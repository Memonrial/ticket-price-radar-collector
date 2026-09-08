import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  CartesianGrid,
  LineChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Database,
  ExternalLink,
  Link2,
  Menu,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Ticket,
  Trash2,
  TrendingDown,
  X,
} from 'lucide-react'

const COLORS = ['#ff5b43', '#5a67f2', '#14a876', '#e9a23b', '#ad62e8']

const initialShows = []

const points = ['09/02', '09/03', '09/04', '09/05', '09/06', '09/07', '09/08']

function seedOf(text) {
  return [...text].reduce((n, char) => n + char.charCodeAt(0), 0)
}

function tierInfo(session, tier) {
  return session.livePrices?.[tier] || session.livePrices?.[String(tier)] || {}
}

function tierLabel(session, tier) {
  return tierInfo(session, tier).name || String(tier)
}

function tierFaceValue(session, tier) {
  const value = Number(tierInfo(session, tier).faceValue ?? tier)
  return Number.isFinite(value) ? value : null
}

function filterTrend(data, range) {
  const hours = { '24小时': 24, '7天': 24 * 7, '15天': 24 * 15 }[range]
  if (!hours || !Array.isArray(data)) return data || []
  const cutoff = Date.now() - hours * 60 * 60 * 1000
  const filtered = data.filter((item) => {
    const timestamp = new Date(item.collectedAt || '').getTime()
    return Number.isFinite(timestamp) && timestamp >= cutoff
  })
  return filtered.length ? filtered : (data.length ? [data.at(-1)] : [])
}

function sessionEndTime(session) {
  if (!session?.date) return null
  const time = /^\d{2}:\d{2}$/.test(session.time || '') ? session.time : '23:59'
  const timestamp = new Date(`${session.date}T${time}:00+08:00`).getTime()
  return Number.isFinite(timestamp) ? timestamp + 6 * 60 * 60 * 1000 : null
}

function isArchivedShow(show) {
  if (show?.archivedAt) return true
  const sessions = show?.sessions || []
  return Boolean(sessions.length) && sessions.every((item) => {
    const endTime = sessionEndTime(item)
    return !item.pending && endTime !== null && endTime <= Date.now()
  })
}

function marketFor(show, session, tier) {
  const savedTrend = session.tierHistory?.[tier] || session.tierHistory?.[String(tier)]
  if (savedTrend?.length) return savedTrend
  if (session.livePrices?.[tier]) {
    const live = session.livePrices[tier]
    const latest = session.history?.at(-1)
    return [{ time: latest?.time || session.lastCollected || '最新', price: live.price, count: live.count, face: tier }]
  }
  const faceValue = tierFaceValue(session, tier)
  if (faceValue === null) return []
  const seed = seedOf(`${show.id}-${session.id}-${tier}`)
  const premium = 1.06 + (seed % 28) / 100
  const wave = [1.08, 1.03, 1.06, .99, 1.02, .96, .92]
  return points.map((time, index) => {
    const jitter = ((seed * (index + 3)) % 41) - 20
    const price = Math.max(Math.round((faceValue * premium * wave[index] + jitter) / 10) * 10, faceValue * .68)
    const count = 70 + ((seed + index * 37) % 150) - index * 5
    return { time, price, count: Math.max(count, 18), face: tier }
  })
}

function sessionSnapshot(show, session) {
  if (session.pending) return { lowest: 0, prevLowest: 0, count: 0, change: 0, firstBatch: true, pending: true }
  const series = session.tiers.map((tier) => marketFor(show, session, tier)).filter((items) => items.length)
  if (!series.length) return { lowest: 0, prevLowest: 0, count: 0, change: 0, firstBatch: Boolean(session.livePrices) }
  const latest = series.map((items) => items.at(-1))
  const previous = series.map((items) => items.at(-2) || items.at(-1))
  const lowest = Math.min(...latest.map((item) => item.price))
  const prevLowest = Math.min(...previous.map((item) => item.price))
  const count = session.listingCount || latest.reduce((sum, item) => sum + item.count, 0)
  return { lowest, prevLowest, count, change: ((lowest - prevLowest) / prevLowest) * 100, firstBatch: Boolean(session.livePrices) }
}

const currency = (value, show) => Number.isFinite(Number(value)) ? `${show?.currency || '¥'}${Number(value).toLocaleString('zh-CN')}` : '—'

function Countdown({ date, time }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  if (!date || !time) return <span className="countdown pending-countdown">等待首次抓取</span>
  const target = new Date(`${date}T${time}:00+08:00`).getTime()
  const diff = Math.max(target - now, 0)
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)
  const seconds = Math.floor((diff % 60000) / 1000)
  return <span className="countdown">{days}<small>天</small> {String(hours).padStart(2, '0')}<small>时</small> {String(minutes).padStart(2, '0')}<small>分</small> {String(seconds).padStart(2, '0')}<small>秒</small></span>
}

