"use strict";

// 错误页：正常启动失败与「环境缺失」两种阻断场景共用同一页，
// 文案与可用按钮按主进程给出的 kind 切换，避免为用户多做一个启动页。
const api = window.piWebBox;
const title = document.getElementById("title");
const message = document.getElementById("message");
const details = document.getElementById("details");
const hint = document.getElementById("hint");
const retry = document.getElementById("retry");
const download = document.getElementById("download");
const log = document.getElementById("log");

const NODE_DOWNLOAD_URL = "https://nodejs.org/zh-cn/download";
const DEFAULT_HINT = '请确认 Node.js ≥ 22.19.0，并已执行 <code>npm install -g @agegr/pi-web@latest</code>。';

api.getStatus().then((status) => {
  const kind = status?.kind || "";
  title.textContent = kind === "npm-missing" ? "未检测到 Node.js 与 npm" : "Pi Web 启动失败";
  message.textContent = status?.message || "无法启动本地 Pi Web 服务。";
  details.textContent = status?.details || "";
  details.hidden = !status?.details;
  // 缺 npm 时给出下载入口；其它失败保留原有的排查提示。
  download.hidden = kind !== "npm-missing";
  hint.innerHTML = kind === "npm-missing"
    ? "请安装 Node.js 22.19.0 或更高版本（自带 npm），安装完成后回到本页点「重试」。"
    : DEFAULT_HINT;
});

retry.addEventListener("click", () => api.retryStartup());
download.addEventListener("click", () => api.openExternal(NODE_DOWNLOAD_URL));
log.addEventListener("click", () => api.openLog());
