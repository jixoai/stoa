import { Loader2Icon, ServerCrashIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Toaster } from "@/components/ui/toast";
import { ConnectionProvider, useConnection } from "@/state/connection";
import { EventHubProvider } from "@/state/hub/provider";
import { PluginsProvider } from "@/state/plugins";
import { PostPreviewsProvider } from "@/state/post-previews";
import { HomeFeedsProvider } from "@/state/feed";
import { NotificationsProvider } from "@/state/notifications";
import { ReadDwellProvider } from "@/components/ReadDwellProvider";
import { BookmarksProvider } from "@/state/bookmarks";
import { LandingPage } from "@/pages/LandingPage";
import { LoginGate } from "@/pages/LoginGate";
import { AppShell } from "@/components/AppShell";

function ConnectingScreen() {
  const { ep } = useConnection();
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
      <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      <div className="text-sm text-muted-foreground">正在连接 {ep ?? "后端"}…</div>
    </div>
  );
}

function ErrorScreen() {
  const { ep, error, retry, switchBackend } = useConnection();
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-md">
        <Alert variant="destructive">
          <ServerCrashIcon />
          <AlertTitle>连接失败</AlertTitle>
          <AlertDescription className="flex flex-col gap-3">
            <span className="break-all">{error}</span>
            <span className="break-all font-mono text-xs text-muted-foreground">{ep}</span>
            <span className="flex gap-2">
              <Button size="sm" variant="outline" onClick={retry}>
                重试
              </Button>
              <Button size="sm" variant="ghost" onClick={switchBackend}>
                换一个后端
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      </div>
    </div>
  );
}

function ReadyApp() {
  return (
    <HomeFeedsProvider>
      <BookmarksProvider>
        <NotificationsProvider>
          <ReadDwellProvider>
            <AppShell />
          </ReadDwellProvider>
        </NotificationsProvider>
      </BookmarksProvider>
    </HomeFeedsProvider>
  );
}

function PhaseView() {
  const { phase } = useConnection();
  if (phase === "connecting") return <ConnectingScreen />;
  if (phase === "landing") return <LandingPage />;
  if (phase === "login") return <LoginGate />;
  if (phase === "error") return <ErrorScreen />;
  return <ReadyApp />;
}

/**
 * EventHub 边界：实时层只在「已验证连接且非静态归档」时建立；登录/落地/错误页
 * 不建流（静态归档 0 条 EventSource，design §4.9）。
 */
function EventHubBoundary() {
  const { phase, client, auth, account, staticMode } = useConnection();
  return (
    <EventHubProvider
      client={phase === "ready" ? client : null}
      authMode={auth?.mode ?? "open"}
      accountId={account?.id ?? null}
      staticMode={staticMode}
    >
      <PluginsProvider>
        <PostPreviewsProvider>
          <PhaseView />
        </PostPreviewsProvider>
      </PluginsProvider>
    </EventHubProvider>
  );
}

export function App() {
  return (
    <Toaster>
      <ConnectionProvider>
        <EventHubBoundary />
      </ConnectionProvider>
    </Toaster>
  );
}
