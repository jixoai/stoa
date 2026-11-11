/**
 * Stoa Client half for dsh (DeepSeek Harness).
 *
 * Registers the left-sidebar entry “Stoa Daemon 控制台” and its `main` panel, then
 * opens the daemon console in the built-in right-sidebar browser.
 *
 * Contract references (dsh 0.2.2-rc.1, verified in a source checkout):
 * - `sidebar.panellist` list slot: ui-sidebar/src/client/index.ts:90-92;
 *   first-party registrations: ui-schedule/src/client/index.ts:240-246,
 *   ui-plugin-manager/src/client/index.ts:167-173.
 * - The same id must exist in the layout `main` keyed slot
 *   (ui-sidebar/README.md:42; ui-layout/src/client/index.ts:75, AppFrame.tsx:49).
 * - `ctx.locale.register(ns, { zh, en })` + `ctx.locale.bind(ns)`:
 *   ui-sidebar/src/client/index.ts:55-56.
 * - `ctx.sidebarRight.openTab('browser', { params: { url } })`:
 *   ui-sidebar-browser/README.zh.md:43, lib/client.js:157-160.
 * - `sidebarRight.mounted` is `undefined` while a global panel fills the main
 *   column, and `openTab` throws without an on-screen session
 *   (ui-sidebar-right/README.md:103; service.ts:226,854-864). The flow therefore
 *   returns to the conversation first, waits for `mounted`, then opens the tab.
 */
