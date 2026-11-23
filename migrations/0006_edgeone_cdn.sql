-- Tencent Cloud EdgeOne (TEO) auto-deployment bindings linking managed SSL
-- certificates in `ssl_certificates` to EdgeOne acceleration domains so that
-- automatic certificate renewals push updated certs to EdgeOne automatically.

CREATE TABLE IF NOT EXISTS edgeone_cert_bindings (
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
);

CREATE INDEX IF NOT EXISTS idx_eo_bindings_ssl ON edgeone_cert_bindings(ssl_cert_id);
CREATE INDEX IF NOT EXISTS idx_eo_bindings_zone ON edgeone_cert_bindings(tencent_account_id, site, zone_id);
