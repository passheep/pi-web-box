"use strict";

// 设置窗口渲染脚本：负责表单读写、保存提示、重启确认和主题跟随。
const api = window.piWebBox;

const fields = {
  traySwitch: document.getElementById("traySwitch"),
  port: document.getElementById("port"),
  hostname: document.getElementById("hostname"),
  allowedHosts: document.getElementById("allowedHosts"),
  password: document.getElementById("password"),
  commandPath: document.getElementById("commandPath"),
  nodePath: document.getElementById("nodePath"),
};

const status = document.getElementById("status");
const commandLine = document.getElementById("commandLine");
const themeName = document.getElementById("themeName");

// 把设置填进表单，密码按原值回填，方便用户直接修改。
function renderForm(data) {
  fields.traySwitch.checked = data.settings.minimizeToTrayOnClose;
  fields.port.value = data.settings.piWeb.port;
  fields.hostname.value = data.settings.piWeb.hostname;
  fields.allowedHosts.value = data.settings.piWeb.allowedHosts;
  fields.password.value = data.settings.piWeb.password;
  fields.commandPath.value = data.settings.piWeb.commandPath;
  fields.nodePath.value = data.settings.piWeb.nodePath;
  commandLine.textContent = data.commandLine || "—";
}

function collectForm() {
  return {
    minimizeToTrayOnClose: fields.traySwitch.checked,
    piWeb: {
      port: fields.port.value.trim(),
      hostname: fields.hostname.value.trim(),
      allowedHosts: fields.allowedHosts.value.trim(),
      password: fields.password.value,
      commandPath: fields.commandPath.value.trim(),
      nodePath: fields.nodePath.value.trim(),
    },
  };
}

function setStatus(message, kind) {
  status.textContent = message || "";
  status.className = "status" + (kind ? " " + kind : "");
}

async function save() {
  setStatus("正在保存…");
  const result = await api.saveSettings(collectForm());
  if (!result.ok) {
    setStatus(result.message, "err");
    return;
  }
  if (result.snapshot) renderForm(result.snapshot);
  setStatus("已保存，重启 Pi Web Box 后生效", "ok");
}

async function restoreDefaults() {
  const result = await api.resetSettings();
  if (result.snapshot) renderForm(result.snapshot);
  setStatus(result.ok ? "已恢复默认设置，重启后生效" : result.message, result.ok ? "ok" : "err");
}

// 左侧导航切换，两个模块互斥显示。
document.getElementById("nav").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-pane]");
  if (!button) return;
  for (const item of document.querySelectorAll("#nav button")) {
    item.setAttribute("aria-current", String(item === button));
  }
  for (const pane of document.querySelectorAll(".pane")) {
    pane.hidden = pane.id !== "pane-" + button.dataset.pane;
  }
});

document.getElementById("save").addEventListener("click", () => void save());
document.getElementById("resetPiWeb").addEventListener("click", () => void restoreDefaults());

// 「关闭后最小化至托盘」是开关，改完立即保存，避免用户忘记点保存。
fields.traySwitch.addEventListener("change", async () => {
  const result = await api.saveSettings(collectForm());
  if (!result.ok) {
    setStatus(result.message, "err");
    fields.traySwitch.checked = !fields.traySwitch.checked;
    return;
  }
  setStatus(
    fields.traySwitch.checked ? "已开启：关闭窗口后留在托盘" : "已关闭：关闭窗口将退出应用",
    "ok",
  );
});

// 标题栏通常会自动跟随主题，这里提供手动兜底。
document.getElementById("refreshTitleBar").addEventListener("click", async () => {
  await api.refreshTitleBar();
  setStatus("已重新同步标题栏外观", "ok");
});

// 重启会中断正在进行的操作，二次确认后再执行。
document.getElementById("restart").addEventListener("click", () => {
  if (!window.confirm("确定要重启 Pi Web Box 吗？\n\n当前的 Pi Web 服务会重新启动，正在进行的操作可能中断。")) return;
  setStatus("正在重启…");
  void api.restartApp();
});

// Pi Web 切换主题时实时同步设置窗口配色，无需重开窗口。
api.onSettingsTheme(({ palette }) => {
  const root = document.documentElement;
  root.style.setProperty("--bg", palette.background);
  root.style.setProperty("--bg-panel", palette.panel);
  root.style.setProperty("--border", palette.border);
  root.style.setProperty("--text", palette.text);
  root.style.setProperty("--text-muted", palette.textMuted);
  root.style.setProperty("--accent", palette.accent);
  root.dataset.theme = palette.id;
  themeName.textContent = palette.label;
});

api.getSettings().then((data) => {
  renderForm(data);
  themeName.textContent = data.themeLabel || "—";
});
