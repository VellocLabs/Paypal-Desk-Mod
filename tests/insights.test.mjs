/**
 * The demo's bad-batch story in the order book, and what the desk says
 * about refunds: per-product stats, the breakdown the
 * agent reads.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { storeOrder as order } from './fixtures.mjs'
import { BAD_BATCH, makeOrder, orderNumber } from '../lib/orders.js'
import { rateChange, refundBreakdown, refundStats } from '../lib/insights.js'

test('orders already paid keep their content: the story only adds refunds', () => {
  // As the sandbox took them on Nov 8.
  const paid = { 'PD-20261108-010': ['US', 12900], 'PD-20261108-020': ['CA', 2900], 'PD-20261108-070': ['DE', 14900] }
  for (const [number, [country, cents]] of Object.entries(paid)) {
    const o = makeOrder(number, '2026-11-08')
    assert.deepEqual([o.country, o.totalCents], [country, cents], number)
  }
})

test('from Nov 2 about half the 65W charger orders are refunded a few days later for the bad batch; before, as usual', () => {
  const chargerOrders = (from, to) => {
    const out = []
    for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      const date = d.toISOString().slice(0, 10)
      for (let k = 1; k <= 80; k++) {
        const o = makeOrder(orderNumber(date, k), date)
        if (o.lines.some(l => l.sku === BAD_BATCH.sku)) out.push(o)
      }
    }
    return out
  }
  const after = chargerOrders('2026-11-02', '2026-11-08')
  const batch = after.filter(o => o.refund && o.refund.reason === BAD_BATCH.reason)
  assert.ok(batch.length / after.length > 0.35 && batch.length / after.length < 0.65, `${batch.length} of ${after.length}`)
  for (const o of batch) {
    assert.equal(o.refund.sku, BAD_BATCH.sku)
    assert.ok(o.refund.date > o.date && o.refund.date <= addDays(o.date, 3), `${o.number} refunded ${o.refund.date}`)
  }
  const before = chargerOrders('2026-10-20', '2026-11-01')
  assert.equal(before.filter(o => o.refund && o.refund.reason === BAD_BATCH.reason).length, 0)
})

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/** A week (Nov 3–9) where the charger drives refunds, and a quiet week before. */
function storyOrders() {
  const orders = []
  for (let i = 0; i < 10; i++) orders.push(order({ date: '2026-10-28', value: '35.00', lines: [['CHG-65W', 1]] }))
  for (let i = 0; i < 10; i++) orders.push(order({ date: '2026-10-29', value: '100.00', lines: [['AUD-BUDS', 1]] }))
  orders.push(order({ date: '2026-10-29', value: '100.00', lines: [['AUD-BUDS', 1]], refund: { date: '2026-10-30', cents: 10000, sku: 'AUD-BUDS', reason: 'Changed my mind' } }))
  for (let i = 0; i < 10; i++) {
    orders.push(order({ date: '2026-11-04', value: '35.00', lines: [['CHG-65W', 1]],
      refund: i < 5 ? { date: '2026-11-06', cents: 3500, sku: 'CHG-65W', reason: BAD_BATCH.reason } : null }))
  }
  for (let i = 0; i < 10; i++) orders.push(order({ date: '2026-11-05', value: '100.00', lines: [['AUD-BUDS', 1]] }))
  return orders
}

test('refund stats count refunds made in the window against orders placed in it, per product and reason', () => {
  const s = refundStats(storyOrders(), '2026-11-03', '2026-11-09')
  assert.equal(s.orders, 20)
  assert.equal(s.refunds, 5)
  assert.equal(Math.round(s.rate * 10) / 10, 13, '$175 of $1,350')
  assert.deepEqual(s.products.get('CHG-65W'), { key: 'CHG-65W', orders: 10, refunds: 5, refundCents: 17500 })
  assert.equal(s.reasons.get(BAD_BATCH.reason).refunds, 5)
  assert.deepEqual(rateChange(12.96, 7.7), { pts: 5.3, text: '+5.3 pts', trend: 'up' })
  assert.equal(rateChange(5.1, 5).trend, 'flat')
})

test('the breakdown for the agent has four weekly rates, products with the week before, and the refunded orders', () => {
  const b = refundBreakdown(storyOrders(), '2026-11-10')
  assert.equal(b.week, 'Nov 3 – Nov 9')
  assert.equal(b.weeks.length, 4)
  assert.deepEqual(b.weeks.map(w => w.rate), ['0.0%', '0.0%', '6.9%', '13.0%'])
  assert.deepEqual(b.products[0], { product: '65W GaN USB-C charger', refunds: 5, orders: 10, rate: '50.0%', refundsWeekBefore: 0, rateWeekBefore: '0.0%', topReason: BAD_BATCH.reason })
  assert.equal(b.refundedOrders.length, 6)
  assert.deepEqual(Object.keys(b.refundedOrders[0]), ['order', 'ordered', 'refunded', 'country', 'items', 'product', 'amount', 'reason'])
  assert.ok(JSON.stringify(b).length < 64_000)
})
