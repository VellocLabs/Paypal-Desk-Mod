/**
 * The PayPal Desk background module. One resident worker per Velloc: on a
 * timer it reads the merchant's invoices, disputes and recent transactions
 * through the plugin's PayPal MCP server, keeps the store's orders (the
 * paid invoices numbered `PD-YYYYMMDD-NNN`) in its store, derives the sales
 * board and the open cases, and copies invoice requests dropped into the
 * declared inbox folder into the app's folder for the session agent.
 *
 * Contract: the module only reads PayPal. Every write (a refund, a reminder,
 * an accepted claim) is the session agent's, and the session hook puts it
 * to the person first. State is the app's `/data`: it is kept small, since
 * the whole of it travels with every dashboard action. It is published one
 * top-level key per patch, so a day's rollover that changes every figure is
 * still a handful of patches.
 */
import { addDays, dateOf, shortDate } from './lib/dates.js'
import { alertSeries, checkRules, disputeAlerts } from './lib/alerts.js'
import { refundBreakdown } from './lib/insights.js'
import { disputeFacts, disputesNote, flatDispute, latestReview, reviewCards, waitsOnMerchant } from './lib/disputes.js'
import { isProduct, productTrend } from './lib/productTrend.js'
import { productsBoard } from './lib/products.js'
import { invoiceRowFields, paymentOrders, readStoreRow, salesBoard } from './lib/sales.js'

export const POLL_MS = 5 * 60_000
export const SERVER = 'paypal'
export const ROW_CAP = 50
export const CASE_CAP = 30
export const PAGE_SIZE = 100
export const MAX_PAGES = 60
/** Page sizes a refused invoice page is read again in, largest first. */
export const PAGE_LADDER = [PAGE_SIZE, 10, 5, 1]
/** The highest page number the list accepts. */
export const MAX_PAGE_NUMBER = 1000
/** Extra list calls one sync may spend reading refused pages again. */
export const FALLBACK_CALLS = 300
/** Every invoice page is read again this often, so a refund or a deletion on an old invoice is seen. */
export const FULL_SCAN_MS = 60 * 60_000
/** Orders older than this many days are not kept. */
export const KEEP_DAYS = 62
const TRANSACTION_DAYS = 30
/** Transaction Search pages one sync reads at most (500 rows each). */
export const TRANSACTION_PAGES = 10
export const PAYMENTS_KEY = 'payments.cache'
const INBOX_EXTENSIONS = ['.csv', '.json', '.txt', '.md']
const HANDLED_FILE = 'data/handled.json'
/** The person's alert rules; the session agent writes them, the module checks them every sync. */
export const ALERTS_FILE = 'data/alerts.json'
/** Conclusions the agent wrote after an analysis, newest first on the board. */
export const FINDINGS_FILE = 'data/findings.json'
/** The refund breakdown the agent reads to explain a change; rewritten when it changes. */
export const REFUNDS_FILE = 'data/refunds.json'
const FINDINGS_SHOWN = 5
/** The AI's dispute reviews: it writes them, the board shows them on the dispute's card. */
export const REVIEWS_FILE = 'data/reviews.json'
/** The product a tab was asked for: {"sku": "DSK-HOOK", "days": 30}. The agent writes it. */
export const WATCH_FILE = 'data/watch.json'
/** What the desk checked for each open dispute, for the AI to start from; rewritten when it changes. */
export const DISPUTES_FILE = 'data/disputes.json'
/** Each open dispute's `get_dispute` answer, by id, with the update time it was read at. */
export const DETAILS_KEY = 'dispute.details'
/** Which dispute versions had a review started, and when: {"<id>@<update time>": ms}. */
export const REVIEWS_KEY = 'reviews.tried'
/** Which alert weeks had an analysis started, and when: {"<alert id>@<week>": ms}. */
export const ANALYSES_KEY = 'analyses'
/** How long an analysis that ended without a finding waits before it is started again. */
export const ANALYSIS_RETRY_MS = 6 * 3_600_000
const NEEDS_SHOWN = 3
/** Days a to-do marked done stays hidden; it comes back after them if it is still true. */
export const DONE_DAYS = 7
/** How often the module looks for a changed alert or finding file between syncs. */
export const RULES_WATCH_MS = 10_000
/** The sign-in phases the runtime reports for a server. */
export const PHASES = new Set(['needs-sign-in', 'signing-in', 'signed-in'])
/** How soon a sync that found the connection coming back is tried again. */
export const RETRY_MS = 10_000
const SEEN_KEY = 'inbox.seen'
export const ORDERS_KEY = 'orders.cache'

let pending = Promise.resolve()

/** Resolves when the sync in flight, if any, has finished. For tests. */
export function whenIdle() {
  return pending
}

