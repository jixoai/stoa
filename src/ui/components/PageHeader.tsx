/**
 * 应用级吸顶顶栏（design §3.3）：标题居中、左侧返回、右侧来源/动作、
 * 底部 1px 细分割线；根页可在第二行放 tabs。
 */
import type { ReactNode } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "cn";

export interface PageHeaderProps {
  title: ReactNode;
  back?: boolean;
  onBack?: () => void;
  backTestId?: string;
  source?: ReactNode;
  sourceTestId?: string;
  actions?: ReactNode;
  /** 移动端左侧品牌位（提供时窄屏隐藏标题——tabs 即标题，design report-ux-r2 §1）。 */
  mobileBrand?: ReactNode;
  /** 移动端右侧动作（如「信息」按钮），桌面不显示。 */
  mobileActions?: ReactNode;
  /** 第二行内容（主页 feed tabs 等）。 */
  children?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  back = false,
  onBack,
  backTestId,
  source,
  sourceTestId,
  actions,
  mobileBrand,
  mobileActions,
  children,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "sticky top-0 z-30 shrink-0 border-b border-border/60 bg-background/80 backdrop-blur-md",
        className,
      )}
    >
      <div className="relative flex h-12 items-center justify-center px-2">
        {back ? (
          <Button
            variant="ghost"
            size="icon"
            className="absolute left-1 size-11"
            onClick={onBack}
            aria-label="返回"
            data-testid={backTestId}
          >
            <ArrowLeftIcon />
          </Button>
        ) : null}
        {mobileBrand ? (
          <div className="absolute left-2 flex items-center gap-2 xl:hidden">{mobileBrand}</div>
        ) : null}
        <h1
          className={cn(
            "max-w-[58%] truncate px-2 text-center text-base font-semibold",
            mobileBrand && "hidden xl:block",
          )}
        >
          {title}
        </h1>
        {source ? (
          <span
            className="absolute right-2 max-w-[36%] truncate text-[11px] text-muted-foreground"
            data-testid={sourceTestId}
          >
            {source}
          </span>
        ) : null}
        {actions ? (
          <div className="absolute right-1 flex items-center gap-1">{actions}</div>
        ) : null}
        {mobileActions ? (
          <div className="absolute right-1 flex items-center gap-1 xl:hidden">{mobileActions}</div>
        ) : null}
      </div>
      {children ? <div className="flex justify-center px-2 pb-2">{children}</div> : null}
    </header>
  );
}
