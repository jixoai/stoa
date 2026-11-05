/*
 * shadcn/ui 官方 registry 一手源（style=base-nova，2026-11-05 经
 * https://ui.shadcn.com/r/styles/base-nova/input.json 取回）。
 * 逐字收编；机械适配点（与 AGENTS.md 收编纪律一致）：
 * registry 生成器占位 IconPlaceholder → lucide-react 单色图标（保留原 className/props）、
 * registry 内部 import 路径 @/registry/base-nova/ui → 本仓 @/components/ui。
 * 升级对照：重取 registry JSON diff 本文件。
 */
import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cn } from "cn"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
