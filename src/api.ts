/**
 * HTTP API — TypeScript port of `app/api.py` (BeacherZ/cdt-management).
 *
 * Mirrors the Python routes and JSON response shapes. Error envelope is
 * `{ok:false, code, message}` (the Python handlers returned
 * `{"error": {"code", "message"}}`; the Workers port normalises to the
 * `{ok:false, ...}` shape used by the frontend contract).
 *
 * Auth: `cdt_mgmt_session` cookie, HMAC-signed via `security.ts`
 * (`issueSession` / `readSession`), plus CSRF double-submit cookie
 * `cdt_mgmt_csrf` checked against the `x-cdt-csrf` header on every
 * non-GET request, exactly like `_current_user` / `require_admin` /
 * `require_csrf` in api.py.
 *
 * Login rate limiting is in-memory (per isolate): it resets when the
 * isolate is recycled, so it is a best-effort guard, not a durable
 * lockout. See `rateLimited` below.
 *
 * NOTE (import assumptions — coordinator): sibling modules do not exist
 * yet. This file is written against CONTRACT.md and assumes:
 * - every `repo.*` / `dns.*` / `ddns.*` / `billing.*` function takes
 *   `env` as its first argument (D1 / bindings come from `env`);
 * - `shift.ts` exports named functions (no `engine` object):
 *   `reconcileAll(env): Promise<void>`,
 *   `refreshServer(env, serverId)`, `manualAction(env, serverId, action)`,
 *   `bootstrapGroup(env, groupId)`, `dissolveGroup(env, groupId)`,
 *   `manualSwitch(env, groupId)`, `dailyReport(env)`, plus the pure
 *   helpers used below (`activeMembers`, `actualDuty(env, group, nowTs, tz)`,
 *   `currentMemberIndex(env, group, nowTs, tz)`, `memberSpanLabel`,
 *   `nextSwitchAt`, `keepaliveWindow(keepalive, now, tz)`) and the
 *   `PHASE_*` constants. `TRANSIENT_STATUS` is private to shift.ts, so
 *   this file mirrors it locally (same three values).
 * - `security.issueSession/readSession` take the session secret as a
 *   third argument (`env.SESSION_SECRET`); `notify.enabledChannels`
 *   takes `(env, config)`; `repo.addEvent` takes an options object
 *   (`{detail}`); `repo.setFlag(env, key)` stores no value (flags are
 *   presence-only with a `created_at` timestamp).
 * - `security.*` / `repo.*` helpers are awaited (works whether the
 *   sibling implementation is sync or async);
 * - `notify.send(env, config, channel, message)` is async and
 *   `Message = {kind, title, titleHtml, body, bodyHtml?}` per CONTRACT.
 */

import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";

import type { Env } from "./env";
import { ensureSchema } from "./db";
import * as repo from "./repo";
import * as security from "./security";
import * as dns from "./dns";
import * as ddns from "./ddns";
import * as notify from "./notify";
import * as messages from "./messages";
import * as billing from "./billing";
import * as aliyun from "./aliyun";
import * as swas from "./swas";
import * as analytics from "./analytics";
import {
  BRAND,
  CSRF_COOKIE,
  REPO,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  UPSTREAM_REPO,
  VERSION,
} from "./settings";
import {
  PHASE_BREAKER,
  PHASE_ERROR,
  PHASE_FAILOVER,
  PHASE_MANUAL,
  PHASE_SETTLED,
  PHASE_SWITCHING,
  activeMembers,
  actualDuty,
  bootstrapGroup,
  currentMemberIndex,
  dissolveGroup,
  keepaliveWindow,
  manualAction,
  manualSwitch,
  memberSpanLabel,
  nextSwitchAt,
  reconcileAll,
  refreshServer,
} from "./shift";
import type { Keepalive, Member, ShiftGroup as ShiftGroupT } from "./shift";
import type {
  KeepaliveView,
  ServerView,
  ShiftGroup as RepoGroup,
} from "./repo";
import type { RecordBooks } from "./dns";

type Bindings = { Bindings: Env };
type Ctx = Context<Bindings>;

// ---------------------------------------------------------------------------
// Small narrowing helpers (repo rows are plain objects)
// ---------------------------------------------------------------------------

type AnyRow = Record<string, unknown>;

const isRow = (v: unknown): v is AnyRow =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const rowOf = (v: unknown): AnyRow => (isRow(v) ? v : {});
const rowsOf = (v: unknown): AnyRow[] =>
  Array.isArray(v) ? v.filter(isRow) : [];
const strOf = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : v === null || v === undefined ? fallback : String(v);
const numOf = (v: unknown, fallback = 0): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const boolOf = (v: unknown): boolean => v === true || v === 1 || v === "1";

// ---------------------------------------------------------------------------
// Errors — converted to `{ok:false, code, message}` by the onError handler
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const invalid = (message: string) => new ApiError(400, "invalid_request", message);
const httpErr = (status: number, code: string, message: string) =>
  new ApiError(status, code, message);

// ---------------------------------------------------------------------------
// Timezone helpers (Asia/Shanghai is the display timezone; store epoch secs)
// ---------------------------------------------------------------------------

interface TzNow {
  epoch: number;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  iso: string;
  label: string;
  dateStr: string;
  monthDays: number;
}

function tzNow(tzName: string, at?: Date): TzNow {
  const date = at ?? new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tzName,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  const year = Number(parts["year"]);
  const month = Number(parts["month"]);
  const day = Number(parts["day"]);
  // hour can come back as "24" for midnight with hour12:false; normalise.
  let hour = Number(parts["hour"]);
  if (hour === 24) hour = 0;
  const minute = Number(parts["minute"]);
  const second = Number(parts["second"]);
  const pad = (n: number) => String(n).padStart(2, "0");
  const monthDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    epoch: Math.floor(date.getTime() / 1000),
    year,
    month,
    day,
    hour,
    minute,
    iso: `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`,
    label: `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}`,
    dateStr: `${year}-${pad(month)}-${pad(day)}`,
    monthDays,
  };
}

function hhmmToMinutes(value: unknown): number {
  const text = strOf(value).trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m) return -1;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 24 || min < 0 || min > 59) return -1;
  return h * 60 + min;
}

const fmtMinute = (minute: number): string =>
  minute >= 1440
    ? "24:00"
    : `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function sessionEpoch(env: Env): Promise<number> {
  try {
    return Number.parseInt((await repo.getSetting(env, "session_epoch")) || "0", 10) || 0;
  } catch {
    return 0;
  }
}

async function isInitialized(env: Env): Promise<boolean> {
  return (await repo.getSetting(env, "initialized")) === "1";
}

async function currentUser(c: Ctx): Promise<string | null> {
  const token = getCookie(c, SESSION_COOKIE) ?? "";
  if (!token) return null;
  const user = await security.readSession(
    token,
    await sessionEpoch(c.env),
    c.env.SESSION_SECRET,
  );
  if (!user) return null;
  try {
    if (await repo.isSessionRevoked(c.env, await security.sessionId(token))) {
      return null;
    }
  } catch (e) {
    // Blacklist lookup failing (e.g. D1 hiccup) must not turn the whole
    // request into a 500: the signature itself already verified.
    console.warn("session revocation check failed, treating as not revoked", e);
  }
  return user;
}

async function requireAdmin(c: Ctx): Promise<string> {
  const user = await currentUser(c);
  if (!user) throw httpErr(401, "unauthorized", "未登录");
  return user;
}

function requireCsrf(c: Ctx): void {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return;
  const cookie = getCookie(c, CSRF_COOKIE) ?? "";
  const header = c.req.header("x-cdt-csrf") ?? "";
  if (!cookie || cookie !== header) {
    throw httpErr(403, "forbidden", "CSRF 校验失败");
  }
}

async function attachSession(c: Ctx, username: string, epoch?: number): Promise<void> {
  const ep = epoch ?? (await sessionEpoch(c.env));
  const token = await security.issueSession(username, ep, c.env.SESSION_SECRET);
  setCookie(c, SESSION_COOKIE, token, {
    maxAge: SESSION_TTL_SECONDS,
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
  });
  setCookie(c, CSRF_COOKIE, await security.newCsrfToken(), {
    maxAge: SESSION_TTL_SECONDS,
    httpOnly: false,
    sameSite: "Lax",
    path: "/",
  });
}

// ---------------------------------------------------------------------------
// Login rate limiting (in-memory — resets per isolate; see file header)
// ---------------------------------------------------------------------------

const LOGIN_WINDOW = 300;
const LOGIN_MAX_FAILURES = 8;
const loginFailures = new Map<string, number[]>();

function clientIp(c: Ctx): string {
  // Workers always sits behind the Cloudflare edge, so cf-connecting-ip is
  // authoritative here. (Python used the direct peer, falling back to
  // X-Forwarded-For only when the peer was a private address.)
  const cf = c.req.header("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const xff = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || "unknown";
}

function rateLimited(client: string): boolean {
  const now = Date.now() / 1000;
  // Prune stale entries when the map grows, so it cannot grow unboundedly
  // with distinct visitor IPs (mirrors the Python cleanup).
  if (loginFailures.size > 256) {
    for (const [key, times] of loginFailures) {
      const last = times[times.length - 1] ?? 0;
      if (!times.length || now - last >= LOGIN_WINDOW) {
        loginFailures.delete(key);
      }
    }
  }
  const attempts = (loginFailures.get(client) ?? []).filter((t) => now - t < LOGIN_WINDOW);
  if (attempts.length) loginFailures.set(client, attempts);
  else loginFailures.delete(client);
  return attempts.length >= LOGIN_MAX_FAILURES;
}

function recordFailure(client: string): void {
  const list = loginFailures.get(client) ?? [];
  list.push(Date.now() / 1000);
  loginFailures.set(client, list);
}

function resetFailures(client: string): void {
  loginFailures.delete(client);
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

async function jsonBody(c: Ctx): Promise<AnyRow> {
  try {
    const data: unknown = await c.req.json();
    return rowOf(data);
  } catch {
    return {};
  }
}

function paramInt(c: Ctx, name: string): number {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n)) throw invalid(`${name}应为整数`);
  return n;
}

function asInt(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw invalid(`${label}应为整数`);
  return n;
}

// ---------------------------------------------------------------------------
// Setting labels (for the "配置已更新" event summary)
// ---------------------------------------------------------------------------

const SETTING_LABELS: Record<string, string> = {
  timezone: "时区",
  public_home_enabled: "公开首页开关",
  public_site_title: "公开首页标题",
  public_site_subtitle: "公开首页简介",
  traffic_threshold_pct: "流量阈值",
  reconcile_interval: "同步间隔",
  reconcile_offset: "巡检起始秒",
  daily_report_enabled: "每日汇总",
  daily_report_time: "汇总时间",
  notify_on_shift: "换班通知",
  notify_on_failover: "故障转移通知",
  notify_on_recovery: "抢占恢复通知",
  notify_on_breaker: "全局熔断通知（全部成员）",
  notify_on_limit_stop: "超限停机通知（单台）",
  notify_on_error: "异常通知",
  notify_on_keepalive: "保活通知",
  notify_on_power: "开关机通知",
  ddns_enabled: "DDNS 开关",
  ddns_provider: "DDNS 服务商",
  ddns_cf_auth_mode: "DDNS 认证方式",
  ddns_cf_email: "DDNS 账号",
  ddns_cf_token: "DDNS Token",
  ddns_cf_key: "DDNS Global Key",
  ddns_zone_id: "Zone ID",
  ddns_record: "默认域名",
  ddns_records: "DDNS 记录名",
  ddns_ttl: "TTL",
  ddns_proxied: "CDN 代理",
  billing_enabled: "费用查询",
  billing_interval: "费用查询间隔",
  notify_tg_enabled: "Telegram 开关",
  notify_tg_token: "Telegram Token",
  notify_tg_chat_id: "Telegram Chat",
  notify_tg_proxy: "Telegram 代理",
  notify_mail_enabled: "邮件开关",
  notify_mail_host: "SMTP 主机",
  notify_mail_port: "SMTP 端口",
  notify_mail_security: "SMTP 加密",
  notify_mail_username: "SMTP 账号",
  notify_mail_password: "SMTP 密码",
  notify_mail_to: "收件人",
  notify_wh_enabled: "Webhook 开关",
  notify_wh_url: "Webhook 地址",
  notify_wh_method: "Webhook 方法",
  notify_wh_body: "Webhook 请求体",
  notify_wh_headers: "Webhook 请求头",
  admin_username: "用户名",
  admin_password: "登录密码",
};

const SETTING_LABELS_SKIP = new Set(["session_epoch", "initialized"]);

function settingLabels(keys: string[]): string {
  const names = keys
    .filter((k) => !SETTING_LABELS_SKIP.has(k))
    .map((k) => SETTING_LABELS[k] ?? k)
    .sort();
  if (names.length > 8) return `${names.slice(0, 8).join("、")} 等 ${names.length} 项`;
  return names.join("、");
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function finiteGb(value: unknown, fallback = 0): number {
  const n = numOf(value, fallback);
  return Number.isFinite(n) ? n : fallback;
}

function serverSummary(
  server: ServerView,
  managed?: Map<number, AnyRow>,
  dnsMap?: Record<number, string[]>,
): AnyRow {
  const used = server.traffic_used;
  const quotaRaw = server.quota_gb;
  const quota = finiteGb(quotaRaw) || 1;
  const id = numOf(server.id);
  const owner = managed?.get(id);
  return {
    id: server.id,
    label: server.label || "",
    access_key_masked: server.access_key_masked || "",
    region_id: server.region_id || "",
    site: repo.normalizeSite(server.site),
    instance_id: server.instance_id || "",
    quota_gb: finiteGb(quotaRaw),
    threshold_gb: finiteGb(server.threshold_gb),
    remark: server.remark || "",
    traffic_used: used ?? null,
    traffic_percent:
      used !== null && used !== undefined
        ? Math.round((numOf(used) / quota) * 100 * 100) / 100
        : null,
    instance_status: server.instance_status || "Unknown",
    stop_mode: repo.normalizeStopMode(server.stop_mode),
    stopped_mode: server.stopped_mode || "",
    public_ip: server.public_ip || "",
    traffic_checked_at: server.traffic_checked_at || 0,
    status_checked_at: server.status_checked_at || 0,
    secret_configured: server.secret_configured ?? false,
    managed: owner ?? null,
    billing: billing.summaryOf(server),
    dns_record: (dnsMap?.[id] ?? []).join("、"),
  };
}

const PHASE_LABELS: Record<string, string> = {
  [PHASE_SWITCHING]: "换班中",
  [PHASE_SETTLED]: "已就绪",
  [PHASE_FAILOVER]: "故障转移",
  [PHASE_MANUAL]: "手动换班",
  [PHASE_BREAKER]: "熔断停机",
  [PHASE_ERROR]: "异常",
  pending: "待执行",
};

const GROUP_STATES: Record<string, string> = {
  scheduled: "正常排班中",
  switching: "换班中",
  failover: "故障转移中",
  manual: "手动换班中",
  recovering: "恢复中",
  breaker: "已熔断停机",
  error: "换班异常",
  disabled: "已停用",
  idle: "待排班",
  unknown: "状态未知",
};

function isTransient(status: string): boolean {
  // shift.ts keeps TRANSIENT_STATUS private; same three values.
  return status === "Starting" || status === "Pending" || status === "Stopping";
}

function groupState(
  group: RepoGroup,
  run: AnyRow,
  picked: [Member, number] | null,
  members: Member[],
  servers: Map<number, ServerView>,
): string {
  if (!group.enabled) return "disabled";
  if (!picked || members.length < 2) return "idle";

  const phase = strOf(run["phase"]);
  if (phase === PHASE_ERROR) return "error";
  if (phase === PHASE_BREAKER) return "breaker";

  const dutyId = numOf(picked[0]["server_id"]);
  const duty = servers.get(dutyId);
  const dutyStatus = duty?.instance_status ?? "";
  if (!dutyStatus) return "unknown";

  const override = run["failover"] ? "failover" : run["manual"] ? "manual" : "";

  if (isTransient(dutyStatus)) return override || "switching";
  if (dutyStatus !== "Running") return "recovering";
  let unknownMember = false;
  for (const member of members) {
    const otherId = numOf(member["server_id"]);
    if (otherId === dutyId) continue;
    const other = servers.get(otherId);
    const otherStatus = other?.instance_status ?? "";
    if (otherStatus === "Running" || isTransient(otherStatus)) return override || "switching";
    if (!otherStatus) unknownMember = true;
  }
  if (unknownMember) return "unknown";
  return override || "scheduled";
}

async function memberLabels(env: Env, members: unknown[]): Promise<Map<number, string>> {
  const labels = new Map<number, string>();
  for (const m of members) {
    const member = rowOf(m);
    const serverId = numOf(member["server_id"]);
    if (!serverId || labels.has(serverId)) continue;
    const server = await repo.getServer(env, serverId);
    labels.set(serverId, strOf(server?.label) || `#${serverId}`);
  }
  return labels;
}

