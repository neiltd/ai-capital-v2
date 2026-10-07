import { describe, it, expect } from 'vitest'
import {
  isNyseTradingDay, nyseHolidays, nyseHolidayOn, nonTradingReason, easterSunday,
  isDailyRunDay, nonRunDayReason,
} from '../src/nyse-calendar.js'

/**
 * EXPECTED DATA, TYPED IN FROM THE PUBLISHED LISTS.
 *
 * Source: NYSE's own holiday and hours page, "Holidays & Trading Hours"
 * (nyse.com/markets/hours-calendars), which publishes the full-day closures
 * for the current and next two calendar years. These are the FULL-DAY closures
 * only; the early closes published alongside them (1:00 p.m. ET on July 3
 * 2026, the day after Thanksgiving, and December 24 where applicable) are
 * deliberately NOT in these lists, because an early close is a trading day.
 *
 * Typed as data rather than generated, so the rules in nyse-calendar.ts are
 * checked against an independent statement of the answer.
 */
const PUBLISHED: Record<number, string[]> = {
  2025: [
    '2025-01-01', // New Year's Day (Wednesday)
    '2025-01-20', // Martin Luther King Jr. Day
    '2025-02-17', // Washington's Birthday
    '2025-04-18', // Good Friday
    '2025-05-26', // Memorial Day
    '2025-06-19', // Juneteenth (Thursday)
    '2025-07-04', // Independence Day (Friday)
    '2025-09-01', // Labor Day
    '2025-11-27', // Thanksgiving Day
    '2025-12-25', // Christmas Day (Thursday)
  ],
  2026: [
    '2026-01-01', // New Year's Day (Thursday)
    '2026-01-19', // Martin Luther King Jr. Day
    '2026-02-16', // Washington's Birthday
    '2026-04-03', // Good Friday
    '2026-05-25', // Memorial Day
    '2026-06-19', // Juneteenth (Friday)
    '2026-07-03', // Independence Day observed — July 4 is a Saturday
    '2026-09-07', // Labor Day
    '2026-11-26', // Thanksgiving Day
    '2026-12-25', // Christmas Day (Friday)
  ],
  2027: [
    '2027-01-01', // New Year's Day (Friday)
    '2027-01-18', // Martin Luther King Jr. Day
    '2027-02-15', // Washington's Birthday
    '2027-03-26', // Good Friday
    '2027-05-31', // Memorial Day
    '2027-06-18', // Juneteenth observed — June 19 is a Saturday
    '2027-07-05', // Independence Day observed — July 4 is a Sunday
    '2027-09-06', // Labor Day
    '2027-11-25', // Thanksgiving Day
    '2027-12-24', // Christmas Day observed — December 25 is a Saturday
  ],
}

describe('NYSE full-day holidays, against the published lists', () => {
  for (const [year, expected] of Object.entries(PUBLISHED)) {
    it(`matches the published ${year} list exactly`, () => {
      expect(nyseHolidays(Number(year)).map(h => h.date)).toEqual(expected)
    })

    it(`${year}: every published date is a non-trading day`, () => {
      for (const d of expected) expect(isNyseTradingDay(d)).toBe(false)
    })
  }

  it('names each holiday, not just the date', () => {
    expect(nyseHolidayOn('2026-07-03')?.name).toBe('Independence Day')
    expect(nyseHolidayOn('2026-04-03')?.name).toBe('Good Friday')
    expect(nyseHolidayOn('2027-12-24')?.name).toBe('Christmas Day')
    expect(nyseHolidayOn('2026-06-19')?.name).toBe('Juneteenth National Independence Day')
  })
})

