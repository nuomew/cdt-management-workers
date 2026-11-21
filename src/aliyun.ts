/**
 * Aliyun ECS / CDT / BSS client for Cloudflare Workers.
 *
 * Port of `app/aliyun.py` (BeacherZ/cdt-management, commit 3ccf6a7).
 *
 * The Python code uses the official Aliyun SDK (`AcsClient` /
 * `CommonRequest`), which is not available in Workers. The RPC signature is
 * therefore implemented from scratch here with WebCrypto:
 *   - percent-encoding per RFC 3986
 *   - SignatureMethod=HMAC-SHA1, SignatureVersion=1.0
 *   - SignatureNonce (random), Timestamp (UTC ISO-8601)
 *   - HMAC-SHA1 over `GET&%2F&<canonical query>` with key
 *     `accessKeySecret + "&"`, base64-encoded
 * All RPC calls are plain GET requests with the signed query string; the
 * Aliyun RPC APIs accept GET for every action used here.
 *
 * NEVER log or return secrets: error messages are redacted/classified by
 * `briefError` (mirrors the Python `_redact` / `brief_error`).
 *
 * Dry-run: when `env.CDT_DRY_RUN === "1"`, no live call is made; per-instance
 * state lives in a module-level `Map` (persists across calls within one
 * isolate) and mirrors `app/aliyun.py` `_mock` / `_mock_advance`, with the
 * async start/stop delay from `CDT_MOCK_OP_DELAY` (seconds, default 3).
 */

import type { Env } from "./env";
import { listServers } from "./repo";

export class AliyunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AliyunError";
  }
}

/** Account record, snake_case as stored in D1 (see `repo.getServer`). */
export interface AliyunAccount {
  access_key_id: string;
  access_key_secret: string;
  region_id: string;
  site: string;
  instance_id: string;
  stop_mode?: string;
  /** Only used by the dry-run mock to derive demo traffic/cost. */
  quota_gb?: number;
}

export interface InstanceInfo {
  status: string;
  stoppedMode: string;
  publicIp: string;
  regionId: string;
}

export interface AccountBalance {
  amount: number;
  currency: string;
  site: string;
}

export interface InstanceBill {
  total: number;
  site: string;
}

// ---------------------------------------------------------------------------
// Endpoints (aliyun.py: _endpoints / bss_endpoint, lines ~150-175)
// ---------------------------------------------------------------------------

export const CDT_DOMAIN = "cdt.aliyuncs.com";
// CDT is a centralised API, region-independent; upstream fixes it to Hong Kong.
export const CDT_REGION = "cn-hongkong";

export const BSS_VERSION = "2017-12-14";
export const ECS_VERSION = "2014-05-26";
export const CDT_VERSION = "2021-08-13";
export const VPC_VERSION = "2016-04-28";

const BSS_ENDPOINTS: Record<string, { region: string; domain: string }> = {
  china: { region: "cn-hangzhou", domain: "business.aliyuncs.com" },
  international: { region: "ap-southeast-1", domain: "business.ap-southeast-1.aliyuncs.com" },
};

export function ecsDomain(region: string): string {
  return `ecs.${region}.aliyuncs.com`;
}

export function vpcDomain(region: string): string {
  return `vpc.${region}.aliyuncs.com`;
}

/** Returns `{region, domain}` for BSS (balance/bill) by site; unknown site -> china. */
export function bssEndpoint(site: string): { region: string; domain: string } {
  return BSS_ENDPOINTS[site] ?? BSS_ENDPOINTS["china"]!;
}

/**
 * Whether the Aliyun client is usable. There is no vendor SDK in Workers —
 * the RPC signature is implemented from scratch — so "ready" means at least
 * one registered server has its AccessKey secret configured. (Previously
 * this was hardcoded to `false`, which made the panel permanently show
 * "阿里云 SDK 未就绪" even with a working account.)
 */
export async function sdkReady(env: Env): Promise<boolean> {
  const servers = await listServers(env);
  return servers.some((s) => s.secret_configured);
}

// ---------------------------------------------------------------------------
// Error redaction / classification (aliyun.py: brief_error, lines ~80-135)
// ---------------------------------------------------------------------------

const NET_ERROR_HINTS = [
  "network is unreachable",
  "max retries exceeded",
  "newconnectionerror",
  "failed to establish a new connection",
  "connection refused",
  "connection reset",
  "connection aborted",
  "temporary failure in name resolution",
  "name or service not known",
];
const TIMEOUT_HINTS = ["timed out", "timeout", "readtimeout"];
const AUTH_ERROR_HINTS = [
  "signaturedoesnotmatch",
  "invalidaccesskeyid",
  "invalidaccesskeysecret",
  "authfailure",
  "authsitefail",
  "forbidden",
  "unauthorized",
  "accessdenied",
];
const THROTTLE_HINTS = ["throttling", "requestlimitexceeded", "serviceunavailable"];

