/** The Products tab's data: what each product sold, what came back, and what breaks a rule. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { breaksRule, productsBoard, refundRules } from '../lib/products.js'
import { storeOrder } from './fixtures.mjs'

const today = '2026-11-11'

const order = ({ date, sku = 'CAB-C2C', qty = 1, value = '12.00', refund = null }) =>
  storeOrder({ date, lines: [[sku, qty]], value, refund })

test('every product gets its week: sales, units and rate, at risk first', () => {
  const orders = [
    order({ date: '2026-11-04' }), order({ date: '2026-11-05' }), order({ date: '2026-11-06' }),
    order({ date: '2026-10-30' }),
    order({ date: '2026-11-07', sku: 'PWR-20K', value: '39.00' }),
  ]
  const board = productsBoard(orders, { today, alerts: [{ metric: 'refund_rate', scope: 'any_product', above: 10, minOrders: 1 }] })
  assert.match(board.range, /^Nov 4 – Nov 10 · compared with Oct 28 – Nov 3$/)
  assert.equal(board.rows.length, 20, 'the rows the board carries')
  assert.match(board.ruleNote, /^20 of 34 products/)
  const cable = board.rows.find(r => r.sku === 'CAB-C2C')
  assert.deepEqual([cable.units, cable.sales, cable.rate, cable.atRisk], ['3', '$36', '0.0%', false])
  assert.match(cable.rateNote, /\+\d+\.\d pts vs week before/)
  assert.equal(cable.spark.length, 8)
})

test('a product over the rule is at risk, named first, with the rule it broke', () => {
  const orders = [
    order({ date: '2026-11-04', value: '12.00', refund: { date: '2026-11-06', cents: 1200, sku: 'CAB-C2C', reason: 'Faulty' } }),
    order({ date: '2026-11-05', value: '12.00' }),
  ]
  const board = productsBoard(orders, { today, alerts: [{ metric: 'refund_rate', scope: 'any_product', above: 10, minOrders: 1 }] })
  const first = board.rows[0]
  assert.equal(first.sku, 'CAB-C2C')
  assert.equal(first.atRisk, true)
  assert.equal(first.rate, '50.0%')
  assert.equal(first.rateNote, 'refund rate 50.0% above 10%')
  assert.deepEqual(first.badges, [{ label: 'At risk', tone: 'danger' }])
  assert.equal(board.kpis.atRisk.value, '1')
  assert.equal(board.kpis.salesAtRisk.value, '$24')
})

test('without a product rule, the desk still marks what is plainly broken', () => {
  const orders = []
  for (let i = 0; i < 12; i++) orders.push(order({ date: `2026-11-0${4 + (i % 7)}`, value: '12.00', refund: i < 2 ? { date: '2026-11-08', cents: 1200, sku: 'CAB-C2C', reason: 'Faulty' } : null }))
  const board = productsBoard(orders, { today })
  assert.match(board.ruleNote, /no product rule set/)
  assert.equal(board.rows[0].sku, 'CAB-C2C')
  assert.equal(board.rows[0].atRisk, true)
})

test('a rule counts only the products it names, and needs enough orders to trust', () => {
  const rule = { metric: 'refund_rate', scope: 'product', sku: 'CAB-C2C', above: 10 }
  assert.deepEqual(refundRules([rule, { metric: 'net_sales' }, rule]), [rule, rule])
  const now = { orders: 2, sales: 2400, refundCents: 1200 }
  assert.equal(breaksRule(rule, now, { orders: 0, sales: 0, refundCents: 0 }), '', 'two orders are not enough')
  assert.equal(breaksRule(rule, { ...now, orders: 12 }, { orders: 0, sales: 0, refundCents: 0 }), 'refund rate 50.0% above 10%')
  assert.match(breaksRule({ scope: 'any_product', riseAbove: 3 }, { orders: 12, sales: 1000, refundCents: 200 }, { orders: 12, sales: 1000, refundCents: 100 }), /up 10\.0 pts/)
})
