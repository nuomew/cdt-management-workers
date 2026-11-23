import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  Eraser,
  KeyRound,
  LoaderCircle,
  Lock,
  Plug,
  RefreshCw,
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

type ConnPhase = 'form' | 'connecting' | 'connected' | 'closed' | 'error'

/**
 * Full-screen interactive Web SSH terminal backed by xterm.js and the Worker's
 * authenticated WebSocket-to-SSH2 bridge (`/api/v1/ddns-ip/monitors/:id/ssh`).
 */
export default function DdnsSshOverlay({
  monitor,
  onClose,
  onToast,
  onMonitorUpdated,
}: DdnsSshOverlayProps) {
  const targetHost = (monitor.current_ip || monitor.resolved_ip || monitor.fqdn).trim()
  const [port, setPort] = useState(String(monitor.ssh_port || 22))
  const [username, setUsername] = useState(monitor.ssh_username || 'root')
  const [authType, setAuthType] = useState<DdnsIpSshAuthType>(monitor.ssh_auth_type || 'password')
  const [secret, setSecret] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [saveProfile, setSaveProfile] = useState(true)
  const [hasSaved, setHasSaved] = useState(monitor.has_ssh_secret)
  const [clearingSaved, setClearingSaved] = useState(false)

  const [phase, setPhase] = useState<ConnPhase>(monitor.has_ssh_secret ? 'connecting' : 'form')
  const [statusText, setStatusText] = useState(
    monitor.has_ssh_secret ? `正在使用已存凭据连接 ${targetHost}…` : '请输入 SSH 登录信息',
  )
  const [errorText, setErrorText] = useState('')
  const [showForm, setShowForm] = useState(!monitor.has_ssh_secret)

  const termContainerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const pingTimerRef = useRef<number | null>(null)
  const autoConnectedRef = useRef(false)

  // Lock body scroll while overlay is active (do NOT close on Escape so vim/nano work).
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  const disconnect = useCallback(() => {
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
      const wsUrl = `${wsProto}//${window.location.host}/api/v1/ddns-ip/monitors/${monitor.id}/ssh`
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
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
                ...monitor,
                ssh_port: portNum,
                ssh_username: user,
                ssh_auth_type: authType,
                has_ssh_secret: true,
                has_ssh_passphrase: Boolean(passphrase) || monitor.has_ssh_passphrase,
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
        setPhase('error')
        setErrorText('WebSocket 通道异常，请检查网络或登录后重试')
        setStatusText('连接异常')
      }

      ws.onclose = () => {
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
      monitor,
      onMonitorUpdated,
      passphrase,
      port,
      saveProfile,
      secret,
      targetHost,
      username,
    ],
  )

  // Auto-connect immediately on open if encrypted credentials are already saved.
  useEffect(() => {
    if (monitor.has_ssh_secret && !autoConnectedRef.current) {
      autoConnectedRef.current = true
      const timer = window.setTimeout(() => connectSsh({ useSaved: true }), 80)
      return () => window.clearTimeout(timer)
    }
  }, [connectSsh, monitor.has_ssh_secret])

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
    <div className="vnc-overlay ssh-overlay" role="dialog" aria-modal="true" aria-label="SSH 远程终端">
      <div className="vnc-bar">
        <div className="vnc-bar-info">
          <TerminalIcon size={15} style={{ color: '#f472b6' }} />
          <strong>{monitor.fqdn}</strong>
          {monitor.label && <span className="ssh-bar-label">{monitor.label}</span>}
          <code className="mono">
            {username.trim() || 'root'}@{targetHost || '--'}:{port || '22'}
          </code>
          <span className={`ssh-status-pill ${phaseDotClass}`}>
            <i />
            {phase === 'connected'
              ? '已连接'
              : phase === 'connecting'
                ? '连接中…'
                : phase === 'error'
                  ? '连接失败'
                  : phase === 'closed'
                    ? '已断开'
                    : '未连接'}
          </span>
        </div>

        <div className="vnc-bar-actions">
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setShowForm((v) => !v)}
          >
            <SlidersHorizontal size={12} /> {showForm ? '返回终端' : '连接配置'}
          </button>
          <button
            type="button"
            className="btn ghost sm"
            disabled={phase === 'connecting'}
            onClick={() => connectSsh()}
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

        {showForm && (
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
                    <TerminalIcon size={16} /> SSH 远程终端登录
                  </h3>
                  <p>通过安全加密通道直连当前监控节点的动态公网 IPv4</p>
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
                  提示：目标服务器需开放外网 SSH 端口（家宽请在路由器转发端口并填写外部端口）
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

        {!showForm && phase === 'error' && errorText && (
          <div className="ssh-error-banner">
            <span>{errorText}</span>
            <div className="ssh-error-banner-ops">
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => setShowForm(true)}
              >
                修改端口 / 凭据
              </button>
              <button type="button" className="btn primary sm" onClick={() => connectSsh()}>
                重试连接
              </button>
            </div>
          </div>
        )}

        {!showForm && phase === 'closed' && (
          <div className="ssh-error-banner is-info">
            <span>{statusText}</span>
            <div className="ssh-error-banner-ops">
              <button type="button" className="btn ghost sm" onClick={() => setShowForm(true)}>
                连接配置
              </button>
              <button type="button" className="btn primary sm" onClick={() => connectSsh()}>
                重新连接
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
