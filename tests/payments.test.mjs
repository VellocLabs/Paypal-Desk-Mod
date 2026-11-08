/**
 * Direct payments: how many orders a day takes, the Orders v2 body that pays
 * one with the sandbox test card, where its capture is, and which refunds
 * are due.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeOrder, orderNumber } from '../lib/orders.js'
import { captureOf, checkoutBody, dailyCount, dueRefunds, refundBody, TEST_CARD } from '../scripts/lib/payments.mjs'

test('a day takes about as many orders as the last seeded week, weekends a little more', () => {
  for (const date of ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']) {
    const n = dailyCount(date)
    assert.ok(n >= 55 && n <= 90, `${date}: ${n}`)
  }
  assert.equal(dailyCount('2026-11-09'), dailyCount('2026-11-09'), 'the same day, the same count')
})

test('the checkout body pays the order total with the test card and carries the order number', () => {
  const order = makeOrder(orderNumber('2026-11-08', 1), '2026-11-08')
  const body = checkoutBody(order)
  const unit = body.purchase_units[0]
  assert.equal(body.intent, 'CAPTURE')
  assert.equal(unit.invoice_id, order.number)
  assert.equal(unit.custom_id, order.number)
  assert.equal(unit.amount.value, (order.totalCents / 100).toFixed(2))
  assert.equal(unit.amount.breakdown.item_total.value, unit.amount.value)
  const items = unit.items.reduce((sum, i) => sum + Math.round(Number(i.unit_amount.value) * 100) * Number(i.quantity), 0)
  assert.equal(items, order.totalCents)
  assert.equal(unit.shipping.address.country_code, order.country)
  assert.equal(body.payment_source.card.number, TEST_CARD.number)
  assert.equal(body.payment_source.card.billing_address.country_code, order.country)
})

test('the capture is read from a completed order; none from one still waiting', () => {
  assert.deepEqual(captureOf({ status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED' }] } }] }), { id: 'CAP-1', status: 'COMPLETED' })
  assert.equal(captureOf({ status: 'APPROVED' }), null)
})

test('a refund is due once its day has come, for a captured order not yet refunded', () => {
  const book = { 'PD-1': { refund: { date: '2026-11-08', cents: 1200 }, number: 'PD-1' }, 'PD-2': { refund: { date: '2026-11-09', cents: 500 }, number: 'PD-2' }, 'PD-3': { refund: null, number: 'PD-3' }, 'PD-4': { refund: { date: '2026-11-01', cents: 100 }, number: 'PD-4' } }
  const journal = { 'PD-1': { captureId: 'C1' }, 'PD-2': { captureId: 'C2' }, 'PD-3': { captureId: 'C3' }, 'PD-4': { captureId: 'C4', refundId: 'R4' }, 'PD-5': { orderId: 'O5' } }
  assert.deepEqual(dueRefunds(journal, n => book[n], '2026-11-08').map(o => o.number), ['PD-1'])
  assert.deepEqual(refundBody(book['PD-1']).amount, { currency_code: 'USD', value: '12.00' })
})
