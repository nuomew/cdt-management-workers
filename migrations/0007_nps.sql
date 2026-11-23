-- NPS (https://github.com/yisier/nps) server connections and SSL certificate
-- auto-sync bindings linking managed Tencent Cloud SSL certificates to NPS
-- domain hosts (and optionally mirroring updates to bound EdgeOne CDN hosts).

CREATE TABLE IF NOT EXISTS nps_servers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT    NOT NULL,
  base_url    TEXT    NOT NULL,
  auth_mode   TEXT    NOT NULL DEFAULT 'auth_key',
  auth_key    TEXT    NOT NULL DEFAULT '',
  username    TEXT    NOT NULL DEFAULT '',
  password    TEXT    NOT NULL DEFAULT '',
  remark      TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS nps_cert_bindings (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  ssl_cert_id           INTEGER NOT NULL,
  nps_server_id         INTEGER NOT NULL,
  nps_host_id           INTEGER NOT NULL,
  nps_client_id         INTEGER NOT NULL DEFAULT 0,
  domain                TEXT    NOT NULL,
  sync_cdn              INTEGER NOT NULL DEFAULT 1,
  last_deployed_cert_id TEXT    NOT NULL DEFAULT '',
  last_deployed_at      INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT    NOT NULL DEFAULT '',
  created_at            INTEGER NOT NULL DEFAULT 0,
  updated_at            INTEGER NOT NULL DEFAULT 0,
  UNIQUE(nps_server_id, nps_host_id)
);

CREATE INDEX IF NOT EXISTS idx_nps_bindings_ssl ON nps_cert_bindings(ssl_cert_id);
CREATE INDEX IF NOT EXISTS idx_nps_bindings_server ON nps_cert_bindings(nps_server_id, domain);
