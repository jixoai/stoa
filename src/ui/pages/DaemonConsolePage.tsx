/**
 * daemon-webui（stoa-daemon design §4；stoa-session-ux design §4/§5）：
 * daemon 进程在 `/` 注入的 `window.__STOA_DAEMON__` 是渲染开关——有它时渲染本控制台，
 * 没有时渲染公示板壳（App）。数据全部走同源 `/api/daemon/*`；组件只用官方收编件。
 *
 * 本版重点（Owner 2026-11-10 反馈）：
 *   - dataDir 不是必填：位置可选「自动（~/.stoa/sessions）／临时（停止即删）／自定义（原生目录选择器）」；
 *   - 口令是一等公民：挂载可指定口令（留空自动生成），服务行「口令」可读取/复制/复制密钥链接/重新生成。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  CircleAlertIcon,
  CopyIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  GlobeIcon,
  KeyRoundIcon,
  PlusIcon,
  PowerIcon,
  RefreshCwIcon,
  RotateCwIcon,
  ServerIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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

const LOCATION_LABEL: Record<Location, string> = {
  auto: "自动",
  temp: "临时",
  path: "自定义",
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

function StatusBadge({ status }: { status: DaemonService["status"] }) {
  return status === "running" ? (
    <Badge className="gap-1">
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      运行中
    </Badge>
  ) : (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <span className="size-1.5 rounded-full bg-current opacity-60" aria-hidden="true" />
      已停止
    </Badge>
  );
}

function ServiceRow({
  service,
  busy,
  onSecret,
  onStop,
  onRemove,
}: {
  service: DaemonService;
  busy: boolean;
  onSecret: (service: DaemonService) => void;
  onStop: (service: DaemonService) => void;
  onRemove: (service: DaemonService) => void;
}) {
  const running = service.status === "running";
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border p-3 data-[status=stopped]:opacity-70 sm:flex-row sm:items-center sm:gap-3"
      data-status={service.status}
      data-testid={`daemon-service-${service.id}`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{service.name}</span>
          <StatusBadge status={service.status} />
          {service.location ? (
            <Badge variant="outline" className="text-muted-foreground">
              {LOCATION_LABEL[service.location] ?? "自定义"}
            </Badge>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <ServerIcon className="size-3.5 shrink-0" />
          {service.url ? (
            running ? (
              <a
                className="truncate font-mono hover:text-foreground hover:underline"
                href={service.url}
                target="_blank"
                rel="noreferrer"
              >
                {service.url}
              </a>
            ) : (
              // 已停止：端口不再监听，保持纯文本（避免误导性可点击观感）。
              <span className="truncate font-mono line-through decoration-muted-foreground/40">
                {service.url}
              </span>
            )
          ) : (
            <span className="truncate font-mono">（无监听地址）</span>
          )}
        </div>
        {service.publicUrl ? (
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <GlobeIcon className="size-3.5 shrink-0" />
            <a
              className="truncate font-mono hover:text-foreground hover:underline"
              href={service.publicUrl}
              target="_blank"
              rel="noreferrer"
            >
              {service.publicUrl}
            </a>
          </div>
        ) : null}
        <div className="text-xs text-muted-foreground">
          端口 {service.port}
          {running
            ? ` · 启动于 ${timeShort(service.startedAt)}`
            : service.stoppedAt
              ? ` · 停止于 ${timeShort(service.stoppedAt)}`
              : ""}
        </div>
        <div className="truncate font-mono text-xs text-muted-foreground/80" title={service.dataDir}>
          {shortPath(service.dataDir)}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onSecret(service)}
          data-testid={`daemon-secret-${service.id}`}
        >
          <KeyRoundIcon />
          口令
        </Button>
        {running ? (
          <>
            {service.url ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(service.url ?? "", "_blank")}
              >
                <ExternalLinkIcon />
                打开
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={busy}
              onClick={() => onStop(service)}
              data-testid={`daemon-stop-${service.id}`}
            >
              {busy ? <Spinner /> : <SquareIcon />}
              停止
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            disabled={busy}
            onClick={() => onRemove(service)}
            data-testid={`daemon-remove-${service.id}`}
          >
            {busy ? <Spinner /> : <Trash2Icon />}
            移除登记
          </Button>
        )}
      </div>
    </div>
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
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [location, setLocation] = useState<Location>("auto");
  const [dataDir, setDataDir] = useState("");
  const [port, setPort] = useState("");
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [picking, setPicking] = useState(false);
  const [canPick, setCanPick] = useState(true);
  const [secretFor, setSecretFor] = useState<DaemonService | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async (silent: boolean) => {
    if (!silent) setRefreshing(true);
    try {
      const out = await daemonApi<{ services: DaemonService[] }>("/api/daemon/services");
      if (!mounted.current) return;
      setServices(out.services);
      setLoadError(null);
    } catch (err) {
      if (!mounted.current) return;
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
    const timer = setInterval(() => void refresh(true), POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const runningCount = useMemo(
    () => services.filter((service) => service.status === "running").length,
    [services],
  );

  const onMount = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const path = dataDir.trim();
      if (location === "path" && !path) {
        setFormError("自定义位置需要填目录路径（可用「选择文件夹」）。");
        return;
      }
      let portValue: number | null = null;
      if (port.trim() !== "") {
        const parsed = Number(port.trim());
        if (!Number.isInteger(parsed) || parsed < 13680 || parsed > 13699) {
          setFormError("端口必须是 13680–13699 的整数（留空则自动挑一个空闲端口）。");
          return;
        }
        portValue = parsed;
      }
      setFormError(null);
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
        setDataDir("");
        setPort("");
        setName("");
        setKey("");
        setLocation("auto");
        await refresh(true);
      } catch (err) {
        setFormError((err as Error).message);
      } finally {
        setSubmitting(false);
      }
    },
    [dataDir, key, location, name, port, refresh],
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
    } catch (err) {
      toast.add({
        type: "error",
        title: "关闭失败",
        description: (err as Error).message,
        timeout: 3600,
      });
    }
  }, []);

  const locationHelper =
    location === "auto"
      ? "会建在 ~/.stoa/sessions/（自动初始化并生成口令，长期保留）。"
      : location === "temp"
        ? "系统临时目录：服务停止后整目录删除，适合一次性演示。"
        : "填一个已有目录（未初始化会自动初始化），或用「选择文件夹」挑一个。";

  return (
    <Toaster>
      <div className="min-h-dvh bg-background text-foreground">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 sm:py-10">
          <header className="flex flex-wrap items-center gap-2">
            <PowerIcon className="size-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Stoa Daemon</h1>
            <Badge variant="outline" className="font-mono">
              v{boot.version}
            </Badge>
            <span className="ml-auto flex items-center gap-2">
              <span className="hidden text-xs text-muted-foreground sm:inline">
                pid {boot.pid} · 启动于 {timeShort(boot.startedAt)}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={refreshing}
                onClick={() => void refresh(false)}
                data-testid="daemon-refresh"
              >
                {refreshing ? <Spinner /> : <RefreshCwIcon />}
                刷新
              </Button>
            </span>
          </header>
          <p className="truncate text-xs text-muted-foreground" title={boot.stateDir}>
            状态目录：<span className="font-mono">{shortPath(boot.stateDir)}</span>
          </p>

          {loadError ? (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertTitle>daemon 面连接失败</AlertTitle>
              <AlertDescription className="break-all">{loadError}</AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <PlusIcon className="size-4 text-muted-foreground" />
                挂载服务
              </CardTitle>
              <CardDescription>
                把一块公示板挂到 daemon 上：服务在后台常驻（不随终端退出而停），口令与入口在这里统一管理。
              </CardDescription>
            </CardHeader>
            <form onSubmit={(event) => void onMount(event)} className="flex flex-col gap-(--card-spacing)">
              <CardContent className="flex flex-col gap-3">
                <Tabs value={location} onValueChange={(value) => setLocation(value as Location)}>
                  <div className="flex flex-col gap-1.5">
                    <Label>位置</Label>
                    <TabsList aria-label="会话位置" data-testid="daemon-location-tabs">
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
                    <p className="text-xs text-muted-foreground">{locationHelper}</p>
                  </div>
                </Tabs>

                {location === "path" ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="daemon-mount-data-dir">目录路径（必填）</Label>
                    <div className="flex gap-2">
                      <Input
                        id="daemon-mount-data-dir"
                        value={dataDir}
                        onChange={(event) => setDataDir(event.target.value)}
                        placeholder="/path/to/data-dir"
                        aria-invalid={
                          formError?.includes("目录路径") ? true : undefined
                        }
                        className="font-mono text-xs sm:text-sm"
                        data-testid="daemon-mount-data-dir"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!canPick || picking}
                        onClick={() => void pickDirectory()}
                        data-testid="daemon-pick-dir"
                      >
                        {picking ? <Spinner /> : <FolderIcon />}
                        选择文件夹
                      </Button>
                    </div>
                    {!canPick ? (
                      <p className="text-xs text-muted-foreground">
                        当前环境没有可用的目录对话框，请手动输入路径。
                      </p>
                    ) : null}
                  </div>
                ) : null}

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="daemon-mount-port">端口（可选）</Label>
                    <Input
                      id="daemon-mount-port"
                      value={port}
                      onChange={(event) => setPort(event.target.value)}
                      placeholder="自动挑空闲"
                      inputMode="numeric"
                      aria-invalid={formError?.includes("端口") ? true : undefined}
                      data-testid="daemon-mount-port"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="daemon-mount-name">名称（可选）</Label>
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
                  <Label htmlFor="daemon-mount-key">访问口令（可选）</Label>
                  <Input
                    id="daemon-mount-key"
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                    placeholder="留空自动生成"
                    className="font-mono"
                    data-testid="daemon-mount-key"
                  />
                  <p className="text-xs text-muted-foreground">
                    填了就用它（会覆盖该目录原口令）；留空则沿用已有口令或自动生成。
                  </p>
                </div>

                {formError ? (
                  <p className="text-sm text-destructive" data-testid="daemon-mount-error">
                    {formError}
                  </p>
                ) : null}
              </CardContent>
              <CardFooter className="gap-3">
                <Button type="submit" disabled={submitting} data-testid="daemon-mount-submit">
                  {submitting ? <Spinner /> : <PlusIcon />}
                  挂载
                </Button>
                <span className="text-xs text-muted-foreground">端口留空＝自动挑空闲端口。</span>
              </CardFooter>
            </form>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ServerIcon className="size-4 text-muted-foreground" />
                服务
              </CardTitle>
              <CardAction>
                <Badge variant="outline">
                  {runningCount} 运行 / {services.length} 登记
                </Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-2" data-testid="daemon-services">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                  <Spinner />
                  正在读取服务列表…
                </div>
              ) : services.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <FolderIcon />
                    </EmptyMedia>
                    <EmptyTitle>还没有挂载的服务</EmptyTitle>
                    <EmptyDescription>
                      用上面的表单挂一个（位置选「自动」即可，不需要准备目录），或改用 CLI：
                      <span className="mx-1 font-mono">stoa serve --data-dir &lt;目录&gt;</span>
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                services.map((service) => (
                  <ServiceRow
                    key={service.id}
                    service={service}
                    busy={busyId === service.id}
                    onSecret={(item) => setSecretFor(item)}
                    onStop={(item) => void onStop(item)}
                    onRemove={(item) => void onRemove(item)}
                  />
                ))
              )}
            </CardContent>
          </Card>

          <Separator />
          <footer className="flex flex-wrap items-center justify-between gap-3 pb-4">
            <span className="text-xs text-muted-foreground">
              daemon 面只绑定回环地址，供本机开发/自动化使用。
            </span>
            <Dialog>
              <DialogTrigger
                render={
                  <Button variant="outline" size="sm" data-testid="daemon-shutdown-open">
                    <PowerIcon />
                    关闭 daemon
                  </Button>
                }
              />
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>关闭 daemon？</DialogTitle>
                  <DialogDescription>
                    挂载中的服务会被一并停止（登记保留），daemon 进程退出。之后
                    <span className="mx-1 font-mono">stoa serve</span>
                    或本页面都会重新按需拉起它。
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose render={<Button variant="outline">取消</Button>} />
                  <Button
                    variant="destructive"
                    onClick={() => void onShutdown()}
                    data-testid="daemon-shutdown-confirm"
                  >
                    <PowerIcon />
                    关闭
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </footer>
          <p className="text-center text-xs text-muted-foreground/70">
            stoa daemon · {fullTime(boot.startedAt)} 启动
          </p>
        </div>
      </div>
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
