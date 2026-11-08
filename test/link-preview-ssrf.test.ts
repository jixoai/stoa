import { describe, expect, test } from "bun:test";
import {
  isBlockedIPv4,
  isBlockedIp,
  normalizeIpLiteral,
  parseIPv6,
  parseTestAllowOrigins,
  resolvePinnedTarget,
  validatePreviewUrl,
  PreviewPolicyError,
} from "../src/server/preview/ssrf.ts";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof PreviewPolicyError) return err.code;
    throw err;
  }
  throw new Error("expected PreviewPolicyError");
}

describe("SSRF address matrix (report-link-preview P1-8 / design §7.2)", () => {
  test("blocks every IPv4 range in the checklist", () => {
    const blocked = [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.0.2.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
    ];
    for (const ip of blocked) expect(isBlockedIPv4(ip)).toBe(true);
    expect(isBlockedIPv4("8.8.8.8")).toBe(false);
    expect(isBlockedIPv4("1.1.1.1")).toBe(false);
  });

  test("blocks IPv6 loopback/link-local/ULA/documentation/multicast and embedded private", () => {
    const blocked = [
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "64:ff9b::7f00:1", // NAT64 127.0.0.1
      "64:ff9b::a00:1", // NAT64 10.0.0.1
      "100::1",
      "2001:db8::1",
      "2001:0000::1",
      "2002:7f00:1::", // 6to4 127.0.0.1
      "2002:a00:1::", // 6to4 10.0.0.1
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
    ];
    for (const ip of blocked) expect(isBlockedIp(ip)).toBe(true);
    expect(isBlockedIp("2606:4700::1111")).toBe(false);
    expect(isBlockedIp("2001:4860:4860::8888")).toBe(false);
    expect(isBlockedIp("::ffff:8.8.8.8")).toBe(false);
  });

  test("IPv6 parser handles compressed and embedded forms", () => {
    expect(parseIPv6("::1")).not.toBeNull();
    expect(parseIPv6("::")).toBe(0n);
    expect(parseIPv6("fe80::1")).not.toBeNull();
    expect(parseIPv6("::ffff:127.0.0.1")).not.toBeNull();
    expect(parseIPv6("not-an-ip")).toBeNull();
  });

  test("decimal/octal/hex IPv4 literals normalize before classification", () => {
    expect(normalizeIpLiteral("2130706433")).toBe("127.0.0.1");
    expect(normalizeIpLiteral("0x7f000001")).toBe("127.0.0.1");
    expect(normalizeIpLiteral("0177.0.0.1")).toBeNull(); // dotted octal forms fall through to URL parser
    expect(isBlockedIp(normalizeIpLiteral("2130706433")!)).toBe(true);
  });
});

describe("URL entry policy (per redirect hop)", () => {
  test("accepts http/https with allowed ports only", () => {
    expect(validatePreviewUrl("https://example.com/a").hostname).toBe("example.com");
    expect(validatePreviewUrl("http://example.com:8080/a", { allowedPorts: [8080] }).port).toBe("8080");
    expect(codeOf(() => validatePreviewUrl("http://example.com:8080/a"))).toBe("blocked_port");
    expect(codeOf(() => validatePreviewUrl("http://example.com:6379/"))).toBe("blocked_port");
  });

  test("rejects scheme/userinfo/single-label/internal hosts", () => {
    expect(codeOf(() => validatePreviewUrl("ftp://example.com/x"))).toBe("blocked_scheme");
    expect(codeOf(() => validatePreviewUrl("file:///etc/passwd"))).toBe("blocked_scheme");
    expect(codeOf(() => validatePreviewUrl("https://user:pass@example.com/"))).toBe("blocked_scheme");
    expect(codeOf(() => validatePreviewUrl("http://localhost/"))).toBe("blocked_private");
    expect(codeOf(() => validatePreviewUrl("http://intranet/"))).toBe("blocked_private");
    expect(codeOf(() => validatePreviewUrl("http://service.local/"))).toBe("blocked_private");
    expect(codeOf(() => validatePreviewUrl("http://x.home.arpa/"))).toBe("blocked_private");
    expect(codeOf(() => validatePreviewUrl("http://x.internal/"))).toBe("blocked_private");
  });

  test("DNS validation rejects mixed answers and pins one resolution", async () => {
    let calls = 0;
    await expect(
      resolvePinnedTarget("example.com", {
        lookup: async () => {
          calls += 1;
          return ["93.184.216.34", "10.0.0.5"];
        },
      }),
    ).rejects.toMatchObject({ code: "blocked_private" });
    expect(calls).toBe(1);

    const pinned = await resolvePinnedTarget("example.com", {
      lookup: async () => ["93.184.216.34", "2606:4700::1111"],
    });
    expect(pinned.address).toBe("93.184.216.34");
    expect(pinned.family).toBe(4);
  });

  test("no DNS answer is network; private IP literal is blocked without DNS", async () => {
    await expect(
      resolvePinnedTarget("example.com", { lookup: async () => [] }),
    ).rejects.toMatchObject({ code: "network" });
    await expect(resolvePinnedTarget("169.254.169.254")).rejects.toMatchObject({
      code: "blocked_private",
    });
    await expect(resolvePinnedTarget("[::1]")).rejects.toMatchObject({ code: "blocked_private" });
  });

  test("N13: test allow origins are exact loopback origins only", () => {
    expect(
      parseTestAllowOrigins(
        "http://127.0.0.1:5555, https://x.test, http://[::1]:6000, http://localhost:7000, http://127.0.0.2:7001",
      ),
    ).toEqual([
      "http://127.0.0.1:5555",
      "http://[::1]:6000",
      "http://localhost:7000",
      "http://127.0.0.2:7001",
    ]);
    expect(parseTestAllowOrigins("http://127.0.0.1:5555/path")).toEqual([]);
    expect(parseTestAllowOrigins("http://example.com:5555")).toEqual([]);
    expect(parseTestAllowOrigins("https://evil.test")).toEqual([]);
  });
});
