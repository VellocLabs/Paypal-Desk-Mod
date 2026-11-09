/**
 * Calendar dates as `YYYY-MM-DD` strings. Day arithmetic is on the calendar;
 * an instant becomes a date on this machine's local clock, the store's day.
 */

const DAY_MS = 86_400_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function isDate(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const ms = Date.parse(`${text}T00:00:00Z`)
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(text)
}

export function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
}

export function dayRange(from, to) {
  const days = []
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d)
  return days
}

/** The local calendar day of the instant `ms`. */
export function dateOf(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** "Nov 7". */
export function shortDate(date) {
  return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`
}

/** "Sat 11/7". */
export function dayLabel(date) {
  return `${WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]} ${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`
}
