import type { ComponentVersions } from "./contracts.js";
import { THEME_PALETTES } from "./themes.js";

export type VersionPanelData = ComponentVersions & {
  // 品牌 logo：深色主题用白色版，浅色主题用深色版。
  darkIconDataUrl: string;
  lightIconDataUrl: string;
  // 关于面板展示的联系方式与仓库地址。
  github: string;
  qq: string;
  // 提示词增强是否已配置模型，未配置时按钮置灰并给出提示。
  enhanceConfigured: boolean;
};

const PANEL_ID = "pi-web-box-version-panel";

/**
 * 生成注入到 Pi Web 页面的脚本，包含三块内容：
 * 1. 右下角悬浮球与「关于」面板（版本、联系方式、仓库地址、设置与统计入口）；
 * 2. 外观主题监听，把当前主题和背景色回传给主进程，用于同步 Windows 标题栏；
 * 3. 用主题变量覆盖面板内配色，使弹窗跟随 Pi Web 主题。
 */
export function buildVersionPanelScript(data: VersionPanelData): string {
  const payload = JSON.stringify(data).replaceAll("<", "\\u003c");
  // 把五个主题的面板配色一并带过去，避免依赖 prefers-color-scheme 而与实际主题不一致。
  const palettePayload = JSON.stringify(THEME_PALETTES).replaceAll("<", "\\u003c");

  return `(() => {
    const data = ${payload};
    const palettes = ${palettePayload};

    // 复用已有实例：仅更新数据，避免重复注入造成多个悬浮球。
    const existing = document.getElementById("${PANEL_ID}");
    if (existing && existing.__piWebBoxUpdate) {
      // 顺手清理可能残留的重复实例，只保留当前这一个。
      for (const stale of document.querySelectorAll("#${PANEL_ID}")) {
        if (stale !== existing) stale.remove();
      }
      existing.__piWebBoxUpdate(data);
      return;
    }
    // 旧实例的主题监听会继续调用自身的更新逻辑，这里一并停掉。
    for (const stale of document.querySelectorAll("#${PANEL_ID}")) {
      try { stale.__piWebBoxTeardown?.(); } catch (error) { void error; }
      stale.remove();
    }

    const host = document.createElement("div");
    host.id = "${PANEL_ID}";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = \`
      <style>
        :host { all: initial; }
        .wrap {
          position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
          font-family: "Segoe UI", system-ui, sans-serif;
          /* 配色跟随 Pi Web 主题，由脚本按当前主题写入 */
          --p-bg: #fff; --p-panel: #f5f5f5; --p-border: #e0e0e0;
          --p-text: #1a1a1a; --p-muted: #515c6b; --p-accent: #245bce; --p-hover: #eee;
          /* logo 与圆形按钮底色随主题深浅切换 */
          --p-logo-bg: #fff; --p-logo-fg: #1a1a1a;
        }
        .trigger { width: 46px; height: 46px; padding: 0; border: 1px solid var(--p-border); border-radius: 50%; background: var(--p-logo-bg); box-shadow: 0 3px 12px rgba(0,0,0,.16); cursor: pointer; display: grid; place-items: center; transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease; }
        .trigger:hover { border-color: var(--p-accent); box-shadow: 0 6px 18px rgba(0,0,0,.2); transform: translateY(-1px); }
        .trigger:focus-visible { outline: 2px solid var(--p-accent); outline-offset: 3px; }
        /* 直接展示品牌 logo：按主题切换深浅两版，不再用内联简化图形。 */
        .trigger img { width: 26px; height: 26px; display: block; }
        .panel { position: absolute; right: 0; bottom: 56px; width: 292px; padding: 8px; border: 1px solid var(--p-border); border-radius: 10px; background: var(--p-bg); box-shadow: 0 12px 36px rgba(0,0,0,.2); box-sizing: border-box; opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(8px) scale(.97); transform-origin: bottom right; transition: opacity 160ms ease, transform 180ms ease, visibility 0s linear 180ms; }
        .panel::after { content: ""; position: absolute; right: 0; bottom: -12px; width: 72px; height: 14px; }
        .panel.open { opacity: 1; visibility: visible; pointer-events: auto; transform: translateY(0) scale(1); transition-delay: 0s; }
        .title { padding: 7px 9px 8px; font-size: 13px; font-weight: 650; color: var(--p-text); }
        .item { min-height: 44px; padding: 7px 9px; border-radius: 7px; display: flex; align-items: center; justify-content: space-between; gap: 12px; box-sizing: border-box; text-decoration: none; color: inherit; width: 100%; border: 0; background: transparent; font: inherit; text-align: left; cursor: pointer; }
        a.item:hover, button.item:hover { background: var(--p-hover); }
        a.item:focus-visible, button.item:focus-visible { outline: 2px solid var(--p-accent); outline-offset: -2px; }
        button.item:disabled { cursor: not-allowed; opacity: .55; }
        .name { font-size: 13px; font-weight: 600; color: var(--p-text); }
        .version { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--p-muted); font-family: Consolas, monospace; font-size: 12px; }
        .external { color: var(--p-muted); font-size: 11px; margin-left: 4px; }
        .divider { height: 1px; margin: 6px 4px; background: var(--p-border); }
        /* 图标与文字在同一基线上对齐：图标用块级元素并消除行高影响 */
        .action { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; line-height: 1; color: var(--p-text); }
        .action svg { width: 15px; height: 15px; flex: none; display: block; color: var(--p-muted); }
        .action span { line-height: 15px; }
        @media (prefers-reduced-motion: reduce) { .trigger, .panel { transition: none; } }
      </style>
      <div class="wrap">
        <div class="panel" role="dialog" aria-label="关于 Pi Web Box">
          <div class="title">关于</div>
          <button class="item" type="button" data-action="usage" title="查看 token 用量统计">
            <span class="action">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 3v18h18"></path><rect x="7" y="12" width="3" height="6" rx="1"></rect><rect x="12" y="8" width="3" height="10" rx="1"></rect><rect x="17" y="5" width="3" height="13" rx="1"></rect>
              </svg>
              <span>Token 统计</span>
            </span><span class="version">查看</span>
          </button>
          <button class="item" type="button" data-action="enhance-settings" title="设置提示词增强">
            <span class="action">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"></path>
              </svg>
              <span>提示词增强</span>
            </span><span class="version">设置</span>
          </button>
          <button class="item" type="button" data-action="settings" title="打开 Pi Web Box 设置">
            <span class="action">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
              <span>Box 设置</span>
            </span><span class="version">配置</span>
          </button>
          <div class="divider"></div>
          <a class="item" href="https://pi.dev" target="_blank" rel="noopener noreferrer" title="在浏览器中打开 pi.dev">
            <span class="name">Pi <span class="external">↗</span></span><span class="version"></span>
          </a>
          <a class="item" href="https://github.com/agegr/pi-web" target="_blank" rel="noopener noreferrer" title="在浏览器中打开 Pi Web GitHub">
            <span class="name">Pi Web <span class="external">↗</span></span><span class="version"></span>
          </a>
          <a class="item" href="https://github.com/passheep/pi-web-box" target="_blank" rel="noopener noreferrer" title="在浏览器中打开 Pi Web Box GitHub">
            <span class="name">Pi Web Box <span class="external">↗</span></span><span class="version"></span>
          </a>
        </div>
        <button class="trigger" type="button" title="关于 Pi Web Box" aria-label="关于 Pi Web Box" aria-expanded="false">
          <img class="logo" alt="" />
        </button>
      </div>
    \`;

    const wrap = shadow.querySelector(".wrap");
    const button = shadow.querySelector(".trigger");
    const logo = shadow.querySelector(".logo");
    const panel = shadow.querySelector(".panel");
    const versions = shadow.querySelectorAll(".version");
    let closeTimer;

    // 主题配色映射：深色主题用深底浅字，浅色主题反之。
    const applyPalette = (theme) => {
      const palette = palettes[theme] || palettes.light;
      const isDark = theme === "dark" || theme === "pine";
      const style = wrap.style;
      style.setProperty("--p-bg", palette.background);
      style.setProperty("--p-panel", palette.panel);
      style.setProperty("--p-border", palette.border);
      style.setProperty("--p-text", palette.text);
      style.setProperty("--p-muted", palette.textMuted);
      style.setProperty("--p-accent", palette.accent);
      // hover 底色取面板色向文字色靠拢一点，两种主题都适用。
      style.setProperty("--p-hover", isDark ? palette.panel : palette.panel);
      // logo 底色与面板一致，跟随主题而不是写死白色，
      // 否则雾青/蔷薇等主题下圆形按钮会与页面脱节。
      style.setProperty("--p-logo-bg", palette.panel);
      style.setProperty("--p-logo-fg", isDark ? palette.text : "#1a1a1a");
      // 品牌 logo 按主题深浅切换，与设置窗口的左上角图标保持一致。
      if (logo) logo.src = isDark ? data.darkIconDataUrl : data.lightIconDataUrl;
    };

    const update = (next) => {
      versions[0].textContent = "查看";
      versions[1].textContent = "设置";
      versions[2].textContent = "配置";
      versions[3].textContent = next.pi;
      versions[4].textContent = next.piWeb;
      versions[5].textContent = next.piWebBox;
      applyPalette(document.documentElement.dataset.theme || "light");
    };
    host.__piWebBoxUpdate = update;
    update(data);

    const setOpen = (open) => {
      window.clearTimeout(closeTimer);
      panel.classList.toggle("open", open);
      button.setAttribute("aria-expanded", String(open));
      if (open) applyPalette(document.documentElement.dataset.theme || "light");
    };
    const scheduleClose = () => {
      window.clearTimeout(closeTimer);
      closeTimer = window.setTimeout(() => setOpen(false), 140);
    };

    wrap.addEventListener("mouseenter", () => setOpen(true));
    wrap.addEventListener("mouseleave", scheduleClose);
    wrap.addEventListener("focusin", () => setOpen(true));
    wrap.addEventListener("focusout", scheduleClose);
    button.addEventListener("click", () => setOpen(true));
    shadow.addEventListener("click", (event) => {
      const target = event.target.closest?.("[data-action]");
      if (!target) return;
      const action = target.dataset.action;
      setOpen(false);
      if (action === "settings") window.piWebBox?.openSettings?.();
      if (action === "usage") window.piWebBox?.openUsage?.();
      if (action === "enhance-settings") window.piWebBox?.openSettings?.("enhance");
    });
    shadow.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.focus();
      }
    });
    document.body.appendChild(host);

    // ── 外观主题监听：同步标题栏，并让面板跟随主题换色 ──
    if (!window.__piWebBoxThemeSync) {
      const readBackground = () => {
        const value = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
        return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value : "";
      };
      // 标题栏取顶栏实际使用的面板底色，页面主体与顶栏才能连成一片。
      const readToolbarBackground = () => {
        const value = getComputedStyle(document.documentElement).getPropertyValue("--bg-panel").trim();
        return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value : "";
      };
      const report = () => {
        const root = document.documentElement;
        const theme = root.dataset.theme || "";
        const isDark = root.classList.contains("dark");
        try {
          window.piWebBox?.reportTheme?.({
            theme,
            background: readToolbarBackground() || readBackground(),
            isDark,
          });
        } catch (error) {
          void error;
        }
        // 面板同步换色，无需重新打开弹窗。
        const sync = document.getElementById("${PANEL_ID}");
        sync?.__piWebBoxUpdate?.(data);
      };
      const observer = new MutationObserver(() => window.requestAnimationFrame(report));
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
      window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", report);
      window.__piWebBoxThemeSync = { observer, report };
    }

    window.__piWebBoxThemeSync.report();

    // 重新注入时先停掉本实例的主题监听，避免旧实例继续上报与重绘。
    host.__piWebBoxTeardown = () => {
      const sync = window.__piWebBoxThemeSync;
      if (sync && sync.report === report) {
        sync.observer?.disconnect?.();
        delete window.__piWebBoxThemeSync;
      }
    };
  })()`;
}
