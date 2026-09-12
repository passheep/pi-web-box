"use strict";

const api = window.piWebBox;
const title = document.getElementById("title");
const message = document.getElementById("message");
const detail = document.getElementById("detail");
const progress = document.getElementById("progress");
const progressBar = document.getElementById("progress-bar");

function render(state) {
  if (!state) return;
  title.textContent = state.title || "正在启动 Pi Web";
  message.textContent = state.message || "正在准备本地服务，请稍候…";
  detail.textContent = state.detail || "";
  detail.hidden = !state.detail;

  const percent = Number.isFinite(state.percent) ? Math.max(0, Math.min(100, state.percent)) : 0;
  progress.classList.toggle("indeterminate", Boolean(state.indeterminate));
  progressBar.style.width = state.indeterminate ? "35%" : `${percent}%`;
  progress.setAttribute("aria-valuenow", String(Math.round(percent)));
}

api.getStartupProgress().then(render);
api.onStartupProgress(render);