const SECRET_PARAM_RE =
  /\b(Signature|AccessKeyId|AccessKeySecret|SecurityToken|SignatureNonce|Password)=([^&\s'"]+)/gi;

function redact(text: string): string {
  return text
    .replace(SECRET_PARAM_RE, "$1=***")
    .replace(/<[^>]*object at 0x[0-9a-fA-F]+>/g, "<sdk-error>")
    .replace(/\b0x[0-9a-fA-F]{4,}\b/g, "0x***")
    .trim();
}

function errorHost(text: string): string {
  const m = /host=(?:'|")?([^'",\s)]+)/.exec(text);
  return m?.[1] ?? "";
}

/**
 * Compress a raw error into one human-readable, redacted line for events /
 * notifications. Mirrors Python `brief_error` (without SDK exception types).
 */
export function briefError(exc: unknown): string {
  const text = exc instanceof Error ? `${exc.name}: ${exc.message}` : String(exc);
  const low = text.toLowerCase();
  const host = errorHost(text);
  if (NET_ERROR_HINTS.some((h) => low.includes(h))) {
    return host ? `网络不可达（${host}）` : "网络不可达";
  }
  if (TIMEOUT_HINTS.some((h) => low.includes(h))) {
    return host ? `连接超时（${host}）` : "连接超时";
  }
  if (AUTH_ERROR_HINTS.some((h) => low.includes(h))) {
    return "鉴权失败（AccessKey 无效或无权限）";
  }
  if (THROTTLE_HINTS.some((h) => low.includes(h))) {
    return "接口限流，稍后重试";
  }
  // Prefer an Aliyun error code + message when the body carried one.
  const code = (exc as { code?: unknown } | null)?.code;
  const message = (exc as { message?: unknown } | null)?.message;
  if (typeof code === "string" && code && !["sdk.httperror", "sdk.servererror", "sdk.clienterror"].includes(code.toLowerCase())) {
    return redact(typeof message === "string" && message ? `${code}：${message}` : code).slice(0, 140);
  }
  return redact(text).slice(0, 140);
}

// ---------------------------------------------------------------------------
// RPC signing (from scratch, WebCrypto)
// ---------------------------------------------------------------------------

/** RFC 3986 percent-encoding: encodeURIComponent plus ! ' ( ) * . */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function utcTimestamp(date = new Date()): string {
  // e.g. 2026-11-12T01:15:52Z
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function hmacSha1Base64(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  const bytes = new Uint8Array(sig);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Sign an Aliyun RPC request and return the full HTTPS URL (GET).
 * `params` are the action parameters (Action/Version/RegionId/...); the
 * common signing parameters are added here.
 */
export async function signRpcUrl(
  domain: string,
  account: AliyunAccount,
  params: Record<string, string>,
): Promise<string> {
  const all: Record<string, string> = {
    ...params,
    Format: "JSON",
    AccessKeyId: account.access_key_id,
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    SignatureNonce: randomNonce(),
    Timestamp: utcTimestamp(),
  };
  const canonical = Object.keys(all)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(all[k]!)}`)
    .join("&");
  const stringToSign = `GET&${percentEncode("/")}&${percentEncode(canonical)}`;
  const signature = await hmacSha1Base64(`${account.access_key_secret}&`, stringToSign);
  return `https://${domain}/?${canonical}&Signature=${percentEncode(signature)}`;
}

// ---------------------------------------------------------------------------
// RPC transport
// ---------------------------------------------------------------------------

const HTTP_TIMEOUT_MS = 12_000; // settings.HTTP_TIMEOUT default 12s

interface RpcErrorBody {
  Code?: unknown;
  Message?: unknown;
  RequestId?: unknown;
}

async function rpcCall<T>(
  domain: string,
  account: AliyunAccount,
  params: Record<string, string>,
): Promise<T> {
  const url = await signRpcUrl(domain, account, params);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (err) {
    throw new AliyunError(briefError(err));
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new AliyunError(`接口返回非 JSON（HTTP ${res.status}）`);
  }
  // NOTE: Aliyun RPC success responses may still carry a `Code` field —
  // BSS returns Code "200" (QueryAccountBalance) or "Success"
  // (DescribeInstanceBill) on success, while ECS responses carry no Code
  // at all. Treating any present Code as an error made every BSS query
  // fail with e.g. "Success：Successful!" / "200：success" even though the
  // call had succeeded. Only a non-2xx HTTP status or a non-success Code
  // is an error.
  const body = (data !== null && typeof data === "object" ? data : {}) as RpcErrorBody;
  const code = typeof body.Code === "string" ? body.Code : "";
  const message = typeof body.Message === "string" ? body.Message : "";
  const isSuccessCode = code === "" || code === "200" || code === "Success";
  if (!res.ok || !isSuccessCode) {
    const errCode = code || `HTTP_${res.status}`;
    const err = new AliyunError(message || errCode);
    // Attach the code so callers (site fallback, no-stock detection) can read it.
    (err as AliyunError & { code?: string }).code = errCode;
    throw err;
  }
  return data as T;
}

function errorCode(exc: unknown): string {
  if (exc instanceof AliyunError) {
    return (exc as AliyunError & { code?: string }).code ?? "";
  }
  return "";
}

// Site-selection errors (aliyun.py: _SITE_ERROR_HINTS, lines ~243-246).
const SITE_ERROR_HINTS = ["AuthSiteFail", "NotApplicable", "site matches", "AuthPrincipal"];

function looksLikeSiteError(exc: unknown): boolean {
  const text = `${errorCode(exc)} ${exc instanceof Error ? exc.message : String(exc)}`;
  return SITE_ERROR_HINTS.some((h) => text.includes(h));
}

// ---------------------------------------------------------------------------
// BSS (balance / bill) with site fallback (aliyun.py: _bss_request /
// _bss_with_site_fallback, lines ~217-282)
// ---------------------------------------------------------------------------

async function bssRequest(
  account: AliyunAccount,
  action: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const { region, domain } = bssEndpoint(account.site || "china");
  return rpcCall<Record<string, unknown>>(domain, account, {
    Action: action,
    Version: BSS_VERSION,
    RegionId: region,
    ...params,
  });
}

async function bssWithSiteFallback(
  account: AliyunAccount,
  action: string,
  params: Record<string, string> = {},
): Promise<{ data: Record<string, unknown>; site: string }> {
  const site = account.site || "china";
  try {
    return { data: await bssRequest(account, action, params), site };
  } catch (exc) {
    if (!looksLikeSiteError(exc)) throw exc;
    const other = site === "china" ? "international" : "china";
    try {
      const data = await bssRequest({ ...account, site: other }, action, params);
      return { data, site: other };
    } catch {
      // Fallback also failed: the original error is more informative.
      throw exc;
    }
  }
}

// Balance: 6h in-process TTL cache (aliyun.py: BALANCE_TTL / _balance_cache).
const BALANCE_TTL_MS = 6 * 3600 * 1000;
const balanceCache = new Map<string, { at: number; value: AccountBalance }>();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getAccountBalance(
  env: Env,
  account: AliyunAccount,
  force = false,
): Promise<AccountBalance> {
  if (isDryRun(env)) {
    const state = mockState(env, account);
    return {
      amount: parseFloat(state.balance),
      currency: state.currency,
      site: account.site || "china",
    };
  }
  const key = (await sha256Hex(`${account.access_key_id}:${account.site || "china"}`)).slice(0, 20);
  const now = Date.now();
  const cached = balanceCache.get(key);
  if (cached && !force && now - cached.at < BALANCE_TTL_MS) {
    return { ...cached.value };
  }
  let data: Record<string, unknown>;
  let site: string;
  try {
    ({ data, site } = await bssWithSiteFallback(account, "QueryAccountBalance"));
  } catch (exc) {
    throw new AliyunError(`账户余额查询失败：${briefError(exc)}`);
  }
  const payload = (data["Data"] as Record<string, unknown> | undefined) ?? {};
  const amountRaw = payload["AvailableAmount"];
  const amount = typeof amountRaw === "number" ? amountRaw : parseFloat(String(amountRaw ?? "0")) || 0;
  const currencyRaw = payload["Currency"];
  const currency = (typeof currencyRaw === "string" && currencyRaw.trim()) || "CNY";
  const value: AccountBalance = { amount, currency, site };
  balanceCache.set(key, { at: now, value });
  return { ...value };
}

export async function getInstanceBill(
  env: Env,
  account: AliyunAccount,
  cycle: string,
): Promise<InstanceBill> {
  if (isDryRun(env)) {
    return {
      total: Math.round(parseFloat(mockState(env, account).cost) * 100) / 100,
      site: account.site || "china",
    };
  }
  let data: Record<string, unknown>;
  let site: string;
  try {
    ({ data, site } = await bssWithSiteFallback(account, "DescribeInstanceBill", {
      BillingCycle: cycle,
      InstanceID: account.instance_id,
      Granularity: "MONTHLY",
      MaxResults: "300",
    }));
  } catch (exc) {
    throw new AliyunError(`实例账单查询失败：${briefError(exc)}`);
  }
  const dataObj = (data["Data"] as Record<string, unknown> | undefined) ?? {};
  let items: unknown = dataObj["Items"] ?? [];
  // Some responses wrap the array as {"Item": [...]}.
  if (items !== null && typeof items === "object" && !Array.isArray(items)) {
    items = (items as Record<string, unknown>)["Item"] ?? [];
  }
  let total = 0;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (item === null || typeof item !== "object") continue;
      const v = (item as Record<string, unknown>)["PretaxAmount"];
      const n = typeof v === "number" ? v : parseFloat(String(v ?? "0"));
      if (Number.isFinite(n)) total += n;
    }
  }
  return { total: Math.round(total * 100) / 100, site };
}

// ---------------------------------------------------------------------------
// CDT traffic (aliyun.py: get_traffic_gb, lines ~447-476)
// Action: ListCdtInternetTraffic, version 2021-08-13, domain cdt.aliyuncs.com,
// region cn-hongkong. Sums all TrafficDetails[].Traffic (bytes) -> GB.
// Returns null when the call succeeds but no detail rows are returned.
// ---------------------------------------------------------------------------

interface TrafficDetail {
  Traffic?: unknown;
}

export async function getTrafficGb(env: Env, account: AliyunAccount): Promise<number | null> {
  if (isDryRun(env)) {
    return parseFloat(mockState(env, account).traffic);
  }
  let data: Record<string, unknown>;
  try {
    data = await rpcCall<Record<string, unknown>>(CDT_DOMAIN, account, {
      Action: "ListCdtInternetTraffic",
      Version: CDT_VERSION,
      RegionId: CDT_REGION,
    });
  } catch (exc) {
    throw new AliyunError(`CDT 流量查询失败：${briefError(exc)}`);
  }
  const details = (data["TrafficDetails"] as TrafficDetail[] | undefined) ?? [];
  if (!Array.isArray(details) || details.length === 0) return null;
  let totalBytes = 0;
  for (const item of details) {
    const v = item?.Traffic;
    const n = typeof v === "number" ? v : parseFloat(String(v ?? "0"));
    if (Number.isFinite(n)) totalBytes += n;
  }
  return totalBytes / 1024 ** 3;
}

// ---------------------------------------------------------------------------
// ECS instances (aliyun.py: get_instance / start_instance / stop_instance,
// lines ~478-577). Actions: DescribeInstances / StartInstances /
// StopInstances, version 2014-05-26, domain ecs.<region>.aliyuncs.com.
// ---------------------------------------------------------------------------

interface EcsInstance {
  Status?: unknown;
  StoppedMode?: unknown;
  RegionId?: unknown;
  ZoneId?: unknown;
  EipAddress?: { IpAddress?: unknown };
  PublicIpAddress?: { IpAddress?: unknown };
}

export async function getInstance(env: Env, account: AliyunAccount): Promise<InstanceInfo> {
  if (isDryRun(env)) {
    const state = mockState(env, account);
    mockAdvance(state);
    return {
      status: state.status,
      stoppedMode: state.stopped_mode,
      publicIp: state.public_ip,
      regionId: account.region_id || "",
    };
  }
  let data: Record<string, unknown>;
  try {
    // DescribeInstancesRequest.set_InstanceIds takes a JSON array string.
    data = await rpcCall<Record<string, unknown>>(ecsDomain(account.region_id), account, {
      Action: "DescribeInstances",
      Version: ECS_VERSION,
      RegionId: account.region_id,
      InstanceIds: JSON.stringify([account.instance_id]),
    });
  } catch (exc) {
    if (exc instanceof AliyunError && exc.message.startsWith("实例状态查询失败")) throw exc;
    throw new AliyunError(`实例状态查询失败：${briefError(exc)}`);
  }
  const instances = ((data["Instances"] as Record<string, unknown> | undefined)?.["Instance"] as EcsInstance[] | undefined) ?? [];
  if (!Array.isArray(instances) || instances.length === 0) {
    throw new AliyunError("实例状态查询失败：实例不存在或已释放，请检查实例 ID 与地域");
  }
  const inst = instances[0]!;
  const eip = inst.EipAddress?.IpAddress;
  let publicIp: string;
  if (eip) {
    publicIp = String(eip);
  } else {
    const addresses = inst.PublicIpAddress?.IpAddress;
    publicIp = Array.isArray(addresses) && addresses.length > 0 ? String(addresses[0]) : "";
  }
  const region = String(inst.RegionId ?? inst.ZoneId ?? "").trim();
  return {
    status: String(inst.Status ?? ""),
    stoppedMode: String(inst.StoppedMode ?? ""),
    publicIp,
    regionId: region,
  };
}

// Stock-out error codes on start (aliyun.py: _NO_STOCK_HINTS, lines ~520-524).
const NO_STOCK_HINTS = ["InsufficientInventory", "NoStock"];

export async function startInstance(env: Env, account: AliyunAccount): Promise<void> {
  if (isDryRun(env)) {
    const state = mockState(env, account);
    const delay = mockOpDelay(env);
    if (delay <= 0) {
      state.status = "Running";
      state.stopped_mode = "";
      state.pending_until = 0;
      state.target_status = "";
    } else {
      state.status = "Starting";
      state.stopped_mode = "";
      state.target_status = "Running";
      state.pending_until = Date.now() / 1000 + delay;
    }
    return;
  }
  try {
    // NOTE: the official SDK's StartInstancesRequest.set_InstanceIds
    // serialises the list as `InstanceId.1`, `InstanceId.2`, ... — note the
    // SINGULAR `InstanceId`, not `InstanceIds`. Both `InstanceIds.1` and
    // a JSON-array `InstanceIds` are rejected with MissingParameter
    // "InstanceId ... is not supplied" (verified live 2026-11-12).
    await rpcCall(ecsDomain(account.region_id), account, {
      Action: "StartInstances",
      Version: ECS_VERSION,
      RegionId: account.region_id,
      "InstanceId.1": account.instance_id,
    });
  } catch (exc) {
    const raw = `${errorCode(exc)} ${exc instanceof Error ? exc.message : String(exc)}`;
    if (NO_STOCK_HINTS.some((h) => raw.includes(h))) {
      const code = errorCode(exc) || "InsufficientInventory";
      throw new AliyunError(`库存不足（${code}），${account.region_id || "该地域"} 暂无可用实例库存`);
    }
    throw new AliyunError(`启动实例失败：${briefError(exc)}`);
  }
}

/**
 * Stop the instance. `mode` defaults to "StopCharging" (saves instance fees).
 * With `fallback=true`, an unsupported StopCharging falls back to plain "Stop".
 * Returns the **actually applied** stopped mode ("Stop" when it fell back).
 */
export async function stopInstance(
  env: Env,
  account: AliyunAccount,
  mode = "StopCharging",
  fallback = false,
): Promise<string> {
  if (isDryRun(env)) {
    const state = mockState(env, account);
    const delay = mockOpDelay(env);
    if (delay <= 0) {
      state.status = "Stopped";
      state.stopped_mode = mode;
      state.pending_until = 0;
      state.target_status = "";
    } else {
      state.status = "Stopping";
      state.stopped_mode = mode;
      state.target_status = "Stopped";
      state.pending_until = Date.now() / 1000 + delay;
    }
    return mode;
  }
  const params: Record<string, string> = {
    Action: "StopInstances",
    Version: ECS_VERSION,
    RegionId: account.region_id,
    // Same as StartInstances: the SDK uses singular `InstanceId.N`
    // (see above); `InstanceIds.1` / JSON array are rejected.
    "InstanceId.1": account.instance_id,
    StoppedMode: mode,
  };
  try {
    await rpcCall(ecsDomain(account.region_id), account, params);
    return mode;
  } catch (exc) {
    if (fallback && mode !== "Stop") {
      try {
        await rpcCall(ecsDomain(account.region_id), account, { ...params, StoppedMode: "Stop" });
        return "Stop";
      } catch (retryExc) {
        throw new AliyunError(`停止实例失败：${briefError(retryExc)}`);
      }
    }
    throw new AliyunError(`停止实例失败：${briefError(exc)}`);
  }
}

// ---------------------------------------------------------------------------
// ECS discovery & management (ported from nuomew/aly-CDTCF)
// ---------------------------------------------------------------------------

/** Scan-order region lists kept aligned with web/src/regions.ts. */
const CHINA_SCAN_REGIONS: readonly string[] = [
  "cn-hongkong",
  "ap-southeast-1",
  "ap-northeast-1",
  "cn-hangzhou",
  "cn-shanghai",
  "cn-beijing",
  "cn-shenzhen",
  "cn-guangzhou",
  "cn-chengdu",
  "cn-qingdao",
  "cn-zhangjiakou",
  "cn-huhehaote",
  "cn-wulanchabu",
  "cn-heyuan",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-5",
  "ap-southeast-6",
  "ap-southeast-7",
  "ap-northeast-2",
  "ap-south-1",
  "us-west-1",
  "us-east-1",
  "eu-west-1",
  "eu-central-1",
  "me-east-1",
];

const INTL_SCAN_REGIONS: readonly string[] = [
  "cn-hongkong",
  "ap-southeast-1",
  "ap-northeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-5",
  "ap-southeast-6",
  "ap-southeast-7",
  "ap-southeast-8",
  "ap-northeast-2",
  "ap-south-1",
  "us-west-1",
  "us-east-1",
  "na-south-1",
  "sa-east-1",
  "eu-west-1",
  "eu-central-1",
  "me-east-1",
  "me-central-1",
];

export interface DiscoveredInstance {
  instance_id: string;
  instance_name: string;
  region_id: string;
  status: string;
  stopped_mode: string;
  instance_type: string;
  cpu: number;
  memory: number;
  os_name: string;
  public_ip: string;
  private_ip: string;
  bandwidth: number;
  charge_type: string;
  creation_time: string;
  expired_time: string;
}

export interface InstanceDetail {
  instance_id: string;
  instance_name: string;
  description: string;
  status: string;
  stopped_mode: string;
  instance_type: string;
  os_name: string;
  os_type: string;
  region_id: string;
  zone_id: string;
  public_ips: string[];
  private_ips: string[];
  vpc_id: string;
  vswitch_id: string;
  security_group_ids: string[];
  internet_charge_type: string;
  internet_max_bandwidth_in: number;
  internet_max_bandwidth_out: number;
  creation_time: string;
  expired_time: string;
  image_id: string;
  cpu: number;
  memory: number;
  instance_charge_type: string;
  network_type: string;
  operation_locks: string[];
  deletion_protection: boolean;
}

export interface InstanceDisk {
  disk_id: string;
  disk_name: string;
  type: string;
  size: number;
  category: string;
  status: string;
  creation_time: string;
}

export interface EcsImage {
  image_id: string;
  image_name: string;
  os_name: string;
  os_type: string;
  architecture: string;
  image_version: string;
  size: number;
  owner_alias: string;
  description: string;
  status: string;
  progress: string;
  creation_time: string;
  usage: string;
  is_self_shared: boolean;
}

export interface ImageShareAccount {
  aliyun_id: string;
  shared_time: string;
}

export interface VncInfo {
  vnc_url: string;
  console_url: string;
}

export interface AutoRenewInfo {
  auto_renew_enabled: boolean;
  renewal_status: "AutoRenewal" | "Normal" | "NotRenewal" | string;
  duration: number;
  period_unit: string;
}

export interface PriceQuote {
  original_price: number;
  discount_price: number;
  trade_price: number;
  currency: string;
  period: number;
  price_unit: string;
  rules: string[];
  estimated?: boolean;
  note?: string;
}

export interface RenewalConsoleUrls {
  renew_url: string;
  instance_url: string;
  recharge_url: string;
  orders_url: string;
}

export interface SecurityGroupRule {
  rule_id: string;
  direction: "ingress" | "egress";
  ip_protocol: string;
  port_range: string;
  source_cidr_ip: string;
  dest_cidr_ip: string;
  policy: string;
  priority: number;
  description: string;
  create_time: string;
}

export interface SecurityGroupDetail {
  security_group_id: string;
  security_group_name: string;
  vpc_id: string;
  description: string;
  rules: SecurityGroupRule[];
}

export interface VSwitchInfo {
  vswitch_id: string;
  vswitch_name: string;
  vpc_id: string;
  zone_id: string;
  cidr_block: string;
  available_ip_count: number;
  is_default: boolean;
}

export interface SecurityGroupSummary {
  security_group_id: string;
  security_group_name: string;
  vpc_id: string;
  security_group_type: string;
  description: string;
}

export interface InstanceTypeOffer {
  instance_type: string;
  cpu: number;
  memory_gb: number;
  family: string;
  zones: string[];
}

export interface ProvisionResources {
  region_id: string;
  zones: string[];
  instance_types: InstanceTypeOffer[];
  vswitches: VSwitchInfo[];
  security_groups: SecurityGroupSummary[];
}

export interface RunInstanceResult {
  instance_ids: string[];
  order_id: string;
  trade_price: number | null;
}

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value !== null && value !== undefined) return [value as T];
  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStrVal(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function asNumVal(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function extractPublicIps(raw: Record<string, unknown>): string[] {
  const ips: string[] = [];
  const eip = asStrVal(asRecord(raw["EipAddress"])["IpAddress"]).trim();
  if (eip) ips.push(eip);
  const pubList = asArray<unknown>(asRecord(raw["PublicIpAddress"])["IpAddress"]);
  for (const item of pubList) {
    const ip = asStrVal(item).trim();
    if (ip && !ips.includes(ip)) ips.push(ip);
  }
  return ips;
}

function extractPrivateIps(raw: Record<string, unknown>): string[] {
  const vpcList = asArray<unknown>(
    asRecord(asRecord(raw["VpcAttributes"])["PrivateIpAddress"])["IpAddress"],
  );
  const innerList = asArray<unknown>(asRecord(raw["InnerIpAddress"])["IpAddress"]);
  const source = vpcList.length > 0 ? vpcList : innerList;
  return source.map((v) => asStrVal(v).trim()).filter(Boolean);
}

function extractOperationLocks(raw: Record<string, unknown>): string[] {
  const locks = asArray<unknown>(asRecord(raw["OperationLocks"])["LockReason"]);
  return locks
    .map((item) => {
      if (typeof item === "string") return item;
      return asStrVal(asRecord(item)["LockReason"]);
    })
    .filter(Boolean);
}

function parseDiscoveredInstance(
  raw: Record<string, unknown>,
  fallbackRegion: string,
): DiscoveredInstance {
  const publicIps = extractPublicIps(raw);
  const privateIps = extractPrivateIps(raw);
  const eipBandwidth = asNumVal(asRecord(raw["EipAddress"])["Bandwidth"]);
  const bandwidth = eipBandwidth > 0 ? eipBandwidth : asNumVal(raw["InternetMaxBandwidthOut"]);
  return {
    instance_id: asStrVal(raw["InstanceId"]).trim(),
    instance_name: asStrVal(raw["InstanceName"]).trim(),
    region_id: asStrVal(raw["RegionId"]).trim() || fallbackRegion,
    status: asStrVal(raw["Status"]).trim() || "Unknown",
    stopped_mode: asStrVal(raw["StoppedMode"]).trim(),
    instance_type: asStrVal(raw["InstanceType"]).trim(),
    cpu: asNumVal(raw["Cpu"]),
    memory: asNumVal(raw["Memory"]),
    os_name: asStrVal(raw["OSName"]).trim() || asStrVal(raw["OSNameEn"]).trim(),
    public_ip: publicIps[0] ?? "",
    private_ip: privateIps[0] ?? "",
    bandwidth,
    charge_type: asStrVal(raw["InstanceChargeType"]).trim(),
    creation_time: asStrVal(raw["CreationTime"]).trim(),
    expired_time: asStrVal(raw["ExpiredTime"]).trim(),
  };
}

function parseInstanceDetail(
  raw: Record<string, unknown>,
  fallbackRegion: string,
): InstanceDetail {
  const eipObj = asRecord(raw["EipAddress"]);
  const vpcObj = asRecord(raw["VpcAttributes"]);
  const eipBandwidth = asNumVal(eipObj["Bandwidth"]);
  const bandwidthOut = eipBandwidth > 0 ? eipBandwidth : asNumVal(raw["InternetMaxBandwidthOut"]);
  const internetChargeType =
    asStrVal(raw["InternetChargeType"]).trim() ||
    asStrVal(eipObj["InternetChargeType"]).trim();
  const osName = asStrVal(raw["OSName"]).trim() || asStrVal(raw["OSNameEn"]).trim();
  const osType =
    asStrVal(raw["OSType"]).trim().toLowerCase() ||
    (osName.toLowerCase().includes("windows") ? "windows" : "linux");
  return {
    instance_id: asStrVal(raw["InstanceId"]).trim(),
    instance_name: asStrVal(raw["InstanceName"]).trim(),
    description: asStrVal(raw["Description"]).trim(),
    status: asStrVal(raw["Status"]).trim() || "Unknown",
    stopped_mode: asStrVal(raw["StoppedMode"]).trim(),
    instance_type: asStrVal(raw["InstanceType"]).trim(),
    os_name: osName,
    os_type: osType,
    region_id: asStrVal(raw["RegionId"]).trim() || fallbackRegion,
    zone_id: asStrVal(raw["ZoneId"]).trim(),
    public_ips: extractPublicIps(raw),
    private_ips: extractPrivateIps(raw),
    vpc_id: asStrVal(vpcObj["VpcId"]).trim(),
    vswitch_id: asStrVal(vpcObj["VSwitchId"]).trim(),
    security_group_ids: asArray<unknown>(
      asRecord(raw["SecurityGroupIds"])["SecurityGroupId"],
    )
      .map((s) => asStrVal(s).trim())
      .filter(Boolean),
    internet_charge_type: internetChargeType,
    internet_max_bandwidth_in: asNumVal(raw["InternetMaxBandwidthIn"]),
    internet_max_bandwidth_out: bandwidthOut,
    creation_time: asStrVal(raw["CreationTime"]).trim(),
    expired_time: asStrVal(raw["ExpiredTime"]).trim(),
    image_id: asStrVal(raw["ImageId"]).trim(),
    cpu: asNumVal(raw["Cpu"]),
    memory: asNumVal(raw["Memory"]),
    instance_charge_type: asStrVal(raw["InstanceChargeType"]).trim(),
    network_type: asStrVal(raw["InstanceNetworkType"]).trim(),
    operation_locks: extractOperationLocks(raw),
    deletion_protection: Boolean(raw["DeletionProtection"]),
  };
}

/** List all ECS instances in a single region using the given credentials. */
export async function listInstancesInRegion(
  env: Env,
  creds: { access_key_id: string; access_key_secret: string; site?: string },
  regionId: string,
): Promise<DiscoveredInstance[]> {
  if (isDryRun(env)) {
    return [
      {
        instance_id: `i-mock-${regionId.replace(/[^a-z0-9]/gi, "")}01`,
        instance_name: `demo-${regionId}`,
        region_id: regionId,
        status: "Running",
        stopped_mode: "",
        instance_type: "ecs.e-c1m1.large",
        cpu: 2,
        memory: 2048,
        os_name: "Debian 12.6 64位",
        public_ip: "47.243.10.20",
        private_ip: "172.16.0.10",
        bandwidth: 200,
        charge_type: "PostPaid",
        creation_time: "2026-01-01T00:00Z",
        expired_time: "",
      },
    ];
  }
  const account: AliyunAccount = {
    access_key_id: creds.access_key_id,
    access_key_secret: creds.access_key_secret,
    region_id: regionId,
    site: creds.site || "china",
    instance_id: "",
  };
  const data = await rpcCall<Record<string, unknown>>(ecsDomain(regionId), account, {
    Action: "DescribeInstances",
    Version: ECS_VERSION,
    RegionId: regionId,
    PageNumber: "1",
    PageSize: "50",
  });
  const rawList = asArray<unknown>(asRecord(data["Instances"])["Instance"]);
  return rawList
    .map((item) => parseDiscoveredInstance(asRecord(item), regionId))
    .filter((inst) => Boolean(inst.instance_id));
}

function isAuthError(exc: unknown): boolean {
  const text = `${errorCode(exc)} ${exc instanceof Error ? exc.message : String(exc)}`.toLowerCase();
  return AUTH_ERROR_HINTS.some((h) => text.includes(h));
}

/**
 * Discover ECS instances for a single region or across all regions of a site.
 * Runs regions in bounded batches of 8 to stay well below Workers subrequest limits.
 */
export async function discoverInstances(
  env: Env,
  creds: { access_key_id: string; access_key_secret: string; site?: string },
  opts: { regionId?: string; scanAll?: boolean },
): Promise<{ items: DiscoveredInstance[]; scanned_regions: number }> {
  const site = creds.site === "international" ? "international" : "china";
  if (!opts.scanAll) {
    const region = (opts.regionId || "cn-hongkong").trim();
    try {
      const items = await listInstancesInRegion(env, creds, region);
      return { items, scanned_regions: 1 };
    } catch (exc) {
      throw new AliyunError(`查询实例列表失败：${briefError(exc)}`);
    }
  }

  const regions = site === "international" ? INTL_SCAN_REGIONS : CHINA_SCAN_REGIONS;
  if (isDryRun(env)) {
    const first = regions[0] ?? "cn-hongkong";
    return {
      items: await listInstancesInRegion(env, creds, first),
      scanned_regions: regions.length,
    };
  }

  const results: DiscoveredInstance[] = [];
  let authFailure: unknown = null;
  let lastFailure: unknown = null;
  let succeeded = 0;

  // Probe the first batch; fail fast if credentials themselves are invalid.
  const batchSize = 8;
  for (let i = 0; i < regions.length; i += batchSize) {
    const slice = regions.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      slice.map((region) => listInstancesInRegion(env, creds, region)),
    );
    for (const item of settled) {
      if (item.status === "fulfilled") {
        succeeded++;
        results.push(...item.value);
      } else {
        lastFailure = item.reason;
        if (isAuthError(item.reason)) authFailure = item.reason;
      }
    }
    if (succeeded === 0 && authFailure) {
      throw new AliyunError(`查询实例列表失败：${briefError(authFailure)}`);
    }
  }

  if (succeeded === 0 && lastFailure) {
    throw new AliyunError(`查询实例列表失败：${briefError(lastFailure)}`);
  }
  return { items: results, scanned_regions: regions.length };
}

/**
 * Fetch detailed instance attributes. Prefers DescribeInstances (richer fields
 * including OSName, Cpu, Memory, EipAddress) and falls back to
 * DescribeInstanceAttribute when needed.
 */
export async function getInstanceDetail(
  env: Env,
  account: AliyunAccount,
): Promise<InstanceDetail> {
  if (isDryRun(env)) {
    const state = mockState(env, account);
    mockAdvance(state);
    const meta = mockInstanceMeta(account);
    if (meta.deleted) {
      throw new AliyunError("实例不存在或已释放");
    }
    return {
      instance_id: account.instance_id,
      instance_name: meta.instance_name,
      description: meta.description,
      status: state.status,
      stopped_mode: state.stopped_mode,
      instance_type: meta.instance_type,
      os_name: meta.os_name,
      os_type: "linux",
      region_id: account.region_id,
      zone_id: meta.zone_id,
      public_ips: state.public_ip ? [state.public_ip] : [],
      private_ips: ["172.16.0.10"],
      vpc_id: meta.vpc_id,
      vswitch_id: meta.vswitch_id,
      security_group_ids: [meta.security_group_id],
      internet_charge_type: meta.internet_charge_type,
      internet_max_bandwidth_in: meta.bandwidth_out || 10,
      internet_max_bandwidth_out: meta.bandwidth_out,
      creation_time: meta.creation_time,
      expired_time: meta.expired_time,
      image_id: meta.image_id,
      cpu: meta.cpu,
      memory: meta.memory,
      instance_charge_type: meta.charge_type,
      network_type: "vpc",
      operation_locks: [],
      deletion_protection: meta.deletion_protection,
    };
  }
  let raw: Record<string, unknown> | null = null;
  try {
    const data = await rpcCall<Record<string, unknown>>(ecsDomain(account.region_id), account, {
      Action: "DescribeInstances",
      Version: ECS_VERSION,
      RegionId: account.region_id,
      InstanceIds: JSON.stringify([account.instance_id]),
    });
    const list = asArray<unknown>(asRecord(data["Instances"])["Instance"]);
    if (list.length > 0) raw = asRecord(list[0]);
  } catch {
    // Fall back to DescribeInstanceAttribute below.
  }
  if (!raw) {
    try {
      raw = await rpcCall<Record<string, unknown>>(ecsDomain(account.region_id), account, {
        Action: "DescribeInstanceAttribute",
        Version: ECS_VERSION,
        RegionId: account.region_id,
        InstanceId: account.instance_id,
      });
    } catch (exc) {
      throw new AliyunError(`获取实例详情失败：${briefError(exc)}`);
    }
  }
  return parseInstanceDetail(raw, account.region_id);
}

/** List system and data disks attached to an instance. */
export async function listInstanceDisks(
  env: Env,
  account: AliyunAccount,
): Promise<InstanceDisk[]> {
  if (isDryRun(env)) {
    return [
      {
        disk_id: "d-mock-system01",
        disk_name: "system-disk",
        type: "system",
        size: 40,
        category: "cloud_essd",
        status: "In_use",
        creation_time: "2026-01-01T00:00Z",
      },
    ];
  }
  let data: Record<string, unknown>;
  try {
    data = await rpcCall<Record<string, unknown>>(ecsDomain(account.region_id), account, {
      Action: "DescribeDisks",
      Version: ECS_VERSION,
      RegionId: account.region_id,
      InstanceId: account.instance_id,
      PageSize: "50",
    });
  } catch (exc) {
    throw new AliyunError(`查询磁盘信息失败：${briefError(exc)}`);
  }
  const rawList = asArray<unknown>(asRecord(data["Disks"])["Disk"]);
  return rawList.map((item) => {
    const d = asRecord(item);
    return {
      disk_id: asStrVal(d["DiskId"]).trim(),
      disk_name: asStrVal(d["DiskName"]).trim(),
      type: asStrVal(d["Type"]).trim(),
      size: asNumVal(d["Size"]),
      category: asStrVal(d["Category"]).trim(),
      status: asStrVal(d["Status"]).trim(),
      creation_time: asStrVal(d["CreationTime"]).trim(),
    };
  });
}

/** Reboot a running ECS instance (uses RebootInstance with official ForceStop param). */
export async function rebootInstance(
  env: Env,
  account: AliyunAccount,
  forceStop = false,
): Promise<void> {
  if (isDryRun(env)) {
    const state = mockState(env, account);
    state.status = "Running";
    state.stopped_mode = "";
    return;
  }
  try {
    await rpcCall(ecsDomain(account.region_id), account, {
      Action: "RebootInstance",
      Version: ECS_VERSION,
      RegionId: account.region_id,
      InstanceId: account.instance_id,
      ForceStop: forceStop ? "true" : "false",
    });
  } catch (exc) {
    throw new AliyunError(`重启实例失败：${briefError(exc)}`);
  }
}

/** Fetch a temporary Aliyun VNC URL for embedded browser console access. */
export async function getInstanceVncUrl(
  env: Env,
  account: AliyunAccount,
): Promise<VncInfo> {
  const consoleUrl = `https://ecs.console.aliyun.com/vnc/${encodeURIComponent(account.instance_id)}?regionId=${encodeURIComponent(account.region_id)}`;
  if (isDryRun(env)) {
    return {
      vnc_url: `wss://mock.vnc.local/${account.instance_id}`,
      console_url: consoleUrl,
    };
  }
  let data: Record<string, unknown>;
  try {
    data = await rpcCall<Record<string, unknown>>(ecsDomain(account.region_id), account, {
      Action: "DescribeInstanceVncUrl",
      Version: ECS_VERSION,
      RegionId: account.region_id,
      InstanceId: account.instance_id,
    });
  } catch (exc) {
    throw new AliyunError(`获取 VNC 连接地址失败：${briefError(exc)}`);
  }
  const vncUrl = asStrVal(data["VncUrl"]).trim();
  if (!vncUrl) {
    throw new AliyunError("获取 VNC 连接地址失败：阿里云未返回 VncUrl");
  }
  return { vnc_url: vncUrl, console_url: consoleUrl };
}

const STS_DOMAIN = "sts.aliyuncs.com";
const STS_VERSION = "2015-04-01";
const callerAccountCache = new Map<string, string>();

// In-memory mock store for CDT_DRY_RUN=1 image creation and sharing tests.
interface MockImageEntry {
  image: EcsImage;
  ownerAccountId: string;
  sharedWith: Map<string, string>;
}
const mockCustomImages = new Map<string, MockImageEntry>();

function mockAccountIdFor(ak: string): string {
  const hash = Array.from(ak || "mock").reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 1_000_000_000, 100_000_000);
  return `1000000${String(Math.abs(hash)).padStart(9, "0")}`;
}

/**
 * Resolve the 16-digit Alibaba Cloud primary account UID for an AccessKey via
 * STS GetCallerIdentity. Cached in memory per AccessKeyId.
 */
export async function getCallerAccountId(
  env: Env,
  account: Pick<AliyunAccount, "access_key_id" | "access_key_secret" | "region_id" | "site">,
): Promise<string> {
  const ak = account.access_key_id.trim();
  if (!ak) throw new AliyunError("无法获取账号 UID：缺少 AccessKey ID");
  if (isDryRun(env)) return mockAccountIdFor(ak);

  const cached = callerAccountCache.get(ak);
  if (cached) return cached;

  const full: AliyunAccount = {
    access_key_id: ak,
    access_key_secret: account.access_key_secret,
    region_id: account.region_id || "cn-hongkong",
    site: account.site || "china",
    instance_id: "",
  };
  let data: Record<string, unknown>;
  try {
    data = await rpcCall<Record<string, unknown>>(STS_DOMAIN, full, {
      Action: "GetCallerIdentity",
      Version: STS_VERSION,
    });
  } catch (exc) {
    throw new AliyunError(`获取阿里云账号 UID 失败：${briefError(exc)}`);
  }
  const accountId = asStrVal(data["AccountId"]).trim();
  if (!accountId) {
    throw new AliyunError("获取阿里云账号 UID 失败：STS 未返回 AccountId");
  }
  callerAccountCache.set(ak, accountId);
  return accountId;
}

/** List ECS images in the instance's region (supports reinstall and image management). */
export async function listImages(
  env: Env,
  account: AliyunAccount,
  opts: { ownerAlias?: string; osType?: string; includeAllStatus?: boolean } = {},
): Promise<EcsImage[]> {
  const ownerAlias = opts.ownerAlias || "system";
  const osType = opts.osType || "";
  if (isDryRun(env)) {
    const selfUid = mockAccountIdFor(account.access_key_id);
    if (ownerAlias === "self") {
      const list = Array.from(mockCustomImages.values())
        .filter((entry) => entry.ownerAccountId === selfUid)
        .map((entry) => ({
          ...entry.image,
          is_self_shared: entry.sharedWith.size > 0,
        }));
      return list.filter((img) => !osType || img.os_type === osType.toLowerCase());
    }
    if (ownerAlias === "others") {
      const list = Array.from(mockCustomImages.values())
        .filter((entry) => entry.sharedWith.has(selfUid))
        .map((entry) => ({
          ...entry.image,
          owner_alias: "others",
          is_self_shared: false,
        }));
      return list.filter((img) => !osType || img.os_type === osType.toLowerCase());
    }
    return [
      {
        image_id: "debian_12_6_x64_20G_alibase_20240819.vhd",
        image_name: "debian_12_6_x64_20G_alibase_20240819.vhd",
        os_name: "Debian 12.6 64位",
        os_type: "linux",
        architecture: "x86_64",
        image_version: "12.6",
        size: 20,
        owner_alias: ownerAlias,
        description: "Debian 12",
        status: "Available",
        progress: "100%",
        creation_time: "2026-01-01T00:00Z",
        usage: "none",
        is_self_shared: false,
      },
      {
        image_id: "ubuntu_24_04_x64_20G_alibase_20240812.vhd",
        image_name: "ubuntu_24_04_x64_20G_alibase_20240812.vhd",
        os_name: "Ubuntu 24.04 64位",
        os_type: "linux",
        architecture: "x86_64",
        image_version: "24.04",
        size: 20,
        owner_alias: ownerAlias,
        description: "Ubuntu 24.04 LTS",
        status: "Available",
        progress: "100%",
        creation_time: "2026-01-01T00:00Z",
        usage: "none",
        is_self_shared: false,
      },
    ].filter((img) => !osType || img.os_type === osType.toLowerCase());
  }
  const params: Record<string, string> = {
    Action: "DescribeImages",
    Version: ECS_VERSION,
    RegionId: account.region_id,
    PageNumber: "1",
    PageSize: "100",
  };
  if (opts.includeAllStatus) {
    params["Status"] = "Creating,Waiting,Available,UnAvailable,CreateFailed";
  } else {
    params["Status"] = "Available";
  }
  if (ownerAlias) params["ImageOwnerAlias"] = ownerAlias;
  // For `others`, set IsPublic=false so only images directly shared with this
  // account are returned (excluding public community images).
  if (ownerAlias === "others") params["IsPublic"] = "false";
  if (osType) params["OSType"] = osType;
  let data: Record<string, unknown>;
  try {
    data = await rpcCall<Record<string, unknown>>(ecsDomain(account.region_id), account, params);
  } catch (exc) {
    throw new AliyunError(`查询镜像列表失败：${briefError(exc)}`);
  }
  const rawList = asArray<unknown>(asRecord(data["Images"])["Image"]);
  return rawList.map((item) => {
    const img = asRecord(item);
    const isSelfSharedRaw = img["IsSelfShared"];
    return {
      image_id: asStrVal(img["ImageId"]).trim(),
      image_name: asStrVal(img["ImageName"]).trim(),
      os_name:
        asStrVal(img["OSName"]).trim() ||
        asStrVal(img["OSNameEn"]).trim() ||
        asStrVal(img["ImageName"]).trim(),
      os_type: asStrVal(img["OSType"]).trim().toLowerCase(),
      architecture: asStrVal(img["Architecture"]).trim(),
      image_version: asStrVal(img["ImageVersion"]).trim(),
      size: asNumVal(img["Size"]),
      owner_alias: asStrVal(img["ImageOwnerAlias"]).trim(),
      description: asStrVal(img["Description"]).trim(),
      status: asStrVal(img["Status"]).trim() || "Available",
      progress: asStrVal(img["Progress"]).trim(),
      creation_time: asStrVal(img["CreationTime"]).trim(),
      usage: asStrVal(img["Usage"]).trim(),
      is_self_shared:
        isSelfSharedRaw === true || asStrVal(isSelfSharedRaw).toLowerCase() === "true",
    };
  });
}

/** Create a custom image from the specified ECS instance. */
export async function createImage(
  env: Env,
  account: AliyunAccount,
  opts: { imageName: string; description?: string },
): Promise<{ image_id: string }> {
  if (isDryRun(env)) {
    const id = `m-mock-${Date.now().toString(36)}`;
    mockCustomImages.set(id, {
      ownerAccountId: mockAccountIdFor(account.access_key_id),
      sharedWith: new Map(),
      image: {
        image_id: id,
        image_name: opts.imageName,
        os_name: "Debian 12.6 64位",
        os_type: "linux",
        architecture: "x86_64",
        image_version: "",
        size: 40,
        owner_alias: "self",
        description: opts.description ?? "",
        status: "Available",
        progress: "100%",
        creation_time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        usage: "none",
        is_self_shared: false,
      },
    });
    return { image_id: id };
  }
  const params: Record<string, string> = {
    Action: "CreateImage",
    Version: ECS_VERSION,
    RegionId: account.region_id,
    InstanceId: account.instance_id,
    ImageName: opts.imageName,
  };
  if (opts.description) params["Description"] = opts.description;
  let data: Record<string, unknown>;
  try {
    data = await rpcCall<Record<string, unknown>>(ecsDomain(account.region_id), account, params);
  } catch (exc) {
    throw new AliyunError(`创建自定义镜像失败：${briefError(exc)}`);
  }
  return { image_id: asStrVal(data["ImageId"]).trim() };
}

/** Delete a custom image owned by this account. */
export async function deleteImage(
  env: Env,
  account: AliyunAccount,
  imageId: string,
  force = false,
): Promise<void> {
  if (isDryRun(env)) {
    mockCustomImages.delete(imageId);
    return;
  }
  try {
    await rpcCall(ecsDomain(account.region_id), account, {
      Action: "DeleteImage",
      Version: ECS_VERSION,
      RegionId: account.region_id,
      ImageId: imageId,
      Force: force ? "true" : "false",
    });
  } catch (exc) {
    throw new AliyunError(`删除自定义镜像失败：${briefError(exc)}`);
  }
}

/** Query the list of Alibaba Cloud account UIDs a custom image is shared with. */
export async function getImageSharePermissions(
  env: Env,
  account: AliyunAccount,
  imageId: string,
): Promise<ImageShareAccount[]> {
  if (isDryRun(env)) {
    const entry = mockCustomImages.get(imageId);
    if (!entry) return [];
    return Array.from(entry.sharedWith.entries()).map(([aliyun_id, shared_time]) => ({
      aliyun_id,
      shared_time,
    }));
  }
  let data: Record<string, unknown>;
  try {
    data = await rpcCall<Record<string, unknown>>(ecsDomain(account.region_id), account, {
      Action: "DescribeImageSharePermission",
      Version: ECS_VERSION,
      RegionId: account.region_id,
      ImageId: imageId,
      PageNumber: "1",
      PageSize: "100",
    });
  } catch (exc) {
    throw new AliyunError(`查询镜像共享列表失败：${briefError(exc)}`);
  }
  const rawAccounts = asArray<unknown>(asRecord(data["Accounts"])["Account"]);
  return rawAccounts
    .map((item) => {
      const rec = asRecord(item);
      return {
        aliyun_id:
          asStrVal(rec["AliyunId"]).trim() || asStrVal(rec["AliyunUid"]).trim(),
        shared_time: asStrVal(rec["SharedTime"]).trim(),
      };
    })
    .filter((entry) => Boolean(entry.aliyun_id));
}

/**
 * Add and/or remove Alibaba Cloud account UIDs for a custom image via
 * ModifyImageSharePermission (max 10 accounts per operation per Aliyun docs).
 */
export async function modifyImageSharePermission(
  env: Env,
  account: AliyunAccount,
  imageId: string,
  opts: { addAccounts?: string[]; removeAccounts?: string[] },
): Promise<void> {
  const addList = (opts.addAccounts ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 10);
  const removeList = (opts.removeAccounts ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 10);
  if (addList.length === 0 && removeList.length === 0) {
    throw new AliyunError("请指定要添加或取消共享的阿里云账号 UID");
  }
  if (isDryRun(env)) {
    const entry = mockCustomImages.get(imageId);
    if (!entry) throw new AliyunError("镜像不存在");
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    for (const uid of addList) entry.sharedWith.set(uid, nowIso);
    for (const uid of removeList) entry.sharedWith.delete(uid);
    return;
  }
  const params: Record<string, string> = {
    Action: "ModifyImageSharePermission",
    Version: ECS_VERSION,
    RegionId: account.region_id,
    ImageId: imageId,
  };
  addList.forEach((uid, idx) => {
    params[`AddAccount.${idx + 1}`] = uid;
  });
  removeList.forEach((uid, idx) => {
    params[`RemoveAccount.${idx + 1}`] = uid;
  });
  try {
    await rpcCall(ecsDomain(account.region_id), account, params);
  } catch (exc) {
    throw new AliyunError(`修改镜像共享权限失败：${briefError(exc)}`);
  }
}

/** List SSH key pairs in the region (used as optional login credential when reinstalling). */
export async function listKeyPairs(
  env: Env,
  account: AliyunAccount,
): Promise<string[]> {
  if (isDryRun(env)) return ["mock-keypair"];
  try {
    const data = await rpcCall<Record<string, unknown>>(ecsDomain(account.region_id), account, {
      Action: "DescribeKeyPairs",
      Version: ECS_VERSION,
      RegionId: account.region_id,
      PageNumber: "1",
      PageSize: "50",
    });
    const rawList = asArray<unknown>(asRecord(data["KeyPairs"])["KeyPair"]);
    return rawList
      .map((item) => asStrVal(asRecord(item)["KeyPairName"]).trim())
      .filter(Boolean);
  } catch {
    // Missing keypair read permission should not block manual keypair input.
    return [];
  }
}

/**
 * Replace the system disk (reinstall OS) on a Stopped ECS instance.
 * Callers must never log or persist `opts.password`.
 */
export async function replaceSystemDisk(
  env: Env,
  account: AliyunAccount,
  opts: {
    imageId: string;
    password?: string;
    keyPairName?: string;
    systemDiskSize?: number;
  },
): Promise<{ disk_id: string }> {
  if (isDryRun(env)) {
    const state = mockState(env, account);
    state.status = "Stopped";
    return { disk_id: "d-mock-replaced01" };
  }
  const params: Record<string, string> = {
    Action: "ReplaceSystemDisk",
    Version: ECS_VERSION,
    RegionId: account.region_id,
    InstanceId: account.instance_id,
    ImageId: opts.imageId,
  };
  if (opts.password) params["Password"] = opts.password;
  if (opts.keyPairName) params["KeyPairName"] = opts.keyPairName;
  if (opts.systemDiskSize && opts.systemDiskSize > 0) {
    params["SystemDisk.Size"] = String(Math.trunc(opts.systemDiskSize));
  }
  let data: Record<string, unknown>;
  try {
    data = await rpcCall<Record<string, unknown>>(ecsDomain(account.region_id), account, params);
  } catch (exc) {
    throw new AliyunError(`重装系统失败：${briefError(exc)}`);
  }
  return { disk_id: asStrVal(data["DiskId"]).trim() };
}

// ---------------------------------------------------------------------------
// Renewal, Instance Attributes, Security Groups, Release & Provisioning
// ---------------------------------------------------------------------------

interface MockInstanceMeta {
  instance_name: string;
  description: string;
  instance_type: string;
  os_name: string;
  image_id: string;
  zone_id: string;
  vpc_id: string;
  vswitch_id: string;
  security_group_id: string;
  internet_charge_type: string;
  bandwidth_out: number;
  cpu: number;
  memory: number;
  charge_type: "PrePaid" | "PostPaid";
  creation_time: string;
  expired_time: string;
  deletion_protection: boolean;
  deleted: boolean;
  auto_renew: AutoRenewInfo;
}

const mockInstanceMetas = new Map<string, MockInstanceMeta>();
const mockSgRules = new Map<string, SecurityGroupRule[]>();
const mockVSwitches = new Map<string, VSwitchInfo[]>();
const mockSecGroups = new Map<string, SecurityGroupSummary[]>();

function mockInstanceMeta(account: AliyunAccount): MockInstanceMeta {
  const key = account.instance_id || account.access_key_id || "mock";
  let meta = mockInstanceMetas.get(key);
  if (!meta) {
    const isPrePaid = key.toLowerCase().includes("prepaid");
    const exp = isPrePaid
      ? new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
      : "";
    meta = {
      instance_name: `mock-${key}`,
      description: "Dry-run simulated ECS instance",
      instance_type: "ecs.e-c1m1.large",
      os_name: "Debian 12.6 64位",
      image_id: "debian_12_6_x64_20G_alibase_20240819.vhd",
      zone_id: `${account.region_id}-a`,
      vpc_id: "vpc-mock001",
      vswitch_id: "vsw-mock001",
      security_group_id: "sg-mock001",
      internet_charge_type: "PayByTraffic",
      bandwidth_out: 100,
      cpu: 2,
      memory: 2048,
      charge_type: isPrePaid ? "PrePaid" : "PostPaid",
      creation_time: "2026-01-01T00:00Z",
      expired_time: exp,
      deletion_protection: false,
      deleted: false,
      auto_renew: {
        auto_renew_enabled: false,
        renewal_status: "Normal",
        duration: 1,
        period_unit: "Month",
      },
    };
    mockInstanceMetas.set(key, meta);
  }
  return meta;
}

function getMockSgRules(sgId: string): SecurityGroupRule[] {
  let rules = mockSgRules.get(sgId);
  if (!rules) {
    rules = [
      {
        rule_id: `sgr-${sgId}-ssh`,
        direction: "ingress",
        ip_protocol: "TCP",
        port_range: "22/22",
        source_cidr_ip: "0.0.0.0/0",
        dest_cidr_ip: "",
        policy: "Accept",
        priority: 1,
        description: "SSH",
        create_time: "2026-01-01T00:00Z",
      },
      {
        rule_id: `sgr-${sgId}-https`,
        direction: "ingress",
        ip_protocol: "TCP",
        port_range: "443/443",
        source_cidr_ip: "0.0.0.0/0",
        dest_cidr_ip: "",
        policy: "Accept",
        priority: 1,
        description: "HTTPS",
        create_time: "2026-01-01T00:00Z",
      },
    ];
    mockSgRules.set(sgId, rules);
  }
  return rules;
}

function makeClientToken(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${hex}`.slice(0, 64);
}

/** Query auto-renewal attribute of a subscription (PrePaid) ECS instance. */
export async function getInstanceAutoRenewAttribute(
  env: Env,
  account: AliyunAccount,
): Promise<AutoRenewInfo> {
  if (isDryRun(env)) {
    const meta = mockInstanceMeta(account);
    if (meta.charge_type !== "PrePaid") {
      throw new AliyunError("按量付费实例不支持自动续费配置");
    }
    return { ...meta.auto_renew };
  }
  let data: Record<string, unknown>;
  try {
    data = await rpcCall<Record<string, unknown>>(ecsDomain(account.region_id), account, {
      Action: "DescribeInstanceAutoRenewAttribute",
      Version: ECS_VERSION,
      RegionId: account.region_id,
      InstanceId: account.instance_id,
    });
  } catch (exc) {
    throw new AliyunError(`查询自动续费属性失败：${briefError(exc)}`);
  }
  const list = asArray<unknown>(
    asRecord(data["InstanceRenewAttributes"])["InstanceRenewAttribute"],
  );
  const first = asRecord(list[0]);
  return {
    auto_renew_enabled: Boolean(first["AutoRenewEnabled"]),
    renewal_status: asStrVal(first["RenewalStatus"]).trim() || "Normal",
    duration: asNumVal(first["Duration"]),
    period_unit: asStrVal(first["PeriodUnit"]).trim() || "Month",
  };
}

/**
 * Build verified official Aliyun console URLs for manual renewal checkout,
 * instance management, account top-up, and order payment.
 */
export function buildRenewalConsoleUrls(
  account: AliyunAccount,
  detectedSite?: string,
): RenewalConsoleUrls {
  const isIntl = (detectedSite || account.site || "china") === "international";
  const region = encodeURIComponent(account.region_id);
  return {
    renew_url: isIntl
      ? "https://usercenter2-intl.aliyun.com/renew/manual?commodityCode=ecs"
      : "https://renew.console.aliyun.com/center#/renew",
    instance_url: `https://ecs.console.aliyun.com/server/region/${region}`,
    recharge_url: isIntl
      ? "https://usercenter2-intl.aliyun.com/billing/#/account/overview"
      : "https://usercenter2.aliyun.com/finance/fund-management/recharge",
    orders_url: isIntl
      ? "https://usercenter2-intl.aliyun.com/order/list"
      : "https://usercenter2.aliyun.com/order/list",
  };
}