export function register(on) {
  let timer = null
  let watch = null
  let retry = null
  let running = false

  on('app.start', async ($, e) => {
    if (timer) timer.cancel()
    // A stopped module's badge is cleared by the host, so a start sends the count again.
    badgeSent = undefined
    const inbox = e.folders && e.folders.read && e.folders.read[0]
    // PayPal answered with a connection that was still coming back: try again soon, once.
    const scheduleRetry = () => {
      if (retry) return
      retry = $.clock.every(RETRY_MS, async () => {
        if (retry) { retry.cancel(); retry = null }
        await run()
      })
    }
    const tick = async () => {
      if (running) return
      running = true
      try {
        await syncOnce($, { inbox, now: await $.clock.now(), onRetry: scheduleRetry })
        // Whichever sync first reads the board after a sign-in opens it for the page that asked.
        if (boardLoaded && pendingClient !== null) {
          const client = pendingClient
          pendingClient = null
          await view($, 'open', client)
          await releaseBusy($)
        }
      } catch (err) {
        await $.log.warn(`sync failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        running = false
      }
    }
    // A sync asked for while one runs waits for it and then runs once more, so the caller sees fresh data.
    let queued = null
    const run = () => {
      if (!running) {
        pending = tick()
        return pending
      }
      if (!queued) queued = pending.then(() => { queued = null; return tick() })
      pending = queued
      return queued
    }
    // The first full invoice read can outlast app.start's budget, so it is not awaited.
    kick = run
    run()
    timer = $.clock.every(POLL_MS, run)
    // A rule or finding the agent just wrote shows on the board within seconds, not at the next sync.
    if (watch) watch.cancel()
    watch = $.clock.every(RULES_WATCH_MS, async () => {
      if (!running && (await rulesText($)) !== rulesSeen) await run()
    })
  })

  on('app.stop', async () => {
    if (busyHold) {
      busyHold.cancel()
      busyHold = null
    }
    if (timer) timer.cancel()
    if (watch) watch.cancel()
    if (retry) retry.cancel()
    timer = null
    watch = null
    retry = null
    kick = null
  })

  // The runtime follows the sign-in service. Signed out, the pane goes away with the
  // account; signed in, the board is read and the pane opened for whoever asked.
  on('mcp.status', async ($, e) => {
    if (!e || e.server !== SERVER) return
    const next = String(e.phase || '')
    if (!PHASES.has(next)) return
    const before = paypalPhase
    paypalPhase = next
    if (next === 'needs-sign-in') {
      boardLoaded = false
      pendingClient = null
      lastDisputes = null
      await releaseBusy($)
      await view($, 'close')
      // The pane is gone; the board behind it becomes the gate, for whoever opens it.
      if (kick) await kick()
      return
    }
    if (next === 'signed-in' && ((before && before !== next) || !boardLoaded)) {
      await holdBusy($)
      try {
        if (kick) await kick()
      } finally {
        // A sign-in waiting for its pane stays at work until the sync that reads the board opens it.
        if (pendingClient === null || !paypalPhase || paypalPhase === 'needs-sign-in') await releaseBusy($)
      }
    }
  })

  // A press on the icon: signed out it signs in, unread it loads first, and the pane
  // is opened by the module once there is something to show.
  on('app.press', async ($, e) => {
    const answer = await answerPress(e)
    if (answer.signIn) {
      // From the press to the open pane the icon shows the desk at work: the sign-in, then the first read.
      pendingClient = clientOf(e)
      await holdBusy($)
    }
    if (answer.handled === true) {
      const client = clientOf(e)
      void (async () => {
        await holdBusy($)
        try {
          if (kick) await kick()
          if (boardLoaded) await view($, 'open', client)
        } finally {
          if (pendingClient === null) await releaseBusy($)
        }
      })()
    }
    return answer
  })

  // Opening the pane refreshes it: a fresh read, or the gate when PayPal does not answer.
  on('app.show', async () => {
    if (kick) await kick()
  })

  on('app.action', async ($, e) => {
    try {
      return await handleAction($, e)
    } catch (err) {
      // A local action that fails is still the board's: it must never fall through to the model.
      await $.log.warn(`action ${e && e.action} failed: ${err instanceof Error ? err.message : String(err)}`)
      return { handled: true }
    }
  })
}

/**
 * The board's local actions, each changing its file and the board at once:
 * `dismiss_finding` {id} removes a finding; `mark_done` {id} moves a to-do to
 * the done list for DONE_DAYS; `undo_done` {id} puts it back on the open
 * list; `delete_todo` {id} takes it off both for DONE_DAYS. Answers
 * {handled: false} for any other action, which then goes to the model.
 * Alerts are changed and removed by the session agent, asked through the
 * composer.
 */
export async function handleAction($, e) {
  const id = e && e.context && typeof e.context.id === 'string' ? e.context.id : ''
  const todoAction = e && TODO_ACTIONS[e.action]
  if (todoAction && id) return changeTodo($, id, todoAction)
  if (e && e.action === 'review_dispute' && id) return reviewAgain($, id)
  if (e && e.action === 'open_details') return { handled: true }
  if (e && e.action === 'toggle_done') return toggleDone($)
  const target = e && e.action === 'dismiss_finding' ? { file: FINDINGS_FILE, key: 'findings' } : null
  if (!target || !id) return { handled: false }
  const doc = await readJsonFile($, target.file)
  const list = Array.isArray(doc && doc[target.key]) ? doc[target.key] : []
  const kept = list.filter(item => !(item && item.id === id))
  if (kept.length !== list.length) await $.fs.write(target.file, `${JSON.stringify({ ...doc, [target.key]: kept }, null, 2)}\n`)
  await updateState($, state => {
    const shown = Array.isArray(state[target.key]) ? state[target.key] : []
    return shown.some(item => item.id === id) ? { ...state, [target.key]: shown.filter(item => item.id !== id) } : null
  })
  return { handled: true }
}

const TODO_ACTIONS = { mark_done: 'done', undo_done: 'open', delete_todo: 'deleted' }

/** Folds or unfolds the done section, keeping the list it shows in step. */
async function toggleDone($) {
  await updateState($, state => {
    const done = Array.isArray(state.doneCases) ? state.doneCases : []
    return { ...state, ...doneSection(done, !state.doneOpen) }
  })
  return { handled: true }
}

/**
 * Moves a to-do between the open list, the done list and neither: records it
 * in the handled file (with the to-do itself, so the done list can show it
 * and an undo can put it back) and republishes both lists.
 */
async function changeTodo($, id, to) {
  const today = dateOf(await $.clock.now())
  const handled = normalizeHandled(await readJsonFile($, HANDLED_FILE))
  const before = handled.find(h => h.id === id)
  let todo = null
  await updateState($, async state => {
  const open = Array.isArray(state.cases) ? state.cases : []
  const shown = (Array.isArray(state.doneCases) ? state.doneCases : []).find(c => c.id === id)
  const { doneNote: _note, doneLabel: _label, ...shownCard } = shown || {}
  todo = open.find(c => c.id === id) || (before && before.todo) || (shown && shownCard.title ? shownCard : null)
  const kept = handled.filter(h => h.id !== id && (!h.at || h.at >= addDays(today, -60)))
  const entry = to === 'open' ? null
    : { id, at: to === 'deleted' && before && before.at ? before.at : today, ...(to === 'deleted' ? { state: 'deleted' } : {}), ...(todo ? { todo } : {}) }
  const next = entry ? [...kept, entry] : kept
  await $.fs.write(HANDLED_FILE, `${JSON.stringify(next, null, 2)}\n`)
  const others = open.filter(c => c.id !== id)
  const cases = to === 'open' && todo ? openTodos([...others, todo], [], today) : others
  const doneCases = doneTodos(next, cases, today)
  return { ...state, ...todoView(cases), ...doneSection(doneCases, state.doneOpen), summary: { ...(state.summary || {}), ...todoSummary(cases) } }
  })
  // An alert's to-do is rebuilt from the alert itself; any other waits for the next sync.
  if (to === 'open' && !todo && id.startsWith('alert:')) await refreshFindings($)
  return { handled: true }
}

/** A JSON file of the app's folder, or null when it is missing or not JSON. */
async function readJsonFile($, path) {
  try {
    if (!(await $.fs.exists(path))) return null
    return JSON.parse(await $.fs.read(path, { as: 'text' }))
  } catch {
    return null
  }
}

let refundsWritten = ''
/** The alert and finding files as the last sync read them. */
let rulesSeen = ''

/** The alert and finding files' text, to notice the agent changing them. */
async function rulesText($) {
  const read = async path => {
    try {
      return (await $.fs.exists(path)) ? await $.fs.read(path, { as: 'text' }) : ''
    } catch {
      return ''
    }
  }
  return `${await read(ALERTS_FILE)}\u0000${await read(FINDINGS_FILE)}\u0000${await read(REVIEWS_FILE)}\u0000${await read(WATCH_FILE)}`
}

/**
 * The product the person asked a tab for, {sku, days}, or null: `data/watch.json`
 * holding a SKU the store sells. A missing or unknown SKU means no such tab.
 */
export async function readWatch($) {
  const doc = await readJsonFile($, WATCH_FILE)
  const sku = doc && typeof doc.sku === 'string' ? doc.sku : ''
  if (!sku || !isProduct(sku)) return null
  return { sku, days: Number(doc.days) || 30 }
}

/** Rewrites the refund breakdown file when its content changed. */
async function writeRefunds($, orders, today) {
  const text = `${JSON.stringify(refundBreakdown(orders, today), null, 1)}\n`
  if (text === refundsWritten) return
  try {
    await $.fs.write(REFUNDS_FILE, text)
    refundsWritten = text
  } catch (err) {
    await $.log.warn(`could not write ${REFUNDS_FILE}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** One sync: connect, read, derive, publish. Exported for tests with a fake `$`. */
export async function syncOnce($, { inbox, now, onRetry, phase = paypalPhase }) {
  const previous = (await $.app.state.get()) || {}
  const connected = await $.mcp.connect(SERVER)
  if (!connected || connected.isConnected !== true) {
    const message = (connected && connected.message) || 'the PayPal server is not connected'
    // Signed in, or a board already read and no word of a sign-out: the connection is coming back, not gone.
    if (phase === 'signed-in' || phase === 'signing-in' || (phase !== 'needs-sign-in' && previous.signedIn && previous.week)) {
      await updateState($, state => ({
        ...state,
        sync: { at: now, ok: false, error: message, note: 'Reconnecting to PayPal…' },
      }))
      if (onRetry) await onRetry()
      return
    }
    boardLoaded = false
    await showBadge($, null)
    await updateState($, state => ({
      ...emptyState(state),
      ...signedOut(),
      sync: { at: now, ok: false, error: message, note: `Not connected to PayPal: ${message}` },
    }))
    return
  }

  if (!previous.week) {
    // The first read takes a minute: say so, and keep a card up rather than an empty board.
    await updateState($, state => ({ ...emptyState(state), ...reading() }))
  }
  const errors = {}
  const unavailable = []
  const read = (tool, args) => readList($, tool, args, errors, unavailable)
  const scan = await scanInvoices($, { now, errors, unavailable })
  const raw = {
    disputes: await read('list_disputes', { page_size: ROW_CAP }),
    transactions: await readTransactions(read, now),
  }
  // A dispute list PayPal did not answer is not an empty one: keep the last one read, and read again soon.
  const disputesFailed = Boolean(errors.list_disputes) || unavailable.includes('list_disputes')
  if (disputesFailed && lastDisputes) raw.disputes = lastDisputes
  else if (!disputesFailed) lastDisputes = raw.disputes
  if (errors.list_disputes && onRetry) await onRetry()
  const payments = await storePayments($, raw.transactions, Boolean(errors.list_transactions))
  const inboxFiles = inbox ? await pullInbox($, inbox) : []
  const handled = await readHandled($)
  const orders = [...scan.orders, ...payments]
  await writeRefunds($, orders, dateOf(now))
  rulesSeen = await rulesText($)
  const alertsDoc = await readJsonFile($, ALERTS_FILE)
  const alertRules = alertsDoc ? listOf(alertsDoc, 'alerts') : []
  const findings = listOf(await readJsonFile($, FINDINGS_FILE), 'findings')
  const details = await disputeDetails($, raw.disputes, unavailable)
  const transactions = normalizeTransactions(raw.transactions)
  const facts = details.map(d => disputeFacts(d, { orders, transactions, disputes: details, now }))
  factsSeen = facts
  await writeDisputes($, facts)
  const reviews = listOf(await readJsonFile($, REVIEWS_FILE), 'reviews')

  let next = deriveState({ previous, raw, orders, alertRules, findings, facts, reviews, running: analyzing, openInvoices: scan.openInvoices, unread: scan.unread, inboxFiles, handled, errors, unavailable, now })
  const watch = await readWatch($)
  if (watch) next = { ...next, productTrend: productTrend(orders, { ...watch, today: dateOf(now) }) }
  if (await startReview($, facts, reviews, now, () => refreshReviews($))) {
    const cases = next.cases.map(c => withReview(c, facts, reviews))
    next = { ...next, ...todoView(cases) }
  } else if (await startAnalysis($, next.alerts, now, () => refreshFindings($))) {
    next = { ...next, alerts: next.alerts.map(a => alertWithStatus(a, findings, analyzing)) }
  }
  await updateState($, () => ({ ...next, ...signedIn(), modelRows: modelRows() }))
  boardLoaded = true
  // A review that ended while this sync ran is drawn from its file, not from what the sync read.
  if (facts.length) await refreshReviews($)
}

/** The facts of the last sync's open disputes, to rebuild the review cards when a review ends. */
/** The running app's sync entry, so `app.show` can ask for one; null while stopped. */
let kick = null
/** The sign-in phase of the PayPal server, as the runtime last reported it. */
let paypalPhase = ''
/** Whether the board in the published state has been read since the last sign-in. */
let boardLoaded = false
/** The page that pressed the icon to sign in, waiting for the board to open: '' is every page, null is none. */
let pendingClient = null
let factsSeen = []
/** The last dispute list PayPal answered, kept for a sync whose read of it failed; null after a sign-out. */
let lastDisputes = null
let disputesWritten = ''

/** Rewrites the dispute facts file when its content changed. */
async function writeDisputes($, facts) {
  const text = `${JSON.stringify({ disputes: facts }, null, 1)}\n`
  if (text === disputesWritten || (!disputesWritten && facts.length === 0)) return
  try {
    await $.fs.write(DISPUTES_FILE, text)
    disputesWritten = text
  } catch (err) {
    await $.log.warn(`could not write ${DISPUTES_FILE}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * The open disputes that wait on the merchant, each as `get_dispute` answers
 * it, read again only when its update time moved; the list row stands in
 * when the server offers no `get_dispute` or the read fails.
 */
export async function disputeDetails($, listed, unavailable = []) {
  const rows = listItems(listed, ['items', 'disputes']).map(flatDispute).filter(d => (d.dispute_id || d.id) && waitsOnMerchant(d))
  const stored = (await $.store.get(DETAILS_KEY)) || {}
  const kept = {}
  let missing = unavailable.includes('get_dispute')
  const out = []
  for (const row of rows) {
    const id = String(row.dispute_id || row.id)
    const updated = String(row.update_time || '')
    const cached = stored[id]
    if (cached && cached.updated === updated && cached.detail) {
      kept[id] = cached
      out.push(cached.detail)
      continue
    }
    if (missing) { out.push(row); continue }
    const read = await callTool($, 'get_dispute', { dispute_id: id })
    if (read.error) {
      if (isToolMissing(read.error)) { missing = true; unavailable.push('get_dispute') }
      else await $.log.warn(`get_dispute ${id}: ${read.error}`)
      out.push(row)
      continue
    }
    const detail = isObject(read.value) ? { ...row, ...read.value } : row
    kept[id] = { updated, detail }
    out.push(detail)
  }
  if (JSON.stringify(kept) !== JSON.stringify(stored)) await $.store.set(DETAILS_KEY, kept)
  return out
}

/** The dispute under review now, or null. */
let reviewing = null
/** Disputes the person asked to review again while another run was going, in order. */
const queued = []

/**
 * Starts an agent run to review a dispute, unless any run is in flight or
 * the host offers no `$.app.analyze`. With `only`, that dispute, reviewed or
 * not (the person pressed Review again); else the first open dispute,
 * soonest deadline first, with no review for its current version and not
 * tried within ANALYSIS_RETRY_MS. When the run ends, a queued request runs
 * next. Answers {run} when it started one, else null.
 */
export async function startReview($, facts, reviews, now, onDone, { only = '' } = {}) {
  if (reviewing || analyzing || typeof $.app.analyze !== 'function') return null
  const tried = (await $.store.get(REVIEWS_KEY)) || {}
  const key = f => `${f.id}@${f.updated}`
  const due = only ? (facts || []).find(f => f.id === only)
    : [...(facts || [])]
      .sort((a, b) => (a.daysLeft ?? 999) - (b.daysLeft ?? 999))
      .find(f => !latestReview(reviews, f.id, f.updated) && !(now - (tried[key(f)] || 0) < ANALYSIS_RETRY_MS))
  if (!due) return null
  const kept = Object.fromEntries(Object.entries(tried).filter(([, at]) => now - at < 30 * 86_400_000))
  await $.store.set(REVIEWS_KEY, { ...kept, [key(due)]: now })
  reviewing = due.id
  let answer
  try {
    answer = $.app.analyze({ title: `Review dispute ${due.id}`, prompt: reviewPrompt(due) })
  } catch (err) {
    answer = Promise.reject(err)
  }
  const run = Promise.resolve(answer)
    .then(r => r || { ok: false, reason: 'no answer' }, err => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }))
    .then(async r => {
      reviewing = null
      if (!r.ok) await $.log.warn(`review of dispute ${due.id} ended without a result: ${r.reason}`)
      if (await noteRun($, r)) await triedSoon($, REVIEWS_KEY, key(due), now)
      else if (notTried(r)) await untried($, REVIEWS_KEY, key(due), tried[key(due)])
      const next = queued.shift()
      // One review after another: the next waiting dispute starts as soon as one got through.
      if (next || r.ok) {
        const fresh = listOf(await readJsonFile($, REVIEWS_FILE), 'reviews')
        await startReview($, next ? factsSeen : facts, fresh, await $.clock.now(), onDone, next ? { only: next } : {})
      }
      await onDone(r)
    })
    .catch(async err => { await $.log.warn(`after the review of ${due.id}: ${err instanceof Error ? err.message : String(err)}`) })
  return { run }
}

/** A failed run's reason that says the session's model cannot answer: none picked, no key, a refused key or a missing provider. */
export const MODEL_TROUBLE = /\bmodel\b|api[ _-]?key|\bprovider\b|\b40[13]\b|unauthori[sz]ed|authenticat|credential|invalid[^.]*key|insufficient[_ ]quota|billing/i
/** How soon a run that failed for the model is tried again, so a fixed model is used within the hour. */
export const MODEL_RETRY_MS = 3_600_000
/** The reason the last agent run failed for the model, or '' once a run got through. */
let modelProblem = ''

/** What the board shows while the model cannot answer: where to fix it, as a card above the tabs. */
export const MODEL_HINT = {
  title: "The AI can't run: no working model",
  text: 'Dispute reviews and alert analysis need a model. Open Settings → Models, add a provider and its API key, and pick a model. The desk tries again within the hour, or press Review again.',
}

/** The model card's rows: one while the model cannot answer, none otherwise. */
export function modelRows() {
  return modelProblem ? [{ title: MODEL_HINT.title, text: MODEL_HINT.text }] : []
}

/**
 * Records how an agent run ended: a failure for the model shows the model
 * card, a run that got through clears it. Answers whether it failed for the model.
 */
export async function noteRun($, r) {
  const trouble = Boolean(r && !r.ok && MODEL_TROUBLE.test(String(r.reason || '')))
  const before = modelProblem
  if (trouble) modelProblem = String(r.reason)
  else if (r && r.ok) modelProblem = ''
  if (Boolean(before) !== Boolean(modelProblem)) {
    await updateState($, state => ({ ...state, modelRows: modelRows() }))
  }
  return trouble
}

/**
 * A run that never got to work: refused while another ran or past the daily
 * limit, stopped with the module, or started before any session window
 * could host it. It is tried again at the next sync, not after ANALYSIS_RETRY_MS.
 */
export const NOT_TRIED = /^(busy|limit|stopped|no answer)$|no session has started|not available in this realm/i

/** Whether a run ended without having been tried. */
export function notTried(r) {
  return Boolean(r && !r.ok && NOT_TRIED.test(String(r.reason || '')))
}

/** Puts a tried mark back as it was before this run: `before` undefined removes it. */
async function untried($, storeKey, key, before) {
  const { [key]: _mark, ...rest } = (await $.store.get(storeKey)) || {}
  await $.store.set(storeKey, before === undefined ? rest : { ...rest, [key]: before })
}

/** Moves a tried mark back so the run comes up again MODEL_RETRY_MS after `at`, not ANALYSIS_RETRY_MS. */
async function triedSoon($, storeKey, key, at) {
  const tried = (await $.store.get(storeKey)) || {}
  await $.store.set(storeKey, { ...tried, [key]: at - ANALYSIS_RETRY_MS + MODEL_RETRY_MS })
}

/** What the agent is asked when a dispute needs a review: its facts inline, so the run starts from them. */
export function reviewPrompt(f) {
  const { checks: _checks, ...facts } = f
  return [
    `Dispute ${f.id} (${f.claim}, ${f.amount}) waits on the merchant${f.respondBy ? `, who must respond by ${f.respondBy.slice(0, 10)}` : ''}.`,
    `What the desk established: ${JSON.stringify(facts)}.`,
    'Review it as the Disputes section of AGENTS.md says: read it with get_dispute if this connection has it, look for the payment and a second one with list_transactions when that matters, and apply the paypal-rules skill.',
    `Then add one review to data/reviews.json with "disputeId": "${f.id}", keeping the reviews already there. Its headline is the one sentence the card shows after the verdict badge: the deciding fact, at most 15 words, without repeating the amount, the claim or the verdict.`,
    'Change nothing on PayPal. End with the verdict and its headline.',
  ].join(' ')
}

/** The "Review again" button: reviews the dispute now, or after the run in flight. */
async function reviewAgain($, id) {
  if (!factsSeen.some(f => f.id === id)) return { handled: true }
  const reviews = listOf(await readJsonFile($, REVIEWS_FILE), 'reviews')
  const started = await startReview($, factsSeen, reviews, await $.clock.now(), () => refreshReviews($), { only: id })
  if (!started && reviewing !== id && !queued.includes(id)) queued.push(id)
  await refreshReviews($)
  return { handled: true }
}

/** Republishes the dispute to-dos with their reviews, after a review started or ended. */
export async function refreshReviews($) {
  const reviews = listOf(await readJsonFile($, REVIEWS_FILE), 'reviews')
  await updateState($, state => {
    const cases = (Array.isArray(state.cases) ? state.cases : []).map(c => withReview(c, factsSeen, reviews))
    return { ...state, cases, ...todoView(cases) }
  })
}

/**
 * A dispute's to-do with its review: the verdict line under the title, the
 * Review again button's label (a ⏳ while a run is on it or waits for one),
 * and the details view's fields.
 */
function withReview(c, facts, reviews) {
  if (c.kind !== 'dispute') return c
  const f = (facts || []).find(x => x.id === c.ref)
  if (!f) return c
  const { id: _id, state: reviewState, ...card } = reviewCards([f], reviews, reviewing || '')[0]
  const waiting = queued.includes(f.id)
  const due = f.daysLeft === null ? '' : f.daysLeft <= 0 ? 'response overdue' : `respond within ${f.daysLeft} day${f.daysLeft === 1 ? '' : 's'}`
  return {
    ...c,
    ...card,
    title: [f.claim, f.amount, due].filter(Boolean).join(' · '),
    source: `PayPal dispute ${f.id}`,
    detail: [f.transactionId && `Payment ${f.transactionId}`, f.order && `order ${f.order.number}`, due || 'no response date given'].filter(Boolean).join(' · '),
    value: f.value,
    reviewState,
    againLabel: waiting ? '⏳ Queued…' : card.againLabel,
    discussQuote: [
      `**PayPal dispute ${f.id}**: ${[f.claim, f.amount, due].filter(Boolean).join(' · ')}`,
      `**${card.detailsLabel}** (${card.detailsNote})`,
      card.detailsHeadline,
      ...[card.detailsWhy1, card.detailsWhy2, card.detailsWhy3, card.detailsWhy4].filter(Boolean),
      ...[card.detailsStep1, card.detailsStep2, card.detailsStep3, card.detailsStep4].filter(Boolean),
      card.detailsReply,
    ].join('\n\n'),
  }
}

/** The alert week being analyzed now, {id, week}, or null. */
let analyzing = null

/**
 * Starts an agent run for the first tripped alert whose week has no finding
 * yet, unless a run is in flight, the host offers no `$.app.analyze`, or that
 * week was tried within ANALYSIS_RETRY_MS. Does not wait for the run:
 * answers {run} (settling once `onDone` ran) when it started one, else null.
 */
export async function startAnalysis($, alerts, now, onDone) {
  if (analyzing || reviewing || typeof $.app.analyze !== 'function') return null
  const tried = (await $.store.get(ANALYSES_KEY)) || {}
  const due = (alerts || []).find(a => a.tripped && !a.analyzed && !(now - (tried[`${a.id}@${a.week}`] || 0) < ANALYSIS_RETRY_MS))
  if (!due) return null
  const key = `${due.id}@${due.week}`
  const kept = Object.fromEntries(Object.entries(tried).filter(([, at]) => now - at < 30 * 86_400_000))
  await $.store.set(ANALYSES_KEY, { ...kept, [key]: now })
  analyzing = { id: due.id, week: due.week }
  let answer
  try {
    answer = $.app.analyze({ title: `Analyze alert: ${due.name}`, prompt: analysisPrompt(due) })
  } catch (err) {
    answer = Promise.reject(err)
  }
  const run = Promise.resolve(answer)
    .then(r => r || { ok: false, reason: 'no answer' }, err => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }))
    .then(async r => {
      analyzing = null
      if (!r.ok) await $.log.warn(`analysis of ${key} ended without a result: ${r.reason}`)
      if (await noteRun($, r)) await triedSoon($, ANALYSES_KEY, key, now)
      else if (notTried(r)) await untried($, ANALYSES_KEY, key, tried[key])
      await onDone(r)
    })
    .catch(async err => { await $.log.warn(`after the analysis of ${key}: ${err instanceof Error ? err.message : String(err)}`) })
  return { run }
}

/** What the agent is asked when an alert triggers. */
export function analysisPrompt(a) {
  return [
    `The alert "${a.name}" triggered for the week ${a.week}: ${a.rule}; it reads ${a.reading}.`,
    'Analyze it as the Alerts section of AGENTS.md says under "Analyze": find what drives it and whether it is one product, one country or the whole store.',
    `Then add one finding to data/findings.json with "alertId": "${a.id}" and "week": "${a.week}", keeping the findings already there.`,
    'Change nothing on PayPal. End with the title of the finding.',
  ].join(' ')
}

/** Republishes findings and alert statuses from the findings file, after an analysis ended. */
export async function refreshFindings($) {
  const findings = listOf(await readJsonFile($, FINDINGS_FILE), 'findings')
  const handled = await readHandled($)
  const clock = await $.clock.now()
  await updateState($, state => {
  const alerts = (Array.isArray(state.alerts) ? state.alerts : []).map(a => alertWithStatus(a, findings, analyzing))
  const now = (state.sync && state.sync.at) || clock
  const others = (Array.isArray(state.cases) ? state.cases : []).filter(c => c.kind !== 'alert')
  const live = [...others, ...alertTodos(alerts, findings, now)]
  const cases = openTodos(live, handled, dateOf(now))
  return {
    ...state,
    alerts,
    ...todoView(cases),
    doneCases: doneTodos(handled, live, dateOf(now)),
    ...doneSection(doneTodos(handled, live, dateOf(now)), state.doneOpen),
    findings: viewFindings(findings),
    ruleCards: ruleCards(alerts, state.paypalAlerts),
    summary: { ...(state.summary || {}), ...todoSummary(cases), findingsNote: findingsNote(findings), alertsNote: alertsNote(alerts, state.paypalAlerts) },
  }
  })
}

/** The last TRANSACTION_DAYS of Transaction Search, every page up to TRANSACTION_PAGES, as {transaction_details}. */
export async function readTransactions(read, now) {
  // Transaction Search wants ISO 8601 date-times with seconds; a date alone is a 400.
  const args = {
    start_date: new Date(now - TRANSACTION_DAYS * 86_400_000).toISOString(),
    end_date: new Date(now).toISOString(),
    page_size: 500,
  }
  const first = await read('list_transactions', args)
  const rows = listItems(first, ['transaction_details', 'transactions', 'items'])
  const pages = Math.min(TRANSACTION_PAGES, Number((first && first.total_pages) || 1))
  for (let page = 2; page <= pages; page++) {
    const more = listItems(await read('list_transactions', { ...args, page }), ['transaction_details', 'transactions', 'items'])
    if (more.length === 0) break
    rows.push(...more)
  }
  return { transaction_details: rows }
}

/** The store's direct payments from this read, or the last good read's when this one failed. */
async function storePayments($, transactions, failed) {
  if (failed) {
    const cached = await $.store.get(PAYMENTS_KEY)
    return Array.isArray(cached) ? cached : []
  }
  const orders = paymentOrders(transactions.transaction_details)
  const cached = await $.store.get(PAYMENTS_KEY)
  if (JSON.stringify(cached) !== JSON.stringify(orders)) await $.store.set(PAYMENTS_KEY, orders)
  return orders
}

/** Publishes `next` as one patch per changed top-level key; `$.app.state.set` where there is no `publish`. */
let stateLock = Promise.resolve()

/**
 * Reads the published state, lets `change` build the next one from it and
 * publishes that, one change at a time, so a review or analysis ending in
 * the middle of a sync cannot publish lists it read before the sync's.
 * `change` answers null to publish nothing; it must not call updateState.
 */
export function updateState($, change) {
  const run = stateLock.then(async () => {
    const current = (await $.app.state.get()) || {}
    const next = await change(current)
    if (next) await publishState($, current, next)
  })
  stateLock = run.catch(() => {})
  return run
}

export async function publishState($, previous, next) {
  if (typeof $.app.publish !== 'function') {
    await $.app.state.set(next)
    return
  }
  const before = previous || {}
  const patches = []
  for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
    const value = next[key]
    if (JSON.stringify(value) === JSON.stringify(before[key])) continue
    patches.push(value === undefined ? { path: `/${key}` } : { path: `/${key}`, value })
  }
  if (patches.length) await $.app.publish(patches)
  await showBadge($, next)
}

let badgeSent

/** Puts `summary.todoCount` on the app's topbar icon (0 shows none); skipped where the host has no `$.app.badge` or the count is unchanged. */
export async function showBadge($, next) {
  const count = next ? (next.summary && next.summary.todoCount) : 0
  if (typeof $.app.badge !== 'function' || !Number.isInteger(count) || count < 0 || count === badgeSent) return
  await $.app.badge(count)
  badgeSent = count
}

/**
 * Reads the invoice list into the cached store orders and open invoices.
 * The list is newest-created first: a sync reads pages until one brings
 * nothing new, and every FULL_SCAN_MS reads them all and drops what is gone.
 */
export async function scanInvoices($, { now, errors, unavailable = [] }) {
  const budget = { calls: FALLBACK_CALLS }
  let skipped = 0
  const stored = await $.store.get(ORDERS_KEY)
  const cache = stored && typeof stored === 'object' ? stored : {}
  const orders = cache.orders && typeof cache.orders === 'object' ? cache.orders : {}
  const open = cache.open && typeof cache.open === 'object' ? cache.open : {}
  const full = !(now - (cache.fullAt || 0) < FULL_SCAN_MS)
  const cutoff = addDays(dateOf(now), -KEEP_DAYS)
  const seen = new Set()
  let changed = false
  let complete = false
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = await readInvoiceRows($, (page - 1) * PAGE_SIZE, PAGE_SIZE, budget)
    if (rows.error) {
      if (isToolMissing(rows.error)) unavailable.push('list_invoices')
      else errors.list_invoices = rows.error
      break
    }
    skipped += rows.skipped
    const items = rows.items
    let pageChanged = false
    for (const row of items) {
      const id = invoiceRowFields(row).id
      if (!id) continue
      seen.add(id)
      const store = readStoreRow(row)
      if (store) {
        if (open[id]) { delete open[id]; pageChanged = true }
        if (!store.order || store.order.date < cutoff) {
          if (orders[id]) { delete orders[id]; pageChanged = true }
        } else if (JSON.stringify(orders[id]) !== JSON.stringify(store.order)) {
          orders[id] = store.order
          pageChanged = true
        }
        continue
      }
      const [invoice] = normalizeInvoices([row], now)
      if (invoice.outstanding) {
        if (JSON.stringify(open[id]) !== JSON.stringify(row)) { open[id] = row; pageChanged = true }
      } else if (open[id]) {
        delete open[id]
        pageChanged = true
      }
    }
    changed = changed || pageChanged
    if (rows.end) { complete = true; break }
    if (!full && !pageChanged) break
  }
  // A row PayPal would not send is unseen, not gone: drop unseen rows only after a read that skipped none.
  const exact = full && complete && skipped === 0
  for (const [id, order] of Object.entries(orders)) {
    if (order.date < cutoff || (exact && !seen.has(id))) { delete orders[id]; changed = true }
  }
  if (exact) {
    for (const id of Object.keys(open)) if (!seen.has(id)) { delete open[id]; changed = true }
  }
  const fullAt = full && complete ? now : cache.fullAt || 0
  const unread = full && complete ? skipped : Math.max(skipped, cache.unread || 0)
  if (changed || fullAt !== cache.fullAt || unread !== (cache.unread || 0)) {
    await $.store.set(ORDERS_KEY, { orders, open, fullAt, unread })
  }
  return { orders: Object.values(orders), openInvoices: normalizeInvoices(Object.values(open), now), unread }
}

/**
 * Rows [start, start + size) of the invoice list: {items, skipped, end} or
 * {error}. PayPal's server refuses a whole page when one invoice fails its own
 * output schema (a refunded invoice's status is not in it), so a refused page
 * is read again in the next smaller PAGE_LADDER size, and only the smallest
 * pages still refused are skipped. `budget.calls` bounds the extra calls.
 */
export async function readInvoiceRows($, start, size, budget) {
  const read = await callTool($, 'list_invoices', { page: start / size + 1, page_size: size })
  if (!read.error) {
    const items = listItems(read.value, ['items', 'invoices'])
    return { items, skipped: 0, end: items.length < size }
  }
  if (!isRejectedOutput(read.error)) return { error: read.error }
  const smaller = PAGE_LADDER.find(s => s < size && size % s === 0 && (start + size) / s <= MAX_PAGE_NUMBER)
  if (!smaller) return { items: [], skipped: size, end: false }
  const items = []
  let skipped = 0
  for (let at = start; at < start + size; at += smaller) {
    if (budget.calls <= 0) return { items, skipped: skipped + (start + size - at), end: false }
    budget.calls -= 1
    const part = await readInvoiceRows($, at, smaller, budget)
    if (part.error) return part
    items.push(...part.items)
    skipped += part.skipped
    if (part.end) return { items, skipped, end: true }
  }
  return { items, skipped, end: false }
}

/** The server's refusal of its own answer: it failed the tool's output schema there. */
export function isRejectedOutput(message) {
  return /output validation error|invalid structured content/i.test(message)
}

// ---- reading -------------------------------------------------------------

/** Calls a list tool and returns its JSON, or `[]` after recording the error.
 *  A tool the server does not offer is listed in `unavailable`, not `errors`:
 *  the dashboard says so once instead of failing every sync. */
async function readList($, tool, args, errors, unavailable = []) {
  const read = await callTool($, tool, args)
  if (!read.error) return read.value
  if (isToolMissing(read.error)) unavailable.push(tool)
  else errors[tool] = read.error
  return []
}

/** One tool call as {value} or {error}: a thrown error and an isError result read alike. */
async function callTool($, tool, args) {
  try {
    const result = await $.mcp.call(SERVER, tool, args)
    const value = resultJson(result)
    if (result && result.isError) return { error: typeof value === 'string' ? value : JSON.stringify(value) }
    return { value }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** The MCP "unknown tool" refusal (-32602 with "not found"). */
export function isToolMissing(message) {
  return /tool\b.*\bnot found|unknown tool/i.test(message)
}

/** The result's structured content, else its first text block parsed as JSON, else the text. */
export function resultJson(result) {
  if (!result) return null
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = (result.content || [])
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** New files in the inbox folder are copied under the app's `inbox/`; returns every file known. */
async function pullInbox($, inbox) {
  let entries
  try {
    entries = await $.fs.list(inbox)
  } catch (err) {
    await $.log.warn(`inbox unreadable: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
  const seen = (await $.store.get(SEEN_KEY)) || {}
  const files = []
  for (const entry of entries || []) {
    const name = typeof entry === 'string' ? entry : entry && (entry.name || entry.path)
    if (!name) continue
    const base = String(name).split(/[\\/]/).pop()
    if (!INBOX_EXTENSIONS.some(ext => base.toLowerCase().endsWith(ext))) continue
    const source = `${inbox}/${base}`
    if (!seen[base]) {
      try {
        const text = await $.fs.read(source, { as: 'text' })
        await $.fs.write(`inbox/${base}`, text)
        seen[base] = Date.now()
      } catch (err) {
        await $.log.warn(`inbox file ${base} skipped: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
    }
    files.push({ name: base, since: seen[base] })
  }
  await $.store.set(SEEN_KEY, seen)
  return files
}

/** The to-dos marked done, from the app folder's `data/handled.json`. */
async function readHandled($) {
  return normalizeHandled(await readJsonFile($, HANDLED_FILE))
}

/**
 * Handled entries as {id, at, state?, todo?}: `{id, at: 'YYYY-MM-DD'}` is
 * done for DONE_DAYS from `at`, `state: 'deleted'` is off the board for as
 * long; a bare id string is done for good (at ''). `todo` is the to-do as
 * it was, kept to show it on the done list and to undo.
 */
export function normalizeHandled(list) {
  return (Array.isArray(list) ? list : []).flatMap(h => typeof h === 'string' ? [{ id: h, at: '' }]
    : h && typeof h.id === 'string' ? [{
      id: h.id,
      at: typeof h.at === 'string' ? h.at.slice(0, 10) : '',
      ...(h.state === 'deleted' ? { state: 'deleted' } : {}),
      ...(h.todo && typeof h.todo === 'object' && typeof h.todo.title === 'string' ? { todo: h.todo } : {}),
    }] : [])
}

/**
 * The done list: to-dos marked done less than DONE_DAYS ago, latest first,
 * each as its live version when there is one, else as it was when marked.
 * One with neither (an id the agent wrote for a case now gone) is left out.
 */
export function doneTodos(handled, live, today) {
  const byId = new Map((live || []).map(c => [c.id, c]))
  return normalizeHandled(handled)
    .filter(h => h.state !== 'deleted' && h.at && today < addDays(h.at, DONE_DAYS))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .flatMap(h => {
      const todo = byId.get(h.id) || h.todo
      if (!todo) return []
      const { doneNote: _note, doneLabel: _label, ...card } = todo
      const done = `Done ${shortDate(h.at)}`
      // A dispute's open card is its title and verdict line; the payment/order
      // detail would make the done card a third line. A card stored by an older
      // build may miss what the card draws now.
      const dispute = card.kind === 'dispute'
      return [{
        ...card, id: h.id, source: card.source || '', kind: card.kind || '',
        detail: dispute ? '' : card.detail || '',
        icon: card.icon || '', label: card.label || '', tone: card.tone || 'neutral',
        doneNote: [dispute ? card.verdictLine || card.source : card.source, done].filter(Boolean).join(' · '),
      }]
    })
}

/**
 * The done section as the board draws it: its heading row (none while nothing
 * is done), the list shown, which is empty while the section is folded, and
 * whether it is open.
 */
export function doneSection(done, open) {
  const list = Array.isArray(done) ? done : []
  return {
    doneOpen: Boolean(open),
    doneCases: list,
    doneShown: open ? list : [],
    doneHeadRows: list.length ? [{ label: `Done (${list.length}) ${open ? '<' : '>'}` }] : [],
  }
}

/** Whether a to-do is hidden on `today`: done for good, or done less than DONE_DAYS ago. */
export function isDone(handled, id, today) {
  return normalizeHandled(handled).some(h => h.id === id && (!h.at || today < addDays(h.at, DONE_DAYS)))
}

// ---- deriving (pure) -------------------------------------------------------

/** The dashboard state from the reads. Pure: no `$`, so tests can drive it. */
export function deriveState({ previous = {}, raw = {}, orders = [], alertRules = [], findings = [], facts = [], reviews = [], running = null, openInvoices = [], unread = 0, inboxFiles = [], handled = [], errors = {}, unavailable = [], now }) {
  const disputes = normalizeDisputes(raw.disputes)
  const transactions = normalizeTransactions(raw.transactions)
  const today = dateOf(now)
  const { refundShare: _refundShare, ...board } = salesBoard(orders, { today })
  const alerts = viewAlerts(checkRules(alertRules, orders, today), findings, running)
  const paypalAlerts = disputeAlerts(disputes, now)
  const found = deriveCases({ invoices: openInvoices, disputes, transactions, inboxFiles, now })
  const seriesOf = new Map()
  for (const a of alerts) {
    if (!a.tripped || !a.spec) continue
    const series = alertSeries(a.spec, orders, today, { subject: a.subject })
    if (series) seriesOf.set(a.id, series)
  }
  const live = [...found, ...alertTodos(alerts, findings, now, seriesOf)]
  const cases = openTodos(live, handled, today).map(c => withReview(c, facts, reviews))
  const errorNames = Object.keys(errors)
  const noteParts = [`Synced ${timeOfDay(now)}`]
  if (errorNames.length) noteParts.push(`${errorNames.length} read(s) failed: ${errorNames.join(', ')}`)
  if (unavailable.length) noteParts.push(`not offered by this server: ${unavailable.join(', ')}`)
  if (unread) noteParts.push(`${unread} invoice(s) PayPal's server would not send`)
  return {
    ...board,
    ...todoView(cases),
    doneCases: doneTodos(handled, live, today),
    ...doneSection(doneTodos(handled, live, today), previous.doneOpen),
    alerts,
    paypalAlerts,
    ruleCards: ruleCards(alerts, paypalAlerts),
    findings: viewFindings(findings),
    products: productsBoard(orders, { today, alerts: alertRules }),
    summary: {
      alertsNote: alertsNote(alerts, paypalAlerts),
      findingsNote: findingsNote(findings),
      ...todoSummary(cases),
    },
    sync: {
      at: now,
      ok: errorNames.length === 0,
      errors: errorNames.length ? errors : undefined,
      unavailable: unavailable.length ? unavailable : undefined,
      unread: unread || undefined,
      note: noteParts.join(' · '),
    },
    handled: previous.handled,
  }
}

/** The to-dos not marked done on `today`, each with the question Ask AI drafts, most urgent first. */
export function openTodos(cases, handled, today) {
  return cases
    .filter(c => !isDone(handled, c.id, today))
    .map(c => ({ ...c, ask: c.ask || `Work this case (${c.id}): ${c.title}. ${c.detail}` }))
    .sort((a, b) => toneRank(b.tone) - toneRank(a.tone) || kindRank(b.kind) - kindRank(a.kind) || a.since - b.since)
    .slice(0, CASE_CAP)
}

/** The to-do list and its first few. */
/** The to-do list, split for the board: dispute cards (with their review) first, then the rest. */
export function todoView(cases) {
  const disputeCases = cases.filter(c => c.kind === 'dispute').map(withDetailsRows)
  const alertCases = cases.filter(c => c.kind === 'alert').map(withDetailsRows)
  const otherCases = cases.filter(c => c.kind !== 'dispute' && c.kind !== 'alert')
  // Alert to-dos and the rest share one heading, shown under the disputes; the disputes heading always shows its totals.
  return {
    cases,
    disputeCases,
    alertCases,
    otherCases,
    groups: {
      disputesTitle: disputeCases.length ? 'Disputes' : '',
      disputesNote: disputesNote(disputeCases),
      otherTitle: disputeCases.length && (alertCases.length || otherCases.length) ? 'Other to-dos' : '',
    },
    needs: cases.slice(0, NEEDS_SHOWN),
  }
}

/**
 * A card's `detailsRows`: the card itself once the AI has written something
 * for it, else none, so the board draws its Details button only when there is
 * an AI call to show.
 */
function withDetailsRows(c) {
  const { detailsRows: _rows, ...card } = c
  return { ...card, detailsRows: card.hasAI ? [card] : [] }
}

/** The Actions tab's count badge and subtitle; `openTab` is always Overview (0), for boards that still bind it. */
function todoSummary(cases) {
  const n = cases.length
  return {
    casesNote: n === 0 ? 'Nothing needs you right now' : `${n} open, most urgent first`,
    todoCount: n,
    openTab: 0,
  }
}

/** A to-do for each tripped alert, its analysis in the detail; the id is the alert's, so done hides it for DONE_DAYS. */
export function alertTodos(alerts, findings, now, seriesOf = new Map()) {
  return alerts.filter(a => a.tripped).map(a => {
    const finding = latestFinding(findings, a)
    // Only a conclusion is shown; while the analysis is pending or running the line stays empty.
    // One line on the board: the finding's title, cut short; the rest is in Details.
    const analysis = finding && finding.title ? `AI: ${oneLine(finding.title)}` : ''
    const series = seriesOf.get(a.id) || null
    const act = actOf(finding)
    return {
      id: `alert:${a.id}`,
      kind: 'alert',
      title: a.headline || sentenceCase(a.reading) || `${a.name} is met`,
      source: `Alert rule: ${a.name}`,
      icon: '🔔',
      detail: analysis,
      tone: 'warning',
      label: 'Review',
      since: now,
      ref: a.id,
      ask: a.ask,
      actLabel: act.label,
      actTone: act.tone,
      detailsTitle: a.name,
      detailsSubtitle: a.rule,
      detailsHeadline: finding ? String(finding.title || '') : 'The AI has not analyzed this yet',
      detailsConclusion: finding ? String(finding.conclusion || '') : '',
      detailsAction: finding && finding.action ? String(finding.action) : '',
      detailsChartTitle: series ? series.title : '',
      detailsChartNote: series ? series.note : '',
      detailsSeries: series ? series.series : [],
      detailsAsk: a.ask,
      hasAI: Boolean(finding),
    }
  })
}

/**
 * What the person should do about an alert, as {label, tone}: the AI writes
 * `act` in its finding; an older finding is read from its `action` words, and
 * one not analyzed yet says so.
 */
export const ACTS = {
  fix: { label: 'Fix now', tone: 'danger' },
  adjust: { label: 'Adjust', tone: 'warning' },
  watch: { label: 'Watch it', tone: 'info' },
  check: { label: 'Look closer', tone: 'neutral' },
}

/**
 * What the person should do about an alert, whatever its metric, as
 * {label, tone}: the AI writes `act` in its finding; an older finding is read
 * from its action words, and one not analyzed yet says so.
 */
export function actOf(finding) {
  if (!finding) return ACTS.check
  const act = String(finding.act || '').trim().toLowerCase()
  if (ACTS[act]) return ACTS[act]
  // A word of the AI's own: "email-the-buyers" reads as "Email the buyers".
  if (act) {
    const words = act.replace(/[-_]+/g, ' ').trim()
    const label = words.charAt(0).toUpperCase() + words.slice(1)
    return { label: label.length <= 24 ? label : `${label.slice(0, 23)}…`, tone: 'neutral' }
  }
  const words = `${finding.action || ''} ${finding.title || ''}`
  if (/stop|pause|pull|halt|withdraw|recall|fix|correct|refund|compensat|money back|contact|chase/i.test(words)) return ACTS.fix
  if (/restock|reorder|raise|lower|cut|shift|adjust|budget|price|stock|plan/i.test(words)) return ACTS.adjust
  if (/watch|monitor|keep an eye|next week/i.test(words)) return ACTS.watch
  return ACTS.check
}

/** A line that fits the board: one sentence, cut at `max` characters. */
export function oneLine(text, max = 90) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

/** A file's list under `key`, or none. */
function listOf(doc, key) {
  return doc && Array.isArray(doc[key]) ? doc[key].filter(item => item && typeof item === 'object') : []
}

/** The newest finding written for an alert's week, if any. */
function latestFinding(findings, a) {
  return [...findings].filter(f => f.alertId === a.id && f.week === a.week)
    .sort((x, y) => (String(x.at || '') < String(y.at || '') ? 1 : -1))[0] || null
}

const sentenceCase = text => (text ? text[0].toUpperCase() + text.slice(1) : '')

/** Checked rules as alert cards; a tripped one says whether this week's analysis is in, running or pending. */
export function viewAlerts(checked, findings, running = null) {
  return checked.map(a => alertWithStatus({
    id: a.id,
    name: a.name,
    rule: a.rule,
    subject: a.subject,
    value: a.value,
    delta: a.delta,
    trend: a.trend,
    better: a.better,
    reading: a.reading,
    week: a.week || '',
    summary: a.rule,
    condition: a.condition || a.rule,
    headline: a.headline || '',
    tripped: a.tripped,
    understood: a.understood,
    spec: a.spec,
    ask: a.understood
      ? `The alert "${a.name}" (${a.rule}) reads ${a.reading}. What's behind it, and what should I do?`
      : `Rewrite the alert "${a.name}" in data/alerts.json so this desk can check it.`,
    editAsk: `Change the alert "${a.name}" (id: ${a.id}, now ${a.rule}): `,
    deleteAsk: `Delete the alert "${a.name}" (id: ${a.id}).`,
  }, findings, running))
}

/**
 * An alert card with `analyzed`, `analysis` (`analyzed`, `analyzing`,
 * `pending` or ''), `status`, `tone` and `note` worked out from the findings
 * and the running analysis.
 */
export function alertWithStatus(row, findings, running) {
  const finding = row.tripped ? latestFinding(findings, row) : null
  const busy = Boolean(row.tripped && !finding && running && running.id === row.id && running.week === row.week)
  const analysis = !row.tripped ? '' : finding ? 'analyzed' : busy ? 'analyzing' : 'pending'
  const status = !row.understood ? "Can't check" : row.tripped ? 'Triggered' : 'OK'
  const note = !row.understood ? 'Ask the AI to restate it as a rule this desk can check'
    : finding ? `AI: ${[finding.title, finding.conclusion].filter(Boolean).join('. ')}`
      : analysis === 'analyzing' ? 'The AI is analyzing it…'
        : analysis === 'pending' ? 'Waiting for the AI to analyze it'
          : ''
  return { ...row, analyzed: Boolean(finding), analysis, status, tone: !row.understood ? 'neutral' : row.tripped ? 'warning' : 'success', note }
}

/** The Alerts heading's subtitle: how many of the rules and PayPal's disputes need a look. */
function alertsNote(alerts, paypalAlerts = []) {
  const met = ruleCards(alerts, paypalAlerts).filter(c => c.met).length
  const own = alerts.length ? '' : ' · add your own with the + card'
  return `The desk checks these every 5 minutes · ${met === 0 ? 'none met now' : `${met} met now`}${own}`
}

export const DISPUTE_RULE_ID = 'paypal-disputes'

/**
 * The Alert rules grid: the built-in PayPal disputes rule, then each rule,
 * as a setting: its condition in words and whether it is met now, with the
 * figure. What happened when one is met is a to-do, not part of the card.
 */
export function ruleCards(alerts = [], paypalAlerts = []) {
  const open = (paypalAlerts || []).filter(d => d.open).length
  const disputes = {
    id: DISPUTE_RULE_ID,
    icon: '⚖️',
    name: 'PayPal disputes',
    condition: 'A buyer opens a dispute or a chargeback on your PayPal account.',
    met: open > 0,
    status: open ? 'Met now' : 'Not met',
    tone: open ? 'warning' : 'neutral',
    statusLine: `${open ? `${open} open now` : 'None open'} · built in`,
    editAsk: 'Change how the desk watches PayPal disputes: ',
    deleteAsk: 'Stop watching PayPal disputes.',
  }
  return [disputes, ...(alerts || []).map(a => ({
    id: a.id,
    icon: '🔔',
    name: a.name,
    condition: a.condition || a.rule,
    met: Boolean(a.understood && a.tripped),
    status: !a.understood ? "Can't check" : a.tripped ? 'Met now' : 'Not met',
    tone: a.understood && a.tripped ? 'warning' : 'neutral',
    statusLine: !a.understood ? 'Ask the AI to restate it as a rule this desk can check'
      : [a.subject, [a.value, a.delta].filter(Boolean).join(', ')].filter(Boolean).join(': '),
    editAsk: a.editAsk,
    deleteAsk: a.deleteAsk,
  }))]
}

function findingsNote(findings) {
  return findings.length === 0 ? 'Conclusions from analyses show up here' : 'Newest first'
}

/** The newest findings as board rows. */
export function viewFindings(findings) {
  return [...findings]
    .filter(f => f.id && f.title)
    .sort((a, b) => (String(a.at || '') < String(b.at || '') ? 1 : -1))
    .slice(0, FINDINGS_SHOWN)
    .map(f => ({
      id: String(f.id),
      title: String(f.title),
      when: String(f.at || '').slice(0, 16).replace('T', ' '),
      source: f.alertId ? 'Automatic analysis' : 'Asked in chat',
      conclusion: String(f.conclusion || ''),
      action: f.action ? `Suggested: ${f.action}` : '',
    }))
}

/** The board as it was, for a sync that could not reach PayPal: every tab keeps its last figures. */
/**
 * The press menu's labels, in the person's own language: the host picks one
 * from this map by the page's locale, falling back to English.
 */
export const LABELS = {
  open: { en: 'Open the desk', 'zh-CN': '打开工作台' },
  refresh: { en: 'Refresh now', 'zh-CN': '立即刷新' },
  signIn: { en: 'Sign in to PayPal…', 'zh-CN': '登录 PayPal…' },
  signOut: { en: 'Sign out of PayPal', 'zh-CN': '退出 PayPal 登录' },
}

/**
 * What a press on the desk's topbar icon asks for, as the host reads it: a
 * sign-in first when the server is waiting for one, the app when it is not,
 * and on the context press a short menu, whose items come back as `menu`
 * presses. A sign-out is answered for a picked item alone.
 */
export async function answerPress(e, phase = paypalPhase, loaded = boardLoaded) {
  const trigger = e && e.trigger
  const signedIn = phase === 'signed-in'
  const due = phase === 'needs-sign-in'
  if (trigger === 'primary') {
    // Signed out: sign in, and the module opens the desk itself once the data is there.
    if (due) return { signIn: SERVER }
    // Signed in but the board is not read yet: hold the screen, load, then open.
    if (!loaded) return { handled: true }
    return { open: true }
  }
  if (trigger === 'context') {
    return {
      menu: signedIn
        ? [
          { id: 'open', label: LABELS.open },
          { id: 'refresh', label: LABELS.refresh },
          { id: 'sign-out', label: LABELS.signOut },
        ]
        : [
          { id: 'sign-in', label: LABELS.signIn, disabled: !due },
          { id: 'open', label: LABELS.open },
        ],
    }
  }
  if (trigger === 'menu') {
    if (e.item === 'open') return { open: true }
    if (e.item === 'refresh') {
      if (kick) await kick()
      return { open: true }
    }
    if (e.item === 'sign-in') return due ? { signIn: SERVER, then: 'open' } : { open: true }
    if (e.item === 'sign-out') return signedIn ? { signOut: SERVER } : { open: true }
  }
  return {}
}

/** What the board shows while PayPal is not connected: the way in, and nothing else. */
export const SIGN_IN = {
  title: 'Sign in to PayPal',
  text: "The desk reads your account through PayPal's own sign-in. Approve it once, in the window that opens.",
  button: 'Sign in',
}

/** What the board shows while the first sync runs. */
export const LOADING = {
  title: 'Reading your PayPal account',
  text: 'The first read walks every invoice, payment and dispute. This takes a minute.',
  button: '',
}

const gate = row => [{ title: row.title, text: row.text, button: row.button }]

/** The board while PayPal is not connected: the gate in front, every list empty. */
export function signedOut() {
  return {
    signedIn: false,
    loading: false,
    gateRows: gate(SIGN_IN),
    modelRows: [],
    cases: [], needs: [], doneCases: [], doneShown: [], doneHeadRows: [],
    disputeCases: [], alertCases: [], otherCases: [],
    disputeReviews: [], findings: [], alerts: [], paypalAlerts: [], ruleCards: [], products: undefined,
    summary: {}, week: undefined, trends: undefined, productTrend: undefined,
  }
}

/** The page that pressed the icon, or empty when the host named none. */
const clientOf = e => (e && typeof e.client === 'string' ? e.client : '')

/** How often a held busy mark is said again: the host drops one that is not renewed within two minutes. */
export const BUSY_RENEW_MS = 60_000
/** How long a held busy mark lasts at most, so a sign-in left unfinished does not keep the icon at work. */
export const BUSY_HOLD_MS = 15 * 60_000
let busyHold = null

/** Shows the icon at work and keeps it so, renewed, until releaseBusy or BUSY_HOLD_MS. */
async function holdBusy($) {
  await busy($, true)
  if (busyHold) return
  const since = await $.clock.now()
  busyHold = $.clock.every(BUSY_RENEW_MS, async () => {
    if ((await $.clock.now()) - since >= BUSY_HOLD_MS) await releaseBusy($)
    else await busy($, true)
  })
}

/** Ends a held busy mark; a second release sends nothing. */
async function releaseBusy($) {
  if (!busyHold) return
  busyHold.cancel()
  busyHold = null
  await busy($, false)
}

/** `$.app.busy(on)`: the icon shows the module at work. Absent on hosts without it. */
async function busy($, on) {
  if (typeof $.app.busy !== 'function') return
  try {
    await $.app.busy(on)
  } catch (err) {
    await $.log.warn(`$.app.busy: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** `$.app.view.open/close`: the pages open the app or close its pane. Absent on hosts without it. */
async function view($, want, client = '') {
  const api = $.app.view
  if (!api || typeof api[want] !== 'function') return
  try {
    await api[want](client ? { client } : undefined)
  } catch (err) {
    await $.log.warn(`$.app.view.${want}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** While the first read runs: the gate's place, saying what is happening. */
export function reading() {
  return { signedIn: true, loading: true, gateRows: [{ title: LOADING.title, text: LOADING.text, button: '' }] }
}

/** The board once PayPal answered: no gate. */
export function signedIn() {
  return { signedIn: true, loading: false, gateRows: [] }
}

function emptyState(previous) {
  return { ...previous, summary: previous.summary || {}, cases: previous.cases || [] }
}

/** Invoice-list rows, flat (MCP) or nested (REST), as the fields the cases use. */
export function normalizeInvoices(value, now) {
  const items = listItems(value, ['items', 'invoices'])
  return items.map(inv => {
    const fields = invoiceRowFields(inv)
    const detail = inv.detail || {}
    const term = detail.payment_term || {}
    const recipient = (inv.primary_recipients || [])[0]
    const billing = (recipient && recipient.billing_info) || {}
    const name = billing.name ? [billing.name.given_name, billing.name.surname].filter(Boolean).join(' ') : ''
    const due = term.due_date || detail.due_date || inv.due_date || ''
    const status = String(inv.status || '').toUpperCase()
    const outstanding = status === 'SENT' || status === 'UNPAID' || status === 'PARTIALLY_PAID' || status === 'PAYMENT_PENDING'
    const overdueDays = outstanding && due ? Math.floor((now - Date.parse(due)) / 86_400_000) : 0
    return {
      id: fields.id,
      number: fields.number || fields.id,
      recipient: name || billing.email_address || '',
      amount: money({ value: fields.value, currency_code: fields.currency }),
      value: fields.value,
      currency: fields.currency,
      status,
      due,
      outstanding,
      overdueDays: overdueDays > 0 ? overdueDays : 0,
    }
  })
}

export function normalizeDisputes(value) {
  const items = listItems(value, ['items', 'disputes']).map(flatDispute)
  return items.map(d => {
    const status = String(d.status || '').toUpperCase()
    const open = status !== 'RESOLVED' && status !== 'CLOSED' && status !== 'CANCELLED'
    return {
      id: d.dispute_id || d.id || '',
      reason: String(d.reason || '').replace(/_/g, ' ').toLowerCase(),
      stage: String(d.dispute_life_cycle_stage || '').toLowerCase(),
      amount: money(d.dispute_amount || {}),
      value: Number((d.dispute_amount && d.dispute_amount.value) || 0),
      status,
      open,
      created: d.create_time || '',
      respondBy: d.seller_response_due_date || '',
      transactionId: ((d.disputed_transactions || [])[0] || {}).seller_transaction_id || '',
    }
  })
}

/** A card or wallet payment names its store order in the subject ("Order PD-20261109-909"); a payment of one order twice keeps the subject but not the invoice id. */
export function orderInSubject(subject) {
  const m = /\bPD-\d{8}-\d{3}\b/.exec(String(subject || ''))
  return m ? m[0] : ''
}

export function normalizeTransactions(value) {
  const items = listItems(value, ['transaction_details', 'transactions', 'items'])
  return items.map(t => {
    const info = t.transaction_info || t
    const amount = info.transaction_amount || info.amount || {}
    const payer = t.payer_info || {}
    const code = String(info.transaction_event_code || '')
    return {
      id: info.transaction_id || t.id || '',
      at: info.transaction_initiation_date || info.transaction_updated_date || t.create_time || '',
      value: Number(amount.value || 0),
      currency: amount.currency_code || '',
      status: String(info.transaction_status || '').toUpperCase(),
      refund: code.startsWith('T11') || Number(amount.value || 0) < 0 && /refund/i.test(info.transaction_subject || ''),
      payer: payer.email_address || (payer.payer_name && payer.payer_name.alternate_full_name) || '',
      number: String(info.invoice_id || info.custom_field || orderInSubject(info.transaction_subject) || ''),
      reference: String(info.paypal_reference_id || ''),
      subject: String(info.transaction_subject || ''),
    }
  })
}

/** The cases: what needs a person's decision, each with a stable id the agent can mark handled. */
export function deriveCases({ invoices, disputes, transactions, inboxFiles, now }) {
  const cases = []
  for (const d of disputes) {
    if (!d.open) continue
    const daysLeft = d.respondBy ? Math.ceil((Date.parse(d.respondBy) - now) / 86_400_000) : null
    cases.push({
      id: `dispute:${d.id}`,
      kind: 'dispute',
      title: `Dispute ${d.id}: ${d.reason || d.stage || 'open'}`,
      source: 'Alert rule: PayPal disputes',
      icon: '⚖️',
      detail: `${d.amount} in dispute${d.transactionId ? ` on transaction ${d.transactionId}` : ''}. ` +
        (daysLeft === null ? 'No response deadline given.' : daysLeft <= 0 ? 'Response overdue.' : `Respond within ${daysLeft} day(s).`),
      tone: daysLeft !== null && daysLeft <= 3 ? 'danger' : 'warning',
      label: daysLeft !== null && daysLeft <= 3 ? 'Urgent' : 'Dispute',
      since: Date.parse(d.created) || now,
      ref: d.id,
    })
  }
  for (const inv of invoices) {
    if (inv.overdueDays <= 0) continue
    cases.push({
      id: `invoice:${inv.id}`,
      kind: 'overdue_invoice',
      title: `Invoice ${inv.number} is ${inv.overdueDays} day(s) overdue`,
      source: 'From PayPal: unpaid invoices',
      icon: '🧾',
      detail: `${inv.amount}${inv.recipient ? ` from ${inv.recipient}` : ''}, due ${inv.due.slice(0, 10)}. A reminder or a cancellation needs your decision.`,
      tone: inv.overdueDays > 14 ? 'danger' : 'warning',
      label: inv.overdueDays > 14 ? 'Long overdue' : 'Overdue',
      since: Date.parse(inv.due) || now,
      ref: inv.id,
    })
  }
  const dupes = duplicatePayments(transactions)
  for (const pair of dupes) {
    cases.push({
      id: `duplicate:${pair[0].id}:${pair[1].id}`,
      kind: 'duplicate_payment',
      title: `Two payments of ${money({ value: pair[0].value, currency_code: pair[0].currency })} from ${pair[0].payer || 'one payer'}`,
      source: 'From PayPal: recent transactions',
      icon: '💳',
      detail: `Transactions ${pair[0].id} and ${pair[1].id} were made within 10 minutes. One may need a refund.`,
      tone: 'warning',
      label: 'Check',
      since: Date.parse(pair[1].at) || now,
      ref: pair[1].id,
    })
  }
  for (const file of inboxFiles) {
    cases.push({
      id: `file:${file.name}`,
      kind: 'invoice_request',
      title: `New invoice request: ${file.name}`,
      source: 'From the inbox folder',
      icon: '📥',
      detail: `Copied to inbox/${file.name} in the app's folder. Read it and draft the PayPal invoice it asks for.`,
      tone: 'info',
      label: 'Inbox',
      since: file.since || now,
      ref: file.name,
    })
  }
  return cases
}

/** Pairs of completed payments from one payer, same amount, within ten minutes. */
export function duplicatePayments(transactions) {
  const sales = transactions
    .filter(t => !t.refund && t.value > 0 && t.payer)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const pairs = []
  for (let i = 1; i < sales.length; i++) {
    const a = sales[i - 1]
    const b = sales[i]
    if (a.payer === b.payer && a.value === b.value && Math.abs(Date.parse(b.at) - Date.parse(a.at)) <= 10 * 60_000) {
      pairs.push([a, b])
    }
  }
  return pairs
}

// ---- views and helpers -----------------------------------------------------

function listItems(value, keys) {
  if (Array.isArray(value)) return value.filter(isObject)
  if (!isObject(value)) return []
  for (const key of keys) if (Array.isArray(value[key])) return value[key].filter(isObject)
  return []
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function money(amount) {
  const value = Number(amount.value || 0)
  const currency = amount.currency_code || ''
  const text = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return currency ? `${currency === 'USD' ? '$' : currency + ' '}${text}` : text
}

function toneRank(tone) {
  return tone === 'danger' ? 3 : tone === 'warning' ? 2 : tone === 'info' ? 1 : 0
}

/** Within one tone, a deadline beats money owed, money owed beats a trend or a file. */
function kindRank(kind) {
  switch (kind) {
    case 'dispute': return 5
    case 'duplicate_payment': return 4
    case 'overdue_invoice': return 3
    case 'alert': return 2
    default: return 1
  }
}

function timeOfDay(ms) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
