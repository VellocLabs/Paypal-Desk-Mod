/**
 * The store's sales board, from the store orders read off the invoice list.
 * A store order is an invoice whose memo carries the store summary
 * (`memo.mjs`); any other invoice is not a sale of the store. Pure: no I/O.
 *
 * Contract: an order is {id, number, date, country, items: [[sku, qty]],
 * cents, customer, buyer, refund: {date, cents} | null} (`buyer` is the
 * email, else the name); amounts are integer cents;
 * `today` is a `YYYY-MM-DD` date. The windows are whole days ending
 * yesterday: the last 7 days against the 7 before them, and the last 30.
 * Refunds count on the day they were made.
 */
import { CATALOG } from './catalog.mjs'
import { addDays, dayLabel, dayRange, shortDate } from './dates.mjs'
import { parseOrderMemo } from './memo.mjs'

/** The country groups every chart uses, in this order; the rest is "Other". */
export const COUNTRY_GROUPS = [
  { key: 'US', label: 'United States', color: '#3b82f6' },
  { key: 'CA', label: 'Canada', color: '#8b5cf6' },
  { key: 'GB', label: 'United Kingdom', color: '#ec4899' },
  { key: 'AU', label: 'Australia', color: '#f59e0b' },
  { key: 'DE', label: 'Germany', color: '#10b981' },
  { key: 'other', label: 'Other', color: '#94a3b8' },
]
const GROUP_KEYS = new Set(COUNTRY_GROUPS.map(g => g.key))
const groupOf = country => (GROUP_KEYS.has(country) ? country : 'other')

export const TOP_PRODUCTS = 5
export const LATEST_ORDERS = 8
export const CHART_PRODUCTS = 10

const BY_SKU = new Map(CATALOG.map(p => [p.sku, p]))
const PAID = new Set(['PAID', 'MARKED_AS_PAID', 'PARTIALLY_PAID', 'REFUNDED', 'PARTIALLY_REFUNDED', 'MARKED_AS_REFUNDED'])

/**
 * One invoice-list row read as a store order. Answers null for a row that is
 * not a store order, and {id, order: null} for a store order that is not paid
 * (a draft, a cancelled or an unpaid invoice), so a cache can drop it.
 */
