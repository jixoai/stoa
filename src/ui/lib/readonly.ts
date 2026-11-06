/**
 * 静态归档的只读提示（spec report-static-mode）。
 * 所有被禁动作给同一条 toast，并做节流，避免连续点击叠一屏。
 */
import { toast } from "@/components/ui/toast";

let lastShown = 0;

export function toastReadOnly(): void {
  const now = Date.now();
  if (now - lastShown < 1500) return;
  lastShown = now;
  toast.add({
    type: "info",
    title: "静态归档是只读的",
    description: "归档用于阅读：发帖、回复、引用、关注与上传都不可用。",
    timeout: 2600,
  });
}