async function groupPayload(
  env: Env,
  group: RepoGroup,
  config: Record<string, string>,
  nowTs: number,
  managed?: Map<number, AnyRow>,
  books?: RecordBooks,
): Promise<AnyRow> {
  const tzName = config["timezone"] || "Asia/Shanghai";
  const shiftGroup = group as unknown as ShiftGroupT;
  const members = activeMembers(shiftGroup);
  const picked = await actualDuty(env, shiftGroup, nowTs, tzName);
  const dutyId = picked ? numOf(picked[0]["server_id"]) : 0;
  const shiftStart = picked ? picked[1] : 0;
  const slotKey = String(shiftStart);
  const run = picked ? rowOf(await repo.getRun(env, numOf(group["id"]), slotKey)) : {};
  const nxt = nextSwitchAt(shiftGroup, nowTs, tzName);
  const servers = new Map<number, ServerView>();
  for (const s of await repo.listServers(env)) {
    servers.set(numOf(s["id"]), s);
  }

  const memberPayload = [];
  for (const member of group.members ?? []) {
    const server = servers.get(numOf(member["server_id"]));
    memberPayload.push({
      id: member["id"],
      server_id: member["server_id"],
      position: member["position"],
      hours: member["hours"],
      days: member["days"] ?? 0,
      span_label: memberSpanLabel(
        shiftGroup,
        member as unknown as Member,
        nowTs,
        tzName,
      ),
      slot_name: member["slot_name"] || "",
      start_time: member["start_time"] || "",
      end_time: member["end_time"] || "",
      enabled: boolOf(member["enabled"]),
      is_duty: numOf(member["server_id"]) === dutyId,
      server: server ? serverSummary(server, managed, books?.servers) : null,
    });
  }

  const state = groupState(group, run, picked, members, servers);
  const phase = strOf(run["phase"]) || "pending";
  return {
    id: group["id"],
    name: group["name"] || "",
    enabled: boolOf(group["enabled"]),
    failover_enabled: boolOf(group["failover_enabled"]),
    cycle: strOf(group["cycle"]) || "day",
    ddns_record: (books?.groups?.[numOf(group["id"])] ?? []).join("、"),
    anchor_at: group["anchor_at"] || 0,
    cycle_hours:
      Math.round(
        members.reduce((sum, m) => sum + numOf(m["hours"]), 0) * 100,
      ) / 100,
    members: memberPayload,
    duty_server_id: dutyId,
    shift_started_at: shiftStart,
    next_switch_at: nxt ? Math.floor(nxt) : 0,
    phase,
    phase_label: PHASE_LABELS[phase] ?? "待执行",
    state,
    state_label: GROUP_STATES[state] ?? "状态未知",
    note: run["note"] || "",
    updated_at: run["updated_at"] || 0,
    current_index: await currentMemberIndex(env, shiftGroup, nowTs, tzName),
  };
}

function managedMap(
  groups: RepoGroup[],
  keepalives: KeepaliveView[],
): Map<number, AnyRow> {
  // Group membership wins over single keepalive, same as Python.
  const managed = new Map<number, AnyRow>();
  for (const group of groups) {
    for (const member of group.members ?? []) {
      if (!member["enabled"]) continue;
      managed.set(numOf(member["server_id"]), {
        kind: "group",
        group_id: numOf(group["id"]),
        name: group["name"] || "",
        active: boolOf(group["enabled"]),
      });
    }
  }
  for (const item of keepalives) {
    const serverId = numOf(item["server_id"]);
    if (managed.has(serverId)) continue;
    managed.set(serverId, {
      kind: "keepalive",
      keepalive_id: numOf(item["id"]),
      name: item["label"] || "",
      active: boolOf(item["enabled"]),
    });
  }
  return managed;
}

// ---------------------------------------------------------------------------
// Validation helpers (ported from api.py)
// ---------------------------------------------------------------------------

async function validateTimetableCoverage(env: Env, members: AnyRow[]): Promise<void> {
  const spans: Array<[number, number]> = [];
  for (const member of members) {
    const start = hhmmToMinutes(member["start_time"]);
    const end = hhmmToMinutes(member["end_time"]);
    if (start < 0 || end < 0) return; // malformed format: repo.upsertGroup reports it
    spans.push([start, end]);
  }
  const labels = await memberLabels(env, members);
  const texts = members.map((m) => [
    labels.get(numOf(m["server_id"])) ?? "",
    strOf(m["start_time"]),
    strOf(m["end_time"]),
  ]);
  const textOf = (i: number): [string, string, string] => {
    const t = texts[i];
    return [t?.[0] ?? "", t?.[1] ?? "", t?.[2] ?? ""];
  };

  const owner = new Array<number>(1440).fill(-1);
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index];
    if (!span) continue;
    const [start, end] = span;
    const t = textOf(index);
    if (start === end) {
      throw invalid(`「${t[0]}」的起止时刻不能相同`);
    }
    if (end < start && end !== 0) {
      throw invalid(
        `「${t[0]}」${t[1]}–${t[2]} 的结束时刻早于开始时刻；排班按一天 0–24 点分，到午夜请把结束填成 24:00`,
      );
    }
    const ranges: Array<[number, number]> =
      end < start ? [[start, 1440], [0, end]] : [[start, end]];
    for (const [lo, hi] of ranges) {
      for (let minute = lo; minute < hi; minute++) {
        if ((owner[minute] ?? -1) >= 0) {
          const other = owner[minute] ?? -1;
          const o = textOf(other);
          throw invalid(
            `「${t[0]}」${t[1]}–${t[2]} 与「${o[0]}」${o[1]}–${o[2]} 在 ${fmtMinute(minute)} 重叠，同一时刻只能有一台当班`,
          );
        }
        owner[minute] = index;
      }
    }
  }

  let minute = 0;
  while (minute < 1440) {
    if ((owner[minute] ?? -1) >= 0) {
      minute++;
      continue;
    }
    const begin = minute;
    while (minute < 1440 && (owner[minute] ?? -1) < 0) minute++;
    throw invalid(
      `排班表在 ${fmtMinute(begin)}–${fmtMinute(minute)} 没有安排当班，一天 24 小时要刚好分完`,
    );
  }
}

async function validateGroupTimetable(env: Env, payload: AnyRow): Promise<void> {
  const allMembers = rowsOf(payload["members"]);
  for (const member of allMembers) {
    if (strOf(member["end_time"]).trim() === "24:00") member["end_time"] = "00:00";
  }
  const members = allMembers.filter((m) => m["enabled"] !== false);
  const filled = members.filter(
    (m) => strOf(m["start_time"]).trim() && strOf(m["end_time"]).trim(),
  );
  if (filled.length && filled.length !== members.length) {
    throw invalid("要么每台成员都填起止时刻，要么全部留空（按班次时长轮换）");
  }
  if (filled.length) await validateTimetableCoverage(env, members);
}

function keepaliveWindowParts(payload: AnyRow): [string, string, number, number] {
  const startRaw = strOf(payload["start_time"]).trim();
  const endRaw = strOf(payload["end_time"]).trim();
  if (Boolean(startRaw) !== Boolean(endRaw)) {
    throw invalid("运行时段的起止时刻要成对填写，或都留空（全天）");
  }
  if (startRaw) {
    if (!repo.isHhmm(startRaw) || !repo.isHhmm(endRaw)) {
      throw invalid("运行时段要用 HH:MM 格式，例如 08:00");
    }
    let startMin = Number(startRaw.slice(0, 2)) * 60 + Number(startRaw.slice(3));
    let endMin = Number(endRaw.slice(0, 2)) * 60 + Number(endRaw.slice(3));
    if (endMin === 0 && startMin > 0) endMin = 24 * 60;
    if (endMin <= startMin) {
      throw invalid("运行时段的结束时刻必须晚于开始时刻（不支持跨零点；结束填 00:00 表示到 24:00）");
    }
  }
  let startDay: number;
  let endDay: number;
  try {
    startDay = Number(payload["start_day"] ?? 0);
    endDay = Number(payload["end_day"] ?? 0);
    if (!Number.isInteger(startDay) || !Number.isInteger(endDay)) throw new Error("nan");
  } catch {
    throw invalid("运行日期必须是 1–31 的数字");
  }
  if (Boolean(startDay) !== Boolean(endDay)) {
    throw invalid("运行日期的起止日要成对填写，或都留空（全月）");
  }
  if (startDay) {
    if (!(startDay >= 1 && startDay <= 31 && endDay >= 1 && endDay <= 31)) {
      throw invalid("运行日期必须在 1–31 之间");
    }
    if (endDay < startDay) {
      throw invalid("运行日期的结束日不能早于开始日（不支持跨月）");
    }
  }
  return [startRaw, endRaw, startDay, endDay];
}

/** Draft settings form → config dict, for the "test connection" endpoints. */
async function configFromDraft(env: Env, payload: AnyRow): Promise<Record<string, string>> {
  const saved = await repo.getSettings(env);
  const cfg: Record<string, string> = { ...saved };
  const put = (key: string, value: unknown) => {
    if (value !== null && value !== undefined) cfg[key] = String(value);
  };
  const putBool = (key: string, value: unknown) => {
    if (value !== null && value !== undefined) cfg[key] = value ? "1" : "0";
  };

  put("timezone", payload["timezone"]);
  put("traffic_threshold_pct", payload["traffic_threshold_pct"]);
  put("reconcile_interval", payload["reconcile_interval"]);
  putBool("billing_enabled", payload["billing_enabled"]);
  putBool("daily_report_enabled", payload["daily_report_enabled"]);
  put("daily_report_time", payload["daily_report_time"]);
  for (const key of [
    "notify_on_shift",
    "notify_on_failover",
    "notify_on_recovery",
    "notify_on_breaker",
    "notify_on_limit_stop",
    "notify_on_error",
    "notify_on_keepalive",
    "notify_on_power",
  ]) {
    putBool(key, payload[key]);
  }

  const ddnsPayload = rowOf(payload["ddns"]);
  if (Object.keys(ddnsPayload).length) {
    putBool("ddns_enabled", ddnsPayload["enabled"]);
    put("ddns_cf_auth_mode", ddnsPayload["cf_auth_mode"]);
    put("ddns_cf_email", ddnsPayload["cf_email"]);
    put("ddns_zone_id", ddnsPayload["zone_id"]);
    put("ddns_ttl", ddnsPayload["ttl"]);
    putBool("ddns_proxied", ddnsPayload["proxied"]);
    if (ddnsPayload["cf_token"]) cfg["ddns_cf_token"] = String(ddnsPayload["cf_token"]);
    if (ddnsPayload["cf_key"]) cfg["ddns_cf_key"] = String(ddnsPayload["cf_key"]);
  }

  const tg = rowOf(payload["telegram"]);
  if (Object.keys(tg).length) {
    putBool("notify_tg_enabled", tg["enabled"]);
    put("notify_tg_chat_id", tg["chat_id"]);
    put("notify_tg_proxy", tg["proxy"]);
    if (tg["token"]) cfg["notify_tg_token"] = String(tg["token"]);
  }

  const mail = rowOf(payload["email"]);
  if (Object.keys(mail).length) {
    putBool("notify_mail_enabled", mail["enabled"]);
    put("notify_mail_host", mail["host"]);
    put("notify_mail_port", mail["port"]);
    put("notify_mail_security", mail["security"]);
    put("notify_mail_username", mail["username"]);
    put("notify_mail_to", mail["to"]);
    if (mail["password"]) cfg["notify_mail_password"] = String(mail["password"]);
  }

  const wh = rowOf(payload["webhook"]);
  if (Object.keys(wh).length) {
    putBool("notify_wh_enabled", wh["enabled"]);
    put("notify_wh_url", wh["url"]);
    put("notify_wh_method", wh["method"]);
    put("notify_wh_body", wh["body"]);
    if (wh["headers"]) cfg["notify_wh_headers"] = String(wh["headers"]);
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// App + routes
// ---------------------------------------------------------------------------

export const app = new Hono<Bindings>();

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return new Response(
      JSON.stringify({ ok: false, code: err.code, message: err.message }),
      { status: err.status, headers: { "Content-Type": "application/json" } },
    );
  }
  if (err instanceof aliyun.AliyunError) {
    return c.json({ ok: false, code: "aliyun_error", message: err.message }, 502);
  }
  console.error("unhandled API error", err);
  return c.json(
    { ok: false, code: "internal_error", message: "服务器内部错误，请查看日志" },
    500,
  );
});

app.notFound((c) => c.json({ ok: false, code: "not_found", message: "接口不存在" }, 404));

// -- System ---------------------------------------------------------------

app.get("/api/health", (c) => c.json({ status: "ok", version: VERSION }));

app.use("/api/v1/*", async (c, next) => {
  await ensureSchema(c.env.DB);
  await next();
});

app.get("/api/v1/system/init-status", async (c) => {
  const initialized = await isInitialized(c.env);
  const config = initialized ? await repo.getSettings(c.env) : {};
  let authenticated = false;
  if (initialized) {
    try {
      authenticated = Boolean(await currentUser(c));
    } catch {
      authenticated = false;
    }
  }
  return c.json({
    initialized,
    authenticated,
    public_home_enabled: (config["public_home_enabled"] ?? "1") !== "0",
    public_site_title: (config["public_site_title"] || "").trim() || "CDT 云节点流量遥测",
    public_site_subtitle:
      (config["public_site_subtitle"] || "").trim() ||
      "阿里云 ECS · 轻量应用服务器实时在线状态与月度流量配额观察站",
    brand: BRAND,
    version: VERSION,
    repo: REPO,
  });
});

app.get("/api/v1/public/home", async (c) => {
  if (!(await isInitialized(c.env))) {
    throw httpErr(404, "not_initialized", "系统尚未初始化");
  }
  const enabled = (await repo.getSetting(c.env, "public_home_enabled")) ?? "1";
  if (enabled === "0") {
    throw httpErr(403, "public_disabled", "管理员已关闭公开首页，请登录管理后台查看");
  }
  const payload = await analytics.buildPublicHomePayload(c.env);
  c.header("Cache-Control", "no-store");
  return c.json(payload);
});

app.get("/api/v1/dashboard/analytics", async (c) => {
  await requireAdmin(c);
  const daysRaw = Number(c.req.query("days") ?? 7);
  const days = daysRaw === 30 ? 30 : daysRaw === 14 ? 14 : 7;
  const serverIdRaw = Number(c.req.query("server_id") ?? 0);
  const serverId = Number.isInteger(serverIdRaw) && serverIdRaw > 0 ? serverIdRaw : 0;
  const payload = await analytics.buildAdminDashboardPayload(c.env, { days, serverId });
  c.header("Cache-Control", "no-store");
  return c.json(payload);
});

app.post("/api/v1/setup", async (c) => {
  if (await isInitialized(c.env)) {
    throw httpErr(409, "conflict", "系统已初始化");
  }
  const payload = await jsonBody(c);
  const username = strOf(payload["username"]).trim();
  const password = strOf(payload["password"]);
  if (username.length < 3) throw invalid("用户名至少 3 个字符");
  if (password.length < 10) throw invalid("密码至少 10 个字符");
  const secretErr = security.validateCryptoSecrets(
    c.env.ENCRYPTION_KEY,
    c.env.SESSION_SECRET,
  );
  if (secretErr) {
    throw httpErr(503, "missing_secret", secretErr);
  }
  await repo.setSettings(c.env, {
    admin_username: username,
    admin_password: await security.hashPassword(password),
    initialized: "1",
  });
  await repo.addEvent(c.env, "system", messages.ev("系统初始化完成"), {
    detail: `已初始化 / 管理员 ${username}`,
  });
  await attachSession(c, username);
  return c.json({ ok: true });
});

// -- Auth -----------------------------------------------------------------

app.post("/api/v1/auth/login", async (c) => {
  const client = clientIp(c);
  if (rateLimited(client)) {
    throw httpErr(429, "rate_limited", "尝试过于频繁，请 5 分钟后再试");
  }
  if (!c.env.SESSION_SECRET?.trim()) {
    throw httpErr(
      503,
      "missing_secret",
      "缺少必填 Secret：SESSION_SECRET。请在 Cloudflare Worker 的 Settings → Variables and Secrets 中添加后重试",
    );
  }
  const payload = await jsonBody(c);
  const username = strOf(payload["username"]).trim();
  const password = strOf(payload["password"]);
  const storedUser = await repo.getSetting(c.env, "admin_username");
  const storedHash = await repo.getSetting(c.env, "admin_password");
  if (username !== storedUser || !(await security.verifyPassword(password, storedHash ?? ""))) {
    recordFailure(client);
    throw httpErr(401, "unauthorized", "用户名或密码不正确");
  }
  resetFailures(client);
  await attachSession(c, username);
  return c.json({ ok: true, username });
});

app.post("/api/v1/auth/logout", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const token = getCookie(c, SESSION_COOKIE) ?? "";
  await repo.revokeSession(
    c.env,
    await security.sessionId(token),
    Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  );
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  deleteCookie(c, CSRF_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/v1/auth/me", async (c) => {
  const user = await requireAdmin(c);
  return c.json({ username: user });
});

// -- Overview ---------------------------------------------------------------

