# PayPal Desk

A resident desk for PayPal merchants, built as a plugin for
[Velloc](https://velloc.app), an AI coding agent in the same family as the
terminal and IDE coding agents. Install the plugin and your PayPal account
is watched in the background: sales, refunds, overdue invoices and open
disputes as live figures, each thing that needs a decision as a case, and an
agent that works the case with PayPal's own tools and asks you before it
changes anything.

Built for the PayPal AI Hackathon 2026 against the PayPal **sandbox**.

## What it does

```
 PayPal MCP server ──▶ background module (resident, every 5 min)
 (sandbox, OAuth)      │ reads invoices, disputes, plans, transactions
                       │ derives figures, series and cases
                       ▼
                 app state  ──▶ dashboard (live, partial re-render)
                       ▲              │ "Work this case"
                       │              ▼
   ~/Documents/paypal-desk/inbox   session agent ──▶ PayPal MCP tools
   (declared folder, consented)        │ every write is confirmed by you
                                       ▼
                                 data/handled.json
```

- **Background module** (`app-bg.js`): one worker that lives as long as
  Velloc runs, with or without the dashboard open. It only reads PayPal.
- **Dashboard** (`app/app.a2ui`): Overview, Cases, Invoices, Disputes, Plans.
  The agent can reshape it on request ("show refunds by week") by editing
  the file and rebuilding.
- **Cases**: open disputes with their response deadline, overdue invoices,
  a refund spike, two payments that look like one, a new request file in
  the inbox folder.
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
monthly plan. For a dispute: send money from your sandbox personal account
to the business account, copy the transaction id, and run
`npm run seed -- --chargeback <id>`; the sandbox-only chargeback endpoint
opens a dispute on it. Transaction Search shows new payments only after a
few hours, so seed early.

## Try it

- Open the desk. Overview shows the figures; Cases lists the overdue
  invoices and the dispute.
- Press *Work this case* on the dispute. The agent reads it with
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
app/                            the seed: app.a2ui, AGENTS.md, data/state.json
hooks/guard.js                  the confirmation gate on PayPal writes
skills/paypal-rules/SKILL.md    operating rules and the tool map
templates/board/template.md     the app's session: tools, MCP scoped to this plugin, skills
scripts/seed-sandbox.mjs        sandbox seeding
tests/                          node tests (npm test)
```

## Tests

```bash
npm test
```

Node 22 or later. The tests cover the manifest, the guard's decisions, the
state derived from PayPal's reads, inbox copying and the module's lifecycle
against a stand-in runtime.

## License

MIT.
