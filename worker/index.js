import puppeteer from '@cloudflare/puppeteer'

const LEGACY_STATE_URL = 'https://pjld666.memonrial.chatgpt.site/api/shared-state'

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  },
})

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

function cleanVenue(value) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^(?:venue|location|address|场馆|场地|地点)\s*[:：-]?\s*/i, '')
    .trim()
  if (!text || text.length > 120) return ''
  if (/^(?:待识别|待补充|unknown|n\/a|null|undefined)$/i.test(text)) return ''
  if (/(?:https?:\/\/|data:|\[object|undefined|null)/i.test(text)) return ''
  const meaningful = text.match(/[\p{L}\p{N}]/gu) || []
  const unusual = text.match(/[^\p{L}\p{N}\s·&()（）,，.。\-/'"]/gu) || []
  if (!meaningful.length || unusual.length > Math.max(3, text.length * 0.12)) return ''
  return text
}

function tierIdentity(item) {
  const sourceName = String(item?.tier_key || item?.face_name || '').replace(/\s+/g, ' ').trim()
  const numericText = sourceName.replace(/^(?:HK\$|HKD|RMB|CNY|[¥￥$])\s*/i, '').replaceAll(',', '')
  const isNumericTicketTier = /^\d+(?:\.\d+)?$/.test(numericText)
  const fallback = finiteNumber(item?.face_value)
  const key = sourceName || (fallback === null ? '未命名票档' : String(fallback))
  return {
    key: key.slice(0, 120),
    name: key.slice(0, 120),
    faceValue: isNumericTicketTier ? finiteNumber(numericText) : (sourceName ? null : fallback),
  }
}

function sessionEndTime(session) {
  const date = String(session?.date || '')
  const time = /^\d{2}:\d{2}$/.test(String(session?.time || '')) ? session.time : '23:59'
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(date)) return null
  const timestamp = new Date(`${date}T${time}:00+08:00`).getTime()
  return Number.isFinite(timestamp) ? timestamp + 6 * 60 * 60 * 1000 : null
}

function isFinishedSession(session) {
  const endTime = sessionEndTime(session)
  return !session?.pending && endTime !== null && endTime <= Date.now()
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
    venue: cleanVenue(raw.venue),
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
  const zonesByTier = new Map()
  for (const zone of snapshot.tiers) {
    const identity = tierIdentity(zone)
    if (identity.key !== '未命名票档' && !zonesByTier.has(identity.key)) zonesByTier.set(identity.key, { ...zone, ...identity })
  }
  const tierKeys = [...zonesByTier.keys()]
  if (!tierKeys.length) throw new Error('抓取结果中没有可用票档')
  const livePrices = {}
  const tierHistory = structuredClone(current.tierHistory || {})

  for (const key of tierKeys) {
    const zone = zonesByTier.get(key)
    const rows = snapshot.listings.filter((item) => tierIdentity(item).key === key)
    const prices = rows.map((item) => finiteNumber(item.sale_price)).filter((value) => value !== null)
    const fallbackPrice = finiteNumber(zone.minimum_price)
    const minimum = prices.length ? Math.min(...prices) : fallbackPrice
    if (minimum === null) continue
    livePrices[key] = {
      price: minimum,
      count: rows.length,
      max: prices.length ? Math.max(...prices) : minimum,
      name: zone.name,
      faceValue: zone.faceValue,
    }
    const previous = Array.isArray(tierHistory[key]) ? tierHistory[key] : []
    tierHistory[key] = [...previous.filter((item) => item.collectedAt !== snapshot.collectedAt), {
      time: time.short, price: minimum, count: rows.length, face: key, collectedAt: snapshot.collectedAt,
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
  group.venue = snapshot.venue || cleanVenue(group.venue) || '待补充地点'
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
    tiers: tierKeys,
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
      face: tierIdentity(item).faceValue,
      tier: tierIdentity(item).name,
      area: String(item.area_name || item.face_name || ''),
      seat: String(item.seat_info || 'Random'),
      price: finiteNumber(item.sale_price, 0),
      delivery: String(item.delivery_text || ''),
    })),
  }
  groups[groupIndex] = group
  const targets = state.targets.map((item) => (String(item.id) === snapshot.sessionId
    ? { ...item, status: '监测中', interval: 120, lastCollected: time.full }
    : item))
  return { targets, showGroups: groups }
}

