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
import {
  checkEp,
  clearCurrentEp,
  clearToken,
  epFromLocation,
  loadCurrentEp,
  loadToken,
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
  const [phase, setPhase] = useState<ConnectionPhase>("connecting");
  const [ep, setEp] = useState<string | null>(null);
  const [client, setClient] = useState<ReportClient | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [account, setAccount] = useState<ConnectionValue["account"]>(null);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [who, setWho] = useState<WhoRow[]>([]);
  const [sseState, setSseState] = useState<SseState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);

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
      saveCurrentEp(current.base);
      rememberEp(current.base);
      setEp(current.base);
      setClient(current);
      setPhase("ready");
      setError(null);
      setLoginError(null);
    },
    [],
  );

  const connect = useCallback(
    async (rawUrl: string) => {
      const checked = checkEp(rawUrl);
      if (!checked.ok) {
        setError(checked.error ?? "后端地址不合法");
        setPhase("landing");
        return;
      }
      const url = checked.url!;
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
    if (ep) void connect(ep);
  }, [connect, ep]);

  // Initial endpoint resolution: ?ep= wins; otherwise the last successful ep.
  useEffect(() => {
    if (autoStarted.current) return;
    autoStarted.current = true;
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
    if (stored) void connect(stored);
    else setPhase("landing");
  }, [connect]);

  // SSE lifecycle
  useEffect(() => {
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
