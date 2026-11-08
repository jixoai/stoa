import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import {
  HttpPreviewTransport,
  MAX_PAGE_BYTES,
  PREVIEW_USER_AGENT,
  PreviewFetchError,
} from "../src/server/preview/fetch.ts";

const HTML = "<!doctype html><html><head><title>Fixture</title></head><body><p>hello</p></body></html>";
const hits = { page: 0, secret: 0, slow: 0, headers: [] as Array<Record<string, string>> };

let main: Server<undefined>;
let secret: Server<undefined>;
let ipv6: Server<undefined>;
let mainOrigin = "";
let secretOrigin = "";
let ipv6Origin = "";
const ipv6Hosts: string[] = [];

beforeAll(() => {
  secret = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      hits.secret += 1;
      return new Response("secret", { headers: { "content-type": "text/plain" } });
    },
  });
  secretOrigin = `http://127.0.0.1:${secret.port}`;
  main = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 30,
    fetch: (req) => {
      const url = new URL(req.url);
      const headerRecord: Record<string, string> = {};
      req.headers.forEach((value, name) => {
        headerRecord[name] = value;
      });
      hits.headers.push(headerRecord);
      const path = url.pathname;
      if (path === "/page") {
        hits.page += 1;
        return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (path === "/head405") {
        if (req.method === "HEAD") return new Response(null, { status: 405 });
        return new Response(HTML, { headers: { "content-type": "text/html" } });
      }
      if (path === "/no-content-type") {
        return new Response(HTML, { headers: { "content-type": "" } });
      }
      if (path === "/redirect") {
        return Response.redirect(new URL("/page", req.url).toString(), 302);
      }
      if (path === "/to-private") {
        return Response.redirect(`${secretOrigin}/secret`, 302);
      }
      if (path === "/slow") {
        hits.slow += 1;
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response("late")), 30_000);
        });
      }
      if (path === "/huge") {
        return new Response(new Uint8Array(5 * 1024 * 1024), {
          headers: { "content-type": "text/html", "content-length": String(5 * 1024 * 1024) },
        });
      }
      if (path === "/gzip") {
        return new Response("compressed", {
          headers: { "content-type": "text/html", "content-encoding": "gzip" },
        });
      }
      if (path === "/br") {
        return new Response("compressed", {
          headers: { "content-type": "text/html", "content-encoding": "br" },
        });
      }
      if (path.startsWith("/loop")) {
        const n = Number(url.searchParams.get("n") ?? "0");
        return Response.redirect(new URL(`/loop?n=${n + 1}`, req.url).toString(), 302);
      }
      return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    },
  });
  mainOrigin = `http://127.0.0.1:${main.port}`;
  ipv6 = Bun.serve({
    hostname: "::1",
    port: 0,
    fetch: (req) => {
      ipv6Hosts.push(req.headers.get("host") ?? "");
      return new Response(HTML, { headers: { "content-type": "text/html" } });
    },
  });
  ipv6Origin = `http://[::1]:${ipv6.port}`;
});

afterAll(() => {
  main?.stop(true);
  secret?.stop(true);
  ipv6?.stop(true);
});

function transport(origins: string[] = [mainOrigin]): HttpPreviewTransport {
  return new HttpPreviewTransport({
    testAllowOrigins: origins,
    rateLimiter: null,
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof PreviewFetchError) return err.code;
    throw err;
  }
  throw new Error("expected PreviewFetchError");
}

describe("bounded preview fetch (report-link-preview P1-9)", () => {
  test("HEAD success + GET page share the same request headers (no cookies/auth/referer)", async () => {
    const client = transport();
    const head = await client.head(`${mainOrigin}/page`);
    expect(head.status).toBe(200);
    expect(head.headers["content-type"]).toContain("text/html");
    expect(head.body).toBeNull();
    const page = await client.page(`${mainOrigin}/page`);
    expect(page.status).toBe(200);
    expect(new TextDecoder().decode(page.body!)).toContain("Fixture");
    expect(page.final_url).toBe(`${mainOrigin}/page`);

    const headers = hits.headers.at(-1)!;
    expect(headers["accept-encoding"]).toBe("identity");
    expect(headers["user-agent"]).toBe(PREVIEW_USER_AGENT);
    expect(headers["cookie"]).toBeUndefined();
    expect(headers["authorization"]).toBeUndefined();
    expect(headers["referer"]).toBeUndefined();
  });

  test("HEAD 405 / missing content-type falls back to GET", async () => {
    const client = transport();
    const fallback = await client.head(`${mainOrigin}/head405`);
    expect(fallback.status).toBe(200);
    expect(new TextDecoder().decode(fallback.body!)).toContain("Fixture");
    const noCt = await client.head(`${mainOrigin}/no-content-type`);
    expect(noCt.status).toBe(200);
    expect(noCt.body).not.toBeNull();
  });

  test("follows redirects and reports the final URL", async () => {
    const client = transport();
    const page = await client.page(`${mainOrigin}/redirect`);
    expect(page.status).toBe(200);
    expect(page.final_url).toBe(`${mainOrigin}/page`);
  });

  test("redirect to a private origin is rejected and never requested", async () => {
    const client = transport();
    expect(await codeOf(client.page(`${mainOrigin}/to-private`))).toBe("blocked_private");
    expect(hits.secret).toBe(0);
  });

  test("too many redirects is rejected", async () => {
    const client = transport();
    expect(await codeOf(client.page(`${mainOrigin}/loop?n=0`))).toBe("too_many_redirects");
  });

  test("declared size over 2MiB is blocked before reading", async () => {
    const client = transport();
    expect(await codeOf(client.page(`${mainOrigin}/huge`))).toBe("blocked_size");
  });

  test("N9: IPv6 literal Host header is bracketed", async () => {
    const client = transport([ipv6Origin]);
    const page = await client.page(`${ipv6Origin}/`);
    expect(page.status).toBe(200);
    expect(ipv6Hosts.at(-1)).toBe(`[::1]:${ipv6.port}`);
  });

  test("N2: gzip/br response encodings are rejected as unsupported", async () => {
    const client = transport();
    expect(await codeOf(client.page(`${mainOrigin}/gzip`))).toBe("unsupported");
    expect(await codeOf(client.page(`${mainOrigin}/br`))).toBe("unsupported");
  });

  test("deadline aborts a slow response", async () => {
    const client = transport();
    const started = Date.now();
    expect(
      await codeOf(
        client.page(`${mainOrigin}/slow`, { deadlineAt: Date.now() + 300 }),
      ),
    ).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("404 maps to http_error and probe reads a bounded prefix", async () => {
    const client = transport();
    expect(await codeOf(client.page(`${mainOrigin}/missing`))).toBe("http_error");
    const probe = await client.probe(`${mainOrigin}/page`);
    expect(probe.status).toBe(200);
    expect((probe.body?.byteLength ?? 0) <= MAX_PAGE_BYTES).toBe(true);
  });

  test("non-allowlisted origins run the full SSRF policy (no DNS bypass)", async () => {
    const client = transport();
    expect(await codeOf(client.page("http://169.254.169.254/"))).toBe("blocked_private");
    expect(await codeOf(client.page("http://127.0.0.1:1/"))).toBe("blocked_private");
    expect(await codeOf(client.page("http://example.com:6379/"))).toBe("blocked_port");
  });
});
