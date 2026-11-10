/**
 * daemon-webui（stoa-daemon design §4）：daemon 进程在 `/` 注入的
 * `window.__STOA_DAEMON__` 是渲染开关——有它时渲染本控制台，没有时渲染公示板壳（App）。
 * 数据全部走同源 `/api/daemon/*`；组件只用官方收编件（card/button/badge/input/alert/empty/spinner/dialog）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  CircleAlertIcon,
  ExternalLinkIcon,
  FolderIcon,
  PlusIcon,
  PowerIcon,
  RefreshCwIcon,
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
import { Toaster, toast } from "@/components/ui/toast";
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
  onStop,
  onRemove,
}: {
  service: DaemonService;
  busy: boolean;
  onStop: (service: DaemonService) => void;
  onRemove: (service: DaemonService) => void;
}) {
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
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <ServerIcon className="size-3.5 shrink-0" />
          {service.url ? (
            service.status === "running" ? (
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
        <div className="text-xs text-muted-foreground">
          端口 {service.port}
          {service.status === "running"
            ? ` · 启动于 ${timeShort(service.startedAt)}`
            : service.stoppedAt
              ? ` · 停止于 ${timeShort(service.stoppedAt)}`
              : ""}
        </div>
        <div className="truncate font-mono text-xs text-muted-foreground/80" title={service.dataDir}>
          {service.dataDir}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {service.status === "running" && service.url ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(service.url ?? "", "_blank")}
            >
              <ExternalLinkIcon />
              打开
            </Button>
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

export function DaemonConsolePage({ boot }: { boot: DaemonBoot }) {
  const [services, setServices] = useState<DaemonService[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dataDir, setDataDir] = useState("");
  const [port, setPort] = useState("");
  const [name, setName] = useState("");
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
      const trimmed = dataDir.trim();
      if (!trimmed) {
        setFormError("dataDir 必填：填一个已初始化（stoa init）过的目录。");
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
        const out = await daemonApi<{ service: DaemonService }>("/api/daemon/services", {
          method: "POST",
          body: {
            dataDir: trimmed,
            port: portValue,
            name: name.trim() || null,
          },
        });
        toast.add({
          type: "success",
          title: "已挂载",
          description: out.service.url ?? out.service.dataDir,
          timeout: 2400,
        });
        setDataDir("");
        setPort("");
        setName("");
        await refresh(true);
      } catch (err) {
        setFormError((err as Error).message);
      } finally {
        setSubmitting(false);
      }
    },
    [dataDir, port, name, refresh],
  );

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
            状态目录：<span className="font-mono">{boot.stateDir}</span>
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
                把一个 data-dir 上的公示板实例挂到 daemon 上：服务在后台常驻（不随终端退出而停），
                下面可统一开关。
              </CardDescription>
            </CardHeader>
            <form onSubmit={(event) => void onMount(event)} className="flex flex-col gap-(--card-spacing)">
              <CardContent className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="daemon-mount-data-dir">dataDir（必填）</Label>
                  <Input
                    id="daemon-mount-data-dir"
                    value={dataDir}
                    onChange={(event) => setDataDir(event.target.value)}
                    placeholder="已 stoa init 过的目录"
                    data-testid="daemon-mount-data-dir"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="daemon-mount-port">端口（可选）</Label>
                  <Input
                    id="daemon-mount-port"
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                    placeholder="自动挑空闲"
                    inputMode="numeric"
                    data-testid="daemon-mount-port"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="daemon-mount-name">名称（可选）</Label>
                  <Input
                    id="daemon-mount-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="默认目录名"
                    data-testid="daemon-mount-name"
                  />
                </div>
                {formError ? (
                  <p className="text-sm text-destructive sm:col-span-3" data-testid="daemon-mount-error">
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
                      用上面的表单把一个 data-dir 挂进来，或改用 CLI：
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
    </Toaster>
  );
}
