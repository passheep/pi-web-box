import type { ComponentVersions } from "./contracts.js";

export type VersionPanelData = ComponentVersions & {
  iconDataUrl: string;
};

export function buildVersionPanelScript(data: VersionPanelData): string {
  const payload = JSON.stringify(data).replaceAll("<", "\\u003c");
  return `(() => {
    const data = ${payload};
    document.getElementById("pi-web-box-version-panel")?.remove();

    const host = document.createElement("div");
    host.id = "pi-web-box-version-panel";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = \`
      <style>
        :host { all: initial; }
        .wrap { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; font-family: "Segoe UI", system-ui, sans-serif; color: #202124; }
        .trigger { width: 46px; height: 46px; padding: 0; border: 1px solid #d4d4d8; border-radius: 50%; background: #fff; box-shadow: 0 3px 12px rgba(0,0,0,.16); cursor: pointer; display: grid; place-items: center; transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease; }
        .trigger:hover { border-color: #a1a1aa; box-shadow: 0 6px 18px rgba(0,0,0,.2); transform: translateY(-1px); }
        .trigger:focus-visible { outline: 2px solid #2563eb; outline-offset: 3px; }
        .trigger img { width: 31px; height: 31px; display: block; }
        .panel { position: absolute; right: 0; bottom: 56px; width: 270px; padding: 8px; border: 1px solid #dfe3e8; border-radius: 8px; background: #fff; box-shadow: 0 12px 36px rgba(0,0,0,.2); box-sizing: border-box; opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(8px) scale(.97); transform-origin: bottom right; transition: opacity 160ms ease, transform 180ms ease, visibility 0s linear 180ms; }
        .panel::after { content: ""; position: absolute; right: 0; bottom: -12px; width: 72px; height: 14px; }
        .panel.open { opacity: 1; visibility: visible; pointer-events: auto; transform: translateY(0) scale(1); transition-delay: 0s; }
        .title { padding: 7px 9px 8px; font-size: 13px; font-weight: 650; color: #202124; }
        .item { min-height: 44px; padding: 7px 9px; border-radius: 6px; display: flex; align-items: center; justify-content: space-between; gap: 12px; box-sizing: border-box; text-decoration: none; color: inherit; }
        a.item:hover { background: #f2f4f6; }
        a.item:focus-visible { outline: 2px solid #2563eb; outline-offset: -2px; }
        .name { font-size: 13px; font-weight: 600; }
        .version { max-width: 145px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #68707b; font-family: Consolas, monospace; font-size: 12px; }
        .external { color: #68707b; font-size: 11px; margin-left: 4px; }
        @media (prefers-color-scheme: dark) {
          .panel { border-color: #3f3f46; background: #27272a; color: #f4f4f5; }
          .title { color: #f4f4f5; }
          a.item:hover { background: #3f3f46; }
          .version, .external { color: #a1a1aa; }
        }
        @media (prefers-reduced-motion: reduce) {
          .trigger, .panel { transition: none; }
        }
      </style>
      <div class="wrap">
        <div class="panel" role="dialog" aria-label="Pi 版本信息">
          <div class="title">组件版本</div>
          <a class="item" href="https://pi.dev" target="_blank" rel="noopener noreferrer" title="在浏览器中打开 pi.dev">
            <span class="name">Pi <span class="external">↗</span></span><span class="version"></span>
          </a>
          <a class="item" href="https://github.com/agegr/pi-web" target="_blank" rel="noopener noreferrer" title="在浏览器中打开 Pi Web GitHub">
            <span class="name">Pi Web <span class="external">↗</span></span><span class="version"></span>
          </a>
          <div class="item"><span class="name">Pi Web Box</span><span class="version"></span></div>
        </div>
        <button class="trigger" type="button" title="查看组件版本" aria-label="查看组件版本" aria-expanded="false">
          <img alt="Pi" />
        </button>
      </div>
    \`;

    const versions = shadow.querySelectorAll(".version");
    versions[0].textContent = data.pi;
    versions[1].textContent = data.piWeb;
    versions[2].textContent = data.piWebBox;
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
    shadow.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.focus();
      }
    });
    document.body.appendChild(host);
  })()`;
}
