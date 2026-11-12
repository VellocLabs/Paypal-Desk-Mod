/**
 * Dispute review: the facts the desk checks for each open dispute, the lean
 * its rules give, and the board's review cards, which carry the AI's verdict
 * once it has written one. Pure: no I/O.
 *
 * Contract: a dispute is PayPal's dispute object (from `get_dispute`, or the
 * `list_disputes` row when the server offers no detail); orders are as in
 * `sales.js`; transactions are `normalizeTransactions` rows; `now` is ms.
 * The lean is a starting point for the AI, never an action: the desk only
 * reads PayPal, and every write is the person's to confirm.
 */
import { CATALOG } from './catalog.js'
import { addDays, dateOf, shortDate } from './dates.js'
import { refundStats } from './insights.js'

const DAY = 86_400_000
/** At or under this many dollars, contesting costs more than the refund. */
export const SMALL_AMOUNT = 25
/** Days of orders a product's refund rate is read over. */
export const RATE_DAYS = 28
/** A product refunded at least this often (percent of its orders), and twice the store's rate, looks faulty. */
export const FAULTY_RATE = 8
/** Where a merchant answers a dispute: evidence, messages and offers are not MCP tools. */
export const RESOLUTION_CENTER = 'https://www.sandbox.paypal.com/resolutioncenter'

const BY_SKU = new Map(CATALOG.map(p => [p.sku, p]))

/** PayPal's reason codes, by what answers them. */
const FAMILIES = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'not_received',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'not_as_described',
  UNAUTHORISED: 'unauthorized',
  UNAUTHORIZED: 'unauthorized',
  DUPLICATE_TRANSACTION: 'duplicate',
  CREDIT_NOT_PROCESSED: 'credit',
  INCORRECT_AMOUNT: 'amount',
  CANCELED_RECURRING_BILLING: 'credit',
}

const REASON_LABELS = {
  not_received: 'Item not received',
  not_as_described: 'Item not as described',
  unauthorized: 'Unauthorized payment',
  duplicate: 'Charged twice',
  credit: 'Refund not received',
  amount: 'Wrong amount charged',
  other: 'Other complaint',
}

const VERDICTS = {
  refund: { label: 'Agree to refund', tone: 'warning' },
  contest: { label: 'Contest it', tone: 'info' },
  review: { label: 'Needs checking', tone: 'neutral' },
}

const money = (value, currency) => {
  const text = Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return !currency || currency === 'USD' ? `$${text}` : `${currency} ${text}`
}
const round1 = x => Math.round(x * 10) / 10
const pct = (n, d) => (d ? (100 * n) / d : 0)

/** The reason code as a family (`not_received`, `duplicate`, …; `other` for the rest). */
export function reasonFamily(reason) {
  return FAMILIES[String(reason || '').toUpperCase().replace(/ /g, '_')] || 'other'
}

/**
 * What the desk can establish about one dispute without the AI: the claim,
 * deadline, the order behind it, a second charge, a refund already made, the
 * product's refund rate and the buyer's history. `checks` says each in a
 * line; `lean` is what the rules make of them.
 */
