/**
 * Tencent Cloud Lighthouse (轻量应用服务器) client for Cloudflare Workers.
 *
 * Implements Tencent Cloud API v3 (TC3-HMAC-SHA256) directly on Web Crypto
 * with zero external SDK dependencies, and returns the exact same domain
 * models as `src/swas.ts` so the management UI, analytics, billing, and
 * scheduler operate uniformly across Aliyun SWAS and Tencent Cloud Lighthouse.
 */

import {
  AliyunError,
  briefError,
  isDryRun,
  type AccountBalance,
  type AliyunAccount,
  type PriceQuote,
} from "./aliyun";
import type { Env } from "./env";
import type {
  SwasCustomImage,
  SwasDisk,
  SwasFirewallRule,
  SwasImageItem,
  SwasInstanceDetail,
  SwasPlan,
  SwasShareAccount,
  SwasSnapshot,
  SwasTrafficPackage,
} from "./swas";

export const LIGHTHOUSE_VERSION = "2020-03-24";
export const BILLING_VERSION = "2018-07-09";
export const STS_VERSION = "2018-08-13";
const REQUEST_TIMEOUT_MS = 20_000;

function makeClientToken(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
const CONTENT_TYPE = "application/json; charset=utf-8";

export const TENCENT_DEFAULT_SCAN_REGIONS = [
  "ap-guangzhou",
  "ap-shanghai",
  "ap-beijing",
  "ap-nanjing",
  "ap-chengdu",
  "ap-chongqing",
  "ap-hongkong",
  "ap-singapore",
  "ap-tokyo",
  "ap-seoul",
  "ap-bangkok",
  "ap-jakarta",
  "na-siliconvalley",
  "na-ashburn",
  "eu-frankfurt",
] as const;

export type TencentRenewFlag =
  | "NOTIFY_AND_AUTO_RENEW"
  | "NOTIFY_AND_MANUAL_RENEW"
  | "DISABLE_NOTIFY_AND_MANUAL_RENEW";

export interface TencentAccount extends AliyunAccount {
  provider?: "tencent";
}

function tencentHost(service: "lighthouse" | "billing" | "sts", site?: string): string {
  const isIntl = (site || "china").toLowerCase() === "international";
  return isIntl
    ? `${service}.intl.tencentcloudapi.com`
    : `${service}.tencentcloudapi.com`;
}

// ---------------------------------------------------------------------------
// TC3-HMAC-SHA256 signing (Web Crypto)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(message));
  return toHex(digest);
}

async function hmacSha256Raw(
  keyBytes: Uint8Array,
  message: string,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return new Uint8Array(sig);
}

