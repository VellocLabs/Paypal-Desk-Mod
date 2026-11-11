/** One product's own figures for the tab a person asked for. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isProduct, productName, productTrend } from '../lib/productTrend.js'
import { storeOrder } from './fixtures.mjs'

const today = '2026-11-11'

test('a product\'s last 30 days: a row a day, its units and sales, and the window totals', () => {
  const orders = [
    storeOrder({ date: '2026-11-10', lines: [['CAB-C2C', 2]], value: '24.00' }),
    storeOrder({ date: '2026-11-08', lines: [['CAB-C2C', 1]], value: '12.00' }),
    storeOrder({ date: '2026-10-20', lines: [['CAB-C2C', 1]], value: '12.00' }),
    storeOrder({ date: '2026-11-09', lines: [['PWR-20K', 1]], value: '39.00' }),
  ]
  const t = productTrend(orders, { sku: 'CAB-C2C', days: 30, today })
  assert.equal(t.series.length, 30)
  assert.deepEqual([t.from, t.to], ['2026-10-12', '2026-11-10'])
  assert.deepEqual(t.series.at(-1), { label: 'Nov 10', units: 2, sales: 24 })
  assert.equal(t.kpis.units.value, '4')
  assert.equal(t.kpis.orders.value, '3')
  assert.equal(t.kpis.sales.value, '$48')
  assert.match(t.note, /^USB-C to USB-C cable, 2 m · Oct 12 – Nov 10 · 4 units, \$48$/)
  assert.match(t.ask, /Analyze USB-C to USB-C cable, 2 m \(CAB-C2C\) over the last 30 days/)
})

test('a refund counts on the day it was made, against the product it names', () => {
  const orders = [
    storeOrder({ date: '2026-11-02', lines: [['CAB-C2C', 1]], value: '12.00', refund: { date: '2026-11-05', cents: 1200, sku: 'CAB-C2C', reason: 'Faulty' } }),
  ]
  const t = productTrend(orders, { sku: 'CAB-C2C', days: 30, today })
  assert.equal(t.kpis.refunds.value, '100.0%')
})

test('only a product the catalog has, under its own name', () => {
  assert.ok(isProduct('CAB-C2C'))
  assert.ok(!isProduct('NOPE-1'))
  assert.equal(productName('CAB-C2C'), 'USB-C to USB-C cable, 2 m')
  assert.equal(productName('NOPE-1'), 'NOPE-1')
  assert.deepEqual(productTrend([], { sku: 'NOPE-1', days: 30, today }).series.length, 30)
})