export function readStoreRow(row) {
  if (!row || typeof row !== 'object') return null
  const detail = row.detail || {}
  const memo = parseOrderMemo(detail.memo)
  if (!memo || !row.id) return null
  const status = String(row.status || '').toUpperCase()
  const date = String(detail.invoice_date || '').slice(0, 10)
  if (!PAID.has(status) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { id: row.id, order: null }
  const cents = Math.round(Number((row.amount && row.amount.value) || 0) * 100)
  let refund = null
  if (status.includes('REFUND')) {
    const planned = memo.refund
    refund = planned
      ? { date: planned.date, cents: Math.min(cents, Math.round(Number(planned.value) * 100)) }
      : { date, cents }
  }
  const billing = (((row.primary_recipients || [])[0] || {}).billing_info) || {}
  const name = billing.name ? [billing.name.given_name, billing.name.surname].filter(Boolean).join(' ') : ''
  return {
    id: row.id,
    order: {
      id: row.id,
      number: detail.invoice_number || row.id,
      date,
      country: memo.country,
      items: memo.items.map(i => [i.sku, i.qty]),
      cents,
      customer: name || billing.email_address || '',
      buyer: billing.email_address || name,
      refund,
    },
  }
}

/** Each line's share of the order total: the catalog price for a known SKU, the rest split by quantity over unknown ones. */
export function lineCents(order) {
  const known = order.items.map(([sku, qty]) => (BY_SKU.has(sku) ? Math.round(BY_SKU.get(sku).price * 100) * qty : null))
  const knownSum = known.reduce((sum, c) => sum + (c ?? 0), 0)
  const unknownQty = order.items.reduce((sum, [, qty], i) => sum + (known[i] === null ? qty : 0), 0)
  const rest = Math.max(0, order.cents - knownSum)
  return order.items.map(([, qty], i) => known[i] ?? (unknownQty ? Math.round((rest * qty) / unknownQty) : 0))
}

/** Totals over [from, to]: orders placed in it, refunds made in it. */
export function windowTotals(orders, from, to) {
  const inside = d => d >= from && d <= to
  const daily = new Map(dayRange(from, to).map(d => [d, 0]))
  const byGroup = Object.fromEntries(COUNTRY_GROUPS.map(g => [g.key, 0]))
  const bySku = new Map()
  const customers = new Set()
  let count = 0
  let gross = 0
  let units = 0
  let refundCount = 0
  let refundCents = 0
  for (const o of orders) {
    if (inside(o.date)) {
      count += 1
      gross += o.cents
      daily.set(o.date, daily.get(o.date) + o.cents)
      byGroup[groupOf(o.country)] += o.cents
      if (o.buyer) customers.add(o.buyer)
      const shares = lineCents(o)
      o.items.forEach(([sku, qty], i) => {
        const row = bySku.get(sku) ?? { sku, units: 0, cents: 0, byGroup: Object.fromEntries(COUNTRY_GROUPS.map(g => [g.key, 0])) }
        row.units += qty
        row.cents += shares[i]
        row.byGroup[groupOf(o.country)] += qty
        bySku.set(sku, row)
        units += qty
      })
    }
    if (o.refund && inside(o.refund.date)) {
      refundCount += 1
      refundCents += o.refund.cents
      daily.set(o.refund.date, daily.get(o.refund.date) - o.refund.cents)
    }
  }
  return {
    from, to, count, gross, units, refundCount, refundCents,
    net: gross - refundCents,
    aov: count ? Math.round(gross / count) : 0,
    customers: customers.size,
    daily, byGroup,
    products: [...bySku.values()],
  }
}

// ---- formatting ------------------------------------------------------------

export function dollars(cents, { decimals = 0 } = {}) {
  const sign = cents < 0 ? '-' : ''
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`
}

/** "$27.6K" from ten thousand dollars up, "$9,876" below. */
export function compactDollars(cents) {
  return Math.abs(cents) >= 1_000_000 ? `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100_000).toFixed(1)}K` : dollars(cents)
}

/** The change from `before` to `now` as a Metric delta and trend; blank and flat with nothing before. */
export function change(now, before) {
  if (!before) return { trendValue: '', trend: 'flat' }
  const pct = (now / before - 1) * 100
  const text = `${pct >= 0 ? '+' : '-'}${Math.abs(pct).toFixed(1)}%`
  return { trendValue: text, trend: pct >= 0.5 ? 'up' : pct <= -0.5 ? 'down' : 'flat' }
}

const percent = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : '0.0%')
const productName = sku => (BY_SKU.get(sku) || { name: sku }).name
const productShort = sku => (BY_SKU.get(sku) || { short: sku }).short

function countryShares(t) {
  return COUNTRY_GROUPS
    .map(g => ({ label: g.label, value: t.gross ? Math.round((1000 * t.byGroup[g.key]) / t.gross) / 10 : 0, color: g.color }))
    .filter(s => s.value > 0)
}

function rangeText(from, to) {
  return `${shortDate(from)} – ${shortDate(to)}, ${to.slice(0, 4)}`
}

function orderStatus(o) {
  if (!o.refund) return 'Paid'
  return o.refund.cents >= o.cents ? 'Refunded' : 'Partly refunded'
}

function itemsText(o) {
  const [first, ...rest] = o.items
  const qty = first[1] > 1 ? ` ×${first[1]}` : ''
  return `${productShort(first[0])}${qty}${rest.length ? ` +${rest.length}` : ''}`
}

/** The newest orders by order date, then number. */
export function latestOrders(orders, n = LATEST_ORDERS) {
  return [...orders]
    .sort((a, b) => (a.date === b.date ? (a.number < b.number ? 1 : -1) : a.date < b.date ? 1 : -1))
    .slice(0, n)
    .map(o => ({ id: o.number, customer: o.customer, country: o.country, items: itemsText(o), total: dollars(o.cents, { decimals: 2 }), status: orderStatus(o) }))
}

/** The board's two tabs and the note under them. */
export function salesBoard(orders, { today }) {
  const end = addDays(today, -1)
  const week = windowTotals(orders, addDays(end, -6), end)
  const before = windowTotals(orders, addDays(end, -13), addDays(end, -7))
  const month = windowTotals(orders, addDays(end, -29), end)

  const byCents = (a, b) => b.cents - a.cents || (a.sku < b.sku ? -1 : 1)
  const byUnits = (a, b) => b.units - a.units || byCents(a, b)
  const refundsKpi = t => ({ label: 'Rate', value: percent(t.refundCents, t.gross), trendValue: `${t.refundCount} refunds · ${dollars(t.refundCents)}`, trend: 'flat' })

  return {
    week: {
      range: before.count
        ? `${rangeText(week.from, week.to)} · compared with ${shortDate(before.from)} – ${shortDate(before.to)}`
        : rangeText(week.from, week.to),
      kpis: {
        net: { label: 'Net', value: compactDollars(week.net), ...change(week.net, before.net) },
        orders: { label: 'Count', value: week.count.toLocaleString('en-US'), ...change(week.count, before.count) },
        aov: { label: 'AOV', value: dollars(week.aov, { decimals: 2 }), ...change(week.aov, before.aov) },
        refunds: refundsKpi(week),
      },
      byCountry: countryShares(week),
      daily: [...week.daily].map(([d, cents]) => ({ label: dayLabel(d), value: Math.round(cents / 100) })),
      topProducts: week.products.sort(byCents).slice(0, TOP_PRODUCTS)
        .map(p => ({ product: productName(p.sku), units: String(p.units), sales: dollars(p.cents) })),
      latest: latestOrders(orders),
    },
    month: {
      range: `${rangeText(month.from, month.to)} · totals`,
      kpis: {
        net: { label: 'Net', value: compactDollars(month.net), trendValue: `${dollars(month.gross)} before refunds`, trend: 'flat' },
        orders: { label: 'Count', value: month.count.toLocaleString('en-US'), trendValue: `${month.customers.toLocaleString('en-US')} customers`, trend: 'flat' },
        aov: { label: 'AOV', value: dollars(month.aov, { decimals: 2 }), trendValue: `${month.units.toLocaleString('en-US')} units`, trend: 'flat' },
        refunds: refundsKpi(month),
      },
      byCountry: countryShares(month),
      productCountry: [...month.products].sort(byUnits).slice(0, CHART_PRODUCTS)
        .map(p => ({ label: productShort(p.sku), ...p.byGroup })),
      products: [...month.products].sort(byUnits)
        .map(p => ({ product: productName(p.sku), units: p.units, sales: dollars(p.cents), ...p.byGroup })),
    },
    salesNote: month.count || week.count
      ? 'Store orders are simulated demo data recorded in the PayPal sandbox.'
      : 'No store orders in the last 30 days.',
    refundShare: week.gross ? week.refundCents / week.gross : 0,
  }
}