function utcDateOf(timestampSec: number): string {
  const d = new Date(timestampSec * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export interface Tc3SignInput {
  secretId: string;
  secretKey: string;
  service: string;
  host: string;
  action: string;
  version: string;
  payload: string;
  region?: string;
  timestamp?: number;
}

export interface Tc3SignedHeaders {
  authorization: string;
  headers: Record<string, string>;
  signature: string;
  timestamp: number;
}

/**
 * Compute Tencent Cloud API v3 (`TC3-HMAC-SHA256`) Authorization header and
 * request headers. Exported so automated checks can assert the official
 * Tencent Cloud test vector verbatim.
 */
export async function signTencentV3(input: Tc3SignInput): Promise<Tc3SignedHeaders> {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const date = utcDateOf(timestamp);
  const actionLower = input.action.toLowerCase();

  const hashedPayload = await sha256Hex(input.payload);
  const canonicalHeaders =
    `content-type:${CONTENT_TYPE}\n` +
    `host:${input.host}\n` +
    `x-tc-action:${actionLower}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join("\n");

  const algorithm = "TC3-HMAC-SHA256";
  const credentialScope = `${date}/${input.service}/tc3_request`;
  const hashedCanonical = await sha256Hex(canonicalRequest);
  const stringToSign = [
    algorithm,
    String(timestamp),
    credentialScope,
    hashedCanonical,
  ].join("\n");

  const secretDate = await hmacSha256Raw(encoder.encode(`TC3${input.secretKey}`), date);
  const secretService = await hmacSha256Raw(secretDate, input.service);
  const secretSigning = await hmacSha256Raw(secretService, "tc3_request");
  const signature = toHex(await hmacSha256Raw(secretSigning, stringToSign));

  const authorization =
    `${algorithm} Credential=${input.secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: Record<string, string> = {
    Authorization: authorization,
    "Content-Type": CONTENT_TYPE,
    "X-TC-Action": input.action,
    "X-TC-Version": input.version,
    "X-TC-Timestamp": String(timestamp),
  };
  if (input.region) {
    headers["X-TC-Region"] = input.region;
  }

  return { authorization, headers, signature, timestamp };
}

// ---------------------------------------------------------------------------
// Generic RPC caller + JSON extraction helpers
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asArray<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function asStrVal(v: unknown, fallback = ""): string {
  if (v === null || v === undefined) return fallback;
  return String(v);
}

function asNumVal(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asBoolVal(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "true";
  return Boolean(v);
}

function bytesToGb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round((bytes / 1024 ** 3) * 100) / 100;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function tencentRpc<T extends Record<string, unknown>>(
  service: "lighthouse" | "billing" | "sts",
  version: string,
  account: AliyunAccount,
  action: string,
  body: Record<string, unknown> = {},
  options?: { region?: string | null },
): Promise<T> {
  const host = tencentHost(service, account.site);
  const payload = JSON.stringify(body);
  const region =
    options && "region" in options
      ? options.region || undefined
      : service === "lighthouse"
        ? account.region_id
        : undefined;

  const { headers } = await signTencentV3({
    secretId: account.access_key_id,
    secretKey: account.access_key_secret,
    service,
    host,
    action,
    version,
    payload,
    region,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`https://${host}/`, {
      method: "POST",
      headers,
      body: payload,
      signal: controller.signal,
    });
  } catch (exc) {
    throw new AliyunError(`腾讯云接口网络请求失败：${briefError(exc)}`);
  } finally {
    clearTimeout(timer);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new AliyunError(`腾讯云接口返回非 JSON 响应（HTTP ${res.status}）`);
  }

  const resp = asRecord(parsed["Response"]);
  const errObj = asRecord(resp["Error"]);
  const errCode = asStrVal(errObj["Code"]).trim();
  const errMsg = asStrVal(errObj["Message"]).trim();

  if (!res.ok || errCode) {
    const code = errCode || `HTTP_${res.status}`;
    const err = new AliyunError(errMsg || code);
    (err as AliyunError & { code?: string }).code = code;
    throw err;
  }

  return resp as T;
}

function lighthouseRpc<T extends Record<string, unknown>>(
  account: AliyunAccount,
  action: string,
  body: Record<string, unknown> = {},
  regionOverride?: string | null,
): Promise<T> {
  return tencentRpc<T>(
    "lighthouse",
    LIGHTHOUSE_VERSION,
    account,
    action,
    body,
    regionOverride !== undefined ? { region: regionOverride } : undefined,
  );
}

// ---------------------------------------------------------------------------
// Status & payload normalizers
// ---------------------------------------------------------------------------

function normalizeInstanceState(state: string): string {
  switch (state.trim().toUpperCase()) {
    case "RUNNING":
      return "Running";
    case "STOPPED":
    case "SHUTDOWN":
    case "FREEZING":
    case "TERMINATING":
    case "DELETING":
      return "Stopped";
    case "STARTING":
      return "Starting";
    case "STOPPING":
      return "Stopping";
    case "REBOOTING":
    case "ENTER_RESCUE_MODE":
    case "EXIT_RESCUE_MODE":
      return "Resetting";
    case "PENDING":
      return "Pending";
    default:
      return state || "Unknown";
  }
}

function deriveBusinessStatus(inst: Record<string, unknown>): string {
  const restrict = asStrVal(inst["InstanceRestrictState"]).trim().toUpperCase();
  const state = asStrVal(inst["InstanceState"]).trim().toUpperCase();
  const isolated = asStrVal(inst["IsolatedTime"]).trim();
  if (restrict && restrict !== "NORMAL") return "Restricted";
  if (state === "FREEZING") return "Overdue";
  if (state === "SHUTDOWN" || isolated) return "Expired";
  return "Normal";
}

function normalizePlatform(platformType: string, osName: string): string {
  const upper = platformType.trim().toUpperCase();
  if (upper.includes("WINDOWS") || osName.toLowerCase().includes("windows")) {
    return "Windows";
  }
  return "Linux";
}

function normalizeBlueprintType(raw: string): "system" | "app" | "custom" {
  const upper = raw.trim().toUpperCase();
  if (upper === "PRIVATE" || upper === "SHARED") return "custom";
  if (upper === "APP_OS" || upper === "DOCKER" || upper === "GAME_PORTAL") return "app";
  return "system";
}

function normalizeSnapshotState(raw: string): string {
  switch (raw.trim().toUpperCase()) {
    case "NORMAL":
      return "Accomplished";
    case "CREATING":
    case "ROLLBACKING":
      return "Progressing";
    case "FAILED":
      return "Failed";
    default:
      return raw || "Accomplished";
  }
}

function normalizeBlueprintState(raw: string): string {
  switch (raw.trim().toUpperCase()) {
    case "NORMAL":
      return "Available";
    case "SYNCING":
    case "CREATING":
      return "Creating";
    case "CREATEFAILED":
    case "SYNCING_FAILED":
      return "CreateFailed";
    default:
      return raw || "Available";
  }
}

function encodeBase64Url(text: string): string {
  const bytes = encoder.encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(token: string): string {
  const padLen = (4 - (token.length % 4)) % 4;
  const b64 = token.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

interface RawTencentFirewallRule {
  Protocol: string;
  Port: string;
  CidrBlock?: string;
  Ipv6CidrBlock?: string;
  Action: string;
  FirewallRuleDescription: string;
}

function firewallRuleKey(rule: RawTencentFirewallRule): string {
  return encodeBase64Url(
    JSON.stringify({
      p: rule.Protocol.toUpperCase(),
      pt: rule.Port || "ALL",
      c: rule.CidrBlock || "",
      c6: rule.Ipv6CidrBlock || "",
      a: rule.Action.toUpperCase(),
      d: rule.FirewallRuleDescription || "",
    }),
  );
}

function parseTencentRule(raw: Record<string, unknown>): {
  apiRule: RawTencentFirewallRule;
  view: SwasFirewallRule;
} {
  const protocol = asStrVal(raw["Protocol"], "TCP").trim().toUpperCase();
  const port = asStrVal(raw["Port"], protocol === "ICMP" || protocol === "ALL" ? "ALL" : "").trim();
  const cidr4 = asStrVal(raw["CidrBlock"]).trim();
  const cidr6 = asStrVal(raw["Ipv6CidrBlock"]).trim();
  const action = asStrVal(raw["Action"], "ACCEPT").trim().toUpperCase();
  const desc = asStrVal(raw["FirewallRuleDescription"]).trim();
  const appType = asStrVal(raw["AppType"]).trim();

  const apiRule: RawTencentFirewallRule = {
    Protocol: protocol,
    Port: port,
    ...(cidr6 ? { Ipv6CidrBlock: cidr6 } : { CidrBlock: cidr4 || "0.0.0.0/0" }),
    Action: action === "DROP" ? "DROP" : "ACCEPT",
    FirewallRuleDescription: desc,
  };

  return {
    apiRule,
    view: {
      rule_id: firewallRuleKey(apiRule),
      rule_protocol: protocol,
      port: port || (protocol === "ICMP" || protocol === "ALL" ? "ALL" : ""),
      source_cidr_ip: cidr6 || cidr4 || "0.0.0.0/0",
      policy: action === "DROP" ? "drop" : "accept",
      remark: desc || (appType && appType !== "Custom" && appType !== "自定义" ? appType : ""),
    },
  };
}

/**
 * Convert panel port notation (`80/80`, `8000/8080`, `1/65535`, `80,443`) to
 * Tencent Lighthouse port notation (`80`, `8000-8080`, `ALL`, `80,443`).
 */
function toTencentPort(protocol: string, rawPort: string): string {
  const proto = protocol.toUpperCase();
  if (proto === "ICMP" || proto === "ICMPV6" || proto === "ALL") return "ALL";
  const cleaned = rawPort.trim();
  if (!cleaned || cleaned.toUpperCase() === "ALL" || cleaned === "-1/-1" || cleaned === "1/65535" || cleaned === "1-65535") {
    return "ALL";
  }
  const slashMatch = /^(\d+)\s*\/\s*(\d+)$/.exec(cleaned);
  if (slashMatch) {
    const start = Number(slashMatch[1]);
    const end = Number(slashMatch[2]);
    if (start === 1 && end === 65535) return "ALL";
    return start === end ? String(start) : `${start}-${end}`;
  }
  return cleaned;
}

function buildTencentApiRulePayload(rule: RawTencentFirewallRule): Record<string, unknown> {
  const out: Record<string, unknown> = {
    Protocol: rule.Protocol,
    Action: rule.Action,
    FirewallRuleDescription: rule.FirewallRuleDescription,
  };
  const proto = rule.Protocol.toUpperCase();
  if (proto === "TCP" || proto === "UDP") {
    out["Port"] = rule.Port || "ALL";
  }
  if (rule.Ipv6CidrBlock) {
    out["Ipv6CidrBlock"] = rule.Ipv6CidrBlock;
  } else {
    out["CidrBlock"] = rule.CidrBlock || "0.0.0.0/0";
  }
  return out;
}

function parseTencentInstance(raw: Record<string, unknown>, regionId: string): SwasInstanceDetail {
  const sysDisk = asRecord(raw["SystemDisk"]);
  const internet = asRecord(raw["InternetAccessible"]);
  const pubIps = asArray<string>(raw["PublicAddresses"]).map((v) => String(v)).filter(Boolean);
  const privIps = asArray<string>(raw["PrivateAddresses"]).map((v) => String(v)).filter(Boolean);
  const osName = asStrVal(raw["OsName"]);
  const platformType = asStrVal(raw["PlatformType"]);
  const diskSize = asNumVal(sysDisk["DiskSize"]);
  const diskType = asStrVal(sysDisk["DiskType"], "CLOUD_PREMIUM");
  const diskId = asStrVal(sysDisk["DiskId"]);

  const disks: SwasDisk[] = diskId
    ? [
        {
          disk_id: diskId,
          disk_name: "系统盘",
          disk_type: "system",
          category: diskType,
          size: diskSize,
          device: "/dev/vda",
          status: "Attached",
          creation_time: asStrVal(raw["CreatedTime"]),
          remark: "",
        },
      ]
    : [];

  return {
    instance_id: asStrVal(raw["InstanceId"]),
    instance_name: asStrVal(raw["InstanceName"]),
    region_id: regionId,
    status: normalizeInstanceState(asStrVal(raw["InstanceState"])),
    business_status: deriveBusinessStatus(raw),
    ddos_status: asStrVal(raw["InstanceRestrictState"], "NORMAL"),
    disable_reason: asStrVal(asRecord(raw["InstanceViolationDetail"])["Reason"]),
    charge_type: asStrVal(raw["InstanceChargeType"], "PREPAID") === "PREPAID" ? "PrePaid" : asStrVal(raw["InstanceChargeType"]),
    plan_id: asStrVal(raw["BundleId"]),
    plan_type: asStrVal(raw["Zone"]),
    public_ip: pubIps[0] ?? "",
    inner_ip: privIps[0] ?? "",
    cpu: asNumVal(raw["CPU"]),
    memory_gb: asNumVal(raw["Memory"]),
    disk_size_gb: diskSize,
    disk_category: diskType,
    bandwidth_mbps: asNumVal(internet["InternetMaxBandwidthOut"]),
    flow_gb: 0,
    image_id: asStrVal(raw["BlueprintId"]),
    image_name: osName || asStrVal(raw["Platform"]),
    image_type: "system",
    image_version: "",
    os_type: normalizePlatform(platformType, osName),
    creation_time: asStrVal(raw["CreatedTime"]),
    expired_time: asStrVal(raw["ExpiredTime"]),
    renew_flag: asStrVal(raw["RenewFlag"]),
    disks,
  };
}

function parseTencentPrice(resp: Record<string, unknown>, periodMonths: number, defaultCurrency: string): PriceQuote {
  const priceRoot = asRecord(resp["Price"]);
  let instPrice = asRecord(priceRoot["InstancePrice"]);
  if (Object.keys(instPrice).length === 0) {
    const totalPrice = asRecord(resp["TotalPrice"]);
    if (Object.keys(totalPrice).length > 0) {
      instPrice = totalPrice;
    } else {
      const details = asArray<Record<string, unknown>>(resp["InstancePriceDetailSet"]);
      if (details.length > 0) {
        instPrice = asRecord(asRecord(details[0])["InstancePrice"]);
      }
    }
  }
  const orig = round2(asNumVal(instPrice["OriginalPrice"]));
  const trade = round2(asNumVal(instPrice["DiscountPrice"], orig));
  const discount = round2(Math.max(0, orig - trade));
  const currency = asStrVal(instPrice["Currency"]).trim() || defaultCurrency;
  const discountPct = asNumVal(instPrice["Discount"], 100);
  const rules: string[] = [];
  if (discount > 0 && discountPct > 0 && discountPct < 100) {
    rules.push(`官网折扣 ${(discountPct / 10).toFixed(1)} 折`);
  }
  return {
    original_price: orig,
    discount_price: discount,
    trade_price: trade,
    currency,
    period: periodMonths,
    price_unit: "Month",
    rules,
  };
}

// ---------------------------------------------------------------------------
// Stateful dry-run mocks (isolate-local) for E2E tests
// ---------------------------------------------------------------------------

interface MockTencentInstance {
  detail: SwasInstanceDetail;
  traffic: SwasTrafficPackage;
}

const mockInstances = new Map<string, MockTencentInstance>();
const mockFirewalls = new Map<string, SwasFirewallRule[]>();
const mockSnapshots = new Map<string, SwasSnapshot[]>();
const mockCustomImages = new Map<string, SwasCustomImage[]>();
const mockImageShares = new Map<string, SwasShareAccount[]>();

function mockKey(account: AliyunAccount, id?: string): string {
  return `tc:${account.access_key_id}:${account.region_id}:${id ?? account.instance_id}`;
}

function mockAcctRegionKey(account: AliyunAccount): string {
  return `tc:${account.access_key_id}:${account.region_id}`;
}

function getOrSeedMockInstance(account: AliyunAccount): MockTencentInstance {
  const key = mockKey(account);
  let entry = mockInstances.get(key);
  if (!entry) {
    const id = account.instance_id || "lhins-mock0001";
    const seed = Array.from(id).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const unlimited = id.toLowerCase().includes("razor") || id.toLowerCase().includes("unlimited");
    const expired = new Date(Date.now() + 30 * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const created = new Date(Date.now() - 45 * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const totalGb = unlimited ? 0 : 1200;
    const usedGb = unlimited ? 0 : round2((seed % 320) + 64.25);
    const totalBytes = Math.round(totalGb * 1024 ** 3);
    const usedBytes = Math.round(usedGb * 1024 ** 3);
    const remainingBytes = Math.max(0, totalBytes - usedBytes);
    const traffic: SwasTrafficPackage = {
      instance_id: id,
      used_bytes: usedBytes,
      total_bytes: totalBytes,
      remaining_bytes: remainingBytes,
      overflow_bytes: 0,
      used_gb: usedGb,
      total_gb: totalGb,
      remaining_gb: unlimited ? 0 : round2(Math.max(0, totalGb - usedGb)),
      overflow_gb: 0,
    };
    const detail: SwasInstanceDetail = {
      instance_id: id,
      instance_name: `tencent-lh-${id.slice(-4)}`,
      region_id: account.region_id || "ap-guangzhou",
      status: "Running",
      business_status: "Normal",
      ddos_status: "NORMAL",
      disable_reason: "",
      charge_type: "PrePaid",
      plan_id: unlimited ? "bundle_rs_mc_med2_01" : "bundle_gen_mc_med2_02",
      plan_type: `${account.region_id || "ap-guangzhou"}-3`,
      public_ip: `43.138.${(seed % 200) + 10}.${(seed % 240) + 5}`,
      inner_ip: `10.0.${(seed % 20) + 1}.${(seed % 200) + 10}`,
      cpu: 2,
      memory_gb: 4,
      disk_size_gb: 60,
      disk_category: "CLOUD_SSD",
      bandwidth_mbps: unlimited ? 200 : 8,
      flow_gb: totalGb,
      image_id: "lhbp-debian12",
      image_name: "Debian 12.6 64bit",
      image_type: "system",
      image_version: "12.6",
      os_type: "Linux",
      creation_time: created,
      expired_time: expired,
      renew_flag: "NOTIFY_AND_MANUAL_RENEW",
      disks: [
        {
          disk_id: `lhdisk-${id.slice(-6)}`,
          disk_name: "系统盘",
          disk_type: "system",
          category: "CLOUD_SSD",
          size: 60,
          device: "/dev/vda",
          status: "Attached",
          creation_time: created,
          remark: "",
        },
      ],
      traffic,
    };
    entry = { detail, traffic };
    mockInstances.set(key, entry);
  }
  return entry;
}

function getOrSeedMockFirewalls(account: AliyunAccount): SwasFirewallRule[] {
  const key = mockKey(account);
  let list = mockFirewalls.get(key);
  if (!list) {
    const defaults: RawTencentFirewallRule[] = [
      { Protocol: "TCP", Port: "22", CidrBlock: "0.0.0.0/0", Action: "ACCEPT", FirewallRuleDescription: "SSH" },
      { Protocol: "TCP", Port: "80", CidrBlock: "0.0.0.0/0", Action: "ACCEPT", FirewallRuleDescription: "HTTP" },
      { Protocol: "TCP", Port: "443", CidrBlock: "0.0.0.0/0", Action: "ACCEPT", FirewallRuleDescription: "HTTPS" },
      { Protocol: "ICMP", Port: "ALL", CidrBlock: "0.0.0.0/0", Action: "ACCEPT", FirewallRuleDescription: "Ping" },
    ];
    list = defaults.map((r) => ({
      rule_id: firewallRuleKey(r),
      rule_protocol: r.Protocol,
      port: r.Port,
      source_cidr_ip: r.CidrBlock || "0.0.0.0/0",
      policy: r.Action === "DROP" ? "drop" : "accept",
      remark: r.FirewallRuleDescription,
    }));
    mockFirewalls.set(key, list);
  }
  return list;
}

function getOrSeedMockSnapshots(account: AliyunAccount): SwasSnapshot[] {
  const key = mockKey(account);
  let list = mockSnapshots.get(key);
  if (!list) {
    const inst = getOrSeedMockInstance(account);
    list = [
      {
        snapshot_id: `lhsnap-${account.instance_id.slice(-6) || "000001"}`,
        snapshot_name: "initial-backup",
        status: "Accomplished",
        progress: "100%",
        source_disk_id: inst.detail.disks[0]?.disk_id || "lhdisk-sys01",
        source_disk_type: "system",
        instance_id: inst.detail.instance_id,
        creation_time: new Date(Date.now() - 2 * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
        remark: "",
      },
    ];
    mockSnapshots.set(key, list);
  }
  return list;
}

function getOrSeedMockCustomImages(account: AliyunAccount): SwasCustomImage[] {
  const key = mockAcctRegionKey(account);
  let list = mockCustomImages.get(key);
  if (!list) {
    list = [];
    mockCustomImages.set(key, list);
  }
  return list;
}

// ---------------------------------------------------------------------------
// Public API matching `src/swas.ts`
// ---------------------------------------------------------------------------

/** List Tencent Cloud Lighthouse regions where Lighthouse is available. */
export async function listRegions(env: Env, account: AliyunAccount): Promise<string[]> {
  if (isDryRun(env)) {
    return [...TENCENT_DEFAULT_SCAN_REGIONS];
  }
  try {
    const data = await lighthouseRpc<Record<string, unknown>>(account, "DescribeRegions", {}, null);
    const regions = asArray<Record<string, unknown>>(data["RegionSet"])
      .filter((r) => asStrVal(r["RegionState"], "AVAILABLE").toUpperCase() === "AVAILABLE")
      .map((r) => asStrVal(r["Region"]).trim())
      .filter(Boolean);
    return regions.length > 0 ? regions : [...TENCENT_DEFAULT_SCAN_REGIONS];
  } catch {
    return [...TENCENT_DEFAULT_SCAN_REGIONS];
  }
}

/** List Tencent Cloud Lighthouse instances in one region (or filter by InstanceIds). */
export async function listInstances(
  env: Env,
  account: AliyunAccount,
  instanceIds?: string[],
): Promise<SwasInstanceDetail[]> {
  if (isDryRun(env)) {
    if (instanceIds && instanceIds.length > 0) {
      return instanceIds.map((id) => ({
        ...getOrSeedMockInstance({ ...account, instance_id: id }).detail,
      }));
    }
    const existing = Array.from(mockInstances.values())
      .filter((m) => m.detail.region_id === (account.region_id || "ap-guangzhou"))
      .map((m) => ({ ...m.detail }));
    if (existing.length > 0) return existing;
    const seeded1 = getOrSeedMockInstance({ ...account, instance_id: "lhins-demo01" }).detail;
    const seeded2 = getOrSeedMockInstance({ ...account, instance_id: "lhins-razor200" }).detail;
    return [{ ...seeded1 }, { ...seeded2 }];
  }

  const out: SwasInstanceDetail[] = [];
  let offset = 0;
  const limit = 100;
  for (let page = 0; page < 10; page++) {
    const body: Record<string, unknown> = { Offset: offset, Limit: limit };
    if (instanceIds && instanceIds.length > 0) {
      body["InstanceIds"] = instanceIds.slice(0, 100);
    }
    const data = await lighthouseRpc<Record<string, unknown>>(account, "DescribeInstances", body);
    const items = asArray<Record<string, unknown>>(data["InstanceSet"]);
    for (const raw of items) {
      out.push(parseTencentInstance(raw, account.region_id));
    }
    const total = asNumVal(data["TotalCount"], out.length);
    if (out.length >= total || items.length < limit || (instanceIds && instanceIds.length > 0)) {
      break;
    }
    offset += items.length;
  }
  return out;
}

/** Query monthly traffic package usage for one or more Lighthouse instances. */
export async function listTrafficPackages(
  env: Env,
  account: AliyunAccount,
  instanceIds: string[],
): Promise<Map<string, SwasTrafficPackage>> {
  const result = new Map<string, SwasTrafficPackage>();
  if (instanceIds.length === 0) return result;
  if (isDryRun(env)) {
    for (const id of instanceIds) {
      const m = getOrSeedMockInstance({ ...account, instance_id: id });
      result.set(id, { ...m.traffic });
    }
    return result;
  }

  for (let i = 0; i < instanceIds.length; i += 100) {
    const chunk = instanceIds.slice(i, i + 100);
    const data = await lighthouseRpc<Record<string, unknown>>(
      account,
      "DescribeInstancesTrafficPackages",
      { InstanceIds: chunk, Offset: 0, Limit: 100 },
    );
    const set = asArray<Record<string, unknown>>(data["InstanceTrafficPackageSet"]);
    for (const item of set) {
      const id = asStrVal(item["InstanceId"]).trim();
      if (!id) continue;
      const pkgs = asArray<Record<string, unknown>>(item["TrafficPackageSet"]);
      const active = pkgs.filter((p) => {
        const st = asStrVal(p["Status"]).toUpperCase();
        return !st || st === "NETWORK_NORMAL" || st === "OVERDUE_NETWORK_DISABLED";
      });
      const source = active.length > 0 ? active : pkgs;
      let usedBytes = 0;
      let totalBytes = 0;
      let remainingBytes = 0;
      let overflowBytes = 0;
      for (const p of source) {
        usedBytes += asNumVal(p["TrafficUsed"]);
        totalBytes += asNumVal(p["TrafficPackageTotal"]);
        remainingBytes += asNumVal(p["TrafficPackageRemaining"]);
        overflowBytes += asNumVal(p["TrafficOverflow"]);
      }
      result.set(id, {
        instance_id: id,
        used_bytes: usedBytes,
        total_bytes: totalBytes,
        remaining_bytes: remainingBytes,
        overflow_bytes: overflowBytes,
        used_gb: bytesToGb(usedBytes),
        total_gb: bytesToGb(totalBytes),
        remaining_gb: bytesToGb(remainingBytes),
        overflow_gb: bytesToGb(overflowBytes),
      });
    }
  }
  return result;
}

/** List cloud disks mounted to a Lighthouse instance. */
export async function listDisks(env: Env, account: AliyunAccount): Promise<SwasDisk[]> {
  if (isDryRun(env)) {
    return getOrSeedMockInstance(account).detail.disks.map((d) => ({ ...d }));
  }
  const data = await lighthouseRpc<Record<string, unknown>>(account, "DescribeDisks", {
    Filters: [{ Name: "instance-id", Values: [account.instance_id] }],
    Limit: 50,
  });
  return asArray<Record<string, unknown>>(data["DiskSet"]).map((d) => ({
    disk_id: asStrVal(d["DiskId"]),
    disk_name: asStrVal(d["DiskName"]) || (asStrVal(d["DiskUsage"]) === "SYSTEM_DISK" ? "系统盘" : "数据盘"),
    disk_type: asStrVal(d["DiskUsage"]).toUpperCase() === "SYSTEM_DISK" ? "system" : "data",
    category: asStrVal(d["DiskType"], "CLOUD_SSD"),
    size: asNumVal(d["DiskSize"]),
    device: "",
    status: asStrVal(d["DiskState"], "ATTACHED"),
    creation_time: asStrVal(d["CreatedTime"]),
    remark: "",
  }));
}

/** Fetch full Lighthouse instance details, disks, and traffic package. */
export async function getInstanceDetail(
  env: Env,
  account: AliyunAccount,
): Promise<SwasInstanceDetail> {
  if (isDryRun(env)) {
    const m = getOrSeedMockInstance(account);
    return {
      ...m.detail,
      disks: m.detail.disks.map((d) => ({ ...d })),
      traffic: { ...m.traffic },
    };
  }
  const [instances, trafficMap, extraDisks] = await Promise.all([
    listInstances(env, account, [account.instance_id]),
    listTrafficPackages(env, account, [account.instance_id]).catch(() => new Map<string, SwasTrafficPackage>()),
    listDisks(env, account).catch(() => [] as SwasDisk[]),
  ]);
  const inst = instances[0];
  if (!inst) {
    throw new AliyunError(`未找到腾讯云轻量实例 ${account.instance_id}（地域 ${account.region_id}）`);
  }
  // Merge system disk with any extra attached cloud data disks without duplicates.
  const seen = new Set(inst.disks.map((d) => d.disk_id));
  const mergedDisks = [...inst.disks];
  for (const d of extraDisks) {
    if (d.disk_id && !seen.has(d.disk_id)) {
      mergedDisks.push(d);
      seen.add(d.disk_id);
    }
  }
  const traffic = trafficMap.get(inst.instance_id) ?? null;
  return {
    ...inst,
    flow_gb: traffic?.total_gb ?? inst.flow_gb,
    disks: mergedDisks,
    traffic,
  };
}

/** Start a stopped Tencent Lighthouse instance. */
export async function startInstance(env: Env, account: AliyunAccount): Promise<void> {
  if (isDryRun(env)) {
    getOrSeedMockInstance(account).detail.status = "Running";
    return;
  }
  await lighthouseRpc(account, "StartInstances", { InstanceIds: [account.instance_id] });
}

/** Stop a running Tencent Lighthouse instance. */
export async function stopInstance(
  env: Env,
  account: AliyunAccount,
  _force = false,
): Promise<void> {
  if (isDryRun(env)) {
    getOrSeedMockInstance(account).detail.status = "Stopped";
    return;
  }
  await lighthouseRpc(account, "StopInstances", { InstanceIds: [account.instance_id] });
}

/** Reboot a running Tencent Lighthouse instance. */
export async function rebootInstance(
  env: Env,
  account: AliyunAccount,
  _force = false,
): Promise<void> {
  if (isDryRun(env)) {
    getOrSeedMockInstance(account).detail.status = "Running";
    return;
  }
  await lighthouseRpc(account, "RebootInstances", { InstanceIds: [account.instance_id] });
}

/**
 * Query a one-time VNC URL (valid for 15 seconds) and assemble the official
 * Tencent Cloud Web VNC viewer URL ready for iframe/new-tab opening.
 */
export async function describeInstanceVncUrl(
  env: Env,
  account: AliyunAccount,
): Promise<string> {
  if (isDryRun(env)) {
    const raw = encodeURIComponent(
      `wss://gzvnc.qcloud.com:443/vnc?s=mock-${account.instance_id}&isWindows=false&isUbuntu=false`,
    );
    return `https://img.qcloud.com/qcloud/app/active_vnc/index.html?InstanceVncUrl=${raw}`;
  }
  const data = await lighthouseRpc<Record<string, unknown>>(
    account,
    "DescribeInstanceVncUrl",
    { InstanceId: account.instance_id },
  );
  const rawVnc = asStrVal(data["InstanceVncUrl"]).trim();
  if (!rawVnc) {
    throw new AliyunError("腾讯云未返回 VNC 地址，请确认实例处于运行中状态");
  }
  if (rawVnc.startsWith("https://") || rawVnc.startsWith("http://")) {
    return rawVnc;
  }
  // Tencent Cloud normally returns InstanceVncUrl already percent-encoded (`wss%3A%2F%2F...`).
  const encoded = rawVnc.startsWith("wss://") || rawVnc.startsWith("ws://")
    ? encodeURIComponent(rawVnc)
    : rawVnc;
  return `https://img.qcloud.com/qcloud/app/active_vnc/index.html?InstanceVncUrl=${encoded}`;
}

/** Build official Tencent Cloud Lighthouse console detail URL. */
export function buildConsoleUrl(account: AliyunAccount): string {
  const host =
    (account.site || "china").toLowerCase() === "international"
      ? "console.tencentcloud.com"
      : "console.cloud.tencent.com";
  return `https://${host}/lighthouse/instance/detail?rid=${encodeURIComponent(account.region_id)}&id=${encodeURIComponent(account.instance_id)}`;
}

/** Rename a Tencent Lighthouse instance and/or reset its OS login password. */
export async function updateInstanceAttribute(
  env: Env,
  account: AliyunAccount,
  opts: { instanceName?: string; password?: string; userName?: string },
): Promise<void> {
  if (isDryRun(env)) {
    const m = getOrSeedMockInstance(account);
    if (opts.instanceName) m.detail.instance_name = opts.instanceName;
    return;
  }
  if (opts.instanceName) {
    await lighthouseRpc(account, "ModifyInstancesAttribute", {
      InstanceIds: [account.instance_id],
      InstanceName: opts.instanceName,
    });
  }
  if (opts.password) {
    const body: Record<string, unknown> = {
      InstanceIds: [account.instance_id],
      Password: opts.password,
    };
    if (opts.userName) {
      body["UserName"] = opts.userName;
    }
    await lighthouseRpc(account, "ResetInstancesPassword", body);
  }
}

/** List available blueprints (OS / App / Custom) for reset or provisioning. */
export async function listImages(
  env: Env,
  account: AliyunAccount,
  imageType?: "system" | "app" | "custom",
): Promise<SwasImageItem[]> {
  if (isDryRun(env)) {
    const base: SwasImageItem[] = [
      { image_id: "lhbp-debian12", image_name: "Debian 12.6 64bit", image_type: "system", platform: "Linux", description: "纯净 Debian 12 系统镜像" },
      { image_id: "lhbp-ubuntu24", image_name: "Ubuntu Server 24.04 LTS 64bit", image_type: "system", platform: "Linux", description: "纯净 Ubuntu 24.04 系统镜像" },
      { image_id: "lhbp-tencentos3", image_name: "TencentOS Server 3.1 (TK4)", image_type: "system", platform: "Linux", description: "腾讯云官方 Linux 发行版" },
      { image_id: "lhbp-docker", image_name: "Docker 基础镜像 26.1", image_type: "app", platform: "Linux", description: "预装 Docker CE 与 Compose" },
      { image_id: "lhbp-btpanel", image_name: "宝塔 Linux 面板腾讯云专享版", image_type: "app", platform: "Linux", description: "预装宝塔可视化运维面板" },
    ];
    for (const custom of getOrSeedMockCustomImages(account)) {
      base.push({
        image_id: custom.image_id,
        image_name: custom.name,
        image_type: "custom",
        platform: custom.os_type || "Linux",
        description: custom.description,
      });
    }
    return imageType ? base.filter((i) => i.image_type === imageType) : base;
  }

  // For resetting an existing instance, DescribeResetInstanceBlueprints returns only compatible blueprints.
  if (account.instance_id) {
    const body: Record<string, unknown> = {
      InstanceId: account.instance_id,
      Offset: 0,
      Limit: 100,
    };
    if (imageType) {
      const filterValues =
        imageType === "system"
          ? ["PURE_OS"]
          : imageType === "app"
            ? ["APP_OS", "DOCKER"]
            : ["PRIVATE", "SHARED"];
      body["Filters"] = [{ Name: "blueprint-type", Values: filterValues }];
    }
    try {
      const data = await lighthouseRpc<Record<string, unknown>>(
        account,
        "DescribeResetInstanceBlueprints",
        body,
      );
      const list = asArray<Record<string, unknown>>(data["ResetInstanceBlueprintSet"]);
      const out: SwasImageItem[] = [];
      for (const item of list) {
        if (item["IsResettable"] === false) continue;
        const bp = asRecord(item["BlueprintInfo"]);
        const id = asStrVal(bp["BlueprintId"]).trim();
        if (!id) continue;
        const osName = asStrVal(bp["OsName"]);
        const title = asStrVal(bp["DisplayTitle"]).trim();
        const ver = asStrVal(bp["DisplayVersion"]).trim();
        const bpName = asStrVal(bp["BlueprintName"]).trim();
        const label =
          title && ver ? `${title} ${ver}` : title || osName || bpName || id;
        out.push({
          image_id: id,
          image_name: label,
          image_type: normalizeBlueprintType(asStrVal(bp["BlueprintType"])),
          platform: normalizePlatform(asStrVal(bp["PlatformType"]), osName),
          description: asStrVal(bp["Description"]) || osName,
        });
      }
      if (out.length > 0) return out;
    } catch {
      // Fall back to generic DescribeBlueprints if reset-specific query fails.
    }
  }

  const body: Record<string, unknown> = { Offset: 0, Limit: 100 };
  if (imageType) {
    const filterValues =
      imageType === "system"
        ? ["PURE_OS"]
        : imageType === "app"
          ? ["APP_OS", "DOCKER"]
          : ["PRIVATE", "SHARED"];
    body["Filters"] = [{ Name: "blueprint-type", Values: filterValues }];
  }
  const data = await lighthouseRpc<Record<string, unknown>>(account, "DescribeBlueprints", body);
  return asArray<Record<string, unknown>>(data["BlueprintSet"])
    .filter((bp) => asStrVal(bp["BlueprintState"], "NORMAL").toUpperCase() === "NORMAL")
    .map((bp) => {
      const osName = asStrVal(bp["OsName"]);
      const title = asStrVal(bp["DisplayTitle"]).trim();
      const ver = asStrVal(bp["DisplayVersion"]).trim();
      const bpName = asStrVal(bp["BlueprintName"]).trim();
      const label =
        title && ver ? `${title} ${ver}` : title || osName || bpName || asStrVal(bp["BlueprintId"]);
      return {
        image_id: asStrVal(bp["BlueprintId"]),
        image_name: label,
        image_type: normalizeBlueprintType(asStrVal(bp["BlueprintType"])),
        platform: normalizePlatform(asStrVal(bp["PlatformType"]), osName),
        description: asStrVal(bp["Description"]) || osName,
      };
    });
}

/** List SSH key pairs in the region (formatted as `KeyId (KeyName)` or raw `KeyId`). */
export async function listKeyPairs(
  env: Env,
  account: AliyunAccount,
): Promise<string[]> {
  if (isDryRun(env)) {
    return ["lhkp-default01 (default-ssh-key)"];
  }
  const data = await lighthouseRpc<Record<string, unknown>>(account, "DescribeKeyPairs", {
    Offset: 0,
    Limit: 100,
  });
  return asArray<Record<string, unknown>>(data["KeyPairSet"])
    .map((kp) => {
      const id = asStrVal(kp["KeyId"]).trim();
      const name = asStrVal(kp["KeyName"]).trim();
      if (!id) return "";
      return name ? `${id} (${name})` : id;
    })
    .filter(Boolean);
}

/** Reset / reinstall OS on a Tencent Lighthouse instance. */
export async function resetSystem(
  env: Env,
  account: AliyunAccount,
  opts: {
    imageId?: string;
    password?: string;
    keyPairName?: string;
    clientToken?: string;
  },
): Promise<void> {
  if (isDryRun(env)) {
    const m = getOrSeedMockInstance(account);
    if (opts.imageId) {
      m.detail.image_id = opts.imageId;
      m.detail.image_name = opts.imageId;
    }
    m.detail.status = "Running";
    return;
  }
  const body: Record<string, unknown> = {
    InstanceId: account.instance_id,
  };
  if (opts.imageId) {
    body["BlueprintId"] = opts.imageId;
  }
  if (opts.keyPairName) {
    // Accept either raw `lhkp-xxxx` or display format `lhkp-xxxx (my-key)`.
    const keyId = opts.keyPairName.split(/\s+/)[0]!.trim();
    body["LoginConfiguration"] = { KeyIds: [keyId] };
  } else if (opts.password) {
    body["LoginConfiguration"] = {
      AutoGeneratePassword: "NO",
      Password: opts.password,
    };
  }
  await lighthouseRpc(account, "ResetInstance", body);
}

// ---------------------------------------------------------------------------
// Firewall rules
// ---------------------------------------------------------------------------

async function fetchRawFirewallRules(
  account: AliyunAccount,
): Promise<{ version: number; items: Array<{ apiRule: RawTencentFirewallRule; view: SwasFirewallRule }> }> {
  const data = await lighthouseRpc<Record<string, unknown>>(account, "DescribeFirewallRules", {
    InstanceId: account.instance_id,
    Offset: 0,
    Limit: 100,
  });
  const version = asNumVal(data["FirewallVersion"], 0);
  const items = asArray<Record<string, unknown>>(data["FirewallRuleSet"]).map(parseTencentRule);
  return { version, items };
}

export async function listFirewallRules(
  env: Env,
  account: AliyunAccount,
): Promise<SwasFirewallRule[]> {
  if (isDryRun(env)) {
    return getOrSeedMockFirewalls(account).map((r) => ({ ...r }));
  }
  const { items } = await fetchRawFirewallRules(account);
  return items.map((i) => i.view);
}

export async function createFirewallRule(
  env: Env,
  account: AliyunAccount,
  opts: {
    ruleProtocol: string;
    port: string;
    sourceCidrIp?: string;
    policy?: string;
    remark?: string;
  },
): Promise<string> {
  const protoRaw = opts.ruleProtocol.trim().toUpperCase();
  const protocols = protoRaw === "TCP+UDP" ? ["TCP", "UDP"] : [protoRaw];
  const cidr = (opts.sourceCidrIp || "0.0.0.0/0").trim();
  const isV6 = cidr.includes(":");
  const action = (opts.policy || "accept").toLowerCase() === "drop" ? "DROP" : "ACCEPT";
  const desc = (opts.remark || "").trim().slice(0, 60);

  const rulesToAdd: RawTencentFirewallRule[] = protocols.map((protocol) => ({
    Protocol: protocol,
    Port: toTencentPort(protocol, opts.port),
    ...(isV6 ? { Ipv6CidrBlock: cidr } : { CidrBlock: cidr }),
    Action: action,
    FirewallRuleDescription: desc,
  }));

  if (isDryRun(env)) {
    const list = getOrSeedMockFirewalls(account);
    let lastId = "";
    for (const r of rulesToAdd) {
      const id = firewallRuleKey(r);
      lastId = id;
      if (!list.some((x) => x.rule_id === id)) {
        list.push({
          rule_id: id,
          rule_protocol: r.Protocol,
          port: r.Port,
          source_cidr_ip: r.Ipv6CidrBlock || r.CidrBlock || "0.0.0.0/0",
          policy: r.Action === "DROP" ? "drop" : "accept",
          remark: r.FirewallRuleDescription,
        });
      }
    }
    return lastId;
  }

  const { version } = await fetchRawFirewallRules(account);
  await lighthouseRpc(account, "CreateFirewallRules", {
    InstanceId: account.instance_id,
    FirewallRules: rulesToAdd.map(buildTencentApiRulePayload),
    ...(version > 0 ? { FirewallVersion: version } : {}),
  });
  return firewallRuleKey(rulesToAdd[0]!);
}

export async function toggleFirewallRule(
  env: Env,
  account: AliyunAccount,
  ruleId: string,
  enable: boolean,
): Promise<void> {
  if (isDryRun(env)) {
    const list = getOrSeedMockFirewalls(account);
    const target = list.find((r) => r.rule_id === ruleId);
    if (!target) throw new AliyunError("未找到对应的防火墙规则");
    target.policy = enable ? "accept" : "drop";
    const apiRule: RawTencentFirewallRule = {
      Protocol: target.rule_protocol,
      Port: target.port,
      ...(target.source_cidr_ip.includes(":")
        ? { Ipv6CidrBlock: target.source_cidr_ip }
        : { CidrBlock: target.source_cidr_ip }),
      Action: enable ? "ACCEPT" : "DROP",
      FirewallRuleDescription: target.remark,
    };
    target.rule_id = firewallRuleKey(apiRule);
    return;
  }

  const { version, items } = await fetchRawFirewallRules(account);
  const idx = items.findIndex((i) => i.view.rule_id === ruleId);
  if (idx < 0) throw new AliyunError("未找到对应的腾讯云防火墙规则，请刷新后重试");

  const nextRules = items.map((i, n) => {
    const r = { ...i.apiRule };
    if (n === idx) {
      r.Action = enable ? "ACCEPT" : "DROP";
    }
    return buildTencentApiRulePayload(r);
  });

  await lighthouseRpc(account, "ModifyFirewallRules", {
    InstanceId: account.instance_id,
    FirewallRules: nextRules,
    ...(version > 0 ? { FirewallVersion: version } : {}),
  });
}

export async function deleteFirewallRule(
  env: Env,
  account: AliyunAccount,
  ruleId: string,
): Promise<void> {
  if (isDryRun(env)) {
    const list = getOrSeedMockFirewalls(account);
    const idx = list.findIndex((r) => r.rule_id === ruleId);
    if (idx >= 0) list.splice(idx, 1);
    return;
  }

  const { version, items } = await fetchRawFirewallRules(account);
  let target = items.find((i) => i.view.rule_id === ruleId)?.apiRule;
  if (!target) {
    // Fallback: attempt to decode rule descriptor directly from ruleId.
    try {
      const decoded = JSON.parse(decodeBase64Url(ruleId)) as {
        p?: string;
        pt?: string;
        c?: string;
        c6?: string;
        a?: string;
        d?: string;
      };
      if (decoded.p) {
        target = {
          Protocol: decoded.p,
          Port: decoded.pt || "ALL",
          ...(decoded.c6 ? { Ipv6CidrBlock: decoded.c6 } : { CidrBlock: decoded.c || "0.0.0.0/0" }),
          Action: decoded.a === "DROP" ? "DROP" : "ACCEPT",
          FirewallRuleDescription: decoded.d || "",
        };
      }
    } catch {
      // Ignore malformed token.
    }
  }
  if (!target) throw new AliyunError("未找到要删除的腾讯云防火墙规则，请刷新后重试");

  await lighthouseRpc(account, "DeleteFirewallRules", {
    InstanceId: account.instance_id,
    FirewallRules: [buildTencentApiRulePayload(target)],
    ...(version > 0 ? { FirewallVersion: version } : {}),
  });
}

// ---------------------------------------------------------------------------
// Snapshots (with rollback support)
// ---------------------------------------------------------------------------

export async function listSnapshots(
  env: Env,
  account: AliyunAccount,
): Promise<SwasSnapshot[]> {
  if (isDryRun(env)) {
    return getOrSeedMockSnapshots(account).map((s) => ({ ...s }));
  }
  const data = await lighthouseRpc<Record<string, unknown>>(account, "DescribeSnapshots", {
    Filters: [{ Name: "instance-id", Values: [account.instance_id] }],
    Offset: 0,
    Limit: 100,
  });
  return asArray<Record<string, unknown>>(data["SnapshotSet"]).map((s) => ({
    snapshot_id: asStrVal(s["SnapshotId"]),
    snapshot_name: asStrVal(s["SnapshotName"]) || asStrVal(s["SnapshotId"]),
    status: normalizeSnapshotState(asStrVal(s["SnapshotState"])),
    progress: `${asNumVal(s["Percent"], 100)}%`,
    source_disk_id: asStrVal(s["DiskId"]),
    source_disk_type: asStrVal(s["DiskUsage"]).toUpperCase() === "DATA_DISK" ? "data" : "system",
    instance_id: asStrVal(s["InstanceId"]) || account.instance_id,
    creation_time: asStrVal(s["CreatedTime"]),
    remark: asStrVal(s["LatestOperationState"]),
  }));
}

export async function createSnapshot(
  env: Env,
  account: AliyunAccount,
  opts: { snapshotName: string },
): Promise<string> {
  if (isDryRun(env)) {
    const list = getOrSeedMockSnapshots(account);
    const id = `lhsnap-${Date.now().toString(36).slice(-8)}`;
    const inst = getOrSeedMockInstance(account);
    list.unshift({
      snapshot_id: id,
      snapshot_name: opts.snapshotName,
      status: "Accomplished",
      progress: "100%",
      source_disk_id: inst.detail.disks[0]?.disk_id || "lhdisk-sys01",
      source_disk_type: "system",
      instance_id: account.instance_id,
      creation_time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      remark: "",
    });
    return id;
  }
  const data = await lighthouseRpc<Record<string, unknown>>(account, "CreateInstanceSnapshot", {
    InstanceId: account.instance_id,
    SnapshotName: opts.snapshotName,
  });
  return asStrVal(data["SnapshotId"]);
}

export async function deleteSnapshot(
  env: Env,
  account: AliyunAccount,
  snapshotId: string,
): Promise<void> {
  if (isDryRun(env)) {
    const list = getOrSeedMockSnapshots(account);
    const idx = list.findIndex((s) => s.snapshot_id === snapshotId);
    if (idx >= 0) list.splice(idx, 1);
    return;
  }
  await lighthouseRpc(account, "DeleteSnapshots", { SnapshotIds: [snapshotId] });
}

export async function applySnapshot(
  env: Env,
  account: AliyunAccount,
  snapshotId: string,
): Promise<void> {
  if (isDryRun(env)) {
    getOrSeedMockInstance(account).detail.status = "Running";
    return;
  }
  await lighthouseRpc(account, "ApplyInstanceSnapshot", {
    InstanceId: account.instance_id,
    SnapshotId: snapshotId,
  });
}

// ---------------------------------------------------------------------------
// Custom images (Blueprints) & cross-account sharing
// ---------------------------------------------------------------------------

export async function listCustomImages(
  env: Env,
  account: AliyunAccount,
): Promise<SwasCustomImage[]> {
  if (isDryRun(env)) {
    return getOrSeedMockCustomImages(account).map((i) => ({ ...i }));
  }
  const data = await lighthouseRpc<Record<string, unknown>>(account, "DescribeBlueprints", {
    Filters: [{ Name: "blueprint-type", Values: ["PRIVATE"] }],
    Offset: 0,
    Limit: 100,
  });
  return asArray<Record<string, unknown>>(data["BlueprintSet"]).map((bp) => {
    const osName = asStrVal(bp["OsName"]);
    return {
      image_id: asStrVal(bp["BlueprintId"]),
      name: asStrVal(bp["DisplayTitle"]) || asStrVal(bp["BlueprintName"]) || asStrVal(bp["BlueprintId"]),
      description: asStrVal(bp["Description"]),
      status: normalizeBlueprintState(asStrVal(bp["BlueprintState"])),
      os_type: normalizePlatform(asStrVal(bp["PlatformType"]), osName),
      instance_id: account.instance_id,
      instance_name: "",
      system_snapshot_id: "",
      system_snapshot_name: "",
      data_snapshot_id: "",
      in_share_ecs: false,
      in_share_user: asBoolVal(bp["BlueprintShared"]),
      required_system_disk_size: asNumVal(bp["RequiredSystemDiskSize"]),
      required_data_disk_size: 0,
      source_image_name: osName,
      creation_time: asStrVal(bp["CreatedTime"]),
    };
  });
}

export async function createCustomImage(
  env: Env,
  account: AliyunAccount,
  opts: {
    imageName: string;
    description?: string;
    forcePowerOff?: boolean;
  },
): Promise<string> {
  if (isDryRun(env)) {
    const list = getOrSeedMockCustomImages(account);
    const id = `lhbp-${Date.now().toString(36).slice(-8)}`;
    const inst = getOrSeedMockInstance(account);
    list.unshift({
      image_id: id,
      name: opts.imageName,
      description: opts.description || "",
      status: "Available",
      os_type: inst.detail.os_type || "Linux",
      instance_id: account.instance_id,
      instance_name: inst.detail.instance_name,
      system_snapshot_id: "",
      system_snapshot_name: "",
      data_snapshot_id: "",
      in_share_ecs: false,
      in_share_user: false,
      required_system_disk_size: inst.detail.disk_size_gb,
      required_data_disk_size: 0,
      source_image_name: inst.detail.image_name,
      creation_time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    return id;
  }
  const body: Record<string, unknown> = {
    BlueprintName: opts.imageName.slice(0, 60),
    InstanceId: account.instance_id,
    ForcePowerOff: opts.forcePowerOff ?? true,
  };
  if (opts.description) {
    body["Description"] = opts.description.slice(0, 60);
  }
  const data = await lighthouseRpc<Record<string, unknown>>(account, "CreateBlueprint", body);
  return asStrVal(data["BlueprintId"]);
}

export async function deleteCustomImage(
  env: Env,
  account: AliyunAccount,
  imageId: string,
): Promise<void> {
  if (isDryRun(env)) {
    const list = getOrSeedMockCustomImages(account);
    const idx = list.findIndex((i) => i.image_id === imageId);
    if (idx >= 0) list.splice(idx, 1);
    mockImageShares.delete(imageId);
    return;
  }
  await lighthouseRpc(account, "DeleteBlueprints", { BlueprintIds: [imageId] });
}

export async function listCustomImageShareAccounts(
  env: Env,
  account: AliyunAccount,
  imageId: string,
): Promise<SwasShareAccount[]> {
  if (isDryRun(env)) {
    return (mockImageShares.get(imageId) ?? []).map((a) => ({ ...a }));
  }
  const data = await lighthouseRpc<Record<string, unknown>>(
    account,
    "DescribeBlueprintsShareAcrossAccountInfos",
    { BlueprintIds: [imageId], Offset: 0, Limit: 100 },
  );
  const rawList =
    asArray<Record<string, unknown>>(data["ShareAcrossAccountInfoSet"]).length > 0
      ? asArray<Record<string, unknown>>(data["ShareAcrossAccountInfoSet"])
      : asArray<Record<string, unknown>>(data["BlueprintShareAcrossAccountInfoSet"]);
  return rawList
    .map((item) => ({
      user_id: asStrVal(item["AccountId"]).trim(),
      shared_time: asStrVal(item["CreatedTime"]),
    }))
    .filter((a) => Boolean(a.user_id));
}

export async function updateCustomImageShareAccounts(
  env: Env,
  account: AliyunAccount,
  imageId: string,
  operation: "add" | "remove",
  accountIds: string[],
): Promise<void> {
  if (isDryRun(env)) {
    const current = mockImageShares.get(imageId) ?? [];
    if (operation === "add") {
      for (const uid of accountIds) {
        if (!current.some((x) => x.user_id === uid)) {
          current.push({
            user_id: uid,
            shared_time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
          });
        }
      }
    } else {
      const drop = new Set(accountIds);
      const kept = current.filter((x) => !drop.has(x.user_id));
      current.length = 0;
      current.push(...kept);
    }
    mockImageShares.set(imageId, current);
    const img = getOrSeedMockCustomImages(account).find((i) => i.image_id === imageId);
    if (img) img.in_share_user = current.length > 0;
    return;
  }

  const action =
    operation === "add"
      ? "ShareBlueprintAcrossAccounts"
      : "CancelShareBlueprintAcrossAccounts";
  await lighthouseRpc(account, action, {
    BlueprintId: imageId,
    AccountIds: accountIds,
  });
}

// ---------------------------------------------------------------------------
// Plans, pricing, renewal, auto-renew & provisioning
// ---------------------------------------------------------------------------

export async function listPlans(env: Env, account: AliyunAccount): Promise<SwasPlan[]> {
  if (isDryRun(env)) {
    const currency = account.site === "international" ? "USD" : "CNY";
    return [
      {
        plan_id: "bundle_gen_mc_med2_01",
        plan_type: "通用型",
        core: 2,
        memory: 2,
        disk_size: 50,
        disk_type: "CLOUD_SSD",
        bandwidth: 4,
        flow: 500,
        isp_type: "BGP",
        origin_price: currency === "USD" ? 8 : 50,
        currency,
        support_platform: ["Linux", "Windows"],
      },
      {
        plan_id: "bundle_gen_mc_med2_02",
        plan_type: "通用型",
        core: 2,
        memory: 4,
        disk_size: 60,
        disk_type: "CLOUD_SSD",
        bandwidth: 6,
        flow: 1000,
        isp_type: "BGP",
        origin_price: currency === "USD" ? 14 : 95,
        currency,
        support_platform: ["Linux", "Windows"],
      },
      {
        plan_id: "bundle_rs_mc_med2_01",
        plan_type: "锐驰型（不限流量）",
        core: 2,
        memory: 2,
        disk_size: 40,
        disk_type: "CLOUD_SSD",
        bandwidth: 200,
        flow: 0,
        isp_type: "BGP",
        origin_price: currency === "USD" ? 7 : 45,
        currency,
        support_platform: ["Linux"],
      },
    ];
  }

  const data = await lighthouseRpc<Record<string, unknown>>(account, "DescribeBundles", {
    Offset: 0,
    Limit: 100,
  });
  const defaultCurrency = account.site === "international" ? "USD" : "CNY";
  return asArray<Record<string, unknown>>(data["BundleSet"])
    .filter((b) => asStrVal(b["BundleSalesState"], "AVAILABLE").toUpperCase() === "AVAILABLE")
    .map((b) => {
      const priceObj = asRecord(asRecord(b["Price"])["InstancePrice"]);
      const unlimited = asBoolVal(b["TrafficUnlimited"]);
      const platforms: string[] = [];
      if (b["SupportLinuxUnixPlatform"] !== false) platforms.push("Linux");
      if (b["SupportWindowsPlatform"] === true) platforms.push("Windows");
      const typeDesc =
        asStrVal(b["BundleTypeDescription"]).trim() || asStrVal(b["BundleType"]).trim() || "通用型";
      return {
        plan_id: asStrVal(b["BundleId"]),
        plan_type: unlimited ? `${typeDesc}（不限流量）` : typeDesc,
        core: asNumVal(b["CPU"]),
        memory: asNumVal(b["Memory"]),
        disk_size: asNumVal(b["SystemDiskSize"]),
        disk_type: asStrVal(b["SystemDiskType"], "CLOUD_SSD"),
        bandwidth: asNumVal(b["InternetMaxBandwidthOut"]),
        flow: unlimited ? 0 : asNumVal(b["MonthlyTraffic"]),
        isp_type: asStrVal(b["BundleDisplayLabel"]) || "BGP",
        origin_price: round2(asNumVal(priceObj["DiscountPrice"], asNumVal(priceObj["OriginalPrice"]))),
        currency: asStrVal(priceObj["Currency"]).trim() || defaultCurrency,
        support_platform: platforms.length > 0 ? platforms : ["Linux"],
      };
    });
}

/** Query real-time price for creating or renewing a Tencent Lighthouse instance. */
export async function describePrice(
  env: Env,
  account: AliyunAccount,
  opts: {
    planId: string;
    periodMonths: number;
    instanceId?: string;
    autoRenew?: boolean;
  },
): Promise<PriceQuote> {
  const months = Math.max(1, Math.trunc(opts.periodMonths));
  const defaultCurrency = account.site === "international" ? "USD" : "CNY";

  if (isDryRun(env)) {
    const base = opts.planId.includes("rs_") ? 45 : opts.planId.includes("_02") ? 95 : 50;
    const orig = round2(base * months);
    const disc = months >= 12 ? round2(orig * 0.15) : 0;
    return {
      original_price: orig,
      discount_price: disc,
      trade_price: round2(orig - disc),
      currency: defaultCurrency,
      period: months,
      price_unit: "Month",
      rules: disc > 0 ? ["包年 8.5 折优惠"] : [],
    };
  }

  if (opts.instanceId) {
    const data = await lighthouseRpc<Record<string, unknown>>(
      account,
      "InquirePriceRenewInstances",
      {
        InstanceIds: [opts.instanceId],
        InstanceChargePrepaid: { Period: months },
        // Explicit false prevents Tencent Lighthouse from rejecting instances
        // that have no separate elastic data disk attached.
        RenewDataDisk: false,
      },
    );
    return parseTencentPrice(data, months, defaultCurrency);
  }

  const data = await lighthouseRpc<Record<string, unknown>>(
    account,
    "InquirePriceCreateInstances",
    {
      BundleId: opts.planId,
      InstanceCount: 1,
      InstanceChargePrepaid: {
        Period: months,
        RenewFlag: opts.autoRenew ? "NOTIFY_AND_AUTO_RENEW" : "NOTIFY_AND_MANUAL_RENEW",
      },
    },
  );
  return parseTencentPrice(data, months, defaultCurrency);
}

/** Renew a PrePaid Tencent Lighthouse instance. */
export async function renewInstance(
  env: Env,
  account: AliyunAccount,
  opts: { periodMonths: number; autoVoucher?: boolean },
): Promise<{ request_id: string; expired_time: string }> {
  const months = Math.max(1, Math.trunc(opts.periodMonths));
  if (isDryRun(env)) {
    const m = getOrSeedMockInstance(account);
    const baseMs = m.detail.expired_time ? Date.parse(m.detail.expired_time) : Date.now();
    const nextIso = new Date(
      (Number.isFinite(baseMs) ? baseMs : Date.now()) + months * 30 * 86400 * 1000,
    )
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    m.detail.expired_time = nextIso;
    return { request_id: makeClientToken("tc-renew"), expired_time: nextIso };
  }

  // Must explicitly pass RenewDataDisk: false (RenewInstances defaults to true
  // upstream, which fails when an instance has no attached elastic data disk
  // and would diverge from the InquirePriceRenewInstances quote above).
  const data = await lighthouseRpc<Record<string, unknown>>(account, "RenewInstances", {
    InstanceIds: [account.instance_id],
    InstanceChargePrepaid: { Period: months },
    RenewDataDisk: false,
    AutoVoucher: opts.autoVoucher ?? true,
  });
  const detail = await getInstanceDetail(env, account).catch(() => null);
  return {
    request_id: asStrVal(data["RequestId"]),
    expired_time: detail?.expired_time ?? "",
  };
}

/** Update auto-renewal flag on a Tencent Lighthouse instance. */
export async function modifyAutoRenew(
  env: Env,
  account: AliyunAccount,
  renewFlag: TencentRenewFlag,
): Promise<void> {
  if (isDryRun(env)) {
    getOrSeedMockInstance(account).detail.renew_flag = renewFlag;
    return;
  }
  await lighthouseRpc(account, "ModifyInstancesRenewFlag", {
    InstanceIds: [account.instance_id],
    RenewFlag: renewFlag,
  });
}

/** Provision a new PrePaid Tencent Lighthouse instance. */
export async function createInstances(
  env: Env,
  account: AliyunAccount,
  opts: {
    planId: string;
    imageId: string;
    periodMonths: number;
    autoRenew?: boolean;
    instanceName?: string;
    clientToken?: string;
  },
): Promise<{ instance_ids: string[]; request_id: string }> {
  const months = Math.max(1, Math.trunc(opts.periodMonths));
  if (isDryRun(env)) {
    const id = `lhins-${Date.now().toString(36).slice(-8)}`;
    const m = getOrSeedMockInstance({ ...account, instance_id: id });
    m.detail.plan_id = opts.planId;
    m.detail.image_id = opts.imageId;
    m.detail.instance_name = opts.instanceName || `tencent-${id.slice(-4)}`;
    m.detail.renew_flag = opts.autoRenew ? "NOTIFY_AND_AUTO_RENEW" : "NOTIFY_AND_MANUAL_RENEW";
    return { instance_ids: [id], request_id: makeClientToken("tc-create") };
  }

  const body: Record<string, unknown> = {
    BundleId: opts.planId,
    BlueprintId: opts.imageId,
    InstanceCount: 1,
    InstanceChargePrepaid: {
      Period: months,
      RenewFlag: opts.autoRenew ? "NOTIFY_AND_AUTO_RENEW" : "NOTIFY_AND_MANUAL_RENEW",
    },
    AutoVoucher: true,
  };
  if (opts.instanceName) {
    body["InstanceName"] = opts.instanceName.slice(0, 60);
  }
  if (opts.clientToken) {
    body["ClientToken"] = opts.clientToken.slice(0, 64);
  }

  const data = await lighthouseRpc<Record<string, unknown>>(account, "CreateInstances", body);
  const ids = asArray<string>(data["InstanceIdSet"]).map((v) => String(v)).filter(Boolean);
  return {
    instance_ids: ids,
    request_id: asStrVal(data["RequestId"]),
  };
}

// ---------------------------------------------------------------------------
// Account balance & caller UIN (for billing & cross-account blueprint share)
// ---------------------------------------------------------------------------

/** Query Tencent Cloud account real available balance (converted from fen to yuan). */
export async function getAccountBalance(
  env: Env,
  account: AliyunAccount,
): Promise<AccountBalance> {
  const site = (account.site || "china").toLowerCase() === "international" ? "international" : "china";
  const currency = site === "international" ? "USD" : "CNY";
  if (isDryRun(env)) {
    return { amount: 256.8, currency, site };
  }
  const data = await tencentRpc<Record<string, unknown>>(
    "billing",
    BILLING_VERSION,
    account,
    "DescribeAccountBalance",
    {},
    { region: null },
  );
  const realFen = asNumVal(data["RealBalance"], asNumVal(data["Balance"], 0));
  return {
    amount: round2(realFen / 100),
    currency,
    site,
  };
}

/** Query current Tencent Cloud owner AccountId (UIN) via STS, falling back to Billing. */
export async function getCallerAccountId(
  env: Env,
  account: AliyunAccount,
): Promise<string> {
  if (isDryRun(env)) {
    const seed = Array.from(account.access_key_id).reduce((a, c) => a + c.charCodeAt(0), 0);
    return `1000${String(10000000 + (seed % 89999999))}`;
  }
  try {
    const data = await tencentRpc<Record<string, unknown>>(
      "sts",
      STS_VERSION,
      account,
      "GetCallerIdentity",
      {},
      { region: null },
    );
    const id = asStrVal(data["AccountId"]).trim();
    if (id) return id;
  } catch {
    // Fallback to Billing DescribeAccountBalance which also returns Uin.
  }
  const bill = await tencentRpc<Record<string, unknown>>(
    "billing",
    BILLING_VERSION,
    account,
    "DescribeAccountBalance",
    {},
    { region: null },
  );
  const uin = asStrVal(bill["Uin"]).trim();
  if (!uin) {
    throw new AliyunError("未能获取腾讯云主账号 ID，请确认密钥具备 STS 或费用中心只读权限");
  }
  return uin;
}

/** Build official Tencent Cloud renewal / recharge / orders console URLs. */
export function buildRenewalConsoleUrls(account: AliyunAccount): {
  renew_url: string;
  instance_url: string;
  recharge_url: string;
  orders_url: string;
} {
  const isIntl = (account.site || "china").toLowerCase() === "international";
  const host = isIntl ? "console.tencentcloud.com" : "console.cloud.tencent.com";
  return {
    renew_url: `https://${host}/expense/renew`,
    instance_url: buildConsoleUrl(account),
    recharge_url: `https://${host}/expense/recharge`,
    orders_url: `https://${host}/expense/deal`,
  };
}
