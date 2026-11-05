/*
 * shadcn/ui 官方 registry 一手源（style=base-nova，2026-11-05 经
 * https://ui.shadcn.com/r/styles/base-nova/separator.json 取回）。
 * 逐字收编；机械适配点（与 AGENTS.md 收编纪律一致）：
 * registry 生成器占位 IconPlaceholder → lucide-react 单色图标（保留原 className/props）、
 * registry 内部 import 路径 @/registry/base-nova/ui → 本仓 @/components/ui。
 * 升级对照：重取 registry JSON diff 本文件。
 */
"use client"

import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"
import { cn } from "cn"

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