function TrendTooltip({ active, payload, label, show }) {
  if (!active || !payload?.length) return null
  return (
    <div className="chart-tooltip">
      <span>{label} · 采集批次</span>
      <strong>{currency(payload[0].value, show)}</strong>
      {payload[1] && <em>在售 {payload[1].value} 张</em>}
    </div>
  )
}

function Sidebar({ showGroups, activeShow, setActiveShow, query, setQuery, open, setOpen, onOpenSource, onDeleteGroup }) {
  const filtered = showGroups.filter((show) => `${show.artist}${show.tour}${show.city}${show.venue}`.toLowerCase().includes(query.toLowerCase()))
  const monitoring = filtered.filter((show) => !isArchivedShow(show))
  const archived = filtered.filter((show) => isArchivedShow(show))
  const showRow = (show) => {
    const firstSnapshot = sessionSnapshot(show, show.sessions[0])
    return <div key={show.id} className={`show-item-row ${activeShow.id === show.id ? 'active' : ''}`}>
      <button className="show-item" onClick={() => { setActiveShow(show); setOpen(false) }}>
        <div className="artist-avatar" style={{ '--accent': show.accent }}>{show.initials}</div>
        <div className="show-copy"><b>{show.artist}</b><span>{isArchivedShow(show) ? '已归档' : `${show.city} · ${show.sessions.length}个日期`}</span></div>
        <div className="show-price"><b>{firstSnapshot.pending ? '待抓取' : currency(firstSnapshot.lowest, show)}</b><span className={isArchivedShow(show) ? 'pending-text' : firstSnapshot.pending ? 'pending-text' : firstSnapshot.firstBatch ? 'live-text' : firstSnapshot.change > 0 ? 'up' : 'down'}>{isArchivedShow(show) ? '历史数据' : firstSnapshot.pending ? '等待识别' : firstSnapshot.firstBatch ? '最新快照' : `${firstSnapshot.change > 0 ? '+' : ''}${firstSnapshot.change.toFixed(1)}%`}</span></div>
      </button>
      <button className="delete-show" aria-label={`删除${show.artist}${show.city}`} title="删除这一组监测" onClick={() => onDeleteGroup(show)}><Trash2 size={14}/></button>
    </div>
  }
  return (
    <aside className={`sidebar ${open ? 'is-open' : ''}`}>
      <div className="brand">
        <div className="brand-mark"><Activity size={20} /></div>
        <div><b>票价雷达</b><span>Ticket Pulse</span></div>
        <button className="icon-btn close-nav" onClick={() => setOpen(false)}><X size={20}/></button>
      </div>
      <div className="search"><Search size={17}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索艺人、城市或巡演"/></div>
      <div className="side-heading"><span>监测中的演出</span><b>{monitoring.length}</b></div>
      <div className="show-list">{monitoring.map(showRow)}</div>
      {archived.length > 0 && <><div className="side-heading archive-heading"><span>历史归档</span><b>{archived.length}</b></div><div className="show-list archived-list">{archived.map(showRow)}</div></>}
      <div className="source-card">
        <div><span className="live-dot"></span><b>MoreTickets 已接入</b></div>
        <p>新增链接后立即抓取首批数据</p>
        <div className="source-progress"><i></i></div>
        <small>计划任务：每 2 小时一次</small>
      </div>
      <div className="side-footer"><button onClick={onOpenSource}><Settings2 size={17}/> 数据源设置</button><span>v1.2</span></div>
    </aside>
  )
}

function MiniStat({ icon: Icon, label, value, meta, tone = 'neutral' }) {
  return (
    <div className="stat-card">
      <div className={`stat-icon ${tone}`}><Icon size={19}/></div>
      <div className="stat-content"><span>{label}</span><strong>{value}</strong><small className={tone}>{meta}</small></div>
    </div>
  )
}

