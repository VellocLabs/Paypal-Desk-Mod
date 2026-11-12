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
 *
 * A formula rule is {id, name, when, show?, unit?, better?, each?, sku?,
 * country?, text?} instead: `when` is a true/false formula (lib/formula.js)
 * and `show` the number on the card, in `unit` (`count`, `usd`, `pct`).
 * `each` is `store` (default), `product` (every product sold in the cached
 * days, or just `sku`) or `country` (every country, or just `country`); the
 * rule trips when `when` holds for any of them. `better` is the direction
 * of `show` that is good (default `up`); `text` says the rule in words.
 */
import { CATALOG } from './catalog.js'
import { addDays, shortDate } from './dates.js'
import { lineCents } from './sales.js'
import { evaluate, figureOf, FormulaError, isTest, LOOKBACK_DAYS, parseFormula } from './formula.js'

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

const OWNERS = { store: "The store's", any_product: "Any product's" }

/**
 * A rule as the sentence a rule card shows: "The store's refund rate rises
 * more than 1.5 pts week over week."
 */
export function conditionText(rule) {
  const scope = rule.scope || 'store'
  const owner = scope === 'product' ? `${nameOf(rule.sku)}'s`
    : scope === 'country' ? `${COUNTRY_NAMES[rule.country] || rule.country}'s`
      : OWNERS[scope]
  const by = n => `${n}${rule.metric === 'refund_rate' ? ' pts' : '%'}`
  const many = ['net_sales', 'orders', 'units'].includes(rule.metric)
  const [is, rises, falls] = many ? ['are', 'rise', 'fall'] : ['is', 'rises', 'falls']
  const parts = BOUNDS.filter(k => Number.isFinite(rule[k])).map(k =>
    k === 'above' ? `${is} above ${valueText(rule.metric, rule[k])} over the last 7 days`
      : k === 'below' ? `${is} below ${valueText(rule.metric, rule[k])} over the last 7 days`
        : k === 'riseAbove' ? `${rises} more than ${by(rule[k])} week over week`
          : `${falls} more than ${by(rule[k])} week over week`)
  return `${owner} ${METRICS[rule.metric].name} ${parts.join(' or ')}.`
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

  const formulas = formulaReader(orders, end)
  return (Array.isArray(rules) ? rules : []).filter(r => r && typeof r === 'object' && r.id).map(r => {
    const base = { id: String(r.id), name: String(r.name || r.id), source: 'rule', week: weekText, spec: r }
    if (r.when !== undefined) {
      const f = checkFormula(r, formulas, week)
      return { ...base, ...f, condition: f.rule, headline: f.reading }
    }
    if (!understood(r)) {
      return { ...base, understood: false, tripped: false, rule: 'Not a rule this desk can check', condition: 'Not a rule this desk can check.', headline: '', subject: '', value: '', delta: '', trend: 'flat', better: 'up', reading: '' }
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
      return { ...base, understood: true, tripped: false, rule: ruleText(r), condition: conditionText(r), headline: '', subject: 'No product with enough orders', value: '–', delta: '', trend: 'flat', better: METRICS[metric].better, reading: 'no product had enough orders this week' }
    }
    const delta = changeText(metric, pick.change)
    const trend = pick.change === null || Math.abs(pick.change) < (metric === 'refund_rate' ? 0.3 : 0.5) ? 'flat' : pick.change > 0 ? 'up' : 'down'
    const value = valueText(metric, pick.value)
    return {
      ...base,
      understood: true,
      tripped: pick.tripped,
      rule: ruleText(r),
      condition: conditionText(r),
      headline: `${scope === 'any_product' || scope === 'product' ? `${pick.label}: ` : ''}${sentence(METRICS[metric].name)} ${trend === 'up' ? 'rose to' : trend === 'down' ? 'fell to' : 'is at'} ${value}${pick.change === null ? '' : ` (${delta})`}`,
      subject: pick.label,
      value,
      delta: pick.change === null ? delta : `${delta} vs week before`,
      trend,
      better: METRICS[metric].better,
      reading: `${scope === 'any_product' || scope === 'product' ? `${pick.label}: ` : ''}${METRICS[metric].name} ${value} over ${shortDate(week[0])} – ${shortDate(week[1])}, ${delta} on the week before`,
    }
  })
}

