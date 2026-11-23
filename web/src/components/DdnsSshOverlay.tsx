import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  Check,
  Copy,
  Eraser,
  KeyRound,
  LoaderCircle,
  Lock,
  Plug,
  Radio,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from 'lucide-react'
import { patch } from '../api'
import type { DdnsIpMonitorItem, DdnsIpSshAuthType } from '../types'
import { Segmented } from './ui'

interface DdnsSshOverlayProps {
  monitor: DdnsIpMonitorItem
  onClose: () => void
  onToast: (message: string, tone?: 'success' | 'error' | 'info') => void
  onMonitorUpdated: (next: DdnsIpMonitorItem) => void
}

type TerminalMode = 'agent' | 'ssh'
type ConnPhase = 'form' | 'connecting' | 'connected' | 'closed' | 'error'

/**
 * Full-screen interactive remote terminal backed by xterm.js with two transports:
 * 1. Passwordless reverse WebSocket PTY agent embedded in the DDNS IP monitor
 *    (`/api/v1/ddns-ip/monitors/:id/terminal` -> SQLite Durable Object relay).
 * 2. Direct SSH2 over Cloudflare outbound TCP sockets (`/api/v1/ddns-ip/monitors/:id/ssh`).
 */
export default function DdnsSshOverlay({
  monitor,
  onClose,
  onToast,
  onMonitorUpdated,
}: DdnsSshOverlayProps) {
  const targetHost = (monitor.current_ip || monitor.resolved_ip || monitor.fqdn).trim()
  const initialMode: TerminalMode =
    monitor.terminal_agent_online || !monitor.has_ssh_secret ? 'agent' : 'ssh'

  const [mode, setMode] = useState<TerminalMode>(initialMode)
  const [port, setPort] = useState(String(monitor.ssh_port || 22))
  const [username, setUsername] = useState(monitor.ssh_username || 'root')
  const [authType, setAuthType] = useState<DdnsIpSshAuthType>(monitor.ssh_auth_type || 'password')
  const [secret, setSecret] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [saveProfile, setSaveProfile] = useState(true)
  const [hasSaved, setHasSaved] = useState(monitor.has_ssh_secret)
  const [clearingSaved, setClearingSaved] = useState(false)
  const [copiedCmd, setCopiedCmd] = useState(false)

  const [phase, setPhase] = useState<ConnPhase>('connecting')
  const [statusText, setStatusText] = useState(
    initialMode === 'agent'
      ? `正在接入 ${monitor.fqdn} 免密反向终端…`
      : `正在使用已存凭据连接 ${targetHost}…`,
  )
  const [errorText, setErrorText] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [agentOffline, setAgentOffline] = useState(false)

  const termContainerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const pingTimerRef = useRef<number | null>(null)
  const connSeqRef = useRef(0)
  const autoConnectedRef = useRef(false)
  const monitorRef = useRef(monitor)
  monitorRef.current = monitor

  // Lock body scroll while overlay is active (do NOT close on Escape so vim/nano work).
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  const disconnect = useCallback(() => {
    connSeqRef.current += 1
    if (pingTimerRef.current !== null) {
      window.clearInterval(pingTimerRef.current)
      pingTimerRef.current = null
    }
    const ws = wsRef.current
    wsRef.current = null
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try {
        ws.close(1000, 'user closed')
      } catch {}
    }
  }, [])

  // Mount xterm.js instance once for the lifetime of the overlay.
  useEffect(() => {
    const hostEl = termContainerRef.current
    if (!hostEl) return

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 13.5,
      lineHeight: 1.28,
      fontFamily:
        "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      scrollback: 5000,
      theme: {
        background: '#0b0f17',
        foreground: '#e5edf7',
        cursor: '#f472b6',
        cursorAccent: '#0b0f17',
        selectionBackground: 'rgba(244, 114, 182, 0.28)',
        black: '#1f2937',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#f472b6',
        cyan: '#22d3ee',
        white: '#e5e7eb',
        brightBlack: '#6b7280',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#f9a8d4',
        brightCyan: '#67e8f9',
        brightWhite: '#ffffff',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostEl)
    try {
      fit.fit()
    } catch {}

    termRef.current = term
    fitRef.current = fit

    const dataSub = term.onData((data) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    })

    const resizeSub = term.onResize(({ cols, rows }) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
      }
    })

    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {}
    })
    observer.observe(hostEl)

    return () => {
      observer.disconnect()
      dataSub.dispose()
      resizeSub.dispose()
      disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [disconnect])

  const connectAgent = useCallback(() => {
    disconnect()
    const seq = connSeqRef.current
    const curMonitor = monitorRef.current
    setMode('agent')
    setShowForm(false)
    setAgentOffline(false)
    setErrorText('')
    setPhase('connecting')
    setStatusText(`正在通过免密监控隧道接入 ${curMonitor.fqdn}…`)

    const term = termRef.current
    const fit = fitRef.current
    if (term) {
      term.reset()
      term.writeln(`\x1b[38;5;212m[CDT-TERM]\x1b[0m 正在连接免密监控反向终端 ${curMonitor.fqdn} …`)
    }
    try {
      fit?.fit()
    } catch {}

    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${wsProto}//${window.location.host}/api/v1/ddns-ip/monitors/${curMonitor.id}/terminal`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      if (connSeqRef.current !== seq) return
      // Use plain "ping" so the Durable Object handles keepalive via WebSocket Hibernation AutoResponse.
      pingTimerRef.current = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('ping')
        }
      }, 25_000)
    }

    ws.onmessage = (ev) => {
      if (connSeqRef.current !== seq) return
      if (typeof ev.data !== 'string' || ev.data === 'pong') return
      let msg: { type?: string; state?: string; code?: string; data?: string; message?: string }
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.type === 'output' && typeof msg.data === 'string') {
        termRef.current?.write(msg.data)
        return
      }
      if (msg.type === 'status') {
        if (msg.state === 'agent_ready') {
          setStatusText(msg.message || '反向隧道已就绪，正在分配 Shell…')
          const cols = termRef.current?.cols || 100
          const rows = termRef.current?.rows || 30
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'open', cols, rows }))
          }
          return
        }
        if (msg.state === 'connected') {
          setAgentOffline(false)
          setPhase('connected')
          setStatusText(msg.message || `已免密接入 ${curMonitor.fqdn}`)
          if (!curMonitor.terminal_agent_online) {
            onMonitorUpdated({ ...curMonitor, terminal_agent_online: true })
          }
          window.setTimeout(() => {
            try {
              fitRef.current?.fit()
            } catch {}
            termRef.current?.focus()
          }, 60)
          return
        }
        if (msg.state === 'closed') {
          setPhase((prev) => (prev === 'error' ? 'error' : 'closed'))
          setStatusText(msg.message || '免密终端会话已结束')
          termRef.current?.writeln(`\r\n\x1b[33m[CDT-TERM]\x1b[0m ${msg.message || '会话已结束'}`)
          return
        }
      }
      if (msg.type === 'error') {
        const errMsg = msg.message || '反向终端连接失败'
        setPhase('error')
        setErrorText(errMsg)
        if (msg.code === 'agent_offline') {
          setAgentOffline(true)
          setStatusText('反向终端未在线')
          if (curMonitor.terminal_agent_online) {
            onMonitorUpdated({ ...curMonitor, terminal_agent_online: false })
          }
        } else {
          setStatusText('连接失败')
        }
        termRef.current?.writeln(`\r\n\x1b[31m[提示]\x1b[0m ${errMsg}`)
      }
    }

    ws.onerror = () => {
      if (connSeqRef.current !== seq) return
      setPhase('error')
      setErrorText('WebSocket 通道异常，请检查网络或重新登录后重试')
      setStatusText('连接异常')
    }

    ws.onclose = () => {
      if (connSeqRef.current !== seq) return
      if (pingTimerRef.current !== null) {
        window.clearInterval(pingTimerRef.current)
        pingTimerRef.current = null
      }
      setPhase((prev) => (prev === 'connecting' || prev === 'connected' ? 'closed' : prev))
    }
  }, [disconnect, onMonitorUpdated])

  const connectSsh = useCallback(
    (overrides?: { useSaved?: boolean }) => {
      const portNum = Math.trunc(Number(port) || 22)
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535 || portNum === 25) {
        setErrorText('SSH 端口须为 1–65535（且不能为 25）')
        setShowForm(true)
        return
      }
      const user = username.trim()
      if (!user) {
        setErrorText('请输入 SSH 用户名')
        setShowForm(true)
        return
      }
      const useSaved = overrides?.useSaved ?? (!secret && hasSaved)
      if (!secret && !useSaved) {
        setErrorText(authType === 'private_key' ? '请粘贴 SSH 私钥' : '请输入 SSH 密码')
        setShowForm(true)
        return
      }

      disconnect()
      const seq = connSeqRef.current
      const curMonitor = monitorRef.current
      setMode('ssh')
      setAgentOffline(false)
      setErrorText('')
      setShowForm(false)
      setPhase('connecting')
      setStatusText(`正在建立到 ${user}@${targetHost}:${portNum} 的 SSH 连接…`)

      const term = termRef.current
      const fit = fitRef.current
      if (term) {
        term.reset()
        term.writeln(`\x1b[38;5;212m[CDT-SSH]\x1b[0m 正在连接 ${user}@${targetHost}:${portNum} …`)
      }
      try {
        fit?.fit()
      } catch {}

      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsUrl = `${wsProto}//${window.location.host}/api/v1/ddns-ip/monitors/${curMonitor.id}/ssh`
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        if (connSeqRef.current !== seq) return
        const cols = termRef.current?.cols || 100
        const rows = termRef.current?.rows || 30
        ws.send(
          JSON.stringify({
            type: 'auth',
            port: portNum,
            username: user,
            auth_type: authType,
            ...(secret ? { secret } : {}),
            ...(passphrase ? { passphrase } : {}),
            use_saved: useSaved,
            save: saveProfile,
            cols,
            rows,
          }),
        )
        pingTimerRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }))
          }
        }, 25_000)
      }

      ws.onmessage = (ev) => {
        if (connSeqRef.current !== seq) return
        if (typeof ev.data !== 'string') return
        let msg: { type?: string; state?: string; data?: string; message?: string }
        try {
          msg = JSON.parse(ev.data)
        } catch {
          return
        }
        if (msg.type === 'output' && typeof msg.data === 'string') {
          termRef.current?.write(msg.data)
          return
        }
        if (msg.type === 'status') {
          if (msg.state === 'connected') {
            setPhase('connected')
            setStatusText(msg.message || `已连接 ${user}@${targetHost}:${portNum}`)
            if (saveProfile && secret) {
              setHasSaved(true)
              onMonitorUpdated({
                ...curMonitor,
                ssh_port: portNum,
                ssh_username: user,
                ssh_auth_type: authType,
                has_ssh_secret: true,
                has_ssh_passphrase: Boolean(passphrase) || curMonitor.has_ssh_passphrase,
              })
            }
            window.setTimeout(() => {
              try {
                fitRef.current?.fit()
              } catch {}
              termRef.current?.focus()
            }, 60)
          } else if (msg.state === 'connecting') {
            setPhase('connecting')
            setStatusText(msg.message || '正在握手…')
          } else if (msg.state === 'closed') {
            setPhase((prev) => (prev === 'error' ? 'error' : 'closed'))
            setStatusText(msg.message || 'SSH 会话已结束')
            termRef.current?.writeln(`\r\n\x1b[33m[CDT-SSH]\x1b[0m ${msg.message || '会话已结束'}`)
          }
          return
        }
        if (msg.type === 'error') {
          const errMsg = msg.message || 'SSH 连接失败'
          setPhase('error')
          setErrorText(errMsg)
          setStatusText('连接失败')
          termRef.current?.writeln(`\r\n\x1b[31m[错误]\x1b[0m ${errMsg}`)
        }
      }

      ws.onerror = () => {
        if (connSeqRef.current !== seq) return
        setPhase('error')
        setErrorText('WebSocket 通道异常，请检查网络或登录后重试')
        setStatusText('连接异常')
      }

      ws.onclose = () => {
        if (connSeqRef.current !== seq) return
        if (pingTimerRef.current !== null) {
          window.clearInterval(pingTimerRef.current)
          pingTimerRef.current = null
        }
        setPhase((prev) => (prev === 'connecting' || prev === 'connected' ? 'closed' : prev))
      }
    },
    [
      authType,
      disconnect,
      hasSaved,
      onMonitorUpdated,
      passphrase,
      port,
      saveProfile,
      secret,
      targetHost,
      username,
    ],
  )

  // Auto-connect immediately on open: prefer passwordless reverse terminal, or saved SSH if agent offline.
  useEffect(() => {
    if (autoConnectedRef.current) return
    autoConnectedRef.current = true
    const timer = window.setTimeout(() => {
      if (initialMode === 'agent') {
        connectAgent()
      } else {
        connectSsh({ useSaved: true })
      }
    }, 60)
    return () => window.clearTimeout(timer)
  }, [connectAgent, connectSsh, initialMode])

  const switchMode = (nextMode: TerminalMode) => {
    if (nextMode === mode && !(nextMode === 'agent' && agentOffline)) return
    setErrorText('')
    if (nextMode === 'agent') {
      connectAgent()
    } else {
      disconnect()
      setMode('ssh')
      setAgentOffline(false)
      if (hasSaved) {
        connectSsh({ useSaved: true })
      } else {
        setPhase('form')
        setStatusText('请输入 SSH 登录信息')
        setShowForm(true)
      }
    }
  }

  const copyInstallCmd = async () => {
    try {
      await navigator.clipboard.writeText(monitor.install_cmd)
      setCopiedCmd(true)
      onToast('已复制新版 Linux 一键安装命令（含免密终端与自动三网延迟）', 'success')
      window.setTimeout(() => setCopiedCmd(false), 1800)
    } catch {
      onToast('复制失败，请手动选中复制', 'error')
    }
  }

  const clearSavedCredentials = async () => {
    setClearingSaved(true)
    try {
      const res = await patch<{ ok: true; item: DdnsIpMonitorItem }>(
        `/api/v1/ddns-ip/monitors/${monitor.id}/ssh-config`,
        { clear_secret: true },
      )
      setHasSaved(false)
      setSecret('')
      setPassphrase('')
      onMonitorUpdated(res.item)
      onToast('已清除该节点的加密 SSH 凭据', 'success')
    } catch (err) {
      onToast(err instanceof Error ? err.message : '清除凭据失败', 'error')
    } finally {
      setClearingSaved(false)
    }
  }

  const phaseDotClass =
    phase === 'connected'
      ? 'is-ok'
      : phase === 'connecting'
        ? 'is-wait'
        : phase === 'error'
          ? 'is-err'
          : 'is-idle'

  return (
    <div className="vnc-overlay ssh-overlay" role="dialog" aria-modal="true" aria-label="远程终端">
      <div className="vnc-bar">
        <div className="vnc-bar-info">
          <TerminalIcon size={15} style={{ color: '#f472b6' }} />
          <strong>{monitor.fqdn}</strong>
          {monitor.label && <span className="ssh-bar-label">{monitor.label}</span>}
          <code className="mono">
            {mode === 'agent'
              ? `免密监控隧道 · ${monitor.hostname || targetHost || monitor.fqdn}`
              : `${username.trim() || 'root'}@${targetHost || '--'}:${port || '22'}`}
          </code>
          <span className={`ssh-status-pill ${phaseDotClass}`}>
            <i />
            {phase === 'connected'
              ? mode === 'agent'
                ? '免密已连接'
                : 'SSH 已连接'
              : phase === 'connecting'
                ? '连接中…'
                : phase === 'error'
                  ? agentOffline
                    ? 'Agent 未在线'
                    : '连接失败'
                  : phase === 'closed'
                    ? '已断开'
                    : '未连接'}
          </span>
        </div>

        <div className="vnc-bar-actions">
          <div className="ssh-mode-switch" role="tablist" aria-label="终端连接方式">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'agent'}
              className={mode === 'agent' ? 'on' : ''}
              onClick={() => switchMode('agent')}
              title="通过 DDNS 监控内置反向隧道免密直连，无需密码和开放端口"
            >
              <ShieldCheck size={12} /> 免密终端
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'ssh'}
              className={mode === 'ssh' ? 'on' : ''}
              onClick={() => switchMode('ssh')}
              title="通过公网 IP 和端口使用密码或私钥直连 sshd"
            >
              <KeyRound size={12} /> 直连 SSH
            </button>
          </div>

          {mode === 'ssh' && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setShowForm((v) => !v)}
            >
              <SlidersHorizontal size={12} /> {showForm ? '返回终端' : '连接配置'}
            </button>
          )}
          <button
            type="button"
            className="btn ghost sm"
            disabled={phase === 'connecting'}
            onClick={() => (mode === 'agent' ? connectAgent() : connectSsh())}
          >
            {phase === 'connecting' ? (
              <LoaderCircle size={12} className="spin" />
            ) : (
              <RefreshCw size={12} />
            )}
            重新连接
          </button>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => termRef.current?.clear()}
          >
            <Eraser size={12} /> 清屏
          </button>
          <button
            type="button"
            className="btn sm danger"
            onClick={() => {
              disconnect()
              onClose()
            }}
          >
            <X size={13} /> 关闭
          </button>
        </div>
      </div>

      <div className="vnc-stage ssh-stage">
        <div ref={termContainerRef} className="ssh-xterm-host" />

        {/* Offline Reverse Agent Guidance Card */}
        {mode === 'agent' && agentOffline && (
          <div className="ssh-form-backdrop">
            <div className="ssh-connect-card ssh-agent-guide">
              <div className="ssh-connect-head">
                <div>
                  <h3>
                    <Radio size={16} style={{ color: '#f472b6' }} /> 免密反向终端尚未在线
                  </h3>
                  <p>
                    节点「{monitor.fqdn}」暂未接入新版免密监控隧道。在目标服务器执行一次下方命令即可开启免密终端、每分钟自动三网延迟上报，且后续面板升级脚本将自动更新。
                  </p>
                </div>
              </div>

              <div className="ssh-agent-cmd-box">
                <div className="ssh-agent-cmd-head">
                  <span>新版 Linux 一键安装 / 升级命令（需 python3，无需开放入站端口）</span>
                  <button
                    type="button"
                    className="btn primary sm"
                    onClick={() => void copyInstallCmd()}
                  >
                    {copiedCmd ? <Check size={12} /> : <Copy size={12} />}
                    {copiedCmd ? '已复制' : '复制命令'}
                  </button>
                </div>
                <pre className="ssh-agent-cmd-pre">{monitor.install_cmd}</pre>
              </div>

              <div className="ssh-form-foot">
                <span className="ssh-form-tip">
                  家宽 / NAT 内网无公网端口也能直接免密连入；若暂不升级，可切换直连 SSH
                </span>
                <div className="ssh-form-btns">
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => switchMode('ssh')}
                  >
                    <KeyRound size={12} /> 改用直连 SSH
                  </button>
                  <button
                    type="button"
                    className="btn primary sm"
                    onClick={() => connectAgent()}
                  >
                    <RefreshCw size={12} /> 重新检测免密终端
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Direct SSH Login Form (Fallback Mode) */}
        {mode === 'ssh' && showForm && (
          <div className="ssh-form-backdrop">
            <form
              className="ssh-connect-card"
              onSubmit={(e) => {
                e.preventDefault()
                connectSsh()
              }}
            >
              <div className="ssh-connect-head">
                <div>
                  <h3>
                    <TerminalIcon size={16} /> 直连 SSH 终端登录
                  </h3>
                  <p>通过安全加密通道直连当前监控节点的动态公网 IPv4（也支持顶部切换免密反向终端）</p>
                </div>
              </div>

              {errorText && <div className="ssh-form-error">{errorText}</div>}

              <div className="ssh-grid-2">
                <div className="field">
                  <label>目标主机（自动同步）</label>
                  <input className="input mono" value={targetHost || '尚未上报公网 IP'} readOnly />
                </div>
                <div className="field">
                  <label>SSH 端口</label>
                  <input
                    className="input mono"
                    type="number"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder="22"
                  />
                </div>
              </div>

              <div className="ssh-grid-2">
                <div className="field">
                  <label>用户名</label>
                  <input
                    className="input mono"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="root"
                    autoComplete="username"
                  />
                </div>
                <div className="field">
                  <label>认证方式</label>
                  <Segmented
                    value={authType}
                    onChange={(val) => setAuthType(val as DdnsIpSshAuthType)}
                    options={[
                      { value: 'password', label: '密码登录' },
                      { value: 'private_key', label: '私钥登录' },
                    ]}
                  />
                </div>
              </div>

              {authType === 'password' ? (
                <div className="field">
                  <label>
                    <Lock size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                    SSH 密码
                  </label>
                  <input
                    className="input"
                    type="password"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder={
                      hasSaved
                        ? '已加密保存密码，留空直接连接，输入新密码将覆盖'
                        : '请输入服务器 SSH 登录密码'
                    }
                    autoComplete="current-password"
                  />
                </div>
              ) : (
                <>
                  <div className="field">
                    <label>
                      <KeyRound size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                      SSH 私钥（OpenSSH / PEM）
                    </label>
                    <textarea
                      className="input mono ssh-key-input"
                      rows={4}
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      placeholder={
                        hasSaved
                          ? '已加密保存私钥，留空直接连接，粘贴新私钥将覆盖'
                          : '-----BEGIN OPENSSH PRIVATE KEY-----'
                      }
                    />
                  </div>
                  <div className="field">
                    <label>私钥口令（未加密可留空）</label>
                    <input
                      className="input"
                      type="password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      placeholder="Passphrase（可选）"
                    />
                  </div>
                </>
              )}

              <div className="ssh-save-row">
                <label className="ssh-check-label">
                  <input
                    type="checkbox"
                    checked={saveProfile}
                    onChange={(e) => setSaveProfile(e.target.checked)}
                  />
                  <span>连接成功后 AES-GCM 加密保存到面板（下次一键直连）</span>
                </label>

                {hasSaved && (
                  <button
                    type="button"
                    className="btn ghost sm danger"
                    disabled={clearingSaved}
                    onClick={() => void clearSavedCredentials()}
                  >
                    {clearingSaved ? (
                      <LoaderCircle size={11} className="spin" />
                    ) : (
                      <Trash2 size={11} />
                    )}
                    清除已存凭据
                  </button>
                )}
              </div>

              <div className="ssh-form-foot">
                <span className="ssh-form-tip">
                  提示：目标服务器需开放外网 SSH 端口（家宽无端口推荐使用顶部「免密终端」）
                </span>
                <div className="ssh-form-btns">
                  {phase === 'connected' && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => setShowForm(false)}
                    >
                      返回终端
                    </button>
                  )}
                  <button
                    type="submit"
                    className="btn primary sm"
                    disabled={!targetHost || phase === 'connecting'}
                  >
                    <Plug size={12} /> 立即连接
                  </button>
                </div>
              </div>
            </form>
          </div>
        )}

        {!showForm && !agentOffline && phase === 'error' && errorText && (
          <div className="ssh-error-banner">
            <span>{errorText}</span>
            <div className="ssh-error-banner-ops">
              {mode === 'ssh' ? (
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setShowForm(true)}
                >
                  修改端口 / 凭据
                </button>
              ) : (
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => switchMode('ssh')}
                >
                  切换直连 SSH
                </button>
              )}
              <button
                type="button"
                className="btn primary sm"
                onClick={() => (mode === 'agent' ? connectAgent() : connectSsh())}
              >
                重试连接
              </button>
            </div>
          </div>
        )}

        {!showForm && !agentOffline && phase === 'closed' && (
          <div className="ssh-error-banner is-info">
            <span>{statusText}</span>
            <div className="ssh-error-banner-ops">
              {mode === 'ssh' && (
                <button type="button" className="btn ghost sm" onClick={() => setShowForm(true)}>
                  连接配置
                </button>
              )}
              <button
                type="button"
                className="btn primary sm"
                onClick={() => (mode === 'agent' ? connectAgent() : connectSsh())}
              >
                重新连接
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
