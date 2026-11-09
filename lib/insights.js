/**
 * What the board says about the week in words, the refund breakdown the
 * agent analyzes, and the person's alert rules checked against it. Pure: no
 * I/O.
 *
 * Contract: orders as in `sales.js`; `today` is a `YYYY-MM-DD` date; the
 * windows are 7 whole days ending yesterday and the 7 before them. A refund
 * counts in the window it was made; a refund of a whole multi-line order
 * counts for each of its products.
 */
import { CATALOG } from './catalog.js'
import { addDays, shortDate } from './dates.js'
import { lineCents, windowTotals } from './sales.js'

const BY_SKU = new Map(CATALOG.map(p => [p.sku, p]))
const nameOf = sku => (BY_SKU.get(sku) ? BY_SKU.get(sku).name : sku)
const shortOf = sku => (BY_SKU.get(sku) ? BY_SKU.get(sku).short || BY_SKU.get(sku).name : sku)
const dollars = cents => `$${Math.round(cents / 100).toLocaleString('en-US')}`
const pct = (n, d) => (d ? (100 * n) / d : 0)
const round1 = x => Math.round(x * 10) / 10

/** The refund metric whose alert rules the module checks. */
export const REFUND_RATE = 'refund_rate'
/** How long the evidence list of refunded orders reaches back. */
const EVIDENCE_DAYS = 14
const EVIDENCE_ROWS = 80

/** Refunds over [from, to]: per product, per country, per reason, against the orders placed in it. */
export function refundStats(orders, from, to) {
  const inside = d => d >= from && d <= to
  const products = new Map()
  const countries = new Map()
  const reasons = new Map()
  const row = (map, key) => map.get(key) ?? map.set(key, { key, orders: 0, refunds: 0, refundCents: 0 }).get(key)
  let count = 0
  let gross = 0
  let refunds = 0
  let refundCents = 0
  for (const o of orders) {
    if (inside(o.date)) {
      count += 1
      gross += o.cents
      for (const [sku] of o.items) row(products, sku).orders += 1
      row(countries, o.country).orders += 1
    }
    if (!o.refund || !inside(o.refund.date)) continue
    refunds += 1
    refundCents += o.refund.cents
    const skus = o.refund.sku ? [o.refund.sku] : o.items.map(([sku]) => sku)
    const shares = lineCents(o)
    for (const sku of skus) {
      const r = row(products, sku)
      r.refunds += 1
      r.refundCents += o.refund.sku ? o.refund.cents : shares[o.items.findIndex(([s]) => s === sku)]
    }
    const c = row(countries, o.country)
    c.refunds += 1
    c.refundCents += o.refund.cents
    const why = row(reasons, o.refund.reason || 'Not given')
    why.refunds += 1
    why.refundCents += o.refund.cents
  }
  return { from, to, orders: count, gross, refunds, refundCents, rate: pct(refundCents, gross), products, countries, reasons }
}

/** The refund rate's change in points, with the trend arrow it earns (up is bad); 0.3 points either way is flat. */
export function rateChange(now, before) {
  const pts = round1(now - before)
  const text = `${pts > 0 ? '+' : ''}${pts.toFixed(1)} pts`
  return { pts, text, trend: Math.abs(pts) < 0.3 ? 'flat' : pts > 0 ? 'up' : 'down' }
}

/** The windows the board compares: this week (ending yesterday) and the week before. */
export function weekWindows(today) {
  const end = addDays(today, -1)
  return { week: [addDays(end, -6), end], before: [addDays(end, -13), addDays(end, -7)] }
}

/** The product that explains most of this week's refunds, if one does: {sku, refunds, orders, rate, reason, before}. */
export function refundDriver(stats, previous) {
  const top = [...stats.products.values()].sort((a, b) => b.refundCents - a.refundCents)[0]
  if (!top || top.refunds < 3 || top.refundCents < 0.3 * stats.refundCents) return null
  const reason = topReason(stats, top.key)
  const prior = previous.products.get(top.key)
  return {
    sku: top.key,
    refunds: top.refunds,
    orders: top.orders,
    rate: round1(pct(top.refunds, top.orders)),
    before: prior ? round1(pct(prior.refunds, prior.orders)) : 0,
    reason,
  }
}

