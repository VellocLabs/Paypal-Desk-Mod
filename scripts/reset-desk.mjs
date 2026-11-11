#!/usr/bin/env node
/**
 * Clears the desk's own memory so a demo starts from nothing: the to-dos marked
 * done, the alerts the AI wrote, the findings and dispute reviews, the product
 * tab and the published board. It never touches PayPal and never touches the
 * seeded store: invoices, payments and disputes stay as they are.
 *
 *   node scripts/reset-desk.mjs            (asks nothing: what it deletes, it lists)
 *   node scripts/reset-desk.mjs --dry-run
 *   node scripts/reset-desk.mjs --app <the app's folder>
 *
 * The app folder is Velloc's copy of the board, by default
 * `~/.velloc/shared-workspace/app-paypal-desk-board` on this machine.
 */
import { existsSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const appIndex = args.indexOf('--app')
const app = appIndex >= 0 ? args[appIndex + 1] : join(homedir(), '.velloc', 'shared-workspace', 'app-paypal-desk-board')

/** The desk's own files: what it learned, and what it shows. The seed's files stay. */
const FILES = [
  'data/handled.json',
  'data/alerts.json',
  'data/findings.json',
  'data/reviews.json',
  'data/watch.json',
  'data/disputes.json',
  'data/refunds.json',
  'data/state.json',
]

if (!existsSync(app)) {
  console.error(`No app folder at ${app}. Pass --app <that folder>.`)
  process.exit(2)
}

let cleared = 0
for (const file of FILES) {
  const path = join(app, file)
  if (!existsSync(path)) continue
  console.log(`${dryRun ? 'would clear' : 'cleared'}  ${file}`)
  if (!dryRun) unlinkSync(path)
  cleared += 1
}
console.log(`\n${cleared} file(s) ${dryRun ? 'to clear' : 'cleared'} in ${app}.`)
console.log('Restart Velloc: the module publishes the board again from PayPal, with the built-in rule only.')
