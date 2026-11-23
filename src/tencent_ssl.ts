/**
 * Tencent Cloud SSL Certificate Service (ssl.tencentcloudapi.com, Version 2019-12-05).
 *
 * Implements zero-dependency TC3-HMAC-SHA256 signing (reusing `signTencentV3`),
 * automated domain validation via Tencent DNSPod (`DNS_AUTO` or bound account)
 * or Cloudflare DNS, PEM/ZIP download, account certificate sync, and automatic
 * renewal + DNS verification 7 days (configurable) before expiration.
 */

import type { Env } from "./env";
import * as dnsProviders from "./dns_providers";
import * as messages from "./messages";
import * as notify from "./notify";
import * as nps from "./nps";
import * as repo from "./repo";
import type {
  DnsAccountRecord,
  EdgeOneSite,
  NpsCertBindingRecord,
  SslCertStatus,
  SslCertificateRecord,
  SslVerifyMode,
} from "./repo";
import { signTencentV3 } from "./tencent_lighthouse";
import {
  deployBindingNow,
  getEdgeOneAutoCertConfig,
  listAccelerationDomains,
  listWatchedEdgeOneScopes,
  listZones,
  modifyHostsCertificate,
  normalizeSite as normalizeEdgeOneSite,
  recordWatchedEdgeOneScope,
  resolveEdgeOneCreds,
  syncRenewedCertificateToEdgeOne,
  type EdgeOneDomain,
} from "./tencent_edgeone";

const SSL_HOST = "ssl.tencentcloudapi.com";
const SSL_SERVICE = "ssl";
const SSL_VERSION = "2019-12-05";
const HTTP_TIMEOUT_MS = 18_000;

const VERIFY_POLL_FLAG = "ssl_verify_last_run";
const RENEW_SCAN_FLAG = "ssl_renew_last_run";
const EO_CERT_SCAN_FLAG = "eo_cert_reconcile_last_run";
const NPS_CERT_SYNC_FLAG = "nps_cert_sync_last_run";
const VERIFY_POLL_INTERVAL_SECONDS = 120; // 2 min
const RENEW_SCAN_INTERVAL_SECONDS = 900; // 15 min
const EO_CERT_SCAN_INTERVAL_SECONDS = 1800; // 30 min
const NPS_CERT_SYNC_INTERVAL_SECONDS = 300; // 5 min
const RENEW_RETRY_COOLDOWN_SECONDS = 6 * 3600; // 6 h between automatic retry attempts

export interface TencentCreds {
  secretId: string;
  secretKey: string;
  sourceLabel: string;
}

export interface DvAuthInfo {
  domain: string;
  subDomain: string;
  fullHost: string;
  verifyType: "TXT" | "CNAME";
  value: string;
}

export interface TencentCertDetail {
  certificateId: string;
  domain: string;
  status: number;
  statusName: string;
  statusMsg: string;
  verifyType: string;
  packageType: string;
  productZhName: string;
  certBeginTime: string;
  certEndTime: string;
  certEndTs: number;
  validityPeriod: string;
  encryptAlgorithm: string;
  certificatePublicKey: string;
  certificatePrivateKey: string;
  dvAuth: DvAuthInfo | null;
}

export interface TencentCertSummary {
  certificateId: string;
  domain: string;
  status: number;
  statusName: string;
  verifyType: string;
  productZhName: string;
  certBeginTime: string;
  certEndTime: string;
  certEndTs: number;
  encryptAlgorithm: string;
  isDv: boolean;
}

export interface ApplyCertRequest {
  domain: string;
  tencent_account_id?: number;
  tencent_swas_id?: number;
  tencent_secret_id?: string;
  tencent_secret_key?: string;
  dns_verify_mode: SslVerifyMode;
  dns_account_id?: number;
  encrypt_algo?: "RSA" | "ECC";
  auto_renew?: boolean;
  renew_before_days?: number;
  clean_dns_after_issue?: boolean;
  contact_email?: string;
  remark?: string;
}

export interface ReconcileCertsSummary {
  checked: number;
  issued: number;
  renewalsStarted: number;
  dnsWritten: number;
  cleaned: number;
  errors: string[];
}

