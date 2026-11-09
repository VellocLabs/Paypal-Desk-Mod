/**
 * The manifest a client installs by, the two modules it loads, the write
 * guard's decisions, the state the background module derives from PayPal's
 * reads, and how it pages, caches and publishes them.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { describeCall, isWriteTool, register as registerGuard } from '../hooks/guard.js'
import {
  DONE_DAYS, FULL_SCAN_MS, RULES_WATCH_MS, KEEP_DAYS, isDone, MAX_PAGE_NUMBER, ALERTS_FILE, ANALYSES_KEY, ANALYSIS_RETRY_MS, FINDINGS_FILE, alertWithStatus, refreshFindings, startAnalysis, ORDERS_KEY, PAGE_SIZE, PAYMENTS_KEY, handleAction, deriveState, duplicatePayments, isRejectedOutput, isToolMissing,
  normalizeInvoices, publishState, readInvoiceRows, resultJson, syncOnce, whenIdle, register as registerBackground,
} from '../app-bg.js'
import { storeOrder, storeRow, transactionRow } from './fixtures.mjs'
import { DEFAULT_RULES } from '../lib/alerts.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = path => JSON.parse(readFileSync(join(root, path), 'utf8'))
const NOW = Date.parse('2026-11-10T12:00:00Z')
const day = offset => new Date(NOW + offset * 86_400_000).toISOString()

test('the manifest declares the app, its background module and the inbox folder', () => {
  const manifest = readJson('.claude-plugin/plugin.json')
  assert.match(manifest.name, /^[a-z0-9][a-z0-9-]*$/)
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.deepEqual(manifest.requires.features.sort(), ['apps', 'template-mcp-scope'])
  const app = manifest.templates.board.app
  assert.equal(manifest.templates.board.launcher, 'hidden')
  assert.ok(existsSync(join(root, app.seed, 'app.a2ui')))
  assert.ok(existsSync(join(root, app.seed, app.data)))
  assert.ok(existsSync(join(root, app.background.module)))
  assert.ok(app.background.fs.read.every(folder => folder.startsWith('~/')))
  assert.deepEqual(app.localActions, ['dismiss_finding', 'mark_done'])
})

test('the hooks file names a module inside hooks/, and the server is the one the template scopes to', () => {
  for (const module of readJson('hooks/hooks.json').modules) {
    assert.ok(module.startsWith('./') && !module.includes('..'), module)
    assert.ok(existsSync(join(root, 'hooks', module)), module)
  }
  const servers = readJson('.mcp.json').mcpServers
  assert.deepEqual(Object.keys(servers), ['paypal'])
  assert.equal(servers.paypal.type, 'http')
  assert.match(servers.paypal.url, /^https:\/\/mcp\.sandbox\.paypal\.com\//)
  const template = readFileSync(join(root, 'templates/board/template.md'), 'utf8')
  assert.match(template, /^mcp: plugin$/m)
  assert.match(template, /^skills: \[/m)
})

test('the background module imports only .js files, which the runtime compiler lowers', () => {
  const files = ['app-bg.js', 'lib/catalog.js', 'lib/dates.js', 'lib/memo.js', 'lib/sales.js']
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8')
    for (const [, spec] of text.matchAll(/^import [^'"]*['"]([^'"]+)['"]/gm)) {
      assert.match(spec, /^\.\.?\/.*\.js$/, `${file} imports ${spec}`)
      assert.ok(existsSync(join(root, dirname(file), spec)), `${file} imports ${spec}`)
    }
  }
})

test('reads pass, writes ask, denies stand', async () => {
  assert.equal(isWriteTool('mcp__paypal__list_invoices'), false)
  assert.equal(isWriteTool('mcp__paypal__get_dispute'), false)
  assert.equal(isWriteTool('mcp__paypal__show_subscription_details'), false)
  assert.equal(isWriteTool('mcp__paypal__create_refund'), true)
  assert.equal(isWriteTool('mcp__paypal__send_invoice_reminder'), true)
  assert.equal(isWriteTool('mcp__paypal__accept_dispute_claim'), true)
  assert.equal(isWriteTool('mcp__other__create_thing'), false)
  assert.equal(isWriteTool('Read'), false)
  assert.equal(describeCall('mcp__paypal__create_refund', { capture_id: 'CAP-1' }), 'create refund (CAP-1)')

  const handlers = {}
  registerGuard((event, handler) => { handlers[event] = handler })
  const allow = async () => ({ decision: 'allow' })
  const deny = async () => ({ decision: 'deny', reason: 'rule' })
  assert.deepEqual(await handlers['tool.check']({}, { tool: 'mcp__paypal__list_invoices', input: {} }, allow), { decision: 'allow' })
  const asked = await handlers['tool.check']({}, { tool: 'mcp__paypal__create_refund', input: { capture_id: 'CAP-1' } }, allow)
  assert.equal(asked.decision, 'ask')
  assert.match(asked.reason, /create refund \(CAP-1\)/)
  assert.deepEqual(await handlers['tool.check']({}, { tool: 'mcp__paypal__create_refund', input: {} }, deny), { decision: 'deny', reason: 'rule' })
})

test('resultJson prefers structured content, then parses text, then keeps text', () => {
  assert.deepEqual(resultJson({ structuredContent: { a: 1 }, content: [{ type: 'text', text: '{"b":2}' }] }), { a: 1 })
  assert.deepEqual(resultJson({ content: [{ type: 'text', text: '{"items":[]}' }] }), { items: [] })
  assert.equal(resultJson({ content: [{ type: 'text', text: 'no such tool' }] }), 'no such tool')
})

const overdueRows = [
  { invoice_id: 'INV2-A', invoice_number: '0001', status: 'SENT', amount: '120.00', currency_code: 'USD', due_amount: '120.00',
    due_date: day(-20).slice(0, 10) },
  { id: 'INV2-B', status: 'SENT', amount: { currency_code: 'USD', value: '80.00' },
    detail: { invoice_number: '0002', payment_term: { due_date: day(-3).slice(0, 10) } },
    primary_recipients: [{ billing_info: { email_address: 'bob@example.com' } }] },
  { invoice_id: 'INV2-C', invoice_number: '0003', status: 'PAID', amount: '50.00', currency_code: 'USD', due_amount: '0.00',
    due_date: day(-30).slice(0, 10) },
]

/** This week's store orders: $200 of sales and a $60 refund, so refunds are 30% of sales. */
const storeOrders = [
  storeOrder({ date: '2026-11-08', value: '100.00', lines: [['CHG-65W', 2], ['DSK-CABLE', 2]] }),
  storeOrder({ date: '2026-11-07', value: '100.00', lines: [['DSK-ARM', 1], ['PHN-GLASS', 1]], country: 'DE',
    refund: { date: '2026-11-08', cents: 6000 } }),
]
/** The invoice list's store rows: two paid orders this week, $200, no refund in the order book. */
const storeRows = [
  storeRow({ date: '2026-11-08', value: '100.00' }),
  storeRow({ date: '2026-11-07', value: '100.00' }),
]

