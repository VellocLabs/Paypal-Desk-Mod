/**
 * Alert formulas: a small expression language the desk reads and evaluates
 * itself, so an alert can test what a fixed rule cannot ("no units sold two
 * weeks running", "this week below half the 4-week average"). Pure: no I/O,
 * and nothing in a formula runs as code.
 *
 * Contract:
 *   formula   := or
 *   or        := and ("or" and)*
 *   and       := not ("and" not)*
 *   not       := "not" not | compare
 *   compare   := sum (("<" | "<=" | ">" | ">=" | "==" | "!=") sum)?
 *   sum       := product (("+" | "-") product)*
 *   product   := unary (("*" | "/") unary)*
 *   unary     := "-" unary | number | "(" formula ")" | name "(" args ")"
 * Windows end yesterday: week(k) is the k-th 7 days back (0 = the last 7
 * days, up to 7), weeks(n) the last n weeks together (1-8), days(n) the
 * last n days (1-56), day(k) one day (0 = yesterday, up to 55). Figures
 * over a window: units, orders, net (dollars, refunds taken off), sales
 * (dollars), refunds (dollars), refund_rate (percent), aov (dollars).
 * Functions: min, max, avg (1+ arguments), abs (1). A division by zero is
 * 0. Errors are thrown as FormulaError with a message meant for the person
 * who wrote the formula.
 */

export const FORMULA_MAX_LENGTH = 400
const MAX_NODES = 200
/** The days a window may reach back: the order cache holds 62. */
export const LOOKBACK_DAYS = 56

export class FormulaError extends Error {}

const FIGURES = ['units', 'orders', 'net', 'sales', 'refunds', 'refund_rate', 'aov']
const WINDOWS = {
  week: { min: 0, max: 7, span: k => [7 * k + 6, 7 * k] },
  weeks: { min: 1, max: 8, span: n => [7 * n - 1, 0] },
  days: { min: 1, max: LOOKBACK_DAYS, span: n => [n - 1, 0] },
  day: { min: 0, max: LOOKBACK_DAYS - 1, span: k => [k, k] },
}
const MATH = { min: Math.min, max: Math.max, abs: Math.abs, avg: (...xs) => xs.reduce((s, x) => s + x, 0) / xs.length }

function tokenize(text) {
  const tokens = []
  const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(<=|>=|==|!=|[-+*/(),<>]))/y
  let at = 0
  while (at < text.length) {
    if (/^\s*$/.test(text.slice(at))) break
    re.lastIndex = at
    const m = re.exec(text)
    if (!m) throw new FormulaError(`Unexpected "${text.slice(at).trim()[0]}" at ${at + 1}`)
    tokens.push(m[1] !== undefined ? { kind: 'num', value: Number(m[1]) } : m[2] !== undefined ? { kind: 'name', value: m[2] } : { kind: 'op', value: m[3] })
    at = re.lastIndex
  }
  return tokens
}

/** Parses a formula into a tree; throws FormulaError. */
export function parseFormula(text) {
  if (typeof text !== 'string' || !text.trim()) throw new FormulaError('The formula is empty')
  if (text.length > FORMULA_MAX_LENGTH) throw new FormulaError(`The formula is longer than ${FORMULA_MAX_LENGTH} characters`)
  const tokens = tokenize(text)
  let i = 0
  let nodes = 0
  const peek = () => tokens[i]
  const isOp = v => peek() && peek().kind === 'op' && peek().value === v
  const isWord = v => peek() && peek().kind === 'name' && peek().value === v
  const node = n => {
    if (++nodes > MAX_NODES) throw new FormulaError('The formula is too long')
    return n
  }
  const expect = v => {
    if (!isOp(v)) throw new FormulaError(`Expected "${v}"${peek() ? ` before "${peek().value}"` : ' at the end'}`)
    i += 1
  }
  const binary = (next, ops, isOperator) => () => {
    let left = next()
    while (ops.some(isOperator)) {
      const op = tokens[i++].value
      left = node({ type: 'bin', op, left, right: next() })
    }
    return left
  }
  const unary = () => {
    const t = peek()
    if (!t) throw new FormulaError('The formula ends too early')
    if (isOp('-')) { i += 1; return node({ type: 'neg', arg: unary() }) }
    if (isOp('(')) { i += 1; const inner = or(); expect(')'); return inner }
    if (t.kind === 'num') { i += 1; return node({ type: 'num', value: t.value }) }
    if (t.kind === 'name' && !['and', 'or', 'not'].includes(t.value)) {
      i += 1
      expect('(')
      const args = []
      if (!isOp(')')) {
        args.push(or())
        while (isOp(',')) { i += 1; args.push(or()) }
      }
      expect(')')
      return node({ type: 'call', name: t.value, args })
    }
    throw new FormulaError(`Unexpected "${t.value}"`)
  }
  const product = binary(unary, ['*', '/'], isOp)
  const sum = binary(product, ['+', '-'], isOp)
  const compare = () => {
    const left = sum()
    const op = ['<=', '>=', '==', '!=', '<', '>'].find(isOp)
    if (!op) return left
    i += 1
    return node({ type: 'cmp', op, left, right: sum() })
  }
  const not = () => {
    if (isWord('not')) { i += 1; return node({ type: 'not', arg: not() }) }
    return compare()
  }
  const and = binary(not, ['and'], isWord)
  const or = binary(and, ['or'], isWord)
  const tree = or()
  if (i < tokens.length) throw new FormulaError(`Unexpected "${tokens[i].value}"`)
  check(tree, 'value')
  return tree
}

