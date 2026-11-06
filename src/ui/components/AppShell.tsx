import { DesktopNav, MobileNav } from "@/components/Nav";
import { WhoPanel } from "@/components/WhoPanel";
import { HomePage } from "@/pages/HomePage";
import { ProfilePage } from "@/pages/ProfilePage";
import { TagPage } from "@/pages/TagPage";
import { ThreadPage } from "@/pages/ThreadPage";
import { SearchPage } from "@/pages/SearchPage";
import { NotificationsPage } from "@/pages/NotificationsPage";
import { ComposePage } from "@/pages/ComposePage";
import { useRoute } from "@/lib/router";

function RouteView() {
  const route = useRoute();
  switch (route.name) {
    case "post":
      return <ThreadPage />;
    case "profile":
      return <ProfilePage />;
    case "tag":
      return <TagPage />;
    case "search":
      return <SearchPage />;
    case "notifications":
      return <NotificationsPage />;
    case "compose":
      return <ComposePage />;
    default:
      return <HomePage />;
  }
}

/** 宽屏三栏（左导航 / 中列 / 右侧成员），窄屏单列 + 底部四导航。无 DM。 */
export function AppShell() {
  return (
    <div className="mx-auto flex h-dvh w-full max-w-[1280px] justify-center">
      <DesktopNav />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col pb-14 lg:max-w-[640px] lg:pb-0">
        <RouteView />
      </main>
      <aside className="hidden w-[320px] shrink-0 border-l border-border/50 xl:block">
        <WhoPanel />
      </aside>
      <MobileNav />
    </div>
  );
}
