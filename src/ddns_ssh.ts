/**
 * Interactive Web SSH bridge for DDNS IP monitors running on Cloudflare Workers.
 *
 * Transport architecture:
 *   Browser (xterm.js) <-- WSS JSON frames --> Worker (`WebSocketPair`)
 *     <-- `ssh2` Client (CTR ciphers first to avoid workerd#8123 GCM bug) -->
 *     `cloudflare:sockets` outbound TCP socket --> Target server sshd
 *
 * Security (R.A.I.L.G.U.A.R.D.):
 * - Admin session cookie is verified before upgrade (`api.ts`).
 * - Same-origin WebSocket check blocks cross-site WebSocket hijacking (CSWSH).
 * - Target host is strictly taken from the saved DDNS IP monitor record (never
 *   arbitrary user-supplied host) and screened against private/loopback/link-local
 *   ranges and blocked port 25 to prevent SSRF.
 * - Credentials travel only inside the first WSS auth message (never URL query),
 *   and optional persisted secrets are encrypted at rest via AES-GCM in D1.
 */

import { Duplex } from "node:stream";
import { Buffer } from "node:buffer";
import { Client as SshClient, type ClientChannel, type ConnectConfig } from "ssh2";
import type { Env } from "./env";
import * as messages from "./messages";
import * as repo from "./repo";
import type { DdnsIpMonitorRecord, DdnsIpSshAuthType } from "./repo";

export interface SshSocketFactoryResult {
  stream: Duplex;
  close: () => void;
}

export type SshSocketFactory = (
  host: string,
  port: number,
) => SshSocketFactoryResult | Promise<SshSocketFactoryResult>;

interface ClientAuthMsg {
  type: "auth";
  port?: number;
  username?: string;
  auth_type?: DdnsIpSshAuthType;
  secret?: string;
  passphrase?: string;
  use_saved?: boolean;
  save?: boolean;
  cols?: number;
  rows?: number;
}

interface ClientInputMsg {
  type: "input";
  data: string;
}

interface ClientResizeMsg {
  type: "resize";
  cols: number;
  rows: number;
}

interface ClientPingMsg {
  type: "ping";
}

type ClientWsMessage = ClientAuthMsg | ClientInputMsg | ClientResizeMsg | ClientPingMsg;

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Validate SSH target host and port against SSRF and Workers socket limits.
 * Throws a user-facing error message if disallowed.
 */
export function validateSshTarget(
  rawHost: string,
  rawPort: number,
  opts?: { allowLoopbackForTest?: boolean },
): { host: string; port: number } {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) {
    throw new Error("该节点尚无公网 IPv4 或域名，请先完成绑定或等待首次上报");
  }
  const port = Math.trunc(Number(rawPort));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SSH 端口必须在 1–65535 之间");
  }
  if (port === 25) {
    throw new Error("Cloudflare Workers 不允许连接 25 端口");
  }
  if (opts?.allowLoopbackForTest) {
    return { host, port };
  }

  // Block localhost & private DNS suffixes.
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "::1" ||
    host === "::" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd")
  ) {
    throw new Error("安全策略禁止通过远程终端连接回环或内网地址");
  }

  const m = IPV4_RE.exec(host);
  if (m) {
    const [a, b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (a > 255 || b > 255 || c > 255 || d > 255) {
      throw new Error("无效的目标 IPv4 地址");
    }
    const blocked =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224;
    if (blocked) {
      throw new Error(`安全策略禁止通过远程终端连接内网或保留 IP（${host}）`);
    }
  }
  return { host, port };
}

/**
 * Wrap a Cloudflare Workers `cloudflare:sockets` TCP Socket as a Node.js Duplex
 * stream compatible with `ssh2`'s `Client.connect({ sock })`.
 */
