/**
 * The PayPal Desk background module. One resident worker per Velloc: on a
 * timer it reads the merchant's invoices, disputes and recent transactions
 * through the plugin's PayPal MCP server, keeps the store's orders (the
 * paid invoices numbered `PD-YYYYMMDD-NNN`) in its store, derives the sales
 * board and the open cases, and copies invoice requests dropped into the
 * declared inbox folder into the app's folder for the session agent.
 *
 * Contract: the module only reads PayPal. Every write (a refund, a reminder,
 * an accepted claim) is the session agent's, and the session hook puts it
 * to the person first. State is the app's `/data`: it is kept small, since
 * the whole of it travels with every dashboard action. It is published one
 * top-level key per patch, so a day's rollover that changes every figure is
 * still a handful of patches.
 */
import { addDays, dateOf, shortDate } from './lib/dates.js'
import { DEFAULT_RULES, checkRules, disputeAlerts } from './lib/alerts.js'
import { refundBreakdown } from './lib/insights.js'
import { invoiceRowFields, paymentOrders, readStoreRow, salesBoard } from './lib/sales.js'

export const POLL_MS = 5 * 60_000
export const SERVER = 'paypal'
export const ROW_CAP = 50
export const CASE_CAP = 30
export const PAGE_SIZE = 100
export const MAX_PAGES = 60
/** Page sizes a refused invoice page is read again in, largest first. */
export const PAGE_LADDER = [PAGE_SIZE, 10, 5, 1]
/** The highest page number the list accepts. */
export const MAX_PAGE_NUMBER = 1000
/** Extra list calls one sync may spend reading refused pages again. */
export const FALLBACK_CALLS = 300
/** Every invoice page is read again this often, so a refund or a deletion on an old invoice is seen. */
export const FULL_SCAN_MS = 60 * 60_000
/** Orders older than this many days are not kept. */
export const KEEP_DAYS = 62
const TRANSACTION_DAYS = 30
/** Transaction Search pages one sync reads at most (500 rows each). */
export const TRANSACTION_PAGES = 10
export const PAYMENTS_KEY = 'payments.cache'
const INBOX_EXTENSIONS = ['.csv', '.json', '.txt', '.md']
const HANDLED_FILE = 'data/handled.json'
/** The person's alert rules; the session agent writes them, the module checks them every sync. */
export const ALERTS_FILE = 'data/alerts.json'
/** Conclusions the agent wrote after an analysis, newest first on the board. */
export const FINDINGS_FILE = 'data/findings.json'
/** The refund breakdown the agent reads to explain a change; rewritten when it changes. */
export const REFUNDS_FILE = 'data/refunds.json'
const FINDINGS_SHOWN = 5
/** Which alert weeks had an analysis started, and when: {"<alert id>@<week>": ms}. */
export const ANALYSES_KEY = 'analyses'
/** How long an analysis that ended without a finding waits before it is started again. */
export const ANALYSIS_RETRY_MS = 6 * 3_600_000
const NEEDS_SHOWN = 3
/** Days a to-do marked done stays hidden; it comes back after them if it is still true. */
export const DONE_DAYS = 7
/** The Actions tab's index in `app.a2ui`'s Tabs. */
const TODO_TAB = 2
/** How often the module looks for a changed alert or finding file between syncs. */
export const RULES_WATCH_MS = 10_000
const SEEN_KEY = 'inbox.seen'
export const ORDERS_KEY = 'orders.cache'

let pending = Promise.resolve()

/** Resolves when the sync in flight, if any, has finished. For tests. */
export function whenIdle() {
  return pending
}

