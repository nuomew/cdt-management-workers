-- Dynamic IPv4 DDNS monitor bindings: each row tracks a remote server's
-- dynamic public IPv4 reported via a per-monitor high-entropy token and
-- automatically updates the bound Cloud DNS A record (Tencent DNSPod or
-- Cloudflare) whenever the IPv4 address changes.

CREATE TABLE IF NOT EXISTS ddns_ip_monitors (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  label             TEXT    NOT NULL DEFAULT '',
  dns_account_id    INTEGER NOT NULL,
  root_domain       TEXT    NOT NULL,
  zone_id           TEXT    NOT NULL DEFAULT '',
  sub_domain        TEXT    NOT NULL DEFAULT '@',
  fqdn              TEXT    NOT NULL,
  ttl               INTEGER NOT NULL DEFAULT 600,
  proxied           INTEGER NOT NULL DEFAULT 0,
  line              TEXT    NOT NULL DEFAULT '默认',
  interval_seconds  INTEGER NOT NULL DEFAULT 60,
  token_enc         TEXT    NOT NULL DEFAULT '',
  token_hash        TEXT    NOT NULL DEFAULT '',
  enabled           INTEGER NOT NULL DEFAULT 1,
  record_id         TEXT    NOT NULL DEFAULT '',
  current_ip        TEXT    NOT NULL DEFAULT '',
  resolved_ip       TEXT    NOT NULL DEFAULT '',
  hostname          TEXT    NOT NULL DEFAULT '',
  last_seen_at      INTEGER NOT NULL DEFAULT 0,
  last_changed_at   INTEGER NOT NULL DEFAULT 0,
  last_status       TEXT    NOT NULL DEFAULT 'waiting',
  last_error        TEXT    NOT NULL DEFAULT '',
  remark            TEXT    NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL DEFAULT 0,
  UNIQUE(dns_account_id, fqdn)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ddns_ip_token_hash ON ddns_ip_monitors(token_hash);
CREATE INDEX IF NOT EXISTS idx_ddns_ip_account ON ddns_ip_monitors(dns_account_id);
