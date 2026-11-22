/**
 * Unified Cloud DNS provider client supporting:
 * - Tencent Cloud DNSPod (dnspod.tencentcloudapi.com, Version 2021-03-23, TC3-HMAC-SHA256)
 * - Cloudflare DNS API v4 (https://api.cloudflare.com/client/v4, API Token & Global API Key)
 *
 * Also exposes idempotent domain-validation record helpers (`upsertValidationRecord`
 * and `deleteValidationRecord`) consumed by the Tencent Cloud SSL certificate service.
 */

import type { Env } from "./env";
import type { DnsAccountProvider, DnsAccountRecord } from "./repo";
import { signTencentV3 } from "./tencent_lighthouse";

const DNSPOD_HOST = "dnspod.tencentcloudapi.com";
const DNSPOD_SERVICE = "dnspod";
const DNSPOD_VERSION = "2021-03-23";
const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const HTTP_TIMEOUT_MS = 15_000;

export const ALLOWED_DNS_RECORD_TYPES = [
  "A",
  "AAAA",
  "CNAME",
  "TXT",
  "MX",
  "NS",
  "SRV",
  "CAA",
] as const;

export const DNSPOD_LINES = [
  "默认",
  "电信",
  "联通",
  "移动",
  "教育网",
  "境外",
  "搜索引擎",
] as const;

export interface CloudDnsDomain {
  id: string;
  name: string;
  status: string;
  record_count: number;
  ttl: number;
  plan: string;
  name_servers: string[];
  updated_on: string;
  provider: DnsAccountProvider;
}

export interface CloudDnsRecord {
  id: string;
  domain: string;
  zone_id: string;
  /** Relative host record: `@` for apex, `www` for `www.example.com`. */
  name: string;
  /** Full FQDN without trailing dot, e.g. `www.example.com` or `example.com`. */
  full_name: string;
  type: string;
  value: string;
  ttl: number;
  line: string;
  mx?: number;
  proxied?: boolean;
  enabled: boolean;
  remark: string;
  updated_on: string;
  provider: DnsAccountProvider;
}

export interface CloudDnsRecordInput {
  name: string;
  type: string;
  value: string;
  ttl?: number;
  line?: string;
  mx?: number;
  proxied?: boolean;
  enabled?: boolean;
  remark?: string;
}

export interface ValidationRecordSpec {
  /** Target certificate domain (e.g. `api.example.com` or `example.com`). */
  domain: string;
  /** Optional known root domain hosted on this DNS account. */
  rootDomain?: string;
  /** Optional known provider zone/domain ID. */
  zoneId?: string;
  /** Relative host prefix from CA (e.g. `_dnsauth` or `_dnsauth.api`). */
  subDomain?: string;
  /** Optional full validation host from CA (e.g. `_dnsauth.api.example.com`). */
  fullHost?: string;
  /** Validation record type (`TXT` or `CNAME`). */
  type: "TXT" | "CNAME";
  /** Validation record value. */
  value: string;
}

export interface ValidationRecordResult {
  rootDomain: string;
  zoneId: string;
  recordId: string;
  hostName: string;
  fullHost: string;
  type: "TXT" | "CNAME";
  value: string;
  action: "created" | "updated" | "unchanged";
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

function cleanHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.+$/, "");
}

/**
 * Convert user/CA host input to relative host (`@` for apex, `sub` for `sub.domain`).
 */
export function toRelativeHost(rawHost: string, rootDomain: string): string {
  const root = cleanHost(rootDomain);
  let host = cleanHost(rawHost);
  if (!host || host === "@" || host === root) return "@";
  const suffix = `.${root}`;
  if (host.endsWith(suffix)) {
    host = host.slice(0, -suffix.length);
  }
  return host || "@";
}

/**
 * Convert relative host or FQDN into a clean FQDN for a given root domain.
 */
export function toFqdn(rawHost: string, rootDomain: string): string {
  const root = cleanHost(rootDomain);
  const rel = toRelativeHost(rawHost, root);
  return rel === "@" ? root : `${rel}.${root}`;
}

function isCfProxiable(recordType: string): boolean {
  const upper = recordType.toUpperCase();
  return upper === "A" || upper === "AAAA" || upper === "CNAME";
}

