/** Invoice-list rows and store orders, shared by the tests. */
import { makeOrder, orderNumber } from '../lib/orders.js'

let seq = 0
const lastIndex = new Map()

/**
 * A store order's row as PayPal's MCP invoice list returns it (flat, no memo).
 * Its number is the next on `date` whose order-book entry has a refund when
 * `refunded`, and none otherwise, so a test knows which it gets.
 */
export function storeRow({ date, value, status = 'MARKED_AS_PAID', refunded = false }) {
  let index = lastIndex.get(date) ?? 0
  let number
  do {
    index += 1
    number = orderNumber(date, index)
  } while (Boolean(makeOrder(number, date).refund) !== refunded)
  lastIndex.set(date, index)
  seq += 1
  return {
    invoice_id: `INV2-${seq}`,
    invoice_number: number,
    status,
    amount: value,
    currency_code: 'USD',
    due_amount: /PAID|REFUND/.test(status) ? '0.00' : value,
    created_date: `${date}T12:00:00Z`,
    due_date: date,
  }
}

/** A store order as the sales board reads it, with the content given. */
export function storeOrder({ date, country = 'US', lines = [['CAB-C2C', 1]], value, refund = null, name = ['Ada', 'Lovelace'] }) {
  seq += 1
  return {
    id: `INV2-${seq}`,
    number: orderNumber(date, seq % 1000),
    date,
    country,
    items: lines,
    cents: Math.round(Number(value) * 100),
    customer: name.join(' '),
    buyer: `${name[0].toLowerCase()}${seq}@example.com`,
    refund,
  }
}

/** A Transaction Search row; `number` is the store order number carried as the invoice id. */
export function transactionRow({ id, number, at, value, code = 'T0006', status = 'S', ref }) {
  const info = {
    transaction_id: id,
    transaction_event_code: code,
    transaction_initiation_date: at,
    transaction_amount: { currency_code: 'USD', value },
    transaction_status: status,
  }
  if (number) info.invoice_id = number
  if (ref) info.paypal_reference_id = ref
  return { transaction_info: info }
}
