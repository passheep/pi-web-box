"use strict";

// 桌面壳渲染脚本：标签栏（拖拽排序）+ 消息中心（倒序、分页懒加载、未读角标）。
// 主进程通过 window.piWebBox 的新增桌面 API 与本页通信，本页不直接接触 ipc。

const api = window.piWebBox;

const els = {
  tabs: document.getElementById("tabs"),
  newTab: document.getElementById("newTabBtn"),
  messagesBtn: document.getElementById("messagesBtn"),
  unreadBadge: document.getElementById("unreadBadge"),
  winMin: document.getElementById("winMin"),
  winMax: document.getElementById("winMax"),
  winMaxIcon: document.getElementById("winMaxIcon"),
  winClose: document.getElementById("winClose"),
  panel: document.getElementById("noticePanel"),
  refreshNew: document.getElementById("refreshNew"),
  list: document.getElementById("noticeList"),
  status: document.getElementById("noticeStatus"),
};

// ── 状态 ──
let state = {
  tabs: [],
  activeId: "",
  maximized: false,
  unread: 0,
  messagePanelOpen: false,
};

// 消息中心状态
let notices = [];            // 已加载记录，倒序（新 → 旧）
let nextCursor = null;       // 下一页游标（sequence），null 表示没有更多
let loadedThrough = 0;       // 当前已加载记录里的最大 sequence（即最新水位）
let loadingPage = false;
let loadToken = 0;           // 防并发：过期响应直接丢弃
let noticeRevision = 0;      // reset 期间收到新消息时保留刷新入口
let pageFailed = false;      // 出错后由重试按钮恢复，避免滚动反复请求
let dragTabId = null;
const PAGE_SIZE = 30;

// 标签栏渲染签名：tabs 内容 + activeId 变化才重建 DOM，避免拖拽/焦点被打断。
let lastTabsSignature = "";

function tabsSignature() {
  return JSON.stringify([
    state.activeId,
    state.tabs.map((tab) => [tab.id, tab.title, tab.loading, tab.color]),
  ]);
}

// ── 主题 ──
function applyPalette(palette) {
  if (!palette) return;
  const root = document.documentElement.style;
  root.setProperty("--bg", palette.background);
  root.setProperty("--bg-panel", palette.panel);
  root.setProperty("--border", palette.border);
  root.setProperty("--text", palette.text);
  root.setProperty("--text-muted", palette.textMuted);
  root.setProperty("--accent", palette.accent);
}

