/**
 * ── NYSE trading days, computed by rule ────────────────────────────────────
 *
 * WHY BY RULE AND NOT A DATE LIST. A hard-coded list of holidays is correct
 * until the year it runs out, and then it is silently wrong: every date past
 * the end of the list reads as a trading day, so the pipeline would run on
 * Christmas 2028 and nothing would flag it. The rules below are the published
 * NYSE ones and they do not expire.
 *
 * WHAT THIS IS NOT. This decides FULL-DAY closures only. Early-close days —
 * the day after Thanksgiving, Christmas Eve in some years, July 3 in others —
 * are trading days and the daily run happens on them. The briefing is due
 * before the open, so a 13:00 ET close changes nothing about it.
 *
 * SCOPE. This answers "would the NYSE be open on this calendar date", nothing
 * else. It takes a logical date string, not an instant, because the question
 * is about a business day and not about a moment in a timezone.
 */

/** A full-day NYSE closure, as a logical date and the rule that produced it. */
export interface NyseHoliday {
  /** `YYYY-MM-DD` in the business calendar. */
  date: string
  /** Which holiday, by its NYSE name. */
  name: string
}

const pad = (n: number): string => String(n).padStart(2, '0')
const ymd = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`

/** Day of week for a calendar date, 0=Sunday .. 6=Saturday, with no timezone in play. */
function dayOfWeekUtc(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** The `n`th `weekday` of a month, e.g. the 3rd Monday of January. */
function nthWeekdayOfMonth(y: number, m: number, weekday: number, n: number): number {
  const firstDow = dayOfWeekUtc(y, m, 1)
  const offset = (weekday - firstDow + 7) % 7
  return 1 + offset + (n - 1) * 7
}

/** The last `weekday` of a month, e.g. the last Monday of May. */
function lastWeekdayOfMonth(y: number, m: number, weekday: number): number {
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const lastDow = dayOfWeekUtc(y, m, daysInMonth)
  return daysInMonth - ((lastDow - weekday + 7) % 7)
}

/**
 * Gregorian Easter Sunday, by the Anonymous (Meeus/Jones/Butcher) computus.
 *
 * Good Friday is the only NYSE holiday that is not a fixed date or an nth
 * weekday, which is the whole reason this arithmetic is here. Spot-checked in
 * the tests against published Easter dates, not just against Good Friday.
 */
export function easterSunday(y: number): { month: number; day: number } {
  const a = y % 19
  const b = Math.floor(y / 100)
  const c = y % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return { month, day }
}

/** `offset` days from a calendar date, as `{y, m, d}`. */
function shiftDate(y: number, m: number, d: number, offset: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + offset))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

/**
 * NYSE weekend observance, for the fixed-date holidays only.
 *
 * Saturday -> the preceding Friday; Sunday -> the following Monday. New Year's
 * Day is the documented exception and is handled by its caller, not here.
 */
function observed(y: number, m: number, d: number): { y: number; m: number; d: number } {
  const dow = dayOfWeekUtc(y, m, d)
  if (dow === 6) return shiftDate(y, m, d, -1)  // Saturday -> Friday
  if (dow === 0) return shiftDate(y, m, d, +1)  // Sunday   -> Monday
  return { y, m, d }
}

/**
 * Every full-day NYSE closure observed in calendar year `y`.
 *
 * Observance rules are NYSE's: a holiday falling on Saturday is observed the
 * preceding Friday and one falling on Sunday the following Monday — EXCEPT
 * New Year's Day, which under NYSE Rule 7.2 is NOT observed on the preceding
 * Friday when January 1 is a Saturday. In that case the market is open on
 * December 31 and there is no closure at all for that New Year's Day.
 */
export function nyseHolidays(y: number): NyseHoliday[] {
  const out: NyseHoliday[] = []
  const add = (name: string, p: { y: number; m: number; d: number }): void => {
    // Only record closures that land inside the requested year. A fixed-date
    // holiday shifted across a year boundary belongs to the other year's list.
    if (p.y === y) out.push({ date: ymd(p.y, p.m, p.d), name })
  }

  // New Year's Day, with the Rule 7.2 exception.
  const nyDow = dayOfWeekUtc(y, 1, 1)
  if (nyDow === 0) add("New Year's Day", { y, m: 1, d: 2 })            // Sunday -> Monday
  else if (nyDow !== 6) add("New Year's Day", { y, m: 1, d: 1 })        // Saturday -> not observed
  // A Sunday January 1 of the FOLLOWING year is observed on January 2 of that
  // year, so it never falls into this year's list; nothing to do here.

  add('Martin Luther King Jr. Day', { y, m: 1, d: nthWeekdayOfMonth(y, 1, 1, 3) })
  add("Washington's Birthday", { y, m: 2, d: nthWeekdayOfMonth(y, 2, 1, 3) })

  const easter = easterSunday(y)
  add('Good Friday', shiftDate(y, easter.month, easter.day, -2))

  add('Memorial Day', { y, m: 5, d: lastWeekdayOfMonth(y, 5, 1) })

  // Juneteenth became a market holiday in 2022, not before.
  if (y >= 2022) add('Juneteenth National Independence Day', observed(y, 6, 19))

  add('Independence Day', observed(y, 7, 4))
  add('Labor Day', { y, m: 9, d: nthWeekdayOfMonth(y, 9, 1, 1) })
  add('Thanksgiving Day', { y, m: 11, d: nthWeekdayOfMonth(y, 11, 4, 4) })
  add('Christmas Day', observed(y, 12, 25))

  return out.sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Which NYSE holiday falls on this logical date, if any.
 * Returns null on a date that is not a full-day closure, including weekends —
 * a Saturday is not "a holiday", it is simply not a trading day.
 */
export function nyseHolidayOn(logicalDate: string): NyseHoliday | null {
  const y = Number(logicalDate.slice(0, 4))
  return nyseHolidays(y).find(h => h.date === logicalDate) ?? null
}

/**
 * Would the NYSE have a regular trading session on this logical date?
 *
 * False on Saturdays, Sundays and full-day holidays. True on early-close days,
 * which are ordinary trading days that happen to end at 13:00 ET.
 */
export function isNyseTradingDay(logicalDate: string): boolean {
  const [y, m, d] = logicalDate.split('-').map(Number)
  const dow = dayOfWeekUtc(y, m, d)
  if (dow === 0 || dow === 6) return false
  return nyseHolidayOn(logicalDate) === null
}

/** Why a logical date is not a trading day, in a form fit for a log line. */
export function nonTradingReason(logicalDate: string): string | null {
  const [y, m, d] = logicalDate.split('-').map(Number)
  const dow = dayOfWeekUtc(y, m, d)
  if (dow === 6) return 'Saturday'
  if (dow === 0) return 'Sunday'
  const holiday = nyseHolidayOn(logicalDate)
  return holiday ? `NYSE holiday: ${holiday.name}` : null
}

/**
 * ── Does the DAILY RUN happen on this logical date? ────────────────────────
 *
 * Trading days AND every Sunday. Not Saturdays, and not a weekday that is an
 * NYSE full-day holiday.
 *
 * WHY SUNDAY IS IN. Four pipeline stages are Sunday-only, gated by
 * `skipIf: notSunday` in packages/queue/src/jobs.ts — world-intel-memory
 * (:90-94), scenario-discover (:161-165), people-tweets (:169-173) and
 * correlation (:179-183). A trading-day-only rule would mean the daily flow
 * never ran on a Sunday again, so those four stages would never run again
 * either, silently. They stay until a separate weekend job takes them over.
 *
 * A holiday falling on a Sunday does NOT stop the Sunday run: Sunday runs
 * regardless of the NYSE calendar, because what Sunday is for here is the
 * weekly stages, not the market.
 *
 * This is deliberately a different question from `isNyseTradingDay`, which
 * stays its own function and its own tested unit: one answers "is the market
 * open", this one answers "do we run". They disagree on every Sunday.
 */
export function isDailyRunDay(logicalDate: string): boolean {
  const [y, m, d] = logicalDate.split('-').map(Number)
  const dow = dayOfWeekUtc(y, m, d)
  if (dow === 0) return true   // Sunday always runs, holiday or not
  if (dow === 6) return false  // Saturday never runs
  return isNyseTradingDay(logicalDate)
}

/**
 * Why the daily run does not happen on this logical date, or null if it does.
 * Exactly two cases can reach this: 'Saturday', or 'NYSE holiday: <name>'.
 */
export function nonRunDayReason(logicalDate: string): string | null {
  if (isDailyRunDay(logicalDate)) return null
  const [y, m, d] = logicalDate.split('-').map(Number)
  if (dayOfWeekUtc(y, m, d) === 6) return 'Saturday'
  const holiday = nyseHolidayOn(logicalDate)
  // Unreachable by construction: a non-run day is a Saturday or a weekday
  // holiday, and nothing else. Named rather than left as a bare non-null
  // assertion so a future rule change fails loudly instead of printing junk.
  if (!holiday) throw new Error(`non-run day with no cause: ${logicalDate}`)
  return `NYSE holiday: ${holiday.name}`
}