/**
 * Query renewal price for a PrePaid ECS instance.
 * Multiples of 12 months are converted to Year units. Aliyun's
 * DescribeRenewalPrice docs cap Year at 1..3 even though RenewInstance accepts
 * 48/60 months (4/5 years), so we query directly first and fall back to a
 * scaled reference estimate if Aliyun rejects Period=4/5 with InvalidPeriod.
 */
export async function describeRenewalPrice(
  env: Env,
  account: AliyunAccount,
  opts: { period: number; periodUnit: "Month" | "Year" },
): Promise<PriceQuote> {
  let priceUnit: "Month" | "Year" = opts.periodUnit;
  let period = Math.trunc(opts.period);
  if (priceUnit === "Month" && period >= 12 && period % 12 === 0) {
    priceUnit = "Year";
    period = period / 12;
  }
  if (isDryRun(env)) {
    const meta = mockInstanceMeta(account);
    if (meta.charge_type !== "PrePaid") {
      throw new AliyunError("仅包年包月实例支持续费询价");
    }
    const months = priceUnit === "Year" ? period * 12 : period;
    const orig = Number((months * 45).toFixed(2));
    const disc = months >= 12 ? Number((orig * 0.15).toFixed(2)) : 0;
    return {
      original_price: orig,
      discount_price: disc,
      trade_price: Number((orig - disc).toFixed(2)),
      currency: account.site === "international" ? "USD" : "CNY",
      period,
      price_unit: priceUnit,
      rules: disc > 0 ? ["年付 8.5 折优惠"] : [],
    };
  }
  const queryQuote = async (p: number, unit: "Month" | "Year"): Promise<PriceQuote> => {
    const raw = await rpcCall<Record<string, unknown>>(ecsDomain(account.region_id), account, {
      Action: "DescribeRenewalPrice",
      Version: ECS_VERSION,
      RegionId: account.region_id,
      ResourceType: "instance",
      ResourceId: account.instance_id,
      Period: String(p),
      PriceUnit: unit,
    });
    return parsePriceQuote(raw, p, unit);
  };
  try {
    return await queryQuote(period, priceUnit);
  } catch (exc) {
    const detail = briefError(exc);
    const canEstimateLongYear =
      priceUnit === "Year" &&
      period > 3 &&
      detail.includes("InvalidPeriod") &&
      !detail.includes("ExceededMaximumExpirationDate");
    if (canEstimateLongYear) {
      for (const baseYears of [3, 1]) {
        try {
          const base = await queryQuote(baseYears, "Year");
          const factor = period / baseYears;
          return {
            ...base,
            original_price: Number((base.original_price * factor).toFixed(2)),
            discount_price: Number((base.discount_price * factor).toFixed(2)),
            trade_price: Number((base.trade_price * factor).toFixed(2)),
            period,
            price_unit: "Year",
            estimated: true,
            note: `阿里云实时询价接口暂仅支持 1–3 年，此处按 ${baseYears} 年价格折算参考；实际扣款以阿里云结算为准。`,
          };
        } catch {
          // Try next shorter baseline period.
        }
      }
    }
    throw new AliyunError(`查询续费价格失败：${detail}`);
  }
}

