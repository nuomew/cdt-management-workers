/**
 * Zero-dependency Python 3 reverse WebSocket PTY agent generator.
 *
 * Uses only the Python 3 standard library (`ssl`, `socket`, `pty`, `fcntl`,
 * `termios`, `select`, `codecs`, `json`, `hashlib`, `base64`, `os`, `signal`)
 * so it runs out of the box on Debian, Ubuntu, CentOS/Rocky, Alpine, Armbian,
 * and most Linux servers without `pip install`.
 */

export const DDNS_AGENT_VERSION = "3";

/**
 * Render the standalone Python 3 reverse WebSocket PTY daemon script.
 * Placeholders `__PANEL_ORIGIN__`, `__DDNS_TOKEN__`, and `__AGENT_VERSION__`
 * are replaced by the installer after writing the single-quoted heredoc.
 */
export function getPythonTerminalAgentTemplate(): string {
  return `#!/usr/bin/env python3
import base64
import codecs
import errno
import fcntl
import json
import os
import pty
import select
import signal
import socket
import ssl
import struct
import sys
import termios
import time
from urllib.parse import urlparse

PANEL_ORIGIN = "__PANEL_ORIGIN__"
DDNS_TOKEN = "__DDNS_TOKEN__"
AGENT_VERSION = "__AGENT_VERSION__"

PING_INTERVAL = 25.0
IDLE_TIMEOUT = 85.0
MAX_SESSIONS = 6


def detect_shell():
    for cand in ("/bin/bash", "/usr/bin/bash", "/bin/ash", "/bin/sh"):
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return "/bin/sh"


def set_winsize(fd, rows, cols):
    try:
        rows = max(8, min(200, int(rows)))
        cols = max(20, min(400, int(cols)))
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except Exception:
        pass


class PtySession:
    def __init__(self, sid, cols, rows):
        self.sid = sid
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.closed = False
        shell = detect_shell()
        pid, master_fd = pty.fork()
        if pid == 0:
            home = os.environ.get("HOME") or "/root"
            if os.path.isdir(home):
                try:
                    os.chdir(home)
                except Exception:
                    pass
            env = os.environ.copy()
            env["TERM"] = "xterm-256color"
            env["COLORTERM"] = "truecolor"
            env["HOME"] = home
            env.setdefault("LANG", "C.UTF-8")
            env.setdefault("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
            try:
                os.execve(shell, [shell, "-l"], env)
            except Exception:
                os.execve("/bin/sh", ["/bin/sh"], env)
        self.pid = pid
        self.fd = master_fd
        flags = fcntl.fcntl(self.fd, fcntl.F_GETFL)
        fcntl.fcntl(self.fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        set_winsize(self.fd, rows, cols)

    def write(self, data_str):
        if self.closed:
            return
        raw = data_str.encode("utf-8", errors="ignore")
        view = memoryview(raw)
        while len(view) > 0:
            try:
                n = os.write(self.fd, view)
                if n <= 0:
                    break
                view = view[n:]
            except BlockingIOError:
                select.select([], [self.fd], [], 0.2)
            except OSError:
                break

    def resize(self, cols, rows):
        if self.closed:
            return
        set_winsize(self.fd, rows, cols)
        try:
            os.killpg(os.getpgid(self.pid), signal.SIGWINCH)
        except Exception:
            try:
                os.kill(self.pid, signal.SIGWINCH)
            except Exception:
                pass

    def read_chunk(self):
        try:
            raw = os.read(self.fd, 8192)
            if not raw:
                return None
            return self.decoder.decode(raw, final=False)
        except OSError as e:
            if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                return ""
            return None

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            os.close(self.fd)
        except Exception:
            pass
        for sig in (signal.SIGHUP, signal.SIGTERM):
            try:
                os.killpg(os.getpgid(self.pid), sig)
            except Exception:
                try:
                    os.kill(self.pid, sig)
                except Exception:
                    pass
        try:
            os.waitpid(self.pid, os.WNOHANG)
        except Exception:
            pass


class RawWebSocket:
    def __init__(self, origin, path, token):
        parsed = urlparse(origin)
        scheme = (parsed.scheme or "https").lower()
        host = parsed.hostname
        if not host:
            raise ValueError("Invalid PANEL_ORIGIN")
        use_tls = scheme in ("https", "wss")
        port = parsed.port or (443 if use_tls else 80)

        raw_sock = socket.create_connection((host, port), timeout=15)
        if use_tls:
            ctx = ssl.create_default_context()
            self.sock = ctx.wrap_socket(raw_sock, server_hostname=host)
        else:
            self.sock = raw_sock

        ws_key = base64.b64encode(os.urandom(16)).decode("ascii")
        host_hdr = host if ((use_tls and port == 443) or (not use_tls and port == 80)) else f"{host}:{port}"
        req = (
            f"GET {path} HTTP/1.1\\r\\n"
            f"Host: {host_hdr}\\r\\n"
            f"Upgrade: websocket\\r\\n"
            f"Connection: Upgrade\\r\\n"
            f"Sec-WebSocket-Key: {ws_key}\\r\\n"
            f"Sec-WebSocket-Version: 13\\r\\n"
            f"Authorization: Bearer {token}\\r\\n"
            f"User-Agent: cdt-ddns-terminal-agent/{AGENT_VERSION}\\r\\n"
            f"\\r\\n"
        )
        self.sock.sendall(req.encode("ascii"))

        buf = b""
        while b"\\r\\n\\r\\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("EOF during WebSocket handshake")
            buf += chunk
            if len(buf) > 32768:
                raise ConnectionError("HTTP response header too large")

        head, rest = buf.split(b"\\r\\n\\r\\n", 1)
        status_line = head.split(b"\\r\\n", 1)[0].decode("latin1", errors="replace")
        if " 101 " not in status_line:
            raise ConnectionError(f"WebSocket upgrade rejected: {status_line}")

        self.sock.setblocking(False)
        self.rx = bytearray(rest)
        self.frag_opcode = None
        self.frag_buf = bytearray()
        self.closed = False
        self.close_code = 1000

    def fileno(self):
        return self.sock.fileno()

    def has_pending(self):
        if len(self.rx) > 0:
            return True
        if isinstance(self.sock, ssl.SSLSocket):
            try:
                return self.sock.pending() > 0
            except Exception:
                return False
        return False

    def send_frame(self, opcode, payload_bytes):
        if self.closed:
            return
        length = len(payload_bytes)
        mask = os.urandom(4)
        header = bytearray([0x80 | (opcode & 0x0F)])
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        header.extend(mask)
        masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload_bytes))
        frame = bytes(header) + masked
        view = memoryview(frame)
        while len(view) > 0:
            try:
                n = self.sock.send(view)
                if n <= 0:
                    raise ConnectionError("Socket send returned 0")
                view = view[n:]
            except (BlockingIOError, ssl.SSLWantWriteError):
                select.select([], [self.sock], [], 5.0)
            except ssl.SSLWantReadError:
                select.select([self.sock], [], [], 5.0)

    def send_text(self, text):
        self.send_frame(0x01, text.encode("utf-8"))

    def send_json(self, obj):
        self.send_text(json.dumps(obj, separators=(",", ":")))

    def pump_read(self):
        while True:
            try:
                chunk = self.sock.recv(16384)
                if not chunk:
                    self.closed = True
                    return
                self.rx.extend(chunk)
            except (BlockingIOError, ssl.SSLWantReadError):
                return
            except ssl.SSLWantWriteError:
                return

    def pop_frames(self):
        frames = []
        while len(self.rx) >= 2:
            b0 = self.rx[0]
            b1 = self.rx[1]
            fin = (b0 & 0x80) != 0
            opcode = b0 & 0x0F
            masked = (b1 & 0x80) != 0
            length = b1 & 0x7F
            offset = 2
            if length == 126:
                if len(self.rx) < 4:
                    break
                length = struct.unpack("!H", self.rx[2:4])[0]
                offset = 4
            elif length == 127:
                if len(self.rx) < 10:
                    break
                length = struct.unpack("!Q", self.rx[2:10])[0]
                offset = 10
            mask_len = 4 if masked else 0
            total = offset + mask_len + length
            if len(self.rx) < total:
                break
            payload = bytes(self.rx[offset + mask_len : total])
            if masked:
                mask = self.rx[offset : offset + 4]
                payload = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
            del self.rx[:total]
            # Control frames (ping/pong/close) are never fragmented per RFC 6455.
            if opcode >= 0x08:
                frames.append((opcode, payload))
                continue
            if opcode == 0x00:
                if self.frag_opcode is not None:
                    self.frag_buf.extend(payload)
                    if fin:
                        frames.append((self.frag_opcode, bytes(self.frag_buf)))
                        self.frag_opcode = None
                        self.frag_buf.clear()
                continue
            if not fin:
                self.frag_opcode = opcode
                self.frag_buf = bytearray(payload)
            else:
                frames.append((opcode, payload))
        return frames

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            self.sock.close()
        except Exception:
            pass


def reap_children():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if pid <= 0:
                break
        except ChildProcessError:
            break
        except Exception:
            break


def run_once():
    hostname = socket.gethostname()
    ws = RawWebSocket(PANEL_ORIGIN, f"/api/v1/ddns-ip/agent/ws?v={AGENT_VERSION}", DDNS_TOKEN)
    sessions = {}
    last_rx = time.monotonic()
    last_ping = time.monotonic()

    try:
        while not ws.closed:
            reap_children()
            now = time.monotonic()
            if now - last_ping >= PING_INTERVAL:
                ws.send_text("ping")
                last_ping = now
            if now - last_rx >= IDLE_TIMEOUT:
                raise TimeoutError("Keepalive timeout")

            if ws.has_pending():
                ws.pump_read()
                rlist = []
            else:
                fd_to_sid = {s.fd: sid for sid, s in sessions.items() if not s.closed}
                watch = [ws.fileno()] + list(fd_to_sid.keys())
                rlist, _, _ = select.select(watch, [], [], 0.5)
                if ws.fileno() in rlist:
                    ws.pump_read()

            for opcode, payload in ws.pop_frames():
                last_rx = time.monotonic()
                if opcode == 0x08:
                    if len(payload) >= 2:
                        ws.close_code = struct.unpack("!H", payload[:2])[0]
                    ws.closed = True
                    break
                if opcode == 0x09:
                    ws.send_frame(0x0A, payload)
                    continue
                if opcode == 0x0A:
                    continue
                if opcode != 0x01:
                    continue
                text = payload.decode("utf-8", errors="replace")
                if text == "pong":
                    continue
                if text == "ping":
                    ws.send_text("pong")
                    continue
                try:
                    msg = json.loads(text)
                except Exception:
                    continue
                if not isinstance(msg, dict):
                    continue
                mtype = msg.get("type")
                sid = str(msg.get("sid") or "")
                if mtype == "open" and sid:
                    if sid in sessions:
                        sessions[sid].close()
                        del sessions[sid]
                    if len(sessions) >= MAX_SESSIONS:
                        oldest = next(iter(sessions))
                        sessions[oldest].close()
                        del sessions[oldest]
                    try:
                        cols = msg.get("cols", 100)
                        rows = msg.get("rows", 30)
                        sessions[sid] = PtySession(sid, cols, rows)
                        ws.send_json({
                            "type": "ready",
                            "sid": sid,
                            "message": f"已免密接入 {hostname}（监控反向终端）",
                        })
                    except Exception as e:
                        ws.send_json({"type": "error", "sid": sid, "message": f"启动 Shell 失败: {e}"})
                elif mtype == "input" and sid in sessions:
                    data = msg.get("data")
                    if isinstance(data, str) and data:
                        sessions[sid].write(data)
                elif mtype == "resize" and sid in sessions:
                    sessions[sid].resize(msg.get("cols", 100), msg.get("rows", 30))
                elif mtype == "close" and sid in sessions:
                    sessions[sid].close()
                    del sessions[sid]

            dead_sids = []
            for sid, sess in list(sessions.items()):
                if sess.closed:
                    dead_sids.append(sid)
                    continue
                out = sess.read_chunk()
                if out is None:
                    tail = sess.decoder.decode(b"", final=True)
                    if tail:
                        ws.send_json({"type": "output", "sid": sid, "data": tail})
                    ws.send_json({"type": "exit", "sid": sid, "message": "远端 Shell 已退出"})
                    sess.close()
                    dead_sids.append(sid)
                elif out:
                    ws.send_json({"type": "output", "sid": sid, "data": out})
            for sid in dead_sids:
                sessions.pop(sid, None)
    finally:
        for sess in sessions.values():
            sess.close()
        ws.close()
    return ws.close_code


def main():
    backoff = 3
    while True:
        try:
            code = run_once()
            backoff = 3
            if code == 4001:
                time.sleep(60)
            else:
                time.sleep(3)
        except KeyboardInterrupt:
            break
        except Exception as e:
            sys.stderr.write(f"[cdt-ddns-term] disconnected: {e}\\n")
            sys.stderr.flush()
            time.sleep(backoff)
            backoff = min(30, backoff * 2)


if __name__ == "__main__":
    main()
`;
}
