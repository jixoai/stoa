/**
 * 移动端「信息」bottom sheet（design report-ux-r2 §1）。
 *
 * 内容与桌面右栏共用 `WhoPanelContent`（连接信息 + 成员列表），不写第二份；
 * 官方 shadcn Sheet 收编件负责遮罩/焦点/关闭，本文件只做业务接线与下拉关闭手势。
 */
import { useRef, useState, type PointerEvent } from "react";
import { cn } from "cn";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { WhoPanelContent } from "@/components/WhoPanel";

interface InfoSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const CLOSE_DISTANCE = 88;

export function InfoSheet({ open, onOpenChange }: InfoSheetProps) {
  const dragStart = useRef<number | null>(null);
  const [dragY, setDragY] = useState(0);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    dragStart.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragStart.current === null) return;
    setDragY(Math.max(0, event.clientY - dragStart.current));
  };

  const endDrag = () => {
    if (dragStart.current === null) return;
    dragStart.current = null;
    if (dragY > CLOSE_DISTANCE) onOpenChange(false);
    setDragY(0);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        data-testid="info-sheet"
        className="max-h-[85dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom)] xl:hidden"
        style={dragY > 0 ? { transform: `translateY(${dragY}px)` } : undefined}
      >
        <div
          className="shrink-0 touch-none select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          aria-hidden
        >
          <div className="flex justify-center pt-2.5">
            <span className={cn("h-1 w-10 rounded-full bg-muted-foreground/30")} />
          </div>
        </div>
        <SheetHeader className="pb-0 pt-2">
          <SheetTitle>信息</SheetTitle>
          <SheetDescription>实例连接与成员列表；点成员进入成员页。</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <WhoPanelContent className="pt-1" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