export function disputeFacts(dispute, { orders = [], transactions = [], disputes = [], now }) {
  const d = flatDispute(dispute)
  const amount = d.dispute_amount || {}
  const value = Number(amount.value || 0)
  const currency = amount.currency_code || 'USD'
  const tx = (Array.isArray(d.disputed_transactions) ? d.disputed_transactions : [])[0] || {}
  const transactionId = String(tx.seller_transaction_id || '')
  const family = reasonFamily(d.reason)
  const respondBy = String(d.seller_response_due_date || '')
  const due = Date.parse(respondBy)
  const daysLeft = Number.isFinite(due) ? Math.ceil((due - now) / DAY) : null

  // PayPal names a disputed payment by its parent reference as often as by its own id.
  const sale = transactions.find(t => t.id === transactionId || (t.reference && t.reference === transactionId)) || null
  const order = orders.find(o => o.id === transactionId)
    || (sale ? orders.find(o => o.id === sale.id) : null)
    || (tx.invoice_number ? orders.find(o => o.number === tx.invoice_number) : null)
    || (sale && sale.number ? orders.find(o => o.number === sale.number) : null)
    || null
  const buyer = String((tx.buyer && tx.buyer.email) || (order && order.buyer) || (sale && sale.payer) || '')
  // One order paid twice: the same order number, or the same payer, for the same amount within ten minutes.
  const sameBuyer = t => (sale.number && t.number === sale.number) || (sale.payer && t.payer === sale.payer)
  const twin = sale ? transactions.find(t => t !== sale && !t.refund && t.value > 0 && sameBuyer(t)
    && t.value === sale.value && Math.abs(Date.parse(t.at) - Date.parse(sale.at)) <= 10 * 60_000) : null
  const refundedCents = order && order.refund ? order.refund.cents : 0
  const refundRow = transactions.find(t => t.refund && sale && t.payer && t.payer === sale.payer && Math.abs(t.value) === sale.value)
  const alreadyRefunded = Boolean(refundedCents || refundRow || d.refund_details)

  const today = dateOf(now)
  const stats = refundStats(orders, addDays(today, -RATE_DAYS), addDays(today, -1))
  const products = order ? order.items.map(([sku]) => {
    const r = stats.products.get(sku)
    return { sku, name: (BY_SKU.get(sku) || {}).name || sku, orders: r ? r.orders : 0, rate: r ? round1(pct(r.refunds, r.orders)) : 0 }
  }).sort((a, b) => b.rate - a.rate) : []
  const storeRate = round1(pct(stats.refunds, stats.orders))
  const worst = products[0] || null
  const faulty = Boolean(worst && worst.orders >= 10 && worst.rate >= FAULTY_RATE && worst.rate >= 2 * storeRate)

  const buyerOrders = buyer ? orders.filter(o => o.buyer === buyer).length : 0
  const buyerDisputes = buyer ? disputes.filter(x => x && x !== d && ((x.disputed_transactions || [])[0] || {}).buyer
    && x.disputed_transactions[0].buyer.email === buyer).length : 0
  const protection = String(tx.seller_protection_eligible ?? '').toLowerCase()
  const messages = (Array.isArray(d.messages) ? d.messages : []).filter(m => m && m.content)
  const buyerSays = messages.filter(m => String(m.posted_by || '').toUpperCase() === 'BUYER').map(m => String(m.content))[0]
    || (messages[0] ? String(messages[0].content) : '')

  const facts = {
    id: String(d.dispute_id || d.id || ''),
    reason: String(d.reason || ''),
    family,
    claim: REASON_LABELS[family],
    stage: String(d.dispute_life_cycle_stage || '').toUpperCase(),
    channel: String(d.dispute_channel || '').toUpperCase(),
    status: String(d.status || '').toUpperCase(),
    amount: money(value, currency),
    value,
    currency,
    created: String(d.create_time || ''),
    updated: String(d.update_time || ''),
    respondBy,
    daysLeft,
    transactionId,
    payment: sale ? { id: sale.id, at: sale.at, amount: money(sale.value, sale.currency || 'USD'), number: sale.number } : null,
    order: order ? {
      number: order.number,
      date: order.date,
      customer: order.customer,
      country: order.country,
      items: order.items.map(([sku, qty]) => `${(BY_SKU.get(sku) || {}).name || sku}${qty > 1 ? ` ×${qty}` : ''}`),
      total: money(order.cents / 100, 'USD'),
    } : null,
    paymentSeen: Boolean(sale),
    secondCharge: twin ? twin.id : '',
    alreadyRefunded,
    product: worst,
    storeRate,
    faulty,
    buyer,
    buyerOrders,
    buyerDisputes,
    sellerProtection: protection === 'true' || protection === 'eligible' ? 'eligible' : protection === 'false' || protection === 'not_eligible' ? 'not eligible' : '',
    buyerSays: buyerSays.length > 280 ? `${buyerSays.slice(0, 277)}…` : buyerSays,
    allowed: Object.keys(d.allowed_response_options || {}),
  }
  facts.checks = factChecks(facts)
  facts.lean = disputeLean(facts)
  return facts
}

/**
 * A dispute in REST's shape. PayPal's MCP `list_disputes` answers flat rows
 * (`amount`, `currency_code`, `created_date`, `updated_date`,
 * `disputed_transaction_id`); REST nests them. Fields already nested win.
 */
export function flatDispute(dispute) {
  const d = dispute && typeof dispute === 'object' ? dispute : {}
  const out = { ...d }
  if (!out.dispute_amount && d.amount !== undefined) out.dispute_amount = { value: String(d.amount), currency_code: d.currency_code || 'USD' }
  if (!out.create_time && d.created_date) out.create_time = d.created_date
  if (!out.update_time && d.updated_date) out.update_time = d.updated_date
  if (!Array.isArray(out.disputed_transactions) && d.disputed_transaction_id) {
    out.disputed_transactions = [{ seller_transaction_id: d.disputed_transaction_id }]
  }
  return out
}

