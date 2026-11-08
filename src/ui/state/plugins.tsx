/**
 * 插件开关状态（report-link-preview P1-15）。
 *
 * - ready 后拉 `GET /api/plugins`；静态归档**不发请求**，以快照 `preview_enabled` 为准；
 * - PATCH 乐观更新 + 失败回滚；`plugin.updated` 控制帧让其他标签页立即隐藏/恢复卡片；
 * - 漏帧/断线由 `stream.reconnected` 与设置页打开时的 `refresh()` 兜底；
 * - 切后端/登出/换账号即清空旧视图，in-flight 响应按 epoch 丢弃（不跨实例泄漏）。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PluginView } from "@core/plugins/types";
import { useConnection } from "@/state/connection";
import { useEventHub } from "@/state/hub/provider";
import { LINK_PREVIEW_PLUGIN_ID } from "@/lib/link-preview";
import {
  optimisticPluginEnabled,
  replacePlugin,
  restorePlugin,
} from "@/lib/plugin-state";

interface PluginsContextValue {
  plugins: PluginView[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  enabled: (id: string) => boolean;
  refresh: () => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<boolean>;
}

const PluginsContext = createContext<PluginsContextValue | null>(null);

export function PluginsProvider({ children }: { children: ReactNode }) {
  const { phase, client, staticMode, account, capabilities } = useConnection();
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  /** 每次切 client/账号/阶段自增；旧请求回来时据 epoch 丢弃。 */
  const epoch = useRef(0);
  const pluginsRef = useRef(plugins);
  pluginsRef.current = plugins;
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const staticEnabled = client?.staticPreviewEnabled() ?? true;
  /** 启动期能力门：feature 未加载/false 时预览整卡不渲染（N2）。 */
  const previewFields = capabilities?.features?.preview_fields === true;

  // 换后端/登出/重连流程回 connecting：旧实例的插件状态一律作废。
  useEffect(() => {
    epoch.current += 1;
    setPlugins([]);
    setLoaded(false);
    setLoading(false);
    setError(null);
  }, [client, account?.id, staticMode, phase]);

  const refresh = useCallback(async () => {
    if (!client || staticMode || phase !== "ready") return;
    const requestEpoch = epoch.current;
    setLoading(true);
    try {
      const rows = await client.plugins();
      if (!alive.current || requestEpoch !== epoch.current) return;
      setPlugins(rows);
      setLoaded(true);
      setError(null);
    } catch (err) {
      if (!alive.current || requestEpoch !== epoch.current) return;
      // 保留已成功加载的旧列表；错误交给设置页「重试」。
      setError((err as Error).message || "插件状态加载失败");
    } finally {
      if (alive.current && requestEpoch === epoch.current) setLoading(false);
    }
  }, [client, staticMode, phase]);

  useEffect(() => {
    if (phase !== "ready" || staticMode) return;
    void refresh();
  }, [phase, staticMode, refresh]);

  useEventHub(["plugin.updated", "stream.reconnected"], (dispatch) => {
    if (dispatch.topic === "plugin.updated") {
      const found = pluginsRef.current.find((plugin) => plugin.id === dispatch.pluginId);
      if (!found) {
        // 首次加载前的控制帧：重新拉一次列表，让关闭状态也生效。
        void refresh();
        return;
      }
      setPlugins((current) => {
        const row = current.find((plugin) => plugin.id === dispatch.pluginId);
        if (!row) return current;
        return replacePlugin(current, {
          ...row,
          enabled: dispatch.enabled,
          ...(dispatch.version ? { version: dispatch.version } : {}),
        });
      });
      return;
    }
    if (dispatch.topic === "stream.reconnected" && loadedRef.current) void refresh();
  });

  const enabled = useCallback(
    (id: string): boolean => {
      if (staticMode) return staticEnabled;
      const found = plugins.find((plugin) => plugin.id === id);
      if (id === LINK_PREVIEW_PLUGIN_ID) {
        // 首帧门（N2）：能力矩阵未加载/不支持 → 不渲染；插件列表未加载 →
        // 也不知道开关，宁可暂不渲染，避免关闭态先闪一批卡片再塌掉。
        if (!previewFields) return false;
        if (!loaded) return false;
        return found ? found.enabled : false;
      }
      return found ? found.enabled : true;
    },
    [plugins, loaded, staticMode, staticEnabled, previewFields],
  );

  const setEnabled = useCallback(
    async (id: string, next: boolean): Promise<boolean> => {
      if (!client || staticMode) return false;
      const previous = pluginsRef.current.find((plugin) => plugin.id === id) ?? null;
      if (!previous) return false;
      if (previous.enabled === next) return true;
      const requestEpoch = epoch.current;
      // 乐观更新；失败回滚到调用前那一行。
      setPlugins((list) => optimisticPluginEnabled(list, id, next));
      setError(null);
      try {
        const updated = await client.setPlugin(id, next);
        // N4：切后端/账号后，在飞 PATCH 的回包不得写入新实例。
        if (!alive.current || requestEpoch !== epoch.current) return false;
        setPlugins((list) => replacePlugin(list, updated));
        return true;
      } catch (err) {
        if (!alive.current || requestEpoch !== epoch.current) return false;
        setPlugins((list) => restorePlugin(list, previous));
        setError((err as Error).message || "插件开关更新失败");
        return false;
      }
    },
    [client, staticMode],
  );

  const value = useMemo<PluginsContextValue>(
    () => ({ plugins, loaded, loading, error, enabled, refresh, setEnabled }),
    [plugins, loaded, loading, error, enabled, refresh, setEnabled],
  );

  return <PluginsContext.Provider value={value}>{children}</PluginsContext.Provider>;
}

export function usePlugins(): PluginsContextValue {
  const value = useContext(PluginsContext);
  if (!value) throw new Error("usePlugins must be used inside PluginsProvider");
  return value;
}

export function useLinkPreviewEnabled(): boolean {
  const { enabled } = usePlugins();
  return enabled(LINK_PREVIEW_PLUGIN_ID);
}
