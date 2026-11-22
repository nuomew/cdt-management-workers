/**
 * Traffic telemetry & analytics aggregation for:
 * 1. Public unauthenticated status homepage (`/api/v1/public/home`) — strictly
 *    sanitized allowlist without IPs, instance IDs, credentials, or billing.
 * 2. Authenticated admin telemetry dashboard (`/api/v1/dashboard/analytics`) —
 *    multi-range trends, day/month comparisons, threshold exhaustion forecasts,
 *    ECS + SWAS dual-domain breakdown, and monthly cost rollup.
 */

import type { Env } from "./env";
import * as repo from "./repo";
import * as billing from "./billing";
import { BRAND } from "./settings";

const ONE_DAY_MS = 86_400_000;

interface TzDayInfo {
  date: string; // YYYY-MM-DD
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  label: string; // YYYY-MM-DD HH:MM:SS
}

function tzDayInfo(tzName: string, epochSeconds: number): TzDayInfo {
  const date = new Date(epochSeconds * 1000);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tzName,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  let hh = p["hour"] || "00";
  if (hh === "24") hh = "00";
  const y = Number(p["year"] || 2026);
  const m = Number(p["month"] || 1);
  const d = Number(p["day"] || 1);
  const yStr = String(y).padStart(4, "0");
  const mStr = String(m).padStart(2, "0");
  const dStr = String(d).padStart(2, "0");
  return {
    date: `${yStr}-${mStr}-${dStr}`,
    year: y,
    month: m,
    day: d,
    label: `${yStr}-${mStr}-${dStr} ${hh}:${p["minute"] || "00"}:${p["second"] || "00"}`,
  };
}

