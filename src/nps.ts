/**
 * NPS (https://github.com/yisier/nps) Web API client & dry-run simulator.
 *
 * Authentication modes verified against `yisier/nps` (`web/controllers/base.go`,
 * `login.go`, `auth.go`, `client.go`, `index.go`, `server/proxy/https.go`):
 * 1. `auth_key` (recommended): `auth_key = md5(raw_auth_key + timestamp)` with
 *    `timestamp` within +/- 20s of the NPS server clock (auto-synced via
 *    `/auth/gettime`).
 * 2. `web_login`: admin username/password login via `POST /login/verify` using
 *    the returned `beegosessionID` cookie (requires NPS captcha disabled).
 *
 * HTTPS certificates: `yisier/nps` natively accepts inline PEM certificate and
 * private key content in `cert_file_path` / `key_file_path` (detected via
 * `-----BEGIN`) and hot-reloads the per-host TLS listener on change without
 * restarting NPS.
 */

import type { Env } from "./env";
import * as repo from "./repo";
import type { NpsServerRecord } from "./repo";

const HTTP_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Zero-dependency RFC 1321 MD5 (Web Crypto API does not expose MD5)
// ---------------------------------------------------------------------------

const MD5_S: readonly number[] = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K: readonly number[] = Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0,
);

/**
 * Compute lowercase hexadecimal RFC 1321 MD5 digest of a UTF-8 string.
 */
