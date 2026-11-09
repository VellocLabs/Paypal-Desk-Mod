/**
 * Alert rules checked against the store's orders, and the board's alert
 * cards. Pure: no I/O.
 *
 * Contract: a rule is {id, name, metric, scope?, sku?, country?, above?,
 * below?, riseAbove?, dropAbove?, minOrders?}. `metric` is `refund_rate`
 * (percent of sales refunded), `net_sales` (dollars, refunds taken off),
 * `orders`, `units` or `aov` (dollars). `scope` is `store` (default),
 * `product` with `sku`, `any_product`, or `country` with `country` (ISO
 * code). `above` / `below` bound this week's value in the metric's unit;
 * `riseAbove` / `dropAbove` bound its change on the week before, in points
 * for `refund_rate` and in percent otherwise. A rule trips when any bound
 * does. The week is the 7 days ending yesterday, against the 7 before.
 */
import { CATALOG } from './catalog.js'
import { addDays, shortDate } from './dates.js'
import { lineCents } from './sales.js'

const BY_SKU = new Map(CATALOG.map(p => [p.sku, p]))
const nameOf = sku => (BY_SKU.get(sku) ? BY_SKU.get(sku).name : sku)
const round1 = x => Math.round(x * 10) / 10

export const METRICS = {
  refund_rate: { name: 'refund rate', better: 'down', unit: 'pct' },
  net_sales: { name: 'net sales', better: 'up', unit: 'usd' },
  orders: { name: 'orders', better: 'up', unit: 'count' },
  units: { name: 'units sold', better: 'up', unit: 'count' },
  aov: { name: 'average order value', better: 'up', unit: 'usd' },
}
const SCOPES = new Set(['store', 'product', 'any_product', 'country'])
const COUNTRY_NAMES = { US: 'United States', CA: 'Canada', GB: 'United Kingdom', AU: 'Australia', DE: 'Germany', FR: 'France', JP: 'Japan', NL: 'Netherlands' }
/** A product needs this many orders in the week before its refund rate counts. */
export const MIN_ORDERS = 10

/** The rules the desk checks while the person has written none: a jump in the store's refund rate. */
export const DEFAULT_RULES = [
  { id: 'refund-jump', name: 'Refund rate jump', metric: 'refund_rate', riseAbove: 1.5, source: 'default' },
]

/** Per-window figures: the store's, and each product's. */
function figures(orders, from, to) {
  const inside = d => d >= from && d <= to
  const blank = () => ({ gross: 0, refundCents: 0, orders: 0, units: 0 })
  const store = blank()
  const bySku = new Map()
  const sku = key => bySku.get(key) ?? bySku.set(key, blank()).get(key)
  for (const o of orders) {
    const shares = lineCents(o)
    if (inside(o.date)) {
      store.orders += 1
      store.gross += o.cents
      o.items.forEach(([key, qty], i) => {
        const p = sku(key)
        p.orders += 1
        p.units += qty
        p.gross += shares[i]
        store.units += qty
      })
    }
    if (!o.refund || !inside(o.refund.date)) continue
    store.refundCents += o.refund.cents
    if (o.refund.sku) sku(o.refund.sku).refundCents += o.refund.cents
    else o.items.forEach(([key], i) => { sku(key).refundCents += shares[i] })
  }
  return { store, bySku }
}

function valueOf(metric, f) {
  switch (metric) {
    case 'refund_rate': return f.gross ? (100 * f.refundCents) / f.gross : 0
    case 'net_sales': return (f.gross - f.refundCents) / 100
    case 'orders': return f.orders
    case 'units': return f.units
    case 'aov': return f.orders ? f.gross / f.orders / 100 : 0
    default: return 0
  }
}

/** The change from `before` to `now`: points for a rate, percent otherwise; null with nothing before. */
function changeOf(metric, now, before) {
  if (metric === 'refund_rate') return round1(now - before)
  return before ? round1((now / before - 1) * 100) : null
}

function valueText(metric, v) {
  const unit = METRICS[metric].unit
  if (unit === 'pct') return `${round1(v).toFixed(1)}%`
  if (unit === 'usd') return `$${Math.round(v).toLocaleString('en-US')}`
  return Math.round(v).toLocaleString('en-US')
}

function changeText(metric, c) {
  if (c === null) return 'new this week'
  const sign = c > 0 ? '+' : c < 0 ? '-' : '±'
  return `${sign}${Math.abs(c).toFixed(1)}${metric === 'refund_rate' ? ' pts' : '%'}`
}

