import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BookOpenIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleSlashIcon,
  CopyIcon,
  HistoryIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldCheckIcon,
  Trash2Icon,
  WifiIcon,
  WifiOffIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import {
  checkEp,
  clearEpHistory,
  clearToken,
  forgetEp,
  loadEpHistoryEntries,
  probeEpHealth,
  type EpHistoryEntry,
} from "@/lib/ep";
import { copyText } from "@/lib/copy";
import { goBack } from "@/lib/router";
import { fullTime, roleLabel, timeShort } from "@/lib/format";
import { useConnection } from "@/state/connection";

type ProbeState = "probing" | "online" | "offline";

/** 最后使用时间的口语化文案（timeShort 的「1 分」在管理列表里太省略）。 */
function lastUsedText(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "时间未知";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return timeShort(ts);
}

function ProbeBadge({ state }: { state: ProbeState | undefined }) {
  if (!state || state === "probing") {
    return (
      <Badge variant="outline" className="gap-1" data-testid="ep-probe-status">
        <Spinner className="size-3" /> 探测中
      </Badge>
    );
  }
  if (state === "online") {
    return (
      <Badge variant="secondary" className="gap-1" data-testid="ep-probe-status">
        <WifiIcon className="size-3" /> 在线
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" className="gap-1" data-testid="ep-probe-status">
      <WifiOffIcon className="size-3" /> 离线
    </Badge>
  );
}

/**
 * 实例管理页：无 ep 时显示。
 *
 * 信息架构（spec report-app-ui「实例管理页结构」）：
 *   品牌 + 一句用途 → 当前连接 → 添加实例 → 我的实例 → 如何启动实例（折叠）。
 * 历史只存本机 localStorage；在线探测走目标既有 GET /healthz；不新增后端接口。
 */
export function LandingPage({ onBack }: { onBack?: () => void } = {}) {
  const { connect, error: connectError, lastConnection } = useConnection();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [history, setHistory] = useState<EpHistoryEntry[]>(() => loadEpHistoryEntries());
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});
  const [usageOpen, setUsageOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const probeOne = useCallback(async (url: string) => {
    if (!alive.current) return;
    setProbes((prev) => ({ ...prev, [url]: "probing" }));
    const result = await probeEpHealth(url);
    if (!alive.current) return;
    setProbes((prev) => ({ ...prev, [url]: result.ok ? "online" : "offline" }));
  }, []);

  useEffect(() => {
    for (const entry of loadEpHistoryEntries()) void probeOne(entry.url);
  }, [probeOne]);

  /**
   * 连接实例：只有「从路由层实例页进入且终态为 ready/login」才回退一层；
   * landing 阶段（无 onBack）与失败态完全不改 URL（深链目标不丢）。
   */
  const activate = useCallback(
    async (url: string) => {
      const outcome = await connect(url);
      if (!onBack || window.location.hash !== "#/instances") return;
      if (outcome === "ready" || outcome === "login") goBack();
    },
    [connect, onBack],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    const checked = checkEp(value);
    if (!checked.ok) {
      setError(checked.error ?? "地址不合法");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const health = await probeEpHealth(checked.url!);
      if (!health.ok) {
        setError(health.error ?? "无法连接该实例");
        return;
      }
      await activate(checked.url!);
    } finally {
      setSubmitting(false);
    }
  };

  const copyAddress = async (url: string) => {
    const ok = await copyText(url);
    toast.add({
      type: ok ? "success" : "error",
      title: ok ? "地址已复制" : "复制失败",
      description: url,
      timeout: 2400,
    });
  };

  const removeEntry = (url: string) => {
    forgetEp(url);
    // 移除历史 = 移除该实例留在本机的登录凭据（access token）。
    clearToken(url);
    setHistory(loadEpHistoryEntries());
    setProbes((prev) => {
      const next = { ...prev };
      delete next[url];
      return next;
    });
  };

  const clearHistory = () => {
    for (const entry of loadEpHistoryEntries()) clearToken(entry.url);
    clearEpHistory();
    setHistory([]);
    setProbes({});
    setConfirmClear(false);
  };

  const version = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.1.0";
  const shownError = error ?? connectError;
  const usage = useMemo(
    () => [
      "在数据目录起一个本地实例：bun src/cli/main.ts serve --data-dir <数据目录>",
      "把 serve 打印的 REPORT_URL（或你经隧道曝光的域名）填进「添加实例」",
      "认证模式首访输入 STOA_AUTH；之后 access token 只存本机 localStorage",
      "同一份 dist 可托管在任意静态宿主，ep 指向另一台机器上的实例也一样可用",
    ],
    [],
  );

  return (
    <div
      className="min-h-dvh max-h-dvh w-full overflow-y-auto overscroll-contain bg-background"
      data-testid="instance-page"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 pt-[calc(1.5rem+env(safe-area-inset-top))] pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:px-6 lg:gap-6 lg:pt-10">
        <header className="flex items-center gap-3">
          <span className="glass-primary flex size-12 shrink-0 items-center justify-center rounded-2xl text-xl font-semibold text-primary-foreground">
            R
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">report</h1>
              <Badge variant="outline">v{version}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">人机公示板 · 管理你连接的实例</p>
          </div>
          {onBack ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto shrink-0 max-sm:size-11"
              data-testid="instance-back"
              onClick={onBack}
            >
              <ArrowLeftIcon data-icon="inline-start" />
              返回
            </Button>
          ) : null}
        </header>

        <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:items-start">
          <div className="flex min-w-0 flex-col gap-5">
            <Card data-testid="current-connection">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ServerIcon className="size-4" /> 当前连接
                </CardTitle>
                <CardDescription>本次会话内最近一次成功连接的实例</CardDescription>
              </CardHeader>
              <CardContent>
                {lastConnection ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {/* 静态归档不会进入本页（App 静态模式直达 ReadyApp）；分支保留以对齐 spec 口径。 */}
                      <Badge variant={lastConnection.staticMode ? "outline" : "secondary"}>
                        {lastConnection.staticMode ? "静态归档" : "已连接"}
                      </Badge>
                      <Badge variant="outline">
                        {lastConnection.authMode === "auth" ? "认证模式" : "开放模式"}
                      </Badge>
                      {lastConnection.account ? (
                        <Badge variant="outline">
                          @{lastConnection.account.id}
                          {lastConnection.account.id === lastConnection.account.role
                            ? ""
                            : ` · ${roleLabel(lastConnection.account.role)}`}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="flex min-w-0 items-center gap-2">
                      <code
                        className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs"
                        title={lastConnection.ep}
                      >
                        {lastConnection.ep}
                      </code>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="max-sm:size-11"
                        aria-label="复制当前实例地址"
                        data-testid="current-copy"
                        onClick={() => void copyAddress(lastConnection.ep)}
                      >
                        <CopyIcon />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div
                    className="flex items-start gap-3 py-1"
                    data-testid="current-connection-empty"
                  >
                    <CircleSlashIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium">当前未连接</div>
                      <div className="text-xs text-muted-foreground">
                        从已连接的实例进入本页时，这里会显示它的地址、模式与身份。
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card data-testid="add-instance">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldCheckIcon className="size-4" /> 添加实例
                </CardTitle>
                <CardDescription>
                  只接受 https，或本机回环 http://localhost / 127.0.0.1
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <form onSubmit={submit} className="flex flex-col gap-3">
                  <InputGroup className="max-sm:h-11">
                    <InputGroupAddon>
                      <ServerIcon />
                    </InputGroupAddon>
                    <InputGroupInput
                      ref={inputRef}
                      value={value}
                      onChange={(event) => setValue(event.target.value)}
                      placeholder="https://local-…  或  http://127.0.0.1:<端口>"
                      aria-label="实例地址"
                      data-testid="ep-input"
                      className="max-sm:h-11"
                      inputMode="url"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      enterKeyHint="go"
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton
                        type="submit"
                        variant="default"
                        size="sm"
                        className="max-sm:h-11"
                        disabled={submitting}
                        data-testid="ep-connect"
                      >
                        {submitting ? (
                          <>
                            <Spinner className="size-3.5" /> 探测中
                          </>
                        ) : (
                          <>
                            连接 <ArrowRightIcon data-icon="inline-end" />
                          </>
                        )}
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                  {shownError ? (
                    <Alert variant="destructive" data-testid="ep-error">
                      <CircleAlertIcon />
                      <AlertTitle>无法连接</AlertTitle>
                      <AlertDescription className="break-words">{shownError}</AlertDescription>
                    </Alert>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    连接前会先探测 <code className="rounded bg-muted px-1">/healthz</code>；
                    地址与历史只保存在本机 localStorage。
                  </p>
                </form>
              </CardContent>
            </Card>
          </div>

          <div className="flex min-w-0 flex-col gap-5">
            <Card data-testid="my-instances">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <HistoryIcon className="size-4" /> 我的实例
                </CardTitle>
                <CardDescription>只保存在本机 localStorage（最近 8 个）</CardDescription>
                {history.length > 0 ? (
                  <CardAction>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="max-sm:min-h-11 text-muted-foreground"
                      data-testid="ep-history-clear"
                      onClick={() => setConfirmClear(true)}
                    >
                      <Trash2Icon data-icon="inline-start" /> 清空历史
                    </Button>
                  </CardAction>
                ) : null}
              </CardHeader>
              <CardContent className="flex flex-col gap-1">
                {confirmClear && history.length > 0 ? (
                  <Alert variant="destructive" data-testid="ep-history-clear-confirm">
                    <CircleAlertIcon />
                    <AlertTitle>清空历史？</AlertTitle>
                    <AlertDescription className="flex flex-col gap-2">
                      <span>将同时清除这些实例保存在本机的登录凭据。</span>
                      <span className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          className="max-sm:min-h-11"
                          data-testid="ep-history-clear-confirm-button"
                          onClick={clearHistory}
                        >
                          确认清空
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="max-sm:min-h-11"
                          onClick={() => setConfirmClear(false)}
                        >
                          取消
                        </Button>
                      </span>
                    </AlertDescription>
                  </Alert>
                ) : null}
                {history.length === 0 ? (
                  <Empty className="border-0 py-8" data-testid="ep-history-empty">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <ServerIcon />
                      </EmptyMedia>
                      <EmptyTitle>还没有连接过任何实例</EmptyTitle>
                      <EmptyDescription>
                        连接成功后会自动记录在这里，最多保留 8 个。
                      </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="max-sm:min-h-11"
                        onClick={() => inputRef.current?.focus()}
                      >
                        添加实例
                      </Button>
                    </EmptyContent>
                  </Empty>
                ) : (
                  history.map((entry) => {
                    const state = probes[entry.url];
                    return (
                      <div
                        key={entry.url}
                        className="flex flex-col gap-2 rounded-lg px-2 py-2.5 transition-colors hover:bg-muted/40"
                        data-testid="ep-history-item"
                        data-url={entry.url}
                        data-status={state ?? "probing"}
                      >
                        <div className="flex min-w-0 items-start gap-2">
                          <ServerIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <div className="break-all font-mono text-xs leading-relaxed">
                              {entry.url}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                              <span
                                title={entry.lastUsedAt > 0 ? fullTime(entry.lastUsedAt) : undefined}
                              >
                                上次使用：{lastUsedText(entry.lastUsedAt)}
                              </span>
                              <ProbeBadge state={state} />
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2 pl-6">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="max-sm:min-h-11"
                            data-testid="ep-history-connect"
                            onClick={() => void activate(entry.url)}
                          >
                            连接
                          </Button>
                          {state === "offline" ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="max-sm:min-h-11"
                              data-testid="ep-history-retry"
                              onClick={() => void probeOne(entry.url)}
                            >
                              <RefreshCwIcon data-icon="inline-start" /> 重试
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="max-sm:min-h-11 text-destructive hover:bg-destructive/10 hover:text-destructive"
                            aria-label={`移除 ${entry.url}`}
                            data-testid="ep-history-remove"
                            onClick={() => removeEntry(entry.url)}
                          >
                            <Trash2Icon data-icon="inline-start" /> 移除
                          </Button>
                        </div>
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>

            <Card className="gap-0 py-0" data-testid="usage-card">
              <Collapsible open={usageOpen} onOpenChange={setUsageOpen}>
                <CollapsibleTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto w-full justify-between gap-2 rounded-none px-4 py-3 text-base font-medium hover:bg-muted/40"
                      data-testid="usage-trigger"
                    />
                  }
                >
                  <span className="flex items-center gap-2">
                    <BookOpenIcon className="size-4" /> 如何启动实例
                  </span>
                  <ChevronDownIcon
                    className={usageOpen ? "rotate-180 transition-transform" : "transition-transform"}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="flex flex-col gap-2 border-t border-border/60 px-4 py-3 text-sm text-muted-foreground">
                    {usage.map((line, index) => (
                      <div key={index} className="flex gap-2">
                        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-foreground">
                          {index + 1}
                        </span>
                        <span className="min-w-0 break-words">{line}</span>
                      </div>
                    ))}
                    <Separator className="my-1" />
                    <p className="text-xs">
                      这是 worker 系列：静态壳与数据分离。当前阶段只私下用，线上部署等 Hive
                      认证服务就绪。
                    </p>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
