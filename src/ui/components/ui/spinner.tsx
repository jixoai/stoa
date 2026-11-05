/*
 * shadcn/ui 官方 registry 一手源（style=base-nova，2026-11-05 经
 * https://ui.shadcn.com/r/styles/base-nova/spinner.json 取回）。
 * 逐字收编；机械适配点（与 AGENTS.md 收编纪律一致）：
 * registry 生成器占位 IconPlaceholder → lucide-react 单色图标（保留原 className/props）、
 * registry 内部 import 路径 @/registry/base-nova/ui → 本仓 @/components/ui。
 * 升级对照：重取 registry JSON diff 本文件。
 */
import { cn } from "cn"
import { Loader2Icon } from "lucide-react"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