/** The desk's checks as lines a person reads, each {text, tone}. */
function factChecks(f) {
  const lines = []
  if (f.daysLeft !== null) {
    lines.push({ text: f.daysLeft <= 0 ? 'Response deadline passed' : `${f.daysLeft} day${f.daysLeft === 1 ? '' : 's'} left to respond`, tone: f.daysLeft <= 3 ? 'danger' : 'neutral' })
  }
  if (f.order) lines.push({ text: `Order ${f.order.number} (${shortDate(f.order.date)}): ${f.order.items.join(', ')}`, tone: 'neutral' })
  else if (f.payment) lines.push({ text: `Payment ${f.payment.id} (${f.payment.amount}) found, with no store order behind it`, tone: 'neutral' })
  else lines.push({ text: f.transactionId ? `Transaction ${f.transactionId} is not in the report yet` : 'No transaction named', tone: 'neutral' })
  if (f.family === 'duplicate') lines.push(f.secondCharge ? { text: `Second charge found: ${f.secondCharge}`, tone: 'warning' } : { text: 'No second charge found', tone: 'success' })
  if (f.alreadyRefunded) lines.push({ text: 'A refund was already made', tone: 'success' })
  if (f.product && f.product.orders) {
    lines.push({ text: `${f.product.name}: ${f.product.rate}% refunded in ${RATE_DAYS} days (store ${f.storeRate}%)`, tone: f.faulty ? 'warning' : 'neutral' })
  }
  if (f.buyer) lines.push({ text: `Buyer: ${f.buyerOrders} order${f.buyerOrders === 1 ? '' : 's'}, ${f.buyerDisputes} other dispute${f.buyerDisputes === 1 ? '' : 's'}`, tone: f.buyerDisputes ? 'warning' : 'neutral' })
  if (f.sellerProtection) lines.push({ text: `Seller protection: ${f.sellerProtection}`, tone: f.sellerProtection === 'eligible' ? 'success' : 'neutral' })
  if (f.value && f.value <= SMALL_AMOUNT) lines.push({ text: `${f.amount}: less than contesting costs`, tone: 'neutral' })
  return lines
}

/** What the rules make of the facts: {verdict: refund|contest|review, because}. */
export function disputeLean(f) {
  const lean = (verdict, because) => ({ verdict, because })
  if (f.alreadyRefunded && f.family !== 'duplicate') return lean('contest', 'The buyer was already refunded: answer with the refund record.')
  switch (f.family) {
    case 'duplicate':
      if (f.secondCharge) return lean('refund', 'The buyer was charged twice: refund the second charge.')
      if (!f.paymentSeen) return lean('review', "The disputed payment is not in PayPal's reports yet, so a second charge cannot be ruled out.")
      return lean('contest', 'Only one charge was found: show the buyer the single payment.')
    case 'credit':
      return lean('refund', 'No refund was found: make the refund the buyer is waiting for.')
    case 'not_received':
      if (f.value <= SMALL_AMOUNT) return lean('refund', 'No tracking is on file and the amount is small.')
      return lean('review', 'Contest only with tracking that shows delivery; without it, refund.')
    case 'not_as_described':
      if (f.faulty) return lean('refund', `${f.product.name} is refunded far more than the store: the buyer is likely right.`)
      if (f.value <= SMALL_AMOUNT) return lean('refund', 'The amount is small.')
      return lean('review', 'Offer a refund on return of the item, with the listing as evidence.')
    case 'unauthorized':
      if (f.sellerProtection === 'eligible') return lean('contest', 'The payment is covered by seller protection.')
      if (f.buyerOrders >= 2) return lean('contest', 'The buyer has ordered before from this account.')
      return lean('review', 'Without protection or history, the card holder usually wins.')
    default:
      if (f.value <= SMALL_AMOUNT) return lean('refund', 'The amount is small.')
      return lean('review', 'The claim needs the buyer\'s message read.')
  }
}

/**
 * The newest review the AI wrote for a dispute, or null. A review written
 * before the dispute last changed is stale, and does not count.
 */
export function latestReview(reviews, id, updated = '') {
  const mine = (Array.isArray(reviews) ? reviews : [])
    .filter(r => r && r.disputeId === id && VERDICTS[r.verdict])
    .sort((a, b) => (String(a.at || '') < String(b.at || '') ? 1 : -1))[0]
  if (!mine) return null
  if (updated && Date.parse(mine.at) < Date.parse(updated)) return null
  return mine
}

/** Markdown bullet lines. */
const bullets = list => list.filter(Boolean).map(line => `- ${line}`).join('\n')
/** A list as the details view shows it: one Markdown list item each, so the board breaks the lines itself. */
const lines = list => (Array.isArray(list) ? list : []).filter(Boolean).map(line => `- ${line}`).join('\n')

/**
 * `n` fixed text slots, one per line, each `"• line"` and empty when the list
 * is shorter: the board draws a text's newlines as spaces, so a line of a list
 * has to be its own component.
 */
const slot = (prefix, list, n) => Object.fromEntries(Array.from({ length: n }, (_, i) =>
  [`${prefix}${i + 1}`, Array.isArray(list) && list[i] ? `• ${list[i]}` : '']))

