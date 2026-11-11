/**
 * Reads the repo's `.env` into `process.env` when the sandbox REST app's
 * credentials are not already there. `.env` is gitignored: it holds the
 * sandbox app's client id and secret, and nothing else. Loading it here means
 * every seeding script runs without the variables set in the shell first.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const file = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env')
if (existsSync(file) && (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET)) {
  try {
    process.loadEnvFile(file)
  } catch (err) {
    console.warn(`could not read .env: ${err instanceof Error ? err.message : String(err)}`)
  }
}
