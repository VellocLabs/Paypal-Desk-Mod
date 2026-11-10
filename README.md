# PayPal Desk

A resident desk for PayPal merchants, built as a plugin for
[Velloc](https://velloc.app), an AI coding agent in the same family as the
terminal and IDE coding agents. Install the plugin and your PayPal account
is watched in the background: your store's sales by day, country and
product, refunds, overdue invoices and open disputes as live figures, each thing that needs a decision as a case, and an
agent that works the case with PayPal's own tools and asks you before it
changes anything.

Built for the PayPal AI Hackathon 2026 against the PayPal **sandbox**.

## What it does

```
 PayPal MCP server ──▶ background module (resident, every 5 min)
 (sandbox, OAuth)      │ reads invoices, disputes, transactions
                       │ derives the sales board and the to-dos
                       ▼
                 app state  ──▶ dashboard (live, partial re-render)
                       ▲              │ "Ask AI" on a to-do
                       │              ▼
   ~/Documents/paypal-desk/inbox   session agent ──▶ PayPal MCP tools
   (declared folder, consented)        │ every write is confirmed by you
                                       ▼
                                 data/handled.json
```

- **Background module** (`app-bg.js`): one worker that lives as long as
  Velloc runs, with or without the dashboard open. It only reads PayPal.
- **Dashboard** (`app/app.a2ui`): *Overview* shows the last 7 days: net sales,
  orders, average order value and refunds against the week before, sales by
  country, daily sales, top products and the latest orders. *Trends* draws
  the last 4 weeks as line charts: net sales, orders, order value, refund
  rate and sales by country, with the products that moved most.
  *Actions* lists what needs you, with a red count on its tab, and the desk
  opens on it while anything is open. The agent can reshape it on request ("show refunds by
  week") by editing the file and rebuilding.
- **Store orders**: an order is a paid invoice numbered `PD-YYYYMMDD-NNN`.
  PayPal gives its amount, status and day; the store's order book
  (`lib/orders.js`) gives the buyer, country, products and any refund, which
  follow from the number alone, since PayPal's MCP invoice list returns a
  flat row with no memo, items or recipient. The module keeps 62 days of
  orders in its store, reads only the newest pages on each sync and every
  page once an hour (`lib/sales.js` does the figures). A direct payment
  whose invoice id is such a number is an order too, on the day it was
  made, with its refunds as PayPal's Transaction Search lists them.
- **Actions**: first the action list: open disputes with their response
  deadline, overdue invoices, two payments that look like one, a new
  request file in the inbox folder, and every alert rule that is met. Each
  is an event: an emoji, what happened with the figure ("Refund rate rose
  to 6.4%"), the rule it came from and the AI's conclusion. *Ask AI* drafts
  a question about one in the chat box; *Mark done* keeps the card as it
  is for 7 days, with a ✅ in place of its emoji, and it opens again if it is still true; its ⋯
  menu, in place of the buttons, can undo it or delete it.
  Below it, the alert rules, as settings: the built-in PayPal disputes
  rule, and the rules you set by asking the AI (a product's refund rate
  above 10%, weekly sales under a floor, a country's orders dropping), each
  with its condition in words; the dashed plus
  card at the end of the grid drafts a new one. A met rule is analyzed by
  the AI
  on its own (`lib/alerts.js` checks the rules). For what a plain rule
  cannot say (no sales two weeks running, a week under its 4-week average)
  the AI writes a formula, which the desk reads itself (`lib/formula.js`);
  no alert runs code.
- **Dispute review** (`lib/disputes.js`): for each open dispute that waits
  on you, the desk checks what it can on its own: the deadline, the order
  behind the payment, a second charge, a refund already made, the
  product's refund rate against the store's, the buyer's history and seller
  protection, and what its rules lean to. Then the AI reviews it in the
  background, with `get_dispute` and the `paypal-rules` skill, and writes a
  verdict on the dispute's card: *Refund*, *Contest* or *Your call*, why,
  what was checked, the next steps and a reply draft for the Resolution
  Center. The primary button drafts "go with your review" into the chat;
  nothing changes on PayPal until you confirm. It never accepts a claim on
  its own.
- **Confirmation** (`hooks/guard.js`): a PayPal tool that creates, sends,
  refunds, cancels or accepts anything opens a confirmation dialog, whatever
  the session's permission mode. Reads pass.
- **Inbox folder**: the plugin declares `~/Documents/paypal-desk/inbox`
  read-only. You approve it when you turn the plugin on. Drop a CSV or a
  text request there and a case appears; the agent drafts the invoice and
  sends it only when you confirm.
- **Rules** (`skills/paypal-rules/SKILL.md`): what a careful merchant does
  about disputes, invoices, refunds and subscriptions, and which tool does
  what.

PayPal provides the hands (its MCP server). Velloc provides the brain (the
model, the background runtime, the confirmation gate, the dashboard).

## Install

1. Velloc on the **beta** channel (About → channel). Apps are a beta
   feature.
2. Link this folder as a plugin and restart Velloc:
   - Windows: `mklink /J %USERPROFILE%\.velloc\plugins\paypal-desk D:\path\to\paypal-desk`
   - macOS/Linux: `ln -s /path/to/paypal-desk ~/.velloc/plugins/paypal-desk`
3. Settings → Plugins & Mods → turn **paypal-desk** on. Approve the inbox
   folder when asked.
4. Sign in to PayPal: the plugin's server is PayPal's sandbox MCP server,
   which signs in through your browser (OAuth). Use a **sandbox business
   account** from https://developer.paypal.com/dashboard/.
5. Press the wallet icon in the top bar. The desk opens with its pane
   maximized and fills in after the first sync.

## Seed the sandbox

A fresh sandbox account has nothing to show.

```bash
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm run seed
```

The script creates four sent invoices (two overdue), a product and a
monthly plan.

The store's order history is a second script: 2,500 orders of a 33-product
accessories store from Oct 1 to Nov 7, each recorded as a paid invoice on its
own date, newest day first. The memo repeats the order for a person reading
the invoice; a refund stays in the order book and the memo, and is not
recorded on PayPal (see *Known PayPal issues*). It takes about an hour and can
be stopped and run again; `--dry-run` prints the plan and calls nothing.

```bash
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm run seed:orders
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm run seed:orders -- --from 2026-11-08 --to 2026-11-10
```

The dashboard's windows end yesterday, so before a demo add the days since
the last run with `--from`/`--to`.

From Nov 8 on, the store takes its orders as direct payments instead: each
order is a PayPal Orders v2 order paid at once with PayPal's sandbox test
card, so PayPal holds a real capture, and a refund in the order book is a real
refund of it once its day has come. A payment is dated when it is made, so
this script takes today's orders only; run it once a day. The REST app's
sandbox account must accept card payments.

```bash
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm run seed:payments -- --dry-run
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm run seed:payments -- --orders 1
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm run seed:payments
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm run seed:payments -- --check
```

### Test disputes

One dispute for each case the dispute review decides differently: an
order paid twice, a small and a large item-not-received, an item not as
described, an unauthorized payment. Each is a store order paid with the
sandbox test card, then a chargeback on its capture through the
sandbox-only endpoint. `--dry-run` prints the orders and the expected
verdicts; a second run skips what is done.

```bash
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm run seed:disputes -- --dry-run
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm run seed:disputes
```

PayPal's sandbox chargeback endpoint answers 500 for a card capture. With
`--wallet` each payment is made from the sandbox personal account instead:
the first run prints an approval link per payment; approve each one signed
in as the buyer, then run the same command again to capture the payments and
open the chargebacks.

```bash
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm run seed:disputes -- --wallet
```

### Known PayPal issues

**Refunded invoices empty the list.**

PayPal's MCP server checks each answer against its own output schema before
sending it, and `list_invoices`' schema lists no `MARKED_AS_REFUNDED` or
`PARTIALLY_REFUNDED` status. A page holding one refunded invoice is refused
whole (`-32602 Output validation error … received 'MARKED_AS_REFUNDED' at
invoices[30].status`). The desk reads a refused page again in pages of 10, 5
and 1 and skips only what is still refused, within 300 extra calls a sync;
the sync note counts what it could not read. Sandbox data seeded before the
seeder stopped recording refunds can be repaired: this deletes the recorded
refunds of the store's invoices, which then read as paid; the board takes
their refunds from the order book.

```bash
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm run undo-refunds -- --dry-run
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm run undo-refunds
```

**The list's rows carry no memo.** `list_invoices` on PayPal's MCP server
answers flat rows (`invoice_id`, `invoice_number`, `status`, `amount` as a
string, `due_date`, `created_date`) without the memo, items or bill-to that
the REST API returns, and the server offers no tool that reads one invoice.
So the store's order content cannot travel on PayPal; the desk reads it from
the order book by the invoice number. For a dispute: send money from your sandbox personal account
to the business account, copy the transaction id, and run
`npm run seed -- --chargeback <id>`; the sandbox-only chargeback endpoint
opens a dispute on it. Transaction Search shows new payments only after a
few hours, so seed early.

## Try it

- Open the desk. *Overview* shows the week's sales; *Actions* lists the
  overdue invoices and the dispute.
- Under *Dispute review*, the dispute's card shows the desk's checks at
  once and the AI's verdict a minute or two later. Press its primary button
  (*Refund $…* or *Prepare the answer*) and send the drafted request.
- Press *Ask AI* on the dispute and send the drafted question. The agent reads it with
  `get_dispute`, explains it, recommends, and calls a tool. The confirmation
  dialog names the call; allow or refuse there.
- Drop `inbox-example.csv` into `~/Documents/paypal-desk/inbox`. Within five
  minutes a case appears; the agent drafts the invoice from it.
- Ask "show me refunds as a bar chart by week" and watch the dashboard
  change.

## Layout

```
.claude-plugin/plugin.json      the manifest: the app, its background module, the inbox folder
.mcp.json                       PayPal's sandbox MCP server (OAuth, no stored secret)
app-bg.js                       the background module
lib/                            the catalog, the order book, the order memo, dates, the sales board, dispute review
app/                            the seed: app.a2ui, AGENTS.md, data/state.json
hooks/guard.js                  the confirmation gate on PayPal writes
skills/paypal-rules/SKILL.md    operating rules and the tool map
templates/board/template.md     the app's session: tools, MCP scoped to this plugin, skills
scripts/seed-sandbox.mjs        sandbox seeding: invoices, a plan
scripts/seed-orders.mjs         sandbox seeding: the store's order history
scripts/undo-refunds.mjs        deletes recorded refunds on the store's invoices
tests/                          node tests (npm test)
```

## Tests

```bash
npm test
```

Node 22 or later. The tests cover the manifest, the guard's decisions, the
sales board, the order generator, the state derived from PayPal's reads, the
invoice paging and cache, inbox copying and the module's lifecycle against a
stand-in runtime.

## License

MIT.
