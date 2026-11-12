/**
 * One product's own figures, day by day, for a tab the person asked for
 * ("a new product, show me its last month"). Pure: no I/O.
 *
 * Contract: orders as in `sales.js`; `sku` is a catalog SKU; the window is
 * `days` whole days ending yesterday, like every other window on the board.
 * A refund counts on the day it was made, against the product's sales.
 */
import { CATALOG } from './catalog.js'
import { addDays, dayRange, shortDate } from './dates.js'
import { lineCents } from './sales.js'

const BY_SKU = new Map(CATALOG.map(p => [p.sku, p]))
const round1 = x => Math.round(x * 10) / 10
const dollars = cents => cents / 100

/** The product's name, or the SKU when the catalog has no such product. */
export function productName(sku) {
  const p = BY_SKU.get(String(sku || ''))
  return p ? p.name : String(sku || '')
}

/** Whether a SKU the person named is one the store sells. */
export function isProduct(sku) {
  return BY_SKU.has(String(sku || ''))
}

/**
 * The product's last `days` days as {sku, name, from, to, series, kpis, note}:
 * `series` is `{label, units, sales}` a day, `kpis` the window's units, sales,
 * orders and refund rate with their change against the window before.
 */
export function productTrend(orders, { sku, days = 30, today }) {
  const id = String(sku || '')
  const span = Math.min(90, Math.max(7, Math.round(Number(days) || 30)))
  const to = addDays(today, -1)
  const from = addDays(to, -(span - 1))
  const beforeTo = addDays(from, -1)
  const beforeFrom = addDays(beforeTo, -(span - 1))
  const name = productName(id)

  const row = d => ({ label: shortDate(d), units: 0, sales: 0 })
  const byDay = new Map(dayRange(from, to).map(d => [d, row(d)]))
  const totals = { units: 0, sales: 0, orders: 0, refunds: 0, refundCents: 0 }
  const prior = { units: 0, sales: 0, orders: 0 }

  for (const o of orders || []) {
    const at = o.items.findIndex(([s]) => s === id)
    if (at === -1) continue
    const qty = o.items[at][1]
    const inWindow = o.date >= from && o.date <= to
    const inBefore = o.date >= beforeFrom && o.date <= beforeTo
    if (inBefore) { prior.units += qty; prior.sales += lineCents(o)[at] || 0; prior.orders += 1 }
    if (!inWindow) continue
    const day = byDay.get(o.date)
    if (day) { day.units += qty; day.sales += dollars(lineCents(o)[at] || 0) }
    totals.units += qty
    totals.sales += lineCents(o)[at] || 0
    totals.orders += 1
    if (o.refund && o.refund.date >= from && o.refund.date <= to) {
      totals.refunds += 1
      totals.refundCents += o.refund.sku === id || !o.refund.sku ? o.refund.cents : (lineCents(o)[at] || 0)
    }
  }

  const series = [...byDay.values()].map(d => ({ ...d, sales: Math.round(d.sales) }))
  const rate = totals.sales ? (100 * totals.refundCents) / totals.sales : 0
  const change = (now, was, unit) => {
    if (!was) return { trendValue: 'new', trend: 'up' }
    const pct = (100 * (now - was)) / was
    const text = unit === 'pct'
      ? `${pct > 0 ? '+' : ''}${round1(pct).toFixed(1)}%`
      : `${pct > 0 ? '+' : ''}${Math.round(pct)}%`
    return { trendValue: text, trend: pct >= 0.5 ? 'up' : pct <= -0.5 ? 'down' : 'flat' }
  }
  return {
    sku: id,
    name,
    from,
    to,
    days: span,
    series,
    kpis: {
      units: { label: 'Units', value: String(totals.units), ...change(totals.units, prior.units) },
      sales: { label: 'Sales', value: `$${Math.round(dollars(totals.sales)).toLocaleString('en-US')}`, ...change(totals.sales, prior.sales) },
      orders: { label: 'Orders', value: String(totals.orders), ...change(totals.orders, prior.orders) },
      refunds: { label: 'Refunded', value: `${round1(rate).toFixed(1)}%`, trend: 'flat' },
    },
    note: `${name} · ${shortDate(from)} – ${shortDate(to)} · ${totals.units} unit${totals.units === 1 ? '' : 's'}, $${Math.round(dollars(totals.sales)).toLocaleString('en-US')}`, 
    ask: `Analyze ${name} (${id}) over the last ${span} days: units, sales and refunds week by week. What changed, and should I keep selling it?`,
  }
}
