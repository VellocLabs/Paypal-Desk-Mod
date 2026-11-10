#!/usr/bin/env node
/**
 * Opens test disputes on the sandbox business account, one per case the
 * desk's dispute review decides differently: each is a store order paid
 * with a sandbox test card, then a chargeback on its capture through the
 * sandbox-only `process-chargeback` endpoint. Needs PAYPAL_CLIENT_ID and
 * PAYPAL_CLIENT_SECRET of a sandbox REST app in the environment; the host is
 * api-m.sandbox.paypal.com and cannot be changed. Progress is kept in
 * .seed/disputes.json, so a second run skips what is done.
 *
 *   node scripts/seed-disputes.mjs --dry-run
 *   node scripts/seed-disputes.mjs
 *   node scripts/seed-disputes.mjs --only duplicate
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dateOf } from '../lib/dates.js'
import { makeOrder, orderNumber } from '../lib/orders.js'
import { captureOf, checkoutBody } from './lib/payments.mjs'
import { createClient } from './lib/rest.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const journalPath = join(root, '.seed', 'disputes.json')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : ''
const today = dateOf(Date.now())

/**
 * The cases, with what the review should conclude. `reason` is the
 * chargeback reason the sandbox endpoint takes; `pick` chooses the order.
 */
const CASES = [
  { key: 'duplicate', reason: 'DUPLICATE', expect: 'refund: the order was paid twice', twice: true, pick: o => o.totalCents >= 3000 && o.totalCents <= 9000 },
  { key: 'small-not-received', reason: 'INR', expect: 'refund: no tracking, and under $25', pick: o => o.totalCents <= 2500 },
  { key: 'large-not-received', reason: 'INR', expect: 'your call: contest only with tracking', pick: o => o.totalCents >= 12000 },
  { key: 'not-as-described', reason: 'SNAD', expect: 'refund if the earbuds are refunded far above the store, else your call', pick: o => o.lines.some(l => l.sku === 'AUD-BUDS') && o.totalCents > 2500 },
  { key: 'unauthorized', reason: 'UNAUTH', expect: 'your call: no seller protection or history on a card payment', pick: o => o.totalCents > 2500 && o.totalCents < 12000 },
]

const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : {}
const used = new Set(Object.values(journal).map(e => e.number))
const plan = CASES.filter(c => !only || c.key === only).map(c => {
  if (journal[c.key] && journal[c.key].chargeback) return { ...c, done: true, number: journal[c.key].number }
  const number = journal[c.key] ? journal[c.key].number : findOrder(c.pick)
  used.add(number)
  return { ...c, number, order: makeOrder(number, today) }
})

for (const c of plan) {
  const total = c.order ? ` $${(c.order.totalCents / 100).toFixed(2)} ${c.order.lines.map(l => l.sku).join('+')}` : ''
  console.log(`${c.done ? 'done ' : 'to do'}  ${c.key.padEnd(20)} ${c.number}${total}  → expect ${c.expect}`)
}
if (dryRun) process.exit(0)

const clientId = process.env.PAYPAL_CLIENT_ID
const clientSecret = process.env.PAYPAL_CLIENT_SECRET
if (!clientId || !clientSecret) {
  console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (a sandbox REST app) first.')
  process.exit(2)
}
const client = createClient({ clientId, clientSecret, rpm: 30 })

let failed = 0
for (const c of plan.filter(p => !p.done)) {
  const entry = journal[c.key] ?? (journal[c.key] = { number: c.number })
  try {
    entry.captureId ??= await pay(c.order, `pd-dispute-${c.number}`)
    if (c.twice) entry.secondCaptureId ??= await pay(c.order, `pd-dispute-${c.number}-again`, { second: true })
    save()
    const target = c.twice ? entry.secondCaptureId : entry.captureId
    const answer = await client.request('POST', '/v2/customer-support/process-chargeback', {
      transaction: { id_enc: target },
      reason: c.reason,
      amount: { currency: 'USD', value: (c.order.totalCents / 100).toFixed(2) },
      chargeback_type: 'FIRST',
    })
    entry.chargeback = { on: target, at: new Date().toISOString(), answer }
    save()
    console.log(`  ${c.key}: chargeback on ${target} → ${JSON.stringify(answer).slice(0, 160)}`)
  } catch (err) {
    failed += 1
    save()
    console.error(`  ${c.key} failed: ${err.message}`)
  }
}

console.log(`\nDone, ${failed} failed.${failed ? ' Run the same command again to retry: finished steps are skipped.' : ''}`)
console.log('Disputes show in the desk at its next sync (5 minutes, or restart Velloc). The order behind each')
console.log('one is matched through Transaction Search, which lists new payments only after a few hours.')

/** Pays one store order with the test card; a second payment of the same order carries no invoice id, which PayPal would refuse twice. */
async function pay(order, requestId, { second = false } = {}) {
  const body = checkoutBody(order)
  if (second) delete body.purchase_units[0].invoice_id
  let answer = await client.request('POST', '/v2/checkout/orders', body, { 'PayPal-Request-Id': requestId })
  if (answer.status === 'APPROVED' || answer.status === 'CREATED') {
    answer = await client.request('POST', `/v2/checkout/orders/${answer.id}/capture`, {}, { 'PayPal-Request-Id': `${requestId}-capture` })
  }
  const capture = captureOf(answer)
  if (answer.status !== 'COMPLETED' || !capture) throw new Error(`order ${answer.id} is ${answer.status}`)
  console.log(`  paid ${order.number} $${(order.totalCents / 100).toFixed(2)} (capture ${capture.id})`)
  return capture.id
}

/** Today's first order-book number from 901 on that `pick` accepts and no case took; daily orders stay under 900. */
function findOrder(pick) {
  for (let i = 901; i <= 999; i++) {
    const number = orderNumber(today, i)
    if (!used.has(number) && pick(makeOrder(number, today))) return number
  }
  throw new Error('no order in the book fits this case today')
}

function save() {
  mkdirSync(dirname(journalPath), { recursive: true })
  writeFileSync(`${journalPath}.tmp`, `${JSON.stringify(journal, null, 2)}\n`)
  renameSync(`${journalPath}.tmp`, journalPath)
}
