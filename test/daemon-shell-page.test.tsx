/**
 * 壳页与控制台入口的 SSR 断言（daemon-unified-port S4-2/S4-3）：
 *   - `/shell` 壳页：全屏 iframe 指向 `/i/<slug>/`，右下浮动小球（可聚焦 button + aria-label）；
 *   - 控制台「打开」与行内本地入口都指向 `/shell/<slug>`（不再带 `#key=`）。
 *
 * 菜单弹层走 base-ui Portal，SSR 不产出内容（同 daemon-console-preview 注），由真机 QA 覆盖。
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DaemonShellPage, type ShellBoot } from "../src/ui/pages/DaemonShellPage.tsx";
import { ServiceRow, type DaemonService } from "../src/ui/pages/DaemonConsolePage.tsx";

const boot: ShellBoot = {
  current: {
    id: "svc-1",
    slug: "board",
    name: "Board One",
    status: "running",
    iframeUrl: "/i/board/",
  },
  instances: [
    { id: "svc-1", slug: "board", name: "Board One", status: "running", iframeUrl: "/i/board/" },
    { id: "svc-2", slug: "other", name: "Other", status: "running", iframeUrl: "/i/other/" },
  ],
};

describe("壳页 SSR", () => {
  test("全屏 iframe 指向实例路径，浮动小球可聚焦且有 aria-label", () => {
    const html = renderToStaticMarkup(<DaemonShellPage boot={boot} />);
    expect(html).toContain('src="/i/board/"');
    expect(html).toContain('data-testid="daemon-shell-frame"');
    expect(html).toContain('data-testid="daemon-shell-ball"');
    expect(html).toContain('aria-label="daemon 快捷菜单"');
    // 壳页不落任何实例凭据
    expect(html).not.toContain("STOA_TOKEN");
    expect(html).not.toContain("#key=");
  });
});

function service(overrides: Partial<DaemonService> = {}): DaemonService {
  return {
    id: "svc-1",
    name: "Board One",
    slug: "board",
    hostnames: [],
    dataDir: "/tmp/svc-1",
    port: null,
    pid: null,
    url: "/i/board/",
    log: null,
    startedAt: 1,
    status: "running",
    ...overrides,
  };
}

function renderRow(overrides: Partial<DaemonService> = {}): string {
  return renderToStaticMarkup(
    <ServiceRow
      service={service(overrides)}
      busy={false}
      onOpen={() => undefined}
      onSecret={() => undefined}
      onStop={() => undefined}
      onRemove={() => undefined}
    />,
  );
}

describe("控制台入口（S4-3）", () => {
  test("「打开」与本地入口都指向 /shell/<slug>，不附 #key", () => {
    const html = renderRow();
    expect(html).toContain('data-testid="daemon-open-svc-1"');
    expect(html).toContain('href="/shell/board"');
    expect(html).toContain('data-testid="daemon-entry-local-svc-1"');
    expect(html).not.toContain("#key=");
  });
});
