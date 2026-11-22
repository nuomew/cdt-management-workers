import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Download,
  FileKey2,
  Globe2,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { SLOW_TIMEOUT_MS, api, del, patch, post } from '../api'
import type {
  DnsAccount,
  SslCertDetailResponse,
  SslCertificateItem,
  SslVerifyMode,
} from '../types'
import { timeAgo } from '../time'
import ConfirmDialog from './ConfirmDialog'
import { Badge, Empty, Modal, Segmented, Switch, type Tone } from './ui'

const CERTS_PAGE_SIZE = 5

type ToastFn = (message: string, tone?: 'success' | 'error' | 'info') => void

type TencentSwasOption = {
  id: number
  label: string
  access_key_id_preview: string
}

type Props = {
  onToast: ToastFn
  onChanged?: () => void
  onGoDnsAccounts?: () => void
}

type CertApplyForm = {
  domain: string
  cred_source: 'dns_account' | 'tencent_swas' | 'manual'
  tencent_account_id: number
  tencent_swas_id: number
  tencent_secret_id: string
  tencent_secret_key: string
  dns_verify_mode: SslVerifyMode
  dns_account_id: number
  encrypt_algo: 'RSA' | 'ECC'
  auto_renew: boolean
  renew_before_days: number
  clean_dns_after_issue: boolean
  contact_email: string
  remark: string
}

type CertEditForm = {
  id: number
  domain: string
  dns_verify_mode: SslVerifyMode
  dns_account_id: number
  auto_renew: boolean
  renew_before_days: number
  clean_dns_after_issue: boolean
  remark: string
}

function certStatusBadge(cert: SslCertificateItem): { tone: Tone; text: string; pulse?: boolean } {
  if (cert.has_pending_renewal) {
    return { tone: 'blue', text: '自动续签验证中', pulse: true }
  }
  if (cert.status === 'issued') {
    if (cert.expiring_soon) {
      return { tone: 'amber', text: '即将到期' }
    }
    return { tone: 'green', text: '已签发' }
  }
  if (cert.status === 'verifying') {
    return { tone: 'blue', text: '验证审核中', pulse: true }
  }
  if (cert.status === 'pending_dns') {
    return { tone: 'amber', text: '待解析验证', pulse: true }
  }
  if (cert.status === 'expired') {
    return { tone: 'red', text: '已过期' }
  }
  return { tone: 'red', text: '审核失败' }
}

