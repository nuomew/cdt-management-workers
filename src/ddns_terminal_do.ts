/**
 * Cloudflare SQLite-backed Durable Object acting as the rendezvous relay
 * between a remote DDNS IP server's reverse WebSocket PTY agent and an
 * authenticated admin browser running xterm.js.
 *
 * Uses the WebSocket Hibernation API (`ctx.acceptWebSocket` +
 * `setWebSocketAutoResponse`) so idle agent connections cost virtually zero
 * compute duration and stay well within Cloudflare Workers Free plan limits.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

interface AgentAttachment {
  role: "agent";
  version: string;
  connectedAt: number;
}

interface ClientAttachment {
  role: "client";
  sid: string;
  connectedAt: number;
}

type WsAttachment = AgentAttachment | ClientAttachment;

function safeJsonSend(ws: WebSocket, payload: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // Ignore sends on closing/closed hibernated sockets
  }
}

function generateSessionId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function clampDim(val: unknown, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(val));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export class DdnsTerminalHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Protocol-level lightweight keepalive handled without waking the DO.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  private getAgentSocket(): WebSocket | null {
    const list = this.ctx.getWebSockets("agent");
    return list[list.length - 1] ?? null;
  }

  private getClientBySid(sid: string): WebSocket | null {
    const list = this.ctx.getWebSockets(`sid:${sid}`);
    return list[0] ?? null;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/status") {
      const agents = this.ctx.getWebSockets("agent");
      const latest = agents.length > 0 ? agents[agents.length - 1] : null;
      const att = latest?.deserializeAttachment() as AgentAttachment | null;
      return new Response(
        JSON.stringify({
          agent_online: agents.length > 0,
          agent_count: agents.length,
          agent_version: att?.version ?? "",
          connected_at: att?.connectedAt ?? 0,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.pathname === "/kick-agent") {
      for (const ws of this.ctx.getWebSockets("agent")) {
        try {
          ws.close(4001, "token rotated or monitor deleted");
        } catch {}
      }
      for (const ws of this.ctx.getWebSockets("client")) {
        safeJsonSend(ws, {
          type: "status",
          state: "closed",
          message: "节点密钥已重置或已删除，反向终端连接已断开",
        });
        try {
          ws.close(1000, "agent kicked");
        } catch {}
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const upgrade = (request.headers.get("upgrade") ?? "").toLowerCase();
    if (upgrade !== "websocket") {
      return new Response(JSON.stringify({ message: "Expected WebSocket upgrade" }), {
        status: 426,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/agent") {
      // Replace any stale agent sockets so a reconnecting host never leaks duplicates.
      for (const old of this.ctx.getWebSockets("agent")) {
        try {
          old.close(1000, "replaced by newer agent connection");
        } catch {}
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const version = (url.searchParams.get("v") ?? "").trim().slice(0, 16);
      this.ctx.acceptWebSocket(server, ["agent"]);
      const att: AgentAttachment = {
        role: "agent",
        version,
        connectedAt: Math.floor(Date.now() / 1000),
      };
      server.serializeAttachment(att);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/client") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const sid = generateSessionId();
      this.ctx.acceptWebSocket(server, ["client", `sid:${sid}`]);
      const att: ClientAttachment = {
        role: "client",
        sid,
        connectedAt: Math.floor(Date.now() / 1000),
      };
      server.serializeAttachment(att);

      const agent = this.getAgentSocket();
      if (!agent) {
        safeJsonSend(server, {
          type: "error",
          code: "agent_offline",
          message:
            "该服务器的免密反向终端 Agent 当前未在线。请在目标服务器重新执行一次新版「一键安装命令」（需要系统装有 python3），或切换上方「直连 SSH」使用端口密码登录。",
        });
      } else {
        safeJsonSend(server, {
          type: "status",
          state: "agent_ready",
          message: "反向终端通道已就绪，正在分配 Shell…",
        });
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not Found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    if (message === "ping") {
      try {
        ws.send("pong");
      } catch {}
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(message) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;

    const att = ws.deserializeAttachment() as WsAttachment | null;
    if (!att) return;

    if (att.role === "client") {
      const msgType = String(parsed["type"] ?? "");
      if (msgType === "ping") {
        safeJsonSend(ws, { type: "pong" });
        return;
      }
      const agent = this.getAgentSocket();
      if (!agent) {
        safeJsonSend(ws, {
          type: "error",
          code: "agent_offline",
          message: "服务器反向终端 Agent 已离线",
        });
        return;
      }
      if (msgType === "open") {
        const cols = clampDim(parsed["cols"], 100, 20, 400);
        const rows = clampDim(parsed["rows"], 30, 8, 200);
        safeJsonSend(agent, { type: "open", sid: att.sid, cols, rows });
        return;
      }
      if (msgType === "input" && typeof parsed["data"] === "string") {
        safeJsonSend(agent, { type: "input", sid: att.sid, data: parsed["data"] });
        return;
      }
      if (msgType === "resize") {
        const cols = clampDim(parsed["cols"], 100, 20, 400);
        const rows = clampDim(parsed["rows"], 30, 8, 200);
        safeJsonSend(agent, { type: "resize", sid: att.sid, cols, rows });
      }
      return;
    }

    if (att.role === "agent") {
      const msgType = String(parsed["type"] ?? "");
      if (msgType === "ping") {
        safeJsonSend(ws, { type: "pong" });
        return;
      }
      const sid = typeof parsed["sid"] === "string" ? parsed["sid"] : "";
      if (!sid) return;
      const targetClient = this.getClientBySid(sid);
      if (!targetClient) {
        // Tell the agent to reap any orphaned PTY whose browser already left.
        if (msgType === "output" || msgType === "ready") {
          safeJsonSend(ws, { type: "close", sid });
        }
        return;
      }
      if (msgType === "ready") {
        safeJsonSend(targetClient, {
          type: "status",
          state: "connected",
          message:
            typeof parsed["message"] === "string" && parsed["message"]
              ? parsed["message"]
              : "已通过免密监控隧道接入服务器终端",
        });
        return;
      }
      if (msgType === "output" && typeof parsed["data"] === "string") {
        safeJsonSend(targetClient, { type: "output", data: parsed["data"] });
        return;
      }
      if (msgType === "exit") {
        safeJsonSend(targetClient, {
          type: "status",
          state: "closed",
          message:
            typeof parsed["message"] === "string" && parsed["message"]
              ? parsed["message"]
              : "远端 Shell 已退出",
        });
        try {
          targetClient.close(1000, "remote shell exited");
        } catch {}
        return;
      }
      if (msgType === "error") {
        safeJsonSend(targetClient, {
          type: "error",
          message:
            typeof parsed["message"] === "string" && parsed["message"]
              ? parsed["message"]
              : "远端终端发生异常",
        });
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.handleSocketGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.handleSocketGone(ws);
  }

  private handleSocketGone(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as WsAttachment | null;
    if (!att) return;

    if (att.role === "client") {
      const agent = this.getAgentSocket();
      if (agent) {
        safeJsonSend(agent, { type: "close", sid: att.sid });
      }
      return;
    }

    if (att.role === "agent") {
      // Only notify browsers if no replacement agent socket is currently attached.
      const remaining = this.ctx.getWebSockets("agent").filter((s) => s !== ws);
      if (remaining.length === 0) {
        for (const client of this.ctx.getWebSockets("client")) {
          safeJsonSend(client, {
            type: "status",
            state: "closed",
            message: "服务器反向终端 Agent 已断开连接，等待重连…",
          });
          try {
            client.close(1001, "agent disconnected");
          } catch {}
        }
      }
    }
  }
}
