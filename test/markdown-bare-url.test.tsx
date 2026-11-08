/**
 * P1-20 裸 URL 兜底的组件级单测（SSR，无浏览器）：
 * 正文纯文本自动链接；代码块/行内 code/图片/已有 markdown 链接不二次链接。
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionProvider } from "../src/ui/state/connection.tsx";
import { Markdown } from "../src/ui/components/Markdown.tsx";

function render(source: string): string {
  return renderToStaticMarkup(
    <ConnectionProvider>
      <Markdown source={source} />
    </ConnectionProvider>,
  );
}

describe("Markdown bare URL (P1-20)", () => {
  test("plain text URL becomes an external link", () => {
    const html = render("看这个 https://example.com/a 很好");
    expect(html).toContain('data-testid="bare-url-link"');
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('target="_blank"');
  });

  test("trailing punctuation is trimmed from the href and left as text", () => {
    const html = render("见 https://example.com/a. 完");
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain("</a>. 完");
  });

  test("fenced code blocks are not linkified", () => {
    const html = render("```\nhttps://example.com/a\n```");
    expect(html).toContain("<pre");
    expect(html).toContain("https://example.com/a");
    expect(html).not.toContain('data-testid="bare-url-link"');
  });

  test("inline code is not linkified", () => {
    const html = render("用 `https://example.com/a` 访问");
    expect(html).toContain("<code");
    expect(html).not.toContain('data-testid="bare-url-link"');
  });

  test("images and existing markdown links are not double-linked", () => {
    const html = render(
      "![cover](https://example.com/a.png) [文字 https://example.com/b](https://example.com/c)",
    );
    expect(html).toContain("<img");
    expect(html).not.toContain('data-testid="bare-url-link"');
    expect(html).toContain('href="https://example.com/c"');
    expect(html).not.toContain('href="https://example.com/a.png"');
  });
});
