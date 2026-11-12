/**
 * daemon 登录 / 首启创建页（daemon-unified-port design §4/§6，S3-2 页面）。
 *
 * 服务端在 `/login` 返回未注入的 SPA index.html（`main.tsx` 据此渲染本页）：
 *   - `GET /api/daemon/auth/status` → 有无账号；
 *   - 无账号 → 「创建 daemon 账号」（username 默认 daemon + 密码两次确认）；
 *   - 有账号 → 密码登录（单账号；用户名可省略）；
 *   - 成功后 `location.replace(next)` 回跳原页面（`/login` 自身不作为 next）。
 *
 * 组件纪律：只用仓内 shadcn 收编件（Card/Input/Label/Button/Alert/Spinner），
 * 文案中文、颜色走主题令牌。展示层（`DaemonLoginCard`）是纯 props 组件，可直接 SSR 断言。
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { KeyRoundIcon, ServerIcon, UserRoundPlusIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

/** `GET /api/daemon/auth/status` 的壳侧视图（无用户名/哈希）。 */
export interface DaemonAuthStatusView {
  configured: boolean;
  setup_available: boolean;
  authenticated: boolean;
}

export type DaemonLoginMode = "loading" | "error" | "login" | "setup";

/** 阶段推导：拉取失败 → error；无账号 → setup；否则 login。 */
export function daemonLoginModeFor(
  status: DaemonAuthStatusView | null,
  loadError: string | null,
): DaemonLoginMode {
  if (loadError) return "error";
  if (!status) return "loading";
  return status.configured ? "login" : "setup";
}

/**
 * `next` 回跳目标只接受站内绝对路径：`/` 开头、不是 `//`（协议相对）、
 * 不回到 `/login` 自身（避免登录后原地循环）。其余一律回根路径。
 */
export function safeNextPath(raw: string | null | undefined): string {
  const value = String(raw ?? "").trim();
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  // 反斜杠/控制字符会被 URL 规范化成站外地址（`/\evil.com` → `http://evil.com/`）。
  if (/[\u0000-\u001f\\]/.test(value)) return "/";
  if (value === "/login" || value.startsWith("/login?") || value.startsWith("/login/")) return "/";
  return value;
}

export interface DaemonLoginCardProps {
  mode: DaemonLoginMode;
  next: string;
  loadError?: string | null;
  error?: string | null;
  busy?: boolean;
  username?: string;
  password?: string;
  confirm?: string;
  notice?: string | null;
  onUsernameChange?: (value: string) => void;
  onPasswordChange?: (value: string) => void;
  onConfirmChange?: (value: string) => void;
  onSubmit?: () => void;
  onReload?: () => void;
}

