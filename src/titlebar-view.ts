/**
 * 设置窗口与用量统计窗口共用的自绘标题栏。
 *
 * 这两类窗口不使用 Windows 原生标题栏（titleBarStyle: "hidden"），
 * 而是自己画一条与页面同色的标题栏，好处是：
 * 1. 颜色永远跟随 Pi Web 主题，不受系统重绘影响；
 * 2. 与「提示词增强」弹窗的外观保持一致；
 * 3. 深浅色主题下都能自己控制按钮配色。
 *
 * 交互通过 preload 暴露的 window.piWebBox.titleBar* 方法完成。
 */

export type TitleBarText = {
  // 标题文字，例如「Pi Web Box 设置」。
  title: string;
  // 品牌图标（data URL），随主题深浅切换。
  iconDataUrl: string;
};

/** 子窗口（设置 / 统计）的标题栏只提供关闭按钮，不提供最大化。 */

/**
 * 注入到 Pi Web 页面里的自绘标题栏。
 * 主窗口的标题栏必须画在页面内部，否则无法与 pi-web 顶栏配色保持一致。
 * 页面本身是整屏布局（body overflow:hidden），所以这里固定定位并给
 * body 留出等高的上内边距，避免遮住 pi-web 自己的工具栏。
 */
export const MAIN_TITLE_BAR_ID = "pi-web-box-titlebar";

export type MainTitleBarData = {
  title: string;
  iconDataUrl: string;
  // 以下颜色均作为「读不到页面真实颜色时」的兑底值，
  // 正常情况下脚本会直接取 pi-web 顶栏的实际背景色。
  background: string;
  border: string;
  text: string;
  textMuted: string;
  hover: string;
};

/**
 * 定位 pi-web 顶部工具栏（【完整历史 / 生成标题 / 系统 / 工具】所在的那条），
 * 标题栏颜色直接取它的实际背景，而不是从主题色板推断，
 * 这样才能与页面真正融为一体。
 */
const TOOLBAR_PROBE = `
    // 顶部工具栏的识别特征：包含「完整历史」等按钮、高度较小、横向贯穿页面。
    const findToolbar = () => {
      const keywords = ["完整历史", "生成标题", "系统", "工具"];
      const candidates = [...document.querySelectorAll("div")].filter((el) => {
        const text = el.textContent || "";
        // 文本里要包含至少两个工具栏关键字，避免误选外层容器。
        const hits = keywords.filter((k) => text.includes(k)).length;
        if (hits < 2) return false;
        const rect = el.getBoundingClientRect();
        if (rect.height < 24 || rect.height > 90) return false;
        if (rect.width < window.innerWidth * 0.5) return false;
        if (rect.top > 120) return false;
        return true;
      });
      // 取最靠内（高度最小）的那个，它就是工具栏本身而不是包裹层。
      candidates.sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height);
      return candidates[0] || null;
    };

    /** 读取顶栏实际背景色；取不到时回退到主进程给的色值。 */
    const readToolbarColor = () => {
      const toolbar = findToolbar();
      if (!toolbar) return "";
      // 逐层向上找第一个有实质背景色的元素，避免读到 transparent。
      let node = toolbar;
      for (let i = 0; i < 4 && node; i += 1) {
        const bg = getComputedStyle(node).backgroundColor;
        if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") return bg;
        node = node.parentElement;
      }
      return "";
    };

    /** 读取顶栏实际文字色，用于标题栏文字。 */
    const readToolbarTextColor = () => {
      const toolbar = findToolbar();
      if (!toolbar) return "";
      const button = toolbar.querySelector("button");
      const color = button ? getComputedStyle(button).color : "";
      return color && color !== "rgba(0, 0, 0, 0)" ? color : "";
    };
`;

