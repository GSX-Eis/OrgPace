export const DAY_MS = 86_400_000
export const WEEK_MS = 7 * DAY_MS

export type DateRange = {
  start_date: string
  end_date: string
}

/** Parse a strict YYYY-MM-DD calendar date into UTC midnight, rejecting rollovers like 2026-02-30. */
export function parseIsoDateUtc(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2]) - 1
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return date
}

export function mondayUtcMs(date: Date): number {
  const day = date.getUTCDay()
  const diffToMonday = day === 0 ? -6 : 1 - day
  return date.getTime() + diffToMonday * DAY_MS
}

export function addDaysIso(isoDate: string, days: number): string | null {
  const parsed = parseIsoDateUtc(isoDate)
  if (!parsed) return null
  return new Date(parsed.getTime() + days * DAY_MS).toISOString().slice(0, 10)
}

export function addWeeks(start: string, weeks: number): string {
  return addDaysIso(start, weeks * 7) ?? start
}

export function weekRange(start: string): DateRange {
  return {
    start_date: start,
    end_date: addDaysIso(start, 6) ?? start,
  }
}

export function overlaps(a: DateRange, b: DateRange): boolean {
  return a.start_date <= b.end_date && b.start_date <= a.end_date
}

export function countWeeks(startDate: string, endDate: string): number | null {
  const start = parseIsoDateUtc(startDate)
  const end = parseIsoDateUtc(endDate)
  if (!start || !end || start.getTime() > end.getTime()) return null
  return Math.round((mondayUtcMs(end) - mondayUtcMs(start)) / WEEK_MS) + 1
}

export function currentMondayIso(now = new Date()): string {
  const day = now.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const monday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + diff,
  )
  const y = monday.getFullYear()
  const m = String(monday.getMonth() + 1).padStart(2, "0")
  const d = String(monday.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

export function isMondayIso(iso: string): boolean {
  const parsed = parseIsoDateUtc(iso)
  return parsed !== null && parsed.getUTCDay() === 1
}

export function weekdaysIso(mondayIso: string): string[] {
  if (!parseIsoDateUtc(mondayIso)) return []
  return Array.from({ length: 5 }, (_, index) => addDaysIso(mondayIso, index)!)
}

export function areConsecutiveWeeks(sortedWeeks: string[]): boolean {
  for (let i = 1; i < sortedWeeks.length; i += 1) {
    const prev = parseIsoDateUtc(sortedWeeks[i - 1])
    const curr = parseIsoDateUtc(sortedWeeks[i])
    if (!prev || !curr || curr.getTime() - prev.getTime() !== WEEK_MS) {
      return false
    }
  }
  return true
}
