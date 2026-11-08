/**
 * The seeding REST client against a stubbed fetch: one token fetch shared by
 * parallel callers, a retry after a 429, and a plain error for a 4xx.
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { ApiError, createClient } from '../scripts/lib/rest.mjs'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function stub(answer) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/v1/oauth2/token')) {
      await new Promise(resolve => setTimeout(resolve, 5))
      return new Response(JSON.stringify({ access_token: 'T', expires_in: 32400 }), { status: 200 })
    }
    return answer(url, calls.length)
  }
  return calls
}

const quiet = { clientId: 'id', clientSecret: 'secret', rpm: 60_000, log: () => {}, wait: async () => {} }

test('parallel requests share one token fetch and all carry it', async () => {
  const calls = stub(() => new Response('{"ok":true}', { status: 200 }))
  const client = createClient(quiet)
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => client.request('GET', `/x/${i}`)))
  assert.equal(results.length, 5)
  assert.equal(calls.filter(c => c.url.endsWith('/v1/oauth2/token')).length, 1)
  for (const c of calls.filter(c => c.url.includes('/x/'))) assert.equal(c.init.headers.Authorization, 'Bearer T')
})

test('a 429 is retried after the advised wait', async () => {
  let first = true
  const waits = []
  stub(() => {
    if (first) {
      first = false
      return new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })
    }
    return new Response('{"id":"INV2-1"}', { status: 201 })
  })
  const client = createClient({ ...quiet, wait: async ms => { waits.push(ms) } })
  assert.deepEqual(await client.request('POST', '/v2/invoicing/invoices', {}), { id: 'INV2-1' })
  assert.ok(waits.includes(2000), `waits ${waits}`)
})

test('a 422 is not retried and reports its body', async () => {
  let n = 0
  stub(() => { n += 1; return new Response('{"name":"DUPLICATE_INVOICE_NUMBER"}', { status: 422 }) })
  const client = createClient(quiet)
  await assert.rejects(client.request('POST', '/v2/invoicing/invoices', {}), err => err instanceof ApiError && err.status === 422 && /DUPLICATE/.test(err.body))
  assert.equal(n, 1)
})
