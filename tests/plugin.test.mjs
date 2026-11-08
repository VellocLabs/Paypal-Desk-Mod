/**
 * The manifest a client installs by, the two modules it loads, the write
 * guard's decisions, and the state the background module derives from
 * PayPal's reads.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { describeCall, isWriteTool, register as registerGuard } from '../hooks/guard.js'
import { deriveState, duplicatePayments, isToolMissing, resultJson, syncOnce, register as registerBackground } from '../app-bg.js'

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

const raw = {
  invoices: { items: [
    { id: 'INV2-A', status: 'SENT', amount: { currency_code: 'USD', value: '120.00' },
      detail: { invoice_number: '0001', payment_term: { due_date: day(-20).slice(0, 10) } },
      primary_recipients: [{ billing_info: { name: { given_name: 'Ada', surname: 'Lovelace' }, email_address: 'ada@example.com' } }] },
    { id: 'INV2-B', status: 'SENT', amount: { currency_code: 'USD', value: '80.00' },
      detail: { invoice_number: '0002', payment_term: { due_date: day(-3).slice(0, 10) } },
      primary_recipients: [{ billing_info: { email_address: 'bob@example.com' } }] },
    { id: 'INV2-C', status: 'PAID', amount: { currency_code: 'USD', value: '50.00' },
      detail: { invoice_number: '0003', payment_term: { due_date: day(-30).slice(0, 10) } } },
  ] },
  disputes: { items: [
    { dispute_id: 'PP-D-1', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'WAITING_FOR_SELLER_RESPONSE',
      dispute_amount: { currency_code: 'USD', value: '45.00' }, seller_response_due_date: day(2), create_time: day(-1),
      disputed_transactions: [{ seller_transaction_id: 'TX-9' }] },
    { dispute_id: 'PP-D-2', reason: 'UNAUTHORISED', status: 'RESOLVED', dispute_amount: { currency_code: 'USD', value: '10.00' } },
  ] },
  plans: { plans: [{ id: 'P-1', name: 'Monthly', status: 'ACTIVE', create_time: day(-100) }] },
  transactions: { transaction_details: [
    { transaction_info: { transaction_id: 'TX-1', transaction_initiation_date: day(-1), transaction_amount: { currency_code: 'USD', value: '100.00' }, transaction_status: 'S', transaction_event_code: 'T0006' }, payer_info: { email_address: 'ada@example.com' } },
    { transaction_info: { transaction_id: 'TX-2', transaction_initiation_date: new Date(NOW - 86_400_000 + 5 * 60_000).toISOString(), transaction_amount: { currency_code: 'USD', value: '100.00' }, transaction_status: 'S', transaction_event_code: 'T0006' }, payer_info: { email_address: 'ada@example.com' } },
    { transaction_info: { transaction_id: 'TX-3', transaction_initiation_date: day(-2), transaction_amount: { currency_code: 'USD', value: '-60.00' }, transaction_status: 'S', transaction_event_code: 'T1107' } },
    { transaction_info: { transaction_id: 'TX-4', transaction_initiation_date: day(-40), transaction_amount: { currency_code: 'USD', value: '999.00' }, transaction_status: 'S', transaction_event_code: 'T0006' } },
  ] },
}

test('deriveState turns the reads into figures, rows and cases, most urgent first', () => {
  const state = deriveState({ raw, inboxFiles: [{ name: 'march.csv', since: NOW }], handled: [], errors: {}, now: NOW })
  assert.equal(state.summary.sales, '$200.00')
  assert.equal(state.summary.refunds, '$60.00')
  assert.equal(state.summary.overdueCount, '2')
  assert.equal(state.summary.disputeCount, '1')
  assert.equal(state.series.daily.length, 30)
  assert.equal(state.series.daily.at(-2).sales, 200)
  assert.equal(state.series.daily.at(-3).refunds, 60)
  assert.deepEqual(state.invoices.map(i => i.status), ['OVERDUE', 'OVERDUE', 'PAID'])
  assert.deepEqual(state.disputes.map(d => d.id), ['PP-D-1', 'PP-D-2'])
  assert.deepEqual(state.plans.map(p => p.name), ['Monthly'])
  const kinds = state.cases.map(c => c.kind)
  assert.deepEqual(kinds, ['dispute', 'overdue_invoice', 'duplicate_payment', 'overdue_invoice', 'refund_spike', 'invoice_request'])
  assert.equal(state.cases[0].tone, 'danger')
  assert.equal(state.cases[0].id, 'dispute:PP-D-1')
  assert.equal(state.cases[1].id, 'invoice:INV2-A')
  assert.equal(state.cases[1].tone, 'danger')
  assert.equal(state.cases[2].kind, 'duplicate_payment')
  assert.equal(state.cases[3].id, 'invoice:INV2-B')
  assert.equal(state.cases[3].tone, 'warning')
  assert.match(state.cases.at(-1).detail, /inbox\/march\.csv/)
  assert.equal(state.sync.ok, true)
  assert.ok(JSON.stringify(state).length < 20_000)
})

test('handled cases are dropped and read errors are reported in the sync note', () => {
  const state = deriveState({ raw, handled: ['dispute:PP-D-1', 'invoice:INV2-A'], errors: { list_subscription_plans: 'boom' }, now: NOW })
  assert.ok(!state.cases.some(c => c.id === 'dispute:PP-D-1' || c.id === 'invoice:INV2-A'))
  assert.equal(state.sync.ok, false)
  assert.match(state.sync.note, /list_subscription_plans/)
})

test('a tool the server does not offer is noted once, not counted as a failed read', () => {
  assert.equal(isToolMissing('MCP error -32602: Tool list_subscription_plans not found'), true)
  assert.equal(isToolMissing('MCP error -32602: Structured content does not match the tool\'s output schema'), false)
  const state = deriveState({ raw, unavailable: ['list_subscription_plans'], now: NOW })
  assert.equal(state.sync.ok, true)
  assert.deepEqual(state.sync.unavailable, ['list_subscription_plans'])
  assert.match(state.sync.note, /not offered by this server: list_subscription_plans/)
  assert.equal(state.summary.plansNote, 'Not offered by this PayPal connection')
})

test('duplicatePayments pairs same payer, same amount, within ten minutes', () => {
  const pairs = duplicatePayments([
    { id: 'a', at: day(0), value: 10, payer: 'x', refund: false },
    { id: 'b', at: new Date(NOW + 60_000).toISOString(), value: 10, payer: 'x', refund: false },
    { id: 'c', at: new Date(NOW + 2 * 60_000).toISOString(), value: 10, payer: 'y', refund: false },
  ])
  assert.deepEqual(pairs.map(([a, b]) => [a.id, b.id]), [['a', 'b']])
})

/** What the fake server answers, by tool name. */
const toolAnswers = {
  list_invoices: raw.invoices,
  list_disputes: raw.disputes,
  list_subscription_plans: raw.plans,
  list_transactions: raw.transactions,
}

