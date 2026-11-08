/**
 * Direct payments for the demo store: each order is a PayPal Orders v2 order
 * paid at once with a sandbox test card (no buyer approval step), and a
 * refund in the order book is a real refund of that capture once its day
 * has come. Unlike an invoice, a payment cannot be dated in the past: it is
 * made the moment the request is sent, so a run seeds today's orders only.
 *
 * Contract: amounts are integer cents internally and two-decimal USD strings
 * in request bodies; the order number travels as the purchase unit's
 * `invoice_id` and `custom_id`, which Transaction Search returns.
 */
import { CALENDAR } from '../../lib/catalog.js'
import { rng } from '../../lib/orders.js'
import { usd } from './orders.mjs'

/** A card number PayPal's sandbox accepts for testing; never a real card. */
export const TEST_CARD = { number: '4111111111111111', expiry: '2030-12', security_code: '123' }

const WEEKDAY = [1.1, 1.0, 0.97, 0.98, 1.0, 1.05, 1.12]
/** Orders on an ordinary day at the end of the seeded history (Nov 1–7: 493 orders). */
const BASE_DAY = 66

/** How many orders the store takes on `date`: the history's last level, weekday shape, store events, ±10% noise. */
export function dailyCount(date) {
  const weekday = WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()]
  const noise = 0.9 + 0.2 * rng(`day:${date}`)()
  const events = CALENDAR.filter(e => e.from <= date && date <= e.to).reduce((f, e) => f * (e.orders ?? 1), 1)
  return Math.max(1, Math.round(BASE_DAY * weekday * noise * events))
}

function address(order) {
  const out = {
    address_line_1: order.address.line1,
    admin_area_2: order.address.city,
    postal_code: order.address.postal,
    country_code: order.country,
  }
  if (order.address.state) out.admin_area_1 = order.address.state
  return out
}

/** The Orders v2 body that creates and pays one order with the test card. */
export function checkoutBody(order, card = TEST_CARD) {
  const name = `${order.buyer.first} ${order.buyer.last}`
  return {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: order.number,
      invoice_id: order.number,
      custom_id: order.number,
      description: `Order ${order.number}`,
      amount: { ...usd(order.totalCents), breakdown: { item_total: usd(order.totalCents) } },
      items: order.lines.map(l => ({
        name: l.name,
        sku: l.sku,
        quantity: String(l.qty),
        unit_amount: usd(l.unitCents),
        category: 'PHYSICAL_GOODS',
      })),
      shipping: { name: { full_name: name }, address: address(order) },
    }],
    payment_source: {
      card: { name, number: card.number, expiry: card.expiry, security_code: card.security_code, billing_address: address(order) },
    },
  }
}

/** The capture an Orders v2 answer holds: {id, status} or null. */
export function captureOf(answer) {
  const capture = answer?.purchase_units?.[0]?.payments?.captures?.[0]
  return capture ? { id: capture.id, status: capture.status } : null
}

/** The refund request for an order-book refund. */
export function refundBody(order) {
  return { amount: usd(order.refund.cents), note_to_payer: `Refund for order ${order.number}` }
}

/** The journal entries whose order-book refund is due on `today` and not yet made. */
export function dueRefunds(journal, orderOf, today) {
  return Object.entries(journal)
    .filter(([, e]) => e.captureId && !e.refundId)
    .map(([number]) => orderOf(number))
    .filter(o => o && o.refund && o.refund.date <= today)
}