const raw = {
  disputes: { items: [
    { dispute_id: 'PP-D-1', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'WAITING_FOR_SELLER_RESPONSE',
      dispute_amount: { currency_code: 'USD', value: '45.00' }, seller_response_due_date: day(2), create_time: day(-1),
      disputed_transactions: [{ seller_transaction_id: 'TX-9' }] },
    { dispute_id: 'PP-D-2', reason: 'UNAUTHORISED', status: 'RESOLVED', dispute_amount: { currency_code: 'USD', value: '10.00' } },
  ] },
  transactions: { transaction_details: [
    { transaction_info: { transaction_id: 'TX-1', transaction_initiation_date: day(-1), transaction_amount: { currency_code: 'USD', value: '100.00' }, transaction_status: 'S', transaction_event_code: 'T0006' }, payer_info: { email_address: 'ada@example.com' } },
    { transaction_info: { transaction_id: 'TX-2', transaction_initiation_date: new Date(NOW - 86_400_000 + 5 * 60_000).toISOString(), transaction_amount: { currency_code: 'USD', value: '100.00' }, transaction_status: 'S', transaction_event_code: 'T0006' }, payer_info: { email_address: 'ada@example.com' } },
  ] },
}

const openInvoices = normalizeInvoices(overdueRows.filter(r => r.status === 'SENT'), NOW)

test('deriveState turns the reads into the sales board and cases, most urgent first', () => {
  const state = deriveState({ raw, orders: storeOrders, alertRules: DEFAULT_RULES, openInvoices, inboxFiles: [{ name: 'march.csv', since: NOW }], handled: [], errors: {}, now: NOW })
  assert.equal(state.week.range, 'Nov 3 – Nov 9, 2026')
  assert.equal(state.week.kpis.net.value, '$140')
  assert.equal(state.week.kpis.orders.value, '2')
  assert.equal(state.week.kpis.refunds.value, '30.0%')
  assert.deepEqual(state.week.byCountry.map(c => c.label), ['United States', 'Germany'])
  assert.equal(state.trends.daily.length, 28)
  assert.deepEqual(state.paypalAlerts.map(d => [d.id, d.status]), [['PP-D-1', 'Respond in 2 days'], ['PP-D-2', 'Resolved']])
  assert.deepEqual(state.alerts.map(a => [a.id, a.status, a.value]), [['refund-jump', 'Triggered', '30.0%']])
  assert.equal(state.summary.casesNote, '6 open, most urgent first')
  assert.equal(state.summary.alertsNote, '2 of 3 need a look')
  for (const gone of ['invoices', 'plans', 'series', 'disputes']) assert.equal(state[gone], undefined, gone)
  assert.deepEqual(state.cases.map(c => c.kind), ['dispute', 'overdue_invoice', 'duplicate_payment', 'overdue_invoice', 'alert', 'invoice_request'])
  assert.equal(state.cases[0].id, 'dispute:PP-D-1')
  assert.equal(state.cases[1].id, 'invoice:INV2-A')
  assert.equal(state.cases[1].tone, 'danger')
  assert.equal(state.cases[3].id, 'invoice:INV2-B')
  assert.equal(state.cases[3].tone, 'warning')
  assert.equal(state.cases[4].title, 'Refund rate jump triggered')
  assert.match(state.cases[4].detail, /^Refund rate 30\.0% over Nov 3 – Nov 9, \+30\.0 pts on the week before\. The AI analysis is pending\.$/)
  assert.match(state.cases.at(-1).detail, /inbox\/march\.csv/)
  assert.equal(state.sync.ok, true)
  assert.ok(JSON.stringify(state).length < 20_000)
})

test('handled cases are dropped and read errors are reported in the sync note', () => {
  const state = deriveState({ raw, orders: storeOrders, openInvoices, handled: ['dispute:PP-D-1', 'invoice:INV2-A'], errors: { list_disputes: 'boom' }, now: NOW })
  assert.ok(!state.cases.some(c => c.id === 'dispute:PP-D-1' || c.id === 'invoice:INV2-A'))
  assert.equal(state.sync.ok, false)
  assert.match(state.sync.note, /1 read\(s\) failed: list_disputes/)
})

test('a tool the server does not offer is noted once, not counted as a failed read', () => {
  assert.equal(isToolMissing('MCP error -32602: Tool list_subscription_plans not found'), true)
  assert.equal(isToolMissing('MCP error -32602: Structured content does not match the tool\'s output schema'), false)
  const state = deriveState({ raw, unavailable: ['list_transactions'], now: NOW })
  assert.equal(state.sync.ok, true)
  assert.deepEqual(state.sync.unavailable, ['list_transactions'])
  assert.match(state.sync.note, /not offered by this server: list_transactions/)
})

