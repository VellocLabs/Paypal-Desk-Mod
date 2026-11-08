/**
 * The PayPal Desk background module. One resident worker per Velloc: on a
 * timer it reads the merchant's invoices, disputes, plans and recent
 * transactions through the plugin's PayPal MCP server, derives the dashboard
 * state and the open cases, and copies invoice requests dropped into the
 * declared inbox folder into the app's folder for the session agent.
 *
 * Contract: the module only reads PayPal. Every write (a refund, a reminder,
 * an accepted claim) is the session agent's, and the session hook puts it
 * to the person first. State is the app's `/data`: it is kept small, since
 * the whole of it travels with every dashboard action.
 */

export const POLL_MS = 5 * 60_000
export const SERVER = 'paypal'
export const ROW_CAP = 50
export const CASE_CAP = 30
export const SERIES_DAYS = 30
const INBOX_EXTENSIONS = ['.csv', '.json', '.txt', '.md']
const HANDLED_FILE = 'data/handled.json'
const SEEN_KEY = 'inbox.seen'

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
    await tick()
    timer = $.clock.every(POLL_MS, tick)
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
    await $.app.state.set({
      ...emptyState(previous),
      sync: { at: now, ok: false, error: message, note: `Not connected to PayPal: ${message}` },
    })
    return
  }

  const errors = {}
  const unavailable = []
  const read = (tool, args) => readList($, tool, args, errors, unavailable)
  const raw = {
    invoices: await read('list_invoices', { page: 1, page_size: ROW_CAP, total_required: true }),
    disputes: await read('list_disputes', { page_size: ROW_CAP }),
    plans: await read('list_subscription_plans', { page: 1, page_size: ROW_CAP }),
    transactions: await read('list_transactions', {
      start_date: isoDate(now - SERIES_DAYS * 86_400_000),
      end_date: isoDate(now),
      fields: 'all',
      page_size: 500,
    }),
  }
  const inboxFiles = inbox ? await pullInbox($, inbox) : []
  const handled = await readHandled($)

  const next = deriveState({ previous, raw, inboxFiles, handled, errors, unavailable, now })
  await $.app.state.set(next)
}

// ---- reading -------------------------------------------------------------

/** Calls a list tool and returns its JSON, or `[]` after recording the error.
 *  A tool the server does not offer is listed in `unavailable`, not `errors`:
 *  the dashboard says so once instead of failing every sync. */
