/**
 * The store's sales board, from the store orders read off the invoice list.
 * A store order is a paid invoice numbered `PD-YYYYMMDD-NNN`, or a payment
 * whose invoice id is such a number. For an invoice PayPal gives the amount,
 * status and date, and the store's order book (`orders.js`) the country,
 * lines, buyer and refund; for a payment PayPal also gives the refunds. Any
 * other invoice or payment is not a sale of the store. Pure: no I/O.
 *
 * Contract: an order is {id, number, date, country, items: [[sku, qty]],
 * cents, customer, buyer, refund: {date, cents, sku, reason} | null}
 * (`refund.sku` is the refunded line, null for every line; `buyer` is the
 * email, else the name); amounts are integer cents;
 * `today` is a `YYYY-MM-DD` date. The windows are whole days ending
 * yesterday: the last 7 days against the 7 before them, and the last 30.
 * Refunds count on the day they were made, and not before that day.
 */
import { CATALOG } from './catalog.js'
import { addDays, dateOf, dayLabel, dayRange, shortDate } from './dates.js'
import { makeOrder, orderDateOf } from './orders.js'

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

/** An invoice-list row's id, number and amount, from the MCP list's flat row or the REST API's nested one. */
export function invoiceRowFields(row) {
  const detail = (row && row.detail) || {}
  const amount = row && row.amount
  return {
    id: String((row && (row.invoice_id || row.id)) || ''),
    number: String((row && row.invoice_number) || detail.invoice_number || ''),
    value: Number((amount && typeof amount === 'object' ? amount.value : amount) || 0),
    currency: String((amount && typeof amount === 'object' ? amount.currency_code : row && row.currency_code) || detail.currency_code || ''),
  }
}

/**
 * One invoice-list row read as a store order. Answers null for a row that is
 * not a store order, and {id, order: null} for a store order that is not paid
 * (a draft, a cancelled or an unpaid invoice), so a cache can drop it.
 */
export function readStoreRow(row) {
  if (!row || typeof row !== 'object') return null
  const { id, number, value } = invoiceRowFields(row)
  const date = orderDateOf(number)
  if (!id || !date) return null
  const status = String(row.status || '').toUpperCase()
  if (!PAID.has(status)) return { id, order: null }
  const cents = Math.round(value * 100)
  const book = makeOrder(number, date)
  // A refund status the order book does not explain is a full refund on the order day.
  let refund = book.refund ? { date: book.refund.date, cents: Math.min(cents, book.refund.cents), sku: book.refund.sku, reason: book.refund.reason } : null
  if (!refund && status.includes('REFUND')) refund = { date, cents, sku: null, reason: null }
  return {
    id,
    order: {
      id,
      number,
      date,
      country: book.country,
      items: book.lines.map(l => [l.sku, l.qty]),
      cents,
      customer: `${book.buyer.first} ${book.buyer.last}`,
      buyer: book.buyer.email,
      refund,
    },
  }
}

/** The store's day of a Transaction Search time stamp; '' for none. */
const localDay = stamp => (Number.isFinite(Date.parse(stamp)) ? dateOf(Date.parse(stamp)) : '')

/** A Transaction Search event code for a refund or a reversal of a payment. */
const isRefundCode = code => /^T11/.test(code)

/**
 * The store's direct payments in Transaction Search rows: each completed
 * payment whose invoice id is a store order number is an order on the day it
 * was made, with its refunds (rows pointing back at it) on the days they were
 * made. Content comes from the order book by the number.
 */