function boundText(metric, key, n) {
  const pts = metric === 'refund_rate'
  switch (key) {
    case 'above': return `above ${valueText(metric, n)}`
    case 'below': return `below ${valueText(metric, n)}`
    case 'riseAbove': return `up more than ${n}${pts ? ' pts' : '%'}`
    case 'dropAbove': return `down more than ${n}${pts ? ' pts' : '%'}`
    default: return ''
  }
}

const BOUNDS = ['above', 'below', 'riseAbove', 'dropAbove']

function trips(bounds, value, change) {
  return bounds.some(([key, n]) =>
    key === 'above' ? value > n
      : key === 'below' ? value < n
        : key === 'riseAbove' ? change !== null && change > n
          : change !== null && -change > n)
}

/** Whose figure a scope reads, as a sentence subject. */
function subjectOf(rule) {
  switch (rule.scope) {
    case 'product': return nameOf(rule.sku)
    case 'any_product': return 'Any product'
    case 'country': return COUNTRY_NAMES[rule.country] || rule.country
    default: return 'Store'
  }
}

/** A rule as one line: "Any product: refund rate above 10.0% or up more than 5 pts". */
export function ruleText(rule) {
  const metric = METRICS[rule.metric]
  const bounds = BOUNDS.filter(k => Number.isFinite(rule[k])).map(k => boundText(rule.metric, k, rule[k]))
  return `${subjectOf(rule)}: ${metric.name} ${bounds.join(' or ')}`
}

function understood(rule) {
  if (!METRICS[rule.metric] || !BOUNDS.some(k => Number.isFinite(rule[k]))) return false
  const scope = rule.scope || 'store'
  if (!SCOPES.has(scope)) return false
  if (scope === 'product') return typeof rule.sku === 'string' && BY_SKU.has(rule.sku)
  if (scope === 'country') return typeof rule.country === 'string' && rule.country.length === 2
  if (rule.metric === 'aov' && scope !== 'store' && scope !== 'country') return false
  return true
}

/**
 * Each rule checked against the week: {id, name, source, understood,
 * tripped, rule, subject, value, delta, trend, better, reading, week}.
 * `subject` names the figure shown (for `any_product`, the product that
 * trips it, or the one nearest to); `reading` is the figure as a sentence.
 */
export function checkRules(rules, orders, today) {
  const end = addDays(today, -1)
  const week = [addDays(end, -6), end]
  const before = [addDays(end, -13), addDays(end, -7)]
  const all = { now: figures(orders, ...week), prior: figures(orders, ...before) }
  const byCountry = new Map()
  const countryFigures = code => byCountry.get(code) ?? byCountry.set(code, (() => {
    const mine = orders.filter(o => o.country === code)
    return { now: figures(mine, ...week), prior: figures(mine, ...before) }
  })()).get(code)
  const weekText = `${week[0]}..${week[1]}`

  return (Array.isArray(rules) ? rules : []).filter(r => r && typeof r === 'object' && r.id).map(r => {
    const base = { id: String(r.id), name: String(r.name || r.id), source: r.source === 'default' ? 'default' : 'rule', week: weekText }
    if (!understood(r)) {
      return { ...base, understood: false, tripped: false, rule: 'Not a rule this desk can check', subject: '', value: '', delta: '', trend: 'flat', better: 'up', reading: '' }
    }
    const metric = r.metric
    const scope = r.scope || 'store'
    const bounds = BOUNDS.filter(k => Number.isFinite(r[k])).map(k => [k, r[k]])
    const candidates = []
    if (scope === 'store' || scope === 'country') {
      const f = scope === 'store' ? all : countryFigures(r.country)
      candidates.push({ label: scope === 'store' ? 'Last 7 days' : `${subjectOf(r)}, last 7 days`, now: f.now.store, prior: f.prior.store })
    } else {
      const minOrders = Number.isFinite(r.minOrders) ? r.minOrders : MIN_ORDERS
      const skus = scope === 'product' ? [r.sku] : [...new Set([...all.now.bySku.keys(), ...all.prior.bySku.keys()])]
      for (const sku of skus) {
        const now = all.now.bySku.get(sku) || { gross: 0, refundCents: 0, orders: 0, units: 0 }
        const prior = all.prior.bySku.get(sku) || { gross: 0, refundCents: 0, orders: 0, units: 0 }
        if (scope === 'any_product' && metric === 'refund_rate' && now.orders < minOrders) continue
        candidates.push({ label: nameOf(sku), now, prior })
      }
    }
    const rows = candidates.map(c => {
      const value = valueOf(metric, c.now)
      const change = changeOf(metric, value, valueOf(metric, c.prior))
      return { label: c.label, value, change, tripped: trips(bounds, value, change) }
    })
    // The figure shown: a tripped row first, then the one furthest toward the rule's bounds.
    const lowWatch = bounds.every(([k]) => k === 'below' || k === 'dropAbove')
    const pick = rows.sort((a, b) => (b.tripped - a.tripped) || (lowWatch ? a.value - b.value : b.value - a.value))[0]
    if (!pick) {
      return { ...base, understood: true, tripped: false, rule: ruleText(r), subject: 'No product with enough orders', value: '–', delta: '', trend: 'flat', better: METRICS[metric].better, reading: 'no product had enough orders this week' }
    }
    const delta = changeText(metric, pick.change)
    const trend = pick.change === null || Math.abs(pick.change) < (metric === 'refund_rate' ? 0.3 : 0.5) ? 'flat' : pick.change > 0 ? 'up' : 'down'
    const value = valueText(metric, pick.value)
    return {
      ...base,
      understood: true,
      tripped: pick.tripped,
      rule: ruleText(r),
      subject: pick.label,
      value,
      delta: pick.change === null ? delta : `${delta} vs week before`,
      trend,
      better: METRICS[metric].better,
      reading: `${scope === 'any_product' || scope === 'product' ? `${pick.label}: ` : ''}${METRICS[metric].name} ${value} over ${shortDate(week[0])} – ${shortDate(week[1])}, ${delta} on the week before`,
    }
  })
}