test('duplicatePayments pairs same payer, same amount, within ten minutes', () => {
  const pairs = duplicatePayments([
    { id: 'a', at: day(0), value: 10, payer: 'x', refund: false },
    { id: 'b', at: new Date(NOW + 60_000).toISOString(), value: 10, payer: 'x', refund: false },
    { id: 'c', at: new Date(NOW + 2 * 60_000).toISOString(), value: 10, payer: 'y', refund: false },
  ])
  assert.deepEqual(pairs.map(([a, b]) => [a.id, b.id]), [['a', 'b']])
})

/** `count` store rows, newest first as the invoice list orders them. */
function manyRows(count) {
  return Array.from({ length: count }, (_, i) => storeRow({ date: day(-1 - (i % 20)).slice(0, 10), value: '12.00' }))
}

/** The invoice list as pages over `rows`; a page holding a row in `refused` is refused as PayPal's server refuses it. */
function pagesOf(rows, refused = new Set()) {
  return ({ page = 1, page_size: size = PAGE_SIZE }) => {
    const items = rows.slice((page - 1) * size, page * size)
    const bad = items.findIndex(r => refused.has(r.invoice_id))
    if (bad >= 0) {
      return { __error: `MCP error -32602: Output validation error: Invalid structured content for tool list_invoices: Invalid enum value. Expected 'DRAFT' | 'SENT' | 'PAID', received 'MARKED_AS_REFUNDED' at invoices[${bad}].status` }
    }
    return { items }
  }
}

/** A stand-in `$` for the module: records calls, answers from `answers` by tool name (a value, or a function of the arguments). */
function fakeDollar({ answers, connected = true, files = [], store = {}, now = NOW }) {
  const state = { value: {} }
  const written = {}
  const logs = []
  const calls = []
  const published = []
  const clock = { now }
  return {
    written, logs, state, calls, published, store, clock,
    $: {
      app: {
        state: { get: async () => state.value, set: async v => { state.value = v } },
        publish: async patches => {
          published.push(patches)
          const next = { ...state.value }
          for (const p of patches) {
            const key = p.path.slice(1)
            if ('value' in p) next[key] = p.value
            else delete next[key]
          }
          state.value = next
        },
      },
      mcp: {
        connect: async server => (connected ? { isConnected: true, server } : { isConnected: false, reason: 'failed', message: 'sign-in required' }),
        call: async (server, tool, args) => {
          calls.push({ tool, args })
          const answer = typeof answers[tool] === 'function' ? answers[tool](args || {}) : answers[tool]
          if (answer && answer.__error) return { isError: true, content: [{ type: 'text', text: answer.__error }] }
          return { content: [{ type: 'text', text: JSON.stringify(answer ?? {}) }] }
        },
      },
      fs: {
        list: async () => files,
        read: async path => `content of ${path}`,
        write: async (path, text) => { written[path] = text },
        exists: async () => false,
      },
      store: { get: async k => store[k], set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)) } },
      log: { warn: async text => { logs.push(text) }, info: async () => {}, debug: async () => {}, error: async () => {} },
      clock: { now: async () => clock.now, every: () => ({ cancel() {} }) },
    },
  }
}

const toolAnswers = {
  list_invoices: pagesOf([...storeRows, ...overdueRows]),
  list_disputes: raw.disputes,
  list_transactions: raw.transactions,
}

test('syncOnce publishes the board and copies new inbox files into the app folder', async () => {
  const world = fakeDollar({ answers: toolAnswers, files: ['orders.csv', 'photo.png'] })
  await syncOnce(world.$, { inbox: '/home/me/Documents/paypal-desk/inbox', now: NOW })
  assert.equal(world.state.value.week.kpis.net.value, '$200')
  assert.equal(world.state.value.week.latest.length, 2)
  assert.ok(world.state.value.cases.some(c => c.id === 'invoice:INV2-A'))
  assert.deepEqual(Object.keys(world.written), ['inbox/orders.csv', 'data/refunds.json'])
  assert.ok(world.state.value.cases.some(c => c.id === 'file:orders.csv'))
  await syncOnce(world.$, { inbox: '/home/me/Documents/paypal-desk/inbox', now: NOW })
  assert.equal(Object.keys(world.written).length, 2, 'a seen file is not copied again')
})

test('the state is published one patch per changed top-level key, and old keys are removed', async () => {
  const world = fakeDollar({ answers: toolAnswers })
  world.state.value = { plans: [{ id: 'P-1' }], series: { daily: [] }, summary: { sales: '$1' } }
  await syncOnce(world.$, { now: NOW })
  const first = world.published[0]
  assert.ok(first.every(p => /^\/[A-Za-z]+$/.test(p.path)), JSON.stringify(first.map(p => p.path)))
  assert.ok(first.some(p => p.path === '/plans' && !('value' in p)))
  assert.ok(first.some(p => p.path === '/week'))
  assert.equal(world.state.value.plans, undefined)
  await syncOnce(world.$, { now: NOW })
  assert.equal(world.published.length, 1, 'an unchanged state publishes nothing')
})

test('the first sync reads every invoice page; later ones stop at a page with nothing new', async () => {
  const rows = manyRows(250)
  const world = fakeDollar({ answers: { ...toolAnswers, list_invoices: pagesOf(rows) } })
  await syncOnce(world.$, { now: NOW })
  const pages = () => world.calls.filter(c => c.tool === 'list_invoices').map(c => c.args.page)
  assert.deepEqual(pages(), [1, 2, 3])
  assert.equal(Object.keys(world.store[ORDERS_KEY].orders).length, 250)
  assert.equal(world.store[ORDERS_KEY].fullAt, NOW)
  assert.match(world.state.value.trends.range, / 250 orders /)

  world.calls.length = 0
  rows.unshift(storeRow({ date: day(-1).slice(0, 10), value: '25.00' }))
  await syncOnce(world.$, { now: NOW + 5 * 60_000 })
  assert.deepEqual(pages(), [1, 2], 'page 1 brought a new order, page 2 nothing new')
  assert.match(world.state.value.trends.range, / 251 orders /)

  world.calls.length = 0
  await syncOnce(world.$, { now: NOW + 10 * 60_000 })
  assert.deepEqual(pages(), [1])
})

