-- Incremental schema migration: China 3-ISP (CT / CU / CM) latency tracking for DDNS IP monitors
ALTER TABLE ddns_ip_monitors ADD COLUMN latency_ct_ms REAL;
ALTER TABLE ddns_ip_monitors ADD COLUMN latency_cu_ms REAL;
ALTER TABLE ddns_ip_monitors ADD COLUMN latency_cm_ms REAL;
ALTER TABLE ddns_ip_monitors ADD COLUMN latency_updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ddns_ip_monitors ADD COLUMN latency_source TEXT NOT NULL DEFAULT '';