// ── 标签栏 ──
function renderTabs() {
  const maxTabs = state.maxTabs || 6;
  els.newTab.disabled = state.tabs.length >= maxTabs;
  els.newTab.title = els.newTab.disabled ? `最多打开 ${maxTabs} 个标签，请先关闭一个` : "新建标签";
  // 运行状态单独更新，不重建标签，也不打断拖拽或圆环动画。
  for (const tab of state.tabs) {
    const button = [...els.tabs.children].find((node) => node.dataset.tabId === tab.id);
    button?.querySelector(".tab-dot")?.classList.toggle("running", !!tab.running);
    if (button) button.title = tab.title + (tab.running ? "（对话进行中）" : "");
  }
  const signature = tabsSignature();
  if (signature === lastTabsSignature) return; // 名称轮询等无关变化不重建，保住拖拽与焦点
  lastTabsSignature = signature;

  els.tabs.textContent = "";
  for (const tab of state.tabs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tab" + (tab.id === state.activeId ? " active" : "");
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(tab.id === state.activeId));
    button.draggable = true;
    button.dataset.tabId = tab.id;
    button.title = tab.title + (tab.running ? "（对话进行中）" : "");
    button.addEventListener("click", () => void api?.activateTab?.(tab.id));
    // 中键不激活标签、不触发自动滚屏，抬起时仅关闭该页面。
    button.addEventListener("mousedown", (event) => { if (event.button === 1) event.preventDefault(); });
    button.addEventListener("auxclick", (event) => {
      if (event.button !== 1) return;
      event.preventDefault(); event.stopPropagation();
      void api?.closeTab?.(tab.id);
    });
    button.addEventListener("dragstart", (event) => {
      dragTabId = tab.id;
      button.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", tab.id);
    });
    button.addEventListener("dragend", () => {
      dragTabId = null;
      button.classList.remove("dragging");
      els.tabs.querySelectorAll(".drop-before").forEach((el) => el.classList.remove("drop-before"));
    });
    button.addEventListener("dragover", (event) => {
      if (!dragTabId || dragTabId === tab.id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      button.classList.add("drop-before");
    });
    button.addEventListener("dragleave", () => button.classList.remove("drop-before"));
    button.addEventListener("drop", (event) => {
      event.preventDefault();
      button.classList.remove("drop-before");
      if (dragTabId && dragTabId !== tab.id) void api?.reorderTab?.(dragTabId, tab.id);
      dragTabId = null;
    });

    const dot = document.createElement("span");
    dot.className = "tab-dot" + (tab.running ? " running" : "");
    dot.style.setProperty("--tab-color", tab.color || "#7796b5");
    dot.setAttribute("aria-hidden", "true");
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.loading ? tab.title + " …" : tab.title;

    const close = document.createElement("span");
    close.className = "tab-close";
    close.setAttribute("role", "button");
    close.setAttribute("tabindex", "-1");
    close.title = "关闭标签";
    close.setAttribute("aria-label", `关闭 ${tab.title}`);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 10 10");
    svg.setAttribute("style", "width:8px;height:8px");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M0 0l10 10M10 0L0 10");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.2");
    svg.appendChild(path);
    close.appendChild(svg);
    // 点击关闭时阻断冒泡，避免同时触发 activateTab。
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      void api?.closeTab?.(tab.id);
    });

    button.append(dot, title, close);
    els.tabs.appendChild(button);
  }
}

// 标签栏空白区域也允许拖放（拖到最末尾 = beforeId 为 null）。
els.tabs.addEventListener("dragover", (event) => {
  if (!dragTabId) return;
  event.preventDefault();
});
els.tabs.addEventListener("drop", (event) => {
  if (!dragTabId || event.target.closest(".tab")) return; // 落在标签上由标签处理
  event.preventDefault();
  void api?.reorderTab?.(dragTabId, null);
  dragTabId = null;
});

// 双击标签栏空白切换最大化。
els.tabs.addEventListener("dblclick", (event) => {
  if (event.target.closest(".tab") || event.target.closest("button")) return;
  void api?.titleBarToggleMaximize?.();
});

// ── 窗口按钮 ──
els.newTab.addEventListener("click", () => void api?.newTab?.());
els.winMin.addEventListener("click", () => void api?.titleBarMinimize?.());
els.winClose.addEventListener("click", () => void api?.titleBarClose?.());
els.winMax.addEventListener("click", () => void api?.titleBarToggleMaximize?.());

function renderMaximized(maximized) {
  els.winMax.title = maximized ? "向下还原" : "最大化";
  els.winMax.setAttribute("aria-label", els.winMax.title);
  els.winMaxIcon.setAttribute(
    "d",
    maximized
      ? "M2.5 2.5h7v7h-7z M2.5 2.5v-2h7v7h-2"
      : "M0.5 0.5h9v9h-9z",
  );
}

// ── 消息中心 ──
function renderBadge() {
  const count = state.unread;
  els.unreadBadge.textContent = count > 99 ? "99+" : count > 0 ? String(count) : "";
  els.unreadBadge.classList.toggle("show", count > 0);
  els.messagesBtn.classList.toggle("active", state.messagePanelOpen);
  els.messagesBtn.setAttribute("aria-pressed", String(state.messagePanelOpen));
}

els.messagesBtn.addEventListener("click", () => void api?.toggleMessages?.());