test('a full read each hour sees a refund on an old page and drops a deleted invoice', async () => {
  const rows = manyRows(150)
  const world = fakeDollar({ answers: { ...toolAnswers, list_invoices: pagesOf(rows) } })
  await syncOnce(world.$, { now: NOW })
  const last = rows[149]
  rows[149] = { ...last, status: 'MARKED_AS_REFUNDED' }
  const gone = rows.splice(120, 1)[0]
  await syncOnce(world.$, { now: NOW + 5 * 60_000 })
  assert.equal(world.store[ORDERS_KEY].orders[last.invoice_id].refund, null, 'not seen before the hour is up')
  await syncOnce(world.$, { now: NOW + FULL_SCAN_MS })
  const cached = world.store[ORDERS_KEY].orders
  assert.deepEqual(cached[last.invoice_id].refund, { date: last.due_date, cents: 1200, sku: null, reason: null })
  assert.equal(cached[gone.invoice_id], undefined)
  assert.equal(Object.keys(cached).length, 149)
})

test("a page PayPal's server refuses is read again in smaller pages, and only the refused invoice is lost", async () => {
  const rows = manyRows(150)
  const world = fakeDollar({ answers: { ...toolAnswers, list_invoices: pagesOf(rows, new Set([rows[37].invoice_id])) } })
  await syncOnce(world.$, { now: NOW })
  const reads = world.calls.filter(c => c.tool === 'list_invoices').map(c => `${c.args.page_size}:${c.args.page}`)
  assert.deepEqual(reads, [
    '100:1',
    '10:1', '10:2', '10:3', '10:4',
    '5:7', '5:8',
    '1:36', '1:37', '1:38', '1:39', '1:40',
    '10:5', '10:6', '10:7', '10:8', '10:9', '10:10',
    '100:2',
  ])
  const cached = world.store[ORDERS_KEY]
  assert.equal(Object.keys(cached.orders).length, 149)
  assert.equal(cached.orders[rows[37].invoice_id], undefined)
  assert.equal(cached.unread, 1)
  assert.equal(world.state.value.sync.ok, true)
  assert.equal(world.state.value.sync.unread, 1)
  assert.match(world.state.value.sync.note, /1 invoice\(s\) PayPal's server would not send/)
})

test('an order PayPal stops sending is kept, not dropped as deleted', async () => {
  const rows = manyRows(120)
  const refused = new Set()
  const world = fakeDollar({ answers: { ...toolAnswers, list_invoices: pagesOf(rows, refused) } })
  await syncOnce(world.$, { now: NOW })
  refused.add(rows[5].invoice_id)
  await syncOnce(world.$, { now: NOW + FULL_SCAN_MS })
  assert.ok(world.store[ORDERS_KEY].orders[rows[5].invoice_id], 'still cached')
  assert.equal(Object.keys(world.store[ORDERS_KEY].orders).length, 120)
  assert.equal(world.store[ORDERS_KEY].fullAt, NOW + FULL_SCAN_MS)
})

test('a page refused past the highest page number is skipped whole', async () => {
  const budget = { calls: 10 }
  const world = fakeDollar({ answers: { list_invoices: () => ({ __error: 'Output validation error: Invalid structured content' }) } })
  const rows = await readInvoiceRows(world.$, (MAX_PAGE_NUMBER + 4) * 5, 5, budget)
  assert.deepEqual(rows, { items: [], skipped: 5, end: false })
  assert.equal(world.calls.length, 1)
  assert.equal(budget.calls, 10)
})

test('the extra reads stop at the budget and count the rest as skipped', async () => {
  const world = fakeDollar({ answers: { list_invoices: () => ({ __error: 'Output validation error: Invalid structured content' }) } })
  const budget = { calls: 3 }
  const rows = await readInvoiceRows(world.$, 0, PAGE_SIZE, budget)
  assert.equal(rows.items.length, 0)
  assert.equal(rows.skipped, PAGE_SIZE)
  assert.equal(world.calls.length, 4)
  assert.equal(budget.calls, 0)
  assert.equal(isRejectedOutput('MCP error -32602: Output validation error: Invalid structured content for tool list_invoices'), true)
  assert.equal(isRejectedOutput('PayPal answered 503'), false)
})

test('a failed invoice read keeps the cached orders and retries the full read', async () => {
  const world = fakeDollar({ answers: toolAnswers })
  await syncOnce(world.$, { now: NOW })
  let invoiceReads = 0
  world.$.mcp.call = async (server, tool) => {
    if (tool !== 'list_invoices') return { content: [{ type: 'text', text: JSON.stringify(toolAnswers[tool] ?? {}) }] }
    invoiceReads += 1
    return { isError: true, content: [{ type: 'text', text: 'PayPal answered 503' }] }
  }
  await syncOnce(world.$, { now: NOW + FULL_SCAN_MS })
  assert.equal(world.state.value.sync.ok, false)
  assert.match(world.state.value.sync.note, /list_invoices/)
  assert.equal(world.state.value.week.kpis.net.value, '$200')
  assert.equal(world.store[ORDERS_KEY].fullAt, NOW, 'the full read is still due')
  assert.equal(invoiceReads, 1, 'an ordinary error is not read again in smaller pages')
})

test('orders older than the kept window are not cached', async () => {
  const old = storeRow({ date: day(-(KEEP_DAYS + 1)).slice(0, 10), value: '12.00' })
  const world = fakeDollar({ answers: { ...toolAnswers, list_invoices: pagesOf([...storeRows, old]) } })
  await syncOnce(world.$, { now: NOW })
  assert.equal(world.store[ORDERS_KEY].orders[old.invoice_id], undefined)
  assert.equal(Object.keys(world.store[ORDERS_KEY].orders).length, 2)
})

test('syncOnce asks Transaction Search for a 30-day window of ISO 8601 date-times', async () => {
  const world = fakeDollar({ answers: toolAnswers })
  await syncOnce(world.$, { now: NOW })
  const args = world.calls.find(c => c.tool === 'list_transactions').args
  const withSeconds = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/
  assert.match(args.start_date, withSeconds)
  assert.match(args.end_date, withSeconds)
  assert.equal(Date.parse(args.end_date) - Date.parse(args.start_date), 30 * 86_400_000)
  assert.equal(Date.parse(args.end_date), NOW)
  assert.ok(args.page_size <= 500)
  assert.deepEqual(Object.keys(args).sort(), ['end_date', 'page_size', 'start_date'])
  assert.ok(!world.calls.some(c => c.tool === 'list_subscription_plans'))
})

test('syncOnce without a connection publishes the error and keeps the board', async () => {
  const world = fakeDollar({ answers: toolAnswers, connected: false })
  world.state.value = { week: { range: 'kept' }, cases: [{ id: 'kept' }] }
  await syncOnce(world.$, { now: NOW })
  assert.equal(world.state.value.sync.ok, false)
  assert.match(world.state.value.sync.note, /sign-in required/)
  assert.deepEqual(world.state.value.week, { range: 'kept' })
  assert.deepEqual(world.state.value.cases, [{ id: 'kept' }])
})

test('publishState falls back to state.set without publish, and sends nothing when nothing changed', async () => {
  const set = []
  await publishState({ app: { state: { set: async v => { set.push(v) } } } }, {}, { a: 1 })
  assert.deepEqual(set, [{ a: 1 }])
  const sent = []
  await publishState({ app: { publish: async p => { sent.push(p) } } }, { a: { b: 1 } }, { a: { b: 1 } })
  assert.deepEqual(sent, [])
})

test('app.start returns before the first sync ends and arms the timers; a changed alert file syncs at once; app.stop cancels them', async () => {
  const handlers = {}
  registerBackground((event, handler) => { handlers[event] = handler })
  let cancelled = 0
  const timers = new Map()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const world = fakeDollar({ answers: toolAnswers })
  const call = world.$.mcp.call
  world.$.mcp.call = async (...args) => {
    await gate
    return call(...args)
  }
  world.$.clock.every = (ms, fn) => { timers.set(ms, fn); return { cancel() { cancelled += 1 } } }
  const appFiles = {}
  world.$.fs.exists = async path => path in appFiles
  world.$.fs.read = async path => appFiles[path]
  await handlers['app.start'](world.$, { appId: 'paypal-desk-board', folder: '/apps/x', folders: { read: [], write: [] }, locale: 'en' })
  assert.equal(world.state.value.week, undefined, 'the sync is still reading')
  assert.deepEqual([...timers.keys()], [5 * 60_000, RULES_WATCH_MS])
  release()
  await whenIdle()
  assert.equal(world.state.value.week.kpis.net.value, '$200')
  assert.deepEqual(world.state.value.alerts.map(a => a.id), ['refund-jump'], 'with no alert file, the built-in rule')

  const reads = () => world.calls.filter(c => c.tool === 'list_disputes').length
  const before = reads()
  await timers.get(RULES_WATCH_MS)()
  assert.equal(reads(), before, 'nothing changed, no sync')
  appFiles[ALERTS_FILE] = JSON.stringify({ alerts: [{ id: 'floor', name: 'Sales floor', metric: 'net_sales', below: 1000 }] })
  await timers.get(RULES_WATCH_MS)()
  await whenIdle()
  assert.equal(reads(), before + 1)
  assert.deepEqual(world.state.value.alerts.map(a => [a.id, a.status]), [['floor', 'Triggered']])

  await handlers['app.stop'](world.$, { appId: 'paypal-desk-board', reason: 'disabled' })
  assert.equal(cancelled, 2)
})

test('a sync adds the store payments from Transaction Search, every page, and keeps the last good ones when the read fails', async () => {
  const sale = (i, page) => transactionRow({ id: `TX-${page}-${i}`, number: `PD-20261108-${String(page * 100 + i).padStart(3, '0')}`, at: '2026-11-08T09:00:00Z', value: '10.00' })
  const pages = { 1: [sale(1, 1), sale(2, 1)], 2: [sale(1, 2)] }
  const transactions = ({ page = 1 }) => ({ transaction_details: pages[page] || [], total_pages: 2 })
  const world = fakeDollar({ answers: { ...toolAnswers, list_invoices: pagesOf(storeRows), list_transactions: transactions } })
  await syncOnce(world.$, { now: NOW })
  assert.deepEqual(world.calls.filter(c => c.tool === 'list_transactions').map(c => c.args.page), [undefined, 2])
  assert.equal(world.state.value.week.kpis.orders.value, '5', 'two invoices and three payments')
  assert.equal(world.store[PAYMENTS_KEY].length, 3)

  world.calls.length = 0
  const failing = fakeDollar({ answers: { ...toolAnswers, list_invoices: pagesOf(storeRows), list_transactions: { __error: 'boom' } }, store: world.store })
  await syncOnce(failing.$, { now: NOW + 5 * 60_000 })
  assert.equal(failing.state.value.week.kpis.orders.value, '5', 'the cached payments still count')
  assert.match(failing.state.value.sync.note, /list_transactions/)
})

test('the home view: the top cases, alerts with their analysis status, and findings', () => {
  const alertRules = [
    { id: 'refund-watch', name: 'Refund rate watch', metric: 'refund_rate', riseAbove: 1.5 },
    { id: 'ceiling', name: 'Refund ceiling', metric: 'refund_rate', above: 50 },
  ]
  const findings = [
    { id: 'f-1', alertId: 'refund-watch', week: '2026-11-03..2026-11-09', at: '2026-11-10T09:00:00-05:00', title: '65W charger: bad batch', conclusion: 'Refunds since Nov 2 are chargers that stop charging.', action: 'Pause the charger' },
    { id: 'f-0', at: '2026-11-09T09:00:00-05:00', title: 'Older', conclusion: 'x' },
  ]
  const state = deriveState({ raw, orders: storeOrders, alertRules, findings, openInvoices, handled: [], errors: {}, now: NOW })
  assert.equal(state.week.ask.refunds, "Analyze the change in the refund rate: 30.0% of sales for Nov 3 – Nov 9, 2026. What's behind it — which products, countries or refund reasons?", 'no week before: no comparison')
  assert.equal(state.needs.length, 3)
  assert.deepEqual(state.needs, state.cases.slice(0, 3))
  assert.deepEqual(state.alerts.map(a => [a.id, a.status, a.tone, a.analysis]), [['refund-watch', 'Triggered', 'warning', 'analyzed'], ['ceiling', 'OK', 'success', '']])
  assert.equal(state.alerts[0].note, 'AI: 65W charger: bad batch. Refunds since Nov 2 are chargers that stop charging.')
  assert.deepEqual([state.alerts[0].rule, state.alerts[0].subject, state.alerts[0].value, state.alerts[0].better], ['Store: refund rate up more than 1.5 pts', 'Last 7 days', '30.0%', 'down'])
  assert.equal(state.alerts[0].summary, 'Store: refund rate up more than 1.5 pts')
  assert.equal(state.alerts[1].note, '')
  assert.deepEqual(state.findings.map(f => [f.id, f.source]), [['f-1', 'Automatic analysis'], ['f-0', 'Asked in chat']])
  assert.equal(state.findings[0].action, 'Suggested: Pause the charger')
  assert.equal(state.summary.alertsNote, '2 of 4 need a look', 'one tripped rule and one open dispute')

  const pending = deriveState({ raw, orders: storeOrders, alertRules, findings: [], openInvoices, handled: [], errors: {}, now: NOW })
  assert.deepEqual([pending.alerts[0].analysis, pending.alerts[0].note], ['pending', 'Waiting for the AI to analyze it'])
})

test('a sync reads the alert and finding files and writes the refund breakdown for the agent', async () => {
  const world = fakeDollar({ answers: toolAnswers })
  const files = {
    [ALERTS_FILE]: JSON.stringify({ alerts: [{ id: 'refund-watch', name: 'Refund rate watch', metric: 'refund_rate', riseAbove: 1.5 }] }),
    [FINDINGS_FILE]: 'not json',
  }
  world.$.fs.exists = async p => p in files
  world.$.fs.read = async p => files[p]
  await syncOnce(world.$, { now: NOW })
  assert.equal(world.state.value.alerts[0].id, 'refund-watch')
  assert.deepEqual(world.state.value.findings, [], 'a bad findings file reads as none')
  const breakdown = JSON.parse(world.written['data/refunds.json'])
  assert.equal(breakdown.asOf, '2026-11-10')
  assert.equal(breakdown.weeks.length, 4)
})

test('dismiss_finding changes the file and the board at once; other actions, deleting an alert among them, go to the model', async () => {
  const world = fakeDollar({ answers: toolAnswers })
  const files = {
    [ALERTS_FILE]: JSON.stringify({ alerts: [{ id: 'a' }, { id: 'b' }] }),
    [FINDINGS_FILE]: JSON.stringify({ findings: [{ id: 'f' }] }),
  }
  world.$.fs.exists = async p => p in files
  world.$.fs.read = async p => files[p]
  world.$.fs.write = async (p, text) => { files[p] = text; world.written[p] = text }
  world.state.value = { alerts: [{ id: 'a' }, { id: 'b' }], findings: [{ id: 'f' }] }

  assert.deepEqual(await handleAction(world.$, { action: 'dismiss_finding', context: { id: 'f' } }), { handled: true })
  assert.deepEqual(world.state.value.findings, [])
  assert.deepEqual(world.published.at(-1).map(p => p.path), ['/findings'])
  assert.deepEqual(await handleAction(world.$, { action: 'ask_why', context: { draft: 'Why?' } }), { handled: false })
  assert.deepEqual(await handleAction(world.$, { action: 'delete_alert', context: { id: 'a' } }), { handled: false })
  assert.deepEqual(JSON.parse(files[ALERTS_FILE]).alerts, [{ id: 'a' }, { id: 'b' }], 'the board never removes an alert itself')
  assert.deepEqual(await handleAction(world.$, { action: 'dismiss_finding', context: {} }), { handled: false })
})

test("a rule card's Edit and Delete draft a request naming the alert for the session agent", () => {
  const state = deriveState({ raw, orders: storeOrders, alertRules: DEFAULT_RULES, now: NOW })
  assert.equal(state.alerts[0].editAsk, 'Change the alert "Refund rate jump" (id: refund-jump, now Store: refund rate up more than 1.5 pts): ')
  assert.equal(state.alerts[0].deleteAsk, 'Delete the alert "Refund rate jump" (id: refund-jump).')
})

const trippedRow = (id, week = '2026-11-03..2026-11-09') => alertWithStatus({ id, name: `Alert ${id}`, rule: 'Store: refund rate up more than 1.5 pts', reading: 'refund rate 6.3% over Nov 3 – Nov 9, +3.1 pts on the week before', week, tripped: true, understood: true, ask: 'q' }, [], null)

test('a tripped alert with no finding starts one agent run in the app, once per alert week, without waiting for it', async () => {
  const world = fakeDollar({ answers: toolAnswers })
  const asked = []
  let finish
  world.$.app.analyze = req => { asked.push(req); return new Promise(r => { finish = r }) }
  const done = []
  const quiet = alertWithStatus({ id: 'q', week: 'w', tripped: false, understood: true }, [], null)
  const analyzed = alertWithStatus({ id: 'x', week: 'w', tripped: true, understood: true }, [{ alertId: 'x', week: 'w' }], null)

  const started = await startAnalysis(world.$, [quiet, analyzed, trippedRow('a'), trippedRow('b')], NOW, r => done.push(r))
  assert.ok(started && started.run)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].title, 'Analyze alert: Alert a')
  assert.match(asked[0].prompt, /"alertId": "a" and "week": "2026-11-03\.\.2026-11-09"/)
  assert.match(asked[0].prompt, /Change nothing on PayPal/)
  assert.deepEqual(world.store[ANALYSES_KEY], { 'a@2026-11-03..2026-11-09': NOW })
  assert.deepEqual(['analysis', 'note'].map(k => alertWithStatus(trippedRow('a'), [], { id: 'a', week: '2026-11-03..2026-11-09' })[k]), ['analyzing', 'The AI is analyzing it…'])

  assert.equal(await startAnalysis(world.$, [trippedRow('b')], NOW, () => {}), null, 'one run at a time')
  finish({ ok: true, text: 'Charger batch' })
  await started.run
  assert.deepEqual(done, [{ ok: true, text: 'Charger batch' }])

  assert.equal(await startAnalysis(world.$, [trippedRow('a')], NOW + 1000, () => {}), null, 'the same week is not started again soon')
  const later = await startAnalysis(world.$, [trippedRow('a')], NOW + ANALYSIS_RETRY_MS, () => {})
  assert.ok(later, 'tried again once the retry time passed')
  finish({ ok: false, reason: 'stopped' })
  await later.run
  assert.match(world.logs.at(-1), /analysis of a@2026-11-03\.\.2026-11-09 ended without a result: stopped/)
})

