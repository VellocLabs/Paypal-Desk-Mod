/**
 * The store's products as the board's Products tab shows them: what each one
 * sold this week, what came back, its refund rate week by week, and whether a
 * refund rule of the person's has been broken. Pure: no I/O.
 *
 * Contract: orders as in `sales.js`; `today` is a `YYYY-MM-DD` date; the week
 * is the 7 days ending yesterday against the 7 before, as everywhere else.
 * A SKU's sales are its lines' share of each order's total, so a multi-product
 * order counts for each of its products.
 */
import { CATALOG } from './catalog.js'
import { addDays, dayRange, shortDate } from './dates.js'
import { lineCents } from './sales.js'

const BY_SKU = new Map(CATALOG.map(p => [p.sku, p]))
const round1 = x => Math.round(x * 10) / 10
const cents = c => Math.round(c)
const money = c => `$${Math.round(c / 100).toLocaleString('en-US')}`
/** The share of its sales a product must give back before it reads as at risk, when no rule says otherwise. */
export const RISK_RATE = 10
/** Orders a product needs in the week before its rate is trusted. */
export const RISK_MIN_ORDERS = 10
/** Rows the board carries: the whole state travels with every action, so the tail is left to asking the agent. */
export const MAX_ROWS = 20

/** One SKU over [from, to]: units, sales, orders, and the refunds made in it. */
function windowOf(sku, orders, from, to) {
  let units = 0
  let sales = 0
  let count = 0
  let refundCents = 0
  let refunds = 0
  for (const o of orders) {
    const at = o.items.findIndex(([s]) => s === sku)
    if (at === -1) continue
    const share = lineCents(o)[at] || 0
    if (o.date >= from && o.date <= to) {
      units += o.items[at][1]
      sales += share
      count += 1
    }
    if (o.refund && o.refund.date >= from && o.refund.date <= to) {
      // A refund of one line is that line's; one of the whole order is shared by value.
      const whole = !o.refund.sku
      refundCents += o.refund.sku === sku ? o.refund.cents : whole ? Math.round((o.refund.cents * share) / Math.max(1, o.cents)) : 0
      refunds += 1
    }
  }
  return { units, sales, orders: count, refundCents, refunds }
}

const rateOf = w => (w.sales ? (100 * w.refundCents) / w.sales : 0)

/** The product refund rules the person wrote, whichever of the two scopes they used. */
export function refundRules(alerts) {
  return (Array.isArray(alerts) ? alerts : []).filter(rule => rule && typeof rule === 'object'
    && rule.metric === 'refund_rate' && (rule.scope === 'product' || rule.scope === 'any_product')
    && (Number.isFinite(rule.above) || Number.isFinite(rule.riseAbove)))
}

/** Whether a week's figures break a rule: why, in words, or ''. */
export function breaksRule(rule, now, before) {
  const minOrders = Number.isFinite(rule.minOrders) ? rule.minOrders : RISK_MIN_ORDERS
  if (now.orders < minOrders) return ''
  const rate = rateOf(now)
  const was = rateOf(before)
  if (Number.isFinite(rule.above) && rate > rule.above) return `refund rate ${round1(rate).toFixed(1)}% above ${rule.above}%`
  if (Number.isFinite(rule.riseAbove) && now.sales && before.sales && rate - was > rule.riseAbove) {
    return `refund rate up ${round1(rate - was).toFixed(1)} pts`
  }
  return ''
}

/**
 * Every product the store sells, at risk first then by this week's sales, as
 * the Products tab draws them: `{range, ruleNote, ask, rows, kpis}`.
 */
export function productsBoard(orders, { today, alerts = [] } = {}) {
  const end = addDays(today, -1)
  const week = [addDays(end, -6), end]
  const before = [addDays(end, -13), addDays(end, -7)]
  const rules = refundRules(alerts)
  const weeks = Array.from({ length: 8 }, (_, i) => {
    const to = addDays(end, -7 * i)
    return [addDays(to, -6), to]
  })

  const figures = CATALOG.map(p => {
    const now = windowOf(p.sku, orders, ...week)
    const prior = windowOf(p.sku, orders, ...before)
    const mine = rules.filter(r => r.scope === 'any_product' || r.sku === p.sku)
    const reason = mine.map(rule => breaksRule(rule, now, prior)).find(Boolean) || ''
    return {
      p,
      now: { ...now, rate: rateOf(now) },
      prior: { ...prior, rate: rateOf(prior) },
      reason,
      atRisk: rules.length ? Boolean(reason) : now.orders >= RISK_MIN_ORDERS && rateOf(now) > RISK_RATE,
      spark: weeks.slice().reverse().map(([from, to]) => ({ label: shortDate(from), rate: round1(rateOf(windowOf(p.sku, orders, from, to))) })),
    }
  }).sort((a, b) => (b.atRisk - a.atRisk) || (b.now.sales - a.now.sales))

  const shown = figures.slice(0, MAX_ROWS)
  const rows = shown.map(({ p, now, prior, atRisk, reason, spark }) => ({
    sku: p.sku,
    product: p.name,
    atRisk,
    badges: atRisk ? [{ label: 'At risk', tone: 'danger' }] : [],
    rate: `${round1(now.rate).toFixed(1)}%`,
    rateNote: reason || (prior.sales ? `${now.rate >= prior.rate ? '+' : ''}${round1(now.rate - prior.rate).toFixed(1)} pts vs week before` : 'no sales the week before'),
    units: String(now.units),
    unitsNote: prior.units ? `${prior.units} the week before` : 'the week before had none',
    sales: money(now.sales),
    salesNote: prior.sales ? `${money(prior.sales)} the week before` : 'the week before had none',
    spark,
  }))

  const risky = figures.filter(f => f.atRisk)
  const refunded = figures.reduce((sum, f) => sum + f.now.refundCents, 0)
  const refundsLast = figures.reduce((sum, f) => sum + f.prior.refundCents, 0)
  const salesAtRisk = risky.reduce((sum, f) => sum + f.now.sales, 0)
  const change = refundsLast ? (100 * (refunded - refundsLast)) / refundsLast : null

  return {
    range: `${shortDate(week[0])} – ${shortDate(week[1])} · compared with ${shortDate(before[0])} – ${shortDate(before[1])}`,
    ruleNote: [
      figures.length > rows.length ? `${rows.length} of ${figures.length} products, at risk first` : `${rows.length} products`,
      rules.length ? 'at risk when one of your refund rules is met' : `at risk above ${RISK_RATE}% refunded on ${RISK_MIN_ORDERS}+ orders, no product rule set`,
    ].join(' · '),
    ask: `Analyze this week's products: which ones are at risk, why, and what should I do about them? ${figures.length} products were sold.`,
    rows,
    kpis: {
      atRisk: { label: 'At risk', value: String(risky.length), caption: risky.length ? risky.slice(0, 2).map(f => f.p.name).join(', ') : 'none this week' },
      refunds: {
        label: 'Refunded',
        value: money(refunded),
        trendValue: change === null ? '' : `${change > 0 ? '+' : ''}${Math.round(change)}%`,
        trend: change === null || Math.abs(change) < 0.5 ? 'flat' : change > 0 ? 'up' : 'down',
        caption: refundsLast ? `${money(refundsLast)} the week before` : 'no refunds the week before',
      },
      salesAtRisk: { label: 'Sales', value: money(salesAtRisk), caption: risky.length ? 'of products at risk' : 'nothing at risk' },
    },
  }
}