window.__ModuleLoader__.load({
  id: '@jixoai/stoa',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Main-panel key and sidebar-entry id; both must be the same string. */
    const PANEL_ID = 'stoa-daemon';
    /** Client locale namespace owned by this plugin. */
    const NS = 'stoa.daemon';
    /** Documented daemon default (src/daemon/state.ts:25). */
    const DAEMON_DEFAULT_URL = 'http://127.0.0.1:13679';
    /** Documented auto-selected port band, highest first (src/daemon/state.ts:27-30). */
    const DAEMON_PORT_BAND = [13679, 13678, 13677, 13676, 13675, 13674, 13673, 13672, 13671, 13670];
    /** Per-probe timeout; a local daemon answers in milliseconds. */
    const PROBE_TIMEOUT_MS = 1200;
    /** How long to wait for the conversation (and its right-Sidebar surface) to come back. */
    const OPEN_WAIT_MS = 1500;

    const zh = {
      'panel.label': 'Stoa Daemon 控制台',
      'panel.probing.title': '正在检查 Stoa daemon…',
      'panel.probing.body': '正在探测 {url} 及其端口带。',
      'panel.opening.title': '正在打开控制台…',
      'panel.opening.body': '正在右栏内置浏览器中打开 {url}。',
      'panel.down.title': '未检测到 Stoa daemon',
      'panel.down.body':
        '在 {url} 及其端口带（13670–13679）上没有响应。先在终端运行 `stoa daemon`，再重试。',
      'panel.blocked.title': '右栏浏览器不可用',
      'panel.blocked.body': '已尝试在右侧栏打开控制台，但未成功：{reason}。可以改用系统浏览器打开。',
      'panel.blocked.no-sidebar': '当前 dsh 组合没有提供右侧栏服务',
      'panel.blocked.no-session': '没有可承载右侧栏的会话',
      'panel.blocked.open-failed': '内置浏览器未注册或拒绝打开',
      'panel.detail': '技术细节：{detail}',
      'panel.action.retry': '重新检测',
      'panel.action.browser': '在浏览器中打开',
      'panel.action.conversation': '返回会话',
    };

    const en = {
      'panel.label': 'Stoa daemon console',
      'panel.probing.title': 'Checking for the Stoa daemon…',
      'panel.probing.body': 'Probing {url} and its port band.',
      'panel.opening.title': 'Opening the console…',
      'panel.opening.body': 'Opening {url} in the right-sidebar browser.',
      'panel.down.title': 'Stoa daemon not detected',
      'panel.down.body':
        'Nothing answered on {url} or its port band (13670–13679). Run `stoa daemon` in a terminal, then retry.',
      'panel.blocked.title': 'Right-sidebar browser unavailable',
      'panel.blocked.body':
        'The console could not be opened in the right sidebar: {reason}. You can open it in the system browser instead.',
      'panel.blocked.no-sidebar': 'this dsh composition provides no right-sidebar service',
      'panel.blocked.no-session': 'no session can host the right sidebar',
      'panel.blocked.open-failed': 'the built-in browser is not registered or refused to open',
      'panel.detail': 'Technical detail: {detail}',
      'panel.action.retry': 'Check again',
      'panel.action.browser': 'Open in browser',
      'panel.action.conversation': 'Back to conversation',
    };

    /** Fill `{name}` placeholders in a locale template. */
    function format(template, params) {
      if (params === undefined || params === null) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
      ));
    }

    /** Translate one key against a dictionary, returning the key when it is missing. */
    function translate(dictionary, key, params) {
      const template = dictionary[key];
      return template === undefined ? key : format(template, params);
    }

    /** Read a human-readable message from an unknown thrown value. */
    function messageOf(error) {
      if (error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message) {
        return error.message;
      }
      return String(error);
    }

    /** Fetch with an abort-based deadline; resolves with the Response. */
    function fetchWithTimeout(url, init, timeoutMs) {
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
      const options = Object.assign({ cache: 'no-store' }, init);
      if (controller !== undefined) options.signal = controller.signal;
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (controller !== undefined) controller.abort();
          reject(new Error('probe timeout'));
        }, timeoutMs);
      });
      return Promise.race([fetch(url, options), deadline]).finally(() => clearTimeout(timer));
    }

    /**
     * Probe one daemon origin. A readable `{ daemon: true }` health document proves
     * the identity; an opaque no-cors response only proves something listens there.
     */
    async function probeBase(base) {
      try {
        const response = await fetchWithTimeout(base + '/healthz', {}, PROBE_TIMEOUT_MS);
        if (response !== undefined && response.ok === true) {
          const body = await response.json().catch(() => null);
          if (body !== null && typeof body === 'object' && body.daemon === true) return true;
        }
      } catch (_readableProbeFailed) {
        // Mixed content, CORS, or no daemon: fall through to the opaque probe.
      }
      try {
        await fetchWithTimeout(base + '/healthz', { mode: 'no-cors' }, PROBE_TIMEOUT_MS);
        return true;
      } catch (_opaqueProbeFailed) {
        return false;
      }
    }

    /** Resolve the daemon URL: the documented default first, then the whole band. */
    async function resolveDaemon() {
      const results = await Promise.all(DAEMON_PORT_BAND.map((port) => {
        const url = 'http://127.0.0.1:' + port;
        return probeBase(url).then((reachable) => ({ port, url, reachable }));
      }));
      const ordered = results.slice().sort((a, b) => b.port - a.port);
      const hit = ordered.find((result) => result.reachable);
      if (hit !== undefined) return { url: hit.url, reachable: true };
      return { url: DAEMON_DEFAULT_URL, reachable: false };
    }

    /** The optional right-Sidebar face; absent in compositions without that plugin. */
    function sidebarRightOf(ctx) {
      const right = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined;
      if (right === null || typeof right !== 'object' || typeof right.openTab !== 'function') return undefined;
      return right;
    }

    /**
     * Return to the conversation, wait for its right-Sidebar surface, then open the
     * console page. Resolves `{ ok: true }` or a coded failure; never throws.
     */
    function openInSidebar(ctx, url) {
      return new Promise((resolve) => {
        const right = sidebarRightOf(ctx);
        if (right === undefined) {
          resolve({ ok: false, code: 'no-sidebar' });
          return;
        }
        try {
          const active = ctx.layout.panelInfo.getSnapshot().activePanelId;
          if (active === PANEL_ID) ctx.layout.selectPanel(null);
        } catch (_leavePanelFailed) {
          // Staying on the panel leaves mounted undefined; the wait below reports it.
        }
        let settled = false;
        let timer = 0;
        let retryTimer = 0;
        let unsubscribe = function () {};
        const finish = (result) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (retryTimer) clearTimeout(retryTimer);
          try { unsubscribe(); } catch (_unsubscribeFailed) { /* nothing left to release */ }
          resolve(result);
        };
        const attempt = () => {
          if (settled) return;
          const mounted = right.mounted;
          if (mounted === null || typeof mounted !== 'object' || typeof mounted.getSnapshot !== 'function') {
            finish({ ok: false, code: 'no-sidebar' });
            return;
          }
          if (mounted.getSnapshot() === undefined) return;
          try {
            right.openTab('browser', { params: { url } });
            finish({ ok: true });
          } catch (error) {
            const detail = messageOf(error);
            // `mounted` is published before React renders the seat that mints the
            // Session's store, so the first write can arrive a commit too early.
            if (detail.indexOf('no session surface is mounted') !== -1) {
              if (retryTimer) clearTimeout(retryTimer);
              retryTimer = setTimeout(attempt, 40);
              return;
            }
            finish({ ok: false, code: 'open-failed', detail });
          }
        };
        timer = setTimeout(() => finish({ ok: false, code: 'no-session' }), OPEN_WAIT_MS);
        if (right.mounted !== null && typeof right.mounted === 'object'
          && typeof right.mounted.subscribe === 'function') {
          unsubscribe = right.mounted.subscribe(attempt);
        }
        attempt();
      });
    }

    /** Turn a recorded failure into panel state. */
    function blockedPhase(blocked) {
      return { kind: 'blocked', url: blocked.url, code: blocked.code, detail: blocked.detail };
    }

    /** A failure is only replayed by the immediate remount that follows it. */
    function isFreshBlocked(blocked) {
      return blocked !== null && typeof blocked.at === 'number' && Date.now() - blocked.at < 2000;
    }

    const SURFACE_STYLE = {
      boxSizing: 'border-box',
      height: '100%',
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '10px',
      padding: '32px 24px',
      textAlign: 'center',
      color: 'inherit',
      background: 'transparent',
    };
    const TITLE_STYLE = { margin: 0, fontSize: '15px', fontWeight: 600 };
    const BODY_STYLE = {
      margin: 0,
      maxWidth: '520px',
      fontSize: '12.5px',
      lineHeight: 1.6,
      opacity: 0.75,
    };
    const URL_STYLE = {
      margin: 0,
      fontSize: '12px',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      wordBreak: 'break-all',
      opacity: 0.9,
    };
    const DETAIL_STYLE = { margin: 0, fontSize: '11px', opacity: 0.55, wordBreak: 'break-word' };
    const ACTIONS_STYLE = {
      display: 'flex',
      flexWrap: 'wrap',
      justifyContent: 'center',
      gap: '8px',
      marginTop: '4px',
    };
    const BUTTON_STYLE = {
      font: 'inherit',
      fontSize: '12px',
      padding: '5px 12px',
      borderRadius: 'var(--dsw-radius-sm, 6px)',
      border: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
    };

    /** The plugin's monochrome portico glyph; the sidebar owns the row around it. */
    function StoaIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 18;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: 'false',
        style: { display: 'block' },
      },
      h('path', { d: 'M3 9 12 3l9 6' }),
      h('path', { d: 'M4.5 9h15' }),
      h('path', { d: 'M6.5 9v8M10.2 9v8M13.8 9v8M17.5 9v8' }),
      h('path', { d: 'M3 20.5h18' }));
    }

    /** Build the `main` panel component bound to this plugin's context. */
    function createPanel(ctx) {
      /** Failure kept across the panel unmount/remount that follows a failed open. */
      const state = { blocked: null };

      return function StoaDaemonPanel(props) {
        const t = typeof props.t === 'function'
          ? props.t
          : (key, params) => translate(zh, key, params);
        const [phase, setPhase] = React.useState(() => (
          isFreshBlocked(state.blocked)
            ? blockedPhase(state.blocked)
            : { kind: 'probing', url: DAEMON_DEFAULT_URL }
        ));
        const [nonce, setNonce] = React.useState(0);

        React.useEffect(() => {
          if (isFreshBlocked(state.blocked)) {
            setPhase(blockedPhase(state.blocked));
            return undefined;
          }
          state.blocked = null;
          let cancelled = false;
          (async () => {
            setPhase({ kind: 'probing', url: DAEMON_DEFAULT_URL });
            const probe = await resolveDaemon();
            if (cancelled) return;
            if (!probe.reachable) {
              setPhase({ kind: 'down', url: probe.url });
              return;
            }
            setPhase({ kind: 'opening', url: probe.url });
            const result = await openInSidebar(ctx, probe.url);
            if (result.ok) return;
            // The panel was unmounted by returning to the conversation; record the
            // failure and bring the panel back so the reason is visible. Never take
            // over a different global panel the user opened in the meantime.
            state.blocked = { url: probe.url, code: result.code, detail: result.detail, at: Date.now() };
            try {
              if (ctx.layout.panelInfo.getSnapshot().activePanelId === null) {
                ctx.layout.selectPanel(PANEL_ID);
              }
            } catch (_reselectFailed) { /* the card renders if the panel is still mounted */ }
            if (!cancelled) setPhase(blockedPhase(state.blocked));
          })();
          return () => { cancelled = true; };
        }, [nonce]);

        const retry = () => {
          state.blocked = null;
          setNonce((value) => value + 1);
        };
        const openInBrowser = () => {
          const url = typeof phase.url === 'string' && phase.url !== '' ? phase.url : DAEMON_DEFAULT_URL;
          try { window.open(url, '_blank', 'noopener'); } catch (_windowOpenFailed) { /* nothing else to try */ }
        };
        const back = () => {
          state.blocked = null;
          try { ctx.layout.selectPanel(null); } catch (_leavePanelFailed) { /* nothing else to try */ }
        };

        const titleKey = phase.kind === 'down'
          ? 'panel.down.title'
          : phase.kind === 'blocked'
            ? 'panel.blocked.title'
            : phase.kind === 'opening'
              ? 'panel.opening.title'
              : 'panel.probing.title';
        const reason = phase.kind === 'blocked'
          ? t('panel.blocked.' + (phase.code || 'open-failed'))
          : '';
        const body = phase.kind === 'down'
          ? t('panel.down.body', { url: phase.url })
          : phase.kind === 'blocked'
            ? t('panel.blocked.body', { reason })
            : phase.kind === 'opening'
              ? t('panel.opening.body', { url: phase.url })
              : t('panel.probing.body', { url: phase.url });

        const actions = [];
        if (phase.kind === 'down') {
          actions.push(h('button', { type: 'button', onClick: retry, style: BUTTON_STYLE }, t('panel.action.retry')));
          actions.push(h('button', { type: 'button', onClick: openInBrowser, style: BUTTON_STYLE }, t('panel.action.browser')));
          actions.push(h('button', { type: 'button', onClick: back, style: BUTTON_STYLE }, t('panel.action.conversation')));
        } else if (phase.kind === 'blocked') {
          actions.push(h('button', { type: 'button', onClick: openInBrowser, style: BUTTON_STYLE }, t('panel.action.browser')));
          actions.push(h('button', { type: 'button', onClick: retry, style: BUTTON_STYLE }, t('panel.action.retry')));
          actions.push(h('button', { type: 'button', onClick: back, style: BUTTON_STYLE }, t('panel.action.conversation')));
        } else {
          actions.push(h('button', { type: 'button', onClick: back, style: BUTTON_STYLE }, t('panel.action.conversation')));
        }

        return h('div', { style: SURFACE_STYLE },
          h(StoaIcon, { size: 40 }),
          h('h2', { style: TITLE_STYLE }, t(titleKey)),
          h('p', { style: BODY_STYLE }, body),
          h('p', { style: URL_STYLE }, phase.url),
          phase.detail === undefined ? null : h('p', { style: DETAIL_STYLE }, t('panel.detail', { detail: phase.detail })),
          h('div', { style: ACTIONS_STYLE }, ...actions));
      };
    }

    /** Required services; `sidebarRight` stays optional so the entry can fall back. */
    const inject = ['slots', 'locale', 'layout'];

    /** Register the sidebar entry, its main panel, and the plugin's copy. */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'stoa: dictionaries');
      const t = ctx.locale.bind(NS);
      const Panel = createPanel(ctx);
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, Panel)), 'stoa: daemon panel');
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        locale: NS,
        label: () => t('panel.label'),
      }, StoaIcon)), 'stoa: sidebar entry');
    }

    return { inject, apply };
  },
});
