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
import * as repo from "./repo";
import type {
  DnsAccountRecord,
  SslCertStatus,
  SslCertificateRecord,
  SslVerifyMode,
} from "./repo";
import { signTencentV3 } from "./tencent_lighthouse";

const SSL_HOST = "ssl.tencentcloudapi.com";
const SSL_SERVICE = "ssl";
const SSL_VERSION = "2019-12-05";
const HTTP_TIMEOUT_MS = 18_000;

const VERIFY_POLL_FLAG = "ssl_verify_last_run";
const RENEW_SCAN_FLAG = "ssl_renew_last_run";
const VERIFY_POLL_INTERVAL_SECONDS = 120; // 2 min
const RENEW_SCAN_INTERVAL_SECONDS = 900; // 15 min
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

async function cleanupValidationDnsIfConfigured(
  env: Env,
  cert: SslCertificateRecord,
): Promise<boolean> {
  if (
    !cert.clean_dns_after_issue ||
    cert.dns_verify_mode !== "dns_account" ||
    !cert.dns_account_id ||
    !cert.dns_record_id ||
    !cert.dns_root_domain
  ) {
    return false;
  }
  const dnsAccount = await repo.getDnsAccount(env, cert.dns_account_id, true);
  if (!dnsAccount) return false;
  return dnsProviders.deleteValidationRecord(
    env,
    dnsAccount,
    cert.dns_root_domain,
    cert.dns_zone_id,
    cert.dns_record_id,
  );
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
        return { certificate: updated, dnsAction: "failed", verifyTriggered: false, justIssued: false };
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
    }
  }

  // Now check whether the active cert has transitioned to Issued / Failed / Expired.
  if (detail.status === 1) {
    const wasAlreadyIssuedSameCert = !isRenewalFlow && cert.status === "issued";
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

    // Cleanup temporary validation DNS record once issued.
    const latestWithSecrets = await repo.getSslCertificate(env, id, true);
    if (latestWithSecrets && latestWithSecrets.dns_record_id) {
      const cleaned = await cleanupValidationDnsIfConfigured(env, latestWithSecrets);
      if (cleaned) {
        await repo.updateSslCertificate(env, id, {
          dns_record_id: "",
          dns_record_written: false,
        });
      }
    }

    if (!wasAlreadyIssuedSameCert) {
      justIssued = true;
      const actionTitle = isRenewalFlow ? "SSL 证书自动续签已签发" : "SSL 证书已签发";
      await repo.addEvent(env, "ssl", messages.ev(actionTitle, messages.objServer(cert.domain)), {
        detail: `域名 ${cert.domain} 证书（ID: ${activeCertId}）已签发，有效期至 ${detail.certEndTime || "未知"}`,
      });
      await notifyCertEvent(env, "ssl_issued", `✅ ${actionTitle}：${cert.domain}`, [
        `域名：${cert.domain}`,
        `证书 ID：${activeCertId}`,
        `生效时间：${detail.certBeginTime || "-"}`,
        `到期时间：${detail.certEndTime || "-"}`,
        `下次自动续签：到期前 ${cert.renew_before_days} 天`,
      ]);
    }
  } else if (detail.status === 2 || detail.status === 7 || detail.status === 10) {
    const reason = detail.statusMsg || detail.statusName || "审核未通过";
    patch.last_error = `腾讯云证书审核异常：${reason}`;
    if (isRenewalFlow) {
      // Preserve current issued cert; clear failed pending renewal so next window can retry.
      patch.pending_cert_id = "";
      patch.dns_record_written = false;
      patch.status =
        cert.cert_end_ts > 0 && cert.cert_end_ts <= checkedAt ? "expired" : "issued";
    } else {
      patch.status = "failed";
    }
    await repo.updateSslCertificate(env, id, patch);
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
  return { certificate: finalCert, dnsAction, verifyTriggered, justIssued };
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
}> {
  const cert = await repo.getSslCertificate(env, id, true);
  if (!cert) throw new Error("证书记录不存在");

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
  };
}

/**
 * Import existing certificates from a configured Tencent Cloud account into
 * local management so users can enable 7-day auto-renewal & downloads.
 */
export async function syncAccountCertificates(
  env: Env,
  tencentAccountId: number,
  opts?: { dnsVerifyMode?: SslVerifyMode; dnsAccountId?: number; autoRenew?: boolean },
): Promise<{ imported: number; updated: number; totalRemote: number }> {
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
  let imported = 0;
  let updated = 0;

  for (const item of remoteList) {
    if (!item.certificateId || !item.domain) continue;
    // Skip wildcard or non-DV or cancelled/revoked certs from auto-import noise unless already tracked.
    const existing = await repo.getSslCertificateByCertId(env, item.certificateId, false);
    const mappedStatus = mapTencentStatus(item.status, item.certEndTs);
    if (existing) {
      await repo.updateSslCertificate(env, existing.id, {
        tencent_status: item.status,
        status_name: item.statusName,
        status: existing.pending_cert_id ? existing.status : mappedStatus,
        cert_begin_time: item.certBeginTime,
        cert_end_time: item.certEndTime,
        cert_end_ts: item.certEndTs,
        last_checked_at: nowSeconds(),
      });
      updated += 1;
      continue;
    }
    if (item.status === 7 || item.status === 10 || item.status === 14) continue;
    if (item.domain.startsWith("*.")) continue;

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
      last_checked_at: nowSeconds(),
    });
    imported += 1;
  }

  return { imported, updated, totalRemote: remoteList.length };
}

/**
 * Cron reconcile engine invoked from `src/scheduler.ts`:
 * 1. Polls pending/verifying certificates (~every 2 min) to push DNS records,
 *    trigger `CompleteCertificate`, and promote issued certs.
 * 2. Scans `auto_renew = 1` certificates (~every 15 min) expiring within
 *    `renew_before_days` (default 7 days) and automatically re-applies + writes
 *    DNS validation records + verifies them.
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

  // Phase 1: Advance all in-flight applications & renewals.
  if (shouldPollPending) {
    for (const cert of certs) {
      const inFlight =
        Boolean(cert.pending_cert_id) ||
        cert.status === "pending_dns" ||
        cert.status === "verifying";
      if (!inFlight) continue;
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
    for (const cert of freshCerts) {
      if (!cert.auto_renew) continue;
      if (cert.pending_cert_id) continue; // renewal already in progress
      if (cert.status === "pending_dns" || cert.status === "verifying") continue;
      if (!cert.cert_end_ts || cert.cert_end_ts <= 0) continue;

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
    await repo.clearFlag(env, RENEW_SCAN_FLAG);
    await repo.setFlag(env, RENEW_SCAN_FLAG);
  }

  return summary;
}
