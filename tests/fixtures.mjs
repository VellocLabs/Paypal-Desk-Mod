/** Invoice-list rows shaped as PayPal returns them, shared by the tests. */
import { orderMemo } from '../lib/memo.mjs'

let seq = 0
/** An invoice-list row as PayPal returns it, for a store order. */
export function storeRow({ date, country = 'US', lines = [['CAB-C2C', 1]], value, status = 'MARKED_AS_PAID', refund, name = ['Ada', 'Lovelace'], email }) {
  seq += 1
  const number = `PD-${date.replaceAll('-', '')}-${String(seq).padStart(3, '0')}`
  return {
    id: `INV2-${seq}`,
    status,
    detail: {
      invoice_number: number,
      invoice_date: date,
      memo: orderMemo({ country, lines: lines.map(([sku, qty]) => ({ sku, qty })), refund }),
    },
    primary_recipients: [{ billing_info: { name: { given_name: name[0], surname: name[1] }, email_address: email ?? `${name[0].toLowerCase()}${seq}@example.com` } }],
    amount: { currency_code: 'USD', value },
  }
}