function swasSummary(
  item: repo.SwasServerView,
  config?: Record<string, string> | null,
): Record<string, unknown> {
  return {
    id: item.id,
    label: item.label,
    access_key_id: item.access_key_id,
    access_key_masked: item.access_key_masked ?? "",
    secret_configured: item.secret_configured,
    region_id: item.region_id,
    site: item.site,
    instance_id: item.instance_id,
    remark: item.remark,
    instance_status: item.instance_status,
    public_ip: item.public_ip,
    inner_ip: item.inner_ip,
    plan_id: item.plan_id,
    plan_type: item.plan_type,
    cpu: item.cpu,
    memory_gb: item.memory_gb,
    disk_size_gb: item.disk_size_gb,
    bandwidth_mbps: item.bandwidth_mbps,
    image_name: item.image_name,
    os_type: item.os_type,
    expired_time: item.expired_time,
    business_status: item.business_status,
    traffic_used_gb: item.traffic_used_gb,
    traffic_total_gb: item.traffic_total_gb,
    traffic_overflow_gb: item.traffic_overflow_gb,
    status_checked_at: item.status_checked_at,
    traffic_checked_at: item.traffic_checked_at,
    sort_order: item.sort_order,
    created_at: item.created_at,
    billing: billing.summaryOf(item, config),
  };
}

app.get("/api/v1/overview", async (c) => {
  await requireAdmin(c);
  const env = c.env;
  const config = await repo.getSettings(env);
  const tzName = config["timezone"] || "Asia/Shanghai";
  const now = tzNow(tzName);
  const channels = notify.enabledChannels(env, config);
  const keepalives = await repo.listKeepalives(env);
  const groups = await repo.listGroups(env);
  const servers = await repo.listServers(env);
  const swasServers = await repo.listSwasServers(env);
  const managed = managedMap(groups, keepalives);
  const books = await dns.recordBooks(env);
  const cards = await dns.booksForCards(env, now.epoch, books);
  const nowDate = new Date(now.epoch * 1000);

  return c.json({
    now: now.iso,
    now_ts: now.epoch,
    now_label: now.label,
    today: now.dateStr,
    month_days: now.monthDays,
    timezone: config["timezone"],
    version: VERSION,
    brand: BRAND,
    repo: REPO,
    servers: servers.map((s) => serverSummary(s, managed, cards)),
    swas_servers: swasServers.map((s) => swasSummary(s, config)),
    keepalives: keepalives.map((item) => ({
      ...item,
      in_window: keepaliveWindow(item as unknown as Keepalive, nowDate, tzName),
      dns_record: (books.servers[numOf(item["server_id"])] ?? []).join("、"),
    })),
    groups: await Promise.all(
      groups.map((g) => groupPayload(env, g, config, now.epoch, managed, books)),
    ),
    dns: await dns.snapshot(env, config, now.epoch),
    notifications: {
      channels,
      telegram: channels.includes("telegram"),
      email: channels.includes("email"),
      webhook: channels.includes("webhook"),
    },
    events: await repo.listEvents(env, 20, "", ""),
  });
});

app.post("/api/v1/reconcile", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  // SIMPLIFIED: shift.reconcileAll() returns void — the TS engine drops
  // Python's lock/None protocol, so there is no per-item `results` list
  // and no `busy` flag. The round still runs exactly once per call.
  await reconcileAll(c.env);
  await swas.refreshAllSwasServers(c.env).catch(() => 0);
  // Manual reconcile also sweeps DNS, same as Python.
  return c.json({
    results: [],
    busy: false,
    dns: await dns.reconcile(c.env, await repo.getSettings(c.env)),
  });
});

// -- Servers ----------------------------------------------------------------

app.get("/api/v1/servers", async (c) => {
  await requireAdmin(c);
  const managed = managedMap(
    await repo.listGroups(c.env),
    await repo.listKeepalives(c.env),
  );
  const cards = await dns.booksForCards(c.env);
  return c.json({
    items: (await repo.listServers(c.env)).map((s) =>
      serverSummary(s, managed, cards),
    ),
  });
});

app.post("/api/v1/servers", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  return c.json({ id: await repo.upsertServer(c.env, payload) });
});

app.post("/api/v1/servers/reorder", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  const ids = payload["ids"];
  if (!Array.isArray(ids) || ids.length === 0) {
    throw httpErr(400, "invalid_request", "ids 必须是非空的有序数组");
  }
  let ordered: number[];
  try {
    ordered = ids.map((i) => {
      const n = Number(i);
      if (!Number.isInteger(n)) throw new Error("nan");
      return n;
    });
  } catch {
    throw httpErr(400, "invalid_request", "ids 里的元素必须是数字");
  }
  await repo.reorderServers(c.env, ordered);
  return c.json({ ok: true });
});

app.delete("/api/v1/servers/:serverId", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  await repo.deleteServer(c.env, paramInt(c, "serverId"));
  return c.json({ ok: true });
});

app.post("/api/v1/servers/:serverId/refresh", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  return c.json(await refreshServer(c.env, paramInt(c, "serverId")));
});

app.post("/api/v1/servers/:serverId/billing", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const snapshot = await billing.refreshServer(c.env, paramInt(c, "serverId"), {
    force: true,
  });
  if (snapshot === null || snapshot === undefined) {
    throw httpErr(400, "invalid_request", "费用查询已关闭，或服务器不存在");
  }
  const snap = rowOf(snapshot);
  if (snap["error"] && snap["monthly_cost"] == null) {
    throw httpErr(502, "bad_gateway", strOf(snap["error"]));
  }
  return c.json(snap);
});

app.post("/api/v1/servers/:serverId/actions/:action", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  return c.json(
    await manualAction(c.env, paramInt(c, "serverId"), c.req.param("action")),
  );
});

app.get("/api/v1/servers/:serverId/samples", async (c) => {
  await requireAdmin(c);
  const hoursRaw = Number(c.req.query("hours") ?? 72);
  const hours = Math.max(1, Math.min(Number.isFinite(hoursRaw) ? hoursRaw : 72, 720));
  return c.json({
    items: await repo.listSamples(c.env, paramInt(c, "serverId"), hours),
  });
});

async function loadServerAccount(
  env: Env,
  serverId: number,
): Promise<{ server: ServerView; account: aliyun.AliyunAccount }> {
  const server = await repo.getServer(env, serverId, true);
  if (!server) throw httpErr(404, "not_found", "服务器不存在");
  const instanceId = strOf(server.instance_id).trim();
  const regionId = strOf(server.region_id).trim();
  const ak = strOf(server.access_key_id).trim();
  const sk = strOf(server.access_key_secret).trim();
  if (!ak || !sk) {
    throw invalid("这台服务器的 AccessKey 凭据不完整，请先在编辑中补全");
  }
  if (!regionId) throw invalid("这台服务器未填写地域，请先编辑补全");
  if (!instanceId) throw invalid("这台服务器未填写实例 ID，请先编辑补全");
  return {
    server,
    account: {
      access_key_id: ak,
      access_key_secret: sk,
      region_id: regionId,
      site: repo.normalizeSite(server.site),
      instance_id: instanceId,
      stop_mode: repo.normalizeStopMode(server.stop_mode),
      quota_gb: finiteGb(server.quota_gb, 200),
    },
  };
}

// Discover ECS instances using form credentials (or an existing server's stored
// credentials when editing with blank AK/SK fields).
app.post("/api/v1/aliyun/instances", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  const serverId = numOf(payload["server_id"], 0);
  let ak = strOf(payload["access_key_id"]).trim();
  let sk = strOf(payload["access_key_secret"]).trim();
  let site = strOf(payload["site"]).trim();
  let regionId = strOf(payload["region_id"]).trim();
  const scanAll = boolOf(payload["scan_all"]);

  if (serverId > 0 && (!ak || !sk)) {
    const existing = await repo.getServer(c.env, serverId, true);
    if (!existing) throw httpErr(404, "not_found", "服务器不存在");
    if (!ak) ak = strOf(existing.access_key_id).trim();
    if (!sk) sk = strOf(existing.access_key_secret).trim();
    if (!site) site = repo.normalizeSite(existing.site);
    if (!regionId) regionId = strOf(existing.region_id).trim();
  }

  if (!ak || !sk) {
    throw invalid("请先填写 AccessKey ID 与 AccessKey Secret");
  }
  const resolvedSite = site === "international" ? "international" : "china";
  const result = await aliyun.discoverInstances(
    c.env,
    { access_key_id: ak, access_key_secret: sk, site: resolvedSite },
    { regionId: regionId || "cn-hongkong", scanAll },
  );
  return c.json(result);
});

app.get("/api/v1/servers/:serverId/detail", async (c) => {
  await requireAdmin(c);
  const { account } = await loadServerAccount(c.env, paramInt(c, "serverId"));
  const [detailResult, disksResult] = await Promise.allSettled([
    aliyun.getInstanceDetail(c.env, account),
    aliyun.listInstanceDisks(c.env, account),
  ]);
  if (detailResult.status === "rejected") throw detailResult.reason;
  const disks = disksResult.status === "fulfilled" ? disksResult.value : [];
  const diskError =
    disksResult.status === "rejected"
      ? disksResult.reason instanceof Error
        ? disksResult.reason.message
        : String(disksResult.reason)
      : "";
  return c.json({
    detail: detailResult.value,
    disks,
    disk_error: diskError,
  });
});

app.post("/api/v1/servers/:serverId/reboot", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const serverId = paramInt(c, "serverId");
  const { server, account } = await loadServerAccount(c.env, serverId);
  const payload = await jsonBody(c);
  const force = boolOf(payload["force"]);
  await aliyun.rebootInstance(c.env, account, force);
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev(force ? "强制重启" : "手动重启", messages.objServer(server.label)),
    {
      detail: `已发送${force ? "强制" : "正常"}重启指令（${account.instance_id}）`,
      level: "info",
      serverId,
    },
  );
  return c.json({ ok: true, force });
});

app.post("/api/v1/servers/:serverId/vnc", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const { account } = await loadServerAccount(c.env, paramInt(c, "serverId"));
  const [vnc, detailRes] = await Promise.all([
    aliyun.getInstanceVncUrl(c.env, account),
    aliyun.getInstanceDetail(c.env, account).catch(() => null),
  ]);
  return c.json({
    vnc_url: vnc.vnc_url,
    console_url: vnc.console_url,
    instance_id: account.instance_id,
    region_id: account.region_id,
    os_name: detailRes?.os_name ?? "",
    os_type: detailRes?.os_type ?? "",
  });
});

app.get("/api/v1/servers/:serverId/account-id", async (c) => {
  await requireAdmin(c);
  const { account } = await loadServerAccount(c.env, paramInt(c, "serverId"));
  const accountId = await aliyun.getCallerAccountId(c.env, account);
  return c.json({ account_id: accountId });
});

app.get("/api/v1/servers/:serverId/images", async (c) => {
  await requireAdmin(c);
  const { account } = await loadServerAccount(c.env, paramInt(c, "serverId"));
  const ownerRaw = (c.req.query("owner") ?? "system").trim();
  const allowedOwners = new Set(["system", "self", "others", "marketplace"]);
  const ownerAlias = allowedOwners.has(ownerRaw) ? ownerRaw : "system";
  const osRaw = (c.req.query("ostype") ?? "").trim().toLowerCase();
  const osType = osRaw === "linux" || osRaw === "windows" ? osRaw : "";
  const includeAllStatus = c.req.query("all_status") === "1";
  const items = await aliyun.listImages(c.env, account, {
    ownerAlias,
    osType,
    includeAllStatus,
  });
  return c.json({ items });
});

app.post("/api/v1/servers/:serverId/images", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const serverId = paramInt(c, "serverId");
  const { server, account } = await loadServerAccount(c.env, serverId);
  const payload = await jsonBody(c);
  const imageName = strOf(payload["image_name"]).trim();
  const description = strOf(payload["description"]).trim();
  if (imageName.length < 2 || imageName.length > 128) {
    throw invalid("镜像名称长度需为 2–128 个字符");
  }
  if (/^https?:\/\//i.test(imageName)) {
    throw invalid("镜像名称不能以 http:// 或 https:// 开头");
  }
  if (!/^[A-Za-z\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5:_-]*$/.test(imageName)) {
    throw invalid("镜像名称须以字母或中文开头，只能包含中英文、数字、冒号(:)、下划线(_)或短划线(-)");
  }
  if (description.length > 256 || /^https?:\/\//i.test(description)) {
    throw invalid("镜像描述长度不能超过 256 个字符，且不能以 http:// 或 https:// 开头");
  }
  const res = await aliyun.createImage(c.env, account, {
    imageName,
    description: description || undefined,
  });
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev("创建自定义镜像", messages.objServer(server.label)),
    {
      detail: `镜像 ${imageName}（${res.image_id}）创建中`,
      level: "info",
      serverId,
    },
  );
  return c.json({ image_id: res.image_id });
});

app.delete("/api/v1/servers/:serverId/images/:imageId", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const serverId = paramInt(c, "serverId");
  const { server, account } = await loadServerAccount(c.env, serverId);
  const imageId = c.req.param("imageId").trim();
  if (!imageId) throw invalid("缺少镜像 ID");
  const force = c.req.query("force") === "1";
  await aliyun.deleteImage(c.env, account, imageId, force);
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev("删除自定义镜像", messages.objServer(server.label)),
    {
      detail: `已${force ? "强制" : ""}删除镜像 ${imageId}`,
      level: "warn",
      serverId,
    },
  );
  return c.json({ ok: true });
});

interface MatchedServerTag {
  id: number;
  label: string;
  region_id: string;
}

async function resolveUidServerMap(
  env: Env,
): Promise<Map<string, MatchedServerTag[]>> {
  const servers = await repo.listServers(env, true);
  const uidMap = new Map<string, MatchedServerTag[]>();
  const uniqueAks = new Map<string, ServerView>();
  for (const s of servers) {
    const ak = strOf(s.access_key_id).trim();
    const sk = strOf(s.access_key_secret).trim();
    if (ak && sk && !uniqueAks.has(ak)) uniqueAks.set(ak, s);
  }
  const akToUid = new Map<string, string>();
  await Promise.allSettled(
    Array.from(uniqueAks.entries()).map(async ([ak, s]) => {
      const uid = await aliyun.getCallerAccountId(env, {
        access_key_id: ak,
        access_key_secret: strOf(s.access_key_secret).trim(),
        region_id: strOf(s.region_id).trim() || "cn-hongkong",
        site: repo.normalizeSite(s.site),
      });
      akToUid.set(ak, uid);
    }),
  );
  for (const s of servers) {
    const uid = akToUid.get(strOf(s.access_key_id).trim());
    if (!uid) continue;
    const list = uidMap.get(uid) ?? [];
    list.push({
      id: numOf(s.id),
      label: s.label || s.instance_id || `#${s.id}`,
      region_id: strOf(s.region_id).trim(),
    });
    uidMap.set(uid, list);
  }
  return uidMap;
}

async function enrichShares(
  env: Env,
  account: aliyun.AliyunAccount,
  imageId: string,
) {
  const [rawShares, uidMap] = await Promise.all([
    aliyun.getImageSharePermissions(env, account, imageId),
    resolveUidServerMap(env).catch(() => new Map<string, MatchedServerTag[]>()),
  ]);
  return rawShares.map((item) => ({
    ...item,
    matched_servers: uidMap.get(item.aliyun_id) ?? [],
  }));
}

app.get("/api/v1/servers/:serverId/images/:imageId/shares", async (c) => {
  await requireAdmin(c);
  const { account } = await loadServerAccount(c.env, paramInt(c, "serverId"));
  const imageId = c.req.param("imageId").trim();
  if (!imageId) throw invalid("缺少镜像 ID");
  const items = await enrichShares(c.env, account, imageId);
  return c.json({ items });
});

