/**
 * Dynamic public IPv4 DDNS monitor engine & one-click installer generator.
 *
 * Reuses `dns_providers.ts` (Tencent Cloud DNSPod + Cloudflare DNS API v4) so
 * any server running the lightweight one-click shell / PowerShell agent can
 * report its dynamic IPv4 address and automatically update its bound A record
 * whenever the public IPv4 changes.
 */

import type { Env } from "./env";
import * as dnsProviders from "./dns_providers";
import * as messages from "./messages";
import * as notify from "./notify";
import * as repo from "./repo";
import type { DdnsIpMonitorRecord } from "./repo";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Strictly validate a canonical dotted-quad IPv4 address (no whitespace,
 * no leading zeros like `01`, every octet in 0..255).
 */
export function isValidIpv4(raw: string): boolean {
  const ip = raw.trim();
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;
  const parts = ip.split(".");
  for (const p of parts) {
    if (p.length > 1 && p.startsWith("0")) return false;
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
  }
  return true;
}

/**
 * Extract the best candidate IPv4 from Cloudflare / reverse-proxy headers.
 * Returns empty string if the request arrived over IPv6 or without an IP header.
 */
export function extractRequestIpv4(req: Request): string {
  const candidates = [
    req.headers.get("cf-connecting-ip") ?? "",
    req.headers.get("x-real-ip") ?? "",
    ...(req.headers.get("x-forwarded-for") ?? "").split(","),
  ];
  for (const raw of candidates) {
    const clean = raw.trim().replace(/^::ffff:/i, "");
    if (isValidIpv4(clean)) return clean;
  }
  return "";
}

/**
 * Normalize and validate a user-entered DNS host prefix (`@`, `home`, `a.b`,
 * or even a full FQDN under `rootDomain`), returning both relative `subDomain`
 * and full `fqdn`.
 */
export function normalizeSubDomainAndFqdn(
  rawSub: string,
  rootDomainRaw: string,
): { rootDomain: string; subDomain: string; fqdn: string } {
  const rootDomain = rootDomainRaw.trim().toLowerCase().replace(/\.+$/, "");
  if (!rootDomain || !rootDomain.includes(".")) {
    throw new Error("请选择有效的根域名");
  }
  const rel = dnsProviders.toRelativeHost(rawSub || "@", rootDomain);
  if (rel !== "@") {
    const labels = rel.split(".");
    for (const label of labels) {
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
        throw new Error(
          `解析前缀「${rel}」格式无效，仅支持字母、数字、连字符和点号（根域名请填 @ 或留空）`,
        );
      }
    }
  }
  const fqdn = dnsProviders.toFqdn(rel, rootDomain);
  return { rootDomain, subDomain: rel, fqdn };
}

export interface DdnsIpSyncResult {
  ok: boolean;
  changed: boolean;
  action: "created" | "updated" | "unchanged" | "disabled";
  fqdn: string;
  ip: string;
  previous_ip: string;
  record_id: string;
  message: string;
}

async function notifyDdnsIpChange(
  env: Env,
  monitor: DdnsIpMonitorRecord,
  previousIp: string,
  newIp: string,
  hostname: string,
): Promise<void> {
  try {
    const config = await repo.getSettings(env);
    if (notify.enabledChannels(env, config).length === 0) return;
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const title = `🌐 DDNS IP 变动已更新：${monitor.fqdn}`;
    const lines = [
      `域名：${monitor.fqdn}`,
      ...(monitor.label ? [`节点：${monitor.label}`] : []),
      ...(hostname ? [`主机名：${hostname}`] : []),
      `原公网 IP：${previousIp || "（首次绑定）"}`,
      `新公网 IP：${newIp}`,
    ];
    await notify.sendAll(env, config, {
      kind: "ddns_ip_changed",
      title,
      titleHtml: `<b>${esc(title)}</b>`,
      body: lines.map(esc).join("\n"),
    });
  } catch (err) {
    console.warn("DDNS IP change notification failed", err);
  }
}

/**
 * Process a dynamic IPv4 report (from a remote host agent or manual panel sync).
 * In steady state (IP unchanged and already synced) this performs zero external
 * Cloud DNS API calls and only updates heartbeat metadata.
 */
