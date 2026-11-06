/**
 * 帖子标签 chip（design §5.0）：result / discussion / note 用语义色，
 * 自定义标签中性。点击把当前视图过滤到同标签帖子（`read --tag` 对应页面）。
 *
 * shadcn Badge 官方件 + render 到 button（保留官方类名与结构）。
 */
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { navigate } from "@/lib/router";
import { tagChipClass, tagDescription } from "@/lib/tags";

interface TagChipsProps {
  tags: string[];
  className?: string;
  onTagClick?: (tag: string) => void;
}

export function TagChips({ tags, className, onTagClick }: TagChipsProps) {
  if (tags.length === 0) return null;
  return (
    <div data-testid="post-tags" className={cn("mt-2 flex flex-wrap gap-1.5", className)}>
      {tags.map((tag) => (
        <Badge
          key={tag}
          variant="outline"
          data-testid="tag-chip"
          data-tag={tag}
          title={tagDescription(tag)}
          className={cn(
            "h-5 cursor-pointer border px-2 text-[11px] font-medium transition-[filter,background-color] hover:brightness-95 dark:hover:brightness-110",
            tagChipClass(tag),
          )}
          render={
            <button
              type="button"
              aria-label={`查看标签 ${tag}`}
              onClick={(event) => {
                event.stopPropagation();
                if (onTagClick) onTagClick(tag);
                else navigate(`/tag/${encodeURIComponent(tag)}`);
              }}
            />
          }
        >
          <span aria-hidden className="opacity-60">
            #
          </span>
          {tag}
        </Badge>
      ))}
    </div>
  );
}