/** 生成注入到主窗口页面的标题栏脚本。 */
export function buildMainTitleBarScript(data: MainTitleBarData): string {
  const payload = JSON.stringify(data).replaceAll("<", "\\u003c");
  return `(() => {
    const data = ${payload};
    const ID = "${MAIN_TITLE_BAR_ID}";
    // 重复注入时先停掉旧实例的监听并移除，避免叠出多条标题栏。
    try { window.__piWebBoxMainTitleBar?.teardown?.(); } catch (error) { void error; }
    document.getElementById(ID)?.remove();
${TOOLBAR_PROBE}

    const bar = document.createElement("div");
    bar.id = ID;
    bar.style.cssText = [
      "position:fixed", "left:0", "top:0", "right:0", "height:34px",
      "z-index:2147483647", "display:flex", "align-items:center", "gap:8px",
      "padding-left:10px", "box-sizing:border-box",
      "-webkit-app-region:drag", "user-select:none",
      'font:12px "Segoe UI",system-ui,sans-serif',
    ].join(";");

    const icon = document.createElement("img");
    icon.src = data.iconDataUrl;
    icon.alt = "";
    icon.style.cssText = "width:15px;height:15px;flex:none";

    const label = document.createElement("div");
    label.textContent = data.title;
    label.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500";

    const buttons = document.createElement("div");
    buttons.style.cssText = "display:flex;flex:none;-webkit-app-region:no-drag";

    /** 生成一个窗口按钮，样式与设置/统计窗口保持一致。 */
    const makeButton = (label, svgPath, onClick, isClose) => {
      const button = document.createElement("button");
      button.type = "button";
      button.title = label;
      button.setAttribute("aria-label", label);
      button.style.cssText = [
        "width:44px", "height:34px", "padding:0", "border:0", "background:transparent",
        "font:inherit", "font-size:12px", "cursor:pointer", "display:grid", "place-items:center",
        "transition:background .12s ease,color .12s ease",
      ].join(";");
      button.innerHTML = '<svg viewBox="0 0 10 10" style="width:10px;height:10px"><path d="' + svgPath + '" stroke="currentColor" stroke-width="1" fill="none"/></svg>';
      button.addEventListener("mouseenter", () => {
        button.style.background = isClose ? "#e81123" : data.hover;
        button.style.color = isClose ? "#fff" : data.text;
      });
      button.addEventListener("mouseleave", () => {
        button.style.background = "transparent";
        button.style.color = data.textMuted;
      });
      button.addEventListener("click", onClick);
      return button;
    };

    // 主窗口有最小化 / 最大化 / 关闭三个按钮；最大化按当前状态切换图标。
    const maxButton = makeButton("最大化", "M0.5 0.5h9v9h-9z", () => window.piWebBox?.titleBarToggleMaximize?.(), false);
    const setMaxIcon = (maximized) => {
      maxButton.title = maximized ? "向下还原" : "最大化";
      maxButton.setAttribute("aria-label", maxButton.title);
      // 最大化状态用两个叠加的方框表示「向下还原」。
      maxButton.innerHTML = maximized
        ? '<svg viewBox="0 0 10 10" style="width:10px;height:10px"><path d="M2.5 2.5h7v7h-7z M2.5 2.5v-2h7v7h-2" stroke="currentColor" stroke-width="1" fill="none"/></svg>'
        : '<svg viewBox="0 0 10 10" style="width:10px;height:10px"><path d="M0.5 0.5h9v9h-9z" stroke="currentColor" stroke-width="1" fill="none"/></svg>';
    };
    setMaxIcon(false);

    buttons.appendChild(makeButton("最小化", "M0 5h10", () => window.piWebBox?.titleBarMinimize?.(), false));
    buttons.appendChild(maxButton);
    buttons.appendChild(makeButton("关闭", "M0 0l10 10M10 0L0 10", () => window.piWebBox?.titleBarClose?.(), true));

    // 双击标题栏切换最大化，与系统行为一致。
    bar.addEventListener("dblclick", () => window.piWebBox?.titleBarToggleMaximize?.());

    bar.append(icon, label, buttons);
    document.body.appendChild(bar);
    // 给页面让出标题栏高度，避免遮住 pi-web 自己的顶栏。
    document.body.style.paddingTop = "34px";
    document.body.style.boxSizing = "border-box";

    /** 主题变化时更新配色：优先用顶栏实测色。 */
    const paint = (next) => {
      const toolbarBg = readToolbarColor();
      const toolbarText = readToolbarTextColor();
      // 不再画下边框：标题栏与 pi-web 顶栏本就同色，
      // 多一条分割线反而显得割裂（且顶栏无边框时该值会退化成文字色，
      // 浅色主题下呈现为一条黑线）。
      bar.style.borderBottom = "none";
      bar.style.background = toolbarBg || next.background;
      bar.style.color = toolbarText || next.textMuted;
      label.style.color = toolbarText || next.textMuted;
      for (const button of buttons.querySelectorAll("button")) button.style.color = toolbarText || next.textMuted;
      if (next.iconDataUrl) icon.src = next.iconDataUrl;
    };
    paint(data);

    // 顶栏可能在页面水合后才出现，这里跟随 DOM 变化重新取色。
    let repaintTimer = 0;
    const repaint = () => {
      window.clearTimeout(repaintTimer);
      repaintTimer = window.setTimeout(() => paint(data), 60);
    };
    const observer = new MutationObserver(repaint);
    observer.observe(document.body, { childList: true, subtree: true });
    window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", repaint);

    window.__piWebBoxMainTitleBar = {
      paint,
      element: bar,
      setMaximized: setMaxIcon,
      teardown: () => { observer.disconnect(); window.clearTimeout(repaintTimer); },
    };
  })()`;
}

