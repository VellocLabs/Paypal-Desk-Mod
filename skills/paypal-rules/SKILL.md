---
name: paypal-rules
description: Operating rules for a merchant's PayPal account — disputes, invoices, refunds, subscriptions — and which PayPal MCP tool does what. Load before acting on a case.
---

# PayPal operating rules

These are the rules a careful merchant follows. They are written for the
desk's agent; PayPal's own documentation is the authority where they differ
(https://developer.paypal.com/docs/).

## Tools, by task

| Task | Read with | Change with |
| --- | --- | --- |
| Invoices | `list_invoices`, `get_invoice`, `search_invoicing` | `create_invoice`, `send_invoice`, `send_invoice_reminder`, `cancel_sent_invoice`, `record_payment_for_invoice`, `record_refund_for_invoice`, `delete_invoice` (drafts only) |
| Disputes | `list_disputes`, `get_dispute` | `accept_dispute_claim` (concede and refund) |
| Payments and refunds | `list_transactions`, `get_order`, `get_refund` | `create_refund` (needs the capture id) |
| Subscriptions | `list_subscription_plans`, `show_subscription_plan_details`, `show_subscription_details` | `create_subscription_plan`, `create_subscription`, `update_subscription`, `cancel_subscription` |
| Reporting | `list_transactions` (`start_date`, `end_date`, up to 31 days a call), `get_merchant_insights` | — |

Everything on the right changes the account and opens a confirmation. Reads
never do. Evidence upload, dispute messages and payouts are not MCP tools;
say so and point the person at the PayPal Resolution Center instead of
improvising.

## Disputes

- A dispute moves through stages: inquiry (the buyer asks), chargeback or
  claim (PayPal or the card issuer holds the amount), review, resolved.
  Only the current stage matters for what you can do.
- `seller_response_due_date` is a hard deadline. Missing it usually means the
  buyer wins by default. Within three days: urgent.
- Reasons fall into two families. *Item not received* and *not as described*
  are about delivery and the product; the strong answer is tracking, delivery
  confirmation and the listing. *Unauthorized* is about the account; the
  strong answer is proof the buyer used the service. Do not argue a
  not-received dispute with product photos.
- `accept_dispute_claim` concedes: PayPal refunds the buyer from the
  merchant's balance and closes the dispute. Recommend it when the amount is
  small relative to the time to contest, when the merchant has no evidence,
  or when the buyer is clearly right. Never call it for a dispute the
  merchant has not seen.
- Transactions in a dispute can still be refunded directly with
  `create_refund`; a full refund resolves most inquiries without a claim.

## Invoices

- Statuses: `DRAFT` (not sent, deletable), `SENT`/`UNPAID` (payable),
  `PARTIALLY_PAID`, `PAID`, `MARKED_AS_PAID` (paid outside PayPal),
  `CANCELLED`. Past the due date an unpaid invoice is overdue; PayPal does not
  change its status.
- Reminder cadence: one reminder at seven days overdue, one at fourteen;
  after thirty days ask the person whether to cancel. Never send two
  reminders in one day.
- `cancel_sent_invoice` tells the recipient; `delete_invoice` works on drafts
  only. A paid invoice is never cancelled; record a refund instead.
- Drafting from a request: one line item per row with quantity and unit
  amount, the recipient's name and email, a currency, a due date (net 14 by
  default). Confirm the total with the person before `send_invoice`.

## Refunds

- Refund the capture, not the order. Partial refunds take an `amount`; omit
  it for a full refund.
- A refund is final. State the amount, the currency and the payee before the
  call. PayPal keeps its fixed fee on most refunds; the merchant pays it.
- Refunds are allowed up to 180 days after the payment; older ones need a
  manual payment.

## Subscriptions

- A plan is the price schedule; a subscription is one buyer on a plan.
  Cancelling a plan does not cancel its subscriptions.
- `cancel_subscription` takes a reason the buyer sees. Suggest `update_subscription`
  (a price or quantity change) before a cancellation when the buyer asked for
  a change, not an end.

## Reporting

- `list_transactions` lists at most 31 days a call and lags up to three
  hours (longer in sandbox). For a month, call it once per 31-day window.
- Event codes: `T00xx` are payments, `T11xx` refunds and reversals, `T15xx`
  disputes and holds. A negative amount is money out.
