/**
 * The store-order summary kept in an invoice memo, which the invoice list
 * returns (it does not return items, the bill-to address or refunds):
 * `paypal-desk demo | country=US | items=CAB-C2C*2,MOU-ERGO*1 | refund=2026-10-05:24.00`.
 * The refund part is the store's record of a refund: no refund is recorded on
 * PayPal itself, since PayPal's MCP server refuses an invoice-list page that
 * holds a refunded invoice.
 */

export const MEMO_TAG = 'paypal-desk demo'

/** `order`: {country, lines: [{sku, qty}], refund?: {date, cents}}. */
export function orderMemo(order) {
  const parts = [MEMO_TAG, `country=${order.country}`, `items=${order.lines.map(l => `${l.sku}*${l.qty}`).join(',')}`]
  if (order.refund) parts.push(`refund=${order.refund.date}:${(order.refund.cents / 100).toFixed(2)}`)
  return parts.join(' | ')
}

/** Reads an `orderMemo` text back as {country, items: [{sku, qty}], refund: {date, value} | null}; null for any other memo. */
export function parseOrderMemo(text) {
  if (typeof text !== 'string' || !text.startsWith(`${MEMO_TAG} |`)) return null
  const fields = Object.fromEntries(text.split(' | ').slice(1).map(part => {
    const at = part.indexOf('=')
    return [part.slice(0, at), part.slice(at + 1)]
  }))
  if (!/^[A-Z]{2}$/.test(fields.country || '') || !fields.items) return null
  const items = fields.items.split(',').map(entry => {
    const [sku, qty] = entry.split('*')
    return { sku, qty: Number(qty) }
  })
  if (items.some(i => !i.sku || !Number.isInteger(i.qty) || i.qty < 1)) return null
  let refund = null
  const m = /^(\d{4}-\d{2}-\d{2}):(\d+\.\d{2})$/.exec(fields.refund || '')
  if (m) refund = { date: m[1], value: m[2] }
  return { country: fields.country, items, refund }
}