describe('observance rules', () => {
  it('a Saturday holiday is observed the preceding Friday', () => {
    // July 4 2026 is a Saturday -> Friday July 3.
    expect(nyseHolidayOn('2026-07-03')).not.toBeNull()
    expect(isNyseTradingDay('2026-07-03')).toBe(false)
    // Christmas 2027 is a Saturday -> Friday December 24.
    expect(nyseHolidayOn('2027-12-24')).not.toBeNull()
  })

  it('a Sunday holiday is observed the following Monday', () => {
    // July 4 2027 is a Sunday -> Monday July 5.
    expect(nyseHolidayOn('2027-07-05')).not.toBeNull()
    expect(isNyseTradingDay('2027-07-05')).toBe(false)
  })

  it("New Year's Day on a SATURDAY is not observed at all (NYSE Rule 7.2)", () => {
    // January 1 2022 was a Saturday. The preceding Friday, December 31 2021,
    // was a full trading day — the documented exception to the Saturday rule.
    expect(new Date(Date.UTC(2022, 0, 1)).getUTCDay()).toBe(6)
    expect(nyseHolidayOn('2021-12-31')).toBeNull()
    expect(isNyseTradingDay('2021-12-31')).toBe(true)
    expect(nyseHolidays(2022).some(h => h.name === "New Year's Day")).toBe(false)
  })

  it("New Year's Day on a SUNDAY is observed on the Monday", () => {
    // January 1 2023 was a Sunday -> Monday January 2 2023.
    expect(new Date(Date.UTC(2023, 0, 1)).getUTCDay()).toBe(0)
    expect(nyseHolidayOn('2023-01-02')?.name).toBe("New Year's Day")
  })

  it('Juneteenth is not a holiday before 2022', () => {
    expect(nyseHolidays(2021).some(h => h.name.startsWith('Juneteenth'))).toBe(false)
    expect(nyseHolidays(2022).some(h => h.name.startsWith('Juneteenth'))).toBe(true)
  })
})

describe('Easter computus, checked independently of Good Friday', () => {
  // Published Gregorian Easter Sundays.
  const EASTER: Record<number, [number, number]> = {
    2024: [3, 31], 2025: [4, 20], 2026: [4, 5], 2027: [3, 28], 2028: [4, 16],
    2030: [4, 21], 2038: [4, 25], // 2038 is the late-boundary case
  }
  for (const [y, [m, d]] of Object.entries(EASTER)) {
    it(`Easter ${y} is ${m}/${d}`, () => {
      expect(easterSunday(Number(y))).toEqual({ month: m, day: d })
    })
  }
})