function TierCard({ show, session, tier, index, range }) {
  const data = filterTrend(marketFor(show, session, tier), range)
  if (!data.length) return null
  const current = data.at(-1).price
  const previous = (data.at(-2) || data.at(-1)).price
  const change = ((current - previous) / previous) * 100
  const low = Math.min(...data.map((d) => d.price))
  return (
    <article className="tier-card">
      <div className="tier-head">
        <div><span>票档</span><strong>{tierLabel(session, tier)}</strong></div>
        <div className="tier-current"><span>当前最低</span><b>{currency(current, show)}</b></div>
      </div>
      <div className="tier-meta">
        {session.livePrices ? <span className="live-text"><CheckCircle2 size={13}/> 真实抓取数据</span> : <span className={change > 0 ? 'up' : 'down'}>{change > 0 ? <ArrowUpRight size={14}/> : <ArrowDownRight size={14}/>} 较上次 {Math.abs(change).toFixed(1)}%</span>}
        <span>{session.livePrices ? '当前最低' : '区间最低'} {currency(low, show)}</span>
        <span>{session.livePrices ? '已加载' : '在售'} {data.at(-1).count} 条</span>
      </div>
      <div className="mini-chart">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 10, right: 4, left: 4, bottom: 0 }}>
            <defs><linearGradient id={`g${session.id}${tier}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS[index % COLORS.length]} stopOpacity=".26"/><stop offset="100%" stopColor={COLORS[index % COLORS.length]} stopOpacity="0"/></linearGradient></defs>
            <Tooltip content={<TrendTooltip show={show}/>}/>
            <Area type="monotone" dataKey="price" stroke={COLORS[index % COLORS.length]} strokeWidth={2.2} fill={`url(#g${session.id}${tier})`} dot={session.livePrices ? { r: 4, fill: COLORS[index % COLORS.length] } : false} activeDot={{ r: 4, fill: '#fff', strokeWidth: 2 }}/>
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="mini-axis"><span>{data[0].time}</span><span>{data.length === 1 ? '等待下次采集' : data.at(-1).time}</span></div>
    </article>
  )
}

const defaultTargets = []

const emptyShow = {
  id: 'empty-monitoring-list', artist: '暂无监测演出', tour: '点击右上角“新增监测”添加第一个页面',
  city: '待添加', venue: '尚未添加数据源', accent: '#8b74e8', initials: '?', status: '空列表',
  currency: '¥', source: 'MoreTickets', live: true,
  sessions: [{ id: 'empty-session', date: '', weekday: '', time: '', tiers: [], pending: true, lastCollected: '' }],
}

function readTargetIds(url) {
  const parsed = new URL(url)
  if (!parsed.hostname.endsWith('moretickets.com')) throw new Error('invalid')
  const id = parsed.searchParams.get('sessionId')
  const showId = parsed.searchParams.get('showId')
  const tourId = parsed.searchParams.get('tourId')
  if (!id || !showId) throw new Error('invalid')
  return { id, showId, tourId }
}