function parsePriceQuote(
  data: Record<string, unknown>,
  period: number,
  priceUnit: string,
): PriceQuote {
  const info = asRecord(data["PriceInfo"]);
  const price = asRecord(info["Price"]);
  const rulesRaw = asArray<unknown>(asRecord(info["Rules"])["Rule"]);
  const rules = rulesRaw
    .map((r) => asStrVal(asRecord(r)["Description"]).trim())
    .filter(Boolean);
  return {
    original_price: asNumVal(price["OriginalPrice"]),
    discount_price: asNumVal(price["DiscountPrice"]),
    trade_price: asNumVal(price["TradePrice"]),
    currency: asStrVal(price["Currency"]).trim() || "CNY",
    period,
    price_unit: priceUnit,
    rules,
  };
}

/**
 * Manually renew a PrePaid ECS instance (charges the Aliyun account balance).
 * RenewInstance uses PeriodUnit=Month (with 12/24/36/48/60 for years) or Week.
 */
export async function renewInstance(
  env: Env,
  account: AliyunAccount,
  opts: { periodMonths: number; clientToken?: string },
): Promise<{ order_id: string }> {
  const months = Math.trunc(opts.periodMonths);
  if (isDryRun(env)) {
    const meta = mockInstanceMeta(account);
    if (meta.charge_type !== "PrePaid") {
      throw new AliyunError("仅包年包月实例支持续费");
    }
    const baseMs = meta.expired_time ? Date.parse(meta.expired_time) : Date.now();
    const next = new Date((Number.isFinite(baseMs) ? baseMs : Date.now()) + months * 30 * 24 * 3600 * 1000);
    meta.expired_time = next.toISOString().replace(/\.\d{3}Z$/, "Z");
    return { order_id: `2026${Date.now().toString().slice(-10)}` };
  }
  const token = (opts.clientToken || makeClientToken("renew")).slice(0, 64);
  let data: Record<string, unknown>;
  try {
    data = await rpcCall<Record<string, unknown>>(ecsDomain(account.region_id), account, {
      Action: "RenewInstance",
      Version: ECS_VERSION,
      InstanceId: account.instance_id,
      Period: String(months),
      PeriodUnit: "Month",
      ClientToken: token,
    });
  } catch (exc) {
    throw new AliyunError(`实例续费失败：${briefError(exc)}`);
  }
  return { order_id: asStrVal(data["OrderId"]).trim() };
}

