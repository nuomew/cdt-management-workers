/**
 * Tencent Cloud EdgeOne (TEO) API v2022-09-01 client & orchestration layer.
 *
 * Supports both China Mainland (`teo.tencentcloudapi.com`) and International
 * (`teo.intl.tencentcloudapi.com`) endpoints, reusing `signTencentV3` and
 * Tencent Cloud credentials stored in `dns_accounts` (provider = 'tencent').
 *
 * Capabilities:
 * - Zones discovery (`DescribeZones`)
 * - Acceleration domains CRUD + enable/disable (`DescribeAccelerationDomains`,
 *   `CreateAccelerationDomain`, `ModifyAccelerationDomain`,
 *   `ModifyAccelerationDomainStatuses`, `DeleteAccelerationDomains`)
 * - Cache purge & URL prefetch + 7-day history (`CreatePurgeTask`,
 *   `DescribePurgeTasks`, `CreatePrefetchTask`, `DescribePrefetchTasks`)
 * - HTTPS certificate deployment (`ModifyHostsCertificate`) + automatic push
 *   whenever a bound managed SSL certificate renews
 * - L7 traffic, bandwidth, request count & response time analytics
 *   (`DescribeTimingL7AnalysisData`)
 */

import type { Env } from "./env";
import * as messages from "./messages";
import * as repo from "./repo";
import type { EdgeOneCertBindingRecord, EdgeOneSite } from "./repo";
import { signTencentV3 } from "./tencent_lighthouse";

const TEO_SERVICE = "teo";
const TEO_VERSION = "2022-09-01";
const HTTP_TIMEOUT_MS = 20_000;

export interface EdgeOneCreds {
  accountId: number;
  secretId: string;
  secretKey: string;
  label: string;
  site: EdgeOneSite;
}

export interface EdgeOneZone {
  zoneId: string;
  zoneName: string;
  area: string;
  type: string;
  status: string;
  activeStatus: string;
  paused: boolean;
  cnameStatus: string;
  cnameSpeedUp: string;
  planType: string;
  planStatus: string;
  createdOn: string;
  modifiedOn: string;
  nameServers: string[];
}

export interface EdgeOneCertInfo {
  certId: string;
  alias: string;
  type: string;
  expireTime: string;
  deployTime: string;
  signAlgo: string;
  commonName: string;
  status: string;
}

export interface EdgeOneDomain {
  zoneId: string;
  domainName: string;
  domainStatus: string;
  cname: string;
  identificationStatus: string;
  originType: string;
  origin: string;
  backupOrigin: string;
  hostHeader: string;
  originProtocol: "FOLLOW" | "HTTP" | "HTTPS";
  httpOriginPort: number;
  httpsOriginPort: number;
  ipv6Status: string;
  certMode: string;
  certificates: EdgeOneCertInfo[];
  createdOn: string;
  modifiedOn: string;
}

export interface EdgeOneDomainWriteInput {
  domainName: string;
  origin: string;
  originType?: string;
  backupOrigin?: string;
  hostHeader?: string;
  originProtocol?: "FOLLOW" | "HTTP" | "HTTPS";
  httpOriginPort?: number;
  httpsOriginPort?: number;
  ipv6Status?: "follow" | "on" | "off";
}

export interface EdgeOneTaskItem {
  jobId: string;
  status: string;
  target: string;
  type: string;
  createTime: string;
  updateTime: string;
}

export interface EdgeOneAnalyticsPoint {
  timestamp: number;
  flux: number;
  bandwidth: number;
  requests: number;
  avgResponseTime: number;
}

export interface EdgeOneAnalyticsResult {
  range: "24h" | "7d";
  interval: string;
  startTime: string;
  endTime: string;
  summary: {
    totalFluxBytes: number;
    peakBandwidthBps: number;
    totalRequests: number;
    avgResponseTimeMs: number;
  };
  series: EdgeOneAnalyticsPoint[];
}

export function normalizeSite(raw?: string): EdgeOneSite {
  return String(raw ?? "").trim().toLowerCase() === "intl" ? "intl" : "cn";
}

function teoHost(site: EdgeOneSite): string {
  return site === "intl" ? "teo.intl.tencentcloudapi.com" : "teo.tencentcloudapi.com";
}

function isDryRun(env: Env): boolean {
  return env.CDT_DRY_RUN === "1";
}

function asObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asArr<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function asStr(v: unknown, fallback = ""): string {
  if (v === null || v === undefined) return fallback;
  return String(v);
}