/** The kind a node yields: 'bool', 'number' or 'window'. Throws on a misuse. */
function kindOf(n) {
  switch (n.type) {
    case 'num': case 'neg': return 'number'
    case 'cmp': case 'not': return 'bool'
    case 'bin': return n.op === 'and' || n.op === 'or' ? 'bool' : 'number'
    case 'call': return WINDOWS[n.name] ? 'window' : 'number'
    default: return 'number'
  }
}

function check(n, want) {
  const kind = kindOf(n)
  if (want === 'number' && kind !== 'number') throw new FormulaError(kind === 'window' ? `${n.name}(…) is a time span: use it inside a figure, e.g. units(${n.name}(…))` : 'Expected a number, not a true/false test')
  if (want === 'bool' && kind !== 'bool') throw new FormulaError('Expected a true/false test, e.g. units(week(0)) < 5')
  if (n.type === 'neg') check(n.arg, 'number')
  if (n.type === 'not') check(n.arg, 'bool')
  if (n.type === 'cmp') { check(n.left, 'number'); check(n.right, 'number') }
  if (n.type === 'bin') {
    const side = n.op === 'and' || n.op === 'or' ? 'bool' : 'number'
    check(n.left, side)
    check(n.right, side)
  }
  if (n.type !== 'call') return
  if (WINDOWS[n.name]) {
    const w = WINDOWS[n.name]
    const [arg] = n.args
    if (n.args.length !== 1 || arg.type !== 'num' || !Number.isInteger(arg.value) || arg.value < w.min || arg.value > w.max) {
      throw new FormulaError(`${n.name}() takes one whole number from ${w.min} to ${w.max}`)
    }
  } else if (FIGURES.includes(n.name)) {
    if (n.args.length !== 1 || kindOf(n.args[0]) !== 'window') throw new FormulaError(`${n.name}() takes one time span, e.g. ${n.name}(week(0))`)
    check(n.args[0], 'window')
  } else if (MATH[n.name]) {
    if (!n.args.length || (n.name === 'abs' && n.args.length !== 1)) throw new FormulaError(`${n.name}() needs ${n.name === 'abs' ? 'one number' : 'at least one number'}`)
    n.args.forEach(a => check(a, 'number'))
  } else {
    throw new FormulaError(`No function named ${n.name}(). Figures: ${FIGURES.join(', ')}; spans: ${Object.keys(WINDOWS).join(', ')}; and min, max, avg, abs`)
  }
}

/** Whether a parsed formula is a true/false test (a `when`) rather than a number (a `show`). */
export function isTest(tree) {
  return kindOf(tree) === 'bool'
}

/**
 * Evaluates a parsed formula. `read(figure, back, upTo)` gives a figure over
 * the days from `back` days before yesterday to `upTo` days before it;
 * `shift` moves every window that many days further back (7 reads the same
 * formula on the week before, for the card's change).
 */
export function evaluate(tree, read, shift = 0) {
  const ev = n => {
    switch (n.type) {
      case 'num': return n.value
      case 'neg': return -ev(n.arg)
      case 'not': return !ev(n.arg)
      case 'cmp': {
        const a = ev(n.left)
        const b = ev(n.right)
        return n.op === '<' ? a < b : n.op === '<=' ? a <= b : n.op === '>' ? a > b : n.op === '>=' ? a >= b : n.op === '==' ? a === b : a !== b
      }
      case 'bin': {
        if (n.op === 'and') return ev(n.left) && ev(n.right)
        if (n.op === 'or') return ev(n.left) || ev(n.right)
        const a = ev(n.left)
        const b = ev(n.right)
        return n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : b ? a / b : 0
      }
      case 'call': {
        if (MATH[n.name]) return MATH[n.name](...n.args.map(ev))
        const span = n.args[0]
        const [back, upTo] = WINDOWS[span.name].span(span.args[0].value)
        return read(n.name, back + shift, upTo + shift)
      }
      default: return 0
    }
  }
  return ev(tree)
}

/** A figure from a window's totals {gross, refundCents, orders, units} (cents). */
export function figureOf(name, f) {
  switch (name) {
    case 'units': return f.units
    case 'orders': return f.orders
    case 'net': return (f.gross - f.refundCents) / 100
    case 'sales': return f.gross / 100
    case 'refunds': return f.refundCents / 100
    case 'refund_rate': return f.gross ? (100 * f.refundCents) / f.gross : 0
    case 'aov': return f.orders ? f.gross / f.orders / 100 : 0
    default: return 0
  }
}