async function createCloudflareSocketDuplex(
  host: string,
  port: number,
): Promise<SshSocketFactoryResult> {
  const { connect: cfConnect } = await import("cloudflare:sockets");
  const cfSocket = cfConnect({ hostname: host, port }, { secureTransport: "off", allowHalfOpen: false });
  const reader = cfSocket.readable.getReader();
  const writer = cfSocket.writable.getWriter();
  let pumpStarted = false;
  let closed = false;

  const duplex = new Duplex({
    read() {
      if (pumpStarted || closed) return;
      pumpStarted = true;
      void (async () => {
        try {
          while (!closed) {
            const { value, done } = await reader.read();
            if (done) {
              duplex.push(null);
              break;
            }
            if (value && value.byteLength > 0) {
              duplex.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
            }
          }
        } catch (err) {
          if (!closed) {
            duplex.destroy(err instanceof Error ? err : new Error(String(err)));
          }
        }
      })();
    },
    write(chunk, _encoding, callback) {
      if (closed) {
        callback(new Error("TCP socket already closed"));
        return;
      }
      const bytes =
        chunk instanceof Uint8Array
          ? chunk
          : Buffer.isBuffer(chunk)
            ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
            : new TextEncoder().encode(String(chunk));
      writer
        .write(bytes)
        .then(() => callback())
        .catch((err) => callback(err instanceof Error ? err : new Error(String(err))));
    },
    final(callback) {
      writer
        .close()
        .then(() => callback())
        .catch(() => callback());
    },
    destroy(err, callback) {
      closed = true;
      void reader.cancel().catch(() => {});
      void writer.abort().catch(() => {});
      void cfSocket.close().catch(() => {});
      callback(err);
    },
  });

  // `ssh2` checks optional net.Socket helpers like setKeepAlive / setNoDelay / setTimeout.
  const sockLike = duplex as unknown as Record<string, unknown>;
  sockLike.setKeepAlive = () => duplex;
  sockLike.setNoDelay = () => duplex;
  sockLike.setTimeout = () => duplex;
  sockLike.ref = () => duplex;
  sockLike.unref = () => duplex;

  cfSocket.closed.catch((err) => {
    if (!closed) {
      closed = true;
      duplex.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  });

  return {
    stream: duplex,
    close: () => {
      if (closed) return;
      closed = true;
      void reader.cancel().catch(() => {});
      void writer.abort().catch(() => {});
      void cfSocket.close().catch(() => {});
      duplex.destroy();
    },
  };
}

function clampDim(val: unknown, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(val));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sendWsJson(ws: WebSocket, payload: Record<string, unknown>): void {
  try {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
    }
  } catch {
    // Ignore sends on closing socket
  }
}

function formatSshError(err: unknown, host: string, port: number): string {
  const raw = err instanceof Error ? err.message : String(err);
  const low = raw.toLowerCase();
  if (low.includes("all configured authentication methods failed")) {
    return "SSH 身份认证失败：请检查用户名、密码或私钥（及私钥口令）是否正确";
  }
  if (low.includes("timed out") || low.includes("timeout")) {
    return `连接 ${host}:${port} 超时：请确认服务器 SSH 服务已启动、端口正确且防火墙/路由器已放行外网入站`;
  }
  if (low.includes("cannot parse privatekey") || low.includes("unsupported key")) {
    return `无法解析 SSH 私钥（请确认粘贴了完整的 OpenSSH / PEM 私钥，加密私钥需填写正确口令）：${raw}`;
  }
  if (low.includes("refused") || low.includes("reset") || low.includes("proxy request failed")) {
    return `无法建立到 ${host}:${port} 的 TCP 连接：${raw}（若目标经过 Cloudflare 代理小云朵，Workers 无法直连 Cloudflare IP，请使用直连公网 IPv4）`;
  }
  return raw;
}

/**
 * Attach an interactive `ssh2` session to an accepted server-side WebSocket.
 * Separated from `WebSocketPair` creation so unit/E2E tests can run the exact
 * same bridge in Node against a real local `ssh2.Server`.
 */
