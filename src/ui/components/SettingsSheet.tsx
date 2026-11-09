/**
 * 设置页（report-link-preview P1-19）：插件开关、worker 摘要、依赖与隐私说明。
 *
 * - 入口：桌面账号 Dropdown / 移动账号抽屉；`SettingsSheetProvider` 在 AppShell
 *   只挂一份 Sheet（两个入口打开同一实例）。
 * - 仅 owner/manager 可改；agent 只读；静态归档只读且 0 `/api/plugins` 请求
 *   （开关状态取快照 `preview_enabled` 的投影）。
 * - 每次打开都 `refresh()`：补上关闭期间漏掉的 `plugin.updated` 控制帧。
 * - Switch 为官方 base-nova registry 收编件。
 */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useConnection } from "@/state/connection";
import { goBack, navigate, useRoute } from "@/lib/router";
import { usePlugins } from "@/state/plugins";
import { LINK_PREVIEW_PLUGIN_ID } from "@/lib/link-preview";
import { staticLinkPreviewPlugin } from "@/lib/plugin-state";
import type { PluginView } from "@core/plugins/types";
import { LockIcon, ShieldAlertIcon } from "lucide-react";

function workerLastError(plugin: PluginView | null): string | null {
  const worker = plugin?.worker;
  if (!worker) return null;
  const value = (worker as unknown as Record<string, unknown>).last_error;
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface SettingsSheetContextValue {
  open: () => void;
}

const SettingsSheetContext = createContext<SettingsSheetContextValue | null>(null);

export function useSettingsSheet(): SettingsSheetContextValue {
  const value = useContext(SettingsSheetContext);
  if (!value) throw new Error("useSettingsSheet must be used inside SettingsSheetProvider");
  return value;
}

function DependencyBadge({
  status,
}: {
  status: "enabled" | "disabled" | "missing";
}) {
  const label = status === "enabled" ? "已启用" : status === "disabled" ? "未启用" : "未安装";
  return (
    <Badge variant={status === "enabled" ? "secondary" : "outline"} className="h-5 px-1.5 text-[10px]">
      {label}
    </Badge>
  );
}

function SettingsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { account, staticMode } = useConnection();
  const { plugins, loading, error, refresh, setEnabled, enabled } = usePlugins();
  const [pending, setPending] = useState(false);
  const staticEnabled = enabled(LINK_PREVIEW_PLUGIN_ID);
  const plugin =
    plugins.find((row) => row.id === LINK_PREVIEW_PLUGIN_ID) ??
    (staticMode ? staticLinkPreviewPlugin(staticEnabled) : null);
  const canManage =
    !staticMode && (account?.role === "owner" || account?.role === "manager");
  const lastError = workerLastError(plugin);

  // 打开设置时兜底重取：漏帧/断线期间别的标签页可能已改过开关。
  useEffect(() => {
    if (!open || staticMode) return;
    void refresh();
  }, [open, staticMode, refresh]);

  const toggle = async (next: boolean) => {
    if (!plugin || pending || !canManage) return;
    setPending(true);
    try {
      await setEnabled(plugin.id, next);
    } finally {
      setPending(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" data-testid="settings-sheet" className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="pb-2 pt-4">
          <SheetTitle>设置</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6">
          <section className="mt-2 rounded-xl ring-1 ring-foreground/10" data-testid="plugin-settings">
            <div className="flex items-start justify-between gap-3 p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">
                    {plugin?.name ?? "链接预览"}
                  </span>
                  <code className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                    {plugin?.id ?? LINK_PREVIEW_PLUGIN_ID}
                  </code>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {plugin?.description ??
                    "识别帖文中的链接并在后台抓取标题、描述与封面（图片裁剪为后续能力）。"}
                </p>
                <div
                  data-testid="plugin-meta"
                  className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground"
                >
                  <span>version {staticMode ? "快照" : plugin?.version ?? "—"}</span>
                  <span>rules {staticMode ? "—" : plugin?.rules_version ?? "—"}</span>
                  {plugin?.limits ? (
                    <span>
                      每帖 {plugin.limits.previews_per_post} 条 / URL ≤{" "}
                      {plugin.limits.url_max_chars} 字符
                    </span>
                  ) : null}
                </div>
              </div>
              {plugin ? (
                <Switch
                  data-testid="plugin-toggle"
                  aria-label="启用链接预览插件"
                  checked={plugin.enabled}
                  disabled={!canManage || pending}
                  onCheckedChange={(checked) => void toggle(checked)}
                />
              ) : loading ? (
                <Skeleton className="h-5 w-8" />
              ) : null}
            </div>
            {plugin?.worker ? (
              <div
                data-testid="plugin-worker-status"
                className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground"
              >
                <span>排队 {plugin.worker.queued}</span>
                <span>处理中 {plugin.worker.running}</span>
                <span>已就绪 {plugin.worker.ready}</span>
                <span>部分 {plugin.worker.partial}</span>
                <span>失败 {plugin.worker.failed}</span>
                {lastError ? (
                  <span
                    data-testid="plugin-worker-error"
                    className="w-full break-all text-destructive"
                  >
                    最近错误：{lastError}
                  </span>
                ) : null}
              </div>
            ) : null}
          </section>

          {plugin && plugin.requires.length > 0 ? (
            <section className="mt-4" data-testid="plugin-dependencies">
              <h3 className="text-xs font-medium text-muted-foreground">依赖</h3>
              <ul className="mt-2 flex flex-col gap-2">
                {plugin.requires.map((dep) => (
                  <li key={dep.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">
                      {dep.id}
                      {dep.optional ? (
                        <span className="ml-1 text-[11px] text-muted-foreground">（可选）</span>
                      ) : null}
                    </span>
                    <DependencyBadge status={dep.status} />
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-muted-foreground">
                file-viewer 未安装/未启用时，点击预览卡直接在新窗口打开原链接。
              </p>
            </section>
          ) : null}

          <Alert className="mt-4" data-testid="plugin-privacy">
            <ShieldAlertIcon />
            <AlertTitle>隐私与行为说明</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-4">
                <li>预览由服务器出站抓取，目标站点可见服务器 IP；不携带你的 Cookie/Authorization。</li>
                <li>不执行目标页脚本、不加载页面子资源；只保存标题/描述/站点名/封面等元数据。</li>
                <li>预览字段会被后台按阶段多次更新（先标题/描述，后封面）；前端实时更新。</li>
                <li>静态导出是导出时刻的快照；归档中的卡片完全离线，不再抓取。</li>
              </ul>
            </AlertDescription>
          </Alert>

          {staticMode ? (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="plugin-readonly">
              <LockIcon className="size-3.5" /> 静态归档 · 只读：插件状态来自导出快照。
            </p>
          ) : !canManage ? (
            <p className="mt-3 text-xs text-muted-foreground" data-testid="plugin-readonly">
              仅 owner/manager 可以修改插件开关（当前身份只读）。
            </p>
          ) : null}

          {error ? (
            <div className="mt-3 flex items-center gap-2 text-xs text-destructive" data-testid="plugin-error">
              <span className="min-w-0 flex-1 break-all">{error}</span>
              <Button size="sm" variant="outline" onClick={() => void refresh()}>
                重试
              </Button>
            </div>
          ) : null}
          {loading && !plugin ? <Skeleton className="mt-3 h-9 w-full" /> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function SettingsSheetProvider({ children }: { children: ReactNode }) {
  const route = useRoute();
  const open = route.name === "settings";
  const closing = useRef(false);
  useEffect(() => {
    closing.current = false;
  }, [route.name]);
  return (
    <SettingsSheetContext.Provider value={{ open: () => navigate("/settings") }}>
      {children}
      <SettingsSheet
        open={open}
        onOpenChange={(next) => {
          if (next || !open || closing.current) return;
          closing.current = true;
          goBack();
        }}
      />
    </SettingsSheetContext.Provider>
  );
}