/** 纯展示层（无副作用；SSR/单测可直接渲染）。 */
export function DaemonLoginCard(props: DaemonLoginCardProps) {
  const setup = props.mode === "setup";
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {setup ? <UserRoundPlusIcon className="size-4" /> : <KeyRoundIcon className="size-4" />}
            {setup ? "创建 daemon 账号" : "登录 Stoa daemon"}
          </CardTitle>
          <CardDescription className="flex items-center gap-1 break-all">
            <ServerIcon className="size-3 shrink-0" />
            {setup
              ? "首次使用：给这台机器的 daemon 设一个账号密码（与实例口令无关）。"
              : "daemon 控制台与全部实例都需要这个账号。"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {props.mode === "loading" ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="daemon-login-loading">
              <Spinner /> 正在检查 daemon 账号…
            </div>
          ) : null}

          {props.mode === "error" ? (
            <div className="flex flex-col gap-3" data-testid="daemon-login-error">
              <Alert variant="destructive">
                <AlertDescription>{props.loadError ?? "无法读取 daemon 账号状态"}</AlertDescription>
              </Alert>
              <Button type="button" variant="outline" size="sm" onClick={props.onReload}>
                重试
              </Button>
            </div>
          ) : null}

          {setup || props.mode === "login" ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                props.onSubmit?.();
              }}
            >
              {setup ? (
                <div className="flex flex-col gap-1">
                  <Label htmlFor="daemon-login-username">用户名</Label>
                  <Input
                    id="daemon-login-username"
                    value={props.username ?? ""}
                    onChange={(event) => props.onUsernameChange?.(event.target.value)}
                    autoComplete="username"
                    data-testid="daemon-login-username"
                  />
                </div>
              ) : null}
              <div className="flex flex-col gap-1">
                <Label htmlFor="daemon-login-password">{setup ? "密码" : "密码"}</Label>
                <Input
                  id="daemon-login-password"
                  type="password"
                  value={props.password ?? ""}
                  onChange={(event) => props.onPasswordChange?.(event.target.value)}
                  placeholder={setup ? "至少 8 个字符" : "daemon 账号密码"}
                  autoComplete={setup ? "new-password" : "current-password"}
                  autoFocus={!setup}
                  data-testid="daemon-login-password"
                />
              </div>
              {setup ? (
                <div className="flex flex-col gap-1">
                  <Label htmlFor="daemon-login-confirm">确认密码</Label>
                  <Input
                    id="daemon-login-confirm"
                    type="password"
                    value={props.confirm ?? ""}
                    onChange={(event) => props.onConfirmChange?.(event.target.value)}
                    autoComplete="new-password"
                    data-testid="daemon-login-confirm"
                  />
                </div>
              ) : null}

              {props.error ? (
                <Alert variant="destructive" data-testid="daemon-login-form-error">
                  <AlertDescription>{props.error}</AlertDescription>
                </Alert>
              ) : null}
              {props.notice ? (
                <p className="text-xs text-muted-foreground" data-testid="daemon-login-notice">
                  {props.notice}
                </p>
              ) : null}

              <Button
                type="submit"
                size="sm"
                disabled={props.busy === true || !(props.password ?? "")}
                data-testid="daemon-login-submit"
              >
                {props.busy ? <Spinner data-icon="inline-start" /> : null}
                {setup ? "创建并登录" : "登录"}
              </Button>
              <p className="text-xs text-muted-foreground break-all">
                {setup
                  ? "密码以 argon2id 哈希存本机（0600），不会明文落盘；创建成功后自动登录。"
                  : `登录后回到 ${props.next}`}
              </p>
            </form>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // 非 JSON：退回状态码
  }
  return `请求失败（HTTP ${res.status}）`;
}

/** 容器：拉取账号状态 → 提交登录/首启 → 回跳 next。 */
export function DaemonLoginPage() {
  const [status, setStatus] = useState<DaemonAuthStatusView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState("daemon");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [next] = useState(() =>
    safeNextPath(
      typeof window === "undefined"
        ? "/"
        : new URLSearchParams(window.location.search).get("next"),
    ),
  );

  const reload = useCallback(() => {
    setLoadError(null);
    setStatus(null);
    if (typeof window === "undefined") return;
    fetch("/api/daemon/auth/status", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(await readError(res));
        return (await res.json()) as {
          configured?: unknown;
          setup_available?: unknown;
          authenticated?: unknown;
        };
      })
      .then((body) => {
        const view: DaemonAuthStatusView = {
          configured: body.configured === true,
          setup_available: body.setup_available === true,
          authenticated: body.authenticated === true,
        };
        setStatus(view);
        // 已登录（同一浏览器重复打开 /login）：直接回跳。
        if (view.authenticated) window.location.replace(next);
      })
      .catch((err: unknown) => setLoadError((err as Error).message || "无法连接 daemon"));
  }, [next]);

  useEffect(() => {
    reload();
  }, [reload]);

  const mode = daemonLoginModeFor(status, loadError);

  const submit = useCallback(async () => {
    if (mode === "setup" && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const endpoint = mode === "setup" ? "/api/daemon/auth/setup" : "/api/daemon/auth/login";
      const body =
        mode === "setup"
          ? { username: username.trim() || undefined, password }
          : { password };
      const res = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      window.location.replace(next);
    } catch (err) {
      setError((err as Error).message || "请求失败");
    } finally {
      setBusy(false);
    }
  }, [confirm, mode, next, password, username]);

  return (
    <DaemonLoginCard
      mode={mode}
      next={next}
      loadError={loadError}
      error={error}
      busy={busy}
      username={username}
      password={password}
      confirm={confirm}
      onUsernameChange={setUsername}
      onPasswordChange={setPassword}
      onConfirmChange={setConfirm}
      onSubmit={() => void submit()}
      onReload={reload}
    />
  );
}
