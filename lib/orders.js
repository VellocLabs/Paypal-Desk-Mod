/**
 * The demo store's order book: one order's content (country, buyer, lines,
 * refund) follows from its number alone, so the seeder and the dashboard
 * read the same order from `PD-YYYYMMDD-NNN`. Pure: no I/O.
 *
 * Contract: amounts are integer cents; dates are YYYY-MM-DD.
 */
import { CATALOG, CALENDAR, COMPANIONS, COUNTRIES } from './catalog.js'
import { addDays, isDate } from './dates.js'

export const DEFAULT_REFUND_RATE = 0.03

const ORDER_NUMBER = /^PD-(\d{4})(\d{2})(\d{2})-\d{3}$/

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

/** The store events running on `date`. */
export const eventsOn = date => CALENDAR.filter(e => e.from <= date && date <= e.to)

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


/** The order day a store order number carries; null for any other number. */
export function orderDateOf(number) {
  const m = ORDER_NUMBER.exec(String(number || ''))
  const date = m ? `${m[1]}-${m[2]}-${m[3]}` : ''
  return isDate(date) ? date : null
}