const DISPUTE_REASONS = {
  'merchandise or service not received': 'Item not received',
  'merchandise or service not as described': 'Item not as described',
  unauthorised: 'Unauthorized payment',
  unauthorized: 'Unauthorized payment',
  'credit not processed': 'Refund not received',
  'duplicate transaction': 'Charged twice',
  'incorrect amount': 'Wrong amount charged',
  'payment by other means': 'Paid another way',
  'canceled recurring billing': 'Canceled subscription billed',
  'problem with remittance': 'Problem with the payment',
}
const sentence = text => (text ? text[0].toUpperCase() + text.slice(1) : '')

/** How long resolved disputes stay on the board. */
export const RESOLVED_DAYS = 30

/**
 * Disputes as alert cards, open ones first: what the buyer claims, the
 * amount held, and what the merchant must do by when. Takes disputes as
 * `normalizeDisputes` gives them.
 */
export function disputeAlerts(disputes, now) {
  const DAY = 86_400_000
  return disputes
    .filter(d => d.id && (d.open || !d.created || now - Date.parse(d.created) < RESOLVED_DAYS * DAY))
    .map(d => {
      const due = d.respondBy ? Date.parse(d.respondBy) : NaN
      const daysLeft = Number.isFinite(due) ? Math.ceil((due - now) / DAY) : null
      const waitingOnMe = d.open && (d.status === 'WAITING_FOR_SELLER_RESPONSE' || d.status === 'OPEN' || d.status === '')
      const [status, tone] = !d.open ? ['Resolved', 'success']
        : waitingOnMe ? (daysLeft !== null && daysLeft <= 0 ? ['Response overdue', 'danger']
          : daysLeft !== null && daysLeft <= 3 ? [`Respond in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`, 'danger']
            : ['Needs your response', 'warning'])
          : d.status === 'WAITING_FOR_BUYER_RESPONSE' ? ['Waiting for buyer', 'info']
            : d.status === 'UNDER_REVIEW' ? ['PayPal reviewing', 'info']
              : [sentence(d.status.replace(/_/g, ' ').toLowerCase()), 'info']
      const stage = d.stage === 'chargeback' ? 'Chargeback' : d.stage === 'claim' ? 'Claim' : 'Dispute'
      const opened = d.created ? ` · opened ${shortDate(d.created.slice(0, 10))}` : ''
      return {
        id: d.id,
        open: d.open,
        tripped: d.open,
        title: DISPUTE_REASONS[d.reason] || sentence(d.reason) || 'Dispute',
        rule: `${stage} ${d.id}${opened}`,
        subject: d.open ? 'Held in dispute' : 'Disputed',
        value: d.amount,
        delta: d.open && d.respondBy ? `Respond by ${shortDate(d.respondBy.slice(0, 10))}` : '',
        trend: 'flat',
        better: 'up',
        status,
        tone,
        summary: `${stage} ${d.id}${opened}`,
        note: d.transactionId ? `On transaction ${d.transactionId}` : '',
        ask: `Work this case (dispute:${d.id}): the buyer says "${DISPUTE_REASONS[d.reason] || d.reason}", ${d.amount} is held.` +
          (d.respondBy ? ` Respond by ${d.respondBy.slice(0, 10)}.` : '') + ' What happened, and what should I answer?',
      }
    })
    .sort((a, b) => (b.open - a.open) || (toneRank(b.tone) - toneRank(a.tone)))
}

function toneRank(tone) {
  return tone === 'danger' ? 3 : tone === 'warning' ? 2 : tone === 'info' ? 1 : 0
}
