import { deepEqual, equal } from "node:assert/strict"
import { test } from "node:test"
import {
  addDaysIso,
  addWeeks,
  areConsecutiveWeeks,
  countWeeks,
  currentMondayIso,
  isMondayIso,
  overlaps,
  parseIsoDateUtc,
  weekdaysIso,
  weekRange,
} from "./dateUtils"

test("parseIsoDateUtc validates strict calendar dates", () => {
  equal(parseIsoDateUtc("2024-02-29")?.toISOString().slice(0, 10), "2024-02-29")
  equal(parseIsoDateUtc("2026-02-29"), null)
  equal(parseIsoDateUtc("2026-02-31"), null)
  equal(parseIsoDateUtc("2026-13-01"), null)
  equal(parseIsoDateUtc("not-a-date"), null)
})

test("addDaysIso, addWeeks, weekRange, and overlaps handle week math", () => {
  equal(addDaysIso("2027-01-04", 6), "2027-01-10")
  equal(addDaysIso("bad", 6), null)
  equal(addWeeks("2027-01-04", 2), "2027-01-18")
  equal(addWeeks("2027-01-18", -1), "2027-01-11")
  deepEqual(weekRange("2027-01-04"), {
    start_date: "2027-01-04",
    end_date: "2027-01-10",
  })
  equal(
    overlaps(
      { start_date: "2027-01-04", end_date: "2027-01-10" },
      { start_date: "2027-01-10", end_date: "2027-01-17" },
    ),
    true,
  )
  equal(
    overlaps(
      { start_date: "2027-01-04", end_date: "2027-01-10" },
      { start_date: "2027-01-11", end_date: "2027-01-17" },
    ),
    false,
  )
})

test("currentMondayIso, isMondayIso, weekdaysIso, and areConsecutiveWeeks", () => {
  // Sunday rolls back 6 days to Monday; Wednesday rolls back 2 days.
  equal(currentMondayIso(new Date(2027, 0, 10, 12)), "2027-01-04")
  equal(currentMondayIso(new Date(2027, 0, 6, 12)), "2027-01-04")
  equal(isMondayIso("2027-01-04"), true)
  equal(isMondayIso("2027-01-05"), false)
  equal(isMondayIso("2026-02-30"), false)
  deepEqual(weekdaysIso("2027-01-04"), [
    "2027-01-04",
    "2027-01-05",
    "2027-01-06",
    "2027-01-07",
    "2027-01-08",
  ])
  deepEqual(weekdaysIso("invalid"), [])
  equal(areConsecutiveWeeks(["2027-01-04", "2027-01-11", "2027-01-18"]), true)
  equal(areConsecutiveWeeks(["2027-01-04", "2027-01-18"]), false)
  equal(countWeeks("2027-01-04", "2027-02-26"), 8)
})
