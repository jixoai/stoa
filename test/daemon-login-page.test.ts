/**
 * 登录回跳安全（实现复核建议 #2）：`next` 只接受站内绝对路径，
 * 反斜杠/控制字符会被 URL 规范化成站外地址，必须拒绝。
 */
import { describe, expect, test } from "bun:test";
import { safeNextPath } from "../src/ui/pages/DaemonLoginPage.tsx";

describe("safeNextPath", () => {
  test("站内路径保留（含 query）", () => {
    expect(safeNextPath("/shell/board")).toBe("/shell/board");
    expect(safeNextPath("/i/board/?x=1")).toBe("/i/board/?x=1");
    expect(safeNextPath("/")).toBe("/");
  });

  test("协议相对/站外/反斜杠/控制字符一律回根", () => {
    expect(safeNextPath("//evil.com")).toBe("/");
    expect(safeNextPath("https://evil.com")).toBe("/");
    expect(safeNextPath("/\\evil.com")).toBe("/");
    expect(safeNextPath("/a\\b")).toBe("/");
    expect(safeNextPath("/a\u0000b")).toBe("/");
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath(null)).toBe("/");
  });

  test("不回到 /login 自身（避免循环）", () => {
    expect(safeNextPath("/login")).toBe("/");
    expect(safeNextPath("/login?next=%2F")).toBe("/");
  });
});