function shiftDateString(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y || 2026, (m || 1) - 1, (d || 1) + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function round2(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function calcDeltaPct(current: number, previous: number): number | null {
  if (previous <= 0.001) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

type HealthLevel = "safe" | "warning" | "critical" | "stopped";

function ecsHealthLevel(server: repo.ServerView): HealthLevel {
  const used = server.traffic_used ?? 0;
  const threshold = server.threshold_gb || 0;
  if (threshold > 0 && used >= threshold) return "critical";
  if (threshold > 0 && used >= threshold * 0.8) return "warning";
  if (server.instance_status && server.instance_status !== "Running") return "stopped";
  return "safe";
}

function swasHealthLevel(server: repo.SwasServerView): HealthLevel {
  const total = server.traffic_total_gb ?? 0;
  const used = server.traffic_used_gb ?? 0;
  const overflow = server.traffic_overflow_gb ?? 0;
  if (overflow > 0 || (total > 0 && used >= total * 0.95)) return "critical";
  if (total > 0 && used >= total * 0.8) return "warning";
  if (server.instance_status && server.instance_status !== "Running") return "stopped";
  return "safe";
}

export interface TrendPoint {
  date: string;
  short_date: string;
  daily_gb: number;
  cumulative_gb: number;
}

export interface PublicNodeItem {
  kind: "ecs" | "swas";
  provider?: repo.SwasProvider;
  name: string;
  region_id: string;
  status: string;
  used_gb: number;
  quota_gb: number;
  threshold_gb: number;
  percent: number;
  today_gb: number;
  health: HealthLevel;
  spec_summary: string;
  bandwidth_mbps?: number;
}

export interface PublicHomePayload {
  brand: string;
  site_title: string;
  site_subtitle: string;
  timezone: string;
  updated_at: number;
  updated_label: string;
  summary: {
    total_nodes: number;
    online_nodes: number;
    ecs_total: number;
    ecs_online: number;
    swas_total: number;
    swas_online: number;
    total_used_gb: number;
    total_quota_gb: number;
    total_percent: number;
    ecs_used_gb: number;
    ecs_quota_gb: number;
    swas_used_gb: number;
    swas_quota_gb: number;
    today_gb: number;
    yesterday_gb: number;
    day_delta_pct: number | null;
    month_gb: number;
    last_month_gb: number;
    month_delta_pct: number | null;
    avg_daily_gb: number;
    projected_month_gb: number;
    remaining_days: number;
  };
  health: {
    safe: number;
    warning: number;
    critical: number;
    stopped: number;
  };
  trend: TrendPoint[];
  nodes: PublicNodeItem[];
  ranking: {
    kind: "ecs" | "swas";
    provider?: repo.SwasProvider;
    name: string;
    region_id: string;
    used_gb: number;
    quota_gb: number;
    percent: number;
    status: string;
    bandwidth_mbps?: number;
  }[];
}

export interface AdminNodeMetric {
  id: number;
  kind: "ecs" | "swas";
  provider?: repo.SwasProvider;
  label: string;
  instance_id: string;
  region_id: string;
  public_ip: string;
  status: string;
  used_gb: number;
  quota_gb: number;
  threshold_gb: number;
  percent: number;
  today_gb: number;
  avg_daily_gb: number;
  projected_gb: number;
  days_to_threshold: number | null;
  health: HealthLevel;
  spec_summary: string;
  expired_time: string;
  bandwidth_mbps?: number;
}

export interface AdminDashboardPayload {
  timezone: string;
  updated_at: number;
  updated_label: string;
  days: number;
  server_id: number;
  filter_servers: { id: number; label: string; region_id: string }[];
  summary: PublicHomePayload["summary"] & {
    costs: { currency: string; monthly_cost: number; balance: number }[];
  };
  health: PublicHomePayload["health"];
  trend: TrendPoint[];
  ecs_nodes: AdminNodeMetric[];
  swas_nodes: AdminNodeMetric[];
  ranking: {
    id: number;
    kind: "ecs" | "swas";
    provider?: repo.SwasProvider;
    name: string;
    region_id: string;
    used_gb: number;
    quota_gb: number;
    today_gb: number;
    percent: number;
    status: string;
    bandwidth_mbps?: number;
  }[];
}

interface ComputedDaily {
  trend: TrendPoint[];
  todayGb: number;
  yesterdayGb: number;
  lastMonthGb: number;
  todayByServer: Map<number, number>;
  monthDaysElapsed: number;
  remainingDays: number;
}

function computeDailyAnalytics(
  samples: repo.ServerTrafficSample[],
  servers: repo.ServerView[],
  tzName: string,
  nowSec: number,
  days: number,
): ComputedDaily {
  const todayInfo = tzDayInfo(tzName, nowSec);
  const todayStr = todayInfo.date;
  const yesterdayStr = shiftDateString(todayStr, -1);
  const monthPrefix = todayStr.slice(0, 7); // YYYY-MM
  const lastMonthYear = todayInfo.month === 1 ? todayInfo.year - 1 : todayInfo.year;
  const lastMonthNum = todayInfo.month === 1 ? 12 : todayInfo.month - 1;
  const lastMonthPrefix = `${String(lastMonthYear).padStart(4, "0")}-${String(lastMonthNum).padStart(2, "0")}`;

  // Group max monthly cumulative reading per (server_id, date).
  const byServerDate = new Map<number, Map<string, number>>();
  for (const s of samples) {
    const dStr = tzDayInfo(tzName, s.ts).date;
    let m = byServerDate.get(s.server_id);
    if (!m) {
      m = new Map<string, number>();
      byServerDate.set(s.server_id, m);
    }
    const prev = m.get(dStr);
    if (prev === undefined || s.used > prev) {
      m.set(dStr, s.used);
    }
  }

  // Inject live snapshot for today if fresher / higher than samples.
  for (const srv of servers) {
    if (srv.traffic_used !== null && srv.traffic_used !== undefined) {
      let m = byServerDate.get(srv.id);
      if (!m) {
        m = new Map<string, number>();
        byServerDate.set(srv.id, m);
      }
      const prev = m.get(todayStr);
      if (prev === undefined || srv.traffic_used > prev) {
        m.set(todayStr, srv.traffic_used);
      }
    }
  }

  // Compute last-month total from the highest reading per server in lastMonthPrefix.
  let lastMonthGb = 0;
  for (const [, dateMap] of byServerDate) {
    let maxLast = 0;
    for (const [d, v] of dateMap) {
      if (d.startsWith(lastMonthPrefix) && v > maxLast) maxLast = v;
    }
    lastMonthGb += maxLast;
  }

  // Compute daily delta per server for every date in [startDate..todayStr] plus yesterday.
  const windowDates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    windowDates.push(shiftDateString(todayStr, -i));
  }
  const allDatesNeeded = new Set<string>([...windowDates, yesterdayStr, todayStr]);

  // For each server, compute cumulative reading at end of each day (carry forward within same month)
  // and daily increment = cur - prevSameMonthDay (or cur on day 01 / first observed day when prior month).
  const dailySumByDate = new Map<string, number>();
  const cumSumByDate = new Map<string, number>();
  const todayByServer = new Map<number, number>();

  for (const srv of servers) {
    const dateMap = byServerDate.get(srv.id);
    if (!dateMap || dateMap.size === 0) {
      todayByServer.set(srv.id, 0);
      continue;
    }

    // Build sorted list of all recorded dates for this server.
    const recorded = Array.from(dateMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));

    // Helper: latest known cumulative value on or before `dateStr` within the SAME YYYY-MM.
    const cumOn = (dateStr: string): number | null => {
      const ym = dateStr.slice(0, 7);
      let latest: number | null = null;
      for (const [d, v] of recorded) {
        if (d > dateStr) break;
        if (d.startsWith(ym)) latest = v;
      }
      return latest;
    };

    const hasRecordOn = (dateStr: string): boolean => dateMap.has(dateStr);

    for (const dStr of allDatesNeeded) {
      const curCum = cumOn(dStr);
      if (curCum !== null) {
        cumSumByDate.set(dStr, (cumSumByDate.get(dStr) ?? 0) + curCum);
      }

      if (!hasRecordOn(dStr) || curCum === null) continue;

      const prevDate = shiftDateString(dStr, -1);
      const sameMonth = prevDate.slice(0, 7) === dStr.slice(0, 7);
      let delta = 0;
      if (!sameMonth) {
        // First day of a new billing month: the monthly counter resets to 0.
        delta = Math.max(0, curCum);
      } else {
        const prevCum = cumOn(prevDate);
        if (prevCum !== null) {
          delta = Math.max(0, curCum - prevCum);
        } else if (recorded[0] && recorded[0][0] === dStr) {
          // Only one day of history exists so far for this server this month:
          // avoid pretending the entire month-to-date happened solely today unless it's the 1st.
          delta = dStr.endsWith("-01") ? Math.max(0, curCum) : 0;
        }
      }

      dailySumByDate.set(dStr, (dailySumByDate.get(dStr) ?? 0) + delta);
      if (dStr === todayStr) {
        todayByServer.set(srv.id, round2(delta));
      }
    }
  }

  const trend: TrendPoint[] = windowDates.map((d) => ({
    date: d,
    short_date: d.slice(5), // MM-DD
    daily_gb: round2(dailySumByDate.get(d) ?? 0),
    cumulative_gb: round2(cumSumByDate.get(d) ?? 0),
  }));

  const totalDaysInMonth = daysInMonth(todayInfo.year, todayInfo.month);
  const monthDaysElapsed = Math.max(1, todayInfo.day);
  const remainingDays = Math.max(0, totalDaysInMonth - todayInfo.day);

  // Keep monthPrefix used for future sanity checks.
  void monthPrefix;

  return {
    trend,
    todayGb: round2(dailySumByDate.get(todayStr) ?? 0),
    yesterdayGb: round2(dailySumByDate.get(yesterdayStr) ?? 0),
    lastMonthGb: round2(lastMonthGb),
    todayByServer,
    monthDaysElapsed,
    remainingDays,
  };
}

function buildSwasSpec(s: repo.SwasServerView): string {
  const parts: string[] = [];
  if (s.cpu > 0 || s.memory_gb > 0) parts.push(`${s.cpu}C ${s.memory_gb}G`);
  if (s.bandwidth_mbps > 0) parts.push(`${s.bandwidth_mbps}M`);
  return parts.join(" · ");
}

/**
 * Build the unauthenticated public status homepage payload.
 * Strictly strips IPs, instance IDs, credentials, remarks, events, and billing.
 */
export async function buildPublicHomePayload(env: Env): Promise<PublicHomePayload> {
  const config = await repo.getSettings(env);
  const tzName = config["timezone"] || "Asia/Shanghai";
  const nowSec = Math.floor(Date.now() / 1000);
  const nowInfo = tzDayInfo(tzName, nowSec);

  const [servers, swasList, samples] = await Promise.all([
    repo.listServers(env),
    repo.listSwasServers(env),
    repo.listAllSamplesSince(env, nowSec - Math.floor((40 * ONE_DAY_MS) / 1000)),
  ]);

  const daily = computeDailyAnalytics(samples, servers, tzName, nowSec, 7);

  const ecsOnline = servers.filter((s) => s.instance_status === "Running").length;
  const swasOnline = swasList.filter((s) => s.instance_status === "Running").length;
  const ecsUsed = round2(servers.reduce((acc, s) => acc + (s.traffic_used ?? 0), 0));
  const ecsQuota = round2(servers.reduce((acc, s) => acc + (s.quota_gb || 0), 0));
  const swasUsed = round2(swasList.reduce((acc, s) => acc + (s.traffic_used_gb || 0), 0));
  const swasQuota = round2(swasList.reduce((acc, s) => acc + (s.traffic_total_gb || 0), 0));

  const totalUsed = round2(ecsUsed + swasUsed);
  const totalQuota = round2(ecsQuota + swasQuota);
  const totalPercent = totalQuota > 0 ? Math.min(100, round2((totalUsed / totalQuota) * 100)) : 0;

  const avgDailyGb = round2(ecsUsed / daily.monthDaysElapsed);
  const projectedMonthGb = round2(ecsUsed + avgDailyGb * daily.remainingDays);

  const health = { safe: 0, warning: 0, critical: 0, stopped: 0 };

  const ecsNodes: PublicNodeItem[] = servers.map((s) => {
    const used = round2(s.traffic_used ?? 0);
    const quota = round2(s.quota_gb || 0);
    const pct = quota > 0 ? Math.min(100, round2((used / quota) * 100)) : 0;
    const h = ecsHealthLevel(s);
    health[h] += 1;
    return {
      kind: "ecs",
      name: s.label || "ECS 节点",
      region_id: s.region_id,
      status: s.instance_status || "Unknown",
      used_gb: used,
      quota_gb: quota,
      threshold_gb: round2(s.threshold_gb || 0),
      percent: pct,
      today_gb: daily.todayByServer.get(s.id) ?? 0,
      health: h,
      spec_summary: "CDT 弹性云服务器",
    };
  });

  const swasNodes: PublicNodeItem[] = swasList.map((s) => {
    const used = round2(s.traffic_used_gb || 0);
    const quota = round2(s.traffic_total_gb || 0);
    const pct = quota > 0 ? Math.min(100, round2((used / quota) * 100)) : 0;
    const h = swasHealthLevel(s);
    health[h] += 1;
    return {
      kind: "swas",
      provider: s.provider,
      name: s.label || "轻量节点",
      region_id: s.region_id,
      status: s.instance_status || "Unknown",
      used_gb: used,
      quota_gb: quota,
      threshold_gb: 0,
      percent: pct,
      today_gb: 0,
      health: h,
      spec_summary:
        buildSwasSpec(s) || (s.provider === "tencent" ? "腾讯云轻量" : "阿里云轻量"),
      bandwidth_mbps: s.bandwidth_mbps || 0,
    };
  });

  const nodes = [...ecsNodes, ...swasNodes];
  const ranking = [...nodes]
    .sort((a, b) => b.used_gb - a.used_gb)
    .slice(0, 10)
    .map((n) => ({
      kind: n.kind,
      ...(n.provider ? { provider: n.provider } : {}),
      name: n.name,
      region_id: n.region_id,
      used_gb: n.used_gb,
      quota_gb: n.quota_gb,
      percent: n.percent,
      status: n.status,
      ...(n.bandwidth_mbps ? { bandwidth_mbps: n.bandwidth_mbps } : {}),
    }));

  return {
    brand: BRAND,
    site_title: (config["public_site_title"] || "").trim() || "CDT 云节点流量遥测",
    site_subtitle:
      (config["public_site_subtitle"] || "").trim() ||
      "阿里云 ECS · 阿里云 / 腾讯云轻量应用服务器实时在线状态与月度流量配额观察站",
    timezone: tzName,
    updated_at: nowSec,
    updated_label: nowInfo.label,
    summary: {
      total_nodes: servers.length + swasList.length,
      online_nodes: ecsOnline + swasOnline,
      ecs_total: servers.length,
      ecs_online: ecsOnline,
      swas_total: swasList.length,
      swas_online: swasOnline,
      total_used_gb: totalUsed,
      total_quota_gb: totalQuota,
      total_percent: totalPercent,
      ecs_used_gb: ecsUsed,
      ecs_quota_gb: ecsQuota,
      swas_used_gb: swasUsed,
      swas_quota_gb: swasQuota,
      today_gb: daily.todayGb,
      yesterday_gb: daily.yesterdayGb,
      day_delta_pct: calcDeltaPct(daily.todayGb, daily.yesterdayGb),
      month_gb: ecsUsed,
      last_month_gb: daily.lastMonthGb,
      month_delta_pct: calcDeltaPct(ecsUsed, daily.lastMonthGb),
      avg_daily_gb: avgDailyGb,
      projected_month_gb: projectedMonthGb,
      remaining_days: daily.remainingDays,
    },
    health,
    trend: daily.trend,
    nodes,
    ranking,
  };
}

/**
 * Build the authenticated admin telemetry dashboard payload with filterable
 * time range (`days`: 7 | 14 | 30), optional single-ECS focus, threshold
 * exhaustion estimates, and multi-currency monthly billing summary.
 */
export async function buildAdminDashboardPayload(
  env: Env,
  opts: { days?: number; serverId?: number } = {},
): Promise<AdminDashboardPayload> {
  const days = opts.days === 14 || opts.days === 30 ? opts.days : 7;
  const serverId = opts.serverId && opts.serverId > 0 ? opts.serverId : 0;

  const config = await repo.getSettings(env);
  const tzName = config["timezone"] || "Asia/Shanghai";
  const nowSec = Math.floor(Date.now() / 1000);
  const nowInfo = tzDayInfo(tzName, nowSec);

  const [allServers, swasList, samples] = await Promise.all([
    repo.listServers(env),
    repo.listSwasServers(env),
    repo.listAllSamplesSince(
      env,
      nowSec - Math.floor((Math.max(days + 2, 40) * ONE_DAY_MS) / 1000),
      serverId,
    ),
  ]);

  const scopedServers = serverId > 0 ? allServers.filter((s) => s.id === serverId) : allServers;
  const daily = computeDailyAnalytics(samples, scopedServers, tzName, nowSec, days);

  const ecsOnline = scopedServers.filter((s) => s.instance_status === "Running").length;
  const swasOnline = swasList.filter((s) => s.instance_status === "Running").length;
  const ecsUsed = round2(scopedServers.reduce((acc, s) => acc + (s.traffic_used ?? 0), 0));
  const ecsQuota = round2(scopedServers.reduce((acc, s) => acc + (s.quota_gb || 0), 0));
  const swasUsed = round2(swasList.reduce((acc, s) => acc + (s.traffic_used_gb || 0), 0));
  const swasQuota = round2(swasList.reduce((acc, s) => acc + (s.traffic_total_gb || 0), 0));

  const totalUsed = serverId > 0 ? ecsUsed : round2(ecsUsed + swasUsed);
  const totalQuota = serverId > 0 ? ecsQuota : round2(ecsQuota + swasQuota);
  const totalPercent = totalQuota > 0 ? Math.min(100, round2((totalUsed / totalQuota) * 100)) : 0;

  const avgDailyGb = round2(ecsUsed / daily.monthDaysElapsed);
  const projectedMonthGb = round2(ecsUsed + avgDailyGb * daily.remainingDays);

  const health = { safe: 0, warning: 0, critical: 0, stopped: 0 };

  const ecsNodes: AdminNodeMetric[] = scopedServers.map((s) => {
    const used = round2(s.traffic_used ?? 0);
    const quota = round2(s.quota_gb || 0);
    const threshold = round2(s.threshold_gb || 0);
    const pct = quota > 0 ? Math.min(100, round2((used / quota) * 100)) : 0;
    const nodeAvg = round2(used / daily.monthDaysElapsed);
    const nodeProjected = round2(used + nodeAvg * daily.remainingDays);
    let daysToThreshold: number | null = null;
    if (threshold > 0) {
      if (used >= threshold) {
        daysToThreshold = 0;
      } else if (nodeAvg > 0.05) {
        daysToThreshold = Math.ceil((threshold - used) / nodeAvg);
      }
    }
    const h = ecsHealthLevel(s);
    health[h] += 1;
    return {
      id: s.id,
      kind: "ecs",
      label: s.label || s.instance_id,
      instance_id: s.instance_id,
      region_id: s.region_id,
      public_ip: s.public_ip || "",
      status: s.instance_status || "Unknown",
      used_gb: used,
      quota_gb: quota,
      threshold_gb: threshold,
      percent: pct,
      today_gb: daily.todayByServer.get(s.id) ?? 0,
      avg_daily_gb: nodeAvg,
      projected_gb: nodeProjected,
      days_to_threshold: daysToThreshold,
      health: h,
      spec_summary: "ECS · CDT",
      expired_time: "",
    };
  });

  const swasNodes: AdminNodeMetric[] = swasList.map((s) => {
    const used = round2(s.traffic_used_gb || 0);
    const quota = round2(s.traffic_total_gb || 0);
    const pct = quota > 0 ? Math.min(100, round2((used / quota) * 100)) : 0;
    const h = swasHealthLevel(s);
    if (serverId === 0) health[h] += 1;
    return {
      id: s.id,
      kind: "swas",
      provider: s.provider,
      label: s.label || s.instance_id,
      instance_id: s.instance_id,
      region_id: s.region_id,
      public_ip: s.public_ip || "",
      status: s.instance_status || "Unknown",
      used_gb: used,
      quota_gb: quota,
      threshold_gb: 0,
      percent: pct,
      today_gb: 0,
      avg_daily_gb: round2(used / daily.monthDaysElapsed),
      projected_gb: round2(used + (used / daily.monthDaysElapsed) * daily.remainingDays),
      days_to_threshold: null,
      health: h,
      spec_summary:
        buildSwasSpec(s) || (s.provider === "tencent" ? "腾讯云轻量" : "阿里云轻量"),
      expired_time: s.expired_time || "",
      bandwidth_mbps: s.bandwidth_mbps || 0,
    };
  });

  // Aggregate monthly billing across unique (provider, access_key_id, site) tuples to avoid
  // double counting accounts that own multiple instances.
  const seenAccountCost = new Set<string>();
  const costByCurrency = new Map<string, { monthly_cost: number; balance: number }>();
  const accumulateBilling = (
    provider: string,
    ak: string,
    site: string,
    b: ReturnType<typeof billing.summaryOf>,
  ) => {
    if (!b || b.stale) return;
    const dedupKey = `${provider}:${ak}:${site}:${b.currency || "CNY"}`;
    if (seenAccountCost.has(dedupKey)) return;
    seenAccountCost.add(dedupKey);
    const cur = b.currency || "CNY";
    const entry = costByCurrency.get(cur) ?? { monthly_cost: 0, balance: 0 };
    if (b.monthly_cost !== null) entry.monthly_cost += b.monthly_cost;
    if (b.balance !== null) entry.balance += b.balance;
    costByCurrency.set(cur, entry);
  };
  for (const s of scopedServers) {
    accumulateBilling("aliyun", s.access_key_id, s.site, billing.summaryOf(s, config));
  }
  if (serverId === 0) {
    for (const s of swasList) {
      accumulateBilling(s.provider, s.access_key_id, s.site, billing.summaryOf(s, config));
    }
  }
  const costs = Array.from(costByCurrency.entries()).map(([currency, v]) => ({
    currency,
    monthly_cost: round2(v.monthly_cost),
    balance: round2(v.balance),
  }));

  const combinedForRank = serverId > 0 ? ecsNodes : [...ecsNodes, ...swasNodes];
  const ranking = [...combinedForRank]
    .sort((a, b) => b.used_gb - a.used_gb)
    .slice(0, 12)
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      ...(n.provider ? { provider: n.provider } : {}),
      name: n.label,
      region_id: n.region_id,
      used_gb: n.used_gb,
      quota_gb: n.quota_gb,
      today_gb: n.today_gb,
      percent: n.percent,
      status: n.status,
      ...(n.bandwidth_mbps ? { bandwidth_mbps: n.bandwidth_mbps } : {}),
    }));

  return {
    timezone: tzName,
    updated_at: nowSec,
    updated_label: nowInfo.label,
    days,
    server_id: serverId,
    filter_servers: allServers.map((s) => ({
      id: s.id,
      label: s.label || s.instance_id,
      region_id: s.region_id,
    })),
    summary: {
      total_nodes: serverId > 0 ? scopedServers.length : scopedServers.length + swasList.length,
      online_nodes: serverId > 0 ? ecsOnline : ecsOnline + swasOnline,
      ecs_total: scopedServers.length,
      ecs_online: ecsOnline,
      swas_total: serverId > 0 ? 0 : swasList.length,
      swas_online: serverId > 0 ? 0 : swasOnline,
      total_used_gb: totalUsed,
      total_quota_gb: totalQuota,
      total_percent: totalPercent,
      ecs_used_gb: ecsUsed,
      ecs_quota_gb: ecsQuota,
      swas_used_gb: serverId > 0 ? 0 : swasUsed,
      swas_quota_gb: serverId > 0 ? 0 : swasQuota,
      today_gb: daily.todayGb,
      yesterday_gb: daily.yesterdayGb,
      day_delta_pct: calcDeltaPct(daily.todayGb, daily.yesterdayGb),
      month_gb: ecsUsed,
      last_month_gb: daily.lastMonthGb,
      month_delta_pct: calcDeltaPct(ecsUsed, daily.lastMonthGb),
      avg_daily_gb: avgDailyGb,
      projected_month_gb: projectedMonthGb,
      remaining_days: daily.remainingDays,
      costs,
    },
    health,
    trend: daily.trend,
    ecs_nodes: ecsNodes,
    swas_nodes: swasNodes,
    ranking,
  };
}
