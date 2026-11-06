import { useRef } from "react";
import { LockIcon } from "lucide-react";
import { DesktopNav, MobileNav } from "@/components/Nav";
import { WhoPanel } from "@/components/WhoPanel";
import { LeaveGuard } from "@/components/LeaveGuard";
import { RouteTransition } from "@/components/RouteTransition";
import { HomePage } from "@/pages/HomePage";
import { ProfilePage } from "@/pages/ProfilePage";
import { TagPage } from "@/pages/TagPage";
import { ThreadPage } from "@/pages/ThreadPage";
import { SearchPage } from "@/pages/SearchPage";
import { NotificationsPage } from "@/pages/NotificationsPage";
import { ComposePage } from "@/pages/ComposePage";
import {
  historyDepth,
  isRootRoute,
  RouteScopeProvider,
  routeKey,
  SharedNamesProvider,
  useRoute,
  type Route,
} from "@/lib/router";
import { useConnection } from "@/state/connection";

function RootView({ route }: { route: Route }) {
  switch (route.name) {
    case "search":
      return <SearchPage />;
    case "notifications":
      return <NotificationsPage />;
    default:
      return <HomePage />;
  }
}

function DetailView({ route }: { route: Route }) {
  switch (route.name) {
    case "post":
      return <ThreadPage />;
    case "profile":
      return <ProfilePage />;
    case "tag":
      return <TagPage />;
    case "compose":
      return <ComposePage />;
    default:
      return null;
  }
}

/** 宽屏三栏（左导航 / 中列 / 右侧成员），窄屏单列 + 底部四导航。无 DM。 */
export function AppShell() {
  const { staticMode, snapshot } = useConnection();
  const route = useRoute();

  // 详情/成员/标签/发帖箱以覆盖层出现；底层根页保持挂载（列表节点与滚动位置不丢）。
  const lastRoot = useRef<Route>(
    isRootRoute(route) ? route : { name: "home", tab: "recommended" },
  );
  if (isRootRoute(route)) lastRoot.current = route;
  const rootRoute = isRootRoute(route) ? route : lastRoot.current;
  const detail = !isRootRoute(route);

  return (
    <div className="mx-auto flex h-dvh w-full max-w-[1280px] flex-col">
      {staticMode ? (
        <div
          data-testid="static-banner"
          className="flex h-7 shrink-0 items-center justify-center gap-2 border-b border-border/60 bg-muted/70 px-3 text-[11px] text-muted-foreground"
        >
          <LockIcon className="size-3" aria-hidden />
          <span>静态归档 · 只读</span>
          {snapshot ? (
            <span className="text-muted-foreground/70">as_of #{snapshot.asOfSeq}</span>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 justify-center">
        <DesktopNav />
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col lg:max-w-[640px]">
          <RouteTransition routeKey={routeKey(rootRoute)} kind="root">
            <RouteScopeProvider route={rootRoute}>
              <SharedNamesProvider active={!detail}>
                <RootView route={rootRoute} />
              </SharedNamesProvider>
            </RouteScopeProvider>
          </RouteTransition>

          {detail ? (
            <RouteTransition
              routeKey={routeKey(route)}
              kind="detail"
              className="absolute inset-0 z-30 bg-background"
            >
              <SharedNamesProvider active>
                {/* 子页按路由键重建：A→B 的第二次导航必须是全新实例，
                    否则转场快照会拍到上一页的 state（数据要等 effect 才换）。 */}
                <DetailView key={routeKey(route)} route={route} />
              </SharedNamesProvider>
            </RouteTransition>
          ) : null}
        </main>
        <aside className="hidden w-[320px] shrink-0 border-l border-border/50 xl:block">
          <WhoPanel />
        </aside>
      </div>
      <MobileNav />
      <LeaveGuard active={!detail && historyDepth() === 0} routeKey={routeKey(route)} />
    </div>
  );
}