function SourceModal({ onClose, targets, onAddTarget, onDeleteTarget, onMigrateLegacy }) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [saving, setSaving] = useState(false)

  const migrateLegacy = async () => {
    setSaving(true)
    setError('')
    try {
      await onMigrateLegacy()
      setSuccessMessage('旧网站数据已导入并同步')
      window.setTimeout(() => setSuccessMessage(''), 2600)
    } catch (err) {
      setError(err?.message || '旧网站数据导入失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  const submit = async (event) => {
    event.preventDefault()
    try {
      const ids = readTargetIds(url)
      if (targets.some((target) => target.id === ids.id)) {
        setError('这个日期场次已经在监测队列中，无需重复添加')
        return
      }
      setSaving(true)
      const result = await onAddTarget({ ...ids, name: name || `待识别演出 ${targets.length + 1}`, url, interval: 120, status: '正在抓取首批数据' })
      setUrl('')
      setName('')
      setError('')
      setSuccessMessage(result?.collectionError
        ? `网址已加入监测；首批抓取暂未完成，系统会在下一次自动更新时重试：${result.collectionError}`
        : '首批票价已抓取并同步到所有访问者')
      window.setTimeout(() => setSuccessMessage(''), 5200)
    } catch (err) {
      setError(err?.message || '请粘贴包含 sessionId 和 showId 的完整 MoreTickets 选座链接')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="source-modal" role="dialog" aria-modal="true" aria-label="数据源管理">
        <div className="modal-head"><div><span className="modal-icon"><Database size={19}/></span><div><h3>数据源管理</h3><p>新增链接立即抓取首批价格，之后每 2 小时自动更新</p></div></div><button className="icon-btn" onClick={onClose}><X size={18}/></button></div>
        <form onSubmit={submit}>
          <label>平台</label>
          <div className="platform-field"><span className="live-dot"></span><b>MoreTickets</b><small>页面结构已识别</small></div>
          <button className="submit-source" type="button" disabled={saving} onClick={migrateLegacy}><Database size={17}/>{saving ? '正在处理…' : '导入旧网站数据'}</button>
          <label htmlFor="source-name">演出备注名称</label>
          <input id="source-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：The Weeknd 香港站"/>
          <label htmlFor="source-url">选座页面完整网址</label>
          <div className="url-input"><Link2 size={17}/><textarea id="source-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.moretickets.com/pick-seat?sessionId=..."/></div>
          {error && <p className="form-error">{error}</p>}
          {successMessage && <p className="form-success"><CheckCircle2 size={14}/> {successMessage}</p>}
          <div className="schedule-row"><div><Clock3 size={17}/><span><b>抓取频率</b><small>立即抓取；之后每 2 小时</small></span></div><div><Database size={17}/><span><b>保存方式</b><small>多人共享云端保存</small></span></div></div>
          <button className="submit-source" type="submit" disabled={saving}><Plus size={17}/>{saving ? '正在抓取首批数据…' : '加入并立即抓取'}</button>
        </form>
        <div className="target-list-head"><span>当前监测网址</span><b>{targets.length}</b></div>
        <div className="target-list">{targets.map((target) => <article key={target.id}><div><span className="target-logo">M</span><div><b>{target.name}</b><small>{target.status} · {Number(target.interval) === 120 ? '每 2 小时自动更新' : `${target.interval}分钟/次`}</small></div></div><div className="target-actions"><a href={target.url} target="_blank" rel="noreferrer" aria-label={`打开${target.name}`}><ExternalLink size={15}/></a><button aria-label={`删除${target.name}`} onClick={() => onDeleteTarget(target)}><Trash2 size={15}/></button></div></article>)}</div>
        <p className="modal-note">新增链接会立即出现在左侧导航，并自动开始首次抓取。同一 showId 会自动合并为一个演出页面，不同 sessionId 显示为不同日期；首次抓取后自动补全演员、地点和日期。</p>
      </section>
    </div>
  )
}

function CompareModal({ show, activeSessionId, onSelect, onClose }) {
  const sessions = [...show.sessions].sort((left, right) => `${left.date} ${left.time}`.localeCompare(`${right.date} ${right.time}`))
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="source-modal compare-modal" role="dialog" aria-modal="true" aria-label="多日期对比">
        <div className="modal-head"><div><span className="modal-icon"><BarChart3 size={19}/></span><div><h3>多日期对比</h3><p>{show.artist} · {show.venue} · 同一演出的不同日期</p></div></div><button className="icon-btn" onClick={onClose}><X size={18}/></button></div>
        <div className="compare-summary"><span>对比市场最低价、在售量和票档数量</span><b>{sessions.length} 个日期</b></div>
        <div className="price-table-wrap compare-table-wrap"><table className="price-table compare-table"><thead><tr><th>演出日期</th><th>开场时间</th><th>市场最低价</th><th>页面在售</th><th>票档数量</th><th>状态</th><th></th></tr></thead><tbody>{sessions.map((item) => {
          const snapshot = sessionSnapshot(show, item)
          const archived = isFinishedSessionView(item)
          return <tr key={item.id} className={item.id === activeSessionId ? 'active-row' : ''}><td><b>{item.date ? item.date.replaceAll('-', '/') : '待识别'}</b><small>{item.weekday || '等待抓取'}</small></td><td>{item.time || '—'}</td><td><strong>{snapshot.pending ? '待抓取' : currency(snapshot.lowest, show)}</strong></td><td>{snapshot.pending ? '—' : `${snapshot.count} 条`}</td><td>{item.tiers?.length || '—'}</td><td><span className="table-status">{archived ? '已归档' : snapshot.pending ? '等待抓取' : '监测中'}</span></td><td><button className="compare-select" onClick={() => onSelect(item.id)}>{item.id === activeSessionId ? '当前查看' : '查看'}</button></td></tr>
        })}</tbody></table></div>
      </section>
    </div>
  )
}

function isFinishedSessionView(session) {
  const endTime = sessionEndTime(session)
  return !session.pending && endTime !== null && endTime <= Date.now()
}

export default function App() {
  const [showGroups, setShowGroups] = useState(() => {
    try { return JSON.parse(localStorage.getItem('ticket-radar-show-groups')) || initialShows } catch { return initialShows }
  })
  const [activeShow, setActiveShow] = useState(showGroups[0] || emptyShow)
  const [sessionId, setSessionId] = useState((showGroups[0] || emptyShow).sessions[0].id)
  const [query, setQuery] = useState('')
  const [range, setRange] = useState('7天')
  const [tab, setTab] = useState('总览')
  const [navOpen, setNavOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [sourceOpen, setSourceOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [cloudReady, setCloudReady] = useState(false)
  const [syncError, setSyncError] = useState('')
  const revisionRef = useRef(0)
  const [targets, setTargets] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('ticket-radar-targets'))
      return saved?.map((target) => {
        try { return { ...target, ...readTargetIds(target.url) } } catch { return target }
      }) || defaultTargets
    } catch { return defaultTargets }
  })

  const applyCloudState = useCallback((data) => {
    const nextGroups = Array.isArray(data.showGroups) ? data.showGroups : []
    const nextTargets = Array.isArray(data.targets) ? data.targets : []
    revisionRef.current = Number(data.revision || 0)
    setShowGroups(nextGroups)
    setTargets(nextTargets)
    setActiveShow((current) => nextGroups.find((item) => item.id === current?.id) || nextGroups[0] || emptyShow)
    setCloudReady(true)
    setSyncError('')
  }, [])

  const saveCloudState = useCallback(async (nextTargets, nextGroups) => {
    const baseRevision = revisionRef.current
    const response = await fetch('/api/shared-state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: nextTargets, showGroups: nextGroups, baseRevision }),
    })
    const data = await response.json().catch(() => ({}))
    if (response.status === 409) {
      if (data.state) applyCloudState(data.state)
      if (baseRevision === 0 && data.state) return data.state
      throw new Error('其他人刚刚修改了监测列表，已为你同步最新数据，请再操作一次')
    }
    if (!response.ok) throw new Error(data.error || '云端保存失败，请稍后重试')
    applyCloudState(data)
    return data
  }, [applyCloudState])

  const loadCloudState = useCallback(async (initialize = false) => {
    try {
      const response = await fetch('/api/shared-state', { cache: 'no-store' })
      if (!response.ok) throw new Error('共享数据暂时无法读取')
      const data = await response.json()
      if (!data.initialized && initialize) {
        await saveCloudState(targets, showGroups)
        return
      }
      if (data.initialized && Number(data.revision || 0) !== revisionRef.current) applyCloudState(data)
      else if (data.initialized) setCloudReady(true)
      setSyncError('')
    } catch (err) {
      setSyncError(err?.message || '云端同步失败')
    }
  }, [applyCloudState, saveCloudState, showGroups, targets])

  useEffect(() => {
    loadCloudState(true)
    const timer = window.setInterval(() => loadCloudState(false), 60000)
    const onFocus = () => loadCloudState(false)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') loadCloudState(false)
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, []) // 初次迁移浏览器旧数据，之后以云端为准

  useEffect(() => {
    if (!activeShow.sessions.some((item) => item.id === sessionId)) setSessionId(activeShow.sessions[0].id)
  }, [activeShow, sessionId])
  const session = activeShow.sessions.find((item) => item.id === sessionId) || activeShow.sessions[0]
  const archived = isArchivedShow(activeShow)
  const lowestFaceValue = useMemo(() => {
    const values = session.tiers.map((tier) => tierFaceValue(session, tier)).filter((value) => value !== null)
    return values.length ? Math.min(...values) : null
  }, [session])
  const snapshot = useMemo(() => sessionSnapshot(activeShow, session), [activeShow, session])
  const overview = useMemo(() => {
    if (session.pending) return []
    const history = session.history?.length ? session.history : points.map((time, idx) => {
      const rows = session.tiers.map((tier) => marketFor(activeShow, session, tier)[idx])
        .filter(Boolean)
      if (!rows.length) return null
      return { time, price: Math.min(...rows.map((row) => row.price)), count: rows.reduce((sum, row) => sum + row.count, 0) }
    }).filter(Boolean)
    return filterTrend(history, range)
  }, [activeShow, range, session])

  const refresh = async () => {
    setRefreshing(true)
    try {
      const target = targets.find((item) => item.id === session.id)
      if (activeShow.live && target && !session.pending && !archived) {
        const response = await fetch('/api/collect-now', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: session.id }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || '本次抓取暂时不可用')
        if (data.state) applyCloudState(data.state)
      } else {
        await loadCloudState(false)
      }
      setSyncError('')
    } catch (error) {
      setSyncError(error?.message || '刷新失败，请稍后重试')
    } finally {
      setRefreshing(false)
    }
  }

  const migrateLegacy = async () => {
    const response = await fetch('/api/migrate-legacy', {
      method: 'POST',
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || '旧网站数据导入失败')
    applyCloudState(data)
  }

  const addTarget = async (target) => {
    const nextTargets = [...targets, target]
    const groupIndex = showGroups.findIndex((show) => show.showId === target.showId || show.groupKey === target.showId)
    const pendingSession = { id: target.id, date: '', weekday: '', time: '', tiers: [], pending: true, sourceUrl: target.url, lastCollected: '' }
    let nextGroups
    if (groupIndex >= 0) {
      nextGroups = showGroups.map((show, index) => index === groupIndex && !show.sessions.some((item) => item.id === target.id)
        ? { ...show, sessions: [...show.sessions, pendingSession] }
        : show)
      setActiveShow(nextGroups[groupIndex])
    } else {
      const pendingGroup = {
        id: `group-${target.showId}`,
        showId: target.showId,
        groupKey: target.showId,
        artist: target.name,
        tour: '等待首次抓取后自动识别演出信息',
        city: '待识别',
        venue: '待识别地点',
        accent: '#8b74e8',
        initials: target.name.trim().slice(0, 1).toUpperCase() || '?',
        status: '等待抓取',
        currency: '¥',
        source: 'MoreTickets',
        live: true,
        pageUrl: target.url,
        sessions: [pendingSession],
      }
      nextGroups = [...showGroups, pendingGroup]
      setActiveShow(pendingGroup)
    }
    await saveCloudState(nextTargets, nextGroups)
    setSessionId(target.id)
    try {
      const response = await fetch('/api/collect-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: target.id }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || '首批抓取暂时不可用')
      if (data.state) applyCloudState(data.state)
      return { collected: true }
    } catch (error) {
      return { collected: false, collectionError: error?.message || '首批抓取暂时不可用' }
    }
  }

  const deleteTarget = async (target) => {
    if (!window.confirm(`确定停止监测“${target.name}”这个日期吗？`)) return
    try {
      const nextTargets = targets.filter((item) => item.id !== target.id)
      const nextGroups = showGroups.map((show) => ({ ...show, sessions: show.sessions.filter((item) => item.id !== target.id) })).filter((show) => show.sessions.length)
      await saveCloudState(nextTargets, nextGroups)
      if (!nextGroups.some((show) => show.id === activeShow.id)) {
        const nextActive = nextGroups[0] || emptyShow
        setActiveShow(nextActive)
        setSessionId(nextActive.sessions[0].id)
      } else if (sessionId === target.id) {
        const current = nextGroups.find((show) => show.id === activeShow.id)
        setActiveShow(current)
        setSessionId(current.sessions[0].id)
      }
    } catch (err) {
      window.alert(err?.message || '删除失败，请稍后重试')
    }
  }

  const deleteGroup = async (show) => {
    if (!window.confirm(`确定删除“${show.artist} · ${show.city}”及其 ${show.sessions.length} 个日期吗？`)) return
    try {
      const sessionIds = new Set(show.sessions.map((item) => item.id))
      const nextTargets = targets.filter((target) => !sessionIds.has(target.id) && target.showId !== show.showId)
      const nextGroups = showGroups.filter((item) => item.id !== show.id)
      await saveCloudState(nextTargets, nextGroups)
      if (activeShow.id === show.id) {
        const nextActive = nextGroups[0] || emptyShow
        setActiveShow(nextActive)
        setSessionId(nextActive.sessions[0].id)
      }
    } catch (err) {
      window.alert(err?.message || '删除失败，请稍后重试')
    }
  }

  return (
    <div className="app-shell">
      <Sidebar showGroups={showGroups} activeShow={activeShow} setActiveShow={setActiveShow} query={query} setQuery={setQuery} open={navOpen} setOpen={setNavOpen} onOpenSource={() => setSourceOpen(true)} onDeleteGroup={deleteGroup}/>
      {navOpen && <button className="nav-scrim" onClick={() => setNavOpen(false)} />}
      {sourceOpen && <SourceModal onClose={() => setSourceOpen(false)} targets={targets} onAddTarget={addTarget} onDeleteTarget={deleteTarget} onMigrateLegacy={migrateLegacy}/>}
      {compareOpen && <CompareModal show={activeShow} activeSessionId={sessionId} onClose={() => setCompareOpen(false)} onSelect={(id) => { setSessionId(id); setCompareOpen(false) }}/>} 
      <main className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setNavOpen(true)}><Menu size={20}/></button>
          <div className="breadcrumb"><span>市场监测</span><ChevronRight size={15}/><b>{activeShow.artist}</b></div>
          <div className="top-actions">
            <span className="updated" title={syncError || '所有访问者共享同一份数据'}><span className={syncError ? 'pending-dot' : cloudReady ? 'live-dot' : 'demo-dot'}></span> {syncError ? '云端同步异常' : cloudReady ? '共享数据已同步' : '正在连接云端'}</span>
            <button className="icon-btn"><Bell size={18}/><i className="notice-dot"></i></button>
            <button className="add-source-btn" onClick={() => setSourceOpen(true)}><Plus size={16}/>新增监测</button>
            <button className="refresh-btn" onClick={refresh} disabled={archived}><RefreshCw className={refreshing ? 'spin' : ''} size={16}/>{refreshing ? '刷新中' : archived ? '已归档' : activeShow.live ? '刷新快照' : '模拟刷新'}</button>
          </div>
        </header>

        <div className="content">
          <section className="hero-panel">
            <div className="event-intro">
              <div className="event-badges"><span className="status-badge"><Radio size={13}/>{archived ? '已归档' : activeShow.status}</span><span>{activeShow.city}</span></div>
              <h1>{activeShow.artist}</h1>
              <h2>{activeShow.tour}</h2>
              <p><CalendarDays size={16}/>{session.pending ? '新链接已加入监测队列' : `${session.date} ${session.weekday} ${session.time}`}<i></i>{activeShow.venue}</p>
            </div>
            <div className="countdown-wrap"><span><Clock3 size={15}/>{archived ? '历史演出' : '距离本场开演'}</span>{archived ? <b>已归档</b> : <Countdown date={session.date} time={session.time}/>}</div>
          </section>

          <section className="session-row">
            <div className="session-label"><CalendarDays size={17}/><span>选择场次</span></div>
            <div className="session-tabs">
              {activeShow.sessions.map((item) => <button key={item.id} className={session.id === item.id ? 'active' : ''} onClick={() => setSessionId(item.id)}><b>{item.pending ? '待识别' : item.date.slice(5).replace('-', '/')}</b><span>{item.pending ? '等待首次抓取' : `${item.weekday} ${item.time}`}</span></button>)}
            </div>
            <button className="filter-btn compare-trigger" disabled={activeShow.sessions.length < 2} onClick={() => setCompareOpen(true)}><BarChart3 size={16}/>场次对比</button>
          </section>

          {session.pending ? <section className="pending-panel">
            <span className="pending-illustration"><RefreshCw size={25}/></span>
            <h3>这个日期已经加入左侧导航</h3>
            <p>首次采集完成后，系统会读取演出名称、地点和日期，并按相同 showId 自动归入同一个演出页面。</p>
            <div><span><CheckCircle2 size={14}/>sessionId 已识别</span><span><CheckCircle2 size={14}/>showId 分组键已建立</span><span><Clock3 size={14}/>等待价格快照</span></div>
          </section> : <>
          <section className="stats-grid">
            <MiniStat icon={Ticket} label="市场最低价" value={currency(snapshot.lowest, activeShow)} meta={snapshot.firstBatch ? '✓ MoreTickets 首个真实快照' : `${snapshot.change > 0 ? '↑' : '↓'} 较上次采集 ${Math.abs(snapshot.change).toFixed(1)}%`} tone={snapshot.change > 0 ? 'warning' : 'positive'}/>
            <MiniStat icon={Activity} label="页面在售 Listings" value={`${snapshot.count} 条`} meta={`覆盖 ${session.tiers.length} 个票面`} tone="violet"/>
            <MiniStat icon={TrendingDown} label={lowestFaceValue === null ? '票档类型' : '较最低票面溢价'} value={lowestFaceValue === null ? `${session.tiers.length} 档` : `${Math.round((snapshot.lowest / lowestFaceValue - 1) * 100)}%`} meta={lowestFaceValue === null ? '按原页面票档展示' : `最低票面 ${currency(lowestFaceValue, activeShow)}`} tone="blue"/>
            <MiniStat icon={Clock3} label="最后采集" value={session.lastCollected || '等待首批数据'} meta={archived ? '已归档，趋势数据已保留' : '每 2 小时自动更新'} tone="neutral"/>
          </section>

          <section className="chart-panel">
            <div className="panel-head">
              <div><h3>本场市场趋势</h3><p>最低成交价与在售票量变化</p></div>
              <div className="chart-controls">
                <div className="segmented">{['24小时', '7天', '15天'].map((item) => <button className={range === item ? 'active' : ''} onClick={() => setRange(item)} key={item}>{item}</button>)}</div>
                <button className="select-btn">最低价 <ChevronDown size={15}/></button>
              </div>
            </div>
            <div className="legend"><span><i className="legend-line"></i>市场最低价</span><span><i className="legend-bar"></i>在售 Listings</span><em>{session.history?.length > 1 ? `已保存 ${session.history.length} 次抓取` : snapshot.firstBatch ? '首个真实批次 · 等待形成趋势' : '数据每2小时自动采集'}</em></div>
            <div className="main-chart">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={overview} margin={{ top: 14, right: 12, left: -8, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#eceef2" strokeDasharray="4 4"/>
                  <XAxis dataKey="time" axisLine={false} tickLine={false} tick={{ fill: '#89909b', fontSize: 12 }} dy={10}/>
                  <YAxis yAxisId="price" axisLine={false} tickLine={false} tick={{ fill: '#89909b', fontSize: 12 }} tickFormatter={(v) => currency(v, activeShow)}/>
                  <YAxis yAxisId="count" orientation="right" axisLine={false} tickLine={false} tick={{ fill: '#a5aab2', fontSize: 12 }}/>
                  <Tooltip content={<TrendTooltip show={activeShow}/>}/>
                  <Bar yAxisId="count" dataKey="count" fill="#e7eaf0" radius={[4, 4, 0, 0]} barSize={22}/>
                  <Line yAxisId="price" type="monotone" dataKey="price" stroke="#ff5b43" strokeWidth={3} dot={{ r: 3.5, fill: '#fff', stroke: '#ff5b43', strokeWidth: 2 }} activeDot={{ r: 6, fill: '#ff5b43', stroke: '#fff', strokeWidth: 3 }}/>
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="tiers-section">
            <div className="panel-head tier-title">
              <div><h3>各票档独立趋势</h3><p>{session.date} · 每个票面分别统计，不混合价格</p></div>
              <div className="view-switch"><button className={tab === '总览' ? 'active' : ''} onClick={() => setTab('总览')}>卡片总览</button><button className={tab === '明细' ? 'active' : ''} onClick={() => setTab('明细')}>价格明细</button></div>
            </div>
            {tab === '总览' ? (
              <div className="tier-grid">{session.tiers.map((tier, index) => <TierCard key={tier} show={activeShow} session={session} tier={tier} index={index} range={range}/>)}</div>
            ) : (
              <div className="price-table-wrap">
                <table className="price-table">
                  <thead><tr><th>票档</th><th>当前最低</th><th>在售票量</th><th>区间最低</th><th>区间最高</th><th>相对票面</th><th>状态</th></tr></thead>
                  <tbody>{session.tiers.map((tier) => { const data = filterTrend(marketFor(activeShow, session, tier), range); if (!data.length) return null; const current = data.at(-1); const liveTier = tierInfo(session, tier); const faceValue = tierFaceValue(session, tier); const relative = faceValue === null ? null : ((current.price / faceValue - 1) * 100); return <tr key={tier}><td><b>{tierLabel(session, tier)}</b>{faceValue !== null && String(faceValue) !== tierLabel(session, tier) && <small className="tier-name-cell">票面 {currency(faceValue, activeShow)}</small>}</td><td><strong>{currency(current.price, activeShow)}</strong></td><td>{current.count} {session.livePrices ? '条已加载' : '张'}</td><td>{currency(Math.min(...data.map(d => d.price)), activeShow)}</td><td>{currency(liveTier?.max || Math.max(...data.map(d => d.price)), activeShow)}</td><td className={relative !== null && relative < 0 ? 'down' : 'up'}>{relative === null ? '—' : `${relative < 0 ? '-' : '+'}${Math.abs(relative).toFixed(1)}%`}</td><td><span className="table-status">{archived ? '已归档' : session.livePrices ? '真实快照' : '监测中'}</span></td></tr>})}</tbody>
                </table>
              </div>
            )}
          </section>

          {session.listings && <section className="listings-section">
            <div className="panel-head listing-title"><div><h3>真实票源明细</h3><p>从 MoreTickets 页面读取的当前最终售价 · 首批展示 {session.listings.length} 条</p></div><a href={activeShow.pageUrl} target="_blank" rel="noreferrer">查看原页面 <ExternalLink size={14}/></a></div>
            <div className="price-table-wrap"><table className="price-table listing-table"><thead><tr><th>票档</th><th>区域 / 票档</th><th>座位说明</th><th>当前最终售价</th><th>交付时间</th><th>Inventory ID</th></tr></thead><tbody>{session.listings.map((item) => <tr key={item.id}><td><b>{item.tier || currency(item.face, activeShow)}</b></td><td>{item.area}</td><td>{item.seat}</td><td><strong>{currency(item.price, activeShow)}</strong><small>/张</small></td><td>{item.delivery}</td><td><code>{item.id}</code></td></tr>)}</tbody></table></div>
          </section>}
          </>}

          <footer className="page-footer"><span><Sparkles size={14}/>票价雷达 · {session.pending ? '新日期已进入监测队列' : activeShow.live ? '当前演出为真实页面快照' : '当前演出为演示数据'}</span><span>{session.pending ? '等待首次抓取并自动归类' : activeShow.live ? `来源 MoreTickets · ${session.lastCollected}` : '真实接入后按场次与票档自动去重'}</span></footer>
        </div>
      </main>
    </div>
  )
}
