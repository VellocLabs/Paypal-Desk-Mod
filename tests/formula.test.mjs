/**
 * Alert formulas: parsing, the errors their author sees, evaluation, and
 * formula rules checked against orders.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { storeOrder as order } from './fixtures.mjs'
import { evaluate, FormulaError, isTest, parseFormula } from '../lib/formula.js'
import { checkRules } from '../lib/alerts.js'

const errorOf = text => {
  try { parseFormula(text); return null } catch (e) { assert.ok(e instanceof FormulaError, e.message); return e.message }
}

test('a formula parses into a test or a number, with the usual precedence', () => {
  assert.equal(isTest(parseFormula('units(week(0)) == 0 and units(week(1)) == 0')), true)
  assert.equal(isTest(parseFormula('net(week(0)) / 2')), false)
  const read = (name, back, upTo) => ({ units: 10, orders: 4 }[name] ?? 0) * (back - upTo + 1) / 7
  assert.equal(evaluate(parseFormula('1 + 2 * 3'), read), 7)
  assert.equal(evaluate(parseFormula('-(1 + 2) * 3'), read), -9)
  assert.equal(evaluate(parseFormula('units(weeks(4)) / 4'), read), 10)
  assert.equal(evaluate(parseFormula('avg(units(week(0)), orders(week(0)), 1)'), read), 5)
  assert.equal(evaluate(parseFormula('units(week(0)) / 0'), read), 0, 'division by zero is 0')
  assert.equal(evaluate(parseFormula('not units(week(0)) > 5 or 1 < 2'), read), true)
})

test('windows end yesterday: week(k), weeks(n), days(n), day(k), and a shift reads them a week earlier', () => {
  const seen = []
  const read = (name, back, upTo) => { seen.push([name, back, upTo]); return 0 }
  evaluate(parseFormula('units(week(0)) + units(week(2)) + orders(weeks(4)) + net(days(3)) + sales(day(0))'), read)
  assert.deepEqual(seen, [['units', 6, 0], ['units', 20, 14], ['orders', 27, 0], ['net', 2, 0], ['sales', 0, 0]])
  seen.length = 0
  evaluate(parseFormula('units(week(0))'), read, 7)
  assert.deepEqual(seen, [['units', 13, 7]])
})

test('a wrong formula says what is wrong, in words its author can act on', () => {
  assert.match(errorOf(''), /empty/)
  assert.match(errorOf('units(week(0)'), /Expected "\)"/)
  assert.match(errorOf('sold(week(0)) > 1'), /No function named sold\(\)\. Figures: units, orders/)
  assert.match(errorOf('units(week(9))'), /week\(\) takes one whole number from 0 to 7/)
  assert.match(errorOf('units(3)'), /units\(\) takes one time span/)
  assert.match(errorOf('week(0) > 1'), /is a time span/)
  assert.match(errorOf('units(week(0)) > 1 + (2 < 3)'), /Expected a number/)
  assert.match(errorOf('units(week(0)) $ 2'), /Unexpected "\$"/)
  assert.match(errorOf('x'.repeat(401)), /longer than 400/)
  assert.match(errorOf(Array(200).fill('1').join('+')), /too long/)
})

/** Five weeks back from Nov 10: chargers sell every week; the 3-pack of cables stopped after Oct 20. */
function history() {
  const orders = []
  for (const day of ['2026-10-07', '2026-10-14', '2026-10-21', '2026-10-28', '2026-11-04']) {
    for (let i = 0; i < 4; i++) orders.push(order({ date: day, value: '35.00', lines: [['CHG-65W', 1]], country: i ? 'US' : 'CA' }))
  }
  orders.push(order({ date: '2026-10-08', value: '20.00', lines: [['CAB-3PK', 2]] }))
  orders.push(order({ date: '2026-10-20', value: '20.00', lines: [['CAB-3PK', 1]] }))
  return orders
}

test('a formula rule finds a product with no sales two weeks running, and shows its figure and change', () => {
  const [rule] = checkRules([{
    id: 'stalled', name: 'Stalled product', each: 'product',
    when: 'units(week(0)) == 0 and units(week(1)) == 0', show: 'units(weeks(4))', unit: 'count', text: 'Any product: no units sold 2 weeks running',
  }], history(), '2026-11-10')
  assert.deepEqual([rule.understood, rule.tripped], [true, true])
  assert.equal(rule.subject, 'Braided cable 3-pack')
  assert.equal(rule.rule, 'Any product: no units sold 2 weeks running')
  assert.equal(rule.value, '1')
  assert.equal(rule.delta, '-66.7% vs week before')
  assert.equal(rule.reading, 'Braided cable 3-pack: no units sold 2 weeks running (1 over Nov 3 – Nov 9)')
})

test('a formula rule over the store or one country reads only it; a quiet one is not tripped', () => {
  const checked = checkRules([
    { id: 's', name: 'Store floor', when: 'net(week(0)) < avg(net(week(1)), net(week(2)), net(week(3))) / 2', show: 'net(week(0))', unit: 'usd' },
    { id: 'c', name: 'Canada', each: 'country', country: 'CA', when: 'orders(week(0)) < 1', show: 'orders(week(0))' },
    { id: 'n', name: 'No show', each: 'country', when: 'orders(week(0)) >= 1' },
  ], history(), '2026-11-10')
  assert.deepEqual(checked.map(c => [c.id, c.tripped, c.subject, c.value]), [
    ['s', false, 'Store', '$140'],
    ['c', false, 'Canada', '1'],
    ['n', true, 'Canada and 1 more', '2 of 2'],
  ])
  assert.equal(checked[1].rule, 'Canada: orders(week(0)) < 1', 'with no text, the rule line is the formula')
})

test("a formula the desk can't read is Can't check, with the reason as its rule line", () => {
  const checked = checkRules([
    { id: 'a', name: 'Typo', when: 'unit(week(0)) < 1' },
    { id: 'b', name: 'Number', when: 'units(week(0))' },
    { id: 'c', name: 'Each', when: 'units(week(0)) < 1', each: 'city' },
  ], history(), '2026-11-10')
  assert.deepEqual(checked.map(c => c.understood), [false, false, false])
  assert.match(checked[0].rule, /^No function named unit\(\)/)
  assert.match(checked[1].rule, /^`when` must be a true\/false test/)
  assert.match(checked[2].rule, /^`each` is store, product or country/)
})
