/**
 * Reads the repo's `.env` into `process.env` when the sandbox REST app's
 * credentials are not already there. `.env` is gitignored: it holds the
 * sandbox app's client id and secret, and nothing else. Loading it here means
 * every seeding script runs without the variables set in the shell first.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The file the scripts read their credentials from. */
export const ENV_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env')

/** A value as the environment has it: trimmed, and empty when it is only spaces. */
const value = name => String(process.env[name] ?? '').trim()

if (existsSync(ENV_FILE) && (!value('PAYPAL_CLIENT_ID') || !value('PAYPAL_CLIENT_SECRET'))) {
  // The shell wins: a variable already set there is kept, whichever of the two the file fills in.
  const shell = { id: value('PAYPAL_CLIENT_ID'), secret: value('PAYPAL_CLIENT_SECRET') }
  try {
    process.loadEnvFile(ENV_FILE)
    if (shell.id) process.env.PAYPAL_CLIENT_ID = shell.id
    if (shell.secret) process.env.PAYPAL_CLIENT_SECRET = shell.secret
  } catch (err) {
    console.warn(`could not read ${ENV_FILE}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Why the credentials are unusable, as a line naming what is missing and
 * where to put it, or '' when both are there.
 */
export function credentialProblem() {
  const missing = [['PAYPAL_CLIENT_ID', value('PAYPAL_CLIENT_ID')], ['PAYPAL_CLIENT_SECRET', value('PAYPAL_CLIENT_SECRET')]]
    .filter(([, v]) => !v).map(([name]) => name)
  if (missing.length === 0) return ''
  const where = existsSync(ENV_FILE) ? `in ${ENV_FILE}` : `in ${ENV_FILE} (create it: copy .env.example)`
  return `No PayPal credentials: ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} empty or unset.\n` +
    `Put both ${where}, or set them in this shell.\n` +
    'Values: developer.paypal.com > Apps & Credentials > Sandbox > your app.'
}