test('no analysis where the host has none, and a throwing analyze ends the run cleanly', async () => {
  const world = fakeDollar({ answers: toolAnswers })
  assert.equal(await startAnalysis(world.$, [trippedRow('a')], NOW, () => {}), null)
  world.$.app.analyze = () => { throw new Error('agent not declared') }
  const done = []
  const started = await startAnalysis(world.$, [trippedRow('a')], NOW, r => done.push(r))
  await started.run
  assert.deepEqual(done, [{ ok: false, reason: 'agent not declared' }])
})

test('after a run the board shows the new finding and the alert as analyzed', async () => {
  const world = fakeDollar({ answers: toolAnswers })
  const findings = [{ id: 'f-1', alertId: 'a', week: '2026-11-03..2026-11-09', at: '2026-11-10T09:00:00-05:00', title: 'Charger batch', conclusion: 'c' }]
  world.$.fs.exists = async p => p === FINDINGS_FILE
  world.$.fs.read = async () => JSON.stringify({ findings })
  const invoice = { id: 'invoice:INV2-A', kind: 'overdue_invoice', title: 'Invoice 7 is 3 day(s) overdue', detail: 'd', tone: 'warning', label: 'Overdue', since: NOW, ref: 'INV2-A', ask: 'Work this case' }
  const pending = { id: 'alert:a', kind: 'alert', title: 'Alert a triggered', detail: 'The AI analysis is pending.', tone: 'warning', label: 'Alert', since: NOW, ref: 'a', ask: 'q' }
  world.state.value = { alerts: [trippedRow('a')], findings: [], cases: [invoice, pending], sync: { at: NOW }, summary: { disputesNote: 'x' } }
  await refreshFindings(world.$)
  assert.deepEqual([world.state.value.alerts[0].status, world.state.value.alerts[0].analysis], ['Triggered', 'analyzed'])
  assert.deepEqual(world.state.value.findings.map(f => [f.id, f.source]), [['f-1', 'Automatic analysis']])
  assert.deepEqual(world.state.value.cases.map(c => c.id), ['invoice:INV2-A', 'alert:a'])
  assert.equal(world.state.value.cases[1].detail, 'Refund rate 6.3% over Nov 3 – Nov 9, +3.1 pts on the week before. AI: Charger batch. c', "the alert's to-do carries the conclusion")
  assert.deepEqual(world.state.value.summary, {
    disputesNote: 'x', casesNote: '2 open, most urgent first', todoCount: 2, openTab: 2, findingsNote: 'Newest first', alertsNote: '1 of 1 need a look',
  })
})