function setNoticeStatus(text, retry = null) {
  els.status.textContent = text || "";
  if (retry) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "重试";
    button.addEventListener("click", retry);
    els.status.appendChild(button);
  }
}

/** 只用 textContent 构建 DOM，防止消息内容里的 HTML 被执行。 */
function appendNotice(record, atTop) {
  const item = document.createElement("div");
  item.className = "notice";
  if (record.sessionId) {
    item.classList.add("clickable");
    item.title = "点击打开对应会话";
    item.addEventListener("click", () => void api?.openNoticeSession?.(record.sessionId));
  }
  item.dataset.sequence = String(record.sequence);
  item.dataset.level = record.level || "info";

  const meta = document.createElement("div");
  meta.className = "notice-meta";
  const session = document.createElement("span");
  session.className = "notice-session";
  session.textContent = record.sessionName || record.sessionId || "未知会话";
  meta.appendChild(session);
  const source = document.createElement("span");
  source.textContent = record.source || "pi"; // 来源展示
  meta.appendChild(source);
  const level = document.createElement("span");
  level.className = "notice-level";
  level.textContent = record.level || "info";
  meta.appendChild(level);
  const time = document.createElement("span");
  time.textContent = formatTime(record.createdAt);
  meta.appendChild(time);

  const text = document.createElement("div");
  text.className = "notice-text";
  text.textContent = record.message;

  item.append(meta, text);
  if (atTop) els.list.prepend(item);
  else els.list.insertBefore(item, els.status);
}