/** Enable, disable, or update auto-renewal settings on a PrePaid ECS instance. */
export async function modifyInstanceAutoRenewAttribute(
  env: Env,
  account: AliyunAccount,
  opts: {
    renewalStatus: "AutoRenewal" | "Normal" | "NotRenewal";
    duration?: number;
    periodUnit?: "Month" | "Year" | "Week";
  },
): Promise<void> {
  if (isDryRun(env)) {
    const meta = mockInstanceMeta(account);
    if (meta.charge_type !== "PrePaid") {
      throw new AliyunError("仅包年包月实例支持设置自动续费");
    }
    meta.auto_renew = {
      auto_renew_enabled: opts.renewalStatus === "AutoRenewal",
      renewal_status: opts.renewalStatus,
      duration: opts.renewalStatus === "AutoRenewal" ? opts.duration ?? 1 : meta.auto_renew.duration,
      period_unit:
        opts.renewalStatus === "AutoRenewal"
          ? opts.periodUnit ?? "Month"
          : meta.auto_renew.period_unit,
    };
    return;
  }
  const params: Record<string, string> = {
    Action: "ModifyInstanceAutoRenewAttribute",
    Version: ECS_VERSION,
    RegionId: account.region_id,
    InstanceId: account.instance_id,
    RenewalStatus: opts.renewalStatus,
    AutoRenew: opts.renewalStatus === "AutoRenewal" ? "true" : "false",
  };
  if (opts.renewalStatus === "AutoRenewal") {
    params["Duration"] = String(Math.trunc(opts.duration ?? 1));
    params["PeriodUnit"] = opts.periodUnit ?? "Month";
  }
  try {
    await rpcCall(ecsDomain(account.region_id), account, params);
  } catch (exc) {
    throw new AliyunError(`更新自动续费设置失败：${briefError(exc)}`);
  }
}

