/**
 * The sales board: which invoice rows are store orders, how a line's share
 * of an order is priced, the 7- and 30-day windows ending yesterday, and the
 * figures, charts and rows the dashboard binds.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { storeOrder as order, storeRow, transactionRow } from './fixtures.mjs'
import { makeOrder } from '../lib/orders.js'
import { change, compactDollars, latestOrders, lineCents, paymentOrders, readStoreRow, salesBoard, weekAsks, windowTotals } from '../lib/sales.js'

test('a paid invoice numbered PD-YYYYMMDD-NNN is a store order: PayPal gives amount and status, the order book the rest', () => {
  assert.equal(readStoreRow({ invoice_id: 'INV2-X', invoice_number: '0001', status: 'PAID', amount: '10.00' }), null)
  assert.equal(readStoreRow({ invoice_id: 'INV2-Y', invoice_number: 'PD-20261340-001', status: 'PAID', amount: '10.00' }), null)
  const unpaid = readStoreRow(storeRow({ date: '2026-11-05', value: '12.00', status: 'CANCELLED' }))
  assert.equal(unpaid.order, null)
  assert.match(unpaid.id, /^INV2-/)

  const row = storeRow({ date: '2026-11-05', value: '59.00' })
  const book = makeOrder(row.invoice_number, '2026-11-05')
  const paid = readStoreRow(row).order
  assert.deepEqual(
    { id: paid.id, date: paid.date, country: paid.country, items: paid.items, cents: paid.cents, customer: paid.customer, buyer: paid.buyer, refund: paid.refund },
    { id: row.invoice_id, date: '2026-11-05', country: book.country, items: book.lines.map(l => [l.sku, l.qty]), cents: 5900,
      customer: `${book.buyer.first} ${book.buyer.last}`, buyer: book.buyer.email, refund: null },
  )
  const nested = { id: row.invoice_id, status: 'MARKED_AS_PAID', detail: { invoice_number: row.invoice_number }, amount: { currency_code: 'USD', value: '59.00' } }
  assert.deepEqual(readStoreRow(nested).order, paid, 'the REST row shape reads the same')
})

test('a refund comes from the order book, never above the amount; a bare refund status is a full one on the order day', () => {
  const row = storeRow({ date: '2026-11-05', value: '500.00', refunded: true })
  const book = makeOrder(row.invoice_number, '2026-11-05')
  assert.deepEqual(readStoreRow(row).order.refund, { date: book.refund.date, cents: book.refund.cents, sku: book.refund.sku, reason: book.refund.reason })
  assert.ok(book.refund.reason, 'an order-book refund says why')
  assert.equal(readStoreRow({ ...row, amount: '1.00' }).order.refund.cents, 100)
  assert.equal(readStoreRow(storeRow({ date: '2026-11-05', value: '24.00' })).order.refund, null)
  assert.deepEqual(readStoreRow(storeRow({ date: '2026-11-05', value: '24.00', status: 'MARKED_AS_REFUNDED' })).order.refund, { date: '2026-11-05', cents: 2400, sku: null, reason: null })
})

test('an order shows as refunded only from the refund day on', () => {
  const o = order({ date: '2026-11-03', value: '20.00', refund: { date: '2026-11-12', cents: 2000 } })
  assert.equal(latestOrders([o], '2026-11-10')[0].status, 'Paid')
  assert.equal(latestOrders([o], '2026-11-12')[0].status, 'Refunded')
})

test('a completed payment carrying a store order number is an order on its own day, with its refunds from PayPal', () => {
  const rows = [
    transactionRow({ id: 'TX-1', number: 'PD-20261109-001', at: '2026-11-09T00:21:10Z', value: '69.00' }),
    transactionRow({ id: 'TX-2', number: 'PD-20261109-002', at: '2026-11-09T00:22:00Z', value: '40.00' }),
    transactionRow({ id: 'TX-R1', at: '2026-11-11T10:00:00Z', value: '-20.00', code: 'T1107', ref: 'TX-2' }),
    transactionRow({ id: 'TX-R2', number: 'PD-20261109-002', at: '2026-11-12T10:00:00Z', value: '-30.00', code: 'T1107' }),
    transactionRow({ id: 'TX-3', number: 'PD-20261109-003', at: '2026-11-09T00:23:00Z', value: '25.00', status: 'P' }),
    transactionRow({ id: 'TX-4', number: 'INV-77', at: '2026-11-09T00:24:00Z', value: '25.00' }),
    transactionRow({ id: 'TX-5', at: '2026-11-07T23:06:31Z', value: '5000.00', code: 'T1900' }),
  ]
  const orders = paymentOrders(rows)
  assert.deepEqual(orders.map(o => o.id), ['TX-1', 'TX-2'])
  const book = makeOrder('PD-20261109-001', '2026-11-09')
  assert.deepEqual(orders[0], {
    id: 'TX-1', number: 'PD-20261109-001', date: '2026-11-08', country: book.country, items: book.lines.map(l => [l.sku, l.qty]),
    cents: 6900, customer: `${book.buyer.first} ${book.buyer.last}`, buyer: book.buyer.email, refund: null,
  })
  assert.equal(orders[1].date, '2026-11-08', '00:22 UTC on the 9th is the evening of the 8th in Toronto')
  const bookRefund = makeOrder('PD-20261109-002', '2026-11-09').refund
  assert.deepEqual(orders[1].refund, { date: '2026-11-12', cents: 4000, sku: bookRefund ? bookRefund.sku : null, reason: bookRefund ? bookRefund.reason : null }, 'two refunds, the second on the 12th, capped at the payment')
  assert.deepEqual(paymentOrders(undefined), [])
})

test('line shares use catalog prices; an unknown SKU takes what is left', () => {
  assert.deepEqual(lineCents({ items: [['CHG-65W', 1], ['CAB-C2C', 2]], cents: 5900 }), [3500, 2400])
  assert.deepEqual(lineCents({ items: [['CAB-C2C', 1], ['NEW-1', 1], ['NEW-2', 3]], cents: 5200 }), [1200, 1000, 3000])
})

test('a window counts orders placed in it and refunds made in it, day by day', () => {
  const orders = [
    order({ date: '2026-11-03', value: '100.00' }),
    order({ date: '2026-11-01', value: '50.00', refund: { date: '2026-11-04', cents: 5000 } }),
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
    order({ date: '2026-11-03', value: '35.00', lines: [['CHG-65W', 1]], country: 'CA', refund: { date: '2026-11-06', cents: 3500 } }),
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
  assert.deepEqual(w.kpis.refunds, { label: 'Rate', value: '18.6%', trendValue: '+18.6 pts', trend: 'up' })
  assert.equal(w.refundsNote, '1 refund · $35')
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
  assert.deepEqual(latestOrders([], '2026-11-10'), [])
})

test('the ask texts name each figure, both windows and the change as shown, and judge none of them', () => {
  const kpis = {
    net: { value: '$27.6K', trendValue: '+4.2%' },
    orders: { value: '72', trendValue: '-3.0%' },
    aov: { value: '$48.20', trendValue: '' },
    refunds: { value: '6.3%', trendValue: '+3.1 pts' },
  }
  const ask = weekAsks(kpis, 'Nov 1 – Nov 7, 2026', 'Oct 25 – Oct 31')
  assert.equal(ask.net, "Analyze the change in net sales: $27.6K for Nov 1 – Nov 7, 2026, +4.2% against Oct 25 – Oct 31. What's behind it — which products, countries or days?")
  assert.equal(ask.orders, "Analyze the change in orders: 72 for Nov 1 – Nov 7, 2026, -3.0% against Oct 25 – Oct 31. What's behind it — which products, countries or days?")
  assert.equal(ask.aov, "Analyze the change in average order value: $48.20 for Nov 1 – Nov 7, 2026. What's behind it — the product mix or basket size?", 'no delta, no comparison')
  assert.equal(ask.refunds, "Analyze the change in the refund rate: 6.3% of sales for Nov 1 – Nov 7, 2026, +3.1 pts against Oct 25 – Oct 31. What's behind it — which products, countries or refund reasons?")
  assert.equal(ask.all, [
    "Analyze this week's changes, Nov 1 – Nov 7, 2026 against Oct 25 – Oct 31:",
    '- Net sales: $27.6K (+4.2%)',
    '- Orders: 72 (-3.0%)',
    '- Avg order value: $48.20',
    '- Refund rate: 6.3% (+3.1 pts)',
    'What is behind each change, and are any of them connected?',
  ].join('\n'))
  for (const text of Object.values(ask)) assert.doesNotMatch(text, /\b(good|bad|better|worse|drop|jump|spike|unusual)\b/i)
})
