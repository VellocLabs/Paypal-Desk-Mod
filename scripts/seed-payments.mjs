#!/usr/bin/env node
/**
 * Takes today's store orders as direct payments: each order is a PayPal
 * Orders v2 order paid with a sandbox test card, so PayPal holds a real
 * capture for it. Then makes each refund in the order book whose day has
 * come, for orders this script took on earlier days. Run it once a day: a
 * payment is dated when it is made, so past days cannot be added.
 * Needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET of a sandbox REST app whose
 * account takes card payments. Progress is kept in .seed/payments.json.
 *
 *   node scripts/seed-payments.mjs --dry-run
 *   node scripts/seed-payments.mjs --orders 1     (one order, to try it)
 *   node scripts/seed-payments.mjs                (all of today's orders)
 *   node scripts/seed-payments.mjs --check        (print the latest transactions)
 *
 * Options: --orders N (take only the first N of today's orders), --workers N
 * (default 4), --rpm N (default 120), --check.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dateOf } from '../lib/dates.js'
import { makeOrder, orderDateOf, orderNumber } from '../lib/orders.js'
import { captureOf, checkoutBody, dailyCount, dueRefunds, refundBody } from './lib/payments.mjs'
import { ApiError, createClient } from './lib/rest.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const journalPath = join(root, '.seed', 'payments.json')

const args = parseArgs(process.argv.slice(2))
const today = dateOf(Date.now())
const workers = args.workers === undefined ? 4 : Number(args.workers)
const rpm = args.rpm === undefined ? 120 : Number(args.rpm)
const limit = args.orders === undefined ? undefined : Number(args.orders)
if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) fail('--orders must be a positive whole number.')
if (!(rpm > 0) || !(Number.isInteger(workers) && workers > 0)) fail('--rpm and --workers must be positive numbers.')

const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : {}
const count = dailyCount(today)
const orders = Array.from({ length: Math.min(count, limit ?? count) }, (_, i) => makeOrder(orderNumber(today, i + 1), today))
const todo = orders.filter(o => !journal[o.number]?.captureId)
const bookOrder = number => {
  const date = orderDateOf(number)
  return date ? makeOrder(number, date) : null
}
const refunds = dueRefunds(journal, bookOrder, today)
const cents = todo.reduce((sum, o) => sum + o.totalCents, 0)
console.log(`Today (${today}, local time): ${count} orders in the order book; ${todo.length} to pay now, $${(cents / 100).toFixed(2)}.`)
console.log(`Refunds due from earlier orders: ${refunds.length}.`)

if (args['dry-run']) {
  if (todo[0]) console.log('\nFirst order, as sent:\n' + JSON.stringify(redactCard(checkoutBody(todo[0])), null, 2))
  if (refunds[0]) console.log(`\nFirst refund (${refunds[0].number}):`, JSON.stringify(refundBody(refunds[0])))
  process.exit(0)
}

const clientId = process.env.PAYPAL_CLIENT_ID
const clientSecret = process.env.PAYPAL_CLIENT_SECRET
if (!clientId || !clientSecret) fail('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (a sandbox REST app) first.')
const client = createClient({ clientId, clientSecret, rpm })

if (args.check) {
  await check()
  process.exit(process.exitCode ?? 0)
}

let paid = 0
let failed = 0
let stopping = false
await runAll(todo, async order => {
  const entry = journal[order.number] ?? (journal[order.number] = {})
  let answer = await client.request('POST', '/v2/checkout/orders', checkoutBody(order), { 'PayPal-Request-Id': `pd-${order.number}` })
  entry.orderId = answer.id
  if (answer.status === 'APPROVED' || answer.status === 'CREATED') {
    answer = await client.request('POST', `/v2/checkout/orders/${answer.id}/capture`, {}, { 'PayPal-Request-Id': `pd-${order.number}-capture` })
  }
  const capture = captureOf(answer)
  if (answer.status !== 'COMPLETED' || !capture) {
    saveJournal()
    throw new Error(`order ${answer.id} is ${answer.status}${capture ? `, capture ${capture.status}` : ', no capture'}`)
  }
  entry.captureId = capture.id
  entry.captureStatus = capture.status
  saveJournal()
  paid += 1
  if (todo.length <= 20 || paid % 10 === 0) {
    console.log(`  ${order.number} ${order.country} $${(order.totalCents / 100).toFixed(2)} ${capture.status} (capture ${capture.id})  ${paid}/${todo.length}`)
  }
})

let refunded = 0
await runAll(refunds, async order => {
  const entry = journal[order.number]
  const answer = await client.request('POST', `/v2/payments/captures/${entry.captureId}/refund`, refundBody(order), { 'PayPal-Request-Id': `pd-${order.number}-refund` })
  entry.refundId = answer.id
  saveJournal()
  refunded += 1
  console.log(`  ${order.number} refunded $${(order.refund.cents / 100).toFixed(2)} (${answer.status})`)
})

console.log(`\nDone: ${paid} paid, ${refunded} refunded, ${failed} failed.`)
if (failed) console.log('Run the same command again to retry: finished orders are skipped.')
if (paid || refunded) console.log('Transaction Search can take up to a few hours to list new payments; --check prints what it lists now.')

/** Runs `step` over `items` with `workers` in flight; stops after the first item or five in a row fail. */
async function runAll(items, step) {
  let next = 0
  let streak = 0
  let ok = 0
  async function worker() {
    while (!stopping && next < items.length) {
      const item = items[next++]
      try {
        await step(item)
        ok += 1
        streak = 0
      } catch (err) {
        failed += 1
        streak += 1
        console.error(`  ${item.number} failed: ${err.message}`)
        if (ok === 0 || streak >= 5) {
          stopping = true
          console.error('\nStopping: the first one or five in a row failed, so the cause is likely not one order.')
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, worker))
}

/** Prints the last day's transactions as Transaction Search lists them, to see which fields it returns. */
async function check() {
  const end = new Date()
  const start = new Date(end.getTime() - 2 * 86_400_000)
  const query = `start_date=${start.toISOString().slice(0, 19)}Z&end_date=${end.toISOString().slice(0, 19)}Z&fields=all&page_size=20`
  let list
  try {
    list = await client.request('GET', `/v1/reporting/transactions?${query}`)
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 403)) throw err
    console.error(`Transaction Search refused this REST app (403 NOT_AUTHORIZED): turn on "Transaction search" in the app's features on developer.paypal.com. The dashboard reads transactions through the MCP server, which does not need it.`)
    process.exitCode = 1
    return
  }
  const rows = list.transaction_details ?? []
  console.log(`Transaction Search, last 2 days: ${list.total_items ?? rows.length} transaction(s).`)
  for (const t of rows.slice(0, 5)) {
    const info = t.transaction_info ?? {}
    console.log(`  ${info.transaction_id} ${info.transaction_event_code} ${info.transaction_status} ${info.transaction_amount?.value} invoice_id=${info.invoice_id ?? '-'} custom=${info.custom_field ?? '-'}`)
  }
  if (rows[0]) console.log('\nFirst one in full:\n' + JSON.stringify(rows[0], null, 2))
}

function redactCard(body) {
  const card = body.payment_source.card
  return { ...body, payment_source: { card: { ...card, number: `${card.number.slice(0, 4)}…${card.number.slice(-4)} (sandbox test card)`, security_code: '…' } } }
}

function saveJournal() {
  mkdirSync(dirname(journalPath), { recursive: true })
  writeFileSync(`${journalPath}.tmp`, JSON.stringify(journal))
  renameSync(`${journalPath}.tmp`, journalPath)
}

function parseArgs(list) {
  const out = {}
  for (let i = 0; i < list.length; i++) {
    const key = list[i].replace(/^--/, '')
    if (key === 'dry-run' || key === 'check') out[key] = true
    else out[key] = list[++i]
  }
  return out
}

function fail(message) {
  console.error(message)
  process.exit(2)
}