/**
 * What a dispute's to-do card shows, by dispute id: the verdict line under
 * its title, and the details view. The AI's verdict once written, else the
 * desk's checks and lean while the review is pending or running. `running`
 * is the dispute id under review now, or ''.
 */
export function reviewCards(factsList, reviews, running = '') {
  return (factsList || []).map(f => {
    const review = latestReview(reviews, f.id, f.updated)
    const busy = running === f.id
    const state = busy ? 'reviewing' : review ? 'reviewed' : 'pending'
    const verdict = review ? VERDICTS[review.verdict] : null
    const deadline = f.daysLeft === null ? 'No response date given'
      : f.daysLeft <= 0 ? 'Response overdue'
        : `Respond by ${shortDate(f.respondBy.slice(0, 10))} (${f.daysLeft} day${f.daysLeft === 1 ? '' : 's'})`
    const stage = f.stage === 'CHARGEBACK' ? (f.channel === 'EXTERNAL' ? 'Card chargeback' : 'Claim') : f.stage === 'INQUIRY' ? 'Inquiry' : 'Claim'
    const checks = bullets(f.checks.map(c => c.text))
    const reasons = review ? bullets((Array.isArray(review.reasons) ? review.reasons : []).map(String)) : ''
    const steps = review ? bullets((Array.isArray(review.steps) ? review.steps : []).map(String)) : ''
    const lean = VERDICTS[f.lean.verdict]
    const headline = review ? String(review.headline || '') : ''
    const body = [
      review ? `**${headline}**` : `**${f.lean.because}**`,
      reasons && `**Why**\n${reasons}`,
      steps && `**Next steps**\n${steps}`,
      f.buyerSays && `**The buyer says**\n\n> ${f.buyerSays.replace(/\n+/g, ' ')}`,
      review && review.reply && `**Reply draft** (paste it in the Resolution Center)\n\n${String(review.reply)}`,
      `**What the desk checked**\n${checks}`,
    ].filter(Boolean).join('\n\n')
    return {
      id: f.id,
      state,
      verdict: review ? review.verdict : '',
      verdictLabel: busy ? 'Reviewing…' : verdict ? verdict.label : 'Not reviewed yet',
      verdictTone: busy ? 'info' : verdict ? verdict.tone : 'neutral',
      verdictLine: busy ? 'The AI is reading the dispute and the payments…'
        : review ? headline
          : `Desk rules lean to "${lean.label.toLowerCase()}": ${f.lean.because}`,
      againLabel: busy ? '⏳ Reviewing…' : review ? 'Review again' : 'Review now',
      detailsTitle: `${f.claim} · ${f.amount}`,
      detailsSubtitle: `${stage} ${f.id}${f.transactionId ? ` · payment ${f.transactionId}` : ''}${f.order ? ` · order ${f.order.number}` : ''} · ${deadline}`,
      detailsLabel: verdict ? verdict.label : lean.label,
      detailsTone: verdict ? verdict.tone : lean.tone,
      detailsNote: review
        ? `AI review of ${String(review.at || '').slice(0, 16).replace('T', ' ')}`
        : 'From the desk rules; the AI has not reviewed it yet',
      detailsBody: body,
      detailsHeadline: headline || f.lean.because,
      detailsReply: review && review.reply ? String(review.reply) : 'The reply draft appears once the AI has reviewed the dispute.',
      detailsConfidence: review && review.confidence ? `${sentence(String(review.confidence))} confidence` : '',
      // One text component a line: the board draws Markdown newlines as spaces.
      ...slot('detailsWhy', review ? (review.reasons || []).map(String) : [f.lean.because], 4),
      ...slot('detailsStep', review ? (review.steps || []).map(String) : ['The AI writes the steps here when it reviews the dispute.'], 4),
      ...slot('detailsCheck', f.checks.map(c => c.text), 6),
    }
  })
}

const sentence = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()

/**
 * The heading over the dispute cards: how many wait, the money at stake and
 * how the verdicts split. `cards` are dispute to-dos with `value` and `verdict`.
 */
export function disputesNote(cards, currency = 'USD') {
  const n = cards.length
  if (!n) return ''
  const total = cards.reduce((sum, c) => sum + (Number(c.value) || 0), 0)
  const count = key => cards.filter(c => (c.verdict || '') === key).length
  const split = [[count('refund'), 'to refund'], [count('contest'), 'to contest'], [count('review'), 'to check'], [count(''), 'not reviewed yet']]
    .filter(([k]) => k).map(([k, label]) => `${k} ${label}`)
  return [`${n} waiting on you`, `${money(total, currency)} at stake`, ...split].join(' · ')
}

/** Whether a dispute waits on the merchant, so the desk reviews it. */
export function waitsOnMerchant(d) {
  const status = String((d && d.status) || '').toUpperCase()
  return status === '' || status === 'OPEN' || status === 'WAITING_FOR_SELLER_RESPONSE'
}

