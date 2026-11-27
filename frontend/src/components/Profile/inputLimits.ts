import i18n from "@/i18n"

export const STATEMENT_MAX = 200
export const EXPLANATION_MAX = 4000
export const ITEMS_MAX = 50

export const characterCount = (value: string) => Array.from(value).length

export function textLimitMessage(
  value: string,
  limit: number,
  index: number,
  label = i18n.t("profile.inputLimits.defaultLabel"),
) {
  const count = characterCount(value)
  return count > limit
    ? i18n.t("profile.inputLimits.exceeded", {
        label,
        limit,
        index: index + 1,
        count,
      })
    : null
}