/**
 * Update ECS instance attributes (InstanceName, Password, Description, DeletionProtection).
 * Password changes take effect only after an ECS-level RebootInstance.
 * Never log or return `opts.password`.
 */
export async function modifyInstanceAttribute(
  env: Env,
  account: AliyunAccount,
  opts: {
    instanceName?: string;
    password?: string;
    description?: string;
    deletionProtection?: boolean;
  },
): Promise<void> {
  if (isDryRun(env)) {
    const meta = mockInstanceMeta(account);
    if (opts.instanceName !== undefined && opts.instanceName !== "") {
      meta.instance_name = opts.instanceName;
    }
    if (opts.description !== undefined) {
      meta.description = opts.description;
    }
    if (opts.deletionProtection !== undefined) {
      meta.deletion_protection = opts.deletionProtection;
    }
    return;
  }
  const params: Record<string, string> = {
    Action: "ModifyInstanceAttribute",
    Version: ECS_VERSION,
    InstanceId: account.instance_id,
  };
  if (opts.instanceName) params["InstanceName"] = opts.instanceName;
  if (opts.password) params["Password"] = opts.password;
  if (opts.description !== undefined) params["Description"] = opts.description;
  if (opts.deletionProtection !== undefined) {
    params["DeletionProtection"] = opts.deletionProtection ? "true" : "false";
  }
  try {
    await rpcCall(ecsDomain(account.region_id), account, params);
  } catch (exc) {
    throw new AliyunError(`修改实例属性失败：${briefError(exc)}`);
  }
}

/** Query rules inside a specific ECS security group. */
export async function describeSecurityGroupAttribute(
  env: Env,
  account: AliyunAccount,
  securityGroupId: string,
): Promise<SecurityGroupDetail> {
  if (isDryRun(env)) {
    return {
      security_group_id: securityGroupId,
      security_group_name: `mock-${securityGroupId}`,
      vpc_id: "vpc-mock001",
      description: "Dry-run security group",
      rules: [...getMockSgRules(securityGroupId)],
    };
  }
  let data: Record<string, unknown>;
  try {
    data = await rpcCall<Record<string, unknown>>(ecsDomain(account.region_id), account, {
      Action: "DescribeSecurityGroupAttribute",
      Version: ECS_VERSION,
      RegionId: account.region_id,
      SecurityGroupId: securityGroupId,
      Direction: "all",
    });
  } catch (exc) {
    throw new AliyunError(`获取安全组规则失败：${briefError(exc)}`);
  }
  const rawList = asArray<unknown>(asRecord(data["Permissions"])["Permission"]);
  const rules: SecurityGroupRule[] = rawList.map((item) => {
    const r = asRecord(item);
    const dir = asStrVal(r["Direction"]).trim().toLowerCase() === "egress" ? "egress" : "ingress";
    return {
      rule_id: asStrVal(r["SecurityGroupRuleId"]).trim(),
      direction: dir,
      ip_protocol: asStrVal(r["IpProtocol"]).trim().toUpperCase(),
      port_range: asStrVal(r["PortRange"]).trim(),
      source_cidr_ip:
        asStrVal(r["SourceCidrIp"]).trim() ||
        asStrVal(r["Ipv6SourceCidrIp"]).trim() ||
        asStrVal(r["SourceGroupId"]).trim(),
      dest_cidr_ip:
        asStrVal(r["DestCidrIp"]).trim() ||
        asStrVal(r["Ipv6DestCidrIp"]).trim() ||
        asStrVal(r["DestGroupId"]).trim(),
      policy: asStrVal(r["Policy"]).trim() || "Accept",
      priority: asNumVal(r["Priority"]) || 1,
      description: asStrVal(r["Description"]).trim(),
      create_time: asStrVal(r["CreateTime"]).trim(),
    };
  });
  return {
    security_group_id: asStrVal(data["SecurityGroupId"]).trim() || securityGroupId,
    security_group_name: asStrVal(data["SecurityGroupName"]).trim(),
    vpc_id: asStrVal(data["VpcId"]).trim(),
    description: asStrVal(data["Description"]).trim(),
    rules,
  };
}