app.post("/api/v1/servers/:serverId/images/:imageId/shares", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const serverId = paramInt(c, "serverId");
  const { server, account } = await loadServerAccount(c.env, serverId);
  const imageId = c.req.param("imageId").trim();
  if (!imageId) throw invalid("缺少镜像 ID");

  const payload = await jsonBody(c);
  const action = strOf(payload["action"]).trim().toLowerCase();
  if (action !== "add" && action !== "remove") {
    throw invalid("action 必须为 add 或 remove");
  }

  const targetServerId = numOf(payload["target_server_id"], 0);
  const rawAccounts = Array.isArray(payload["accounts"]) ? payload["accounts"] : [];
  const accountSet = new Set<string>();
  let targetLabel = "";
  let crossRegionWarning = "";

  if (targetServerId > 0) {
    if (targetServerId === serverId) {
      throw invalid("不能选择当前服务器自身作为共享目标");
    }
    const target = await loadServerAccount(c.env, targetServerId);
    targetLabel = target.server.label || target.account.instance_id;
    const [sourceUid, targetUid] = await Promise.all([
      aliyun.getCallerAccountId(c.env, account).catch(() => ""),
      aliyun.getCallerAccountId(c.env, target.account),
    ]);
    if (action === "add" && sourceUid && sourceUid === targetUid) {
      throw invalid(
        `「${targetLabel}」与当前服务器属于同一个阿里云主账号（UID ${targetUid}），同账号同地域下自定义镜像天然互通，无需共享`,
      );
    }
    if (action === "add" && target.account.region_id !== account.region_id) {
      crossRegionWarning = `已共享给「${targetLabel}」所在账号（UID ${targetUid}），但阿里云共享镜像仅在源地域（${account.region_id}）生效，与目标服务器地域（${target.account.region_id}）不同。`;
    }
    accountSet.add(targetUid);
  }

  for (const item of rawAccounts) {
    const uid = strOf(item).trim();
    if (!uid) continue;
    if (!/^\d{6,32}$/.test(uid)) {
      throw invalid(`无效的阿里云账号 UID「${uid}」（应为纯数字主账号 UID，可在阿里云账号中心查看）`);
    }
    accountSet.add(uid);
  }

  const uids = Array.from(accountSet);
  if (uids.length === 0) {
    throw invalid("请选择目标服务器或输入至少一个阿里云账号 UID");
  }
  if (uids.length > 10) {
    throw invalid("阿里云单次最多支持添加或取消 10 个共享账号，请分批操作");
  }

  await aliyun.modifyImageSharePermission(
    c.env,
    account,
    imageId,
    action === "add" ? { addAccounts: uids } : { removeAccounts: uids },
  );

  const labelSuffix = targetLabel ? `（${targetLabel}）` : "";
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev(
      action === "add" ? "添加镜像共享" : "取消镜像共享",
      messages.objServer(server.label),
    ),
    {
      detail: `镜像 ${imageId} ${action === "add" ? "共享给" : "取消共享"} ${uids.join("、")}${labelSuffix}`,
      level: "info",
      serverId,
    },
  );

  const shares = await enrichShares(c.env, account, imageId).catch(() => []);
  return c.json({
    ok: true,
    action,
    target_accounts: uids,
    shares,
    cross_region_warning: crossRegionWarning,
  });
});

app.get("/api/v1/servers/:serverId/keypairs", async (c) => {
  await requireAdmin(c);
  const { account } = await loadServerAccount(c.env, paramInt(c, "serverId"));
  const items = await aliyun.listKeyPairs(c.env, account);
  return c.json({ items });
});

app.post("/api/v1/servers/:serverId/reinstall", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const serverId = paramInt(c, "serverId");
  const { server, account } = await loadServerAccount(c.env, serverId);
  const payload = await jsonBody(c);
  const imageId = strOf(payload["image_id"]).trim();
  const password = strOf(payload["password"]);
  const keyPairName = strOf(payload["key_pair_name"]).trim();
  const diskSizeRaw = numOf(payload["system_disk_size"], 0);
  const systemDiskSize = Number.isFinite(diskSizeRaw) && diskSizeRaw > 0 ? Math.trunc(diskSizeRaw) : 0;

  if (!imageId) throw invalid("请选择目标系统镜像");
  if (!password && !keyPairName) throw invalid("请设置新登录密码或指定 SSH 密钥对");
  if (password && (password.length < 8 || password.length > 30)) {
    throw invalid("登录密码长度需为 8–30 位");
  }

  const detail = await aliyun.getInstanceDetail(c.env, account);
  if (detail.status === "Running") {
    // Use KeepCharging (normal stop) before ReplaceSystemDisk per Aliyun docs so
    // pay-as-you-go spot/regular inventory is not released mid-reinstall.
    await aliyun.stopInstance(c.env, account, "KeepCharging", true);
    await repo.addEvent(
      c.env,
      "manual",
      messages.ev("重装系统", messages.objServer(server.label)),
      {
        detail: `开始重装流程（镜像 ${imageId}），正在停止实例`,
        level: "warn",
        serverId,
      },
    );
    return c.json({
      status: "stopping",
      instance_id: account.instance_id,
      message: "正在停止实例，停机完成后自动更换系统盘…",
    });
  }

  if (detail.status === "Stopped") {
    const res = await aliyun.replaceSystemDisk(c.env, account, {
      imageId,
      password: password || undefined,
      keyPairName: keyPairName || undefined,
      systemDiskSize,
    });
    await repo.addEvent(
      c.env,
      "manual",
      messages.ev("重装系统", messages.objServer(server.label)),
      {
        detail: `已提交更换系统盘（镜像 ${imageId}）`,
        level: "warn",
        serverId,
      },
    );
    return c.json({
      status: "reinstalling",
      instance_id: account.instance_id,
      disk_id: res.disk_id,
      message: "重装任务已提交，正在更换系统盘…",
    });
  }

  throw httpErr(
    409,
    "invalid_state",
    `实例当前状态为 ${detail.status}，请等待其进入运行中或已停机后再试`,
  );
});

app.post("/api/v1/servers/:serverId/reinstall-progress", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const serverId = paramInt(c, "serverId");
  const { server, account } = await loadServerAccount(c.env, serverId);
  const payload = await jsonBody(c);
  const phase = strOf(payload["phase"]).trim();
  const imageId = strOf(payload["image_id"]).trim();
  const password = strOf(payload["password"]);
  const keyPairName = strOf(payload["key_pair_name"]).trim();
  const diskSizeRaw = numOf(payload["system_disk_size"], 0);
  const systemDiskSize = Number.isFinite(diskSizeRaw) && diskSizeRaw > 0 ? Math.trunc(diskSizeRaw) : 0;

  if (!phase) throw invalid("缺少阶段参数 phase");

  const detail = await aliyun.getInstanceDetail(c.env, account);

  if (phase === "stopping") {
    if (detail.status === "Stopped") {
      if (!imageId) throw invalid("缺少镜像 ID");
      const res = await aliyun.replaceSystemDisk(c.env, account, {
        imageId,
        password: password || undefined,
        keyPairName: keyPairName || undefined,
        systemDiskSize,
      });
      await repo.addEvent(
        c.env,
        "manual",
        messages.ev("重装系统", messages.objServer(server.label)),
        {
          detail: `实例已停机，已提交更换系统盘（镜像 ${imageId}）`,
          level: "info",
          serverId,
        },
      );
      return c.json({
        status: "reinstalling",
        current_status: detail.status,
        disk_id: res.disk_id,
        message: "实例已停机，正在更换系统盘…",
      });
    }
    return c.json({
      status: "stopping",
      current_status: detail.status,
      message: `正在等待实例停机（当前：${detail.status}）…`,
    });
  }

  if (phase === "reinstalling") {
    const locked = detail.operation_locks.length > 0;
    if (detail.status === "Stopped" && !locked) {
      await aliyun.startInstance(c.env, account);
      await repo.addEvent(
        c.env,
        "manual",
        messages.ev("重装后开机", messages.objServer(server.label)),
        {
          detail: `系统盘更换完成，已发送开机指令（${account.instance_id}）`,
          level: "info",
          serverId,
        },
      );
      return c.json({
        status: "starting",
        current_status: detail.status,
        message: "系统盘更换完成，正在自动开机…",
      });
    }
    return c.json({
      status: "reinstalling",
      current_status: detail.status,
      is_locked: locked,
      message: locked ? "系统盘正在写入重装中…" : "正在等待重装完成…",
    });
  }

  if (phase === "starting") {
    if (detail.status === "Running") {
      try {
        await refreshServer(c.env, serverId);
      } catch {
        // Snapshot refresh failure does not negate completed reinstall.
      }
      return c.json({
        status: "completed",
        current_status: detail.status,
        message: "重装系统完成，实例已启动运行！",
      });
    }
    return c.json({
      status: "starting",
      current_status: detail.status,
      message: `实例正在启动（当前：${detail.status}）…`,
    });
  }

  throw invalid(`未知的重装阶段：${phase}`);
});

// -- Renewal & Auto-Renew -----------------------------------------------------

const VALID_RENEW_MONTHS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 24, 36, 48, 60]);
const VALID_AUTORENEW_MONTHS = new Set([1, 2, 3, 6, 12, 24, 36]);
const VALID_AUTORENEW_YEARS = new Set([1, 2, 3, 4, 5]);
const VALID_AUTORENEW_WEEKS = new Set([1, 2, 3, 4]);

function validateEcsPassword(password: string): void {
  if (password.length < 8 || password.length > 30) {
    throw invalid("登录密码长度需为 8–30 位");
  }
  const classes = [
    /[A-Z]/.test(password),
    /[a-z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9\s]/.test(password),
  ].filter(Boolean).length;
  if (classes < 3) {
    throw invalid("密码须同时包含大写字母、小写字母、数字和特殊符号中的至少三类");
  }
}

function validateEcsInstanceName(name: string): void {
  if (name.length < 2 || name.length > 128) {
    throw invalid("实例名称长度需为 2–128 个字符");
  }
  if (/^https?:\/\//i.test(name)) {
    throw invalid("实例名称不能以 http:// 或 https:// 开头");
  }
  if (!/^[A-Za-z\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5:._-]*$/.test(name)) {
    throw invalid("实例名称须以字母或中文开头，仅允许中英文、数字、冒号(:)、点(.)、下划线(_)或短划线(-)");
  }
}

app.get("/api/v1/servers/:serverId/renewal", async (c) => {
  await requireAdmin(c);
  const { account } = await loadServerAccount(c.env, paramInt(c, "serverId"));
  const detail = await aliyun.getInstanceDetail(c.env, account);
  const isPrePaid = detail.instance_charge_type === "PrePaid";
  if (!isPrePaid) {
    return c.json({
      supported: false,
      instance_id: detail.instance_id,
      instance_name: detail.instance_name,
      status: detail.status,
      instance_charge_type: detail.instance_charge_type,
      expired_time: detail.expired_time,
      auto_renew: null,
      balance: null,
      console_urls: aliyun.buildRenewalConsoleUrls(account),
      reason: "当前实例为按量付费（PostPaid），按使用时长实时计费，无需也不支持续费。",
    });
  }
  const [autoRenew, balance] = await Promise.all([
    aliyun.getInstanceAutoRenewAttribute(c.env, account).catch(() => null),
    aliyun.getAccountBalance(c.env, account, true).catch(() => null),
  ]);
  return c.json({
    supported: true,
    instance_id: detail.instance_id,
    instance_name: detail.instance_name,
    status: detail.status,
    instance_charge_type: detail.instance_charge_type,
    expired_time: detail.expired_time,
    auto_renew: autoRenew,
    balance,
    console_urls: aliyun.buildRenewalConsoleUrls(account, balance?.site),
    reason: "",
  });
});

app.post("/api/v1/servers/:serverId/renewal/price", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const { account } = await loadServerAccount(c.env, paramInt(c, "serverId"));
  const payload = await jsonBody(c);
  const months = Math.trunc(numOf(payload["period_months"], 1));
  if (!VALID_RENEW_MONTHS.has(months)) {
    throw invalid("续费时长仅支持 1–9 个月或 1–5 年（12 / 24 / 36 / 48 / 60 个月）");
  }
  const quote = await aliyun.describeRenewalPrice(c.env, account, {
    period: months >= 12 && months % 12 === 0 ? months / 12 : months,
    periodUnit: months >= 12 && months % 12 === 0 ? "Year" : "Month",
  });
  return c.json({ quote, period_months: months });
});

app.post("/api/v1/servers/:serverId/renewal/pay", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const serverId = paramInt(c, "serverId");
  const { server, account } = await loadServerAccount(c.env, serverId);
  const payload = await jsonBody(c);
  const months = Math.trunc(numOf(payload["period_months"], 0));
  if (!VALID_RENEW_MONTHS.has(months)) {
    throw invalid("续费时长仅支持 1–9 个月或 1–5 年（12 / 24 / 36 / 48 / 60 个月）");
  }
  if (!boolOf(payload["confirm_pay"])) {
    throw invalid("请先确认续费价格并勾选扣费确认后再提交");
  }
  const clientToken = strOf(payload["client_token"]).trim();
  const res = await aliyun.renewInstance(c.env, account, {
    periodMonths: months,
    clientToken: clientToken || undefined,
  });
  const [detail, balance] = await Promise.all([
    aliyun.getInstanceDetail(c.env, account).catch(() => null),
    aliyun.getAccountBalance(c.env, account, true).catch(() => null),
  ]);
  const consoleUrls = aliyun.buildRenewalConsoleUrls(account, balance?.site);
  const periodLabel = months >= 12 && months % 12 === 0 ? `${months / 12} 年` : `${months} 个月`;
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev("包年包月续费", messages.objServer(server.label)),
    {
      detail: `已续费 ${periodLabel}（订单 ${res.order_id || "—"}，实例 ${account.instance_id}）`,
      level: "info",
      serverId,
    },
  );
  return c.json({
    ok: true,
    order_id: res.order_id,
    expired_time: detail?.expired_time ?? "",
    balance,
    orders_url: consoleUrls.orders_url,
  });
});

app.post("/api/v1/servers/:serverId/renewal/auto", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const serverId = paramInt(c, "serverId");
  const { server, account } = await loadServerAccount(c.env, serverId);
  const payload = await jsonBody(c);
  const statusRaw = strOf(payload["renewal_status"]).trim();
  if (statusRaw !== "AutoRenewal" && statusRaw !== "Normal" && statusRaw !== "NotRenewal") {
    throw invalid("自动续费状态仅支持 AutoRenewal、Normal 或 NotRenewal");
  }
  const unitRaw = strOf(payload["period_unit"]).trim() || "Month";
  if (unitRaw !== "Month" && unitRaw !== "Year" && unitRaw !== "Week") {
    throw invalid("自动续费周期单位仅支持 Month、Year 或 Week");
  }
  const duration = Math.trunc(numOf(payload["duration"], 1));
  if (statusRaw === "AutoRenewal") {
    const allowed =
      unitRaw === "Year"
        ? VALID_AUTORENEW_YEARS
        : unitRaw === "Week"
          ? VALID_AUTORENEW_WEEKS
          : VALID_AUTORENEW_MONTHS;
    if (!allowed.has(duration)) {
      throw invalid(`当前周期单位（${unitRaw}）不支持时长 ${duration}`);
    }
  }
  await aliyun.modifyInstanceAutoRenewAttribute(c.env, account, {
    renewalStatus: statusRaw,
    duration,
    periodUnit: unitRaw,
  });
  const latest = await aliyun.getInstanceAutoRenewAttribute(c.env, account).catch(() => null);
  const statusText =
    statusRaw === "AutoRenewal"
      ? `开启自动续费（每 ${duration} ${unitRaw === "Year" ? "年" : unitRaw === "Week" ? "周" : "个月"}）`
      : statusRaw === "NotRenewal"
        ? "设为到期不续费"
        : "关闭自动续费（改为手动续费）";
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev("调整自动续费", messages.objServer(server.label)),
    {
      detail: `${statusText}（${account.instance_id}）`,
      level: "info",
      serverId,
    },
  );
  return c.json({ ok: true, auto_renew: latest });
});

// -- Instance Attribute (Password / InstanceName / DeletionProtection) --------

app.post("/api/v1/servers/:serverId/attribute", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const serverId = paramInt(c, "serverId");
  const { server, account } = await loadServerAccount(c.env, serverId);
  const payload = await jsonBody(c);
  const instanceName = strOf(payload["instance_name"]).trim();
  const password = strOf(payload["password"]);
  const hasDeletionProtection =
    payload["deletion_protection"] !== undefined && payload["deletion_protection"] !== null;
  const deletionProtection = hasDeletionProtection
    ? boolOf(payload["deletion_protection"])
    : undefined;
  const syncLabel = boolOf(payload["sync_label"]);
  const rebootAfter = boolOf(payload["reboot_after"]);

  if (!instanceName && !password && deletionProtection === undefined) {
    throw invalid("请至少填写一项要修改的内容（实例名称、新密码或释放保护）");
  }
  if (instanceName) validateEcsInstanceName(instanceName);
  if (password) validateEcsPassword(password);

  await aliyun.modifyInstanceAttribute(c.env, account, {
    instanceName: instanceName || undefined,
    password: password || undefined,
    deletionProtection,
  });

  if (instanceName && syncLabel) {
    await repo.upsertServer(c.env, {
      id: serverId,
      label: instanceName,
      region_id: server.region_id,
      site: server.site,
      instance_id: server.instance_id,
      quota_gb: server.quota_gb,
      threshold_gb: server.threshold_gb,
      remark: server.remark,
      stop_mode: server.stop_mode,
    });
  }

  let rebooted = false;
  if (password && rebootAfter) {
    const detail = await aliyun.getInstanceDetail(c.env, account).catch(() => null);
    if (detail?.status === "Running") {
      await aliyun.rebootInstance(c.env, account, false);
      rebooted = true;
    }
  }

  const changed: string[] = [];
  if (instanceName) changed.push(`实例名改为 ${instanceName}`);
  if (password) changed.push(rebooted ? "已重置登录密码并触发重启" : "已重置登录密码（需重启生效）");
  if (deletionProtection !== undefined) {
    changed.push(deletionProtection ? "已开启释放保护" : "已关闭释放保护");
  }
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev("修改实例属性", messages.objServer(instanceName && syncLabel ? instanceName : server.label)),
    {
      detail: `${changed.join("，")}（${account.instance_id}）`,
      level: "info",
      serverId,
    },
  );
  return c.json({ ok: true, rebooted });
});

// -- Security Group Rules -----------------------------------------------------

