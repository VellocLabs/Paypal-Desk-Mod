#!/usr/bin/env node
/**
 * Seeds a PayPal sandbox business account with what the desk shows: a few
 * sent invoices (two already overdue), a subscription plan, and, when a
 * seller transaction id is given, one chargeback through the sandbox-only
 * endpoint. Needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET of a sandbox
 * REST app in the environment. Nothing here touches a live account: the
 * host is api-m.sandbox.paypal.com and cannot be changed.
 *
 *   node scripts/seed-sandbox.mjs
 *   node scripts/seed-sandbox.mjs --chargeback <SELLER_TRANSACTION_ID>
 */

const HOST = 'https://api-m.sandbox.paypal.com'
const clientId = process.env.PAYPAL_CLIENT_ID
const clientSecret = process.env.PAYPAL_CLIENT_SECRET
if (!clientId || !clientSecret) {
  console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (a sandbox REST app) first.')
  process.exit(2)
}

const chargebackIndex = process.argv.indexOf('--chargeback')
const sellerTransactionId = chargebackIndex > 0 ? process.argv[chargebackIndex + 1] : undefined

const token = await accessToken()
const invoices = await seedInvoices(token)
const plan = await seedPlan(token)
if (sellerTransactionId) await seedChargeback(token, sellerTransactionId)

console.log('\nSeeded:')
for (const inv of invoices) console.log(`  invoice ${inv.number} ${inv.status} due ${inv.due} → ${inv.id}`)
if (plan) console.log(`  plan ${plan.name} → ${plan.id}`)
console.log('\nFor a dispute without a chargeback id: log in to the sandbox *personal* account, send money to the')
console.log('business account, copy the transaction id from the business account, then run this script with')
console.log('--chargeback <that id>. Transaction Search shows new payments after a delay of a few hours.')

async function accessToken() {
  const res = await fetch(`${HOST}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })
  if (!res.ok) throw new Error(`token: ${res.status} ${await res.text()}`)
  return (await res.json()).access_token
}

async function api(token, method, path, body) {
  const res = await fetch(`${HOST}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`)
  return text ? JSON.parse(text) : {}
}

function dateOffset(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
}

async function seedInvoices(token) {
  const recipients = [
    { given: 'Ada', surname: 'Lovelace', email: 'ada-buyer@example.com', item: 'Website redesign, phase 1', amount: '1200.00', invoiceDays: -40, dueDays: -20 },
    { given: 'Grace', surname: 'Hopper', email: 'grace-buyer@example.com', item: 'Monthly maintenance', amount: '300.00', invoiceDays: -20, dueDays: -5 },
    { given: 'Linus', surname: 'Pauling', email: 'linus-buyer@example.com', item: 'Consulting, 4 hours', amount: '480.00', invoiceDays: -2, dueDays: 12 },
    { given: 'Mary', surname: 'Jackson', email: 'mary-buyer@example.com', item: 'Logo pack', amount: '150.00', invoiceDays: 0, dueDays: 14 },
  ]
  const out = []
  for (const r of recipients) {
    try {
      const created = await api(token, 'POST', '/v2/invoicing/invoices', {
        detail: {
          currency_code: 'USD',
          invoice_date: dateOffset(r.invoiceDays),
          payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: dateOffset(r.dueDays) },
          note: 'Seeded by paypal-desk for the sandbox.',
        },
        invoicer: { name: { given_name: 'Desk', surname: 'Merchant' } },
        primary_recipients: [{ billing_info: { name: { given_name: r.given, surname: r.surname }, email_address: r.email } }],
        items: [{ name: r.item, quantity: '1', unit_amount: { currency_code: 'USD', value: r.amount } }],
      })
      const id = created.id || (created.href || '').split('/').pop()
      await api(token, 'POST', `/v2/invoicing/invoices/${id}/send`, { send_to_invoicer: false, send_to_recipient: false })
      out.push({ id, number: created.detail?.invoice_number || id, status: 'SENT', due: dateOffset(r.dueDays) })
    } catch (err) {
      console.warn(`invoice for ${r.given} skipped: ${err.message}`)
    }
  }
  return out
}

async function seedPlan(token) {
  try {
    const product = await api(token, 'POST', '/v1/catalogs/products', {
      name: 'Desk Pro',
      type: 'SERVICE',
      category: 'SOFTWARE',
      description: 'Seeded by paypal-desk.',
    })
    const plan = await api(token, 'POST', '/v1/billing/plans', {
      product_id: product.id,
      name: 'Desk Pro monthly',
      status: 'ACTIVE',
      billing_cycles: [{
        frequency: { interval_unit: 'MONTH', interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: { fixed_price: { value: '29.00', currency_code: 'USD' } },
      }],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 2 },
    })
    return { id: plan.id, name: plan.name }
  } catch (err) {
    console.warn(`plan skipped: ${err.message}`)
    return null
  }
}

async function seedChargeback(token, id) {
  try {
    const result = await api(token, 'POST', '/v2/customer-support/process-chargeback', {
      transaction: { id_enc: id },
      reason: 'INR',
      amount: { currency: 'USD', value: '20.00' },
      chargeback_type: 'FIRST',
    })
    console.log(`  chargeback created: ${JSON.stringify(result)}`)
  } catch (err) {
    console.warn(`chargeback skipped: ${err.message}`)
  }
}