export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const padLen = ((56 - ((bytes.length + 1) % 64)) + 64) % 64;
  const totalLen = bytes.length + 1 + padLen + 8;
  const buf = new Uint8Array(totalLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;

  const view = new DataView(buf.buffer);
  view.setUint32(totalLen - 8, bitLen >>> 0, true);
  view.setUint32(totalLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Uint32Array(16);
  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let j = 0; j < 16; j += 1) {
      m[j] = view.getUint32(offset + j * 4, true);
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i += 1) {
      let f = 0;
      let g = 0;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (a + f + MD5_K[i]! + m[g]!) >>> 0;
      const s = MD5_S[i]!;
      const rotated = ((sum << s) | (sum >>> (32 - s))) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotated) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return Array.from(out, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Public Models
// ---------------------------------------------------------------------------

export type NpsTunnelMode =
  | "tcp"
  | "udp"
  | "socks5"
  | "httpProxy"
  | "secret"
  | "p2p"
  | "file";

export type NpsHostScheme = "all" | "http" | "https";

export interface NpsClientItem {
  id: number;
  verifyKey: string;
  remark: string;
  status: boolean;
  isConnect: boolean;
  addr: string;
  localAddr: string;
  version: string;
  nowConn: number;
  maxConn: number;
  rateLimit: number;
  maxTunnelNum: number;
  inletFlow: number;
  exportFlow: number;
  flowLimit: number;
  compress: boolean;
  crypt: boolean;
  basicUser: string;
  basicPass: string;
  webUserName: string;
  configConnAllow: boolean;
  expireTime: string;
  createTime: string;
  lastOnlineTime: string;
}

export interface NpsBridgeInfo {
  ip: string;
  bridgeType: string;
  bridgePort: number;
}

export interface NpsTunnelItem {
  id: number;
  clientId: number;
  clientRemark: string;
  clientOnline: boolean;
  mode: string;
  port: number;
  serverIp: string;
  target: string;
  localProxy: boolean;
  status: boolean;
  runStatus: boolean;
  remark: string;
  password: string;
  localPath: string;
  stripPre: string;
  inletFlow: number;
  exportFlow: number;
}

export interface NpsHostItem {
  id: number;
  clientId: number;
  clientRemark: string;
  clientOnline: boolean;
  host: string;
  target: string;
  localProxy: boolean;
  scheme: NpsHostScheme;
  location: string;
  headerChange: string;
  hostChange: string;
  remark: string;
  isClose: boolean;
  autoHttps: boolean;
  inletFlow: number;
  exportFlow: number;
  hasCert: boolean;
  certMode: "pem" | "file" | "none";
  certPreview: string;
}

export interface NpsHostRaw extends NpsHostItem {
  certFilePath: string;
  keyFilePath: string;
}

export interface NpsClientWriteInput {
  remark?: string;
  vkey?: string;
  u?: string;
  p?: string;
  compress?: boolean;
  crypt?: boolean;
  rateLimit?: number;
  flowLimit?: number;
  maxConn?: number;
  maxTunnelNum?: number;
  webUserName?: string;
  webPassword?: string;
  configConnAllow?: boolean;
  expireTime?: string;
}

export interface NpsTunnelWriteInput {
  clientId: number;
  mode: NpsTunnelMode;
  port?: number;
  target: string;
  serverIp?: string;
  remark?: string;
  localProxy?: boolean;
  password?: string;
  localPath?: string;
  stripPre?: string;
}

export interface NpsHostWriteInput {
  clientId: number;
  host: string;
  target: string;
  scheme?: NpsHostScheme;
  location?: string;
  headerChange?: string;
  hostChange?: string;
  remark?: string;
  localProxy?: boolean;
  autoHttps?: boolean;
  certFilePath?: string;
  keyFilePath?: string;
}

// ---------------------------------------------------------------------------
// Helpers & Input Validation
// ---------------------------------------------------------------------------

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

function asBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

function normalizeScheme(raw: unknown): NpsHostScheme {
  const s = asStr(raw).trim().toLowerCase();
  if (s === "http" || s === "https") return s;
  return "all";
}

/**
 * Validate and normalize an NPS Web base URL (preserving optional `web_base_url` path).
 */
export function normalizeNpsBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("请填写 NPS 管理后台地址");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("NPS 管理后台地址格式无效，请包含 http:// 或 https://");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("NPS 管理后台地址仅支持 http:// 或 https://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("请勿在 URL 中内嵌账号密码，请使用下方认证配置");
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${cleanPath}`;
}

function normalizePem(raw: string): string {
  return raw.replace(/\r\n/g, "\n").trim();
}

function classifyCert(certPath: string, keyPath: string): {
  hasCert: boolean;
  certMode: "pem" | "file" | "none";
  certPreview: string;
} {
  const c = certPath.trim();
  const k = keyPath.trim();
  if (!c || !k) {
    return { hasCert: false, certMode: "none", certPreview: "" };
  }
  if (c.includes("-----BEGIN") || k.includes("-----BEGIN")) {
    return { hasCert: true, certMode: "pem", certPreview: "PEM 内联证书（已配置）" };
  }
  return { hasCert: true, certMode: "file", certPreview: c };
}

function parseClientItem(raw: Record<string, unknown>): NpsClientItem {
  const cnf = asObj(raw["Cnf"]);
  const flow = asObj(raw["Flow"]);
  return {
    id: asNum(raw["Id"]),
    verifyKey: asStr(raw["VerifyKey"]),
    remark: asStr(raw["Remark"]),
    status: asBool(raw["Status"]),
    isConnect: asBool(raw["IsConnect"]),
    addr: asStr(raw["Addr"]),
    localAddr: asStr(raw["LocalAddr"]),
    version: asStr(raw["Version"]),
    nowConn: asNum(raw["NowConn"]),
    maxConn: asNum(raw["MaxConn"]),
    rateLimit: asNum(raw["RateLimit"]),
    maxTunnelNum: asNum(raw["MaxTunnelNum"]),
    inletFlow: asNum(flow["InletFlow"]),
    exportFlow: asNum(flow["ExportFlow"]),
    flowLimit: asNum(flow["FlowLimit"]),
    compress: asBool(cnf["Compress"]),
    crypt: asBool(cnf["Crypt"]),
    basicUser: asStr(cnf["U"]),
    basicPass: asStr(cnf["P"]),
    webUserName: asStr(raw["WebUserName"]),
    configConnAllow: asBool(raw["ConfigConnAllow"]),
    expireTime: asStr(raw["ExpireTime"]),
    createTime: asStr(raw["CreateTime"]),
    lastOnlineTime: asStr(raw["LastOnlineTime"]),
  };
}

function parseTunnelItem(raw: Record<string, unknown>): NpsTunnelItem {
  const client = asObj(raw["Client"]);
  const target = asObj(raw["Target"]);
  const flow = asObj(raw["Flow"]);
  return {
    id: asNum(raw["Id"]),
    clientId: asNum(client["Id"]),
    clientRemark: asStr(client["Remark"]),
    clientOnline: asBool(client["IsConnect"]),
    mode: asStr(raw["Mode"], "tcp"),
    port: asNum(raw["Port"]),
    serverIp: asStr(raw["ServerIp"]),
    target: asStr(target["TargetStr"] ?? raw["TargetAddr"]),
    localProxy: asBool(target["LocalProxy"]),
    status: asBool(raw["Status"]),
    runStatus: asBool(raw["RunStatus"]),
    remark: asStr(raw["Remark"]),
    password: asStr(raw["Password"]),
    localPath: asStr(raw["LocalPath"]),
    stripPre: asStr(raw["StripPre"]),
    inletFlow: asNum(flow["InletFlow"]),
    exportFlow: asNum(flow["ExportFlow"]),
  };
}

function parseHostRaw(raw: Record<string, unknown>): NpsHostRaw {
  const client = asObj(raw["Client"]);
  const target = asObj(raw["Target"]);
  const flow = asObj(raw["Flow"]);
  const certFilePath = asStr(raw["CertFilePath"]);
  const keyFilePath = asStr(raw["KeyFilePath"]);
  const certMeta = classifyCert(certFilePath, keyFilePath);
  return {
    id: asNum(raw["Id"]),
    clientId: asNum(client["Id"]),
    clientRemark: asStr(client["Remark"]),
    clientOnline: asBool(client["IsConnect"]),
    host: asStr(raw["Host"]).trim().toLowerCase(),
    target: asStr(target["TargetStr"]),
    localProxy: asBool(target["LocalProxy"]),
    scheme: normalizeScheme(raw["Scheme"]),
    location: asStr(raw["Location"]),
    headerChange: asStr(raw["HeaderChange"]),
    hostChange: asStr(raw["HostChange"]),
    remark: asStr(raw["Remark"]),
    isClose: asBool(raw["IsClose"]),
    autoHttps: asBool(raw["AutoHttps"]),
    inletFlow: asNum(flow["InletFlow"]),
    exportFlow: asNum(flow["ExportFlow"]),
    hasCert: certMeta.hasCert,
    certMode: certMeta.certMode,
    certPreview: certMeta.certPreview,
    certFilePath,
    keyFilePath,
  };
}

function stripHostSecrets(raw: NpsHostRaw): NpsHostItem {
  const { certFilePath: _c, keyFilePath: _k, ...pub } = raw;
  return pub;
}

// ---------------------------------------------------------------------------
// Per-isolate auth caches (clock offset for auth_key, session cookie for web_login)
// ---------------------------------------------------------------------------

const clockOffsetCache = new Map<string, { offsetSec: number; fetchedAt: number }>();
const sessionCookieCache = new Map<string, { cookie: string; fetchedAt: number }>();

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getServerClockOffset(baseUrl: string, forceRefresh = false): Promise<number> {
  const now = Date.now();
  const cached = clockOffsetCache.get(baseUrl);
  if (!forceRefresh && cached && now - cached.fetchedAt < 5 * 60_000) {
    return cached.offsetSec;
  }
  try {
    const res = await fetchWithTimeout(`${baseUrl}/auth/gettime`, { method: "GET" });
    if (res.ok) {
      const data = asObj(await res.json().catch(() => ({})));
      const remoteSec = asNum(data["time"], 0);
      if (remoteSec > 1_000_000_000) {
        const offsetSec = Math.round(remoteSec - Date.now() / 1000);
        clockOffsetCache.set(baseUrl, { offsetSec, fetchedAt: Date.now() });
        return offsetSec;
      }
    }
  } catch {
    // Fall back to local UTC clock if /auth/gettime is unreachable.
  }
  return cached?.offsetSec ?? 0;
}

function extractSessionCookie(res: Response): string {
  const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const list = typeof getSetCookie === "function" ? getSetCookie.call(res.headers) : [];
  const raw = list.length > 0 ? list : [res.headers.get("set-cookie") ?? ""];
  const pairs: string[] = [];
  for (const header of raw) {
    for (const part of header.split(/,(?=[^;,=\s]+=[^;,]+)/)) {
      const nv = part.split(";")[0]?.trim();
      if (nv && nv.includes("=")) pairs.push(nv);
    }
  }
  return pairs.join("; ");
}

async function loginWebSession(
  server: NpsServerRecord,
  baseUrl: string,
  forceRefresh = false,
): Promise<string> {
  const cacheKey = `${server.id}:${baseUrl}:${server.username}`;
  const cached = sessionCookieCache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < 15 * 60_000) {
    return cached.cookie;
  }
  const form = new URLSearchParams();
  form.set("username", server.username);
  form.set("password", server.password);
  const res = await fetchWithTimeout(`${baseUrl}/login/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = asObj(JSON.parse(text));
  } catch {
    throw new Error(`NPS 登录响应异常（HTTP ${res.status}），请检查后台地址是否正确`);
  }
  if (asNum(json["status"], 0) !== 1) {
    const msg = asStr(json["msg"], "用户名或密码错误");
    if (msg.toLowerCase().includes("verification code") || msg.includes("验证码")) {
      throw new Error("NPS 已开启登录验证码，请改用 auth_key 模式对接");
    }
    throw new Error(`NPS 管理员登录失败：${msg}`);
  }
  const cookie = extractSessionCookie(res);
  if (!cookie) {
    throw new Error("NPS 登录成功但未返回 Session Cookie，建议改用 auth_key 模式");
  }
  sessionCookieCache.set(cacheKey, { cookie, fetchedAt: Date.now() });
  return cookie;
}

async function npsPost(
  server: NpsServerRecord,
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  attempt = 0,
): Promise<Record<string, unknown>> {
  const baseUrl = normalizeNpsBaseUrl(server.base_url);
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    form.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json, text/plain, */*",
  };

  if (server.auth_mode === "web_login") {
    const cookie = await loginWebSession(server, baseUrl, attempt > 0);
    headers["Cookie"] = cookie;
  } else {
    if (!server.auth_key.trim()) {
      throw new Error(`NPS 服务器「${server.label}」未配置 auth_key`);
    }
    const offset = await getServerClockOffset(baseUrl, attempt > 0);
    const ts = Math.floor(Date.now() / 1000) + offset;
    form.set("timestamp", String(ts));
    form.set("auth_key", md5Hex(`${server.auth_key.trim()}${ts}`));
  }

  const res = await fetchWithTimeout(`${baseUrl}${cleanPath}`, {
    method: "POST",
    headers,
    body: form.toString(),
  });

  // Beego redirects unauthenticated requests to /login/index (HTTP 302).
  if (res.status === 302 || res.status === 301 || res.status === 401 || res.status === 403) {
    if (attempt === 0) {
      return npsPost(server, path, params, 1);
    }
    throw new Error(
      server.auth_mode === "auth_key"
        ? "NPS auth_key 认证失败，请检查 nps.conf 中的 auth_key 与服务器时间"
        : "NPS 会话认证失败，请检查管理员用户名与密码",
    );
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`NPS 请求 ${cleanPath} 失败（HTTP ${res.status}）`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = asObj(JSON.parse(text));
  } catch {
    if (text.includes("<html") || text.includes("/login/")) {
      if (attempt === 0) return npsPost(server, path, params, 1);
      throw new Error("NPS 返回了登录页面而非 JSON，请核对 auth_key 或后台路径（web_base_url）");
    }
    throw new Error(`NPS 接口 ${cleanPath} 返回非 JSON 内容`);
  }
  return parsed;
}

function assertAjaxOk(resp: Record<string, unknown>, fallbackMsg: string): void {
  if (asNum(resp["status"], 0) !== 1) {
    throw new Error(asStr(resp["msg"]) || fallbackMsg);
  }
}

// ---------------------------------------------------------------------------
// Dry-run in-memory NPS state (used when CDT_DRY_RUN=1)
// ---------------------------------------------------------------------------

interface DryNpsState {
  nextClientId: number;
  nextTunnelId: number;
  nextHostId: number;
  clients: Map<number, NpsClientItem>;
  tunnels: Map<number, NpsTunnelItem>;
  hosts: Map<number, NpsHostRaw>;
}

const dryNpsStore = new Map<number, DryNpsState>();

function getDryNps(server: NpsServerRecord): DryNpsState {
  let st = dryNpsStore.get(server.id);
  if (st) return st;

  const client1: NpsClientItem = {
    id: 1,
    verifyKey: "drynpsvkey001abc",
    remark: "家宽 NAS 节点",
    status: true,
    isConnect: true,
    addr: "203.0.113.10:54321",
    localAddr: "192.168.1.20",
    version: "0.26.25",
    nowConn: 3,
    maxConn: 0,
    rateLimit: 0,
    maxTunnelNum: 0,
    inletFlow: 125_829_120,
    exportFlow: 842_006_528,
    flowLimit: 0,
    compress: true,
    crypt: true,
    basicUser: "",
    basicPass: "",
    webUserName: "",
    configConnAllow: true,
    expireTime: "",
    createTime: "2026-11-20 10:00:00",
    lastOnlineTime: "2026-11-22 17:00:00",
  };
  const tunnel1: NpsTunnelItem = {
    id: 10,
    clientId: 1,
    clientRemark: client1.remark,
    clientOnline: true,
    mode: "tcp",
    port: 2222,
    serverIp: "",
    target: "127.0.0.1:22",
    localProxy: false,
    status: true,
    runStatus: true,
    remark: "SSH 映射",
    password: "",
    localPath: "",
    stripPre: "",
    inletFlow: 12_345_678,
    exportFlow: 98_765_432,
  };
  const tunnel2: NpsTunnelItem = {
    id: 11,
    clientId: 1,
    clientRemark: client1.remark,
    clientOnline: true,
    mode: "udp",
    port: 51820,
    serverIp: "",
    target: "127.0.0.1:51820",
    localProxy: false,
    status: true,
    runStatus: true,
    remark: "WireGuard UDP",
    password: "",
    localPath: "",
    stripPre: "",
    inletFlow: 4_194_304,
    exportFlow: 8_388_608,
  };
  const host1: NpsHostRaw = {
    id: 20,
    clientId: 1,
    clientRemark: client1.remark,
    clientOnline: true,
    host: "nas.tencent-demo.cn",
    target: "127.0.0.1:5000",
    localProxy: false,
    scheme: "all",
    location: "",
    headerChange: "",
    hostChange: "",
    remark: "NAS Web 面板",
    isClose: false,
    autoHttps: true,
    inletFlow: 5_242_880,
    exportFlow: 20_971_520,
    hasCert: false,
    certMode: "none",
    certPreview: "",
    certFilePath: "",
    keyFilePath: "",
  };

  st = {
    nextClientId: 2,
    nextTunnelId: 12,
    nextHostId: 21,
    clients: new Map([[client1.id, client1]]),
    tunnels: new Map([
      [tunnel1.id, tunnel1],
      [tunnel2.id, tunnel2],
    ]),
    hosts: new Map([[host1.id, host1]]),
  };
  dryNpsStore.set(server.id, st);
  return st;
}

// ---------------------------------------------------------------------------
// High-level NPS Operations
// ---------------------------------------------------------------------------

export async function resolveNpsServer(env: Env, serverId: number): Promise<NpsServerRecord> {
  const server = await repo.getNpsServer(env, serverId, true);
  if (!server) throw new Error("NPS 服务器不存在");
  return server;
}

export async function testNpsServer(
  env: Env,
  server: NpsServerRecord,
): Promise<{ ok: true; clientCount: number; bridge: NpsBridgeInfo }> {
  const res = await listClients(env, server);
  return { ok: true, clientCount: res.total, bridge: res.bridge };
}

export async function listClients(
  env: Env,
  server: NpsServerRecord,
  search = "",
): Promise<{ total: number; items: NpsClientItem[]; bridge: NpsBridgeInfo }> {
  if (isDryRun(env)) {
    const st = getDryNps(server);
    const kw = search.trim().toLowerCase();
    const items = [...st.clients.values()].filter((c) =>
      !kw ||
      c.remark.toLowerCase().includes(kw) ||
      c.verifyKey.toLowerCase().includes(kw) ||
      String(c.id).includes(kw),
    );
    return {
      total: items.length,
      items,
      bridge: { ip: "nps.tencent-demo.cn", bridgeType: "tcp", bridgePort: 8024 },
    };
  }
  const resp = await npsPost(server, "/client/list", {
    offset: 0,
    limit: 500,
    search: search.trim(),
  });
  const rows = asArr<Record<string, unknown>>(resp["rows"]).map(parseClientItem);
  return {
    total: asNum(resp["total"], rows.length),
    items: rows,
    bridge: {
      ip: asStr(resp["ip"]),
      bridgeType: asStr(resp["bridgeType"], "tcp"),
      bridgePort: asNum(resp["bridgePort"], 8024),
    },
  };
}

export async function addClient(
  env: Env,
  server: NpsServerRecord,
  input: NpsClientWriteInput,
): Promise<{ id: number }> {
  if (isDryRun(env)) {
    const st = getDryNps(server);
    const id = st.nextClientId++;
    const vkey = (input.vkey ?? "").trim() || `dryvkey_${id}_${Date.now().toString(36)}`;
    st.clients.set(id, {
      id,
      verifyKey: vkey,
      remark: (input.remark ?? "").trim(),
      status: true,
      isConnect: false,
      addr: "",
      localAddr: "",
      version: "",
      nowConn: 0,
      maxConn: Math.max(0, Math.trunc(input.maxConn ?? 0)),
      rateLimit: Math.max(0, Math.trunc(input.rateLimit ?? 0)),
      maxTunnelNum: Math.max(0, Math.trunc(input.maxTunnelNum ?? 0)),
      inletFlow: 0,
      exportFlow: 0,
      flowLimit: Math.max(0, Math.trunc(input.flowLimit ?? 0)),
      compress: Boolean(input.compress),
      crypt: Boolean(input.crypt),
      basicUser: (input.u ?? "").trim(),
      basicPass: (input.p ?? "").trim(),
      webUserName: (input.webUserName ?? "").trim(),
      configConnAllow: input.configConnAllow !== false,
      expireTime: (input.expireTime ?? "").trim(),
      createTime: new Date().toISOString().slice(0, 19).replace("T", " "),
      lastOnlineTime: "",
    });
    return { id };
  }
  const resp = await npsPost(server, "/client/add", {
    remark: (input.remark ?? "").trim(),
    vkey: (input.vkey ?? "").trim(),
    u: (input.u ?? "").trim(),
    p: (input.p ?? "").trim(),
    compress: input.compress ? "1" : "0",
    crypt: input.crypt ? "1" : "0",
    rate_limit: Math.max(0, Math.trunc(input.rateLimit ?? 0)),
    flow_limit: Math.max(0, Math.trunc(input.flowLimit ?? 0)),
    max_conn: Math.max(0, Math.trunc(input.maxConn ?? 0)),
    max_tunnel: Math.max(0, Math.trunc(input.maxTunnelNum ?? 0)),
    web_username: (input.webUserName ?? "").trim(),
    web_password: (input.webPassword ?? "").trim(),
    config_conn_allow: input.configConnAllow === false ? "0" : "1",
    expire_time: (input.expireTime ?? "").trim(),
  });
  assertAjaxOk(resp, "添加 NPS 客户端失败");
  return { id: asNum(resp["id"], 0) };
}

export async function editClient(
  env: Env,
  server: NpsServerRecord,
  clientId: number,
  input: NpsClientWriteInput,
): Promise<void> {
  if (isDryRun(env)) {
    const st = getDryNps(server);
    const cur = st.clients.get(clientId);
    if (!cur) throw new Error(`客户端 #${clientId} 不存在`);
    if (input.remark !== undefined) cur.remark = input.remark.trim();
    if (input.vkey !== undefined && input.vkey.trim()) cur.verifyKey = input.vkey.trim();
    if (input.u !== undefined) cur.basicUser = input.u.trim();
    if (input.p !== undefined) cur.basicPass = input.p.trim();
    if (input.compress !== undefined) cur.compress = input.compress;
    if (input.crypt !== undefined) cur.crypt = input.crypt;
    if (input.rateLimit !== undefined) cur.rateLimit = Math.max(0, Math.trunc(input.rateLimit));
    if (input.flowLimit !== undefined) cur.flowLimit = Math.max(0, Math.trunc(input.flowLimit));
    if (input.maxConn !== undefined) cur.maxConn = Math.max(0, Math.trunc(input.maxConn));
    if (input.maxTunnelNum !== undefined) cur.maxTunnelNum = Math.max(0, Math.trunc(input.maxTunnelNum));
    if (input.configConnAllow !== undefined) cur.configConnAllow = input.configConnAllow;
    if (input.expireTime !== undefined) cur.expireTime = input.expireTime.trim();
    return;
  }

  // Fetch current client fields first because NPS /client/edit overwrites all fields.
  const curResp = await npsPost(server, "/client/getclient", { id: clientId });
  if (asNum(curResp["code"], 0) !== 1) {
    throw new Error(`未找到客户端 #${clientId}`);
  }
  const raw = asObj(curResp["data"]);
  const cur = parseClientItem(raw);
  const blackIpList = asArr<string>(raw["BlackIpList"]).join("\r\n");
  const ipWhiteList = asArr<string>(raw["IpWhiteList"]).join("\r\n");

  const resp = await npsPost(server, "/client/edit", {
    id: clientId,
    remark: input.remark !== undefined ? input.remark.trim() : cur.remark,
    vkey: input.vkey !== undefined && input.vkey.trim() ? input.vkey.trim() : cur.verifyKey,
    u: input.u !== undefined ? input.u.trim() : cur.basicUser,
    p: input.p !== undefined ? input.p.trim() : cur.basicPass,
    compress: (input.compress !== undefined ? input.compress : cur.compress) ? "1" : "0",
    crypt: (input.crypt !== undefined ? input.crypt : cur.crypt) ? "1" : "0",
    rate_limit: input.rateLimit !== undefined ? Math.max(0, Math.trunc(input.rateLimit)) : cur.rateLimit,
    flow_limit: input.flowLimit !== undefined ? Math.max(0, Math.trunc(input.flowLimit)) : cur.flowLimit,
    max_conn: input.maxConn !== undefined ? Math.max(0, Math.trunc(input.maxConn)) : cur.maxConn,
    max_tunnel:
      input.maxTunnelNum !== undefined ? Math.max(0, Math.trunc(input.maxTunnelNum)) : cur.maxTunnelNum,
    web_username: input.webUserName !== undefined ? input.webUserName.trim() : cur.webUserName,
    web_password:
      input.webPassword !== undefined ? input.webPassword.trim() : asStr(raw["WebPassword"]),
    config_conn_allow:
      (input.configConnAllow !== undefined ? input.configConnAllow : cur.configConnAllow) ? "1" : "0",
    expire_time: input.expireTime !== undefined ? input.expireTime.trim() : cur.expireTime,
    blackiplist: blackIpList,
    ipwhite: asBool(raw["IpWhite"]) ? "1" : "0",
    ipwhitepass: asStr(raw["IpWhitePass"]),
    ipwhitelist: ipWhiteList,
  });
  assertAjaxOk(resp, "保存客户端配置失败");
}

export async function setClientStatus(
  env: Env,
  server: NpsServerRecord,
  clientId: number,
  enabled: boolean,
): Promise<void> {
  if (isDryRun(env)) {
    const cur = getDryNps(server).clients.get(clientId);
    if (!cur) throw new Error(`客户端 #${clientId} 不存在`);
    cur.status = enabled;
    if (!enabled) cur.isConnect = false;
    return;
  }
  const resp = await npsPost(server, "/client/changestatus", {
    id: clientId,
    status: enabled ? "1" : "0",
  });
  assertAjaxOk(resp, "切换客户端状态失败");
}

export async function deleteClient(
  env: Env,
  server: NpsServerRecord,
  clientId: number,
): Promise<void> {
  if (isDryRun(env)) {
    const st = getDryNps(server);
    st.clients.delete(clientId);
    for (const [tid, t] of st.tunnels) {
      if (t.clientId === clientId) st.tunnels.delete(tid);
    }
    for (const [hid, h] of st.hosts) {
      if (h.clientId === clientId) {
        st.hosts.delete(hid);
        await repo.deleteNpsCertBindingByHost(env, server.id, hid);
      }
    }
    return;
  }
  const resp = await npsPost(server, "/client/del", { id: clientId });
  assertAjaxOk(resp, "删除客户端失败");
  // Clean up local cert bindings that belonged to this deleted client.
  const bindings = await repo.listNpsCertBindings(env, { npsServerId: server.id });
  for (const b of bindings) {
    if (b.nps_client_id === clientId) {
      await repo.deleteNpsCertBinding(env, b.id);
    }
  }
}

export async function listTunnels(
  env: Env,
  server: NpsServerRecord,
  opts?: { clientId?: number; type?: string; search?: string },
): Promise<{ total: number; items: NpsTunnelItem[] }> {
  if (isDryRun(env)) {
    const st = getDryNps(server);
    const typeFilter = (opts?.type ?? "").trim();
    const kw = (opts?.search ?? "").trim().toLowerCase();
    const items = [...st.tunnels.values()].filter((t) => {
      if (opts?.clientId && t.clientId !== opts.clientId) return false;
      if (typeFilter && t.mode !== typeFilter) return false;
      if (
        kw &&
        !`${t.port} ${t.target} ${t.remark} ${t.mode} ${t.clientRemark}`.toLowerCase().includes(kw)
      ) {
        return false;
      }
      return true;
    });
    return { total: items.length, items };
  }
  const resp = await npsPost(server, "/index/gettunnel", {
    offset: 0,
    limit: 500,
    client_id: opts?.clientId || 0,
    type: (opts?.type ?? "").trim(),
    search: (opts?.search ?? "").trim(),
  });
  const rows = asArr<Record<string, unknown>>(resp["rows"]).map(parseTunnelItem);
  return { total: asNum(resp["total"], rows.length), items: rows };
}

export async function addTunnel(
  env: Env,
  server: NpsServerRecord,
  input: NpsTunnelWriteInput,
): Promise<{ id: number }> {
  if (!input.clientId || input.clientId <= 0) {
    throw new Error("请选择所属 NPS 客户端");
  }
  const mode = input.mode;
  const target = (input.target ?? "").trim();
  if ((mode === "tcp" || mode === "udp" || mode === "secret" || mode === "p2p") && !target) {
    throw new Error("请填写内网目标地址（例如 127.0.0.1:8080）");
  }
  if (isDryRun(env)) {
    const st = getDryNps(server);
    const client = st.clients.get(input.clientId);
    if (!client) throw new Error(`客户端 #${input.clientId} 不存在`);
    const id = st.nextTunnelId++;
    const port = input.port && input.port > 0 ? Math.trunc(input.port) : 20000 + id;
    st.tunnels.set(id, {
      id,
      clientId: client.id,
      clientRemark: client.remark,
      clientOnline: client.isConnect,
      mode,
      port,
      serverIp: (input.serverIp ?? "").trim(),
      target,
      localProxy: Boolean(input.localProxy),
      status: true,
      runStatus: true,
      remark: (input.remark ?? "").trim(),
      password: (input.password ?? "").trim(),
      localPath: (input.localPath ?? "").trim(),
      stripPre: (input.stripPre ?? "").trim(),
      inletFlow: 0,
      exportFlow: 0,
    });
    return { id };
  }
  const resp = await npsPost(server, "/index/add", {
    type: mode,
    client_id: input.clientId,
    port: input.port && input.port > 0 ? Math.trunc(input.port) : 0,
    server_ip: (input.serverIp ?? "").trim(),
    target,
    remark: (input.remark ?? "").trim(),
    local_proxy: input.localProxy ? "1" : "0",
    password: (input.password ?? "").trim(),
    local_path: (input.localPath ?? "").trim(),
    strip_pre: (input.stripPre ?? "").trim(),
  });
  assertAjaxOk(resp, "添加端口映射失败");
  return { id: asNum(resp["id"], 0) };
}

export async function editTunnel(
  env: Env,
  server: NpsServerRecord,
  tunnelId: number,
  input: Partial<NpsTunnelWriteInput>,
): Promise<void> {
  if (isDryRun(env)) {
    const st = getDryNps(server);
    const cur = st.tunnels.get(tunnelId);
    if (!cur) throw new Error(`端口映射 #${tunnelId} 不存在`);
    if (input.clientId && input.clientId > 0) {
      const cli = st.clients.get(input.clientId);
      if (!cli) throw new Error(`客户端 #${input.clientId} 不存在`);
      cur.clientId = cli.id;
      cur.clientRemark = cli.remark;
      cur.clientOnline = cli.isConnect;
    }
    if (input.mode) cur.mode = input.mode;
    if (input.port !== undefined) cur.port = Math.max(0, Math.trunc(input.port));
    if (input.serverIp !== undefined) cur.serverIp = input.serverIp.trim();
    if (input.target !== undefined) cur.target = input.target.trim();
    if (input.remark !== undefined) cur.remark = input.remark.trim();
    if (input.localProxy !== undefined) cur.localProxy = input.localProxy;
    if (input.password !== undefined) cur.password = input.password.trim();
    if (input.localPath !== undefined) cur.localPath = input.localPath.trim();
    if (input.stripPre !== undefined) cur.stripPre = input.stripPre.trim();
    return;
  }

  const curResp = await npsPost(server, "/index/getonetunnel", { id: tunnelId });
  if (asNum(curResp["code"], 0) !== 1) {
    throw new Error(`未找到端口映射 #${tunnelId}`);
  }
  const cur = parseTunnelItem(asObj(curResp["data"]));

  const resp = await npsPost(server, "/index/edit", {
    id: tunnelId,
    type: input.mode ?? cur.mode,
    client_id: input.clientId ?? cur.clientId,
    port: input.port !== undefined ? Math.max(0, Math.trunc(input.port)) : cur.port,
    server_ip: input.serverIp !== undefined ? input.serverIp.trim() : cur.serverIp,
    target: input.target !== undefined ? input.target.trim() : cur.target,
    remark: input.remark !== undefined ? input.remark.trim() : cur.remark,
    local_proxy: (input.localProxy !== undefined ? input.localProxy : cur.localProxy) ? "1" : "0",
    password: input.password !== undefined ? input.password.trim() : cur.password,
    local_path: input.localPath !== undefined ? input.localPath.trim() : cur.localPath,
    strip_pre: input.stripPre !== undefined ? input.stripPre.trim() : cur.stripPre,
  });
  assertAjaxOk(resp, "保存端口映射失败");
}

export async function setTunnelRunning(
  env: Env,
  server: NpsServerRecord,
  tunnelId: number,
  running: boolean,
): Promise<void> {
  if (isDryRun(env)) {
    const cur = getDryNps(server).tunnels.get(tunnelId);
    if (!cur) throw new Error(`端口映射 #${tunnelId} 不存在`);
    cur.status = running;
    cur.runStatus = running;
    return;
  }
  const resp = await npsPost(server, running ? "/index/start" : "/index/stop", { id: tunnelId });
  assertAjaxOk(resp, running ? "启动端口映射失败" : "停止端口映射失败");
}

export async function deleteTunnel(
  env: Env,
  server: NpsServerRecord,
  tunnelId: number,
): Promise<void> {
  if (isDryRun(env)) {
    getDryNps(server).tunnels.delete(tunnelId);
    return;
  }
  const resp = await npsPost(server, "/index/del", { id: tunnelId });
  assertAjaxOk(resp, "删除端口映射失败");
}

export async function listHosts(
  env: Env,
  server: NpsServerRecord,
  opts?: { clientId?: number; search?: string },
): Promise<{ total: number; items: NpsHostItem[] }> {
  if (isDryRun(env)) {
    const st = getDryNps(server);
    const kw = (opts?.search ?? "").trim().toLowerCase();
    const items = [...st.hosts.values()]
      .filter((h) => {
        if (opts?.clientId && h.clientId !== opts.clientId) return false;
        if (
          kw &&
          !`${h.host} ${h.target} ${h.remark} ${h.clientRemark}`.toLowerCase().includes(kw)
        ) {
          return false;
        }
        return true;
      })
      .map(stripHostSecrets);
    return { total: items.length, items };
  }
  const resp = await npsPost(server, "/index/hostlist", {
    offset: 0,
    limit: 500,
    client_id: opts?.clientId || 0,
    search: (opts?.search ?? "").trim(),
  });
  const rows = asArr<Record<string, unknown>>(resp["rows"]).map((r) =>
    stripHostSecrets(parseHostRaw(r)),
  );
  return { total: asNum(resp["total"], rows.length), items: rows };
}

export async function getHostRaw(
  env: Env,
  server: NpsServerRecord,
  hostId: number,
): Promise<NpsHostRaw> {
  if (isDryRun(env)) {
    const cur = getDryNps(server).hosts.get(hostId);
    if (!cur) throw new Error(`域名解析 #${hostId} 不存在`);
    return { ...cur };
  }
  const resp = await npsPost(server, "/index/gethost", { id: hostId });
  if (asNum(resp["code"], 0) !== 1) {
    throw new Error(`未找到 NPS 域名解析 #${hostId}`);
  }
  return parseHostRaw(asObj(resp["data"]));
}

export async function addHost(
  env: Env,
  server: NpsServerRecord,
  input: NpsHostWriteInput,
): Promise<{ id: number }> {
  if (!input.clientId || input.clientId <= 0) {
    throw new Error("请选择所属 NPS 客户端");
  }
  const host = input.host.trim().toLowerCase().replace(/\.+$/, "");
  const target = input.target.trim();
  if (!host) throw new Error("请填写绑定域名");
  if (!target) throw new Error("请填写目标内网地址（例如 127.0.0.1:8080）");

  const scheme = normalizeScheme(input.scheme);
  const autoHttps = scheme === "http" ? false : Boolean(input.autoHttps);
  const certFilePath = normalizePem(input.certFilePath ?? "");
  const keyFilePath = normalizePem(input.keyFilePath ?? "");

  if (isDryRun(env)) {
    const st = getDryNps(server);
    const client = st.clients.get(input.clientId);
    if (!client) throw new Error(`客户端 #${input.clientId} 不存在`);
    const id = st.nextHostId++;
    const certMeta = classifyCert(certFilePath, keyFilePath);
    st.hosts.set(id, {
      id,
      clientId: client.id,
      clientRemark: client.remark,
      clientOnline: client.isConnect,
      host,
      target,
      localProxy: Boolean(input.localProxy),
      scheme,
      location: (input.location ?? "").trim(),
      headerChange: (input.headerChange ?? "").trim(),
      hostChange: (input.hostChange ?? "").trim(),
      remark: (input.remark ?? "").trim(),
      isClose: false,
      autoHttps,
      inletFlow: 0,
      exportFlow: 0,
      hasCert: certMeta.hasCert,
      certMode: certMeta.certMode,
      certPreview: certMeta.certPreview,
      certFilePath,
      keyFilePath,
    });
    return { id };
  }

  const resp = await npsPost(server, "/index/addhost", {
    client_id: input.clientId,
    host,
    target,
    scheme,
    location: (input.location ?? "").trim(),
    header: (input.headerChange ?? "").trim(),
    hostchange: (input.hostChange ?? "").trim(),
    remark: (input.remark ?? "").trim(),
    local_proxy: input.localProxy ? "1" : "0",
    AutoHttps: autoHttps ? "1" : "0",
    cert_file_path: certFilePath,
    key_file_path: keyFilePath,
  });
  assertAjaxOk(resp, "添加域名解析失败");
  return { id: asNum(resp["id"], 0) };
}

export async function editHost(
  env: Env,
  server: NpsServerRecord,
  hostId: number,
  input: Partial<NpsHostWriteInput>,
): Promise<NpsHostItem> {
  const cur = await getHostRaw(env, server, hostId);
  const nextClientId = input.clientId && input.clientId > 0 ? input.clientId : cur.clientId;
  const nextHost =
    input.host !== undefined ? input.host.trim().toLowerCase().replace(/\.+$/, "") : cur.host;
  const nextTarget = input.target !== undefined ? input.target.trim() : cur.target;
  const nextScheme = input.scheme !== undefined ? normalizeScheme(input.scheme) : cur.scheme;
  const nextAutoHttps =
    nextScheme === "http"
      ? false
      : input.autoHttps !== undefined
        ? input.autoHttps
        : cur.autoHttps;
  const nextLocation = input.location !== undefined ? input.location.trim() : cur.location;
  const nextHeader = input.headerChange !== undefined ? input.headerChange.trim() : cur.headerChange;
  const nextHostChange = input.hostChange !== undefined ? input.hostChange.trim() : cur.hostChange;
  const nextRemark = input.remark !== undefined ? input.remark.trim() : cur.remark;
  const nextLocalProxy = input.localProxy !== undefined ? input.localProxy : cur.localProxy;
  const nextCert =
    input.certFilePath !== undefined ? normalizePem(input.certFilePath) : cur.certFilePath;
  const nextKey =
    input.keyFilePath !== undefined ? normalizePem(input.keyFilePath) : cur.keyFilePath;

  if (!nextHost) throw new Error("域名不能为空");
  if (!nextTarget) throw new Error("目标地址不能为空");

  if (isDryRun(env)) {
    const st = getDryNps(server);
    const cli = st.clients.get(nextClientId);
    if (!cli) throw new Error(`客户端 #${nextClientId} 不存在`);
    const certMeta = classifyCert(nextCert, nextKey);
    const updated: NpsHostRaw = {
      ...cur,
      clientId: cli.id,
      clientRemark: cli.remark,
      clientOnline: cli.isConnect,
      host: nextHost,
      target: nextTarget,
      scheme: nextScheme,
      location: nextLocation,
      headerChange: nextHeader,
      hostChange: nextHostChange,
      remark: nextRemark,
      localProxy: nextLocalProxy,
      autoHttps: nextAutoHttps,
      hasCert: certMeta.hasCert,
      certMode: certMeta.certMode,
      certPreview: certMeta.certPreview,
      certFilePath: nextCert,
      keyFilePath: nextKey,
    };
    st.hosts.set(hostId, updated);
    return stripHostSecrets(updated);
  }

  const resp = await npsPost(server, "/index/edithost", {
    id: hostId,
    client_id: nextClientId,
    host: nextHost,
    target: nextTarget,
    scheme: nextScheme,
    location: nextLocation,
    header: nextHeader,
    hostchange: nextHostChange,
    remark: nextRemark,
    local_proxy: nextLocalProxy ? "1" : "0",
    AutoHttps: nextAutoHttps ? "1" : "0",
    cert_file_path: nextCert,
    key_file_path: nextKey,
  });
  assertAjaxOk(resp, "保存 NPS 域名解析失败");

  const certMeta = classifyCert(nextCert, nextKey);
  return {
    ...stripHostSecrets(cur),
    clientId: nextClientId,
    host: nextHost,
    target: nextTarget,
    scheme: nextScheme,
    location: nextLocation,
    headerChange: nextHeader,
    hostChange: nextHostChange,
    remark: nextRemark,
    localProxy: nextLocalProxy,
    autoHttps: nextAutoHttps,
    hasCert: certMeta.hasCert,
    certMode: certMeta.certMode,
    certPreview: certMeta.certPreview,
  };
}

export async function setHostEnabled(
  env: Env,
  server: NpsServerRecord,
  hostId: number,
  enabled: boolean,
): Promise<void> {
  if (isDryRun(env)) {
    const cur = getDryNps(server).hosts.get(hostId);
    if (!cur) throw new Error(`域名解析 #${hostId} 不存在`);
    cur.isClose = !enabled;
    return;
  }
  const resp = await npsPost(server, enabled ? "/index/hoststart" : "/index/hoststop", {
    id: hostId,
  });
  assertAjaxOk(resp, enabled ? "启用域名解析失败" : "停用域名解析失败");
}

export async function deleteHost(
  env: Env,
  server: NpsServerRecord,
  hostId: number,
): Promise<void> {
  if (isDryRun(env)) {
    getDryNps(server).hosts.delete(hostId);
    await repo.deleteNpsCertBindingByHost(env, server.id, hostId);
    return;
  }
  const resp = await npsPost(server, "/index/delhost", { id: hostId });
  assertAjaxOk(resp, "删除域名解析失败");
  await repo.deleteNpsCertBindingByHost(env, server.id, hostId);
}

/**
 * Push a full PEM certificate chain + private key directly onto an NPS Host
 * record. Preserves all existing Host fields and upgrades `scheme === "http"`
 * to `"all"` so HTTPS starts serving immediately (`yisier/nps` hot-reloads the
 * TLS listener whenever `CertFilePath` changes).
 */
export async function deployPemCertificateToNpsHost(
  env: Env,
  server: NpsServerRecord,
  hostId: number,
  certPem: string,
  keyPem: string,
  opts?: { autoHttps?: boolean },
): Promise<NpsHostItem> {
  const cleanCert = normalizePem(certPem);
  const cleanKey = normalizePem(keyPem);
  if (!cleanCert.includes("-----BEGIN") || !cleanKey.includes("-----BEGIN")) {
    throw new Error("证书公钥或私钥 PEM 内容无效，无法写入 NPS");
  }
  const cur = await getHostRaw(env, server, hostId);
  const nextScheme: NpsHostScheme = cur.scheme === "http" ? "all" : cur.scheme;
  return editHost(env, server, hostId, {
    scheme: nextScheme,
    autoHttps: opts?.autoHttps !== undefined ? opts.autoHttps : cur.autoHttps,
    certFilePath: cleanCert,
    keyFilePath: cleanKey,
  });
}