/** The figures of no orders at all, for a week a product did not sell in. */
const NO_FIGURES = { gross: 0, refundCents: 0, orders: 0, units: 0 }

/** The catalog SKU a product is named by in an alert's subject, or ''. */
const unitTitle = unit => (unit === 'usd' ? 'Dollars' : unit === 'pct' ? 'Percent' : 'Count')
const unitSuffix = unit => (unit === 'usd' ? ' ($)' : unit === 'pct' ? ' (%)' : '')

function skuNamed(subject) {
  const text = String(subject || '').trim().toLowerCase()
  if (!text) return ''
  const hit = CATALOG.find(p => p.name.toLowerCase() === text || (p.short || '').toLowerCase() === text)
  return hit ? hit.sku : ''
}

/**
 * An alert's own figure week by week, oldest first, for its details view:
 * {title, note, series: [{label, value}], weeks}. The last entry is the week
 * the rule is checked over. Null when the rule cannot be read, or follows one
 * product that cannot be named.
 */
export function alertSeries(spec, orders, today, { subject = '', weeks = 8 } = {}) {
  if (!spec || typeof spec !== 'object') return null
  const end = addDays(today, -1)
  const span = Math.max(2, Math.min(12, Math.round(Number(weeks) || 8)))
  if (spec.when !== undefined) {
    let show
    try {
      show = spec.show ? parseFormula(spec.show) : null
    } catch {
      return null
    }
    if (!show) return null
    const each = spec.each || 'store'
    if (!EACH[each]) return null
    const formulas = formulaReader(orders, end)
    const id = each === 'product' ? skuNamed(subject) || spec.sku || formulas.skus()[0]
      : each === 'country' ? spec.country || formulas.countries()[0] : ''
    if (each !== 'store' && !id) return null
    const read = formulas.read({ kind: each, id })
    const series = []
    for (let k = span - 1; k >= 0; k--) {
      const to = addDays(end, -7 * k)
      series.push({ label: shortDate(addDays(to, -6)), value: round1(Number(evaluate(show, read, 7 * k)) || 0) })
    }
    const who = each === 'store' ? 'store' : each === 'product' ? nameOf(id) : COUNTRY_NAMES[id] || id
    return { title: `${unitTitle(spec.unit)} · ${who}`, note: 'What the rule shows, week by week', series }
  }
  if (!understood(spec)) return null
  const metric = spec.metric
  const scope = spec.scope || 'store'
  let pool = orders
  let read
  if (scope === 'country') {
    pool = orders.filter(o => o.country === spec.country)
    read = f => f.store
  } else if (scope === 'product' || scope === 'any_product') {
    const sku = spec.sku || skuNamed(subject)
    if (!sku) return null
    read = f => f.bySku.get(sku) || NO_FIGURES
  } else {
    read = f => f.store
  }
  const series = []
  for (let k = span - 1; k >= 0; k--) {
    const to = addDays(end, -7 * k)
    series.push({ label: shortDate(addDays(to, -6)), value: round1(valueOf(metric, read(figures(pool, addDays(to, -6), to)))) })
  }
  return { title: `${sentence(METRICS[metric].name)}${unitSuffix(METRICS[metric].unit)}${scope === 'store' ? '' : ` · ${subject || spec.sku || spec.country || ''}`}`.trim(), note: 'The rule\'s own figure, week by week', series }
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

const UNITS = new Set(['count', 'usd', 'pct'])
const EACH = { store: 'Store', product: 'Any product', country: 'Any country' }

function unitText(unit, v) {
  if (unit === 'pct') return `${round1(v).toFixed(1)}%`
  if (unit === 'usd') return `$${Math.round(v).toLocaleString('en-US')}`
  return (Number.isInteger(v) ? v : round1(v)).toLocaleString('en-US')
}

/** Figures over any window ending yesterday, for the store, a product or a country; cached per window. */
function formulaReader(orders, end) {
  const cache = new Map()
  const countryOrders = new Map()
  const totals = (scope, from, to) => {
    const key = `${scope.kind}:${scope.id || ''}:${from}:${to}`
    if (!cache.has(key)) {
      if (scope.kind === 'country' && !countryOrders.has(scope.id)) countryOrders.set(scope.id, orders.filter(o => o.country === scope.id))
      const f = figures(scope.kind === 'country' ? countryOrders.get(scope.id) : orders, from, to)
      cache.set(key, scope.kind === 'product' ? f.bySku.get(scope.id) || { gross: 0, refundCents: 0, orders: 0, units: 0 } : f.store)
    }
    return cache.get(key)
  }
  const span = [addDays(end, -(LOOKBACK_DAYS - 1)), end]
  return {
    read: scope => (name, back, upTo) => figureOf(name, totals(scope, addDays(end, -back), addDays(end, -upTo))),
    skus: () => [...figures(orders, ...span).bySku.keys()],
    countries: () => [...new Set(orders.filter(o => o.date >= span[0] && o.country).map(o => o.country))].sort(),
  }
}

/** A formula rule checked: the card fields, or `understood: false` with what is wrong as its rule line. */
function checkFormula(r, formulas, week) {
  const each = r.each || 'store'
  const unit = UNITS.has(r.unit) ? r.unit : 'count'
  const better = r.better === 'down' ? 'down' : 'up'
  const fail = message => ({ understood: false, tripped: false, rule: message, subject: '', value: '', delta: '', trend: 'flat', better, reading: '' })
  let when
  let show = null
  try {
    when = parseFormula(r.when)
    if (!isTest(when)) throw new FormulaError('`when` must be a true/false test, e.g. units(week(0)) < 5')
    if (r.show !== undefined) {
      show = parseFormula(r.show)
      if (isTest(show)) throw new FormulaError('`show` must be a number, e.g. units(week(0))')
    }
  } catch (e) {
    if (e instanceof FormulaError) return fail(e.message)
    throw e
  }
  if (!EACH[each]) return fail('`each` is store, product or country')
  if (each === 'product' && r.sku !== undefined && !BY_SKU.has(r.sku)) return fail(`no product ${r.sku}`)
  const scopes = each === 'store' ? [{ kind: 'store', label: 'Store' }]
    : each === 'product' ? (r.sku ? [r.sku] : formulas.skus()).map(id => ({ kind: 'product', id, label: nameOf(id) }))
      : (r.country ? [r.country] : formulas.countries()).map(id => ({ kind: 'country', id, label: COUNTRY_NAMES[id] || id }))
  const rows = scopes.map(scope => {
    const read = formulas.read(scope)
    const value = show ? evaluate(show, read) : null
    return { label: scope.label, tripped: Boolean(evaluate(when, read)), value, prior: show ? evaluate(show, read, 7) : null }
  })
  const hits = rows.filter(row => row.tripped)
  const head = r.sku ? nameOf(r.sku) : r.country ? COUNTRY_NAMES[r.country] || r.country : EACH[each]
  const ruleLine = typeof r.text === 'string' && r.text.trim() ? r.text.trim() : `${head}: ${r.when}`
  // The figure shown: a tripped one first, then the one furthest the bad way.
  const pick = [...rows].sort((a, b) => (b.tripped - a.tripped) || (show ? (better === 'up' ? a.value - b.value : b.value - a.value) : 0))[0]
  if (!pick) return { understood: true, tripped: false, rule: ruleLine, subject: each === 'product' ? 'No product sold yet' : 'No country yet', value: '–', delta: '', trend: 'flat', better, reading: '' }
  const subject = hits.length > 1 ? `${pick.label} and ${hits.length - 1} more` : pick.label
  const value = show ? unitText(unit, pick.value) : hits.length ? `${hits.length} of ${rows.length}` : '–'
  const change = show ? (unit === 'pct' ? round1(pick.value - pick.prior) : pick.prior ? round1((pick.value / pick.prior - 1) * 100) : null) : null
  const delta = !show ? '' : change === null ? (pick.value ? 'new this week' : '') : `${change > 0 ? '+' : change < 0 ? '-' : '±'}${Math.abs(change).toFixed(1)}${unit === 'pct' ? ' pts' : '%'} vs week before`
  const trend = change === null || Math.abs(change) < 0.5 ? 'flat' : change > 0 ? 'up' : 'down'
  const said = ruleLine.replace(/^[^:]*:\s*/, '')
  return {
    understood: true,
    tripped: hits.length > 0,
    rule: ruleLine,
    subject,
    value,
    delta,
    trend,
    better,
    reading: `${subject}: ${said}${show ? ` (${value} over ${shortDate(week[0])} – ${shortDate(week[1])})` : ''}`,
  }
}
