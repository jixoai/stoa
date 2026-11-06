/**
 * 发帖箱的标签选择器（design §5.0）：三个语义标签一键切换 + 自定义 slug 输入。
 * 校验与后端一致：[a-z0-9-]{1,24}，最多 8 个，去重。
 */
import { useState, type KeyboardEvent } from "react";
import { cn } from "cn";
import { CheckIcon, PlusIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MAX_TAGS,
  SEMANTIC_TAGS,
  isSemanticTag,
  normalizeTagInput,
  tagChipClass,
  tagDescription,
} from "@/lib/tags";

interface TagPickerProps {
  value: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}

export function TagPicker({ value, onChange, disabled = false }: TagPickerProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const toggle = (tag: string) => {
    if (disabled) return;
    setError(null);
    if (value.includes(tag)) {
      onChange(value.filter((entry) => entry !== tag));
      return;
    }
    if (value.length >= MAX_TAGS) {
      setError(`最多 ${MAX_TAGS} 个标签`);
      return;
    }
    onChange([...value, tag]);
  };

  const addCustom = () => {
    if (disabled || !draft.trim()) return;
    const tag = normalizeTagInput(draft);
    if (!tag) {
      setError("标签只能用 a-z、0-9、-（1–24 字符）");
      return;
    }
    if (value.includes(tag)) {
      setDraft("");
      setError(null);
      return;
    }
    if (value.length >= MAX_TAGS) {
      setError(`最多 ${MAX_TAGS} 个标签`);
      return;
    }
    onChange([...value, tag]);
    setDraft("");
    setError(null);
  };

  const onDraftKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === "," || event.key === "，") {
      event.preventDefault();
      addCustom();
      return;
    }
    if (event.key === "Backspace" && draft === "" && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div
      data-testid="tag-picker"
      className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border/60 bg-muted/20 px-2 py-1.5"
    >
      <span className="mr-0.5 text-[11px] font-medium text-muted-foreground">标签</span>

      {SEMANTIC_TAGS.map((tag) => {
        const active = value.includes(tag);
        return (
          <Button
            key={tag}
            type="button"
            size="xs"
            variant="outline"
            aria-pressed={active}
            data-testid={`tag-option-${tag}`}
            title={tagDescription(tag)}
            className={cn("h-6 rounded-full border px-2 text-[11px]", tagChipClass(tag, active))}
            disabled={disabled}
            onClick={() => toggle(tag)}
          >
            {active ? (
              <CheckIcon data-icon="inline-start" />
            ) : (
              <span aria-hidden className="opacity-60">
                #
              </span>
            )}
            {tag}
          </Button>
        );
      })}

      {value
        .filter((tag) => !isSemanticTag(tag))
        .map((tag) => (
          <Badge
            key={tag}
            variant="outline"
            data-testid="tag-picker-custom"
            className="h-6 gap-0.5 border-border/70 bg-muted/40 pl-2 pr-0.5 text-[11px] text-muted-foreground"
          >
            <span aria-hidden className="opacity-60">
              #
            </span>
            {tag}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`移除标签 ${tag}`}
              className="text-muted-foreground hover:text-foreground"
              disabled={disabled}
              onClick={() => toggle(tag)}
            >
              <XIcon />
            </Button>
          </Badge>
        ))}

      <div className="flex items-center gap-0.5">
        <Input
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onDraftKeyDown}
          placeholder="自定义 slug"
          aria-label="自定义标签"
          data-testid="tag-input"
          maxLength={24}
          disabled={disabled}
          className="h-6 w-28 rounded-full px-2 text-[11px]"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="添加标签"
          title="添加标签（Enter）"
          disabled={disabled || !draft.trim()}
          onClick={addCustom}
        >
          <PlusIcon />
        </Button>
      </div>

      {error ? (
        <span className="text-[11px] text-destructive" data-testid="tag-error">
          {error}
        </span>
      ) : null}
      <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
        {value.length}/{MAX_TAGS}
      </span>
    </div>
  );
}
