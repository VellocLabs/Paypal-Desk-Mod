/**
 * Deterministic demo orders for the sandbox store, and the PayPal Invoicing
 * request bodies that record each one as a paid (and sometimes refunded)
 * sale on its own date. Each order's content is seeded from its number, so a
 * resumed run regenerates exactly the same orders.
 *
 * Contract: amounts are integer cents internally and two-decimal USD strings
 * in request bodies; dates are YYYY-MM-DD.
 */
import { CALENDAR, CATALOG, COMPANIONS, COUNTRIES } from '../../lib/catalog.mjs'
import { addDays, dayRange, isDate } from '../../lib/dates.mjs'
import { orderMemo, parseOrderMemo } from '../../lib/memo.mjs'

export { addDays, dayRange, isDate, orderMemo, parseOrderMemo }

export const DEFAULT_FROM = '2026-10-01'
export const DEFAULT_TO = '2026-11-07'
export const DEFAULT_TOTAL = 2500
export const DEFAULT_REFUND_RATE = 0.03

// Sunday … Saturday: weekend orders run a little higher.
const WEEKDAY = [1.1, 1.0, 0.97, 0.98, 1.0, 1.05, 1.12]

export function rng(seedText) {
  let h = 2166136261
  for (let i = 0; i < seedText.length; i++) {
    h ^= seedText.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pickWeighted(r, list, weightOf) {
  const total = list.reduce((sum, item) => sum + weightOf(item), 0)
  let x = r() * total
  for (const item of list) {
    x -= weightOf(item)
    if (x < 0) return item
  }
  return list[list.length - 1]
}

const pick = (r, list) => list[Math.floor(r() * list.length)]

export function defaultTotal(dayCount) {
  return Math.round((DEFAULT_TOTAL * dayCount) / dayRange(DEFAULT_FROM, DEFAULT_TO).length)
}

export const eventsOn = date => CALENDAR.filter(e => e.from <= date && date <= e.to)

/**
 * Splits `total` orders over `days` (weekday shape, a run-up toward the
 * holidays, store events, ±10% noise); sums to `total` exactly.
 */
export function dayCounts(days, total) {
  const n = days.length
  const weights = days.map((d, i) => {
    const trend = n > 1 ? 0.88 + (0.27 * i) / (n - 1) : 1
    const noise = 0.9 + 0.2 * rng(`day:${d}`)()
    const events = eventsOn(d).reduce((f, e) => f * (e.orders ?? 1), 1)
    return WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()] * trend * noise * events
  })
  const sum = weights.reduce((a, b) => a + b, 0)
  const raw = weights.map(w => (w / sum) * total)
  const counts = raw.map(Math.floor)
  let left = total - counts.reduce((a, b) => a + b, 0)
  const byFraction = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1])
  for (const [, i] of byFraction) {
    if (left-- <= 0) break
    counts[i] += 1
  }
  return counts
}

const BY_SKU = new Map(CATALOG.map(p => [p.sku, p]))
const weightCache = new Map()

/** Product weights on `date`: popularity × store events; the same for every country. */
export function productWeights(date) {
  if (weightCache.has(date)) return weightCache.get(date)
  const events = eventsOn(date)
  const weights = new Map(CATALOG.map(p => {
    let w = p.weight
    for (const e of events) w *= (e.categories?.[p.category] ?? 1) * (e.skus?.[p.sku] ?? 1)
    return [p.sku, w]
  }))
  weightCache.set(date, weights)
  return weights
}

export function orderNumber(date, index) {
  return `PD-${date.replaceAll('-', '')}-${String(index).padStart(3, '0')}`
}

