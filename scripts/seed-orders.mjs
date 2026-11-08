#!/usr/bin/env node
/**
 * Seeds the sandbox business account with the demo store's order history:
 * each order becomes an invoice dated on its order day, sent without email,
 * marked paid that day, and for a few orders refunded a few days later.
 * Needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET of a sandbox REST app in
 * the environment. Progress is kept in .seed/journal.json, so an interrupted
 * run picks up where it stopped.
 *
 *   node scripts/seed-orders.mjs --dry-run
 *   node scripts/seed-orders.mjs --from 2026-09-25 --to 2026-09-25 --orders 10
 *   node scripts/seed-orders.mjs                 (2,500 orders, 2026-10-01 … 2026-11-07)
 *
 * Options: --from, --to (YYYY-MM-DD), --orders N (default: 2,500 spread pro
 * rata over the range), --refund-rate R (default 0.04), --rpm N (requests a
 * minute, default 50), --method PAYPAL|OTHER|… (recorded payment method),
 * --dry-run (print the plan and one request body, call nothing).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CATALOG } from './lib/catalog.mjs'
import {
  DEFAULT_FROM, DEFAULT_REFUND_RATE, DEFAULT_TO, dayRange, generateOrders, invoiceBody, isDate,
  paymentBody, refundBody, summarizeOrders,
} from './lib/orders.mjs'
import { ApiError, createClient } from './lib/rest.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const journalPath = join(root, '.seed', 'journal.json')

const args = parseArgs(process.argv.slice(2))
const today = new Date().toISOString().slice(0, 10)
const from = args.from ?? DEFAULT_FROM
const to = args.to ?? DEFAULT_TO
if (!isDate(from) || !isDate(to) || from > to) fail(`--from/--to must be dates with from <= to (got ${from} … ${to}).`)
if (to > today) fail(`--to ${to} is in the future; recorded payments cannot be.`)
const total = args.orders === undefined ? undefined : Number(args.orders)
if (total !== undefined && !(Number.isInteger(total) && total > 0)) fail('--orders must be a positive whole number.')
const refundRate = args['refund-rate'] === undefined ? DEFAULT_REFUND_RATE : Number(args['refund-rate'])
const rpm = args.rpm === undefined ? 50 : Number(args.rpm)
const method = args.method ?? 'PAYPAL'

const orders = generateOrders({ from, to, total, refundRate })
const plan = summarizeOrders(orders)
printPlan(plan)

if (args['dry-run']) {
  console.log('\nFirst order, as sent:')
  console.log(JSON.stringify({ invoice: invoiceBody(orders[0]), payment: paymentBody(orders[0], method) }, null, 2))
  const refunded = orders.find(o => o.refund)
  if (refunded) console.log(`\nA refund (${refunded.number}):`, JSON.stringify(refundBody(refunded, method)))
  process.exit(0)
}

const clientId = process.env.PAYPAL_CLIENT_ID
const clientSecret = process.env.PAYPAL_CLIENT_SECRET
if (!clientId || !clientSecret) fail('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (a sandbox REST app) first.')

const client = createClient({ clientId, clientSecret, rpm })
const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : {}
const verbose = orders.length <= 100
let done = 0
let failed = 0
let streak = 0
const started = Date.now()

for (const order of orders) {
  try {
    await seedOrder(order)
    done += 1
    streak = 0
    if (verbose || done % 25 === 0) {
      const tag = order.refund ? ` refunded ${(order.refund.cents / 100).toFixed(2)} on ${order.refund.date}` : ''
      console.log(`  ${order.number} ${order.country} $${(order.totalCents / 100).toFixed(2)} paid${tag}  (${done}/${orders.length})`)
    }
  } catch (err) {
    failed += 1
    streak += 1
    console.error(`  ${order.number} failed: ${err.message}`)
    if (done === 0 || streak >= 5) {
      console.error('\nStopping: the first order or five in a row failed, so the cause is likely not this one order.')
      break
    }
  }
}

console.log(`\nDone: ${done} order(s) seeded, ${failed} failed, in ${Math.round((Date.now() - started) / 1000)} s.`)
await probe()

async function seedOrder(order) {
  const entry = journal[order.number] ?? (journal[order.number] = {})
  if (!entry.id) {
    try {
      const created = await client.request('POST', '/v2/invoicing/invoices', invoiceBody(order))
      entry.id = created.id || (created.href || '').split('/').pop()
    } catch (err) {
      if (!(err instanceof ApiError && /DUPLICATE_INVOICE_NUMBER/.test(err.body))) throw err
      await adoptExisting(order, entry)
    }
    saveJournal()
  }
  if (!entry.sent) {
    await client.request('POST', `/v2/invoicing/invoices/${entry.id}/send`, { send_to_invoicer: false, send_to_recipient: false })
    entry.sent = true
    saveJournal()
  }
  if (!entry.paid) {
    await client.request('POST', `/v2/invoicing/invoices/${entry.id}/payments`, paymentBody(order, method))
    entry.paid = true
    saveJournal()
  }
  if (order.refund && !entry.refunded) {
    await client.request('POST', `/v2/invoicing/invoices/${entry.id}/refunds`, refundBody(order, method))
    entry.refunded = true
    saveJournal()
  }
}

async function adoptExisting(order, entry) {
  const found = await client.request('POST', '/v2/invoicing/search-invoices?page_size=1', { invoice_number: order.number })
  const invoice = found.items?.[0]
  if (!invoice) throw new Error(`invoice number ${order.number} is taken but search found nothing`)
  const status = invoice.status || ''
  entry.id = invoice.id
  entry.sent = status !== 'DRAFT'
  entry.paid = /PAID|REFUND/.test(status)
  entry.refunded = /REFUND/.test(status)
}

async function probe() {
  const seeded = orders.filter(o => journal[o.number]?.id)
  const picks = [['first seeded invoice', seeded[0]], ['first refunded invoice', seeded.find(o => o.refund)]]
  try {
    for (const [label, order] of picks) {
      if (!order) continue
      const invoice = await client.request('GET', `/v2/invoicing/invoices/${journal[order.number].id}`)
      console.log(`\nCheck of the ${label} (${order.number}):`)
      console.log(`  status ${invoice.status}, invoice_date ${invoice.detail?.invoice_date}`)
      console.log(`  memo ${invoice.detail?.memo}`)
      console.log(`  payments ${JSON.stringify(invoice.payments ?? null)}`)
      console.log(`  refunds ${JSON.stringify(invoice.refunds ?? null)}`)
    }
    const list = await client.request('GET', '/v2/invoicing/invoices?page=1&page_size=100&total_required=true')
    const mine = new Set(seeded.map(o => o.number))
    const rows = (list.items ?? []).filter(i => mine.has(i.detail?.invoice_number))
    console.log(`\nList answer: total_items ${list.total_items}; this run's invoices on page 1: ${rows.length}`)
    for (const row of rows.slice(0, 12)) {
      console.log(`  ${row.detail.invoice_number} ${row.status} ${row.amount?.value} memo=${JSON.stringify(row.detail?.memo ?? null)}`)
    }
  } catch (err) {
    console.error(`Check failed: ${err.message}`)
  }
}

function saveJournal() {
  mkdirSync(dirname(journalPath), { recursive: true })
  writeFileSync(`${journalPath}.tmp`, JSON.stringify(journal))
  renameSync(`${journalPath}.tmp`, journalPath)
}

function printPlan(p) {
  const days = dayRange(from, to).length
  const pct = n => `${((100 * n) / p.orders).toFixed(1)}%`
  const countries = Object.entries(p.byCountry).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${pct(n)}`).join(', ')
  const names = Object.fromEntries(CATALOG.map(c => [c.sku, c.name]))
  const top = Object.entries(p.bySku).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([sku, cents]) => `${names[sku]} $${Math.round(cents / 100)}`).join('; ')
  console.log(`Plan: ${p.orders} orders over ${days} day(s), ${from} … ${to}`)
  console.log(`  revenue $${(p.revenueCents / 100).toFixed(2)}, AOV $${(p.aovCents / 100).toFixed(2)}, ${p.refunds} refund(s)`)
  console.log(`  countries: ${countries}`)
  console.log(`  products used: ${Object.keys(p.bySku).length}/${CATALOG.length}; top: ${top}`)
  console.log(`  ${p.requests} API calls at ${rpm}/min ≈ ${Math.ceil(p.requests / rpm)} min`)
}

function parseArgs(list) {
  const out = {}
  for (let i = 0; i < list.length; i++) {
    const key = list[i].replace(/^--/, '')
    if (key === 'dry-run') out[key] = true
    else out[key] = list[++i]
  }
  return out
}

function fail(message) {
  console.error(message)
  process.exit(2)
}
