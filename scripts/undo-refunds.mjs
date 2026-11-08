#!/usr/bin/env node
/**
 * Deletes the refunds recorded on the store's demo invoices, so each goes
 * back to paid and its refund lives in the memo alone. PayPal's MCP server
 * refuses any invoice-list page that holds a refunded invoice, which empties
 * the dashboard. Only the seeder's invoices are touched (a store-order memo,
 * or an order number `PD-YYYYMMDD-NNN`, which early test runs used with
 * another memo); another refunded invoice is listed and left as it is. The
 * seeding journal is not touched, so this can run beside a seeding run.
 * Needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET of a sandbox REST app.
 *
 *   node scripts/undo-refunds.mjs --dry-run    (list what would change)
 *   node scripts/undo-refunds.mjs
 *
 * Options: --workers N (default 6), --rpm N (default 150).
 */
import { parseOrderMemo } from '../lib/memo.mjs'
import { ApiError, createClient } from './lib/rest.mjs'

const PAGE_SIZE = 100

const args = process.argv.slice(2)
const flag = name => args.includes(`--${name}`)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? Number(args[at + 1]) : fallback
}
const dryRun = flag('dry-run')
const workers = option('workers', 6)
const rpm = option('rpm', 150)

const clientId = process.env.PAYPAL_CLIENT_ID
const clientSecret = process.env.PAYPAL_CLIENT_SECRET
if (!clientId || !clientSecret) {
  console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (a sandbox REST app) first.')
  process.exit(2)
}
const client = createClient({ clientId, clientSecret, rpm })

const refunded = await listRefunded()
const seeded = i => Boolean(parseOrderMemo(i.detail?.memo)) || /^PD-\d{8}-\d{3}$/.test(i.detail?.invoice_number || '')
const store = refunded.filter(seeded)
const others = refunded.filter(i => !seeded(i))
console.log(`Refunded invoices: ${refunded.length} (${store.length} seeded, ${others.length} other)`)
for (const i of others) console.log(`  left as it is: ${i.detail?.invoice_number ?? i.id} ${i.status}`)
if (dryRun || store.length === 0) {
  for (const i of store.slice(0, 5)) console.log(`  would undo: ${i.detail.invoice_number} ${i.status}`)
  process.exit(0)
}

let next = 0
let done = 0
let failed = 0
async function worker() {
  while (next < store.length) {
    const invoice = store[next++]
    const number = invoice.detail.invoice_number
    try {
      const removed = await undo(invoice.id)
      done += 1
      if (done % 10 === 0 || done === store.length) console.log(`  ${done}/${store.length} undone (${number}: ${removed} refund record(s) deleted)`)
    } catch (err) {
      failed += 1
      console.error(`  ${number} failed: ${err.message}`)
    }
  }
}
await Promise.all(Array.from({ length: Math.min(workers, store.length) }, worker))

const left = (await listRefunded()).filter(seeded)
console.log(`\nDone: ${done} undone, ${failed} failed. Seeded invoices still refunded: ${left.length}.`)
if (store[0]) {
  const check = await client.request('GET', `/v2/invoicing/invoices/${store[0].id}`)
  console.log(`Check of ${store[0].detail.invoice_number}: status ${check.status}, refunds ${JSON.stringify(check.refunds ?? null)}`)
}
if (failed || left.length) console.log('Run the same command again to retry.')

/** Every invoice whose status says refunded, from the whole list. */
async function listRefunded() {
  const found = []
  for (let page = 1; ; page++) {
    const list = await client.request('GET', `/v2/invoicing/invoices?page=${page}&page_size=${PAGE_SIZE}`)
    const items = list.items ?? []
    for (const i of items) if (/REFUND/.test(String(i.status || ''))) found.push(i)
    if (items.length < PAGE_SIZE) return found
  }
}

/** Deletes each recorded refund of one invoice; answers how many were deleted. */
async function undo(id) {
  const invoice = await client.request('GET', `/v2/invoicing/invoices/${id}`)
  const records = invoice.refunds?.transactions ?? []
  let removed = 0
  for (const record of records) {
    const refundId = record.recipient_transaction_id ?? record.refund_id ?? record.transaction_id ?? record.id
    if (!refundId) throw new Error(`a refund record without an id: ${JSON.stringify(record)}`)
    try {
      await client.request('DELETE', `/v2/invoicing/invoices/${id}/refunds/${refundId}`)
      removed += 1
    } catch (err) {
      // A retried DELETE whose first try went through answers 404.
      if (!(err instanceof ApiError && err.status === 404)) throw err
    }
  }
  return removed
}
