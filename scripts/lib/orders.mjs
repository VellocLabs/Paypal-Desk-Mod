/**
 * The sandbox store's order runs (how many orders on which day) and the
 * PayPal Invoicing request bodies that record each order as a paid sale on
 * its own date. One order's content comes from `lib/orders.js`.
 *
 * Contract: amounts are integer cents internally and two-decimal USD strings
 * in request bodies; dates are YYYY-MM-DD.
 */
import { addDays, dayRange, isDate } from '../../lib/dates.js'
import { orderMemo, parseOrderMemo } from '../../lib/memo.js'
import { DEFAULT_REFUND_RATE, eventsOn, makeOrder, orderNumber, productWeights, rng } from '../../lib/orders.js'

export { addDays, dayRange, isDate, orderMemo, parseOrderMemo }
export { DEFAULT_REFUND_RATE, eventsOn, makeOrder, orderNumber, productWeights, rng }

export const DEFAULT_FROM = '2026-10-01'
export const DEFAULT_TO = '2026-11-07'
export const DEFAULT_TOTAL = 2500

// Sunday … Saturday: weekend orders run a little higher.
const WEEKDAY = [1.1, 1.0, 0.97, 0.98, 1.0, 1.05, 1.12]


export function defaultTotal(dayCount) {
  return Math.round((DEFAULT_TOTAL * dayCount) / dayRange(DEFAULT_FROM, DEFAULT_TO).length)
}

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
    requests: orders.length * 3,
  }
}
