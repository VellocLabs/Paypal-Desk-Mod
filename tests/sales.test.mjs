/**
 * The sales board: which invoice rows are store orders, how a line's share
 * of an order is priced, the 7- and 30-day windows ending yesterday, and the
 * figures, charts and rows the dashboard binds.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { storeRow } from './fixtures.mjs'
import { change, compactDollars, latestOrders, lineCents, readStoreRow, salesBoard, windowTotals } from '../lib/sales.mjs'

const order = args => readStoreRow(storeRow(args)).order

test('only an invoice with a store memo is a store order, and only a paid one counts', () => {
  assert.equal(readStoreRow({ id: 'INV2-X', status: 'PAID', detail: { memo: 'Thanks for your business' } }), null)
  assert.equal(readStoreRow({ id: 'INV2-Y', status: 'SENT', detail: {} }), null)
  const unpaid = readStoreRow(storeRow({ date: '2026-11-05', value: '12.00', status: 'CANCELLED' }))
  assert.equal(unpaid.order, null)
  assert.match(unpaid.id, /^INV2-/)
  const paid = order({ date: '2026-11-05', country: 'CA', lines: [['CHG-65W', 1], ['CAB-C2C', 2]], value: '59.00' })
  assert.deepEqual(
    { date: paid.date, country: paid.country, items: paid.items, cents: paid.cents, customer: paid.customer, refund: paid.refund },
    { date: '2026-11-05', country: 'CA', items: [['CHG-65W', 1], ['CAB-C2C', 2]], cents: 5900, customer: 'Ada Lovelace', refund: null },
  )
})

test('a refund is read from the memo only when the status says refunded, and never exceeds the order', () => {
  const planned = { date: '2026-11-08', cents: 1200 }
  assert.equal(order({ date: '2026-11-05', value: '24.00', lines: [['CAB-C2C', 2]], refund: planned }).refund, null)
  assert.deepEqual(order({ date: '2026-11-05', value: '24.00', lines: [['CAB-C2C', 2]], refund: planned, status: 'MARKED_AS_REFUNDED' }).refund, { date: '2026-11-08', cents: 1200 })
  assert.deepEqual(order({ date: '2026-11-05', value: '24.00', status: 'MARKED_AS_REFUNDED' }).refund, { date: '2026-11-05', cents: 2400 })
  assert.deepEqual(order({ date: '2026-11-05', value: '10.00', refund: { date: '2026-11-06', cents: 9900 }, status: 'REFUNDED' }).refund, { date: '2026-11-06', cents: 1000 })
})

test('line shares use catalog prices; an unknown SKU takes what is left', () => {
  assert.deepEqual(lineCents({ items: [['CHG-65W', 1], ['CAB-C2C', 2]], cents: 5900 }), [3500, 2400])
  assert.deepEqual(lineCents({ items: [['CAB-C2C', 1], ['NEW-1', 1], ['NEW-2', 3]], cents: 5200 }), [1200, 1000, 3000])
})

test('a window counts orders placed in it and refunds made in it, day by day', () => {
  const orders = [
    order({ date: '2026-11-03', value: '100.00' }),
    order({ date: '2026-11-01', value: '50.00', refund: { date: '2026-11-04', cents: 5000 }, status: 'MARKED_AS_REFUNDED' }),
    order({ date: '2026-11-04', value: '40.00', country: 'JP' }),
  ]
  const t = windowTotals(orders, '2026-11-03', '2026-11-05')
  assert.equal(t.count, 2)
  assert.equal(t.gross, 14000)
  assert.equal(t.refundCount, 1)
  assert.equal(t.net, 9000)
  assert.deepEqual([...t.daily], [['2026-11-03', 10000], ['2026-11-04', -1000], ['2026-11-05', 0]])
  assert.equal(t.byGroup.US, 10000)
  assert.equal(t.byGroup.other, 4000)
})

test('the formats: compact dollars from $10K, a change with one decimal and a dead band', () => {
  assert.equal(compactDollars(2755400), '$27.6K')
  assert.equal(compactDollars(987600), '$9,876')
  assert.deepEqual(change(10140, 10000), { trendValue: '+1.4%', trend: 'up' })
  assert.deepEqual(change(9980, 10000), { trendValue: '-0.2%', trend: 'flat' })
  assert.deepEqual(change(9000, 10000), { trendValue: '-10.0%', trend: 'down' })
  assert.deepEqual(change(5, 0), { trendValue: '', trend: 'flat' })
})

test('the board: last 7 days against the 7 before, 30-day totals, both ending yesterday', () => {
  const orders = [
    order({ date: '2026-11-09', value: '129.00', lines: [['AUD-BUDS', 1]], name: ['Mia', 'Clark'] }),
    order({ date: '2026-11-09', value: '24.00', lines: [['CAB-C2C', 2]], country: 'GB' }),
    order({ date: '2026-11-03', value: '35.00', lines: [['CHG-65W', 1]], country: 'CA', refund: { date: '2026-11-06', cents: 3500 }, status: 'MARKED_AS_REFUNDED' }),
    order({ date: '2026-10-30', value: '100.00', lines: [['DSK-ARM', 1], ['CAB-C2C', 1]] }),
    order({ date: '2026-11-10', value: '999.00', lines: [['HUB-DOCK', 5]] }),
    order({ date: '2026-10-10', value: '12.00', lines: [['CAB-C2C', 1]], country: 'FR' }),
  ]
  const board = salesBoard(orders, { today: '2026-11-10' })
  const w = board.week
  assert.equal(w.range, 'Nov 3 – Nov 9, 2026 · compared with Oct 27 – Nov 2')
  assert.deepEqual(w.kpis.net, { label: 'Net', value: '$153', trendValue: '+53.0%', trend: 'up' })
  assert.deepEqual(w.kpis.orders, { label: 'Count', value: '3', trendValue: '+200.0%', trend: 'up' })
  assert.deepEqual(w.kpis.aov, { label: 'AOV', value: '$62.67', trendValue: '-37.3%', trend: 'down' })
  assert.deepEqual(w.kpis.refunds, { label: 'Rate', value: '18.6%', trendValue: '1 refunds · $35', trend: 'flat' })
  assert.deepEqual(w.daily.map(d => d.label), ['Tue 11/3', 'Wed 11/4', 'Thu 11/5', 'Fri 11/6', 'Sat 11/7', 'Sun 11/8', 'Mon 11/9'])
  assert.deepEqual(w.daily.map(d => d.value), [35, 0, 0, -35, 0, 0, 153])
  assert.deepEqual(w.byCountry.map(c => [c.label, c.value]), [['United States', 68.6], ['Canada', 18.6], ['United Kingdom', 12.8]])
  assert.deepEqual(w.topProducts[0], { product: 'Noise-cancelling earbuds', units: '1', sales: '$129' })
  assert.deepEqual(w.latest.map(r => r.status), ['Paid', 'Paid', 'Paid', 'Refunded', 'Paid', 'Paid'])
  assert.equal(w.latest[0].total, '$999.00', 'today\'s order is the newest even though the window ends yesterday')
  assert.equal(w.latest[2].customer, 'Mia Clark')
  assert.equal(w.latest[2].items, 'ANC earbuds')
  assert.equal(w.latest[1].items, 'USB-C cable ×2')
  assert.equal(w.latest[4].items, 'Monitor arm +1')

  const m = board.month
  assert.equal(m.range, 'Oct 11 – Nov 9, 2026 · totals')
  assert.equal(m.kpis.orders.value, '4')
  assert.equal(m.kpis.net.trendValue, '$288 before refunds')
  assert.deepEqual(m.productCountry[0], { label: 'USB-C cable', US: 1, CA: 0, GB: 2, AU: 0, DE: 0, other: 0 })
  assert.equal(m.products.length, 4)
  assert.deepEqual(m.products.map(p => p.units), [3, 1, 1, 1])
  assert.match(board.salesNote, /simulated demo data/)
  assert.ok(Math.abs(board.refundShare - 35 / 188) < 1e-9)
})

test('an empty store reads as empty, not as an error', () => {
  const board = salesBoard([], { today: '2026-11-10' })
  assert.equal(board.week.kpis.net.value, '$0')
  assert.equal(board.week.range, 'Nov 3 – Nov 9, 2026')
  assert.deepEqual(board.week.byCountry, [])
  assert.equal(board.week.daily.length, 7)
  assert.deepEqual(board.month.products, [])
  assert.equal(board.salesNote, 'No store orders in the last 30 days.')
  assert.deepEqual(latestOrders([]), [])
})
