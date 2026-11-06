/**
 * 连接生命周期：ep 校验 → health/认证状态 → 登录 → who/accounts → SSE。
 * 页面层只消费 ready 之后的 client；壳内无任何后端地址硬编码。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { NotificationEventLine } from "@core/types";
import { AuthError, ReportClient, ReportStream, type AccountRow, type AuthStatus, type ServerStatus, type SseState, type WhoRow } from "@/lib/api";
import { clearMediaCache } from "@/lib/media";
import { installStaticApi, readReportSnapshot, type StaticReportClient } from "@/lib/static-api";
import {
  checkEp,
  clearCurrentEp,
  clearToken,
  epFromLocation,
  loadCurrentEp,
  loadToken,
  probeSameOriginEp,
  rememberEp,
  saveCurrentEp,
  saveToken,
  tokenExpired,
} from "@/lib/ep";

export type ConnectionPhase = "landing" | "connecting" | "login" | "ready" | "error";

export interface ConnectionValue {
  phase: ConnectionPhase;
  ep: string | null;
  client: ReportClient | null;
  auth: AuthStatus | null;
  server: ServerStatus | null;
  account: { id: string; role: "owner" | "manager" | "agent" } | null;
  accounts: AccountRow[];
  who: WhoRow[];
  /** 当前 ep 与页面同源（页面由后端自身托管） */
  sameOrigin: boolean;
  /** 静态归档模式：数据来自内联快照，写入口全部只读（spec report-static-mode）。 */
  staticMode: boolean;
  snapshot: { asOfSeq: number; viewer: string } | null;
  sseState: SseState;
  error: string | null;
  loginError: string | null;
  connect: (url: string) => Promise<void>;
  login: (secret: string) => Promise<void>;
  logout: () => void;
  switchBackend: () => void;
  retry: () => void;
  refreshWho: () => void;
  subscribeEvents: (listener: (event: NotificationEventLine) => void) => () => void;
}

const ConnectionContext = createContext<ConnectionValue | null>(null);

function stripEpFromLocation(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("ep")) return;
    url.searchParams.delete("ep");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // ignore
  }
}