function normalizePortRange(protocol: string, raw: string): string {
  if (protocol === "ICMP" || protocol === "ALL") return "-1/-1";
  const cleaned = raw.trim();
  if (/^\d+$/.test(cleaned)) {
    const port = Number(cleaned);
    if (port < 1 || port > 65535) throw invalid("端口号须在 1–65535 之间");
    return `${port}/${port}`;
  }
  const match = cleaned.match(/^(\d+)\s*[/\-:]\s*(\d+)$/);
  if (!match) {
    throw invalid("端口范围格式应为单个端口（如 22）或区间（如 8000/9000）");
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 1 || end > 65535 || start > end) {
    throw invalid("端口范围须满足 1 <= 起始端口 <= 结束端口 <= 65535");
  }
  return `${start}/${end}`;
}

function validateCidrIp(raw: string): string {
  const cidr = raw.trim();
  if (!cidr) throw invalid("请输入授权对象 CIDR（例如 0.0.0.0/0）");
  const ipv4Cidr = /^(\d{1,3}\.){3}\d{1,3}(\/(\d{1,2}))?$/;
  const ipv6Cidr = /^[0-9a-fA-F:]+(\/\d{1,3})?$/;
  if (ipv4Cidr.test(cidr)) {
    const [ip, prefixRaw] = cidr.split("/");
    const octets = ip!.split(".").map(Number);
    if (octets.some((o) => o < 0 || o > 255)) throw invalid(`无效的 IPv4 地址：${cidr}`);
    if (prefixRaw !== undefined) {
      const p = Number(prefixRaw);
      if (p < 0 || p > 32) throw invalid(`无效的 IPv4 掩码：${cidr}`);
    }
    return cidr;
  }
  if (cidr.includes(":") && ipv6Cidr.test(cidr)) {
    const [, prefixRaw] = cidr.split("/");
    if (prefixRaw !== undefined) {
      const p = Number(prefixRaw);
      if (p < 0 || p > 128) throw invalid(`无效的 IPv6 掩码：${cidr}`);
    }
    return cidr;
  }
  throw invalid(`无效的授权对象 CIDR「${cidr}」（示例：0.0.0.0/0 或 1.2.3.4/32）`);
}

app.get("/api/v1/servers/:serverId/security-groups", async (c) => {
  await requireAdmin(c);
  const { account } = await loadServerAccount(c.env, paramInt(c, "serverId"));
  const detail = await aliyun.getInstanceDetail(c.env, account);
  const sgIds = detail.security_group_ids;
  if (sgIds.length === 0) {
    return c.json({ security_groups: [] });
  }
  const results = await Promise.all(
    sgIds.map((sgId) => aliyun.describeSecurityGroupAttribute(c.env, account, sgId)),
  );
  return c.json({ security_groups: results });
});

app.post("/api/v1/servers/:serverId/security-groups/:sgId/rules", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const serverId = paramInt(c, "serverId");
  const { server, account } = await loadServerAccount(c.env, serverId);
  const sgId = c.req.param("sgId").trim();
  if (!sgId) throw invalid("缺少安全组 ID");

  const payload = await jsonBody(c);
  const directionRaw = strOf(payload["direction"]).trim().toLowerCase();
  const direction = directionRaw === "egress" ? "egress" : "ingress";
  const protocolRaw = strOf(payload["ip_protocol"]).trim().toUpperCase();
  if (
    protocolRaw !== "TCP" &&
    protocolRaw !== "UDP" &&
    protocolRaw !== "ICMP" &&
    protocolRaw !== "ALL"
  ) {
    throw invalid("协议类型仅支持 TCP、UDP、ICMP 或 ALL");
  }
  const portRange = normalizePortRange(protocolRaw, strOf(payload["port_range"]));
  const cidrIp = validateCidrIp(strOf(payload["cidr_ip"]) || "0.0.0.0/0");
  const policyRaw = strOf(payload["policy"]).trim().toLowerCase();
  const policy = policyRaw === "drop" ? "drop" : "accept";
  const priority = Math.min(100, Math.max(1, Math.trunc(numOf(payload["priority"], 1))));
  const description = strOf(payload["description"]).trim().slice(0, 256);

  await aliyun.authorizeSecurityGroupRule(c.env, account, {
    securityGroupId: sgId,
    direction,
    ipProtocol: protocolRaw,
    portRange,
    cidrIp,
    policy,
    priority,
    description: description || undefined,
  });
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev("添加安全组规则", messages.objServer(server.label)),
    {
      detail: `${sgId} ${direction === "ingress" ? "入方向" : "出方向"} ${policy === "accept" ? "允许" : "拒绝"} ${protocolRaw} ${portRange} (${cidrIp})`,
      level: "info",
      serverId,
    },
  );
  const updated = await aliyun.describeSecurityGroupAttribute(c.env, account, sgId);
  return c.json({ ok: true, security_group: updated });
});

app.delete("/api/v1/servers/:serverId/security-groups/:sgId/rules/:ruleId", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const serverId = paramInt(c, "serverId");
  const { server, account } = await loadServerAccount(c.env, serverId);
  const sgId = c.req.param("sgId").trim();
  const ruleId = c.req.param("ruleId").trim();
  if (!sgId || !ruleId) throw invalid("缺少安全组 ID 或规则 ID");
  const dirQuery = (c.req.query("direction") ?? "ingress").trim().toLowerCase();
  const direction = dirQuery === "egress" ? "egress" : "ingress";

  await aliyun.revokeSecurityGroupRule(c.env, account, {
    securityGroupId: sgId,
    direction,
    ruleId,
  });
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev("删除安全组规则", messages.objServer(server.label)),
    {
      detail: `${sgId} 移除${direction === "ingress" ? "入方向" : "出方向"}规则 ${ruleId}`,
      level: "warn",
      serverId,
    },
  );
  const updated = await aliyun.describeSecurityGroupAttribute(c.env, account, sgId);
  return c.json({ ok: true, security_group: updated });
});

// -- Instance Release (Destroy on Aliyun) -------------------------------------

app.post("/api/v1/servers/:serverId/release", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const serverId = paramInt(c, "serverId");
  const { server, account } = await loadServerAccount(c.env, serverId);
  const payload = await jsonBody(c);
  const confirmId = strOf(payload["confirm_instance_id"]).trim();
  const force = boolOf(payload["force"]);
  const terminateSubscription = boolOf(payload["terminate_subscription"]);
  const removeFromPanel = boolOf(payload["remove_from_panel"]);

  if (confirmId !== account.instance_id) {
    throw invalid(`确认实例 ID 不匹配，请完整输入 ${account.instance_id}`);
  }

  // Block destroying an instance that is actively managed by keepalive or shift group.
  const managed = managedMap(
    await repo.listGroups(c.env),
    await repo.listKeepalives(c.env),
  ).get(serverId);
  if (managed?.active) {
    throw httpErr(
      409,
      "managed_conflict",
      `这台服务器正由「${managed.name}」托管运行，请先暂停或移出托管后再释放实例`,
    );
  }

  await aliyun.deleteInstance(c.env, account, {
    force,
    forceStop: true,
    terminateSubscription,
  });

  await repo.addEvent(
    c.env,
    "manual",
    messages.ev("释放云端实例", messages.objServer(server.label)),
    {
      detail: `已向阿里云提交释放指令（${account.instance_id}${force ? "，强制释放" : ""}）${removeFromPanel ? "，并从本面板移除" : ""}`,
      level: "warn",
      serverId: removeFromPanel ? 0 : serverId,
    },
  );

  if (removeFromPanel) {
    await repo.deleteServer(c.env, serverId);
  }
  return c.json({ ok: true, removed_from_panel: removeFromPanel });
});

// -- Provision New ECS Instance -----------------------------------------------

async function resolveProvisionAccount(
  env: Env,
  payload: AnyRow,
): Promise<{ account: aliyun.AliyunAccount; site: string }> {
  const sourceServerId = numOf(payload["source_server_id"], 0);
  let ak = strOf(payload["access_key_id"]).trim();
  let sk = strOf(payload["access_key_secret"]).trim();
  let site = strOf(payload["site"]).trim();
  const regionId = strOf(payload["region_id"]).trim();

  if (sourceServerId > 0) {
    const existing = await repo.getServer(env, sourceServerId, true);
    if (!existing) throw httpErr(404, "not_found", "所选来源服务器不存在");
    ak = strOf(existing.access_key_id).trim();
    sk = strOf(existing.access_key_secret).trim();
    if (!site) site = repo.normalizeSite(existing.site);
  }
  if (!ak || !sk) {
    throw invalid("请选择已有服务器账号，或填写完整的 AccessKey ID 与 AccessKey Secret");
  }
  if (!regionId) {
    throw invalid("请选择目标地域");
  }
  const normalizedSite = repo.normalizeSite(site);
  return {
    site: normalizedSite,
    account: {
      access_key_id: ak,
      access_key_secret: sk,
      region_id: regionId,
      site: normalizedSite,
      instance_id: "",
    },
  };
}

const VALID_SYSTEM_DISK_CATEGORIES = new Set([
  "cloud_essd",
  "cloud_essd_entry",
  "cloud_efficiency",
  "cloud_ssd",
  "cloud_auto",
]);

app.post("/api/v1/aliyun/provision/options", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  const { account } = await resolveProvisionAccount(c.env, payload);
  const chargeType = strOf(payload["charge_type"]).trim() === "PrePaid" ? "PrePaid" : "PostPaid";
  const imageOwnerRaw = strOf(payload["image_owner"]).trim() || "system";
  const imageOwner = new Set(["system", "self", "others"]).has(imageOwnerRaw)
    ? imageOwnerRaw
    : "system";

  const [resources, images, keyPairs] = await Promise.all([
    aliyun.listProvisionResources(c.env, account, { chargeType }),
    aliyun
      .listImages(c.env, account, { ownerAlias: imageOwner })
      .catch(() => [] as aliyun.EcsImage[]),
    aliyun.listKeyPairs(c.env, account).catch(() => [] as string[]),
  ]);
  return c.json({
    ...resources,
    images,
    key_pairs: keyPairs,
  });
});

app.post("/api/v1/aliyun/provision/init-network", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  const { account } = await resolveProvisionAccount(c.env, payload);
  const zoneId = strOf(payload["zone_id"]).trim();
  if (!zoneId) throw invalid("请先选择可用区");
  const created = await aliyun.ensureDefaultNetwork(c.env, account, zoneId);
  const refreshed = await aliyun.listProvisionResources(c.env, account, {
    chargeType: "PostPaid",
  });
  return c.json({
    ok: true,
    created,
    vswitches: refreshed.vswitches,
    security_groups: refreshed.security_groups,
  });
});

app.post("/api/v1/aliyun/provision/price", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  const { account } = await resolveProvisionAccount(c.env, payload);
  const instanceType = strOf(payload["instance_type"]).trim();
  if (!instanceType) throw invalid("请先选择或输入实例规格");
  const chargeType = strOf(payload["charge_type"]).trim() === "PrePaid" ? "PrePaid" : "PostPaid";
  const periodMonths = Math.trunc(numOf(payload["period_months"], 1));
  if (chargeType === "PrePaid" && !VALID_RENEW_MONTHS.has(periodMonths)) {
    throw invalid("包年包月购买时长仅支持 1–9 个月或 1–3 年（12 / 24 / 36 个月）");
  }
  const diskCategory = strOf(payload["system_disk_category"]).trim() || "cloud_essd";
  if (!VALID_SYSTEM_DISK_CATEGORIES.has(diskCategory)) {
    throw invalid(`不支持的系统盘类型：${diskCategory}`);
  }
  const diskSize = Math.trunc(numOf(payload["system_disk_size"], 40));
  if (diskSize < 20 || diskSize > 2048) {
    throw invalid("系统盘容量须在 20–2048 GiB 之间");
  }
  const netChargeType =
    strOf(payload["internet_charge_type"]).trim() === "PayByBandwidth"
      ? "PayByBandwidth"
      : "PayByTraffic";
  const bwOut = Math.trunc(numOf(payload["internet_max_bandwidth_out"], 100));
  if (bwOut < 0 || bwOut > 200) {
    throw invalid("公网出带宽上限须在 0–200 Mbps 之间");
  }
  const quote = await aliyun.describeInstancePrice(c.env, account, {
    instanceType,
    imageId: strOf(payload["image_id"]).trim() || undefined,
    chargeType,
    periodMonths,
    systemDiskCategory: diskCategory,
    systemDiskSize: diskSize,
    internetChargeType: netChargeType,
    internetMaxBandwidthOut: bwOut,
  });
  return c.json({ quote });
});

app.post("/api/v1/aliyun/provision/create", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  if (!boolOf(payload["confirm_pay"])) {
    throw invalid("请先完成询价并勾选扣费确认后再开通实例");
  }
  const { account, site } = await resolveProvisionAccount(c.env, payload);
  const instanceType = strOf(payload["instance_type"]).trim();
  const imageId = strOf(payload["image_id"]).trim();
  const vswitchId = strOf(payload["vswitch_id"]).trim();
  const securityGroupId = strOf(payload["security_group_id"]).trim();
  const zoneId = strOf(payload["zone_id"]).trim();
  const instanceName = strOf(payload["instance_name"]).trim();
  const chargeType = strOf(payload["charge_type"]).trim() === "PrePaid" ? "PrePaid" : "PostPaid";
  const periodMonths = Math.trunc(numOf(payload["period_months"], 1));
  const autoRenew = boolOf(payload["auto_renew"]);
  const diskCategory = strOf(payload["system_disk_category"]).trim() || "cloud_essd";
  const diskSize = Math.trunc(numOf(payload["system_disk_size"], 40));
  const netChargeType =
    strOf(payload["internet_charge_type"]).trim() === "PayByBandwidth"
      ? "PayByBandwidth"
      : "PayByTraffic";
  const bwOut = Math.trunc(numOf(payload["internet_max_bandwidth_out"], 100));
  const authMode = strOf(payload["auth_mode"]).trim() || "password";
  const password = strOf(payload["password"]);
  const keyPairName = strOf(payload["key_pair_name"]).trim();
  const addToPanel = payload["add_to_panel"] !== false;
  const panelLabel = strOf(payload["panel_label"]).trim();
  const quotaGb = numOf(payload["quota_gb"], 200);
  const thresholdGb = numOf(payload["threshold_gb"], 188);
  const clientToken = strOf(payload["client_token"]).trim();

  if (!instanceType) throw invalid("请选择或输入实例规格");
  if (!imageId) throw invalid("请选择系统镜像");
  if (!vswitchId) throw invalid("请选择虚拟交换机（若当前地域尚无网络，请先点击初始化默认网络）");
  if (!securityGroupId) throw invalid("请选择安全组");
  if (instanceName) validateEcsInstanceName(instanceName);
  if (chargeType === "PrePaid" && !VALID_RENEW_MONTHS.has(periodMonths)) {
    throw invalid("包年包月购买时长仅支持 1–9 个月或 1–3 年（12 / 24 / 36 个月）");
  }
  if (!VALID_SYSTEM_DISK_CATEGORIES.has(diskCategory)) {
    throw invalid(`不支持的系统盘类型：${diskCategory}`);
  }
  if (diskSize < 20 || diskSize > 2048) {
    throw invalid("系统盘容量须在 20–2048 GiB 之间");
  }
  if (bwOut < 0 || bwOut > 200) {
    throw invalid("公网出带宽上限须在 0–200 Mbps 之间");
  }
  if (authMode === "password") {
    validateEcsPassword(password);
  } else if (authMode === "keypair") {
    if (!keyPairName) throw invalid("请选择或输入 SSH 密钥对名称");
  } else if (authMode !== "inherit") {
    throw invalid("登录凭证模式仅支持 password、keypair 或 inherit");
  }

  const created = await aliyun.runInstances(c.env, account, {
    zoneId: zoneId || undefined,
    imageId,
    instanceType,
    securityGroupId,
    vswitchId,
    instanceName: instanceName || undefined,
    chargeType,
    periodMonths,
    autoRenew: chargeType === "PrePaid" ? autoRenew : false,
    systemDiskCategory: diskCategory,
    systemDiskSize: diskSize,
    internetChargeType: netChargeType,
    internetMaxBandwidthOut: bwOut,
    password: authMode === "password" ? password : undefined,
    keyPairName: authMode === "keypair" ? keyPairName : undefined,
    passwordInherit: authMode === "inherit",
    clientToken: clientToken || undefined,
  });

  const newInstanceId = created.instance_ids[0] ?? "";
  let serverId = 0;
  if (addToPanel && newInstanceId) {
    const label = panelLabel || instanceName || newInstanceId;
    serverId = await repo.upsertServer(c.env, {
      label,
      access_key_id: account.access_key_id,
      access_key_secret: account.access_key_secret,
      region_id: account.region_id,
      site,
      instance_id: newInstanceId,
      quota_gb: quotaGb > 0 ? quotaGb : 200,
      threshold_gb: thresholdGb > 0 && thresholdGb <= (quotaGb > 0 ? quotaGb : 200)
        ? thresholdGb
        : Math.max(1, Math.round((quotaGb > 0 ? quotaGb : 200) * 0.94)),
      remark: `${instanceType} · ${chargeType === "PrePaid" ? "包年包月" : "按量付费"}`,
      stop_mode: chargeType === "PostPaid" ? "StopCharging" : "Stop",
    });
    // Best-effort initial status sync; newly launched instances may still be Pending.
    await refreshServer(c.env, serverId).catch(() => {});
  }

  await repo.addEvent(
    c.env,
    "manual",
    messages.ev("开通新 ECS 实例", messages.objServer(panelLabel || instanceName || newInstanceId)),
    {
      detail: `地域 ${account.region_id} · ${instanceType} · ${chargeType === "PrePaid" ? `包年包月 ${periodMonths} 个月` : "按量付费"} · 实例 ${newInstanceId || "—"}（订单 ${created.order_id || "—"}）`,
      level: "info",
      serverId,
    },
  );

  return c.json({
    ok: true,
    instance_id: newInstanceId,
    instance_ids: created.instance_ids,
    order_id: created.order_id,
    trade_price: created.trade_price,
    server_id: serverId,
  });
});

