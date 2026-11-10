/**
 * Dispute review: the facts the desk checks, the lean its rules give, and
 * the review cards before and after the AI has written its verdict.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { storeOrder } from './fixtures.mjs'
import { disputeFacts, disputeLean, latestReview, reasonFamily, reviewCards, waitsOnMerchant } from '../lib/disputes.js'

const NOW = Date.parse('2026-11-10T12:00:00Z')
const day = offset => new Date(NOW + offset * 86_400_000).toISOString()

function dispute({ id = 'PP-D-1', reason = 'DUPLICATE_TRANSACTION', value = '59.70', tx = 'TX-2', due = 5, extra = {} } = {}) {
  return {
    dispute_id: id,
    reason,
    status: 'WAITING_FOR_SELLER_RESPONSE',
    dispute_life_cycle_stage: 'CLAIM',
    dispute_amount: { currency_code: 'USD', value },
    seller_response_due_date: day(due),
    create_time: day(-2),
    update_time: day(-1),
    disputed_transactions: [{ seller_transaction_id: tx }],
    ...extra,
  }
}

const sale = (id, minutes, value = 59.7, payer = 'ada@example.com') =>
  ({ id, at: new Date(NOW - 86_400_000 + minutes * 60_000).toISOString(), value, currency: 'USD', status: 'S', refund: false, payer })

test('reason codes fall into the families that answer them', () => {
  assert.equal(reasonFamily('MERCHANDISE_OR_SERVICE_NOT_RECEIVED'), 'not_received')
  assert.equal(reasonFamily('merchandise or service not as described'), 'not_as_described')
  assert.equal(reasonFamily('UNAUTHORISED'), 'unauthorized')
  assert.equal(reasonFamily('DUPLICATE_TRANSACTION'), 'duplicate')
  assert.equal(reasonFamily('SOMETHING_NEW'), 'other')
})

test('a charge-twice claim with a second charge within ten minutes leans to a refund', () => {
  const f = disputeFacts(dispute(), { transactions: [sale('TX-1', 0), sale('TX-2', 3)], now: NOW })
  assert.equal(f.secondCharge, 'TX-1')
  assert.deepEqual([f.lean.verdict, f.claim, f.amount, f.daysLeft], ['refund', 'Charged twice', '$59.70', 5])
  assert.ok(f.checks.some(c => c.text === 'Second charge found: TX-1' && c.tone === 'warning'))
})

test('a charge-twice claim with one charge leans to contesting it', () => {
  const f = disputeFacts(dispute(), { transactions: [sale('TX-2', 3), sale('TX-3', 60 * 5)], now: NOW })
  assert.equal(f.secondCharge, '')
  assert.equal(f.lean.verdict, 'contest')
})

test('the order behind the payment is found, and a product refunded far above the store leans a not-as-described claim to a refund', () => {
  const orders = []
  // 20 orders of the faulty cable, 4 refunded; 40 orders of a fine product, 1 refunded.
  for (let i = 0; i < 20; i++) orders.push(storeOrder({ date: '2026-11-0' + (1 + (i % 8)), lines: [['CAB-C2C', 1]], value: '15.00', refund: i < 4 ? { date: '2026-11-08', cents: 1500, sku: 'CAB-C2C', reason: 'Defective' } : null }))
  for (let i = 0; i < 40; i++) orders.push(storeOrder({ date: '2026-11-0' + (1 + (i % 8)), lines: [['PWR-20K', 1]], value: '39.00', refund: i === 0 ? { date: '2026-11-08', cents: 3900, sku: 'PWR-20K', reason: 'Changed mind' } : null }))
  const target = orders[10]
  const f = disputeFacts(dispute({ reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', value: '45.00', tx: target.id }), { orders, now: NOW })
  assert.equal(f.order.number, target.number)
  assert.equal(f.product.sku, 'CAB-C2C')
  assert.equal(f.product.rate, 20)
  assert.ok(f.faulty)
  assert.equal(f.lean.verdict, 'refund')
})

test('the rules: small amounts refund, a refund already made is contested, an unprotected unauthorized claim is the person\'s call', () => {
  const base = { family: 'not_received', value: 60, product: null, faulty: false, alreadyRefunded: false, secondCharge: '', sellerProtection: '', buyerOrders: 0 }
  assert.equal(disputeLean(base).verdict, 'review')
  assert.equal(disputeLean({ ...base, value: 20 }).verdict, 'refund')
  assert.equal(disputeLean({ ...base, alreadyRefunded: true }).verdict, 'contest')
  assert.equal(disputeLean({ ...base, family: 'credit' }).verdict, 'refund')
  assert.equal(disputeLean({ ...base, family: 'unauthorized' }).verdict, 'review')
  assert.equal(disputeLean({ ...base, family: 'unauthorized', sellerProtection: 'eligible' }).verdict, 'contest')
  assert.equal(disputeLean({ ...base, family: 'unauthorized', buyerOrders: 3 }).verdict, 'contest')
})

test('the buyer\'s message, the deadline and seller protection come from get_dispute', () => {
  const f = disputeFacts(dispute({ due: 2, extra: {
    messages: [{ posted_by: 'BUYER', content: 'I was billed twice for one order.' }],
    disputed_transactions: [{ seller_transaction_id: 'TX-2', seller_protection_eligible: true, buyer: { email: 'ada@example.com' } }],
    allowed_response_options: { make_offer: {}, accept_claim: {} },
  } }), { now: NOW })
  assert.equal(f.buyerSays, 'I was billed twice for one order.')
  assert.equal(f.sellerProtection, 'eligible')
  assert.deepEqual(f.allowed, ['make_offer', 'accept_claim'])
  assert.ok(f.checks.some(c => c.text === '2 days left to respond' && c.tone === 'danger'))
})

test('only a dispute waiting on the merchant is reviewed', () => {
  assert.ok(waitsOnMerchant({ status: 'WAITING_FOR_SELLER_RESPONSE' }))
  assert.ok(waitsOnMerchant({ status: 'OPEN' }))
  assert.ok(!waitsOnMerchant({ status: 'UNDER_REVIEW' }))
  assert.ok(!waitsOnMerchant({ status: 'RESOLVED' }))
})

test('a review written before the dispute last changed is stale', () => {
  const reviews = [
    { disputeId: 'PP-D-1', at: day(-3), verdict: 'refund', headline: 'old' },
    { disputeId: 'PP-D-1', at: day(-0.5), verdict: 'contest', headline: 'new' },
    { disputeId: 'PP-D-1', at: day(0), verdict: 'maybe', headline: 'not a verdict' },
  ]
  assert.equal(latestReview(reviews, 'PP-D-1', day(-1)).headline, 'new')
  assert.equal(latestReview(reviews.slice(0, 1), 'PP-D-1', day(-1)), null)
})

test('the card shows the desk lean while pending, a reviewing state, and the AI verdict in one line with the details behind it', () => {
  const f = disputeFacts(dispute(), { transactions: [sale('TX-1', 0), sale('TX-2', 3)], now: NOW })
  const [pending] = reviewCards([f], [], '')
  assert.deepEqual([pending.state, pending.verdictLabel, pending.againLabel], ['pending', 'Not reviewed yet', 'Review now'])
  assert.equal(pending.verdictLine, 'Desk rules lean to "agree to refund": The buyer was charged twice: refund the second charge.')
  assert.match(pending.checks, /\*\*What the desk checked\*\*\n- 5 days left to respond/)
  assert.equal(pending.why, '')
  assert.equal(pending.replyBlock, '')

  const review = { disputeId: 'PP-D-1', at: day(0), verdict: 'refund', confidence: 'high', headline: 'The buyer was charged twice',
    reasons: ['TX-1 and TX-2: same buyer, same amount, 3 minutes apart'], steps: ['Refund TX-2'], reply: 'Sorry, we refunded the second charge.' }
  const [busy] = reviewCards([f], [review], 'PP-D-1')
  assert.deepEqual([busy.state, busy.verdictLabel, busy.verdictTone, busy.againLabel], ['reviewing', 'Reviewing…', 'info', '⏳ Reviewing…'])

  const [done] = reviewCards([f], [review], '')
  assert.deepEqual([done.state, done.verdictLabel, done.verdictTone, done.againLabel], ['reviewed', 'Agree to refund', 'warning', 'Review again'])
  assert.equal(done.verdictLine, 'The buyer was charged twice')
  assert.equal(done.detailsVerdict, '**Agree to refund** (high confidence): The buyer was charged twice')
  assert.equal(done.why, '**Why**\n- TX-1 and TX-2: same buyer, same amount, 3 minutes apart')
  assert.equal(done.steps, '**Next steps**\n- Refund TX-2')
  assert.equal(done.replyBlock, '**Reply draft** (paste it in the Resolution Center)\n\nSorry, we refunded the second charge.')
  assert.match(done.detailsSubtitle, /^Claim PP-D-1 · payment TX-2 · Respond by /)
  assert.equal(reviewCards([f], [{ ...review, verdict: 'contest' }], '')[0].verdictLabel, 'Contest it')
  assert.equal(reviewCards([f], [{ ...review, verdict: 'review' }], '')[0].verdictLabel, 'Needs checking')
})

test('a charge-twice claim whose payment PayPal has not reported yet needs checking, not a contest', () => {
  const f = disputeFacts(dispute(), { transactions: [], now: NOW })
  assert.equal(f.paymentSeen, false)
  assert.equal(f.lean.verdict, 'review')
})

test('a second card payment of the same order number is a second charge, with no payer email', () => {
  const a = { ...sale('TX-1', 0, 38, ''), number: 'PD-20261109-907' }
  const b = { ...sale('TX-2', 1, 38, ''), number: 'PD-20261109-907' }
  const other = { ...sale('TX-3', 2, 38, ''), number: 'PD-20261109-908' }
  assert.equal(disputeFacts(dispute({ value: '38.00' }), { transactions: [a, b], now: NOW }).secondCharge, 'TX-1')
  assert.equal(disputeFacts(dispute({ value: '38.00' }), { transactions: [other, b], now: NOW }).secondCharge, '')
})

test('a flat MCP list row reads like the REST dispute: amount, dates and the disputed transaction', () => {
  const row = { dispute_id: 'PP-R-CIS-1', reason: 'DUPLICATE_TRANSACTION', status: 'WAITING_FOR_SELLER_RESPONSE',
    dispute_life_cycle_stage: 'CHARGEBACK', dispute_channel: 'INTERNAL', amount: '69.00', currency_code: 'USD',
    created_date: day(-1), updated_date: day(-0.5), disputed_transaction_id: '6AA3' }
  const f = disputeFacts(row, { transactions: [{ ...sale('6AA3', 3, 69), number: 'PD-1' }, { ...sale('2E17', 1, 69), number: 'PD-1' }], now: NOW })
  assert.deepEqual([f.amount, f.value, f.transactionId, f.created, f.updated, f.channel], ['$69.00', 69, '6AA3', day(-1), day(-0.5), 'INTERNAL'])
  assert.equal(f.secondCharge, '2E17')
  assert.equal(f.lean.verdict, 'refund')
})