export function paymentOrders(rows) {
  const infos = (Array.isArray(rows) ? rows : []).map(t => (t && t.transaction_info) || t || {})
  const orders = new Map()
  for (const info of infos) {
    const code = String(info.transaction_event_code || '')
    const number = String(info.invoice_id || info.custom_field || '')
    const bookDate = orderDateOf(number)
    const cents = Math.round(Number((info.transaction_amount && info.transaction_amount.value) || 0) * 100)
    const day = localDay(info.transaction_initiation_date)
    if (!bookDate || isRefundCode(code) || cents <= 0 || String(info.transaction_status || '') !== 'S' || !day) continue
    const book = makeOrder(number, bookDate)
    orders.set(String(info.transaction_id), {
      id: String(info.transaction_id),
      number,
      date: day,
      country: book.country,
      items: book.lines.map(l => [l.sku, l.qty]),
      cents,
      customer: `${book.buyer.first} ${book.buyer.last}`,
      buyer: book.buyer.email,
      refund: null,
    })
  }
  const byNumber = new Map([...orders.values()].map(o => [o.number, o]))
  for (const info of infos) {
    if (!isRefundCode(String(info.transaction_event_code || ''))) continue
    const order = orders.get(String(info.paypal_reference_id || '')) || byNumber.get(String(info.invoice_id || ''))
    if (!order) continue
    const cents = Math.abs(Math.round(Number((info.transaction_amount && info.transaction_amount.value) || 0) * 100))
    const day = localDay(info.transaction_initiation_date)
    const sum = Math.min(order.cents, (order.refund ? order.refund.cents : 0) + cents)
    const book = makeOrder(order.number, orderDateOf(order.number)).refund
    order.refund = {
      date: order.refund && order.refund.date > day ? order.refund.date : day,
      cents: sum,
      sku: book ? book.sku : null,
      reason: book ? book.reason : null,
    }
  }
  return [...orders.values()]
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
export const productName = sku => (BY_SKU.get(sku) || { name: sku }).name
const productShort = sku => (BY_SKU.get(sku) || { short: sku }).short

/** Pie slices in whole percent of sales, largest first and "Other" last; a share under half a percent is left out. */
function countryShares(t) {
  return COUNTRY_GROUPS
    .map(g => ({ key: g.key, label: g.label, value: t.gross ? Math.round((100 * t.byGroup[g.key]) / t.gross) : 0, color: g.color }))
    .filter(s => s.value > 0)
    .sort((a, b) => (a.key === 'other') - (b.key === 'other') || b.value - a.value)
    .map(({ label, value, color }) => ({ label, value, color }))
}

function rangeText(from, to) {
  return `${shortDate(from)} – ${shortDate(to)}, ${to.slice(0, 4)}`
}

function orderStatus(o, today) {
  if (!o.refund || o.refund.date > today) return 'Paid'
  return o.refund.cents >= o.cents ? 'Refunded' : 'Partly refunded'
}

function itemsText(o) {
  const [first, ...rest] = o.items
  const qty = first[1] > 1 ? ` ×${first[1]}` : ''
  return `${productShort(first[0])}${qty}${rest.length ? ` +${rest.length}` : ''}`
}

/** The newest orders by order date, then number; a refund shows from its day on. */
export function latestOrders(orders, today, n = LATEST_ORDERS) {
  return [...orders]
    .sort((a, b) => (a.date === b.date ? (a.number < b.number ? 1 : -1) : a.date < b.date ? 1 : -1))
    .slice(0, n)
    .map(o => ({ id: o.number, customer: o.customer, country: o.country, items: itemsText(o), total: dollars(o.cents, { decimals: 2 }), status: orderStatus(o, today) }))
}

/** This week's refund rate against the week before's, in points: a rise is 'up'; 0.3 points either way is flat. */
function weekRefundsKpi(week, before) {
  const rate = t => (t.gross ? (100 * t.refundCents) / t.gross : 0)
  const pts = Math.round((rate(week) - rate(before)) * 10) / 10
  const trend = !before.gross || Math.abs(pts) < 0.3 ? 'flat' : pts > 0 ? 'up' : 'down'
  return { label: 'Rate', value: percent(week.refundCents, week.gross), trendValue: before.gross ? `${pts > 0 ? '+' : ''}${pts.toFixed(1)} pts` : '', trend }
}

/** The figures the week's ask texts name, in the order the cards show them. */
const ASK_FIGURES = [
  { key: 'net', name: 'Net sales', subject: 'net sales', probe: 'which products, countries or days?' },
  { key: 'orders', name: 'Orders', subject: 'orders', probe: 'which products, countries or days?' },
  { key: 'aov', name: 'Avg order value', subject: 'average order value', probe: 'the product mix or basket size?' },
  { key: 'refunds', name: 'Refund rate', subject: 'the refund rate', probe: 'which products, countries or refund reasons?', unit: ' of sales' },
]

/**
 * The texts a card's or the week's "Ask AI" drafts in the composer: each names
 * the figure, the two windows and the change as the card shows it, and asks
 * what is behind it without calling the change good or bad.
 */
export function weekAsks(kpis, period, prior) {
  const against = prior ? ` against ${prior}` : ''
  const asks = {}
  for (const f of ASK_FIGURES) {
    const k = kpis[f.key]
    const moved = prior && k.trendValue ? `, ${k.trendValue}${against}` : ''
    asks[f.key] = `Analyze the change in ${f.subject}: ${k.value}${f.unit || ''} for ${period}${moved}. What's behind it — ${f.probe}`
  }
  const lines = ASK_FIGURES.map(f => {
    const k = kpis[f.key]
    return `- ${f.name}: ${k.value}${prior && k.trendValue ? ` (${k.trendValue})` : ''}`
  })
  asks.all = [`Analyze this week's changes, ${period}${against}:`, ...lines, 'What is behind each change, and are any of them connected?'].join('\n')
  return asks
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

  const weekKpis = {
    net: { label: 'Net', value: compactDollars(week.net), ...change(week.net, before.net) },
    orders: { label: 'Count', value: week.count.toLocaleString('en-US'), ...change(week.count, before.count) },
    aov: { label: 'AOV', value: dollars(week.aov, { decimals: 2 }), ...change(week.aov, before.aov) },
    refunds: weekRefundsKpi(week, before),
  }
  const prior = before.count ? `${shortDate(before.from)} – ${shortDate(before.to)}` : ''

  return {
    week: {
      range: before.count
        ? `${rangeText(week.from, week.to)} · compared with ${shortDate(before.from)} – ${shortDate(before.to)}`
        : rangeText(week.from, week.to),
      kpis: weekKpis,
      ask: weekAsks(weekKpis, rangeText(week.from, week.to), prior),
      refundsNote: `${week.refundCount} ${week.refundCount === 1 ? 'refund' : 'refunds'} · ${dollars(week.refundCents)}`,
      byCountry: countryShares(week),
      daily: [...week.daily].map(([d, cents]) => ({ label: dayLabel(d), value: Math.round(cents / 100) })),
      topProducts: week.products.sort(byCents).slice(0, TOP_PRODUCTS)
        .map(p => ({ product: productName(p.sku), units: String(p.units), sales: dollars(p.cents) })),
      latest: latestOrders(orders, today),
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
