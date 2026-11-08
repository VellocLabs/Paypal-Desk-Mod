/**
 * The demo order generator: exact counts, dates inside the range, a stable
 * result per order number, a plausible basket and country mix, and request
 * bodies in the Invoicing API's shape.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CATALOG, COUNTRIES } from '../scripts/lib/catalog.mjs'
import {
  addDays, dayCounts, dayRange, defaultTotal, generateOrders, invoiceBody, makeOrder, orderMemo,
  parseOrderMemo, paymentBody, refundBody, seedingQueue, summarizeOrders,
} from '../scripts/lib/orders.mjs'

const LAST = '2026-11-07'
const full = generateOrders()

test('the catalog has 33 distinct products and the country shares add up to 100', () => {
  assert.equal(CATALOG.length, 33)
  assert.equal(new Set(CATALOG.map(p => p.sku)).size, 33)
  assert.equal(COUNTRIES.reduce((sum, c) => sum + c.share, 0), 100)
})

test('the default run is 2,500 orders from Oct 1 to Nov 7, every day has orders', () => {
  assert.equal(full.length, 2500)
  const days = new Set(full.map(o => o.date))
  assert.deepEqual([...days].sort(), dayRange('2026-10-01', '2026-11-07'))
  assert.equal(new Set(full.map(o => o.number)).size, 2500)
})

test('day counts sum to the total exactly and stay near the daily average', () => {
  const days = dayRange('2026-10-01', '2026-11-07')
  const counts = dayCounts(days, 2500)
  assert.equal(counts.reduce((a, b) => a + b, 0), 2500)
  for (const n of counts) assert.ok(n >= 45 && n <= 95, `day count ${n}`)
  const sale = days.map((d, i) => [d, counts[i]]).filter(([d]) => d >= '2026-10-09' && d <= '2026-10-11')
  const average = 2500 / days.length
  assert.ok(sale.reduce((a, [, n]) => a + n, 0) / sale.length > average * 1.15, 'the sale weekend stands out')
})

test('a single test day gets the pro-rata default or the count asked for', () => {
  assert.equal(defaultTotal(1), 66)
  const day = generateOrders({ from: '2026-09-25', to: '2026-09-25', total: 10 })
  assert.equal(day.length, 10)
  assert.ok(day.every(o => o.date === '2026-09-25'))
  assert.equal(day[0].number, 'PD-20260925-001')
})

test('an order is the same every time it is generated from its number', () => {
  assert.deepEqual(makeOrder('PD-20261015-007', '2026-10-15', { lastDay: LAST }), makeOrder('PD-20261015-007', '2026-10-15', { lastDay: LAST }))
})

test('the basket and country mix look like a small accessories store', () => {
  const s = summarizeOrders(full)
  assert.ok(s.aovCents >= 5500 && s.aovCents <= 8000, `AOV ${s.aovCents}`)
  assert.equal(Object.keys(s.bySku).length, 33)
  const share = code => s.byCountry[code] / s.orders
  assert.ok(Math.abs(share('US') - 0.6) < 0.04, `US ${share('US')}`)
  assert.ok(Math.abs(share('CA') - 0.16) < 0.03, `CA ${share('CA')}`)
  assert.ok(s.refunds > 50 && s.refunds < 160, `refunds ${s.refunds}`)
  for (const o of full) {
    assert.ok(o.lines.length >= 1 && o.lines.length <= 4)
    assert.equal(new Set(o.lines.map(l => l.sku)).size, o.lines.length)
  }
})

const unitsBy = orders => {
  const bySku = {}
  for (const o of orders) {
    for (const l of o.lines) {
      const row = (bySku[l.sku] ??= { units: 0, byCountry: {} })
      row.units += l.qty
      row.byCountry[o.country] = (row.byCountry[o.country] || 0) + l.qty
    }
  }
  return Object.entries(bySku).sort((a, b) => b[1].units - a[1].units)
}

test('sales follow a long tail: a few products sell most of the units', () => {
  const ranked = unitsBy(full)
  const units = ranked.reduce((a, [, r]) => a + r.units, 0)
  const top = k => ranked.slice(0, k).reduce((a, [, r]) => a + r.units, 0) / units
  assert.ok(top(3) > 0.25 && top(3) < 0.4, `top 3 ${top(3)}`)
  assert.ok(top(10) > 0.6 && top(10) < 0.78, `top 10 ${top(10)}`)
  assert.equal(ranked[0][0], 'CAB-C2C')
})

test('every best-selling product sells to the same country mix as the store', () => {
  for (const [sku, row] of unitsBy(full).slice(0, 10)) {
    const us = row.byCountry.US / row.units
    const ca = (row.byCountry.CA || 0) / row.units
    assert.ok(Math.abs(us - 0.6) < 0.07, `${sku} US ${us}`)
    assert.ok(Math.abs(ca - 0.16) < 0.06, `${sku} CA ${ca}`)
  }
})

test('every product sells in every week of the run', () => {
  for (let start = '2026-10-01'; start <= '2026-11-01'; start = addDays(start, 7)) {
    const week = full.filter(o => o.date >= start && o.date <= addDays(start, 6))
    const sold = new Set(week.flatMap(o => o.lines.map(l => l.sku)))
    assert.ok(sold.size >= 30, `week of ${start}: ${sold.size} products`)
  }
})

test('refunds fall after the order, never after the last day of the run, and never exceed what was paid', () => {
  for (const o of full.filter(x => x.refund)) {
    assert.ok(o.refund.date > o.date || o.refund.date === LAST, `${o.number} ${o.refund.date}`)
    assert.ok(o.refund.date <= LAST)
    assert.ok(o.refund.date <= addDays(o.date, 10))
    assert.ok(o.refund.cents > 0 && o.refund.cents <= o.totalCents)
  }
})

test('the request bodies carry the order date, the buyer country and the SKU per line', () => {
  const o = full.find(x => x.refund && x.lines.length > 1) ?? full[0]
  const body = invoiceBody(o)
  assert.equal(body.detail.invoice_number, o.number)
  assert.equal(body.detail.invoice_date, o.date)
  assert.equal(body.primary_recipients[0].billing_info.address.country_code, o.country)
  assert.match(body.primary_recipients[0].billing_info.email_address, /^[a-z.]+\d*@example\.com$/)
  assert.deepEqual(body.items.map(i => i.description), o.lines.map(l => `SKU ${l.sku}`))
  const itemCents = body.items.reduce((sum, i) => sum + Math.round(Number(i.unit_amount.value) * 100) * Number(i.quantity), 0)
  assert.equal(itemCents, o.totalCents)
  assert.deepEqual(paymentBody(o), { method: 'PAYPAL', payment_date: o.date, amount: { currency_code: 'USD', value: (o.totalCents / 100).toFixed(2) } })
  assert.equal(refundBody(o).refund_date, o.refund.date)
})

test('the memo carries country, lines and the planned refund, and reads back', () => {
  const o = full.find(x => x.refund && x.lines.length === 3)
  const memo = invoiceBody(o).detail.memo
  assert.ok(memo.length < 500)
  assert.deepEqual(parseOrderMemo(memo), {
    country: o.country,
    items: o.lines.map(l => ({ sku: l.sku, qty: l.qty })),
    refund: { date: o.refund.date, value: (o.refund.cents / 100).toFixed(2) },
  })
  const plain = full.find(x => !x.refund)
  assert.equal(parseOrderMemo(orderMemo(plain)).refund, null)
  assert.equal(parseOrderMemo('Seeded by paypal-desk for the sandbox.'), null)
  assert.equal(parseOrderMemo('paypal-desk demo | country=US | items=CAB-C2C*0'), null)
  assert.equal(parseOrderMemo(undefined), null)
})

test('seeding goes newest day first, each day in number order, every order once', () => {
  const queue = seedingQueue(full)
  assert.equal(queue.length, full.length)
  assert.deepEqual(new Set(queue), new Set(full))
  assert.equal(queue[0].number, 'PD-20261107-001')
  assert.equal(queue[queue.length - 1].date, '2026-10-01')
  for (let i = 1; i < queue.length; i++) {
    const [a, b] = [queue[i - 1], queue[i]]
    assert.ok(a.date > b.date || (a.date === b.date && a.number < b.number), `${a.number} then ${b.number}`)
  }
  assert.equal(seedingQueue(full, { oldestFirst: true })[0].number, 'PD-20261001-001')
})