export default function CertsView({ onToast, onChanged, onGoDnsAccounts }: Props) {
  const [certs, setCerts] = useState<SslCertificateItem[]>([])
  const [dnsAccounts, setDnsAccounts] = useState<DnsAccount[]>([])
  const [tencentSwas, setTencentSwas] = useState<TencentSwasOption[]>([])
  const [loading, setLoading] = useState(true)
  const [reconciling, setReconciling] = useState(false)
  const [busyId, setBusyId] = useState<number>(0)

  const [applyModal, setApplyModal] = useState<CertApplyForm | null>(null)
  const [applying, setApplying] = useState(false)

  const [syncModalOpen, setSyncModalOpen] = useState(false)
  const [syncTencentAccountId, setSyncTencentAccountId] = useState<number>(0)
  const [syncDnsMode, setSyncDnsMode] = useState<SslVerifyMode>('dns_account')
  const [syncDnsAccountId, setSyncDnsAccountId] = useState<number>(0)
  const [syncing, setSyncing] = useState(false)

  const [editModal, setEditModal] = useState<CertEditForm | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)

  const [detailCert, setDetailCert] = useState<SslCertificateItem | null>(null)
  const [detailData, setDetailData] = useState<SslCertDetailResponse | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [detailError, setDetailError] = useState('')

  const [deleteTarget, setDeleteTarget] = useState<SslCertificateItem | null>(null)
  const [deleteRemote, setDeleteRemote] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const tencentAccounts = useMemo(
    () => dnsAccounts.filter((a) => a.provider === 'tencent'),
    [dnsAccounts],
  )

  const loadCerts = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api<{
        items: SslCertificateItem[]
        dns_accounts: DnsAccount[]
        tencent_swas: TencentSwasOption[]
      }>('/api/v1/certs')
      setCerts(res.items ?? [])
      setDnsAccounts(res.dns_accounts ?? [])
      setTencentSwas(res.tencent_swas ?? [])
    } catch (err) {
      onToast(err instanceof Error ? err.message : '加载证书列表失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [onToast])

  useEffect(() => {
    void loadCerts()
  }, [loadCerts])

  const [page, setPage] = useState(1)

  const stats = useMemo(() => {
    let issued = 0
    let pending = 0
    let expiring = 0
    for (const c of certs) {
      if (c.status === 'issued') issued += 1
      if (c.status === 'pending_dns' || c.status === 'verifying' || c.has_pending_renewal) {
        pending += 1
      }
      if (c.status === 'expired' || (c.status === 'issued' && c.expiring_soon)) {
        expiring += 1
      }
    }
    return { total: certs.length, issued, pending, expiring }
  }, [certs])

  const totalPages = Math.max(1, Math.ceil(certs.length / CERTS_PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pagedCerts = useMemo(() => {
    const start = (safePage - 1) * CERTS_PAGE_SIZE
    return certs.slice(start, start + CERTS_PAGE_SIZE)
  }, [certs, safePage])

  const pageTokens = useMemo<(number | 'ellipsis')[]>(() => {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1)
    }
    const items: (number | 'ellipsis')[] = [1]
    const left = Math.max(2, safePage - 1)
    const right = Math.min(totalPages - 1, safePage + 1)
    if (left > 2) items.push('ellipsis')
    for (let p = left; p <= right; p += 1) items.push(p)
    if (right < totalPages - 1) items.push('ellipsis')
    items.push(totalPages)
    return items
  }, [safePage, totalPages])

  function openApplyModal() {
    const defaultTcAcct = tencentAccounts[0]?.id ?? 0
    const defaultSwas = tencentSwas[0]?.id ?? 0
    const defaultDnsAcct = dnsAccounts[0]?.id ?? 0
    const credSource: CertApplyForm['cred_source'] = defaultTcAcct
      ? 'dns_account'
      : defaultSwas
        ? 'tencent_swas'
        : 'manual'

    setApplyModal({
      domain: '',
      cred_source: credSource,
      tencent_account_id: defaultTcAcct,
      tencent_swas_id: defaultSwas,
      tencent_secret_id: '',
      tencent_secret_key: '',
      dns_verify_mode: defaultDnsAcct ? 'dns_account' : 'tencent_auto',
      dns_account_id: defaultDnsAcct,
      encrypt_algo: 'RSA',
      auto_renew: true,
      renew_before_days: 7,
      clean_dns_after_issue: true,
      contact_email: '',
      remark: '',
    })
  }

  async function submitApply() {
    if (!applyModal) return
    if (!applyModal.domain.trim()) {
      onToast('请输入要申请 443 证书的域名', 'error')
      return
    }
    setApplying(true)
    try {
      const payload: Record<string, unknown> = {
        domain: applyModal.domain.trim(),
        dns_verify_mode: applyModal.dns_verify_mode,
        dns_account_id:
          applyModal.dns_verify_mode === 'dns_account' ? applyModal.dns_account_id : 0,
        encrypt_algo: applyModal.encrypt_algo,
        auto_renew: applyModal.auto_renew,
        renew_before_days: applyModal.renew_before_days,
        clean_dns_after_issue: applyModal.clean_dns_after_issue,
        contact_email: applyModal.contact_email.trim(),
        remark: applyModal.remark.trim(),
      }
      if (applyModal.cred_source === 'dns_account') {
        payload.tencent_account_id = applyModal.tencent_account_id
      } else if (applyModal.cred_source === 'tencent_swas') {
        payload.tencent_swas_id = applyModal.tencent_swas_id
      } else {
        payload.tencent_secret_id = applyModal.tencent_secret_id.trim()
        payload.tencent_secret_key = applyModal.tencent_secret_key.trim()
      }
      const res = await post<{
        ok: boolean
        item: SslCertificateItem
        dns_action: string
        verify_triggered: boolean
      }>('/api/v1/certs/apply', payload, SLOW_TIMEOUT_MS)

      const stepNote =
        res.item.status === 'issued'
          ? '证书已签发！'
          : res.dns_action === 'created' || res.dns_action === 'updated'
            ? '已自动写入 DNS 验证记录并触发验证'
            : res.verify_triggered
              ? '已提交申请并触发域名验证'
              : '已提交申请，后台 Cron 将自动跟进验证'
      onToast(`${res.item.domain}：${stepNote}`, 'success')
      setApplyModal(null)
      setPage(1)
      await loadCerts()
      onChanged?.()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '证书申请失败', 'error')
    } finally {
      setApplying(false)
    }
  }

  function openSyncModal() {
    setSyncTencentAccountId(tencentAccounts[0]?.id ?? 0)
    setSyncDnsMode(dnsAccounts.length > 0 ? 'dns_account' : 'tencent_auto')
    setSyncDnsAccountId(dnsAccounts[0]?.id ?? 0)
    setSyncModalOpen(true)
  }

  async function submitSync() {
    if (!syncTencentAccountId) {
      onToast('请先在「域名解析」中接入腾讯云账号', 'error')
      return
    }
    setSyncing(true)
    try {
      const res = await post<{
        imported: number
        updated: number
        cleaned?: number
        totalRemote: number
      }>(
        '/api/v1/certs/sync',
        {
          tencent_account_id: syncTencentAccountId,
          dns_verify_mode: syncDnsMode,
          dns_account_id: syncDnsMode === 'dns_account' ? syncDnsAccountId : 0,
          auto_renew: true,
        },
        SLOW_TIMEOUT_MS,
      )
      const cleanedNote = res.cleaned ? `，自动清理旧/过期 ${res.cleaned} 张` : ''
      onToast(
        `同步完成：云端 ${res.totalRemote} 张，新导入 ${res.imported} 张，更新 ${res.updated} 张${cleanedNote}`,
        'success',
      )
      setSyncModalOpen(false)
      setPage(1)
      await loadCerts()
      onChanged?.()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '同步证书失败', 'error')
    } finally {
      setSyncing(false)
    }
  }

  async function runReconcileNow() {
    setReconciling(true)
    try {
      const res = await post<{
        summary: {
          checked: number
          issued: number
          renewalsStarted: number
          dnsWritten: number
          cleaned?: number
          errors: string[]
        }
      }>('/api/v1/certs/reconcile', {}, SLOW_TIMEOUT_MS)
      const s = res.summary
      const cleanedNote = s.cleaned ? `，自动清理旧/过期 ${s.cleaned} 张` : ''
      const msg = `巡检完成：检查 ${s.checked} 项，自动续签 ${s.renewalsStarted} 张，写入验证解析 ${s.dnsWritten} 条，新签发 ${s.issued} 张${cleanedNote}`
      onToast(
        s.errors.length > 0 ? `${msg}（异常 ${s.errors.length} 项）` : msg,
        s.errors.length > 0 ? 'info' : 'success',
      )
      await loadCerts()
      onChanged?.()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '巡检失败', 'error')
    } finally {
      setReconciling(false)
    }
  }

  async function verifyCert(cert: SslCertificateItem) {
    setBusyId(cert.id)
    try {
      const res = await post<{
        item: SslCertificateItem
        dns_action: string
        just_issued: boolean
      }>(`/api/v1/certs/${cert.id}/verify`, {}, SLOW_TIMEOUT_MS)
      if (res.just_issued) {
        onToast(`${cert.domain} 证书已通过验证并签发！`, 'success')
      } else if (res.dns_action === 'created' || res.dns_action === 'updated') {
        onToast(`${cert.domain} 已补写 DNS 验证记录并主动触发验证`, 'success')
      } else {
        onToast(`${cert.domain} 状态已刷新（${res.item.status_name || res.item.status}）`, 'info')
      }
      await loadCerts()
      onChanged?.()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '触发验证失败', 'error')
    } finally {
      setBusyId(0)
    }
  }

  async function renewCertNow(cert: SslCertificateItem) {
    setBusyId(cert.id)
    try {
      const res = await post<{
        new_cert_id: string
        item: SslCertificateItem
      }>(`/api/v1/certs/${cert.id}/renew`, {}, SLOW_TIMEOUT_MS)
      onToast(
        res.item.status === 'issued' && !res.item.has_pending_renewal
          ? `${cert.domain} 续签证书（${res.new_cert_id}）已签发！`
          : `${cert.domain} 已发起续签申请（${res.new_cert_id}）并自动解析验证`,
        'success',
      )
      await loadCerts()
      onChanged?.()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '发起续签失败', 'error')
    } finally {
      setBusyId(0)
    }
  }

  async function toggleAutoRenew(cert: SslCertificateItem, nextVal: boolean) {
    setBusyId(cert.id)
    try {
      await patch(`/api/v1/certs/${cert.id}`, { auto_renew: nextVal })
      onToast(
        nextVal
          ? `已开启 ${cert.domain} 到期前 ${cert.renew_before_days} 天自动续签`
          : `已关闭 ${cert.domain} 自动续签`,
        'info',
      )
      await loadCerts()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '更新设置失败', 'error')
    } finally {
      setBusyId(0)
    }
  }

  async function openDetail(cert: SslCertificateItem) {
    setDetailCert(cert)
    setDetailData(null)
    setDetailError('')
    setLoadingDetail(true)
    try {
      const res = await api<SslCertDetailResponse>(
        `/api/v1/certs/${cert.id}/detail`,
        { timeoutMs: SLOW_TIMEOUT_MS },
      )
      setDetailData(res)
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : '加载证书详情失败')
    } finally {
      setLoadingDetail(false)
    }
  }

  async function saveEditModal() {
    if (!editModal) return
    setSavingEdit(true)
    try {
      await patch(`/api/v1/certs/${editModal.id}`, {
        dns_verify_mode: editModal.dns_verify_mode,
        dns_account_id:
          editModal.dns_verify_mode === 'dns_account' ? editModal.dns_account_id : 0,
        auto_renew: editModal.auto_renew,
        renew_before_days: editModal.renew_before_days,
        clean_dns_after_issue: editModal.clean_dns_after_issue,
        remark: editModal.remark,
      })
      onToast('证书续签与验证配置已保存', 'success')
      setEditModal(null)
      await loadCerts()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSavingEdit(false)
    }
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text)
      onToast(`已复制${label}`, 'success')
    } catch {
      onToast('浏览器拒绝了剪贴板访问，请手动全选复制', 'error')
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>证书服务</h1>
          <p>
            申请腾讯云免费 443 HTTPS 证书（TrustAsia DV），自动完成 DNS 解析验证，并在到期前 7 天自动重新申请与解析验证。
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn ghost sm"
            disabled={reconciling}
            onClick={() => void runReconcileNow()}
          >
            {reconciling ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />}{' '}
            立即巡检续签
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={openSyncModal}
          >
            <RefreshCw size={13} /> 同步腾讯云证书
          </button>
          <button type="button" className="btn primary sm" onClick={openApplyModal}>
            <Plus size={13} /> 申请 443 证书
          </button>
        </div>
      </div>

      {/* 汇总条 */}
      <div className="certs-kpi-grid">
        <div className="card certs-kpi">
          <span>托管证书</span>
          <strong>{stats.total}</strong>
        </div>
        <div className="card certs-kpi">
          <span>已签发生效</span>
          <strong className="tone-green">{stats.issued}</strong>
        </div>
        <div className="card certs-kpi">
          <span>验证 / 续签中</span>
          <strong className="tone-blue">{stats.pending}</strong>
        </div>
        <div className="card certs-kpi">
          <span>7 天内到期 / 已过期</span>
          <strong className={stats.expiring > 0 ? 'tone-amber' : ''}>{stats.expiring}</strong>
        </div>
      </div>

      {loading ? (
        <div className="card cloud-dns-loading">
          <LoaderCircle size={16} className="spin" /> 正在加载证书列表…
        </div>
      ) : certs.length === 0 ? (
        <div className="card">
          <Empty icon={<ShieldCheck size={24} />} title="还没有托管的 443 SSL 证书">
            点击右上角「申请 443 证书」直接向腾讯云申请免费 HTTPS 证书，面板会自动把 TXT / CNAME 验证记录写入您绑定的腾讯云 DNSPod 或 Cloudflare 账号并触发验证；距离到期不足 7 天时后台定时任务会自动重新申请并完成解析验证。
            {dnsAccounts.length === 0 && onGoDnsAccounts && (
              <div style={{ marginTop: 12 }}>
                <button type="button" className="btn sm" onClick={onGoDnsAccounts}>
                  <Globe2 size={13} /> 先去「域名解析」接入腾讯云 / Cloudflare 账号
                </button>
              </div>
            )}
          </Empty>
        </div>
      ) : (
        <>
          <div className="certs-list">
            {pagedCerts.map((cert) => {
              const badge = certStatusBadge(cert)
              const isBusy = busyId === cert.id
              return (
                <div key={cert.id} className="card cert-card">
                  <div className="cert-card-head">
                    <div className="cert-domain-wrap">
                      <ShieldCheck size={16} style={{ color: 'var(--accent)' }} />
                      <span className="cert-domain">{cert.domain}</span>
                      <Badge tone={badge.tone} pulse={badge.pulse}>
                        {badge.text}
                      </Badge>
                      <Badge tone="gray" dot={false}>
                        {cert.encrypt_algo}
                      </Badge>
                      {cert.remaining_days !== null && (
                        <Badge
                          tone={
                            cert.remaining_days <= 0
                              ? 'red'
                              : cert.remaining_days <= cert.renew_before_days
                                ? 'amber'
                                : 'green'
                          }
                          dot={false}
                        >
                          <Clock size={11} style={{ marginRight: 3 }} />
                          {cert.remaining_days <= 0
                            ? `已过期 ${Math.abs(cert.remaining_days)} 天`
                            : `剩余 ${cert.remaining_days} 天`}
                        </Badge>
                      )}
                    </div>

                    <div className="cert-auto-toggle">
                      <span className="muted-xs">到期前 {cert.renew_before_days} 天自动续签</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={cert.auto_renew}
                        aria-label={`自动续签 ${cert.domain}`}
                        className={`switch${cert.auto_renew ? ' on' : ''}`}
                        disabled={isBusy}
                        onClick={() => void toggleAutoRenew(cert, !cert.auto_renew)}
                      />
                    </div>
                  </div>

                  <div className="cert-meta-grid">
                    <div>
                      <span className="cert-meta-k">腾讯云账号</span>
                      <span className="cert-meta-v">{cert.tencent_account_label}</span>
                    </div>
                    <div>
                      <span className="cert-meta-k">自动验证方式</span>
                      <span className="cert-meta-v">{cert.dns_account_label}</span>
                    </div>
                    <div>
                      <span className="cert-meta-k">证书 ID</span>
                      <span className="cert-meta-v mono">
                        {cert.cert_id || '-'}
                        {cert.pending_cert_id && (
                          <span className="cert-pending-id"> → 新单 {cert.pending_cert_id}</span>
                        )}
                      </span>
                    </div>
                    <div>
                      <span className="cert-meta-k">有效期</span>
                      <span className="cert-meta-v mono">
                        {cert.cert_begin_time && cert.cert_end_time
                          ? `${cert.cert_begin_time.slice(0, 10)} ~ ${cert.cert_end_time.slice(0, 10)}`
                          : cert.status_name || '等待签发'}
                      </span>
                    </div>
                  </div>

                  {/* 待验证 / 续签中时展示当前 DNS 解析验证详情 */}
                  {(cert.status === 'pending_dns' ||
                    cert.status === 'verifying' ||
                    cert.has_pending_renewal) &&
                    cert.dv_auth_value && (
                      <div className="cert-dv-box">
                        <div className="cert-dv-head">
                          <strong>当前 DNS 验证记录</strong>
                          {cert.dns_record_written ? (
                            <Badge tone="green" dot={false}>
                              <CheckCircle2 size={11} style={{ marginRight: 3 }} /> 已自动写入云解析
                            </Badge>
                          ) : cert.dns_verify_mode === 'tencent_auto' ? (
                            <Badge tone="blue" dot={false}>
                              腾讯云 DNS_AUTO 自动托管
                            </Badge>
                          ) : (
                            <Badge tone="amber" dot={false}>
                              待写入验证解析
                            </Badge>
                          )}
                        </div>
                        <div className="cert-dv-fields">
                          <span>
                            类型：<code>{cert.dv_auth_type || 'TXT'}</code>
                          </span>
                          <span>
                            主机记录：<code>{cert.dv_auth_sub_domain}</code>
                          </span>
                          <span className="cert-dv-val">
                            记录值：<code>{cert.dv_auth_value}</code>
                          </span>
                        </div>
                      </div>
                    )}

                  {cert.last_error && (
                    <div className="cert-error">
                      <AlertTriangle size={13} />
                      <span>{cert.last_error}</span>
                    </div>
                  )}

                  <div className="cert-card-foot">
                    <span className="muted-xs">
                      {cert.last_checked_at
                        ? `上次检查：${timeAgo(cert.last_checked_at)}`
                        : '尚未巡检'}
                      {cert.remark ? ` · ${cert.remark}` : ''}
                    </span>

                    <div className="cert-card-actions">
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={isBusy}
                        onClick={() => void openDetail(cert)}
                      >
                        <FileKey2 size={13} /> 详情 / PEM
                      </button>
                      {cert.status === 'issued' && cert.cert_id && (
                        <a
                          className="btn ghost sm"
                          href={`/api/v1/certs/${cert.id}/download`}
                          download
                        >
                          <Download size={13} /> 下载 ZIP
                        </a>
                      )}
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={isBusy}
                        onClick={() => void verifyCert(cert)}
                      >
                        {isBusy ? (
                          <LoaderCircle size={13} className="spin" />
                        ) : (
                          <RefreshCw size={13} />
                        )}{' '}
                        验证 / 刷新
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={isBusy}
                        onClick={() => void renewCertNow(cert)}
                      >
                        <RotateCw size={13} /> 立即续签
                      </button>
                      <button
                        type="button"
                        className="btn ghost icon sm"
                        title="续签与验证配置"
                        onClick={() =>
                          setEditModal({
                            id: cert.id,
                            domain: cert.domain,
                            dns_verify_mode: cert.dns_verify_mode,
                            dns_account_id: cert.dns_account_id || dnsAccounts[0]?.id || 0,
                            auto_renew: cert.auto_renew,
                            renew_before_days: cert.renew_before_days,
                            clean_dns_after_issue: cert.clean_dns_after_issue,
                            remark: cert.remark,
                          })
                        }
                      >
                        <Settings2 size={13} />
                      </button>
                      <button
                        type="button"
                        className="btn ghost icon sm"
                        title="移除托管"
                        onClick={() => {
                          setDeleteRemote(false)
                          setDeleteTarget(cert)
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {totalPages > 1 && (
            <div className="card certs-pager">
              <div className="cloud-dns-pager" role="navigation" aria-label="证书分页">
                <span className="cloud-dns-pager-info">
                  共 {certs.length} 张 · 第 {(safePage - 1) * CERTS_PAGE_SIZE + 1}–
                  {Math.min(safePage * CERTS_PAGE_SIZE, certs.length)} 张（{safePage} / {totalPages} 页）
                </span>
                <div className="cloud-dns-pager-controls">
                  <button
                    type="button"
                    className="cloud-dns-page-btn"
                    disabled={safePage <= 1}
                    onClick={() => setPage(Math.max(1, safePage - 1))}
                  >
                    <ChevronLeft size={13} /> 上一页
                  </button>
                  {pageTokens.map((tok, idx) =>
                    tok === 'ellipsis' ? (
                      <span key={`e-${idx}`} className="cloud-dns-page-ellipsis">
                        …
                      </span>
                    ) : (
                      <button
                        key={tok}
                        type="button"
                        className={`cloud-dns-page-btn${tok === safePage ? ' on' : ''}`}
                        aria-current={tok === safePage ? 'page' : undefined}
                        onClick={() => setPage(tok)}
                      >
                        {tok}
                      </button>
                    ),
                  )}
                  <button
                    type="button"
                    className="cloud-dns-page-btn"
                    disabled={safePage >= totalPages}
                    onClick={() => setPage(Math.min(totalPages, safePage + 1))}
                  >
                    下一页 <ChevronRight size={13} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* 申请 443 免费证书弹窗 */}
      {applyModal && (
        <Modal
          title="申请腾讯云 443 免费 SSL 证书"
          icon={<ShieldCheck size={16} style={{ color: 'var(--accent)' }} />}
          wide
          onClose={() => !applying && setApplyModal(null)}
          footer={
            <>
              <button
                type="button"
                className="btn ghost"
                disabled={applying}
                onClick={() => setApplyModal(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={applying}
                onClick={() => void submitApply()}
              >
                {applying && <LoaderCircle size={13} className="spin" />} 提交申请并自动解析验证
              </button>
            </>
          }
        >
          <div className="form-stack">
            <div className="grid-2">
              <div className="field">
                <label>申请域名（单域名）</label>
                <input
                  className="input"
                  placeholder="例如：example.com 或 api.example.com"
                  value={applyModal.domain}
                  onChange={(e) => setApplyModal({ ...applyModal, domain: e.target.value })}
                />
                <div className="hint">
                  腾讯云免费 TrustAsia C1 DV 证书有效期 3 个月，支持 443 HTTPS 服务，暂不支持泛域名。
                </div>
              </div>
              <div className="field">
                <label>密钥算法</label>
                <Segmented<'RSA' | 'ECC'>
                  value={applyModal.encrypt_algo}
                  options={[
                    { value: 'RSA', label: 'RSA（通用推荐）' },
                    { value: 'ECC', label: 'ECC（更轻量）' },
                  ]}
                  onChange={(v) => setApplyModal({ ...applyModal, encrypt_algo: v })}
                />
              </div>
            </div>

            <div className="field">
              <label>腾讯云 SSL 账号凭据来源</label>
              <Segmented<'dns_account' | 'tencent_swas' | 'manual'>
                value={applyModal.cred_source}
                options={[
                  { value: 'dns_account', label: `腾讯云 DNS 账号 (${tencentAccounts.length})` },
                  { value: 'tencent_swas', label: `腾讯云轻量密钥 (${tencentSwas.length})` },
                  { value: 'manual', label: '手动填写密钥' },
                ]}
                onChange={(v) => setApplyModal({ ...applyModal, cred_source: v })}
              />
            </div>

            {applyModal.cred_source === 'dns_account' && (
              <div className="field">
                <label>选择腾讯云账号</label>
                <select
                  className="select"
                  value={applyModal.tencent_account_id}
                  onChange={(e) =>
                    setApplyModal({ ...applyModal, tencent_account_id: Number(e.target.value) })
                  }
                >
                  <option value={0}>请选择腾讯云账号…</option>
                  {tencentAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}（{a.cred_id_preview}）
                    </option>
                  ))}
                </select>
                {tencentAccounts.length === 0 && (
                  <div className="hint">
                    尚未在「域名解析」添加腾讯云账号，可先切换「手动填写密钥」或前往添加。
                  </div>
                )}
              </div>
            )}

            {applyModal.cred_source === 'tencent_swas' && (
              <div className="field">
                <label>复用已有腾讯云轻量服务器密钥</label>
                <select
                  className="select"
                  value={applyModal.tencent_swas_id}
                  onChange={(e) =>
                    setApplyModal({ ...applyModal, tencent_swas_id: Number(e.target.value) })
                  }
                >
                  <option value={0}>请选择腾讯云轻量服务器…</option>
                  {tencentSwas.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}（{s.access_key_id_preview}）
                    </option>
                  ))}
                </select>
              </div>
            )}

            {applyModal.cred_source === 'manual' && (
              <div className="grid-2">
                <div className="field">
                  <label>腾讯云 SecretId</label>
                  <input
                    className="input"
                    placeholder="AKID..."
                    value={applyModal.tencent_secret_id}
                    onChange={(e) =>
                      setApplyModal({ ...applyModal, tencent_secret_id: e.target.value })
                    }
                  />
                </div>
                <div className="field">
                  <label>腾讯云 SecretKey</label>
                  <input
                    className="input"
                    type="password"
                    placeholder="请输入 SecretKey"
                    value={applyModal.tencent_secret_key}
                    onChange={(e) =>
                      setApplyModal({ ...applyModal, tencent_secret_key: e.target.value })
                    }
                  />
                </div>
              </div>
            )}

            <div className="field">
              <label>域名所有权验证方式</label>
              <Segmented<SslVerifyMode>
                value={applyModal.dns_verify_mode}
                options={[
                  { value: 'dns_account', label: '自动解析验证（DNSPod / Cloudflare）' },
                  { value: 'tencent_auto', label: '腾讯云同账号 DNS_AUTO' },
                  { value: 'manual', label: '仅显示验证值（手动）' },
                ]}
                onChange={(v) => setApplyModal({ ...applyModal, dns_verify_mode: v })}
              />
            </div>

            {applyModal.dns_verify_mode === 'dns_account' && (
              <div className="field">
                <label>绑定用于自动写入验证记录的云解析账号</label>
                <select
                  className="select"
                  value={applyModal.dns_account_id}
                  onChange={(e) =>
                    setApplyModal({ ...applyModal, dns_account_id: Number(e.target.value) })
                  }
                >
                  <option value={0}>请选择腾讯云 DNSPod 或 Cloudflare 账号…</option>
                  {dnsAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      [{a.provider === 'tencent' ? '腾讯云 DNSPod' : 'Cloudflare'}] {a.label}
                    </option>
                  ))}
                </select>
                <div className="hint">
                  申请提交与到期前自动续签时，系统会自动把 CA 下发的 TXT / CNAME 验证记录写入该账号并触发验证。
                </div>
              </div>
            )}

            <div className="ops-card">
              <Switch
                checked={applyModal.auto_renew}
                onChange={(v) => setApplyModal({ ...applyModal, auto_renew: v })}
                label="到期前自动重新申请并完成解析验证"
                hint="后台定时巡检会在证书距离过期达到设定天数时自动提交新申请、写入验证解析并完成签发"
              />
              {applyModal.auto_renew && (
                <div className="grid-2" style={{ marginTop: 8 }}>
                  <div className="field">
                    <label>到期前提前续签天数</label>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={30}
                      value={applyModal.renew_before_days}
                      onChange={(e) =>
                        setApplyModal({
                          ...applyModal,
                          renew_before_days: Math.max(1, Math.min(30, Number(e.target.value) || 7)),
                        })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>联系邮箱（可选）</label>
                    <input
                      className="input"
                      placeholder="选填，用于腾讯云证书通知"
                      value={applyModal.contact_email}
                      onChange={(e) =>
                        setApplyModal({ ...applyModal, contact_email: e.target.value })
                      }
                    />
                  </div>
                </div>
              )}
              <div style={{ marginTop: 8 }}>
                <Switch
                  checked={applyModal.clean_dns_after_issue}
                  onChange={(v) => setApplyModal({ ...applyModal, clean_dns_after_issue: v })}
                  label="签发完成后自动清理临时验证记录"
                  hint="保持域名解析列表整洁，避免残留过期的 _dnsauth 记录"
                />
              </div>
            </div>

            <div className="field">
              <label>备注（可选）</label>
              <input
                className="input"
                placeholder="例如：主站 443 网关证书"
                value={applyModal.remark}
                onChange={(e) => setApplyModal({ ...applyModal, remark: e.target.value })}
              />
            </div>
          </div>
        </Modal>
      )}

      {/* 同步腾讯云已有证书弹窗 */}
      {syncModalOpen && (
        <Modal
          title="从腾讯云账号同步已有证书"
          icon={<RefreshCw size={16} style={{ color: 'var(--accent)' }} />}
          onClose={() => !syncing && setSyncModalOpen(false)}
          footer={
            <>
              <button
                type="button"
                className="btn ghost"
                disabled={syncing}
                onClick={() => setSyncModalOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={syncing || !syncTencentAccountId}
                onClick={() => void submitSync()}
              >
                {syncing && <LoaderCircle size={13} className="spin" />} 开始同步
              </button>
            </>
          }
        >
          <div className="form-stack">
            <div className="field">
              <label>选择腾讯云账号</label>
              <select
                className="select"
                value={syncTencentAccountId}
                onChange={(e) => setSyncTencentAccountId(Number(e.target.value))}
              >
                <option value={0}>请选择腾讯云账号…</option>
                {tencentAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}（{a.cred_id_preview}）
                  </option>
                ))}
              </select>
              {tencentAccounts.length === 0 && (
                <div className="hint">请先在「域名解析」中接入至少一个腾讯云账号。</div>
              )}
            </div>
            <div className="field">
              <label>新导入证书的默认自动续签验证方式</label>
              <Segmented<SslVerifyMode>
                value={syncDnsMode}
                options={[
                  { value: 'dns_account', label: '绑定云解析账号' },
                  { value: 'tencent_auto', label: '腾讯云 DNS_AUTO' },
                  { value: 'manual', label: '手动' },
                ]}
                onChange={setSyncDnsMode}
              />
            </div>
            {syncDnsMode === 'dns_account' && (
              <div className="field">
                <label>自动解析验证账号</label>
                <select
                  className="select"
                  value={syncDnsAccountId}
                  onChange={(e) => setSyncDnsAccountId(Number(e.target.value))}
                >
                  <option value={0}>默认使用同腾讯云账号</option>
                  {dnsAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      [{a.provider === 'tencent' ? '腾讯云 DNSPod' : 'Cloudflare'}] {a.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* 编辑证书续签设置弹窗 */}
      {editModal && (
        <Modal
          title={`续签与验证配置 · ${editModal.domain}`}
          icon={<Settings2 size={16} style={{ color: 'var(--accent)' }} />}
          onClose={() => !savingEdit && setEditModal(null)}
          footer={
            <>
              <button
                type="button"
                className="btn ghost"
                disabled={savingEdit}
                onClick={() => setEditModal(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={savingEdit}
                onClick={() => void saveEditModal()}
              >
                {savingEdit && <LoaderCircle size={13} className="spin" />} 保存设置
              </button>
            </>
          }
        >
          <div className="form-stack">
            <Switch
              checked={editModal.auto_renew}
              onChange={(v) => setEditModal({ ...editModal, auto_renew: v })}
              label="启用到期前自动续签与自动解析验证"
            />
            <div className="field">
              <label>提前续签天数（默认 7 天）</label>
              <input
                className="input"
                type="number"
                min={1}
                max={30}
                value={editModal.renew_before_days}
                onChange={(e) =>
                  setEditModal({
                    ...editModal,
                    renew_before_days: Math.max(1, Math.min(30, Number(e.target.value) || 7)),
                  })
                }
              />
            </div>
            <div className="field">
              <label>DNS 自动验证方式</label>
              <Segmented<SslVerifyMode>
                value={editModal.dns_verify_mode}
                options={[
                  { value: 'dns_account', label: '绑定云解析账号' },
                  { value: 'tencent_auto', label: '腾讯云 DNS_AUTO' },
                  { value: 'manual', label: '手动' },
                ]}
                onChange={(v) => setEditModal({ ...editModal, dns_verify_mode: v })}
              />
            </div>
            {editModal.dns_verify_mode === 'dns_account' && (
              <div className="field">
                <label>自动解析验证账号</label>
                <select
                  className="select"
                  value={editModal.dns_account_id}
                  onChange={(e) =>
                    setEditModal({ ...editModal, dns_account_id: Number(e.target.value) })
                  }
                >
                  <option value={0}>请选择云解析账号…</option>
                  {dnsAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      [{a.provider === 'tencent' ? '腾讯云 DNSPod' : 'Cloudflare'}] {a.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <Switch
              checked={editModal.clean_dns_after_issue}
              onChange={(v) => setEditModal({ ...editModal, clean_dns_after_issue: v })}
              label="签发后自动清理临时验证记录"
            />
            <div className="field">
              <label>备注</label>
              <input
                className="input"
                value={editModal.remark}
                onChange={(e) => setEditModal({ ...editModal, remark: e.target.value })}
              />
            </div>
          </div>
        </Modal>
      )}

      {/* 证书详情与 PEM / 私钥弹窗 */}
      {detailCert && (
        <Modal
          title={`证书详情与 PEM · ${detailCert.domain}`}
          icon={<FileKey2 size={16} style={{ color: 'var(--accent)' }} />}
          wide
          onClose={() => setDetailCert(null)}
          footer={
            <>
              {detailCert.status === 'issued' && detailCert.cert_id && (
                <a
                  className="btn"
                  href={`/api/v1/certs/${detailCert.id}/download`}
                  download
                >
                  <Download size={13} /> 下载腾讯云官方 ZIP 证书包
                </a>
              )}
              <button type="button" className="btn primary" onClick={() => setDetailCert(null)}>
                关闭
              </button>
            </>
          }
        >
          {loadingDetail ? (
            <div className="cloud-dns-loading">
              <LoaderCircle size={15} className="spin" /> 正在从腾讯云读取证书内容…
            </div>
          ) : detailError ? (
            <div className="cloud-dns-error">{detailError}</div>
          ) : detailData ? (
            <div className="form-stack cert-detail-stack">
              <div className="cert-meta-grid cert-detail-meta">
                <div>
                  <span className="cert-meta-k">证书 ID</span>
                  <span className="cert-meta-v mono">{detailData.certificate_id}</span>
                </div>
                <div>
                  <span className="cert-meta-k">证书产品</span>
                  <span className="cert-meta-v">{detailData.product_name}</span>
                </div>
                <div>
                  <span className="cert-meta-k">状态</span>
                  <span className="cert-meta-v">
                    {detailData.status_name}
                    {detailData.status_msg ? ` (${detailData.status_msg})` : ''}
                  </span>
                </div>
                <div>
                  <span className="cert-meta-k">有效期</span>
                  <span className="cert-meta-v mono cert-validity-range">
                    <span>{detailData.cert_begin_time || '-'}</span>
                    <span>~ {detailData.cert_end_time || '-'}</span>
                  </span>
                </div>
              </div>

              {detailData.verification && (
                <div className="ops-card">
                  <div className="ops-card-head">
                    <strong>CA 域名验证实时诊断</strong>
                    <Badge tone={detailData.verification.issued ? 'green' : 'blue'} dot={false}>
                      {detailData.verification.issued ? '已签发' : '检测中'}
                    </Badge>
                  </div>
                  <div className="muted-xs">
                    腾讯云本地检测：{detailData.verification.localCheck === 1 ? '通过' : `未通过 (${detailData.verification.localCheck})`}
                    {' · '}CA 检测：{detailData.verification.caCheck === 2 ? '通过' : '等待中'}
                    {detailData.verification.failReason
                      ? ` · 原因：${detailData.verification.failReason}`
                      : ''}
                  </div>
                </div>
              )}

              {detailData.dv_auth && (
                <div className="cert-dv-box">
                  <div className="cert-dv-head">
                    <strong>DNS 验证记录</strong>
                  </div>
                  <div className="cert-dv-fields">
                    <span>
                      类型：<code>{detailData.dv_auth.verifyType}</code>
                    </span>
                    <span>
                      主机记录：<code>{detailData.dv_auth.subDomain}</code>
                    </span>
                    <span className="cert-dv-val">
                      记录值：<code>{detailData.dv_auth.value}</code>
                    </span>
                  </div>
                </div>
              )}

              {detailData.certificate_public_key ? (
                <div className="cert-pem-stack">
                  <div className="cert-pem-card">
                    <div className="cert-pem-head">
                      <div className="cert-pem-title">
                        <strong>证书公钥链</strong>
                        <code>fullchain.pem / .crt</code>
                      </div>
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => void copyText(detailData.certificate_public_key, '证书 PEM')}
                      >
                        <Copy size={12} /> 复制证书
                      </button>
                    </div>
                    <textarea
                      className="textarea cert-pem-box"
                      readOnly
                      spellCheck={false}
                      rows={9}
                      value={detailData.certificate_public_key}
                    />
                  </div>
                  <div className="cert-pem-card">
                    <div className="cert-pem-head">
                      <div className="cert-pem-title">
                        <strong>证书私钥</strong>
                        <code>private.key</code>
                      </div>
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => void copyText(detailData.certificate_private_key, '证书私钥')}
                      >
                        <Copy size={12} /> 复制私钥
                      </button>
                    </div>
                    <textarea
                      className="textarea cert-pem-box"
                      readOnly
                      spellCheck={false}
                      rows={9}
                      value={detailData.certificate_private_key}
                    />
                  </div>
                </div>
              ) : (
                <div className="cloud-dns-empty-sm">
                  证书尚未签发，待验证通过后即可在此查看并复制 PEM 证书链与私钥，或下载官方 ZIP 压缩包。
                </div>
              )}
            </div>
          ) : null}
        </Modal>
      )}

      {/* 删除确认弹窗 */}
      {deleteTarget && (
        <ConfirmDialog
          title="移除托管证书"
          message={`确定从面板移除域名「${deleteTarget.domain}」的证书托管记录吗？`}
          hint="移除后后台 Cron 将不再为该证书自动续签。"
          confirmText="确认移除"
          busy={deleting}
          onCancel={() => !deleting && setDeleteTarget(null)}
          onConfirm={async () => {
            setDeleting(true)
            try {
              const res = await del<{ ok: boolean; remote_error?: string }>(
                `/api/v1/certs/${deleteTarget.id}${deleteRemote ? '?delete_remote=1' : ''}`,
                SLOW_TIMEOUT_MS,
              )
              onToast(
                res.remote_error
                  ? `已从面板移除（腾讯云侧未删除：${res.remote_error}）`
                  : `已移除 ${deleteTarget.domain} 证书托管`,
                'info',
              )
              setDeleteTarget(null)
              await loadCerts()
              onChanged?.()
            } catch (err) {
              onToast(err instanceof Error ? err.message : '移除失败', 'error')
            } finally {
              setDeleting(false)
            }
          }}
        >
          <div style={{ marginTop: 10 }}>
            <Switch
              checked={deleteRemote}
              onChange={setDeleteRemote}
              label="同时尝试删除腾讯云侧证书订单"
              hint="腾讯云已颁发证书或 1 小时内申请的免费证书可能不允许直接删除，失败时仅保留移除本地托管"
            />
          </div>
        </ConfirmDialog>
      )}
    </>
  )
}
