import type { ComponentVersions } from "./contracts.js";

export type VersionPanelData = ComponentVersions & {
  iconDataUrl: string;
};

const PANEL_ID = "pi-web-box-version-panel";

/**
 * 生成注入到 Pi Web 页面的脚本，包含两块内容：
 * 1. 右下角悬浮球与「关于」面板（版本信息、GitHub 链接、Box 设置入口）；
 * 2. 外观主题监听，把当前主题和背景色回传给主进程，用于同步 Windows 标题栏。
 */
export function buildVersionPanelScript(data: VersionPanelData): string {
  const payload = JSON.stringify(data).replaceAll("<", "\\u003c");
  return `(() => {
    const data = ${payload};
    document.getElementById("${PANEL_ID}")?.remove();

    const host = document.createElement("div");
    host.id = "${PANEL_ID}";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = \`
      <style>
        :host { all: initial; }
        .wrap { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; font-family: "Segoe UI", system-ui, sans-serif; color: #202124; }
        .trigger { width: 46px; height: 46px; padding: 0; border: 1px solid #d4d4d8; border-radius: 50%; background: #fff; box-shadow: 0 3px 12px rgba(0,0,0,.16); cursor: pointer; display: grid; place-items: center; transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease; }
        .trigger:hover { border-color: #a1a1aa; box-shadow: 0 6px 18px rgba(0,0,0,.2); transform: translateY(-1px); }
        .trigger:focus-visible { outline: 2px solid #2563eb; outline-offset: 3px; }
        .trigger img { width: 31px; height: 31px; display: block; }
        .panel { position: absolute; right: 0; bottom: 56px; width: 280px; padding: 8px; border: 1px solid #dfe3e8; border-radius: 10px; background: #fff; box-shadow: 0 12px 36px rgba(0,0,0,.2); box-sizing: border-box; opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(8px) scale(.97); transform-origin: bottom right; transition: opacity 160ms ease, transform 180ms ease, visibility 0s linear 180ms; }
        .panel::after { content: ""; position: absolute; right: 0; bottom: -12px; width: 72px; height: 14px; }
        .panel.open { opacity: 1; visibility: visible; pointer-events: auto; transform: translateY(0) scale(1); transition-delay: 0s; }
        .title { padding: 7px 9px 8px; font-size: 13px; font-weight: 650; color: #202124; }
        .item { min-height: 44px; padding: 7px 9px; border-radius: 7px; display: flex; align-items: center; justify-content: space-between; gap: 12px; box-sizing: border-box; text-decoration: none; color: inherit; width: 100%; border: 0; background: transparent; font: inherit; text-align: left; cursor: pointer; }
        a.item:hover, button.item:hover { background: #f2f4f6; }
        a.item:focus-visible, button.item:focus-visible { outline: 2px solid #2563eb; outline-offset: -2px; }
        .name { font-size: 13px; font-weight: 600; }
        .version { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #68707b; font-family: Consolas, monospace; font-size: 12px; }
        .external { color: #68707b; font-size: 11px; margin-left: 4px; }
        .divider { height: 1px; margin: 6px 4px; background: #e8eaed; }
        .action { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
        .action svg { width: 15px; height: 15px; flex: none; color: #68707b; }
        @media (prefers-color-scheme: dark) {
          .panel { border-color: #3f3f46; background: #27272a; color: #f4f4f5; }
          .title { color: #f4f4f5; }
          a.item:hover, button.item:hover { background: #3f3f46; }
          .version, .external { color: #a1a1aa; }
          .action svg { color: #a1a1aa; }
          .divider { background: #3f3f46; }
        }
        @media (prefers-reduced-motion: reduce) {
          .trigger, .panel { transition: none; }
        }
      </style>
      <div class="wrap">
        <div class="panel" role="dialog" aria-label="关于 Pi Web Box">
          <div class="title">关于</div>
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
          <img alt="Pi" />
        </button>
      </div>
    \`;

    const versions = shadow.querySelectorAll(".version");
    versions[0].textContent = "配置";
    versions[1].textContent = data.pi;
    versions[2].textContent = data.piWeb;
    versions[3].textContent = data.piWebBox;
    shadow.querySelector("img").src = data.iconDataUrl;

    const wrap = shadow.querySelector(".wrap");
    const button = shadow.querySelector(".trigger");
    const panel = shadow.querySelector(".panel");
    let closeTimer;

    // 鼠标移入展开，移出稍作延迟后收起，避免跨过按钮与面板间隙时闪烁。
    const setOpen = (open) => {
      window.clearTimeout(closeTimer);
      panel.classList.toggle("open", open);
      button.setAttribute("aria-expanded", String(open));
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
      if (target?.dataset.action === "settings") {
        setOpen(false);
        window.piWebBox?.openSettings?.();
      }
    });
    shadow.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.focus();
      }
    });
    document.body.appendChild(host);

    // ── 外观主题监听：把当前主题回传主进程，用于同步 Windows 原生标题栏 ──
    if (!window.__piWebBoxThemeSync) {
      const readBackground = () => {
        const value = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
        return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value : "";
      };
      const report = () => {
        const theme = document.documentElement.dataset.theme || "";
        const background = readBackground();
        const isDark = document.documentElement.classList.contains("dark");
        try {
          window.piWebBox?.reportTheme?.({ theme, background, isDark });
        } catch (error) {
          void error;
        }
      };
      const observer = new MutationObserver(() => {
        // 主题切换会同时改动 data-theme 和 dark 类，这里统一延迟到下一帧再读取，
        // 保证拿到的是切换完成后的实际背景色。
        window.requestAnimationFrame(report);
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });

      // auto 主题跟随系统，系统外观变化时也要同步。
      window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", report);
      window.__piWebBoxThemeSync = { observer, report };
    }

    // 页面首次注入时立即上报一次，避免标题栏停留在系统默认色。
    window.__piWebBoxThemeSync.report();
  })()`;
}
