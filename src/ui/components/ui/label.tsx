/*
 * shadcn/ui 官方 registry 一手源（style=base-nova，2026-11-10 经
 * https://ui.shadcn.com/r/styles/base-nova/label.json 取回）。
 * 逐字收编；机械适配点（与 AGENTS.md 收编纪律一致）：
 * 本件无 registry 生成器占位 IconPlaceholder，也没有内部 import 需要改路径（仅 cn）。
 * 升级对照：重取 registry JSON diff 本文件。
 */
"use client"

import * as React from "react"
import { cn } from "cn"

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Label }
