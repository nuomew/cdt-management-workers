-- Add cloud provider discriminator to swas_servers (aliyun | tencent).
ALTER TABLE swas_servers ADD COLUMN provider TEXT NOT NULL DEFAULT 'aliyun';