// ---------------------------------------------------------------------------
// Dry-run in-memory mock state (isolated by account ID for deterministic E2E)
// ---------------------------------------------------------------------------

interface DryAccountStore {
  domains: CloudDnsDomain[];
  records: Map<string, CloudDnsRecord[]>;
  nextId: number;
}

const dryStore = new Map<string, DryAccountStore>();

function getDryStore(account: DnsAccountRecord): DryAccountStore {
  const key = `${account.provider}:${account.id}`;
  let store = dryStore.get(key);
  if (!store) {
    const sampleDomain =
      account.provider === "tencent" ? "tencent-demo.cn" : "cf-demo.dev";
    const zoneId =
      account.provider === "tencent" ? "88001001" : "cf_zone_demo_001";
    const domains: CloudDnsDomain[] = [
      {
        id: zoneId,
        name: sampleDomain,
        status: "active",
        record_count: 2,
        ttl: 600,
        plan: account.provider === "tencent" ? "免费版" : "Free",
        name_servers:
          account.provider === "tencent"
            ? ["ns1.dnspod.net", "ns2.dnspod.net"]
            : ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
        updated_on: "2026-11-22 10:00:00",
        provider: account.provider,
      },
    ];
    const records = new Map<string, CloudDnsRecord[]>();
    records.set(sampleDomain, [
      {
        id: "1001",
        domain: sampleDomain,
        zone_id: zoneId,
        name: "@",
        full_name: sampleDomain,
        type: "A",
        value: "1.2.3.4",
        ttl: account.provider === "tencent" ? 600 : 1,
        line: account.provider === "tencent" ? "默认" : "",
        proxied: account.provider === "cloudflare" ? true : undefined,
        enabled: true,
        remark: "demo apex",
        updated_on: "2026-11-22 10:00:00",
        provider: account.provider,
      },
      {
        id: "1002",
        domain: sampleDomain,
        zone_id: zoneId,
        name: "www",
        full_name: `www.${sampleDomain}`,
        type: "CNAME",
        value: sampleDomain,
        ttl: account.provider === "tencent" ? 600 : 1,
        line: account.provider === "tencent" ? "默认" : "",
        proxied: account.provider === "cloudflare" ? false : undefined,
        enabled: true,
        remark: "",
        updated_on: "2026-11-22 10:00:00",
        provider: account.provider,
      },
    ]);
    store = { domains, records, nextId: 2000 };
    dryStore.set(key, store);
  }
  return store;
}

// ---------------------------------------------------------------------------
// Low-level Tencent Cloud DNSPod v3 RPC
// ---------------------------------------------------------------------------