export function attachSshSessionToWebSocket(
  ws: WebSocket,
  env: Env,
  monitor: DdnsIpMonitorRecord,
  opts?: {
    socketFactory?: SshSocketFactory;
    allowLoopbackForTest?: boolean;
  },
): void {
  const socketFactory = opts?.socketFactory ?? createCloudflareSocketDuplex;
  let started = false;
  let cleanedUp = false;
  let sshClient: SshClient | null = null;
  let shellStream: ClientChannel | null = null;
  let tcpHandle: SshSocketFactoryResult | null = null;
  let authTimeout: ReturnType<typeof setTimeout> | null = null;

  const cleanup = (closeWs = false, closeCode = 1000, closeReason = "session ended") => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (authTimeout) {
      clearTimeout(authTimeout);
      authTimeout = null;
    }
    try {
      shellStream?.close();
    } catch {}
    shellStream = null;
    try {
      sshClient?.end();
    } catch {}
    sshClient = null;
    try {
      tcpHandle?.close();
    } catch {}
    tcpHandle = null;
    if (closeWs) {
      try {
        ws.close(closeCode, closeReason.slice(0, 120));
      } catch {}
    }
  };

  // Require the client to send the auth frame within 20s of WS open.
  authTimeout = setTimeout(() => {
    if (!started && !cleanedUp) {
      sendWsJson(ws, { type: "error", message: "等待 SSH 登录凭据超时，连接已关闭" });
      cleanup(true, 1008, "auth timeout");
    }
  }, 20_000);

  const handleAuth = async (msg: ClientAuthMsg) => {
    if (started) return;
    started = true;
    if (authTimeout) {
      clearTimeout(authTimeout);
      authTimeout = null;
    }

    // Prefer direct public IPv4 reported by the agent so Cloudflare proxied domains
    // don't hit Cloudflare's blocked outbound-to-CF-IP restriction.
    const rawHost = (monitor.current_ip || monitor.resolved_ip || monitor.fqdn).trim();
    let target: { host: string; port: number };
    try {
      target = validateSshTarget(rawHost, msg.port ?? monitor.ssh_port ?? 22, {
        allowLoopbackForTest: opts?.allowLoopbackForTest,
      });
    } catch (err) {
      sendWsJson(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
      cleanup(true, 1008, "invalid target");
      return;
    }

    const username = String(msg.username ?? monitor.ssh_username ?? "root").trim();
    if (!username || username.length > 64 || /[\r\n\0]/.test(username)) {
      sendWsJson(ws, { type: "error", message: "请输入有效的 SSH 用户名" });
      cleanup(true, 1008, "invalid username");
      return;
    }

    const authType: DdnsIpSshAuthType =
      msg.auth_type === "private_key" ? "private_key" : "password";
    const cols = clampDim(msg.cols, 100, 20, 400);
    const rows = clampDim(msg.rows, 30, 8, 200);

    // Resolve secret & passphrase: explicit input overrides saved encrypted D1 profile.
    let secret = typeof msg.secret === "string" ? msg.secret : "";
    let passphrase = typeof msg.passphrase === "string" ? msg.passphrase : "";
    if (!secret && msg.use_saved !== false && monitor.has_ssh_secret) {
      secret = monitor.ssh_secret;
      if (!passphrase && monitor.has_ssh_passphrase) {
        passphrase = monitor.ssh_passphrase;
      }
    }

    if (!secret) {
      sendWsJson(ws, {
        type: "error",
        message: authType === "private_key" ? "请提供 SSH 私钥" : "请提供 SSH 登录密码",
      });
      cleanup(true, 1008, "missing credentials");
      return;
    }

    sendWsJson(ws, {
      type: "status",
      state: "connecting",
      message: `正在连接 ${username}@${target.host}:${target.port}…`,
    });

    try {
      tcpHandle = await socketFactory(target.host, target.port);
    } catch (err) {
      sendWsJson(ws, { type: "error", message: formatSshError(err, target.host, target.port) });
      cleanup(true, 1011, "tcp connect failed");
      return;
    }

    const client = new SshClient();
    sshClient = client;
    const outDecoder = new TextDecoder("utf-8");
    const errDecoder = new TextDecoder("utf-8");
    let connectedOk = false;

    client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
      if (authType === "password") {
        finish(prompts.map(() => secret));
      } else {
        finish(prompts.map(() => passphrase || ""));
      }
    });

    client.on("ready", () => {
      connectedOk = true;
      // Persist encrypted credentials only after SSH authentication actually succeeds.
      if (msg.save) {
        void repo
          .updateDdnsIpSshConfig(env, monitor.id, {
            ssh_port: target.port,
            ssh_username: username,
            ssh_auth_type: authType,
            ...(typeof msg.secret === "string" && msg.secret.length > 0
              ? { ssh_secret: msg.secret }
              : {}),
            ...(typeof msg.passphrase === "string" && msg.passphrase.length > 0
              ? { ssh_passphrase: msg.passphrase }
              : {}),
          })
          .catch((e) => console.warn("Failed to persist encrypted SSH profile", e));
      }

      void repo
        .addEvent(
          env,
          "dns",
          messages.ev("DDNS IP 远程终端已连接", messages.objServer(monitor.fqdn)),
          { detail: `${username}@${target.host}:${target.port}` },
        )
        .catch(() => {});

      client.shell({ term: "xterm-256color", cols, rows }, (err, stream) => {
        if (err) {
          sendWsJson(ws, { type: "error", message: `无法启动远端 Shell：${err.message}` });
          cleanup(true, 1011, "shell failed");
          return;
        }
        shellStream = stream;
        sendWsJson(ws, {
          type: "status",
          state: "connected",
          message: `已连接 ${username}@${target.host}:${target.port}`,
        });

        stream.on("data", (chunk: Buffer) => {
          const text = outDecoder.decode(chunk, { stream: true });
          if (text) sendWsJson(ws, { type: "output", data: text });
        });
        stream.stderr?.on("data", (chunk: Buffer) => {
          const text = errDecoder.decode(chunk, { stream: true });
          if (text) sendWsJson(ws, { type: "output", data: text });
        });
        stream.on("close", () => {
          const tail = outDecoder.decode();
          if (tail) sendWsJson(ws, { type: "output", data: tail });
          sendWsJson(ws, { type: "status", state: "closed", message: "远端会话已结束" });
          cleanup(true, 1000, "remote closed");
        });
      });
    });

    client.on("error", (err) => {
      sendWsJson(ws, {
        type: "error",
        message: formatSshError(err, target.host, target.port),
      });
      cleanup(true, 1011, "ssh error");
    });

    client.on("close", () => {
      if (!cleanedUp) {
        sendWsJson(ws, {
          type: "status",
          state: "closed",
          message: connectedOk ? "SSH 连接已断开" : "SSH 连接已关闭",
        });
        cleanup(true, 1000, "ssh closed");
      }
    });

    const connectCfg: ConnectConfig = {
      sock: tcpHandle.stream,
      username,
      readyTimeout: 15_000,
      keepaliveInterval: 20_000,
      keepaliveCountMax: 3,
      tryKeyboard: authType === "password",
      // Prefer CTR ciphers ahead of GCM to avoid Cloudflare workerd#8123
      // (`node:crypto` GCM decipher requiring `setAuthTag` before `update`).
      algorithms: {
        cipher: [
          "aes256-ctr",
          "aes128-ctr",
          "aes192-ctr",
          "aes128-gcm@openssh.com",
          "aes256-gcm@openssh.com",
        ],
        serverHostKey: [
          "ssh-ed25519",
          "ecdsa-sha2-nistp256",
          "ecdsa-sha2-nistp384",
          "ecdsa-sha2-nistp521",
          "rsa-sha2-512",
          "rsa-sha2-256",
          "ssh-rsa",
        ],
      },
      ...(authType === "private_key"
        ? {
            privateKey: secret,
            ...(passphrase ? { passphrase } : {}),
          }
        : {
            password: secret,
          }),
    };

    try {
      client.connect(connectCfg);
    } catch (err) {
      sendWsJson(ws, { type: "error", message: formatSshError(err, target.host, target.port) });
      cleanup(true, 1011, "ssh init failed");
    }
  };

  ws.addEventListener("message", (ev) => {
    if (cleanedUp) return;
    if (typeof ev.data !== "string") return;
    let parsed: ClientWsMessage;
    try {
      parsed = JSON.parse(ev.data) as ClientWsMessage;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    if (parsed.type === "ping") {
      sendWsJson(ws, { type: "pong" });
      return;
    }
    if (parsed.type === "auth") {
      void handleAuth(parsed);
      return;
    }
    if (parsed.type === "input" && typeof parsed.data === "string" && shellStream) {
      shellStream.write(parsed.data);
      return;
    }
    if (parsed.type === "resize" && shellStream) {
      const cols = clampDim(parsed.cols, 100, 20, 400);
      const rows = clampDim(parsed.rows, 30, 8, 200);
      try {
        shellStream.setWindow(rows, cols, 0, 0);
      } catch {}
    }
  });

  ws.addEventListener("close", () => cleanup(false));
  ws.addEventListener("error", () => cleanup(false));
}

/**
 * Create a Cloudflare Workers `WebSocketPair` response for an authenticated
 * DDNS IP remote SSH terminal request.
 */
export function upgradeDdnsIpSshWebSocket(
  request: Request,
  env: Env,
  monitor: DdnsIpMonitorRecord,
): Response {
  const upgrade = (request.headers.get("upgrade") ?? "").toLowerCase();
  if (upgrade !== "websocket") {
    return new Response(JSON.stringify({ message: "Expected WebSocket upgrade" }), {
      status: 426,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Same-origin check against Cross-Site WebSocket Hijacking (CSWSH).
  const originHeader = request.headers.get("origin");
  if (originHeader) {
    try {
      const reqOrigin = new URL(request.url).origin;
      const clientOrigin = new URL(originHeader).origin;
      if (reqOrigin !== clientOrigin) {
        return new Response(JSON.stringify({ message: "禁止跨站 WebSocket 连接" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
    } catch {
      return new Response(JSON.stringify({ message: "非法的 Origin 请求头" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  attachSshSessionToWebSocket(server, env, monitor);
  return new Response(null, { status: 101, webSocket: client });
}
