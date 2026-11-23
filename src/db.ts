// D1 storage layer — port of app/db.py's query helpers.
// Python used a per-thread sqlite3 connection with WAL; in Workers every
// query goes through the bound D1Database with `?` placeholders and bind().
// All timestamps are Unix seconds (number), matching the Python code.
// The schema itself lives in migrations/0001_schema.sql (consolidated from
// db.py SCHEMA plus its _migrate() ALTER additions).

import type { Env } from "./env";
import { generateEncryptionKey, generateSessionSecret } from "./security";
import { DEFAULT_SETTINGS } from "./settings";

export type SqlParam = string | number | null | ArrayBuffer | Uint8Array;

export interface ExecuteResult {
  changes: number;
  lastInsertRowId: number;
}

const REQUIRED_TABLES = [
  "settings",
  "servers",
  "swas_servers",
  "keepalives",
  "shift_groups",
  "shift_members",
  "shift_runs",
  "dns_records",
  "dns_accounts",
  "ssl_certificates",
  "edgeone_cert_bindings",
  "events",
  "flags",
  "revoked_sessions",
  "traffic_samples",
] as const;

// Consolidated DDL matching migrations/0001_schema.sql .. 0006_edgeone_cdn.sql so a
// freshly auto-provisioned or upgraded D1 database works without manual SQL setup.
const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS servers (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    label               TEXT    NOT NULL,
    access_key_id       TEXT    NOT NULL,
    access_key_secret   TEXT    NOT NULL,
    region_id           TEXT    NOT NULL,
    site                TEXT    NOT NULL DEFAULT 'china',
    instance_id         TEXT    NOT NULL,
    quota_gb            REAL    NOT NULL DEFAULT 200,
    threshold_gb        REAL    NOT NULL DEFAULT 188,
    remark              TEXT    NOT NULL DEFAULT '',
    traffic_used        REAL,
    instance_status     TEXT    NOT NULL DEFAULT '',
    stop_mode           TEXT    NOT NULL DEFAULT 'StopCharging',
    stopped_mode        TEXT    NOT NULL DEFAULT '',
    public_ip           TEXT    NOT NULL DEFAULT '',
    traffic_checked_at  INTEGER NOT NULL DEFAULT 0,
    status_checked_at   INTEGER NOT NULL DEFAULT 0,
    monthly_cost        REAL,
    balance_amount      REAL,
    billing_currency    TEXT    NOT NULL DEFAULT '',
    billing_cycle       TEXT    NOT NULL DEFAULT '',
    billing_updated_at  INTEGER NOT NULL DEFAULT 0,
    billing_error       TEXT    NOT NULL DEFAULT '',
    created_at          INTEGER NOT NULL DEFAULT 0,
    sort_order          INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS swas_servers (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    provider            TEXT    NOT NULL DEFAULT 'aliyun',
    label               TEXT    NOT NULL,
    access_key_id       TEXT    NOT NULL,
    access_key_secret   TEXT    NOT NULL,
    region_id           TEXT    NOT NULL,
    site                TEXT    NOT NULL DEFAULT 'china',
    instance_id         TEXT    NOT NULL,
    remark              TEXT    NOT NULL DEFAULT '',
    instance_status     TEXT    NOT NULL DEFAULT '',
    public_ip           TEXT    NOT NULL DEFAULT '',
    inner_ip            TEXT    NOT NULL DEFAULT '',
    plan_id             TEXT    NOT NULL DEFAULT '',
    plan_type           TEXT    NOT NULL DEFAULT '',
    cpu                 INTEGER NOT NULL DEFAULT 0,
    memory_gb           REAL    NOT NULL DEFAULT 0,
    disk_size_gb        INTEGER NOT NULL DEFAULT 0,
    bandwidth_mbps      INTEGER NOT NULL DEFAULT 0,
    image_name          TEXT    NOT NULL DEFAULT '',
    os_type             TEXT    NOT NULL DEFAULT '',
    expired_time        TEXT    NOT NULL DEFAULT '',
    business_status     TEXT    NOT NULL DEFAULT '',
    traffic_used_gb     REAL,
    traffic_total_gb    REAL,
    traffic_overflow_gb REAL,
    status_checked_at   INTEGER NOT NULL DEFAULT 0,
    traffic_checked_at  INTEGER NOT NULL DEFAULT 0,
    monthly_cost        REAL,
    balance_amount      REAL,
    billing_currency    TEXT    NOT NULL DEFAULT '',
    billing_cycle       TEXT    NOT NULL DEFAULT '',
    billing_updated_at  INTEGER NOT NULL DEFAULT 0,
    billing_error       TEXT    NOT NULL DEFAULT '',
    created_at          INTEGER NOT NULL DEFAULT 0,
    sort_order          INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS keepalives (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id  INTEGER NOT NULL UNIQUE,
    enabled    INTEGER NOT NULL DEFAULT 1,
    start_time TEXT    NOT NULL DEFAULT '',
    end_time   TEXT    NOT NULL DEFAULT '',
    start_day  INTEGER NOT NULL DEFAULT 0,
    end_day    INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS shift_groups (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT    NOT NULL,
    enabled           INTEGER NOT NULL DEFAULT 1,
    failover_enabled  INTEGER NOT NULL DEFAULT 1,
    ddns_record       TEXT    NOT NULL DEFAULT '',
    anchor_at         INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL DEFAULT 0,
    cycle             TEXT    NOT NULL DEFAULT 'day'
  )`,
  `CREATE TABLE IF NOT EXISTS shift_members (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   INTEGER NOT NULL,
    server_id  INTEGER NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    hours      REAL    NOT NULL DEFAULT 12,
    enabled    INTEGER NOT NULL DEFAULT 1,
    slot_name  TEXT    NOT NULL DEFAULT '',
    start_time TEXT    NOT NULL DEFAULT '',
    end_time   TEXT    NOT NULL DEFAULT '',
    days       INTEGER NOT NULL DEFAULT 0,
    UNIQUE(group_id, position)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_members_group ON shift_members(group_id, position)`,
  `CREATE TABLE IF NOT EXISTS shift_runs (
    group_id            INTEGER NOT NULL,
    slot                TEXT    NOT NULL,
    phase               TEXT    NOT NULL DEFAULT 'pending',
    stage               TEXT    NOT NULL DEFAULT '',
    event_id            INTEGER NOT NULL DEFAULT 0,
    duty_server_id      INTEGER NOT NULL DEFAULT 0,
    standby_server_ids  TEXT    NOT NULL DEFAULT '',
    failover            INTEGER NOT NULL DEFAULT 0,
    failover_reason     TEXT    NOT NULL DEFAULT '',
    failover_from       INTEGER NOT NULL DEFAULT 0,
    duty_day            TEXT    NOT NULL DEFAULT '',
    manual              INTEGER NOT NULL DEFAULT 0,
    origin              TEXT    NOT NULL DEFAULT '',
    dns_before          TEXT    NOT NULL DEFAULT '',
    attempts            INTEGER NOT NULL DEFAULT 0,
    started_at          INTEGER NOT NULL DEFAULT 0,
    updated_at          INTEGER NOT NULL DEFAULT 0,
    note                TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (group_id, slot)
  )`,
  `CREATE TABLE IF NOT EXISTS dns_records (
    record      TEXT    PRIMARY KEY,
    target_kind TEXT    NOT NULL DEFAULT '',
    target_id   INTEGER NOT NULL DEFAULT 0,
    last_ip     TEXT    NOT NULL DEFAULT '',
    last_status TEXT    NOT NULL DEFAULT '',
    last_at     INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dns_target_lookup ON dns_records(target_kind, target_id) WHERE target_kind <> ''`,
  `CREATE TABLE IF NOT EXISTS events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ts             INTEGER NOT NULL DEFAULT 0,
    level          TEXT    NOT NULL DEFAULT 'info',
    kind           TEXT    NOT NULL DEFAULT '',
    group_id       INTEGER NOT NULL DEFAULT 0,
    server_id      INTEGER NOT NULL DEFAULT 0,
    title          TEXT    NOT NULL DEFAULT '',
    detail         TEXT    NOT NULL DEFAULT '',
    status         TEXT    NOT NULL DEFAULT 'done',
    progress       TEXT    NOT NULL DEFAULT '',
    finished_at    INTEGER NOT NULL DEFAULT 0,
    pending_status TEXT    NOT NULL DEFAULT '',
    pending_kind   TEXT    NOT NULL DEFAULT '',
    pending_ts     INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC)`,
  `CREATE TABLE IF NOT EXISTS flags (
    key        TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL DEFAULT 0,
    value      INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS revoked_sessions (
    token_id   TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_revoked_exp ON revoked_sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS traffic_samples (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id  INTEGER NOT NULL,
    ts         INTEGER NOT NULL DEFAULT 0,
    used       REAL    NOT NULL DEFAULT 0,
    status     TEXT    NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_samples_server_ts ON traffic_samples(server_id, ts DESC)`,
  `CREATE TABLE IF NOT EXISTS dns_accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    provider    TEXT    NOT NULL,
    label       TEXT    NOT NULL,
    auth_mode   TEXT    NOT NULL DEFAULT 'cam',
    cred_id     TEXT    NOT NULL DEFAULT '',
    cred_secret TEXT    NOT NULL,
    remark      TEXT    NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dns_accounts_provider ON dns_accounts(provider, id)`,
  `CREATE TABLE IF NOT EXISTS ssl_certificates (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    domain                TEXT    NOT NULL,
    tencent_account_id    INTEGER NOT NULL DEFAULT 0,
    tencent_secret_id     TEXT    NOT NULL DEFAULT '',
    tencent_secret_key    TEXT    NOT NULL DEFAULT '',
    dns_verify_mode       TEXT    NOT NULL DEFAULT 'dns_account',
    dns_account_id        INTEGER NOT NULL DEFAULT 0,
    dns_root_domain       TEXT    NOT NULL DEFAULT '',
    dns_zone_id           TEXT    NOT NULL DEFAULT '',
    cert_id               TEXT    NOT NULL DEFAULT '',
    pending_cert_id       TEXT    NOT NULL DEFAULT '',
    replaced_cert_id      TEXT    NOT NULL DEFAULT '',
    encrypt_algo          TEXT    NOT NULL DEFAULT 'RSA',
    status                TEXT    NOT NULL DEFAULT 'pending_dns',
    tencent_status        INTEGER NOT NULL DEFAULT -1,
    status_name           TEXT    NOT NULL DEFAULT '',
    dv_auth_domain        TEXT    NOT NULL DEFAULT '',
    dv_auth_sub_domain    TEXT    NOT NULL DEFAULT '',
    dv_auth_type          TEXT    NOT NULL DEFAULT '',
    dv_auth_value         TEXT    NOT NULL DEFAULT '',
    dns_record_id         TEXT    NOT NULL DEFAULT '',
    dns_record_written    INTEGER NOT NULL DEFAULT 0,
    cert_begin_time       TEXT    NOT NULL DEFAULT '',
    cert_end_time         TEXT    NOT NULL DEFAULT '',
    cert_end_ts           INTEGER NOT NULL DEFAULT 0,
    auto_renew            INTEGER NOT NULL DEFAULT 1,
    renew_before_days     INTEGER NOT NULL DEFAULT 7,
    clean_dns_after_issue INTEGER NOT NULL DEFAULT 1,
    last_error            TEXT    NOT NULL DEFAULT '',
    last_checked_at       INTEGER NOT NULL DEFAULT 0,
    last_renew_at         INTEGER NOT NULL DEFAULT 0,
    remark                TEXT    NOT NULL DEFAULT '',
    created_at            INTEGER NOT NULL DEFAULT 0,
    updated_at            INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ssl_certs_domain ON ssl_certificates(domain)`,
  `CREATE INDEX IF NOT EXISTS idx_ssl_certs_status ON ssl_certificates(status, cert_end_ts)`,
  `CREATE TABLE IF NOT EXISTS edgeone_cert_bindings (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    ssl_cert_id           INTEGER NOT NULL,
    tencent_account_id    INTEGER NOT NULL,
    site                  TEXT    NOT NULL DEFAULT 'cn',
    zone_id               TEXT    NOT NULL,
    zone_name             TEXT    NOT NULL DEFAULT '',
    domain                TEXT    NOT NULL,
    last_deployed_cert_id TEXT    NOT NULL DEFAULT '',
    last_deployed_at      INTEGER NOT NULL DEFAULT 0,
    last_error            TEXT    NOT NULL DEFAULT '',
    created_at            INTEGER NOT NULL DEFAULT 0,
    updated_at            INTEGER NOT NULL DEFAULT 0,
    UNIQUE(tencent_account_id, site, zone_id, domain)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_eo_bindings_ssl ON edgeone_cert_bindings(ssl_cert_id)`,
  `CREATE INDEX IF NOT EXISTS idx_eo_bindings_zone ON edgeone_cert_bindings(tencent_account_id, site, zone_id)`,
];

const TABLE_CHECK_SQL = `SELECT count(*) AS cnt FROM sqlite_master WHERE type='table' AND name IN (${REQUIRED_TABLES.map((t) => `'${t}'`).join(",")})`;

const AUTO_ENCRYPTION_KEY_ROW = "_internal_encryption_key";
const AUTO_SESSION_SECRET_ROW = "_internal_session_secret";

// Cache schema readiness per D1Database binding instance inside an isolate so
// steady-state requests incur zero extra SQL round-trips.
const schemaReadyCache = new WeakMap<D1Database, Promise<void>>();

interface AutoSecrets {
  encryptionKey: string;
  sessionSecret: string;
}

const autoSecretsCache = new WeakMap<D1Database, Promise<AutoSecrets>>();

/**
 * Ensure all application tables and default settings rows exist in D1.
 * Safe to call repeatedly: runs at most once per isolate when tables exist,
 * and atomically bootstraps an empty database on first access.
 */
export function ensureSchema(db: D1Database | undefined): Promise<void> {
  if (!db) {
    return Promise.reject(new Error("D1 binding 'DB' is not configured"));
  }
  const existing = schemaReadyCache.get(db);
  if (existing) return existing;

  const initPromise = (async () => {
    const check = await db.prepare(TABLE_CHECK_SQL).first<{ cnt?: number }>();
    if (Number(check?.cnt ?? 0) !== REQUIRED_TABLES.length) {
      const statements: D1PreparedStatement[] = SCHEMA_STATEMENTS.map((sql) =>
        db.prepare(sql),
      );
      for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        statements.push(
          db
            .prepare(
              "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO NOTHING",
            )
            .bind(key, value),
        );
      }
      await db.batch(statements);
    }

    // Idempotent column upgrades for pre-existing D1 databases.
    const swasCols = await db
      .prepare("PRAGMA table_info(swas_servers)")
      .all<{ name?: string }>();
    const hasProvider = (swasCols.results ?? []).some(
      (col) => col.name === "provider",
    );
    if (!hasProvider) {
      await db
        .prepare(
          "ALTER TABLE swas_servers ADD COLUMN provider TEXT NOT NULL DEFAULT 'aliyun'",
        )
        .run();
    }

    const sslCols = await db
      .prepare("PRAGMA table_info(ssl_certificates)")
      .all<{ name?: string }>();
    const hasReplacedCertId = (sslCols.results ?? []).some(
      (col) => col.name === "replaced_cert_id",
    );
    if (!hasReplacedCertId) {
      await db
        .prepare(
          "ALTER TABLE ssl_certificates ADD COLUMN replaced_cert_id TEXT NOT NULL DEFAULT ''",
        )
        .run();
    }
  })().catch((err) => {
    // Clear failed promise so a transient D1 error does not poison the isolate.
    schemaReadyCache.delete(db);
    throw err;
  });

  schemaReadyCache.set(db, initPromise);
  return initPromise;
}

function loadOrCreateAutoSecrets(db: D1Database): Promise<AutoSecrets> {
  const existing = autoSecretsCache.get(db);
  if (existing) return existing;

  const promise = (async () => {
    // Use INSERT ... ON CONFLICT DO NOTHING followed by SELECT so concurrent
    // cold starts across isolates always converge on the exact same key pair.
    await db.batch([
      db
        .prepare(
          "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO NOTHING",
        )
        .bind(AUTO_ENCRYPTION_KEY_ROW, generateEncryptionKey()),
      db
        .prepare(
          "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO NOTHING",
        )
        .bind(AUTO_SESSION_SECRET_ROW, generateSessionSecret()),
    ]);
    const rows = await query<{ key: string; value: string }>(
      db,
      "SELECT key, value FROM settings WHERE key IN (?, ?)",
      [AUTO_ENCRYPTION_KEY_ROW, AUTO_SESSION_SECRET_ROW],
    );
    let encryptionKey = "";
    let sessionSecret = "";
    for (const row of rows) {
      if (row.key === AUTO_ENCRYPTION_KEY_ROW) encryptionKey = row.value;
      else if (row.key === AUTO_SESSION_SECRET_ROW) sessionSecret = row.value;
    }
    if (!encryptionKey || !sessionSecret) {
      throw new Error("Failed to initialize runtime secrets in D1");
    }
    return { encryptionKey, sessionSecret };
  })().catch((err) => {
    autoSecretsCache.delete(db);
    throw err;
  });

  autoSecretsCache.set(db, promise);
  return promise;
}

/**
 * Ensure the D1 schema exists and resolve ENCRYPTION_KEY / SESSION_SECRET.
 * Explicit Worker Secrets always take precedence; when unset, runtime-random
 * keys are persisted once in D1 internal rows (filtered out of settings APIs).
 */
export async function resolveRuntimeEnv(env: Env): Promise<Env> {
  await ensureSchema(env.DB);
  const hasEnc = Boolean(env.ENCRYPTION_KEY?.trim());
  const hasSess = Boolean(env.SESSION_SECRET?.trim());
  if (hasEnc && hasSess) return env;

  const fallback = await loadOrCreateAutoSecrets(env.DB);
  const overrides: Partial<Pick<Env, "ENCRYPTION_KEY" | "SESSION_SECRET">> = {};
  if (!hasEnc) overrides.ENCRYPTION_KEY = fallback.encryptionKey;
  if (!hasSess) overrides.SESSION_SECRET = fallback.sessionSecret;

  // Proxy preserves all non-enumerable Cloudflare bindings without mutating env.
  return new Proxy(env, {
    get(target, prop) {
      if (prop === "ENCRYPTION_KEY" && overrides.ENCRYPTION_KEY !== undefined) {
        return overrides.ENCRYPTION_KEY;
      }
      if (prop === "SESSION_SECRET" && overrides.SESSION_SECRET !== undefined) {
        return overrides.SESSION_SECRET;
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function toPlainObject<T>(row: unknown): T {
  // D1 returns plain objects already; this normalises null rows and keeps
  // the conversion explicit at the single place rows leave D1.
  if (row === null || typeof row !== "object") return row as T;
  return { ...(row as Record<string, unknown>) } as T;
}

/** Run a SELECT and return all rows as plain objects. */
export async function query<T>(
  db: D1Database,
  sql: string,
  params: SqlParam[] = [],
): Promise<T[]> {
  const result = await db
    .prepare(sql)
    .bind(...params)
    .all();
  return (result.results ?? []).map((row) => toPlainObject<T>(row));
}

/** Run a SELECT and return the first row, or null. */
export async function queryOne<T>(
  db: D1Database,
  sql: string,
  params: SqlParam[] = [],
): Promise<T | null> {
  const result = await db
    .prepare(sql)
    .bind(...params)
    .first();
  if (result === null || result === undefined) return null;
  return toPlainObject<T>(result);
}

/** Run an INSERT/UPDATE/DELETE and report affected rows + last row id. */
export async function execute(
  db: D1Database,
  sql: string,
  params: SqlParam[] = [],
): Promise<ExecuteResult> {
  const result = await db
    .prepare(sql)
    .bind(...params)
    .run();
  const meta = result.meta as unknown as {
    changes?: number;
    last_row_id?: number | string;
  };
  return {
    changes: meta.changes ?? 0,
    lastInsertRowId:
      typeof meta.last_row_id === "number"
        ? meta.last_row_id
        : Number(meta.last_row_id ?? 0),
  };
}

export interface BatchStatement {
  sql: string;
  params?: SqlParam[];
}

/**
 * Run several statements atomically (D1 batch). Used by repo functions that
 * the Python code wrapped in BEGIN/COMMIT (setSettings, reorderServers,
 * reorderDnsRecords, upsertGroup, deleteGroup) so a failure mid-sequence
 * cannot leave a half-written group or settings update behind.
 * Returns one ExecuteResult per statement, in order.
 */
export async function batch(
  db: D1Database,
  statements: BatchStatement[],
): Promise<ExecuteResult[]> {
  const prepared = statements.map((s) =>
    db.prepare(s.sql).bind(...(s.params ?? [])),
  );
  const results = await db.batch(prepared);
  return results.map((result) => {
    const meta = result.meta as unknown as {
      changes?: number;
      last_row_id?: number | string;
    };
    return {
      changes: meta.changes ?? 0,
      lastInsertRowId:
        typeof meta.last_row_id === "number"
          ? meta.last_row_id
          : Number(meta.last_row_id ?? 0),
    };
  });
}