test('a tripped alert is a to-do with the analysis in it; with no rule there is no refund to-do', () => {
  const alertRules = [{ id: 'refund-watch', name: 'Refund rate watch', metric: 'refund_rate', riseAbove: 1.5 }]
  const findings = [{ id: 'f-1', alertId: 'refund-watch', week: '2026-11-03..2026-11-09', at: '2026-11-10T09:00:00-05:00', title: '65W charger: bad batch', conclusion: 'Chargers stop charging.' }]
  const plain = deriveState({ raw, orders: storeOrders, openInvoices, handled: [], errors: {}, now: NOW })
  assert.ok(!plain.cases.some(c => c.kind === 'alert'))
  const state = deriveState({ raw, orders: storeOrders, alertRules, findings, openInvoices, handled: [], errors: {}, now: NOW })
  const todo = state.cases.find(c => c.kind === 'alert')
  assert.equal(todo.id, 'alert:refund-watch')
  assert.equal(todo.title, 'Refund rate watch triggered')
  assert.match(todo.detail, /^Refund rate 30\.0% over Nov 3 – Nov 9, \+30\.0 pts on the week before\. AI: 65W charger: bad batch\. Chargers stop charging\.$/)
  assert.match(todo.ask, /^The alert "Refund rate watch" \(Store: refund rate up more than 1\.5 pts\) reads refund rate 30\.0%/)
  assert.match(state.cases[0].ask, /^Work this case \(dispute:PP-D-1\): Dispute PP-D-1/)
  assert.equal(state.cases.length, plain.cases.length + 1)
  assert.deepEqual([state.summary.todoCount, state.summary.openTab], [state.cases.length, 2])
  const none = deriveState({ raw: {}, now: NOW })
  assert.deepEqual([none.summary.todoCount, none.summary.openTab, none.summary.casesNote], [0, 0, 'Nothing needs you right now'])
})