export function makeOrder(number, date, { refundRate = DEFAULT_REFUND_RATE, lastDay } = {}) {
  const r = rng(number)
  const country = pickWeighted(r, COUNTRIES, c => c.share)
  const first = pick(r, country.first)
  const last = pick(r, country.last)
  const place = pick(r, country.places)
  const street = `${100 + Math.floor(r() * 800)} ${pick(r, country.streets)}`
  const handle = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '')
  const email = `${handle}${r() < 0.5 ? '' : 10 + Math.floor(r() * 90)}@example.com`

  const weights = productWeights(date)
  const lines = []
  const add = product => {
    const qty = r() < (product.price <= 20 ? 0.2 : 0.05) ? 2 : 1
    lines.push({ sku: product.sku, name: product.name, unitCents: Math.round(product.price * 100), qty })
  }
  const draw = () => {
    const open = CATALOG.filter(p => weights.get(p.sku) > 0 && !lines.some(l => l.sku === p.sku))
    return pickWeighted(r, open, p => weights.get(p.sku))
  }
  add(draw())
  const companion = COMPANIONS[lines[0].sku]
  if (companion && weights.get(companion[0]) > 0 && r() < companion[1]) add(BY_SKU.get(companion[0]))
  if (r() < 0.35) {
    add(draw())
    if (r() < 0.3) add(draw())
  }
  const totalCents = lines.reduce((sum, l) => sum + l.unitCents * l.qty, 0)

  const refundFactor = Math.max(...lines.map(l => BY_SKU.get(l.sku).refund ?? 1))
  let refund = null
  if (r() < refundRate * refundFactor) {
    const full = lines.length === 1 || r() < 0.7
    let refundDate = addDays(date, 1 + Math.floor(r() * 10))
    if (lastDay && refundDate > lastDay) refundDate = lastDay
    refund = {
      date: refundDate,
      cents: full ? totalCents : lines[0].unitCents * lines[0].qty,
      full,
    }
  }

  return {
    number,
    date,
    country: country.code,
    buyer: { first, last, email },
    address: { line1: street, city: place.city, state: place.state, postal: place.postal },
    lines,
    totalCents,
    refund,
  }
}

export function generateOrders({ from = DEFAULT_FROM, to = DEFAULT_TO, total, refundRate, lastDay = to } = {}) {
  const days = dayRange(from, to)
  const counts = dayCounts(days, total ?? defaultTotal(days.length))
  const orders = []
  days.forEach((date, i) => {
    for (let k = 1; k <= counts[i]; k++) orders.push(makeOrder(orderNumber(date, k), date, { refundRate, lastDay }))
  })
  return orders
}

/** The order to seed in: newest day first (so the latest week fills first), each day in number order. */
export function seedingQueue(orders, { oldestFirst = false } = {}) {
  const days = [...new Set(orders.map(o => o.date))].sort()
  if (!oldestFirst) days.reverse()
  const byDay = Map.groupBy(orders, o => o.date)
  return days.flatMap(d => byDay.get(d))
}

export const usd = cents => ({ currency_code: 'USD', value: (cents / 100).toFixed(2) })

export function invoiceBody(order) {
  const address = {
    address_line_1: order.address.line1,
    admin_area_2: order.address.city,
    postal_code: order.address.postal,
    country_code: order.country,
  }
  if (order.address.state) address.admin_area_1 = order.address.state
  return {
    detail: {
      invoice_number: order.number,
      reference: order.number,
      invoice_date: order.date,
      currency_code: 'USD',
      payment_term: { term_type: 'DUE_ON_RECEIPT' },
      memo: orderMemo(order),
    },
    primary_recipients: [{
      billing_info: {
        name: { given_name: order.buyer.first, surname: order.buyer.last },
        email_address: order.buyer.email,
        address,
      },
    }],
    items: order.lines.map(l => ({
      name: l.name,
      description: `SKU ${l.sku}`,
      quantity: String(l.qty),
      unit_amount: usd(l.unitCents),
      unit_of_measure: 'QUANTITY',
    })),
  }
}

export function paymentBody(order, method = 'PAYPAL') {
  return { method, payment_date: order.date, amount: usd(order.totalCents) }
}

export function refundBody(order, method = 'PAYPAL') {
  return { method, refund_date: order.refund.date, amount: usd(order.refund.cents) }
}

/** Order count, AOV, country and product shares, refunds — for a dry run and the tests. */
export function summarizeOrders(orders) {
  const byCountry = {}
  const bySku = {}
  let cents = 0
  let refunds = 0
  for (const o of orders) {
    cents += o.totalCents
    byCountry[o.country] = (byCountry[o.country] || 0) + 1
    for (const l of o.lines) bySku[l.sku] = (bySku[l.sku] || 0) + l.unitCents * l.qty
    if (o.refund) refunds += 1
  }
  return {
    orders: orders.length,
    revenueCents: cents,
    aovCents: orders.length ? Math.round(cents / orders.length) : 0,
    byCountry,
    bySku,
    refunds,
    requests: orders.length * 3 + refunds,
  }
}