async function readList($, tool, args, errors, unavailable = []) {
  try {
    const result = await $.mcp.call(SERVER, tool, args)
    const value = resultJson(result)
    if (result && result.isError) {
      const message = typeof value === 'string' ? value : JSON.stringify(value)
      if (isToolMissing(message)) unavailable.push(tool)
      else errors[tool] = message
      return []
    }
    return value
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (isToolMissing(message)) unavailable.push(tool)
    else errors[tool] = message
    return []
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

/** The dashboard state from the raw reads. Pure: no `$`, so tests can drive it. */
export function deriveState({ previous = {}, raw = {}, inboxFiles = [], handled = [], errors = {}, unavailable = [], now }) {
  const invoices = normalizeInvoices(raw.invoices, now)
  const disputes = normalizeDisputes(raw.disputes)
  const plans = normalizePlans(raw.plans)
  const transactions = normalizeTransactions(raw.transactions)
  const series = dailySeries(transactions, now)
  const summary = summarize({ invoices, disputes, transactions, series, now })
  const cases = deriveCases({ invoices, disputes, transactions, series, inboxFiles, now })
    .filter(c => !handled.includes(c.id))
    .sort((a, b) => toneRank(b.tone) - toneRank(a.tone) || kindRank(b.kind) - kindRank(a.kind) || a.since - b.since)
    .slice(0, CASE_CAP)
  const errorNames = Object.keys(errors)
  const plansOffered = !unavailable.includes('list_subscription_plans')
  const noteParts = [`Synced ${timeOfDay(now)}`]
  if (errorNames.length) noteParts.push(`${errorNames.length} read(s) failed: ${errorNames.join(', ')}`)
  if (unavailable.length) noteParts.push(`not offered by this server: ${unavailable.join(', ')}`)
  return {
    summary: {
      ...summary,
      casesNote: cases.length === 0 ? 'Nothing needs a decision right now' : `${cases.length} open, most urgent first`,
      invoicesNote: `${invoices.length} most recent`,
      disputesNote: disputes.length === 0 ? 'No disputes' : `${disputes.filter(d => d.open).length} open of ${disputes.length}`,
      plansNote: plansOffered ? `${plans.length} plans` : 'Not offered by this PayPal connection',
    },
    series: { daily: series },
    cases,
    invoices: invoices.slice(0, ROW_CAP).map(viewInvoice),
    disputes: disputes.slice(0, ROW_CAP).map(viewDispute),
    plans: plans.slice(0, ROW_CAP),
    sync: {
      at: now,
      ok: errorNames.length === 0,
      errors: errorNames.length ? errors : undefined,
      unavailable: unavailable.length ? unavailable : undefined,
      note: noteParts.join(' · '),
    },
    handled: previous.handled,
  }
}

function emptyState(previous) {
  return {
    summary: previous.summary || {},
    series: previous.series || { daily: [] },
    cases: previous.cases || [],
    invoices: previous.invoices || [],
    disputes: previous.disputes || [],
    plans: previous.plans || [],
  }
}

export function normalizeInvoices(value, now) {
  const items = listItems(value, ['items', 'invoices'])
  return items.map(inv => {
    const detail = inv.detail || {}
    const term = detail.payment_term || {}
    const recipient = (inv.primary_recipients || [])[0]
    const billing = (recipient && recipient.billing_info) || {}
    const name = billing.name ? [billing.name.given_name, billing.name.surname].filter(Boolean).join(' ') : ''
    const due = term.due_date || detail.due_date || ''
    const status = String(inv.status || '').toUpperCase()
    const outstanding = status === 'SENT' || status === 'UNPAID' || status === 'PARTIALLY_PAID' || status === 'PAYMENT_PENDING'
    const overdueDays = outstanding && due ? Math.floor((now - Date.parse(due)) / 86_400_000) : 0
    return {
      id: inv.id || '',
      number: detail.invoice_number || inv.id || '',
      recipient: name || billing.email_address || '',
      amount: money(inv.amount || (inv.due_amount) || {}),
      value: Number((inv.amount && inv.amount.value) || 0),
      currency: (inv.amount && inv.amount.currency_code) || detail.currency_code || '',
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

export function normalizePlans(value) {
  const items = listItems(value, ['plans', 'items'])
  return items.map(p => ({
    id: p.id || '',
    name: p.name || '',
    status: String(p.status || '').toUpperCase(),
    product: p.product_id || '',
    created: (p.create_time || '').slice(0, 10),
  }))
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

/** One row per day over the window: completed sales and refunds, in account currency units. */
export function dailySeries(transactions, now) {
  const days = []
  const byDay = new Map()
  for (let i = SERIES_DAYS - 1; i >= 0; i--) {
    const day = isoDate(now - i * 86_400_000).slice(5)
    const row = { day, sales: 0, refunds: 0 }
    days.push(row)
    byDay.set(day, row)
  }
  for (const t of transactions) {
    const day = String(t.at || '').slice(5, 10)
    const row = byDay.get(day)
    if (!row) continue
    if (t.refund || t.value < 0) row.refunds = round2(row.refunds + Math.abs(t.value))
    else if (t.status === 'S' || t.status === 'COMPLETED' || t.status === '') row.sales = round2(row.sales + t.value)
  }
  return days
}

export function summarize({ invoices, disputes, transactions, series, now }) {
  const sales = series.reduce((sum, r) => sum + r.sales, 0)
  const refunds = series.reduce((sum, r) => sum + r.refunds, 0)
  const half = Math.floor(series.length / 2)
  const recent = series.slice(half).reduce((s, r) => s + r.sales, 0)
  const earlier = series.slice(0, half).reduce((s, r) => s + r.sales, 0)
  const delta = earlier > 0 ? Math.round(((recent - earlier) / earlier) * 100) : 0
  const overdue = invoices.filter(i => i.overdueDays > 0)
  const openDisputes = disputes.filter(d => d.open)
  const soonest = openDisputes.map(d => d.respondBy).filter(Boolean).sort()[0]
  const currency = (transactions[0] && transactions[0].currency) || (invoices[0] && invoices[0].currency) || 'USD'
  return {
    period: `Last ${SERIES_DAYS} days · ${isoDate(now)}`,
    sales: money({ value: sales, currency_code: currency }),
    salesDelta: earlier > 0 ? `${delta >= 0 ? '+' : ''}${delta}%` : '',
    salesTrend: delta > 2 ? 'up' : delta < -2 ? 'down' : 'flat',
    refunds: money({ value: refunds, currency_code: currency }),
    refundRate: sales > 0 ? `${Math.round((refunds / sales) * 100)}% of sales` : 'No sales in the window',
    overdueCount: String(overdue.length),
    overdueAmount: overdue.length ? money({ value: overdue.reduce((s, i) => s + i.value, 0), currency_code: currency }) + ' outstanding' : 'All invoices on time',
    disputeCount: String(openDisputes.length),
    disputeDue: soonest ? `Next response due ${soonest.slice(0, 10)}` : 'No response pending',
  }
}

/** The cases: what needs a person's decision, each with a stable id the agent can mark handled. */
export function deriveCases({ invoices, disputes, transactions, series, inboxFiles, now }) {
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
      detail: `${inv.amount} from ${inv.recipient || 'the recipient'}, due ${inv.due.slice(0, 10)}. A reminder or a cancellation needs your decision.`,
      tone: inv.overdueDays > 14 ? 'danger' : 'warning',
      label: inv.overdueDays > 14 ? 'Long overdue' : 'Overdue',
      since: Date.parse(inv.due) || now,
      ref: inv.id,
    })
  }
  const week = series.slice(-7)
  const weekSales = week.reduce((s, r) => s + r.sales, 0)
  const weekRefunds = week.reduce((s, r) => s + r.refunds, 0)
  if (weekSales > 0 && weekRefunds / weekSales > 0.2) {
    cases.push({
      id: `refunds:${isoDate(now).slice(0, 7)}`,
      kind: 'refund_spike',
      title: 'Refunds are high this week',
      detail: `${Math.round((weekRefunds / weekSales) * 100)}% of the last 7 days' sales were refunded. Worth finding the product or customer behind it.`,
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

function viewInvoice(inv) {
  return {
    number: inv.number,
    recipient: inv.recipient,
    amount: inv.amount,
    status: inv.overdueDays > 0 ? 'OVERDUE' : inv.status,
    due: inv.due.slice(0, 10),
  }
}

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

function round2(n) {
  return Math.round(n * 100) / 100
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

function timeOfDay(ms) {
  return new Date(ms).toISOString().slice(11, 16) + ' UTC'
}
