/**
 * Structural guard for the dsh UI plugin surface.
 *
 * Loads `client.js` with a stub `window.__ModuleLoader__` and asserts the
 * registration shape dsh 0.2.2-rc.1 expects, then checks the bundle patch,
 * manifest, locale resources, and icon so a release cannot silently drop them.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const readJson = (path: string): Record<string, unknown> => JSON.parse(read(path)) as Record<string, unknown>;

interface LoaderDescriptor {
  id: string;
  factory: (require: (id: string) => unknown) => unknown;
}

interface ElementNode {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
}

interface ClientPlugin {
  inject: readonly string[];
  apply: (ctx: unknown) => void;
}

interface Registration {
  options: Record<string, unknown>;
  component: (props: Record<string, unknown>) => unknown;
}

function loadClientModule(): { source: string; descriptor: LoaderDescriptor } {
  const source = read("client.js");
  const loaded: LoaderDescriptor[] = [];
  const fakeWindow = {
    __ModuleLoader__: {
      load(descriptor: LoaderDescriptor): void {
        loaded.push(descriptor);
      },
    },
  };
  const evaluate = new Function("window", source) as (target: unknown) => void;
  evaluate(fakeWindow);
  expect(loaded).toHaveLength(1);
  const descriptor = loaded[0];
  if (descriptor === undefined) throw new Error("client.js registered no module");
  return { source, descriptor };
}

const reactStub = {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): ElementNode {
    return { type, props: props ?? {}, children };
  },
  useState<T>(initial: T): readonly [T, () => void] {
    return [initial, () => undefined] as const;
  },
  useEffect(): void {},
  useCallback<T>(fn: T): T {
    return fn;
  },
};

function requireStub(id: string): unknown {
  if (id === "react") return reactStub;
  throw new Error(`client.js requested an undeclared module: ${id}`);
}

interface FakeContext {
  ctx: unknown;
  registrations: Registration[];
  effects: string[];
  dictionaries: Record<string, Record<string, Record<string, string>>>;
}

function createFakeContext(): FakeContext {
  const registrations: Registration[] = [];
  const effects: string[] = [];
  const dictionaries: Record<string, Record<string, Record<string, string>>> = {};
  const ctx = {
    effect(run: () => unknown, label?: string): unknown {
      effects.push(label ?? "");
      return run();
    },
    locale: {
      register(namespace: string, dicts: Record<string, Record<string, string>>): () => void {
        dictionaries[namespace] = dicts;
        return () => undefined;
      },
      bind(namespace: string): (key: string, params?: Record<string, unknown>) => string {
        return (key, params) => {
          const template = dictionaries[namespace]?.zh?.[key] ?? key;
          if (params === undefined) return template;
          return template.replace(/\{(\w+)\}/g, (match, name: string) => (
            params[name] === undefined ? match : String(params[name])
          ));
        };
      },
    },
    slots: {
      inject(_name: string, run: () => unknown): unknown {
        return run();
      },
      register(options: Record<string, unknown>, component: Registration["component"]): () => void {
        registrations.push({ options, component });
        return () => undefined;
      },
    },
    layout: {
      panelInfo: { getSnapshot: () => ({ activePanelId: null }) },
      selectPanel: (): void => undefined,
    },
    get: (): undefined => undefined,
  };
  return { ctx, registrations, effects, dictionaries };
}

function findRegistration(registrations: Registration[], name: string): Registration {
  const found = registrations.find(entry => entry.options.name === name);
  if (found === undefined) throw new Error(`no registration for slot ${name}`);
  return found;
}

describe("dsh client module", () => {
  test("registers one module whose id is the package name", () => {
    const { descriptor } = loadClientModule();
    expect(descriptor.id).toBe("@jixoai/stoa");
    expect(typeof descriptor.factory).toBe("function");
  });

  test("factory returns the cordis plugin shape with the services it uses", () => {
    const { descriptor } = loadClientModule();
    const plugin = descriptor.factory(requireStub) as ClientPlugin;
    expect(typeof plugin.apply).toBe("function");
    expect(plugin.inject).toEqual(["slots", "locale", "layout"]);
  });

  test("apply registers the locale dictionaries, the main panel, and the sidebar entry", () => {
    const { descriptor } = loadClientModule();
    const plugin = descriptor.factory(requireStub) as ClientPlugin;
    const fake = createFakeContext();
    plugin.apply(fake.ctx);

    expect(fake.effects).toEqual(["stoa: dictionaries", "stoa: daemon panel", "stoa: sidebar entry"]);
    expect(fake.registrations).toHaveLength(2);

    const panel = findRegistration(fake.registrations, "main");
    expect(panel.options.key).toBe("stoa-daemon");
    expect(panel.options.locale).toBe("stoa.daemon");
    expect(typeof panel.component).toBe("function");

    const entry = findRegistration(fake.registrations, "sidebar.panellist");
    expect(entry.options.id).toBe("stoa-daemon");
    expect(entry.options.order).toBe(20);
    expect(entry.options.locale).toBe("stoa.daemon");
    expect(typeof entry.options.label).toBe("function");
    expect((entry.options.label as () => string)()).toBe("Stoa Daemon 控制台");

    const icon = entry.component({ size: 18 }) as ElementNode;
    expect(icon.type).toBe("svg");
    expect(icon.props.width).toBe(18);
    expect(icon.props.height).toBe(18);
    expect(icon.props.stroke).toBe("currentColor");
    expect(icon.props["aria-hidden"]).toBe(true);
    expect(icon.children).toHaveLength(4);
  });

  test("zh and en dictionaries carry identical keys and the visible copy", () => {
    const { descriptor } = loadClientModule();
    const plugin = descriptor.factory(requireStub) as ClientPlugin;
    const fake = createFakeContext();
    plugin.apply(fake.ctx);

    const dictionaries = fake.dictionaries["stoa.daemon"];
    expect(dictionaries).toBeDefined();
    const zh = dictionaries?.zh ?? {};
    const en = dictionaries?.en ?? {};
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const key of [
      "panel.label",
      "panel.probing.title",
      "panel.opening.title",
      "panel.down.title",
      "panel.down.body",
      "panel.blocked.title",
      "panel.blocked.body",
      "panel.blocked.no-sidebar",
      "panel.blocked.no-session",
      "panel.blocked.open-failed",
      "panel.action.retry",
      "panel.action.browser",
      "panel.action.conversation",
    ]) {
      expect(zh[key]).toBeString();
      expect(en[key]).toBeString();
    }
  });

  test("open flow uses the verified dsh contract", () => {
    const { source } = loadClientModule();
    // Right-sidebar built-in browser (ui-sidebar-browser README:43).
    expect(source).toContain("openTab('browser', { params: { url } })");
    // Returning to the conversation restores sidebarRight.mounted (README:103).
    expect(source).toContain("selectPanel(null)");
    // Daemon probe: documented default plus the documented port band.
    expect(source).toContain("http://127.0.0.1:13679");
    expect(source).toContain("/healthz");
    expect(source).toContain("mode: 'no-cors'");
    expect(source).toContain("DAEMON_PORT_BAND");
    // Explicit fallback, never silent.
    expect(source).toContain("window.open(url, '_blank', 'noopener')");
    // No application-root replacement or foreign DOM access.
    expect(source).not.toContain("document.body");
    expect(source).not.toContain("querySelector");
  });
});

describe("bundle patch", () => {
  test("keeps the MCP client row and adds the package's own UI row in one insert list", () => {
    const patch = read("cordis.patch.yml");
    expect(patch).toContain("- insert:");
    expect(patch).toContain("id: stoa-mcp");
    expect(patch).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(patch).toContain("serverName: stoa");
    expect(patch).toContain("STOA_BASE_URL");
    expect(patch).toContain("id: stoa-daemon-ui");
    expect(patch).toContain("name: '@jixoai/stoa'");
    // Both rows live under the same insert list, so enabling the bundle wires both faces.
    const insertAt = patch.indexOf("- insert:");
    const mcpAt = patch.indexOf("id: stoa-mcp");
    const uiAt = patch.indexOf("id: stoa-daemon-ui");
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(mcpAt).toBeGreaterThan(insertAt);
    expect(uiAt).toBeGreaterThan(mcpAt);
    expect(patch.slice(insertAt, uiAt)).not.toContain("\n- ");
  });
});

describe("package manifest", () => {
  const pkg = readJson("package.json");
  const dsh = pkg.dsh as Record<string, unknown>;
  const bundle = dsh.bundle as Record<string, unknown>;
  const client = dsh.client as Record<string, unknown>;
  const exportsMap = pkg.exports as Record<string, string>;
  const files = pkg.files as string[];

  test("declares the bundle patch and the client manifest", () => {
    expect(bundle.patch).toBe("./cordis.patch.yml");
    expect(client.platform).toBe("web");
    expect(client.immediately).toBe(true);
    expect(client.inject).toEqual([
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-layout",
      "@deepseek-ai/dsh-client-ui-sidebar",
      "@deepseek-ai/dsh-client-ui-sidebar-browser",
      "@deepseek-ai/dsh-client-ui-sidebar-right",
    ]);
  });

  test("exports every runtime entry dsh resolves", () => {
    expect(exportsMap["."]).toBe("./index.js");
    expect(exportsMap["./client"]).toBe("./client.js");
    expect(exportsMap["./locale/*.json"]).toBe("./locale/*.json");
    expect(exportsMap["./icon"]).toBe("./icon.svg");
    expect(pkg.main).toBe("index.js");
  });

  test("files keeps every runtime file that dsh reads", () => {
    for (const entry of ["index.js", "client.js", "locale/*.json", "icon.svg", "cordis.patch.yml"]) {
      expect(files).toContain(entry);
    }
  });

  test("every referenced runtime file exists", () => {
    for (const path of [
      "index.js",
      "client.js",
      "cordis.patch.yml",
      "locale/zh.json",
      "locale/en.json",
      "icon.svg",
    ]) {
      expect(existsSync(join(root, path))).toBe(true);
    }
  });
});

describe("display resources", () => {
  test("locale files carry non-empty display metadata", () => {
    for (const locale of ["zh", "en"]) {
      const file = readJson(`locale/${locale}.json`);
      const meta = file.meta as Record<string, unknown>;
      expect(typeof meta.title).toBe("string");
      expect(typeof meta.description).toBe("string");
      expect((meta.title as string).length).toBeGreaterThan(0);
      expect((meta.description as string).length).toBeGreaterThan(0);
    }
  });

  test("icon is a monochrome svg inside the size limit", () => {
    const icon = read("icon.svg");
    expect(icon).toContain("<svg");
    expect(icon).toContain("viewBox=");
    expect(icon).toContain("stroke=");
    expect(icon).not.toContain("<image");
    expect(statSync(join(root, "icon.svg")).size).toBeLessThan(256 * 1024);
  });
});
