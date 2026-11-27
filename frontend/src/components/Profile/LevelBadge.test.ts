import { deepEqual, equal } from "node:assert/strict"
import { test } from "node:test"
import { levelBadgeInfo } from "./LevelBadge"

test("generates L1..LN dynamically for 3-level and 5-level rubrics with increasing color depth", () => {
  const threeLevels = {
    levels: [
      { key: "needs_support", label: "需要协助", description: "需指导" },
      { key: "routine", label: "能完成常规任务", description: "独立完成常规" },
      {
        key: "independent_complex",
        label: "能独立完成复杂任务",
        description: "主导复杂",
      },
    ],
  }
  const r3 = threeLevels.levels.map((l) => levelBadgeInfo(threeLevels, l.key))
  deepEqual(
    r3.map((item) =>
      item.kind === "ranked" ? [item.code, item.styleIndex] : null,
    ),
    [
      ["L1", 0],
      ["L2", 2],
      ["L3", 4],
    ],
  )

  const fiveLevels = {
    levels: [
      { key: "l1", label: "入门" },
      { key: "l2", label: "基础" },
      { key: "l3", label: "熟练" },
      { key: "l4", label: "精通" },
      { key: "l5", label: "专家" },
    ],
  }
  const r5 = fiveLevels.levels.map((l) => levelBadgeInfo(fiveLevels, l.key))
  deepEqual(
    r5.map((item) =>
      item.kind === "ranked" ? [item.code, item.styleIndex] : null,
    ),
    [
      ["L1", 0],
      ["L2", 1],
      ["L3", 2],
      ["L4", 3],
      ["L5", 4],
    ],
  )
})

test("handles ungraded, adjusted and unlisted levels cleanly", () => {
  const rubric = { levels: [{ key: "a", label: "基础" }] }
  equal(levelBadgeInfo(rubric, null).kind, "ungraded")
  equal(levelBadgeInfo(rubric, "").kind, "ungraded")
  equal(levelBadgeInfo(rubric, "x", { adjusted: true }).kind, "adjusted")
  const unlisted = levelBadgeInfo(rubric, "legacy", { fallbackLabel: "旧等级" })
  deepEqual(unlisted, { kind: "unlisted", label: "旧等级" })
})