// -- Lightweight Application Server (Aliyun SWAS) -----------------------------

async function loadSwasAccount(
  env: Env,
  swasId: number,
): Promise<{ server: repo.SwasServerView; account: aliyun.AliyunAccount }> {
  const server = await repo.getSwasServer(env, swasId, true);
  if (!server) throw httpErr(404, "not_found", "轻量服务器不存在");
  if (!server.access_key_secret) {
    throw invalid("这台轻量服务器还没有配置 AccessKey Secret，请先编辑补全");
  }
  return { server, account: swas.toAccount(server) };
}

/**
 * Resolve Aliyun credentials for SWAS discover / import / provision.
 * Supports reusing an existing ECS server (`source_server_id`), an existing
 * SWAS server (`source_swas_id`), or explicit AK/SK in the request payload.
 */
async function resolveSwasSourceAccount(
  env: Env,
  payload: AnyRow,
): Promise<{ account: aliyun.AliyunAccount; site: string }> {
  const sourceServerId = numOf(payload["source_server_id"], 0);
  const sourceSwasId = numOf(payload["source_swas_id"], 0);
  let ak = strOf(payload["access_key_id"]).trim();
  let sk = strOf(payload["access_key_secret"]).trim();
  let site = strOf(payload["site"]).trim();
  const regionId = strOf(payload["region_id"]).trim();

  if (sourceSwasId > 0) {
    const existing = await repo.getSwasServer(env, sourceSwasId, true);
    if (!existing) throw httpErr(404, "not_found", "所选来源轻量服务器不存在");
    ak = strOf(existing.access_key_id).trim();
    sk = strOf(existing.access_key_secret).trim();
    if (!site) site = repo.normalizeSite(existing.site);
  } else if (sourceServerId > 0) {
    const existing = await repo.getServer(env, sourceServerId, true);
    if (!existing) throw httpErr(404, "not_found", "所选来源服务器不存在");
    ak = strOf(existing.access_key_id).trim();
    sk = strOf(existing.access_key_secret).trim();
    if (!site) site = repo.normalizeSite(existing.site);
  }

  if (!ak || !sk) {
    throw invalid("请选择已有服务器账号，或填写完整的 AccessKey ID 与 AccessKey Secret");
  }
  if (!regionId) {
    throw invalid("请选择目标地域");
  }
  const normalizedSite = repo.normalizeSite(site);
  return {
    site: normalizedSite,
    account: {
      access_key_id: ak,
      access_key_secret: sk,
      region_id: regionId,
      site: normalizedSite,
      instance_id: "",
    },
  };
}

app.get("/api/v1/swas", async (c) => {
  await requireAdmin(c);
  const config = await repo.getSettings(c.env);
  const items = await repo.listSwasServers(c.env);
  return c.json({ items: items.map((s) => swasSummary(s, config)) });
});

app.post("/api/v1/swas", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  const swasId = numOf(payload["id"], 0);

  // Allow creating a SWAS record by reusing an existing ECS or SWAS account's AK/SK.
  let ak = strOf(payload["access_key_id"]).trim();
  let sk = strOf(payload["access_key_secret"]).trim();
  let site = strOf(payload["site"]).trim();
  const sourceServerId = numOf(payload["source_server_id"], 0);
  const sourceSwasId = numOf(payload["source_swas_id"], 0);
  if (!swasId && (!ak || !sk)) {
    if (sourceSwasId > 0) {
      const src = await repo.getSwasServer(c.env, sourceSwasId, true);
      if (!src) throw httpErr(404, "not_found", "所选来源轻量服务器不存在");
      ak = src.access_key_id;
      sk = src.access_key_secret ?? "";
      if (!site) site = src.site;
    } else if (sourceServerId > 0) {
      const src = await repo.getServer(c.env, sourceServerId, true);
      if (!src) throw httpErr(404, "not_found", "所选来源服务器不存在");
      ak = src.access_key_id;
      sk = src.access_key_secret ?? "";
      if (!site) site = src.site;
    }
  }

  let savedId: number;
  try {
    savedId = await repo.upsertSwasServer(c.env, {
      ...payload,
      access_key_id: ak,
      access_key_secret: sk,
      site: site || payload["site"],
    });
  } catch (err) {
    throw invalid(err instanceof Error ? err.message : String(err));
  }

  // Best-effort initial sync so cards immediately show specs, status, and traffic.
  await swas.refreshSwasServer(c.env, savedId).catch(() => {});
  const config = await repo.getSettings(c.env);
  const saved = await repo.getSwasServer(c.env, savedId);
  return c.json({ id: savedId, server: saved ? swasSummary(saved, config) : null });
});

app.post("/api/v1/swas/reorder", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  const raw = payload["ids"];
  if (!Array.isArray(raw)) throw invalid("ids 必须是数字数组");
  const ids = raw.map((v) => numOf(v, 0)).filter((v) => v > 0);
  await repo.reorderSwasServers(c.env, ids);
  return c.json({ ok: true });
});

app.post("/api/v1/swas/discover", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  const { account } = await resolveSwasSourceAccount(c.env, payload);
  const instances = await swas.listInstances(c.env, account);
  const ids = instances.map((i) => i.instance_id).filter(Boolean);
  const trafficMap = ids.length
    ? await swas.listTrafficPackages(c.env, account, ids).catch(() => new Map())
    : new Map();
  return c.json({
    items: instances.map((inst) => ({
      ...inst,
      traffic: trafficMap.get(inst.instance_id) ?? inst.traffic ?? null,
    })),
  });
});

// -- SWAS Provisioning (must come before /:swasId) ----------------------------

app.post("/api/v1/swas/provision/options", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  const { account } = await resolveSwasSourceAccount(c.env, payload);
  const imageTypeRaw = strOf(payload["image_type"]).trim().toLowerCase();
  const imageType =
    imageTypeRaw === "app" || imageTypeRaw === "custom" ? imageTypeRaw : "system";
  const [plans, images] = await Promise.all([
    swas.listPlans(c.env, account),
    swas.listImages(c.env, account, imageType),
  ]);
  return c.json({
    region_id: account.region_id,
    site: account.site,
    plans,
    images,
  });
});

app.post("/api/v1/swas/provision/price", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  const { account } = await resolveSwasSourceAccount(c.env, payload);
  const planId = strOf(payload["plan_id"]).trim();
  if (!planId) throw invalid("请先选择套餐");
  const periodMonths = Math.trunc(numOf(payload["period_months"], 1));
  const dataDiskSize = Math.max(0, Math.trunc(numOf(payload["data_disk_size"], 0)));
  if (dataDiskSize > 0 && (dataDiskSize % 20 !== 0 || dataDiskSize > 16380)) {
    throw invalid("数据盘容量须为 0 或 20 的整数倍（最大 16380 GB）");
  }
  const quote = await swas.describePrice(c.env, account, {
    planId,
    periodMonths,
    dataDiskSize,
  });
  return c.json({ quote });
});

app.post("/api/v1/swas/provision/create", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  if (!boolOf(payload["confirm_pay"])) {
    throw invalid("请先完成实时询价并勾选扣费确认后再开通轻量服务器");
  }
  const { account, site } = await resolveSwasSourceAccount(c.env, payload);
  const planId = strOf(payload["plan_id"]).trim();
  const imageId = strOf(payload["image_id"]).trim();
  const periodMonths = Math.trunc(numOf(payload["period_months"], 1));
  const dataDiskSize = Math.max(0, Math.trunc(numOf(payload["data_disk_size"], 0)));
  const autoRenew = boolOf(payload["auto_renew"]);
  const autoRenewPeriod = Math.trunc(numOf(payload["auto_renew_period"], 1));
  const addToPanel = payload["add_to_panel"] === undefined ? true : boolOf(payload["add_to_panel"]);
  const panelLabel = strOf(payload["panel_label"]).trim();
  const clientToken = strOf(payload["client_token"]).trim();

  if (!planId) throw invalid("请选择轻量服务器套餐");
  if (!imageId) throw invalid("请选择操作系统或应用镜像");

  const created = await swas.createInstances(c.env, account, {
    planId,
    imageId,
    periodMonths,
    dataDiskSize,
    autoRenew,
    autoRenewPeriod,
    clientToken: clientToken || undefined,
  });
  const newInstanceId = created.instance_ids[0] ?? "";

  let swasId = 0;
  if (addToPanel && newInstanceId) {
    swasId = await repo.upsertSwasServer(c.env, {
      label: panelLabel || `轻量-${newInstanceId.slice(-6)}`,
      access_key_id: account.access_key_id,
      access_key_secret: account.access_key_secret,
      region_id: account.region_id,
      site,
      instance_id: newInstanceId,
      remark: `${planId} · 包年包月 ${periodMonths} 个月`,
    });
    await swas.refreshSwasServer(c.env, swasId).catch(() => {});
  }

  await repo.addEvent(
    c.env,
    "manual",
    messages.ev("开通新轻量服务器", messages.objServer(panelLabel || newInstanceId)),
    {
      detail: `地域 ${account.region_id} · 套餐 ${planId} · ${periodMonths} 个月 · 实例 ${newInstanceId || "—"}`,
      level: "info",
    },
  );
  return c.json({
    ok: true,
    instance_id: newInstanceId,
    instance_ids: created.instance_ids,
    request_id: created.request_id,
    swas_id: swasId,
  });
});

// -- Single SWAS instance routes ----------------------------------------------

app.delete("/api/v1/swas/:swasId", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const swasId = paramInt(c, "swasId");
  const existing = await repo.getSwasServer(c.env, swasId);
  if (!existing) throw httpErr(404, "not_found", "轻量服务器不存在");
  await repo.deleteSwasServer(c.env, swasId);
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev("移除轻量服务器", messages.objServer(existing.label)),
    {
      detail: `仅从面板移除（${existing.instance_id}），云端包年包月实例不受影响`,
      level: "info",
    },
  );
  return c.json({ ok: true });
});

app.post("/api/v1/swas/:swasId/refresh", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const swasId = paramInt(c, "swasId");
  const detail = await swas.refreshSwasServer(c.env, swasId);
  const config = await repo.getSettings(c.env);
  const updated = await repo.getSwasServer(c.env, swasId);
  return c.json({
    ok: true,
    detail,
    server: updated ? swasSummary(updated, config) : null,
  });
});

app.post("/api/v1/swas/:swasId/billing", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const swasId = paramInt(c, "swasId");
  const snap = await billing.refreshSwasServer(c.env, swasId, { force: true });
  if (snap === null) throw httpErr(404, "not_found", "轻量服务器不存在或费用查询已关闭");
  return c.json({ ok: true, billing: snap });
});

app.post("/api/v1/swas/:swasId/actions/:action", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const swasId = paramInt(c, "swasId");
  const action = c.req.param("action").trim().toLowerCase();
  const payload = await jsonBody(c).catch(() => ({} as AnyRow));
  const force = boolOf(payload["force"]);
  const { server, account } = await loadSwasAccount(c.env, swasId);

  if (action === "start") {
    await swas.startInstance(c.env, account);
    await repo.updateSwasRuntime(c.env, swasId, { status: "Starting" });
    await repo.addEvent(c.env, "manual", messages.ev("轻量开机", messages.objServer(server.label)), {
      detail: `已提交开机指令（${account.instance_id}）`,
    });
  } else if (action === "stop") {
    await swas.stopInstance(c.env, account, force);
    await repo.updateSwasRuntime(c.env, swasId, { status: "Stopping" });
    await repo.addEvent(c.env, "manual", messages.ev("轻量关机", messages.objServer(server.label)), {
      detail: `已提交${force ? "强制" : ""}关机指令（${account.instance_id}）`,
    });
  } else if (action === "reboot") {
    await swas.rebootInstance(c.env, account, force);
    await repo.addEvent(c.env, "manual", messages.ev("轻量重启", messages.objServer(server.label)), {
      detail: `已提交${force ? "强制" : ""}重启指令（${account.instance_id}）`,
    });
  } else {
    throw invalid("不支持的电源操作，仅支持 start / stop / reboot");
  }
  await swas.refreshSwasServer(c.env, swasId).catch(() => {});
  return c.json({ ok: true });
});

app.get("/api/v1/swas/:swasId/detail", async (c) => {
  await requireAdmin(c);
  const swasId = paramInt(c, "swasId");
  const detail = await swas.refreshSwasServer(c.env, swasId);
  return c.json({ detail });
});

app.post("/api/v1/swas/:swasId/vnc", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const swasId = paramInt(c, "swasId");
  const { server, account } = await loadSwasAccount(c.env, swasId);
  const vncUrl = await swas.describeInstanceVncUrl(c.env, account);
  const consoleUrl = `https://swasnext.console.aliyun.com/servers/${encodeURIComponent(account.region_id)}/${encodeURIComponent(account.instance_id)}/overview`;
  return c.json({
    vnc_url: vncUrl,
    console_url: consoleUrl,
    instance_id: account.instance_id,
    os_type: server.os_type,
    image_name: server.image_name,
  });
});

app.post("/api/v1/swas/:swasId/vnc-password", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const swasId = paramInt(c, "swasId");
  const { server, account } = await loadSwasAccount(c.env, swasId);
  const payload = await jsonBody(c);
  const vncPassword = strOf(payload["vnc_password"]).trim();
  if (!/^[A-Za-z0-9]{6}$/.test(vncPassword)) {
    throw invalid("VNC 密码必须是 6 位英文字母或数字组合");
  }
  await swas.modifyInstanceVncPassword(c.env, account, vncPassword);
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev("修改轻量 VNC 密码", messages.objServer(server.label)),
    { detail: `已更新 VNC 连接密码（${account.instance_id}）`, level: "info" },
  );
  return c.json({ ok: true });
});

app.post("/api/v1/swas/:swasId/workbench", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const swasId = paramInt(c, "swasId");
  const { account } = await loadSwasAccount(c.env, swasId);
  const payload = await jsonBody(c).catch(() => ({} as AnyRow));
  const redirectUrl = await swas.loginInstanceWorkbench(c.env, account, {
    username: strOf(payload["username"]).trim() || undefined,
    password: strOf(payload["password"]) || undefined,
    port: numOf(payload["port"], 0) || undefined,
  });
  return c.json({ redirect_url: redirectUrl });
});

app.get("/api/v1/swas/:swasId/account-id", async (c) => {
  await requireAdmin(c);
  const swasId = paramInt(c, "swasId");
  const { account } = await loadSwasAccount(c.env, swasId);
  const accountId = await aliyun.getCallerAccountId(c.env, account);
  return c.json({ account_id: accountId });
});

// -- SWAS Reset System & Images/KeyPairs --------------------------------------

app.get("/api/v1/swas/:swasId/images", async (c) => {
  await requireAdmin(c);
  const swasId = paramInt(c, "swasId");
  const { account } = await loadSwasAccount(c.env, swasId);
  const typeRaw = (c.req.query("type") ?? "").trim().toLowerCase();
  const imageType =
    typeRaw === "system" || typeRaw === "app" || typeRaw === "custom" ? typeRaw : undefined;
  const images = await swas.listImages(c.env, account, imageType);
  return c.json({ images });
});

app.get("/api/v1/swas/:swasId/keypairs", async (c) => {
  await requireAdmin(c);
  const swasId = paramInt(c, "swasId");
  const { account } = await loadSwasAccount(c.env, swasId);
  const keyPairs = await swas.listKeyPairs(c.env, account);
  return c.json({ key_pairs: keyPairs });
});

app.post("/api/v1/swas/:swasId/reset", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const swasId = paramInt(c, "swasId");
  const { server, account } = await loadSwasAccount(c.env, swasId);
  const payload = await jsonBody(c);
  const imageId = strOf(payload["image_id"]).trim();
  const password = strOf(payload["password"]);
  const keyPairName = strOf(payload["key_pair_name"]).trim();
  const clientToken = strOf(payload["client_token"]).trim();
  if (password) validateEcsPassword(password);

  await swas.resetSystem(c.env, account, {
    imageId: imageId || undefined,
    password: password || undefined,
    keyPairName: keyPairName || undefined,
    clientToken: clientToken || undefined,
  });
  await repo.updateSwasRuntime(c.env, swasId, { status: "Resetting" });
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev("轻量重置系统", messages.objServer(server.label)),
    {
      detail: `${imageId ? `更换镜像 ${imageId}` : "重置当前系统"}（${account.instance_id}）`,
      level: "warn",
    },
  );
  await swas.refreshSwasServer(c.env, swasId).catch(() => {});
  return c.json({ ok: true });
});

