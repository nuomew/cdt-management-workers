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
import { DDNS_AGENT_VERSION, getPythonTerminalAgentTemplate } from "./ddns_agent_py";

export { DDNS_AGENT_VERSION };

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

export interface DdnsIpLatencyInput {
  ct?: number | null;
  cu?: number | null;
  cm?: number | null;
}

/**
 * Parse a latency value in milliseconds from query/JSON input.
 * Accepts `-1` (unreachable / timeout) or positive values up to 9999 ms.
 * Returns `undefined` when omitted or invalid so existing DB values are kept.
 */
export function parseLatencyMs(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  const num = Number(text);
  if (!Number.isFinite(num)) return undefined;
  if (num < 0) return -1;
  if (num < 0.1 || num > 9999) return undefined;
  return Math.round(num * 10) / 10;
}

function buildLatencyPatch(
  latency: DdnsIpLatencyInput | undefined,
  now: number,
  source: "agent" | "probe",
): {
  latency_ct_ms?: number | null;
  latency_cu_ms?: number | null;
  latency_cm_ms?: number | null;
  latency_updated_at?: number;
  latency_source?: string;
} {
  if (!latency) return {};
  const hasAny =
    latency.ct !== undefined || latency.cu !== undefined || latency.cm !== undefined;
  if (!hasAny) return {};
  return {
    ...(latency.ct !== undefined ? { latency_ct_ms: latency.ct } : {}),
    ...(latency.cu !== undefined ? { latency_cu_ms: latency.cu } : {}),
    ...(latency.cm !== undefined ? { latency_cm_ms: latency.cm } : {}),
    latency_updated_at: now,
    latency_source: source,
  };
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
    latency?: DdnsIpLatencyInput;
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
  const latencyPatch = buildLatencyPatch(opts?.latency, now, "agent");

  if (!monitor.enabled && !force) {
    await repo.updateDdnsIpMonitorRuntime(env, monitor.id, {
      current_ip: ip,
      hostname: hostname || monitor.hostname,
      last_seen_at: opts?.source === "manual" ? monitor.last_seen_at : now,
      last_status: "disabled",
      ...latencyPatch,
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
      ...latencyPatch,
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
      ...latencyPatch,
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
      ...latencyPatch,
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
      ...latencyPatch,
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

export interface ThreeNetProbeCarrierResult {
  key: "ct" | "cu" | "cm";
  label: string;
  ms: number | null;
  city: string;
  network: string;
  note: string;
}

export interface ThreeNetProbeSummary {
  target: string;
  ct_ms: number | null;
  cu_ms: number | null;
  cm_ms: number | null;
  updated_at: number;
  source: "probe";
  carriers: ThreeNetProbeCarrierResult[];
  message: string;
}

const CHINA_THREE_NET_SPECS: Array<{
  key: "ct" | "cu" | "cm";
  label: string;
  asn: number;
  fallbackMagic: string;
}> = [
  { key: "ct", label: "电信", asn: 4134, fallbackMagic: "China Telecom" },
  { key: "cu", label: "联通", asn: 4837, fallbackMagic: "China Unicom" },
  { key: "cm", label: "移动", asn: 9808, fallbackMagic: "China Mobile" },
];

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSingleGlobalpingCarrier(
  target: string,
  spec: (typeof CHINA_THREE_NET_SPECS)[number],
): Promise<ThreeNetProbeCarrierResult> {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "cdt-management-workers/ddns-ip-probe",
  };
  const locationCandidates: Array<Record<string, unknown>> = [
    { country: "CN", asn: spec.asn, limit: 1 },
    { magic: `CN+${spec.fallbackMagic}`, limit: 1 },
  ];

  let measurementId = "";
  let lastFail = "暂缺在线国内探针";
  for (const loc of locationCandidates) {
    try {
      const createRes = await fetch("https://api.globalping.io/v1/measurements", {
        method: "POST",
        headers,
        body: JSON.stringify({
          type: "ping",
          target,
          locations: [loc],
          measurementOptions: { packets: 3 },
        }),
      });
      if (createRes.ok) {
        const body = (await createRes.json()) as { id?: string };
        if (body.id) {
          measurementId = body.id;
          break;
        }
      } else if (createRes.status === 429) {
        lastFail = "公共探测频率受限，请稍后再试";
        break;
      } else if (createRes.status !== 422) {
        lastFail = `探测服务 HTTP ${createRes.status}`;
      }
    } catch {
      lastFail = "探测服务连接失败";
    }
  }

  if (!measurementId) {
    return {
      key: spec.key,
      label: spec.label,
      ms: null,
      city: "",
      network: "",
      note: lastFail,
    };
  }

  for (let attempt = 0; attempt < 9; attempt += 1) {
    await sleepMs(attempt === 0 ? 500 : 650);
    try {
      const pollRes = await fetch(
        `https://api.globalping.io/v1/measurements/${encodeURIComponent(measurementId)}`,
        { headers: { Accept: "application/json", "User-Agent": headers["User-Agent"] } },
      );
      if (!pollRes.ok) continue;
      const data = (await pollRes.json()) as {
        status?: string;
        results?: Array<{
          probe?: { city?: string; network?: string };
          result?: {
            status?: string;
            stats?: { avg?: number | null; loss?: number | null };
          };
        }>;
      };
      if (data.status === "in-progress") continue;
      const first = data.results?.[0];
      const city = first?.probe?.city ?? "";
      const network = first?.probe?.network ?? "";
      const avg = first?.result?.stats?.avg;
      const loss = first?.result?.stats?.loss;
      if (typeof avg === "number" && Number.isFinite(avg) && avg > 0) {
        const rounded = Math.round(avg * 10) / 10;
        return {
          key: spec.key,
          label: spec.label,
          ms: rounded,
          city,
          network,
          note: `${rounded}ms`,
        };
      }
      if (loss === 100 || first?.result?.status === "finished") {
        return {
          key: spec.key,
          label: spec.label,
          ms: -1,
          city,
          network,
          note: "超时/禁Ping",
        };
      }
      break;
    } catch {
      // Retry next poll slot
    }
  }

  return {
    key: spec.key,
    label: spec.label,
    ms: null,
    city: "",
    network: "",
    note: "等待结果超时",
  };
}

/**
 * Trigger an on-demand China 3-ISP (Telecom / Unicom / Mobile) latency probe
 * against a DDNS IP monitor's public IPv4 (or bound FQDN) via Globalping's
 * public measurement API and persist the results to D1.
 */
export async function probeChinaThreeNetLatency(
  env: Env,
  monitor: DdnsIpMonitorRecord,
): Promise<ThreeNetProbeSummary> {
  const target = (monitor.current_ip || monitor.resolved_ip || monitor.fqdn).trim();
  if (!target) {
    throw new Error("当前记录没有可探测的公网 IPv4 或域名");
  }
  const now = nowSeconds();

  if (env.CDT_DRY_RUN === "1") {
    const carriers: ThreeNetProbeCarrierResult[] = [
      { key: "ct", label: "电信", ms: 36.4, city: "Guangzhou", network: "China Telecom", note: "36.4ms" },
      { key: "cu", label: "联通", ms: 44.8, city: "Shanghai", network: "China Unicom", note: "44.8ms" },
      { key: "cm", label: "移动", ms: 58.2, city: "Shenzhen", network: "China Mobile", note: "58.2ms" },
    ];
    await repo.updateDdnsIpMonitorRuntime(env, monitor.id, {
      latency_ct_ms: 36.4,
      latency_cu_ms: 44.8,
      latency_cm_ms: 58.2,
      latency_updated_at: now,
      latency_source: "probe",
    });
    return {
      target,
      ct_ms: 36.4,
      cu_ms: 44.8,
      cm_ms: 58.2,
      updated_at: now,
      source: "probe",
      carriers,
      message: "三网测速完成：电信 36.4ms · 联通 44.8ms · 移动 58.2ms",
    };
  }

  const carriers = await Promise.all(
    CHINA_THREE_NET_SPECS.map((spec) => runSingleGlobalpingCarrier(target, spec)),
  );
  const byKey = new Map(carriers.map((c) => [c.key, c]));
  const ctMs = byKey.get("ct")?.ms ?? null;
  const cuMs = byKey.get("cu")?.ms ?? null;
  const cmMs = byKey.get("cm")?.ms ?? null;

  const patch: Parameters<typeof repo.updateDdnsIpMonitorRuntime>[2] = {};
  if (ctMs !== null) patch.latency_ct_ms = ctMs;
  if (cuMs !== null) patch.latency_cu_ms = cuMs;
  if (cmMs !== null) patch.latency_cm_ms = cmMs;

  const hasAny = ctMs !== null || cuMs !== null || cmMs !== null;
  if (hasAny) {
    patch.latency_updated_at = now;
    patch.latency_source = "probe";
    await repo.updateDdnsIpMonitorRuntime(env, monitor.id, patch);
  }

  const fmt = (c: ThreeNetProbeCarrierResult | undefined) => {
    if (!c) return "--";
    if (c.ms === null) return "无探针";
    if (c.ms < 0) return "超时";
    return `${c.ms}ms`;
  };
  const allTimedOut =
    hasAny &&
    [ctMs, cuMs, cmMs].filter((v) => v !== null).every((v) => v !== null && v < 0);

  let message: string;
  if (!hasAny) {
    message = "当前公共国内三网探针暂不可用，请重新运行一键安装命令启用服务器主动三网回报";
  } else if (allTimedOut) {
    message = "国内三网 ICMP Ping 全部超时（目标可能禁 Ping），建议重新运行一键安装命令由服务器主动测速上报";
  } else {
    message = `三网测速完成：电信 ${fmt(byKey.get("ct"))} · 联通 ${fmt(byKey.get("cu"))} · 移动 ${fmt(byKey.get("cm"))}`;
  }

  return {
    target,
    ct_ms: ctMs,
    cu_ms: cuMs,
    cm_ms: cmMs,
    updated_at: hasAny ? now : monitor.latency_updated_at,
    source: "probe",
    carriers,
    message,
  };
}

/**
 * Render a zero-dependency POSIX shell installer/uninstaller script that sets
 * up periodic dynamic IPv4 monitoring + China 3-ISP latency reporting via
 * systemd timer (preferred, exact second-level interval) with automatic crontab
 * fallback (Alpine / OpenWrt / containers).
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
  const termUnitName = `cdt-ddns-ip-term-${id}`;
  const scriptPath = `/usr/local/bin/${unitName}.sh`;
  const termScriptPath = `/usr/local/bin/${termUnitName}.py`;
  const termPidFile = `/var/run/${termUnitName}.pid`;
  const updateStampFile = `/tmp/.${unitName}.up`;
  const safeToken = monitor.token.replace(/[^a-fA-F0-9_-]/g, "");
  const safeFqdn = monitor.fqdn.replace(/[^a-zA-Z0-9.-]/g, "");
  const pyAgentTemplate = getPythonTerminalAgentTemplate();

  if (action === "uninstall") {
    return `#!/bin/sh
set -eu

UNIT="${unitName}"
TERM_UNIT="${termUnitName}"
SCRIPT_PATH="${scriptPath}"
TERM_SCRIPT_PATH="${termScriptPath}"
TERM_PID_FILE="${termPidFile}"
UPDATE_STAMP_FILE="${updateStampFile}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 root 或 sudo 运行卸载命令" >&2
  exit 1
fi

echo "==> 正在卸载 DDNS IP 监控与反向远程终端 (${safeFqdn}, \${UNIT})..."

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl disable --now "\${UNIT}.timer" 2>/dev/null || true
  systemctl stop "\${UNIT}.service" 2>/dev/null || true
  systemctl disable --now "\${TERM_UNIT}.service" 2>/dev/null || true
  rm -f "/etc/systemd/system/\${UNIT}.service" "/etc/systemd/system/\${UNIT}.timer" "/etc/systemd/system/\${TERM_UNIT}.service"
  systemctl daemon-reload 2>/dev/null || true
fi

if [ -f "\${TERM_PID_FILE}" ]; then
  OLD_PID="$(cat "\${TERM_PID_FILE}" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ]; then
    kill "$OLD_PID" 2>/dev/null || true
  fi
  rm -f "\${TERM_PID_FILE}"
fi

if command -v crontab >/dev/null 2>&1; then
  (crontab -l 2>/dev/null | grep -v "# \${UNIT}" || true) | crontab - 2>/dev/null || true
fi

rm -f "\${SCRIPT_PATH}" "\${TERM_SCRIPT_PATH}" "\${UPDATE_STAMP_FILE}"
echo "✅ 已完成卸载 \${UNIT} 与反向终端服务 (${safeFqdn})"
`;
  }

  return `#!/bin/sh
set -eu

UNIT="${unitName}"
TERM_UNIT="${termUnitName}"
SCRIPT_PATH="${scriptPath}"
TERM_SCRIPT_PATH="${termScriptPath}"
TERM_PID_FILE="${termPidFile}"
UPDATE_STAMP_FILE="${updateStampFile}"
PANEL_ORIGIN="${origin}"
DDNS_TOKEN="${safeToken}"
DDNS_FQDN="${safeFqdn}"
AGENT_VERSION="${DDNS_AGENT_VERSION}"
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

echo "==> 正在安装 DDNS IP 监控 v\${AGENT_VERSION}（动态 IPv4 + 每次心跳三网延迟 + 免密反向终端）: \${DDNS_FQDN} (每 \${INTERVAL_SEC} 秒)"

mkdir -p /usr/local/bin /var/run
cat > "\${SCRIPT_PATH}" <<'CDT_DDNS_AGENT_EOF'
#!/bin/sh
set -u

PANEL_ORIGIN="__PANEL_ORIGIN__"
DDNS_TOKEN="__DDNS_TOKEN__"
AGENT_VERSION="__AGENT_VERSION__"
TERM_SCRIPT_PATH="__TERM_SCRIPT_PATH__"
TERM_PID_FILE="__TERM_PID_FILE__"
UPDATE_STAMP_FILE="__UPDATE_STAMP_FILE__"
HOST_NAME="$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9._-' | cut -c1-64)"

is_ipv4() {
  printf '%s' "$1" | grep -Eq '^[0-9]{1,3}(\\.[0-9]{1,3}){3}$'
}

fetch_v4() {
  if command -v curl >/dev/null 2>&1; then
    curl -4 -fsS --connect-timeout 8 --max-time 15 "$1" 2>/dev/null || true
  else
    wget -4 -qO- -T 15 "$1" 2>/dev/null || true
  fi
}

# Measure TCP SYN->SYN-ACK RTT (ms) to China 3-ISP backbone nodes (curl first, ping fallback)
probe_isp_ms() {
  for host in "$@"; do
    if command -v curl >/dev/null 2>&1; then
      rc=0
      raw="$(curl -4 -o /dev/null -s -w '%{time_namelookup} %{time_connect}' --connect-timeout 3 --max-time 4 "http://\${host}/" 2>/dev/null)" || rc=$?
      if [ "$rc" -eq 0 ] || [ "$rc" -eq 52 ] || [ "$rc" -eq 56 ]; then
        ms="$(printf '%s\\n' "$raw" | awk '{ v = ($2 - $1) * 1000; if (v < 0.1 && $2 > 0) v = $2 * 1000; if (v >= 0.1 && v < 9999) printf "%.1f", v }' 2>/dev/null || true)"
        if [ -n "$ms" ]; then
          printf '%s' "$ms"
          return 0
        fi
      fi
    elif command -v ping >/dev/null 2>&1; then
      ms="$(ping -4 -c 2 -W 2 "$host" 2>/dev/null | awk -F'[=/ ]+' '/time=/{for(i=1;i<=NF;i++) if($i=="time"){sum+=$(i+1);n++}} END{if(n>0) printf "%.1f", sum/n}' 2>/dev/null || true)"
      if [ -n "$ms" ]; then
        printf '%s' "$ms"
        return 0
      fi
    fi
  done
  printf '%s' "-1"
}

# Keep non-systemd reverse terminal daemon alive on Alpine / OpenWrt / Docker
ensure_term_daemon() {
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1 || [ ! -x "$TERM_SCRIPT_PATH" ]; then
    return 0
  fi
  if [ -f "$TERM_PID_FILE" ]; then
    CUR_PID="$(cat "$TERM_PID_FILE" 2>/dev/null || true)"
    if [ -n "$CUR_PID" ] && kill -0 "$CUR_PID" 2>/dev/null; then
      return 0
    fi
  fi
  nohup python3 "$TERM_SCRIPT_PATH" >/dev/null 2>&1 &
  printf '%s' "$!" > "$TERM_PID_FILE"
}

# Auto-update agent script when panel publishes a newer AGENT_VERSION (300s cooldown)
maybe_self_update() {
  REMOTE_VER="$(printf '%s' "$1" | sed -n 's/.*"agent_version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
  if [ -z "$REMOTE_VER" ] || [ "$REMOTE_VER" = "$AGENT_VERSION" ]; then
    return 0
  fi
  NOW_TS="$(date +%s 2>/dev/null || echo 0)"
  LAST_TS="$(cat "$UPDATE_STAMP_FILE" 2>/dev/null || echo 0)"
  if [ "$NOW_TS" -gt 0 ] && [ "$LAST_TS" -gt 0 ] && [ $((NOW_TS - LAST_TS)) -lt 300 ]; then
    return 0
  fi
  printf '%s' "$NOW_TS" > "$UPDATE_STAMP_FILE" 2>/dev/null || true
  TMP_UP="/tmp/cdt-ddns-up-$$.sh"
  UP_URL="\${PANEL_ORIGIN}/api/v1/ddns-ip/install.sh?token=\${DDNS_TOKEN}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --connect-timeout 10 --max-time 30 "$UP_URL" -o "$TMP_UP" 2>/dev/null || { rm -f "$TMP_UP"; return 0; }
  else
    wget -qO "$TMP_UP" -T 30 "$UP_URL" 2>/dev/null || { rm -f "$TMP_UP"; return 0; }
  fi
  if /bin/sh -n "$TMP_UP" 2>/dev/null; then
    printf '[cdt-ddns-ip] 检测到新版本 v%s（本地 v%s），正在自动更新...\\n' "$REMOTE_VER" "$AGENT_VERSION"
    CDT_DDNS_SKIP_FIRST_RUN=1 /bin/sh "$TMP_UP" >/dev/null 2>&1 || true
  fi
  rm -f "$TMP_UP"
}

ensure_term_daemon

# Detect public IPv4 (panel endpoint first via IPv4 socket, then public IPv4 fallbacks)
PUB_IP=""
for probe in \\
  "\${PANEL_ORIGIN}/api/v1/ddns-ip/ip" \\
  "https://api4.ipify.org" \\
  "https://4.ipw.cn" \\
  "https://ipv4.icanhazip.com"; do
  CAND="$(fetch_v4 "$probe" | tr -d ' \\r\\n\\t')"
  if is_ipv4 "$CAND"; then
    PUB_IP="$CAND"
    break
  fi
done

# Probe China Telecom / Unicom / Mobile RTT (ms) with multi-province failover
CT_MS="$(probe_isp_ms gd-ct-v4.ip.zstaticcdn.com sh-ct-v4.ip.zstaticcdn.com bj-ct-v4.ip.zstaticcdn.com)"
CU_MS="$(probe_isp_ms gd-cu-v4.ip.zstaticcdn.com sh-cu-v4.ip.zstaticcdn.com bj-cu-v4.ip.zstaticcdn.com)"
CM_MS="$(probe_isp_ms gd-cm-v4.ip.zstaticcdn.com sh-cm-v4.ip.zstaticcdn.com bj-cm-v4.ip.zstaticcdn.com)"

REPORT_URL="\${PANEL_ORIGIN}/api/v1/ddns-ip/report?token=\${DDNS_TOKEN}&host=\${HOST_NAME}&ct=\${CT_MS}&cu=\${CU_MS}&cm=\${CM_MS}&v=\${AGENT_VERSION}"
if [ -n "$PUB_IP" ]; then
  REPORT_URL="\${REPORT_URL}&ip=\${PUB_IP}"
fi

if command -v curl >/dev/null 2>&1; then
  RESP="$(curl -4 -fsS --connect-timeout 8 --max-time 20 "$REPORT_URL" 2>/dev/null || curl -fsS --connect-timeout 8 --max-time 20 "$REPORT_URL" 2>/dev/null || true)"
else
  RESP="$(wget -4 -qO- -T 20 "$REPORT_URL" 2>/dev/null || wget -qO- -T 20 "$REPORT_URL" 2>/dev/null || true)"
fi

if [ -n "$RESP" ]; then
  printf '[cdt-ddns-ip] %s\\n' "$RESP"
  maybe_self_update "$RESP"
else
  printf '[cdt-ddns-ip] 上报失败，请检查网络连通性: %s\\n' "$PANEL_ORIGIN" >&2
  exit 1
fi
CDT_DDNS_AGENT_EOF

sed -i "s|__PANEL_ORIGIN__|\${PANEL_ORIGIN}|g; s|__DDNS_TOKEN__|\${DDNS_TOKEN}|g; s|__AGENT_VERSION__|\${AGENT_VERSION}|g; s|__TERM_SCRIPT_PATH__|\${TERM_SCRIPT_PATH}|g; s|__TERM_PID_FILE__|\${TERM_PID_FILE}|g; s|__UPDATE_STAMP_FILE__|\${UPDATE_STAMP_FILE}|g" "\${SCRIPT_PATH}"
chmod 700 "\${SCRIPT_PATH}"

# Install zero-dependency Python 3 reverse WebSocket PTY terminal daemon
if command -v python3 >/dev/null 2>&1; then
  cat > "\${TERM_SCRIPT_PATH}" <<'CDT_DDNS_TERM_EOF'
${pyAgentTemplate}CDT_DDNS_TERM_EOF
  sed -i "s|__PANEL_ORIGIN__|\${PANEL_ORIGIN}|g; s|__DDNS_TOKEN__|\${DDNS_TOKEN}|g; s|__AGENT_VERSION__|\${AGENT_VERSION}|g" "\${TERM_SCRIPT_PATH}"
  chmod 700 "\${TERM_SCRIPT_PATH}"
else
  echo "⚠️ 未检测到 python3，将跳过免密反向终端守护服务（DDNS IP 与三网延迟监控不受影响）"
fi

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  cat > "/etc/systemd/system/\${UNIT}.service" <<EOF
[Unit]
Description=CDT DDNS IPv4 & 3-ISP Monitor (\${DDNS_FQDN})
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

  if [ -x "\${TERM_SCRIPT_PATH}" ]; then
    cat > "/etc/systemd/system/\${TERM_UNIT}.service" <<EOF
[Unit]
Description=CDT DDNS Reverse WebSocket Terminal Agent (\${DDNS_FQDN})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=HOME=/root
WorkingDirectory=/root
ExecStart=/usr/bin/env python3 \${TERM_SCRIPT_PATH}
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOF
  fi

  systemctl daemon-reload
  systemctl enable --now "\${UNIT}.timer"
  echo "✅ 已启用 systemd 定时任务: \${UNIT}.timer (每 \${INTERVAL_SEC} 秒检测 IPv4 与三网延迟，支持自动更新)"
  if [ -x "\${TERM_SCRIPT_PATH}" ]; then
    systemctl enable --now "\${TERM_UNIT}.service"
    systemctl restart "\${TERM_UNIT}.service" 2>/dev/null || true
    echo "✅ 已启用免密反向终端常驻服务: \${TERM_UNIT}.service (无需开放 SSH 端口)"
  fi
elif command -v crontab >/dev/null 2>&1; then
  (crontab -l 2>/dev/null | grep -v "# \${UNIT}" || true; echo "\${CRON_EXPR} \${SCRIPT_PATH} >/dev/null 2>&1 # \${UNIT}") | crontab -
  echo "✅ 已写入 crontab 定时任务: \${CRON_EXPR} (注释标记 # \${UNIT})"
  if [ -x "\${TERM_SCRIPT_PATH}" ]; then
    if [ -f "\${TERM_PID_FILE}" ]; then
      OLD_PID="$(cat "\${TERM_PID_FILE}" 2>/dev/null || true)"
      [ -n "$OLD_PID" ] && kill "$OLD_PID" 2>/dev/null || true
    fi
    nohup python3 "\${TERM_SCRIPT_PATH}" >/dev/null 2>&1 &
    printf '%s' "$!" > "\${TERM_PID_FILE}"
    echo "✅ 已后台启动免密反向终端服务 (PID $(cat "\${TERM_PID_FILE}"))"
  fi
else
  echo "⚠️ 未检测到 systemd 或 crontab，已安装脚本至 \${SCRIPT_PATH}，请手动加入计划任务"
fi

if [ "\${CDT_DDNS_SKIP_FIRST_RUN:-0}" != "1" ]; then
  echo "==> 正在执行首次公网 IPv4 及国内三网延迟检测..."
  "\${SCRIPT_PATH}" || true
fi
echo "✅ 安装完成！卸载命令: curl -fsSL \"\${PANEL_ORIGIN}/api/v1/ddns-ip/install.sh?token=\${DDNS_TOKEN}&action=uninstall\" | sudo sh"
`;
}
