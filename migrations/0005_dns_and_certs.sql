-- Cloud DNS accounts (Tencent Cloud DNSPod & Cloudflare) and Tencent Cloud SSL
-- certificate management with automated DNS validation and pre-expiry renewal.

CREATE TABLE IF NOT EXISTS dns_accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider    TEXT    NOT NULL,
  label       TEXT    NOT NULL,
  auth_mode   TEXT    NOT NULL DEFAULT 'cam',
  cred_id     TEXT    NOT NULL DEFAULT '',
  cred_secret TEXT    NOT NULL,
  remark      TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_dns_accounts_provider ON dns_accounts(provider, id);

CREATE TABLE IF NOT EXISTS ssl_certificates (
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
);

CREATE INDEX IF NOT EXISTS idx_ssl_certs_domain ON ssl_certificates(domain);
CREATE INDEX IF NOT EXISTS idx_ssl_certs_status ON ssl_certificates(status, cert_end_ts);
