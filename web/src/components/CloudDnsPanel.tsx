import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Edit3,
  Globe2,
  KeyRound,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Trash2,
  Zap,
} from 'lucide-react'
import { SLOW_TIMEOUT_MS, api, del, post, put } from '../api'
import type {
  CloudDnsDomain,
  CloudDnsRecord,
  DnsAccount,
  DnsAccountAuthMode,
  DnsAccountProvider,
  ImportableDnsSources,
} from '../types'
import ConfirmDialog from './ConfirmDialog'
import { Badge, Empty, Modal, Segmented, Switch } from './ui'

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'] as const
const DNSPOD_LINES = ['默认', '电信', '联通', '移动', '教育网', '境外', '搜索引擎'] as const
const RECORDS_PAGE_SIZE = 20

type ToastFn = (message: string, tone?: 'success' | 'error' | 'info') => void

type Props = {
  onToast: ToastFn
  onChanged?: () => void
}

type AccountFormState = {
  id: number | null
  provider: DnsAccountProvider
  label: string
  auth_mode: DnsAccountAuthMode
  cred_id: string
  cred_secret: string
  remark: string
}

type RecordFormState = {
  id: string | null
  name: string
  type: string
  value: string
  ttl: string
  line: string
  mx: string
  proxied: boolean
  enabled: boolean
  remark: string
}

type ConfirmState = {
  title: string
  message: string
  hint?: string
  confirmText?: string
  run: () => Promise<void>
}