function isDryRun(env: Env): boolean {
  return env.CDT_DRY_RUN === "1";
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
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

/**
 * Parse Tencent Cloud GMT+8 datetime string (`YYYY-MM-DD HH:mm:ss`) to Unix epoch seconds.
 */
export function parseTencentTimeToEpoch(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  // Already ISO with timezone
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(trimmed);
  if (!m) return 0;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function formatGmt8(epochSec: number): string {
  const d = new Date((epochSec + 8 * 3600) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function mapTencentStatus(status: number, certEndTs: number): SslCertStatus {
  if (status === 1) {
    if (certEndTs > 0 && certEndTs <= nowSeconds()) return "expired";
    return "issued";
  }
  if (status === 3) return "expired";
  if (status === 2 || status === 7 || status === 10 || status === 14) return "failed";
  if (status === 0 || status === 4 || status === 11) return "verifying";
  return "pending_dns";
}

export function tencentStatusLabel(status: number, fallback = ""): string {
  if (fallback) return fallback;
  switch (status) {
    case 0:
      return "审核中";
    case 1:
      return "已颁发";
    case 2:
      return "审核失败";
    case 3:
      return "已过期";
    case 4:
      return "待添加 DNS 解析";
    case 6:
      return "订单取消中";
    case 7:
      return "已取消";
    case 9:
      return "吊销中";
    case 10:
      return "已吊销";
    case 11:
      return "重颁发中";
    default:
      return "处理中";
  }
}

export function normalizeDomain(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.+$/, "");
  if (!cleaned || cleaned.includes(" ") || !cleaned.includes(".")) {
    throw new Error("请输入合法的域名（例如 example.com 或 api.example.com）");
  }
  if (cleaned.startsWith("*.")) {
    throw new Error("腾讯云免费 DV 证书仅支持单域名，不支持泛域名（*）申请");
  }
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(cleaned)) {
    throw new Error(`域名格式不正确：${cleaned}`);
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Dry-run in-memory mock store for Tencent SSL certificates
// ---------------------------------------------------------------------------

interface DrySslCert {
  certificateId: string;
  domain: string;
  verifyType: string;
  encryptAlgorithm: "RSA" | "ECC";
  status: number;
  statusName: string;
  statusMsg: string;
  dvAuth: DvAuthInfo;
  certBeginTime: string;
  certEndTime: string;
  certEndTs: number;
  publicKey: string;
  privateKey: string;
  completedCalls: number;
}

const drySslStore = new Map<string, DrySslCert>();
let drySslSeq = 100;

function makeDrySslCert(
  domain: string,
  verifyType: string,
  encryptAlgorithm: "RSA" | "ECC",
  existingId?: string,
): DrySslCert {
  drySslSeq += 1;
  const certId = existingId || `tcDry${drySslSeq}`;
  const labels = domain.split(".");
  const rootDomain = labels.length >= 2 ? labels.slice(-2).join(".") : domain;
  const prefix = labels.length > 2 ? `_dnsauth.${labels.slice(0, -2).join(".")}` : "_dnsauth";
  const token = `dry-verify-${certId}-${Date.now().toString(36)}`;
  const now = nowSeconds();
  const endTs = now + 90 * 86400;
  const cert: DrySslCert = {
    certificateId: certId,
    domain,
    verifyType,
    encryptAlgorithm,
    status: verifyType === "DNS_AUTO" ? 0 : 0,
    statusName: "审核中",
    statusMsg: "PENDING-DCV",
    dvAuth: {
      domain: rootDomain,
      subDomain: prefix,
      fullHost: `${prefix}.${rootDomain}`,
      verifyType: "TXT",
      value: token,
    },
    certBeginTime: "",
    certEndTime: "",
    certEndTs: 0,
    publicKey: `-----BEGIN CERTIFICATE-----\nMOCK-PUBLIC-CERT-FOR-${domain}-${certId}\n-----END CERTIFICATE-----\n`,
    privateKey: `-----BEGIN PRIVATE KEY-----\nMOCK-PRIVATE-KEY-FOR-${domain}-${certId}\n-----END PRIVATE KEY-----\n`,
    completedCalls: 0,
  };
  // Pre-seed endTs only after issuance (triggered by CompleteCertificate)
  void endTs;
  drySslStore.set(certId, cert);
  return cert;
}

function issueDrySslCert(cert: DrySslCert): void {
  const now = nowSeconds();
  const endTs = now + 90 * 86400;
  cert.status = 1;
  cert.statusName = "已颁发";
  cert.statusMsg = "";
  cert.certBeginTime = formatGmt8(now);
  cert.certEndTime = formatGmt8(endTs);
  cert.certEndTs = endTs;
}

// ---------------------------------------------------------------------------
// Low-level Tencent Cloud SSL RPC
// ---------------------------------------------------------------------------

async function sslRpc(
  creds: TencentCreds,
  action: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const secretId = creds.secretId.trim();
  const secretKey = creds.secretKey.trim();
  if (!secretId || !secretKey) {
    throw new Error("缺少腾讯云 API 密钥（SecretId / SecretKey）");
  }
  const payload = JSON.stringify(params);
  const signed = await signTencentV3({
    secretId,
    secretKey,
    service: SSL_SERVICE,
    host: SSL_HOST,
    action,
    version: SSL_VERSION,
    payload,
  });

  const resp = await fetch(`https://${SSL_HOST}`, {
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
    throw new Error(`腾讯云 SSL 接口返回非 JSON（HTTP ${resp.status}）`);
  }
  const body = asObj(parsed["Response"]);
  const err = asObj(body["Error"]);
  if (err["Code"]) {
    const code = asStr(err["Code"]);
    const msg = asStr(err["Message"] || code);
    const wrapped = new Error(`腾讯云 SSL ${action} 失败（${code}）：${msg}`);
    (wrapped as Error & { tcCode?: string }).tcCode = code;
    throw wrapped;
  }
  if (!resp.ok) {
    throw new Error(`腾讯云 SSL HTTP ${resp.status}`);
  }
  return body;
}

function extractDvAuth(rawDetail: Record<string, unknown>, domain: string): DvAuthInfo | null {
  const detail = asObj(rawDetail["DvAuthDetail"]);
  const auths = asArr<Record<string, unknown>>(detail["DvAuths"]);
  const first = auths.length > 0 ? asObj(auths[0]) : {};

  const dvValue = asStr(first["DvAuthValue"] ?? detail["DvAuthValue"]).trim();
  if (!dvValue) return null;

  const dvDomain = asStr(first["DvAuthDomain"] ?? detail["DvAuthDomain"]).trim().toLowerCase();
  const dvKey = asStr(first["DvAuthKey"] ?? detail["DvAuthKey"]).trim().toLowerCase();
  const dvSub = asStr(
    first["DvAuthSubDomain"] ?? detail["DvAuthKeySubDomain"],
  )
    .trim()
    .toLowerCase();
  const rawType = asStr(first["DvAuthVerifyType"]).trim().toUpperCase();

  let verifyType: "TXT" | "CNAME" = "TXT";
  if (rawType === "CNAME") {
    verifyType = "CNAME";
  } else if (rawType === "TXT") {
    verifyType = "TXT";
  } else if (
    dvValue.includes(".trust-provider.com") ||
    dvValue.includes(".sectigo.com") ||
    dvValue.includes(".digicert.com") ||
    dvValue.includes(".dnspod.")
  ) {
    verifyType = "CNAME";
  }

  const root = dvDomain || domain;
  let fullHost = dvKey;
  let subDomain = dvSub;
  if (!subDomain && fullHost) {
    subDomain = dnsProviders.toRelativeHost(fullHost, root);
  }
  if (!fullHost && subDomain) {
    fullHost = dnsProviders.toFqdn(subDomain, root);
  }
  if (!subDomain) subDomain = "_dnsauth";
  if (!fullHost) fullHost = dnsProviders.toFqdn(subDomain, root);

  return {
    domain: root,
    subDomain,
    fullHost,
    verifyType,
    value: dvValue,
  };
}

// ---------------------------------------------------------------------------
// Credential resolvers
// ---------------------------------------------------------------------------

export async function resolveTencentCredsForCert(
  env: Env,
  cert: SslCertificateRecord,
): Promise<TencentCreds> {
  if (cert.tencent_account_id > 0) {
    const acct = await repo.getDnsAccount(env, cert.tencent_account_id, true);
    if (acct && acct.provider === "tencent" && acct.cred_id && acct.cred_secret) {
      return {
        secretId: acct.cred_id,
        secretKey: acct.cred_secret,
        sourceLabel: acct.label,
      };
    }
  }
  if (cert.tencent_secret_id && cert.tencent_secret_key) {
    return {
      secretId: cert.tencent_secret_id,
      secretKey: cert.tencent_secret_key,
      sourceLabel: "独立密钥",
    };
  }
  throw new Error("未找到可用的腾讯云 API 密钥，请先绑定腾讯云账号或重新配置密钥");
}

export async function resolveTencentCredsFromInput(
  env: Env,
  input: {
    tencent_account_id?: number;
    tencent_swas_id?: number;
    tencent_secret_id?: string;
    tencent_secret_key?: string;
  },
): Promise<{
  creds: TencentCreds;
  tencentAccountId: number;
  customSecretId: string;
  customSecretKey: string;
}> {
  if (input.tencent_account_id && input.tencent_account_id > 0) {
    const acct = await repo.getDnsAccount(env, input.tencent_account_id, true);
    if (!acct || acct.provider !== "tencent") {
      throw new Error("所选腾讯云账号不存在或不是腾讯云类型");
    }
    if (!acct.cred_id || !acct.cred_secret) {
      throw new Error(`腾讯云账号「${acct.label}」密钥不完整`);
    }
    return {
      creds: {
        secretId: acct.cred_id,
        secretKey: acct.cred_secret,
        sourceLabel: acct.label,
      },
      tencentAccountId: acct.id,
      customSecretId: "",
      customSecretKey: "",
    };
  }

  if (input.tencent_swas_id && input.tencent_swas_id > 0) {
    const swasRow = await repo.getSwasServer(env, input.tencent_swas_id, true);
    if (!swasRow || swasRow.provider !== "tencent") {
      throw new Error("所选腾讯云轻量服务器不存在");
    }
    const sid = String(swasRow.access_key_id || "").trim();
    const skey = String(swasRow.access_key_secret || "").trim();
    if (!sid || !skey) {
      throw new Error("所选腾讯云轻量服务器缺少 API 密钥");
    }
    return {
      creds: {
        secretId: sid,
        secretKey: skey,
        sourceLabel: `轻量：${swasRow.label}`,
      },
      tencentAccountId: 0,
      customSecretId: sid,
      customSecretKey: skey,
    };
  }

  const sid = (input.tencent_secret_id ?? "").trim();
  const skey = (input.tencent_secret_key ?? "").trim();
  if (!sid || !skey) {
    throw new Error("请选择腾讯云账号，或填写腾讯云 SecretId 与 SecretKey");
  }
  return {
    creds: {
      secretId: sid,
      secretKey: skey,
      sourceLabel: "独立密钥",
    },
    tencentAccountId: 0,
    customSecretId: sid,
    customSecretKey: skey,
  };
}

// ---------------------------------------------------------------------------
// Direct Tencent SSL API wrappers
// ---------------------------------------------------------------------------

export async function applyTencentCertificate(
  env: Env,
  creds: TencentCreds,
  opts: {
    domain: string;
    dvAuthMethod: "DNS_AUTO" | "DNS";
    oldCertificateId?: string;
    encryptAlgo?: "RSA" | "ECC";
    deleteDnsAutoRecord?: boolean;
    contactEmail?: string;
    alias?: string;
  },
): Promise<{ certificateId: string }> {
  if (isDryRun(env)) {
    const cert = makeDrySslCert(
      opts.domain,
      opts.dvAuthMethod,
      opts.encryptAlgo ?? "RSA",
    );
    return { certificateId: cert.certificateId };
  }

  const params: Record<string, unknown> = {
    DvAuthMethod: opts.dvAuthMethod,
    DomainName: opts.domain,
    PackageType: "83",
    ValidityPeriod: "3",
  };
  if (opts.oldCertificateId?.trim()) {
    params["OldCertificateId"] = opts.oldCertificateId.trim();
  }
  if (opts.encryptAlgo === "ECC") {
    params["CsrEncryptAlgo"] = "ECC";
  } else {
    params["CsrEncryptAlgo"] = "RSA";
  }
  if (opts.dvAuthMethod === "DNS_AUTO" && opts.deleteDnsAutoRecord !== undefined) {
    params["DeleteDnsAutoRecord"] = Boolean(opts.deleteDnsAutoRecord);
  }
  if (opts.contactEmail?.trim()) {
    params["ContactEmail"] = opts.contactEmail.trim();
  }
  if (opts.alias?.trim()) {
    params["Alias"] = opts.alias.trim().slice(0, 64);
  }

  const data = await sslRpc(creds, "ApplyCertificate", params);
  const certificateId = asStr(data["CertificateId"]).trim();
  if (!certificateId) {
    throw new Error("腾讯云 ApplyCertificate 未返回 CertificateId");
  }
  return { certificateId };
}

export async function describeTencentCertificateDetail(
  env: Env,
  creds: TencentCreds,
  certificateId: string,
): Promise<TencentCertDetail> {
  if (isDryRun(env)) {
    let cert = drySslStore.get(certificateId);
    if (!cert) {
      // Allow querying pre-seeded/synced dry-run cert IDs gracefully.
      cert = makeDrySslCert("dry.tencent-demo.cn", "DNS", "RSA", certificateId);
      issueDrySslCert(cert);
    }
    return {
      certificateId: cert.certificateId,
      domain: cert.domain,
      status: cert.status,
      statusName: cert.statusName,
      statusMsg: cert.statusMsg,
      verifyType: cert.verifyType,
      packageType: "83",
      productZhName: "TrustAsia C1 DV Free",
      certBeginTime: cert.certBeginTime,
      certEndTime: cert.certEndTime,
      certEndTs: cert.certEndTs,
      validityPeriod: "3",
      encryptAlgorithm: cert.encryptAlgorithm,
      certificatePublicKey: cert.status === 1 ? cert.publicKey : "",
      certificatePrivateKey: cert.status === 1 ? cert.privateKey : "",
      dvAuth: cert.status === 1 ? null : cert.dvAuth,
    };
  }

  const data = await sslRpc(creds, "DescribeCertificateDetail", {
    CertificateId: certificateId,
  });
  const domain = asStr(data["Domain"]).trim().toLowerCase();
  const status = asNum(data["Status"], -1);
  const certEndTime = asStr(data["CertEndTime"]).trim();
  const certEndTs = parseTencentTimeToEpoch(certEndTime);
  return {
    certificateId: asStr(data["CertificateId"], certificateId),
    domain,
    status,
    statusName: tencentStatusLabel(status, asStr(data["StatusName"]).trim()),
    statusMsg: asStr(data["StatusMsg"]).trim(),
    verifyType: asStr(data["VerifyType"]).trim(),
    packageType: asStr(data["PackageType"]).trim(),
    productZhName: asStr(data["ProductZhName"] || data["PackageTypeName"] || "TrustAsia C1 DV Free"),
    certBeginTime: asStr(data["CertBeginTime"]).trim(),
    certEndTime,
    certEndTs,
    validityPeriod: asStr(data["ValidityPeriod"], "3"),
    encryptAlgorithm: asStr(data["EncryptAlgorithm"], "RSA"),
    certificatePublicKey: asStr(data["CertificatePublicKey"]),
    certificatePrivateKey: asStr(data["CertificatePrivateKey"]),
    dvAuth: extractDvAuth(data, domain),
  };
}

export async function listTencentCertificates(
  env: Env,
  creds: TencentCreds,
  opts?: { searchKey?: string; limit?: number },
): Promise<TencentCertSummary[]> {
  if (isDryRun(env)) {
    const out: TencentCertSummary[] = [];
    for (const c of drySslStore.values()) {
      out.push({
        certificateId: c.certificateId,
        domain: c.domain,
        status: c.status,
        statusName: c.statusName,
        verifyType: c.verifyType,
        productZhName: "TrustAsia C1 DV Free",
        certBeginTime: c.certBeginTime,
        certEndTime: c.certEndTime,
        certEndTs: c.certEndTs,
        encryptAlgorithm: c.encryptAlgorithm,
        isDv: true,
      });
    }
    if (out.length === 0) {
      const demo = makeDrySslCert("web.tencent-demo.cn", "DNS_AUTO", "RSA", "tcDrySeed01");
      issueDrySslCert(demo);
      out.push({
        certificateId: demo.certificateId,
        domain: demo.domain,
        status: demo.status,
        statusName: demo.statusName,
        verifyType: demo.verifyType,
        productZhName: "TrustAsia C1 DV Free",
        certBeginTime: demo.certBeginTime,
        certEndTime: demo.certEndTime,
        certEndTs: demo.certEndTs,
        encryptAlgorithm: demo.encryptAlgorithm,
        isDv: true,
      });
    }
    return out;
  }

  const params: Record<string, unknown> = {
    Offset: 0,
    Limit: Math.max(1, Math.min(100, opts?.limit ?? 100)),
  };
  if (opts?.searchKey?.trim()) {
    params["SearchKey"] = opts.searchKey.trim();
  }
  const data = await sslRpc(creds, "DescribeCertificates", params);
  const items = asArr<Record<string, unknown>>(data["Certificates"]);
  return items.map((item) => {
    const status = asNum(item["Status"], -1);
    const certEndTime = asStr(item["CertEndTime"]).trim();
    return {
      certificateId: asStr(item["CertificateId"]),
      domain: asStr(item["Domain"]).trim().toLowerCase(),
      status,
      statusName: tencentStatusLabel(status, asStr(item["StatusName"]).trim()),
      verifyType: asStr(item["VerifyType"]).trim(),
      productZhName: asStr(item["ProductZhName"] || item["PackageTypeName"] || "SSL 证书"),
      certBeginTime: asStr(item["CertBeginTime"]).trim(),
      certEndTime,
      certEndTs: parseTencentTimeToEpoch(certEndTime),
      encryptAlgorithm: asStr(item["EncryptAlgorithm"], "RSA"),
      isDv: Boolean(item["IsDv"]),
    };
  });
}

export async function completeTencentCertificate(
  env: Env,
  creds: TencentCreds,
  certificateId: string,
): Promise<void> {
  if (isDryRun(env)) {
    const cert = drySslStore.get(certificateId);
    if (cert) {
      cert.completedCalls += 1;
      // Issue on CompleteCertificate call so E2E verifies full validation -> issued flow.
      issueDrySslCert(cert);
    }
    return;
  }
  await sslRpc(creds, "CompleteCertificate", { CertificateId: certificateId });
}

export async function checkTencentDomainVerification(
  env: Env,
  creds: TencentCreds,
  certificateId: string,
): Promise<{
  issued: boolean;
  localCheck: number;
  caCheck: number;
  failReason: string;
}> {
  if (isDryRun(env)) {
    const cert = drySslStore.get(certificateId);
    return {
      issued: cert?.status === 1,
      localCheck: 1,
      caCheck: cert?.status === 1 ? 2 : -1,
      failReason: "",
    };
  }
  const data = await sslRpc(creds, "CheckCertificateDomainVerification", {
    CertificateId: certificateId,
  });
  const results = asArr<Record<string, unknown>>(data["VerificationResults"]);
  const first = asObj(results[0]);
  return {
    issued: Boolean(first["Issued"]),
    localCheck: asNum(first["LocalCheck"], -1),
    caCheck: asNum(first["CaCheck"], -1),
    failReason: asStr(first["LocalCheckFailReason"]).trim(),
  };
}

export async function downloadTencentCertificateZip(
  env: Env,
  creds: TencentCreds,
  certificateId: string,
): Promise<{ contentBase64: string; contentType: string }> {
  if (isDryRun(env)) {
    const sample = `MOCK-TENCENT-SSL-ZIP:${certificateId}`;
    return {
      contentBase64: btoa(sample),
      contentType: "application/zip",
    };
  }
  const data = await sslRpc(creds, "DownloadCertificate", {
    CertificateId: certificateId,
  });
  const content = asStr(data["Content"]).trim();
  if (!content) {
    throw new Error("腾讯云未返回证书压缩包内容，请确认证书已签发");
  }
  return {
    contentBase64: content,
    contentType: asStr(data["ContentType"], "application/zip"),
  };
}

export async function deleteTencentCertificate(
  env: Env,
  creds: TencentCreds,
  certificateId: string,
): Promise<void> {
  if (isDryRun(env)) {
    drySslStore.delete(certificateId);
    return;
  }
  await sslRpc(creds, "DeleteCertificate", { CertificateId: certificateId });
}

/**
 * Best-effort delete of an obsolete or expired Tencent Cloud SSL certificate.
 * Treats "already missing" as deleted; preserves non-fatal upstream blocks
 * (e.g. `CannotBeDeletedIssued` while an old cert still has days left) so the
 * Cron scheduler can retry automatically once the certificate expires.
 */
async function tryDeleteRemoteCert(
  env: Env,
  creds: TencentCreds,
  certificateId: string,
): Promise<{ deleted: boolean; reason: string }> {
  const id = certificateId.trim();
  if (!id) return { deleted: true, reason: "" };
  try {
    await deleteTencentCertificate(env, creds, id);
    return { deleted: true, reason: "" };
  } catch (err) {
    const code = (err as Error & { tcCode?: string }).tcCode ?? "";
    const msg = err instanceof Error ? err.message : String(err);
    if (
      code === "FailedOperation.CertificateNotFound" ||
      msg.includes("CertificateNotFound") ||
      msg.includes("证书不存在")
    ) {
      return { deleted: true, reason: "already_gone" };
    }
    return { deleted: false, reason: msg };
  }
}

// ---------------------------------------------------------------------------
// Notification helper (uses existing configured channels: Telegram / Email / Webhook)
// ---------------------------------------------------------------------------

async function notifyCertEvent(
  env: Env,
  kind: string,
  title: string,
  lines: string[],
): Promise<void> {
  try {
    const config = await repo.getSettings(env);
    if (notify.enabledChannels(env, config).length === 0) return;
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const body = lines.map((line) => esc(line)).join("\n");
    await notify.sendAll(env, config, {
      kind,
      title,
      titleHtml: `<b>${esc(title)}</b>`,
      body,
    });
  } catch (err) {
    console.warn("SSL certificate notification failed", err);
  }
}

// ---------------------------------------------------------------------------
// High-level Managed Certificate Orchestration
// ---------------------------------------------------------------------------

async function writeDnsValidationIfNeeded(
  env: Env,
  cert: SslCertificateRecord,
  dvAuth: DvAuthInfo,
  forceWrite: boolean,
): Promise<{
  written: boolean;
  recordId: string;
  rootDomain: string;
  zoneId: string;
  action?: string;
}> {
  if (cert.dns_verify_mode !== "dns_account") {
    return {
      written: cert.dns_verify_mode === "tencent_auto",
      recordId: cert.dns_record_id,
      rootDomain: cert.dns_root_domain,
      zoneId: cert.dns_zone_id,
    };
  }
  if (!cert.dns_account_id) {
    throw new Error("证书未绑定自动解析验证用的云解析账号");
  }
  const dnsAccount = await repo.getDnsAccount(env, cert.dns_account_id, true);
  if (!dnsAccount) {
    throw new Error(`绑定的 DNS 账号 #${cert.dns_account_id} 不存在`);
  }

  const sameAuth =
    cert.dns_record_written &&
    cert.dv_auth_value === dvAuth.value &&
    cert.dv_auth_sub_domain === dvAuth.subDomain &&
    cert.dv_auth_type === dvAuth.verifyType;
  if (sameAuth && !forceWrite) {
    return {
      written: true,
      recordId: cert.dns_record_id,
      rootDomain: cert.dns_root_domain,
      zoneId: cert.dns_zone_id,
      action: "unchanged",
    };
  }

  const res = await dnsProviders.upsertValidationRecord(env, dnsAccount, {
    domain: cert.domain,
    rootDomain: cert.dns_root_domain || undefined,
    zoneId: cert.dns_zone_id || undefined,
    subDomain: dvAuth.subDomain,
    fullHost: dvAuth.fullHost,
    type: dvAuth.verifyType,
    value: dvAuth.value,
  });

  return {
    written: true,
    recordId: res.recordId,
    rootDomain: res.rootDomain,
    zoneId: res.zoneId,
    action: res.action,
  };
}

const CLEAR_VALIDATION_DNS_PATCH: Partial<repo.SslCertificateCreateInput> = {
  dns_record_id: "",
  dns_record_written: false,
  dv_auth_domain: "",
  dv_auth_sub_domain: "",
  dv_auth_type: "",
  dv_auth_value: "",
};

function hasPendingValidationDnsCleanup(cert: SslCertificateRecord): boolean {
  return Boolean(cert.dns_record_id || cert.dns_record_written || cert.dv_auth_value);
}

/**
 * Clean up temporary DNS validation records once domain verification has completed
 * or terminated. Supports both explicit `dns_account` bindings (DNSPod/Cloudflare)
 * and `tencent_auto` / imported certs by matching tracked `recordId` and exact
 * `(fullHost, type, value)` against configured DNS accounts.
 */
export async function cleanupManagedValidationDns(
  env: Env,
  cert: SslCertificateRecord,
  dvAuthOverride?: DvAuthInfo | null,
  opts?: { force?: boolean; clearDbState?: boolean },
): Promise<{ cleared: boolean; deletedCount: number }> {
  const clearDbState = opts?.clearDbState !== false;
  if (!opts?.force && !cert.clean_dns_after_issue) {
    return { cleared: false, deletedCount: 0 };
  }

  const dvDomain = (dvAuthOverride?.domain || cert.dv_auth_domain || cert.domain).trim();
  const dvSub = (dvAuthOverride?.subDomain || cert.dv_auth_sub_domain).trim();
  const dvFullHost = (dvAuthOverride?.fullHost ?? "").trim();
  const dvType = (dvAuthOverride?.verifyType || cert.dv_auth_type).trim().toUpperCase();
  const dvValue = (dvAuthOverride?.value || cert.dv_auth_value).trim();

  const hasExactMatch = Boolean(
    dvValue && (dvFullHost || dvSub) && (dvType === "TXT" || dvType === "CNAME"),
  );
  const hasRecordId = Boolean(cert.dns_record_id);

  if (!hasRecordId && !hasExactMatch) {
    // Nothing trackable to delete remotely (e.g. tencent_auto without saved dv_auth);
    // clear stale local written flag if set so Cron doesn't spin.
    if (clearDbState && cert.id > 0 && hasPendingValidationDnsCleanup(cert)) {
      await repo.updateSslCertificate(env, cert.id, CLEAR_VALIDATION_DNS_PATCH);
    }
    return { cleared: true, deletedCount: 0 };
  }

  const match: dnsProviders.ValidationRecordCleanupMatch = {
    domain: dvDomain || cert.domain,
    subDomain: dvSub || undefined,
    fullHost: dvFullHost || undefined,
    type: dvType || undefined,
    value: dvValue || undefined,
  };

  // Build ordered candidate DNS accounts: bound dns_account first, then same tencent
  // account (covers tencent_auto), then any other configured DNS account hosting the domain.
  const candidates: DnsAccountRecord[] = [];
  const seenIds = new Set<number>();
  const pushById = async (accountId: number) => {
    if (!accountId || seenIds.has(accountId)) return;
    seenIds.add(accountId);
    const acct = await repo.getDnsAccount(env, accountId, true);
    if (acct) candidates.push(acct);
  };
  await pushById(cert.dns_account_id);
  await pushById(cert.tencent_account_id);
  if (hasExactMatch) {
    const allAccounts = await repo.listDnsAccounts(env, { decryptSecret: true });
    for (const acct of allAccounts) {
      if (!seenIds.has(acct.id)) {
        seenIds.add(acct.id);
        candidates.push(acct);
      }
    }
  }

  let totalDeleted = 0;
  let foundHostingAccount = false;
  let clearedOnHost = false;

  for (const account of candidates) {
    const isPrimaryBound = cert.dns_account_id > 0 && account.id === cert.dns_account_id;
    const res = await dnsProviders.deleteValidationRecord(
      env,
      account,
      isPrimaryBound ? cert.dns_root_domain : "",
      isPrimaryBound ? cert.dns_zone_id : "",
      isPrimaryBound ? cert.dns_record_id : "",
      match,
    );
    if (res.notHosted) continue;
    foundHostingAccount = true;
    totalDeleted += res.deletedCount;
    if (res.cleared) {
      clearedOnHost = true;
      break;
    }
  }

  // If no configured DNS account hosts this domain (e.g. external manual DNS) and we
  // don't hold an orphaned tracked recordId, clear local tracking cleanly.
  const cleared = clearedOnHost || (!foundHostingAccount && !hasRecordId);
  if (cleared && clearDbState && cert.id > 0 && hasPendingValidationDnsCleanup(cert)) {
    await repo.updateSslCertificate(env, cert.id, CLEAR_VALIDATION_DNS_PATCH);
  }
  return { cleared, deletedCount: totalDeleted };
}

/**
 * Apply a new Tencent Cloud free 443 SSL certificate, persist management state,
 * auto-write DNS validation record (if configured), and trigger CA verification.
 */
export async function applyManagedCertificate(
  env: Env,
  input: ApplyCertRequest,
): Promise<{
  certificate: SslCertificateRecord;
  dnsAction: string;
  verifyTriggered: boolean;
}> {
  const domain = normalizeDomain(input.domain);
  const { creds, tencentAccountId, customSecretId, customSecretKey } =
    await resolveTencentCredsFromInput(env, input);

  let dnsAccount: DnsAccountRecord | null = null;
  let dnsRootDomain = "";
  let dnsZoneId = "";
  if (input.dns_verify_mode === "dns_account") {
    if (!input.dns_account_id) {
      throw new Error("请选择用于自动解析验证的腾讯云 DNSPod 或 Cloudflare 账号");
    }
    dnsAccount = await repo.getDnsAccount(env, input.dns_account_id, true);
    if (!dnsAccount) {
      throw new Error("所选 DNS 解析账号不存在");
    }
    // Pre-verify that the selected DNS account actually hosts this domain's zone
    // before spending a Tencent free certificate quota.
    const resolved = await dnsProviders.resolveDomainZone(env, dnsAccount, domain);
    dnsRootDomain = resolved.rootDomain;
    dnsZoneId = resolved.zoneId;
  }

  const dvMethod: "DNS_AUTO" | "DNS" =
    input.dns_verify_mode === "tencent_auto" ? "DNS_AUTO" : "DNS";
  const encryptAlgo = input.encrypt_algo === "ECC" ? "ECC" : "RSA";
  const cleanDnsAfterIssue = input.clean_dns_after_issue !== false;

  const { certificateId } = await applyTencentCertificate(env, creds, {
    domain,
    dvAuthMethod: dvMethod,
    encryptAlgo,
    deleteDnsAutoRecord: cleanDnsAfterIssue,
    contactEmail: input.contact_email,
    alias: input.remark || `CDT:${domain}`,
  });

  const rowId = await repo.createSslCertificate(env, {
    domain,
    tencent_account_id: tencentAccountId,
    tencent_secret_id: customSecretId,
    tencent_secret_key: customSecretKey,
    dns_verify_mode: input.dns_verify_mode,
    dns_account_id: dnsAccount?.id ?? 0,
    dns_root_domain: dnsRootDomain,
    dns_zone_id: dnsZoneId,
    cert_id: certificateId,
    pending_cert_id: "",
    encrypt_algo: encryptAlgo,
    status: input.dns_verify_mode === "tencent_auto" ? "verifying" : "pending_dns",
    tencent_status: 0,
    status_name: "审核中",
    auto_renew: input.auto_renew !== false,
    renew_before_days: Math.max(1, Math.min(30, input.renew_before_days ?? 7)),
    clean_dns_after_issue: cleanDnsAfterIssue,
    remark: input.remark ?? "",
  });

  await repo.addEvent(env, "ssl", messages.ev("SSL 证书已申请", messages.objServer(domain)), {
    detail: `已向腾讯云提交 443 免费证书申请（ID: ${certificateId}，验证方式：${
      input.dns_verify_mode === "tencent_auto"
        ? "腾讯云同账号 DNS_AUTO"
        : input.dns_verify_mode === "dns_account"
          ? `${dnsAccount?.provider === "cloudflare" ? "Cloudflare" : "腾讯云 DNSPod"} 自动解析`
          : "手动解析"
    }）`,
  });

  // Immediately pull DvAuthDetail, push DNS record, and trigger CompleteCertificate.
  const refreshed = await refreshManagedCertificate(env, rowId, {
    forceWriteDns: true,
    triggerVerify: true,
  });

  return {
    certificate: refreshed.certificate,
    dnsAction: refreshed.dnsAction,
    verifyTriggered: refreshed.verifyTriggered,
  };
}

/**
 * Inspect latest Tencent Cloud certificate state, auto-push DNS validation record
 * if pending, optionally invoke `CompleteCertificate`, and promote issued certs.
 */
export async function refreshManagedCertificate(
  env: Env,
  id: number,
  opts?: { forceWriteDns?: boolean; triggerVerify?: boolean },
): Promise<{
  certificate: SslCertificateRecord;
  dnsAction: string;
  verifyTriggered: boolean;
  justIssued: boolean;
  oldCertDeleted: boolean;
}> {
  const cert = await repo.getSslCertificate(env, id, true);
  if (!cert) throw new Error("证书记录不存在");

  const creds = await resolveTencentCredsForCert(env, cert);
  const isRenewalFlow = Boolean(cert.pending_cert_id);
  const activeCertId = cert.pending_cert_id || cert.cert_id;
  if (!activeCertId) {
    throw new Error("当前记录缺少腾讯云 CertificateId");
  }

  let detail = await describeTencentCertificateDetail(env, creds, activeCertId);
  let dnsAction = "";
  let verifyTriggered = false;
  let justIssued = false;
  let oldCertDeleted = false;
  const checkedAt = nowSeconds();

  const patch: Partial<repo.SslCertificateCreateInput> = {
    tencent_status: detail.status,
    status_name: detail.statusName,
    last_checked_at: checkedAt,
    last_error: "",
  };

  if (detail.dvAuth) {
    patch.dv_auth_domain = detail.dvAuth.domain;
    patch.dv_auth_sub_domain = detail.dvAuth.subDomain;
    patch.dv_auth_type = detail.dvAuth.verifyType;
    patch.dv_auth_value = detail.dvAuth.value;
  }

  // Pending / in-review certificate: push DNS validation record and trigger CA verification.
  if (detail.status === 0 || detail.status === 4) {
    if (detail.dvAuth && cert.dns_verify_mode === "dns_account") {
      try {
        const writeRes = await writeDnsValidationIfNeeded(
          env,
          cert,
          detail.dvAuth,
          Boolean(opts?.forceWriteDns),
        );
        patch.dns_record_written = writeRes.written;
        patch.dns_record_id = writeRes.recordId;
        patch.dns_root_domain = writeRes.rootDomain;
        patch.dns_zone_id = writeRes.zoneId;
        dnsAction = writeRes.action || "";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        patch.last_error = `自动写入验证解析失败：${msg}`;
        patch.status = isRenewalFlow ? cert.status : "pending_dns";
        await repo.updateSslCertificate(env, id, patch);
        const updated = (await repo.getSslCertificate(env, id, false))!;
        return {
          certificate: updated,
          dnsAction: "failed",
          verifyTriggered: false,
          justIssued: false,
          oldCertDeleted: false,
        };
      }
    }

    const shouldTriggerComplete =
      Boolean(opts?.triggerVerify) ||
      dnsAction === "created" ||
      dnsAction === "updated" ||
      (cert.dns_verify_mode === "dns_account" && (patch.dns_record_written || cert.dns_record_written)) ||
      cert.dns_verify_mode === "tencent_auto";

    if (shouldTriggerComplete) {
      try {
        await completeTencentCertificate(env, creds, activeCertId);
        verifyTriggered = true;
        // Re-fetch detail immediately (in dry-run or fast-pass cases it may already be issued).
        detail = await describeTencentCertificateDetail(env, creds, activeCertId);
        patch.tencent_status = detail.status;
        patch.status_name = detail.statusName;
      } catch (err) {
        // Non-fatal: Tencent may return temporary rate-limit or propagation error while DNS settles.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("已验证") && !msg.includes("已签发")) {
          patch.last_error = msg;
        }
      }

      // If still status 0/4 right after CompleteCertificate, check whether CA already issued it.
      if (detail.status === 0 || detail.status === 4) {
        const ver = await checkTencentDomainVerification(env, creds, activeCertId).catch(() => null);
        if (ver?.issued) {
          detail = await describeTencentCertificateDetail(env, creds, activeCertId);
          patch.tencent_status = detail.status;
          patch.status_name = detail.statusName;
        }
      }
    }
  }

  // Now check whether the active cert has transitioned to Issued / Failed / Expired.
  if (detail.status === 1) {
    const wasAlreadyIssuedSameCert = !isRenewalFlow && cert.status === "issued";
    const previousCertId =
      isRenewalFlow && cert.cert_id && cert.cert_id !== activeCertId ? cert.cert_id : "";

    if (isRenewalFlow) {
      patch.cert_id = activeCertId;
      patch.pending_cert_id = "";
      patch.last_renew_at = checkedAt;
    }
    patch.status =
      detail.certEndTs > 0 && detail.certEndTs <= checkedAt ? "expired" : "issued";
    patch.cert_begin_time = detail.certBeginTime;
    patch.cert_end_time = detail.certEndTime;
    patch.cert_end_ts = detail.certEndTs;
    patch.last_error = "";

    await repo.updateSslCertificate(env, id, patch);

    // Cleanup temporary validation DNS record(s) once domain verification & issuance complete.
    let dnsCleanupNote = "";
    const latestWithSecrets = await repo.getSslCertificate(env, id, true);
    if (latestWithSecrets && (hasPendingValidationDnsCleanup(latestWithSecrets) || detail.dvAuth)) {
      const dnsClean = await cleanupManagedValidationDns(env, latestWithSecrets, detail.dvAuth);
      if (dnsClean.deletedCount > 0) {
        dnsCleanupNote = "；已自动删除临时验证解析";
      }
    }

    // Automatically delete the superseded old certificate on Tencent Cloud.
    let oldCleanupNote = "";
    if (previousCertId) {
      const delRes = await tryDeleteRemoteCert(env, creds, previousCertId);
      if (delRes.deleted) {
        oldCertDeleted = true;
        await repo.updateSslCertificate(env, id, { replaced_cert_id: "" });
        oldCleanupNote = `；已自动删除旧证书 ${previousCertId}`;
      } else {
        // Keep the old cert ID queued so Cron automatically retries deletion once Tencent allows it (e.g. after expiry).
        await repo.updateSslCertificate(env, id, { replaced_cert_id: previousCertId });
        oldCleanupNote = `；旧证书 ${previousCertId} 将在到期后由巡检自动删除`;
      }
    }

    // Automatically push the newly issued / renewed certificate to any bound EdgeOne hosts.
    let edgeOneSyncNote = "";
    let npsSyncNote = "";
    if (!wasAlreadyIssuedSameCert || isRenewalFlow) {
      const eoSync = await syncRenewedCertificateToEdgeOne(env, id, activeCertId);
      if (eoSync.notes.length > 0) {
        edgeOneSyncNote = `；${eoSync.notes.join("，")}`;
      }
      const npsSync = await syncRenewedCertificateToNps(env, id, activeCertId, {
        pemOverride:
          detail.certificatePublicKey && detail.certificatePrivateKey
            ? {
                certPem: detail.certificatePublicKey,
                keyPem: detail.certificatePrivateKey,
              }
            : undefined,
      });
      if (npsSync.notes.length > 0) {
        npsSyncNote = `；${npsSync.notes.join("，")}`;
      }
    }

    if (!wasAlreadyIssuedSameCert) {
      justIssued = true;
      const actionTitle = isRenewalFlow ? "SSL 证书自动续签已签发" : "SSL 证书已签发";
      await repo.addEvent(env, "ssl", messages.ev(actionTitle, messages.objServer(cert.domain)), {
        detail: `域名 ${cert.domain} 证书（ID: ${activeCertId}）已签发，有效期至 ${detail.certEndTime || "未知"}${dnsCleanupNote}${oldCleanupNote}${edgeOneSyncNote}${npsSyncNote}`,
      });
      await notifyCertEvent(env, "ssl_issued", `✅ ${actionTitle}：${cert.domain}`, [
        `域名：${cert.domain}`,
        `证书 ID：${activeCertId}`,
        `生效时间：${detail.certBeginTime || "-"}`,
        `到期时间：${detail.certEndTime || "-"}`,
        `下次自动续签：到期前 ${cert.renew_before_days} 天`,
        ...(dnsCleanupNote ? [`验证解析：${dnsCleanupNote.replace(/^；/, "")}`] : []),
        ...(oldCleanupNote ? [`旧证清理：${oldCleanupNote.replace(/^；/, "")}`] : []),
        ...(edgeOneSyncNote ? [`EdgeOne 联动：${edgeOneSyncNote.replace(/^；/, "")}`] : []),
        ...(npsSyncNote ? [`NPS 联动：${npsSyncNote.replace(/^；/, "")}`] : []),
      ]);
    }
  } else if (detail.status === 2 || detail.status === 7 || detail.status === 10) {
    const reason = detail.statusMsg || detail.statusName || "审核未通过";
    patch.last_error = `腾讯云证书审核异常：${reason}`;
    if (isRenewalFlow) {
      // Preserve current issued cert; clear failed pending renewal so next window can retry.
      patch.pending_cert_id = "";
      patch.status =
        cert.cert_end_ts > 0 && cert.cert_end_ts <= checkedAt ? "expired" : "issued";
    } else {
      patch.status = "failed";
    }
    await repo.updateSslCertificate(env, id, patch);

    // Verification terminated/failed: remove any temporary DNS validation record occupation.
    const latestWithSecrets = await repo.getSslCertificate(env, id, true);
    if (latestWithSecrets && (hasPendingValidationDnsCleanup(latestWithSecrets) || detail.dvAuth)) {
      await cleanupManagedValidationDns(env, latestWithSecrets, detail.dvAuth);
    }

    await repo.addEvent(env, "ssl", messages.ev("SSL 证书审核失败", messages.objServer(cert.domain)), {
      level: "error",
      detail: `证书 ${activeCertId}：${reason}`,
    });
    await notifyCertEvent(env, "ssl_failed", `❌ SSL 证书审核失败：${cert.domain}`, [
      `域名：${cert.domain}`,
      `证书 ID：${activeCertId}`,
      `原因：${reason}`,
    ]);
  } else if (detail.status === 3) {
    if (!isRenewalFlow) patch.status = "expired";
    await repo.updateSslCertificate(env, id, patch);
    if (!isRenewalFlow) {
      const latestWithSecrets = await repo.getSslCertificate(env, id, true);
      if (latestWithSecrets && hasPendingValidationDnsCleanup(latestWithSecrets)) {
        await cleanupManagedValidationDns(env, latestWithSecrets, detail.dvAuth);
      }
    }
  } else {
    // Still pending / verifying
    if (!isRenewalFlow) {
      patch.status =
        patch.dns_record_written || cert.dns_record_written || cert.dns_verify_mode === "tencent_auto"
          ? "verifying"
          : "pending_dns";
    }
    await repo.updateSslCertificate(env, id, patch);
  }

  const finalCert = (await repo.getSslCertificate(env, id, false))!;
  return { certificate: finalCert, dnsAction, verifyTriggered, justIssued, oldCertDeleted };
}

/**
 * Start a renewal application for an existing managed certificate, automatically
 * write DNS validation records, and trigger CA verification while keeping the
 * previous `cert_id` active until the new one is issued.
 */
export async function renewManagedCertificate(
  env: Env,
  id: number,
  reason: "auto" | "manual" = "manual",
): Promise<{
  certificate: SslCertificateRecord;
  newCertId: string;
  dnsAction: string;
  verifyTriggered: boolean;
  oldCertDeleted: boolean;
}> {
  const cert = await repo.getSslCertificate(env, id, true);
  if (!cert) throw new Error("证书记录不存在");

  // Clean up any leftover validation DNS record before overwriting tracking fields.
  if (hasPendingValidationDnsCleanup(cert)) {
    await cleanupManagedValidationDns(env, cert, null, { clearDbState: false });
  }

  const creds = await resolveTencentCredsForCert(env, cert);
  const now = nowSeconds();

  // Tencent Cloud `ApplyCertificate` accepts `OldCertificateId` only when the
  // existing certificate is issued, not yet expired, and within 30 days of expiry.
  const canPassOldId =
    Boolean(cert.cert_id) &&
    cert.cert_end_ts > now &&
    cert.cert_end_ts - now <= 30 * 86400;

  const dvMethod: "DNS_AUTO" | "DNS" =
    cert.dns_verify_mode === "tencent_auto" ? "DNS_AUTO" : "DNS";

  const { certificateId } = await applyTencentCertificate(env, creds, {
    domain: cert.domain,
    dvAuthMethod: dvMethod,
    oldCertificateId: canPassOldId ? cert.cert_id : undefined,
    encryptAlgo: cert.encrypt_algo,
    deleteDnsAutoRecord: cert.clean_dns_after_issue,
    alias: cert.remark || `CDT-Renew:${cert.domain}`,
  });

  await repo.updateSslCertificate(env, id, {
    pending_cert_id: certificateId,
    dns_record_written: false,
    dns_record_id: "",
    dv_auth_domain: "",
    dv_auth_sub_domain: "",
    dv_auth_type: "",
    dv_auth_value: "",
    last_renew_at: now,
    last_error: "",
  });

  await repo.addEvent(
    env,
    "ssl",
    messages.ev(
      reason === "auto" ? "SSL 到期前自动续签已发起" : "SSL 手动续签已发起",
      messages.objServer(cert.domain),
    ),
    {
      detail: `域名 ${cert.domain} 已向腾讯云申请新证书（新 ID: ${certificateId}${
        canPassOldId ? `，关联旧证书 ${cert.cert_id}` : ""
      }），即将自动完成 DNS 解析验证`,
    },
  );

  const refreshed = await refreshManagedCertificate(env, id, {
    forceWriteDns: true,
    triggerVerify: true,
  });

  return {
    certificate: refreshed.certificate,
    newCertId: certificateId,
    dnsAction: refreshed.dnsAction,
    verifyTriggered: refreshed.verifyTriggered,
    oldCertDeleted: refreshed.oldCertDeleted,
  };
}

/**
 * Import existing certificates from a configured Tencent Cloud account into
 * local management, while automatically deleting expired or already-superseded
 * old certificates on Tencent Cloud and locally.
 */
export async function syncAccountCertificates(
  env: Env,
  tencentAccountId: number,
  opts?: { dnsVerifyMode?: SslVerifyMode; dnsAccountId?: number; autoRenew?: boolean },
): Promise<{ imported: number; updated: number; cleaned: number; totalRemote: number }> {
  const acct = await repo.getDnsAccount(env, tencentAccountId, true);
  if (!acct || acct.provider !== "tencent") {
    throw new Error("请选择有效的腾讯云账号");
  }
  const creds: TencentCreds = {
    secretId: acct.cred_id,
    secretKey: acct.cred_secret ?? "",
    sourceLabel: acct.label,
  };
  const remoteList = await listTencentCertificates(env, creds, { limit: 100 });
  const now = nowSeconds();
  let imported = 0;
  let updated = 0;
  let cleaned = 0;

  // Determine the latest active issued certificate per domain so older duplicates can be cleaned.
  const latestValidByDomain = new Map<string, { certId: string; endTs: number }>();
  for (const item of remoteList) {
    if (!item.certificateId || !item.domain || item.domain.startsWith("*.")) continue;
    const isValidIssued =
      item.status === 1 && (item.certEndTs === 0 || item.certEndTs > now);
    if (!isValidIssued) continue;
    const cur = latestValidByDomain.get(item.domain);
    if (!cur || item.certEndTs > cur.endTs) {
      latestValidByDomain.set(item.domain, {
        certId: item.certificateId,
        endTs: item.certEndTs,
      });
    }
  }

  for (const item of remoteList) {
    if (!item.certificateId || !item.domain) continue;
    if (item.domain.startsWith("*.")) continue;

    const existing = await repo.getSslCertificateByCertId(env, item.certificateId, false);
    const mappedStatus = mapTencentStatus(item.status, item.certEndTs);
    const isExpired = mappedStatus === "expired";
    const newer = latestValidByDomain.get(item.domain);
    const isSuperseded =
      Boolean(newer) &&
      newer!.certId !== item.certificateId &&
      (item.status === 1 || item.status === 3);

    // Auto-delete expired certificates or old certificates already replaced by a newer issued one.
    if (isExpired || isSuperseded) {
      const keepLocalForPendingRenew = Boolean(existing?.pending_cert_id);
      if (!keepLocalForPendingRenew) {
        const delRes = await tryDeleteRemoteCert(env, creds, item.certificateId);
        if (existing) {
          if (hasPendingValidationDnsCleanup(existing)) {
            await cleanupManagedValidationDns(env, existing, null, { clearDbState: false });
          }
          await repo.deleteSslCertificate(env, existing.id);
        }
        if (delRes.deleted || existing) {
          cleaned += 1;
          await repo.addEvent(
            env,
            "ssl",
            messages.ev(
              isExpired ? "SSL 过期证书已自动删除" : "SSL 旧证书已自动删除",
              messages.objServer(item.domain),
            ),
            {
              detail: `证书 ${item.certificateId}（${
                isExpired ? "已过期" : `已被新证书 ${newer?.certId} 替代`
              }）${delRes.deleted ? "已从腾讯云和面板自动清理" : "已从面板清理"}`,
            },
          );
        }
      }
      continue;
    }

    if (existing) {
      await repo.updateSslCertificate(env, existing.id, {
        tencent_status: item.status,
        status_name: item.statusName,
        status: existing.pending_cert_id ? existing.status : mappedStatus,
        cert_begin_time: item.certBeginTime,
        cert_end_time: item.certEndTime,
        cert_end_ts: item.certEndTs,
        last_checked_at: now,
      });
      if (
        !existing.pending_cert_id &&
        (mappedStatus === "issued" || mappedStatus === "failed") &&
        hasPendingValidationDnsCleanup(existing)
      ) {
        await cleanupManagedValidationDns(env, existing);
      }
      updated += 1;
      continue;
    }
    if (item.status === 7 || item.status === 10 || item.status === 14) continue;

    const verifyMode: SslVerifyMode =
      opts?.dnsVerifyMode ??
      (item.verifyType === "DNS_AUTO" ? "tencent_auto" : "dns_account");
    const dnsAccountId =
      verifyMode === "dns_account"
        ? opts?.dnsAccountId || tencentAccountId
        : 0;

    await repo.createSslCertificate(env, {
      domain: item.domain,
      tencent_account_id: tencentAccountId,
      dns_verify_mode: verifyMode,
      dns_account_id: dnsAccountId,
      cert_id: item.certificateId,
      encrypt_algo: item.encryptAlgorithm.toUpperCase() === "ECC" ? "ECC" : "RSA",
      status: mappedStatus,
      tencent_status: item.status,
      status_name: item.statusName,
      cert_begin_time: item.certBeginTime,
      cert_end_time: item.certEndTime,
      cert_end_ts: item.certEndTs,
      auto_renew: opts?.autoRenew !== false,
      renew_before_days: 7,
      clean_dns_after_issue: true,
      last_checked_at: now,
    });
    imported += 1;
  }

  return { imported, updated, cleaned, totalRemote: remoteList.length };
}

/**
 * Cleanup pass for Cron / manual reconcile:
 * 1. Retry deletion of any queued `replaced_cert_id` left over from a renewal.
 * 2. Delete superseded duplicate rows when the same domain already has a newer valid issued cert.
 * 3. Delete expired certificates (remote Tencent cert + local row) when auto-renew is off or
 *    a newer valid certificate already covers the domain.
 */
async function cleanupObsoleteAndExpiredCertificates(
  env: Env,
  now: number,
): Promise<{ cleaned: number; errors: string[] }> {
  let cleaned = 0;
  const errors: string[] = [];
  const allCerts = await repo.listSslCertificates(env, true);

  // 1. Retry any pending remote deletion of previously replaced old certs.
  for (const cert of allCerts) {
    if (!cert.replaced_cert_id) continue;
    try {
      const creds = await resolveTencentCredsForCert(env, cert);
      const delRes = await tryDeleteRemoteCert(env, creds, cert.replaced_cert_id);
      if (delRes.deleted) {
        const oldId = cert.replaced_cert_id;
        await repo.updateSslCertificate(env, cert.id, { replaced_cert_id: "" });
        cleaned += 1;
        await repo.addEvent(
          env,
          "ssl",
          messages.ev("SSL 旧证书已自动删除", messages.objServer(cert.domain)),
          { detail: `已从腾讯云自动清理续签替换后的旧证书 ${oldId}` },
        );
      }
    } catch (err) {
      errors.push(`${cert.domain} 清理旧证书失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Build map of newest valid issued certificate per domain.
  const bestValidByDomain = new Map<string, SslCertificateRecord>();
  for (const cert of allCerts) {
    const isValidIssued =
      cert.status === "issued" && (cert.cert_end_ts === 0 || cert.cert_end_ts > now);
    if (!isValidIssued) continue;
    const prev = bestValidByDomain.get(cert.domain);
    if (!prev || cert.cert_end_ts > prev.cert_end_ts || (cert.cert_end_ts === prev.cert_end_ts && cert.id > prev.id)) {
      bestValidByDomain.set(cert.domain, cert);
    }
  }

  // 2. Remove superseded old rows and expired rows (without breaking active renewals).
  for (const cert of allCerts) {
    if (cert.pending_cert_id) continue;

    const best = bestValidByDomain.get(cert.domain);
    const isSupersededByNewer = Boolean(best && best.id !== cert.id);
    const isExpired =
      cert.status === "expired" ||
      (cert.cert_end_ts > 0 && cert.cert_end_ts <= now);

    // Delete if superseded by a newer valid cert of the same domain, OR expired without auto-renew.
    const shouldDelete = isSupersededByNewer || (isExpired && !cert.auto_renew);
    if (!shouldDelete) continue;

    if (hasPendingValidationDnsCleanup(cert)) {
      await cleanupManagedValidationDns(env, cert, null, { clearDbState: false });
    }

    let remoteDeleted = false;
    if (cert.cert_id) {
      try {
        const creds = await resolveTencentCredsForCert(env, cert);
        const delRes = await tryDeleteRemoteCert(env, creds, cert.cert_id);
        remoteDeleted = delRes.deleted;
      } catch (err) {
        errors.push(`${cert.domain} 删除远端证书失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await repo.deleteSslCertificate(env, cert.id);
    cleaned += 1;
    await repo.addEvent(
      env,
      "ssl",
      messages.ev(
        isExpired ? "SSL 过期证书已自动删除" : "SSL 旧证书已自动删除",
        messages.objServer(cert.domain),
      ),
      {
        detail: `${cert.domain}（${cert.cert_id || `#${cert.id}`}，${
          isSupersededByNewer ? `已被新证书 ${best?.cert_id} 替代` : "证书已过期"
        }）${remoteDeleted ? "已同步从腾讯云和面板删除" : "已从面板移除"}`,
      },
    );
  }

  return { cleaned, errors };
}

/**
 * Cron reconcile engine invoked from `src/scheduler.ts`:
 * 1. Polls pending/verifying certificates (~every 2 min) to push DNS records,
 *    trigger `CompleteCertificate`, promote issued certs, and delete replaced old certs.
 * 2. Scans `auto_renew = 1` certificates (~every 15 min) expiring within
 *    `renew_before_days` (default 7 days) and automatically re-applies + writes
 *    DNS validation records + verifies them.
 * 3. Automatically deletes expired certificates and superseded old certificates.
 */
export async function reconcileCertificates(
  env: Env,
  opts?: { force?: boolean },
): Promise<ReconcileCertsSummary> {
  const summary: ReconcileCertsSummary = {
    checked: 0,
    issued: 0,
    renewalsStarted: 0,
    dnsWritten: 0,
    cleaned: 0,
    errors: [],
  };
  const force = Boolean(opts?.force);

  const certs = await repo.listSslCertificates(env, false);
  if (certs.length === 0) return summary;

  const now = nowSeconds();
  const verifyAge = force ? VERIFY_POLL_INTERVAL_SECONDS + 1 : await repo.flagAge(env, VERIFY_POLL_FLAG);
  const shouldPollPending = force || verifyAge < 0 || verifyAge >= VERIFY_POLL_INTERVAL_SECONDS;

  const renewAge = force ? RENEW_SCAN_INTERVAL_SECONDS + 1 : await repo.flagAge(env, RENEW_SCAN_FLAG);
  const shouldScanRenewals = force || renewAge < 0 || renewAge >= RENEW_SCAN_INTERVAL_SECONDS;

  if (!shouldPollPending && !shouldScanRenewals) {
    return summary;
  }

  // Phase 1: Advance all in-flight applications & renewals, and retry any lingering
  // temporary DNS validation record cleanups for already-finished certificates.
  if (shouldPollPending) {
    for (const cert of certs) {
      const inFlight =
        Boolean(cert.pending_cert_id) ||
        cert.status === "pending_dns" ||
        cert.status === "verifying";
      if (!inFlight) {
        if (cert.clean_dns_after_issue && hasPendingValidationDnsCleanup(cert)) {
          try {
            const dnsClean = await cleanupManagedValidationDns(env, cert);
            if (dnsClean.deletedCount > 0) {
              summary.cleaned += dnsClean.deletedCount;
              await repo.addEvent(
                env,
                "ssl",
                messages.ev("SSL 临时验证解析已自动清理", messages.objServer(cert.domain)),
                {
                  detail: `证书验证已完成，已自动补删残留验证解析记录（${dnsClean.deletedCount} 条）`,
                },
              );
            }
          } catch (err) {
            summary.errors.push(
              `${cert.domain} 清理验证解析失败: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        continue;
      }
      summary.checked += 1;
      try {
        const res = await refreshManagedCertificate(env, cert.id, {
          forceWriteDns: false,
          triggerVerify: true,
        });
        if (res.dnsAction === "created" || res.dnsAction === "updated") {
          summary.dnsWritten += 1;
        }
        if (res.justIssued) {
          summary.issued += 1;
        }
        if (res.oldCertDeleted) {
          summary.cleaned += 1;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        summary.errors.push(`${cert.domain}: ${msg}`);
        await repo.updateSslCertificate(env, cert.id, {
          last_error: msg,
          last_checked_at: now,
        });
      }
    }
    await repo.clearFlag(env, VERIFY_POLL_FLAG);
    await repo.setFlag(env, VERIFY_POLL_FLAG);
  }

  // Phase 2: Auto-renew certificates expiring within `renew_before_days` (default 7 days).
  if (shouldScanRenewals) {
    const freshCerts = await repo.listSslCertificates(env, false);
    // Skip renewing older duplicate records when the domain already has a newer valid cert.
    const bestValidByDomain = new Map<string, number>();
    for (const c of freshCerts) {
      if (c.status === "issued" && (c.cert_end_ts === 0 || c.cert_end_ts > now)) {
        const cur = bestValidByDomain.get(c.domain) ?? 0;
        if (c.cert_end_ts > cur) bestValidByDomain.set(c.domain, c.cert_end_ts);
      }
    }

    for (const cert of freshCerts) {
      if (!cert.auto_renew) continue;
      if (cert.pending_cert_id) continue; // renewal already in progress
      if (cert.status === "pending_dns" || cert.status === "verifying") continue;
      if (!cert.cert_end_ts || cert.cert_end_ts <= 0) continue;

      const bestEnd = bestValidByDomain.get(cert.domain) ?? 0;
      if (bestEnd > cert.cert_end_ts) continue; // already superseded by a newer cert; Phase 3 will delete it

      const remainingSec = cert.cert_end_ts - now;
      const renewWindowSec = Math.max(1, cert.renew_before_days || 7) * 86400;
      if (remainingSec > renewWindowSec) continue;

      // Cooldown prevents runaway retries if Tencent account hits quota or auth error.
      if (!force && cert.last_renew_at > 0 && now - cert.last_renew_at < RENEW_RETRY_COOLDOWN_SECONDS) {
        continue;
      }

      try {
        const res = await renewManagedCertificate(env, cert.id, "auto");
        summary.renewalsStarted += 1;
        if (res.dnsAction === "created" || res.dnsAction === "updated") {
          summary.dnsWritten += 1;
        }
        if (res.certificate.status === "issued" && res.certificate.cert_id === res.newCertId) {
          summary.issued += 1;
        }
        if (res.oldCertDeleted) {
          summary.cleaned += 1;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        summary.errors.push(`${cert.domain} 自动续签失败: ${msg}`);
        await repo.updateSslCertificate(env, cert.id, {
          last_error: `自动续签失败：${msg}`,
          last_renew_at: now,
          last_checked_at: now,
        });
        await repo.addEvent(
          env,
          "ssl",
          messages.ev("SSL 自动续签失败", messages.objServer(cert.domain)),
          {
            level: "error",
            detail: msg,
          },
        );
        await notifyCertEvent(env, "ssl_renew_failed", `⚠️ SSL 自动续签失败：${cert.domain}`, [
          `域名：${cert.domain}`,
          `错误：${msg}`,
        ]);
      }
    }

    // Phase 3: Automatically delete expired certificates and replaced/superseded old certificates.
    const cleanRes = await cleanupObsoleteAndExpiredCertificates(env, now);
    summary.cleaned += cleanRes.cleaned;
    summary.errors.push(...cleanRes.errors);

    await repo.clearFlag(env, RENEW_SCAN_FLAG);
    await repo.setFlag(env, RENEW_SCAN_FLAG);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// EdgeOne CDN Expiring-Certificate Auto-Apply & Auto-Replacement Engine
// ---------------------------------------------------------------------------

export interface EdgeOneAutoCertActionResult {
  domain: string;
  action: "replaced" | "applied" | "renewed" | "pending" | "skipped";
  deployed: boolean;
  certId?: string;
  sslCertRowId?: number;
  detail: string;
}

export interface ReconcileEdgeOneCertsSummary {
  enabled: boolean;
  days: number;
  scannedScopes: number;
  scannedDomains: number;
  expiringFound: number;
  replaced: number;
  applied: number;
  renewed: number;
  pending: number;
  skipped: number;
  results: EdgeOneAutoCertActionResult[];
  errors: string[];
}

interface EdgeOneScanCaches {
  dnsAccounts?: DnsAccountRecord[];
  dnsDomainsByAccount: Map<number, dnsProviders.CloudDnsDomain[]>;
  remoteCertsByAccount: Map<number, TencentCertSummary[]>;
}

function createScanCaches(): EdgeOneScanCaches {
  return {
    dnsDomainsByAccount: new Map(),
    remoteCertsByAccount: new Map(),
  };
}

/**
 * Inspect the EdgeOne host's currently attached edge certificates and return
 * the latest effective expiry timestamp plus whether a deployment is already
 * in progress on Tencent Cloud's side.
 */
function inspectEdgeHostCertState(domain: EdgeOneDomain): {
  deploying: boolean;
  primaryCertId: string;
  maxExpireTs: number;
} {
  let deploying = false;
  let primaryCertId = "";
  let maxExpireTs = 0;

  for (const c of domain.certificates) {
    const st = (c.status || "").toLowerCase();
    if (st === "deploying" || st === "processing") {
      deploying = true;
    }
    const expTs = parseTencentTimeToEpoch(c.expireTime || "");
    if (!primaryCertId && c.certId) {
      primaryCertId = c.certId;
      maxExpireTs = expTs;
    } else if (expTs > maxExpireTs) {
      maxExpireTs = expTs;
      if (c.certId) primaryCertId = c.certId;
    }
  }
  return { deploying, primaryCertId, maxExpireTs };
}

/**
 * Automatically locate the best DNS verification mode and account for a domain
 * across all saved Tencent DNSPod and Cloudflare accounts in the panel.
 * Falls back to `tencent_auto` (same-account DNS_AUTO) if no hosted zone matches.
 */
async function autoDetectDnsVerifyForDomain(
  env: Env,
  tencentAccountId: number,
  domain: string,
  caches: EdgeOneScanCaches,
  explicit?: { dnsVerifyMode?: SslVerifyMode; dnsAccountId?: number },
): Promise<{ mode: SslVerifyMode; dnsAccountId: number }> {
  if (explicit?.dnsVerifyMode) {
    return {
      mode: explicit.dnsVerifyMode,
      dnsAccountId:
        explicit.dnsVerifyMode === "dns_account"
          ? explicit.dnsAccountId || tencentAccountId
          : 0,
    };
  }
  if (explicit?.dnsAccountId && explicit.dnsAccountId > 0) {
    return { mode: "dns_account", dnsAccountId: explicit.dnsAccountId };
  }

  if (!caches.dnsAccounts) {
    caches.dnsAccounts = await repo.listDnsAccounts(env, { decryptSecret: true });
  }

  // Prefer the same Tencent account first, then other Tencent DNSPod accounts, then Cloudflare.
  const ordered = [...caches.dnsAccounts].sort((a, b) => {
    const score = (x: DnsAccountRecord) =>
      x.id === tencentAccountId ? 0 : x.provider === "tencent" ? 1 : 2;
    return score(a) - score(b);
  });

  const cleanTarget = domain.trim().toLowerCase().replace(/\.+$/, "");
  let bestMatch: { accountId: number; rootLen: number } | null = null;

  for (const acct of ordered) {
    let domains = caches.dnsDomainsByAccount.get(acct.id);
    if (!domains) {
      try {
        domains = await dnsProviders.listDomains(env, acct);
      } catch {
        domains = [];
      }
      caches.dnsDomainsByAccount.set(acct.id, domains);
    }
    for (const item of domains) {
      const candidate = item.name.trim().toLowerCase().replace(/\.+$/, "");
      if (!candidate) continue;
      if (cleanTarget === candidate || cleanTarget.endsWith(`.${candidate}`)) {
        if (!bestMatch || candidate.length > bestMatch.rootLen) {
          bestMatch = { accountId: acct.id, rootLen: candidate.length };
        }
      }
    }
    // Exact or same-account match found immediately; keep checking only if not same account.
    if (bestMatch && bestMatch.accountId === tencentAccountId) break;
  }

  if (bestMatch) {
    return { mode: "dns_account", dnsAccountId: bestMatch.accountId };
  }
  if (isDryRun(env) && tencentAccountId > 0) {
    return { mode: "dns_account", dnsAccountId: tencentAccountId };
  }
  return { mode: "tencent_auto", dnsAccountId: 0 };
}

async function getCachedRemoteTencentCerts(
  env: Env,
  tencentAccountId: number,
  creds: TencentCreds,
  caches: EdgeOneScanCaches,
): Promise<TencentCertSummary[]> {
  let list = caches.remoteCertsByAccount.get(tencentAccountId);
  if (list) return list;
  try {
    list = await listTencentCertificates(env, creds, { limit: 100 });
  } catch {
    list = [];
  }
  caches.remoteCertsByAccount.set(tencentAccountId, list);
  return list;
}

/**
 * Ensure a single EdgeOne acceleration domain has a healthy SSL certificate
 * (> threshold days remaining) by reusing/deploying an existing valid cert,
 * renewing a managed cert, importing a valid remote Tencent cert, or applying
 * a brand-new free DV certificate with automated DNS validation and binding it
 * for automatic edge deployment upon issuance.
 */
export async function ensureEdgeOneDomainCert(
  env: Env,
  params: {
    accountId: number;
    site: EdgeOneSite;
    zoneId: string;
    zoneName: string;
    domain: string;
    oldEdgeCertId?: string;
    oldEdgeCertMode?: string;
    thresholdDays?: number;
    force?: boolean;
    dnsVerifyMode?: SslVerifyMode;
    dnsAccountId?: number;
    reason?: "auto" | "manual";
  },
  caches: EdgeOneScanCaches = createScanCaches(),
): Promise<EdgeOneAutoCertActionResult> {
  const domain = params.domain.trim().toLowerCase();
  const reason = params.reason ?? (params.force ? "manual" : "auto");
  const thresholdDays = Math.max(1, Math.min(30, Math.trunc(params.thresholdDays ?? 7)));
  const thresholdSec = thresholdDays * 86400;
  const now = nowSeconds();
  const oldEdgeCertId = (params.oldEdgeCertId ?? "").trim();
  const oldEdgeCertMode = (params.oldEdgeCertMode ?? "").trim().toLowerCase();

  if (!domain || domain.startsWith("*.")) {
    return {
      domain,
      action: "skipped",
      deployed: false,
      detail: "泛域名不支持腾讯云免费 DV 证书自动申请，请手动配置证书或使用 EdgeOne 免费证书",
    };
  }

  const eoCreds = await resolveEdgeOneCreds(env, params.accountId, params.site);
  const sslCreds: TencentCreds = {
    secretId: eoCreds.secretId,
    secretKey: eoCreds.secretKey,
    sourceLabel: eoCreds.label,
  };

  // Helper to mark superseded external sslcert for cleanup ONLY AFTER replacement succeeds.
  const queueOldEdgeCertCleanup = async (sslRowId: number, newCertId: string) => {
    if (oldEdgeCertMode !== "sslcert" || !oldEdgeCertId || oldEdgeCertId === newCertId) {
      return;
    }
    const row = await repo.getSslCertificate(env, sslRowId, false);
    if (row && !row.replaced_cert_id) {
      await repo.updateSslCertificate(env, sslRowId, { replaced_cert_id: oldEdgeCertId });
    }
  };

  const allManaged = await repo.listSslCertificates(env, false);
  const sameDomainCerts = allManaged.filter(
    (c) =>
      c.domain.toLowerCase() === domain &&
      c.tencent_account_id === params.accountId,
  );

  // 1. Reuse an already-issued healthy local managed cert (> thresholdDays remaining).
  const healthyManaged = sameDomainCerts
    .filter(
      (c) =>
        c.status === "issued" &&
        Boolean(c.cert_id) &&
        c.cert_id !== oldEdgeCertId &&
        c.cert_end_ts > now + thresholdSec,
    )
    .sort((a, b) => b.cert_end_ts - a.cert_end_ts)[0];

  if (healthyManaged) {
    await modifyHostsCertificate(
      env,
      eoCreds,
      params.zoneId,
      [domain],
      "sslcert",
      healthyManaged.cert_id,
    );
    await repo.upsertEdgeOneCertBinding(env, {
      ssl_cert_id: healthyManaged.id,
      tencent_account_id: params.accountId,
      site: params.site,
      zone_id: params.zoneId,
      zone_name: params.zoneName,
      domain,
      last_deployed_cert_id: healthyManaged.cert_id,
      last_deployed_at: now,
      last_error: "",
    });
    if (!healthyManaged.auto_renew || healthyManaged.renew_before_days < thresholdDays) {
      await repo.updateSslCertificate(env, healthyManaged.id, {
        auto_renew: true,
        renew_before_days: Math.max(healthyManaged.renew_before_days || 7, thresholdDays),
      });
    }
    await queueOldEdgeCertCleanup(healthyManaged.id, healthyManaged.cert_id);
    await repo.addEvent(
      env,
      "ssl",
      messages.ev("EdgeOne 临期证书已自动替换", messages.objServer(domain)),
      {
        detail: `已复用面板有效证书 ${healthyManaged.cert_id} 替换 EdgeOne 证书（原证书 ${oldEdgeCertId || "无"}），并开启续签自动同步`,
      },
    );
    await notifyCertEvent(env, "ssl_issued", `✅ EdgeOne 证书已自动替换：${domain}`, [
      `域名：${domain}`,
      `站点：${params.zoneName || params.zoneId}`,
      `新证书 ID：${healthyManaged.cert_id}`,
      `有效期至：${healthyManaged.cert_end_time || "-"}`,
    ]);
    return {
      domain,
      action: "replaced",
      deployed: true,
      certId: healthyManaged.cert_id,
      sslCertRowId: healthyManaged.id,
      detail: `已复用有效证书 ${healthyManaged.cert_id} 自动替换并开启续签联动`,
    };
  }

  // 2. If there is already an in-flight application/renewal for this domain, bind it and advance verification.
  const inFlightManaged = sameDomainCerts.find(
    (c) =>
      Boolean(c.pending_cert_id) ||
      c.status === "pending_dns" ||
      c.status === "verifying",
  );
  if (inFlightManaged) {
    const binding = await repo.upsertEdgeOneCertBinding(env, {
      ssl_cert_id: inFlightManaged.id,
      tencent_account_id: params.accountId,
      site: params.site,
      zone_id: params.zoneId,
      zone_name: params.zoneName,
      domain,
      last_deployed_cert_id: oldEdgeCertId,
      last_deployed_at: 0,
      last_error: "",
    });
    const refreshed = await refreshManagedCertificate(env, inFlightManaged.id, {
      forceWriteDns: false,
      triggerVerify: true,
    });
    const finalCert = refreshed.certificate;
    if (finalCert.status === "issued" && finalCert.cert_id && finalCert.cert_id !== oldEdgeCertId) {
      // Ensure it is deployed on EdgeOne even if refreshManagedCertificate didn't consider it justIssued.
      const latestBinding = await repo.getEdgeOneCertBinding(env, binding.id);
      if (!latestBinding || latestBinding.last_deployed_cert_id !== finalCert.cert_id) {
        await deployBindingNow(env, binding, finalCert.cert_id);
      }
      await queueOldEdgeCertCleanup(finalCert.id, finalCert.cert_id);
      return {
        domain,
        action: "replaced",
        deployed: true,
        certId: finalCert.cert_id,
        sslCertRowId: finalCert.id,
        detail: `在途证书 ${finalCert.cert_id} 已签发并自动替换到 EdgeOne`,
      };
    }
    return {
      domain,
      action: "pending",
      deployed: false,
      certId: finalCert.pending_cert_id || finalCert.cert_id,
      sslCertRowId: finalCert.id,
      detail: `已有证书 ${finalCert.pending_cert_id || finalCert.cert_id} 正在验证签发，已绑定签发后自动替换`,
    };
  }

  // 3. Check Tencent Cloud remote SSL list for an already-issued healthy certificate we can import & deploy directly.
  const remoteCerts = await getCachedRemoteTencentCerts(env, params.accountId, sslCreds, caches);
  const healthyRemote = remoteCerts
    .filter(
      (r) =>
        r.domain.toLowerCase() === domain &&
        r.status === 1 &&
        Boolean(r.certificateId) &&
        r.certificateId !== oldEdgeCertId &&
        r.certEndTs > now + thresholdSec,
    )
    .sort((a, b) => b.certEndTs - a.certEndTs)[0];

  if (healthyRemote) {
    const verify = await autoDetectDnsVerifyForDomain(env, params.accountId, domain, caches, {
      dnsVerifyMode: params.dnsVerifyMode,
      dnsAccountId: params.dnsAccountId,
    });
    let row = await repo.getSslCertificateByCertId(env, healthyRemote.certificateId, false);
    let rowId = row?.id ?? 0;
    if (!row) {
      rowId = await repo.createSslCertificate(env, {
        domain,
        tencent_account_id: params.accountId,
        dns_verify_mode: verify.mode,
        dns_account_id: verify.dnsAccountId,
        cert_id: healthyRemote.certificateId,
        encrypt_algo: healthyRemote.encryptAlgorithm.toUpperCase() === "ECC" ? "ECC" : "RSA",
        status: "issued",
        tencent_status: healthyRemote.status,
        status_name: healthyRemote.statusName || "已颁发",
        cert_begin_time: healthyRemote.certBeginTime,
        cert_end_time: healthyRemote.certEndTime,
        cert_end_ts: healthyRemote.certEndTs,
        auto_renew: true,
        renew_before_days: thresholdDays,
        clean_dns_after_issue: true,
        remark: "EdgeOne 自动导入复用",
        last_checked_at: now,
      });
    }
    await modifyHostsCertificate(
      env,
      eoCreds,
      params.zoneId,
      [domain],
      "sslcert",
      healthyRemote.certificateId,
    );
    await repo.upsertEdgeOneCertBinding(env, {
      ssl_cert_id: rowId,
      tencent_account_id: params.accountId,
      site: params.site,
      zone_id: params.zoneId,
      zone_name: params.zoneName,
      domain,
      last_deployed_cert_id: healthyRemote.certificateId,
      last_deployed_at: now,
      last_error: "",
    });
    await queueOldEdgeCertCleanup(rowId, healthyRemote.certificateId);
    await repo.addEvent(
      env,
      "ssl",
      messages.ev("EdgeOne 临期证书已自动替换", messages.objServer(domain)),
      {
        detail: `已从腾讯云 SSL 导入并部署现有有效证书 ${healthyRemote.certificateId}，替代临期证书 ${oldEdgeCertId || "无"}`,
      },
    );
    return {
      domain,
      action: "replaced",
      deployed: true,
      certId: healthyRemote.certificateId,
      sslCertRowId: rowId,
      detail: `已复用腾讯云账号内有效证书 ${healthyRemote.certificateId} 并自动替换`,
    };
  }

  // 4. If a managed cert already exists locally for this domain (expiring/expired/failed), bind and renew it.
  const renewableManaged = sameDomainCerts
    .slice()
    .sort((a, b) => b.cert_end_ts - a.cert_end_ts || b.id - a.id)[0];

  if (renewableManaged) {
    if (
      !params.force &&
      renewableManaged.last_renew_at > 0 &&
      now - renewableManaged.last_renew_at < RENEW_RETRY_COOLDOWN_SECONDS
    ) {
      return {
        domain,
        action: "skipped",
        deployed: false,
        sslCertRowId: renewableManaged.id,
        detail: "6 小时内已尝试过自动续签，等待冷却结束或手动触发",
      };
    }

    // Upgrade manual DNS verification to automated DNS account / DNS_AUTO if possible.
    const patch: Partial<repo.SslCertificateCreateInput> = {
      auto_renew: true,
      renew_before_days: Math.max(renewableManaged.renew_before_days || 7, thresholdDays),
    };
    if (renewableManaged.dns_verify_mode === "manual" || params.dnsVerifyMode || params.dnsAccountId) {
      const verify = await autoDetectDnsVerifyForDomain(env, params.accountId, domain, caches, {
        dnsVerifyMode: params.dnsVerifyMode,
        dnsAccountId: params.dnsAccountId,
      });
      patch.dns_verify_mode = verify.mode;
      patch.dns_account_id = verify.dnsAccountId;
    }
    await repo.updateSslCertificate(env, renewableManaged.id, patch);

    // Bind BEFORE renewing so immediate issuance inside renewManagedCertificate auto-pushes to EdgeOne.
    const binding = await repo.upsertEdgeOneCertBinding(env, {
      ssl_cert_id: renewableManaged.id,
      tencent_account_id: params.accountId,
      site: params.site,
      zone_id: params.zoneId,
      zone_name: params.zoneName,
      domain,
      last_deployed_cert_id: oldEdgeCertId,
      last_deployed_at: 0,
      last_error: "",
    });

    const renewed = await renewManagedCertificate(env, renewableManaged.id, reason);
    const issuedNow =
      renewed.certificate.status === "issued" &&
      renewed.certificate.cert_id === renewed.newCertId;

    if (issuedNow) {
      const latestBinding = await repo.getEdgeOneCertBinding(env, binding.id);
      if (!latestBinding || latestBinding.last_deployed_cert_id !== renewed.newCertId) {
        await deployBindingNow(env, binding, renewed.newCertId);
      }
      await queueOldEdgeCertCleanup(renewableManaged.id, renewed.newCertId);
    }

    return {
      domain,
      action: issuedNow ? "replaced" : "renewed",
      deployed: issuedNow,
      certId: renewed.newCertId,
      sslCertRowId: renewableManaged.id,
      detail: issuedNow
        ? `已自动续签新证书 ${renewed.newCertId} 并替换至 EdgeOne`
        : `已发起自动续签（新证书 ${renewed.newCertId}），签发后将自动替换至 EdgeOne`,
    };
  }

  // 5. No local or healthy remote cert exists: automatically apply a new free 443 DV cert.
  const cooldownFlag = `eo_auto_apply:${params.accountId}:${domain}`;
  if (!params.force) {
    const age = await repo.flagAge(env, cooldownFlag);
    if (age >= 0 && age < RENEW_RETRY_COOLDOWN_SECONDS) {
      return {
        domain,
        action: "skipped",
        deployed: false,
        detail: "6 小时内已尝试过自动申请，等待下次巡检或手动触发",
      };
    }
  }

  const verify = await autoDetectDnsVerifyForDomain(env, params.accountId, domain, caches, {
    dnsVerifyMode: params.dnsVerifyMode,
    dnsAccountId: params.dnsAccountId,
  });

  await repo.clearFlag(env, cooldownFlag);
  await repo.setFlag(env, cooldownFlag);

  const applied = await applyManagedCertificate(env, {
    domain,
    tencent_account_id: params.accountId,
    dns_verify_mode: verify.mode,
    dns_account_id: verify.dnsAccountId,
    encrypt_algo: "RSA",
    auto_renew: true,
    renew_before_days: thresholdDays,
    clean_dns_after_issue: true,
    remark: `EdgeOne 自动申请 (${params.zoneName || params.zoneId})`,
  });

  const issuedNow =
    applied.certificate.status === "issued" && Boolean(applied.certificate.cert_id);

  if (issuedNow) {
    await modifyHostsCertificate(
      env,
      eoCreds,
      params.zoneId,
      [domain],
      "sslcert",
      applied.certificate.cert_id,
    );
    await repo.upsertEdgeOneCertBinding(env, {
      ssl_cert_id: applied.certificate.id,
      tencent_account_id: params.accountId,
      site: params.site,
      zone_id: params.zoneId,
      zone_name: params.zoneName,
      domain,
      last_deployed_cert_id: applied.certificate.cert_id,
      last_deployed_at: now,
      last_error: "",
    });
    await queueOldEdgeCertCleanup(applied.certificate.id, applied.certificate.cert_id);
    await repo.addEvent(
      env,
      "ssl",
      messages.ev("EdgeOne 临期证书已自动申请并替换", messages.objServer(domain)),
      {
        detail: `已为 EdgeOne 域名自动申请免费证书 ${applied.certificate.cert_id} 并完成替换（原证书 ${oldEdgeCertId || "无"}），后续到期前 ${thresholdDays} 天将继续自动续签同步`,
      },
    );
    await notifyCertEvent(env, "ssl_issued", `✅ EdgeOne 证书已自动申请并替换：${domain}`, [
      `域名：${domain}`,
      `站点：${params.zoneName || params.zoneId}`,
      `新证书 ID：${applied.certificate.cert_id}`,
      `有效期至：${applied.certificate.cert_end_time || "-"}`,
      `续签策略：到期前 ${thresholdDays} 天自动续签并同步 EdgeOne`,
    ]);
    return {
      domain,
      action: "applied",
      deployed: true,
      certId: applied.certificate.cert_id,
      sslCertRowId: applied.certificate.id,
      detail: `已自动申请新证书 ${applied.certificate.cert_id} 并替换至 EdgeOne`,
    };
  }

  // Still verifying/pending: create binding now so 2-min SSL Cron pushes it automatically upon issuance.
  await repo.upsertEdgeOneCertBinding(env, {
    ssl_cert_id: applied.certificate.id,
    tencent_account_id: params.accountId,
    site: params.site,
    zone_id: params.zoneId,
    zone_name: params.zoneName,
    domain,
    last_deployed_cert_id: oldEdgeCertId,
    last_deployed_at: 0,
    last_error: "",
  });

  await repo.addEvent(
    env,
    "ssl",
    messages.ev("EdgeOne 临期证书已发起自动申请", messages.objServer(domain)),
    {
      detail: `检测到 EdgeOne 域名证书临期（≤ ${thresholdDays} 天），已自动申请证书 ${applied.certificate.cert_id} 并绑定签发后自动替换`,
    },
  );

  return {
    domain,
    action: "applied",
    deployed: false,
    certId: applied.certificate.cert_id,
    sslCertRowId: applied.certificate.id,
    detail: `已自动提交免费证书申请（${applied.certificate.cert_id}），验证签发后将自动替换至 EdgeOne`,
  };
}

/**
 * Scheduled & on-demand EdgeOne certificate audit engine:
 * Scans active EdgeOne zones/domains (every ~30 min in Cron, or immediately when
 * `force: true`). Whenever an online non-wildcard CDN domain's edge certificate
 * is expired or expiring within `days` (default 7), automatically replaces it
 * with an existing valid cert or applies a new free SSL cert and binds it for
 * automatic deployment and future renewals.
 */
export async function reconcileEdgeOneCertificates(
  env: Env,
  opts?: {
    force?: boolean;
    accountId?: number;
    site?: EdgeOneSite;
    zoneId?: string;
  },
): Promise<ReconcileEdgeOneCertsSummary> {
  const force = Boolean(opts?.force);
  const cfg = await getEdgeOneAutoCertConfig(env);
  const summary: ReconcileEdgeOneCertsSummary = {
    enabled: cfg.enabled,
    days: cfg.days,
    scannedScopes: 0,
    scannedDomains: 0,
    expiringFound: 0,
    replaced: 0,
    applied: 0,
    renewed: 0,
    pending: 0,
    skipped: 0,
    results: [],
    errors: [],
  };

  if (!force && !cfg.enabled) {
    return summary;
  }

  if (!force) {
    const age = await repo.flagAge(env, EO_CERT_SCAN_FLAG);
    if (age >= 0 && age < EO_CERT_SCAN_INTERVAL_SECONDS) {
      return summary;
    }
  }

  // Build deduplicated list of (accountId, site) scopes to audit.
  const scopeList: Array<{ accountId: number; site: EdgeOneSite }> = [];
  const scopeSeen = new Set<string>();
  const addScope = (accountId: number, site: EdgeOneSite) => {
    if (!Number.isFinite(accountId) || accountId <= 0) return;
    const cleanSite = normalizeEdgeOneSite(site);
    const key = `${accountId}:${cleanSite}`;
    if (scopeSeen.has(key)) return;
    scopeSeen.add(key);
    scopeList.push({ accountId, site: cleanSite });
  };

  if (opts?.accountId && opts.accountId > 0) {
    addScope(opts.accountId, normalizeEdgeOneSite(opts.site));
  } else {
    const [watched, bindings, tencentAccounts] = await Promise.all([
      listWatchedEdgeOneScopes(env),
      repo.listEdgeOneCertBindings(env),
      repo.listDnsAccounts(env, { provider: "tencent", decryptSecret: false }),
    ]);
    const accountsWithKnownScope = new Set<number>();
    for (const s of watched) {
      addScope(s.accountId, s.site);
      accountsWithKnownScope.add(s.accountId);
    }
    for (const b of bindings) {
      addScope(b.tencent_account_id, b.site);
      accountsWithKnownScope.add(b.tencent_account_id);
    }
    // For Tencent accounts never opened in the CDN UI yet, probe cn & intl once;
    // any site that returns real zones will be remembered automatically.
    for (const acct of tencentAccounts) {
      if (!accountsWithKnownScope.has(acct.id)) {
        addScope(acct.id, "cn");
        addScope(acct.id, "intl");
      }
    }
  }

  if (scopeList.length === 0) {
    return summary;
  }

  const now = nowSeconds();
  const thresholdSec = cfg.days * 86400;
  const caches = createScanCaches();
  const allManaged = await repo.listSslCertificates(env, false);
  const managedById = new Map(allManaged.map((c) => [c.id, c]));

  for (const scope of scopeList) {
    let creds;
    try {
      creds = await resolveEdgeOneCreds(env, scope.accountId, scope.site);
    } catch {
      continue;
    }

    let zones;
    try {
      zones = await listZones(env, creds);
    } catch (err) {
      if (force && opts?.accountId) {
        summary.errors.push(
          `读取 EdgeOne 站点失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      continue;
    }

    if (zones.length === 0) continue;
    summary.scannedScopes += 1;
    await recordWatchedEdgeOneScope(env, scope.accountId, scope.site);

    const targetZones = opts?.zoneId
      ? zones.filter((z) => z.zoneId === opts.zoneId)
      : zones;

    for (const zone of targetZones) {
      if (zone.paused) continue;
      let domains: EdgeOneDomain[];
      let bindings: repo.EdgeOneCertBindingRecord[];
      try {
        [domains, bindings] = await Promise.all([
          listAccelerationDomains(env, creds, zone.zoneId),
          repo.listEdgeOneCertBindings(env, {
            tencentAccountId: scope.accountId,
            site: scope.site,
            zoneId: zone.zoneId,
          }),
        ]);
      } catch (err) {
        summary.errors.push(
          `站点 ${zone.zoneName || zone.zoneId} 获取域名失败: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }

      const bindingByHost = new Map(
        bindings.map((b) => [b.domain.toLowerCase(), b]),
      );

      for (const dom of domains) {
        summary.scannedDomains += 1;
        if (dom.domainStatus !== "online") continue;
        if (dom.domainName.startsWith("*.")) continue;

        const hostKey = dom.domainName.toLowerCase();
        const edgeState = inspectEdgeHostCertState(dom);
        if (edgeState.deploying) continue;

        const existingBinding = bindingByHost.get(hostKey) ?? null;

        // First: if already bound to a managed cert whose issued cert_id is newer than
        // what is currently deployed on EdgeOne, sync it immediately even if > 7 days left.
        if (existingBinding) {
          const boundCert = managedById.get(existingBinding.ssl_cert_id);
          if (
            boundCert &&
            boundCert.status === "issued" &&
            boundCert.cert_id &&
            boundCert.cert_id !== edgeState.primaryCertId &&
            boundCert.cert_end_ts > Math.max(now, edgeState.maxExpireTs)
          ) {
            try {
              await deployBindingNow(env, existingBinding, boundCert.cert_id);
              summary.replaced += 1;
              summary.results.push({
                domain: dom.domainName,
                action: "replaced",
                deployed: true,
                certId: boundCert.cert_id,
                sslCertRowId: boundCert.id,
                detail: `已将已签发的新托管证书 ${boundCert.cert_id} 补推部署到 EdgeOne`,
              });
              continue;
            } catch (err) {
              summary.errors.push(
                `${dom.domainName} 补推证书失败: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }
        }

        // Check whether edge certificate is expired or expiring within threshold days (default 7).
        const isSslCertMode = dom.certMode === "sslcert";
        const isFreeCertMode = dom.certMode === "eofreecert";
        if (!isSslCertMode && !isFreeCertMode) continue;

        const isExpiring = isSslCertMode
          ? edgeState.maxExpireTs === 0 || edgeState.maxExpireTs <= now + thresholdSec
          : edgeState.maxExpireTs > 0 && edgeState.maxExpireTs <= now + thresholdSec;

        if (!isExpiring) continue;
        summary.expiringFound += 1;

        try {
          const res = await ensureEdgeOneDomainCert(
            env,
            {
              accountId: scope.accountId,
              site: scope.site,
              zoneId: zone.zoneId,
              zoneName: zone.zoneName,
              domain: dom.domainName,
              oldEdgeCertId: edgeState.primaryCertId,
              oldEdgeCertMode: dom.certMode,
              thresholdDays: cfg.days,
              force,
              reason: force ? "manual" : "auto",
            },
            caches,
          );
          summary.results.push(res);
          if (res.action === "replaced") summary.replaced += 1;
          else if (res.action === "applied") {
            summary.applied += 1;
            if (res.deployed) summary.replaced += 1;
          } else if (res.action === "renewed") summary.renewed += 1;
          else if (res.action === "pending") summary.pending += 1;
          else summary.skipped += 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          summary.errors.push(`${dom.domainName}: ${msg}`);
          await repo.addEvent(
            env,
            "ssl",
            messages.ev("EdgeOne 临期证书自动处理失败", messages.objServer(dom.domainName)),
            { level: "error", detail: msg },
          );
        }
      }
    }
  }

  if (!opts?.accountId) {
    await repo.clearFlag(env, EO_CERT_SCAN_FLAG);
    await repo.setFlag(env, EO_CERT_SCAN_FLAG);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// NPS Host Certificate Automation & EdgeOne CDN Cross-Sync
// ---------------------------------------------------------------------------

export interface NpsCertSyncResult {
  synced: number;
  failed: number;
  cdnSynced: number;
  cdnFailed: number;
  notes: string[];
}

export interface EnsureNpsHostCertParams {
  npsServerId: number;
  npsHostId: number;
  sslCertId?: number;
  tencentAccountId?: number;
  dnsVerifyMode?: SslVerifyMode;
  dnsAccountId?: number;
  syncCdn?: boolean;
  autoHttps?: boolean;
  renewBeforeDays?: number;
}

export interface EnsureNpsHostCertResult {
  domain: string;
  action: "bound_and_deployed" | "applied" | "renewed" | "pending";
  deployedToNps: boolean;
  certId: string;
  sslCertRowId: number;
  binding: NpsCertBindingRecord;
  cdnSynced: number;
  cdnNotes: string[];
  detail: string;
}

export interface ReconcileNpsCertsSummary {
  checked: number;
  synced: number;
  failed: number;
  cdnSynced: number;
  errors: string[];
}

/**
 * Push a freshly issued or bound Tencent SSL certificate (`certId`) to every
 * matching EdgeOne CDN acceleration domain for `domain`:
 * 1) Any existing `edgeone_cert_bindings` row for the same domain (re-linking
 *    `ssl_cert_id` if needed, skipping bindings already deployed with `certId`
 *    unless `force` is set);
 * 2) Any active EdgeOne acceleration domain on the certificate's Tencent Cloud
 *    account (cn/intl) whose `domainName` matches `domain`, automatically
 *    creating an `edgeone_cert_bindings` record so future 7-day renewals stay
 *    synchronized automatically.
 */
async function syncDomainCertToMatchingEdgeOne(
  env: Env,
  sslCertId: number,
  certId: string,
  domainRaw: string,
  opts?: {
    preferredTencentAccountId?: number;
    force?: boolean;
  },
): Promise<{ synced: number; failed: number; matched: number; notes: string[] }> {
  const domain = domainRaw.trim().toLowerCase().replace(/\.+$/, "");
  const cleanCertId = certId.trim();
  if (!domain || !cleanCertId) {
    return { synced: 0, failed: 0, matched: 0, notes: [] };
  }

  const now = nowSeconds();
  let synced = 0;
  let failed = 0;
  let matched = 0;
  const notes: string[] = [];
  const handledZoneDomains = new Set<string>();

  const existingBindings = (await repo.listEdgeOneCertBindings(env)).filter(
    (b) => b.domain.trim().toLowerCase() === domain,
  );

  for (const b of existingBindings) {
    const key = `${b.tencent_account_id}:${b.site}:${b.zone_id}:${domain}`;
    handledZoneDomains.add(key);
    matched += 1;

    // Ensure binding points to this managed SSL certificate so future renewals auto-sync.
    let activeBinding = b;
    if (b.ssl_cert_id !== sslCertId) {
      activeBinding = await repo.upsertEdgeOneCertBinding(env, {
        ssl_cert_id: sslCertId,
        tencent_account_id: b.tencent_account_id,
        site: b.site,
        zone_id: b.zone_id,
        zone_name: b.zone_name,
        domain,
        last_deployed_cert_id: b.last_deployed_cert_id,
        last_deployed_at: b.last_deployed_at,
        last_error: b.last_error,
      });
    }

    if (!opts?.force && activeBinding.last_deployed_cert_id === cleanCertId) {
      continue;
    }

    try {
      await deployBindingNow(env, activeBinding, cleanCertId);
      synced += 1;
      notes.push(`EdgeOne CDN ${domain} 已同步证书 ${cleanCertId}`);
    } catch (err) {
      failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      notes.push(`EdgeOne CDN ${domain} 同步失败（${msg}）`);
    }
  }

  // Probe EdgeOne zones on the certificate's Tencent account to auto-discover
  // any CDN domain that hasn't been explicitly bound yet.
  const scopeList: Array<{ accountId: number; site: EdgeOneSite }> = [];
  const scopeSeen = new Set<string>();
  const addScope = (accountId: number, site: EdgeOneSite) => {
    if (!Number.isFinite(accountId) || accountId <= 0) return;
    const cleanSite = normalizeEdgeOneSite(site);
    const k = `${accountId}:${cleanSite}`;
    if (scopeSeen.has(k)) return;
    scopeSeen.add(k);
    scopeList.push({ accountId, site: cleanSite });
  };

  const preferredAcct = opts?.preferredTencentAccountId ?? 0;
  const watched = await listWatchedEdgeOneScopes(env);
  if (preferredAcct > 0) {
    for (const s of watched) {
      if (s.accountId === preferredAcct) addScope(s.accountId, s.site);
    }
    addScope(preferredAcct, "cn");
    addScope(preferredAcct, "intl");
  } else {
    for (const s of watched) {
      addScope(s.accountId, s.site);
    }
    if (scopeList.length === 0) {
      const accts = await repo.listDnsAccounts(env, { provider: "tencent", decryptSecret: false });
      for (const a of accts) {
        addScope(a.id, "cn");
        addScope(a.id, "intl");
      }
    }
  }

  for (const scope of scopeList) {
    let creds;
    try {
      creds = await resolveEdgeOneCreds(env, scope.accountId, scope.site);
    } catch {
      continue;
    }

    let zones;
    try {
      zones = await listZones(env, creds);
    } catch {
      continue;
    }
    if (zones.length === 0) continue;
    await recordWatchedEdgeOneScope(env, scope.accountId, scope.site);

    for (const zone of zones) {
      if (zone.paused) continue;
      // Quick suffix check: acceleration domain must match or be a subdomain of zoneName.
      const zoneName = zone.zoneName.trim().toLowerCase().replace(/\.+$/, "");
      if (zoneName && domain !== zoneName && !domain.endsWith(`.${zoneName}`)) {
        continue;
      }

      let domains: EdgeOneDomain[];
      try {
        domains = await listAccelerationDomains(env, creds, zone.zoneId);
      } catch {
        continue;
      }

      const hit = domains.find(
        (d) => d.domainName.trim().toLowerCase() === domain && d.domainStatus !== "offline",
      );
      if (!hit) continue;

      const key = `${scope.accountId}:${scope.site}:${zone.zoneId}:${domain}`;
      if (handledZoneDomains.has(key)) continue;
      handledZoneDomains.add(key);
      matched += 1;

      try {
        await modifyHostsCertificate(env, creds, zone.zoneId, [domain], "sslcert", cleanCertId);
        await repo.upsertEdgeOneCertBinding(env, {
          ssl_cert_id: sslCertId,
          tencent_account_id: scope.accountId,
          site: scope.site,
          zone_id: zone.zoneId,
          zone_name: zone.zoneName,
          domain,
          last_deployed_cert_id: cleanCertId,
          last_deployed_at: now,
          last_error: "",
        });
        synced += 1;
        notes.push(`EdgeOne CDN ${domain}（${zone.zoneName || zone.zoneId}）已联动同步证书 ${cleanCertId}`);
        await repo.addEvent(
          env,
          "ssl",
          messages.ev("NPS 联动 EdgeOne CDN 证书同步成功", messages.objServer(domain)),
          {
            detail: `已将腾讯云证书 ${cleanCertId} 同步部署至 EdgeOne 站点 ${zone.zoneName || zone.zoneId}，并建立后续自动续签联动`,
          },
        );
      } catch (err) {
        failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        notes.push(`EdgeOne CDN ${domain} 联动同步失败（${msg}）`);
        await repo.addEvent(
          env,
          "ssl",
          messages.ev("NPS 联动 EdgeOne CDN 证书同步失败", messages.objServer(domain)),
          { level: "error", detail: `证书 ${cleanCertId}：${msg}` },
        );
      }
    }
  }

  return { synced, failed, matched, notes };
}

async function fetchCertPemForDeployment(
  env: Env,
  cert: SslCertificateRecord,
  certId: string,
  pemOverride?: { certPem: string; keyPem: string },
): Promise<{ certPem: string; keyPem: string }> {
  if (
    pemOverride?.certPem.includes("-----BEGIN") &&
    pemOverride?.keyPem.includes("-----BEGIN")
  ) {
    return pemOverride;
  }
  const creds = await resolveTencentCredsForCert(env, cert);
  const detail = await describeTencentCertificateDetail(env, creds, certId);
  if (
    !detail.certificatePublicKey.includes("-----BEGIN") ||
    !detail.certificatePrivateKey.includes("-----BEGIN")
  ) {
    throw new Error(`腾讯云证书 ${certId} 尚未包含完整 PEM 公钥/私钥内容`);
  }
  return {
    certPem: detail.certificatePublicKey,
    keyPem: detail.certificatePrivateKey,
  };
}

/**
 * Push a newly issued or renewed managed Tencent SSL certificate to every bound
 * NPS Host (inline PEM hot-reload without restarting NPS) and, when `sync_cdn`
 * is enabled on the binding, synchronize any matching EdgeOne CDN acceleration
 * domain with the exact same certificate.
 */
export async function syncRenewedCertificateToNps(
  env: Env,
  sslCertId: number,
  newCertId: string,
  opts?: {
    pemOverride?: { certPem: string; keyPem: string };
    forceCdn?: boolean;
  },
): Promise<NpsCertSyncResult> {
  const bindings = await repo.listNpsBindingsBySslCert(env, sslCertId);
  if (bindings.length === 0) {
    return { synced: 0, failed: 0, cdnSynced: 0, cdnFailed: 0, notes: [] };
  }

  const cert = await repo.getSslCertificate(env, sslCertId, true);
  if (!cert) {
    return { synced: 0, failed: 0, cdnSynced: 0, cdnFailed: 0, notes: [] };
  }

  let synced = 0;
  let failed = 0;
  let cdnSynced = 0;
  let cdnFailed = 0;
  const notes: string[] = [];
  const now = nowSeconds();

  let pem: { certPem: string; keyPem: string };
  try {
    pem = await fetchCertPemForDeployment(env, cert, newCertId, opts?.pemOverride);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const b of bindings) {
      failed += 1;
      await repo.updateNpsCertBindingStatus(env, b.id, { last_error: msg });
    }
    notes.push(`NPS 证书同步失败（${msg}）`);
    return { synced, failed, cdnSynced, cdnFailed, notes };
  }

  const cdnDomainsToSync = new Set<string>();

  for (const binding of bindings) {
    try {
      const server = await nps.resolveNpsServer(env, binding.nps_server_id);
      await nps.deployPemCertificateToNpsHost(
        env,
        server,
        binding.nps_host_id,
        pem.certPem,
        pem.keyPem,
      );
      await repo.updateNpsCertBindingStatus(env, binding.id, {
        last_deployed_cert_id: newCertId,
        last_deployed_at: now,
        last_error: "",
      });
      synced += 1;
      notes.push(`NPS「${server.label}」${binding.domain} 已热替换证书 ${newCertId}`);
      await repo.addEvent(
        env,
        "ssl",
        messages.ev("NPS 证书自动同步成功", messages.objServer(binding.domain)),
        {
          detail: `已将腾讯云证书 ${newCertId}（PEM）热更新至 NPS 服务器「${server.label}」域名解析 #${binding.nps_host_id}`,
        },
      );
      if (binding.sync_cdn) {
        cdnDomainsToSync.add(binding.domain.trim().toLowerCase());
      }
    } catch (err) {
      failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      await repo.updateNpsCertBindingStatus(env, binding.id, { last_error: msg });
      notes.push(`NPS 域名 ${binding.domain} 同步失败（${msg}）`);
      await repo.addEvent(
        env,
        "ssl",
        messages.ev("NPS 证书自动同步失败", messages.objServer(binding.domain)),
        { level: "error", detail: `证书 ${newCertId}：${msg}` },
      );
    }
  }

  for (const dom of cdnDomainsToSync) {
    const cdnRes = await syncDomainCertToMatchingEdgeOne(env, sslCertId, newCertId, dom, {
      preferredTencentAccountId: cert.tencent_account_id,
      force: opts?.forceCdn,
    });
    cdnSynced += cdnRes.synced;
    cdnFailed += cdnRes.failed;
    notes.push(...cdnRes.notes);
  }

  return { synced, failed, cdnSynced, cdnFailed, notes };
}

/**
 * Bind an NPS domain host to a Tencent Cloud SSL certificate — either an
 * explicitly chosen managed certificate (`sslCertId`) or automatic 5-step
 * provisioning (reuse healthy local cert -> advance in-flight cert -> import
 * healthy remote cert -> renew expiring local cert -> apply brand-new free 443
 * DV cert with auto DNS verification & 7-day auto-renewal).
 *
 * Whenever the certificate is already issued (or issues immediately), deploys
 * its PEM directly onto the NPS Host and optionally synchronizes matching
 * EdgeOne CDN domains.
 */
export async function ensureNpsHostTencentCert(
  env: Env,
  params: EnsureNpsHostCertParams,
): Promise<EnsureNpsHostCertResult> {
  const server = await nps.resolveNpsServer(env, params.npsServerId);
  const hostRaw = await nps.getHostRaw(env, server, params.npsHostId);
  const domain = hostRaw.host.trim().toLowerCase().replace(/\.+$/, "");
  if (!domain) {
    throw new Error("该 NPS 域名解析未配置有效域名");
  }
  const syncCdn = params.syncCdn !== false;
  const thresholdDays = Math.max(1, Math.min(30, Math.trunc(params.renewBeforeDays ?? 7)));
  const thresholdSec = thresholdDays * 86400;
  const now = nowSeconds();

  // Helper: persist binding + push PEM to NPS + sync matching EdgeOne CDN if enabled.
  const deployIssuedCert = async (
    cert: SslCertificateRecord,
    actionLabel: EnsureNpsHostCertResult["action"],
    summaryPrefix: string,
  ): Promise<EnsureNpsHostCertResult> => {
    const certWithSecrets = (await repo.getSslCertificate(env, cert.id, true)) ?? cert;
    const pem = await fetchCertPemForDeployment(env, certWithSecrets, cert.cert_id);
    await nps.deployPemCertificateToNpsHost(
      env,
      server,
      hostRaw.id,
      pem.certPem,
      pem.keyPem,
      params.autoHttps !== undefined ? { autoHttps: params.autoHttps } : undefined,
    );
    const binding = await repo.upsertNpsCertBinding(env, {
      nps_server_id: server.id,
      nps_host_id: hostRaw.id,
      nps_client_id: hostRaw.clientId,
      domain,
      ssl_cert_id: cert.id,
      sync_cdn: syncCdn,
      last_deployed_cert_id: cert.cert_id,
      last_deployed_at: now,
      last_error: "",
    });
    if (!cert.auto_renew || cert.renew_before_days < thresholdDays) {
      await repo.updateSslCertificate(env, cert.id, {
        auto_renew: true,
        renew_before_days: Math.max(cert.renew_before_days || 7, thresholdDays),
      });
    }

    let cdnSynced = 0;
    let cdnNotes: string[] = [];
    if (syncCdn) {
      const cdnRes = await syncDomainCertToMatchingEdgeOne(env, cert.id, cert.cert_id, domain, {
        preferredTencentAccountId: cert.tencent_account_id,
        force: true,
      });
      cdnSynced = cdnRes.synced;
      cdnNotes = cdnRes.notes;
    }

    const cdnSuffix = cdnNotes.length > 0 ? `；${cdnNotes.join("，")}` : "";
    await repo.addEvent(
      env,
      "ssl",
      messages.ev("NPS 域名已绑定并部署腾讯证书", messages.objServer(domain)),
      {
        detail: `${summaryPrefix}（证书 ${cert.cert_id}，NPS「${server.label}」#${hostRaw.id}，到期前 ${thresholdDays} 天自动续期）${cdnSuffix}`,
      },
    );

    return {
      domain,
      action: actionLabel,
      deployedToNps: true,
      certId: cert.cert_id,
      sslCertRowId: cert.id,
      binding,
      cdnSynced,
      cdnNotes,
      detail: `${summaryPrefix}${cdnSuffix}`,
    };
  };

  // Path A: Bind an explicitly selected managed SSL certificate.
  if (params.sslCertId && params.sslCertId > 0) {
    const chosen = await repo.getSslCertificate(env, params.sslCertId, false);
    if (!chosen) {
      throw new Error(`所选托管证书 #${params.sslCertId} 不存在`);
    }
    if (chosen.status === "issued" && chosen.cert_id) {
      return deployIssuedCert(
        chosen,
        "bound_and_deployed",
        `已绑定并热部署托管证书 ${chosen.cert_id} 到 NPS`,
      );
    }

    // Pending / verifying certificate: bind first, advance once, deploy if issued immediately.
    let binding = await repo.upsertNpsCertBinding(env, {
      nps_server_id: server.id,
      nps_host_id: hostRaw.id,
      nps_client_id: hostRaw.clientId,
      domain,
      ssl_cert_id: chosen.id,
      sync_cdn: syncCdn,
      last_deployed_cert_id: "",
      last_deployed_at: 0,
      last_error: "",
    });
    const refreshed = await refreshManagedCertificate(env, chosen.id, {
      forceWriteDns: false,
      triggerVerify: true,
    });
    if (refreshed.certificate.status === "issued" && refreshed.certificate.cert_id) {
      const latestBinding = await repo.getNpsCertBinding(env, binding.id);
      if (!latestBinding || latestBinding.last_deployed_cert_id !== refreshed.certificate.cert_id) {
        return deployIssuedCert(
          refreshed.certificate,
          "bound_and_deployed",
          `所选证书 ${refreshed.certificate.cert_id} 已签发并热部署到 NPS`,
        );
      }
      binding = latestBinding;
      return {
        domain,
        action: "bound_and_deployed",
        deployedToNps: true,
        certId: refreshed.certificate.cert_id,
        sslCertRowId: refreshed.certificate.id,
        binding,
        cdnSynced: 0,
        cdnNotes: [],
        detail: `所选证书 ${refreshed.certificate.cert_id} 已签发并自动部署到 NPS`,
      };
    }
    return {
      domain,
      action: "pending",
      deployedToNps: false,
      certId: refreshed.certificate.pending_cert_id || refreshed.certificate.cert_id,
      sslCertRowId: refreshed.certificate.id,
      binding,
      cdnSynced: 0,
      cdnNotes: [],
      detail: `已绑定证书 ${refreshed.certificate.pending_cert_id || refreshed.certificate.cert_id}，等待验证签发后将自动写入 NPS${syncCdn ? " 并同步 CDN" : ""}`,
    };
  }

  // Path B: Automatic Tencent Cloud free 443 DV certificate provisioning / reuse.
  if (domain.startsWith("*.")) {
    throw new Error("腾讯云免费 443 DV 证书不支持泛域名，请改选已有泛域名证书或手动填写 PEM");
  }

  const allManaged = await repo.listSslCertificates(env, false);
  const sameDomainAll = allManaged.filter((c) => c.domain.toLowerCase() === domain);

  let accountId = Math.trunc(params.tencentAccountId ?? 0);
  if (accountId <= 0) {
    const existingAcct = sameDomainAll.find((c) => c.tencent_account_id > 0)?.tencent_account_id;
    if (existingAcct) {
      accountId = existingAcct;
    } else {
      const tencentAccounts = await repo.listDnsAccounts(env, {
        provider: "tencent",
        decryptSecret: false,
      });
      accountId = tencentAccounts[0]?.id ?? 0;
    }
  }
  if (accountId <= 0) {
    throw new Error("请先在「云解析 / DNS 账号」中添加至少一个腾讯云账号后再申请证书");
  }

  const acct = await repo.getDnsAccount(env, accountId, true);
  if (!acct || acct.provider !== "tencent") {
    throw new Error("所选腾讯云账号无效，请检查账号配置");
  }
  const sslCreds: TencentCreds = {
    secretId: acct.cred_id,
    secretKey: acct.cred_secret ?? "",
    sourceLabel: acct.label,
  };

  const sameDomainCerts = sameDomainAll.filter((c) => c.tencent_account_id === accountId);
  const caches = createScanCaches();

  // 1. Reuse already-issued healthy local managed cert (> thresholdDays remaining).
  const healthyManaged = sameDomainCerts
    .filter(
      (c) =>
        c.status === "issued" &&
        Boolean(c.cert_id) &&
        c.cert_end_ts > now + thresholdSec,
    )
    .sort((a, b) => b.cert_end_ts - a.cert_end_ts)[0];

  if (healthyManaged) {
    return deployIssuedCert(
      healthyManaged,
      "bound_and_deployed",
      `已复用面板有效证书 ${healthyManaged.cert_id} 并热部署到 NPS`,
    );
  }

  // 2. Bind & advance an existing in-flight managed cert for this domain.
  const inFlightManaged = sameDomainCerts.find(
    (c) =>
      Boolean(c.pending_cert_id) ||
      c.status === "pending_dns" ||
      c.status === "verifying",
  );
  if (inFlightManaged) {
    const binding = await repo.upsertNpsCertBinding(env, {
      nps_server_id: server.id,
      nps_host_id: hostRaw.id,
      nps_client_id: hostRaw.clientId,
      domain,
      ssl_cert_id: inFlightManaged.id,
      sync_cdn: syncCdn,
      last_deployed_cert_id: "",
      last_deployed_at: 0,
      last_error: "",
    });
    const refreshed = await refreshManagedCertificate(env, inFlightManaged.id, {
      forceWriteDns: false,
      triggerVerify: true,
    });
    const finalCert = refreshed.certificate;
    if (finalCert.status === "issued" && finalCert.cert_id) {
      const latestBinding = await repo.getNpsCertBinding(env, binding.id);
      if (!latestBinding || latestBinding.last_deployed_cert_id !== finalCert.cert_id) {
        return deployIssuedCert(
          finalCert,
          "bound_and_deployed",
          `在途证书 ${finalCert.cert_id} 已签发并热部署到 NPS`,
        );
      }
      return {
        domain,
        action: "bound_and_deployed",
        deployedToNps: true,
        certId: finalCert.cert_id,
        sslCertRowId: finalCert.id,
        binding: latestBinding,
        cdnSynced: 0,
        cdnNotes: [],
        detail: `在途证书 ${finalCert.cert_id} 已签发并自动部署到 NPS`,
      };
    }
    return {
      domain,
      action: "pending",
      deployedToNps: false,
      certId: finalCert.pending_cert_id || finalCert.cert_id,
      sslCertRowId: finalCert.id,
      binding,
      cdnSynced: 0,
      cdnNotes: [],
      detail: `已有证书 ${finalCert.pending_cert_id || finalCert.cert_id} 正在验证签发，签发后将自动部署到 NPS${syncCdn ? " 并同步 CDN" : ""}`,
    };
  }

  // 3. Check Tencent Cloud remote SSL list for an already-issued healthy certificate to import & deploy.
  const remoteCerts = await getCachedRemoteTencentCerts(env, accountId, sslCreds, caches);
  const healthyRemote = remoteCerts
    .filter(
      (r) =>
        r.domain.toLowerCase() === domain &&
        r.status === 1 &&
        Boolean(r.certificateId) &&
        r.certEndTs > now + thresholdSec,
    )
    .sort((a, b) => b.certEndTs - a.certEndTs)[0];

  if (healthyRemote) {
    const verify = await autoDetectDnsVerifyForDomain(env, accountId, domain, caches, {
      dnsVerifyMode: params.dnsVerifyMode,
      dnsAccountId: params.dnsAccountId,
    });
    let row = await repo.getSslCertificateByCertId(env, healthyRemote.certificateId, false);
    if (!row) {
      const rowId = await repo.createSslCertificate(env, {
        domain,
        tencent_account_id: accountId,
        dns_verify_mode: verify.mode,
        dns_account_id: verify.dnsAccountId,
        cert_id: healthyRemote.certificateId,
        encrypt_algo: healthyRemote.encryptAlgorithm.toUpperCase() === "ECC" ? "ECC" : "RSA",
        status: "issued",
        tencent_status: healthyRemote.status,
        status_name: healthyRemote.statusName || "已颁发",
        cert_begin_time: healthyRemote.certBeginTime,
        cert_end_time: healthyRemote.certEndTime,
        cert_end_ts: healthyRemote.certEndTs,
        auto_renew: true,
        renew_before_days: thresholdDays,
        clean_dns_after_issue: true,
        remark: `NPS 自动导入复用 (${server.label})`,
        last_checked_at: now,
      });
      row = (await repo.getSslCertificate(env, rowId, false))!;
    }
    return deployIssuedCert(
      row,
      "bound_and_deployed",
      `已导入腾讯云有效证书 ${healthyRemote.certificateId} 并热部署到 NPS`,
    );
  }

  // 4. Renew an existing expiring/expired/failed local managed certificate.
  const renewableManaged = sameDomainCerts
    .slice()
    .sort((a, b) => b.cert_end_ts - a.cert_end_ts || b.id - a.id)[0];

  if (renewableManaged) {
    const patch: Partial<repo.SslCertificateCreateInput> = {
      auto_renew: true,
      renew_before_days: Math.max(renewableManaged.renew_before_days || 7, thresholdDays),
    };
    if (renewableManaged.dns_verify_mode === "manual" || params.dnsVerifyMode || params.dnsAccountId) {
      const verify = await autoDetectDnsVerifyForDomain(env, accountId, domain, caches, {
        dnsVerifyMode: params.dnsVerifyMode,
        dnsAccountId: params.dnsAccountId,
      });
      patch.dns_verify_mode = verify.mode;
      patch.dns_account_id = verify.dnsAccountId;
    }
    await repo.updateSslCertificate(env, renewableManaged.id, patch);

    // Bind BEFORE calling renewManagedCertificate so immediate issuance auto-pushes to NPS + CDN.
    const binding = await repo.upsertNpsCertBinding(env, {
      nps_server_id: server.id,
      nps_host_id: hostRaw.id,
      nps_client_id: hostRaw.clientId,
      domain,
      ssl_cert_id: renewableManaged.id,
      sync_cdn: syncCdn,
      last_deployed_cert_id: "",
      last_deployed_at: 0,
      last_error: "",
    });

    const renewed = await renewManagedCertificate(env, renewableManaged.id, "manual");
    const issuedNow =
      renewed.certificate.status === "issued" &&
      renewed.certificate.cert_id === renewed.newCertId;

    if (issuedNow) {
      const latestBinding = await repo.getNpsCertBinding(env, binding.id);
      if (!latestBinding || latestBinding.last_deployed_cert_id !== renewed.newCertId) {
        return deployIssuedCert(
          renewed.certificate,
          "renewed",
          `已续签新证书 ${renewed.newCertId} 并热部署到 NPS`,
        );
      }
      let cdnSynced = 0;
      let cdnNotes: string[] = [];
      if (syncCdn) {
        const cdnRes = await syncDomainCertToMatchingEdgeOne(
          env,
          renewed.certificate.id,
          renewed.newCertId,
          domain,
          { preferredTencentAccountId: accountId },
        );
        cdnSynced = cdnRes.synced;
        cdnNotes = cdnRes.notes;
      }
      return {
        domain,
        action: "renewed",
        deployedToNps: true,
        certId: renewed.newCertId,
        sslCertRowId: renewed.certificate.id,
        binding: latestBinding,
        cdnSynced,
        cdnNotes,
        detail: `已续签新证书 ${renewed.newCertId} 并自动热替换至 NPS${
          cdnNotes.length > 0 ? `；${cdnNotes.join("，")}` : ""
        }`,
      };
    }

    return {
      domain,
      action: "renewed",
      deployedToNps: false,
      certId: renewed.newCertId,
      sslCertRowId: renewableManaged.id,
      binding,
      cdnSynced: 0,
      cdnNotes: [],
      detail: `已发起证书续签（新证书 ${renewed.newCertId}），验证签发后将自动热替换到 NPS${syncCdn ? " 并同步 CDN" : ""}`,
    };
  }

  // 5. Apply a brand-new Tencent Cloud free 443 DV certificate.
  const verify = await autoDetectDnsVerifyForDomain(env, accountId, domain, caches, {
    dnsVerifyMode: params.dnsVerifyMode,
    dnsAccountId: params.dnsAccountId,
  });

  const applied = await applyManagedCertificate(env, {
    domain,
    tencent_account_id: accountId,
    dns_verify_mode: verify.mode,
    dns_account_id: verify.dnsAccountId,
    encrypt_algo: "RSA",
    auto_renew: true,
    renew_before_days: thresholdDays,
    clean_dns_after_issue: true,
    remark: `NPS 自动申请 (${server.label})`,
  });

  const issuedNow =
    applied.certificate.status === "issued" && Boolean(applied.certificate.cert_id);

  if (issuedNow) {
    return deployIssuedCert(
      applied.certificate,
      "applied",
      `已自动申请免费证书 ${applied.certificate.cert_id} 并热部署到 NPS`,
    );
  }

  const binding = await repo.upsertNpsCertBinding(env, {
    nps_server_id: server.id,
    nps_host_id: hostRaw.id,
    nps_client_id: hostRaw.clientId,
    domain,
    ssl_cert_id: applied.certificate.id,
    sync_cdn: syncCdn,
    last_deployed_cert_id: "",
    last_deployed_at: 0,
    last_error: "",
  });

  return {
    domain,
    action: "applied",
    deployedToNps: false,
    certId: applied.certificate.cert_id,
    sslCertRowId: applied.certificate.id,
    binding,
    cdnSynced: 0,
    cdnNotes: [],
    detail: `已向腾讯云提交免费证书申请（${applied.certificate.cert_id}），自动验证签发后将自动写入 NPS${syncCdn ? " 并同步 CDN" : ""}`,
  };
}

/**
 * Manually trigger an immediate certificate sync for a single NPS Host binding
 * (advances verification if still pending, pushes PEM to NPS Host, and syncs
 * matching EdgeOne CDN if `sync_cdn` is enabled).
 */
export async function syncNpsHostCertBindingNow(
  env: Env,
  npsServerId: number,
  npsHostId: number,
): Promise<{
  synced: boolean;
  certId: string;
  cdnSynced: number;
  detail: string;
}> {
  const binding = await repo.getNpsCertBindingByHost(env, npsServerId, npsHostId);
  if (!binding) {
    throw new Error("该 NPS 域名尚未绑定腾讯云托管证书");
  }
  let cert = await repo.getSslCertificate(env, binding.ssl_cert_id, true);
  if (!cert) {
    throw new Error(`绑定的托管证书 #${binding.ssl_cert_id} 不存在`);
  }

  if (cert.status !== "issued" || cert.pending_cert_id) {
    const refreshed = await refreshManagedCertificate(env, cert.id, {
      forceWriteDns: false,
      triggerVerify: true,
    });
    cert = (await repo.getSslCertificate(env, refreshed.certificate.id, true)) ?? cert;
  }

  if (cert.status !== "issued" || !cert.cert_id) {
    return {
      synced: false,
      certId: cert.pending_cert_id || cert.cert_id,
      cdnSynced: 0,
      detail: `证书当前状态为「${cert.status_name || cert.status}」，尚未签发完成，签发后将自动同步`,
    };
  }

  const server = await nps.resolveNpsServer(env, binding.nps_server_id);
  const pem = await fetchCertPemForDeployment(env, cert, cert.cert_id);
  await nps.deployPemCertificateToNpsHost(env, server, binding.nps_host_id, pem.certPem, pem.keyPem);
  await repo.updateNpsCertBindingStatus(env, binding.id, {
    last_deployed_cert_id: cert.cert_id,
    last_deployed_at: nowSeconds(),
    last_error: "",
  });

  let cdnSynced = 0;
  let cdnNote = "";
  if (binding.sync_cdn) {
    const cdnRes = await syncDomainCertToMatchingEdgeOne(env, cert.id, cert.cert_id, binding.domain, {
      preferredTencentAccountId: cert.tencent_account_id,
      force: true,
    });
    cdnSynced = cdnRes.synced;
    if (cdnRes.notes.length > 0) {
      cdnNote = `；${cdnRes.notes.join("，")}`;
    }
  }

  await repo.addEvent(
    env,
    "ssl",
    messages.ev("NPS 证书手动同步成功", messages.objServer(binding.domain)),
    {
      detail: `已将证书 ${cert.cert_id} 重新部署至 NPS「${server.label}」#${binding.nps_host_id}${cdnNote}`,
    },
  );

  return {
    synced: true,
    certId: cert.cert_id,
    cdnSynced,
    detail: `已将证书 ${cert.cert_id} 热部署至 NPS${cdnNote}`,
  };
}

/**
 * Periodic Cron self-healing reconciler (~every 5 min): checks all NPS
 * certificate bindings and retries pushing PEM to any NPS Host whose bound
 * SSL certificate has a newer issued `cert_id` (or previously failed to push),
 * plus ensures CDN sync when `sync_cdn` is enabled. Steady state costs zero
 * external network requests.
 */
export async function reconcileNpsCertificates(
  env: Env,
  opts?: { force?: boolean },
): Promise<ReconcileNpsCertsSummary> {
  const force = Boolean(opts?.force);
  const summary: ReconcileNpsCertsSummary = {
    checked: 0,
    synced: 0,
    failed: 0,
    cdnSynced: 0,
    errors: [],
  };

  if (!force) {
    const age = await repo.flagAge(env, NPS_CERT_SYNC_FLAG);
    if (age >= 0 && age < NPS_CERT_SYNC_INTERVAL_SECONDS) {
      return summary;
    }
  }

  const bindings = await repo.listNpsCertBindings(env);
  if (bindings.length === 0) {
    await repo.clearFlag(env, NPS_CERT_SYNC_FLAG);
    await repo.setFlag(env, NPS_CERT_SYNC_FLAG);
    return summary;
  }

  const allCerts = await repo.listSslCertificates(env, true);
  const certById = new Map(allCerts.map((c) => [c.id, c]));
  const pemCache = new Map<string, { certPem: string; keyPem: string }>();
  const now = nowSeconds();

  for (const binding of bindings) {
    summary.checked += 1;
    const cert = certById.get(binding.ssl_cert_id);
    if (!cert || cert.status !== "issued" || !cert.cert_id) continue;

    const needsPush =
      force ||
      binding.last_deployed_cert_id !== cert.cert_id ||
      Boolean(binding.last_error);
    if (!needsPush) continue;

    try {
      let pem = pemCache.get(cert.cert_id);
      if (!pem) {
        pem = await fetchCertPemForDeployment(env, cert, cert.cert_id);
        pemCache.set(cert.cert_id, pem);
      }
      const server = await nps.resolveNpsServer(env, binding.nps_server_id);
      await nps.deployPemCertificateToNpsHost(
        env,
        server,
        binding.nps_host_id,
        pem.certPem,
        pem.keyPem,
      );
      await repo.updateNpsCertBindingStatus(env, binding.id, {
        last_deployed_cert_id: cert.cert_id,
        last_deployed_at: now,
        last_error: "",
      });
      summary.synced += 1;

      if (binding.sync_cdn) {
        const cdnRes = await syncDomainCertToMatchingEdgeOne(
          env,
          cert.id,
          cert.cert_id,
          binding.domain,
          { preferredTencentAccountId: cert.tencent_account_id },
        );
        summary.cdnSynced += cdnRes.synced;
      }
    } catch (err) {
      summary.failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push(`${binding.domain}: ${msg}`);
      await repo.updateNpsCertBindingStatus(env, binding.id, { last_error: msg });
    }
  }

  await repo.clearFlag(env, NPS_CERT_SYNC_FLAG);
  await repo.setFlag(env, NPS_CERT_SYNC_FLAG);
  return summary;
}


