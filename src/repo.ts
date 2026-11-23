// Data-access layer — port of app/repo.py (1:1, camelCase).
// Every function takes `env` first (Workers have no module-global DB or
// master key; D1 comes from env.DB, the encryption key from
// env.ENCRYPTION_KEY). All timestamps are Unix seconds, matching Python.
// Secrets are never logged or returned in plaintext except through the
// explicit decrypt paths (listServers(true) / getServer(..., true)).

import { batch, execute, query, queryOne } from "./db";
import type { Env } from "./env";
import { decrypt, encrypt, mask } from "./security";

export type Row = Record<string, unknown>;

export interface ProgressStep {
  ts: number;
  text: string;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function asStr(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function asNum(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asInt(value: unknown, fallback = 0): number {
  return Math.trunc(asNum(value, fallback));
}

function asOptNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asBool(value: unknown): boolean {
  return asInt(value, 0) !== 0;
}

export const SENSITIVE_SETTINGS: ReadonlySet<string> = new Set([
  "admin_password",
  "ddns_cf_token",
  "ddns_cf_key",
  "notify_tg_token",
  "notify_mail_password",
  "notify_wh_headers",
]);

/** Validate an HH:MM time, 00:00–23:59. */
export function isHhmm(value: string): boolean {
  const parts = value.split(":");
  if (parts.length !== 2) return false;
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return false;
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

export type SettingsMap = Record<string, string>;

export async function getSettings(env: Env): Promise<SettingsMap> {
  const rows = await query<Row>(
    env.DB,
    "SELECT key, value FROM settings WHERE substr(key, 1, 10) <> '_internal_'",
  );
  const data: SettingsMap = {};
  for (const row of rows) {
    data[asStr(row["key"])] = asStr(row["value"]);
  }
  for (const key of SENSITIVE_SETTINGS) {
    if (data[key]) {
      try {
        data[key] = await decrypt(data[key] as string, env.ENCRYPTION_KEY);
      } catch {
        data[key] = "";
      }
    }
  }
  return data;
}

export async function getSetting(
  env: Env,
  key: string,
  fallback = "",
): Promise<string> {
  if (key.startsWith("_internal_")) return fallback;
  const row = await queryOne<Row>(
    env.DB,
    "SELECT value FROM settings WHERE key=?",
    [key],
  );
  if (row === null) return fallback;
  const value = asStr(row["value"]);
  if (SENSITIVE_SETTINGS.has(key) && value) {
    try {
      return await decrypt(value, env.ENCRYPTION_KEY);
    } catch {
      return fallback;
    }
  }
  return value;
}

export async function setSettings(
  env: Env,
  values: SettingsMap,
): Promise<void> {
  const statements = [];
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith("_internal_")) continue;
    const stored = SENSITIVE_SETTINGS.has(key)
      ? await encrypt(value, env.ENCRYPTION_KEY)
      : value;
    statements.push({
      sql:
        "INSERT INTO settings(key, value) VALUES(?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      params: [key, stored] as (string | number | null)[],
    });
  }
  if (statements.length > 0) await batch(env.DB, statements);
}

// ---------------------------------------------------------------------------
// flags (one-shot markers with an attached counter)
// ---------------------------------------------------------------------------

export async function getFlag(env: Env, key: string): Promise<boolean> {
  const row = await queryOne<Row>(env.DB, "SELECT 1 FROM flags WHERE key=?", [
    key,
  ]);
  return row !== null;
}

export async function setFlag(env: Env, key: string): Promise<void> {
  await execute(
    env.DB,
    "INSERT INTO flags(key, created_at) VALUES(?, ?) ON CONFLICT(key) DO NOTHING",
    [key, nowSeconds()],
  );
}

export async function clearFlag(env: Env, key: string): Promise<void> {
  await execute(env.DB, "DELETE FROM flags WHERE key=?", [key]);
}

/**
 * Increment a flag's counter and return the new value; a missing flag starts
 * at 1 (created_at set to now). Serves "how many times in this one event"
 * counters (currently keepalive retries).
 */
export async function bumpFlag(env: Env, key: string): Promise<number> {
  await execute(
    env.DB,
    "INSERT INTO flags(key, created_at, value) VALUES(?, ?, 1) " +
      "ON CONFLICT(key) DO UPDATE SET value = value + 1",
    [key, nowSeconds()],
  );
  const row = await queryOne<Row>(env.DB, "SELECT value FROM flags WHERE key=?", [
    key,
  ]);
  return row !== null ? asInt(row["value"], 1) : 1;
}

/** How long ago (seconds) a flag was set; -1 when absent ("can run now"). */
export async function flagAge(env: Env, key: string): Promise<number> {
  const row = await queryOne<Row>(
    env.DB,
    "SELECT created_at FROM flags WHERE key=?",
    [key],
  );
  if (row === null) return -1;
  return Date.now() / 1000 - asNum(row["created_at"]);
}

/** A flag's attached counter value; 0 when absent. */
export async function flagValue(env: Env, key: string): Promise<number> {
  const row = await queryOne<Row>(env.DB, "SELECT value FROM flags WHERE key=?", [
    key,
  ]);
  return row !== null ? asInt(row["value"], 0) : 0;
}

/**
 * Store a float value on a flag, but only when the flag does not exist yet.
 * Used for daily-traffic baselines: the first reconcile of the day records
 * the month-to-date traffic, and later writes must never move it, or the
 * day's figure would silently reset to zero.
 */
export async function ensureFlagValue(
  env: Env,
  key: string,
  value: number,
): Promise<void> {
  await execute(
    env.DB,
    "INSERT INTO flags(key, created_at, value) VALUES(?, ?, ?) " +
      "ON CONFLICT(key) DO NOTHING",
    [key, nowSeconds(), value],
  );
}

/** A flag's attached value as a float; null when absent or not a number. */
export async function flagValueNum(env: Env, key: string): Promise<number | null> {
  const row = await queryOne<Row>(env.DB, "SELECT value FROM flags WHERE key=?", [
    key,
  ]);
  if (row === null || row["value"] === null || row["value"] === undefined) {
    return null;
  }
  const value = Number(row["value"]);
  return Number.isFinite(value) ? value : null;
}

/** Daily-traffic baseline keys look like `traffic_day:<serverId>:<YYYY-MM-DD>`. */
export const TRAFFIC_DAY_PREFIX = "traffic_day:";

/**
 * Delete daily-traffic baselines except the given dates (YYYY-MM-DD):
 * only today and yesterday are ever read again.
 */
export async function pruneTrafficDayBaselines(
  env: Env,
  keepDates: string[],
): Promise<void> {
  if (keepDates.length === 0) return;
  const keep = keepDates.map(() => "substr(key, -10) = ?").join(" OR ");
  await execute(
    env.DB,
    `DELETE FROM flags WHERE substr(key, 1, 12) = 'traffic_day:' AND NOT (${keep})`,
    keepDates,
  );
}

/**
 * Delete a batch of flags by prefix. Uses substr comparison, not LIKE:
 * record names may contain `_`, which is a LIKE wildcard.
 */
export async function clearFlagsLike(env: Env, prefix: string): Promise<void> {
  await execute(env.DB, "DELETE FROM flags WHERE substr(key, 1, ?) = ?", [
    prefix.length,
    prefix,
  ]);
}

// ---------------------------------------------------------------------------
// Session revocation blacklist
// ---------------------------------------------------------------------------

export async function revokeSession(
  env: Env,
  tokenId: string,
  expiresAt: number,
): Promise<void> {
  if (!tokenId) return;
  const now = nowSeconds();
  // The table only grows, so piggy-back expiry cleanup on every logout.
  await execute(env.DB, "DELETE FROM revoked_sessions WHERE expires_at <= ?", [
    now,
  ]);
  if (Math.trunc(expiresAt) <= now) return; // already expired: no need to record
  await execute(
    env.DB,
    "INSERT INTO revoked_sessions(token_id, expires_at) VALUES(?, ?) " +
      "ON CONFLICT(token_id) DO UPDATE SET expires_at=excluded.expires_at",
    [tokenId, Math.trunc(expiresAt)],
  );
}

export async function isSessionRevoked(env: Env, tokenId: string): Promise<boolean> {
  if (!tokenId) return false;
  const row = await queryOne<Row>(
    env.DB,
    "SELECT 1 FROM revoked_sessions WHERE token_id=? AND expires_at > ?",
    [tokenId, nowSeconds()],
  );
  return row !== null;
}

// ---------------------------------------------------------------------------
// servers
// ---------------------------------------------------------------------------

export const SERVER_COLUMNS =
  "id, label, access_key_id, access_key_secret, region_id, site, instance_id, " +
  "quota_gb, threshold_gb, remark, traffic_used, instance_status, stop_mode, stopped_mode, " +
  "public_ip, traffic_checked_at, status_checked_at, monthly_cost, balance_amount, " +
  "billing_currency, billing_cycle, billing_updated_at, billing_error, created_at, sort_order";

// Only two site values; anything else normalises to the China site so dirty
// data never reaches endpoint resolution.
export const SITE_TYPES = ["china", "international"] as const;

// Selectable stop modes: StopCharging = economy stop, Stop = normal stop.
// Old / dirty values fall back to economy stop: the fixed behaviour before
// this option existed.
export const STOP_MODES = ["StopCharging", "Stop"] as const;
export const DEFAULT_STOP_MODE = "StopCharging";

export function normalizeStopMode(value: unknown): string {
  const mode = asStr(value).trim();
  return (STOP_MODES as readonly string[]).includes(mode) ? mode : DEFAULT_STOP_MODE;
}

export function normalizeSite(value: unknown): string {
  const site = asStr(value).trim().toLowerCase();
  return (SITE_TYPES as readonly string[]).includes(site) ? site : "china";
}

export interface ServerView {
  id: number;
  label: string;
  access_key_id: string;
  region_id: string;
  site: string;
  instance_id: string;
  quota_gb: number;
  threshold_gb: number;
  remark: string;
  traffic_used: number | null;
  instance_status: string;
  stop_mode: string;
  stopped_mode: string;
  public_ip: string;
  traffic_checked_at: number;
  status_checked_at: number;
  monthly_cost: number | null;
  balance_amount: number | null;
  billing_currency: string;
  billing_cycle: string;
  billing_updated_at: number;
  billing_error: string;
  created_at: number;
  sort_order: number;
  secret_configured: boolean;
  /** Only present when decryptSecret=true (plaintext, for Aliyun calls). */
  access_key_secret?: string;
  /** Only present when decryptSecret=false (masked for display). */
  access_key_masked?: string;
}

async function serverRow(env: Env, row: Row, decryptSecret = false): Promise<ServerView> {
  const item: ServerView = {
    id: asInt(row["id"]),
    label: asStr(row["label"]),
    access_key_id: asStr(row["access_key_id"]),
    region_id: asStr(row["region_id"]),
    site: normalizeSite(row["site"]),
    instance_id: asStr(row["instance_id"]),
    quota_gb: asNum(row["quota_gb"], 200),
    threshold_gb: asNum(row["threshold_gb"], 188),
    remark: asStr(row["remark"]),
    traffic_used: asOptNum(row["traffic_used"]),
    instance_status: asStr(row["instance_status"]),
    stop_mode: normalizeStopMode(row["stop_mode"]),
    stopped_mode: asStr(row["stopped_mode"]),
    public_ip: asStr(row["public_ip"]),
    traffic_checked_at: asInt(row["traffic_checked_at"]),
    status_checked_at: asInt(row["status_checked_at"]),
    monthly_cost: asOptNum(row["monthly_cost"]),
    balance_amount: asOptNum(row["balance_amount"]),
    billing_currency: asStr(row["billing_currency"]),
    billing_cycle: asStr(row["billing_cycle"]),
    billing_updated_at: asInt(row["billing_updated_at"]),
    billing_error: asStr(row["billing_error"]),
    created_at: asInt(row["created_at"]),
    sort_order: asInt(row["sort_order"]),
    secret_configured: false,
  };
  const secret = asStr(row["access_key_secret"]);
  item.secret_configured = Boolean(secret);
  if (decryptSecret) {
    // Aliyun calls need the plaintext, otherwise the signature is over ciphertext.
    if (!secret) {
      item.access_key_secret = "";
    } else {
      try {
        item.access_key_secret = await decrypt(secret, env.ENCRYPTION_KEY);
      } catch (err) {
        throw new Error(
          `${item.label || "该服务器"} 的 AccessKey Secret 解密失败，通常是 ENCRYPTION_KEY 被替换或丢失，请重新填写一遍 Secret`,
        );
      }
    }
  } else {
    // A lost/rotated key must not take the whole server list down.
    try {
      item.access_key_masked = mask(await decrypt(secret, env.ENCRYPTION_KEY));
    } catch {
      item.access_key_masked = "⚠️ 解密失败";
      item.secret_configured = false;
    }
  }
  return item;
}

export async function listServers(
  env: Env,
  decryptSecret = false,
): Promise<ServerView[]> {
  // Manual sort first: sort_order != 0 sorts by sort_order ascending; the
  // rest (0 default) fall back to a stable id-based key.
  const rows = await query<Row>(
    env.DB,
    `SELECT ${SERVER_COLUMNS} FROM servers ORDER BY ` +
      "CASE WHEN sort_order=0 THEN id + 1000000 ELSE sort_order END, id",
  );
  const out: ServerView[] = [];
  for (const row of rows) out.push(await serverRow(env, row, decryptSecret));
  return out;
}

export async function getServer(
  env: Env,
  serverId: number,
  decryptSecret = false,
): Promise<ServerView | null> {
  const row = await queryOne<Row>(
    env.DB,
    `SELECT ${SERVER_COLUMNS} FROM servers WHERE id=?`,
    [serverId],
  );
  return row ? serverRow(env, row, decryptSecret) : null;
}

function gbValue(raw: unknown, fallback: number, label: string): number {
  // float("inf") slips past quota>0 / threshold<=quota checks and then breaks
  // every JSON response (Infinity is not valid JSON); NaN trips SQLite's
  // NOT NULL constraint. Block both before writing.
  if (raw === null || raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${label}必须是有限数字`);
  }
  return value;
}

export interface ServerPayload {
  id?: unknown;
  label?: unknown;
  access_key_id?: unknown;
  access_key_secret?: unknown;
  region_id?: unknown;
  site?: unknown;
  instance_id?: unknown;
  quota_gb?: unknown;
  threshold_gb?: unknown;
  remark?: unknown;
  stop_mode?: unknown;
  [key: string]: unknown;
}

export async function upsertServer(env: Env, payload: ServerPayload): Promise<number> {
  const serverId = asInt(payload["id"], 0);
  const label = asStr(payload["label"]).trim();
  let ak = asStr(payload["access_key_id"]).trim();
  const sk = asStr(payload["access_key_secret"]).trim();
  const region = asStr(payload["region_id"]).trim();
  let site = normalizeSite(payload["site"]);
  const instance = asStr(payload["instance_id"]).trim();
  const quota = gbValue(payload["quota_gb"], 200.0, "总配额");
  const threshold = gbValue(payload["threshold_gb"], 188.0, "阈值");
  const remark = asStr(payload["remark"]).trim();
  const stopModeRaw = payload["stop_mode"];
  // Absent (old frontend / field-only callers) keeps the stored value;
  // a new server falls back to economy stop.
  const stopMode =
    stopModeRaw !== null && stopModeRaw !== undefined
      ? normalizeStopMode(stopModeRaw)
      : "";

  if (!region) throw new Error("地域不能为空");
  // Distinguish "not passed" from "passed 0 / negative": a cleared input
  // sends 0, which used to be silently swallowed back to the default.
  if (quota <= 0) throw new Error("总配额必须大于 0");
  if (threshold <= 0 || threshold > quota) {
    throw new Error("阈值必须大于 0 且不超过总配额");
  }

  if (serverId) {
    const existing = await queryOne<Row>(
      env.DB,
      "SELECT access_key_id, access_key_secret, site, instance_id, stop_mode FROM servers WHERE id=?",
      [serverId],
    );
    if (existing === null) throw new Error("服务器不存在");
    if (!ak) ak = asStr(existing["access_key_id"]);
    if (payload["site"] === null || payload["site"] === undefined) {
      // Old frontends that do not send the field must not reset the site.
      site = normalizeSite(existing["site"]);
    }
    let finalStopMode = stopMode;
    if (stopModeRaw === null || stopModeRaw === undefined) {
      finalStopMode = normalizeStopMode(existing["stop_mode"]);
    }
    const encrypted = sk
      ? await encrypt(sk, env.ENCRYPTION_KEY)
      : asStr(existing["access_key_secret"]);
    // Changing account / instance / site invalidates the old billing snapshot.
    const billingChanged =
      ak !== asStr(existing["access_key_id"]) ||
      instance !== asStr(existing["instance_id"]) ||
      site !== normalizeSite(existing["site"]);
    const resetBilling = billingChanged
      ? ", monthly_cost=NULL, balance_amount=NULL, billing_currency='', " +
        "billing_cycle='', billing_updated_at=0, billing_error=''"
      : "";
    await execute(
      env.DB,
      "UPDATE servers SET label=?, access_key_id=?, access_key_secret=?, region_id=?, " +
        "site=?, instance_id=?, quota_gb=?, threshold_gb=?, remark=?, stop_mode=?" +
        resetBilling +
        " WHERE id=?",
      [
        label || ak.slice(-6),
        ak,
        encrypted,
        region,
        site,
        instance,
        quota,
        threshold,
        remark,
        finalStopMode,
        serverId,
      ],
    );
    return serverId;
  }

  if (!ak) throw new Error("AccessKey ID 不能为空");
  if (!sk) throw new Error("新建服务器必须填写 AccessKey Secret");
  const result = await execute(
    env.DB,
    "INSERT INTO servers(label, access_key_id, access_key_secret, region_id, site, instance_id, " +
      "quota_gb, threshold_gb, remark, stop_mode, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    [
      label || ak.slice(-6),
      ak,
      await encrypt(sk, env.ENCRYPTION_KEY),
      region,
      site,
      instance,
      quota,
      threshold,
      remark,
      stopMode || DEFAULT_STOP_MODE,
      nowSeconds(),
    ],
  );
  return result.lastInsertRowId;
}

/**
 * Persist server ordering: sort_order counts up from 1 in the given order.
 * orderedIds must be the complete ordered id list; unlisted servers are
 * zeroed and fall back to natural id order at the back.
 */
export async function reorderServers(env: Env, orderedIds: number[]): Promise<void> {
  if (!orderedIds || orderedIds.length === 0) return;
  const statements: { sql: string; params: (string | number | null)[] }[] = [
    { sql: "UPDATE servers SET sort_order=0", params: [] },
  ];
  orderedIds.forEach((serverId, index) => {
    statements.push({
      sql: "UPDATE servers SET sort_order=? WHERE id=?",
      params: [index + 1, Math.trunc(serverId)],
    });
  });
  await batch(env.DB, statements);
}

export async function deleteServer(env: Env, serverId: number): Promise<void> {
  const used = await queryOne<Row>(
    env.DB,
    "SELECT 1 FROM shift_members WHERE server_id=?",
    [serverId],
  );
  if (used !== null) throw new Error("该服务器仍在某个换班组里，请先移出");
  await batch(env.DB, [
    { sql: "DELETE FROM servers WHERE id=?", params: [serverId] },
    { sql: "DELETE FROM keepalives WHERE server_id=?", params: [serverId] },
    { sql: "DELETE FROM traffic_samples WHERE server_id=?", params: [serverId] },
    {
      sql: "DELETE FROM flags WHERE key IN (?,?,?,?,?,?,?)",
      params: [
        `read_err:${serverId}`,
        `keepalive_err:${serverId}`,
        `keepalive_fail:${serverId}`,
        `keepalive_tries:${serverId}`,
        // Rest-window flags: a deleted server keeps them, and a future
        // server reusing the id would never enter its run window.
        `keepalive_rest:${serverId}`,
        `keepalive_rest_fail:${serverId}`,
        // Stale wait flag from <=1.2.36, swept up opportunistically.
        `keepalive_wait:${serverId}`,
      ],
    },
    // The target is gone, so its DNS bindings must be released or records
    // stay attached to a machine that no longer exists.
    {
      sql:
        "UPDATE dns_records SET target_kind='', target_id=0, last_ip='', " +
        "last_status='', last_at=0, updated_at=? " +
        "WHERE target_kind='server' AND target_id=?",
      params: [nowSeconds(), serverId],
    },
  ]);
}

/** Change only the site. Called by the billing probe, touches nothing else. */
export async function updateServerSite(
  env: Env,
  serverId: number,
  site: string,
): Promise<void> {
  await execute(env.DB, "UPDATE servers SET site=? WHERE id=?", [
    normalizeSite(site),
    serverId,
  ]);
}

export interface BillingUpdate {
  monthlyCost?: number | null;
  balance?: number | null;
  currency?: string;
  cycle?: string;
  error?: string;
  touch?: boolean;
}

/**
 * Write a billing snapshot. monthlyCost / balance of null means "not fetched
 * this time, keep the old value" — distinct from a fetched 0, which is stored.
 */
export async function updateServerBilling(
  env: Env,
  serverId: number,
  opts: BillingUpdate,
): Promise<void> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (opts.monthlyCost !== null && opts.monthlyCost !== undefined) {
    sets.push("monthly_cost=?");
    params.push(Number(opts.monthlyCost));
  }
  if (opts.balance !== null && opts.balance !== undefined) {
    sets.push("balance_amount=?");
    params.push(Number(opts.balance));
  }
  if (opts.currency) {
    sets.push("billing_currency=?");
    params.push(String(opts.currency));
  }
  if (opts.cycle) {
    sets.push("billing_cycle=?");
    params.push(String(opts.cycle));
  }
  sets.push("billing_error=?");
  params.push(String(opts.error ?? ""));
  if (opts.touch !== false) {
    sets.push("billing_updated_at=?");
    params.push(nowSeconds());
  }
  params.push(serverId);
  await execute(env.DB, `UPDATE servers SET ${sets.join(", ")} WHERE id=?`, params);
}

export interface RuntimeUpdate {
  traffic?: number | null;
  status?: string | null;
  stoppedMode?: string | null;
  publicIp?: string | null;
  regionId?: string | null;
}

export async function updateServerRuntime(
  env: Env,
  serverId: number,
  opts: RuntimeUpdate,
): Promise<void> {
  const now = nowSeconds();
  if (opts.traffic !== null && opts.traffic !== undefined) {
    await execute(
      env.DB,
      "UPDATE servers SET traffic_used=?, traffic_checked_at=? WHERE id=?",
      [Number(opts.traffic), now, serverId],
    );
  }
  if (opts.status !== null && opts.status !== undefined) {
    const status = String(opts.status);
    const stoppedMode = String(opts.stoppedMode ?? "");
    if (opts.publicIp) {
      await execute(
        env.DB,
        "UPDATE servers SET instance_status=?, stopped_mode=?, public_ip=?, " +
          "status_checked_at=? WHERE id=?",
        [status, stoppedMode, String(opts.publicIp), now, serverId],
      );
    } else if (status.startsWith("Stop") || status.includes("Releas")) {
      // Stopped / released: the public IP really is gone, clear it.
      await execute(
        env.DB,
        "UPDATE servers SET instance_status=?, stopped_mode=?, public_ip='', " +
          "status_checked_at=? WHERE id=?",
        [status, stoppedMode, now, serverId],
      );
    } else {
      // Running / starting but no public IP: usually a transient missing
      // field in DescribeInstances. Keep the last known IP rather than
      // blanking DNS targets and notification IP lines.
      await execute(
        env.DB,
        "UPDATE servers SET instance_status=?, stopped_mode=?, " +
          "status_checked_at=? WHERE id=?",
        [status, stoppedMode, now, serverId],
      );
    }
  }
  if (opts.regionId) {
    // Backfill the real region from DescribeInstances; never trust a typo.
    await execute(env.DB, "UPDATE servers SET region_id=? WHERE id=?", [
      String(opts.regionId),
      serverId,
    ]);
  }
}

// ---------------------------------------------------------------------------
// traffic samples
// ---------------------------------------------------------------------------

export interface TrafficSample {
  ts: number;
  used: number;
  status: string;
}

export async function addSample(
  env: Env,
  serverId: number,
  used: number,
  status: string,
): Promise<void> {
  const now = nowSeconds();
  const last = await queryOne<Row>(
    env.DB,
    "SELECT used, ts FROM traffic_samples WHERE server_id=? ORDER BY ts DESC LIMIT 1",
    [serverId],
  );
  if (
    last !== null &&
    now - asInt(last["ts"]) < 600 &&
    Math.abs(asNum(last["used"]) - used) < 0.001
  ) {
    return;
  }
  await execute(
    env.DB,
    "INSERT INTO traffic_samples(server_id, ts, used, status) VALUES(?,?,?,?)",
    [serverId, now, used, status],
  );
}

/**
 * Timestamp of this server's most recent traffic sample; 0 if never sampled.
 * Distinguishes "no reading yet this month" (fresh zero) from "a reading
 * went missing mid-month" (API jitter): monthly usage only ever rises.
 */
export async function lastSampleTs(env: Env, serverId: number): Promise<number> {
  const row = await queryOne<Row>(
    env.DB,
    "SELECT MAX(ts) AS ts FROM traffic_samples WHERE server_id=?",
    [serverId],
  );
  if (row === null || row["ts"] === null || row["ts"] === undefined) return 0;
  return asInt(row["ts"]);
}

export async function listSamples(
  env: Env,
  serverId: number,
  hours = 72,
): Promise<TrafficSample[]> {
  const since = nowSeconds() - hours * 3600;
  const rows = await query<Row>(
    env.DB,
    "SELECT ts, used, status FROM traffic_samples WHERE server_id=? AND ts>=? ORDER BY ts",
    [serverId, since],
  );
  return rows.map((row) => ({
    ts: asInt(row["ts"]),
    used: asNum(row["used"]),
    status: asStr(row["status"]),
  }));
}

export async function latestSamples(
  env: Env,
  serverId: number,
): Promise<{ used: number; ts: number } | null> {
  const row = await queryOne<Row>(
    env.DB,
    "SELECT used, ts FROM traffic_samples WHERE server_id=? ORDER BY ts DESC LIMIT 1",
    [serverId],
  );
  return row ? { used: asNum(row["used"]), ts: asInt(row["ts"]) } : null;
}

export interface ServerTrafficSample {
  server_id: number;
  ts: number;
  used: number;
  status: string;
}

/**
 * Fetch traffic samples across all (or one specific) ECS servers since `sinceTs`,
 * ordered chronologically so callers can aggregate daily increments and trends.
 */
export async function listAllSamplesSince(
  env: Env,
  sinceTs: number,
  serverId = 0,
): Promise<ServerTrafficSample[]> {
  const rows =
    serverId > 0
      ? await query<Row>(
          env.DB,
          "SELECT server_id, ts, used, status FROM traffic_samples WHERE server_id=? AND ts>=? ORDER BY ts ASC",
          [serverId, sinceTs],
        )
      : await query<Row>(
          env.DB,
          "SELECT server_id, ts, used, status FROM traffic_samples WHERE ts>=? ORDER BY ts ASC",
          [sinceTs],
        );
  return rows.map((row) => ({
    server_id: asInt(row["server_id"]),
    ts: asInt(row["ts"]),
    used: asNum(row["used"]),
    status: asStr(row["status"]),
  }));
}

// ---------------------------------------------------------------------------
// keepalives (single-instance keepalive)
// ---------------------------------------------------------------------------

export interface KeepaliveView {
  id: number;
  server_id: number;
  enabled: number;
  created_at: number;
  start_time: string;
  end_time: string;
  start_day: number;
  end_day: number;
  label: string;
  instance_status: string;
  stop_mode: string;
  stopped_mode: string;
  public_ip: string;
  traffic_used: number | null;
  quota_gb: number;
  threshold_gb: number;
  instance_id: string;
  region_id: string;
  site: string;
  status_checked_at: number;
}

export async function listKeepalives(env: Env): Promise<KeepaliveView[]> {
  const rows = await query<Row>(
    env.DB,
    "SELECT k.id, k.server_id, k.enabled, k.created_at, k.start_time, k.end_time, " +
      "k.start_day, k.end_day, s.label, s.instance_status, s.stop_mode, " +
      "s.stopped_mode, s.public_ip, s.traffic_used, s.quota_gb, s.threshold_gb, " +
      "s.instance_id, s.region_id, s.site, s.status_checked_at " +
      "FROM keepalives k JOIN servers s ON s.id=k.server_id ORDER BY k.id",
  );
  return rows.map((row) => ({
    id: asInt(row["id"]),
    server_id: asInt(row["server_id"]),
    enabled: asInt(row["enabled"]),
    created_at: asInt(row["created_at"]),
    start_time: asStr(row["start_time"]),
    end_time: asStr(row["end_time"]),
    start_day: asInt(row["start_day"]),
    end_day: asInt(row["end_day"]),
    label: asStr(row["label"]),
    instance_status: asStr(row["instance_status"]),
    stop_mode: asStr(row["stop_mode"]),
    stopped_mode: asStr(row["stopped_mode"]),
    public_ip: asStr(row["public_ip"]),
    traffic_used: asOptNum(row["traffic_used"]),
    quota_gb: asNum(row["quota_gb"]),
    threshold_gb: asNum(row["threshold_gb"]),
    instance_id: asStr(row["instance_id"]),
    region_id: asStr(row["region_id"]),
    site: asStr(row["site"]),
    status_checked_at: asInt(row["status_checked_at"]),
  }));
}

export interface KeepaliveRow {
  id: number;
  server_id: number;
  enabled: number;
  start_time: string;
  end_time: string;
  start_day: number;
  end_day: number;
  created_at: number;
}

function toKeepaliveRow(row: Row): KeepaliveRow {
  return {
    id: asInt(row["id"]),
    server_id: asInt(row["server_id"]),
    enabled: asInt(row["enabled"]),
    start_time: asStr(row["start_time"]),
    end_time: asStr(row["end_time"]),
    start_day: asInt(row["start_day"]),
    end_day: asInt(row["end_day"]),
    created_at: asInt(row["created_at"]),
  };
}

export async function getKeepalive(
  env: Env,
  keepaliveId: number,
): Promise<KeepaliveRow | null> {
  const row = await queryOne<Row>(env.DB, "SELECT * FROM keepalives WHERE id=?", [
    keepaliveId,
  ]);
  return row ? toKeepaliveRow(row) : null;
}

export async function keepaliveServerIds(env: Env): Promise<Set<number>> {
  const rows = await query<Row>(
    env.DB,
    "SELECT server_id FROM keepalives WHERE enabled=1",
  );
  return new Set(rows.map((row) => asInt(row["server_id"])));
}

export interface KeepaliveSchedule {
  server_id: number;
  enabled: number;
  start_time: string;
  end_time: string;
  start_day: number;
  end_day: number;
}

/** server_id -> run window. Read once per reconcile round, not per event. */
export async function keepaliveSchedules(
  env: Env,
): Promise<Record<number, KeepaliveSchedule>> {
  const rows = await query<Row>(
    env.DB,
    "SELECT server_id, enabled, start_time, end_time, start_day, end_day FROM keepalives",
  );
  const out: Record<number, KeepaliveSchedule> = {};
  for (const row of rows) {
    out[asInt(row["server_id"])] = {
      server_id: asInt(row["server_id"]),
      enabled: asInt(row["enabled"]),
      start_time: asStr(row["start_time"]),
      end_time: asStr(row["end_time"]),
      start_day: asInt(row["start_day"]),
      end_day: asInt(row["end_day"]),
    };
  }
  return out;
}

export interface KeepaliveOptions {
  startTime?: string;
  endTime?: string;
  startDay?: number;
  endDay?: number;
  /** snake_case aliases (accepted for callers mirroring the Python/JSON names). */
  start_time?: string;
  end_time?: string;
  start_day?: number;
  end_day?: number;
}

function keepaliveWindow(opts: KeepaliveOptions): {
  startTime: string;
  endTime: string;
  startDay: number;
  endDay: number;
} {
  return {
    startTime: opts.startTime ?? opts.start_time ?? "",
    endTime: opts.endTime ?? opts.end_time ?? "",
    startDay: asInt(opts.startDay ?? opts.start_day, 0),
    endDay: asInt(opts.endDay ?? opts.end_day, 0),
  };
}

export async function addKeepalive(
  env: Env,
  serverId: number,
  enabled = true,
  optsOrStartTime: KeepaliveOptions | string = "",
  endTime = "",
  startDay = 0,
  endDay = 0,
): Promise<number> {
  if (
    (await queryOne<Row>(env.DB, "SELECT 1 FROM servers WHERE id=?", [serverId])) ===
    null
  ) {
    throw new Error("服务器不存在");
  }
  const enabledVal = enabled ? 1 : 0;
  // Window either as an options object or positionally
  // (serverId, enabled, startTime, endTime, startDay, endDay).
  const window =
    typeof optsOrStartTime === "string"
      ? { startTime: optsOrStartTime, endTime, startDay, endDay }
      : keepaliveWindow(optsOrStartTime);
  // Atomic upsert: a prior check-then-insert raced under concurrent requests
  // and hit the server_id UNIQUE constraint. ON CONFLICT covers the switch
  // and window without touching created_at.
  await execute(
    env.DB,
    "INSERT INTO keepalives(server_id, enabled, start_time, end_time, start_day, end_day, created_at) " +
      "VALUES(?,?,?,?,?,?,?) " +
      "ON CONFLICT(server_id) DO UPDATE SET enabled=excluded.enabled, " +
      "start_time=excluded.start_time, end_time=excluded.end_time, " +
      "start_day=excluded.start_day, end_day=excluded.end_day",
    [
      serverId,
      enabledVal,
      window.startTime,
      window.endTime,
      window.startDay,
      window.endDay,
      nowSeconds(),
    ],
  );
  // Re-joining / changing the window voids stale rest markers.
  await clearKeepaliveFlags(env, serverId);
  const row = await queryOne<Row>(
    env.DB,
    "SELECT id FROM keepalives WHERE server_id=?",
    [serverId],
  );
  return row ? asInt(row["id"]) : 0;
}

async function clearKeepaliveFlags(env: Env, serverId: number): Promise<void> {
  // A leftover keepalive_rest makes the next round think "still in the rest
  // window" and skip the "window resumed" notice; a leftover
  // keepalive_resume_pending makes the next interruption look like a
  // continuation of the window ending instead of a fresh event.
  await execute(env.DB, "DELETE FROM flags WHERE key IN (?,?,?)", [
    `keepalive_rest:${serverId}`,
    `keepalive_rest_fail:${serverId}`,
    `keepalive_resume_pending:${serverId}`,
  ]);
}

export async function setKeepaliveEnabled(
  env: Env,
  keepaliveId: number,
  enabled: boolean,
): Promise<void> {
  await execute(env.DB, "UPDATE keepalives SET enabled=? WHERE id=?", [
    enabled ? 1 : 0,
    keepaliveId,
  ]);
  if (!enabled) {
    const row = await queryOne<Row>(
      env.DB,
      "SELECT server_id FROM keepalives WHERE id=?",
      [keepaliveId],
    );
    if (row !== null) await clearKeepaliveFlags(env, asInt(row["server_id"]));
  }
}

/** Change the switch and run window. server_id is immutable — re-add to move. */
export async function updateKeepalive(
  env: Env,
  keepaliveId: number,
  opts: KeepaliveOptions & { enabled?: boolean },
): Promise<void> {
  const window = keepaliveWindow(opts);
  await execute(
    env.DB,
    "UPDATE keepalives SET enabled=?, start_time=?, end_time=?, start_day=?, end_day=? " +
      "WHERE id=?",
    [
      opts.enabled === false ? 0 : 1,
      window.startTime,
      window.endTime,
      window.startDay,
      window.endDay,
      keepaliveId,
    ],
  );
}

export async function deleteKeepalive(env: Env, keepaliveId: number): Promise<void> {
  // Only the keepalive task itself is deleted. DNS bindings are user-made on
  // the DNS page and are not cleared here — one machine may serve other
  // purposes under the same domain.
  const row = await queryOne<Row>(
    env.DB,
    "SELECT server_id FROM keepalives WHERE id=?",
    [keepaliveId],
  );
  await execute(env.DB, "DELETE FROM keepalives WHERE id=?", [keepaliveId]);
  if (row !== null) await clearKeepaliveFlags(env, asInt(row["server_id"]));
}

// ---------------------------------------------------------------------------
// DNS records + bindings
// ---------------------------------------------------------------------------

export interface DnsRecord {
  record: string;
  target_kind: string;
  target_id: number;
  last_ip: string;
  last_status: string;
  last_at: number;
  updated_at: number;
  sort_order: number;
}

function toDnsRecord(row: Row): DnsRecord {
  return {
    record: asStr(row["record"]),
    target_kind: asStr(row["target_kind"]),
    target_id: asInt(row["target_id"]),
    last_ip: asStr(row["last_ip"]),
    last_status: asStr(row["last_status"]),
    last_at: asInt(row["last_at"]),
    updated_at: asInt(row["updated_at"]),
    sort_order: asInt(row["sort_order"]),
  };
}

export async function listDnsRecords(env: Env): Promise<DnsRecord[]> {
  // Manual sort first: dragged records by sort_order ascending, never-dragged
  // (0) by registration order behind them.
  const rows = await query<Row>(
    env.DB,
    "SELECT * FROM dns_records " +
      "ORDER BY CASE WHEN sort_order=0 THEN rowid + 1000000 ELSE sort_order END, rowid",
  );
  return rows.map(toDnsRecord);
}

/**
 * Persist record ordering: sort_order counts up from 1.
 * `ordered` must be the complete ordered record-name list; unlisted records
 * are zeroed back to registration order. Unknown names are ignored, and if
 * none are recognised the table is left untouched.
 */
export async function reorderDnsRecords(
  env: Env,
  ordered: string[],
): Promise<void> {
  if (!ordered || ordered.length === 0) return;
  const known = new Set(
    (await query<Row>(env.DB, "SELECT record FROM dns_records")).map((row) =>
      asStr(row["record"]),
    ),
  );
  if (!ordered.some((record) => known.has(String(record)))) return;
  const statements: { sql: string; params: (string | number | null)[] }[] = [
    { sql: "UPDATE dns_records SET sort_order=0", params: [] },
  ];
  ordered.forEach((record, index) => {
    const name = String(record);
    if (!known.has(name)) return;
    statements.push({
      sql: "UPDATE dns_records SET sort_order=? WHERE record=?",
      params: [index + 1, name],
    });
  });
  await batch(env.DB, statements);
}

export async function getDnsRecord(
  env: Env,
  record: string,
): Promise<DnsRecord | null> {
  const row = await queryOne<Row>(env.DB, "SELECT * FROM dns_records WHERE record=?", [
    record,
  ]);
  return row ? toDnsRecord(row) : null;
}

/** Register a record name. Existing rows are left untouched (binding kept). */
export async function ensureDnsRecord(env: Env, record: string): Promise<void> {
  await execute(
    env.DB,
    "INSERT INTO dns_records(record, updated_at) VALUES(?, ?) " +
      "ON CONFLICT(record) DO NOTHING",
    [record, nowSeconds()],
  );
}

export async function deleteDnsRecord(env: Env, record: string): Promise<void> {
  await execute(env.DB, "DELETE FROM dns_records WHERE record=?", [record]);
}

/**
 * Bind a record to a target. One record belongs to exactly one target;
 * one target may hold many records (www, api, … on the same machine).
 */
export async function bindDnsRecord(
  env: Env,
  record: string,
  kind: string,
  target: number,
): Promise<void> {
  await execute(
    env.DB,
    "UPDATE dns_records SET target_kind=?, target_id=?, updated_at=? WHERE record=?",
    [kind, kind ? target : 0, nowSeconds(), record],
  );
}

/** All records this target currently holds, in UI display order. */
export async function dnsRecordsOf(
  env: Env,
  kind: string,
  target: number,
): Promise<string[]> {
  if (!kind || !target) return [];
  const rows = await query<Row>(
    env.DB,
    "SELECT record FROM dns_records WHERE target_kind=? AND target_id=? " +
      "ORDER BY CASE WHEN sort_order=0 THEN rowid + 1000000 ELSE sort_order END, rowid",
    [kind, target],
  );
  return rows.map((row) => asStr(row["record"]));
}

/** The target's first record, or "" when unbound. For "is it bound" checks. */
export async function dnsRecordOf(
  env: Env,
  kind: string,
  target: number,
): Promise<string> {
  const names = await dnsRecordsOf(env, kind, target);
  return names.length > 0 ? (names[0] as string) : "";
}

export async function setDnsState(
  env: Env,
  record: string,
  ip: string,
  status: string,
  at?: number | null,
): Promise<void> {
  await execute(
    env.DB,
    "UPDATE dns_records SET last_ip=?, last_status=?, last_at=? WHERE record=?",
    [ip, status, at !== null && at !== undefined ? Math.trunc(at) : nowSeconds(), record],
  );
}

// ---------------------------------------------------------------------------
// shift groups + members
// ---------------------------------------------------------------------------

export interface ShiftMember {
  id: number;
  group_id: number;
  server_id: number;
  position: number;
  hours: number;
  enabled: number;
  slot_name: string;
  start_time: string;
  end_time: string;
  days: number;
  label: string;
  instance_id: string;
  region_id: string;
  site: string;
  instance_status: string;
  stop_mode: string;
  stopped_mode: string;
  public_ip: string;
  traffic_used: number | null;
  quota_gb: number;
  threshold_gb: number;
  status_checked_at: number;
}

export interface ShiftGroup {
  id: number;
  name: string;
  enabled: number;
  failover_enabled: number;
  ddns_record: string;
  anchor_at: number;
  created_at: number;
  cycle: string;
  members: ShiftMember[];
}

export async function listMembers(env: Env, groupId: number): Promise<ShiftMember[]> {
  const rows = await query<Row>(
    env.DB,
    "SELECT m.id, m.group_id, m.server_id, m.position, m.hours, m.enabled, " +
      "m.slot_name, m.start_time, m.end_time, m.days, " +
      "s.label, s.instance_id, s.region_id, s.site, s.instance_status, s.stop_mode, s.stopped_mode, " +
      "s.public_ip, s.traffic_used, s.quota_gb, s.threshold_gb, s.status_checked_at " +
      "FROM shift_members m LEFT JOIN servers s ON s.id=m.server_id " +
      "WHERE m.group_id=? ORDER BY m.position",
    [groupId],
  );
  return rows.map((row) => ({
    id: asInt(row["id"]),
    group_id: asInt(row["group_id"]),
    server_id: asInt(row["server_id"]),
    position: asInt(row["position"]),
    hours: asNum(row["hours"]),
    enabled: asInt(row["enabled"]),
    slot_name: asStr(row["slot_name"]),
    start_time: asStr(row["start_time"]),
    end_time: asStr(row["end_time"]),
    days: asInt(row["days"]),
    label: asStr(row["label"]),
    instance_id: asStr(row["instance_id"]),
    region_id: asStr(row["region_id"]),
    site: asStr(row["site"]),
    instance_status: asStr(row["instance_status"]),
    stop_mode: asStr(row["stop_mode"]),
    stopped_mode: asStr(row["stopped_mode"]),
    public_ip: asStr(row["public_ip"]),
    traffic_used: asOptNum(row["traffic_used"]),
    quota_gb: asNum(row["quota_gb"]),
    threshold_gb: asNum(row["threshold_gb"]),
    status_checked_at: asInt(row["status_checked_at"]),
  }));
}

function toShiftGroup(row: Row, members: ShiftMember[]): ShiftGroup {
  return {
    id: asInt(row["id"]),
    name: asStr(row["name"]),
    enabled: asInt(row["enabled"]),
    failover_enabled: asInt(row["failover_enabled"]),
    ddns_record: asStr(row["ddns_record"]),
    anchor_at: asInt(row["anchor_at"]),
    created_at: asInt(row["created_at"]),
    cycle: asStr(row["cycle"]) || "day",
    members,
  };
}

export async function listGroups(env: Env): Promise<ShiftGroup[]> {
  const rows = await query<Row>(env.DB, "SELECT * FROM shift_groups ORDER BY id");
  const groups: ShiftGroup[] = [];
  for (const row of rows) {
    groups.push(toShiftGroup(row, await listMembers(env, asInt(row["id"]))));
  }
  return groups;
}

export async function getGroup(env: Env, groupId: number): Promise<ShiftGroup | null> {
  const row = await queryOne<Row>(env.DB, "SELECT * FROM shift_groups WHERE id=?", [
    groupId,
  ]);
  if (row === null) return null;
  return toShiftGroup(row, await listMembers(env, groupId));
}

interface ParsedMember {
  server_id: number;
  position: number;
  hours: number;
  days: number;
  enabled: number;
  slot_name: string;
  start_time: string;
  end_time: string;
}

/**
 * One server cannot be in two *enabled* shift groups: the groups would treat
 * each other's members as "off-duty → stop", starting/stopping each other
 * every round. Disabled groups do not participate (normal "set up, paused" state).
 */
async function groupConflict(
  env: Env,
  members: ParsedMember[],
  groupId: number,
): Promise<string> {
  const ids = new Set(
    members.filter((m) => m.enabled).map((m) => m.server_id),
  );
  if (ids.size === 0) return "";
  const rows = await query<Row>(
    env.DB,
    "SELECT g.name, m.server_id FROM shift_groups g " +
      "JOIN shift_members m ON m.group_id = g.id " +
      "WHERE g.enabled=1 AND g.id<>? AND m.enabled=1",
    [groupId],
  );
  for (const row of rows) {
    const serverId = asInt(row["server_id"]);
    if (!ids.has(serverId)) continue;
    const server = await getServer(env, serverId);
    const label = (server && server.label) || `#${serverId}`;
    return (
      `「${label}」已在换班组「${asStr(row["name"])}」里，` +
      "同一台服务器不能同时编进两个启用的换班组"
    );
  }
  return "";
}

export interface GroupMemberPayload {
  server_id?: unknown;
  hours?: unknown;
  days?: unknown;
  enabled?: unknown;
  slot_name?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  [key: string]: unknown;
}

export interface GroupPayload {
  id?: unknown;
  name?: unknown;
  enabled?: unknown;
  failover_enabled?: unknown;
  cycle?: unknown;
  ddns_record?: unknown;
  members?: unknown;
  [key: string]: unknown;
}

export async function upsertGroup(env: Env, payload: GroupPayload): Promise<number> {
  let groupId = asInt(payload["id"], 0);
  const name = asStr(payload["name"]).trim() || "换班组";
  const enabled = payload["enabled"] === false ? 0 : 1;
  const failover = payload["failover_enabled"] === false ? 0 : 1;
  // Rotation cycle: day = one round per day (hours / fixed timetable),
  // month = one round per month (by days). Absent keeps the stored value.
  let cycle: string;
  if ("cycle" in payload) {
    cycle = asStr(payload["cycle"]).trim() === "month" ? "month" : "day";
  } else {
    const row = await queryOne<Row>(
      env.DB,
      "SELECT cycle FROM shift_groups WHERE id=?",
      [groupId],
    );
    cycle = (row ? asStr(row["cycle"]) : "") || "day";
  }
  const monthCycle = cycle === "month";
  // DNS binding moved to the DNS page; absent keeps the stored value.
  let ddnsRecord: string;
  if ("ddns_record" in payload) {
    ddnsRecord = asStr(payload["ddns_record"]).trim();
  } else {
    const row = await queryOne<Row>(
      env.DB,
      "SELECT ddns_record FROM shift_groups WHERE id=?",
      [groupId],
    );
    ddnsRecord = row ? asStr(row["ddns_record"]) : "";
  }

  const rawMembers = Array.isArray(payload["members"])
    ? (payload["members"] as GroupMemberPayload[])
    : [];
  const members: ParsedMember[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < rawMembers.length; index++) {
    const item = rawMembers[index] as GroupMemberPayload;
    const serverId = asInt(item["server_id"], 0);
    if (!serverId) continue;
    if (seen.has(serverId)) {
      throw new Error("同一台服务器不能在组里出现两次");
    }
    seen.add(serverId);
    const hoursRaw = item["hours"];
    const hours =
      hoursRaw === null || hoursRaw === undefined || hoursRaw === ""
        ? 0
        : Number(hoursRaw);
    const daysRaw = item["days"];
    const days =
      daysRaw === null || daysRaw === undefined || daysRaw === ""
        ? 0
        : Math.trunc(Number(daysRaw));
    // A month cycle is scheduled by days; hours is a display estimate only.
    if (!monthCycle && (!Number.isFinite(hours) || hours <= 0 || hours > 168)) {
      throw new Error("每台的运行时长应在 0–168 小时之间");
    }
    if (monthCycle && (!Number.isFinite(days) || days < 0)) {
      throw new Error("每台的天数不能是负数");
    }
    const slotName = asStr(item["slot_name"]).trim();
    let startTime = asStr(item["start_time"]).trim();
    let endTime = asStr(item["end_time"]).trim();
    if (monthCycle) {
      // Month rotation has no hourly boundaries; clear them, don't store dirt.
      startTime = "";
      endTime = "";
    }
    // Times are either both empty (legacy hours accumulation) or both filled
    // and well-formed.
    if ((startTime && !endTime) || (endTime && !startTime)) {
      throw new Error("班次起止时刻要成对填写");
    }
    if (startTime && !isHhmm(startTime)) {
      throw new Error(`起始时刻「${startTime}」格式应为 HH:MM`);
    }
    if (endTime && !isHhmm(endTime)) {
      throw new Error(`结束时刻「${endTime}」格式应为 HH:MM`);
    }
    members.push({
      server_id: serverId,
      position: index,
      hours: Number.isFinite(hours) ? hours : 0,
      days: Number.isFinite(days) ? days : 0,
      enabled: item["enabled"] === false ? 0 : 1,
      slot_name: slotName,
      start_time: startTime,
      end_time: endTime,
    });
  }

  if (members.length < 2) throw new Error("换班组至少需要两台服务器");
  if (monthCycle) {
    // A month has at most 31 days: a larger total means someone never gets a
    // shift all month. All-empty days split 31 evenly (remainder to the last).
    // Only enabled members count: disabled members are never scheduled.
    for (const member of members) {
      if (!member.enabled) member.days = 0;
    }
    const live = members.filter((m) => m.enabled);
    if (live.some((m) => m.days > 0) && live.some((m) => m.days <= 0)) {
      throw new Error("一月一轮的组，每台启用的成员都要填天数");
    }
    if (live.length > 0 && live.every((m) => m.days <= 0)) {
      const base = Math.max(1, Math.floor(31 / live.length));
      live.forEach((member, index) => {
        member.days =
          index < live.length - 1
            ? base
            : Math.max(1, 31 - base * (live.length - 1));
      });
    }
    const totalDays = live.reduce((sum, m) => sum + m.days, 0);
    if (totalDays > 31) {
      throw new Error(`合计 ${totalDays} 天，超过一个月最多 31 天`);
    }
    if (totalDays <= 0) {
      throw new Error("至少需要一台启用的成员，且天数大于 0");
    }
  } else if (
    members.filter((m) => m.enabled).reduce((sum, m) => sum + m.hours, 0) <= 0
  ) {
    throw new Error("至少需要一台启用的成员，且时长大于 0");
  }
  if (enabled) {
    const conflict = await groupConflict(env, members, groupId);
    if (conflict) throw new Error(conflict);
  }

  // Changing the member composition resets the rotation anchor, or the
  // timetable would desync. Compare the old signature first (reads only).
  let resetAnchor = false;
  if (groupId) {
    const existing = await queryOne<Row>(
      env.DB,
      "SELECT 1 FROM shift_groups WHERE id=?",
      [groupId],
    );
    if (existing === null) throw new Error("换班组不存在");
    const oldRows = await query<Row>(
      env.DB,
      "SELECT server_id, hours, days, slot_name, start_time, end_time " +
        "FROM shift_members WHERE group_id=? ORDER BY position",
      [groupId],
    );
    const oldCycleRow = await queryOne<Row>(
      env.DB,
      "SELECT cycle FROM shift_groups WHERE id=?",
      [groupId],
    );
    const oldCycle = (oldCycleRow ? asStr(oldCycleRow["cycle"]) : "") || "day";
    const signature = (rows: Row[]) =>
      JSON.stringify(
        rows.map((r) => [
          asInt(r["server_id"]),
          asNum(r["hours"]),
          asInt(r["days"]),
          asStr(r["slot_name"]),
          asStr(r["start_time"]),
          asStr(r["end_time"]),
        ]),
      );
    const newSignature = JSON.stringify(
      members.map((m) => [
        m.server_id,
        m.hours,
        m.days,
        m.slot_name,
        m.start_time,
        m.end_time,
      ]),
    );
    resetAnchor = signature(oldRows) !== newSignature || oldCycle !== cycle;
  }

  const memberStatements = (gid: number) =>
    members.map((m) => ({
      sql:
        "INSERT INTO shift_members(group_id, server_id, position, hours, enabled, " +
        "slot_name, start_time, end_time, days) VALUES(?,?,?,?,?,?,?,?,?)",
      params: [
        gid,
        m.server_id,
        m.position,
        m.hours,
        m.enabled,
        m.slot_name,
        m.start_time,
        m.end_time,
        m.days,
      ] as (string | number | null)[],
    }));

  if (groupId) {
    const statements: { sql: string; params: (string | number | null)[] }[] = [
      {
        sql:
          "UPDATE shift_groups SET name=?, enabled=?, failover_enabled=?, ddns_record=?, cycle=? " +
          "WHERE id=?",
        params: [name, enabled, failover, ddnsRecord, cycle, groupId],
      },
    ];
    if (resetAnchor) {
      statements.push({
        sql: "UPDATE shift_groups SET anchor_at=? WHERE id=?",
        params: [nowSeconds(), groupId],
      });
    }
    statements.push({
      sql: "DELETE FROM shift_members WHERE group_id=?",
      params: [groupId],
    });
    statements.push(...memberStatements(groupId));
    await batch(env.DB, statements);
    return groupId;
  }

  const created = await execute(
    env.DB,
    "INSERT INTO shift_groups(name, enabled, failover_enabled, ddns_record, cycle, " +
      "anchor_at, created_at) VALUES(?,?,?,?,?,?,?)",
    [name, enabled, failover, ddnsRecord, cycle, nowSeconds(), nowSeconds()],
  );
  groupId = created.lastInsertRowId;
  await batch(env.DB, memberStatements(groupId));
  return groupId;
}

export async function deleteGroup(env: Env, groupId: number): Promise<void> {
  await batch(env.DB, [
    { sql: "DELETE FROM shift_members WHERE group_id=?", params: [groupId] },
    { sql: "DELETE FROM shift_runs WHERE group_id=?", params: [groupId] },
    { sql: "DELETE FROM shift_groups WHERE id=?", params: [groupId] },
    {
      sql:
        "UPDATE dns_records SET target_kind='', target_id=0, last_ip='', " +
        "last_status='', last_at=0, updated_at=? " +
        "WHERE target_kind='group' AND target_id=?",
      params: [nowSeconds(), groupId],
    },
  ]);
}

export async function resetGroupAnchor(env: Env, groupId: number): Promise<void> {
  await execute(env.DB, "UPDATE shift_groups SET anchor_at=? WHERE id=?", [
    nowSeconds(),
    groupId,
  ]);
}

/** Alias of resetGroupAnchor (same meaning: re-anchor the rotation now). */
export const setGroupAnchor = resetGroupAnchor;

// ---------------------------------------------------------------------------
// shift runs
// ---------------------------------------------------------------------------

export interface ShiftRun {
  group_id: number;
  slot: string;
  phase: string;
  stage: string;
  event_id: number;
  duty_server_id: number;
  standby_server_ids: string;
  failover: number;
  failover_reason: string;
  failover_from: number;
  duty_day: string;
  manual: number;
  origin: string;
  dns_before: string;
  attempts: number;
  started_at: number;
  updated_at: number;
  note: string;
}

function toShiftRun(row: Row): ShiftRun {
  return {
    group_id: asInt(row["group_id"]),
    slot: asStr(row["slot"]),
    phase: asStr(row["phase"]),
    stage: asStr(row["stage"]),
    event_id: asInt(row["event_id"]),
    duty_server_id: asInt(row["duty_server_id"]),
    standby_server_ids: asStr(row["standby_server_ids"]),
    failover: asInt(row["failover"]),
    failover_reason: asStr(row["failover_reason"]),
    failover_from: asInt(row["failover_from"]),
    duty_day: asStr(row["duty_day"]),
    manual: asInt(row["manual"]),
    origin: asStr(row["origin"]),
    dns_before: asStr(row["dns_before"]),
    attempts: asInt(row["attempts"]),
    started_at: asInt(row["started_at"]),
    updated_at: asInt(row["updated_at"]),
    note: asStr(row["note"]),
  };
}

export async function getRun(
  env: Env,
  groupId: number,
  slot: string,
): Promise<ShiftRun | null> {
  const row = await queryOne<Row>(
    env.DB,
    "SELECT * FROM shift_runs WHERE group_id=? AND slot=?",
    [groupId, slot],
  );
  return row ? toShiftRun(row) : null;
}

// "Healthy" phases: `note` holds the failure reason (breaker / limit stop),
// so returning to one of these must clear it — otherwise the UI keeps
// showing "all members over limit" on a card that says "ready, duty running".
const HEALTHY_PHASES = ["pending", "switching", "settled", "failover", "manual"];

const RUN_COLUMNS: ReadonlySet<string> = new Set([
  "phase",
  "stage",
  "event_id",
  "duty_server_id",
  "standby_server_ids",
  "failover",
  "failover_reason",
  "failover_from",
  "duty_day",
  "manual",
  "origin",
  "dns_before",
  "attempts",
  "started_at",
  "updated_at",
  "note",
]);

export async function upsertRun(
  env: Env,
  groupId: number,
  slot: string,
  fields: Record<string, unknown>,
): Promise<ShiftRun> {
  const now = nowSeconds();
  const patch: Record<string, unknown> = { ...fields };
  if (HEALTHY_PHASES.includes(asStr(patch["phase"])) && !("note" in patch)) {
    patch["note"] = "";
  }
  // started_at anchors the shift timeout. It is written once when the row is
  // created; callers pass it explicitly to re-time (failover recovery).
  const resetStarted = "started_at" in patch;
  const startedAt = resetStarted ? asInt(patch["started_at"], now) : now;
  delete patch["started_at"];

  const columns = ["group_id", "slot", "started_at", "updated_at"];
  const values: (string | number | null)[] = [groupId, slot, startedAt, now];
  for (const [key, value] of Object.entries(patch)) {
    if (!RUN_COLUMNS.has(key) || key === "updated_at") continue;
    columns.push(key);
    values.push(
      value === null || value === undefined
        ? null
        : typeof value === "number" || typeof value === "string"
          ? value
          : String(value),
    );
  }
  // One atomic upsert (was INSERT-then-UPDATE: a crash in between left an
  // empty run row). On conflict only the passed fields + updated_at change;
  // started_at is untouched unless explicitly re-timed above.
  const updateKeys = [
    ...(resetStarted ? ["started_at"] : []),
    ...columns.slice(4),
    "updated_at",
  ];
  const updates = updateKeys.map((key) => `${key}=excluded.${key}`).join(", ");
  await execute(
    env.DB,
    `INSERT INTO shift_runs(${columns.join(", ")}) ` +
      `VALUES(${columns.map(() => "?").join(",")}) ` +
      `ON CONFLICT(group_id, slot) DO UPDATE SET ${updates}`,
    values,
  );
  const run = await getRun(env, groupId, slot);
  if (!run) throw new Error("shift_runs upsert did not return a row");
  return run;
}

export async function recentRuns(env: Env, limit = 30): Promise<(ShiftRun & { group_name: string })[]> {
  const rows = await query<Row>(
    env.DB,
    "SELECT r.*, g.name AS group_name FROM shift_runs r " +
      "LEFT JOIN shift_groups g ON g.id=r.group_id " +
      "ORDER BY r.updated_at DESC LIMIT ?",
    [limit],
  );
  return rows.map((row) => ({ ...toShiftRun(row), group_name: asStr(row["group_name"]) }));
}

export function standbyIds(run: ShiftRun | Row): number[] {
  try {
    const parsed: unknown = JSON.parse(asStr(run["standby_server_ids"]) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map((value) => asInt(value)).filter((v) => Number.isFinite(v));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

export interface EventRecord {
  id: number;
  ts: number;
  level: string;
  kind: string;
  group_id: number;
  server_id: number;
  title: string;
  detail: string;
  status: string;
  progress: ProgressStep[];
  finished_at: number;
  pending_status: string;
  pending_kind: string;
  pending_ts: number;
}

function parseProgress(raw: unknown): ProgressStep[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(asStr(raw));
    if (!Array.isArray(data)) return [];
    return data
      .filter(
        (step): step is Record<string, unknown> =>
          typeof step === "object" && step !== null,
      )
      .map((step) => ({ ts: asInt(step["ts"]), text: asStr(step["text"]) }));
  } catch {
    return [];
  }
}

function toEvent(row: Row): EventRecord {
  return {
    id: asInt(row["id"]),
    ts: asInt(row["ts"]),
    level: asStr(row["level"]),
    kind: asStr(row["kind"]),
    group_id: asInt(row["group_id"]),
    server_id: asInt(row["server_id"]),
    title: asStr(row["title"]),
    detail: asStr(row["detail"]),
    status: asStr(row["status"]),
    progress: parseProgress(row["progress"]),
    finished_at: asInt(row["finished_at"]),
    pending_status: asStr(row["pending_status"]),
    pending_kind: asStr(row["pending_kind"]),
    pending_ts: asInt(row["pending_ts"]),
  };
}

export interface AddEventOptions {
  detail?: string;
  level?: string;
  groupId?: number;
  serverId?: number;
  status?: string;
  pendingStatus?: string;
  pendingKind?: string;
}

/**
 * Write an event. Returns the event id for later addEventProgress calls.
 * status: done (one-shot history) / running (in progress) / error (failed).
 * pending_status: async target state (e.g. Stopped/Running), '' = no polling.
 * pending_kind: manual / keepalive — the confirmer uses it to decide whether
 * to send a follow-up notice once the target is reached.
 *
 * Two call forms (both used across the port, mirroring Python's positional
 * add_event(kind, title, detail, level, ...) and the options object):
 *   addEvent(env, kind, title, detail, {level, groupId, serverId, status, ...})
 *   addEvent(env, kind, title, {detail, level, groupId, serverId, status, ...})
 *
 * One-shot events (done / error) get their detail split into progress lines,
 * so every event shows "what it did", not just a title and a summary.
 */
export async function addEvent(
  env: Env,
  kind: string,
  title: string,
  detailOrOpts: string | AddEventOptions = "",
  optsArg: AddEventOptions = {},
): Promise<number> {
  const opts: AddEventOptions =
    typeof detailOrOpts === "object" ? detailOrOpts : optsArg;
  const detail =
    typeof detailOrOpts === "string" ? detailOrOpts : (opts.detail ?? "");
  const now = nowSeconds();
  const status = opts.status ?? "done";
  const result = await execute(
    env.DB,
    "INSERT INTO events(ts, level, kind, group_id, server_id, title, detail, " +
      "status, finished_at, pending_status, pending_kind, pending_ts) " +
      "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    [
      now,
      opts.level ?? "info",
      kind,
      opts.groupId ?? 0,
      opts.serverId ?? 0,
      title,
      detail,
      status,
      status !== "running" ? now : 0,
      status === "running" ? (opts.pendingStatus ?? "") : "",
      status === "running" ? (opts.pendingKind ?? "") : "",
      // Waiting starts now (same as ts); retargetEvent refreshes it.
      status === "running" ? now : 0,
    ],
  );
  const eventId = result.lastInsertRowId;
  if (status !== "running" && detail) {
    for (const line of detail.split("\n")) {
      const text = line.trim().replace(/^[·\-]\s*/, "").trim();
      if (text) await addEventProgress(env, eventId, text);
    }
  }
  return eventId;
}

/** All "running and needing polling confirmation" events (confirmer input). */
export async function listPendingEvents(env: Env): Promise<EventRecord[]> {
  const rows = await query<Row>(
    env.DB,
    "SELECT * FROM events WHERE status='running' AND pending_status<>'' ORDER BY id",
  );
  return rows.map(toEvent);
}

/**
 * Does this server already have a running manual power event waiting for the
 * same target status? Guards idempotency: manual power ops are async
 * (issued, then polled), and fast double-clicks would otherwise issue
 * duplicate start/stop commands and spawn duplicate spinning events.
 */
export async function pendingManualExists(
  env: Env,
  serverId: number,
  targetStatus: string,
): Promise<boolean> {
  const row = await queryOne<Row>(
    env.DB,
    "SELECT 1 FROM events WHERE server_id=? AND status='running' " +
      "AND pending_kind='manual' AND pending_status=?",
    [serverId, targetStatus],
  );
  return row !== null;
}

/**
 * This server's still-waiting event of a given kind (newest first), or null.
 * Keepalive retries reuse the same event to append progress instead of
 * opening a new "keepalive pull-up" event per retry.
 */
export async function pendingEvent(
  env: Env,
  serverId: number,
  pendingKind: string,
): Promise<EventRecord | null> {
  const row = await queryOne<Row>(
    env.DB,
    "SELECT * FROM events WHERE server_id=? AND status='running' " +
      "AND pending_kind=? ORDER BY id DESC LIMIT 1",
    [serverId, pendingKind],
  );
  return row ? toEvent(row) : null;
}

/** All "running" events of a given pending_kind (read-alert cleanup use). */
export async function runningPendingEvents(
  env: Env,
  pendingKind: string,
): Promise<EventRecord[]> {
  const rows = await query<Row>(
    env.DB,
    "SELECT * FROM events WHERE status='running' AND pending_kind=? ORDER BY id",
    [pendingKind],
  );
  return rows.map(toEvent);
}

// Max progress steps kept per event; oldest are dropped so a long-stuck
// event cannot grow its progress without bound.
export const PROGRESS_MAX_STEPS = 50;

/**
 * Append a line to an event's progress log. Adjacent duplicates are skipped
 * (a reconcile round re-appending the same step every minute); once=true
 * deduplicates across the whole event (a step reappearing after other steps
 * were inserted in between). Steps are capped at PROGRESS_MAX_STEPS.
 */
export async function addEventProgress(
  env: Env,
  eventId: number,
  text: string,
  opts: { once?: boolean } = {},
): Promise<void> {
  if (!eventId) return;
  const now = nowSeconds();
  const row = await queryOne<Row>(env.DB, "SELECT progress FROM events WHERE id=?", [
    eventId,
  ]);
  if (row === null) return;
  let progress = parseProgress(row["progress"]);
  if (progress.length > 0 && progress[progress.length - 1]?.text === text) return;
  if (opts.once && progress.some((step) => step.text === text)) return;
  progress.push({ ts: now, text });
  if (progress.length > PROGRESS_MAX_STEPS) {
    progress = progress.slice(-PROGRESS_MAX_STEPS);
  }
  await execute(env.DB, "UPDATE events SET progress=? WHERE id=?", [
    JSON.stringify(progress),
    eventId,
  ]);
}

/** Fetch one event (with progress). Null when missing. */
export async function getEvent(env: Env, eventId: number): Promise<EventRecord | null> {
  if (!eventId) return null;
  const row = await queryOne<Row>(env.DB, "SELECT * FROM events WHERE id=?", [
    Math.trunc(eventId),
  ]);
  return row ? toEvent(row) : null;
}

/** Mark an event finished. status: done / error. */
export async function finishEvent(
  env: Env,
  eventId: number,
  status = "done",
  detail = "",
): Promise<void> {
  if (!eventId) return;
  const sets = ["status=?", "finished_at=?"];
  const params: (string | number | null)[] = [status, nowSeconds()];
  if (detail) {
    sets.push("detail=?");
    params.push(detail);
  }
  params.push(eventId);
  await execute(env.DB, `UPDATE events SET ${sets.join(", ")} WHERE id=?`, params);
}

/**
 * Rewrite an event's title / detail / kind / level (e.g. "handover in
 * progress" -> "handover complete"), keeping ts and progress.
 */
export async function updateEvent(
  env: Env,
  eventId: number,
  opts: { title?: string; detail?: string; kind?: string; level?: string },
): Promise<void> {
  if (!eventId) return;
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (opts.title) {
    sets.push("title=?");
    params.push(opts.title);
  }
  if (opts.detail) {
    sets.push("detail=?");
    params.push(opts.detail);
  }
  if (opts.kind) {
    sets.push("kind=?");
    params.push(opts.kind);
  }
  if (opts.level) {
    sets.push("level=?");
    params.push(opts.level);
  }
  if (sets.length === 0) return;
  params.push(eventId);
  await execute(env.DB, `UPDATE events SET ${sets.join(", ")} WHERE id=?`, params);
}

/**
 * Retarget a still-spinning event to wait for a different state.
 * Typical case: a keepalive pull-up event is mid-flight when the run window
 * closes — it should now wait for Stopped, not Running.
 * pending_ts refreshes too: the timeout is measured from "started waiting
 * for this target", and the event may already be hours old.
 */
export async function retargetEvent(
  env: Env,
  eventId: number,
  pendingStatus: string,
  pendingKind: string,
): Promise<void> {
  if (!eventId) return;
  await execute(
    env.DB,
    "UPDATE events SET pending_status=?, pending_kind=?, pending_ts=? WHERE id=?",
    [pendingStatus, pendingKind, nowSeconds(), eventId],
  );
}

/** This group's still-running events, filtered by kind (prevents stale spins). */
export async function runningEvents(
  env: Env,
  groupId: number,
  kinds: string[],
): Promise<EventRecord[]> {
  if (!kinds || kinds.length === 0) return [];
  const placeholders = kinds.map(() => "?").join(",");
  const rows = await query<Row>(
    env.DB,
    `SELECT * FROM events WHERE group_id=? AND status='running' ` +
      `AND kind IN (${placeholders}) ORDER BY id DESC`,
    [Math.trunc(groupId), ...kinds],
  );
  return rows.map(toEvent);
}

export async function listEvents(
  env: Env,
  limit = 200,
  kind = "",
  level = "",
  groupId = 0,
): Promise<EventRecord[]> {
  let sql = "SELECT * FROM events WHERE 1=1";
  const params: (string | number | null)[] = [];
  if (kind) {
    sql += " AND kind=?";
    params.push(kind);
  }
  if (level) {
    sql += " AND level=?";
    params.push(level);
  }
  if (groupId) {
    sql += " AND group_id=?";
    params.push(groupId);
  }
  sql += " ORDER BY id DESC LIMIT ?";
  params.push(limit);
  const rows = await query<Row>(env.DB, sql, params);
  return rows.map(toEvent);
}

/**
 * Most recent event id of a kind (optionally in a group) within maxAge
 * seconds, for appending a closing step to an event recorded earlier.
 * The time window stops a fresh over-limit from writing onto an ancient event.
 */
export async function latestEventId(
  env: Env,
  kind: string,
  groupId = 0,
  maxAge = 3600,
): Promise<number> {
  let sql = "SELECT id FROM events WHERE kind=? AND ts>=?";
  const params: (string | number | null)[] = [kind, nowSeconds() - maxAge];
  if (groupId) {
    sql += " AND group_id=?";
    params.push(groupId);
  }
  sql += " ORDER BY id DESC LIMIT 1";
  const row = await queryOne<Row>(env.DB, sql, params);
  return row ? asInt(row["id"]) : 0;
}

/**
 * A server's most recent event of one of the given kinds within maxAge
 * seconds, for writing a late result back onto an already-finished event
 * (pendingEvent only finds running ones).
 */
export async function latestServerEvent(
  env: Env,
  serverId: number,
  kinds: string[],
  maxAge = 600,
): Promise<EventRecord | null> {
  if (!kinds || kinds.length === 0) return null;
  const placeholders = kinds.map(() => "?").join(",");
  const params: (string | number | null)[] = [
    serverId,
    ...kinds,
    nowSeconds() - maxAge,
  ];
  const row = await queryOne<Row>(
    env.DB,
    `SELECT * FROM events WHERE server_id=? AND kind IN (${placeholders}) AND ts>=? ` +
      "ORDER BY id DESC LIMIT 1",
    params,
  );
  return row ? toEvent(row) : null;
}

export async function pruneEvents(env: Env, days: number): Promise<void> {
  const now = nowSeconds();
  const cutoff = now - days * 86400;
  // Running events are never pruned: keepalive / shift events may legally
  // hang for days (long-term out-of-stock / arrears), and cutting by ts
  // would delete them from the UI and reset their "attempt N" counters.
  await execute(env.DB, "DELETE FROM events WHERE ts<? AND status<>'running'", [
    cutoff,
  ]);
  // flags hold both per-slot dedup keys and long-lived state ("already
  // yielded", "breaker tripped"), so they get a 90-day floor, not the
  // event retention period.
  await execute(env.DB, "DELETE FROM flags WHERE created_at<?", [
    now - Math.max(days, 90) * 86400,
  ]);
  // shift_runs must outlive the longest slot: failover recovery judges the
  // previous round's phase, and deleting early makes a restarted duty look
  // like a brand-new slot and re-send a handover-complete notice.
  await execute(env.DB, "DELETE FROM shift_runs WHERE updated_at<?", [
    now - 30 * 86400,
  ]);
  // Retain 45 days of samples so 30-day charts and previous-month comparisons stay populated.
  await execute(env.DB, "DELETE FROM traffic_samples WHERE ts<?", [now - 45 * 86400]);
}

// ---------------------------------------------------------------------------
// swas_servers (Aliyun Lightweight Application Server — independent registry)
// ---------------------------------------------------------------------------

export type SwasProvider = "aliyun" | "tencent";

export function normalizeProvider(value: unknown): SwasProvider {
  const s = asStr(value).trim().toLowerCase();
  return s === "tencent" ? "tencent" : "aliyun";
}

export const SWAS_COLUMNS =
  "id, provider, label, access_key_id, access_key_secret, region_id, site, instance_id, remark, " +
  "instance_status, public_ip, inner_ip, plan_id, plan_type, cpu, memory_gb, disk_size_gb, " +
  "bandwidth_mbps, image_name, os_type, expired_time, business_status, " +
  "traffic_used_gb, traffic_total_gb, traffic_overflow_gb, status_checked_at, traffic_checked_at, " +
  "monthly_cost, balance_amount, billing_currency, billing_cycle, billing_updated_at, " +
  "billing_error, created_at, sort_order";

export interface SwasServerView {
  id: number;
  provider: SwasProvider;
  label: string;
  access_key_id: string;
  region_id: string;
  site: string;
  instance_id: string;
  remark: string;
  instance_status: string;
  public_ip: string;
  inner_ip: string;
  plan_id: string;
  plan_type: string;
  cpu: number;
  memory_gb: number;
  disk_size_gb: number;
  bandwidth_mbps: number;
  image_name: string;
  os_type: string;
  expired_time: string;
  business_status: string;
  traffic_used_gb: number | null;
  traffic_total_gb: number | null;
  traffic_overflow_gb: number | null;
  status_checked_at: number;
  traffic_checked_at: number;
  monthly_cost: number | null;
  balance_amount: number | null;
  billing_currency: string;
  billing_cycle: string;
  billing_updated_at: number;
  billing_error: string;
  created_at: number;
  sort_order: number;
  secret_configured: boolean;
  /** Plaintext secret when decryptSecret=true; never returned in API responses. */
  access_key_secret?: string;
  /** Masked secret for UI display when decryptSecret=false. */
  access_key_masked?: string;
}

async function swasRow(env: Env, row: Row, decryptSecret = false): Promise<SwasServerView> {
  const item: SwasServerView = {
    id: asInt(row["id"]),
    provider: normalizeProvider(row["provider"]),
    label: asStr(row["label"]),
    access_key_id: asStr(row["access_key_id"]),
    region_id: asStr(row["region_id"]),
    site: normalizeSite(row["site"]),
    instance_id: asStr(row["instance_id"]),
    remark: asStr(row["remark"]),
    instance_status: asStr(row["instance_status"]),
    public_ip: asStr(row["public_ip"]),
    inner_ip: asStr(row["inner_ip"]),
    plan_id: asStr(row["plan_id"]),
    plan_type: asStr(row["plan_type"]),
    cpu: asInt(row["cpu"]),
    memory_gb: asNum(row["memory_gb"]),
    disk_size_gb: asInt(row["disk_size_gb"]),
    bandwidth_mbps: asInt(row["bandwidth_mbps"]),
    image_name: asStr(row["image_name"]),
    os_type: asStr(row["os_type"]),
    expired_time: asStr(row["expired_time"]),
    business_status: asStr(row["business_status"]),
    traffic_used_gb: asOptNum(row["traffic_used_gb"]),
    traffic_total_gb: asOptNum(row["traffic_total_gb"]),
    traffic_overflow_gb: asOptNum(row["traffic_overflow_gb"]),
    status_checked_at: asInt(row["status_checked_at"]),
    traffic_checked_at: asInt(row["traffic_checked_at"]),
    monthly_cost: asOptNum(row["monthly_cost"]),
    balance_amount: asOptNum(row["balance_amount"]),
    billing_currency: asStr(row["billing_currency"]),
    billing_cycle: asStr(row["billing_cycle"]),
    billing_updated_at: asInt(row["billing_updated_at"]),
    billing_error: asStr(row["billing_error"]),
    created_at: asInt(row["created_at"]),
    sort_order: asInt(row["sort_order"]),
    secret_configured: false,
  };
  const secret = asStr(row["access_key_secret"]);
  item.secret_configured = Boolean(secret);
  if (decryptSecret) {
    if (!secret) {
      item.access_key_secret = "";
    } else {
      try {
        item.access_key_secret = await decrypt(secret, env.ENCRYPTION_KEY);
      } catch {
        throw new Error(
          `${item.label || "该轻量服务器"} 的密钥解密失败，请重新填写一遍 Secret`,
        );
      }
    }
  } else {
    try {
      item.access_key_masked = mask(await decrypt(secret, env.ENCRYPTION_KEY));
    } catch {
      item.access_key_masked = "⚠️ 解密失败";
      item.secret_configured = false;
    }
  }
  return item;
}

export async function listSwasServers(
  env: Env,
  decryptSecret = false,
): Promise<SwasServerView[]> {
  const rows = await query<Row>(
    env.DB,
    `SELECT ${SWAS_COLUMNS} FROM swas_servers ORDER BY ` +
      "CASE WHEN sort_order=0 THEN id + 1000000 ELSE sort_order END, id",
  );
  const out: SwasServerView[] = [];
  for (const row of rows) out.push(await swasRow(env, row, decryptSecret));
  return out;
}

export async function getSwasServer(
  env: Env,
  swasId: number,
  decryptSecret = false,
): Promise<SwasServerView | null> {
  const row = await queryOne<Row>(
    env.DB,
    `SELECT ${SWAS_COLUMNS} FROM swas_servers WHERE id=?`,
    [swasId],
  );
  return row ? swasRow(env, row, decryptSecret) : null;
}

export interface SwasServerPayload {
  id?: unknown;
  provider?: unknown;
  label?: unknown;
  access_key_id?: unknown;
  access_key_secret?: unknown;
  region_id?: unknown;
  site?: unknown;
  instance_id?: unknown;
  remark?: unknown;
  [key: string]: unknown;
}

export async function upsertSwasServer(
  env: Env,
  payload: SwasServerPayload,
): Promise<number> {
  const swasId = asInt(payload["id"], 0);
  let provider = normalizeProvider(payload["provider"]);
  const label = asStr(payload["label"]).trim();
  let ak = asStr(payload["access_key_id"]).trim();
  const sk = asStr(payload["access_key_secret"]).trim();
  const region = asStr(payload["region_id"]).trim();
  let site = normalizeSite(payload["site"]);
  const instance = asStr(payload["instance_id"]).trim();
  const remark = asStr(payload["remark"]).trim();

  if (!region) throw new Error("地域不能为空");
  if (!instance) throw new Error("轻量实例 ID 不能为空");

  if (swasId) {
    const existing = await queryOne<Row>(
      env.DB,
      "SELECT provider, access_key_id, access_key_secret, site, instance_id FROM swas_servers WHERE id=?",
      [swasId],
    );
    if (existing === null) throw new Error("轻量服务器不存在");
    if (payload["provider"] === null || payload["provider"] === undefined || asStr(payload["provider"]).trim() === "") {
      provider = normalizeProvider(existing["provider"]);
    }
    if (!ak) ak = asStr(existing["access_key_id"]);
    if (payload["site"] === null || payload["site"] === undefined) {
      site = normalizeSite(existing["site"]);
    }
    const encrypted = sk
      ? await encrypt(sk, env.ENCRYPTION_KEY)
      : asStr(existing["access_key_secret"]);
    const billingChanged =
      provider !== normalizeProvider(existing["provider"]) ||
      ak !== asStr(existing["access_key_id"]) ||
      instance !== asStr(existing["instance_id"]) ||
      site !== normalizeSite(existing["site"]);
    const resetBilling = billingChanged
      ? ", monthly_cost=NULL, balance_amount=NULL, billing_currency='', " +
        "billing_cycle='', billing_updated_at=0, billing_error=''"
      : "";
    await execute(
      env.DB,
      "UPDATE swas_servers SET provider=?, label=?, access_key_id=?, access_key_secret=?, region_id=?, " +
        "site=?, instance_id=?, remark=?" +
        resetBilling +
        " WHERE id=?",
      [provider, label || instance.slice(0, 12), ak, encrypted, region, site, instance, remark, swasId],
    );
    return swasId;
  }

  if (!ak) throw new Error(provider === "tencent" ? "SecretId 不能为空" : "AccessKey ID 不能为空");
  if (!sk) {
    throw new Error(
      provider === "tencent"
        ? "新建腾讯云轻量服务器必须填写 SecretKey（或复用已有腾讯云账号）"
        : "新建轻量服务器必须填写 AccessKey Secret（或复用已有服务器账号）",
    );
  }
  const result = await execute(
    env.DB,
    "INSERT INTO swas_servers(provider, label, access_key_id, access_key_secret, region_id, site, " +
      "instance_id, remark, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    [
      provider,
      label || instance.slice(0, 12),
      ak,
      await encrypt(sk, env.ENCRYPTION_KEY),
      region,
      site,
      instance,
      remark,
      nowSeconds(),
    ],
  );
  return result.lastInsertRowId;
}

export async function deleteSwasServer(env: Env, swasId: number): Promise<void> {
  await execute(env.DB, "DELETE FROM swas_servers WHERE id=?", [swasId]);
}

export async function reorderSwasServers(env: Env, orderedIds: number[]): Promise<void> {
  if (!orderedIds || orderedIds.length === 0) return;
  const statements: { sql: string; params: (string | number | null)[] }[] = [
    { sql: "UPDATE swas_servers SET sort_order=0", params: [] },
  ];
  orderedIds.forEach((id, index) => {
    statements.push({
      sql: "UPDATE swas_servers SET sort_order=? WHERE id=?",
      params: [index + 1, Math.trunc(id)],
    });
  });
  await batch(env.DB, statements);
}

export async function updateSwasSite(
  env: Env,
  swasId: number,
  site: string,
): Promise<void> {
  await execute(env.DB, "UPDATE swas_servers SET site=? WHERE id=?", [
    normalizeSite(site),
    swasId,
  ]);
}

export interface SwasRuntimeUpdate {
  status?: string;
  publicIp?: string;
  innerIp?: string;
  planId?: string;
  planType?: string;
  cpu?: number;
  memoryGb?: number;
  diskSizeGb?: number;
  bandwidthMbps?: number;
  imageName?: string;
  osType?: string;
  expiredTime?: string;
  businessStatus?: string;
  trafficUsedGb?: number | null;
  trafficTotalGb?: number | null;
  trafficOverflowGb?: number | null;
}

export async function updateSwasRuntime(
  env: Env,
  swasId: number,
  opts: SwasRuntimeUpdate,
): Promise<void> {
  const now = nowSeconds();
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (opts.status !== undefined) {
    sets.push("instance_status=?", "status_checked_at=?");
    params.push(opts.status, now);
  }
  if (opts.publicIp !== undefined) {
    sets.push("public_ip=?");
    params.push(opts.publicIp);
  }
  if (opts.innerIp !== undefined) {
    sets.push("inner_ip=?");
    params.push(opts.innerIp);
  }
  if (opts.planId !== undefined) {
    sets.push("plan_id=?");
    params.push(opts.planId);
  }
  if (opts.planType !== undefined) {
    sets.push("plan_type=?");
    params.push(opts.planType);
  }
  if (opts.cpu !== undefined) {
    sets.push("cpu=?");
    params.push(Math.trunc(opts.cpu));
  }
  if (opts.memoryGb !== undefined) {
    sets.push("memory_gb=?");
    params.push(opts.memoryGb);
  }
  if (opts.diskSizeGb !== undefined) {
    sets.push("disk_size_gb=?");
    params.push(Math.trunc(opts.diskSizeGb));
  }
  if (opts.bandwidthMbps !== undefined) {
    sets.push("bandwidth_mbps=?");
    params.push(Math.trunc(opts.bandwidthMbps));
  }
  if (opts.imageName !== undefined) {
    sets.push("image_name=?");
    params.push(opts.imageName);
  }
  if (opts.osType !== undefined) {
    sets.push("os_type=?");
    params.push(opts.osType);
  }
  if (opts.expiredTime !== undefined) {
    sets.push("expired_time=?");
    params.push(opts.expiredTime);
  }
  if (opts.businessStatus !== undefined) {
    sets.push("business_status=?");
    params.push(opts.businessStatus);
  }
  if (opts.trafficUsedGb !== undefined || opts.trafficTotalGb !== undefined) {
    if (opts.trafficUsedGb !== undefined) {
      sets.push("traffic_used_gb=?");
      params.push(opts.trafficUsedGb);
    }
    if (opts.trafficTotalGb !== undefined) {
      sets.push("traffic_total_gb=?");
      params.push(opts.trafficTotalGb);
    }
    if (opts.trafficOverflowGb !== undefined) {
      sets.push("traffic_overflow_gb=?");
      params.push(opts.trafficOverflowGb);
    }
    sets.push("traffic_checked_at=?");
    params.push(now);
  }

  if (sets.length === 0) return;
  params.push(swasId);
  await execute(env.DB, `UPDATE swas_servers SET ${sets.join(", ")} WHERE id=?`, params);
}

export async function updateSwasBilling(
  env: Env,
  swasId: number,
  opts: BillingUpdate,
): Promise<void> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (opts.monthlyCost !== null && opts.monthlyCost !== undefined) {
    sets.push("monthly_cost=?");
    params.push(Number(opts.monthlyCost));
  }
  if (opts.balance !== null && opts.balance !== undefined) {
    sets.push("balance_amount=?");
    params.push(Number(opts.balance));
  }
  if (opts.currency) {
    sets.push("billing_currency=?");
    params.push(String(opts.currency));
  }
  if (opts.cycle) {
    sets.push("billing_cycle=?");
    params.push(String(opts.cycle));
  }
  sets.push("billing_error=?");
  params.push(String(opts.error ?? ""));
  if (opts.touch !== false) {
    sets.push("billing_updated_at=?");
    params.push(nowSeconds());
  }
  params.push(swasId);
  await execute(env.DB, `UPDATE swas_servers SET ${sets.join(", ")} WHERE id=?`, params);
}

// ---------------------------------------------------------------------------
// dns_accounts (Tencent Cloud DNSPod & Cloudflare DNS accounts)
// ---------------------------------------------------------------------------

export type DnsAccountProvider = "tencent" | "cloudflare";
export type DnsAccountAuthMode = "cam" | "token" | "global_key";

export interface DnsAccountRecord {
  id: number;
  provider: DnsAccountProvider;
  label: string;
  auth_mode: DnsAccountAuthMode;
  cred_id: string;
  cred_id_preview: string;
  has_secret: boolean;
  cred_secret?: string;
  remark: string;
  created_at: number;
  updated_at: number;
}

export interface DnsAccountInput {
  provider: DnsAccountProvider;
  label: string;
  auth_mode?: DnsAccountAuthMode;
  cred_id?: string;
  cred_secret?: string;
  remark?: string;
}

async function normalizeDnsAccountRow(
  env: Env,
  row: Row,
  decryptSecret: boolean,
): Promise<DnsAccountRecord> {
  const provider: DnsAccountProvider =
    asStr(row["provider"]).toLowerCase() === "cloudflare" ? "cloudflare" : "tencent";
  const rawAuthMode = asStr(row["auth_mode"]).toLowerCase();
  const authMode: DnsAccountAuthMode =
    provider === "tencent"
      ? "cam"
      : rawAuthMode === "global_key"
        ? "global_key"
        : "token";
  const credId = asStr(row["cred_id"]);
  const encryptedSecret = asStr(row["cred_secret"]);
  const out: DnsAccountRecord = {
    id: asInt(row["id"]),
    provider,
    label: asStr(row["label"]),
    auth_mode: authMode,
    cred_id: credId,
    cred_id_preview: credId ? (provider === "tencent" ? mask(credId) : credId) : "",
    has_secret: Boolean(encryptedSecret),
    remark: asStr(row["remark"]),
    created_at: asInt(row["created_at"]),
    updated_at: asInt(row["updated_at"]),
  };
  if (decryptSecret && encryptedSecret) {
    out.cred_secret = await decrypt(encryptedSecret, env.ENCRYPTION_KEY);
  }
  return out;
}

export async function listDnsAccounts(
  env: Env,
  opts?: { provider?: DnsAccountProvider; decryptSecret?: boolean },
): Promise<DnsAccountRecord[]> {
  const rows = opts?.provider
    ? await query<Row>(
        env.DB,
        "SELECT * FROM dns_accounts WHERE provider=? ORDER BY id ASC",
        [opts.provider],
      )
    : await query<Row>(env.DB, "SELECT * FROM dns_accounts ORDER BY provider ASC, id ASC");
  const list: DnsAccountRecord[] = [];
  for (const row of rows) {
    list.push(await normalizeDnsAccountRow(env, row, Boolean(opts?.decryptSecret)));
  }
  return list;
}

export async function getDnsAccount(
  env: Env,
  id: number,
  decryptSecret = false,
): Promise<DnsAccountRecord | null> {
  const row = await queryOne<Row>(env.DB, "SELECT * FROM dns_accounts WHERE id=?", [id]);
  if (!row) return null;
  return normalizeDnsAccountRow(env, row, decryptSecret);
}

export async function createDnsAccount(
  env: Env,
  input: DnsAccountInput,
): Promise<number> {
  const now = nowSeconds();
  const provider: DnsAccountProvider =
    input.provider === "cloudflare" ? "cloudflare" : "tencent";
  const authMode: DnsAccountAuthMode =
    provider === "tencent"
      ? "cam"
      : input.auth_mode === "global_key"
        ? "global_key"
        : "token";
  const secretEnc = await encrypt((input.cred_secret ?? "").trim(), env.ENCRYPTION_KEY);
  const res = await execute(
    env.DB,
    `INSERT INTO dns_accounts (
      provider, label, auth_mode, cred_id, cred_secret, remark, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      provider,
      input.label.trim(),
      authMode,
      (input.cred_id ?? "").trim(),
      secretEnc,
      (input.remark ?? "").trim(),
      now,
      now,
    ],
  );
  return res.lastInsertRowId;
}

export async function updateDnsAccount(
  env: Env,
  id: number,
  input: Partial<DnsAccountInput>,
): Promise<void> {
  const existing = await queryOne<Row>(env.DB, "SELECT * FROM dns_accounts WHERE id=?", [id]);
  if (!existing) throw new Error("DNS 账号不存在");
  const provider: DnsAccountProvider =
    (input.provider ?? asStr(existing["provider"])) === "cloudflare"
      ? "cloudflare"
      : "tencent";
  const authMode: DnsAccountAuthMode =
    provider === "tencent"
      ? "cam"
      : (input.auth_mode ?? asStr(existing["auth_mode"])) === "global_key"
        ? "global_key"
        : "token";
  const sets: string[] = [
    "provider=?",
    "label=?",
    "auth_mode=?",
    "cred_id=?",
    "remark=?",
    "updated_at=?",
  ];
  const params: (string | number | null)[] = [
    provider,
    (input.label ?? asStr(existing["label"])).trim(),
    authMode,
    input.cred_id !== undefined ? input.cred_id.trim() : asStr(existing["cred_id"]),
    input.remark !== undefined ? input.remark.trim() : asStr(existing["remark"]),
    nowSeconds(),
  ];
  if (input.cred_secret && input.cred_secret.trim()) {
    sets.push("cred_secret=?");
    params.push(await encrypt(input.cred_secret.trim(), env.ENCRYPTION_KEY));
  }
  params.push(id);
  await execute(env.DB, `UPDATE dns_accounts SET ${sets.join(", ")} WHERE id=?`, params);
}

export async function deleteDnsAccount(env: Env, id: number): Promise<void> {
  await execute(env.DB, "DELETE FROM dns_accounts WHERE id=?", [id]);
}

// ---------------------------------------------------------------------------
// ssl_certificates (Tencent Cloud 443 free SSL certificates + auto renewal)
// ---------------------------------------------------------------------------

export type SslVerifyMode = "tencent_auto" | "dns_account" | "manual";
export type SslCertStatus = "pending_dns" | "verifying" | "issued" | "failed" | "expired";

export interface SslCertificateRecord {
  id: number;
  domain: string;
  tencent_account_id: number;
  tencent_secret_id: string;
  tencent_secret_id_preview: string;
  has_custom_secret: boolean;
  tencent_secret_key?: string;
  dns_verify_mode: SslVerifyMode;
  dns_account_id: number;
  dns_root_domain: string;
  dns_zone_id: string;
  cert_id: string;
  pending_cert_id: string;
  replaced_cert_id: string;
  encrypt_algo: "RSA" | "ECC";
  status: SslCertStatus;
  tencent_status: number;
  status_name: string;
  dv_auth_domain: string;
  dv_auth_sub_domain: string;
  dv_auth_type: string;
  dv_auth_value: string;
  dns_record_id: string;
  dns_record_written: boolean;
  cert_begin_time: string;
  cert_end_time: string;
  cert_end_ts: number;
  auto_renew: boolean;
  renew_before_days: number;
  clean_dns_after_issue: boolean;
  last_error: string;
  last_checked_at: number;
  last_renew_at: number;
  remark: string;
  created_at: number;
  updated_at: number;
}

export interface SslCertificateCreateInput {
  domain: string;
  tencent_account_id?: number;
  tencent_secret_id?: string;
  tencent_secret_key?: string;
  dns_verify_mode?: SslVerifyMode;
  dns_account_id?: number;
  dns_root_domain?: string;
  dns_zone_id?: string;
  cert_id?: string;
  pending_cert_id?: string;
  replaced_cert_id?: string;
  encrypt_algo?: "RSA" | "ECC";
  status?: SslCertStatus;
  tencent_status?: number;
  status_name?: string;
  dv_auth_domain?: string;
  dv_auth_sub_domain?: string;
  dv_auth_type?: string;
  dv_auth_value?: string;
  dns_record_id?: string;
  dns_record_written?: boolean;
  cert_begin_time?: string;
  cert_end_time?: string;
  cert_end_ts?: number;
  auto_renew?: boolean;
  renew_before_days?: number;
  clean_dns_after_issue?: boolean;
  last_error?: string;
  last_checked_at?: number;
  last_renew_at?: number;
  remark?: string;
}

async function normalizeSslCertRow(
  env: Env,
  row: Row,
  decryptSecret: boolean,
): Promise<SslCertificateRecord> {
  const modeRaw = asStr(row["dns_verify_mode"]).toLowerCase();
  const mode: SslVerifyMode =
    modeRaw === "tencent_auto"
      ? "tencent_auto"
      : modeRaw === "manual"
        ? "manual"
        : "dns_account";
  const statusRaw = asStr(row["status"]).toLowerCase();
  const status: SslCertStatus =
    statusRaw === "verifying" ||
    statusRaw === "issued" ||
    statusRaw === "failed" ||
    statusRaw === "expired"
      ? statusRaw
      : "pending_dns";
  const secretId = asStr(row["tencent_secret_id"]);
  const secretKeyEnc = asStr(row["tencent_secret_key"]);
  const algo = asStr(row["encrypt_algo"]).toUpperCase() === "ECC" ? "ECC" : "RSA";

  const out: SslCertificateRecord = {
    id: asInt(row["id"]),
    domain: asStr(row["domain"]),
    tencent_account_id: asInt(row["tencent_account_id"]),
    tencent_secret_id: secretId,
    tencent_secret_id_preview: secretId ? mask(secretId) : "",
    has_custom_secret: Boolean(secretId && secretKeyEnc),
    dns_verify_mode: mode,
    dns_account_id: asInt(row["dns_account_id"]),
    dns_root_domain: asStr(row["dns_root_domain"]),
    dns_zone_id: asStr(row["dns_zone_id"]),
    cert_id: asStr(row["cert_id"]),
    pending_cert_id: asStr(row["pending_cert_id"]),
    replaced_cert_id: asStr(row["replaced_cert_id"]),
    encrypt_algo: algo,
    status,
    tencent_status: asInt(row["tencent_status"], -1),
    status_name: asStr(row["status_name"]),
    dv_auth_domain: asStr(row["dv_auth_domain"]),
    dv_auth_sub_domain: asStr(row["dv_auth_sub_domain"]),
    dv_auth_type: asStr(row["dv_auth_type"]),
    dv_auth_value: asStr(row["dv_auth_value"]),
    dns_record_id: asStr(row["dns_record_id"]),
    dns_record_written: asBool(row["dns_record_written"]),
    cert_begin_time: asStr(row["cert_begin_time"]),
    cert_end_time: asStr(row["cert_end_time"]),
    cert_end_ts: asInt(row["cert_end_ts"]),
    auto_renew: asBool(row["auto_renew"]),
    renew_before_days: Math.max(1, asInt(row["renew_before_days"], 7)),
    clean_dns_after_issue: asBool(row["clean_dns_after_issue"]),
    last_error: asStr(row["last_error"]),
    last_checked_at: asInt(row["last_checked_at"]),
    last_renew_at: asInt(row["last_renew_at"]),
    remark: asStr(row["remark"]),
    created_at: asInt(row["created_at"]),
    updated_at: asInt(row["updated_at"]),
  };
  if (decryptSecret && secretKeyEnc) {
    out.tencent_secret_key = await decrypt(secretKeyEnc, env.ENCRYPTION_KEY);
  }
  return out;
}

export async function listSslCertificates(
  env: Env,
  decryptSecret = false,
): Promise<SslCertificateRecord[]> {
  const rows = await query<Row>(
    env.DB,
    "SELECT * FROM ssl_certificates ORDER BY id DESC",
  );
  const out: SslCertificateRecord[] = [];
  for (const row of rows) {
    out.push(await normalizeSslCertRow(env, row, decryptSecret));
  }
  return out;
}

export async function getSslCertificate(
  env: Env,
  id: number,
  decryptSecret = false,
): Promise<SslCertificateRecord | null> {
  const row = await queryOne<Row>(
    env.DB,
    "SELECT * FROM ssl_certificates WHERE id=?",
    [id],
  );
  if (!row) return null;
  return normalizeSslCertRow(env, row, decryptSecret);
}

export async function getSslCertificateByCertId(
  env: Env,
  certId: string,
  decryptSecret = false,
): Promise<SslCertificateRecord | null> {
  const row = await queryOne<Row>(
    env.DB,
    "SELECT * FROM ssl_certificates WHERE cert_id=? OR pending_cert_id=? LIMIT 1",
    [certId, certId],
  );
  if (!row) return null;
  return normalizeSslCertRow(env, row, decryptSecret);
}

export async function createSslCertificate(
  env: Env,
  input: SslCertificateCreateInput,
): Promise<number> {
  const now = nowSeconds();
  const secretKeyEnc = input.tencent_secret_key?.trim()
    ? await encrypt(input.tencent_secret_key.trim(), env.ENCRYPTION_KEY)
    : "";
  const res = await execute(
    env.DB,
    `INSERT INTO ssl_certificates (
      domain, tencent_account_id, tencent_secret_id, tencent_secret_key,
      dns_verify_mode, dns_account_id, dns_root_domain, dns_zone_id,
      cert_id, pending_cert_id, replaced_cert_id, encrypt_algo, status, tencent_status, status_name,
      dv_auth_domain, dv_auth_sub_domain, dv_auth_type, dv_auth_value,
      dns_record_id, dns_record_written, cert_begin_time, cert_end_time, cert_end_ts,
      auto_renew, renew_before_days, clean_dns_after_issue,
      last_error, last_checked_at, last_renew_at, remark, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?
    )`,
    [
      input.domain.trim().toLowerCase(),
      input.tencent_account_id ?? 0,
      (input.tencent_secret_id ?? "").trim(),
      secretKeyEnc,
      input.dns_verify_mode ?? "dns_account",
      input.dns_account_id ?? 0,
      (input.dns_root_domain ?? "").trim().toLowerCase(),
      (input.dns_zone_id ?? "").trim(),
      (input.cert_id ?? "").trim(),
      (input.pending_cert_id ?? "").trim(),
      (input.replaced_cert_id ?? "").trim(),
      input.encrypt_algo === "ECC" ? "ECC" : "RSA",
      input.status ?? "pending_dns",
      input.tencent_status ?? -1,
      (input.status_name ?? "").trim(),
      (input.dv_auth_domain ?? "").trim(),
      (input.dv_auth_sub_domain ?? "").trim(),
      (input.dv_auth_type ?? "").trim(),
      (input.dv_auth_value ?? "").trim(),
      (input.dns_record_id ?? "").trim(),
      input.dns_record_written ? 1 : 0,
      (input.cert_begin_time ?? "").trim(),
      (input.cert_end_time ?? "").trim(),
      input.cert_end_ts ?? 0,
      input.auto_renew === false ? 0 : 1,
      Math.max(1, Math.min(30, input.renew_before_days ?? 7)),
      input.clean_dns_after_issue === false ? 0 : 1,
      (input.last_error ?? "").trim(),
      input.last_checked_at ?? 0,
      input.last_renew_at ?? 0,
      (input.remark ?? "").trim(),
      now,
      now,
    ],
  );
  return res.lastInsertRowId;
}

export async function updateSslCertificate(
  env: Env,
  id: number,
  patch: Partial<SslCertificateCreateInput>,
): Promise<void> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const add = (col: string, val: string | number | null) => {
    sets.push(`${col}=?`);
    params.push(val);
  };
  if (patch.domain !== undefined) add("domain", patch.domain.trim().toLowerCase());
  if (patch.tencent_account_id !== undefined) add("tencent_account_id", patch.tencent_account_id);
  if (patch.tencent_secret_id !== undefined) add("tencent_secret_id", patch.tencent_secret_id.trim());
  if (patch.tencent_secret_key !== undefined && patch.tencent_secret_key.trim()) {
    add("tencent_secret_key", await encrypt(patch.tencent_secret_key.trim(), env.ENCRYPTION_KEY));
  }
  if (patch.dns_verify_mode !== undefined) add("dns_verify_mode", patch.dns_verify_mode);
  if (patch.dns_account_id !== undefined) add("dns_account_id", patch.dns_account_id);
  if (patch.dns_root_domain !== undefined) add("dns_root_domain", patch.dns_root_domain.trim().toLowerCase());
  if (patch.dns_zone_id !== undefined) add("dns_zone_id", patch.dns_zone_id.trim());
  if (patch.cert_id !== undefined) add("cert_id", patch.cert_id.trim());
  if (patch.pending_cert_id !== undefined) add("pending_cert_id", patch.pending_cert_id.trim());
  if (patch.replaced_cert_id !== undefined) add("replaced_cert_id", patch.replaced_cert_id.trim());
  if (patch.encrypt_algo !== undefined) add("encrypt_algo", patch.encrypt_algo === "ECC" ? "ECC" : "RSA");
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.tencent_status !== undefined) add("tencent_status", patch.tencent_status);
  if (patch.status_name !== undefined) add("status_name", patch.status_name);
  if (patch.dv_auth_domain !== undefined) add("dv_auth_domain", patch.dv_auth_domain);
  if (patch.dv_auth_sub_domain !== undefined) add("dv_auth_sub_domain", patch.dv_auth_sub_domain);
  if (patch.dv_auth_type !== undefined) add("dv_auth_type", patch.dv_auth_type);
  if (patch.dv_auth_value !== undefined) add("dv_auth_value", patch.dv_auth_value);
  if (patch.dns_record_id !== undefined) add("dns_record_id", patch.dns_record_id);
  if (patch.dns_record_written !== undefined) add("dns_record_written", patch.dns_record_written ? 1 : 0);
  if (patch.cert_begin_time !== undefined) add("cert_begin_time", patch.cert_begin_time);
  if (patch.cert_end_time !== undefined) add("cert_end_time", patch.cert_end_time);
  if (patch.cert_end_ts !== undefined) add("cert_end_ts", patch.cert_end_ts);
  if (patch.auto_renew !== undefined) add("auto_renew", patch.auto_renew ? 1 : 0);
  if (patch.renew_before_days !== undefined) {
    add("renew_before_days", Math.max(1, Math.min(30, patch.renew_before_days)));
  }
  if (patch.clean_dns_after_issue !== undefined) {
    add("clean_dns_after_issue", patch.clean_dns_after_issue ? 1 : 0);
  }
  if (patch.last_error !== undefined) add("last_error", patch.last_error);
  if (patch.last_checked_at !== undefined) add("last_checked_at", patch.last_checked_at);
  if (patch.last_renew_at !== undefined) add("last_renew_at", patch.last_renew_at);
  if (patch.remark !== undefined) add("remark", patch.remark.trim());

  if (sets.length === 0) return;
  add("updated_at", nowSeconds());
  params.push(id);
  await execute(env.DB, `UPDATE ssl_certificates SET ${sets.join(", ")} WHERE id=?`, params);
}

export async function deleteSslCertificate(env: Env, id: number): Promise<void> {
  await execute(env.DB, "DELETE FROM edgeone_cert_bindings WHERE ssl_cert_id=?", [id]);
  await execute(env.DB, "DELETE FROM nps_cert_bindings WHERE ssl_cert_id=?", [id]);
  await execute(env.DB, "DELETE FROM ssl_certificates WHERE id=?", [id]);
}

// ---------------------------------------------------------------------------
// Tencent Cloud EdgeOne (TEO) SSL Auto-Sync Bindings
// ---------------------------------------------------------------------------

export type EdgeOneSite = "cn" | "intl";

export interface EdgeOneCertBindingRecord {
  id: number;
  ssl_cert_id: number;
  tencent_account_id: number;
  site: EdgeOneSite;
  zone_id: string;
  zone_name: string;
  domain: string;
  last_deployed_cert_id: string;
  last_deployed_at: number;
  last_error: string;
  created_at: number;
  updated_at: number;
}

function normalizeEdgeOneBindingRow(row: Row): EdgeOneCertBindingRecord {
  const siteRaw = asStr(row["site"]).toLowerCase();
  return {
    id: asInt(row["id"]),
    ssl_cert_id: asInt(row["ssl_cert_id"]),
    tencent_account_id: asInt(row["tencent_account_id"]),
    site: siteRaw === "intl" ? "intl" : "cn",
    zone_id: asStr(row["zone_id"]),
    zone_name: asStr(row["zone_name"]),
    domain: asStr(row["domain"]),
    last_deployed_cert_id: asStr(row["last_deployed_cert_id"]),
    last_deployed_at: asInt(row["last_deployed_at"]),
    last_error: asStr(row["last_error"]),
    created_at: asInt(row["created_at"]),
    updated_at: asInt(row["updated_at"]),
  };
}

export async function listEdgeOneCertBindings(
  env: Env,
  filter?: { tencentAccountId?: number; site?: EdgeOneSite; zoneId?: string },
): Promise<EdgeOneCertBindingRecord[]> {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter?.tencentAccountId) {
    clauses.push("tencent_account_id=?");
    params.push(filter.tencentAccountId);
  }
  if (filter?.site) {
    clauses.push("site=?");
    params.push(filter.site);
  }
  if (filter?.zoneId) {
    clauses.push("zone_id=?");
    params.push(filter.zoneId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await query<Row>(
    env.DB,
    `SELECT * FROM edgeone_cert_bindings ${where} ORDER BY id DESC`,
    params,
  );
  return rows.map(normalizeEdgeOneBindingRow);
}

export async function listEdgeOneBindingsBySslCert(
  env: Env,
  sslCertId: number,
): Promise<EdgeOneCertBindingRecord[]> {
  const rows = await query<Row>(
    env.DB,
    "SELECT * FROM edgeone_cert_bindings WHERE ssl_cert_id=? ORDER BY id ASC",
    [sslCertId],
  );
  return rows.map(normalizeEdgeOneBindingRow);
}

export async function getEdgeOneCertBinding(
  env: Env,
  id: number,
): Promise<EdgeOneCertBindingRecord | null> {
  const row = await queryOne<Row>(env.DB, "SELECT * FROM edgeone_cert_bindings WHERE id=?", [id]);
  return row ? normalizeEdgeOneBindingRow(row) : null;
}

export async function upsertEdgeOneCertBinding(
  env: Env,
  input: {
    ssl_cert_id: number;
    tencent_account_id: number;
    site: EdgeOneSite;
    zone_id: string;
    zone_name?: string;
    domain: string;
    last_deployed_cert_id?: string;
    last_deployed_at?: number;
    last_error?: string;
  },
): Promise<EdgeOneCertBindingRecord> {
  const now = nowSeconds();
  const site: EdgeOneSite = input.site === "intl" ? "intl" : "cn";
  const domain = input.domain.trim().toLowerCase();
  const zoneId = input.zone_id.trim();
  const zoneName = (input.zone_name ?? "").trim();
  const deployedCertId = (input.last_deployed_cert_id ?? "").trim();
  const deployedAt = input.last_deployed_at ?? 0;
  const lastError = input.last_error ?? "";

  await execute(
    env.DB,
    `INSERT INTO edgeone_cert_bindings
       (ssl_cert_id, tencent_account_id, site, zone_id, zone_name, domain,
        last_deployed_cert_id, last_deployed_at, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tencent_account_id, site, zone_id, domain) DO UPDATE SET
       ssl_cert_id=excluded.ssl_cert_id,
       zone_name=CASE WHEN excluded.zone_name != '' THEN excluded.zone_name ELSE edgeone_cert_bindings.zone_name END,
       last_deployed_cert_id=excluded.last_deployed_cert_id,
       last_deployed_at=excluded.last_deployed_at,
       last_error=excluded.last_error,
       updated_at=excluded.updated_at`,
    [
      input.ssl_cert_id,
      input.tencent_account_id,
      site,
      zoneId,
      zoneName,
      domain,
      deployedCertId,
      deployedAt,
      lastError,
      now,
      now,
    ],
  );
  const row = await queryOne<Row>(
    env.DB,
    "SELECT * FROM edgeone_cert_bindings WHERE tencent_account_id=? AND site=? AND zone_id=? AND domain=?",
    [input.tencent_account_id, site, zoneId, domain],
  );
  return normalizeEdgeOneBindingRow(row!);
}

export async function updateEdgeOneCertBindingStatus(
  env: Env,
  id: number,
  patch: { last_deployed_cert_id?: string; last_deployed_at?: number; last_error?: string },
): Promise<void> {
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (patch.last_deployed_cert_id !== undefined) {
    sets.push("last_deployed_cert_id=?");
    params.push(patch.last_deployed_cert_id.trim());
  }
  if (patch.last_deployed_at !== undefined) {
    sets.push("last_deployed_at=?");
    params.push(patch.last_deployed_at);
  }
  if (patch.last_error !== undefined) {
    sets.push("last_error=?");
    params.push(patch.last_error);
  }
  if (sets.length === 0) return;
  sets.push("updated_at=?");
  params.push(nowSeconds(), id);
  await execute(
    env.DB,
    `UPDATE edgeone_cert_bindings SET ${sets.join(", ")} WHERE id=?`,
    params,
  );
}

export async function deleteEdgeOneCertBinding(env: Env, id: number): Promise<void> {
  await execute(env.DB, "DELETE FROM edgeone_cert_bindings WHERE id=?", [id]);
}

export async function deleteEdgeOneCertBindingByHost(
  env: Env,
  tencentAccountId: number,
  site: EdgeOneSite,
  zoneId: string,
  domain: string,
): Promise<void> {
  await execute(
    env.DB,
    "DELETE FROM edgeone_cert_bindings WHERE tencent_account_id=? AND site=? AND zone_id=? AND domain=?",
    [tencentAccountId, site, zoneId.trim(), domain.trim().toLowerCase()],
  );
}

// ---------------------------------------------------------------------------
// NPS (https://github.com/yisier/nps) Servers & SSL Auto-Sync Bindings
// ---------------------------------------------------------------------------

export type NpsAuthMode = "auth_key" | "web_login";

export interface NpsServerRecord {
  id: number;
  label: string;
  base_url: string;
  auth_mode: NpsAuthMode;
  auth_key: string;
  username: string;
  password: string;
  remark: string;
  created_at: number;
  updated_at: number;
}

export interface NpsServerInput {
  label: string;
  base_url: string;
  auth_mode?: NpsAuthMode;
  auth_key?: string;
  username?: string;
  password?: string;
  remark?: string;
}

async function normalizeNpsServerRow(
  env: Env,
  row: Row,
  decryptSecrets: boolean,
): Promise<NpsServerRecord> {
  const modeRaw = asStr(row["auth_mode"]).toLowerCase();
  const authMode: NpsAuthMode = modeRaw === "web_login" ? "web_login" : "auth_key";
  const rawAuthKey = asStr(row["auth_key"]);
  const rawPassword = asStr(row["password"]);
  let authKey = rawAuthKey;
  let password = rawPassword;
  if (decryptSecrets) {
    if (rawAuthKey) authKey = await decrypt(rawAuthKey, env.ENCRYPTION_KEY);
    if (rawPassword) password = await decrypt(rawPassword, env.ENCRYPTION_KEY);
  }
  return {
    id: asInt(row["id"]),
    label: asStr(row["label"]),
    base_url: asStr(row["base_url"]),
    auth_mode: authMode,
    auth_key: authKey,
    username: asStr(row["username"]),
    password,
    remark: asStr(row["remark"]),
    created_at: asInt(row["created_at"]),
    updated_at: asInt(row["updated_at"]),
  };
}

export async function listNpsServers(
  env: Env,
  opts?: { decryptSecrets?: boolean },
): Promise<NpsServerRecord[]> {
  const rows = await query<Row>(env.DB, "SELECT * FROM nps_servers ORDER BY id ASC");
  const out: NpsServerRecord[] = [];
  for (const row of rows) {
    out.push(await normalizeNpsServerRow(env, row, Boolean(opts?.decryptSecrets)));
  }
  return out;
}

export async function getNpsServer(
  env: Env,
  id: number,
  decryptSecrets = false,
): Promise<NpsServerRecord | null> {
  const row = await queryOne<Row>(env.DB, "SELECT * FROM nps_servers WHERE id=?", [id]);
  if (!row) return null;
  return normalizeNpsServerRow(env, row, decryptSecrets);
}

export async function createNpsServer(env: Env, input: NpsServerInput): Promise<number> {
  const now = nowSeconds();
  const authMode: NpsAuthMode = input.auth_mode === "web_login" ? "web_login" : "auth_key";
  const cleanKey = (input.auth_key ?? "").trim();
  const cleanPass = (input.password ?? "").trim();
  const encKey = cleanKey ? await encrypt(cleanKey, env.ENCRYPTION_KEY) : "";
  const encPass = cleanPass ? await encrypt(cleanPass, env.ENCRYPTION_KEY) : "";
  const res = await execute(
    env.DB,
    `INSERT INTO nps_servers
       (label, base_url, auth_mode, auth_key, username, password, remark, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.label.trim(),
      input.base_url.trim().replace(/\/+$/, ""),
      authMode,
      encKey,
      (input.username ?? "").trim(),
      encPass,
      (input.remark ?? "").trim(),
      now,
      now,
    ],
  );
  return res.lastInsertRowId;
}

export async function updateNpsServer(
  env: Env,
  id: number,
  input: Partial<NpsServerInput>,
): Promise<void> {
  const existing = await queryOne<Row>(env.DB, "SELECT * FROM nps_servers WHERE id=?", [id]);
  if (!existing) throw new Error("NPS 服务器不存在");
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (input.label !== undefined) {
    sets.push("label=?");
    params.push(input.label.trim());
  }
  if (input.base_url !== undefined) {
    sets.push("base_url=?");
    params.push(input.base_url.trim().replace(/\/+$/, ""));
  }
  if (input.auth_mode !== undefined) {
    sets.push("auth_mode=?");
    params.push(input.auth_mode === "web_login" ? "web_login" : "auth_key");
  }
  if (input.auth_key !== undefined && input.auth_key.trim() !== "") {
    sets.push("auth_key=?");
    params.push(await encrypt(input.auth_key.trim(), env.ENCRYPTION_KEY));
  }
  if (input.username !== undefined) {
    sets.push("username=?");
    params.push(input.username.trim());
  }
  if (input.password !== undefined && input.password.trim() !== "") {
    sets.push("password=?");
    params.push(await encrypt(input.password.trim(), env.ENCRYPTION_KEY));
  }
  if (input.remark !== undefined) {
    sets.push("remark=?");
    params.push(input.remark.trim());
  }
  if (sets.length === 0) return;
  sets.push("updated_at=?");
  params.push(nowSeconds(), id);
  await execute(env.DB, `UPDATE nps_servers SET ${sets.join(", ")} WHERE id=?`, params);
}

export async function deleteNpsServer(env: Env, id: number): Promise<void> {
  await execute(env.DB, "DELETE FROM nps_cert_bindings WHERE nps_server_id=?", [id]);
  await execute(env.DB, "DELETE FROM nps_servers WHERE id=?", [id]);
}

export interface NpsCertBindingRecord {
  id: number;
  ssl_cert_id: number;
  nps_server_id: number;
  nps_host_id: number;
  nps_client_id: number;
  domain: string;
  sync_cdn: boolean;
  last_deployed_cert_id: string;
  last_deployed_at: number;
  last_error: string;
  created_at: number;
  updated_at: number;
}

function normalizeNpsBindingRow(row: Row): NpsCertBindingRecord {
  return {
    id: asInt(row["id"]),
    ssl_cert_id: asInt(row["ssl_cert_id"]),
    nps_server_id: asInt(row["nps_server_id"]),
    nps_host_id: asInt(row["nps_host_id"]),
    nps_client_id: asInt(row["nps_client_id"]),
    domain: asStr(row["domain"]),
    sync_cdn: asBool(row["sync_cdn"]),
    last_deployed_cert_id: asStr(row["last_deployed_cert_id"]),
    last_deployed_at: asInt(row["last_deployed_at"]),
    last_error: asStr(row["last_error"]),
    created_at: asInt(row["created_at"]),
    updated_at: asInt(row["updated_at"]),
  };
}

export async function listNpsCertBindings(
  env: Env,
  filter?: { npsServerId?: number; domain?: string },
): Promise<NpsCertBindingRecord[]> {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter?.npsServerId) {
    clauses.push("nps_server_id=?");
    params.push(filter.npsServerId);
  }
  if (filter?.domain) {
    clauses.push("domain=?");
    params.push(filter.domain.trim().toLowerCase());
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await query<Row>(
    env.DB,
    `SELECT * FROM nps_cert_bindings ${where} ORDER BY id DESC`,
    params,
  );
  return rows.map(normalizeNpsBindingRow);
}

export async function listNpsBindingsBySslCert(
  env: Env,
  sslCertId: number,
): Promise<NpsCertBindingRecord[]> {
  const rows = await query<Row>(
    env.DB,
    "SELECT * FROM nps_cert_bindings WHERE ssl_cert_id=? ORDER BY id ASC",
    [sslCertId],
  );
  return rows.map(normalizeNpsBindingRow);
}

export async function getNpsCertBinding(
  env: Env,
  id: number,
): Promise<NpsCertBindingRecord | null> {
  const row = await queryOne<Row>(env.DB, "SELECT * FROM nps_cert_bindings WHERE id=?", [id]);
  return row ? normalizeNpsBindingRow(row) : null;
}

export async function getNpsCertBindingByHost(
  env: Env,
  npsServerId: number,
  npsHostId: number,
): Promise<NpsCertBindingRecord | null> {
  const row = await queryOne<Row>(
    env.DB,
    "SELECT * FROM nps_cert_bindings WHERE nps_server_id=? AND nps_host_id=?",
    [npsServerId, npsHostId],
  );
  return row ? normalizeNpsBindingRow(row) : null;
}

export async function upsertNpsCertBinding(
  env: Env,
  input: {
    ssl_cert_id: number;
    nps_server_id: number;
    nps_host_id: number;
    nps_client_id?: number;
    domain: string;
    sync_cdn?: boolean;
    last_deployed_cert_id?: string;
    last_deployed_at?: number;
    last_error?: string;
  },
): Promise<NpsCertBindingRecord> {
  const now = nowSeconds();
  const domain = input.domain.trim().toLowerCase();
  const clientId = Math.max(0, Math.trunc(input.nps_client_id ?? 0));
  const syncCdn = input.sync_cdn === false ? 0 : 1;
  const deployedCertId = (input.last_deployed_cert_id ?? "").trim();
  const deployedAt = input.last_deployed_at ?? 0;
  const lastError = input.last_error ?? "";

  await execute(
    env.DB,
    `INSERT INTO nps_cert_bindings
       (ssl_cert_id, nps_server_id, nps_host_id, nps_client_id, domain, sync_cdn,
        last_deployed_cert_id, last_deployed_at, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(nps_server_id, nps_host_id) DO UPDATE SET
       ssl_cert_id=excluded.ssl_cert_id,
       nps_client_id=CASE WHEN excluded.nps_client_id > 0 THEN excluded.nps_client_id ELSE nps_cert_bindings.nps_client_id END,
       domain=excluded.domain,
       sync_cdn=excluded.sync_cdn,
       last_deployed_cert_id=excluded.last_deployed_cert_id,
       last_deployed_at=excluded.last_deployed_at,
       last_error=excluded.last_error,
       updated_at=excluded.updated_at`,
    [
      input.ssl_cert_id,
      input.nps_server_id,
      input.nps_host_id,
      clientId,
      domain,
      syncCdn,
      deployedCertId,
      deployedAt,
      lastError,
      now,
      now,
    ],
  );
  const row = await queryOne<Row>(
    env.DB,
    "SELECT * FROM nps_cert_bindings WHERE nps_server_id=? AND nps_host_id=?",
    [input.nps_server_id, input.nps_host_id],
  );
  return normalizeNpsBindingRow(row!);
}

export async function updateNpsCertBindingStatus(
  env: Env,
  id: number,
  patch: {
    domain?: string;
    nps_client_id?: number;
    sync_cdn?: boolean;
    last_deployed_cert_id?: string;
    last_deployed_at?: number;
    last_error?: string;
  },
): Promise<void> {
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (patch.domain !== undefined) {
    sets.push("domain=?");
    params.push(patch.domain.trim().toLowerCase());
  }
  if (patch.nps_client_id !== undefined) {
    sets.push("nps_client_id=?");
    params.push(Math.max(0, Math.trunc(patch.nps_client_id)));
  }
  if (patch.sync_cdn !== undefined) {
    sets.push("sync_cdn=?");
    params.push(patch.sync_cdn ? 1 : 0);
  }
  if (patch.last_deployed_cert_id !== undefined) {
    sets.push("last_deployed_cert_id=?");
    params.push(patch.last_deployed_cert_id.trim());
  }
  if (patch.last_deployed_at !== undefined) {
    sets.push("last_deployed_at=?");
    params.push(patch.last_deployed_at);
  }
  if (patch.last_error !== undefined) {
    sets.push("last_error=?");
    params.push(patch.last_error);
  }
  if (sets.length === 0) return;
  sets.push("updated_at=?");
  params.push(nowSeconds(), id);
  await execute(env.DB, `UPDATE nps_cert_bindings SET ${sets.join(", ")} WHERE id=?`, params);
}

export async function deleteNpsCertBinding(env: Env, id: number): Promise<void> {
  await execute(env.DB, "DELETE FROM nps_cert_bindings WHERE id=?", [id]);
}

export async function deleteNpsCertBindingByHost(
  env: Env,
  npsServerId: number,
  npsHostId: number,
): Promise<void> {
  await execute(
    env.DB,
    "DELETE FROM nps_cert_bindings WHERE nps_server_id=? AND nps_host_id=?",
    [npsServerId, npsHostId],
  );
}

