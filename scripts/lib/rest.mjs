/**
 * A small PayPal sandbox REST client for the seeding scripts: client-
 * credentials token (renewed on expiry or a 401, one fetch shared by
 * concurrent callers), a pace of at most `rpm` calls a minute across callers
 * (slowed on a 429, eased back on success), and retries with backoff on 429,
 * 5xx and network errors.
 *
 * Security: the host is fixed to the sandbox; credentials come only from the
 * caller (the environment) and are never logged.
 */

export const SANDBOX = 'https://api-m.sandbox.paypal.com'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export class ApiError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path}: ${status} ${body}`)
    this.status = status
    this.body = body
  }
}

export function createClient({ clientId, clientSecret, rpm = 50, log = console.log, wait = sleep } = {}) {
  let token = null
  let tokenExpires = 0
  let tokenPending = null
  const baseInterval = 60_000 / rpm
  let interval = baseInterval
  let nextSlot = 0

  async function pace() {
    const now = Date.now()
    const delay = Math.max(0, nextSlot - now)
    nextSlot = Math.max(now, nextSlot) + interval
    if (delay) await wait(delay)
  }

  async function fetchToken() {
    const res = await fetch(`${SANDBOX}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    })
    if (!res.ok) throw new ApiError('POST', '/v1/oauth2/token', res.status, await res.text())
    const json = await res.json()
    token = json.access_token
    tokenExpires = Date.now() + Math.max(60, (json.expires_in || 3600) - 300) * 1000
  }

  /** `headers` adds request headers, such as `PayPal-Request-Id` for an idempotent retry. */
  async function request(method, path, body, headers = {}) {
    let renewed = false
    for (let attempt = 0; ; attempt++) {
      if (!token || Date.now() > tokenExpires) {
        tokenPending ??= fetchToken().finally(() => { tokenPending = null })
        await tokenPending
      }
      await pace()
      let res
      try {
        res = await fetch(`${SANDBOX}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      } catch (err) {
        if (attempt >= 5) throw err
        await backoff(attempt, null, `network error (${err.message})`)
        continue
      }
      const text = await res.text()
      if (res.ok) {
        if (interval > baseInterval) interval = Math.max(baseInterval, interval * 0.97)
        return text ? JSON.parse(text) : {}
      }
      if (res.status === 401 && !renewed) {
        renewed = true
        token = null
        continue
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        if (res.status === 429) interval = Math.min(6000, interval * 1.5)
        await backoff(attempt, res.headers.get('retry-after'), `${res.status}`)
        continue
      }
      throw new ApiError(method, path, res.status, text)
    }
  }

  async function backoff(attempt, retryAfter, why) {
    const seconds = Number(retryAfter)
    const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Math.min(60_000, 5000 * 2 ** attempt)
    log(`  … ${why}, retrying in ${Math.round(ms / 1000)} s (pace now ${Math.round(60_000 / interval)}/min)`)
    await wait(ms)
  }

  return { request }
}