test('a to-do marked done is hidden for DONE_DAYS and comes back after them; a bare id is hidden for good', () => {
  assert.equal(DONE_DAYS, 7)
  const handled = [{ id: 'alert:a', at: '2026-11-03' }, 'dispute:PP-D-1']
  assert.equal(isDone(handled, 'alert:a', '2026-11-09'), true)
  assert.equal(isDone(handled, 'alert:a', '2026-11-10'), false, 'a week later it shows again')
  assert.equal(isDone(handled, 'dispute:PP-D-1', '2027-01-01'), true)
  assert.equal(isDone(handled, 'invoice:x', '2026-11-09'), false)
  const doneToday = deriveState({ raw, orders: storeOrders, openInvoices, handled: [{ id: 'invoice:INV2-A', at: '2026-11-10' }], errors: {}, now: NOW })
  assert.ok(!doneToday.cases.some(c => c.id === 'invoice:INV2-A'))
  const weekLater = deriveState({ raw, orders: storeOrders, openInvoices, handled: [{ id: 'invoice:INV2-A', at: '2026-11-03' }], errors: {}, now: NOW })
  assert.ok(weekLater.cases.some(c => c.id === 'invoice:INV2-A'), 'still overdue a week on: back on the list')
})

test('mark_done records the day in the handled file and drops the to-do from the board at once', async () => {
  const world = fakeDollar({ answers: toolAnswers })
  const files = { 'data/handled.json': JSON.stringify([{ id: 'old', at: '2026-08-01' }, 'forever', { id: 'b', at: '2026-11-01' }]) }
  world.$.fs.exists = async p => p in files
  world.$.fs.read = async p => files[p]
  world.$.fs.write = async (p, text) => { files[p] = text; world.written[p] = text }
  const row = id => ({ id, kind: 'overdue_invoice', title: id, detail: '', tone: 'warning', label: 'Overdue', since: NOW, ask: '' })
  world.state.value = { cases: [row('a'), row('b')], needs: [row('a'), row('b')], summary: { alertsNote: 'n' } }
  assert.deepEqual(await handleAction(world.$, { action: 'mark_done', context: { id: 'b' } }), { handled: true })
  assert.deepEqual(JSON.parse(files['data/handled.json']), [{ id: 'forever', at: '' }, { id: 'b', at: '2026-11-10' }], 'entries past 60 days dropped, the id recorded once')
  assert.deepEqual(world.state.value.cases.map(c => c.id), ['a'])
  assert.deepEqual(world.state.value.needs.map(c => c.id), ['a'])
  assert.deepEqual(world.state.value.summary, { alertsNote: 'n', casesNote: '1 open, most urgent first', todoCount: 1, openTab: 2 })
  assert.deepEqual(await handleAction(world.$, { action: 'mark_done', context: {} }), { handled: false })
})

