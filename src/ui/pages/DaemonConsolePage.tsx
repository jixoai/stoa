/**
 * daemon-webui（stoa-daemon design §4；stoa-session-ux design §4/§5；
 * stoa-daemon-console-layout design §2–§6）：daemon 进程在 `/` 注入的
 * `window.__STOA_DAEMON__` 是渲染开关——有它时渲染本控制台，没有时渲染公示板壳（App）。
 * 数据全部走同源 `/api/daemon/*`；组件只用官方收编件。
 *
 * 本版重点（Owner 2026-11-10 / 2026-11-11 反馈）：
 *   - 挂载入口 Sheet 化：常驻表单 Card 移除，header 主按钮与空态 CTA 打开同一官方 Sheet；
 *   - 服务列表成为首屏主角：身份+状态 → 入口 → 元信息 → 操作 分层；
 *     「打开」唯一主操作，口令次级，停止/移除收进菜单 + 二次确认；
 *   - stopped 行去饱和（不是整体降透明），不提供失效的「打开」；
 *   - 表单错误就地显示，端口校验错误在重新输入时清除；
 *   - 「打开」与行内入口（本地/公网）点击时按需读取口令并把 `#key=` 附为 fragment
 *     （stoa-console-open-with-key design §2）：从控制台打开服务不再落到登录门。
 *   - 已停止实例可「生成预览」（stoa-stopped-preview design v2 §2）：真 `<a>` 直链 daemon 的
 *     `/preview/<id>/`——静态快照、只读、首开生成后命中缓存；所有 stopped 行都给入口，数据缺失由预览页 404 承接。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  ChevronDownIcon,
  CircleAlertIcon,
  ClockIcon,
  CopyIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  GlobeIcon,
  KeyRoundIcon,
  MapPinIcon,
  MoreHorizontalIcon,
  PlugIcon,
  PlusIcon,
  PowerIcon,
  RefreshCwIcon,
  RotateCwIcon,
  ServerIcon,
  SquareIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster, toast } from "@/components/ui/toast";
import { copyText } from "@/lib/copy";
import { fullTime, timeShort } from "@/lib/format";

export interface DaemonBoot {
  version: string;
  stateDir: string;
  pid: number;
  startedAt: number;
}

export interface DaemonService {
  id: string;
  name: string;
  dataDir: string;
  port: number;
  pid: number | null;
  url: string | null;
  log: string | null;
  startedAt: number;
  status: "running" | "stopped";
  stoppedAt?: number;
  envFiles?: string[] | null;
  ephemeral?: boolean;
  publicUrl?: string | null;
  secretFile?: string | null;
  location?: Location;
}

type Location = "auto" | "temp" | "path";

interface SecretView {
  mode: "auth" | "open" | "unknown";
  key: string | null;
  key_link: string | null;
  source: string | null;
}

type ConfirmTarget =
  | { kind: "stop"; service: DaemonService }
  | { kind: "remove"; service: DaemonService }
  | { kind: "shutdown" };

/** 注入开关（main.tsx 用它决定渲染本页还是公示板壳）。 */
export function readDaemonBoot(): DaemonBoot | null {
  const boot = (window as Window & { __STOA_DAEMON__?: DaemonBoot }).__STOA_DAEMON__;
  return boot && typeof boot === "object" && typeof boot.stateDir === "string" ? boot : null;
}

