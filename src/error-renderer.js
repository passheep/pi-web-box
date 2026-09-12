"use strict";

const api = window.piWebBox;
const message = document.getElementById("message");
const details = document.getElementById("details");

api.getStatus().then((status) => {
  message.textContent = status.message || "无法启动本地 Pi Web 服务。";
  details.textContent = status.details || "";
});

document.getElementById("retry").addEventListener("click", () => api.retryStartup());
document.getElementById("log").addEventListener("click", () => api.openLog());