async function archiveExpiredShows(db) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await readState(db)
    if (!state.initialized) return state
    let changed = false
    const showGroups = state.showGroups.map((group) => {
      const shouldArchive = !group.archivedAt && group.sessions?.length && group.sessions.every(isFinishedSession)
      if (!shouldArchive) return group
      changed = true
      return { ...group, status: '已归档', archivedAt: new Date().toISOString() }
    })
    if (!changed) return state
    const result = await db.prepare(
      'UPDATE shared_radar_state SET show_groups_json = ?, revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ?',
    ).bind(JSON.stringify(showGroups), new Date().toISOString(), state.revision).run()
    if (Number(result.meta?.changes || 0) > 0) return readState(db)
  }
  return readState(db)
}

async function persistSnapshot(db, snapshot) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await readState(db)
    if (!state.initialized) throw new Error('共享监测列表尚未初始化')
    const merged = mergeSnapshotIntoState(state, snapshot)
    const targetsJson = JSON.stringify(merged.targets)
    const showGroupsJson = JSON.stringify(merged.showGroups)
    if (targetsJson.length + showGroupsJson.length > 1_500_000) throw new Error('历史数据量超过当前上限')
    const result = await db.prepare(
      'UPDATE shared_radar_state SET targets_json = ?, show_groups_json = ?, revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ?',
    ).bind(targetsJson, showGroupsJson, new Date().toISOString(), state.revision).run()
    if (Number(result.meta?.changes || 0) > 0) return { ok: true, sessionId: snapshot.sessionId, revision: state.revision + 1 }
  }
  throw new Error('数据刚刚被其他访问者修改，请稍后重试')
}

async function ingestSnapshot(request, db) {
  try {
    const snapshot = normalizedSnapshot(await request.json())
    return json(await persistSnapshot(db, snapshot))
  } catch (error) {
    return json({ error: error.message || '抓取快照无法读取' }, 400)
  }
}

function readTargetIds(value) {
  const url = new URL(value)
  if (!url.hostname.endsWith('moretickets.com')) throw new Error('只支持 MoreTickets 选座网址')
  const sessionId = url.searchParams.get('sessionId')
  const showId = url.searchParams.get('showId')
  const tourId = url.searchParams.get('tourId')
  if (!sessionId || !showId) throw new Error('链接中缺少 sessionId 或 showId')
  return { sourceUrl: url.toString(), sessionId, showId, tourId }
}