function topReason(stats, sku) {
  return stats.topReasons ? stats.topReasons.get(sku) || null : null
}

/** Per product, the reason given most for its refunds over the window. */
export function reasonsByProduct(orders, from, to) {
  const counts = new Map()
  for (const o of orders) {
    if (!o.refund || o.refund.date < from || o.refund.date > to || !o.refund.reason) continue
    for (const sku of o.refund.sku ? [o.refund.sku] : o.items.map(([s]) => s)) {
      const m = counts.get(sku) ?? counts.set(sku, new Map()).get(sku)
      m.set(o.refund.reason, (m.get(o.refund.reason) || 0) + 1)
    }
  }
  return new Map([...counts].map(([sku, m]) => [sku, [...m].sort((a, b) => b[1] - a[1])[0][0]]))
}

/** This week and the one before as refund stats, each with its products' top reasons. */
export function refundWeeks(orders, today) {
  const { week, before } = weekWindows(today)
  const now = refundStats(orders, ...week)
  now.topReasons = reasonsByProduct(orders, ...week)
  const prior = refundStats(orders, ...before)
  prior.topReasons = reasonsByProduct(orders, ...before)
  return { now, prior }
}

/**
 * The week in a few plain sentences: net sales and orders against the week
 * before, the biggest product gain and fall, the refund rate and what
 * drives it.
 */
export function weeklyBrief(orders, today) {
  const { week, before } = weekWindows(today)
  const t = windowTotals(orders, ...week)
  const b = windowTotals(orders, ...before)
  if (!t.count) return 'No store orders in the last 7 days.'
  const parts = []
  const netChange = b.net ? pct(t.net - b.net, b.net) : 0
  const verb = !b.net ? 'were' : Math.abs(netChange) < 0.5 ? 'held at' : netChange > 0 ? `rose ${round1(netChange)}% to` : `fell ${round1(-netChange)}% to`
  parts.push(`Net sales ${verb} ${dollars(t.net)} on ${t.count.toLocaleString('en-US')} orders.`)

  const prior = new Map(b.products.map(p => [p.sku, p.cents]))
  const moves = t.products
    .map(p => ({ sku: p.sku, delta: p.cents - (prior.get(p.sku) || 0), before: prior.get(p.sku) || 0 }))
    .filter(m => m.before >= 20000)
  const up = [...moves].sort((a, c) => c.delta - a.delta)[0]
  const down = [...moves].sort((a, c) => a.delta - c.delta)[0]
  const move = m => `${shortOf(m.sku)} ${m.delta > 0 ? 'up' : 'down'} ${Math.abs(Math.round(pct(m.delta, m.before)))}%`
  const named = [up && up.delta > 0 ? move(up) : null, down && down.delta < 0 ? move(down) : null].filter(Boolean)
  if (named.length) parts.push(`${named.join(', ')}.`.replace(/^./, c => c.toUpperCase()))

  const { now, prior: last } = refundWeeks(orders, today)
  const change = rateChange(now.rate, last.rate)
  let refunds = `Refunds are ${round1(now.rate).toFixed(1)}% of sales (${change.text})`
  const driver = refundDriver(now, last)
  if (driver && change.pts >= 1) {
    refunds += `, led by the ${shortOf(driver.sku)}: ${driver.refunds} of ${driver.orders} orders refunded${driver.reason ? `, "${driver.reason}"` : ''}`
  }
  parts.push(`${refunds}.`)
  return parts.join(' ')
}

/**
 * The refund breakdown the agent reads to explain a change: four weekly
 * rates, this week's products, countries and reasons against the week
 * before, and the refunded orders of the last two weeks.
 */
