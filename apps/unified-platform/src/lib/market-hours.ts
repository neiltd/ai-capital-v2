// Mirrors the trading windows that used to live in the crontab for
// scripts/refresh-prices.sh (US + Thai SET sessions, in PT).

function ptParts(now: Date): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour:     'numeric',
    hour12:   false,
    weekday:  'short',
  }).formatToParts(now)
  const hourStr = parts.find(p => p.type === 'hour')?.value ?? '0'
  const weekdayStr = parts.find(p => p.type === 'weekday')?.value ?? 'Sun'
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return { hour: parseInt(hourStr, 10) % 24, weekday: WEEKDAYS.indexOf(weekdayStr) }
}

export function isMarketOpen(now: Date = new Date()): boolean {
  const { hour, weekday } = ptParts(now)

  // US session 9:30am-4pm ET = 6:00-13:00 PT, Mon-Fri
  const usOpen = weekday >= 1 && weekday <= 5 && hour >= 6 && hour <= 13

  // Thai SET morning 10:00-12:30 ICT = 19:00-22:30 PT prior evening, Sun-Thu
  const thMorningOpen = weekday >= 0 && weekday <= 4 && hour >= 19 && hour <= 22

  // Thai SET afternoon 14:30-16:30 ICT = 0:30-3:30 PT same night, Mon-Fri
  const thAfternoonOpen = weekday >= 1 && weekday <= 5 && hour >= 0 && hour <= 3

  return usOpen || thMorningOpen || thAfternoonOpen
}
