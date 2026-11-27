import { useTranslation } from "react-i18next"
import type { DepartmentNode } from "@/client"

export function DepartmentTree({ nodes }: { nodes: DepartmentNode[] }) {
  const { t } = useTranslation()
  return (
    <ul className="space-y-2 border-l pl-4 text-sm">
      {nodes.map((node) => (
        <li key={node.path.join("/")}>
          <span>
            {t("setup.departmentTree.nodeLabel", {
              name: node.name,
              count: node.employee_count,
            })}
            {node.is_new && t("setup.departmentTree.newSuffix")}
          </span>
          {!!node.children?.length && <DepartmentTree nodes={node.children} />}
        </li>
      ))}
    </ul>
  )
}
