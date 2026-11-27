import { deepEqual, equal } from "node:assert/strict"
import { test } from "node:test"
import { countWeeks, summarizeFindings } from "./Plans"

const people = new Map<string, string>([
  ["emp-1", "陈砚冰"],
  ["emp-2", "林秋禾"],
])

test("countWeeks calculates inclusive calendar weeks across date spans", () => {
  equal(countWeeks("2027-01-04", "2027-02-26"), 8)
  equal(countWeeks("2027-01-04", "2027-01-10"), 1)
  equal(countWeeks("2027-01-04", "2027-01-04"), 1)
  equal(countWeeks("2027-01-06", "2027-01-12"), 2)
  equal(countWeeks("2027-01-10", "2027-01-04"), null)
  equal(countWeeks("未定", "2027-01-10"), null)
})

test("summarizeFindings merges continuous weeks into a date range", () => {
  const weeks = [
    "2027-01-04",
    "2027-01-11",
    "2027-01-18",
    "2027-01-25",
    "2027-02-01",
    "2027-02-08",
    "2027-02-15",
    "2027-02-22",
  ]
  const findings = weeks.map((week_start) => ({
    code: "unconfirmed",
    level: "insufficient_data",
    message: "该周容量未确认或需重新确认",
    employee_id: "emp-1",
    week_start,
  }))
  deepEqual(summarizeFindings(findings, people), [
    "陈砚冰：8 周容量未确认（2027-01-04 至 2027-02-28）",
  ])
})

test("summarizeFindings formats non-continuous and single weeks concisely", () => {
  const findings = [
    {
      code: "unconfirmed",
      employee_id: "emp-1",
      week_start: "2027-01-04",
      message: "该周容量未确认或需重新确认",
    },
    {
      code: "unconfirmed",
      employee_id: "emp-1",
      week_start: "2027-02-01",
      message: "该周容量未确认或需重新确认",
    },
    {
      code: "unconfirmed",
      employee_id: "emp-1",
      week_start: "2027-01-18",
      message: "该周容量未确认或需重新确认",
    },
    {
      code: "over_regular_cap",
      employee_id: "emp-2",
      week_start: "2027-01-04",
      message: "该周超出常规配额上限（70%）10%，需允许动用弹性空间",
    },
    {
      code: "overload",
      employee_id: "emp-2",
      week_start: "2027-01-11",
      message: "该周超出可用容量 10%",
    },
    {
      code: "elastic_used",
      employee_id: "emp-2",
      week_start: "2027-01-18",
      message: "已占用弹性配额 10%",
    },
  ]
  deepEqual(summarizeFindings(findings, people), [
    "陈砚冰：3 周容量未确认（01-04、01-18、02-01）",
    "林秋禾：1 周超出常规配额（2027-01-04）",
    "林秋禾：1 周超可用容量（2027-01-11）",
    "林秋禾：1 周已占用弹性配额（2027-01-18）",
  ])
})

test("summarizeFindings deduplicates findings missing employee_id or week_start", () => {
  const findings = [
    {
      code: "headcount_gap",
      week_start: "2027-01-04",
      message: "该周覆盖人数少于需求",
    },
    {
      code: "headcount_gap",
      week_start: "2027-01-11",
      message: "该周覆盖人数少于需求",
    },
    {
      code: "outside_basis",
      employee_id: "emp-1",
      message: "画像未记录这项能力，按经理判断",
    },
    {
      code: "outside_basis",
      employee_id: "emp-1",
      message: "画像未记录这项能力，按经理判断",
    },
  ]
  deepEqual(summarizeFindings(findings, people), [
    "该周覆盖人数少于需求",
    "陈砚冰：画像未记录这项能力，按经理判断",
  ])
})

test("summarizeFindings merges forecast_week into soft confirmation summary", () => {
  const weeks = [
    "2027-01-04",
    "2027-01-11",
    "2027-01-18",
    "2027-01-25",
    "2027-02-01",
    "2027-02-08",
    "2027-02-15",
    "2027-02-22",
  ]
  const findings = weeks.map((week_start) => ({
    code: "forecast_week",
    level: "feasible",
    message: "该周使用预测基线 20%，确认方案后将自动确认",
    employee_id: "emp-2",
    week_start,
  }))
  deepEqual(summarizeFindings(findings, people), [
    "林秋禾：8 周使用预测基线（2027-01-04 至 2027-02-28），确认方案时将自动确认这些周次负荷",
  ])
})