/** 自绘标题栏的样式，颜色全部走页面主题变量。 */
export const TITLE_BAR_CSS = `
  /* 自绘标题栏：高度与 Windows 原生接近，视觉上仍是窗口标题。
     底色用 --bg-panel，与 pi-web 顶部工具栏一致，而不是页面主体底色。 */
  .titlebar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    flex: none;
    padding-left: 10px;
    background: var(--titlebar-bg, var(--bg-panel));
    border-bottom: 1px solid var(--border);
    /* 整条标题栏可拖动窗口 */
    -webkit-app-region: drag;
    user-select: none;
  }
  .titlebar .tb-icon { width: 15px; height: 15px; flex: none; }
  .titlebar .tb-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-muted);
  }
  /* 窗口按钮：不参与拖动，否则点不动 */
  .titlebar .tb-buttons { display: flex; flex: none; -webkit-app-region: no-drag; }
  .titlebar .tb-btn {
    width: 44px;
    height: 34px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    display: grid;
    place-items: center;
    transition: background .12s ease, color .12s ease;
  }
  .titlebar .tb-btn:hover { background: var(--bg-hover); color: var(--text); }
  .titlebar .tb-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  /* 关闭按钮沿用系统惯例：悬停变红 */
  .titlebar .tb-btn.close:hover { background: #e81123; color: #fff; }
  .titlebar .tb-btn svg { width: 10px; height: 10px; }
`;

/** 生成标题栏的 HTML 片段。 */
export function buildTitleBarHtml(data: TitleBarText): string {
  return `
    <div class="titlebar">
      <img class="tb-icon" id="titleBarIcon" src="${escapeAttr(data.iconDataUrl)}" alt="" />
      <div class="tb-title" id="titleBarText">${escapeText(data.title)}</div>
      <div class="tb-buttons">
        <button class="tb-btn close" type="button" id="titleBarClose" title="关闭" aria-label="关闭">
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1" />
          </svg>
        </button>
      </div>
    </div>`;
}

/** 标题栏按钮的事件绑定脚本，与主进程交互。 */
export const TITLE_BAR_SCRIPT = `
  (() => {
    const api = window.piWebBox;
    document.getElementById("titleBarClose")?.addEventListener("click", () => api?.titleBarClose?.());
    // 标题栏图标按主题深浅切换，与左上角品牌图标保持一致。
    window.__piWebBoxSetTitleBarIcon = (isDark) => {
      const icon = document.getElementById("titleBarIcon");
      const icons = window.__PI_WEB_BOX_ICONS__;
      if (icon && icons) icon.src = isDark ? icons.dark : icons.light;
    };
  })();
`;

function escapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}