// -- SWAS Snapshots & Custom Images (with Cross-Account & ECS Sharing) --------

app.get("/api/v1/swas/:swasId/snapshots", async (c) => {
  await requireAdmin(c);
  const swasId = paramInt(c, "swasId");
  const { account } = await loadSwasAccount(c.env, swasId);
  const detail = await swas.getInstanceDetail(c.env, account);
  const snapshots = await swas.listSnapshots(c.env, account);
  return c.json({ disks: detail.disks, snapshots });
});

app.post("/api/v1/swas/:swasId/snapshots", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const swasId = paramInt(c, "swasId");
  const { server, account } = await loadSwasAccount(c.env, swasId);
  const payload = await jsonBody(c);
  const diskId = strOf(payload["disk_id"]).trim();
  const snapshotName = strOf(payload["snapshot_name"]).trim();
  if (!diskId) throw invalid("请选择要创建快照的磁盘");
  if (snapshotName.length < 2 || snapshotName.length > 50) {
    throw invalid("快照名称长度须为 2–50 个字符");
  }
  const snapshotId = await swas.createSnapshot(c.env, account, { diskId, snapshotName });
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev("创建轻量快照", messages.objServer(server.label)),
    { detail: `快照 ${snapshotName}（${snapshotId}，磁盘 ${diskId}）`, level: "info" },
  );
  return c.json({ ok: true, snapshot_id: snapshotId });
});

app.delete("/api/v1/swas/:swasId/snapshots/:snapshotId", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const swasId = paramInt(c, "swasId");
  const snapshotId = c.req.param("snapshotId").trim();
  if (!snapshotId) throw invalid("缺少快照 ID");
  const { server, account } = await loadSwasAccount(c.env, swasId);
  await swas.deleteSnapshot(c.env, account, snapshotId);
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev("删除轻量快照", messages.objServer(server.label)),
    { detail: `已删除快照 ${snapshotId}`, level: "warn" },
  );
  return c.json({ ok: true });
});

app.get("/api/v1/swas/:swasId/custom-images", async (c) => {
  await requireAdmin(c);
  const swasId = paramInt(c, "swasId");
  const { account } = await loadSwasAccount(c.env, swasId);
  const images = await swas.listCustomImages(c.env, account);
  return c.json({ images });
});

app.post("/api/v1/swas/:swasId/custom-images", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const swasId = paramInt(c, "swasId");
  const { server, account } = await loadSwasAccount(c.env, swasId);
  const payload = await jsonBody(c);
  const imageName = strOf(payload["image_name"]).trim();
  const systemSnapshotId = strOf(payload["system_snapshot_id"]).trim();
  const dataSnapshotId = strOf(payload["data_snapshot_id"]).trim();
  const description = strOf(payload["description"]).trim().slice(0, 256);
  if (imageName.length < 2 || imageName.length > 128) {
    throw invalid("自定义镜像名称长度须为 2–128 个字符");
  }
  if (!systemSnapshotId) throw invalid("请选择一个系统盘快照作为镜像来源");
  const imageId = await swas.createCustomImage(c.env, account, {
    imageName,
    systemSnapshotId,
    dataSnapshotId: dataSnapshotId || undefined,
    description: description || undefined,
  });
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev("创建轻量自定义镜像", messages.objServer(server.label)),
    { detail: `镜像 ${imageName}（${imageId}，基于快照 ${systemSnapshotId}）`, level: "info" },
  );
  return c.json({ ok: true, image_id: imageId });
});

app.delete("/api/v1/swas/:swasId/custom-images/:imageId", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const swasId = paramInt(c, "swasId");
  const imageId = c.req.param("imageId").trim();
  if (!imageId) throw invalid("缺少自定义镜像 ID");
  const { server, account } = await loadSwasAccount(c.env, swasId);
  await swas.deleteCustomImage(c.env, account, imageId);
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev("删除轻量自定义镜像", messages.objServer(server.label)),
    { detail: `已删除自定义镜像 ${imageId}`, level: "warn" },
  );
  return c.json({ ok: true });
});

app.post("/api/v1/swas/:swasId/custom-images/:imageId/share-ecs", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const swasId = paramInt(c, "swasId");
  const imageId = c.req.param("imageId").trim();
  const payload = await jsonBody(c);
  const share = boolOf(payload["share"]);
  const { server, account } = await loadSwasAccount(c.env, swasId);
  await swas.modifyImageShareStatus(c.env, account, imageId, share);
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev(share ? "镜像共享到 ECS" : "取消镜像共享到 ECS", messages.objServer(server.label)),
    { detail: `自定义镜像 ${imageId}`, level: "info" },
  );
  return c.json({ ok: true, in_share_ecs: share });
});

app.get("/api/v1/swas/:swasId/custom-images/:imageId/shares", async (c) => {
  await requireAdmin(c);
  const swasId = paramInt(c, "swasId");
  const imageId = c.req.param("imageId").trim();
  const { account } = await loadSwasAccount(c.env, swasId);
  const accounts = await swas.listCustomImageShareAccounts(c.env, account, imageId);
  return c.json({ accounts });
});

app.post("/api/v1/swas/:swasId/custom-images/:imageId/shares", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const swasId = paramInt(c, "swasId");
  const imageId = c.req.param("imageId").trim();
  const payload = await jsonBody(c);
  const action = strOf(payload["action"]).trim().toLowerCase() === "remove" ? "remove" : "add";
  let targetAccountId = strOf(payload["account_id"]).trim();
  const targetSwasId = numOf(payload["target_swas_id"], 0);
  const targetServerId = numOf(payload["target_server_id"], 0);

  if (!targetAccountId && targetSwasId > 0) {
    const target = await loadSwasAccount(c.env, targetSwasId);
    targetAccountId = await aliyun.getCallerAccountId(c.env, target.account);
  } else if (!targetAccountId && targetServerId > 0) {
    const target = await loadServerAccount(c.env, targetServerId);
    targetAccountId = await aliyun.getCallerAccountId(c.env, target.account);
  }
  if (!/^\d{6,24}$/.test(targetAccountId)) {
    throw invalid("请填写有效的阿里云主账号 UID（纯数字）或选择目标服务器");
  }

  const { server, account } = await loadSwasAccount(c.env, swasId);
  await swas.updateCustomImageShareAccounts(c.env, account, imageId, action, [targetAccountId]);
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev(action === "add" ? "轻量镜像跨账号共享" : "取消轻量镜像共享", messages.objServer(server.label)),
    { detail: `镜像 ${imageId} ${action === "add" ? "→ 共享给" : "× 移除"} 账号 ${targetAccountId}` },
  );
  const accounts = await swas.listCustomImageShareAccounts(c.env, account, imageId);
  return c.json({ ok: true, account_id: targetAccountId, accounts });
});

// -- SWAS Attribute (Rename / Password) & Firewall ----------------------------

app.post("/api/v1/swas/:swasId/attribute", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const swasId = paramInt(c, "swasId");
  const { server, account } = await loadSwasAccount(c.env, swasId);
  const payload = await jsonBody(c);
  const instanceName = strOf(payload["instance_name"]).trim();
  const password = strOf(payload["password"]);
  const syncLabel = boolOf(payload["sync_label"]);
  const rebootAfter = boolOf(payload["reboot_after"]);

  if (!instanceName && !password) {
    throw invalid("请至少填写实例名称或新密码");
  }
  if (instanceName && (instanceName.length < 2 || instanceName.length > 50)) {
    throw invalid("轻量实例名称长度须为 2–50 个字符");
  }
  if (password) validateEcsPassword(password);

  await swas.updateInstanceAttribute(c.env, account, {
    instanceName: instanceName || undefined,
    password: password || undefined,
  });

  if (instanceName && syncLabel) {
    await repo.upsertSwasServer(c.env, {
      id: swasId,
      label: instanceName,
      region_id: server.region_id,
      site: server.site,
      instance_id: server.instance_id,
      remark: server.remark,
    });
  }

  let rebooted = false;
  if (password && rebootAfter) {
    const detail = await swas.getInstanceDetail(c.env, account).catch(() => null);
    if (detail?.status === "Running") {
      await swas.rebootInstance(c.env, account, false);
      rebooted = true;
    }
  }

  const changed: string[] = [];
  if (instanceName) changed.push(`实例名改为 ${instanceName}`);
  if (password) changed.push(rebooted ? "已重置登录密码并触发重启" : "已重置登录密码（需重启生效）");
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev("修改轻量实例属性", messages.objServer(instanceName && syncLabel ? instanceName : server.label)),
    { detail: `${changed.join("，")}（${account.instance_id}）`, level: "info" },
  );
  return c.json({ ok: true, rebooted });
});

app.get("/api/v1/swas/:swasId/firewall", async (c) => {
  await requireAdmin(c);
  const swasId = paramInt(c, "swasId");
  const { account } = await loadSwasAccount(c.env, swasId);
  const rules = await swas.listFirewallRules(c.env, account);
  return c.json({ rules });
});

app.post("/api/v1/swas/:swasId/firewall", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const swasId = paramInt(c, "swasId");
  const { server, account } = await loadSwasAccount(c.env, swasId);
  const payload = await jsonBody(c);
  const protoRaw = strOf(payload["rule_protocol"]).trim().toUpperCase();
  if (protoRaw !== "TCP" && protoRaw !== "UDP" && protoRaw !== "TCP+UDP" && protoRaw !== "ICMP") {
    throw invalid("轻量防火墙协议仅支持 TCP、UDP、TCP+UDP 或 ICMP");
  }
  const port = protoRaw === "ICMP" ? "-1/-1" : normalizePortRange("TCP", strOf(payload["port"]));
  const cidrRaw = strOf(payload["source_cidr_ip"]).trim();
  const sourceCidrIp = cidrRaw ? validateCidrIp(cidrRaw) : "0.0.0.0/0";
  const remark = strOf(payload["remark"]).trim().slice(0, 128);

  const ruleId = await swas.createFirewallRule(c.env, account, {
    ruleProtocol: protoRaw,
    port,
    sourceCidrIp,
    remark: remark || undefined,
  });
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev("添加轻量防火墙规则", messages.objServer(server.label)),
    { detail: `${protoRaw} ${port} (${sourceCidrIp})${remark ? ` · ${remark}` : ""}` },
  );
  const rules = await swas.listFirewallRules(c.env, account);
  return c.json({ ok: true, rule_id: ruleId, rules });
});

app.post("/api/v1/swas/:swasId/firewall/:ruleId/toggle", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const swasId = paramInt(c, "swasId");
  const ruleId = c.req.param("ruleId").trim();
  const payload = await jsonBody(c);
  const enable = boolOf(payload["enable"]);
  const { server, account } = await loadSwasAccount(c.env, swasId);
  await swas.toggleFirewallRule(c.env, account, ruleId, enable);
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev(enable ? "启用防火墙规则" : "禁用防火墙规则", messages.objServer(server.label)),
    { detail: `规则 ${ruleId}` },
  );
  const rules = await swas.listFirewallRules(c.env, account);
  return c.json({ ok: true, rules });
});

app.delete("/api/v1/swas/:swasId/firewall/:ruleId", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const swasId = paramInt(c, "swasId");
  const ruleId = c.req.param("ruleId").trim();
  if (!ruleId) throw invalid("缺少防火墙规则 ID");
  const { server, account } = await loadSwasAccount(c.env, swasId);
  await swas.deleteFirewallRule(c.env, account, ruleId);
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev("删除轻量防火墙规则", messages.objServer(server.label)),
    { detail: `已移除防火墙规则 ${ruleId}`, level: "warn" },
  );
  const rules = await swas.listFirewallRules(c.env, account);
  return c.json({ ok: true, rules });
});

// -- SWAS Renewal (PrePaid) ---------------------------------------------------

app.post("/api/v1/swas/:swasId/renewal/price", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const swasId = paramInt(c, "swasId");
  const { account } = await loadSwasAccount(c.env, swasId);
  const payload = await jsonBody(c);
  const periodMonths = Math.trunc(numOf(payload["period_months"], 1));
  const detail = await swas.getInstanceDetail(c.env, account);
  const dataDiskSize = detail.disks
    .filter((d) => d.disk_type.toLowerCase() === "data")
    .reduce((acc, d) => acc + d.size, 0);
  const quote = await swas.describePrice(c.env, account, {
    planId: detail.plan_id,
    periodMonths,
    dataDiskSize,
    instanceId: account.instance_id,
  });
  return c.json({
    quote,
    expired_time: detail.expired_time,
    plan_id: detail.plan_id,
  });
});

app.post("/api/v1/swas/:swasId/renewal/pay", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const swasId = paramInt(c, "swasId");
  const { server, account } = await loadSwasAccount(c.env, swasId);
  const payload = await jsonBody(c);
  if (!boolOf(payload["confirm_pay"])) {
    throw invalid("请先查询续费价格并勾选确认扣费后再提交");
  }
  const periodMonths = Math.trunc(numOf(payload["period_months"], 1));
  const clientToken = strOf(payload["client_token"]).trim();
  const res = await swas.renewInstance(c.env, account, {
    periodMonths,
    clientToken: clientToken || undefined,
  });
  await swas.refreshSwasServer(c.env, swasId).catch(() => {});
  await repo.addEvent(
    c.env,
    "manual",
    messages.ev("轻量服务器续费", messages.objServer(server.label)),
    {
      detail: `已续费 ${periodMonths} 个月（${account.instance_id}）${res.expired_time ? `，新到期时间 ${res.expired_time}` : ""}`,
      level: "info",
    },
  );
  return c.json({ ok: true, ...res });
});

// -- Single keepalive ---------------------------------------------------------

app.get("/api/v1/keepalives", async (c) => {
  await requireAdmin(c);
  const config = await repo.getSettings(c.env);
  const tzName = config["timezone"] || "Asia/Shanghai";
  const now = tzNow(tzName);
  const nowDate = new Date(now.epoch * 1000);
  const items = await repo.listKeepalives(c.env);
  return c.json({
    items: items.map((item) => ({
      ...item,
      in_window: keepaliveWindow(item as unknown as Keepalive, nowDate, tzName),
    })),
  });
});

app.post("/api/v1/keepalives", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  const serverId = numOf(payload["server_id"]);
  if (!serverId) throw invalid("请选择服务器");
  const [startTime, endTime, startDay, endDay] = keepaliveWindowParts(payload);
  return c.json({
    id: await repo.addKeepalive(
      c.env,
      serverId,
      payload["enabled"] !== false,
      { startTime, endTime, startDay, endDay },
    ),
  });
});

app.post("/api/v1/keepalives/:keepaliveId", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const keepaliveId = paramInt(c, "keepaliveId");
  const payload = await jsonBody(c);
  if ((await repo.getKeepalive(c.env, keepaliveId)) === null) {
    throw invalid("保活任务不存在");
  }
  const [startTime, endTime, startDay, endDay] = keepaliveWindowParts(payload);
  await repo.updateKeepalive(c.env, keepaliveId, {
    enabled: payload["enabled"] !== false,
    startTime,
    endTime,
    startDay,
    endDay,
  });
  // Deliberately do NOT clear keepalive_rest here: the next reconcile round
  // treats the window change as a quiet window-resume instead of a
  // preemption recovery (see Python comment in api.py).
  const item = rowOf(await repo.getKeepalive(c.env, keepaliveId));
  const serverId = numOf(item["server_id"]);
  if (serverId) {
    await repo.setFlag(c.env, `keepalive_resume_pending:${serverId}`);
  }
  return c.json({ ok: true });
});

app.post("/api/v1/keepalives/:keepaliveId/toggle", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  await repo.setKeepaliveEnabled(
    c.env,
    paramInt(c, "keepaliveId"),
    payload["enabled"] !== false,
  );
  return c.json({ ok: true });
});

app.delete("/api/v1/keepalives/:keepaliveId", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  await repo.deleteKeepalive(c.env, paramInt(c, "keepaliveId"));
  return c.json({ ok: true });
});

// -- Shift groups -------------------------------------------------------------

app.get("/api/v1/groups", async (c) => {
  await requireAdmin(c);
  const config = await repo.getSettings(c.env);
  const nowTs = tzNow(config["timezone"] || "Asia/Shanghai").epoch;
  const books = await dns.recordBooks(c.env);
  return c.json({
    items: await Promise.all(
      (await repo.listGroups(c.env)).map((g) =>
        groupPayload(c.env, g, config, nowTs, undefined, books),
      ),
    ),
  });
});

app.post("/api/v1/groups", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  if (strOf(payload["cycle"] || "day") !== "month") {
    await validateGroupTimetable(c.env, payload);
  }
  const isNew = !numOf(payload["id"]);
  const groupId = await repo.upsertGroup(c.env, payload);
  if (!isNew) return c.json({ id: groupId });
  // New group: immediately settle members into their scheduled positions.
  // Failure does not roll back the saved group, only the reason is returned.
  let result: unknown;
  try {
    result = await bootstrapGroup(c.env, groupId);
  } catch (e) {
    console.error("bootstrap group failed", e);
    result = { error: e instanceof Error ? e.message : String(e) };
  }
  return c.json({ id: groupId, bootstrap: result });
});

