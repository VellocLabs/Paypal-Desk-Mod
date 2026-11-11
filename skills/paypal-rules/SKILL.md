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
- Check what this connection offers before you plan a call: the sandbox
  connection may list disputes with no `get_dispute`, and offer no refund
  or accept tool. Then the decision is still yours to give; the merchant
  carries it out in the Resolution Center.

### Refund or contest

Decide by the claim, then weigh the costs. Each line names the fact that
settles it.

| Claim | Refund when | Contest when |
| --- | --- | --- |
| Charged twice | A second charge, same buyer and amount, within minutes | Only one charge exists: show it |
| Refund not received | No refund was made | The refund was made: show its record |
| Item not received | No tracking that shows delivery, or the amount is small | Tracking shows delivery to the buyer's address |
| Not as described | The product is refunded far above the store's rate (a faulty batch), or the amount is small | The listing matches what was sent; offer a refund on return first |
| Unauthorized | Neither seller protection nor buyer history | The payment has seller protection, or the buyer has ordered before |

- **Small amounts.** At or under $25, contesting costs more than the refund
  (time, and a chargeback fee if it escalates): refund, unless the buyer
  was already refunded.
- **Earlier is cheaper.** An inquiry settled by a refund never becomes a
  claim or a chargeback; a chargeback adds the issuer's fee and is decided
  by the bank.
- **A pattern is not one case.** A buyer with other disputes, or a product
  refunded far above the store, changes the answer: say so in the review.
- **Say when it is the merchant's call.** When facts cut both ways or one
  is missing (no tracking on file for a large order), give the verdict
  `review` and name the fact that would settle it.

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

## Write what to do

Every analysis ends with one `act` in its finding, which the board shows as a
badge on the alert. The four words describe the response, not the metric, so
they fit whatever the person asked to watch:

- `fix` — something is wrong and a concrete step is named: pull the product,
  refund the buyer, correct the listing, chase the carrier.
- `adjust` — nothing is broken; a plan changes because of the figure: restock,
  shift a budget, move a price, follow up a large order, keep a campaign
  running.
- `watch` — no action this week; the figure is worth the next look.
- `check` — the evidence does not decide it: name the fact that would (the
  buyer's message, tracking, another week of data).

Those four are the defaults, not the whole list. When none of them says the
thing to do, put your own two or three words in `act` (`email-the-buyers`,
`raise-the-price`, `pause-the-ads`) and the board badges it as written — with
`action` still naming the concrete step.

The same four answer very different alerts. A product refunded far above the
store is `fix`, and `action` names what to pull. Sales up 30% in a week is
`adjust`, and `action` names what to do about the demand, or `watch` if one
week says nothing yet. A product with no orders for a week is `watch` or
`check`, never `fix` on one quiet week.

Analyze the alert's own subject. A sales alert is about what drove the rise
and whether it holds (a campaign, a country, one product); a refund alert is
about which orders and why; an orders alert is about which country or channel
moved. The conclusion, the action and the reply are written for that subject —
never a standing paragraph reused from another alert.

Keep the finding's `title` to one line (about 90 characters), since the board
cuts it there; the argument goes in `conclusion`, and the concrete step in
`action`.

## After an analysis, offer to watch it

An analysis that found something worth knowing next time ends with one
recommendation: watch the **class** of thing, not the one row that tripped
it. The rule you offer should catch the next product, the next country, the
next duplicate — the one in hand is only the evidence for it.

Give the rule **two bounds wherever both make sense**: an absolute line, and
a move from where the figure was. The line catches what is already bad; the
move catches the thing that was fine and turned — a product whose refund
rate doubles from 0.4% to 0.9% deserves a look even though it never reaches
the line. Say both in the offer, with today's figure.

- A product refunded far above the store: "Shall I watch every product's
  weekly refund rate? I would alert you when any product goes above 10%, or
  rises more than 3 points on the week before — the 65W charger is at 33.3%,
  up from 2.7%." In `data/alerts.json`: `scope: "any_product"`, `above: 10`,
  `riseAbove: 3`. Not a rule for the charger alone.
- A country's orders falling: watch every country (`each: "country"`, or a
  `country` scope), with a floor and a drop from the week before; unless the
  fall is store-wide, in which case watch the store.
- A week's sales under a floor: the store's floor, and a drop against its
  own 4-week average — a store at $9K that always ran $9K is not the problem
the rule is for.
- One payment made twice: the rule that catches any second charge of one
  order, not that payer.

Bounds are set where they would have warned you before the damage, not at
today's figure: a line just under what the store tolerates, a move far
smaller than the one just seen.

Narrow it to one SKU, country or customer only when that thing is special in
a way the general rule cannot hold — a product whose normal refund rate is
high enough to need its own ceiling, a reseller whose orders are larger than
the rest — or when the person asked for that one. Say which it is and why it
is narrow.

Offer once per finding, one rule at a time unless both follow from it. On
yes, write the rule into `data/alerts.json` keeping the rules already there,
then say what it reads now and whether it is met.

## Reporting

- `list_transactions` lists at most 31 days a call and lags up to three
  hours (longer in sandbox). For a month, call it once per 31-day window.
- Event codes: `T00xx` are payments, `T11xx` refunds and reversals, `T15xx`
  disputes and holds. A negative amount is money out.