test('alerts are added from a plus card that ends the rule grid, not from a button in the heading', () => {
  const board = readFileSync(join(root, 'app/app.a2ui'), 'utf8')
  assert.match(board, /^ruleAlertList = Grid\(_template\(\$\/data\/alerts, ruleCard\), minWidth=320, after=ruleAdd\)$/m)
  assert.match(board, /^ruleAdd = AddCard\("Add alert with AI", Event\("compose", \{text: "Add an alert: /m)
  assert.match(board, /^alertsHead = Heading\("Alerts", 2, /m)
  assert.equal(board.match(/Add alert with AI/g).length, 1)
})

test('the board uses only icons the catalog offers', () => {
  const allowed = new Set(['accountCircle', 'add', 'arrowBack', 'arrowForward', 'attachFile', 'calendarToday', 'call', 'camera', 'check', 'close', 'delete', 'download', 'edit', 'event', 'error', 'fastForward', 'favorite', 'favoriteOff', 'folder', 'help', 'home', 'info', 'locationOn', 'lock', 'lockOpen', 'mail', 'menu', 'moreVert', 'moreHoriz', 'notificationsOff', 'notifications', 'pause', 'payment', 'person', 'phone', 'photo', 'play', 'print', 'refresh', 'rewind', 'search', 'send', 'settings', 'share', 'shoppingCart', 'skipNext', 'skipPrevious', 'star', 'starHalf', 'starOff', 'stop', 'upload', 'visibility', 'visibilityOff', 'volumeDown', 'volumeMute', 'volumeOff', 'volumeUp', 'warning'])
  const board = readFileSync(join(root, 'app/app.a2ui'), 'utf8')
  const used = [...board.matchAll(/Icon\("([^"]+)"\)/g)].map(m => m[1])
  assert.ok(used.length > 0)
  assert.deepEqual(used.filter(name => !allowed.has(name)), [])
})

test('board: no tab repeats its own name as a title; each tab opens on its period or status line', () => {
  const board = readFileSync(join(root, 'app/app.a2ui'), 'utf8')
  const tabs = [...board.match(/^root = Tabs\(.*$/m)[0].matchAll(/title: "([^"]+)", child: (\w+)/g)]
  assert.deepEqual(tabs.map(m => m[1]), ['Overview', 'Trends', 'Actions'])
  for (const [, name, child] of tabs) {
    const first = board.match(new RegExp(`^${child} = Column\\(\\[(\\w+)`, 'm'))[1]
    const line = board.match(new RegExp(`^${first} = (.*)$`, 'm'))[1]
    assert.match(line, /^Heading\(subtitle=\$\/data\/[\w/]+[,)]/, `${name} opens on a bound subtitle line, small and muted`)
  }
  assert.doesNotMatch(board, /Heading\("(Store sales|Trends|Actions|Overview)"/)
})