function parseSessionText(sessionText) {
  const chinese = sessionText.match(/(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})日?/) 
  const english = sessionText.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})\b/i)
  let date = ''
  if (chinese) date = `${chinese[1]}-${String(chinese[2]).padStart(2, '0')}-${String(chinese[3]).padStart(2, '0')}`
  if (english) {
    const parsed = new Date(`${english[1]} ${english[2]} ${english[3]} 12:00:00 UTC`)
    if (!Number.isNaN(parsed.getTime())) date = parsed.toISOString().slice(0, 10)
  }
  const weekday = date ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${date}T12:00:00Z`).getUTCDay()] : ''
  const timeMatch = sessionText.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/)
  let time = ''
  if (timeMatch) {
    let hour = Number(timeMatch[1])
    const after = sessionText.slice(timeMatch.index + timeMatch[0].length, timeMatch.index + timeMatch[0].length + 4).trim().toUpperCase()
    if (after.startsWith('PM') && hour < 12) hour += 12
    if (after.startsWith('AM') && hour === 12) hour = 0
    time = `${String(hour).padStart(2, '0')}:${timeMatch[2]}`
  }
  return { date, weekday, time }
}

async function scrapeMoreTickets(targetUrl, env) {
  const ids = readTargetIds(targetUrl)
  let browser
  try {
    browser = await puppeteer.launch(env.BROWSER)
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 1000 })
    await page.goto(ids.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await page.waitForSelector('.ticket.hasColor.pc', { timeout: 90_000 })

    const pageInfo = await page.evaluate(() => {
      const text = (selector) => document.querySelector(selector)?.textContent?.trim() || ''
      const cleanVenueCandidate = (value) => {
        const clean = String(value || '')
          .replace(/\s+/g, ' ')
          .replace(/^(?:venue|location|address|场馆|场地|地点)\s*[:：-]?\s*/i, '')
          .trim()
        if (!clean || clean.length > 120) return ''
        if (/(?:https?:\/\/|data:|\[object|undefined|null)/i.test(clean)) return ''
        const meaningful = clean.match(/[\p{L}\p{N}]/gu) || []
        const unusual = clean.match(/[^\p{L}\p{N}\s·&()（）,，.。\-/'"]/gu) || []
        return meaningful.length && unusual.length <= Math.max(3, clean.length * 0.12) ? clean : ''
      }
      const candidates = []
      const addCandidate = (element, priority) => {
        const value = cleanVenueCandidate(element?.textContent)
        if (value) candidates.push({ value, priority, length: value.length })
      }
      const venueSelectors = [
        '.venue-name', '.show-venue-name', '.show-venue', '.show-address', '.show-location',
        '.venue', '.location', '.address', "[data-testid*='venue' i]", "[data-testid*='location' i]", "[data-testid*='address' i]",
      ]
      venueSelectors.forEach((selector, priority) => document.querySelectorAll(selector).forEach((element) => addCandidate(element, priority)))
      document.querySelectorAll('[class]').forEach((element) => {
        const isVenueField = [...element.classList].some((className) => /(?:^|[-_])(venue|location|address)(?:[-_]|$)/i.test(className))
        if (isVenueField) addCandidate(element, 20)
      })
      candidates.sort((left, right) => left.priority - right.priority || left.length - right.length)
      return {
        showName: text('.tour-name'),
        sessionText: text('.date-time'),
        countText: text('.inventory-count'),
        venue: candidates[0]?.value || '',
      }
    })
    const zones = await page.$$eval('.zone', (elements) => elements.map((element) => ({
      color: element.style.getPropertyValue('--zone-color').trim(),
      face_name: element.querySelector('.zone-name')?.textContent?.trim() || '',
      minimum_text: element.querySelector('.price')?.textContent?.trim() || '',
    })).map((zone) => {
      const name = zone.face_name.replace(/\s+/g, ' ').trim()
      const numericText = name.replace(/^(?:HK\$|HKD|RMB|CNY|[¥￥$])\s*/i, '').replaceAll(',', '')
      const faceValue = /^\d+(?:\.\d+)?$/.test(numericText) ? Number(numericText) : null
      const prices = zone.minimum_text.match(/\d+(?:\.\d+)?/g) || []
      return { ...zone, tier_key: name, face_value: faceValue, minimum_price: prices.length ? Number(prices.at(-1)) : null }
    }))
    const zoneByColor = new Map(zones.map((zone) => [zone.color, zone]))
    const countMatch = pageInfo.countText.match(/[\d,]+/)
    const listingCount = countMatch ? Number(countMatch[0].replaceAll(',', '')) : 0
    const collected = new Map()

    for (let turn = 0, unchanged = 0, previousSize = -1; turn < 80; turn += 1) {
      const cards = await page.$$eval('.ticket.hasColor.pc', (elements) => elements.map((element) => ({
        inventory_id: element.getAttribute('data-inventory-id'),
        color: element.style.getPropertyValue('--ticket-color').trim(),
        area_name: element.querySelector('.ticket-title')?.textContent?.trim() || '',
        seat_info: element.querySelector('.seat')?.textContent?.trim() || '',
        sale_price: Number((element.querySelector('.discount-price')?.textContent || '').replace(/[^0-9.]/g, '')),
        delivery_text: element.querySelector('.issue-text')?.textContent?.trim() || '',
      })))
      for (const card of cards) if (card.inventory_id && Number.isFinite(card.sale_price) && card.sale_price > 0) collected.set(card.inventory_id, card)
      if (collected.size === previousSize) unchanged += 1
      else { previousSize = collected.size; unchanged = 0 }
      if ((listingCount && collected.size >= listingCount) || unchanged >= 5) break
      await page.$eval('.pc-ticket-list', (element) => { element.scrollTop += Math.max(element.clientHeight * 0.8, 500) })
      await new Promise((resolve) => setTimeout(resolve, 350))
    }

    const collectedAt = new Date().toISOString()
    const listings = [...collected.values()].map((card) => ({ ...card, ...(zoneByColor.get(card.color) || {}), collected_at: collectedAt })).sort((left, right) => left.sale_price - right.sale_price)
    const session = parseSessionText(pageInfo.sessionText)
    return {
      session_id: ids.sessionId,
      show_id: ids.showId,
      tour_id: ids.tourId,
      source_url: ids.sourceUrl,
      show_name: pageInfo.showName,
      session_text: pageInfo.sessionText,
      session_date: session.date,
      session_time: session.time,
      session_weekday: session.weekday,
      venue: pageInfo.venue,
      currency: zones.some((zone) => zone.minimum_text.includes('HK$')) ? 'HK$' : '¥',
      listing_count: listingCount,
      loaded_listing_count: listings.length,
      market_min_price: listings.length ? listings[0].sale_price : null,
      collected_at: collectedAt,
      tiers: zones,
      listings,
    }
  } finally {
    if (browser) await browser.close()
  }
}

async function collectTarget(target, env) {
  const snapshot = normalizedSnapshot(await scrapeMoreTickets(target.url, env))
  await persistSnapshot(env.DB, snapshot)
  return snapshot
}

async function collectEveryTarget(env) {
  const state = await archiveExpiredShows(env.DB)
  for (const target of state.targets) {
    const group = state.showGroups.find((item) => String(item.showId || item.groupKey || '') === String(target.showId || ''))
    const session = group?.sessions?.find((item) => String(item.id) === String(target.id))
    if (session && isFinishedSession(session)) continue
    try { await collectTarget(target, env) } catch (error) { console.error('scheduled ticket collection failed', target.id, error) }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/api/shared-state') {
        if (request.method === 'GET') return json(await readState(env.DB))
        if (request.method === 'PUT') {
          return await writeState(request, env.DB)
        }
        return json({ error: '不支持的操作' }, 405)
      }
      if (url.pathname === '/api/migrate-legacy') {
        if (request.method !== 'POST') return json({ error: '不支持的操作' }, 405)
        return json(await migrateLegacyState(env.DB))
      }
      if (url.pathname === '/api/collector/snapshot') {
        if (request.method === 'POST') {
          return await ingestSnapshot(request, env.DB)
        }
        return json({ error: '不支持的操作' }, 405)
      }
      if (url.pathname === '/api/collect-now') {
        if (request.method !== 'POST') return json({ error: '不支持的操作' }, 405)
        const body = await request.json().catch(() => ({}))
        const sessionId = String(body.sessionId || '')
        const state = await readState(env.DB)
        const target = state.targets.find((item) => String(item.id) === sessionId)
        if (!target) return json({ error: '找不到需要抓取的监测网址' }, 404)
        const snapshot = await collectTarget(target, env)
        return json({ ok: true, sessionId: snapshot.sessionId, state: await readState(env.DB) })
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 })
      return env.ASSETS.fetch(request)
    } catch (error) {
      console.error('ticket-radar request failed', error)
      return json({ error: '共享数据库暂时不可用，请稍后重试' }, 500)
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(collectEveryTarget(env))
  },
}