export async function syncDdnsIpMonitor(
  env: Env,
  monitor: DdnsIpMonitorRecord,
  rawIp: string,
  opts?: {
    hostname?: string;
    force?: boolean;
    source?: "agent" | "manual";
  },
): Promise<DdnsIpSyncResult> {
  const ip = rawIp.trim().replace(/^::ffff:/i, "");
  if (!isValidIpv4(ip)) {
    throw new Error(`无效的公网 IPv4 地址：${rawIp || "空"}`);
  }
  const now = nowSeconds();
  const hostname = (opts?.hostname ?? "").trim().slice(0, 128);
  const force = Boolean(opts?.force);
  const previousIp = monitor.resolved_ip;

  if (!monitor.enabled && !force) {
    await repo.updateDdnsIpMonitorRuntime(env, monitor.id, {
      current_ip: ip,
      hostname: hostname || monitor.hostname,
      last_seen_at: opts?.source === "manual" ? monitor.last_seen_at : now,
      last_status: "disabled",
    });
    return {
      ok: true,
      changed: false,
      action: "disabled",
      fqdn: monitor.fqdn,
      ip,
      previous_ip: previousIp,
      record_id: monitor.record_id,
      message: "监控已暂停，仅记录心跳，未修改 DNS 解析",
    };
  }

  // Steady-state fast path: IPv4 did not change and we already synced this record cleanly.
  if (
    !force &&
    monitor.resolved_ip === ip &&
    Boolean(monitor.record_id) &&
    monitor.last_status !== "error"
  ) {
    await repo.updateDdnsIpMonitorRuntime(env, monitor.id, {
      current_ip: ip,
      hostname: hostname || monitor.hostname,
      last_seen_at: opts?.source === "manual" ? monitor.last_seen_at : now,
      last_status: "unchanged",
      last_error: "",
    });
    return {
      ok: true,
      changed: false,
      action: "unchanged",
      fqdn: monitor.fqdn,
      ip,
      previous_ip: previousIp,
      record_id: monitor.record_id,
      message: `IP 未变动（${ip}），无需更新解析`,
    };
  }

  const account = await repo.getDnsAccount(env, monitor.dns_account_id, true);
  if (!account) {
    const errMsg = `绑定的云解析账号 #${monitor.dns_account_id} 不存在`;
    await repo.updateDdnsIpMonitorRuntime(env, monitor.id, {
      current_ip: ip,
      hostname: hostname || monitor.hostname,
      last_seen_at: opts?.source === "manual" ? monitor.last_seen_at : now,
      last_status: "error",
      last_error: errMsg,
    });
    throw new Error(errMsg);
  }

  try {
    let zoneId = monitor.zone_id;
    let rootDomain = monitor.root_domain;
    if (!zoneId) {
      const resolved = await dnsProviders.resolveDomainZone(env, account, monitor.fqdn);
      zoneId = resolved.zoneId;
      rootDomain = resolved.rootDomain;
    }

    const records = await dnsProviders.listRecords(env, account, rootDomain, zoneId);
    const targetRel = dnsProviders.toRelativeHost(monitor.sub_domain, rootDomain);
    const sameHostRecords = records.filter(
      (r) => dnsProviders.toRelativeHost(r.name, rootDomain) === targetRel,
    );

    const existingA =
      (monitor.record_id
        ? sameHostRecords.find((r) => r.id === monitor.record_id && r.type.toUpperCase() === "A")
        : undefined) ??
      sameHostRecords.find((r) => r.type.toUpperCase() === "A");

    if (!existingA) {
      const conflictCname = sameHostRecords.find((r) => r.type.toUpperCase() === "CNAME");
      if (conflictCname) {
        throw new Error(
          `域名 ${monitor.fqdn} 已存在冲突的 CNAME 记录（指向 ${conflictCname.value}），请先在云解析中删除该 CNAME 后重试`,
        );
      }
    }

    const remarkText = monitor.remark || `DDNS IP (${monitor.label || monitor.fqdn})`;
    let finalRecordId = existingA?.id ?? "";
    let action: "created" | "updated" | "unchanged" = "unchanged";

    if (existingA) {
      const ttlMatch = !monitor.ttl || existingA.ttl === monitor.ttl;
      const proxiedMatch =
        account.provider !== "cloudflare" || Boolean(existingA.proxied) === monitor.proxied;
      if (existingA.value.trim() === ip && ttlMatch && proxiedMatch && existingA.enabled) {
        finalRecordId = existingA.id;
        action = "unchanged";
      } else {
        const updated = await dnsProviders.updateRecord(env, account, rootDomain, zoneId, existingA.id, {
          name: targetRel,
          type: "A",
          value: ip,
          ttl: monitor.ttl,
          line: account.provider === "tencent" ? monitor.line || "默认" : undefined,
          proxied: account.provider === "cloudflare" ? monitor.proxied : undefined,
          enabled: true,
          remark: remarkText,
        });
        finalRecordId = updated.id;
        action = "updated";
      }
    } else {
      const created = await dnsProviders.createRecord(env, account, rootDomain, zoneId, {
        name: targetRel,
        type: "A",
        value: ip,
        ttl: monitor.ttl,
        line: account.provider === "tencent" ? monitor.line || "默认" : undefined,
        proxied: account.provider === "cloudflare" ? monitor.proxied : undefined,
        enabled: true,
        remark: remarkText,
      });
      finalRecordId = created.id;
      action = "created";
    }

    const ipChanged = previousIp !== ip || action !== "unchanged";
    await repo.updateDdnsIpMonitorRuntime(env, monitor.id, {
      record_id: finalRecordId,
      zone_id: zoneId,
      current_ip: ip,
      resolved_ip: ip,
      hostname: hostname || monitor.hostname,
      last_seen_at: opts?.source === "manual" ? monitor.last_seen_at : now,
      last_changed_at: ipChanged ? now : monitor.last_changed_at,
      last_status: action === "unchanged" ? "unchanged" : "synced",
      last_error: "",
    });

    if (action === "created" || action === "updated") {
      await repo.addEvent(
        env,
        "dns",
        messages.ev(
          action === "created" ? "DDNS IP 首次解析已创建" : "DDNS IP 变动已自动更新",
          messages.objServer(monitor.fqdn),
        ),
        {
          detail: `${monitor.label ? `[${monitor.label}] ` : ""}${previousIp ? `${previousIp} → ` : ""}${ip}（${
            account.provider === "cloudflare" ? "Cloudflare" : "腾讯云 DNSPod"
          }）`,
        },
      );
      if (previousIp && previousIp !== ip) {
        await notifyDdnsIpChange(env, monitor, previousIp, ip, hostname || monitor.hostname);
      }
    }

    return {
      ok: true,
      changed: action !== "unchanged",
      action,
      fqdn: monitor.fqdn,
      ip,
      previous_ip: previousIp,
      record_id: finalRecordId,
      message:
        action === "created"
          ? `已创建 A 记录 ${monitor.fqdn} → ${ip}`
          : action === "updated"
            ? `已更新 A 记录 ${monitor.fqdn}：${previousIp || "旧值"} → ${ip}`
            : `远端解析已是 ${ip}，已同步绑定状态`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await repo.updateDdnsIpMonitorRuntime(env, monitor.id, {
      current_ip: ip,
      hostname: hostname || monitor.hostname,
      last_seen_at: opts?.source === "manual" ? monitor.last_seen_at : now,
      last_status: "error",
      last_error: msg,
    });
    await repo.addEvent(
      env,
      "dns",
      messages.ev("DDNS IP 自动更新失败", messages.objServer(monitor.fqdn)),
      { level: "error", detail: `${ip}：${msg}` },
    );
    throw new Error(msg);
  }
}

/**
 * Render a zero-dependency POSIX shell installer/uninstaller script that sets
 * up periodic dynamic IPv4 monitoring via systemd timer (preferred, exact
 * second-level interval) with automatic crontab fallback (Alpine / OpenWrt /
 * containers).
 */
export function renderLinuxInstallScript(
  originRaw: string,
  monitor: DdnsIpMonitorRecord,
  action: "install" | "uninstall" = "install",
): string {
  const origin = new URL(originRaw).origin;
  const id = Math.max(1, Math.trunc(monitor.id));
  const interval = Math.max(30, Math.min(3600, Math.trunc(monitor.interval_seconds || 60)));
  const cronMinutes = Math.max(1, Math.round(interval / 60));
  const cronExpr = cronMinutes <= 1 ? "* * * * *" : `*/${cronMinutes} * * * *`;
  // Safe ASCII identifier for filenames / unit names
  const unitName = `cdt-ddns-ip-${id}`;
  const scriptPath = `/usr/local/bin/${unitName}.sh`;
  const safeToken = monitor.token.replace(/[^a-fA-F0-9_-]/g, "");
  const safeFqdn = monitor.fqdn.replace(/[^a-zA-Z0-9.-]/g, "");

  if (action === "uninstall") {
    return `#!/bin/sh
set -eu

UNIT="${unitName}"
SCRIPT_PATH="${scriptPath}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 root 或 sudo 运行卸载命令" >&2
  exit 1
fi

echo "==> 正在卸载 DDNS IP 监控 (${safeFqdn}, \${UNIT})..."

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl disable --now "\${UNIT}.timer" 2>/dev/null || true
  systemctl stop "\${UNIT}.service" 2>/dev/null || true
  rm -f "/etc/systemd/system/\${UNIT}.service" "/etc/systemd/system/\${UNIT}.timer"
  systemctl daemon-reload 2>/dev/null || true
fi

if command -v crontab >/dev/null 2>&1; then
  (crontab -l 2>/dev/null | grep -v "# \${UNIT}" || true) | crontab - 2>/dev/null || true
fi

rm -f "\${SCRIPT_PATH}"
echo "✅ 已完成卸载 \${UNIT} (${safeFqdn})"
`;
  }

  return `#!/bin/sh
set -eu

UNIT="${unitName}"
SCRIPT_PATH="${scriptPath}"
PANEL_ORIGIN="${origin}"
DDNS_TOKEN="${safeToken}"
DDNS_FQDN="${safeFqdn}"
INTERVAL_SEC="${interval}"
CRON_EXPR="${cronExpr}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 root 或 sudo 运行一键安装命令（例如: curl -fsSL ... | sudo sh）" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  echo "未检测到 curl 或 wget，请先安装其中之一后重试" >&2
  exit 1
fi

echo "==> 正在安装 DDNS IP 动态公网 IPv4 监控: \${DDNS_FQDN} (每 \${INTERVAL_SEC} 秒)"

mkdir -p /usr/local/bin
cat > "\${SCRIPT_PATH}" <<'CDT_DDNS_AGENT_EOF'
#!/bin/sh
set -u

PANEL_ORIGIN="__PANEL_ORIGIN__"
DDNS_TOKEN="__DDNS_TOKEN__"
HOST_NAME="$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9._-' | cut -c1-64)"

is_ipv4() {
  printf '%s' "$1" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
}

fetch_v4() {
  if command -v curl >/dev/null 2>&1; then
    curl -4 -fsS --connect-timeout 8 --max-time 15 "$1" 2>/dev/null || true
  else
    wget -4 -qO- -T 15 "$1" 2>/dev/null || true
  fi
}

# Detect public IPv4 (panel endpoint first via IPv4 socket, then public IPv4 fallbacks)
PUB_IP=""
for probe in \\
  "\${PANEL_ORIGIN}/api/v1/ddns-ip/ip" \\
  "https://api4.ipify.org" \\
  "https://4.ipw.cn" \\
  "https://ipv4.icanhazip.com"; do
  CAND="$(fetch_v4 "$probe" | tr -d ' \r\n\t')"
  if is_ipv4 "$CAND"; then
    PUB_IP="$CAND"
    break
  fi
done

REPORT_URL="\${PANEL_ORIGIN}/api/v1/ddns-ip/report?token=\${DDNS_TOKEN}&host=\${HOST_NAME}"
if [ -n "$PUB_IP" ]; then
  REPORT_URL="\${REPORT_URL}&ip=\${PUB_IP}"
fi

if command -v curl >/dev/null 2>&1; then
  RESP="$(curl -4 -fsS --connect-timeout 8 --max-time 20 "$REPORT_URL" 2>/dev/null || curl -fsS --connect-timeout 8 --max-time 20 "$REPORT_URL" 2>/dev/null || true)"
else
  RESP="$(wget -4 -qO- -T 20 "$REPORT_URL" 2>/dev/null || wget -qO- -T 20 "$REPORT_URL" 2>/dev/null || true)"
fi

if [ -n "$RESP" ]; then
  printf '[cdt-ddns-ip] %s\n' "$RESP"
else
  printf '[cdt-ddns-ip] 上报失败，请检查网络连通性: %s\n' "$PANEL_ORIGIN" >&2
  exit 1
fi
CDT_DDNS_AGENT_EOF

sed -i "s|__PANEL_ORIGIN__|\${PANEL_ORIGIN}|g; s|__DDNS_TOKEN__|\${DDNS_TOKEN}|g" "\${SCRIPT_PATH}"
chmod 700 "\${SCRIPT_PATH}"

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  cat > "/etc/systemd/system/\${UNIT}.service" <<EOF
[Unit]
Description=CDT DDNS IPv4 Monitor (\${DDNS_FQDN})
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=\${SCRIPT_PATH}
EOF

  cat > "/etc/systemd/system/\${UNIT}.timer" <<EOF
[Unit]
Description=Run CDT DDNS IPv4 Monitor (\${DDNS_FQDN}) every \${INTERVAL_SEC}s

[Timer]
OnBootSec=15s
OnUnitActiveSec=\${INTERVAL_SEC}s
AccuracySec=5s
Persistent=true

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now "\${UNIT}.timer"
  echo "✅ 已启用 systemd 定时任务: \${UNIT}.timer (每 \${INTERVAL_SEC} 秒检测并自动更新)"
elif command -v crontab >/dev/null 2>&1; then
  (crontab -l 2>/dev/null | grep -v "# \${UNIT}" || true; echo "\${CRON_EXPR} \${SCRIPT_PATH} >/dev/null 2>&1 # \${UNIT}") | crontab -
  echo "✅ 已写入 crontab 定时任务: \${CRON_EXPR} (注释标记 # \${UNIT})"
else
  echo "⚠️ 未检测到 systemd 或 crontab，已安装脚本至 \${SCRIPT_PATH}，请手动加入计划任务"
fi

echo "==> 正在执行首次公网 IPv4 检测与解析上报..."
"\${SCRIPT_PATH}" || true
echo "✅ 安装完成！卸载命令: curl -fsSL \"\${PANEL_ORIGIN}/api/v1/ddns-ip/install.sh?token=\${DDNS_TOKEN}&action=uninstall\" | sudo sh"
`;
}