export default function CloudDnsPanel({ onToast, onChanged }: Props) {
  const [accounts, setAccounts] = useState<DnsAccount[]>([])
  const [importable, setImportable] = useState<ImportableDnsSources>({
    cloudflare_ddns: false,
    tencent_swas: [],
  })
  const [loadingAccounts, setLoadingAccounts] = useState(true)
  const [selectedAccountId, setSelectedAccountId] = useState<number>(0)

  const [domains, setDomains] = useState<CloudDnsDomain[]>([])
  const [loadingDomains, setLoadingDomains] = useState(false)
  const [domainsError, setDomainsError] = useState('')
  const [selectedDomain, setSelectedDomain] = useState<CloudDnsDomain | null>(null)

  const [records, setRecords] = useState<CloudDnsRecord[]>([])
  const [loadingRecords, setLoadingRecords] = useState(false)
  const [recordsError, setRecordsError] = useState('')
  const [keyword, setKeyword] = useState('')
  const [typeFilter, setTypeFilter] = useState('')

  const [testingAccountId, setTestingAccountId] = useState<number>(0)
  const [togglingRecordId, setTogglingRecordId] = useState<string>('')
  const [accountModal, setAccountModal] = useState<AccountFormState | null>(null)
  const [savingAccount, setSavingAccount] = useState(false)
  const [recordModal, setRecordModal] = useState<RecordFormState | null>(null)
  const [savingRecord, setSavingRecord] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === selectedAccountId) ?? null,
    [accounts, selectedAccountId],
  )

  const loadAccounts = useCallback(
    async (preferId?: number) => {
      setLoadingAccounts(true)
      try {
        const res = await api<{ items: DnsAccount[]; importable: ImportableDnsSources }>(
          '/api/v1/dns-accounts',
        )
        const list = res.items ?? []
        setAccounts(list)
        setImportable(res.importable ?? { cloudflare_ddns: false, tencent_swas: [] })
        setSelectedAccountId((prev) => {
          if (preferId && list.some((a) => a.id === preferId)) return preferId
          if (prev && list.some((a) => a.id === prev)) return prev
          return list[0]?.id ?? 0
        })
      } catch (err) {
        onToast(err instanceof Error ? err.message : '加载云解析账号失败', 'error')
      } finally {
        setLoadingAccounts(false)
      }
    },
    [onToast],
  )

  const loadDomains = useCallback(async (accountId: number) => {
    if (!accountId) {
      setDomains([])
      setSelectedDomain(null)
      return
    }
    setLoadingDomains(true)
    setDomainsError('')
    try {
      const res = await api<{ items: CloudDnsDomain[] }>(
        `/api/v1/dns-accounts/${accountId}/domains`,
        { timeoutMs: SLOW_TIMEOUT_MS },
      )
      const list = res.items ?? []
      setDomains(list)
      setSelectedDomain((prev) => {
        if (prev && list.some((d) => d.name === prev.name)) {
          return list.find((d) => d.name === prev.name) ?? list[0] ?? null
        }
        return list[0] ?? null
      })
    } catch (err) {
      setDomains([])
      setSelectedDomain(null)
      setDomainsError(err instanceof Error ? err.message : '拉取域名列表失败')
    } finally {
      setLoadingDomains(false)
    }
  }, [])

  const loadRecords = useCallback(
    async (accountId: number, domain: CloudDnsDomain | null) => {
      if (!accountId || !domain) {
        setRecords([])
        return
      }
      setLoadingRecords(true)
      setRecordsError('')
      try {
        const q = new URLSearchParams({
          domain: domain.name,
          zone_id: domain.id,
        })
        const res = await api<{ items: CloudDnsRecord[] }>(
          `/api/v1/dns-accounts/${accountId}/records?${q.toString()}`,
          { timeoutMs: SLOW_TIMEOUT_MS },
        )
        setRecords(res.items ?? [])
      } catch (err) {
        setRecords([])
        setRecordsError(err instanceof Error ? err.message : '拉取解析记录失败')
      } finally {
        setLoadingRecords(false)
      }
    },
    [],
  )

  useEffect(() => {
    void loadAccounts()
  }, [loadAccounts])

  useEffect(() => {
    setSelectedDomain(null)
    setRecords([])
    if (selectedAccountId) {
      void loadDomains(selectedAccountId)
    }
  }, [selectedAccountId, loadDomains])

  useEffect(() => {
    if (selectedAccountId && selectedDomain) {
      void loadRecords(selectedAccountId, selectedDomain)
    } else {
      setRecords([])
    }
  }, [selectedAccountId, selectedDomain, loadRecords])

  const [page, setPage] = useState(1)

  const filteredRecords = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    const tf = typeFilter.trim().toUpperCase()
    return records.filter((rec) => {
      if (tf && rec.type.toUpperCase() !== tf) return false
      if (kw) {
        const hay = `${rec.name} ${rec.full_name} ${rec.value} ${rec.remark}`.toLowerCase()
        if (!hay.includes(kw)) return false
      }
      return true
    })
  }, [records, keyword, typeFilter])

  useEffect(() => {
    setPage(1)
  }, [selectedAccountId, selectedDomain?.name, keyword, typeFilter])

  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / RECORDS_PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pagedRecords = useMemo(() => {
    const start = (safePage - 1) * RECORDS_PAGE_SIZE
    return filteredRecords.slice(start, start + RECORDS_PAGE_SIZE)
  }, [filteredRecords, safePage])

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

  function openNewAccount(provider: DnsAccountProvider = 'tencent') {
    setAccountModal({
      id: null,
      provider,
      label: '',
      auth_mode: provider === 'tencent' ? 'cam' : 'token',
      cred_id: '',
      cred_secret: '',
      remark: '',
    })
  }

  function openEditAccount(acct: DnsAccount) {
    setAccountModal({
      id: acct.id,
      provider: acct.provider,
      label: acct.label,
      auth_mode: acct.auth_mode,
      cred_id: acct.provider === 'cloudflare' ? acct.cred_id : '',
      cred_secret: '',
      remark: acct.remark,
    })
  }

  async function saveAccount() {
    if (!accountModal) return
    setSavingAccount(true)
    try {
      if (accountModal.id) {
        await put(`/api/v1/dns-accounts/${accountModal.id}`, {
          label: accountModal.label,
          auth_mode: accountModal.auth_mode,
          cred_id: accountModal.cred_id || undefined,
          cred_secret: accountModal.cred_secret || undefined,
          remark: accountModal.remark,
        })
        onToast('云解析账号已更新', 'success')
        setAccountModal(null)
        await loadAccounts(accountModal.id)
      } else {
        const res = await post<{ id: number }>('/api/v1/dns-accounts', {
          provider: accountModal.provider,
          label: accountModal.label,
          auth_mode: accountModal.auth_mode,
          cred_id: accountModal.cred_id,
          cred_secret: accountModal.cred_secret,
          remark: accountModal.remark,
        })
        onToast('云解析账号已添加', 'success')
        setAccountModal(null)
        await loadAccounts(res.id)
      }
      onChanged?.()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSavingAccount(false)
    }
  }

  async function quickImport(source: 'cf_ddns' | 'tencent_swas', swasId?: number) {
    setSavingAccount(true)
    try {
      const res = await post<{ id: number }>('/api/v1/dns-accounts', {
        import_from: source,
        swas_id: swasId,
      })
      onToast(
        source === 'cf_ddns' ? '已一键导入 Cloudflare DDNS 凭据' : '已一键导入腾讯云轻量凭据',
        'success',
      )
      setAccountModal(null)
      await loadAccounts(res.id)
      onChanged?.()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '导入失败', 'error')
    } finally {
      setSavingAccount(false)
    }
  }

  async function testAccount(acct: DnsAccount) {
    setTestingAccountId(acct.id)
    try {
      const res = await post<{ ok: boolean; message: string }>(
        `/api/v1/dns-accounts/${acct.id}/test`,
        {},
        SLOW_TIMEOUT_MS,
      )
      onToast(res.message || '连接成功', 'success')
    } catch (err) {
      onToast(err instanceof Error ? err.message : '连接测试失败', 'error')
    } finally {
      setTestingAccountId(0)
    }
  }

  function requestDeleteAccount(acct: DnsAccount) {
    setConfirm({
      title: '删除云解析账号',
      message: `确定删除「${acct.label}」（${acct.provider === 'tencent' ? '腾讯云 DNSPod' : 'Cloudflare'}）吗？`,
      hint: '仅移除面板保存的 API 凭据，不会删除云端域名和解析记录。若证书服务绑定了该账号，请记得更新证书绑定。',
      confirmText: '确认删除',
      run: async () => {
        await del(`/api/v1/dns-accounts/${acct.id}`)
        onToast(`已删除账号「${acct.label}」`, 'info')
        await loadAccounts()
        onChanged?.()
      },
    })
  }

  function openNewRecord() {
    if (!selectedAccount || !selectedDomain) return
    setRecordModal({
      id: null,
      name: '@',
      type: 'A',
      value: '',
      ttl: selectedAccount.provider === 'tencent' ? '600' : '1',
      line: '默认',
      mx: '10',
      proxied: false,
      enabled: true,
      remark: '',
    })
  }

  function openEditRecord(rec: CloudDnsRecord) {
    setRecordModal({
      id: rec.id,
      name: rec.name || '@',
      type: rec.type,
      value: rec.value,
      ttl: String(rec.ttl || (rec.provider === 'tencent' ? 600 : 1)),
      line: rec.line || '默认',
      mx: String(rec.mx ?? 10),
      proxied: Boolean(rec.proxied),
      enabled: rec.enabled,
      remark: rec.remark || '',
    })
  }

  async function saveRecord() {
    if (!recordModal || !selectedAccount || !selectedDomain) return
    setSavingRecord(true)
    try {
      const payload = {
        domain: selectedDomain.name,
        zone_id: selectedDomain.id,
        name: recordModal.name.trim() || '@',
        type: recordModal.type,
        value: recordModal.value.trim(),
        ttl: Number(recordModal.ttl) || (selectedAccount.provider === 'tencent' ? 600 : 1),
        line: selectedAccount.provider === 'tencent' ? recordModal.line || '默认' : undefined,
        mx: recordModal.type === 'MX' ? Number(recordModal.mx) || 10 : undefined,
        proxied: selectedAccount.provider === 'cloudflare' ? recordModal.proxied : false,
        enabled: recordModal.enabled,
        remark: recordModal.remark.trim(),
      }
      if (recordModal.id) {
        await put(
          `/api/v1/dns-accounts/${selectedAccount.id}/records/${encodeURIComponent(recordModal.id)}`,
          payload,
          SLOW_TIMEOUT_MS,
        )
        onToast('解析记录已更新', 'success')
      } else {
        await post(
          `/api/v1/dns-accounts/${selectedAccount.id}/records`,
          payload,
          SLOW_TIMEOUT_MS,
        )
        onToast('解析记录已添加', 'success')
      }
      setRecordModal(null)
      await loadRecords(selectedAccount.id, selectedDomain)
    } catch (err) {
      onToast(err instanceof Error ? err.message : '保存解析记录失败', 'error')
    } finally {
      setSavingRecord(false)
    }
  }

  async function toggleRecordState(rec: CloudDnsRecord) {
    if (!selectedAccount || !selectedDomain) return
    const nextVal = selectedAccount.provider === 'tencent' ? !rec.enabled : !rec.proxied
    setTogglingRecordId(rec.id)
    try {
      await post(
        `/api/v1/dns-accounts/${selectedAccount.id}/records/${encodeURIComponent(rec.id)}/status`,
        {
          domain: selectedDomain.name,
          zone_id: selectedDomain.id,
          enabled: nextVal,
        },
        SLOW_TIMEOUT_MS,
      )
      onToast(
        selectedAccount.provider === 'tencent'
          ? nextVal
            ? '记录已启用'
            : '记录已暂停'
          : nextVal
            ? '已开启 Cloudflare 小黄云代理'
            : '已切换为仅 DNS 解析',
        'success',
      )
      await loadRecords(selectedAccount.id, selectedDomain)
    } catch (err) {
      onToast(err instanceof Error ? err.message : '状态切换失败', 'error')
    } finally {
      setTogglingRecordId('')
    }
  }

  function requestDeleteRecord(rec: CloudDnsRecord) {
    if (!selectedAccount || !selectedDomain) return
    setConfirm({
      title: '删除解析记录',
      message: `确定删除 ${rec.type} 记录 ${rec.full_name} → ${rec.value} 吗？`,
      hint: '删除后会立即同步到云解析服务商，可能影响正在访问该域名的服务。',
      confirmText: '确认删除',
      run: async () => {
        const q = new URLSearchParams({
          domain: selectedDomain.name,
          zone_id: selectedDomain.id,
        })
        await del(
          `/api/v1/dns-accounts/${selectedAccount.id}/records/${encodeURIComponent(rec.id)}?${q.toString()}`,
          SLOW_TIMEOUT_MS,
        )
        onToast('解析记录已删除', 'info')
        await loadRecords(selectedAccount.id, selectedDomain)
      },
    })
  }

  return (
    <div className="cloud-dns-wrap">
      {/* 账号工具栏 */}
      <div className="card cloud-dns-accounts-card">
        <div className="cloud-dns-head">
          <div className="cloud-dns-head-title">
            <KeyRound size={15} />
            <strong>云解析账号</strong>
            <span className="muted-sm">支持同时接入多个腾讯云 DNSPod 与 Cloudflare 账号</span>
          </div>
          <div className="cloud-dns-actions">
            <button
              type="button"
              className="btn sm"
              onClick={() => openNewAccount('tencent')}
            >
              <Plus size={13} /> 接入腾讯云 DNSPod
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => openNewAccount('cloudflare')}
            >
              <Plus size={13} /> 接入 Cloudflare
            </button>
          </div>
        </div>

        {loadingAccounts ? (
          <div className="cloud-dns-loading">
            <LoaderCircle size={15} className="spin" /> 正在加载云解析账号…
          </div>
        ) : accounts.length === 0 ? (
          <Empty icon={<Globe2 size={22} />} title="尚未接入云解析账号">
            请添加腾讯云 DNSPod（CAM SecretId / SecretKey）或 Cloudflare（API Token / Global Key）账号，接入后即可直接管理域名解析，并供「证书服务」自动完成域名验证。
            {(importable.cloudflare_ddns || importable.tencent_swas.length > 0) && (
              <div className="cloud-dns-import-bar">
                {importable.cloudflare_ddns && (
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={savingAccount}
                    onClick={() => void quickImport('cf_ddns')}
                  >
                    <Zap size={13} /> 一键导入已有 Cloudflare DDNS 凭据
                  </button>
                )}
                {importable.tencent_swas.map((swas) => (
                  <button
                    key={swas.id}
                    type="button"
                    className="btn sm"
                    disabled={savingAccount}
                    onClick={() => void quickImport('tencent_swas', swas.id)}
                  >
                    <Zap size={13} /> 导入腾讯云轻量「{swas.label}」密钥
                  </button>
                ))}
              </div>
            )}
          </Empty>
        ) : (
          <div className="cloud-dns-acct-strip">
            {accounts.map((acct) => {
              const active = acct.id === selectedAccountId
              return (
                <div
                  key={acct.id}
                  className={`cloud-dns-acct-pill${active ? ' is-active' : ''}`}
                  onClick={() => setSelectedAccountId(acct.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSelectedAccountId(acct.id)
                    }
                  }}
                >
                  <div className="cloud-dns-acct-main">
                    <Badge tone={acct.provider === 'tencent' ? 'blue' : 'amber'} dot={false}>
                      {acct.provider === 'tencent' ? '腾讯云' : 'Cloudflare'}
                    </Badge>
                    <span className="cloud-dns-acct-name">{acct.label}</span>
                  </div>
                  <div className="cloud-dns-acct-sub">
                    <span>
                      {acct.provider === 'tencent'
                        ? acct.cred_id_preview || 'CAM 密钥'
                        : acct.auth_mode === 'global_key'
                          ? acct.cred_id_preview || 'Global Key'
                          : 'API Token'}
                    </span>
                    <div className="cloud-dns-acct-ops" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className="btn ghost icon sm"
                        title="测试连接"
                        disabled={testingAccountId === acct.id}
                        onClick={() => void testAccount(acct)}
                      >
                        {testingAccountId === acct.id ? (
                          <LoaderCircle size={12} className="spin" />
                        ) : (
                          <CheckCircle2 size={12} />
                        )}
                      </button>
                      <button
                        type="button"
                        className="btn ghost icon sm"
                        title="编辑账号"
                        onClick={() => openEditAccount(acct)}
                      >
                        <Edit3 size={12} />
                      </button>
                      <button
                        type="button"
                        className="btn ghost icon sm"
                        title="删除账号"
                        onClick={() => requestDeleteAccount(acct)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 域名列表 + 解析记录 */}
      {selectedAccount && (
        <div className="cloud-dns-workspace">
          <aside className="card cloud-dns-domains">
            <div className="cloud-dns-panel-head">
              <strong>
                {selectedAccount.provider === 'tencent' ? '腾讯云域名' : 'Cloudflare Zones'}
              </strong>
              <button
                type="button"
                className="btn ghost icon sm"
                title="刷新域名列表"
                disabled={loadingDomains}
                onClick={() => void loadDomains(selectedAccount.id)}
              >
                <RefreshCw size={13} className={loadingDomains ? 'spin' : ''} />
              </button>
            </div>

            {loadingDomains ? (
              <div className="cloud-dns-loading">
                <LoaderCircle size={14} className="spin" /> 拉取域名中…
              </div>
            ) : domainsError ? (
              <div className="cloud-dns-error">{domainsError}</div>
            ) : domains.length === 0 ? (
              <div className="cloud-dns-empty-sm">该账号下暂无托管域名</div>
            ) : (
              <div className="cloud-dns-domain-list">
                {domains.map((dom) => {
                  const active = selectedDomain?.name === dom.name
                  return (
                    <button
                      key={dom.id || dom.name}
                      type="button"
                      className={`cloud-dns-domain-item${active ? ' is-active' : ''}`}
                      onClick={() => setSelectedDomain(dom)}
                    >
                      <div className="cloud-dns-domain-name">{dom.name}</div>
                      <div className="cloud-dns-domain-meta">
                        <span>{dom.plan || '标准'}</span>
                        {dom.record_count > 0 && <span>{dom.record_count} 条</span>}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </aside>

          <section className="card cloud-dns-records">
            <div className="cloud-dns-records-bar">
              <div className="cloud-dns-records-title">
                <Globe2 size={15} />
                <strong>{selectedDomain ? selectedDomain.name : '请选择左侧域名'}</strong>
                {selectedDomain && (
                  <Badge
                    tone={selectedAccount.provider === 'tencent' ? 'blue' : 'amber'}
                    dot={false}
                  >
                    {selectedAccount.provider === 'tencent' ? '腾讯云 DNSPod' : 'Cloudflare'}
                  </Badge>
                )}
              </div>

              {selectedDomain && (
                <div className="cloud-dns-records-tools">
                  <div className="cloud-dns-search">
                    <Search size={13} />
                    <input
                      className="input"
                      placeholder="搜索主机记录 / 记录值 / 备注"
                      value={keyword}
                      onChange={(e) => setKeyword(e.target.value)}
                    />
                  </div>
                  <select
                    className="select"
                    value={typeFilter}
                    onChange={(e) => setTypeFilter(e.target.value)}
                    style={{ width: 102 }}
                  >
                    <option value="">全部类型</option>
                    {RECORD_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={loadingRecords}
                    onClick={() => void loadRecords(selectedAccount.id, selectedDomain)}
                  >
                    <RefreshCw size={13} className={loadingRecords ? 'spin' : ''} /> 刷新
                  </button>
                  <button type="button" className="btn primary sm" onClick={openNewRecord}>
                    <Plus size={13} /> 添加记录
                  </button>
                </div>
              )}
            </div>

            {!selectedDomain ? (
              <div className="cloud-dns-empty-sm">从左侧选择一个域名查看与管理解析记录</div>
            ) : loadingRecords ? (
              <div className="cloud-dns-loading">
                <LoaderCircle size={15} className="spin" /> 正在读取解析记录…
              </div>
            ) : recordsError ? (
              <div className="cloud-dns-error">{recordsError}</div>
            ) : filteredRecords.length === 0 ? (
              <div className="cloud-dns-empty-sm">暂无匹配的解析记录</div>
            ) : (
              <>
                <div className="cloud-dns-table-wrap">
                  <table className="cloud-dns-table">
                    <thead>
                      <tr>
                        <th>主机记录</th>
                        <th>类型</th>
                        <th>记录值</th>
                        <th>{selectedAccount.provider === 'tencent' ? '线路' : '代理'}</th>
                        <th>TTL</th>
                        <th>状态</th>
                        <th style={{ textAlign: 'right' }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedRecords.map((rec) => {
                        const isToggling = togglingRecordId === rec.id
                        const canCfProxy =
                          selectedAccount.provider === 'cloudflare' &&
                          ['A', 'AAAA', 'CNAME'].includes(rec.type.toUpperCase())
                        return (
                          <tr key={rec.id} className={!rec.enabled ? 'is-disabled' : ''}>
                            <td>
                              <div className="mono-strong">{rec.name}</div>
                              {rec.remark && <div className="muted-xs">{rec.remark}</div>}
                            </td>
                            <td>
                              <Badge tone="blue" dot={false}>
                                {rec.type}
                              </Badge>
                            </td>
                            <td className="cloud-dns-val-cell">
                              <code title={rec.value}>{rec.value}</code>
                              {rec.mx !== undefined && (
                                <span className="muted-xs" style={{ marginLeft: 6 }}>
                                  MX:{rec.mx}
                                </span>
                              )}
                            </td>
                            <td>
                              {selectedAccount.provider === 'tencent' ? (
                                <span>{rec.line || '默认'}</span>
                              ) : canCfProxy ? (
                                <button
                                  type="button"
                                  className={`cf-proxy-btn${rec.proxied ? ' on' : ''}`}
                                  disabled={isToggling}
                                  onClick={() => void toggleRecordState(rec)}
                                  title={rec.proxied ? '点击关闭代理（仅 DNS）' : '点击开启 Cloudflare 代理'}
                                >
                                  <Cloud size={12} />
                                  {rec.proxied ? '已代理' : '仅 DNS'}
                                </button>
                              ) : (
                                <span className="muted-xs">仅 DNS</span>
                              )}
                            </td>
                            <td className="mono-muted">
                              {rec.provider === 'cloudflare' && rec.ttl === 1 ? 'Auto' : `${rec.ttl}s`}
                            </td>
                            <td>
                              {rec.enabled ? (
                                <Badge tone="green">正常</Badge>
                              ) : (
                                <Badge tone="gray">已暂停</Badge>
                              )}
                            </td>
                            <td>
                              <div className="cloud-dns-row-ops">
                                {selectedAccount.provider === 'tencent' && (
                                  <button
                                    type="button"
                                    className="btn ghost icon sm"
                                    disabled={isToggling}
                                    title={rec.enabled ? '暂停解析' : '启用解析'}
                                    onClick={() => void toggleRecordState(rec)}
                                  >
                                    {isToggling ? (
                                      <LoaderCircle size={13} className="spin" />
                                    ) : rec.enabled ? (
                                      <Pause size={13} />
                                    ) : (
                                      <Play size={13} />
                                    )}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="btn ghost icon sm"
                                  title="编辑记录"
                                  onClick={() => openEditRecord(rec)}
                                >
                                  <Edit3 size={13} />
                                </button>
                                <button
                                  type="button"
                                  className="btn ghost icon sm"
                                  title="删除记录"
                                  onClick={() => requestDeleteRecord(rec)}
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {totalPages > 1 && (
                  <div className="cloud-dns-pager" aria-label="解析记录分页">
                    <span className="cloud-dns-pager-info">
                      共 {filteredRecords.length} 条 · 第{' '}
                      {(safePage - 1) * RECORDS_PAGE_SIZE + 1}–
                      {Math.min(safePage * RECORDS_PAGE_SIZE, filteredRecords.length)} 条（
                      {safePage} / {totalPages} 页）
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
                      {pageTokens.map((token, idx) =>
                        token === 'ellipsis' ? (
                          <span key={`e-${idx}`} className="cloud-dns-page-ellipsis">
                            …
                          </span>
                        ) : (
                          <button
                            key={token}
                            type="button"
                            className={`cloud-dns-page-btn${token === safePage ? ' on' : ''}`}
                            aria-current={token === safePage ? 'page' : undefined}
                            onClick={() => setPage(token)}
                          >
                            {token}
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
                )}
              </>
            )}
          </section>
        </div>
      )}

      {/* 新增 / 编辑云解析账号弹窗 */}
      {accountModal && (
        <Modal
          title={accountModal.id ? '编辑云解析账号' : '接入云解析账号'}
          icon={<KeyRound size={16} style={{ color: 'var(--accent)' }} />}
          onClose={() => !savingAccount && setAccountModal(null)}
          footer={
            <>
              <button
                type="button"
                className="btn ghost"
                disabled={savingAccount}
                onClick={() => setAccountModal(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={savingAccount}
                onClick={() => void saveAccount()}
              >
                {savingAccount && <LoaderCircle size={13} className="spin" />} 保存账号
              </button>
            </>
          }
        >
          <div className="form-stack">
            {!accountModal.id && (
              <>
                <div className="field">
                  <label>云解析服务商</label>
                  <Segmented<DnsAccountProvider>
                    value={accountModal.provider}
                    options={[
                      { value: 'tencent', label: '腾讯云 DNSPod' },
                      { value: 'cloudflare', label: 'Cloudflare' },
                    ]}
                    onChange={(p) =>
                      setAccountModal({
                        ...accountModal,
                        provider: p,
                        auth_mode: p === 'tencent' ? 'cam' : 'token',
                        cred_id: '',
                        cred_secret: '',
                      })
                    }
                  />
                </div>

                {accountModal.provider === 'cloudflare' && importable.cloudflare_ddns && (
                  <div className="ops-card">
                    <div className="ops-card-head">
                      <strong>快捷导入</strong>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={savingAccount}
                        onClick={() => void quickImport('cf_ddns')}
                      >
                        <Zap size={12} /> 直接复用设置中的 Cloudflare DDNS 凭据
                      </button>
                    </div>
                  </div>
                )}

                {accountModal.provider === 'tencent' && importable.tencent_swas.length > 0 && (
                  <div className="ops-card">
                    <div className="ops-card-head">
                      <strong>从已有腾讯云轻量服务器复用密钥</strong>
                    </div>
                    <div className="cloud-dns-import-bar" style={{ marginTop: 6 }}>
                      {importable.tencent_swas.map((swas) => (
                        <button
                          key={swas.id}
                          type="button"
                          className="btn sm"
                          disabled={savingAccount}
                          onClick={() => void quickImport('tencent_swas', swas.id)}
                        >
                          <Zap size={12} /> {swas.label} ({swas.access_key_id_preview})
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="field">
              <label>账号名称</label>
              <input
                className="input"
                placeholder={
                  accountModal.provider === 'tencent' ? '例如：腾讯云主账号' : '例如：Cloudflare 主站'
                }
                value={accountModal.label}
                onChange={(e) => setAccountModal({ ...accountModal, label: e.target.value })}
              />
            </div>

            {accountModal.provider === 'tencent' ? (
              <>
                <div className="field">
                  <label>腾讯云 SecretId</label>
                  <input
                    className="input"
                    placeholder={accountModal.id ? '留空则保持原 SecretId 不变' : 'AKID...'}
                    value={accountModal.cred_id}
                    onChange={(e) => setAccountModal({ ...accountModal, cred_id: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>腾讯云 SecretKey</label>
                  <input
                    className="input"
                    type="password"
                    placeholder={accountModal.id ? '留空则保持原 SecretKey 不变' : '请输入 SecretKey'}
                    value={accountModal.cred_secret}
                    onChange={(e) =>
                      setAccountModal({ ...accountModal, cred_secret: e.target.value })
                    }
                  />
                  <div className="hint">
                    需要授予 CAM 策略 <code>QcloudDNSPodFullAccess</code>；若同时用于申请 443 免费证书，建议一并授予{' '}
                    <code>QcloudSSLFullAccess</code>。
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="field">
                  <label>认证方式</label>
                  <Segmented<DnsAccountAuthMode>
                    value={accountModal.auth_mode === 'global_key' ? 'global_key' : 'token'}
                    options={[
                      { value: 'token', label: 'API Token（推荐）' },
                      { value: 'global_key', label: 'Global API Key' },
                    ]}
                    onChange={(m) => setAccountModal({ ...accountModal, auth_mode: m })}
                  />
                </div>
                {accountModal.auth_mode === 'global_key' && (
                  <div className="field">
                    <label>Cloudflare 账号邮箱</label>
                    <input
                      className="input"
                      placeholder="you@example.com"
                      value={accountModal.cred_id}
                      onChange={(e) => setAccountModal({ ...accountModal, cred_id: e.target.value })}
                    />
                  </div>
                )}
                <div className="field">
                  <label>
                    {accountModal.auth_mode === 'global_key' ? 'Global API Key' : 'API Token'}
                  </label>
                  <input
                    className="input"
                    type="password"
                    placeholder={accountModal.id ? '留空则保持原密钥不变' : '请输入凭据'}
                    value={accountModal.cred_secret}
                    onChange={(e) =>
                      setAccountModal({ ...accountModal, cred_secret: e.target.value })
                    }
                  />
                  <div className="hint">
                    API Token 请至少勾选 <code>Zone:Zone:Read</code> 与 <code>Zone:DNS:Edit</code> 权限。
                  </div>
                </div>
              </>
            )}

            <div className="field">
              <label>备注（可选）</label>
              <input
                className="input"
                placeholder="用途说明"
                value={accountModal.remark}
                onChange={(e) => setAccountModal({ ...accountModal, remark: e.target.value })}
              />
            </div>
          </div>
        </Modal>
      )}

      {/* 新增 / 编辑解析记录弹窗 */}
      {recordModal && selectedAccount && selectedDomain && (
        <Modal
          title={`${recordModal.id ? '编辑' : '添加'}解析记录 · ${selectedDomain.name}`}
          icon={<Shield size={16} style={{ color: 'var(--accent)' }} />}
          onClose={() => !savingRecord && setRecordModal(null)}
          footer={
            <>
              <button
                type="button"
                className="btn ghost"
                disabled={savingRecord}
                onClick={() => setRecordModal(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={savingRecord}
                onClick={() => void saveRecord()}
              >
                {savingRecord && <LoaderCircle size={13} className="spin" />} 保存记录
              </button>
            </>
          }
        >
          <div className="form-stack">
            <div className="grid-2">
              <div className="field">
                <label>记录类型</label>
                <select
                  className="select"
                  value={recordModal.type}
                  onChange={(e) => setRecordModal({ ...recordModal, type: e.target.value })}
                >
                  {RECORD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>主机记录</label>
                <input
                  className="input"
                  placeholder="@ / www / api / _dnsauth"
                  value={recordModal.name}
                  onChange={(e) => setRecordModal({ ...recordModal, name: e.target.value })}
                />
              </div>
            </div>

            <div className="field">
              <label>记录值</label>
              <input
                className="input"
                placeholder={
                  recordModal.type === 'A'
                    ? '例如：1.2.3.4'
                    : recordModal.type === 'CNAME'
                      ? '例如：target.example.com'
                      : '请输入解析值'
                }
                value={recordModal.value}
                onChange={(e) => setRecordModal({ ...recordModal, value: e.target.value })}
              />
            </div>

            <div className="grid-2">
              <div className="field">
                <label>TTL（秒）</label>
                <input
                  className="input"
                  type="number"
                  min={selectedAccount.provider === 'cloudflare' ? 1 : 60}
                  max={604800}
                  value={recordModal.ttl}
                  onChange={(e) => setRecordModal({ ...recordModal, ttl: e.target.value })}
                />
                {selectedAccount.provider === 'cloudflare' && (
                  <div className="hint">填 1 表示 Cloudflare 自动 TTL（Auto）</div>
                )}
              </div>

              {selectedAccount.provider === 'tencent' ? (
                <div className="field">
                  <label>解析线路</label>
                  <select
                    className="select"
                    value={recordModal.line}
                    onChange={(e) => setRecordModal({ ...recordModal, line: e.target.value })}
                  >
                    {DNSPOD_LINES.map((line) => (
                      <option key={line} value={line}>
                        {line}
                      </option>
                    ))}
                  </select>
                </div>
              ) : recordModal.type === 'MX' || recordModal.type === 'SRV' ? (
                <div className="field">
                  <label>优先级（Priority）</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={65535}
                    value={recordModal.mx}
                    onChange={(e) => setRecordModal({ ...recordModal, mx: e.target.value })}
                  />
                </div>
              ) : (
                <div className="field">
                  <label>备注（可选）</label>
                  <input
                    className="input"
                    placeholder="备注说明"
                    value={recordModal.remark}
                    onChange={(e) => setRecordModal({ ...recordModal, remark: e.target.value })}
                  />
                </div>
              )}
            </div>

            {selectedAccount.provider === 'tencent' && recordModal.type === 'MX' && (
              <div className="field">
                <label>MX 优先级（1-20）</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={20}
                  value={recordModal.mx}
                  onChange={(e) => setRecordModal({ ...recordModal, mx: e.target.value })}
                />
              </div>
            )}

            {selectedAccount.provider === 'cloudflare' &&
              ['A', 'AAAA', 'CNAME'].includes(recordModal.type) && (
                <Switch
                  checked={recordModal.proxied}
                  onChange={(v) => setRecordModal({ ...recordModal, proxied: v })}
                  label="开启 Cloudflare 代理（小黄云）"
                  hint="关闭则为仅 DNS 解析；证书验证记录请务必关闭代理"
                />
              )}

            {selectedAccount.provider === 'tencent' && (
              <>
                <Switch
                  checked={recordModal.enabled}
                  onChange={(v) => setRecordModal({ ...recordModal, enabled: v })}
                  label="启用该解析记录"
                  hint="关闭后将暂停解析而不删除记录"
                />
                <div className="field">
                  <label>备注（可选）</label>
                  <input
                    className="input"
                    placeholder="备注说明"
                    value={recordModal.remark}
                    onChange={(e) => setRecordModal({ ...recordModal, remark: e.target.value })}
                  />
                </div>
              </>
            )}
          </div>
        </Modal>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          hint={confirm.hint}
          confirmText={confirm.confirmText}
          busy={confirmBusy}
          onCancel={() => !confirmBusy && setConfirm(null)}
          onConfirm={async () => {
            setConfirmBusy(true)
            try {
              await confirm.run()
              setConfirm(null)
            } catch (err) {
              onToast(err instanceof Error ? err.message : '操作失败', 'error')
            } finally {
              setConfirmBusy(false)
            }
          }}
        />
      )}
    </div>
  )
}