function formatTime(ts) {
  if (!ts) return "";
  const date = new Date(ts);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}-${day} ${hh}:${mm}`;
}

function renderNoticeList() {
  els.list.textContent = "";
  // 状态提示随列表滚动，始终保留在最后一条消息之后。
  els.list.appendChild(els.status);
  for (const record of notices) appendNotice(record, false);
  if (!notices.length) {
    const empty = document.createElement("div");
    empty.className = "notice empty";
    empty.textContent = "暂无消息";
    els.list.insertBefore(empty, els.status);
  }
}

// 统一的面板开合入口：所有加载/清场都从这里走，避免隐式重复加载。
function setPanelOpen(open) {
  state.messagePanelOpen = open;
  els.panel.classList.toggle("open", open);
  els.messagesBtn.classList.toggle("active", open);
  els.messagesBtn.setAttribute("aria-pressed", String(open));
  if (open) {
    // 保留旧列表和刷新提示直到最新页成功返回；reset 可覆盖旧请求。
    void loadNotices({ reset: true });
  } else {
    // 关闭面板：作废在途请求并停止加载，避免结果回来后误标已读。
    loadToken += 1;
    loadingPage = false;
  }
}

/**
 * 拉取一页消息。倒序展示：第一页是最新 30 条；滚动到底部再取更早的一页。
 * reset=true 时重新取最新页，成功后替换列表。loadToken 丢弃过期响应。
 */
async function loadNotices({ reset = false } = {}) {
  if (!state.messagePanelOpen) return; // 面板未打开不加载、不标已读
  if (loadingPage && !reset) return;
  loadingPage = true;
  pageFailed = false;
  const token = ++loadToken; // reset 即使有旧请求也会作废旧令牌
  const revisionAtStart = noticeRevision;
  if (reset) els.list.scrollTop = 0;
  setNoticeStatus("加载中…");
  try {
    const query = reset || !notices.length
      ? { limit: PAGE_SIZE }
      : { before: nextCursor ?? notices[notices.length - 1].sequence, limit: PAGE_SIZE };
    const page = await api?.queryNotices?.(query);
    if (token !== loadToken) return; // 已有更新的请求（面板重开/关闭），丢弃过期结果
    if (!page || !Array.isArray(page.items)) throw new Error("Invalid notice page");
    if (reset) {
      notices = page.items.slice();
      renderNoticeList();
      els.list.scrollTop = 0;
      // 仅成功重置才清除提示；请求期间来的新消息可能不在这页中。
      if (noticeRevision === revisionAtStart) els.refreshNew.classList.remove("show");
    } else {
      // 去重合并（正常不会重复，防御一下）
      const seen = new Set(notices.map((item) => item.sequence));
      for (const record of page.items) {
        if (!seen.has(record.sequence)) {
          seen.add(record.sequence);
          notices.push(record);
          appendNotice(record, false);
        }
      }
    }
    nextCursor = page.nextCursor;
    // 已加载列表里最大的 sequence 即最新水位，只有面板打开时才上报。
    const previousThrough = loadedThrough;
    loadedThrough = notices.reduce((max, item) => Math.max(max, item.sequence), 0);
    if (loadedThrough > 0 && (reset || loadedThrough > previousThrough)) {
      // 不借用其他页/旧列表的水位，也不采用通知总数标记尚未加载的消息。
      Promise.resolve(api?.markNoticesRead?.(loadedThrough)).catch(() => {
        // 标记失败不伪装成查询失败；重新打开面板时会重试标记。
      });
    }
    setNoticeStatus(nextCursor === null && notices.length ? "没有更早的消息了" : "");
  } catch {
    if (token !== loadToken) return;
    pageFailed = true;
    // 重试原来的请求模式：刷新失败不能误变成向后翻页。
    setNoticeStatus("消息加载失败", () => void loadNotices({ reset }));
  } finally {
    if (token === loadToken) loadingPage = false;
  }
}

// 滚动到底部加载下一页。
els.list.addEventListener("scroll", () => {
  const el = els.list;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
    if (nextCursor !== null && !loadingPage && !pageFailed) void loadNotices();
  }
});

// 面板打开期间来了新消息：不扰动旧列表，显示刷新按钮。
els.refreshNew.addEventListener("click", () => {
  void loadNotices({ reset: true });
});

// 主进程推送：{ hasNew: true, unread }。
function onNoticesChanged(payload = {}) {
  if (typeof payload.unread === "number") {
    state.unread = payload.unread;
    renderBadge();
  }
  if (payload.hasNew) {
    noticeRevision += 1;
    if (state.messagePanelOpen) els.refreshNew.classList.add("show");
  }
}

// ── 状态渲染 ──
function renderState(next, previous = {}) {
  state = { ...state, ...next };
  renderTabs();
  renderBadge();
  renderMaximized(state.maximized);
  // 面板开合统一走 setPanelOpen，控制加载与清场。
  if (state.messagePanelOpen !== previous.messagePanelOpen) {
    setPanelOpen(state.messagePanelOpen);
  }
}

// ── 启动 ──
// 先注册监听再取初始状态，避免 getDesktopState 期间到来的状态/主题推送被错过。
let stateRevision = 0;
let unreadRevision = 0;
const unsubscribe = [
  api?.onDesktopState?.((next) => {
    if (!next) return;
    stateRevision += 1;
    renderState(next, state);
  }),
  api?.onNoticesChanged?.((payload) => {
    unreadRevision += 1;
    onNoticesChanged(payload);
  }),
  api?.onDesktopTheme?.(applyPalette),
];
window.addEventListener("unload", () => {
  loadToken += 1;
  for (const stop of unsubscribe) if (typeof stop === "function") stop();
}, { once: true });

(async () => {
  try {
    const revisionAtStart = stateRevision;
    const unreadAtStart = unreadRevision;
    const initial = await api?.getDesktopState?.();
    // 注意：启动时即使 unread>0 也不加载消息、不标已读——
    // 标记已读只发生在面板打开并成功加载之后。
    // 较晚返回的初始快照不能覆盖已收到的状态推送。
    if (initial && stateRevision === revisionAtStart) {
      if (unreadRevision !== unreadAtStart) initial.unread = state.unread;
      renderState(initial, state);
    }
  } catch {
    /* 主进程尚未就绪时静默，等推送 */
  }
})();