/** A stand-in `$` for the module: records calls, answers from `answers` by tool name. */
function fakeDollar({ answers, connected = true, files = [], store = {} }) {
  const state = { value: {} }
  const written = {}
  const logs = []
  return {
    written,
    logs,
    state,
    $: {
      app: { state: { get: async () => state.value, set: async v => { state.value = v } } },
      mcp: {
        connect: async server => (connected ? { isConnected: true, server } : { isConnected: false, reason: 'failed', message: 'sign-in required' }),
        call: async (server, tool) => ({ content: [{ type: 'text', text: JSON.stringify(answers[tool] ?? {}) }] }),
      },
      fs: {
        list: async () => files,
        read: async path => `content of ${path}`,
        write: async (path, text) => { written[path] = text },
        exists: async () => false,
      },
      store: { get: async k => store[k], set: async (k, v) => { store[k] = v } },
      log: { warn: async text => { logs.push(text) }, info: async () => {}, debug: async () => {}, error: async () => {} },
      clock: { now: async () => NOW, every: () => ({ cancel() {} }) },
    },
  }
}

test('syncOnce publishes the derived state and copies new inbox files into the app folder', async () => {
  const world = fakeDollar({ answers: toolAnswers, files: ['orders.csv', 'photo.png'] })
  await syncOnce(world.$, { inbox: '/home/me/Documents/paypal-desk/inbox', now: NOW })
  assert.equal(world.state.value.summary.sales, '$200.00')
  assert.deepEqual(Object.keys(world.written), ['inbox/orders.csv'])
  assert.ok(world.state.value.cases.some(c => c.id === 'file:orders.csv'))
  await syncOnce(world.$, { inbox: '/home/me/Documents/paypal-desk/inbox', now: NOW })
  assert.equal(Object.keys(world.written).length, 1, 'a seen file is not copied again')
})

test('syncOnce treats an isError "not found" answer as a tool the server does not offer', async () => {
  const world = fakeDollar({ answers: toolAnswers })
  world.$.mcp.call = async (server, tool) =>
    tool === 'list_subscription_plans'
      ? { isError: true, content: [{ type: 'text', text: 'MCP error -32602: Tool list_subscription_plans not found' }] }
      : { content: [{ type: 'text', text: JSON.stringify(toolAnswers[tool] ?? {}) }] }
  await syncOnce(world.$, { now: NOW })
  assert.equal(world.state.value.sync.ok, true)
  assert.deepEqual(world.state.value.sync.unavailable, ['list_subscription_plans'])
  assert.equal(world.state.value.summary.plansNote, 'Not offered by this PayPal connection')
})

test('syncOnce without a connection publishes the error and keeps the lists', async () => {
  const world = fakeDollar({ answers: toolAnswers, connected: false })
  world.state.value = { invoices: [{ number: 'kept' }] }
  await syncOnce(world.$, { now: NOW })
  assert.equal(world.state.value.sync.ok, false)
  assert.match(world.state.value.sync.note, /sign-in required/)
  assert.deepEqual(world.state.value.invoices, [{ number: 'kept' }])
})

test('app.start syncs at once and arms the timer; app.stop cancels it', async () => {
  const handlers = {}
  registerBackground((event, handler) => { handlers[event] = handler })
  let cancelled = 0
  let period = 0
  const world = fakeDollar({ answers: toolAnswers })
  world.$.clock.every = (ms, fn) => { period = ms; return { cancel() { cancelled += 1 } } }
  await handlers['app.start'](world.$, { appId: 'paypal-desk-board', folder: '/apps/x', folders: { read: [], write: [] }, locale: 'en' })
  assert.equal(world.state.value.summary.sales, '$200.00')
  assert.equal(period, 5 * 60_000)
  await handlers['app.stop'](world.$, { appId: 'paypal-desk-board', reason: 'disabled' })
  assert.equal(cancelled, 1)
})
