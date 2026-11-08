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
  FULL_SCAN_MS, KEEP_DAYS, ORDERS_KEY, PAGE_SIZE, deriveState, duplicatePayments, isToolMissing, normalizeInvoices, publishState,
  resultJson, syncOnce, whenIdle, register as registerBackground,
} from '../app-bg.js'
import { readStoreRow } from '../lib/sales.mjs'
import { storeRow } from './fixtures.mjs'

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
  { id: 'INV2-A', status: 'SENT', amount: { currency_code: 'USD', value: '120.00' },
    detail: { invoice_number: '0001', payment_term: { due_date: day(-20).slice(0, 10) } },
    primary_recipients: [{ billing_info: { name: { given_name: 'Ada', surname: 'Lovelace' }, email_address: 'ada@example.com' } }] },
  { id: 'INV2-B', status: 'SENT', amount: { currency_code: 'USD', value: '80.00' },
    detail: { invoice_number: '0002', payment_term: { due_date: day(-3).slice(0, 10) } },
    primary_recipients: [{ billing_info: { email_address: 'bob@example.com' } }] },
  { id: 'INV2-C', status: 'PAID', amount: { currency_code: 'USD', value: '50.00' },
    detail: { invoice_number: '0003', payment_term: { due_date: day(-30).slice(0, 10) } } },
]

/** This week's store orders: $200 of sales and a $60 refund, so refunds are 30% of sales. */
const storeRows = [
  storeRow({ date: '2026-11-08', value: '100.00', lines: [['CHG-65W', 2], ['DSK-CABLE', 2]] }),
  storeRow({ date: '2026-11-07', value: '100.00', lines: [['DSK-ARM', 1], ['PHN-GLASS', 1]], country: 'DE',
    refund: { date: '2026-11-08', cents: 6000 }, status: 'MARKED_AS_REFUNDED' }),
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

const storeOrders = storeRows.map(row => readStoreRow(row).order)
const openInvoices = normalizeInvoices(overdueRows.filter(r => r.status === 'SENT'), NOW)

test('deriveState turns the reads into the sales board and cases, most urgent first', () => {
  const state = deriveState({ raw, orders: storeOrders, openInvoices, inboxFiles: [{ name: 'march.csv', since: NOW }], handled: [], errors: {}, now: NOW })
  assert.equal(state.week.range, 'Nov 3 – Nov 9, 2026')
  assert.equal(state.week.kpis.net.value, '$140')
  assert.equal(state.week.kpis.orders.value, '2')
  assert.equal(state.week.kpis.refunds.value, '30.0%')
  assert.deepEqual(state.week.byCountry.map(c => c.label), ['United States', 'Germany'])
  assert.equal(state.month.products.length, 4)
  assert.deepEqual(state.disputes.map(d => d.id), ['PP-D-1', 'PP-D-2'])
  assert.deepEqual(state.summary, { casesNote: '6 open, most urgent first', disputesNote: '1 open of 2' })
  for (const gone of ['invoices', 'plans', 'series']) assert.equal(state[gone], undefined, gone)
  assert.deepEqual(state.cases.map(c => c.kind), ['dispute', 'overdue_invoice', 'duplicate_payment', 'overdue_invoice', 'refund_spike', 'invoice_request'])
  assert.equal(state.cases[0].id, 'dispute:PP-D-1')
  assert.equal(state.cases[1].id, 'invoice:INV2-A')
  assert.equal(state.cases[1].tone, 'danger')
  assert.equal(state.cases[3].id, 'invoice:INV2-B')
  assert.equal(state.cases[3].tone, 'warning')
  assert.match(state.cases[4].detail, /^30% of the last 7 days/)
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

/** The invoice list as pages of PAGE_SIZE over `rows`. */
function pagesOf(rows) {
  return ({ page = 1, page_size: size = PAGE_SIZE }) => ({ items: rows.slice((page - 1) * size, page * size) })
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
  assert.equal(world.state.value.week.kpis.net.value, '$140')
  assert.ok(world.state.value.cases.some(c => c.id === 'invoice:INV2-A'))
  assert.deepEqual(Object.keys(world.written), ['inbox/orders.csv'])
  assert.ok(world.state.value.cases.some(c => c.id === 'file:orders.csv'))
  await syncOnce(world.$, { inbox: '/home/me/Documents/paypal-desk/inbox', now: NOW })
  assert.equal(Object.keys(world.written).length, 1, 'a seen file is not copied again')
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
  assert.equal(world.state.value.month.kpis.orders.value, '250')

  world.calls.length = 0
  rows.unshift(storeRow({ date: day(-1).slice(0, 10), value: '25.00', lines: [['PHN-CASE', 1]] }))
  await syncOnce(world.$, { now: NOW + 5 * 60_000 })
  assert.deepEqual(pages(), [1, 2], 'page 1 brought a new order, page 2 nothing new')
  assert.equal(world.state.value.month.kpis.orders.value, '251')

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
  assert.equal(world.store[ORDERS_KEY].orders[last.id].refund, null, 'not seen before the hour is up')
  await syncOnce(world.$, { now: NOW + FULL_SCAN_MS })
  const cached = world.store[ORDERS_KEY].orders
  assert.deepEqual(cached[last.id].refund, { date: last.detail.invoice_date, cents: 1200 })
  assert.equal(cached[gone.id], undefined)
  assert.equal(Object.keys(cached).length, 149)
})

test('a failed invoice read keeps the cached orders and retries the full read', async () => {
  const world = fakeDollar({ answers: toolAnswers })
  await syncOnce(world.$, { now: NOW })
  world.$.mcp.call = async (server, tool) =>
    tool === 'list_invoices'
      ? { isError: true, content: [{ type: 'text', text: 'PayPal answered 503' }] }
      : { content: [{ type: 'text', text: JSON.stringify(toolAnswers[tool] ?? {}) }] }
  await syncOnce(world.$, { now: NOW + FULL_SCAN_MS })
  assert.equal(world.state.value.sync.ok, false)
  assert.match(world.state.value.sync.note, /list_invoices/)
  assert.equal(world.state.value.week.kpis.net.value, '$140')
  assert.equal(world.store[ORDERS_KEY].fullAt, NOW, 'the full read is still due')
})

test('orders older than the kept window are not cached', async () => {
  const old = storeRow({ date: day(-(KEEP_DAYS + 1)).slice(0, 10), value: '12.00' })
  const world = fakeDollar({ answers: { ...toolAnswers, list_invoices: pagesOf([...storeRows, old]) } })
  await syncOnce(world.$, { now: NOW })
  assert.equal(world.store[ORDERS_KEY].orders[old.id], undefined)
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

test('app.start returns before the first sync ends and arms the timer; app.stop cancels it', async () => {
  const handlers = {}
  registerBackground((event, handler) => { handlers[event] = handler })
  let cancelled = 0
  let period = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const world = fakeDollar({ answers: toolAnswers })
  const call = world.$.mcp.call
  world.$.mcp.call = async (...args) => {
    await gate
    return call(...args)
  }
  world.$.clock.every = (ms, fn) => { period = ms; return { cancel() { cancelled += 1 } } }
  await handlers['app.start'](world.$, { appId: 'paypal-desk-board', folder: '/apps/x', folders: { read: [], write: [] }, locale: 'en' })
  assert.equal(world.state.value.week, undefined, 'the sync is still reading')
  assert.equal(period, 5 * 60_000)
  release()
  await whenIdle()
  assert.equal(world.state.value.week.kpis.net.value, '$140')
  await handlers['app.stop'](world.$, { appId: 'paypal-desk-board', reason: 'disabled' })
  assert.equal(cancelled, 1)
})
