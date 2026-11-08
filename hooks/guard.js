/**
 * Session hooks of the PayPal Desk app: every PayPal tool call that changes
 * the account is put to the person before it runs, whatever the session's
 * permission mode. Reads (list, get, show, search) pass as the engine decided.
 */

const SERVER = 'paypal'
const READ_VERBS = new Set(['list', 'get', 'show', 'search'])

/** True for a PayPal MCP tool that creates, sends, cancels, refunds or otherwise changes something. */
export function isWriteTool(tool) {
  if (typeof tool !== 'string') return false
  const prefix = `mcp__${SERVER}__`
  if (!tool.startsWith(prefix)) return false
  const verb = tool.slice(prefix.length).split('_')[0]
  return !READ_VERBS.has(verb)
}

/** A short line naming what the call does, for the confirmation dialog. */
export function describeCall(tool, input) {
  const name = tool.slice(`mcp__${SERVER}__`.length).replace(/_/g, ' ')
  const id = input && typeof input === 'object'
    ? input.invoice_id ?? input.dispute_id ?? input.subscription_id ?? input.order_id ?? input.capture_id ?? input.id
    : undefined
  return id ? `${name} (${id})` : name
}

export function register(on) {
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict && verdict.decision === 'deny') return verdict
    if (!isWriteTool(e.tool)) return verdict
    return {
      decision: 'ask',
      reason: `PayPal Desk: "${describeCall(e.tool, e.input)}" changes your PayPal account. Allow it to run?`,
    }
  })
}