describe('weekends and ordinary days', () => {
  it('Saturdays and Sundays are not trading days', () => {
    expect(isNyseTradingDay('2026-10-10')).toBe(false) // Saturday
    expect(isNyseTradingDay('2026-10-11')).toBe(false) // Sunday
    expect(nonTradingReason('2026-10-10')).toBe('Saturday')
    expect(nonTradingReason('2026-10-11')).toBe('Sunday')
  })

  it('an ordinary weekday is a trading day', () => {
    expect(isNyseTradingDay('2026-10-07')).toBe(true) // Wednesday
    expect(nonTradingReason('2026-10-07')).toBeNull()
  })

  it('EARLY-CLOSE days are trading days and do run', () => {
    // The day after Thanksgiving 2026 closes at 13:00 ET. It still trades.
    expect(isNyseTradingDay('2026-11-27')).toBe(true)
    expect(nonTradingReason('2026-11-27')).toBeNull()
    // July 3 2025 was an early close, and a trading day.
    expect(isNyseTradingDay('2025-07-03')).toBe(true)
    // December 24 2026 is a Thursday early close, not a closure.
    expect(isNyseTradingDay('2026-12-24')).toBe(true)
  })

  it('counts a plausible number of trading days in a year', () => {
    // 2026 has 261 weekdays; 9 of the 10 holidays fall on a weekday (July 4
    // falls on a Saturday and is observed July 3, which is also a weekday), so
    // every one of the 10 published closures removes a weekday.
    let weekdays = 0
    let trading = 0
    for (let m = 1; m <= 12; m++) {
      const days = new Date(Date.UTC(2026, m, 0)).getUTCDate()
      for (let d = 1; d <= days; d++) {
        const iso = `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        const dow = new Date(Date.UTC(2026, m - 1, d)).getUTCDay()
        if (dow !== 0 && dow !== 6) weekdays++
        if (isNyseTradingDay(iso)) trading++
      }
    }
    expect(weekdays).toBe(261)
    expect(trading).toBe(weekdays - PUBLISHED[2026].length)
    expect(trading).toBe(251)
  })
})

/**
 * ── THE RUN RULE: trading days AND every Sunday ────────────────────────────
 *
 * Distinct from isNyseTradingDay above, which this function uses but does not
 * equal. The two disagree on every Sunday, and that disagreement is the point:
 * the market is shut on Sunday, and we run anyway, because four stages are
 * Sunday-only.
 */
describe('isDailyRunDay — the eligibility rule', () => {
  it('a Saturday is NOT a run day', () => {
    expect(isDailyRunDay('2026-10-10')).toBe(false)   // Saturday
    expect(nonRunDayReason('2026-10-10')).toBe('Saturday')
  })

  it('a Sunday IS a run day', () => {
    expect(isDailyRunDay('2026-10-11')).toBe(true)    // Sunday
    expect(nonRunDayReason('2026-10-11')).toBeNull()
    // And the market is shut that day — the two questions differ.
    expect(isNyseTradingDay('2026-10-11')).toBe(false)
  })

  it('a holiday falling on a SUNDAY is still a run day', () => {
    // July 4 2027 is a Sunday. The market observes it on Monday July 5; the
    // Sunday itself still runs, because Sunday runs regardless.
    expect(new Date(Date.UTC(2027, 6, 4)).getUTCDay()).toBe(0)
    expect(isDailyRunDay('2027-07-04')).toBe(true)
    expect(nonRunDayReason('2027-07-04')).toBeNull()
    // The observed Monday is a weekday holiday, so it does not run.
    expect(isDailyRunDay('2027-07-05')).toBe(false)
    expect(nonRunDayReason('2027-07-05')).toBe('NYSE holiday: Independence Day')
  })

  it('a WEEKDAY holiday is NOT a run day', () => {
    // Thanksgiving 2026, a Thursday.
    expect(isDailyRunDay('2026-11-26')).toBe(false)
    expect(nonRunDayReason('2026-11-26')).toBe('NYSE holiday: Thanksgiving Day')
  })

  it('an OBSERVED holiday on a weekday is NOT a run day', () => {
    // July 4 2026 is a Saturday, observed Friday July 3.
    expect(new Date(Date.UTC(2026, 6, 3)).getUTCDay()).toBe(5)
    expect(isDailyRunDay('2026-07-03')).toBe(false)
    expect(nonRunDayReason('2026-07-03')).toBe('NYSE holiday: Independence Day')
    // The Saturday itself is excluded as a Saturday, not as a holiday.
    expect(nonRunDayReason('2026-07-04')).toBe('Saturday')
  })

  it('an EARLY-CLOSE day IS a run day', () => {
    // The day after Thanksgiving 2026 closes at 13:00 ET and still runs.
    expect(isDailyRunDay('2026-11-27')).toBe(true)
    expect(nonRunDayReason('2026-11-27')).toBeNull()
  })

  it('an ordinary weekday IS a run day', () => {
    expect(isDailyRunDay('2026-10-07')).toBe(true)
  })

  it('every non-run day gives exactly one of the two reasons', () => {
    for (let m = 1; m <= 12; m++) {
      const days = new Date(Date.UTC(2026, m, 0)).getUTCDate()
      for (let d = 1; d <= days; d++) {
        const iso = `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        const why = nonRunDayReason(iso)
        if (isDailyRunDay(iso)) expect(why).toBeNull()
        else expect(why === 'Saturday' || why!.startsWith('NYSE holiday: ')).toBe(true)
      }
    }
  })

  it('counts the 2026 run days: weekdays minus weekday holidays, plus Sundays', () => {
    let run = 0, sundays = 0, weekdayHolidays = 0
    for (let m = 1; m <= 12; m++) {
      const days = new Date(Date.UTC(2026, m, 0)).getUTCDate()
      for (let d = 1; d <= days; d++) {
        const iso = `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        const dow = new Date(Date.UTC(2026, m - 1, d)).getUTCDay()
        if (isDailyRunDay(iso)) run++
        if (dow === 0) sundays++
        if (dow >= 1 && dow <= 5 && nyseHolidayOn(iso)) weekdayHolidays++
      }
    }
    // 261 weekdays in 2026, 10 published closures all of which land on a
    // weekday, plus 52 Sundays.
    expect(weekdayHolidays).toBe(10)
    expect(sundays).toBe(52)
    expect(run).toBe(261 - 10 + 52)
    expect(run).toBe(303)
  })
})
