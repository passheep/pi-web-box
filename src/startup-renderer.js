"use strict";

const api = window.piWebBox;
const title = document.getElementById("title");
const message = document.getElementById("message");
const detail = document.getElementById("detail");
const progress = document.getElementById("progress");
const progressBar = document.getElementById("progress-bar");
const resetButton = document.getElementById("reset");
const resetHint = document.getElementById("reset-hint");

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

// 重置入口：配置写错导致 Pi Web 起不来时，用它恢复到自动探测。
resetButton.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "确定要重置 Pi Web Box 配置吗？\n\n盒子设置和 pi-web 启动参数都会恢复默认，启动命令回到自动探测。",
  );
  if (!confirmed) return;
  resetButton.disabled = true;
  resetHint.textContent = "正在重置…";
  const result = await api.resetStartupConfig();
  resetHint.textContent = result.ok
    ? "已重置，请点「重试」重新启动"
    : (result.message || "重置失败");
  resetButton.disabled = false;
});

api.getStartupProgress().then(render);
api.onStartupProgress(render);

// 启动失败时把重试按钮和重置入口一起呈现，方便用户自助恢复。
const retryButton = document.getElementById("retry");
retryButton.addEventListener("click", async () => {
  retryButton.disabled = true;
  resetHint.textContent = "正在重试…";
  await api.retryStartup();
  retryButton.disabled = false;
  resetHint.textContent = "";
});

api.getStatus().then((status) => {
  if (!status || !status.details) return;
  if (/失败|错误|不存在|找不到/.test(status.message || "")) {
    retryButton.hidden = false;
    resetHint.textContent = "如果一直启动失败，可以尝试重置配置。";
  }
});