/** Add an ingress or egress security group rule using the non-deprecated Permissions.1.* format. */
export async function authorizeSecurityGroupRule(
  env: Env,
  account: AliyunAccount,
  opts: {
    securityGroupId: string;
    direction: "ingress" | "egress";
    ipProtocol: "TCP" | "UDP" | "ICMP" | "ALL";
    portRange: string;
    cidrIp: string;
    policy: "accept" | "drop";
    priority: number;
    description?: string;
  },
): Promise<void> {
  if (isDryRun(env)) {
    const rules = getMockSgRules(opts.securityGroupId);
    const id = `sgr-mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    rules.unshift({
      rule_id: id,
      direction: opts.direction,
      ip_protocol: opts.ipProtocol,
      port_range: opts.portRange,
      source_cidr_ip: opts.direction === "ingress" ? opts.cidrIp : "",
      dest_cidr_ip: opts.direction === "egress" ? opts.cidrIp : "",
      policy: opts.policy === "drop" ? "Drop" : "Accept",
      priority: opts.priority,
      description: opts.description || "",
      create_time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    return;
  }
  const isIpv6 = opts.cidrIp.includes(":");
  const action =
    opts.direction === "egress" ? "AuthorizeSecurityGroupEgress" : "AuthorizeSecurityGroup";
  const params: Record<string, string> = {
    Action: action,
    Version: ECS_VERSION,
    RegionId: account.region_id,
    SecurityGroupId: opts.securityGroupId,
    "Permissions.1.IpProtocol": opts.ipProtocol,
    "Permissions.1.PortRange": opts.portRange,
    "Permissions.1.Policy": opts.policy,
    "Permissions.1.Priority": String(Math.min(100, Math.max(1, Math.trunc(opts.priority)))),
  };
  if (opts.direction === "egress") {
    params[isIpv6 ? "Permissions.1.Ipv6DestCidrIp" : "Permissions.1.DestCidrIp"] = opts.cidrIp;
  } else {
    params[isIpv6 ? "Permissions.1.Ipv6SourceCidrIp" : "Permissions.1.SourceCidrIp"] = opts.cidrIp;
  }
  if (opts.description) params["Permissions.1.Description"] = opts.description;
  try {
    await rpcCall(ecsDomain(account.region_id), account, params);
  } catch (exc) {
    throw new AliyunError(`添加安全组规则失败：${briefError(exc)}`);
  }
}

/** Delete an ingress or egress security group rule by SecurityGroupRuleId. */
export async function revokeSecurityGroupRule(
  env: Env,
  account: AliyunAccount,
  opts: {
    securityGroupId: string;
    direction: "ingress" | "egress";
    ruleId: string;
  },
): Promise<void> {
  if (isDryRun(env)) {
    const rules = getMockSgRules(opts.securityGroupId);
    const idx = rules.findIndex((r) => r.rule_id === opts.ruleId && r.direction === opts.direction);
    if (idx < 0) throw new AliyunError("安全组规则不存在");
    rules.splice(idx, 1);
    return;
  }
  const action =
    opts.direction === "egress" ? "RevokeSecurityGroupEgress" : "RevokeSecurityGroup";
  try {
    await rpcCall(ecsDomain(account.region_id), account, {
      Action: action,
      Version: ECS_VERSION,
      RegionId: account.region_id,
      SecurityGroupId: opts.securityGroupId,
      "SecurityGroupRuleId.1": opts.ruleId,
    });
  } catch (exc) {
    throw new AliyunError(`删除安全组规则失败：${briefError(exc)}`);
  }
}

/**
 * Release (permanently destroy) a PostPaid or expired PrePaid ECS instance.
 * Irreversible on Aliyun — callers must enforce explicit confirmation.
 */
export async function deleteInstance(
  env: Env,
  account: AliyunAccount,
  opts: { force?: boolean; forceStop?: boolean; terminateSubscription?: boolean } = {},
): Promise<void> {
  if (isDryRun(env)) {
    const meta = mockInstanceMeta(account);
    if (meta.deletion_protection) {
      throw new AliyunError("该实例已开启释放保护，请先关闭释放保护");
    }
    if (meta.charge_type === "PrePaid" && !opts.terminateSubscription) {
      throw new AliyunError("包年包月未到期实例不能直接释放");
    }
    const state = mockState(env, account);
    if (state.status === "Running" && !opts.force) {
      throw new AliyunError("运行中的实例需先停机，或勾选强制释放");
    }
    meta.deleted = true;
    state.status = "Deleted";
    return;
  }
  const params: Record<string, string> = {
    Action: "DeleteInstance",
    Version: ECS_VERSION,
    InstanceId: account.instance_id,
    Force: opts.force ? "true" : "false",
  };
  if (opts.force) {
    params["ForceStop"] = opts.forceStop === false ? "false" : "true";
  }
  if (opts.terminateSubscription) {
    params["TerminateSubscription"] = "true";
  }
  try {
    await rpcCall(ecsDomain(account.region_id), account, params);
  } catch (exc) {
    throw new AliyunError(`释放实例失败：${briefError(exc)}`);
  }
}

const PREFERRED_FAMILIES = [
  "ecs.e-",
  "ecs.u1-",
  "ecs.t6-",
  "ecs.t5-",
  "ecs.s6-",
  "ecs.n4.",
  "ecs.c7.",
  "ecs.g7.",
  "ecs.c8i.",
  "ecs.g8i.",
  "ecs.c6.",
  "ecs.g6.",
];

function instanceTypePriority(typeId: string): number {
  const idx = PREFERRED_FAMILIES.findIndex((prefix) => typeId.startsWith(prefix));
  return idx >= 0 ? idx : PREFERRED_FAMILIES.length;
}

/**
 * List available zones, purchasable instance types (enriched with CPU/memory),
 * VSwitches, and SecurityGroups in the target region for instance provisioning.
 */
export async function listProvisionResources(
  env: Env,
  account: AliyunAccount,
  opts: { chargeType: "PostPaid" | "PrePaid" },
): Promise<ProvisionResources> {
  if (isDryRun(env)) {
    const r = account.region_id;
    const vsws = mockVSwitches.get(r) ?? [
      {
        vswitch_id: `vsw-mock-${r.slice(0, 6)}`,
        vswitch_name: "default-vswitch",
        vpc_id: `vpc-mock-${r.slice(0, 6)}`,
        zone_id: `${r}-a`,
        cidr_block: "172.16.0.0/20",
        available_ip_count: 4000,
        is_default: true,
      },
    ];
    const sgs = mockSecGroups.get(r) ?? [
      {
        security_group_id: `sg-mock-${r.slice(0, 6)}`,
        security_group_name: "default-sg",
        vpc_id: vsws[0]?.vpc_id || `vpc-mock-${r.slice(0, 6)}`,
        security_group_type: "normal",
        description: "Default security group",
      },
    ];
    return {
      region_id: r,
      zones: [`${r}-a`, `${r}-b`],
      instance_types: [
        { instance_type: "ecs.e-c1m1.large", cpu: 2, memory_gb: 2, family: "ecs.e", zones: [`${r}-a`, `${r}-b`] },
        { instance_type: "ecs.e-c1m2.large", cpu: 2, memory_gb: 4, family: "ecs.e", zones: [`${r}-a`, `${r}-b`] },
        { instance_type: "ecs.u1-c1m2.large", cpu: 2, memory_gb: 4, family: "ecs.u1", zones: [`${r}-a`] },
        { instance_type: "ecs.c7.large", cpu: 2, memory_gb: 4, family: "ecs.c7", zones: [`${r}-a`, `${r}-b`] },
      ],
      vswitches: vsws,
      security_groups: sgs,
    };
  }

  const [availRes, vswRes, sgRes] = await Promise.all([
    rpcCall<Record<string, unknown>>(ecsDomain(account.region_id), account, {
      Action: "DescribeAvailableResource",
      Version: ECS_VERSION,
      RegionId: account.region_id,
      DestinationResource: "InstanceType",
      IoOptimized: "optimized",
      NetworkCategory: "vpc",
      InstanceChargeType: opts.chargeType,
    }).catch((exc) => {
      throw new AliyunError(`查询地域可用库存失败：${briefError(exc)}`);
    }),
    rpcCall<Record<string, unknown>>(vpcDomain(account.region_id), account, {
      Action: "DescribeVSwitches",
      Version: VPC_VERSION,
      RegionId: account.region_id,
      PageNumber: "1",
      PageSize: "50",
    }).catch(() => ({}) as Record<string, unknown>),
    rpcCall<Record<string, unknown>>(ecsDomain(account.region_id), account, {
      Action: "DescribeSecurityGroups",
      Version: ECS_VERSION,
      RegionId: account.region_id,
      PageNumber: "1",
      PageSize: "50",
    }).catch(() => ({}) as Record<string, unknown>),
  ]);

  const zones: string[] = [];
  const typeZones = new Map<string, Set<string>>();
  const availZones = asArray<unknown>(asRecord(availRes["AvailableZones"])["AvailableZone"]);
  for (const zItem of availZones) {
    const z = asRecord(zItem);
    const zoneId = asStrVal(z["ZoneId"]).trim();
    if (!zoneId || asStrVal(z["Status"]).trim() !== "Available") continue;
    if (!zones.includes(zoneId)) zones.push(zoneId);
    const resList = asArray<unknown>(asRecord(z["AvailableResources"])["AvailableResource"]);
    for (const rItem of resList) {
      const r = asRecord(rItem);
      if (asStrVal(r["Type"]).trim() !== "InstanceType") continue;
      const supported = asArray<unknown>(asRecord(r["SupportedResources"])["SupportedResource"]);
      for (const sItem of supported) {
        const s = asRecord(sItem);
        if (asStrVal(s["Status"]).trim() !== "Available") continue;
        const val = asStrVal(s["Value"]).trim();
        if (!val) continue;
        let set = typeZones.get(val);
        if (!set) {
          set = new Set<string>();
          typeZones.set(val, set);
        }
        set.add(zoneId);
      }
    }
  }

  const sortedTypeIds = Array.from(typeZones.keys()).sort((a, b) => {
    const pa = instanceTypePriority(a);
    const pb = instanceTypePriority(b);
    return pa !== pb ? pa - pb : a.localeCompare(b);
  });

  // Enrich the top 40 prioritized types (4 batches of 10) with exact CPU/RAM specs.
  const specMap = new Map<string, { cpu: number; memory_gb: number; family: string }>();
  const toEnrich = sortedTypeIds.slice(0, 40);
  const chunks: string[][] = [];
  for (let i = 0; i < toEnrich.length; i += 10) {
    chunks.push(toEnrich.slice(i, i + 10));
  }
  await Promise.allSettled(
    chunks.map(async (chunk) => {
      const params: Record<string, string> = {
        Action: "DescribeInstanceTypes",
        Version: ECS_VERSION,
      };
      chunk.forEach((id, idx) => {
        params[`InstanceTypes.${idx + 1}`] = id;
      });
      const res = await rpcCall<Record<string, unknown>>(
        ecsDomain(account.region_id),
        account,
        params,
      );
      const list = asArray<unknown>(asRecord(res["InstanceTypes"])["InstanceType"]);
      for (const item of list) {
        const t = asRecord(item);
        const id = asStrVal(t["InstanceTypeId"]).trim();
        if (!id) continue;
        specMap.set(id, {
          cpu: asNumVal(t["CpuCoreCount"]),
          memory_gb: asNumVal(t["MemorySize"]),
          family: asStrVal(t["InstanceTypeFamily"]).trim(),
        });
      }
    }),
  );

  const instanceTypes: InstanceTypeOffer[] = sortedTypeIds.slice(0, 120).map((id) => {
    const spec = specMap.get(id);
    return {
      instance_type: id,
      cpu: spec?.cpu ?? 0,
      memory_gb: spec?.memory_gb ?? 0,
      family: spec?.family ?? id.split(".").slice(0, 2).join("."),
      zones: Array.from(typeZones.get(id) ?? []),
    };
  });
  instanceTypes.sort((a, b) => {
    const pa = instanceTypePriority(a.instance_type);
    const pb = instanceTypePriority(b.instance_type);
    if (pa !== pb) return pa - pb;
    if (a.cpu > 0 && b.cpu > 0 && a.cpu !== b.cpu) return a.cpu - b.cpu;
    if (a.memory_gb > 0 && b.memory_gb > 0 && a.memory_gb !== b.memory_gb) {
      return a.memory_gb - b.memory_gb;
    }
    return a.instance_type.localeCompare(b.instance_type);
  });

  const vswitches: VSwitchInfo[] = asArray<unknown>(asRecord(vswRes["VSwitches"])["VSwitch"])
    .map((item) => {
      const v = asRecord(item);
      return {
        vswitch_id: asStrVal(v["VSwitchId"]).trim(),
        vswitch_name: asStrVal(v["VSwitchName"]).trim(),
        vpc_id: asStrVal(v["VpcId"]).trim(),
        zone_id: asStrVal(v["ZoneId"]).trim(),
        cidr_block: asStrVal(v["CidrBlock"]).trim(),
        available_ip_count: asNumVal(v["AvailableIpAddressCount"]),
        is_default: Boolean(v["IsDefault"]),
      };
    })
    .filter((v) => v.vswitch_id);

  const securityGroups: SecurityGroupSummary[] = asArray<unknown>(
    asRecord(sgRes["SecurityGroups"])["SecurityGroup"],
  )
    .map((item) => {
      const sg = asRecord(item);
      return {
        security_group_id: asStrVal(sg["SecurityGroupId"]).trim(),
        security_group_name: asStrVal(sg["SecurityGroupName"]).trim(),
        vpc_id: asStrVal(sg["VpcId"]).trim(),
        security_group_type: asStrVal(sg["SecurityGroupType"]).trim() || "normal",
        description: asStrVal(sg["Description"]).trim(),
      };
    })
    .filter((sg) => sg.security_group_id && sg.vpc_id);

  return {
    region_id: account.region_id,
    zones,
    instance_types: instanceTypes,
    vswitches,
    security_groups: securityGroups,
  };
}

/**
 * Ensure a default VPC, default VSwitch in `zoneId`, and a basic SecurityGroup
 * (with SSH port 22 open) exist in the target region so new regions can launch
 * instances without leaving the panel.
 */
export async function ensureDefaultNetwork(
  env: Env,
  account: AliyunAccount,
  zoneId: string,
): Promise<{ vswitch_id: string; security_group_id: string; vpc_id: string }> {
  if (isDryRun(env)) {
    const r = account.region_id;
    const vpcId = `vpc-mock-def-${r.slice(0, 6)}`;
    const vswId = `vsw-mock-def-${zoneId.slice(-1)}`;
    const sgId = `sg-mock-def-${r.slice(0, 6)}`;
    mockVSwitches.set(r, [
      {
        vswitch_id: vswId,
        vswitch_name: "cdt-default-vsw",
        vpc_id: vpcId,
        zone_id: zoneId,
        cidr_block: "172.16.0.0/20",
        available_ip_count: 4000,
        is_default: true,
      },
    ]);
    mockSecGroups.set(r, [
      {
        security_group_id: sgId,
        security_group_name: "cdt-default-sg",
        vpc_id: vpcId,
        security_group_type: "normal",
        description: "Auto-created by CDT-Management",
      },
    ]);
    return { vswitch_id: vswId, security_group_id: sgId, vpc_id: vpcId };
  }

  let vpcId = "";
  let vswitchId = "";

  // 1. Check existing VSwitches in target zone first.
  try {
    const vswList = await rpcCall<Record<string, unknown>>(vpcDomain(account.region_id), account, {
      Action: "DescribeVSwitches",
      Version: VPC_VERSION,
      RegionId: account.region_id,
      ZoneId: zoneId,
      PageSize: "20",
    });
    const first = asArray<unknown>(asRecord(vswList["VSwitches"])["VSwitch"])[0];
    if (first) {
      const rec = asRecord(first);
      vswitchId = asStrVal(rec["VSwitchId"]).trim();
      vpcId = asStrVal(rec["VpcId"]).trim();
    }
  } catch {
    // Continue and attempt default VPC/VSwitch creation.
  }

  // 2. Create default VPC + default VSwitch if missing.
  if (!vswitchId) {
    try {
      const vpcRes = await rpcCall<Record<string, unknown>>(
        vpcDomain(account.region_id),
        account,
        {
          Action: "CreateDefaultVpc",
          Version: VPC_VERSION,
          RegionId: account.region_id,
          ClientToken: makeClientToken("defvpc"),
        },
      );
      vpcId = asStrVal(vpcRes["VpcId"]).trim();
    } catch {
      // Default VPC may already exist; look it up.
      try {
        const vpcs = await rpcCall<Record<string, unknown>>(
          vpcDomain(account.region_id),
          account,
          {
            Action: "DescribeVpcs",
            Version: VPC_VERSION,
            RegionId: account.region_id,
            IsDefault: "true",
            PageSize: "5",
          },
        );
        const firstVpc = asArray<unknown>(asRecord(vpcs["Vpcs"])["Vpc"])[0];
        if (firstVpc) vpcId = asStrVal(asRecord(firstVpc)["VpcId"]).trim();
      } catch {
        // Let CreateDefaultVSwitch report any remaining error.
      }
    }

    try {
      const vswCreate = await rpcCall<Record<string, unknown>>(
        vpcDomain(account.region_id),
        account,
        {
          Action: "CreateDefaultVSwitch",
          Version: VPC_VERSION,
          RegionId: account.region_id,
          ZoneId: zoneId,
          ClientToken: makeClientToken("defvsw"),
        },
      );
      vswitchId = asStrVal(vswCreate["VSwitchId"]).trim();
    } catch (exc) {
      throw new AliyunError(`初始化默认交换机失败：${briefError(exc)}`);
    }

    if (!vpcId && vswitchId) {
      const vswLookup = await rpcCall<Record<string, unknown>>(
        vpcDomain(account.region_id),
        account,
        {
          Action: "DescribeVSwitches",
          Version: VPC_VERSION,
          RegionId: account.region_id,
          VSwitchId: vswitchId,
        },
      ).catch(() => ({}) as Record<string, unknown>);
      const first = asArray<unknown>(asRecord(vswLookup["VSwitches"])["VSwitch"])[0];
      if (first) vpcId = asStrVal(asRecord(first)["VpcId"]).trim();
    }
  }

  // 3. Find or create a SecurityGroup inside the VPC.
  let securityGroupId = "";
  if (vpcId) {
    const sgList = await rpcCall<Record<string, unknown>>(ecsDomain(account.region_id), account, {
      Action: "DescribeSecurityGroups",
      Version: ECS_VERSION,
      RegionId: account.region_id,
      VpcId: vpcId,
      PageSize: "20",
    }).catch(() => ({}) as Record<string, unknown>);
    const firstSg = asArray<unknown>(asRecord(sgList["SecurityGroups"])["SecurityGroup"])[0];
    if (firstSg) {
      securityGroupId = asStrVal(asRecord(firstSg)["SecurityGroupId"]).trim();
    }
  }
  if (!securityGroupId) {
    try {
      const createdSg = await rpcCall<Record<string, unknown>>(
        ecsDomain(account.region_id),
        account,
        {
          Action: "CreateSecurityGroup",
          Version: ECS_VERSION,
          RegionId: account.region_id,
          VpcId: vpcId,
          SecurityGroupName: "cdt-default-sg",
          Description: "Auto-created by CDT-Management",
          SecurityGroupType: "normal",
          ClientToken: makeClientToken("defsg"),
        },
      );
      securityGroupId = asStrVal(createdSg["SecurityGroupId"]).trim();
      if (securityGroupId) {
        // Open SSH 22/22 by default so newly created Linux instances are reachable.
        await authorizeSecurityGroupRule(env, account, {
          securityGroupId,
          direction: "ingress",
          ipProtocol: "TCP",
          portRange: "22/22",
          cidrIp: "0.0.0.0/0",
          policy: "accept",
          priority: 1,
          description: "SSH default",
        }).catch(() => {});
      }
    } catch (exc) {
      throw new AliyunError(`初始化默认安全组失败：${briefError(exc)}`);
    }
  }

  return { vswitch_id: vswitchId, security_group_id: securityGroupId, vpc_id: vpcId };
}

/** Query real-time price for creating a new ECS instance before placing an order. */
export async function describeInstancePrice(
  env: Env,
  account: AliyunAccount,
  opts: {
    instanceType: string;
    imageId?: string;
    chargeType: "PostPaid" | "PrePaid";
    periodMonths?: number;
    systemDiskCategory: string;
    systemDiskSize: number;
    internetChargeType: "PayByTraffic" | "PayByBandwidth";
    internetMaxBandwidthOut: number;
  },
): Promise<PriceQuote> {
  let priceUnit: "Hour" | "Month" | "Year" = "Hour";
  let period = 1;
  if (opts.chargeType === "PrePaid") {
    const months = Math.max(1, Math.trunc(opts.periodMonths ?? 1));
    if (months >= 12 && months % 12 === 0) {
      priceUnit = "Year";
      period = months / 12;
    } else {
      priceUnit = "Month";
      period = months;
    }
  }

  if (isDryRun(env)) {
    const baseHour = opts.instanceType.includes("c7") ? 0.42 : 0.14;
    const diskHour = opts.systemDiskSize * 0.0006;
    const bwHour =
      opts.internetChargeType === "PayByBandwidth" ? opts.internetMaxBandwidthOut * 0.06 : 0;
    const unitPrice =
      priceUnit === "Hour"
        ? baseHour + diskHour + bwHour
        : (baseHour + diskHour + bwHour) * 24 * 30 * (priceUnit === "Year" ? period * 12 : period);
    const orig = Number(unitPrice.toFixed(3));
    const disc = priceUnit === "Year" ? Number((orig * 0.15).toFixed(3)) : 0;
    return {
      original_price: orig,
      discount_price: disc,
      trade_price: Number((orig - disc).toFixed(3)),
      currency: account.site === "international" ? "USD" : "CNY",
      period,
      price_unit: priceUnit,
      rules: disc > 0 ? ["包年 8.5 折优惠"] : [],
    };
  }

  const params: Record<string, string> = {
    Action: "DescribePrice",
    Version: ECS_VERSION,
    RegionId: account.region_id,
    ResourceType: "instance",
    InstanceType: opts.instanceType,
    IoOptimized: "optimized",
    InstanceNetworkType: "vpc",
    "SystemDisk.Category": opts.systemDiskCategory,
    "SystemDisk.Size": String(Math.trunc(opts.systemDiskSize)),
    InternetChargeType: opts.internetChargeType,
    InternetMaxBandwidthOut: String(Math.trunc(opts.internetMaxBandwidthOut)),
    PriceUnit: priceUnit,
    Period: String(period),
    Amount: "1",
  };
  if (opts.imageId) params["ImageId"] = opts.imageId;
  let data: Record<string, unknown>;
  try {
    data = await rpcCall<Record<string, unknown>>(ecsDomain(account.region_id), account, params);
  } catch (exc) {
    throw new AliyunError(`实例询价失败：${briefError(exc)}`);
  }
  return parsePriceQuote(data, period, priceUnit);
}

/**
 * Provision (create and start) a new ECS instance via RunInstances.
 * Charges the Aliyun account immediately — callers must enforce price preview
 * and explicit user confirmation. Never logs `opts.password`.
 */
export async function runInstances(
  env: Env,
  account: AliyunAccount,
  opts: {
    zoneId?: string;
    imageId: string;
    instanceType: string;
    securityGroupId: string;
    vswitchId: string;
    instanceName?: string;
    chargeType: "PostPaid" | "PrePaid";
    periodMonths?: number;
    autoRenew?: boolean;
    systemDiskCategory: string;
    systemDiskSize: number;
    internetChargeType: "PayByTraffic" | "PayByBandwidth";
    internetMaxBandwidthOut: number;
    password?: string;
    keyPairName?: string;
    passwordInherit?: boolean;
    clientToken?: string;
  },
): Promise<RunInstanceResult> {
  if (isDryRun(env)) {
    const id = `i-mock-${opts.chargeType === "PrePaid" ? "prepaid-" : ""}${Date.now().toString(36).slice(-6)}`;
    const mockAcct: AliyunAccount = { ...account, instance_id: id };
    const st = mockState(env, mockAcct);
    st.status = "Running";
    st.stopped_mode = "";
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const months = Math.max(1, Math.trunc(opts.periodMonths ?? 1));
    const expIso =
      opts.chargeType === "PrePaid"
        ? new Date(Date.now() + months * 30 * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
        : "";
    mockInstanceMetas.set(id, {
      instance_name: opts.instanceName || id,
      description: "Provisioned via CDT-Management",
      instance_type: opts.instanceType,
      os_name: opts.imageId,
      image_id: opts.imageId,
      zone_id: opts.zoneId || `${account.region_id}-a`,
      vpc_id: "vpc-mock001",
      vswitch_id: opts.vswitchId,
      security_group_id: opts.securityGroupId,
      internet_charge_type: opts.internetChargeType,
      bandwidth_out: opts.internetMaxBandwidthOut,
      cpu: 2,
      memory: 2048,
      charge_type: opts.chargeType,
      creation_time: nowIso,
      expired_time: expIso,
      deletion_protection: false,
      deleted: false,
      auto_renew: {
        auto_renew_enabled: Boolean(opts.autoRenew),
        renewal_status: opts.autoRenew ? "AutoRenewal" : "Normal",
        duration: 1,
        period_unit: "Month",
      },
    });
    return {
      instance_ids: [id],
      order_id: `2026${Date.now().toString().slice(-10)}`,
      trade_price: opts.chargeType === "PrePaid" ? 45 * months : 0.16,
    };
  }

  const params: Record<string, string> = {
    Action: "RunInstances",
    Version: ECS_VERSION,
    RegionId: account.region_id,
    ImageId: opts.imageId,
    InstanceType: opts.instanceType,
    SecurityGroupId: opts.securityGroupId,
    VSwitchId: opts.vswitchId,
    InstanceChargeType: opts.chargeType,
    InternetChargeType: opts.internetChargeType,
    InternetMaxBandwidthOut: String(Math.trunc(opts.internetMaxBandwidthOut)),
    "SystemDisk.Category": opts.systemDiskCategory,
    "SystemDisk.Size": String(Math.trunc(opts.systemDiskSize)),
    Amount: "1",
    ClientToken: (opts.clientToken || makeClientToken("run")).slice(0, 64),
  };
  if (opts.zoneId) params["ZoneId"] = opts.zoneId;
  if (opts.instanceName) params["InstanceName"] = opts.instanceName;
  if (opts.chargeType === "PrePaid") {
    params["PeriodUnit"] = "Month";
    params["Period"] = String(Math.max(1, Math.trunc(opts.periodMonths ?? 1)));
    if (opts.autoRenew) {
      params["AutoRenew"] = "true";
      params["AutoRenewPeriod"] = "1";
    }
  }
  if (opts.password) {
    params["Password"] = opts.password;
  } else if (opts.keyPairName) {
    params["KeyPairName"] = opts.keyPairName;
  } else if (opts.passwordInherit) {
    params["PasswordInherit"] = "true";
  }

  let data: Record<string, unknown>;
  try {
    data = await rpcCall<Record<string, unknown>>(ecsDomain(account.region_id), account, params);
  } catch (exc) {
    throw new AliyunError(`开通实例失败：${briefError(exc)}`);
  }
  const ids = asArray<unknown>(asRecord(data["InstanceIdSets"])["InstanceIdSet"])
    .map((v) => asStrVal(v).trim())
    .filter(Boolean);
  const priceRaw = data["TradePrice"];
  const tradePrice =
    priceRaw !== undefined && priceRaw !== null && Number.isFinite(Number(priceRaw))
      ? Number(priceRaw)
      : null;
  return {
    instance_ids: ids,
    order_id: asStrVal(data["OrderId"]).trim(),
    trade_price: tradePrice,
  };
}

// ---------------------------------------------------------------------------
// Dry-run mock (aliyun.py: _mock / _mock_set / _mock_advance, lines ~330-420)
// Module-level Map: state persists across calls within one isolate, as the
// Python process-level `_MOCK` dict does. Workers isolates may be recycled,
// so mock state is not durable — that matches dry-run intent.
// ---------------------------------------------------------------------------

export function isDryRun(env: Env): boolean {
  return env.CDT_DRY_RUN === "1";
}

export function mockOpDelay(env: Env): number {
  const raw = parseFloat(env.CDT_MOCK_OP_DELAY ?? "3");
  return Number.isFinite(raw) ? Math.max(0, raw) : 3;
}

interface MockState {
  status: string;
  stopped_mode: string;
  public_ip: string;
  traffic: string;
  cost: string;
  balance: string;
  currency: string;
  pending_until: number; // epoch seconds, 0 = no operation in flight
  target_status: string;
}

const mockStates = new Map<string, MockState>();

function mockKey(account: AliyunAccount): string {
  return account.instance_id || account.access_key_id || "mock";
}

function mockState(env: Env, account: AliyunAccount): MockState {
  const key = mockKey(account);
  let state = mockStates.get(key);
  if (state === undefined) {
    const index = mockStates.size + 10;
    // Stable per-instance offset from the instance id hash, so demo figures
    // differ per server but do not jump between rounds (mirrors Python).
    const seed = Array.from(key).reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
    const quota = account.quota_gb ?? 200;
    state = {
      status: "Stopped",
      stopped_mode: "StopCharging",
      // 47.243.x is an Aliyun Hong Kong public range; mock only, never written to DNS.
      public_ip: `47.243.${index}.${20 + index}`,
      traffic: (quota * 0.42).toFixed(2),
      cost: (quota * 0.072 + 9 + (seed % 420) / 100).toFixed(2),
      balance: `${800 + (seed % 1600)}.${((seed * 7) % 100).toString().padStart(2, "0")}`,
      currency: "CNY",
      pending_until: 0,
      target_status: "",
    };
    mockStates.set(key, state);
  }
  return state;
}

function mockAdvance(state: MockState): void {
  if (state.pending_until && state.target_status && Date.now() / 1000 >= state.pending_until) {
    state.pending_until = 0;
    const target = state.target_status;
    state.target_status = "";
    state.status = target;
    if (target === "Stopped") {
      state.stopped_mode = state.stopped_mode || "StopCharging";
    } else {
      state.stopped_mode = "";
    }
  }
}
