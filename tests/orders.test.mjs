/**
 * The demo order generator: exact counts, dates inside the range, a stable
 * result per order number, a plausible basket and country mix, and request
 * bodies in the Invoicing API's shape.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CATALOG, COUNTRIES } from '../scripts/lib/catalog.mjs'
import {
  addDays, dayCounts, dayRange, defaultTotal, generateOrders, invoiceBody, makeOrder, paymentBody,
  refundBody, summarizeOrders,
} from '../scripts/lib/orders.mjs'

const TODAY = '2026-11-08'
const full = generateOrders({ today: TODAY })

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
  for (const n of counts) assert.ok(n >= 50 && n <= 85, `day count ${n}`)
})

test('a single test day gets the pro-rata default or the count asked for', () => {
  assert.equal(defaultTotal(1), 66)
  const day = generateOrders({ from: '2026-09-25', to: '2026-09-25', total: 10, today: TODAY })
  assert.equal(day.length, 10)
  assert.ok(day.every(o => o.date === '2026-09-25'))
  assert.equal(day[0].number, 'PD-20260925-001')
})

test('an order is the same every time it is generated from its number', () => {
  assert.deepEqual(makeOrder('PD-20261015-007', '2026-10-15', { today: TODAY }), makeOrder('PD-20261015-007', '2026-10-15', { today: TODAY }))
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
    assert.ok(o.lines.length >= 1 && o.lines.length <= 3)
    assert.equal(new Set(o.lines.map(l => l.sku)).size, o.lines.length)
  }
})

test('refunds fall after the order, never after today, and never exceed what was paid', () => {
  for (const o of full.filter(x => x.refund)) {
    assert.ok(o.refund.date > o.date || o.refund.date === TODAY, `${o.number} ${o.refund.date}`)
    assert.ok(o.refund.date <= TODAY)
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
