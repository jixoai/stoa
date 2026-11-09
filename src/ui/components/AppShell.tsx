import { useEffect, useLayoutEffect, useRef } from "react";
import { LockIcon } from "lucide-react";
import { DesktopNav, MobileNav } from "@/components/Nav";
import { WhoPanel } from "@/components/WhoPanel";
import { LeaveGuard } from "@/components/LeaveGuard";
import { RouteTransition } from "@/components/RouteTransition";
import { HomePage } from "@/pages/HomePage";
import { ProfilePage } from "@/pages/ProfilePage";
import { TagPage } from "@/pages/TagPage";
import { ThreadPage } from "@/pages/ThreadPage";
import { ArticlePage } from "@/pages/ArticlePage";
import { SearchPage } from "@/pages/SearchPage";
import { NotificationsPage } from "@/pages/NotificationsPage";
import { BookmarksPage } from "@/pages/BookmarksPage";
import { ComposePage } from "@/pages/ComposePage";
import { SettingsSheetProvider } from "@/components/SettingsSheet";
import { LandingPage } from "@/pages/LandingPage";
import { AccountSheet } from "@/components/AccountSheet";
import { InfoSheet } from "@/components/InfoSheet";
import {
  goBack,
  historyDepth,
  navigate,
  isRootRoute,
  RouteScopeProvider,
  routeKey,
  SharedNamesProvider,
  useRoute,
  type Route,
} from "@/lib/router";
import { useConnection } from "@/state/connection";
import { useReadDwell } from "@/components/ReadDwellProvider";

function RootView({ route }: { route: Route }) {
  switch (route.name) {
    case "search":
      return <SearchPage />;
    case "notifications":
      return <NotificationsPage />;
    case "bookmarks":
      return <BookmarksPage />;
    default:
      return <HomePage />;
  }
}

function DetailView({ route }: { route: Route }) {
  switch (route.name) {
    case "post":
      return <ThreadPage />;
    case "article":
      return <ArticlePage />;
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
  const readDwell = useReadDwell();
  const detailLayerRef = useRef<HTMLDivElement | null>(null);

  // 覆盖层（详情/实例/账号/设置/信息）不替换底层页面：打开期间底层根页与详情页
  // 都保持挂载（滚动/草稿/附件/节点状态不丢），关闭后原样返回。
  const overlayRoute =
    route.name === "instances" ||
    route.name === "account" ||
    route.name === "settings" ||
    route.name === "info";
  const lastBase = useRef<Route>(
    isRootRoute(route) ? route : { name: "home", tab: "recommended" },
  );
  if (!overlayRoute) lastBase.current = route;
  const baseRoute = overlayRoute ? lastBase.current : route;
  const lastRoot = useRef<Route>(
    isRootRoute(baseRoute) ? baseRoute : { name: "home", tab: "recommended" },
  );
  if (isRootRoute(baseRoute)) lastRoot.current = baseRoute;
  const rootRoute = isRootRoute(baseRoute) ? baseRoute : lastRoot.current;
  const detail = !isRootRoute(baseRoute);
  // 一次打开只允许一次回退：双击 Esc/返回不能吃掉 LeaveGuard 的合成条目。
  const closingFor = useRef<string | null>(null);
  useEffect(() => {
    closingFor.current = null;
  }, [route.name]);
  const closeOverlayRoute = () => {
    if (!overlayRoute || closingFor.current === route.name) return;
    closingFor.current = route.name;
    goBack();
  };

  // 信息/账号面板是移动端形态（内容 xl:hidden）：桌面直开会留下不可见 sheet/遮罩，
  // 回退一层（窄屏保持正常打开）。
  useEffect(() => {
    if (route.name !== "info" && route.name !== "account") return;
    if (window.matchMedia("(min-width: 1280px)").matches) goBack();
  }, [route.name]);

  // 实例管理是全屏层：被完全遮挡的 feed 不得继续停留计时（否则静默标已读）。
  useLayoutEffect(() => {
    if (route.name !== "instances") return;
    readDwell.hold("route-instances");
    return () => readDwell.release("route-instances");
  }, [route.name, readDwell]);

  // 覆盖层只做视觉覆盖（IO 不能感知遮挡）：详情打开时暂停「覆盖层之外」的
  // 停留计时，覆盖层内部的卡片继续正常计时。layout effect 在首帧 IO 回调前生效。
  useLayoutEffect(() => {
    if (!detail) return;
    const layer = detailLayerRef.current;
    if (!layer) return;
    readDwell.hold("route-detail", layer);
    return () => readDwell.release("route-detail");
  }, [detail, readDwell]);

  return (
    <SettingsSheetProvider>
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
          <RouteTransition
            routeKey={routeKey(rootRoute)}
            kind="root"
            testId="app-root-view"
          >
            <RouteScopeProvider route={rootRoute}>
              <SharedNamesProvider active={!detail}>
                <RootView route={rootRoute} />
              </SharedNamesProvider>
            </RouteScopeProvider>
          </RouteTransition>

          {detail ? (
            <div ref={detailLayerRef} data-testid="app-detail-layer" className="contents">
              <RouteTransition
                routeKey={routeKey(baseRoute)}
                kind="detail"
                testId="app-detail-view"
                className="absolute inset-0 z-30 bg-background"
              >
                <RouteScopeProvider route={baseRoute}>
                  <SharedNamesProvider active>
                    {/* 子页按路由键重建：A→B 的第二次导航必须是全新实例，
                        否则转场快照会拍到上一页的 state（数据要等 effect 才换）。 */}
                    <DetailView key={routeKey(baseRoute)} route={baseRoute} />
                  </SharedNamesProvider>
                </RouteScopeProvider>
              </RouteTransition>
            </div>
          ) : null}
        </main>
        <aside className="hidden w-[320px] shrink-0 border-l border-border/50 xl:block">
          <WhoPanel />
        </aside>
      </div>
      <MobileNav />
      <LeaveGuard active={!detail && historyDepth() === 0} routeKey={routeKey(route)} />
      </div>
      {route.name === "account" ? (
        <AccountSheet
          open
          onOpenChange={(open) => {
            if (!open) closeOverlayRoute();
          }}
          onOpenInfo={() => navigate("/info", true)}
        />
      ) : null}
      {route.name === "info" ? (
        <InfoSheet
          open
          onOpenChange={(open) => {
            if (!open) closeOverlayRoute();
          }}
        />
      ) : null}
      {route.name === "instances" ? (
        <div
          className="fixed inset-0 z-50 bg-background"
          data-testid="instance-route-layer"
        >
          <LandingPage onBack={closeOverlayRoute} />
        </div>
      ) : null}
    </SettingsSheetProvider>
  );
}
