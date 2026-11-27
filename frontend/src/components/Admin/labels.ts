import type { AccountPublic, EmploymentStatus, Role } from "@/client"
import { i18n } from "@/i18n"

export type AccountStatus = AccountPublic["status"]

/** Wrap a static zh-CN map in a Proxy so every read resolves the active locale dynamically. */
export function localeRecord<T extends Record<string, string>>(
  defaults: T,
  namespacePrefix: string,
  transformKey?: (key: string) => string,
): T {
  return new Proxy(defaults, {
    get(target, prop) {
      if (
        typeof prop === "string" &&
        Reflect.getOwnPropertyDescriptor(target, prop) !== undefined
      ) {
        const key = transformKey ? transformKey(prop) : prop
        const translationKey = `${namespacePrefix}.${key}`
        return target[prop]
          ? i18n.t(translationKey, { defaultValue: target[prop] })
          : i18n.t(translationKey)
      }
      return Reflect.get(target, prop)
    },
    getOwnPropertyDescriptor(target, prop) {
      const desc = Reflect.getOwnPropertyDescriptor(target, prop)
      if (desc && typeof prop === "string") {
        const key = transformKey ? transformKey(prop) : prop
        const translationKey = `${namespacePrefix}.${key}`
        return {
          ...desc,
          value: target[prop]
            ? i18n.t(translationKey, { defaultValue: target[prop] })
            : i18n.t(translationKey),
        }
      }
      return desc
    },
  })
}

export const accountLabels: Record<AccountStatus, string> = localeRecord(
  {
    none: "",
    pending_first_login: "",
    active: "",
    disabled: "",
  },
  "admin.labels.account",
)
export const employmentLabels: Record<EmploymentStatus, string> = localeRecord(
  {
    active: "",
    inactive: "",
  },
  "admin.labels.employment",
)
export const roleLabels: Record<Role, string> = localeRecord(
  {
    org_admin: "",
    dept_manager: "",
  },
  "admin.labels.role",
)
