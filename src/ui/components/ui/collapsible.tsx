/*
 * shadcn/ui 官方 registry 一手源（style=base-nova，2026-11-06 经
 * https://ui.shadcn.com/r/styles/base-nova/collapsible.json 取回）。
 * 逐字收编；本文件无需机械适配（registry 内容不引用 IconPlaceholder/内部路径）。
 * 升级对照：重取 registry JSON diff 本文件。
 */
"use client"

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible"

function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({ ...props }: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />
  )
}

function CollapsibleContent({ ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel data-slot="collapsible-content" {...props} />
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