function asNum(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export async function resolveEdgeOneCreds(
  env: Env,
  accountId: number,
  site: EdgeOneSite,
): Promise<EdgeOneCreds> {
  const acct = await repo.getDnsAccount(env, accountId, true);
  if (!acct || acct.provider !== "tencent") {
    throw new Error("未找到有效的腾讯云账号，请先在「域名解析」中添加腾讯云账号");
  }
  if (!acct.cred_id || !acct.cred_secret) {
    throw new Error(`腾讯云账号「${acct.label}」缺少 SecretId / SecretKey`);
  }
  return {
    accountId: acct.id,
    secretId: acct.cred_id,
    secretKey: acct.cred_secret,
    label: acct.label,
    site: normalizeSite(site),
  };
}

async function teoRpc(
  creds: EdgeOneCreds,
  action: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const host = teoHost(creds.site);
  const payload = JSON.stringify(params);
  const signed = await signTencentV3({
    secretId: creds.secretId,
    secretKey: creds.secretKey,
    service: TEO_SERVICE,
    host,
    action,
    version: TEO_VERSION,
    payload,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`https://${host}/`, {
      method: "POST",
      headers: signed.headers,
      body: payload,
      signal: controller.signal,
    });
    const text = await res.text();
    let body: Record<string, unknown>;
    try {
      body = asObj(JSON.parse(text));
    } catch {
      throw new Error(`EdgeOne ${action} 响应非 JSON（HTTP ${res.status}）`);
    }
    const resp = asObj(body["Response"]);
    const errObj = asObj(resp["Error"]);
    if (errObj["Code"]) {
      const code = asStr(errObj["Code"]);
      const message = asStr(errObj["Message"]) || code;
      const e = new Error(`腾讯云 EdgeOne ${action} 失败 [${code}]：${message}`);
      (e as Error & { tcCode?: string }).tcCode = code;
      throw e;
    }
    if (!res.ok) {
      throw new Error(`腾讯云 EdgeOne ${action} HTTP ${res.status}`);
    }
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Dry-run in-memory EdgeOne state (used when CDT_DRY_RUN=1 for E2E verification)
// ---------------------------------------------------------------------------

interface DryZoneState {
  zone: EdgeOneZone;
  domains: Map<string, EdgeOneDomain>;
  purgeTasks: EdgeOneTaskItem[];
  prefetchTasks: EdgeOneTaskItem[];
}

const dryStore = new Map<string, Map<string, DryZoneState>>();
let dryJobSeq = 100;

function getDryBucket(creds: EdgeOneCreds): Map<string, DryZoneState> {
  const key = `${creds.accountId}:${creds.site}`;
  let bucket = dryStore.get(key);
  if (bucket) return bucket;

  bucket = new Map<string, DryZoneState>();
  const nowIso = new Date().toISOString();
  const zoneId = creds.site === "intl" ? "zone-dryintl001" : "zone-drycn0001";
  const zoneName = creds.site === "intl" ? "edge-global.demo" : "tencent-demo.cn";
  const domains = new Map<string, EdgeOneDomain>();
  domains.set(`cdn.${zoneName}`, {
    zoneId,
    domainName: `cdn.${zoneName}`,
    domainStatus: "online",
    cname: `cdn.${zoneName}.eo.dnse3.com`,
    identificationStatus: "finished",
    originType: "IP_DOMAIN",
    origin: "203.0.113.10",
    backupOrigin: "",
    hostHeader: `cdn.${zoneName}`,
    originProtocol: "FOLLOW",
    httpOriginPort: 80,
    httpsOriginPort: 443,
    ipv6Status: "follow",
    certMode: "eofreecert",
    certificates: [
      {
        certId: "eoFreeDry01",
        alias: "EdgeOne Free Cert",
        type: "default",
        expireTime: new Date(Date.now() + 75 * 86400_000).toISOString(),
        deployTime: nowIso,
        signAlgo: "RSA 2048",
        commonName: `cdn.${zoneName}`,
        status: "deployed",
      },
    ],
    createdOn: nowIso,
    modifiedOn: nowIso,
  });

  bucket.set(zoneId, {
    zone: {
      zoneId,
      zoneName,
      area: creds.site === "intl" ? "overseas" : "global",
      type: "partial",
      status: "active",
      activeStatus: "active",
      paused: false,
      cnameStatus: "finished",
      cnameSpeedUp: "enabled",
      planType: "personal",
      planStatus: "normal",
      createdOn: nowIso,
      modifiedOn: nowIso,
      nameServers: ["ns1.teodns.com", "ns2.teodns.com"],
    },
    domains,
    purgeTasks: [
      {
        jobId: "eoPurgeSeed01",
        status: "success",
        target: `https://cdn.${zoneName}/index.html`,
        type: "purge_url",
        createTime: nowIso,
        updateTime: nowIso,
      },
    ],
    prefetchTasks: [],
  });

  // Seed an unbound/no-domain plan zone in dry-run to verify filtering excludes it.
  const unboundZoneId = creds.site === "intl" ? "zone-dryintl-unbound" : "zone-drycn-unbound";
  bucket.set(unboundZoneId, {
    zone: {
      zoneId: unboundZoneId,
      zoneName: "",
      area: creds.site === "intl" ? "overseas" : "global",
      type: "noDomainAccess",
      status: "active",
      activeStatus: "active",
      paused: false,
      cnameStatus: "",
      cnameSpeedUp: "",
      planType: "free",
      planStatus: "normal",
      createdOn: nowIso,
      modifiedOn: nowIso,
      nameServers: [],
    },
    domains: new Map(),
    purgeTasks: [],
    prefetchTasks: [],
  });

  dryStore.set(key, bucket);
  return bucket;
}

// ---------------------------------------------------------------------------
// Zones & Acceleration Domains
// ---------------------------------------------------------------------------

const NON_DOMAIN_ZONE_TYPES = new Set([
  "nodomainaccess",
  "partialcomposite",
  "pages",
  "ai",
]);

/**
 * Exclude EdgeOne plans/sites that have no bound domain (empty ZoneName,
 * no-domain / Pages / AI access types, or deleted / uninitialized placeholders).
 */
export function hasBoundDomainZone(zone: EdgeOneZone): boolean {
  const name = zone.zoneName.trim().toLowerCase();
  const id = zone.zoneId.trim().toLowerCase();
  if (!name || !name.includes(".") || (id && name === id)) {
    return false;
  }
  const type = zone.type.trim().toLowerCase();
  if (NON_DOMAIN_ZONE_TYPES.has(type)) {
    return false;
  }
  const status = zone.status.trim().toLowerCase();
  const activeStatus = zone.activeStatus.trim().toLowerCase();
  if (status === "deleted" || status === "init" || activeStatus === "init") {
    return false;
  }
  return true;
}

export async function listZones(env: Env, creds: EdgeOneCreds): Promise<EdgeOneZone[]> {
  if (isDryRun(env)) {
    return [...getDryBucket(creds).values()]
      .map((z) => z.zone)
      .filter(hasBoundDomainZone);
  }

  const all: EdgeOneZone[] = [];
  let offset = 0;
  let fetched = 0;
  const limit = 100;
  for (let page = 0; page < 5; page += 1) {
    const resp = await teoRpc(creds, "DescribeZones", { Offset: offset, Limit: limit });
    const items = asArr<Record<string, unknown>>(resp["Zones"]);
    fetched += items.length;
    for (const z of items) {
      const resources = asArr<Record<string, unknown>>(z["Resources"]);
      const planRes = resources.find((r) => asStr(r["Group"]) === "plan") ?? resources[0];
      const zone: EdgeOneZone = {
        zoneId: asStr(z["ZoneId"]),
        zoneName: asStr(z["ZoneName"]).trim(),
        area: asStr(z["Area"], "global"),
        type: asStr(z["Type"], "partial"),
        status: asStr(z["Status"]),
        activeStatus: asStr(z["ActiveStatus"] || z["Status"]),
        paused: Boolean(z["Paused"]),
        cnameStatus: asStr(z["CnameStatus"]),
        cnameSpeedUp: asStr(z["CnameSpeedUp"]),
        planType: asStr(planRes?.["PlanId"] || planRes?.["Group"]),
        planStatus: asStr(planRes?.["Status"]),
        createdOn: asStr(z["CreatedOn"]),
        modifiedOn: asStr(z["ModifiedOn"]),
        nameServers: asArr<string>(z["NameServers"]).map((s) => asStr(s)),
      };
      if (hasBoundDomainZone(zone)) {
        all.push(zone);
      }
    }
    const total = asNum(resp["TotalCount"], fetched);
    if (items.length === 0 || fetched >= total) break;
    offset += limit;
  }
  return all;
}

function parseOriginProtocol(raw: unknown): "FOLLOW" | "HTTP" | "HTTPS" {
  const s = asStr(raw).toUpperCase();
  if (s === "HTTP" || s === "HTTPS") return s;
  return "FOLLOW";
}

export async function listAccelerationDomains(
  env: Env,
  creds: EdgeOneCreds,
  zoneId: string,
): Promise<EdgeOneDomain[]> {
  if (isDryRun(env)) {
    const z = getDryBucket(creds).get(zoneId);
    return z ? [...z.domains.values()] : [];
  }

  const all: EdgeOneDomain[] = [];
  let offset = 0;
  const limit = 200;
  for (let page = 0; page < 5; page += 1) {
    const resp = await teoRpc(creds, "DescribeAccelerationDomains", {
      ZoneId: zoneId,
      Offset: offset,
      Limit: limit,
      Order: "created_on",
      Direction: "desc",
    });
    const items = asArr<Record<string, unknown>>(resp["AccelerationDomains"]);
    for (const d of items) {
      const originDetail = asObj(d["OriginDetail"]);
      const certObj = asObj(d["Certificate"]);
      const certList = asArr<Record<string, unknown>>(certObj["List"]).map((c) => ({
        certId: asStr(c["CertId"]),
        alias: asStr(c["Alias"]),
        type: asStr(c["Type"]),
        expireTime: asStr(c["ExpireTime"]),
        deployTime: asStr(c["DeployTime"]),
        signAlgo: asStr(c["SignAlgo"]),
        commonName: asStr(c["CommonName"]),
        status: asStr(c["Status"]),
      }));
      all.push({
        zoneId: asStr(d["ZoneId"], zoneId),
        domainName: asStr(d["DomainName"]).toLowerCase(),
        domainStatus: asStr(d["DomainStatus"]),
        cname: asStr(d["Cname"]),
        identificationStatus: asStr(d["IdentificationStatus"]),
        originType: asStr(originDetail["OriginType"], "IP_DOMAIN"),
        origin: asStr(originDetail["Origin"]),
        backupOrigin: asStr(originDetail["BackupOrigin"]),
        hostHeader: asStr(originDetail["HostHeader"]),
        originProtocol: parseOriginProtocol(d["OriginProtocol"]),
        httpOriginPort: asNum(d["HttpOriginPort"], 80),
        httpsOriginPort: asNum(d["HttpsOriginPort"], 443),
        ipv6Status: asStr(d["IPv6Status"], "follow"),
        certMode: asStr(certObj["Mode"], "none"),
        certificates: certList,
        createdOn: asStr(d["CreatedOn"]),
        modifiedOn: asStr(d["ModifiedOn"]),
      });
    }
    const total = asNum(resp["TotalCount"], all.length);
    if (items.length === 0 || all.length >= total) break;
    offset += limit;
  }
  return all;
}

function buildOriginPayload(input: EdgeOneDomainWriteInput): Record<string, unknown> {
  const originInfo: Record<string, unknown> = {
    OriginType: (input.originType || "IP_DOMAIN").trim() || "IP_DOMAIN",
    Origin: input.origin.trim(),
  };
  if (input.backupOrigin?.trim()) {
    originInfo["BackupOrigin"] = input.backupOrigin.trim();
  }
  if (input.hostHeader?.trim()) {
    originInfo["HostHeader"] = input.hostHeader.trim();
  }
  return originInfo;
}

export async function createAccelerationDomain(
  env: Env,
  creds: EdgeOneCreds,
  zoneId: string,
  input: EdgeOneDomainWriteInput,
): Promise<{ ownershipVerification: Record<string, unknown> | null }> {
  const domainName = input.domainName.trim().toLowerCase();
  const originProtocol = parseOriginProtocol(input.originProtocol);
  const httpPort = Math.max(1, Math.min(65535, Math.trunc(input.httpOriginPort ?? 80)));
  const httpsPort = Math.max(1, Math.min(65535, Math.trunc(input.httpsOriginPort ?? 443)));
  const ipv6Status =
    input.ipv6Status === "on" || input.ipv6Status === "off" ? input.ipv6Status : "follow";

  if (isDryRun(env)) {
    const z = getDryBucket(creds).get(zoneId);
    if (!z) throw new Error(`站点 ${zoneId} 不存在`);
    if (z.domains.has(domainName)) {
      throw new Error(`加速域名 ${domainName} 已存在`);
    }
    const nowIso = new Date().toISOString();
    const simulateExpiring = domainName.startsWith("expiring.");
    const simulateExpiringFree = domainName.startsWith("expfree.");
    z.domains.set(domainName, {
      zoneId,
      domainName,
      domainStatus: "online",
      cname: `${domainName}.eo.dnse3.com`,
      identificationStatus: "finished",
      originType: input.originType || "IP_DOMAIN",
      origin: input.origin.trim(),
      backupOrigin: (input.backupOrigin ?? "").trim(),
      hostHeader: (input.hostHeader ?? "").trim() || domainName,
      originProtocol,
      httpOriginPort: httpPort,
      httpsOriginPort: httpsPort,
      ipv6Status,
      certMode: simulateExpiring
        ? "sslcert"
        : simulateExpiringFree
          ? "eofreecert"
          : "none",
      certificates:
        simulateExpiring || simulateExpiringFree
          ? [
              {
                certId: simulateExpiring ? `eoExpOld_${domainName.slice(0, 12)}` : "eoFreeExp01",
                alias: simulateExpiring ? "Expiring External Cert" : "Expiring EdgeOne Free Cert",
                type: simulateExpiring ? "managed" : "default",
                expireTime: new Date(Date.now() + 3 * 86400_000).toISOString(),
                deployTime: new Date(Date.now() - 86 * 86400_000).toISOString(),
                signAlgo: "RSA 2048",
                commonName: domainName,
                status: "deployed",
              },
            ]
          : [],
      createdOn: nowIso,
      modifiedOn: nowIso,
    });
    return { ownershipVerification: null };
  }

  const params: Record<string, unknown> = {
    ZoneId: zoneId,
    DomainName: domainName,
    OriginInfo: buildOriginPayload(input),
    OriginProtocol: originProtocol,
    IPv6Status: ipv6Status,
  };
  if (originProtocol === "FOLLOW" || originProtocol === "HTTP") {
    params["HttpOriginPort"] = httpPort;
  }
  if (originProtocol === "FOLLOW" || originProtocol === "HTTPS") {
    params["HttpsOriginPort"] = httpsPort;
  }

  const resp = await teoRpc(creds, "CreateAccelerationDomain", params);
  const ov = resp["OwnershipVerification"];
  return {
    ownershipVerification:
      ov && typeof ov === "object" && !Array.isArray(ov)
        ? (ov as Record<string, unknown>)
        : null,
  };
}

export async function modifyAccelerationDomain(
  env: Env,
  creds: EdgeOneCreds,
  zoneId: string,
  input: EdgeOneDomainWriteInput,
): Promise<void> {
  const domainName = input.domainName.trim().toLowerCase();
  const originProtocol = parseOriginProtocol(input.originProtocol);
  const httpPort = Math.max(1, Math.min(65535, Math.trunc(input.httpOriginPort ?? 80)));
  const httpsPort = Math.max(1, Math.min(65535, Math.trunc(input.httpsOriginPort ?? 443)));
  const ipv6Status =
    input.ipv6Status === "on" || input.ipv6Status === "off" ? input.ipv6Status : "follow";

  if (isDryRun(env)) {
    const z = getDryBucket(creds).get(zoneId);
    const existing = z?.domains.get(domainName);
    if (!existing) throw new Error(`加速域名 ${domainName} 不存在`);
    existing.originType = input.originType || existing.originType || "IP_DOMAIN";
    existing.origin = input.origin.trim();
    existing.backupOrigin = (input.backupOrigin ?? "").trim();
    existing.hostHeader = (input.hostHeader ?? "").trim();
    existing.originProtocol = originProtocol;
    existing.httpOriginPort = httpPort;
    existing.httpsOriginPort = httpsPort;
    existing.ipv6Status = ipv6Status;
    existing.modifiedOn = new Date().toISOString();
    return;
  }

  const params: Record<string, unknown> = {
    ZoneId: zoneId,
    DomainName: domainName,
    OriginInfo: buildOriginPayload(input),
    OriginProtocol: originProtocol,
    IPv6Status: ipv6Status,
  };
  if (originProtocol === "FOLLOW" || originProtocol === "HTTP") {
    params["HttpOriginPort"] = httpPort;
  }
  if (originProtocol === "FOLLOW" || originProtocol === "HTTPS") {
    params["HttpsOriginPort"] = httpsPort;
  }

  await teoRpc(creds, "ModifyAccelerationDomain", params);
}

export async function setAccelerationDomainStatus(
  env: Env,
  creds: EdgeOneCreds,
  zoneId: string,
  domainName: string,
  status: "online" | "offline",
): Promise<void> {
  const host = domainName.trim().toLowerCase();
  if (isDryRun(env)) {
    const z = getDryBucket(creds).get(zoneId);
    const existing = z?.domains.get(host);
    if (!existing) throw new Error(`加速域名 ${host} 不存在`);
    existing.domainStatus = status;
    existing.modifiedOn = new Date().toISOString();
    return;
  }
  await teoRpc(creds, "ModifyAccelerationDomainStatuses", {
    ZoneId: zoneId,
    DomainNames: [host],
    Status: status,
    Force: false,
  });
}

export async function deleteAccelerationDomain(
  env: Env,
  creds: EdgeOneCreds,
  zoneId: string,
  domainName: string,
  force = true,
): Promise<void> {
  const host = domainName.trim().toLowerCase();
  if (isDryRun(env)) {
    const z = getDryBucket(creds).get(zoneId);
    if (!z || !z.domains.delete(host)) {
      throw new Error(`加速域名 ${host} 不存在`);
    }
    return;
  }
  await teoRpc(creds, "DeleteAccelerationDomains", {
    ZoneId: zoneId,
    DomainNames: [host],
    Force: force,
  });
}

// ---------------------------------------------------------------------------
// Cache Purge & URL Prefetch
// ---------------------------------------------------------------------------

export type PurgeType = "purge_url" | "purge_prefix" | "purge_host" | "purge_all";
export type PurgeMethod = "invalidate" | "delete";

export async function createPurgeTask(
  env: Env,
  creds: EdgeOneCreds,
  zoneId: string,
  opts: { type: PurgeType; method?: PurgeMethod; targets?: string[] },
): Promise<{ jobId: string; failedList: { target: string; message: string }[] }> {
  const targets = (opts.targets ?? []).map((s) => s.trim()).filter(Boolean);
  const method: PurgeMethod = opts.method === "delete" ? "delete" : "invalidate";

  if (opts.type !== "purge_all" && targets.length === 0) {
    throw new Error("请输入至少一条刷新目标");
  }

  if (isDryRun(env)) {
    const z = getDryBucket(creds).get(zoneId);
    if (!z) throw new Error(`站点 ${zoneId} 不存在`);
    dryJobSeq += 1;
    const jobId = `eoPurgeDry${dryJobSeq}`;
    const nowIso = new Date().toISOString();
    const list = opts.type === "purge_all" ? [z.zone.zoneName] : targets;
    for (const target of list) {
      z.purgeTasks.unshift({
        jobId,
        status: "success",
        target,
        type: opts.type,
        createTime: nowIso,
        updateTime: nowIso,
      });
    }
    return { jobId, failedList: [] };
  }

  const params: Record<string, unknown> = {
    ZoneId: zoneId,
    Type: opts.type,
  };
  if (opts.type !== "purge_all") {
    params["Targets"] = targets;
  }
  if (opts.type === "purge_prefix" || opts.type === "purge_host" || opts.type === "purge_all") {
    params["Method"] = method;
  }
  const resp = await teoRpc(creds, "CreatePurgeTask", params);
  const failedList = asArr<Record<string, unknown>>(resp["FailedList"]).map((f) => ({
    target: asStr(f["Target"]),
    message: asStr(f["Message"]),
  }));
  return {
    jobId: asStr(resp["JobId"]),
    failedList,
  };
}

export async function createPrefetchTask(
  env: Env,
  creds: EdgeOneCreds,
  zoneId: string,
  targetsRaw: string[],
): Promise<{ jobId: string; failedList: { target: string; message: string }[] }> {
  const targets = targetsRaw.map((s) => s.trim()).filter(Boolean);
  if (targets.length === 0) {
    throw new Error("请输入至少一条需要预热的 URL");
  }

  if (isDryRun(env)) {
    const z = getDryBucket(creds).get(zoneId);
    if (!z) throw new Error(`站点 ${zoneId} 不存在`);
    dryJobSeq += 1;
    const jobId = `eoPrefetchDry${dryJobSeq}`;
    const nowIso = new Date().toISOString();
    for (const target of targets) {
      z.prefetchTasks.unshift({
        jobId,
        status: "success",
        target,
        type: "prefetch_url",
        createTime: nowIso,
        updateTime: nowIso,
      });
    }
    return { jobId, failedList: [] };
  }

  const resp = await teoRpc(creds, "CreatePrefetchTask", {
    ZoneId: zoneId,
    Targets: targets,
    EncodeUrl: true,
  });
  const failedList = asArr<Record<string, unknown>>(resp["FailedList"]).map((f) => ({
    target: asStr(f["Target"]),
    message: asStr(f["Message"]),
  }));
  return {
    jobId: asStr(resp["JobId"]),
    failedList,
  };
}

export async function listCacheTasks(
  env: Env,
  creds: EdgeOneCreds,
  zoneId: string,
  kind: "purge" | "prefetch",
  limit = 50,
): Promise<{ total: number; items: EdgeOneTaskItem[] }> {
  if (isDryRun(env)) {
    const z = getDryBucket(creds).get(zoneId);
    const arr = z ? (kind === "prefetch" ? z.prefetchTasks : z.purgeTasks) : [];
    return { total: arr.length, items: arr.slice(0, limit) };
  }

  // EdgeOne restricts DescribePurgeTasks / DescribePrefetchTasks window to <= 7 days.
  const endMs = Date.now();
  const startMs = endMs - 6 * 86400_000;
  const action = kind === "prefetch" ? "DescribePrefetchTasks" : "DescribePurgeTasks";
  const resp = await teoRpc(creds, action, {
    ZoneId: zoneId,
    StartTime: new Date(startMs).toISOString(),
    EndTime: new Date(endMs).toISOString(),
    Offset: 0,
    Limit: Math.max(1, Math.min(200, limit)),
  });
  const tasks = asArr<Record<string, unknown>>(resp["Tasks"]).map((t) => ({
    jobId: asStr(t["JobId"]),
    status: asStr(t["Status"]),
    target: asStr(t["Target"]),
    type: asStr(t["Type"], kind === "prefetch" ? "prefetch_url" : "purge_url"),
    createTime: asStr(t["CreateTime"]),
    updateTime: asStr(t["UpdateTime"]),
  }));
  return {
    total: asNum(resp["TotalCount"], tasks.length),
    items: tasks,
  };
}

// ---------------------------------------------------------------------------
// HTTPS Certificate Deployment & Automatic SSL Renewal Sync
// ---------------------------------------------------------------------------

export type EdgeOneCertMode = "sslcert" | "eofreecert" | "none";

export async function modifyHostsCertificate(
  env: Env,
  creds: EdgeOneCreds,
  zoneId: string,
  hosts: string[],
  mode: EdgeOneCertMode,
  certId?: string,
): Promise<void> {
  const cleanHosts = hosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (cleanHosts.length === 0) throw new Error("请指定要配置证书的加速域名");
  if (mode === "sslcert" && !certId?.trim()) {
    throw new Error("部署托管 SSL 证书时必须提供腾讯云证书 ID");
  }

  if (isDryRun(env)) {
    const z = getDryBucket(creds).get(zoneId);
    if (!z) throw new Error(`站点 ${zoneId} 不存在`);
    const nowIso = new Date().toISOString();
    for (const h of cleanHosts) {
      const dom = z.domains.get(h);
      if (!dom) throw new Error(`加速域名 ${h} 不存在`);
      dom.certMode = mode;
      if (mode === "sslcert") {
        dom.certificates = [
          {
            certId: certId!.trim(),
            alias: `Managed SSL ${certId!.trim()}`,
            type: "managed",
            expireTime: new Date(Date.now() + 89 * 86400_000).toISOString(),
            deployTime: nowIso,
            signAlgo: "RSA 2048",
            commonName: h,
            status: "deployed",
          },
        ];
      } else if (mode === "eofreecert") {
        dom.certificates = [
          {
            certId: "eoFreeDry01",
            alias: "EdgeOne Free Cert",
            type: "default",
            expireTime: new Date(Date.now() + 89 * 86400_000).toISOString(),
            deployTime: nowIso,
            signAlgo: "RSA 2048",
            commonName: h,
            status: "deployed",
          },
        ];
      } else {
        dom.certificates = [];
      }
      dom.modifiedOn = nowIso;
    }
    return;
  }

  const params: Record<string, unknown> = {
    ZoneId: zoneId,
    Hosts: cleanHosts,
    Mode: mode,
  };
  if (mode === "sslcert") {
    params["ServerCertInfo"] = [{ CertId: certId!.trim() }];
  }
  await teoRpc(creds, "ModifyHostsCertificate", params);
}

/**
 * Invoked automatically from `src/tencent_ssl.ts` whenever a managed SSL
 * certificate is issued or renewed. Pushes the fresh `certId` to every bound
 * EdgeOne acceleration domain and records deployment status & audit events.
 */
export async function syncRenewedCertificateToEdgeOne(
  env: Env,
  sslCertId: number,
  newCertId: string,
): Promise<{ synced: number; failed: number; notes: string[] }> {
  const bindings = await repo.listEdgeOneBindingsBySslCert(env, sslCertId);
  if (bindings.length === 0) return { synced: 0, failed: 0, notes: [] };

  let synced = 0;
  let failed = 0;
  const notes: string[] = [];
  const now = nowSeconds();

  for (const binding of bindings) {
    try {
      const creds = await resolveEdgeOneCreds(env, binding.tencent_account_id, binding.site);
      await modifyHostsCertificate(
        env,
        creds,
        binding.zone_id,
        [binding.domain],
        "sslcert",
        newCertId,
      );
      await repo.updateEdgeOneCertBindingStatus(env, binding.id, {
        last_deployed_cert_id: newCertId,
        last_deployed_at: now,
        last_error: "",
      });
      synced += 1;
      notes.push(`EdgeOne ${binding.domain} 已同步新证书 ${newCertId}`);
      await repo.addEvent(
        env,
        "ssl",
        messages.ev("EdgeOne 证书自动同步成功", messages.objServer(binding.domain)),
        {
          detail: `证书续签后已自动部署至腾讯云 EdgeOne（站点 ${binding.zone_name || binding.zone_id}，证书 ID: ${newCertId}）`,
        },
      );
    } catch (err) {
      failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      await repo.updateEdgeOneCertBindingStatus(env, binding.id, {
        last_error: msg,
      });
      notes.push(`EdgeOne ${binding.domain} 同步失败：${msg}`);
      await repo.addEvent(
        env,
        "ssl",
        messages.ev("EdgeOne 证书自动同步失败", messages.objServer(binding.domain)),
        {
          level: "error",
          detail: `证书 ${newCertId} 部署至 EdgeOne 失败：${msg}`,
        },
      );
    }
  }
  return { synced, failed, notes };
}

export async function deployBindingNow(
  env: Env,
  binding: EdgeOneCertBindingRecord,
  certId: string,
): Promise<void> {
  const creds = await resolveEdgeOneCreds(env, binding.tencent_account_id, binding.site);
  await modifyHostsCertificate(env, creds, binding.zone_id, [binding.domain], "sslcert", certId);
  await repo.updateEdgeOneCertBindingStatus(env, binding.id, {
    last_deployed_cert_id: certId,
    last_deployed_at: nowSeconds(),
    last_error: "",
  });
}

// ---------------------------------------------------------------------------
// L7 Analytics (Traffic, Bandwidth, Requests, Average Response Time)
// ---------------------------------------------------------------------------

export async function getZoneAnalytics(
  env: Env,
  creds: EdgeOneCreds,
  zoneId: string,
  range: "24h" | "7d",
  domainFilter?: string,
): Promise<EdgeOneAnalyticsResult> {
  // EdgeOne analytics has ~10 min reporting delay; end at now - 5 min for stable buckets.
  const endSec = Math.floor((Date.now() - 5 * 60_000) / 1000);
  const spanSec = range === "7d" ? 7 * 86400 : 24 * 3600;
  const startSec = endSec - spanSec;
  const interval = range === "7d" ? "hour" : "hour";
  const startTime = new Date(startSec * 1000).toISOString();
  const endTime = new Date(endSec * 1000).toISOString();

  if (isDryRun(env)) {
    const count = range === "7d" ? 28 : 24;
    const step = Math.floor(spanSec / count);
    const series: EdgeOneAnalyticsPoint[] = [];
    let totalFluxBytes = 0;
    let peakBandwidthBps = 0;
    let totalRequests = 0;
    let rtSum = 0;
    for (let i = 0; i < count; i += 1) {
      const ts = startSec + i * step;
      const wave = 0.65 + 0.35 * Math.sin((i / count) * Math.PI * 2.5);
      const flux = Math.round(180_000_000 * wave);
      const bandwidth = Math.round(14_500_000 * wave);
      const requests = Math.round(4200 * wave);
      const avgResponseTime = Math.round(42 + 16 * (1 - wave));
      totalFluxBytes += flux;
      if (bandwidth > peakBandwidthBps) peakBandwidthBps = bandwidth;
      totalRequests += requests;
      rtSum += avgResponseTime;
      series.push({ timestamp: ts, flux, bandwidth, requests, avgResponseTime });
    }
    return {
      range,
      interval,
      startTime,
      endTime,
      summary: {
        totalFluxBytes,
        peakBandwidthBps,
        totalRequests,
        avgResponseTimeMs: series.length ? Math.round(rtSum / series.length) : 0,
      },
      series,
    };
  }

  const params: Record<string, unknown> = {
    StartTime: startTime,
    EndTime: endTime,
    ZoneIds: [zoneId],
    Interval: interval,
    MetricNames: [
      "l7Flow_flux",
      "l7Flow_outBandwidth",
      "l7Flow_request",
      "l7Flow_avgResponseTime",
    ],
  };
  if (domainFilter?.trim()) {
    params["Filters"] = [
      {
        Key: "domain",
        Operator: "equals",
        Value: [domainFilter.trim().toLowerCase()],
      },
    ];
  }

  const resp = await teoRpc(creds, "DescribeTimingL7AnalysisData", params);
  const byTs = new Map<number, EdgeOneAnalyticsPoint>();
  let totalFluxBytes = 0;
  let peakBandwidthBps = 0;
  let totalRequests = 0;
  let avgRtAcc = 0;
  let avgRtCnt = 0;

  for (const record of asArr<Record<string, unknown>>(resp["Data"])) {
    for (const tv of asArr<Record<string, unknown>>(record["TypeValue"])) {
      const metric = asStr(tv["MetricName"]);
      const sum = asNum(tv["Sum"], 0);
      const max = asNum(tv["Max"], 0);
      const avg = asNum(tv["Avg"], 0);

      if (metric === "l7Flow_flux") totalFluxBytes += sum;
      if (metric === "l7Flow_outBandwidth" && max > peakBandwidthBps) peakBandwidthBps = max;
      if (metric === "l7Flow_request") totalRequests += sum;
      if (metric === "l7Flow_avgResponseTime" && avg > 0) {
        avgRtAcc += avg;
        avgRtCnt += 1;
      }

      for (const pt of asArr<Record<string, unknown>>(tv["Detail"])) {
        const ts = asNum(pt["Timestamp"], 0);
        const val = asNum(pt["Value"], 0);
        if (!ts) continue;
        let cur = byTs.get(ts);
        if (!cur) {
          cur = { timestamp: ts, flux: 0, bandwidth: 0, requests: 0, avgResponseTime: 0 };
          byTs.set(ts, cur);
        }
        if (metric === "l7Flow_flux") cur.flux += val;
        else if (metric === "l7Flow_outBandwidth") cur.bandwidth = Math.max(cur.bandwidth, val);
        else if (metric === "l7Flow_request") cur.requests += val;
        else if (metric === "l7Flow_avgResponseTime") cur.avgResponseTime = val;
      }
    }
  }

  const series = [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
  return {
    range,
    interval,
    startTime,
    endTime,
    summary: {
      totalFluxBytes,
      peakBandwidthBps,
      totalRequests,
      avgResponseTimeMs: avgRtCnt > 0 ? Math.round(avgRtAcc / avgRtCnt) : 0,
    },
    series,
  };
}

// ---------------------------------------------------------------------------
// Auto-Certificate Policy & Watched Scope Persistence (stored in `settings`)
// ---------------------------------------------------------------------------

const AUTO_CERT_ENABLED_KEY = "edgeone_auto_cert_enabled";
const AUTO_CERT_DAYS_KEY = "edgeone_auto_cert_days";
const WATCHED_SCOPES_KEY = "edgeone_watched_scopes";

export interface EdgeOneAutoCertConfig {
  enabled: boolean;
  days: number;
}

export interface EdgeOneWatchedScope {
  accountId: number;
  site: EdgeOneSite;
}

/**
 * Read EdgeOne automatic expiring-certificate replacement/application policy.
 * Enabled by default with a 7-day threshold so expiring CDN hosts are protected
 * out of the box without manual setup.
 */
export async function getEdgeOneAutoCertConfig(env: Env): Promise<EdgeOneAutoCertConfig> {
  const settings = await repo.getSettings(env);
  const enabled = (settings[AUTO_CERT_ENABLED_KEY] ?? "1") !== "0";
  const rawDays = Number(settings[AUTO_CERT_DAYS_KEY] ?? "7");
  const days = Number.isFinite(rawDays)
    ? Math.max(1, Math.min(30, Math.trunc(rawDays)))
    : 7;
  return { enabled, days };
}

export async function setEdgeOneAutoCertConfig(
  env: Env,
  input: Partial<EdgeOneAutoCertConfig>,
): Promise<EdgeOneAutoCertConfig> {
  const current = await getEdgeOneAutoCertConfig(env);
  const next: EdgeOneAutoCertConfig = {
    enabled: input.enabled !== undefined ? Boolean(input.enabled) : current.enabled,
    days:
      input.days !== undefined
        ? Math.max(1, Math.min(30, Math.trunc(Number(input.days) || 7)))
        : current.days,
  };
  await repo.setSettings(env, {
    [AUTO_CERT_ENABLED_KEY]: next.enabled ? "1" : "0",
    [AUTO_CERT_DAYS_KEY]: String(next.days),
  });
  return next;
}

export async function listWatchedEdgeOneScopes(env: Env): Promise<EdgeOneWatchedScope[]> {
  const raw = await repo.getSetting(env, WATCHED_SCOPES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: EdgeOneWatchedScope[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const accountId = Math.trunc(Number((item as Record<string, unknown>)["accountId"] ?? (item as Record<string, unknown>)["account_id"] ?? 0));
      if (!Number.isFinite(accountId) || accountId <= 0) continue;
      const site = normalizeSite(String((item as Record<string, unknown>)["site"] ?? "cn"));
      const key = `${accountId}:${site}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ accountId, site });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Remember an active `(accountId, site)` pair that successfully returned
 * EdgeOne zones so Cron knows which Tencent site (`cn` vs `intl`) to audit.
 */
export async function recordWatchedEdgeOneScope(
  env: Env,
  accountId: number,
  site: EdgeOneSite,
): Promise<void> {
  if (!Number.isFinite(accountId) || accountId <= 0) return;
  const cleanSite = normalizeSite(site);
  const current = await listWatchedEdgeOneScopes(env);
  if (current.some((s) => s.accountId === accountId && s.site === cleanSite)) {
    return;
  }
  const next = [...current, { accountId, site: cleanSite }].slice(-32);
  await repo.setSettings(env, {
    [WATCHED_SCOPES_KEY]: JSON.stringify(next),
  });
}