async function dnspodRpc(
  account: DnsAccountRecord,
  action: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const secretId = account.cred_id.trim();
  const secretKey = (account.cred_secret ?? "").trim();
  if (!secretId || !secretKey) {
    throw new Error("腾讯云 DNS 账号缺少 SecretId 或 SecretKey");
  }
  const payload = JSON.stringify(params);
  const signed = await signTencentV3({
    secretId,
    secretKey,
    service: DNSPOD_SERVICE,
    host: DNSPOD_HOST,
    action,
    version: DNSPOD_VERSION,
    payload,
  });

  const resp = await fetch(`https://${DNSPOD_HOST}`, {
    method: "POST",
    headers: signed.headers,
    body: payload,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await resp.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = asObj(JSON.parse(text));
  } catch {
    throw new Error(`腾讯云 DNSPod 接口返回非 JSON（HTTP ${resp.status}）`);
  }
  const body = asObj(parsed["Response"]);
  const err = asObj(body["Error"]);
  if (err["Code"]) {
    const code = asStr(err["Code"]);
    const msg = asStr(err["Message"] || code);
    const wrapped = new Error(`DNSPod ${action} 失败（${code}）：${msg}`);
    (wrapped as Error & { tcCode?: string }).tcCode = code;
    throw wrapped;
  }
  if (!resp.ok) {
    throw new Error(`腾讯云 DNSPod HTTP ${resp.status}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Low-level Cloudflare API v4
// ---------------------------------------------------------------------------

function cfHeaders(account: DnsAccountRecord): Record<string, string> {
  const secret = (account.cred_secret ?? "").trim();
  if (!secret) {
    throw new Error("Cloudflare 账号缺少 API Token / Global API Key");
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (account.auth_mode === "global_key") {
    const email = account.cred_id.trim();
    if (!email) throw new Error("Cloudflare Global API Key 模式需要填写登录邮箱");
    headers["X-Auth-Email"] = email;
    headers["X-Auth-Key"] = secret;
  } else {
    headers["Authorization"] = `Bearer ${secret}`;
  }
  return headers;
}

async function cfRequest(
  account: DnsAccountRecord,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const resp = await fetch(`${CF_API_BASE}${path}`, {
    method,
    headers: cfHeaders(account),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await resp.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = asObj(JSON.parse(text));
  } catch {
    throw new Error(`Cloudflare API 返回非 JSON（HTTP ${resp.status}）`);
  }
  if (!resp.ok || parsed["success"] === false) {
    const errors = asArr<Record<string, unknown>>(parsed["errors"]);
    const detail = errors
      .map((e) => {
        const c = asStr(e["code"]);
        const m = asStr(e["message"]);
        return c ? `[${c}] ${m}` : m;
      })
      .filter(Boolean)
      .join("；");
    throw new Error(`Cloudflare API 错误（HTTP ${resp.status}）：${detail || "请求失败"}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Public unified DNS operations
// ---------------------------------------------------------------------------

export async function testDnsAccount(
  env: Env,
  account: DnsAccountRecord,
): Promise<{ ok: boolean; domainCount: number; message: string }> {
  const domains = await listDomains(env, account);
  return {
    ok: true,
    domainCount: domains.length,
    message:
      account.provider === "tencent"
        ? `腾讯云 DNSPod 连接成功，读取到 ${domains.length} 个域名`
        : `Cloudflare 连接成功，读取到 ${domains.length} 个域名`,
  };
}

export async function listDomains(
  env: Env,
  account: DnsAccountRecord,
): Promise<CloudDnsDomain[]> {
  if (isDryRun(env)) {
    const store = getDryStore(account);
    return store.domains.map((d) => ({
      ...d,
      record_count: store.records.get(d.name)?.length ?? d.record_count,
    }));
  }

  if (account.provider === "tencent") {
    const result: CloudDnsDomain[] = [];
    let offset = 0;
    const limit = 100;
    for (let page = 0; page < 10; page += 1) {
      const data = await dnspodRpc(account, "DescribeDomainList", {
        Type: "ALL",
        Offset: offset,
        Limit: limit,
      });
      const list = asArr<Record<string, unknown>>(data["DomainList"]);
      for (const item of list) {
        result.push({
          id: asStr(item["DomainId"]),
          name: cleanHost(asStr(item["Name"])),
          status: asStr(item["Status"], "ENABLE").toLowerCase(),
          record_count: asNum(item["RecordCount"], 0),
          ttl: asNum(item["TTL"], 600),
          plan: asStr(item["GradeTitle"] || item["Grade"] || "免费版"),
          name_servers: asArr<string>(item["EffectiveDNS"]).map(String),
          updated_on: asStr(item["UpdatedOn"]),
          provider: "tencent",
        });
      }
      if (list.length < limit) break;
      offset += limit;
    }
    return result;
  }

  // Cloudflare zones
  const result: CloudDnsDomain[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const data = await cfRequest(
      account,
      "GET",
      `/zones?per_page=50&page=${page}`,
    );
    const list = asArr<Record<string, unknown>>(data["result"]);
    for (const item of list) {
      const planObj = asObj(item["plan"]);
      result.push({
        id: asStr(item["id"]),
        name: cleanHost(asStr(item["name"])),
        status: asStr(item["status"], "active").toLowerCase(),
        record_count: 0,
        ttl: 1,
        plan: asStr(planObj["name"] || "Free"),
        name_servers: asArr<string>(item["name_servers"]).map(String),
        updated_on: asStr(item["modified_on"]),
        provider: "cloudflare",
      });
    }
    const info = asObj(data["result_info"]);
    const totalPages = asNum(info["total_pages"], 1);
    if (page >= totalPages || list.length === 0) break;
  }
  return result;
}

export async function listRecords(
  env: Env,
  account: DnsAccountRecord,
  domain: string,
  zoneId?: string,
  opts?: { keyword?: string; type?: string },
): Promise<CloudDnsRecord[]> {
  const root = cleanHost(domain);
  if (!root) throw new Error("域名不能为空");

  if (isDryRun(env)) {
    const store = getDryStore(account);
    const list = store.records.get(root) ?? [];
    const kw = (opts?.keyword ?? "").trim().toLowerCase();
    const typeFilter = (opts?.type ?? "").trim().toUpperCase();
    return list.filter((rec) => {
      if (typeFilter && rec.type.toUpperCase() !== typeFilter) return false;
      if (kw) {
        const hay = `${rec.name} ${rec.full_name} ${rec.value} ${rec.remark}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }

  if (account.provider === "tencent") {
    const payload: Record<string, unknown> = {
      Domain: root,
      Offset: 0,
      Limit: 3000,
    };
    if (opts?.keyword?.trim()) payload["Keyword"] = opts.keyword.trim();
    if (opts?.type?.trim()) payload["RecordType"] = opts.type.trim().toUpperCase();

    try {
      const data = await dnspodRpc(account, "DescribeRecordList", payload);
      const list = asArr<Record<string, unknown>>(data["RecordList"]);
      return list.map((item) => {
        const host = asStr(item["Name"], "@");
        const recType = asStr(item["Type"]).toUpperCase();
        const statusStr = asStr(item["Status"], "ENABLE").toUpperCase();
        const mxVal = asNum(item["MX"], 0);
        return {
          id: asStr(item["RecordId"]),
          domain: root,
          zone_id: zoneId || "",
          name: host,
          full_name: toFqdn(host, root),
          type: recType,
          value: asStr(item["Value"]),
          ttl: asNum(item["TTL"], 600),
          line: asStr(item["Line"], "默认"),
          mx: recType === "MX" ? mxVal || 10 : undefined,
          enabled: statusStr !== "DISABLE",
          remark: asStr(item["Remark"]),
          updated_on: asStr(item["UpdatedOn"]),
          provider: "tencent",
        };
      });
    } catch (err) {
      const code = (err as Error & { tcCode?: string }).tcCode ?? "";
      if (code === "ResourceNotFound.NoDataOfRecord") {
        return [];
      }
      throw err;
    }
  }

  // Cloudflare
  let zid = (zoneId ?? "").trim();
  if (!zid) {
    const resolved = await resolveDomainZone(env, account, root);
    zid = resolved.zoneId;
  }
  const params = new URLSearchParams({ per_page: "100" });
  if (opts?.type?.trim()) params.set("type", opts.type.trim().toUpperCase());
  const out: CloudDnsRecord[] = [];
  for (let page = 1; page <= 5; page += 1) {
    params.set("page", String(page));
    const data = await cfRequest(
      account,
      "GET",
      `/zones/${encodeURIComponent(zid)}/dns_records?${params.toString()}`,
    );
    const list = asArr<Record<string, unknown>>(data["result"]);
    for (const item of list) {
      const fullName = cleanHost(asStr(item["name"]));
      const recType = asStr(item["type"]).toUpperCase();
      const pri = item["priority"] !== undefined ? asNum(item["priority"], 0) : undefined;
      out.push({
        id: asStr(item["id"]),
        domain: root,
        zone_id: zid,
        name: toRelativeHost(fullName, root),
        full_name: fullName,
        type: recType,
        value: asStr(item["content"]),
        ttl: asNum(item["ttl"], 1),
        line: "",
        mx: recType === "MX" || recType === "SRV" ? pri : undefined,
        proxied: Boolean(item["proxied"]),
        enabled: true,
        remark: asStr(item["comment"]),
        updated_on: asStr(item["modified_on"]),
        provider: "cloudflare",
      });
    }
    const info = asObj(data["result_info"]);
    const totalPages = asNum(info["total_pages"], 1);
    if (page >= totalPages || list.length === 0) break;
  }
  const kw = (opts?.keyword ?? "").trim().toLowerCase();
  if (!kw) return out;
  return out.filter((rec) =>
    `${rec.name} ${rec.full_name} ${rec.value} ${rec.remark}`.toLowerCase().includes(kw),
  );
}

export async function createRecord(
  env: Env,
  account: DnsAccountRecord,
  domain: string,
  zoneId: string,
  input: CloudDnsRecordInput,
): Promise<CloudDnsRecord> {
  const root = cleanHost(domain);
  const type = input.type.trim().toUpperCase();
  const rel = toRelativeHost(input.name, root);
  const fqdn = toFqdn(rel, root);
  const value = input.value.trim();
  if (!root || !type || !value) {
    throw new Error("记录类型、域名与记录值不能为空");
  }

  if (isDryRun(env)) {
    const store = getDryStore(account);
    const list = store.records.get(root) ?? [];
    store.nextId += 1;
    const rec: CloudDnsRecord = {
      id: String(store.nextId),
      domain: root,
      zone_id: zoneId || store.domains[0]?.id || "dry_zone",
      name: rel,
      full_name: fqdn,
      type,
      value,
      ttl: input.ttl ?? (account.provider === "tencent" ? 600 : 1),
      line: account.provider === "tencent" ? input.line?.trim() || "默认" : "",
      mx: type === "MX" ? input.mx ?? 10 : undefined,
      proxied:
        account.provider === "cloudflare"
          ? isCfProxiable(type) && Boolean(input.proxied)
          : undefined,
      enabled: input.enabled !== false,
      remark: (input.remark ?? "").trim(),
      updated_on: new Date().toISOString().slice(0, 19).replace("T", " "),
      provider: account.provider,
    };
    list.unshift(rec);
    store.records.set(root, list);
    return rec;
  }

  if (account.provider === "tencent") {
    const ttl = Math.max(60, Math.min(604800, Math.trunc(input.ttl ?? 600)));
    const line = input.line?.trim() || "默认";
    const payload: Record<string, unknown> = {
      Domain: root,
      SubDomain: rel,
      RecordType: type,
      RecordLine: line,
      Value: value,
      TTL: ttl,
      Status: input.enabled === false ? "DISABLE" : "ENABLE",
    };
    if (type === "MX") {
      payload["MX"] = Math.max(1, Math.min(20, Math.trunc(input.mx ?? 10)));
    }
    if (input.remark?.trim()) {
      payload["Remark"] = input.remark.trim();
    }
    const data = await dnspodRpc(account, "CreateRecord", payload);
    const recordId = asStr(data["RecordId"]);
    return {
      id: recordId,
      domain: root,
      zone_id: zoneId,
      name: rel,
      full_name: fqdn,
      type,
      value,
      ttl,
      line,
      mx: type === "MX" ? (payload["MX"] as number) : undefined,
      enabled: input.enabled !== false,
      remark: (input.remark ?? "").trim(),
      updated_on: "",
      provider: "tencent",
    };
  }

  // Cloudflare
  let zid = zoneId.trim();
  if (!zid) {
    const resolved = await resolveDomainZone(env, account, root);
    zid = resolved.zoneId;
  }
  const ttl = input.ttl && input.ttl >= 60 ? Math.trunc(input.ttl) : 1;
  const proxied = isCfProxiable(type) && Boolean(input.proxied);
  const body: Record<string, unknown> = {
    type,
    name: fqdn,
    content: value,
    ttl,
    proxied,
  };
  if (type === "MX" || type === "SRV") {
    body["priority"] = Math.max(0, Math.trunc(input.mx ?? 10));
  }
  if (input.remark?.trim()) {
    body["comment"] = input.remark.trim();
  }
  const data = await cfRequest(
    account,
    "POST",
    `/zones/${encodeURIComponent(zid)}/dns_records`,
    body,
  );
  const item = asObj(data["result"]);
  return {
    id: asStr(item["id"]),
    domain: root,
    zone_id: zid,
    name: rel,
    full_name: cleanHost(asStr(item["name"], fqdn)),
    type,
    value: asStr(item["content"], value),
    ttl: asNum(item["ttl"], ttl),
    line: "",
    mx: type === "MX" || type === "SRV" ? asNum(item["priority"], input.mx ?? 10) : undefined,
    proxied: Boolean(item["proxied"]),
    enabled: true,
    remark: asStr(item["comment"]),
    updated_on: asStr(item["modified_on"]),
    provider: "cloudflare",
  };
}

export async function updateRecord(
  env: Env,
  account: DnsAccountRecord,
  domain: string,
  zoneId: string,
  recordId: string,
  input: CloudDnsRecordInput,
): Promise<CloudDnsRecord> {
  const root = cleanHost(domain);
  const type = input.type.trim().toUpperCase();
  const rel = toRelativeHost(input.name, root);
  const fqdn = toFqdn(rel, root);
  const value = input.value.trim();
  if (!root || !recordId.trim() || !type || !value) {
    throw new Error("缺少必要的解析记录更新参数");
  }

  if (isDryRun(env)) {
    const store = getDryStore(account);
    const list = store.records.get(root) ?? [];
    const idx = list.findIndex((r) => r.id === recordId);
    if (idx < 0) throw new Error("解析记录不存在");
    const updated: CloudDnsRecord = {
      ...list[idx]!,
      name: rel,
      full_name: fqdn,
      type,
      value,
      ttl: input.ttl ?? list[idx]!.ttl,
      line: account.provider === "tencent" ? input.line?.trim() || list[idx]!.line || "默认" : "",
      mx: type === "MX" ? input.mx ?? list[idx]!.mx ?? 10 : undefined,
      proxied:
        account.provider === "cloudflare"
          ? isCfProxiable(type) && Boolean(input.proxied)
          : undefined,
      enabled: input.enabled !== undefined ? input.enabled : list[idx]!.enabled,
      remark: input.remark !== undefined ? input.remark.trim() : list[idx]!.remark,
      updated_on: new Date().toISOString().slice(0, 19).replace("T", " "),
    };
    list[idx] = updated;
    store.records.set(root, list);
    return updated;
  }

  if (account.provider === "tencent") {
    const numId = Number(recordId);
    if (!Number.isFinite(numId) || numId <= 0) {
      throw new Error("DNSPod RecordId 无效");
    }
    const ttl = Math.max(60, Math.min(604800, Math.trunc(input.ttl ?? 600)));
    const line = input.line?.trim() || "默认";
    const payload: Record<string, unknown> = {
      Domain: root,
      RecordId: numId,
      SubDomain: rel,
      RecordType: type,
      RecordLine: line,
      Value: value,
      TTL: ttl,
      Status: input.enabled === false ? "DISABLE" : "ENABLE",
    };
    if (type === "MX") {
      payload["MX"] = Math.max(1, Math.min(20, Math.trunc(input.mx ?? 10)));
    }
    await dnspodRpc(account, "ModifyRecord", payload);
    if (input.remark !== undefined) {
      try {
        await dnspodRpc(account, "ModifyRecordRemark", {
          Domain: root,
          RecordId: numId,
          Remark: input.remark.trim(),
        });
      } catch {
        // Non-fatal: keep main record update succeeded even if remark API is restricted.
      }
    }
    return {
      id: String(numId),
      domain: root,
      zone_id: zoneId,
      name: rel,
      full_name: fqdn,
      type,
      value,
      ttl,
      line,
      mx: type === "MX" ? (payload["MX"] as number) : undefined,
      enabled: input.enabled !== false,
      remark: (input.remark ?? "").trim(),
      updated_on: "",
      provider: "tencent",
    };
  }

  // Cloudflare
  let zid = zoneId.trim();
  if (!zid) {
    const resolved = await resolveDomainZone(env, account, root);
    zid = resolved.zoneId;
  }
  const ttl = input.ttl && input.ttl >= 60 ? Math.trunc(input.ttl) : 1;
  const proxied = isCfProxiable(type) && Boolean(input.proxied);
  const body: Record<string, unknown> = {
    type,
    name: fqdn,
    content: value,
    ttl,
    proxied,
  };
  if (type === "MX" || type === "SRV") {
    body["priority"] = Math.max(0, Math.trunc(input.mx ?? 10));
  }
  if (input.remark !== undefined) {
    body["comment"] = input.remark.trim();
  }
  const data = await cfRequest(
    account,
    "PATCH",
    `/zones/${encodeURIComponent(zid)}/dns_records/${encodeURIComponent(recordId)}`,
    body,
  );
  const item = asObj(data["result"]);
  return {
    id: asStr(item["id"], recordId),
    domain: root,
    zone_id: zid,
    name: rel,
    full_name: cleanHost(asStr(item["name"], fqdn)),
    type,
    value: asStr(item["content"], value),
    ttl: asNum(item["ttl"], ttl),
    line: "",
    mx: type === "MX" || type === "SRV" ? asNum(item["priority"], input.mx ?? 10) : undefined,
    proxied: Boolean(item["proxied"]),
    enabled: true,
    remark: asStr(item["comment"]),
    updated_on: asStr(item["modified_on"]),
    provider: "cloudflare",
  };
}

export async function setRecordStatus(
  env: Env,
  account: DnsAccountRecord,
  domain: string,
  zoneId: string,
  recordId: string,
  enabled: boolean,
): Promise<void> {
  const root = cleanHost(domain);
  if (isDryRun(env)) {
    const store = getDryStore(account);
    const list = store.records.get(root) ?? [];
    const target = list.find((r) => r.id === recordId);
    if (!target) throw new Error("解析记录不存在");
    if (account.provider === "tencent") {
      target.enabled = enabled;
    } else {
      target.proxied = enabled;
    }
    return;
  }

  if (account.provider === "tencent") {
    const numId = Number(recordId);
    if (!Number.isFinite(numId) || numId <= 0) {
      throw new Error("DNSPod RecordId 无效");
    }
    await dnspodRpc(account, "ModifyRecordStatus", {
      Domain: root,
      RecordId: numId,
      Status: enabled ? "ENABLE" : "DISABLE",
    });
    return;
  }

  // Cloudflare does not have pause/resume; this endpoint toggles proxied state when called on CF.
  let zid = zoneId.trim();
  if (!zid) {
    const resolved = await resolveDomainZone(env, account, root);
    zid = resolved.zoneId;
  }
  await cfRequest(
    account,
    "PATCH",
    `/zones/${encodeURIComponent(zid)}/dns_records/${encodeURIComponent(recordId)}`,
    { proxied: enabled },
  );
}

export async function deleteRecord(
  env: Env,
  account: DnsAccountRecord,
  domain: string,
  zoneId: string,
  recordId: string,
): Promise<void> {
  const root = cleanHost(domain);
  if (isDryRun(env)) {
    const store = getDryStore(account);
    const list = store.records.get(root) ?? [];
    store.records.set(
      root,
      list.filter((r) => r.id !== recordId),
    );
    return;
  }

  if (account.provider === "tencent") {
    const numId = Number(recordId);
    if (!Number.isFinite(numId) || numId <= 0) {
      throw new Error("DNSPod RecordId 无效");
    }
    await dnspodRpc(account, "DeleteRecord", {
      Domain: root,
      RecordId: numId,
    });
    return;
  }

  let zid = zoneId.trim();
  if (!zid) {
    const resolved = await resolveDomainZone(env, account, root);
    zid = resolved.zoneId;
  }
  await cfRequest(
    account,
    "DELETE",
    `/zones/${encodeURIComponent(zid)}/dns_records/${encodeURIComponent(recordId)}`,
  );
}

// ---------------------------------------------------------------------------
// Automated SSL domain validation helpers (used by src/tencent_ssl.ts)
// ---------------------------------------------------------------------------

/**
 * Find the longest matching root domain hosted under `account` for `targetDomain`.
 */
export async function resolveDomainZone(
  env: Env,
  account: DnsAccountRecord,
  targetDomain: string,
): Promise<{ rootDomain: string; zoneId: string }> {
  const cleanTarget = cleanHost(targetDomain);
  const domains = await listDomains(env, account);
  let best: CloudDnsDomain | null = null;
  for (const item of domains) {
    const candidate = cleanHost(item.name);
    if (
      cleanTarget === candidate ||
      cleanTarget.endsWith(`.${candidate}`)
    ) {
      if (!best || candidate.length > best.name.length) {
        best = item;
      }
    }
  }
  if (!best) {
    if (isDryRun(env) && domains.length > 0) {
      // In dry-run mode, allow validating arbitrary test domains by auto-registering the apex.
      const labels = cleanTarget.split(".").filter(Boolean);
      const rootDomain =
        labels.length >= 2 ? labels.slice(-2).join(".") : cleanTarget;
      const store = getDryStore(account);
      let existing = store.domains.find((d) => d.name === rootDomain);
      if (!existing) {
        existing = {
          id: `${account.provider}_zone_${store.domains.length + 1}`,
          name: rootDomain,
          status: "active",
          record_count: 0,
          ttl: account.provider === "tencent" ? 600 : 1,
          plan: account.provider === "tencent" ? "免费版" : "Free",
          name_servers: [],
          updated_on: new Date().toISOString().slice(0, 19).replace("T", " "),
          provider: account.provider,
        };
        store.domains.push(existing);
        store.records.set(rootDomain, []);
      }
      return { rootDomain: existing.name, zoneId: existing.id };
    }
    throw new Error(
      `未在所选 ${account.provider === "tencent" ? "腾讯云 DNSPod" : "Cloudflare"} 账号「${account.label}」中找到托管域名 ${cleanTarget} 的主域`,
    );
  }
  return { rootDomain: best.name, zoneId: best.id };
}

/**
 * Idempotently create or update the TXT/CNAME validation record required by
 * Tencent Cloud SSL CA verification.
 */
export async function upsertValidationRecord(
  env: Env,
  account: DnsAccountRecord,
  spec: ValidationRecordSpec,
): Promise<ValidationRecordResult> {
  let rootDomain = cleanHost(spec.rootDomain ?? "");
  let zoneId = (spec.zoneId ?? "").trim();
  if (!rootDomain || (account.provider === "cloudflare" && !zoneId)) {
    const resolved = await resolveDomainZone(env, account, spec.domain);
    rootDomain = resolved.rootDomain;
    zoneId = resolved.zoneId;
  }

  // Derive relative host carefully: prefer fullHost if given, otherwise subDomain.
  const rawHost = spec.fullHost?.trim() || spec.subDomain?.trim() || "_dnsauth";
  const hostName = toRelativeHost(rawHost, rootDomain);
  const fullHost = toFqdn(hostName, rootDomain);
  const value = spec.value.trim();
  if (!value) {
    throw new Error("证书验证记录值为空，无法自动写入 DNS");
  }

  const existingRecords = await listRecords(env, account, rootDomain, zoneId, {
    type: spec.type,
  });
  const matching = existingRecords.filter(
    (r) =>
      r.type.toUpperCase() === spec.type &&
      cleanHost(r.full_name) === fullHost,
  );

  // Exact match already present -> reuse cleanly (idempotent).
  const exact = matching.find(
    (r) => r.value.trim().replace(/^"|"$/g, "") === value.replace(/^"|"$/g, "") && r.enabled,
  );
  if (exact) {
    return {
      rootDomain,
      zoneId: exact.zone_id || zoneId,
      recordId: exact.id,
      hostName,
      fullHost,
      type: spec.type,
      value,
      action: "unchanged",
    };
  }

  // Existing record on same host & type with stale value -> update in place
  // (avoids CNAME collisions and stale verification tokens on renewal).
  if (matching.length > 0) {
    const target = matching[0]!;
    const updated = await updateRecord(env, account, rootDomain, zoneId, target.id, {
      name: hostName,
      type: spec.type,
      value,
      ttl: account.provider === "tencent" ? 600 : 60,
      line: account.provider === "tencent" ? target.line || "默认" : undefined,
      proxied: false,
      enabled: true,
      remark: "SSL auto validation",
    });
    return {
      rootDomain,
      zoneId: updated.zone_id || zoneId,
      recordId: updated.id,
      hostName,
      fullHost,
      type: spec.type,
      value,
      action: "updated",
    };
  }

  const created = await createRecord(env, account, rootDomain, zoneId, {
    name: hostName,
    type: spec.type,
    value,
    ttl: account.provider === "tencent" ? 600 : 60,
    line: account.provider === "tencent" ? "默认" : undefined,
    proxied: false,
    enabled: true,
    remark: "SSL auto validation",
  });
  return {
    rootDomain,
    zoneId: created.zone_id || zoneId,
    recordId: created.id,
    hostName,
    fullHost,
    type: spec.type,
    value,
    action: "created",
  };
}

/**
 * Best-effort cleanup of a temporary validation DNS record once the certificate
 * has been issued. Missing/already-deleted records are ignored safely.
 */
export async function deleteValidationRecord(
  env: Env,
  account: DnsAccountRecord,
  rootDomain: string,
  zoneId: string,
  recordId: string,
): Promise<boolean> {
  if (!rootDomain || !recordId) return false;
  try {
    await deleteRecord(env, account, rootDomain, zoneId, recordId);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("404") ||
      msg.includes("RecordIdInvalid") ||
      msg.includes("does not exist") ||
      msg.includes("不存在")
    ) {
      return false;
    }
    console.warn("failed to clean temporary SSL validation DNS record", msg);
    return false;
  }
}
