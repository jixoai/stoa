/**
 * stoa-stopped-preview S4-1 的行渲染断言（SSR，无浏览器）：
 *   - stopped 行出现「生成预览」真 `<a>` 直链 `/preview/<id>/`（daemon 同源）；
 *   - 所有 stopped 行都给入口（design v2 §2 / 评审 F8）：含 ephemeral 被降级的临时行
 *     （干净停止的临时行会连登记一起消失，不以 `ephemeral` 一刀切藏掉可用功能）；
 *   - running 行的主操作仍是「打开」，不出现行内预览按钮。
 *
 * 注：running 行 ⋯ 菜单里的 `daemon-preview-menu-<id>` 走 base-ui Portal，SSR 不产出
 * 弹层内容，由真机 QA（tasks S4-2 / scripts/qa/stoa-daemon.mjs）覆盖。
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ServiceRow, type DaemonService } from "../src/ui/pages/DaemonConsolePage.tsx";

const ID = "svc-test01";

function service(overrides: Partial<DaemonService> = {}): DaemonService {
  return {
    id: ID,
    name: "board",
    dataDir: `/tmp/${ID}`,
    port: 13680,
    pid: null,
    url: null,
    log: null,
    startedAt: 1,
    status: "stopped",
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
      onCopyPath={() => undefined}
    />,
  );
}

describe("daemon console preview entry (S4-1)", () => {
  test("stopped row offers a real anchor to /preview/<id>/", () => {
    const html = renderRow({ status: "stopped" });
    expect(html).toContain(`data-testid="daemon-preview-${ID}"`);
    expect(html).toContain(`href="/preview/${ID}/"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain("静态快照 · 只读 · 首次生成后自动缓存");
    expect(html).toContain("生成预览");
  });

  test("stopped ephemeral row (degraded by reconcile) still offers the preview entry", () => {
    const html = renderRow({ status: "stopped", ephemeral: true, location: "temp" });
    expect(html).toContain(`data-testid="daemon-preview-${ID}"`);
    expect(html).toContain(`href="/preview/${ID}/"`);
    expect(html).toContain("生成预览");
  });

  test("row addresses instances by /i/<slug>/ (single port) and lists custom hostnames", () => {
    const html = renderRow({
      status: "running",
      pid: 4242,
      slug: "board",
      port: null,
      hostnames: ["board.localhost"],
      url: "http://127.0.0.1:13679/i/board/",
    });
    expect(html).toContain("/i/board/");
    expect(html).toContain("board.localhost");
    // daemon 托管实例不占 TCP：没有端口 chip
    expect(html).not.toContain("端口");
  });

  test("running row keeps 打开 as primary action and keeps the inline preview off", () => {
    const html = renderRow({
      status: "running",
      pid: 4242,
      url: "http://127.0.0.1:13680",
    });
    expect(html).toContain(`data-testid="daemon-open-${ID}"`);
    expect(html).not.toContain(`data-testid="daemon-preview-${ID}"`);
  });
});