async function daemonApi<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const record = (typeof body === "object" && body !== null ? body : {}) as {
    ok?: boolean;
    error?: string;
    code?: string;
  };
  if (!res.ok || record.ok === false) {
    throw new Error(record.error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

const POLL_MS = 5000;
const PORT_MIN = 13680;
const PORT_MAX = 13699;
const CLI_HINT = "stoa serve --data-dir <目录>";

const LOCATION_LABEL: Record<Location, string> = {
  auto: "自动",
  temp: "临时目录",
  path: "自定义",
};

const LOCATION_HINT: Record<Location, string> = {
  auto: "建在 ~/.stoa/sessions/：自动初始化并生成口令，长期保留。",
  temp: "系统临时目录：服务停止后整目录删除，适合一次性演示。",
  path: "填一个已有目录（未初始化会自动初始化），或用「选择文件夹」挑一个。",
};

/** 目录尾部两段（`…/sessions/<id>`）——列表里只用尾部区分，全路径放 title。 */
function shortPath(dir: string): string {
  const parts = dir.split("/").filter(Boolean);
  if (parts.length <= 2) return dir;
  return `…/${parts.slice(-2).join("/")}`;
}

/** 口令链接的展示文本：把 key 打码（复制按钮才带完整口令，避免截图/肩窥泄漏）。 */
function redactKeyLink(link: string | null): string {
  if (!link) return "";
  const marker = link.indexOf("#key=");
  if (marker < 0) return link;
  return `${link.slice(0, marker)}#key=••••••`;
}

/** 行内口令链接恒短形态：`口令 ••••••`（6 圆点，永不被列宽截断；全链接只在复制/口令面板）。 */
const KEY_MASK = "••••••";

/** 「打开」/行内入口的目标：local＝service.url，public＝service.publicUrl。 */
type OpenTarget = "local" | "public";

/** 同一行入口的重复点击去抖窗口（连点不连开多标签）。 */
const OPEN_DEBOUNCE_MS = 1000;

/**
 * 把口令附到目标 URL 的 fragment 上（`#key=<口令>`）：
 * fragment 不进服务端请求行/Referer；保留原 path/query（stoa-console-open-with-key design §2）。
 */
function withKeyFragment(base: string, key: string): string {
  try {
    const url = new URL(base);
    url.hash = `#key=${encodeURIComponent(key)}`;
    return url.toString();
  } catch {
    return `${base.replace(/#.*$/, "")}#key=${encodeURIComponent(key)}`;
  }
}

function LocationIcon({ location }: { location?: Location }) {
  const Icon = location === "path" ? MapPinIcon : location === "temp" ? ClockIcon : FolderIcon;
  return <Icon className="size-3.5 shrink-0" aria-hidden="true" />;
}

/** 入口行前的弱化标签（本地/公网/口令）；非交互、非徽标语义，纯文字引导。 */
function EntryTag({ children }: { children: string }) {
  return (
    <span className="w-[34px] shrink-0 rounded-sm border text-center text-[10px] leading-4 text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * 挂载入口 Sheet 的形态：<640px 底部抽屉（max-h 85dvh），≥640px 右侧约 440px。
 * 官方 Sheet 的 side 是 prop，无法用媒体查询切换，这里用 matchMedia 同步。
 */
function useWideSheet(): boolean {
  const [wide, setWide] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 640px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(min-width: 640px)");
    const sync = () => setWide(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return wide;
}

/**
 * 服务行（design §2.3）：身份+状态 → 入口 → 元信息 → 操作。
 * 使用容器查询（≥720px）切四列横排；<720px 纵向堆叠且操作与身份同一行。
 * 导出供 SSR 行渲染测试（test/daemon-console-preview.test.tsx）直接断言行操作。
 */
export function ServiceRow({
  service,
  busy,
  onOpen,
  onSecret,
  onStop,
  onRemove,
  onCopyPath,
}: {
  service: DaemonService;
  busy: boolean;
  onOpen: (service: DaemonService, target: OpenTarget) => void;
  onSecret: (service: DaemonService) => void;
  onStop: (service: DaemonService) => void;
  onRemove: (service: DaemonService) => void;
  onCopyPath: (path: string) => void;
}) {
  const running = service.status === "running";
  const stoppedAt = service.stoppedAt;
  const entryBase = (service.publicUrl ?? service.url ?? "").replace(/\/$/, "");
  const locationLabel = service.location ? LOCATION_LABEL[service.location] : null;
  const timeTitle = `pid ${service.pid ?? "—"} · 启动于 ${fullTime(service.startedAt)}${
    stoppedAt ? ` · 停止于 ${fullTime(stoppedAt)}` : ""
  }`;
  /**
   * 静态预览入口（stoa-stopped-preview design v2 §2）：daemon 同源相对路径的真 `<a>`——
   * 同步导航不受弹窗拦截影响（与「打开」读口令路径不同，预览免口令、免实例运行）。
   * **所有 stopped 行都给入口**（评审 F8）：临时实例干净停止会连 dataDir/登记一起删除、
   * 控制台根本不会出现该行；外部死亡被降级（reconcileServices）的临时行数据仍在、预览本可用。
   * 数据真缺失的罕见情形（手工删目录）由预览页的可读 404 承接，前端不做存在性探测。
   * `service.id` 经 encodeURIComponent（与 daemon 路由的 decode 对称；newServiceId 生成的 id 不变）。
   */
  const previewHref = `/preview/${encodeURIComponent(service.id)}/`;
  const previewTitle = "静态快照 · 只读 · 首次生成后自动缓存";
  const stoppedPreview = !running;

  /**
   * 普通左键走「读口令→附 #key=→打开」；修饰键（Cmd/Ctrl/Shift/Alt）不拦截，
   * 保留浏览器原生「新标签/新窗口」语义（stoa-console-open-with-key design §2）。
   */
  const openOnClick =
    (target: OpenTarget) =>
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
        return;
      }
      event.preventDefault();
      onOpen(service, target);
    };

  return (
    <Card
      size="sm"
      data-status={service.status}
      data-testid={`daemon-service-${service.id}`}
      className="group-data-[refreshing=true]:opacity-60 flex flex-row flex-wrap items-center gap-x-3 gap-y-2.5 rounded-xl p-3.5 transition-[opacity,box-shadow] hover:ring-foreground/20 @min-[720px]:flex-nowrap @min-[720px]:gap-x-5 @min-[720px]:gap-y-0"
    >
      {/* 身份 + 状态 */}
      <div className="order-1 flex min-w-0 flex-1 items-center gap-2 @min-[720px]:order-none @min-[720px]:w-[200px] @min-[720px]:flex-none">
        <span
          className={
            running
              ? "size-2 shrink-0 rounded-full bg-foreground ring-[3px] ring-foreground/10"
              : "size-2 shrink-0 rounded-full bg-muted-foreground"
          }
          aria-hidden="true"
        />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={
                running
                  ? "truncate text-sm font-medium"
                  : "truncate text-sm font-medium text-muted-foreground"
              }
              title={service.name}
            >
              {service.name}
            </span>
            {service.ephemeral ? (
              <span className="shrink-0 rounded-sm border px-1 text-[10px] leading-4 text-muted-foreground">
                会话临时
              </span>
            ) : null}
          </div>
          <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <LocationIcon location={service.location} />
            <span className="truncate">
              {locationLabel ? `${locationLabel} · ` : ""}
              {running ? "运行中" : "已停止"}
            </span>
          </div>
        </div>
      </div>

      {/* 入口 */}
      <div className="order-3 flex w-full min-w-0 flex-col gap-1 @min-[720px]:order-none @min-[720px]:w-auto @min-[720px]:flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <EntryTag>本地</EntryTag>
          {service.url ? (
            running ? (
              <a
                className="truncate font-mono text-xs hover:text-foreground hover:underline"
                href={service.url}
                target="_blank"
                rel="noreferrer"
                title={service.url}
                data-testid={`daemon-entry-local-${service.id}`}
                onClick={openOnClick("local")}
              >
                {service.url}
              </a>
            ) : (
              <span
                className="truncate font-mono text-xs text-muted-foreground line-through decoration-muted-foreground/40"
                title={service.url}
              >
                {service.url}
              </span>
            )
          ) : (
            <span className="truncate font-mono text-xs text-muted-foreground">（无监听地址）</span>
          )}
        </div>
        {service.publicUrl ? (
          <div className="flex min-w-0 items-center gap-2">
            <EntryTag>公网</EntryTag>
            <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            {running ? (
              <a
                className="truncate font-mono text-xs hover:text-foreground hover:underline"
                href={service.publicUrl}
                target="_blank"
                rel="noreferrer"
                title={service.publicUrl}
                data-testid={`daemon-entry-public-${service.id}`}
                onClick={openOnClick("public")}
              >
                {service.publicUrl}
              </a>
            ) : (
              <span
                className="truncate font-mono text-xs text-muted-foreground line-through decoration-muted-foreground/40"
                title={service.publicUrl}
              >
                {service.publicUrl}
              </span>
            )}
          </div>
        ) : null}
        <div className="flex min-w-0 items-center gap-2">
          <EntryTag>口令</EntryTag>
          <Button
            variant="ghost"
            size="sm"
            className="h-auto min-w-0 justify-start gap-1 px-0 py-0 font-mono text-xs font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
            title={
              entryBase ? `口令链接 ${entryBase}/#key=••••••（完整链接在口令面板复制）` : "查看口令"
            }
            onClick={() => onSecret(service)}
          >
            <KeyRoundIcon className="size-3 shrink-0" aria-hidden="true" />
            <span className="whitespace-nowrap">{KEY_MASK}</span>
          </Button>
        </div>
      </div>

      {/* 元信息 */}
      <div className="order-4 flex w-full min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground @min-[720px]:order-none @min-[720px]:w-[230px] @min-[720px]:flex-none">
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <PlugIcon className="size-3.5 shrink-0" aria-hidden="true" />
          端口 <span className="font-mono">{service.port}</span>
        </span>
        <span className="inline-flex items-center gap-1" title={timeTitle}>
          <ClockIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="whitespace-nowrap">
            {timeShort(running ? service.startedAt : (stoppedAt ?? service.startedAt))}
            {running ? " 启动" : " 停止"}
          </span>
        </span>
        <span className="flex w-full min-w-0 items-center gap-1" title={service.dataDir}>
          <FolderIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-mono">{shortPath(service.dataDir)}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="复制目录路径"
            title="复制目录路径"
            onClick={() => onCopyPath(service.dataDir)}
          >
            <CopyIcon />
          </Button>
        </span>
      </div>

      {/* 操作：打开（唯一主操作）→ 口令（次级）→ 菜单（停止/移除） */}
      <div className="order-2 flex shrink-0 items-center justify-end gap-1.5 @min-[720px]:order-none @min-[720px]:ml-auto">
        {running && service.url ? (
          <Button
            render={
              <a
                href={service.url}
                target="_blank"
                rel="noreferrer"
                onClick={openOnClick("local")}
              />
            }
            data-testid={`daemon-open-${service.id}`}
            title={`打开 ${service.url}`}
          >
            <ExternalLinkIcon data-icon="inline-start" />
            打开
          </Button>
        ) : null}
        {stoppedPreview ? (
          <Button
            render={<a href={previewHref} target="_blank" rel="noreferrer" />}
            data-testid={`daemon-preview-${service.id}`}
            title={previewTitle}
          >
            <EyeIcon data-icon="inline-start" />
            生成预览
          </Button>
        ) : null}
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => onSecret(service)}
          data-testid={`daemon-secret-${service.id}`}
        >
          <KeyRoundIcon data-icon="inline-start" />
          口令
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="更多操作"
                disabled={busy}
                data-testid={`daemon-menu-${service.id}`}
              />
            }
          >
            {busy ? <Spinner /> : <MoreHorizontalIcon />}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {running ? (
              <>
                <DropdownMenuItem
                  disabled={busy}
                  onClick={() => onStop(service)}
                  data-testid={`daemon-stop-${service.id}`}
                >
                  <SquareIcon />
                  停止服务
                </DropdownMenuItem>
                {/* 预览同走真 `<a>`（stoa-stopped-preview design v2 §2）；运行中也可快照。 */}
                <DropdownMenuItem
                  render={<a href={previewHref} target="_blank" rel="noreferrer" />}
                  disabled={busy}
                  title={previewTitle}
                  data-testid={`daemon-preview-menu-${service.id}`}
                >
                  <EyeIcon />
                  生成静态预览
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem
              variant="destructive"
              disabled={busy}
              onClick={() => onRemove(service)}
              data-testid={`daemon-remove-${service.id}`}
            >
              <Trash2Icon />
              移除登记
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Card>
  );
}

/** 口令对话框：读取/显示/复制口令与口令链接、重新生成；开放模式可一键设置。 */
function SecretDialog({
  service,
  onClose,
  onChanged,
  onServiceUpdated,
}: {
  service: DaemonService;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onServiceUpdated: (service: DaemonService) => void;
}) {
  const [view, setView] = useState<SecretView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [keyInput, setKeyInput] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const out = await daemonApi<SecretView & { ok: boolean }>(
        `/api/daemon/services/${service.id}/secret`,
      );
      setView({ mode: out.mode, key: out.key, key_link: out.key_link, source: out.source });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [service.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const copy = useCallback(async (text: string, label: string) => {
    const ok = await copyText(text);
    toast.add({
      type: ok ? "success" : "error",
      title: ok ? `已复制${label}` : `复制${label}失败`,
      description: ok ? undefined : "请手动选择文本复制",
      timeout: 2200,
    });
  }, []);

  const rotate = useCallback(async () => {
    if (!confirmRotate) {
      setConfirmRotate(true);
      window.setTimeout(() => setConfirmRotate(false), 4000);
      return;
    }
    setConfirmRotate(false);
    setBusy(true);
    try {
      const out = await daemonApi<{
        key: string;
        key_link: string | null;
        service: DaemonService;
        restarted: boolean;
      }>(`/api/daemon/services/${service.id}/secret`, { method: "PUT", body: { generate: true } });
      setView({ mode: "auth", key: out.key, key_link: out.key_link, source: "daemon" });
      setReveal(true);
      onServiceUpdated(out.service);
      toast.add({
        type: "success",
        title: "口令已重新生成",
        description: out.restarted
          ? "服务已重启以生效；旧口令链接与登录会话已失效。"
          : "旧口令链接与登录会话已失效。",
        timeout: 3600,
      });
      await onChanged();
    } catch (err) {
      toast.add({
        type: "error",
        title: "重新生成失败",
        description: (err as Error).message,
        timeout: 3600,
      });
    } finally {
      setBusy(false);
    }
  }, [confirmRotate, onChanged, onServiceUpdated, service.id]);

  const applyKey = useCallback(async () => {
    if (!keyInput.trim()) {
      toast.add({ type: "error", title: "请先填写口令", timeout: 2200 });
      return;
    }
    setBusy(true);
    try {
      const out = await daemonApi<{
        key: string;
        key_link: string | null;
        service: DaemonService;
        restarted: boolean;
      }>(`/api/daemon/services/${service.id}/secret`, {
        method: "PUT",
        body: { key: keyInput.trim() },
      });
      setView({ mode: "auth", key: out.key, key_link: out.key_link, source: "daemon" });
      setKeyInput("");
      onServiceUpdated(out.service);
      toast.add({
        type: "success",
        title: "口令已设置",
        description: out.restarted ? "服务已重启以生效。" : "已生效；旧 token 已失效。",
        timeout: 3200,
      });
      await onChanged();
    } catch (err) {
      toast.add({
        type: "error",
        title: "设置口令失败",
        description: (err as Error).message,
        timeout: 3600,
      });
    } finally {
      setBusy(false);
    }
  }, [keyInput, onChanged, onServiceUpdated, service.id]);

  const key = view?.key ?? null;
  const link = view?.key_link ?? null;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      {/* 小屏（390）下内容可能高于视口：对话框自身滚动，别让底部按钮点不到。 */}
      <DialogContent
        data-testid="daemon-secret-dialog"
        className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] overflow-y-auto [&>*]:min-w-0"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRoundIcon className="size-4" />
            访问口令
          </DialogTitle>
          <DialogDescription className="break-all">
            {service.name} · {service.publicUrl ?? service.url ?? service.dataDir}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Spinner />
            读取口令…
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>读取失败</AlertTitle>
            <AlertDescription className="break-all">{error}</AlertDescription>
          </Alert>
        ) : view?.mode === "open" ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              当前为开放模式（无口令）——本机任何进程都可以直接读写这块板。建议设置口令。
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="daemon-secret-set">设置口令（6–128 字符）</Label>
              <Input
                id="daemon-secret-set"
                value={keyInput}
                onChange={(event) => setKeyInput(event.target.value)}
                placeholder="或点右侧「生成并设置」"
                data-testid="daemon-secret-input"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => void applyKey()} data-testid="daemon-secret-apply">
                {busy ? <Spinner /> : <KeyRoundIcon />}
                设置
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void rotate()}
                data-testid="daemon-secret-generate"
              >
                <RotateCwIcon />
                生成并设置
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {view?.mode === "unknown" ? (
              <p className="text-sm text-muted-foreground">服务当前不可达，以下口令来自数据目录记录。</p>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="daemon-secret-value">口令</Label>
              <div className="flex min-w-0 gap-2">
                <Input
                  id="daemon-secret-value"
                  readOnly
                  type={reveal ? "text" : "password"}
                  value={key ?? ""}
                  placeholder={
                    key
                      ? ""
                      : view?.source === "external-env"
                        ? "由外部 env 文件提供，控制台无法读取"
                        : "（未找到口令）"
                  }
                  className="min-w-0 flex-1 font-mono"
                  data-testid="daemon-secret-value"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={reveal ? "隐藏口令" : "显示口令"}
                  aria-pressed={reveal}
                  disabled={!key}
                  onClick={() => setReveal((value) => !value)}
                  data-testid="daemon-secret-reveal"
                >
                  {reveal ? <EyeOffIcon /> : <EyeIcon />}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="复制口令"
                  disabled={!key}
                  onClick={() => void copy(key ?? "", "口令")}
                  data-testid="daemon-secret-copy"
                >
                  <CopyIcon />
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="daemon-secret-link">口令链接（# fragment，不经过服务端日志）</Label>
              <div className="flex min-w-0 gap-2">
                <Input
                  id="daemon-secret-link"
                  readOnly
                  value={redactKeyLink(link)}
                  placeholder={key ? "构造中…" : "需要口令才能生成链接"}
                  className="min-w-0 flex-1 font-mono text-xs"
                  data-testid="daemon-secret-link"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="复制口令链接"
                  disabled={!link}
                  onClick={() => void copy(link ?? "", "口令链接")}
                  data-testid="daemon-secret-copy-link"
                >
                  <CopyIcon />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                展示已打码；「复制链接」带完整口令，打开即自动登录。
              </p>
            </div>
            <Separator />
            <div className="flex min-w-0 flex-col gap-2">
              <Button
                variant={confirmRotate ? "destructive" : "outline"}
                disabled={busy}
                onClick={() => void rotate()}
                data-testid="daemon-secret-rotate"
              >
                {busy ? <Spinner /> : <RotateCwIcon />}
                {confirmRotate ? "确认重新生成（旧链接失效）" : "重新生成口令"}
              </Button>
              {view?.source && view.source !== "daemon" ? (
                <p className="truncate text-xs text-muted-foreground" title={view.source}>
                  来源：{view.source}
                </p>
              ) : null}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="daemon-secret-close">
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DaemonConsolePage({ boot }: { boot: DaemonBoot }) {
  const [services, setServices] = useState<DaemonService[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState(() => Date.now());
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [daemonDown, setDaemonDown] = useState(false);
  const [secretFor, setSecretFor] = useState<DaemonService | null>(null);
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);

  const [mountOpen, setMountOpen] = useState(false);
  const [location, setLocation] = useState<Location>("auto");
  const [dataDir, setDataDir] = useState("");
  const [port, setPort] = useState("");
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [revealKey, setRevealKey] = useState(false);
  const [picking, setPicking] = useState(false);
  const [canPick, setCanPick] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);
  const [portError, setPortError] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const mounted = useRef(true);
  /** daemon 已知退出（shutdown 成功）后停止轮询，避免每 5s 的无谓失败请求与 console 噪声。 */
  const daemonDownRef = useRef(false);
  const mountTriggerRef = useRef<HTMLElement | null>(null);
  const wideSheet = useWideSheet();

  const refresh = useCallback(async (silent: boolean) => {
    if (!silent) setRefreshing(true);
    try {
      const out = await daemonApi<{ services: DaemonService[] }>("/api/daemon/services");
      // daemon 已关闭后到达的响应一律丢弃：关闭前发出的 5s 轮询可能晚到，
      // 旧数据会把已降级的 stopped 行回填成 running（并复活失效的「打开」）。
      if (!mounted.current || daemonDownRef.current) return;
      setServices(out.services);
      setLoadError(null);
      setLastRefreshAt(Date.now());
    } catch (err) {
      if (!mounted.current || daemonDownRef.current) return;
      setLoadError((err as Error).message);
    } finally {
      if (!mounted.current) return;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh(false);
    void daemonApi<{ capabilities?: { pickDirectory?: boolean } }>("/api/daemon/info")
      .then((info) => {
        if (mounted.current) setCanPick(info.capabilities?.pickDirectory !== false);
      })
      .catch(() => undefined);
    const timer = setInterval(() => {
      if (daemonDownRef.current) return;
      void refresh(true);
    }, POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  // 「上次刷新 Ns 前」的时钟（5s 轮询只刷新文本，不打断操作）。
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const runningCount = useMemo(
    () => services.filter((service) => service.status === "running").length,
    [services],
  );
  const stoppedCount = services.length - runningCount;
  const refreshSeconds = Math.max(0, Math.round((nowTick - lastRefreshAt) / 1000));
  /** 空态时 header 的「添加服务」降级为 ghost，让空态卡内 CTA 成为唯一实心主按钮。 */
  const emptyState = !loading && !loadError && !daemonDown && services.length === 0;
  /** 列表不可用（daemon 已停/首屏加载失败且无在册数据）时，挂载入口必然失败，直接禁用。 */
  const mountDisabled = daemonDown || (Boolean(loadError) && services.length === 0);
  const mountDisabledReason = daemonDown
    ? "daemon 未运行：先重新执行 stoa serve"
    : "服务列表加载失败：请先重试";

  const copy = useCallback(async (text: string, label: string) => {
    const ok = await copyText(text);
    toast.add({
      type: ok ? "success" : "error",
      title: ok ? `已复制${label}` : `复制${label}失败`,
      description: ok ? undefined : "请手动选择文本复制",
      timeout: 2200,
    });
  }, []);

  /** 每行最近一次「打开」的时刻（去抖：连点不连开多标签）。 */
  const openClickAt = useRef(new Map<string, number>());

  /**
   * 从控制台打开服务（stoa-console-open-with-key design §2）：
   * 点击时按需读取口令 → `#key=<口令>` 附为 fragment → 新标签打开。
   * 开放模式/无口令/读取失败一律退回不带 key 的原 URL，并给出可见提示（不阻断）。
   */
  const openWithKey = useCallback(async (service: DaemonService, target: OpenTarget) => {
    const base = ((target === "public" ? service.publicUrl : service.url) ?? "").trim();
    if (!base) return;
    const now = Date.now();
    if (now - (openClickAt.current.get(service.id) ?? 0) < OPEN_DEBOUNCE_MS) return;
    openClickAt.current.set(service.id, now);

    let url = base;
    let note: string | null = null;
    try {
      const out = await daemonApi<SecretView & { ok: boolean }>(
        `/api/daemon/services/${service.id}/secret`,
      );
      const secret = (out.key ?? "").trim();
      if (out.mode === "auth" && secret) {
        url = withKeyFragment(base, secret);
      } else {
        note = out.mode === "open" ? "该服务为开放模式（无口令）。" : "未找到该服务的口令。";
      }
    } catch (err) {
      note = `口令读取失败（${(err as Error).message}）。`;
    }

    // 规范：features 含 noopener 的 window.open 恒返回 null，无法区分「被拦截」。
    // 这里普通打开后立即断开 opener（同等安全），保留可检测的返回值。
    const opened = window.open(url, "_blank");
    if (opened) opened.opener = null;
    if (!opened) {
      toast.add({
        type: "error",
        title: "新标签被浏览器拦截",
        description: "请在「口令」面板复制口令链接后手动打开。",
        timeout: 4200,
      });
      return;
    }
    if (note) {
      toast.add({
        type: "warning",
        title: "已打开（未附带口令）",
        description: note,
        timeout: 3600,
      });
    }
  }, []);

  const resetMountForm = useCallback(() => {
    setLocation("auto");
    setDataDir("");
    setPort("");
    setName("");
    setKey("");
    setRevealKey(false);
    setDirError(null);
    setPortError(null);
    setGlobalError(null);
  }, []);

  const openMount = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      mountTriggerRef.current = event.currentTarget;
      resetMountForm();
      setMountOpen(true);
    },
    [resetMountForm],
  );

  /** 关闭面板并重置表单（不处理焦点，供成功挂载路径先关面板再刷新列表）。 */
  const dismissMount = useCallback(() => {
    setMountOpen(false);
    resetMountForm();
  }, [resetMountForm]);

  const closeMount = useCallback(() => {
    dismissMount();
    const trigger = mountTriggerRef.current;
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
      // 触发钮若已随空态卸载，退回 header 主入口。
      else document.querySelector<HTMLElement>('[data-testid="daemon-mount-open"]')?.focus();
    });
  }, [dismissMount]);

  /** 挂载成功后的焦点：触发钮仍在→回它；空态 CTA 已卸载→新行「打开」，再退 header。 */
  const focusMountResult = useCallback((serviceId: string) => {
    window.requestAnimationFrame(() => {
      const trigger = mountTriggerRef.current;
      if (trigger?.isConnected) {
        trigger.focus();
        return;
      }
      const rowOpen = document.querySelector<HTMLElement>(
        `[data-testid="daemon-open-${serviceId}"]`,
      );
      (rowOpen ?? document.querySelector<HTMLElement>('[data-testid="daemon-mount-open"]'))?.focus();
    });
  }, []);

  const onMount = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const path = dataDir.trim();
      let nextDirError: string | null = null;
      let nextPortError: string | null = null;
      if (location === "path" && !path) {
        nextDirError = "自定义位置需要填目录路径（可用「选择文件夹」）。";
      }
      let portValue: number | null = null;
      if (port.trim() !== "") {
        const parsed = Number(port.trim());
        if (!/^\d+$/.test(port.trim()) || !Number.isInteger(parsed) || parsed < PORT_MIN || parsed > PORT_MAX) {
          nextPortError = `端口需为 ${PORT_MIN}–${PORT_MAX} 的整数（留空自动分配）。`;
        } else {
          portValue = parsed;
        }
      }
      setDirError(nextDirError);
      setPortError(nextPortError);
      if (nextDirError || nextPortError) return;

      setGlobalError(null);
      setSubmitting(true);
      try {
        const out = await daemonApi<{ service: DaemonService; warnings?: string[] }>(
          "/api/daemon/services",
          {
            method: "POST",
            body: {
              location,
              dataDir: location === "path" ? path : null,
              port: portValue,
              name: name.trim() || null,
              key: key.trim() || null,
            },
          },
        );
        toast.add({
          type: "success",
          title: "已挂载",
          description: out.service.url ?? out.service.dataDir,
          timeout: 2400,
        });
        for (const warning of out.warnings ?? []) {
          toast.add({ type: "warning", title: "提示", description: warning, timeout: 4200 });
        }
        dismissMount();
        await refresh(true);
        focusMountResult(out.service.id);
      } catch (err) {
        setGlobalError((err as Error).message);
      } finally {
        setSubmitting(false);
      }
    },
    [dataDir, dismissMount, focusMountResult, key, location, name, port, refresh],
  );

  const pickDirectory = useCallback(async () => {
    setPicking(true);
    try {
      const out = await daemonApi<{ ok: boolean; path: string | null; error?: string }>(
        "/api/daemon/pick-directory",
        { method: "POST" },
      );
      if (out.error) {
        toast.add({ type: "error", title: "无法打开目录选择器", description: out.error, timeout: 4200 });
      } else if (out.path) {
        setDataDir(out.path);
        setDirError(null);
      }
    } catch (err) {
      toast.add({ type: "error", title: "目录选择失败", description: (err as Error).message, timeout: 4200 });
    } finally {
      setPicking(false);
    }
  }, []);

  const onStop = useCallback(
    async (service: DaemonService) => {
      setBusyId(service.id);
      try {
        await daemonApi(`/api/daemon/services/${service.id}/stop`, { method: "POST" });
        toast.add({ type: "success", title: "已停止", description: service.name, timeout: 2400 });
      } catch (err) {
        toast.add({
          type: "error",
          title: "停止失败",
          description: (err as Error).message,
          timeout: 3600,
        });
      } finally {
        setBusyId(null);
        await refresh(true);
      }
    },
    [refresh],
  );

  const onRemove = useCallback(
    async (service: DaemonService) => {
      setBusyId(service.id);
      try {
        await daemonApi(`/api/daemon/services/${service.id}`, { method: "DELETE" });
        toast.add({ type: "success", title: "已移除登记", description: service.name, timeout: 2400 });
      } catch (err) {
        toast.add({
          type: "error",
          title: "移除失败",
          description: (err as Error).message,
          timeout: 3600,
        });
      } finally {
        setBusyId(null);
        await refresh(true);
      }
    },
    [refresh],
  );

  const onShutdown = useCallback(async () => {
    try {
      await daemonApi("/api/daemon/shutdown", { method: "POST" });
      toast.add({
        type: "success",
        title: "daemon 正在退出",
        description: "挂载的服务会一并停止；此页面随后失联属正常。",
        timeout: 4000,
      });
      // 概览即时降级：daemon 已停止 + 在册服务全置 stopped（进程随后消失，轮询停表）。
      daemonDownRef.current = true;
      setDaemonDown(true);
      setServices((prev) =>
        prev.map((service) =>
          service.status === "running"
            ? { ...service, status: "stopped" as const, stoppedAt: Date.now(), pid: null }
            : service,
        ),
      );
    } catch (err) {
      toast.add({
        type: "error",
        title: "关闭失败",
        description: (err as Error).message,
        timeout: 3600,
      });
    }
  }, []);

  const runConfirm = useCallback(async () => {
    const target = confirm;
    setConfirm(null);
    if (!target) return;
    if (target.kind === "shutdown") {
      await onShutdown();
      return;
    }
    if (target.kind === "stop") await onStop(target.service);
    else await onRemove(target.service);
  }, [confirm, onRemove, onShutdown, onStop]);

  const confirmCopy =
    confirm?.kind === "stop"
      ? {
          title: "停止服务？",
          description: `停止「${confirm.service.name}」后该服务将不可访问；登记与口令仍保留，可随时重新挂载。`,
          action: "停止服务",
          testid: "daemon-stop-confirm",
        }
      : confirm?.kind === "remove"
        ? {
            title: "移除登记？",
            description: `移除「${confirm.service.name}」的登记不会删除数据目录；之后可用 CLI 或本面板重新挂载。`,
            action: "移除登记",
            testid: "daemon-remove-confirm",
          }
        : confirm?.kind === "shutdown"
          ? {
              title: "关闭 daemon？",
              description:
                "挂载中的服务会被一并停止（登记保留），daemon 进程退出。之后重新执行 stoa serve 后再打开本页。",
              action: "关闭",
              testid: "daemon-shutdown-confirm",
            }
          : null;

  const formBusy = submitting || picking;

  return (
    <Toaster>
      <div className="h-dvh overflow-y-auto overscroll-contain bg-background text-foreground">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-5 sm:px-6 lg:py-8">
          <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div
              className="flex min-w-0 items-center gap-2.5"
              title={`pid ${boot.pid} · 启动于 ${fullTime(boot.startedAt)}`}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-card text-muted-foreground ring-1 ring-foreground/10">
                <ServerIcon className="size-4" aria-hidden="true" />
              </span>
              <h1 className="truncate text-base font-semibold">Stoa Daemon</h1>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">v{boot.version}</span>
            </div>
            <div className="order-3 flex w-full items-center gap-3 text-xs text-muted-foreground sm:order-none sm:w-auto">
              {daemonDown ? (
                <span className="inline-flex items-center gap-1.5" data-testid="daemon-stopped-overview">
                  <span className="size-2 shrink-0 rounded-full bg-muted-foreground" aria-hidden="true" />
                  daemon 已停止
                </span>
              ) : (
                <>
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="size-2 shrink-0 rounded-full bg-foreground ring-[3px] ring-foreground/10"
                      aria-hidden="true"
                    />
                    {runningCount} 运行中
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 shrink-0 rounded-full bg-muted-foreground" aria-hidden="true" />
                    {stoppedCount} 已停止
                  </span>
                </>
              )}
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              <span
                className="hidden text-right text-xs text-muted-foreground md:inline-block md:w-[104px]"
                aria-live="polite"
              >
                {refreshing ? "刷新中…" : `上次刷新 ${refreshSeconds}s 前`}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="刷新"
                title="刷新"
                disabled={refreshing}
                onClick={() => void refresh(false)}
                data-testid="daemon-refresh"
              >
                {refreshing ? <Spinner /> : <RefreshCwIcon />}
              </Button>
              <Button
                variant={emptyState ? "ghost" : "default"}
                disabled={mountDisabled}
                title={mountDisabled ? mountDisabledReason : undefined}
                onClick={openMount}
                data-testid="daemon-mount-open"
              >
                <PlusIcon data-icon="inline-start" />
                添加服务
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="更多操作"
                      data-testid="daemon-shutdown-open"
                    />
                  }
                >
                  <MoreHorizontalIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setConfirm({ kind: "shutdown" })}
                  >
                    <PowerIcon />
                    关闭 daemon
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>

          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0">状态目录</span>
            <span className="truncate font-mono" title={boot.stateDir}>
              {shortPath(boot.stateDir)}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="复制状态目录"
              title="复制状态目录"
              onClick={() => void copy(boot.stateDir, "状态目录")}
            >
              <CopyIcon />
            </Button>
          </div>

          {daemonDown ? (
            <Alert data-testid="daemon-stopped">
              <PowerIcon />
              <AlertTitle>daemon 已停止</AlertTitle>
              <AlertDescription>
                进程已退出，挂载中的服务已一并停止（登记保留）。重新执行 stoa serve 后再打开本页。
              </AlertDescription>
            </Alert>
          ) : loadError && services.length > 0 ? (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertTitle>daemon 面连接失败</AlertTitle>
              <AlertDescription className="break-all">{loadError}</AlertDescription>
            </Alert>
          ) : null}

          <div
            className="group @container flex flex-col gap-2"
            data-testid="daemon-services"
            data-refreshing={refreshing ? "true" : "false"}
            aria-busy={refreshing}
          >
            <h2 className="sr-only">服务列表</h2>
            {loading ? (
              <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed py-10 text-sm text-muted-foreground">
                <Spinner />
                正在读取服务列表…
              </div>
            ) : loadError && services.length === 0 ? (
              <Alert variant="destructive">
                <CircleAlertIcon />
                <AlertTitle>服务列表加载失败</AlertTitle>
                <AlertDescription className="break-all">{loadError}</AlertDescription>
                <div className="mt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={refreshing}
                    onClick={() => void refresh(false)}
                    data-testid="daemon-retry"
                  >
                    {refreshing ? <Spinner /> : <RefreshCwIcon />}
                    重试
                  </Button>
                </div>
              </Alert>
            ) : daemonDown && services.length === 0 ? (
              <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                daemon 未运行，暂无在册服务。
              </p>
            ) : services.length === 0 ? (
              <Empty className="rounded-xl border border-dashed bg-card/40 py-10">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ServerIcon />
                  </EmptyMedia>
                  <EmptyTitle>还没有挂载的服务</EmptyTitle>
                  <EmptyDescription>
                    把一块 Stoa 公示板挂到本机 daemon：服务在后台常驻，入口与口令在这里统一管理。
                  </EmptyDescription>
                </EmptyHeader>
                <Button onClick={openMount} data-testid="daemon-mount-empty-cta">
                  <PlusIcon data-icon="inline-start" />
                  挂载第一个服务
                </Button>
                <Collapsible className="flex w-full max-w-sm flex-col items-center">
                  <CollapsibleTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs text-muted-foreground"
                      />
                    }
                  >
                    <TerminalIcon data-icon="inline-start" />
                    或使用 CLI
                    <ChevronDownIcon data-icon="inline-end" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="w-full">
                    <div className="mt-2 flex min-w-0 items-center gap-1 rounded-lg border bg-muted/40 px-3 py-2">
                      <code
                        className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
                        title={CLI_HINT}
                      >
                        {CLI_HINT}
                      </code>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="复制 CLI 命令"
                        title="复制 CLI 命令"
                        onClick={() => void copy(CLI_HINT, "CLI 命令")}
                      >
                        <CopyIcon />
                      </Button>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </Empty>
            ) : (
              services.map((service) => (
                <ServiceRow
                  key={service.id}
                  service={service}
                  busy={busyId === service.id}
                  onOpen={(item, target) => void openWithKey(item, target)}
                  onSecret={(item) => setSecretFor(item)}
                  onStop={(item) => setConfirm({ kind: "stop", service: item })}
                  onRemove={(item) => setConfirm({ kind: "remove", service: item })}
                  onCopyPath={(path) => void copy(path, "目录路径")}
                />
              ))
            )}
          </div>

          <Separator />
          <footer className="pb-4">
            <span className="text-xs text-muted-foreground">
              daemon 面只绑定回环地址，供本机开发/自动化使用。
            </span>
          </footer>
        </div>
      </div>

      {/* 挂载 Sheet：<640px 底部抽屉，≥640px 右侧 440px；body 内部滚动、footer 固定。 */}
      <Sheet
        open={mountOpen}
        onOpenChange={(open) => {
          if (open) setMountOpen(true);
          else closeMount();
        }}
      >
        <SheetContent
          side={wideSheet ? "right" : "bottom"}
          data-testid="daemon-mount-sheet"
          className={
            wideSheet
              ? "w-full gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[440px]"
              : "max-h-[85dvh] gap-0 rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
          }
        >
          <SheetHeader className="gap-1 border-b px-4 pt-4 pb-3">
            <SheetTitle>挂载服务</SheetTitle>
            <SheetDescription>
              把一块公示板挂到 daemon 上：服务在后台常驻（不随终端退出而停），口令与入口在这里统一管理。
            </SheetDescription>
          </SheetHeader>
          <form onSubmit={(event) => void onMount(event)} className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 py-4">
              <div className="flex flex-col gap-1.5">
                <Label>位置</Label>
                <Tabs value={location} onValueChange={(value) => {
                  setLocation(value as Location);
                  setDirError(null);
                  setGlobalError(null);
                }}>
                  <TabsList aria-label="会话位置" className="h-9 w-full" data-testid="daemon-location-tabs">
                    <TabsTrigger value="auto" data-testid="daemon-location-auto">
                      自动
                    </TabsTrigger>
                    <TabsTrigger value="temp" data-testid="daemon-location-temp">
                      临时
                    </TabsTrigger>
                    <TabsTrigger value="path" data-testid="daemon-location-path">
                      自定义
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <p className="text-xs text-muted-foreground">{LOCATION_HINT[location]}</p>
              </div>

              {location === "path" ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="daemon-mount-data-dir">目录路径</Label>
                  <div className="flex gap-2">
                    <Input
                      id="daemon-mount-data-dir"
                      value={dataDir}
                      onChange={(event) => {
                        setDataDir(event.target.value);
                        setDirError(null);
                        setGlobalError(null);
                      }}
                      placeholder="/path/to/data-dir"
                      aria-invalid={dirError ? true : undefined}
                      aria-describedby={dirError ? "daemon-mount-dir-error" : undefined}
                      className="min-w-0 flex-1 font-mono text-xs sm:text-sm"
                      data-testid="daemon-mount-data-dir"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!canPick || picking}
                      onClick={() => void pickDirectory()}
                      data-testid="daemon-pick-dir"
                    >
                      {picking ? <Spinner /> : <FolderIcon data-icon="inline-start" />}
                      选择文件夹
                    </Button>
                  </div>
                  {dirError ? (
                    <p
                      id="daemon-mount-dir-error"
                      className="text-xs text-destructive"
                      data-testid="daemon-mount-error"
                    >
                      {dirError}
                    </p>
                  ) : !canPick ? (
                    <p className="text-xs text-muted-foreground">
                      当前环境没有可用的目录对话框，请手动输入路径。
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor="daemon-mount-port">端口</Label>
                  <Input
                    id="daemon-mount-port"
                    value={port}
                    onChange={(event) => {
                      setPort(event.target.value);
                      setPortError(null);
                      setGlobalError(null);
                    }}
                    placeholder="自动分配"
                    inputMode="numeric"
                    aria-invalid={portError ? true : undefined}
                    aria-describedby={portError ? "daemon-mount-port-error" : undefined}
                    data-testid="daemon-mount-port"
                  />
                  {portError ? (
                    <p id="daemon-mount-port-error" className="text-xs text-destructive">
                      {portError}
                    </p>
                  ) : null}
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor="daemon-mount-name">名称</Label>
                  <Input
                    id="daemon-mount-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="默认用目录名"
                    data-testid="daemon-mount-name"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="daemon-mount-key">访问口令</Label>
                <div className="flex gap-2">
                  <Input
                    id="daemon-mount-key"
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                    placeholder="留空自动生成"
                    type={revealKey ? "text" : "password"}
                    autoComplete="new-password"
                    className="min-w-0 flex-1 font-mono"
                    data-testid="daemon-mount-key"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={revealKey ? "隐藏口令" : "显示口令"}
                    aria-pressed={revealKey}
                    onClick={() => setRevealKey((value) => !value)}
                  >
                    {revealKey ? <EyeOffIcon /> : <EyeIcon />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  填了就用它（会覆盖该目录原口令）；留空则沿用已有口令或自动生成。
                </p>
              </div>

              {globalError ? (
                <Alert variant="destructive">
                  <CircleAlertIcon />
                  <AlertTitle>挂载失败</AlertTitle>
                  <AlertDescription className="break-all">{globalError}</AlertDescription>
                </Alert>
              ) : null}
            </div>

            <SheetFooter className="mt-0 flex-row items-center justify-end gap-2 border-t px-4 py-3">
              <Button type="button" variant="ghost" disabled={formBusy} onClick={closeMount}>
                取消
              </Button>
              <Button type="submit" disabled={formBusy} data-testid="daemon-mount-submit">
                {submitting ? <Spinner /> : <PlusIcon data-icon="inline-start" />}
                挂载
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>

      {confirmCopy ? (
        <Dialog open onOpenChange={(open) => (open ? undefined : setConfirm(null))}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{confirmCopy.title}</DialogTitle>
              <DialogDescription>{confirmCopy.description}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline">取消</Button>} />
              <Button
                variant="destructive"
                onClick={() => void runConfirm()}
                data-testid={confirmCopy.testid}
              >
                {confirmCopy.action}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {secretFor ? (
        <SecretDialog
          service={secretFor}
          onClose={() => setSecretFor(null)}
          onChanged={async () => {
            await refresh(true);
          }}
          onServiceUpdated={(updated) => setSecretFor(updated)}
        />
      ) : null}
    </Toaster>
  );
}
