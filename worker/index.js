const STATIC_ASSETS = /*__STATIC_ASSETS__*/
const LEGACY_STATE_URL = 'https://pjld666.memonrial.chatgpt.site/api/shared-state'

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  },
})

function canWrite(request, env) {
  const expected = String(env.RADAR_WRITE_TOKEN || '')
  const provided = String(request.headers.get('x-radar-write-token') || '')
  return expected.length >= 8 && provided.length === expected.length && provided === expected
}

function parseStored(row) {
  if (!row) return { initialized: false, targets: [], showGroups: [], revision: 0, updatedAt: null }
  return {
    initialized: true,
    targets: JSON.parse(row.targets_json),
    showGroups: JSON.parse(row.show_groups_json),
    revision: row.revision,
    updatedAt: row.updated_at,
  }
}

async function readState(db) {
  const row = await db.prepare(
    'SELECT targets_json, show_groups_json, revision, updated_at FROM shared_radar_state WHERE id = 1',
  ).first()
  return parseStored(row)
}

function validateState(body) {
  if (!body || !Array.isArray(body.targets) || !Array.isArray(body.showGroups)) {
    throw new Error('监测数据格式无效')
  }
  if (body.targets.length > 500 || body.showGroups.length > 200) throw new Error('监测项目数量超过上限')
  const targetsJson = JSON.stringify(body.targets)
  const showGroupsJson = JSON.stringify(body.showGroups)
  if (targetsJson.length + showGroupsJson.length > 1_500_000) throw new Error('共享数据量超过当前上限')
  return { targetsJson, showGroupsJson, baseRevision: Number(body.baseRevision || 0) }
}

async function writeState(request, db) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: '请求内容不是有效的数据' }, 400)
  }

  let payload
  try {
    payload = validateState(body)
  } catch (error) {
    return json({ error: error.message }, 400)
  }

  const now = new Date().toISOString()
  if (payload.baseRevision === 0) {
    const result = await db.prepare(
      'INSERT OR IGNORE INTO shared_radar_state (id, targets_json, show_groups_json, revision, updated_at) VALUES (1, ?, ?, 1, ?)',
    ).bind(payload.targetsJson, payload.showGroupsJson, now).run()
    if (Number(result.meta?.changes || 0) === 0) return json({ error: '共享数据已经由其他访问者初始化', state: await readState(db) }, 409)
    return json(await readState(db))
  }

  const result = await db.prepare(
    'UPDATE shared_radar_state SET targets_json = ?, show_groups_json = ?, revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ?',
  ).bind(payload.targetsJson, payload.showGroupsJson, now, payload.baseRevision).run()
  if (Number(result.meta?.changes || 0) === 0) return json({ error: '共享数据已发生变化', state: await readState(db) }, 409)
  return json(await readState(db))
}

