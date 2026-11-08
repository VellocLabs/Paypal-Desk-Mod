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
import { addDays, dateOf } from './lib/dates.js'
import { invoiceRowFields, readStoreRow, salesBoard } from './lib/sales.js'

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
const INBOX_EXTENSIONS = ['.csv', '.json', '.txt', '.md']
const HANDLED_FILE = 'data/handled.json'
const SEEN_KEY = 'inbox.seen'
export const ORDERS_KEY = 'orders.cache'

let pending = Promise.resolve()

/** Resolves when the sync in flight, if any, has finished. For tests. */
export function whenIdle() {
  return pending
}

export function register(on) {
  let timer = null
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
  })

  on('app.stop', async () => {
    if (timer) timer.cancel()
    timer = null
  })
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
    // Transaction Search wants ISO 8601 date-times with seconds; a date alone is a 400.
    transactions: await read('list_transactions', {
      start_date: new Date(now - TRANSACTION_DAYS * 86_400_000).toISOString(),
      end_date: new Date(now).toISOString(),
      page_size: 500,
    }),
  }
  const inboxFiles = inbox ? await pullInbox($, inbox) : []
  const handled = await readHandled($)

  const next = deriveState({ previous, raw, orders: scan.orders, openInvoices: scan.openInvoices, unread: scan.unread, inboxFiles, handled, errors, unavailable, now })
  await publishState($, previous, next)
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

/** The case ids the session agent marked handled, from the app folder's `data/handled.json`. */
async function readHandled($) {
  try {
    if (!(await $.fs.exists(HANDLED_FILE))) return []
    const parsed = JSON.parse(await $.fs.read(HANDLED_FILE, { as: 'text' }))
    return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : []
  } catch {
    return []
  }
}

// ---- deriving (pure) -------------------------------------------------------

/** The dashboard state from the reads. Pure: no `$`, so tests can drive it. */
export function deriveState({ previous = {}, raw = {}, orders = [], openInvoices = [], unread = 0, inboxFiles = [], handled = [], errors = {}, unavailable = [], now }) {
  const disputes = normalizeDisputes(raw.disputes)
  const transactions = normalizeTransactions(raw.transactions)
  const { refundShare, ...board } = salesBoard(orders, { today: dateOf(now) })
  const cases = deriveCases({ invoices: openInvoices, disputes, transactions, refundShare, inboxFiles, now })
    .filter(c => !handled.includes(c.id))
    .sort((a, b) => toneRank(b.tone) - toneRank(a.tone) || kindRank(b.kind) - kindRank(a.kind) || a.since - b.since)
    .slice(0, CASE_CAP)
  const errorNames = Object.keys(errors)
  const noteParts = [`Synced ${timeOfDay(now)}`]
  if (errorNames.length) noteParts.push(`${errorNames.length} read(s) failed: ${errorNames.join(', ')}`)
  if (unavailable.length) noteParts.push(`not offered by this server: ${unavailable.join(', ')}`)
  if (unread) noteParts.push(`${unread} invoice(s) PayPal's server would not send`)
  return {
    ...board,
    summary: {
      casesNote: cases.length === 0 ? 'Nothing needs a decision right now' : `${cases.length} open, most urgent first`,
      disputesNote: disputes.length === 0 ? 'No disputes' : `${disputes.filter(d => d.open).length} open of ${disputes.length}`,
    },
    cases,
    disputes: disputes.slice(0, ROW_CAP).map(viewDispute),
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

function emptyState(previous) {
  return {
    week: previous.week,
    month: previous.month,
    salesNote: previous.salesNote,
    summary: previous.summary || {},
    cases: previous.cases || [],
    disputes: previous.disputes || [],
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
export function deriveCases({ invoices, disputes, transactions, refundShare = 0, inboxFiles, now }) {
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
  if (refundShare > 0.2) {
    cases.push({
      id: `refunds:${dateOf(now).slice(0, 7)}`,
      kind: 'refund_spike',
      title: 'Refunds are high this week',
      detail: `${Math.round(refundShare * 100)}% of the last 7 days' sales were refunded. Worth finding the product or customer behind it.`,
      tone: 'warning',
      label: 'Trend',
      since: now,
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

function viewDispute(d) {
  return {
    id: d.id,
    reason: d.reason,
    amount: d.amount,
    status: d.status,
    respondBy: d.respondBy.slice(0, 10),
  }
}

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
    case 'refund_spike': return 2
    default: return 1
  }
}

function timeOfDay(ms) {
  return new Date(ms).toISOString().slice(11, 16) + ' UTC'
}
