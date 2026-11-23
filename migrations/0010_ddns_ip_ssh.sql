-- Incremental schema migration: encrypted SSH connection profile per DDNS IP monitor
ALTER TABLE ddns_ip_monitors ADD COLUMN ssh_port INTEGER NOT NULL DEFAULT 22;
ALTER TABLE ddns_ip_monitors ADD COLUMN ssh_username TEXT NOT NULL DEFAULT 'root';
ALTER TABLE ddns_ip_monitors ADD COLUMN ssh_auth_type TEXT NOT NULL DEFAULT 'password';
ALTER TABLE ddns_ip_monitors ADD COLUMN ssh_secret_enc TEXT NOT NULL DEFAULT '';
ALTER TABLE ddns_ip_monitors ADD COLUMN ssh_passphrase_enc TEXT NOT NULL DEFAULT '';
