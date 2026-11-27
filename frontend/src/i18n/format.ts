import { getLocale } from "./index"

export type DateInput = Date | string | number

function toDate(value: DateInput): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00`)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function formatDate(
  value: DateInput,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = toDate(value)
  if (!date) return String(value)
  return new Intl.DateTimeFormat(getLocale(), options).format(date)
}

export function formatDateRange(
  start: DateInput,
  end: DateInput,
  options?: Intl.DateTimeFormatOptions,
): string {
  const startDate = toDate(start)
  const endDate = toDate(end)
  if (!startDate || !endDate) return `${String(start)} - ${String(end)}`
  const formatter = new Intl.DateTimeFormat(
    getLocale(),
    options ?? { year: "numeric", month: "short", day: "numeric" },
  ) as Intl.DateTimeFormat & {
    formatRange?: (start: Date, end: Date) => string
  }
  return typeof formatter.formatRange === "function"
    ? formatter.formatRange(startDate, endDate)
    : `${formatter.format(startDate)} – ${formatter.format(endDate)}`
}

export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(getLocale(), options).format(value)
}

/** Formats a ratio (0..1) as a localized percentage string. */
export function formatPercent(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(getLocale(), {
    style: "percent",
    ...options,
  }).format(value)
}
