/**
 * Alert rules checked against a week of orders, and disputes as alert cards.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { storeOrder as order } from './fixtures.mjs'
import { checkRules, disputeAlerts, ruleText } from '../lib/alerts.js'

/** Nov 3–9 against Oct 27 – Nov 2: chargers refunded half the time this week, earbuds steady, Canada fading. */
function weekOrders() {
  const orders = []
  for (let i = 0; i < 10; i++) orders.push(order({ date: '2026-10-28', value: '35.00', lines: [['CHG-65W', 1]] }))
  for (let i = 0; i < 10; i++) orders.push(order({ date: '2026-10-29', value: '100.00', lines: [['AUD-BUDS', 1]], country: i < 6 ? 'CA' : 'US' }))
  for (let i = 0; i < 12; i++) {
    orders.push(order({ date: '2026-11-04', value: '35.00', lines: [['CHG-65W', 1]],
      refund: i < 6 ? { date: '2026-11-06', cents: 3500, sku: 'CHG-65W', reason: 'Stops charging' } : null }))
  }
  for (let i = 0; i < 10; i++) orders.push(order({ date: '2026-11-05', value: '100.00', lines: [['AUD-BUDS', 1]], country: i < 3 ? 'CA' : 'US' }))
  // Two cable orders, one refunded: a 50% rate on too few orders to count.
  orders.push(order({ date: '2026-11-05', value: '12.00', lines: [['CAB-C2C', 1]], refund: { date: '2026-11-06', cents: 1200, sku: 'CAB-C2C' } }))
  orders.push(order({ date: '2026-11-05', value: '12.00', lines: [['CAB-C2C', 1]] }))
  return orders
}

const byId = list => Object.fromEntries(list.map(a => [a.id, a]))

test('a product refund ceiling trips on the product that crosses it, and skips products with too few orders', () => {
  const [rule] = checkRules([{ id: 'p', name: 'Product refunds', metric: 'refund_rate', scope: 'any_product', above: 10 }], weekOrders(), '2026-11-10')
  assert.equal(rule.tripped, true)
  assert.equal(rule.subject, '65W GaN USB-C charger')
  assert.equal(rule.value, '50.0%')
  assert.equal(rule.delta, '+50.0 pts vs week before')
  assert.deepEqual([rule.trend, rule.better], ['up', 'down'])
  assert.equal(rule.rule, 'Any product: refund rate above 10.0%')
  assert.equal(rule.week, '2026-11-03..2026-11-09')
  assert.match(rule.reading, /^65W GaN USB-C charger: refund rate 50\.0% over Nov 3 – Nov 9, \+50\.0 pts on the week before$/)
})

test('store, country and product rules read their own figure; a quiet rule shows it too', () => {
  const checked = byId(checkRules([
    { id: 'floor', name: 'Sales floor', metric: 'net_sales', below: 2000 },
    { id: 'jump', name: 'Refund jump', metric: 'refund_rate', riseAbove: 1.5 },
    { id: 'ca', name: 'Canada orders', metric: 'orders', scope: 'country', country: 'CA', dropAbove: 40 },
    { id: 'buds', name: 'Earbuds units', metric: 'units', scope: 'product', sku: 'AUD-BUDS', below: 5 },
  ], weekOrders(), '2026-11-10'))
  // $420 + $1,000 + $24 of sales, $222 refunded.
  assert.deepEqual([checked.floor.tripped, checked.floor.value, checked.floor.subject], [true, '$1,222', 'Last 7 days'])
  assert.equal(checked.floor.rule, 'Store: net sales below $2,000')
  assert.equal(checked.jump.tripped, true)
  assert.deepEqual([checked.ca.tripped, checked.ca.value, checked.ca.delta, checked.ca.subject], [true, '3', '-50.0% vs week before', 'Canada, last 7 days'])
  assert.equal(checked.ca.rule, 'Canada: orders down more than 40%')
  assert.deepEqual([checked.buds.tripped, checked.buds.value, checked.buds.delta, checked.buds.trend], [false, '10', '±0.0% vs week before', 'flat'])
})

test('a rule the desk cannot check is listed as not understood', () => {
  const checked = checkRules([
    { id: 'a', metric: 'profit', above: 1 },
    { id: 'b', metric: 'orders' },
    { id: 'c', metric: 'units', scope: 'product', sku: 'NOPE', below: 1 },
    { name: 'no id', metric: 'orders', above: 1 },
  ], weekOrders(), '2026-11-10')
  assert.deepEqual(checked.map(a => [a.id, a.understood, a.tripped, a.rule]), [
    ['a', false, false, 'Not a rule this desk can check'],
    ['b', false, false, 'Not a rule this desk can check'],
    ['c', false, false, 'Not a rule this desk can check'],
  ])
})

test('rules read as one line naming whose figure, the metric and each bound', () => {
  assert.equal(ruleText({ metric: 'refund_rate', riseAbove: 1.5, above: 5 }), 'Store: refund rate above 5.0% or up more than 1.5 pts')
  assert.equal(ruleText({ metric: 'aov', scope: 'country', country: 'GB', dropAbove: 10 }), 'United Kingdom: average order value down more than 10%')
})

test('disputes are alert cards: open ones first, a near deadline in red, resolved ones kept for 30 days', () => {
  const now = Date.parse('2026-11-10T12:00:00Z')
  const cards = disputeAlerts([
    { id: 'PP-D-3', reason: 'credit not processed', stage: 'inquiry', amount: '$20.00', status: 'RESOLVED', open: false, created: '2026-11-01T00:00:00Z', respondBy: '', transactionId: '' },
    { id: 'PP-D-1', reason: 'merchandise or service not received', stage: 'inquiry', amount: '$45.00', status: 'WAITING_FOR_SELLER_RESPONSE', open: true, created: '2026-11-05T00:00:00Z', respondBy: '2026-11-12T00:00:00Z', transactionId: '9AB' },
    { id: 'PP-D-2', reason: 'unauthorised', stage: 'chargeback', amount: '$129.00', status: 'UNDER_REVIEW', open: true, created: '2026-11-02T00:00:00Z', respondBy: '', transactionId: '' },
    { id: 'PP-D-0', reason: 'incorrect amount', stage: 'inquiry', amount: '$9.00', status: 'RESOLVED', open: false, created: '2026-09-01T00:00:00Z', respondBy: '', transactionId: '' },
  ], now)
  assert.deepEqual(cards.map(c => [c.id, c.title, c.status, c.tone]), [
    ['PP-D-1', 'Item not received', 'Respond in 2 days', 'danger'],
    ['PP-D-2', 'Unauthorized payment', 'PayPal reviewing', 'info'],
    ['PP-D-3', 'Refund not received', 'Resolved', 'success'],
  ])
  const first = cards[0]
  assert.deepEqual([first.rule, first.value, first.delta, first.note], ['Dispute PP-D-1 · opened Nov 5', '$45.00', 'Respond by Nov 12', 'On transaction 9AB'])
  assert.match(first.ask, /^Work this case \(dispute:PP-D-1\)/)
  assert.equal(cards[1].rule, 'Chargeback PP-D-2 · opened Nov 2')
  assert.equal(first.summary, 'Dispute PP-D-1 · opened Nov 5')
})
