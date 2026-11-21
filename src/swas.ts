/**
 * Aliyun Lightweight Application Server (SWAS-OPEN / 2020-06-01) client
 * for Cloudflare Workers.
 *
 * Uses the same RFC-3986 HMAC-SHA1 RPC signing helper (`signRpcUrl`) from
 * `src/aliyun.ts`. Endpoint format: `swas.<region_id>.aliyuncs.com`.
 *
 * Dry-run (`env.CDT_DRY_RUN === "1"`): all operations run against stateful
 * in-isolate mock maps so the full UI and API flows can be tested offline.
 */

import type { Env } from "./env";
import * as repo from "./repo";
import {
  AliyunError,
  briefError,
  signRpcUrl,
  type AliyunAccount,
  type PriceQuote,
} from "./aliyun";

export const SWAS_VERSION = "2020-06-01";
const HTTP_TIMEOUT_MS = 12_000;

export function swasDomain(region: string): string {
  return `swas.${region}.aliyuncs.com`;
}

function isDryRun(env: Env): boolean {
  return env.CDT_DRY_RUN === "1";
}

function strOf(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return fallback;
  return String(v);
}

function numOf(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function boolOf(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

function roundGb(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 100) / 100;
}

/**
 * Signed GET RPC request against SWAS-OPEN.
 * Quotes 15+ digit integer values of `UserId` before `JSON.parse` so Aliyun
 * account UIDs never lose precision in IEEE-754 numbers.
 */
async function swasCall<T>(
  account: AliyunAccount,
  params: Record<string, string>,
): Promise<T> {
  const region = (params["RegionId"] || account.region_id || "cn-hangzhou").trim();
  const domain = swasDomain(region);
  const url = await signRpcUrl(domain, account, {
    Version: SWAS_VERSION,
    RegionId: region,
    ...params,
  });
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (err) {
    throw new AliyunError(briefError(err));
  }
  const rawText = await res.text();
  let data: unknown;
  try {
    // Preserve large numeric Aliyun UserId fields as exact strings.
    const safeText = rawText.replace(/"UserId"\s*:\s*(\d{15,})/g, '"UserId":"$1"');
    data = JSON.parse(safeText);
  } catch {
    throw new AliyunError(`轻量接口返回非 JSON（HTTP ${res.status}）`);
  }
  const body = (data !== null && typeof data === "object" ? data : {}) as {
    Code?: unknown;
    Message?: unknown;
  };
  const code = typeof body.Code === "string" ? body.Code : "";
  const message = typeof body.Message === "string" ? body.Message : "";
  const isSuccess = code === "" || code === "200" || code === "Success";
  if (!res.ok || !isSuccess) {
    const errCode = code || `HTTP_${res.status}`;
    const err = new AliyunError(message || errCode);
    (err as AliyunError & { code?: string }).code = errCode;
    throw err;
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Exported domain types
// ---------------------------------------------------------------------------

export interface SwasDisk {
  disk_id: string;
  disk_name: string;
  disk_type: string; // system | data
  category: string; // ESSD | SSD | CLOUD_EFFICIENCY
  size: number;
  device: string;
  status: string;
  creation_time: string;
  remark: string;
}

export interface SwasTrafficPackage {
  instance_id: string;
  used_bytes: number;
  total_bytes: number;
  remaining_bytes: number;
  overflow_bytes: number;
  used_gb: number;
  total_gb: number;
  remaining_gb: number;
  overflow_gb: number;
}

export interface SwasInstanceDetail {
  instance_id: string;
  instance_name: string;
  region_id: string;
  status: string;
  business_status: string;
  ddos_status: string;
  disable_reason: string;
  charge_type: string;
  plan_id: string;
  plan_type: string;
  public_ip: string;
  inner_ip: string;
  cpu: number;
  memory_gb: number;
  disk_size_gb: number;
  disk_category: string;
  bandwidth_mbps: number;
  flow_gb: number;
  image_id: string;
  image_name: string;
  image_type: string;
  image_version: string;
  os_type: string;
  creation_time: string;
  expired_time: string;
  disks: SwasDisk[];
  traffic?: SwasTrafficPackage | null;
}

export interface SwasFirewallRule {
  rule_id: string;
  rule_protocol: string; // TCP | UDP | TCP+UDP | ICMP
  port: string;
  source_cidr_ip: string;
  policy: string; // accept | drop
  remark: string;
}

export interface SwasImageItem {
  image_id: string;
  image_name: string;
  image_type: string; // system | app | custom
  platform: string; // Linux | Windows
  description: string;
}

export interface SwasSnapshot {
  snapshot_id: string;
  snapshot_name: string;
  status: string;
  progress: string;
  source_disk_id: string;
  source_disk_type: string;
  instance_id: string;
  creation_time: string;
  remark: string;
}

export interface SwasCustomImage {
  image_id: string;
  name: string;
  description: string;
  status: string;
  os_type: string;
  instance_id: string;
  instance_name: string;
  system_snapshot_id: string;
  system_snapshot_name: string;
  data_snapshot_id: string;
  in_share_ecs: boolean;
  in_share_user: boolean;
  required_system_disk_size: number;
  required_data_disk_size: number;
  source_image_name: string;
  creation_time: string;
}

export interface SwasShareAccount {
  user_id: string;
  shared_time: string;
}

export interface SwasPlan {
  plan_id: string;
  plan_type: string;
  core: number;
  memory: number;
  disk_size: number;
  disk_type: string;
  bandwidth: number;
  flow: number;
  isp_type: string;
  origin_price: number;
  currency: string;
  support_platform: string[];
}

// ---------------------------------------------------------------------------
// Stateful dry-run mocks (isolate-local)
// ---------------------------------------------------------------------------

interface MockSwasInstance {
  detail: SwasInstanceDetail;
  traffic: SwasTrafficPackage;
  vncPassword: string;
}

const mockInstances = new Map<string, MockSwasInstance>();
const mockFirewalls = new Map<string, SwasFirewallRule[]>();
const mockSnapshots = new Map<string, SwasSnapshot[]>();
const mockCustomImages = new Map<string, SwasCustomImage[]>();
const mockImageShares = new Map<string, SwasShareAccount[]>();

function mockKey(account: AliyunAccount, id?: string): string {
  return `${account.access_key_id}:${account.region_id}:${id ?? account.instance_id}`;
}

function mockAcctRegionKey(account: AliyunAccount): string {
  return `${account.access_key_id}:${account.region_id}`;
}

function getOrSeedMockInstance(account: AliyunAccount): MockSwasInstance {
  const key = mockKey(account);
  let entry = mockInstances.get(key);
  if (!entry) {
    const id = account.instance_id || "swas-mock-001";
    const seed = Array.from(id).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const expired = new Date(Date.now() + 25 * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const created = new Date(Date.now() - 40 * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const totalGb = 1000;
    const usedGb = Math.round(((seed % 420) + 45.6) * 100) / 100;
    const totalBytes = Math.round(totalGb * 1024 ** 3);
    const usedBytes = Math.round(usedGb * 1024 ** 3);
    entry = {
      detail: {
        instance_id: id,
        instance_name: `swas-${id.slice(-6)}`,
        region_id: account.region_id || "cn-hongkong",
        status: "Running",
        business_status: "Normal",
        ddos_status: "Normal",
        disable_reason: "",
        charge_type: "PrePaid",
        plan_id: "swas.s2.c2m2s50b30t10",
        plan_type: "NORMAL",
        public_ip: `47.242.${(seed % 200) + 10}.${(seed * 7) % 240 + 5}`,
        inner_ip: `172.26.${(seed % 100) + 1}.${(seed % 200) + 10}`,
        cpu: 2,
        memory_gb: 2,
        disk_size_gb: 50,
        disk_category: "ESSD",
        bandwidth_mbps: 30,
        flow_gb: totalGb,
        image_id: "swas-img-debian12",
        image_name: "Debian 12.6",
        image_type: "system",
        image_version: "12.6",
        os_type: "linux",
        creation_time: created,
        expired_time: expired,
        disks: [
          {
            disk_id: `d-swas-${id.slice(-6)}`,
            disk_name: "SystemDisk",
            disk_type: "system",
            category: "ESSD",
            size: 50,
            device: "/dev/vda",
            status: "In_use",
            creation_time: created,
            remark: "",
          },
        ],
      },
      traffic: {
        instance_id: id,
        used_bytes: usedBytes,
        total_bytes: totalBytes,
        remaining_bytes: Math.max(0, totalBytes - usedBytes),
        overflow_bytes: 0,
        used_gb: usedGb,
        total_gb: totalGb,
        remaining_gb: Math.round((totalGb - usedGb) * 100) / 100,
        overflow_gb: 0,
      },
      vncPassword: "",
    };
    mockInstances.set(key, entry);
  }
  return entry;
}

function getOrSeedMockFirewall(account: AliyunAccount): SwasFirewallRule[] {
  const key = mockKey(account);
  let rules = mockFirewalls.get(key);
  if (!rules) {
    rules = [
      {
        rule_id: "fw-mock-ssh",
        rule_protocol: "TCP",
        port: "22/22",
        source_cidr_ip: "0.0.0.0/0",
        policy: "accept",
        remark: "SSH",
      },
      {
        rule_id: "fw-mock-http",
        rule_protocol: "TCP",
        port: "80/80",
        source_cidr_ip: "0.0.0.0/0",
        policy: "accept",
        remark: "HTTP",
      },
      {
        rule_id: "fw-mock-https",
        rule_protocol: "TCP",
        port: "443/443",
        source_cidr_ip: "0.0.0.0/0",
        policy: "accept",
        remark: "HTTPS",
      },
    ];
    mockFirewalls.set(key, rules);
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseDisk(raw: Record<string, unknown>): SwasDisk {
  return {
    disk_id: strOf(raw["DiskId"]),
    disk_name: strOf(raw["DiskName"]),
    disk_type: strOf(raw["DiskType"]),
    category: strOf(raw["Category"]),
    size: numOf(raw["Size"]),
    device: strOf(raw["Device"]),
    status: strOf(raw["Status"]),
    creation_time: strOf(raw["CreationTime"]),
    remark: strOf(raw["Remark"]),
  };
}

function parseInstance(raw: Record<string, unknown>): SwasInstanceDetail {
  const spec = (raw["ResourceSpec"] && typeof raw["ResourceSpec"] === "object"
    ? raw["ResourceSpec"]
    : {}) as Record<string, unknown>;
  const img = (raw["Image"] && typeof raw["Image"] === "object"
    ? raw["Image"]
    : {}) as Record<string, unknown>;
  const rawDisks = Array.isArray(raw["Disks"]) ? raw["Disks"] : [];
  const disks: SwasDisk[] = rawDisks
    .filter((d): d is Record<string, unknown> => d !== null && typeof d === "object")
    .map(parseDisk);

  return {
    instance_id: strOf(raw["InstanceId"]),
    instance_name: strOf(raw["InstanceName"]),
    region_id: strOf(raw["RegionId"]),
    status: strOf(raw["Status"]),
    business_status: strOf(raw["BusinessStatus"]),
    ddos_status: strOf(raw["DdosStatus"]),
    disable_reason: strOf(raw["DisableReason"]),
    charge_type: strOf(raw["ChargeType"], "PrePaid"),
    plan_id: strOf(raw["PlanId"]),
    plan_type: strOf(raw["PlanType"]),
    public_ip: strOf(raw["PublicIpAddress"]),
    inner_ip: strOf(raw["InnerIpAddress"]),
    cpu: Math.trunc(numOf(spec["Cpu"])),
    memory_gb: numOf(spec["Memory"]),
    disk_size_gb: Math.trunc(numOf(spec["DiskSize"])),
    disk_category: strOf(spec["DiskCategory"]),
    bandwidth_mbps: Math.trunc(numOf(spec["Bandwidth"])),
    flow_gb: numOf(spec["Flow"]),
    image_id: strOf(raw["ImageId"]),
    image_name: strOf(img["ImageName"]),
    image_type: strOf(img["ImageType"]),
    image_version: strOf(img["ImageVersion"]),
    os_type: strOf(img["OsType"]),
    creation_time: strOf(raw["CreationTime"]),
    expired_time: strOf(raw["ExpiredTime"]),
    disks,
  };
}

function parseTraffic(raw: Record<string, unknown>): SwasTrafficPackage {
  const usedBytes = numOf(raw["TrafficUsed"]);
  const totalBytes = numOf(raw["TrafficPackageTotal"]);
  const remainingBytes = numOf(raw["TrafficPackageRemaining"]);
  const overflowBytes = numOf(raw["TrafficOverflow"]);
  return {
    instance_id: strOf(raw["InstanceId"]),
    used_bytes: usedBytes,
    total_bytes: totalBytes,
    remaining_bytes: remainingBytes,
    overflow_bytes: overflowBytes,
    used_gb: roundGb(usedBytes),
    total_gb: roundGb(totalBytes),
    remaining_gb: roundGb(remainingBytes),
    overflow_gb: roundGb(overflowBytes),
  };
}

// ---------------------------------------------------------------------------
// Instances & traffic packages
// ---------------------------------------------------------------------------

/** List all SWAS instances in `account.region_id` (optionally filtered by instanceIds). */
export async function listInstances(
  env: Env,
  account: AliyunAccount,
  instanceIds?: string[],
): Promise<SwasInstanceDetail[]> {
  if (isDryRun(env)) {
    if (instanceIds && instanceIds.length > 0) {
      return instanceIds.map((id) => {
        const entry = getOrSeedMockInstance({ ...account, instance_id: id });
        return { ...entry.detail, traffic: entry.traffic };
      });
    }
    const prefix = `${account.access_key_id}:${account.region_id}:`;
    const found: SwasInstanceDetail[] = [];
    for (const [k, v] of mockInstances.entries()) {
      if (k.startsWith(prefix)) {
        found.push({ ...v.detail, traffic: v.traffic });
      }
    }
    if (found.length === 0) {
      const demo = getOrSeedMockInstance({ ...account, instance_id: "swas-hk-demo01" });
      found.push({ ...demo.detail, traffic: demo.traffic });
    }
    return found;
  }

  const out: SwasInstanceDetail[] = [];
  let pageNumber = 1;
  const pageSize = 100;
  for (let i = 0; i < 10; i++) {
    const params: Record<string, string> = {
      Action: "ListInstances",
      RegionId: account.region_id,
      PageNumber: String(pageNumber),
      PageSize: String(pageSize),
    };
    if (instanceIds && instanceIds.length > 0) {
      params["InstanceIds"] = JSON.stringify(instanceIds);
    }
    let data: Record<string, unknown>;
    try {
      data = await swasCall<Record<string, unknown>>(account, params);
    } catch (exc) {
      throw new AliyunError(`轻量实例列表查询失败：${briefError(exc)}`);
    }
    const items = Array.isArray(data["Instances"]) ? data["Instances"] : [];
    for (const raw of items) {
      if (raw && typeof raw === "object") {
        out.push(parseInstance(raw as Record<string, unknown>));
      }
    }
    const total = numOf(data["TotalCount"], out.length);
    if (out.length >= total || items.length < pageSize) break;
    pageNumber++;
  }
  return out;
}

export async function listTrafficPackages(
  env: Env,
  account: AliyunAccount,
  instanceIds: string[],
): Promise<Map<string, SwasTrafficPackage>> {
  const result = new Map<string, SwasTrafficPackage>();
  if (instanceIds.length === 0) return result;

  if (isDryRun(env)) {
    for (const id of instanceIds) {
      const entry = getOrSeedMockInstance({ ...account, instance_id: id });
      result.set(id, entry.traffic);
    }
    return result;
  }

  let data: Record<string, unknown>;
  try {
    data = await swasCall<Record<string, unknown>>(account, {
      Action: "ListInstancesTrafficPackages",
      RegionId: account.region_id,
      InstanceIds: JSON.stringify(instanceIds.slice(0, 100)),
    });
  } catch (exc) {
    throw new AliyunError(`轻量流量包查询失败：${briefError(exc)}`);
  }
  const list = Array.isArray(data["InstanceTrafficPackageUsages"])
    ? data["InstanceTrafficPackageUsages"]
    : [];
  for (const raw of list) {
    if (raw && typeof raw === "object") {
      const pkg = parseTraffic(raw as Record<string, unknown>);
      if (pkg.instance_id) result.set(pkg.instance_id, pkg);
    }
  }
  return result;
}

export async function listDisks(
  env: Env,
  account: AliyunAccount,
): Promise<SwasDisk[]> {
  if (isDryRun(env)) {
    return getOrSeedMockInstance(account).detail.disks;
  }
  let data: Record<string, unknown>;
  try {
    data = await swasCall<Record<string, unknown>>(account, {
      Action: "ListDisks",
      RegionId: account.region_id,
      InstanceId: account.instance_id,
      PageSize: "50",
    });
  } catch (exc) {
    throw new AliyunError(`轻量磁盘列表查询失败：${briefError(exc)}`);
  }
  const list = Array.isArray(data["Disks"]) ? data["Disks"] : [];
  return list
    .filter((d): d is Record<string, unknown> => d !== null && typeof d === "object")
    .map(parseDisk);
}

/** Fetch full instance detail + traffic package + disks (with ListDisks fallback if empty). */
export async function getInstanceDetail(
  env: Env,
  account: AliyunAccount,
): Promise<SwasInstanceDetail> {
  const list = await listInstances(env, account, [account.instance_id]);
  const detail = list.find((item) => item.instance_id === account.instance_id) ?? list[0];
  if (!detail) {
    throw new AliyunError(`地域 ${account.region_id} 下未找到轻量实例 ${account.instance_id}`);
  }
  const trafficMap = await listTrafficPackages(env, account, [account.instance_id]).catch(
    () => new Map<string, SwasTrafficPackage>(),
  );
  detail.traffic = trafficMap.get(account.instance_id) ?? null;
  if (detail.disks.length === 0) {
    detail.disks = await listDisks(env, account).catch(() => []);
  }
  return detail;
}

// ---------------------------------------------------------------------------
// Power operations
// ---------------------------------------------------------------------------

export async function startInstance(env: Env, account: AliyunAccount): Promise<void> {
  if (isDryRun(env)) {
    getOrSeedMockInstance(account).detail.status = "Running";
    return;
  }
  try {
    await swasCall(account, {
      Action: "StartInstance",
      RegionId: account.region_id,
      InstanceId: account.instance_id,
    });
  } catch (exc) {
    throw new AliyunError(`轻量开机失败：${briefError(exc)}`);
  }
}

export async function stopInstance(
  env: Env,
  account: AliyunAccount,
  forceStop = false,
): Promise<void> {
  if (isDryRun(env)) {
    getOrSeedMockInstance(account).detail.status = "Stopped";
    return;
  }
  const params: Record<string, string> = {
    Action: "StopInstance",
    RegionId: account.region_id,
    InstanceId: account.instance_id,
  };
  if (forceStop) params["ForceStop"] = "true";
  try {
    await swasCall(account, params);
  } catch (exc) {
    throw new AliyunError(`轻量关机失败：${briefError(exc)}`);
  }
}

export async function rebootInstance(
  env: Env,
  account: AliyunAccount,
  forceReboot = false,
): Promise<void> {
  if (isDryRun(env)) {
    getOrSeedMockInstance(account).detail.status = "Running";
    return;
  }
  const params: Record<string, string> = {
    Action: "RebootInstance",
    RegionId: account.region_id,
    InstanceId: account.instance_id,
  };
  if (forceReboot) params["ForceReboot"] = "true";
  try {
    await swasCall(account, params);
  } catch (exc) {
    throw new AliyunError(`轻量重启失败：${briefError(exc)}`);
  }
}

// ---------------------------------------------------------------------------
// VNC & Workbench
// ---------------------------------------------------------------------------

export async function describeInstanceVncUrl(
  env: Env,
  account: AliyunAccount,
): Promise<string> {
  if (isDryRun(env)) {
    return `wss%3A%2F%2Fmock-vnc.aliyun.com%2Fwebsockify%2F%3Fs%3Dswas-${encodeURIComponent(account.instance_id)}`;
  }
  let data: Record<string, unknown>;
  try {
    data = await swasCall<Record<string, unknown>>(account, {
      Action: "DescribeInstanceVncUrl",
      RegionId: account.region_id,
      InstanceId: account.instance_id,
    });
  } catch (exc) {
    throw new AliyunError(`获取轻量 VNC 地址失败：${briefError(exc)}`);
  }
  const vncUrl = strOf(data["VncUrl"]);
  if (!vncUrl) throw new AliyunError("阿里云未返回轻量 VNC 连接地址");
  return vncUrl;
}

export async function modifyInstanceVncPassword(
  env: Env,
  account: AliyunAccount,
  vncPassword: string,
): Promise<void> {
  if (isDryRun(env)) {
    getOrSeedMockInstance(account).vncPassword = vncPassword;
    return;
  }
  try {
    await swasCall(account, {
      Action: "ModifyInstanceVncPassword",
      RegionId: account.region_id,
      InstanceId: account.instance_id,
      VncPassword: vncPassword,
    });
  } catch (exc) {
    throw new AliyunError(`修改 VNC 密码失败：${briefError(exc)}`);
  }
}

export async function loginInstanceWorkbench(
  env: Env,
  account: AliyunAccount,
  opts?: { username?: string; password?: string; port?: number },
): Promise<string> {
  if (isDryRun(env)) {
    return `https://ecs-workbench.aliyun.com/view/instance/single/mock-${encodeURIComponent(account.instance_id)}`;
  }
  const params: Record<string, string> = {
    Action: "LoginInstance",
    RegionId: account.region_id,
    InstanceId: account.instance_id,
  };
  if (opts?.username) params["Username"] = opts.username;
  if (opts?.password) params["Password"] = opts.password;
  if (opts?.port && opts.port > 0) params["Port"] = String(Math.trunc(opts.port));
  let data: Record<string, unknown>;
  try {
    data = await swasCall<Record<string, unknown>>(account, params);
  } catch (exc) {
    throw new AliyunError(`获取 Workbench 登录链接失败：${briefError(exc)}`);
  }
  const url = strOf(data["RedirectUrl"]);
  if (!url) throw new AliyunError("阿里云未返回 Workbench 登录地址");
  return url;
}

// ---------------------------------------------------------------------------
// Instance attribute (rename / reset password)
// ---------------------------------------------------------------------------

export async function updateInstanceAttribute(
  env: Env,
  account: AliyunAccount,
  opts: { instanceName?: string; password?: string },
): Promise<void> {
  if (isDryRun(env)) {
    const entry = getOrSeedMockInstance(account);
    if (opts.instanceName) entry.detail.instance_name = opts.instanceName;
    return;
  }
  const params: Record<string, string> = {
    Action: "UpdateInstanceAttribute",
    RegionId: account.region_id,
    InstanceId: account.instance_id,
  };
  if (opts.instanceName) params["InstanceName"] = opts.instanceName;
  if (opts.password) params["Password"] = opts.password;
  try {
    await swasCall(account, params);
  } catch (exc) {
    throw new AliyunError(`修改轻量实例属性失败：${briefError(exc)}`);
  }
}

// ---------------------------------------------------------------------------
// Images, key pairs & ResetSystem
// ---------------------------------------------------------------------------

export async function listImages(
  env: Env,
  account: AliyunAccount,
  imageType?: "system" | "app" | "custom",
): Promise<SwasImageItem[]> {
  if (isDryRun(env)) {
    const all: SwasImageItem[] = [
      {
        image_id: "swas-img-debian12",
        image_name: "Debian 12.6",
        image_type: "system",
        platform: "Linux",
        description: "Debian 12.6 64-bit",
      },
      {
        image_id: "swas-img-ubuntu24",
        image_name: "Ubuntu 24.04 LTS",
        image_type: "system",
        platform: "Linux",
        description: "Ubuntu 24.04 64-bit",
      },
      {
        image_id: "swas-img-alinux3",
        image_name: "Alibaba Cloud Linux 3.2104",
        image_type: "system",
        platform: "Linux",
        description: "Alibaba Cloud Linux 3",
      },
      {
        image_id: "swas-img-win2022",
        image_name: "Windows Server 2022 中文版",
        image_type: "system",
        platform: "Windows",
        description: "Windows Server 2022 Datacenter",
      },
      {
        image_id: "swas-app-docker",
        image_name: "Docker 26.1",
        image_type: "app",
        platform: "Linux",
        description: "预装 Docker 与 Docker Compose",
      },
      {
        image_id: "swas-app-wordpress",
        image_name: "WordPress 6.6",
        image_type: "app",
        platform: "Linux",
        description: "预装 Nginx + PHP + MySQL + WordPress",
      },
    ];
    const customList = (mockCustomImages.get(mockAcctRegionKey(account)) ?? []).map((c) => ({
      image_id: c.image_id,
      image_name: c.name,
      image_type: "custom",
      platform: c.os_type || "Linux",
      description: c.description,
    }));
    const merged = [...all, ...customList];
    return imageType ? merged.filter((x) => x.image_type === imageType) : merged;
  }

  const params: Record<string, string> = {
    Action: "ListImages",
    RegionId: account.region_id,
  };
  if (imageType) params["ImageType"] = imageType;
  let data: Record<string, unknown>;
  try {
    data = await swasCall<Record<string, unknown>>(account, params);
  } catch (exc) {
    throw new AliyunError(`获取轻量镜像列表失败：${briefError(exc)}`);
  }
  const items = Array.isArray(data["Images"]) ? data["Images"] : [];
  return items
    .filter((i): i is Record<string, unknown> => i !== null && typeof i === "object")
    .map((raw) => ({
      image_id: strOf(raw["ImageId"]),
      image_name: strOf(raw["ImageName"]),
      image_type: strOf(raw["ImageType"]),
      platform: strOf(raw["Platform"]),
      description: strOf(raw["Description"]),
    }));
}

export async function listKeyPairs(
  env: Env,
  account: AliyunAccount,
): Promise<string[]> {
  if (isDryRun(env)) {
    return ["swas-default-key"];
  }
  let data: Record<string, unknown>;
  try {
    data = await swasCall<Record<string, unknown>>(account, {
      Action: "ListKeyPairs",
      RegionId: account.region_id,
      PageSize: "50",
    });
  } catch (exc) {
    throw new AliyunError(`获取轻量密钥对失败：${briefError(exc)}`);
  }
  const list = Array.isArray(data["KeyPairs"]) ? data["KeyPairs"] : [];
  return list
    .filter((k): k is Record<string, unknown> => k !== null && typeof k === "object")
    .map((k) => strOf(k["KeyPairName"]))
    .filter(Boolean);
}

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
    const entry = getOrSeedMockInstance(account);
    if (opts.imageId) {
      entry.detail.image_id = opts.imageId;
      const imgs = await listImages(env, account);
      const matched = imgs.find((i) => i.image_id === opts.imageId);
      if (matched) {
        entry.detail.image_name = matched.image_name;
        entry.detail.image_type = matched.image_type;
        entry.detail.os_type = matched.platform.toLowerCase();
      }
    }
    entry.detail.status = "Running";
    return;
  }

  const params: Record<string, string> = {
    Action: "ResetSystem",
    RegionId: account.region_id,
    InstanceId: account.instance_id,
  };
  if (opts.imageId) params["ImageId"] = opts.imageId;
  if (opts.password) params["LoginCredentials.Password"] = opts.password;
  if (opts.keyPairName) params["LoginCredentials.KeyPairName"] = opts.keyPairName;
  if (opts.clientToken) params["ClientToken"] = opts.clientToken;
  try {
    await swasCall(account, params);
  } catch (exc) {
    throw new AliyunError(`轻量重置系统失败：${briefError(exc)}`);
  }
}

// ---------------------------------------------------------------------------
// Firewall rules
// ---------------------------------------------------------------------------

export async function listFirewallRules(
  env: Env,
  account: AliyunAccount,
): Promise<SwasFirewallRule[]> {
  if (isDryRun(env)) {
    return [...getOrSeedMockFirewall(account)];
  }
  const out: SwasFirewallRule[] = [];
  let pageNumber = 1;
  const pageSize = 100;
  for (let i = 0; i < 5; i++) {
    let data: Record<string, unknown>;
    try {
      data = await swasCall<Record<string, unknown>>(account, {
        Action: "ListFirewallRules",
        RegionId: account.region_id,
        InstanceId: account.instance_id,
        PageNumber: String(pageNumber),
        PageSize: String(pageSize),
      });
    } catch (exc) {
      throw new AliyunError(`获取防火墙规则失败：${briefError(exc)}`);
    }
    const items = Array.isArray(data["FirewallRules"]) ? data["FirewallRules"] : [];
    for (const raw of items) {
      if (raw && typeof raw === "object") {
        const r = raw as Record<string, unknown>;
        out.push({
          rule_id: strOf(r["RuleId"]),
          rule_protocol: strOf(r["RuleProtocol"]),
          port: strOf(r["Port"]),
          source_cidr_ip: strOf(r["SourceCidrIp"], "0.0.0.0/0"),
          policy: strOf(r["Policy"], "accept"),
          remark: strOf(r["Remark"]),
        });
      }
    }
    const total = numOf(data["TotalCount"], out.length);
    if (out.length >= total || items.length < pageSize) break;
    pageNumber++;
  }
  return out;
}

export async function createFirewallRule(
  env: Env,
  account: AliyunAccount,
  opts: {
    ruleProtocol: "TCP" | "UDP" | "TCP+UDP" | "ICMP";
    port: string;
    sourceCidrIp?: string;
    remark?: string;
  },
): Promise<string> {
  if (isDryRun(env)) {
    const rules = getOrSeedMockFirewall(account);
    const id = `fw-mock-${Date.now().toString(36).slice(-6)}`;
    rules.push({
      rule_id: id,
      rule_protocol: opts.ruleProtocol,
      port: opts.port,
      source_cidr_ip: opts.sourceCidrIp || "0.0.0.0/0",
      policy: "accept",
      remark: opts.remark || "",
    });
    return id;
  }

  // Use CreateFirewallRules (batch API) so SourceCidrIp can be specified directly.
  const params: Record<string, string> = {
    Action: "CreateFirewallRules",
    RegionId: account.region_id,
    InstanceId: account.instance_id,
    "FirewallRules.1.RuleProtocol": opts.ruleProtocol,
    "FirewallRules.1.Port": opts.port,
  };
  if (opts.sourceCidrIp) params["FirewallRules.1.SourceCidrIp"] = opts.sourceCidrIp;
  if (opts.remark) params["FirewallRules.1.Remark"] = opts.remark;

  let data: Record<string, unknown>;
  try {
    data = await swasCall<Record<string, unknown>>(account, params);
  } catch (exc) {
    throw new AliyunError(`添加防火墙规则失败：${briefError(exc)}`);
  }
  const ids = Array.isArray(data["FirewallRuleIds"]) ? data["FirewallRuleIds"] : [];
  return strOf(ids[0]);
}

export async function toggleFirewallRule(
  env: Env,
  account: AliyunAccount,
  ruleId: string,
  enable: boolean,
): Promise<void> {
  if (isDryRun(env)) {
    const rules = getOrSeedMockFirewall(account);
    const found = rules.find((r) => r.rule_id === ruleId);
    if (found) found.policy = enable ? "accept" : "drop";
    return;
  }
  try {
    await swasCall(account, {
      Action: enable ? "EnableFirewallRule" : "DisableFirewallRule",
      RegionId: account.region_id,
      InstanceId: account.instance_id,
      RuleId: ruleId,
    });
  } catch (exc) {
    throw new AliyunError(`${enable ? "启用" : "禁用"}防火墙规则失败：${briefError(exc)}`);
  }
}

export async function deleteFirewallRule(
  env: Env,
  account: AliyunAccount,
  ruleId: string,
): Promise<void> {
  if (isDryRun(env)) {
    const rules = getOrSeedMockFirewall(account);
    const idx = rules.findIndex((r) => r.rule_id === ruleId);
    if (idx >= 0) rules.splice(idx, 1);
    return;
  }
  try {
    await swasCall(account, {
      Action: "DeleteFirewallRule",
      RegionId: account.region_id,
      InstanceId: account.instance_id,
      RuleId: ruleId,
    });
  } catch (exc) {
    throw new AliyunError(`删除防火墙规则失败：${briefError(exc)}`);
  }
}

// ---------------------------------------------------------------------------
// Snapshots & Custom Images (with cross-account + ECS sharing)
// ---------------------------------------------------------------------------

export async function listSnapshots(
  env: Env,
  account: AliyunAccount,
  instanceId?: string,
): Promise<SwasSnapshot[]> {
  if (isDryRun(env)) {
    const list = mockSnapshots.get(mockAcctRegionKey(account)) ?? [];
    return instanceId ? list.filter((s) => !s.instance_id || s.instance_id === instanceId) : [...list];
  }
  const params: Record<string, string> = {
    Action: "ListSnapshots",
    RegionId: account.region_id,
    PageSize: "100",
  };
  if (instanceId) params["InstanceId"] = instanceId;
  let data: Record<string, unknown>;
  try {
    data = await swasCall<Record<string, unknown>>(account, params);
  } catch (exc) {
    throw new AliyunError(`获取快照列表失败：${briefError(exc)}`);
  }
  const list = Array.isArray(data["Snapshots"]) ? data["Snapshots"] : [];
  return list
    .filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
    .map((raw) => ({
      snapshot_id: strOf(raw["SnapshotId"]),
      snapshot_name: strOf(raw["SnapshotName"]),
      status: strOf(raw["Status"]),
      progress: strOf(raw["Progress"]),
      source_disk_id: strOf(raw["SourceDiskId"]),
      source_disk_type: strOf(raw["SourceDiskType"]),
      instance_id: strOf(raw["InstanceId"]),
      creation_time: strOf(raw["CreationTime"]),
      remark: strOf(raw["Remark"]),
    }));
}

export async function createSnapshot(
  env: Env,
  account: AliyunAccount,
  opts: { diskId: string; snapshotName: string },
): Promise<string> {
  if (isDryRun(env)) {
    const key = mockAcctRegionKey(account);
    const list = mockSnapshots.get(key) ?? [];
    const id = `s-mock-${Date.now().toString(36).slice(-6)}`;
    list.unshift({
      snapshot_id: id,
      snapshot_name: opts.snapshotName,
      status: "Accomplished",
      progress: "100%",
      source_disk_id: opts.diskId,
      source_disk_type: "System",
      instance_id: account.instance_id,
      creation_time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      remark: "",
    });
    mockSnapshots.set(key, list);
    return id;
  }
  let data: Record<string, unknown>;
  try {
    data = await swasCall<Record<string, unknown>>(account, {
      Action: "CreateSnapshot",
      RegionId: account.region_id,
      DiskId: opts.diskId,
      SnapshotName: opts.snapshotName,
    });
  } catch (exc) {
    throw new AliyunError(`创建快照失败：${briefError(exc)}`);
  }
  return strOf(data["SnapshotId"]);
}

export async function deleteSnapshot(
  env: Env,
  account: AliyunAccount,
  snapshotId: string,
): Promise<void> {
  if (isDryRun(env)) {
    const key = mockAcctRegionKey(account);
    const list = mockSnapshots.get(key) ?? [];
    mockSnapshots.set(
      key,
      list.filter((s) => s.snapshot_id !== snapshotId),
    );
    return;
  }
  try {
    await swasCall(account, {
      Action: "DeleteSnapshot",
      RegionId: account.region_id,
      SnapshotId: snapshotId,
    });
  } catch (exc) {
    throw new AliyunError(`删除快照失败：${briefError(exc)}`);
  }
}

function mapCustomImageStatus(raw: string): string {
  switch (raw) {
    case "0":
      return "Copying";
    case "1":
      return "Available";
    case "2":
      return "Unavailable";
    case "3":
      return "CreateFailed";
    case "4":
      return "Creating";
    default:
      return raw || "Available";
  }
}

export async function listCustomImages(
  env: Env,
  account: AliyunAccount,
  shareFilter?: boolean,
): Promise<SwasCustomImage[]> {
  if (isDryRun(env)) {
    const list = mockCustomImages.get(mockAcctRegionKey(account)) ?? [];
    if (shareFilter === true) return list.filter((i) => i.in_share_user);
    if (shareFilter === false) return list.filter((i) => !i.in_share_user);
    return [...list];
  }
  const params: Record<string, string> = {
    Action: "ListCustomImages",
    RegionId: account.region_id,
    PageSize: "100",
  };
  if (shareFilter !== undefined) params["Share"] = shareFilter ? "true" : "false";
  let data: Record<string, unknown>;
  try {
    data = await swasCall<Record<string, unknown>>(account, params);
  } catch (exc) {
    throw new AliyunError(`获取自定义镜像列表失败：${briefError(exc)}`);
  }
  const list = Array.isArray(data["CustomImages"]) ? data["CustomImages"] : [];
  return list
    .filter((i): i is Record<string, unknown> => i !== null && typeof i === "object")
    .map((raw) => ({
      image_id: strOf(raw["ImageId"]),
      name: strOf(raw["Name"]),
      description: strOf(raw["Description"]),
      status: mapCustomImageStatus(strOf(raw["Status"])),
      os_type: strOf(raw["OsType"]),
      instance_id: strOf(raw["InstanceId"]),
      instance_name: strOf(raw["InstanceName"]),
      system_snapshot_id: strOf(raw["SystemSnapshotId"]),
      system_snapshot_name: strOf(raw["SystemSnapshotName"]),
      data_snapshot_id: strOf(raw["DataSnapshotId"]),
      in_share_ecs: boolOf(raw["InShare"]),
      in_share_user: boolOf(raw["InShareUser"]),
      required_system_disk_size: Math.trunc(numOf(raw["RequiredSystemDiskSize"])),
      required_data_disk_size: Math.trunc(numOf(raw["RequiredDataDiskSize"])),
      source_image_name: strOf(raw["SourceImageName"]),
      creation_time: strOf(raw["CreationTime"]),
    }));
}

export async function createCustomImage(
  env: Env,
  account: AliyunAccount,
  opts: {
    imageName: string;
    systemSnapshotId: string;
    dataSnapshotId?: string;
    description?: string;
  },
): Promise<string> {
  if (isDryRun(env)) {
    const key = mockAcctRegionKey(account);
    const list = mockCustomImages.get(key) ?? [];
    const inst = getOrSeedMockInstance(account);
    const id = `m-swas-${Date.now().toString(36).slice(-6)}`;
    list.unshift({
      image_id: id,
      name: opts.imageName,
      description: opts.description || "",
      status: "Available",
      os_type: inst.detail.os_type || "Linux",
      instance_id: account.instance_id,
      instance_name: inst.detail.instance_name,
      system_snapshot_id: opts.systemSnapshotId,
      system_snapshot_name: opts.systemSnapshotId,
      data_snapshot_id: opts.dataSnapshotId || "",
      in_share_ecs: false,
      in_share_user: false,
      required_system_disk_size: inst.detail.disk_size_gb || 50,
      required_data_disk_size: 0,
      source_image_name: inst.detail.image_name,
      creation_time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    mockCustomImages.set(key, list);
    return id;
  }
  const params: Record<string, string> = {
    Action: "CreateCustomImage",
    RegionId: account.region_id,
    InstanceId: account.instance_id,
    ImageName: opts.imageName,
    SystemSnapshotId: opts.systemSnapshotId,
  };
  if (opts.dataSnapshotId) params["DataSnapshotId"] = opts.dataSnapshotId;
  if (opts.description) params["Description"] = opts.description;
  let data: Record<string, unknown>;
  try {
    data = await swasCall<Record<string, unknown>>(account, params);
  } catch (exc) {
    throw new AliyunError(`创建轻量自定义镜像失败：${briefError(exc)}`);
  }
  return strOf(data["ImageId"]);
}

export async function deleteCustomImage(
  env: Env,
  account: AliyunAccount,
  imageId: string,
): Promise<void> {
  if (isDryRun(env)) {
    const key = mockAcctRegionKey(account);
    const list = mockCustomImages.get(key) ?? [];
    mockCustomImages.set(
      key,
      list.filter((i) => i.image_id !== imageId),
    );
    mockImageShares.delete(`${key}:${imageId}`);
    return;
  }
  try {
    await swasCall(account, {
      Action: "DeleteCustomImage",
      RegionId: account.region_id,
      ImageId: imageId,
    });
  } catch (exc) {
    throw new AliyunError(`删除轻量自定义镜像失败：${briefError(exc)}`);
  }
}

export async function modifyImageShareStatus(
  env: Env,
  account: AliyunAccount,
  imageId: string,
  shareToEcs: boolean,
): Promise<void> {
  if (isDryRun(env)) {
    const list = mockCustomImages.get(mockAcctRegionKey(account)) ?? [];
    const found = list.find((i) => i.image_id === imageId);
    if (found) found.in_share_ecs = shareToEcs;
    return;
  }
  try {
    await swasCall(account, {
      Action: "ModifyImageShareStatus",
      RegionId: account.region_id,
      ImageId: imageId,
      Operation: shareToEcs ? "Share" : "UnShare",
    });
  } catch (exc) {
    throw new AliyunError(
      `${shareToEcs ? "共享到 ECS" : "取消共享到 ECS"}失败：${briefError(exc)}`,
    );
  }
}

export async function listCustomImageShareAccounts(
  env: Env,
  account: AliyunAccount,
  imageId: string,
): Promise<SwasShareAccount[]> {
  if (isDryRun(env)) {
    return [...(mockImageShares.get(`${mockAcctRegionKey(account)}:${imageId}`) ?? [])];
  }
  let data: Record<string, unknown>;
  try {
    data = await swasCall<Record<string, unknown>>(account, {
      Action: "ListCustomImageShareAccounts",
      RegionId: account.region_id,
      ImageId: imageId,
      PageSize: "50",
    });
  } catch (exc) {
    throw new AliyunError(`查询跨账号共享列表失败：${briefError(exc)}`);
  }
  const users = Array.isArray(data["ImageShareUsers"]) ? data["ImageShareUsers"] : [];
  return users
    .filter((u): u is Record<string, unknown> => u !== null && typeof u === "object")
    .map((u) => ({
      user_id: strOf(u["UserId"]),
      shared_time: strOf(u["SharedTime"]),
    }))
    .filter((u) => Boolean(u.user_id) && u.user_id !== "0");
}

export async function updateCustomImageShareAccounts(
  env: Env,
  account: AliyunAccount,
  imageId: string,
  action: "add" | "remove",
  accountIds: string[],
): Promise<void> {
  if (accountIds.length === 0) return;
  if (isDryRun(env)) {
    const shareKey = `${mockAcctRegionKey(account)}:${imageId}`;
    const current = mockImageShares.get(shareKey) ?? [];
    if (action === "add") {
      const nowStr = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, ".0");
      for (const uid of accountIds) {
        if (!current.some((x) => x.user_id === uid)) {
          current.push({ user_id: uid, shared_time: nowStr });
        }
      }
      mockImageShares.set(shareKey, current);
    } else {
      const drop = new Set(accountIds);
      mockImageShares.set(
        shareKey,
        current.filter((x) => !drop.has(x.user_id)),
      );
    }
    const imgs = mockCustomImages.get(mockAcctRegionKey(account)) ?? [];
    const img = imgs.find((x) => x.image_id === imageId);
    if (img) img.in_share_user = (mockImageShares.get(shareKey)?.length ?? 0) > 0;
    return;
  }

  const params: Record<string, string> = {
    Action: action === "add" ? "AddCustomImageShareAccount" : "RemoveCustomImageShareAccount",
    RegionId: account.region_id,
    ImageId: imageId,
  };
  accountIds.slice(0, 10).forEach((uid, idx) => {
    params[`Account.${idx + 1}`] = uid;
  });
  try {
    await swasCall(account, params);
  } catch (exc) {
    throw new AliyunError(
      `${action === "add" ? "添加" : "取消"}跨账号共享失败：${briefError(exc)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Plans, Pricing, Renewal & Provisioning (CreateInstances)
// ---------------------------------------------------------------------------

export async function listPlans(
  env: Env,
  account: AliyunAccount,
): Promise<SwasPlan[]> {
  if (isDryRun(env)) {
    const currency = account.site === "international" ? "USD" : "CNY";
    const factor = currency === "USD" ? 0.14 : 1;
    return [
      {
        plan_id: "swas.s2.c2m1s40b30t05",
        plan_type: "NORMAL",
        core: 2,
        memory: 1,
        disk_size: 40,
        disk_type: "ESSD",
        bandwidth: 30,
        flow: 500,
        isp_type: "BGP",
        origin_price: Math.round(24 * factor * 100) / 100,
        currency,
        support_platform: ["Linux"],
      },
      {
        plan_id: "swas.s2.c2m2s50b30t10",
        plan_type: "NORMAL",
        core: 2,
        memory: 2,
        disk_size: 50,
        disk_type: "ESSD",
        bandwidth: 30,
        flow: 1000,
        isp_type: "BGP",
        origin_price: Math.round(34 * factor * 100) / 100,
        currency,
        support_platform: ["Linux", "Windows"],
      },
      {
        plan_id: "swas.s2.c2m4s80b30t20",
        plan_type: "NORMAL",
        core: 2,
        memory: 4,
        disk_size: 80,
        disk_type: "ESSD",
        bandwidth: 30,
        flow: 2000,
        isp_type: "BGP",
        origin_price: Math.round(67 * factor * 100) / 100,
        currency,
        support_platform: ["Linux", "Windows"],
      },
      {
        plan_id: "swas.s2.c4m8s100b200t30",
        plan_type: "NORMAL",
        core: 4,
        memory: 8,
        disk_size: 100,
        disk_type: "ESSD",
        bandwidth: 200,
        flow: 3000,
        isp_type: "BGP",
        origin_price: Math.round(135 * factor * 100) / 100,
        currency,
        support_platform: ["Linux", "Windows"],
      },
    ];
  }

  let data: Record<string, unknown>;
  try {
    data = await swasCall<Record<string, unknown>>(account, {
      Action: "ListPlans",
      RegionId: account.region_id,
    });
  } catch (exc) {
    throw new AliyunError(`获取轻量套餐列表失败：${briefError(exc)}`);
  }
  const plans = Array.isArray(data["Plans"]) ? data["Plans"] : [];
  return plans
    .filter((p): p is Record<string, unknown> => p !== null && typeof p === "object")
    .map((raw) => {
      let platforms: string[] = [];
      const sp = raw["SupportPlatform"];
      if (Array.isArray(sp)) {
        platforms = sp.map((x) => strOf(x)).filter(Boolean);
      } else if (typeof sp === "string" && sp.trim()) {
        try {
          const parsed = JSON.parse(sp);
          if (Array.isArray(parsed)) platforms = parsed.map((x) => strOf(x)).filter(Boolean);
        } catch {
          platforms = [sp.trim()];
        }
      }
      return {
        plan_id: strOf(raw["PlanId"]),
        plan_type: strOf(raw["PlanType"], "NORMAL"),
        core: Math.trunc(numOf(raw["Core"])),
        memory: numOf(raw["Memory"]),
        disk_size: Math.trunc(numOf(raw["DiskSize"])),
        disk_type: strOf(raw["DiskType"], "ESSD"),
        bandwidth: Math.trunc(numOf(raw["Bandwidth"])),
        flow: Math.trunc(numOf(raw["Flow"])),
        isp_type: strOf(raw["IspType"], "BGP"),
        origin_price: numOf(raw["OriginPrice"]),
        currency: strOf(raw["Currency"], account.site === "international" ? "USD" : "CNY"),
        support_platform: platforms,
      };
    })
    .filter((p) => Boolean(p.plan_id))
    .sort((a, b) => a.origin_price - b.origin_price || a.core - b.core || a.memory - b.memory);
}

/**
 * Query real-time price via `SWAS-OPEN:DescribePrice`.
 * Automatically maps 12/24/36 months to `PriceUnit=Year` + `Period=1/2/3` as
 * required by Aliyun's `DescribePrice` contract (`Month` only allows 1..9).
 */
export async function describePrice(
  env: Env,
  account: AliyunAccount,
  opts: {
    planId: string;
    periodMonths: number;
    dataDiskSize?: number;
    instanceId?: string;
    amount?: number;
  },
): Promise<PriceQuote> {
  const months = Math.max(1, Math.trunc(opts.periodMonths));
  const useYear = months >= 12 && months % 12 === 0;
  const period = useYear ? months / 12 : months;
  const priceUnit = useYear ? "Year" : "Month";
  const dataDisk = Math.max(0, Math.trunc(opts.dataDiskSize ?? 0));
  const amount = Math.max(1, Math.min(20, Math.trunc(opts.amount ?? 1)));

  if (isDryRun(env)) {
    const plans = await listPlans(env, account);
    const plan = plans.find((p) => p.plan_id === opts.planId) ?? plans[1] ?? plans[0]!;
    const diskMonthly = (dataDisk / 20) * (plan.currency === "USD" ? 0.6 : 4);
    const base = (plan.origin_price + diskMonthly) * months * amount;
    const discountRate = months >= 24 ? 0.25 : months >= 12 ? 0.15 : 0;
    const discount = Math.round(base * discountRate * 100) / 100;
    const original = Math.round(base * 100) / 100;
    return {
      original_price: original,
      discount_price: discount,
      trade_price: Math.round((original - discount) * 100) / 100,
      currency: plan.currency,
      period,
      price_unit: priceUnit,
      rules: discount > 0 ? [`年付折扣 -${Math.round(discountRate * 100)}%`] : [],
    };
  }

  const params: Record<string, string> = {
    Action: "DescribePrice",
    RegionId: account.region_id,
    CommodityType: "Server",
    PlanId: opts.planId,
    Period: String(period),
    PriceUnit: priceUnit,
    Amount: String(amount),
    PayType: "Prepaid",
    OrderType: "Buy",
    AcceptLanguage: "zh-CN",
  };
  if (dataDisk > 0) params["DataDiskSize"] = String(dataDisk);
  if (opts.instanceId) params["InstanceId"] = opts.instanceId;

  let data: Record<string, unknown>;
  try {
    data = await swasCall<Record<string, unknown>>(account, params);
  } catch (exc) {
    throw new AliyunError(`轻量询价失败：${briefError(exc)}`);
  }
  const priceInfo = (data["PriceInfo"] && typeof data["PriceInfo"] === "object"
    ? data["PriceInfo"]
    : {}) as Record<string, unknown>;
  const price = (priceInfo["Price"] && typeof priceInfo["Price"] === "object"
    ? priceInfo["Price"]
    : {}) as Record<string, unknown>;
  const rawRules = Array.isArray(priceInfo["Rules"]) ? priceInfo["Rules"] : [];
  const rules = rawRules
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
    .map((r) => strOf(r["Description"]).trim())
    .filter(Boolean);
  const original = numOf(price["OriginalPrice"]);
  const trade = numOf(price["TradePrice"]);
  const discount = numOf(price["DiscountPrice"], Math.max(0, Math.round((original - trade) * 100) / 100));
  return {
    original_price: original,
    discount_price: discount,
    trade_price: trade,
    currency: strOf(price["Currency"], account.site === "international" ? "USD" : "CNY"),
    period,
    price_unit: priceUnit,
    rules,
  };
}

export async function renewInstance(
  env: Env,
  account: AliyunAccount,
  opts: { periodMonths: number; clientToken?: string },
): Promise<{ request_id: string; expired_time?: string }> {
  const validPeriods = new Set([1, 3, 6, 12, 24, 36]);
  const months = Math.trunc(opts.periodMonths);
  if (!validPeriods.has(months)) {
    throw new AliyunError("轻量续费时长仅支持 1、3、6、12、24 或 36 个月");
  }

  if (isDryRun(env)) {
    const entry = getOrSeedMockInstance(account);
    const baseMs = Math.max(Date.now(), Date.parse(entry.detail.expired_time) || Date.now());
    const nextDate = new Date(baseMs);
    nextDate.setUTCMonth(nextDate.getUTCMonth() + months);
    const nextIso = nextDate.toISOString().replace(/\.\d{3}Z$/, "Z");
    entry.detail.expired_time = nextIso;
    return { request_id: `mock-renew-${Date.now().toString(36)}`, expired_time: nextIso };
  }

  const params: Record<string, string> = {
    Action: "RenewInstance",
    RegionId: account.region_id,
    InstanceId: account.instance_id,
    Period: String(months),
  };
  if (opts.clientToken) params["ClientToken"] = opts.clientToken;
  let data: Record<string, unknown>;
  try {
    data = await swasCall<Record<string, unknown>>(account, params);
  } catch (exc) {
    throw new AliyunError(`轻量续费失败：${briefError(exc)}`);
  }
  const refreshed = await getInstanceDetail(env, account).catch(() => null);
  return {
    request_id: strOf(data["RequestId"]),
    expired_time: refreshed?.expired_time || undefined,
  };
}

export async function createInstances(
  env: Env,
  account: AliyunAccount,
  opts: {
    planId: string;
    imageId: string;
    periodMonths: number;
    dataDiskSize?: number;
    autoRenew?: boolean;
    autoRenewPeriod?: number;
    clientToken?: string;
  },
): Promise<{ instance_ids: string[]; request_id: string }> {
  const validPeriods = new Set([1, 3, 6, 12, 24, 36]);
  const months = Math.trunc(opts.periodMonths);
  if (!validPeriods.has(months)) {
    throw new AliyunError("轻量购买时长仅支持 1、3、6、12、24 或 36 个月");
  }
  const dataDisk = Math.max(0, Math.trunc(opts.dataDiskSize ?? 0));
  if (dataDisk > 0 && (dataDisk % 20 !== 0 || dataDisk > 16380)) {
    throw new AliyunError("数据盘容量须为 0 或 20 的整数倍（最大 16380 GB）");
  }

  if (isDryRun(env)) {
    const newId = `swas-mock-${Date.now().toString(36).slice(-6)}`;
    const plans = await listPlans(env, account);
    const plan = plans.find((p) => p.plan_id === opts.planId) ?? plans[0]!;
    const images = await listImages(env, account);
    const img = images.find((i) => i.image_id === opts.imageId);
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const exp = new Date();
    exp.setUTCMonth(exp.getUTCMonth() + months);
    const expIso = exp.toISOString().replace(/\.\d{3}Z$/, "Z");
    const totalGb = plan.flow || 1000;
    const totalBytes = Math.round(totalGb * 1024 ** 3);
    const disks: SwasDisk[] = [
      {
        disk_id: `d-sys-${newId.slice(-5)}`,
        disk_name: "SystemDisk",
        disk_type: "system",
        category: plan.disk_type || "ESSD",
        size: plan.disk_size || 50,
        device: "/dev/vda",
        status: "In_use",
        creation_time: nowIso,
        remark: "",
      },
    ];
    if (dataDisk > 0) {
      disks.push({
        disk_id: `d-data-${newId.slice(-5)}`,
        disk_name: "DataDisk",
        disk_type: "data",
        category: plan.disk_type || "ESSD",
        size: dataDisk,
        device: "/dev/vdb",
        status: "In_use",
        creation_time: nowIso,
        remark: "",
      });
    }
    mockInstances.set(mockKey(account, newId), {
      detail: {
        instance_id: newId,
        instance_name: `swas-${newId.slice(-6)}`,
        region_id: account.region_id,
        status: "Running",
        business_status: "Normal",
        ddos_status: "Normal",
        disable_reason: "",
        charge_type: "PrePaid",
        plan_id: plan.plan_id,
        plan_type: plan.plan_type,
        public_ip: `47.243.88.${(Date.now() % 200) + 10}`,
        inner_ip: `172.26.9.${(Date.now() % 200) + 10}`,
        cpu: plan.core,
        memory_gb: plan.memory,
        disk_size_gb: plan.disk_size,
        disk_category: plan.disk_type,
        bandwidth_mbps: plan.bandwidth,
        flow_gb: totalGb,
        image_id: opts.imageId,
        image_name: img?.image_name || opts.imageId,
        image_type: img?.image_type || "system",
        image_version: "",
        os_type: (img?.platform || "Linux").toLowerCase(),
        creation_time: nowIso,
        expired_time: expIso,
        disks,
      },
      traffic: {
        instance_id: newId,
        used_bytes: 0,
        total_bytes: totalBytes,
        remaining_bytes: totalBytes,
        overflow_bytes: 0,
        used_gb: 0,
        total_gb: totalGb,
        remaining_gb: totalGb,
        overflow_gb: 0,
      },
      vncPassword: "",
    });
    return { instance_ids: [newId], request_id: `mock-create-${Date.now().toString(36)}` };
  }

  const params: Record<string, string> = {
    Action: "CreateInstances",
    RegionId: account.region_id,
    PlanId: opts.planId,
    ImageId: opts.imageId,
    Period: String(months),
    Amount: "1",
    ChargeType: "PrePaid",
    AutoRenew: opts.autoRenew ? "true" : "false",
  };
  if (opts.autoRenew) {
    const arPeriod = validPeriods.has(Math.trunc(opts.autoRenewPeriod ?? 1))
      ? Math.trunc(opts.autoRenewPeriod ?? 1)
      : 1;
    params["AutoRenewPeriod"] = String(arPeriod);
  }
  if (dataDisk > 0) params["DataDiskSize"] = String(dataDisk);
  if (opts.clientToken) params["ClientToken"] = opts.clientToken;

  let data: Record<string, unknown>;
  try {
    data = await swasCall<Record<string, unknown>>(account, params);
  } catch (exc) {
    throw new AliyunError(`开通轻量服务器失败：${briefError(exc)}`);
  }
  const ids = Array.isArray(data["InstanceIds"])
    ? data["InstanceIds"].map((x) => strOf(x)).filter(Boolean)
    : [];
  if (ids.length === 0) {
    throw new AliyunError("阿里云未返回新创建的轻量实例 ID");
  }
  return { instance_ids: ids, request_id: strOf(data["RequestId"]) };
}

// ---------------------------------------------------------------------------
// Runtime state + traffic sync (persisted to swas_servers)
// ---------------------------------------------------------------------------

export function toAccount(server: repo.SwasServerView): AliyunAccount {
  return {
    access_key_id: server.access_key_id,
    access_key_secret: server.access_key_secret ?? "",
    region_id: server.region_id,
    site: server.site || "china",
    instance_id: server.instance_id,
  };
}

/**
 * Fetch live instance info + traffic package for one SWAS server and persist
 * the snapshot to D1. Throws if the server does not exist or Aliyun fails.
 */
export async function refreshSwasServer(
  env: Env,
  swasId: number,
): Promise<SwasInstanceDetail> {
  const row = await repo.getSwasServer(env, swasId, true);
  if (!row) throw new AliyunError("轻量服务器不存在");
  if (!row.access_key_secret) throw new AliyunError("未配置 AccessKey Secret");
  const detail = await getInstanceDetail(env, toAccount(row));
  const traffic = detail.traffic;
  await repo.updateSwasRuntime(env, swasId, {
    status: detail.status,
    publicIp: detail.public_ip,
    innerIp: detail.inner_ip,
    planId: detail.plan_id,
    planType: detail.plan_type,
    cpu: detail.cpu,
    memoryGb: detail.memory_gb,
    diskSizeGb: detail.disk_size_gb,
    bandwidthMbps: detail.bandwidth_mbps,
    imageName: detail.image_name,
    osType: detail.os_type,
    expiredTime: detail.expired_time,
    businessStatus: detail.business_status,
    trafficUsedGb: traffic ? traffic.used_gb : undefined,
    trafficTotalGb: traffic ? traffic.total_gb : detail.flow_gb > 0 ? detail.flow_gb : undefined,
    trafficOverflowGb: traffic ? traffic.overflow_gb : undefined,
  });
  return detail;
}

/**
 * Best-effort read-only refresh for every registered SWAS server. Never
 * triggers power operations and never throws.
 */
export async function refreshAllSwasServers(env: Env): Promise<number> {
  const list = await repo.listSwasServers(env);
  let ok = 0;
  for (const item of list) {
    if (!item.secret_configured || !item.instance_id || !item.region_id) continue;
    try {
      await refreshSwasServer(env, item.id);
      ok++;
    } catch {
      // Read-only background sync: ignore transient errors per instance.
    }
  }
  return ok;
}