export function ConnectionProvider({ children }: { children: ReactNode }) {
  // 模式判定（design §2）：`?ep=` → 后端；无 ep 且存在内联快照 → 静态归档；
  // 两者皆无 → 现有连接流程（记录 ep / 同源探测 / 落地页）。
  const boot = useMemo(() => {
    if (typeof window === "undefined") return null;
    if (epFromLocation().raw !== null) return null;
    const snapshot = readReportSnapshot();
    if (!snapshot) return null;
    const staticClient: StaticReportClient = installStaticApi(snapshot);
    return {
      client: staticClient,
      info: staticClient.boot(),
      snapshot: { asOfSeq: snapshot.as_of_seq, viewer: snapshot.viewer },
    };
  }, []);

  const [phase, setPhase] = useState<ConnectionPhase>(boot ? "ready" : "connecting");
  const [ep, setEp] = useState<string | null>(null);
  const [client, setClient] = useState<ReportClient | null>(boot?.client ?? null);
  const [auth, setAuth] = useState<AuthStatus | null>(boot?.info.auth ?? null);
  const [server, setServer] = useState<ServerStatus | null>(boot?.info.server ?? null);
  const [account, setAccount] = useState<ConnectionValue["account"]>(boot?.info.account ?? null);
  const [accounts, setAccounts] = useState<AccountRow[]>(boot?.info.accounts ?? []);
  const [who, setWho] = useState<WhoRow[]>(boot?.info.who ?? []);
  const [sseState, setSseState] = useState<SseState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [staticMode, setStaticMode] = useState(boot !== null);

  const listeners = useRef(new Set<(event: NotificationEventLine) => void>());
  const pendingClient = useRef<ReportClient | null>(null);
  const autoStarted = useRef(false);
  const whoTimer = useRef<number | null>(null);

  const subscribeEvents = useCallback((listener: (event: NotificationEventLine) => void) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);

  const refreshWho = useCallback(() => {
    const current = client;
    if (!current) return;
    if (whoTimer.current !== null) window.clearTimeout(whoTimer.current);
    whoTimer.current = window.setTimeout(() => {
      whoTimer.current = null;
      void Promise.all([current.who(), current.accounts()])
        .then(([whoRes, accountRows]) => {
          setWho(whoRes.accounts);
          setAccounts(accountRows);
        })
        .catch(() => {
          // presence is non-critical; next tick retries
        });
    }, 200);
  }, [client]);

  const finishReady = useCallback(
    async (current: ReportClient, authStatus: AuthStatus) => {
      const status = await current.status();
      setAuth(authStatus);
      setServer(status.server);
      setAccount(status.account);
      const myAccount = status.account.id;
      // 保证自己出现在 who 里（owner/manager 恒列）
      void Promise.all([current.who(), current.accounts()])
        .then(([whoRes, accountRows]) => {
          setWho(whoRes.accounts);
          setAccounts(accountRows);
          void myAccount;
        })
        .catch(() => {
          // will be retried by the poll
        });
      setStaticMode(current.mode === "static");
      if (current.mode !== "static") {
        saveCurrentEp(current.base);
        rememberEp(current.base);
        setEp(current.base);
      } else {
        setEp(null);
      }
      setClient(current);
      setPhase("ready");
      setError(null);
      setLoginError(null);
    },
    [],
  );

  const startConnect = useCallback(
    async (url: string) => {
      setPhase("connecting");
      setError(null);
      setLoginError(null);
      const token = tokenExpired(url) ? null : loadToken(url);
      const nextClient = new ReportClient(url, token);
      nextClient.setUnauthorizedHandler(() => {
        clearToken(url);
        clearMediaCache();
        setLoginError("登录已失效，请重新输入密码");
        setPhase("login");
      });
      pendingClient.current = nextClient;
      setEp(url);

      try {
        await nextClient.health();
        const authStatus = await nextClient.authStatus();
        setAuth(authStatus);
        if (authStatus.mode === "auth") {
          if (!token) {
            setPhase("login");
            return;
          }
          try {
            await finishReady(nextClient, authStatus);
          } catch (err) {
            if (err instanceof AuthError) {
              clearToken(url);
              setPhase("login");
              return;
            }
            throw err;
          }
        } else {
          await finishReady(nextClient, authStatus);
        }
      } catch (err) {
        setError((err as Error).message);
        setPhase("error");
      }
    },
    [finishReady],
  );

  const connect = useCallback(
    async (rawUrl: string) => {
      const checked = checkEp(rawUrl);
      if (!checked.ok) {
        setError(checked.error ?? "后端地址不合法");
        setPhase("landing");
        return;
      }
      await startConnect(checked.url!);
    },
    [startConnect],
  );

  const login = useCallback(
    async (secret: string) => {
      const current = pendingClient.current;
      if (!current) {
        setPhase("landing");
        return;
      }
      setLoginError(null);
      try {
        const result = await current.login(secret);
        saveToken(current.base, result.token, result.exp);
        current.setToken(result.token);
        const authStatus = await current.authStatus();
        await finishReady(current, authStatus);
      } catch (err) {
        setLoginError((err as Error).message || "登录失败");
      }
    },
    [finishReady],
  );

  const logout = useCallback(() => {
    if (ep) clearToken(ep);
    clearCurrentEp();
    clearMediaCache();
    setClient(null);
    setAccount(null);
    setWho([]);
    setAccounts([]);
    setAuth(null);
    setServer(null);
    setEp(null);
    setError(null);
    setPhase("landing");
    stripEpFromLocation();
  }, [ep]);

  const switchBackend = useCallback(() => {
    clearCurrentEp();
    clearMediaCache();
    setClient(null);
    setAccount(null);
    setWho([]);
    setAccounts([]);
    setAuth(null);
    setServer(null);
    setEp(null);
    setError(null);
    setPhase("landing");
    stripEpFromLocation();
  }, []);

  const retry = useCallback(() => {
    // ep 已经过校验（或同源探测）才进入当前会话，重试不再二次套 checkEp
    if (ep) void startConnect(ep);
  }, [startConnect, ep]);

  // Initial endpoint resolution: ?ep= wins; then the last successful ep; then the
  // same-origin backend (the shell is often served by the report backend itself).
  useEffect(() => {
    if (autoStarted.current) return;
    autoStarted.current = true;
    if (boot) return; // 静态归档：同步引导已完成，不发起网络探测
    const fromLocation = epFromLocation();
    if (fromLocation.raw !== null) {
      if (fromLocation.checked?.ok) {
        void connect(fromLocation.checked.url!);
      } else {
        setError(fromLocation.checked?.error ?? "ep 不合法");
        setPhase("landing");
      }
      return;
    }
    const stored = loadCurrentEp();
    if (stored) {
      void connect(stored);
      return;
    }
    let alive = true;
    setEp(window.location.origin);
    void probeSameOriginEp().then((probe) => {
      if (!alive) return;
      if (probe.ok && probe.url) {
        // 同源探测已经证明它是 report 后端，直接建连（跳过 checkEp 的 http 限制）
        void startConnect(probe.url);
      } else {
        setEp(null);
        setPhase("landing");
      }
    });
    return () => {
      alive = false;
    };
  }, [boot, connect, startConnect]);

  // SSE lifecycle（静态归档没有事件流，也不做 presence 轮询）
  useEffect(() => {
    if (staticMode) return;
    if (phase !== "ready" || !client || !auth) return;
    const stream = new ReportStream(client, auth.mode, {
      onEvent: (event) => {
        for (const listener of listeners.current) listener(event);
        // presence may change when an agent posts; refresh lazily
        refreshWho();
      },
      onState: setSseState,
    });
    stream.start();
    return () => stream.stop();
  }, [phase, client, auth, refreshWho]);

  // Presence fallback: poll slowly while visible; SSE is the primary channel.
  useEffect(() => {
    if (staticMode) return;
    if (phase !== "ready" || !client) return;
    const tick = () => {
      if (document.visibilityState === "visible") refreshWho();
    };
    const timer = window.setInterval(tick, 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshWho();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [phase, client, refreshWho]);

  const sameOrigin = useMemo(() => {
    if (!ep) return false;
    try {
      return new URL(ep).origin === window.location.origin;
    } catch {
      return false;
    }
  }, [ep]);

  const value = useMemo<ConnectionValue>(
    () => ({
      phase,
      ep,
      client,
      auth,
      server,
      account,
      accounts,
      who,
      sameOrigin,
      staticMode,
      snapshot: boot?.snapshot ?? null,
      sseState,
      error,
      loginError,
      connect,
      login,
      logout,
      switchBackend,
      retry,
      refreshWho,
      subscribeEvents,
    }),
    [
      phase,
      ep,
      client,
      auth,
      server,
      account,
      accounts,
      who,
      sameOrigin,
      staticMode,
      boot,
      sseState,
      error,
      loginError,
      connect,
      login,
      logout,
      switchBackend,
      retry,
      refreshWho,
      subscribeEvents,
    ],
  );

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionValue {
  const value = useContext(ConnectionContext);
  if (!value) throw new Error("useConnection must be used inside ConnectionProvider");
  return value;
}