export function refundBreakdown(orders, today) {
  const end = addDays(today, -1)
  const weeks = [3, 2, 1, 0].map(k => {
    const to = addDays(end, -7 * k)
    const from = addDays(to, -6)
    const s = refundStats(orders, from, to)
    return { from, to, orders: s.orders, sales: dollars(s.gross), refunds: s.refunds, refunded: dollars(s.refundCents), rate: `${round1(s.rate).toFixed(1)}%` }
  })
  const { now, prior } = refundWeeks(orders, today)
  const rows = (map, before, label) => [...map.values()]
    .filter(r => r.refunds > 0 || (before.get(r.key) && before.get(r.key).refunds > 0))
    .sort((a, b) => b.refundCents - a.refundCents)
    .slice(0, 10)
    .map(r => {
      const p = before.get(r.key) || { orders: 0, refunds: 0 }
      return {
        [label]: label === 'product' ? nameOf(r.key) : r.key,
        refunds: r.refunds,
        orders: r.orders,
        rate: `${round1(pct(r.refunds, r.orders)).toFixed(1)}%`,
        refundsWeekBefore: p.refunds,
        rateWeekBefore: `${round1(pct(p.refunds, p.orders)).toFixed(1)}%`,
        ...(label === 'product' && now.topReasons.get(r.key) ? { topReason: now.topReasons.get(r.key) } : {}),
      }
    })
  const from = addDays(end, -(EVIDENCE_DAYS - 1))
  const refunded = orders
    .filter(o => o.refund && o.refund.date >= from && o.refund.date <= end)
    .sort((a, b) => (a.refund.date < b.refund.date ? 1 : -1))
    .slice(0, EVIDENCE_ROWS)
    .map(o => ({
      order: o.number,
      ordered: o.date,
      refunded: o.refund.date,
      country: o.country,
      items: o.items.map(([sku, qty]) => `${nameOf(sku)}${qty > 1 ? ` ×${qty}` : ''}`).join(', '),
      product: o.refund.sku ? nameOf(o.refund.sku) : 'whole order',
      amount: `$${(o.refund.cents / 100).toFixed(2)}`,
      reason: o.refund.reason || 'Not given',
    }))
  const change = rateChange(now.rate, prior.rate)
  return {
    asOf: today,
    week: `${shortDate(now.from)} – ${shortDate(now.to)}`,
    weekBefore: `${shortDate(prior.from)} – ${shortDate(prior.to)}`,
    refundRate: `${round1(now.rate).toFixed(1)}%`,
    refundRateWeekBefore: `${round1(prior.rate).toFixed(1)}%`,
    change: change.text,
    weeks,
    products: rows(now.products, prior.products, 'product'),
    countries: rows(now.countries, prior.countries, 'country'),
    reasons: [...now.reasons.values()].sort((a, b) => b.refunds - a.refunds)
      .map(r => ({ reason: r.key, refunds: r.refunds, weekBefore: (prior.reasons.get(r.key) || { refunds: 0 }).refunds })),
    refundedOrders: refunded,
  }
}

/**
 * The person's alert rules checked against this week: each answers
 * {id, name, rule, status: 'tripped' | 'ok', reading}. A rule is
 * {id, name, metric: 'refund_rate', changeAbovePts?, rateAbovePct?}; a rule
 * of another metric, or with neither bound, is listed as not understood.
 */
export function checkAlerts(rules, orders, today) {
  const { now, prior } = refundWeeks(orders, today)
  const change = rateChange(now.rate, prior.rate)
  const reading = `${round1(now.rate).toFixed(1)}% of sales, ${change.text} on the week before`
  return (Array.isArray(rules) ? rules : []).filter(r => r && typeof r === 'object' && r.id).map(r => {
    const name = String(r.name || r.id)
    const bounds = []
    if (Number.isFinite(r.changeAbovePts)) bounds.push(`changes by more than ${r.changeAbovePts} pts`)
    if (Number.isFinite(r.rateAbovePct)) bounds.push(`goes above ${r.rateAbovePct}%`)
    if (r.metric !== REFUND_RATE || bounds.length === 0) {
      return { id: String(r.id), name, rule: 'Not a rule this desk can check', status: 'unknown', reading: '' }
    }
    const tripped = (Number.isFinite(r.changeAbovePts) && Math.abs(change.pts) > r.changeAbovePts) ||
      (Number.isFinite(r.rateAbovePct) && now.rate > r.rateAbovePct)
    return {
      id: String(r.id),
      name,
      rule: `Weekly refund rate ${bounds.join(' or ')}`,
      status: tripped ? 'tripped' : 'ok',
      reading,
      week: `${now.from}..${now.to}`,
    }
  })
}