app.delete("/api/v1/groups/:groupId", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const groupId = paramInt(c, "groupId");
  if ((await repo.getGroup(c.env, groupId)) === null) {
    throw httpErr(404, "not_found", "换班组不存在");
  }
  // Dissolving only deletes config: members keep their current state.
  return c.json(await dissolveGroup(c.env, groupId));
});

app.post("/api/v1/groups/:groupId/switch", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  return c.json({ result: await manualSwitch(c.env, paramInt(c, "groupId")) });
});

// -- DNS ----------------------------------------------------------------------

app.get("/api/v1/dns", async (c) => {
  await requireAdmin(c);
  return c.json(await dns.snapshot(c.env, await repo.getSettings(c.env)));
});

app.post("/api/v1/dns/reorder", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  const records = payload["records"];
  if (!Array.isArray(records) || records.length === 0) {
    throw httpErr(400, "invalid_request", "records 必须是非空的有序数组");
  }
  if (!records.every((item) => typeof item === "string")) {
    throw httpErr(400, "invalid_request", "records 里的元素必须是记录名");
  }
  await repo.reorderDnsRecords(c.env, records as string[]);
  return c.json({ ok: true });
});

app.post("/api/v1/dns/records", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const payload = await jsonBody(c);
  const name = await dns.addRecord(c.env, strOf(payload["record"]), await repo.getSettings(c.env));
  await repo.addEvent(c.env, "dns", messages.ev("DNS 记录已添加", messages.objServer(name)), {
    detail: `已添加 / ${name}`,
  });
  return c.json({ record: name });
});

app.delete("/api/v1/dns/records/:record", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const record = c.req.param("record");
  const row = await repo.getDnsRecord(c.env, record);
  if (row === null || row === undefined) {
    throw httpErr(404, "not_found", "记录不存在");
  }
  await dns.removeRecord(c.env, record, await repo.getSettings(c.env));
  const hadTarget = Boolean(rowOf(row)["target_kind"]);
  await repo.addEvent(c.env, "dns", messages.ev("DNS 记录已删除", messages.objServer(record)), {
    detail: hadTarget
      ? `已删除 / ${record}（绑定已一并解除）`
      : `已删除 / ${record}`,
  });
  return c.json({ ok: true });
});

app.post("/api/v1/dns/records/:record/bind", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const record = c.req.param("record");
  const payload = await jsonBody(c);
  const kind = strOf(payload["kind"]);
  const targetId = numOf(payload["id"]);
  if (kind && !targetId) throw invalid("请选择绑定目标");
  const config = await repo.getSettings(c.env);
  await dns.syncRegistry(c.env, config);
  // Bind then sync immediately: the user should not wait a reconcile round.
  return c.json(await dns.bind(c.env, record, kind, targetId, config));
});

app.post("/api/v1/dns/records/:record/sync", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const record = c.req.param("record");
  const config = await repo.getSettings(c.env);
  if (config["ddns_enabled"] !== "1") {
    throw httpErr(400, "invalid_request", "DDNS 未启用，请先在设置里打开");
  }
  const result = await dns.syncRecord(c.env, record, config, { force: true });
  return c.json({
    record,
    status: result.status,
    detail: result.detail,
    ip: result.ip,
  });
});

app.post("/api/v1/dns/sync", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const config = await repo.getSettings(c.env);
  if (config["ddns_enabled"] !== "1") {
    throw httpErr(400, "invalid_request", "DDNS 未启用，请先在设置里打开");
  }
  return c.json({ items: await dns.reconcile(c.env, config, true) });
});

// -- Settings -----------------------------------------------------------------

app.get("/api/v1/settings", async (c) => {
  await requireAdmin(c);
  const config = await repo.getSettings(c.env);
  return c.json({
    admin_username: config["admin_username"] || "",
    timezone: config["timezone"],
    public_home_enabled: (config["public_home_enabled"] ?? "1") !== "0",
    public_site_title: (config["public_site_title"] || "").trim() || "CDT 云节点流量遥测",
    public_site_subtitle:
      (config["public_site_subtitle"] || "").trim() ||
      "阿里云 ECS · 轻量应用服务器实时在线状态与月度流量配额观察站",
    traffic_threshold_pct: config["traffic_threshold_pct"],
    reconcile_interval: config["reconcile_interval"],
    reconcile_offset: config["reconcile_offset"] || "0",
    billing_enabled: (config["billing_enabled"] ?? "1") === "1",
    billing_interval: config["billing_interval"] || "600",
    daily_report_enabled: config["daily_report_enabled"] === "1",
    daily_report_time: config["daily_report_time"],
    notify_on_shift: config["notify_on_shift"] === "1",
    notify_on_failover: config["notify_on_failover"] === "1",
    notify_on_recovery: config["notify_on_recovery"] === "1",
    notify_on_breaker: config["notify_on_breaker"] === "1",
    notify_on_limit_stop: config["notify_on_limit_stop"] === "1",
    notify_on_error: config["notify_on_error"] === "1",
    notify_on_keepalive: config["notify_on_keepalive"] === "1",
    notify_on_power: (config["notify_on_power"] ?? "1") === "1",
    ddns: {
      enabled: config["ddns_enabled"] === "1",
      provider: config["ddns_provider"] || "cloudflare",
      cf_auth_mode: config["ddns_cf_auth_mode"] || "token",
      cf_token_configured: Boolean(config["ddns_cf_token"]),
      cf_email: config["ddns_cf_email"] || "",
      cf_key_configured: Boolean(config["ddns_cf_key"]),
      zone_id: config["ddns_zone_id"] || "",
      record: ddns.defaultRecord(config),
      records: ddns.records(config),
      ttl: config["ddns_ttl"],
      proxied: config["ddns_proxied"] === "1",
      last_ip: config["ddns_last_ip"] || "",
      last_status: config["ddns_last_status"] || "",
    },
    telegram: {
      enabled: config["notify_tg_enabled"] === "1",
      token_configured: Boolean(config["notify_tg_token"]),
      chat_id: config["notify_tg_chat_id"] || "",
      proxy: config["notify_tg_proxy"] || "",
    },
    email: {
      enabled: config["notify_mail_enabled"] === "1",
      host: config["notify_mail_host"] || "",
      port: config["notify_mail_port"],
      security: config["notify_mail_security"] || "ssl",
      username: config["notify_mail_username"] || "",
      password_configured: Boolean(config["notify_mail_password"]),
      to: config["notify_mail_to"] || "",
    },
    webhook: {
      enabled: config["notify_wh_enabled"] === "1",
      url: config["notify_wh_url"] || "",
      method: config["notify_wh_method"] || "POST",
      headers_configured: Boolean(config["notify_wh_headers"]),
      body: config["notify_wh_body"] || "",
    },
    channels: notify.enabledChannels(c.env, config),
    sdk_ready: await aliyun.sdkReady(c.env),
    dry_run: c.env.CDT_DRY_RUN === "1",
    repo: REPO,
    upstream_repo: UPSTREAM_REPO,
    version: VERSION,
  });
});

app.post("/api/v1/settings", async (c) => {
  const user = await requireAdmin(c);
  requireCsrf(c);
  const env = c.env;
  const payload = await jsonBody(c);
  const updates: Record<string, string> = {};

  const putStr = (key: string, value: unknown) => {
    if (value !== null && value !== undefined) updates[key] = String(value);
  };
  const putBool = (key: string, value: unknown) => {
    if (value !== null && value !== undefined) updates[key] = value ? "1" : "0";
  };

  putStr("timezone", payload["timezone"]);
  putBool("public_home_enabled", payload["public_home_enabled"]);
  if (payload["public_site_title"] !== null && payload["public_site_title"] !== undefined) {
    updates["public_site_title"] = String(payload["public_site_title"]).trim().slice(0, 80);
  }
  if (payload["public_site_subtitle"] !== null && payload["public_site_subtitle"] !== undefined) {
    updates["public_site_subtitle"] = String(payload["public_site_subtitle"]).trim().slice(0, 160);
  }
  if (payload["traffic_threshold_pct"] !== null && payload["traffic_threshold_pct"] !== undefined) {
    const percent = asInt(payload["traffic_threshold_pct"], "流量阈值百分比");
    if (percent < 50 || percent > 100) throw invalid("流量阈值百分比应在 50–100 之间");
    updates["traffic_threshold_pct"] = String(percent);
  }
  if (payload["reconcile_interval"] !== null && payload["reconcile_interval"] !== undefined) {
    const interval = asInt(payload["reconcile_interval"], "同步间隔");
    if (interval < 30 || interval > 3600) throw invalid("同步间隔应在 30–3600 秒之间");
    updates["reconcile_interval"] = String(interval);
  }
  if (payload["reconcile_offset"] !== null && payload["reconcile_offset"] !== undefined) {
    const offset = asInt(payload["reconcile_offset"], "巡检起始秒");
    if (offset < 0 || offset > 59) throw invalid("巡检起始秒应在 0–59 之间");
    updates["reconcile_offset"] = String(offset);
  }

  putBool("billing_enabled", payload["billing_enabled"]);
  if (payload["billing_interval"] !== null && payload["billing_interval"] !== undefined) {
    const interval = asInt(payload["billing_interval"], "费用查询间隔");
    if (interval < 60 || interval > 86400) throw invalid("费用查询间隔应在 60–86400 秒之间");
    updates["billing_interval"] = String(interval);
  }

  putBool("daily_report_enabled", payload["daily_report_enabled"]);
  const reportTime = payload["daily_report_time"];
  if (reportTime !== null && reportTime !== undefined) {
    const text = String(reportTime).trim();
    if (text) {
      if (!repo.isHhmm(text)) throw invalid("日报时间格式应为 HH:MM（00:00–23:59）");
      const [h, m] = text.split(":").map(Number);
      updates["daily_report_time"] = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    } else {
      updates["daily_report_time"] = text;
    }
  }
  for (const key of [
    "notify_on_shift",
    "notify_on_failover",
    "notify_on_recovery",
    "notify_on_breaker",
    "notify_on_limit_stop",
    "notify_on_error",
    "notify_on_keepalive",
    "notify_on_power",
  ]) {
    putBool(key, payload[key]);
  }

  const ddnsPayload = rowOf(payload["ddns"]);
  if (Object.keys(ddnsPayload).length) {
    putBool("ddns_enabled", ddnsPayload["enabled"]);
    putStr("ddns_provider", ddnsPayload["provider"]);
    putStr("ddns_cf_auth_mode", ddnsPayload["cf_auth_mode"]);
    putStr("ddns_cf_email", ddnsPayload["cf_email"]);
    putStr("ddns_zone_id", ddnsPayload["zone_id"]);
    const recordsPayload = ddnsPayload["records"];
    if (recordsPayload !== null && recordsPayload !== undefined) {
      if (!Array.isArray(recordsPayload)) throw invalid("DDNS 记录名需要是列表");
      const cleaned: string[] = [];
      const seen = new Set<string>();
      for (const item of recordsPayload) {
        const name = String(item ?? "").trim();
        if (!name || seen.has(name.toLowerCase())) continue;
        if (!ddns.isValidRecord(name)) {
          throw invalid(`DDNS 记录名要是完整域名（至少一层点、不带空格）：${name}`);
        }
        seen.add(name.toLowerCase());
        cleaned.push(name);
      }
      updates["ddns_records"] = JSON.stringify(cleaned);
      updates["ddns_record"] = cleaned[0] ?? "";
    } else {
      putStr("ddns_record", ddnsPayload["record"]);
    }
    putStr("ddns_ttl", ddnsPayload["ttl"]);
    putBool("ddns_proxied", ddnsPayload["proxied"]);
    if (ddnsPayload["cf_token"]) updates["ddns_cf_token"] = String(ddnsPayload["cf_token"]);
    if (ddnsPayload["cf_key"]) updates["ddns_cf_key"] = String(ddnsPayload["cf_key"]);
  }

  const tg = rowOf(payload["telegram"]);
  if (Object.keys(tg).length) {
    putBool("notify_tg_enabled", tg["enabled"]);
    putStr("notify_tg_chat_id", tg["chat_id"]);
    putStr("notify_tg_proxy", tg["proxy"]);
    if (tg["token"]) updates["notify_tg_token"] = String(tg["token"]);
  }

  const mail = rowOf(payload["email"]);
  if (Object.keys(mail).length) {
    putBool("notify_mail_enabled", mail["enabled"]);
    putStr("notify_mail_host", mail["host"]);
    putStr("notify_mail_port", mail["port"]);
    putStr("notify_mail_security", mail["security"]);
    putStr("notify_mail_username", mail["username"]);
    putStr("notify_mail_to", mail["to"]);
    if (mail["password"]) updates["notify_mail_password"] = String(mail["password"]);
  }

  const wh = rowOf(payload["webhook"]);
  if (Object.keys(wh).length) {
    putBool("notify_wh_enabled", wh["enabled"]);
    putStr("notify_wh_url", wh["url"]);
    putStr("notify_wh_method", wh["method"]);
    putStr("notify_wh_body", wh["body"]);
    if (wh["headers"]) updates["notify_wh_headers"] = String(wh["headers"]);
  }

  let bumpedEpoch: number | null = null;
  let newSessionUser: string | null = null;
  const newUsername = strOf(payload["new_username"]).trim();
  const newPassword = payload["new_password"];

  // Changing username/password invalidates every old session ticket.
  if (newUsername) {
    if (newUsername.length < 3) throw invalid("用户名至少 3 个字符");
    if (newUsername !== (await repo.getSetting(env, "admin_username"))) {
      updates["admin_username"] = newUsername;
      bumpedEpoch = Math.floor(Date.now() / 1000);
      updates["session_epoch"] = String(bumpedEpoch);
      newSessionUser = newUsername;
    }
  }
  if (newPassword !== null && newPassword !== undefined && newPassword !== "") {
    if (String(newPassword).length < 10) throw invalid("新密码至少 10 个字符");
    updates["admin_password"] = await security.hashPassword(String(newPassword));
    bumpedEpoch = Math.floor(Date.now() / 1000);
    updates["session_epoch"] = String(bumpedEpoch);
  }

  if (Object.keys(updates).length) {
    const before = await repo.getSettings(env);
    const changed = Object.entries(updates)
      .filter(([key, value]) => String(before[key] ?? "") !== String(value))
      .map(([key]) => key)
      .filter((key) => !SETTING_LABELS_SKIP.has(key));
    await repo.setSettings(env, updates);
    if ("ddns_records" in updates) {
      await dns.syncRegistry(env, await repo.getSettings(env));
    }
    if (changed.length) {
      await repo.addEvent(env, "system", messages.ev("配置已更新"), {
        detail: `已保存 / ${settingLabels(changed)}`,
      });
    }
  }

  if (bumpedEpoch !== null) {
    await attachSession(c, newSessionUser ?? user, bumpedEpoch);
    return c.json({ ok: true, username: newSessionUser ?? user });
  }
  return c.json({ ok: true });
});

// -- Channel test ---------------------------------------------------------------

app.post("/api/v1/settings/test/:channel", async (c) => {
  await requireAdmin(c);
  requireCsrf(c);
  const channel = c.req.param("channel");
  const payload = await jsonBody(c);
  // Test with the draft values from the form, not the saved config.
  const config = await configFromDraft(c.env, payload);
  if (channel === "ddns") {
    const result = rowOf(await ddns.test(c.env, config));
    return c.json({
      ok: strOf(result["status"]).startsWith("✅"),
      status: result["status"],
      detail: notify.safeError(strOf(result["detail"]), config),
    });
  }
  if (channel !== "telegram" && channel !== "email" && channel !== "webhook") {
    throw invalid("未知渠道");
  }
  const nowLabel = tzNow(config["timezone"] || "Asia/Shanghai").iso.replace("T", " ");
  const message: notify.Message = {
    kind: "test",
    title: "通知通道测试",
    titleHtml: `✅ <b>${BRAND} 通知测试</b>\n\n配置工作正常。\n⏰ ${nowLabel}`,
    body: `✅ <b>${BRAND} 通知测试</b><br><br>配置工作正常。<br>⏰ ${nowLabel}`,
    text: "通知通道测试：配置工作正常。",
  };
  try {
    await notify.send(
      c.env,
      config,
      channel,
      await notify.withTrafficFooter(c.env, config, message),
    );
  } catch (e) {
    return c.json({
      ok: false,
      detail: notify.safeError(e instanceof Error ? e.message : String(e), config),
    });
  }
  return c.json({ ok: true, detail: "已发送" });
});

// -- Events ---------------------------------------------------------------------

app.get("/api/v1/events", async (c) => {
  await requireAdmin(c);
  const limitRaw = Number(c.req.query("limit") ?? 100);
  const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : 100, 500));
  return c.json({
    items: await repo.listEvents(
      c.env,
      limit,
      c.req.query("kind") ?? "",
      c.req.query("level") ?? "",
    ),
  });
});

export default app;
