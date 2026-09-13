import type { ThemePalette } from "./themes.js";

export type EnhancePanelData = {
  // 当前主题色板，注入按钮需要与 pi-web 现有按钮视觉一致。
  palette: ThemePalette;
  // 是否已经配置好增强模型。
  configured: boolean;
  scenes: Array<{ id: string; label: string }>;
  defaultScene: string;
};

const PANEL_ID = "pi-web-box-enhance";

/**
 * 生成注入到 Pi Web 输入区的提示词增强控件。
 *
 * 定位策略：pi-web 没有稳定的类名，这里以 title="Change model" 的按钮作为锚点，
 * 找到它所在的那一行按钮容器后把控件插入容器末尾，避免依赖易变的类名。
 */
export function buildEnhancePanelScript(data: EnhancePanelData): string {
  const payload = JSON.stringify({
    configured: data.configured,
    scenes: data.scenes,
    defaultScene: data.defaultScene,
    accent: data.palette.accent,
    border: data.palette.border,
    panel: data.palette.panel,
    text: data.palette.text,
    textMuted: data.palette.textMuted,
    background: data.palette.background,
  }).replaceAll("<", "\\u003c");

  return `(() => {
    const data = ${payload};
    // 重复注入时要把旧实例彻底停掉：仅靠 remove() 删元素不够，
    // 旧实例的 MutationObserver 与定时器还会把它 appendChild 回来，
    // 表现为每保存一次设置就多出一个控件。
    for (const stale of document.querySelectorAll("#${PANEL_ID}")) {
      try { stale.__piWebBoxTeardown?.(); } catch (error) { void error; }
      stale.remove();
    }

    const host = document.createElement("div");
    host.id = "${PANEL_ID}";
    // 占位尺寸与模型按钮一致，注入时不会把同一行的其它按钮挤走。
    host.style.cssText = "display:inline-flex;align-items:center;height:32px;flex:none";

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = \`
      <style>
        /* all:initial 会清掉继承来的自定义属性，所以这里显式声明一套变量，
           否则 var(--text) 之类的引用全部失效，文字会回退成黑色。 */
        :host {
          all: initial;
          --text: ${data.palette.text};
          --muted: ${data.palette.textMuted};
          --border: ${data.palette.border};
          --panel: ${data.palette.panel};
          --bg: ${data.palette.background};
          --accent: ${data.palette.accent};
          --hover: ${data.palette.panel};
        }
        /* 样式对齐 pi-web 的模型选择按钮：32px 高、9px 圆角、12px 字号。 */
        .wrap { position: relative; display: inline-flex; align-items: center; gap: 2px; font-family: "Segoe UI", system-ui, sans-serif; }
        button { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border: 0; border-radius: 9px; background: transparent; color: var(--muted); font: inherit; font-size: 12px; font-weight: 400; cursor: pointer; transition: background .12s ease, color .12s ease; }
        button:hover:not(:disabled) { background: var(--hover); color: var(--text); }
        button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
        button:disabled { opacity: .5; cursor: not-allowed; }
        button svg { width: 14px; height: 14px; flex: none; }
        select { height: 32px; padding: 0 6px; border: 0; border-radius: 9px; background: transparent; color: var(--muted); font: inherit; font-size: 12px; cursor: pointer; transition: background .12s ease, color .12s ease; }
        select:hover { background: var(--hover); color: var(--text); }
        select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
        /* 「回到底部」按钮：固定在右下角圆形 logo 上方 */
        .to-bottom { position: fixed; right: 26px; bottom: 78px; z-index: 2147483646; width: 38px; height: 38px; padding: 0; justify-content: center; border: 1px solid var(--border); border-radius: 50%; background: var(--bg); color: var(--text); box-shadow: 0 3px 12px rgba(0,0,0,.16); opacity: 0; visibility: hidden; transform: translateY(6px); transition: opacity 160ms ease, transform 160ms ease, visibility 0s linear 160ms; }
        .to-bottom.show { opacity: 1; visibility: visible; transform: translateY(0); transition-delay: 0s; }
        .to-bottom:hover { background: var(--hover); }
        .to-bottom .badge { position: absolute; top: -4px; right: -4px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: var(--accent); color: #fff; font-size: 10px; line-height: 16px; font-weight: 650; display: none; }
        .to-bottom.has-new .badge { display: block; }
        /* 弹窗 */
        .dialog { position: fixed; inset: 0; z-index: 2147483647; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,.42); }
        .dialog.open { display: flex; }
        .card { width: min(720px, calc(100vw - 40px)); max-height: calc(100vh - 80px); display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 12px; background: var(--bg); color: var(--text); box-shadow: 0 20px 60px rgba(0,0,0,.36); overflow: hidden; }
        .head { display: flex; align-items: center; justify-content: space-between; padding: 13px 16px; border-bottom: 1px solid var(--border); }
        .head b { font-size: 14px; font-weight: 650; }
        .head .close { width: 28px; height: 28px; padding: 0; justify-content: center; border-radius: 7px; }
        .body { padding: 14px 16px; overflow: auto; }
        .label { margin-bottom: 6px; font-size: 12px; color: var(--muted); }
        .box { width: 100%; box-sizing: border-box; min-height: 120px; max-height: 300px; padding: 10px 12px; overflow: auto; border: 1px solid var(--border); border-radius: 9px; background: var(--panel); color: var(--text); font: 13px/1.65 "Segoe UI", system-ui, sans-serif; white-space: pre-wrap; overflow-wrap: anywhere; }
        .box.original { color: var(--muted); }
        .foot { display: flex; align-items: center; gap: 9px; padding: 12px 16px; border-top: 1px solid var(--border); }
        .foot .spacer { flex: 1; }
        .foot .status { font-size: 12px; color: var(--muted); }
        .primary { background: var(--accent) !important; color: var(--accent-contrast, #fff) !important; padding: 0 14px !important; font-weight: 550 !important; }
        .primary:hover:not(:disabled) { filter: brightness(1.08); }
        .danger { color: #c0392b !important; }
        .spin { width: 13px; height: 13px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin .7s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { button, .dialog .card, .spin { transition: none; animation: none; } }
      </style>
      <div class="wrap">
        <select id="scene" title="选择增强场景" aria-label="增强场景">
          \${data.scenes.map((s) => \`<option value="\${s.id}">\${s.label}</option>\`).join("")}
        </select>
        <button id="enhance" type="button" title="用 AI 优化输入框中的提示词">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"></path></svg>
          <span>增强</span>
        </button>
        <button class="to-bottom" id="toBottom" type="button" title="回到底部" aria-label="回到底部">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"></path></svg>
          <span class="badge" id="badge"></span>
        </button>
      </div>
      <div class="dialog" id="dialog" role="dialog" aria-modal="true" aria-label="提示词增强">
        <div class="card">
          <div class="head"><b id="dialogTitle">提示词增强</b><button class="close" id="dialogClose" type="button" aria-label="关闭">✕</button></div>
          <div class="body">
            <div class="label" id="originalLabel">原文</div>
            <div class="box original" id="original"></div>
            <div class="label" id="resultLabel" style="margin-top:14px">增强结果</div>
            <div class="box" id="result"></div>
          </div>
          <div class="foot">
            <button id="accept" class="primary" type="button">接受并替换</button>
            <button id="regenerate" type="button">重新生成</button>
            <span class="spacer"></span>
            <span class="status" id="status"></span>
            <button id="cancel" class="danger" type="button">取消</button>
          </div>
        </div>
      </div>
    \`;

  const root = shadow;
  const sceneSelect = root.getElementById("scene");
  const enhanceButton = root.getElementById("enhance");
  const toBottom = root.getElementById("toBottom");
  const badge = root.getElementById("badge");
  const dialog = root.getElementById("dialog");
  const originalBox = root.getElementById("original");
  const resultBox = root.getElementById("result");
  const statusText = root.getElementById("status");
  const acceptButton = root.getElementById("accept");
  const regenerateButton = root.getElementById("regenerate");
  const cancelButton = root.getElementById("cancel");
  const closeButton = root.getElementById("dialogClose");

  sceneSelect.value = data.defaultScene;

  // ── 定位输入框与滚动容器 ──
  const getEditor = () => document.querySelector("textarea.chat-input-textarea") ||
    document.querySelector("textarea") || document.querySelector('[contenteditable="true"]');

  const setEditorText = (text) => {
    const editor = getEditor();
    if (!editor) return false;
    if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") {
      // 用原生 setter 触发 React 的受控更新，否则状态不会同步。
      const proto = editor.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(editor, text); else editor.value = text;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    editor.focus();
    return true;
  };

  const getEditorText = () => {
    const editor = getEditor();
    if (!editor) return "";
    return editor.tagName === "TEXTAREA" || editor.tagName === "INPUT" ? editor.value : editor.textContent || "";
  };

  // 聊天滚动容器。pi-web 的消息区通常是输入框的兄弟节点而不是祖先，
  // 所以先找祖先，再用「与输入框水平对齐」筛选，避免误绑到左侧会话列表。
  const getScroller = () => {
    const editor = getEditor();
    const isScrollable = (el) => {
      const style = getComputedStyle(el);
      return /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 4;
    };

    let node = editor?.parentElement;
    while (node && node !== document.body) {
      if (isScrollable(node)) return node;
      node = node.parentElement;
    }

    // 候选池：可滚动且高度足够的容器。
    const candidates = [...document.querySelectorAll("div")].filter(
      (el) => isScrollable(el) && el.clientHeight > 120,
    );
    if (!candidates.length) return null;

    const editorRect = editor?.getBoundingClientRect();
    if (editorRect && editorRect.width > 0) {
      // 与输入框水平重叠超过一半的容器才可能是聊天区，侧边栏在这里会被排除。
      const aligned = candidates.filter((el) => {
        const rect = el.getBoundingClientRect();
        const overlap = Math.min(rect.right, editorRect.right) - Math.max(rect.left, editorRect.left);
        return overlap > editorRect.width * 0.5;
      });
      if (aligned.length) {
        return aligned.sort((a, b) => b.clientHeight - a.clientHeight)[0];
      }
      // 没有任何容器与输入框对齐，说明消息区当前不可滚动，此时不需要回到底部按钮。
      return null;
    }

    return candidates.sort((a, b) => b.clientHeight - a.clientHeight)[0];
  };

  // ── 回到底部：滚动时淡入淡出，不在底部时显示新消息角标 ──
  let scroller = null;
  let lastScrollHeight = 0;

  const updateToBottom = () => {
    // 找不到聊天滚动区（或消息不足一屏）时不显示按钮，避免出现一个按不动的悬浮球。
    if (!scroller) {
      toBottom.classList.remove("show", "has-new");
      badge.textContent = "";
      return;
    }
    const distance = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    const atBottom = distance < 40;
    toBottom.classList.toggle("show", !atBottom);
    if (atBottom) {
      toBottom.classList.remove("has-new");
      badge.textContent = "";
    }
  };

  const attachScroller = () => {
    const found = getScroller();
    if (found === scroller) return;
    if (scroller) scroller.removeEventListener("scroll", updateToBottom);
    scroller = found;
    if (scroller) {
      scroller.addEventListener("scroll", updateToBottom, { passive: true });
      lastScrollHeight = scroller.scrollHeight;
    }
    // 无论有没有找到容器都要刷新一次，让按钮在不可滚动时隐藏。
    updateToBottom();
  };

  // 消息变多时滚动高度会变化，用它判断是否出现新内容。
  const watchNewMessages = () => {
    if (!scroller) return;
    if (scroller.scrollHeight > lastScrollHeight + 20) {
      const distance = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      if (distance >= 40) {
        badge.textContent = "新";
        toBottom.classList.add("has-new");
      }
    }
    lastScrollHeight = scroller.scrollHeight;
  };

  toBottom.addEventListener("click", () => {
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    toBottom.classList.remove("has-new");
    badge.textContent = "";
  });

  // ── 控件归位 ──
  // pi-web 是客户端渲染的：页面刚打开时工具栏可能还没挂载。
  // 未找到锚点前先隐藏控件，避免它先在左侧出现、等模型加载完成后再跳位。
  let placedInToolbar = false;
  const placePanel = () => {
    const anchor = [...document.querySelectorAll("button")].find(
      (button) => (button.getAttribute("title") || "").trim() === "Change model",
    );
    const row = anchor?.parentElement?.parentElement || anchor?.parentElement;
    if (row) {
      if (host.parentElement !== row) row.appendChild(host);
      // 回到工具栏后清掉兜底定位与隐藏状态。
      host.style.position = "";
      host.style.right = "";
      host.style.bottom = "";
      host.style.zIndex = "";
      host.style.visibility = "";
      placedInToolbar = true;
      return;
    }
    // 锚点还没出现：保持隐藏占位，等下一轮 MutationObserver 再试。
    if (!placedInToolbar) host.style.visibility = "hidden";
  };

  const observer = new MutationObserver(() => {
    placePanel();
    attachScroller();
    watchNewMessages();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const pollTimer = setInterval(() => { placePanel(); attachScroller(); watchNewMessages(); }, 1500);
  // 首屏渲染很快，先用高频短轮询把控件尽早放到正确位置，
  // 避免模型按钮出现前控件长时间隐藏。
  let fastTicks = 0;
  const fastTimer = setInterval(() => {
    placePanel();
    fastTicks += 1;
    if (placedInToolbar || fastTicks > 40) clearInterval(fastTimer);
  }, 80);

  // 主题变化时同步控件配色。
  const themeObserver = new MutationObserver(() => {
    const cs = getComputedStyle(document.documentElement);
    const read = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    const root = shadow.host;
    root.style.setProperty("--text", read("--text", data.text));
    root.style.setProperty("--muted", read("--text-muted", data.textMuted));
    root.style.setProperty("--border", read("--border", data.border));
    root.style.setProperty("--panel", read("--bg-panel", data.panel));
    root.style.setProperty("--bg", read("--bg", data.background));
    root.style.setProperty("--accent", read("--accent", data.accent));
    root.style.setProperty("--hover", read("--bg-panel", data.panel));
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });

  // 供下一次注入调用：先停掉本实例的监听与定时器，再让新实例接管。
  host.__piWebBoxTeardown = () => {
    observer.disconnect();
    themeObserver.disconnect();
    clearInterval(pollTimer);
    clearInterval(fastTimer);
    if (scroller) scroller.removeEventListener("scroll", updateToBottom);
  };

  // ── 增强流程 ──
  let lastOriginal = "";
  let lastResult = "";
  let busy = false;

  const setBusy = (value) => {
    busy = value;
    enhanceButton.disabled = value;
    acceptButton.disabled = value;
    regenerateButton.disabled = value;
    if (value) {
      statusText.innerHTML = '<span style="display:inline-flex;align-items:center;gap:6px"><span class="spin"></span>正在生成…</span>';
    } else {
      statusText.textContent = "";
    }
  };

  const openDialog = (original) => {
    lastOriginal = original;
    originalBox.textContent = original;
    resultBox.textContent = "";
    dialog.classList.add("open");
  };
  const closeDialog = () => {
    dialog.classList.remove("open");
    setBusy(false);
  };

  const run = async (original) => {
    setBusy(true);
    resultBox.textContent = "";
    const response = await window.piWebBox.enhancePrompt({
      draft: original,
      scene: sceneSelect.value,
    });
    setBusy(false);
    if (!response || !response.ok) {
      statusText.textContent = response?.message || "生成失败";
      return;
    }
    lastResult = response.text;
    resultBox.textContent = response.text;
    statusText.textContent = "已生成，可接受或重新生成";
  };

  enhanceButton.addEventListener("click", () => {
    if (busy) return;
    const original = getEditorText();
    if (!original.trim()) {
      statusText.textContent = "输入框为空";
      return;
    }
    openDialog(original);
    void run(original);
  });

  acceptButton.addEventListener("click", () => {
    if (!lastResult) return;
    if (!setEditorText(lastResult)) {
      statusText.textContent = "未找到输入框，无法替换";
      return;
    }
    closeDialog();
  });

  regenerateButton.addEventListener("click", () => {
    if (busy || !lastOriginal) return;
    void run(lastOriginal);
  });

  cancelButton.addEventListener("click", closeDialog);
  closeButton.addEventListener("click", closeDialog);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) closeDialog(); });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dialog.classList.contains("open")) closeDialog();
  });

  // 未配置增强模型时给出明确提示，而不是静默失败。
  if (!data.configured) {
    enhanceButton.title = "尚未在 Box 设置中选择用于增强的模型";
  }

  // ── 插入到模型按钮所在行的末尾 ──
  placePanel();
  window.__piWebBoxEnhance = { closeDialog, getEditorText, setEditorText };
})()`;
}