export function register(on) {
  let timer = null
  let watch = null
  let running = false

  on('app.start', async ($, e) => {
    if (timer) timer.cancel()
    const inbox = e.folders && e.folders.read && e.folders.read[0]
    const tick = async () => {
      if (running) return
      running = true
      try {
        await syncOnce($, { inbox, now: await $.clock.now() })
      } catch (err) {
        await $.log.warn(`sync failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        running = false
      }
    }
    const run = () => {
      pending = tick()
      return pending
    }
    // The first full invoice read can outlast app.start's budget, so it is not awaited.
    run()
    timer = $.clock.every(POLL_MS, run)
    // A rule or finding the agent just wrote shows on the board within seconds, not at the next sync.
    if (watch) watch.cancel()
    watch = $.clock.every(RULES_WATCH_MS, async () => {
      if (!running && (await rulesText($)) !== rulesSeen) await run()
    })
  })

  on('app.stop', async () => {
    if (timer) timer.cancel()
    if (watch) watch.cancel()
    timer = null
    watch = null
  })

  on('app.action', async ($, e) => handleAction($, e))
}

/**
 * The board's local actions, each changing its file and the board at once:
 * `dismiss_finding` {id} removes a finding; `mark_done` {id} moves a to-do to
 * the done list for DONE_DAYS; `undo_done` {id} puts it back on the open
 * list; `delete_todo` {id} takes it off both for DONE_DAYS. Answers
 * {handled: false} for any other action, which then goes to the model.
 * Alerts are changed and removed by the session agent, asked through the
 * composer.
 */
export async function handleAction($, e) {
  const id = e && e.context && typeof e.context.id === 'string' ? e.context.id : ''
  const todoAction = e && TODO_ACTIONS[e.action]
  if (todoAction && id) return changeTodo($, id, todoAction)
  const target = e && e.action === 'dismiss_finding' ? { file: FINDINGS_FILE, key: 'findings' } : null
  if (!target || !id) return { handled: false }
  const doc = await readJsonFile($, target.file)
  const list = Array.isArray(doc && doc[target.key]) ? doc[target.key] : []
  const kept = list.filter(item => !(item && item.id === id))
  if (kept.length !== list.length) await $.fs.write(target.file, `${JSON.stringify({ ...doc, [target.key]: kept }, null, 2)}\n`)
  const state = (await $.app.state.get()) || {}
  const shown = Array.isArray(state[target.key]) ? state[target.key] : []
  if (shown.some(item => item.id === id)) {
    await publishState($, state, { ...state, [target.key]: shown.filter(item => item.id !== id) })
  }
  return { handled: true }
}

const TODO_ACTIONS = { mark_done: 'done', undo_done: 'open', delete_todo: 'deleted' }

/**
 * Moves a to-do between the open list, the done list and neither: records it
 * in the handled file (with the to-do itself, so the done list can show it
 * and an undo can put it back) and republishes both lists.
 */
async function changeTodo($, id, to) {
  const today = dateOf(await $.clock.now())
  const handled = normalizeHandled(await readJsonFile($, HANDLED_FILE))
  const before = handled.find(h => h.id === id)
  const state = (await $.app.state.get()) || {}
  const open = Array.isArray(state.cases) ? state.cases : []
  const todo = open.find(c => c.id === id) || (before && before.todo) || null
  const kept = handled.filter(h => h.id !== id && (!h.at || h.at >= addDays(today, -60)))
  const entry = to === 'open' ? null
    : { id, at: to === 'deleted' && before && before.at ? before.at : today, ...(to === 'deleted' ? { state: 'deleted' } : {}), ...(todo ? { todo } : {}) }
  const next = entry ? [...kept, entry] : kept
  await $.fs.write(HANDLED_FILE, `${JSON.stringify(next, null, 2)}\n`)
  const others = open.filter(c => c.id !== id)
  const cases = to === 'open' && todo ? openTodos([...others, todo], [], today) : others
  const doneCases = doneTodos(next, cases, today)
  await publishState($, state, { ...state, ...todoView(cases), doneCases, summary: { ...(state.summary || {}), ...todoSummary(cases) } })
  // An alert's to-do is rebuilt from the alert itself; any other waits for the next sync.
  if (to === 'open' && !todo && id.startsWith('alert:')) await refreshFindings($)
  return { handled: true }
}

/** A JSON file of the app's folder, or null when it is missing or not JSON. */
async function readJsonFile($, path) {
  try {
    if (!(await $.fs.exists(path))) return null
    return JSON.parse(await $.fs.read(path, { as: 'text' }))
  } catch {
    return null
  }
}

let refundsWritten = ''
/** The alert and finding files as the last sync read them. */
let rulesSeen = ''

/** The alert and finding files' text, to notice the agent changing them. */
async function rulesText($) {
  const read = async path => {
    try {
      return (await $.fs.exists(path)) ? await $.fs.read(path, { as: 'text' }) : ''
    } catch {
      return ''
    }
  }
  return `${await read(ALERTS_FILE)}\u0000${await read(FINDINGS_FILE)}`
}

/** Rewrites the refund breakdown file when its content changed. */
async function writeRefunds($, orders, today) {
  const text = `${JSON.stringify(refundBreakdown(orders, today), null, 1)}\n`
  if (text === refundsWritten) return
  try {
    await $.fs.write(REFUNDS_FILE, text)
    refundsWritten = text
  } catch (err) {
    await $.log.warn(`could not write ${REFUNDS_FILE}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** One sync: connect, read, derive, publish. Exported for tests with a fake `$`. */
export async function syncOnce($, { inbox, now }) {
  const previous = (await $.app.state.get()) || {}
  const connected = await $.mcp.connect(SERVER)
  if (!connected || connected.isConnected !== true) {
    const message = (connected && connected.message) || 'the PayPal server is not connected'
    await publishState($, previous, {
      ...emptyState(previous),
      sync: { at: now, ok: false, error: message, note: `Not connected to PayPal: ${message}` },
    })
    return
  }

  const errors = {}
  const unavailable = []
  const read = (tool, args) => readList($, tool, args, errors, unavailable)
  const scan = await scanInvoices($, { now, errors, unavailable })
  const raw = {
    disputes: await read('list_disputes', { page_size: ROW_CAP }),
    transactions: await readTransactions(read, now),
  }
  const payments = await storePayments($, raw.transactions, Boolean(errors.list_transactions))
  const inboxFiles = inbox ? await pullInbox($, inbox) : []
  const handled = await readHandled($)
  const orders = [...scan.orders, ...payments]
  await writeRefunds($, orders, dateOf(now))
  rulesSeen = await rulesText($)
  const alertsDoc = await readJsonFile($, ALERTS_FILE)
  const alertRules = alertsDoc ? listOf(alertsDoc, 'alerts') : DEFAULT_RULES
  const findings = listOf(await readJsonFile($, FINDINGS_FILE), 'findings')

  let next = deriveState({ previous, raw, orders, alertRules, findings, running: analyzing, openInvoices: scan.openInvoices, unread: scan.unread, inboxFiles, handled, errors, unavailable, now })
  if (await startAnalysis($, next.alerts, now, () => refreshFindings($))) {
    next = { ...next, alerts: next.alerts.map(a => alertWithStatus(a, findings, analyzing)) }
  }
  await publishState($, previous, next)
}

/** The alert week being analyzed now, {id, week}, or null. */
let analyzing = null

/**
 * Starts an agent run for the first tripped alert whose week has no finding
 * yet, unless a run is in flight, the host offers no `$.app.analyze`, or that
 * week was tried within ANALYSIS_RETRY_MS. Does not wait for the run:
 * answers {run} (settling once `onDone` ran) when it started one, else null.
 */
export async function startAnalysis($, alerts, now, onDone) {
  if (analyzing || typeof $.app.analyze !== 'function') return null
  const tried = (await $.store.get(ANALYSES_KEY)) || {}
  const due = (alerts || []).find(a => a.tripped && !a.analyzed && !(now - (tried[`${a.id}@${a.week}`] || 0) < ANALYSIS_RETRY_MS))
  if (!due) return null
  const key = `${due.id}@${due.week}`
  const kept = Object.fromEntries(Object.entries(tried).filter(([, at]) => now - at < 30 * 86_400_000))
  await $.store.set(ANALYSES_KEY, { ...kept, [key]: now })
  analyzing = { id: due.id, week: due.week }
  let answer
  try {
    answer = $.app.analyze({ title: `Analyze alert: ${due.name}`, prompt: analysisPrompt(due) })
  } catch (err) {
    answer = Promise.reject(err)
  }
  const run = Promise.resolve(answer)
    .then(r => r || { ok: false, reason: 'no answer' }, err => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }))
    .then(async r => {
      analyzing = null
      if (!r.ok) await $.log.warn(`analysis of ${key} ended without a result: ${r.reason}`)
      await onDone(r)
    })
    .catch(async err => { await $.log.warn(`after the analysis of ${key}: ${err instanceof Error ? err.message : String(err)}`) })
  return { run }
}

/** What the agent is asked when an alert triggers. */
export function analysisPrompt(a) {
  return [
    `The alert "${a.name}" triggered for the week ${a.week}: ${a.rule}; it reads ${a.reading}.`,
    'Analyze it as the Alerts section of AGENTS.md says under "Analyze": find what drives it and whether it is one product, one country or the whole store.',
    `Then add one finding to data/findings.json with "alertId": "${a.id}" and "week": "${a.week}", keeping the findings already there.`,
    'Change nothing on PayPal. End with the title of the finding.',
  ].join(' ')
}

/** Republishes findings and alert statuses from the findings file, after an analysis ended. */
export async function refreshFindings($) {
  const state = (await $.app.state.get()) || {}
  const findings = listOf(await readJsonFile($, FINDINGS_FILE), 'findings')
  const alerts = (Array.isArray(state.alerts) ? state.alerts : []).map(a => alertWithStatus(a, findings, analyzing))
  const now = (state.sync && state.sync.at) || (await $.clock.now())
  const others = (Array.isArray(state.cases) ? state.cases : []).filter(c => c.kind !== 'alert')
  const handled = await readHandled($)
  const live = [...others, ...alertTodos(alerts, findings, now)]
  const cases = openTodos(live, handled, dateOf(now))
  await publishState($, state, {
    ...state,
    alerts,
    ...todoView(cases),
    doneCases: doneTodos(handled, live, dateOf(now)),
    findings: viewFindings(findings),
    summary: { ...(state.summary || {}), ...todoSummary(cases), findingsNote: findingsNote(findings), alertsNote: alertsNote(alerts, state.paypalAlerts) },
  })
}

/** The last TRANSACTION_DAYS of Transaction Search, every page up to TRANSACTION_PAGES, as {transaction_details}. */
export async function readTransactions(read, now) {
  // Transaction Search wants ISO 8601 date-times with seconds; a date alone is a 400.
  const args = {
    start_date: new Date(now - TRANSACTION_DAYS * 86_400_000).toISOString(),
    end_date: new Date(now).toISOString(),
    page_size: 500,
  }
  const first = await read('list_transactions', args)
  const rows = listItems(first, ['transaction_details', 'transactions', 'items'])
  const pages = Math.min(TRANSACTION_PAGES, Number((first && first.total_pages) || 1))
  for (let page = 2; page <= pages; page++) {
    const more = listItems(await read('list_transactions', { ...args, page }), ['transaction_details', 'transactions', 'items'])
    if (more.length === 0) break
    rows.push(...more)
  }
  return { transaction_details: rows }
}

/** The store's direct payments from this read, or the last good read's when this one failed. */
async function storePayments($, transactions, failed) {
  if (failed) {
    const cached = await $.store.get(PAYMENTS_KEY)
    return Array.isArray(cached) ? cached : []
  }
  const orders = paymentOrders(transactions.transaction_details)
  const cached = await $.store.get(PAYMENTS_KEY)
  if (JSON.stringify(cached) !== JSON.stringify(orders)) await $.store.set(PAYMENTS_KEY, orders)
  return orders
}

/** Publishes `next` as one patch per changed top-level key; `$.app.state.set` where there is no `publish`. */
export async function publishState($, previous, next) {
  if (typeof $.app.publish !== 'function') {
    await $.app.state.set(next)
    return
  }
  const before = previous || {}
  const patches = []
  for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
    const value = next[key]
    if (JSON.stringify(value) === JSON.stringify(before[key])) continue
    patches.push(value === undefined ? { path: `/${key}` } : { path: `/${key}`, value })
  }
  if (patches.length) await $.app.publish(patches)
}

/**
 * Reads the invoice list into the cached store orders and open invoices.
 * The list is newest-created first: a sync reads pages until one brings
 * nothing new, and every FULL_SCAN_MS reads them all and drops what is gone.
 */
export async function scanInvoices($, { now, errors, unavailable = [] }) {
  const budget = { calls: FALLBACK_CALLS }
  let skipped = 0
  const stored = await $.store.get(ORDERS_KEY)
  const cache = stored && typeof stored === 'object' ? stored : {}
  const orders = cache.orders && typeof cache.orders === 'object' ? cache.orders : {}
  const open = cache.open && typeof cache.open === 'object' ? cache.open : {}
  const full = !(now - (cache.fullAt || 0) < FULL_SCAN_MS)
  const cutoff = addDays(dateOf(now), -KEEP_DAYS)
  const seen = new Set()
  let changed = false
  let complete = false
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = await readInvoiceRows($, (page - 1) * PAGE_SIZE, PAGE_SIZE, budget)
    if (rows.error) {
      if (isToolMissing(rows.error)) unavailable.push('list_invoices')
      else errors.list_invoices = rows.error
      break
    }
    skipped += rows.skipped
    const items = rows.items
    let pageChanged = false
    for (const row of items) {
      const id = invoiceRowFields(row).id
      if (!id) continue
      seen.add(id)
      const store = readStoreRow(row)
      if (store) {
        if (open[id]) { delete open[id]; pageChanged = true }
        if (!store.order || store.order.date < cutoff) {
          if (orders[id]) { delete orders[id]; pageChanged = true }
        } else if (JSON.stringify(orders[id]) !== JSON.stringify(store.order)) {
          orders[id] = store.order
          pageChanged = true
        }
        continue
      }
      const [invoice] = normalizeInvoices([row], now)
      if (invoice.outstanding) {
        if (JSON.stringify(open[id]) !== JSON.stringify(row)) { open[id] = row; pageChanged = true }
      } else if (open[id]) {
        delete open[id]
        pageChanged = true
      }
    }
    changed = changed || pageChanged
    if (rows.end) { complete = true; break }
    if (!full && !pageChanged) break
  }
  // A row PayPal would not send is unseen, not gone: drop unseen rows only after a read that skipped none.
  const exact = full && complete && skipped === 0
  for (const [id, order] of Object.entries(orders)) {
    if (order.date < cutoff || (exact && !seen.has(id))) { delete orders[id]; changed = true }
  }
  if (exact) {
    for (const id of Object.keys(open)) if (!seen.has(id)) { delete open[id]; changed = true }
  }
  const fullAt = full && complete ? now : cache.fullAt || 0
  const unread = full && complete ? skipped : Math.max(skipped, cache.unread || 0)
  if (changed || fullAt !== cache.fullAt || unread !== (cache.unread || 0)) {
    await $.store.set(ORDERS_KEY, { orders, open, fullAt, unread })
  }
  return { orders: Object.values(orders), openInvoices: normalizeInvoices(Object.values(open), now), unread }
}

/**
 * Rows [start, start + size) of the invoice list: {items, skipped, end} or
 * {error}. PayPal's server refuses a whole page when one invoice fails its own
 * output schema (a refunded invoice's status is not in it), so a refused page
 * is read again in the next smaller PAGE_LADDER size, and only the smallest
 * pages still refused are skipped. `budget.calls` bounds the extra calls.
 */
export async function readInvoiceRows($, start, size, budget) {
  const read = await callTool($, 'list_invoices', { page: start / size + 1, page_size: size })
  if (!read.error) {
    const items = listItems(read.value, ['items', 'invoices'])
    return { items, skipped: 0, end: items.length < size }
  }
  if (!isRejectedOutput(read.error)) return { error: read.error }
  const smaller = PAGE_LADDER.find(s => s < size && size % s === 0 && (start + size) / s <= MAX_PAGE_NUMBER)
  if (!smaller) return { items: [], skipped: size, end: false }
  const items = []
  let skipped = 0
  for (let at = start; at < start + size; at += smaller) {
    if (budget.calls <= 0) return { items, skipped: skipped + (start + size - at), end: false }
    budget.calls -= 1
    const part = await readInvoiceRows($, at, smaller, budget)
    if (part.error) return part
    items.push(...part.items)
    skipped += part.skipped
    if (part.end) return { items, skipped, end: true }
  }
  return { items, skipped, end: false }
}

/** The server's refusal of its own answer: it failed the tool's output schema there. */
export function isRejectedOutput(message) {
  return /output validation error|invalid structured content/i.test(message)
}

// ---- reading -------------------------------------------------------------

/** Calls a list tool and returns its JSON, or `[]` after recording the error.
 *  A tool the server does not offer is listed in `unavailable`, not `errors`:
 *  the dashboard says so once instead of failing every sync. */
async function readList($, tool, args, errors, unavailable = []) {
  const read = await callTool($, tool, args)
  if (!read.error) return read.value
  if (isToolMissing(read.error)) unavailable.push(tool)
  else errors[tool] = read.error
  return []
}

/** One tool call as {value} or {error}: a thrown error and an isError result read alike. */
async function callTool($, tool, args) {
  try {
    const result = await $.mcp.call(SERVER, tool, args)
    const value = resultJson(result)
    if (result && result.isError) return { error: typeof value === 'string' ? value : JSON.stringify(value) }
    return { value }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** The MCP "unknown tool" refusal (-32602 with "not found"). */
export function isToolMissing(message) {
  return /tool\b.*\bnot found|unknown tool/i.test(message)
}

/** The result's structured content, else its first text block parsed as JSON, else the text. */
export function resultJson(result) {
  if (!result) return null
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = (result.content || [])
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** New files in the inbox folder are copied under the app's `inbox/`; returns every file known. */
async function pullInbox($, inbox) {
  let entries
  try {
    entries = await $.fs.list(inbox)
  } catch (err) {
    await $.log.warn(`inbox unreadable: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
  const seen = (await $.store.get(SEEN_KEY)) || {}
  const files = []
  for (const entry of entries || []) {
    const name = typeof entry === 'string' ? entry : entry && (entry.name || entry.path)
    if (!name) continue
    const base = String(name).split(/[\\/]/).pop()
    if (!INBOX_EXTENSIONS.some(ext => base.toLowerCase().endsWith(ext))) continue
    const source = `${inbox}/${base}`
    if (!seen[base]) {
      try {
        const text = await $.fs.read(source, { as: 'text' })
        await $.fs.write(`inbox/${base}`, text)
        seen[base] = Date.now()
      } catch (err) {
        await $.log.warn(`inbox file ${base} skipped: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
    }
    files.push({ name: base, since: seen[base] })
  }
  await $.store.set(SEEN_KEY, seen)
  return files
}

/** The to-dos marked done, from the app folder's `data/handled.json`. */
async function readHandled($) {
  return normalizeHandled(await readJsonFile($, HANDLED_FILE))
}

/**
 * Handled entries as {id, at, state?, todo?}: `{id, at: 'YYYY-MM-DD'}` is
 * done for DONE_DAYS from `at`, `state: 'deleted'` is off the board for as
 * long; a bare id string is done for good (at ''). `todo` is the to-do as
 * it was, kept to show it on the done list and to undo.
 */
export function normalizeHandled(list) {
  return (Array.isArray(list) ? list : []).flatMap(h => typeof h === 'string' ? [{ id: h, at: '' }]
    : h && typeof h.id === 'string' ? [{
      id: h.id,
      at: typeof h.at === 'string' ? h.at.slice(0, 10) : '',
      ...(h.state === 'deleted' ? { state: 'deleted' } : {}),
      ...(h.todo && typeof h.todo === 'object' && typeof h.todo.title === 'string' ? { todo: h.todo } : {}),
    }] : [])
}

/**
 * The done list: to-dos marked done less than DONE_DAYS ago, latest first,
 * each as its live version when there is one, else as it was when marked.
 * One with neither (an id the agent wrote for a case now gone) is left out.
 */
export function doneTodos(handled, live, today) {
  const byId = new Map((live || []).map(c => [c.id, c]))
  return normalizeHandled(handled)
    .filter(h => h.state !== 'deleted' && h.at && today < addDays(h.at, DONE_DAYS))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .flatMap(h => {
      const todo = byId.get(h.id) || h.todo
      if (!todo) return []
      return [{ id: h.id, title: todo.title, detail: todo.detail || '', kind: todo.kind || '', doneLabel: `✓ Done ${shortDate(h.at)}` }]
    })
}

/** Whether a to-do is hidden on `today`: done for good, or done less than DONE_DAYS ago. */
export function isDone(handled, id, today) {
  return normalizeHandled(handled).some(h => h.id === id && (!h.at || today < addDays(h.at, DONE_DAYS)))
}

// ---- deriving (pure) -------------------------------------------------------

/** The dashboard state from the reads. Pure: no `$`, so tests can drive it. */
export function deriveState({ previous = {}, raw = {}, orders = [], alertRules = [], findings = [], running = null, openInvoices = [], unread = 0, inboxFiles = [], handled = [], errors = {}, unavailable = [], now }) {
  const disputes = normalizeDisputes(raw.disputes)
  const transactions = normalizeTransactions(raw.transactions)
  const today = dateOf(now)
  const { refundShare: _refundShare, ...board } = salesBoard(orders, { today })
  const alerts = viewAlerts(checkRules(alertRules, orders, today), findings, running)
  const paypalAlerts = disputeAlerts(disputes, now)
  const found = deriveCases({ invoices: openInvoices, disputes, transactions, inboxFiles, now })
  const live = [...found, ...alertTodos(alerts, findings, now)]
  const cases = openTodos(live, handled, today)
  const errorNames = Object.keys(errors)
  const noteParts = [`Synced ${timeOfDay(now)}`]
  if (errorNames.length) noteParts.push(`${errorNames.length} read(s) failed: ${errorNames.join(', ')}`)
  if (unavailable.length) noteParts.push(`not offered by this server: ${unavailable.join(', ')}`)
  if (unread) noteParts.push(`${unread} invoice(s) PayPal's server would not send`)
  return {
    ...board,
    ...todoView(cases),
    doneCases: doneTodos(handled, live, today),
    alerts,
    paypalAlerts,
    findings: viewFindings(findings),
    summary: {
      alertsNote: alertsNote(alerts, paypalAlerts),
      findingsNote: findingsNote(findings),
      ...todoSummary(cases),
    },
    sync: {
      at: now,
      ok: errorNames.length === 0,
      errors: errorNames.length ? errors : undefined,
      unavailable: unavailable.length ? unavailable : undefined,
      unread: unread || undefined,
      note: noteParts.join(' · '),
    },
    handled: previous.handled,
  }
}

/** The to-dos not marked done on `today`, each with the question Ask AI drafts, most urgent first. */
export function openTodos(cases, handled, today) {
  return cases
    .filter(c => !isDone(handled, c.id, today))
    .map(c => ({ ...c, ask: c.ask || `Work this case (${c.id}): ${c.title}. ${c.detail}` }))
    .sort((a, b) => toneRank(b.tone) - toneRank(a.tone) || kindRank(b.kind) - kindRank(a.kind) || a.since - b.since)
    .slice(0, CASE_CAP)
}

/** The to-do list and its first few. */
function todoView(cases) {
  return { cases, needs: cases.slice(0, NEEDS_SHOWN) }
}

/** The Actions tab's count badge and subtitle; `openTab` is the tab the board opens on (Actions while any to-do is open). */
function todoSummary(cases) {
  const n = cases.length
  return {
    casesNote: n === 0 ? 'Nothing needs you right now' : `${n} open, most urgent first`,
    todoCount: n,
    openTab: n === 0 ? 0 : TODO_TAB,
  }
}

/** A to-do for each tripped alert, its analysis in the detail; the id is the alert's, so done hides it for DONE_DAYS. */
export function alertTodos(alerts, findings, now) {
  return alerts.filter(a => a.tripped).map(a => {
    const finding = latestFinding(findings, a)
    const analysis = finding ? `AI: ${[finding.title, finding.conclusion].filter(Boolean).join('. ')}`
      : a.analysis === 'analyzing' ? 'The AI is analyzing it now.' : 'The AI analysis is pending.'
    return {
      id: `alert:${a.id}`,
      kind: 'alert',
      title: `${a.name} triggered`,
      detail: `${sentenceCase(a.reading)}. ${analysis}`,
      tone: 'warning',
      label: 'Alert',
      since: now,
      ref: a.id,
      ask: a.ask,
    }
  })
}

/** A file's list under `key`, or none. */
function listOf(doc, key) {
  return doc && Array.isArray(doc[key]) ? doc[key].filter(item => item && typeof item === 'object') : []
}

/** The newest finding written for an alert's week, if any. */
function latestFinding(findings, a) {
  return [...findings].filter(f => f.alertId === a.id && f.week === a.week)
    .sort((x, y) => (String(x.at || '') < String(y.at || '') ? 1 : -1))[0] || null
}

const sentenceCase = text => (text ? text[0].toUpperCase() + text.slice(1) : '')

/** Checked rules as alert cards; a tripped one says whether this week's analysis is in, running or pending. */
export function viewAlerts(checked, findings, running = null) {
  return checked.map(a => alertWithStatus({
    id: a.id,
    name: a.name,
    rule: a.rule,
    subject: a.subject,
    value: a.value,
    delta: a.delta,
    trend: a.trend,
    better: a.better,
    reading: a.reading,
    week: a.week || '',
    summary: a.rule,
    tripped: a.tripped,
    understood: a.understood,
    ask: a.understood
      ? `The alert "${a.name}" (${a.rule}) reads ${a.reading}. What's behind it, and what should I do?`
      : `Rewrite the alert "${a.name}" in data/alerts.json so this desk can check it.`,
    editAsk: `Change the alert "${a.name}" (id: ${a.id}, now ${a.rule}): `,
    deleteAsk: `Delete the alert "${a.name}" (id: ${a.id}).`,
  }, findings, running))
}

/**
 * An alert card with `analyzed`, `analysis` (`analyzed`, `analyzing`,
 * `pending` or ''), `status`, `tone` and `note` worked out from the findings
 * and the running analysis.
 */
export function alertWithStatus(row, findings, running) {
  const finding = row.tripped ? latestFinding(findings, row) : null
  const busy = Boolean(row.tripped && !finding && running && running.id === row.id && running.week === row.week)
  const analysis = !row.tripped ? '' : finding ? 'analyzed' : busy ? 'analyzing' : 'pending'
  const status = !row.understood ? "Can't check" : row.tripped ? 'Triggered' : 'OK'
  const note = !row.understood ? 'Ask the AI to restate it as a rule this desk can check'
    : finding ? `AI: ${[finding.title, finding.conclusion].filter(Boolean).join('. ')}`
      : analysis === 'analyzing' ? 'The AI is analyzing it…'
        : analysis === 'pending' ? 'Waiting for the AI to analyze it'
          : ''
  return { ...row, analyzed: Boolean(finding), analysis, status, tone: !row.understood ? 'neutral' : row.tripped ? 'warning' : 'success', note }
}

/** The Alerts heading's subtitle: how many of the rules and PayPal's disputes need a look. */
function alertsNote(alerts, paypalAlerts = []) {
  const all = [...(alerts || []), ...(paypalAlerts || [])]
  if (all.length === 0) return 'None yet. Add one with AI, e.g. "any product\'s refund rate above 10%"'
  const live = all.filter(a => a.tripped).length
  return live === 0 ? `All ${all.length} quiet` : `${live} of ${all.length} need a look`
}

function findingsNote(findings) {
  return findings.length === 0 ? 'Conclusions from analyses show up here' : 'Newest first'
}

/** The newest findings as board rows. */
export function viewFindings(findings) {
  return [...findings]
    .filter(f => f.id && f.title)
    .sort((a, b) => (String(a.at || '') < String(b.at || '') ? 1 : -1))
    .slice(0, FINDINGS_SHOWN)
    .map(f => ({
      id: String(f.id),
      title: String(f.title),
      when: String(f.at || '').slice(0, 16).replace('T', ' '),
      source: f.alertId ? 'Automatic analysis' : 'Asked in chat',
      conclusion: String(f.conclusion || ''),
      action: f.action ? `Suggested: ${f.action}` : '',
    }))
}

function emptyState(previous) {
  return {
    week: previous.week,
    trends: previous.trends,
    salesNote: previous.salesNote,
    summary: previous.summary || {},
    cases: previous.cases || [],
    alerts: previous.alerts || [],
    paypalAlerts: previous.paypalAlerts || [],
  }
}

/** Invoice-list rows, flat (MCP) or nested (REST), as the fields the cases use. */
export function normalizeInvoices(value, now) {
  const items = listItems(value, ['items', 'invoices'])
  return items.map(inv => {
    const fields = invoiceRowFields(inv)
    const detail = inv.detail || {}
    const term = detail.payment_term || {}
    const recipient = (inv.primary_recipients || [])[0]
    const billing = (recipient && recipient.billing_info) || {}
    const name = billing.name ? [billing.name.given_name, billing.name.surname].filter(Boolean).join(' ') : ''
    const due = term.due_date || detail.due_date || inv.due_date || ''
    const status = String(inv.status || '').toUpperCase()
    const outstanding = status === 'SENT' || status === 'UNPAID' || status === 'PARTIALLY_PAID' || status === 'PAYMENT_PENDING'
    const overdueDays = outstanding && due ? Math.floor((now - Date.parse(due)) / 86_400_000) : 0
    return {
      id: fields.id,
      number: fields.number || fields.id,
      recipient: name || billing.email_address || '',
      amount: money({ value: fields.value, currency_code: fields.currency }),
      value: fields.value,
      currency: fields.currency,
      status,
      due,
      outstanding,
      overdueDays: overdueDays > 0 ? overdueDays : 0,
    }
  })
}

export function normalizeDisputes(value) {
  const items = listItems(value, ['items', 'disputes'])
  return items.map(d => {
    const status = String(d.status || '').toUpperCase()
    const open = status !== 'RESOLVED' && status !== 'CLOSED' && status !== 'CANCELLED'
    return {
      id: d.dispute_id || d.id || '',
      reason: String(d.reason || '').replace(/_/g, ' ').toLowerCase(),
      stage: String(d.dispute_life_cycle_stage || '').toLowerCase(),
      amount: money(d.dispute_amount || {}),
      value: Number((d.dispute_amount && d.dispute_amount.value) || 0),
      status,
      open,
      created: d.create_time || '',
      respondBy: d.seller_response_due_date || '',
      transactionId: ((d.disputed_transactions || [])[0] || {}).seller_transaction_id || '',
    }
  })
}

export function normalizeTransactions(value) {
  const items = listItems(value, ['transaction_details', 'transactions', 'items'])
  return items.map(t => {
    const info = t.transaction_info || t
    const amount = info.transaction_amount || info.amount || {}
    const payer = t.payer_info || {}
    const code = String(info.transaction_event_code || '')
    return {
      id: info.transaction_id || t.id || '',
      at: info.transaction_initiation_date || info.transaction_updated_date || t.create_time || '',
      value: Number(amount.value || 0),
      currency: amount.currency_code || '',
      status: String(info.transaction_status || '').toUpperCase(),
      refund: code.startsWith('T11') || Number(amount.value || 0) < 0 && /refund/i.test(info.transaction_subject || ''),
      payer: payer.email_address || (payer.payer_name && payer.payer_name.alternate_full_name) || '',
    }
  })
}

/** The cases: what needs a person's decision, each with a stable id the agent can mark handled. */
export function deriveCases({ invoices, disputes, transactions, inboxFiles, now }) {
  const cases = []
  for (const d of disputes) {
    if (!d.open) continue
    const daysLeft = d.respondBy ? Math.ceil((Date.parse(d.respondBy) - now) / 86_400_000) : null
    cases.push({
      id: `dispute:${d.id}`,
      kind: 'dispute',
      title: `Dispute ${d.id}: ${d.reason || d.stage || 'open'}`,
      detail: `${d.amount} in dispute${d.transactionId ? ` on transaction ${d.transactionId}` : ''}. ` +
        (daysLeft === null ? 'No response deadline given.' : daysLeft <= 0 ? 'Response overdue.' : `Respond within ${daysLeft} day(s).`),
      tone: daysLeft !== null && daysLeft <= 3 ? 'danger' : 'warning',
      label: daysLeft !== null && daysLeft <= 3 ? 'Urgent' : 'Dispute',
      since: Date.parse(d.created) || now,
      ref: d.id,
    })
  }
  for (const inv of invoices) {
    if (inv.overdueDays <= 0) continue
    cases.push({
      id: `invoice:${inv.id}`,
      kind: 'overdue_invoice',
      title: `Invoice ${inv.number} is ${inv.overdueDays} day(s) overdue`,
      detail: `${inv.amount}${inv.recipient ? ` from ${inv.recipient}` : ''}, due ${inv.due.slice(0, 10)}. A reminder or a cancellation needs your decision.`,
      tone: inv.overdueDays > 14 ? 'danger' : 'warning',
      label: inv.overdueDays > 14 ? 'Long overdue' : 'Overdue',
      since: Date.parse(inv.due) || now,
      ref: inv.id,
    })
  }
  const dupes = duplicatePayments(transactions)
  for (const pair of dupes) {
    cases.push({
      id: `duplicate:${pair[0].id}:${pair[1].id}`,
      kind: 'duplicate_payment',
      title: `Two payments of ${money({ value: pair[0].value, currency_code: pair[0].currency })} from ${pair[0].payer || 'one payer'}`,
      detail: `Transactions ${pair[0].id} and ${pair[1].id} were made within 10 minutes. One may need a refund.`,
      tone: 'warning',
      label: 'Check',
      since: Date.parse(pair[1].at) || now,
      ref: pair[1].id,
    })
  }
  for (const file of inboxFiles) {
    cases.push({
      id: `file:${file.name}`,
      kind: 'invoice_request',
      title: `New request in the inbox: ${file.name}`,
      detail: `Copied to inbox/${file.name} in the app's folder. Read it and draft the PayPal invoice it asks for.`,
      tone: 'info',
      label: 'Inbox',
      since: file.since || now,
      ref: file.name,
    })
  }
  return cases
}

/** Pairs of completed payments from one payer, same amount, within ten minutes. */
export function duplicatePayments(transactions) {
  const sales = transactions
    .filter(t => !t.refund && t.value > 0 && t.payer)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const pairs = []
  for (let i = 1; i < sales.length; i++) {
    const a = sales[i - 1]
    const b = sales[i]
    if (a.payer === b.payer && a.value === b.value && Math.abs(Date.parse(b.at) - Date.parse(a.at)) <= 10 * 60_000) {
      pairs.push([a, b])
    }
  }
  return pairs
}

// ---- views and helpers -----------------------------------------------------

function listItems(value, keys) {
  if (Array.isArray(value)) return value.filter(isObject)
  if (!isObject(value)) return []
  for (const key of keys) if (Array.isArray(value[key])) return value[key].filter(isObject)
  return []
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function money(amount) {
  const value = Number(amount.value || 0)
  const currency = amount.currency_code || ''
  const text = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return currency ? `${currency === 'USD' ? '$' : currency + ' '}${text}` : text
}

function toneRank(tone) {
  return tone === 'danger' ? 3 : tone === 'warning' ? 2 : tone === 'info' ? 1 : 0
}

/** Within one tone, a deadline beats money owed, money owed beats a trend or a file. */
function kindRank(kind) {
  switch (kind) {
    case 'dispute': return 5
    case 'duplicate_payment': return 4
    case 'overdue_invoice': return 3
    case 'alert': return 2
    default: return 1
  }
}

function timeOfDay(ms) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