async function migrateLegacyState(db) {
  const response = await fetch(LEGACY_STATE_URL, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error('旧网站数据暂时无法读取')
  const state = await response.json()
  const payload = validateState(state)
  const now = new Date().toISOString()
  await db.prepare(
    'UPDATE shared_radar_state SET targets_json = ?, show_groups_json = ?, revision = revision + 1, updated_at = ? WHERE id = 1',
  ).bind(payload.targetsJson, payload.showGroupsJson, now).run()
  return readState(db)
}

function finiteNumber(value, fallback = null) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function chinaTime(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return { full: iso, short: iso }
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {})
  return {
    full: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`,
    short: `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`,
  }
}

function normalizedSnapshot(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('抓取快照格式无效')
  const sessionId = String(raw.session_id || '').slice(0, 160)
  const showId = String(raw.show_id || '').slice(0, 160)
  if (!sessionId || !showId) throw new Error('抓取快照缺少场次编号')
  const tiers = Array.isArray(raw.tiers) ? raw.tiers.slice(0, 80) : []
  const listings = Array.isArray(raw.listings) ? raw.listings.slice(0, 500) : []
  return {
    sessionId,
    showId,
    showName: String(raw.show_name || '').trim().slice(0, 240),
    venue: String(raw.venue || '').trim().slice(0, 240),
    city: String(raw.city || '').trim().slice(0, 80),
    sessionDate: String(raw.session_date || '').slice(0, 10),
    sessionTime: String(raw.session_time || '').slice(0, 5),
    sessionWeekday: String(raw.session_weekday || '').slice(0, 12),
    sessionText: String(raw.session_text || '').trim().slice(0, 300),
    currency: raw.currency === 'HK$' ? 'HK$' : '¥',
    listingCount: Math.max(0, finiteNumber(raw.listing_count, 0)),
    loadedCount: Math.max(0, finiteNumber(raw.loaded_listing_count, listings.length)),
    marketMin: finiteNumber(raw.market_min_price),
    collectedAt: String(raw.collected_at || new Date().toISOString()).slice(0, 40),
    tiers,
    listings,
  }
}

function mergeSnapshotIntoState(state, snapshot) {
  const target = state.targets.find((item) => String(item.id) === snapshot.sessionId || String(item.sessionId || '') === snapshot.sessionId)
  if (!target) throw new Error('这个场次已不在监测列表中')

  const groups = structuredClone(state.showGroups)
  const groupIndex = groups.findIndex((item) => String(item.showId || item.groupKey || '') === snapshot.showId)
  if (groupIndex < 0) throw new Error('找不到这个场次所属的演出')
  const group = groups[groupIndex]
  const sessionIndex = group.sessions.findIndex((item) => String(item.id) === snapshot.sessionId)
  if (sessionIndex < 0) throw new Error('找不到需要更新的日期场次')

  const current = group.sessions[sessionIndex]
  const time = chinaTime(snapshot.collectedAt)
  const tierValues = [...new Set(snapshot.tiers.map((tier) => finiteNumber(tier.face_value)).filter((value) => value !== null))].sort((a, b) => a - b)
  if (!tierValues.length) throw new Error('抓取结果中没有可用票档')
  const livePrices = {}
  const tierHistory = structuredClone(current.tierHistory || {})

  for (const face of tierValues) {
    const zone = snapshot.tiers.find((tier) => finiteNumber(tier.face_value) === face) || {}
    const rows = snapshot.listings.filter((item) => finiteNumber(item.face_value) === face)
    const prices = rows.map((item) => finiteNumber(item.sale_price)).filter((value) => value !== null)
    const fallbackPrice = finiteNumber(zone.minimum_price)
    const minimum = prices.length ? Math.min(...prices) : fallbackPrice
    if (minimum === null) continue
    livePrices[face] = {
      price: minimum,
      count: rows.length,
      max: prices.length ? Math.max(...prices) : minimum,
      name: String(zone.face_name || `票面 ${face}`).slice(0, 120),
    }
    const previous = Array.isArray(tierHistory[face]) ? tierHistory[face] : []
    tierHistory[face] = [...previous.filter((item) => item.collectedAt !== snapshot.collectedAt), {
      time: time.short, price: minimum, count: rows.length, face, collectedAt: snapshot.collectedAt,
    }].slice(-720)
  }

  const marketMin = snapshot.marketMin ?? Math.min(...Object.values(livePrices).map((item) => item.price))
  const history = [...(current.history || []).filter((item) => item.collectedAt !== snapshot.collectedAt), {
    time: time.short,
    price: Number.isFinite(marketMin) ? marketMin : 0,
    count: snapshot.listingCount,
    collectedAt: snapshot.collectedAt,
  }].slice(-720)

  group.artist = snapshot.showName || group.artist || target.name
  if (String(group.tour || '').includes('等待首次抓取')) group.tour = snapshot.sessionText || 'MoreTickets 市场监测'
  group.city = snapshot.city || (group.city === '待识别' ? '待补充' : group.city)
  group.venue = snapshot.venue || (group.venue === '待识别地点' ? '待补充地点' : group.venue)
  group.status = '监测中'
  group.currency = snapshot.currency
  group.live = true
  group.pageUrl = target.url || group.pageUrl
  group.sessions[sessionIndex] = {
    ...current,
    id: snapshot.sessionId,
    date: snapshot.sessionDate || current.date,
    weekday: snapshot.sessionWeekday || current.weekday,
    time: snapshot.sessionTime || current.time,
    tiers: tierValues,
    pending: false,
    sourceUrl: target.url || current.sourceUrl,
    listingCount: snapshot.listingCount,
    loadedCount: snapshot.loadedCount,
    lastCollected: time.full,
    livePrices,
    tierHistory,
    history,
    listings: snapshot.listings.slice(0, 200).map((item, index) => ({
      id: String(item.inventory_id || `${snapshot.sessionId}-${index}`),
      face: finiteNumber(item.face_value, 0),
      area: String(item.area_name || item.face_name || ''),
      seat: String(item.seat_info || 'Random'),
      price: finiteNumber(item.sale_price, 0),
      delivery: String(item.delivery_text || ''),
    })),
  }
  groups[groupIndex] = group
  return { targets: state.targets, showGroups: groups }
}

async function ingestSnapshot(request, db) {
  let snapshot
  try {
    snapshot = normalizedSnapshot(await request.json())
  } catch (error) {
    return json({ error: error.message || '抓取快照无法读取' }, 400)
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await readState(db)
    if (!state.initialized) return json({ error: '共享监测列表尚未初始化' }, 409)
    let merged
    try {
      merged = mergeSnapshotIntoState(state, snapshot)
    } catch (error) {
      return json({ error: error.message }, 404)
    }
    const targetsJson = JSON.stringify(merged.targets)
    const showGroupsJson = JSON.stringify(merged.showGroups)
    if (targetsJson.length + showGroupsJson.length > 1_500_000) return json({ error: '历史数据量超过当前上限' }, 413)
    const result = await db.prepare(
      'UPDATE shared_radar_state SET targets_json = ?, show_groups_json = ?, revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ?',
    ).bind(targetsJson, showGroupsJson, new Date().toISOString(), state.revision).run()
    if (Number(result.meta?.changes || 0) > 0) return json({ ok: true, sessionId: snapshot.sessionId, revision: state.revision + 1 })
  }
  return json({ error: '数据刚刚被其他访问者修改，请稍后重试' }, 409)
}

function decodeBase64(value) {
  const raw = atob(value)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function serveAsset(request, pathname) {
  let key = pathname === '/' ? '/index.html' : pathname
  let asset = STATIC_ASSETS[key]
  if (!asset && request.headers.get('accept')?.includes('text/html')) {
    key = '/index.html'
    asset = STATIC_ASSETS[key]
  }
  if (!asset) return new Response('Not found', { status: 404 })
  const body = asset.encoding === 'base64' ? decodeBase64(asset.body) : asset.body
  const headers = {
    'content-type': asset.contentType,
    'x-content-type-options': 'nosniff',
    'cache-control': key === '/index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  }
  return new Response(body, { headers })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/api/shared-state') {
        if (request.method === 'GET') return json(await readState(env.DB))
        if (request.method === 'PUT') {
          if (!canWrite(request, env)) return json({ error: '共享编辑密码错误' }, 401)
          return await writeState(request, env.DB)
        }
        return json({ error: '不支持的操作' }, 405)
      }
      if (url.pathname === '/api/migrate-legacy') {
        if (request.method !== 'POST') return json({ error: '不支持的操作' }, 405)
        if (!canWrite(request, env)) return json({ error: '共享编辑密码错误' }, 401)
        return json(await migrateLegacyState(env.DB))
      }
      if (url.pathname === '/api/collector/snapshot') {
        if (request.method === 'POST') {
          if (!canWrite(request, env)) return json({ error: '抓取程序没有写入权限' }, 401)
          return await ingestSnapshot(request, env.DB)
        }
        return json({ error: '不支持的操作' }, 405)
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 })
      return serveAsset(request, decodeURIComponent(url.pathname))
    } catch (error) {
      console.error('ticket-radar request failed', error)
      return json({ error: '共享数据库暂时不可用，请稍后重试' }, 500)
    }
  },
}
