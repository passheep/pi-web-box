"use strict";

// 设置窗口渲染脚本：表单读写、插件安装、增强模型选择、关于信息与主题跟随。
const api = window.piWebBox;

const fields = {
  traySwitch: document.getElementById("traySwitch"),
  trayIconSwitch: document.getElementById("trayIconSwitch"),
  port: document.getElementById("port"),
  hostname: document.getElementById("hostname"),
  allowedHosts: document.getElementById("allowedHosts"),
  password: document.getElementById("password"),
  commandPath: document.getElementById("commandPath"),
  nodePath: document.getElementById("nodePath"),
  enhanceProvider: document.getElementById("enhanceProvider"),
  enhanceModel: document.getElementById("enhanceModel"),
};

const statusEl = document.getElementById("status");
const commandLine = document.getElementById("commandLine");
const themeName = document.getElementById("themeName");
const lanRow = document.getElementById("lanRow");
const lanAddress = document.getElementById("lanAddress");
const extHint = document.getElementById("extHint");
const installExt = document.getElementById("installExt");
const enhanceStatus = document.getElementById("enhanceStatus");
const aboutVersion = document.getElementById("aboutVersion");
const aboutQq = document.getElementById("aboutQq");
const aboutRuntime = document.getElementById("aboutRuntime");
const aboutStatus = document.getElementById("aboutStatus");

let snapshot = null;
let providers = [];

function setStatus(element, message, kind) {
  element.textContent = message || "";
  element.className = "status" + (kind ? " " + kind : "");
}

// ── 表单填充与收集 ──
function renderForm(data) {
  fields.traySwitch.checked = data.settings.minimizeToTrayOnClose;
  fields.trayIconSwitch.checked = data.settings.showTrayIcon;
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
    showTrayIcon: fields.trayIconSwitch.checked,
    piWeb: {
      port: fields.port.value.trim(),
      hostname: fields.hostname.value.trim(),
      allowedHosts: fields.allowedHosts.value.trim(),
      password: fields.password.value,
      commandPath: fields.commandPath.value.trim(),
      nodePath: fields.nodePath.value.trim(),
    },
    enhance: {
      provider: fields.enhanceProvider.value,
      model: fields.enhanceModel.value,
    },
  };
}

// ── 增强模型下拉 ──
function renderProviders(data) {
  providers = data.providers || [];
  const withKey = providers.filter((provider) => provider.hasApiKey);
  const current = { ...data.settings.enhance };

  fields.enhanceProvider.innerHTML = '<option value="">未选择</option>';
  for (const provider of withKey) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = `${provider.name}（${provider.id}）`;
    fields.enhanceProvider.appendChild(option);
  }
  fields.enhanceProvider.value = withKey.some((p) => p.id === current.provider) ? current.provider : "";
  renderModels(current.model);

  // 没有任何可用供应商时给出说明，而不是留一个空下拉。
  if (withKey.length === 0) {
    fields.enhanceProvider.innerHTML = '<option value="">未找到已配置 API Key 的供应商</option>';
    constrainModel("请先在 pi 中配置模型与 API Key", true);
  }
}

function constrainModel(placeholder, disabled) {
  fields.enhanceModel.innerHTML = `<option value="">${placeholder}</option>`;
  fields.enhanceModel.disabled = !!disabled;
}

function renderModels(selected) {
  const provider = providers.find((item) => item.id === fields.enhanceProvider.value);
  if (!provider) {
    constrainModel("请先选择供应商", true);
    return;
  }
  fields.enhanceModel.disabled = false;
  fields.enhanceModel.innerHTML = '<option value="">未选择</option>';
  for (const model of provider.models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.name && model.name !== model.id ? `${model.name}（${model.id}）` : model.id;
    fields.enhanceModel.appendChild(option);
  }
  fields.enhanceModel.value = selected && provider.models.some((m) => m.id === selected) ? selected : "";
}

fields.enhanceProvider.addEventListener("change", () => renderModels(""));

// ── 保存与重置 ──

/** 监听地址已开放到局域网时，提醒用户必须设置访问密码。 */
function needsPassword(hostname, password) {
  const host = (hostname || "").trim().toLowerCase();
  const isLoopback = !host || host === "127.0.0.1" || host === "localhost" || host === "::1";
  return !isLoopback && !(password || "").trim();
}

/** 监听地址从本机改为局域网（或反向）时需要重启才能生效。 */
function needsRestart(previous, next) {
  const keys = ["port", "hostname", "allowedHosts", "password", "commandPath", "nodePath"];
  return keys.some((key) => (previous.piWeb?.[key] || "") !== (next.piWeb?.[key] || ""));
}

async function save() {
  const form = collectForm();

  // 开放到局域网但没有密码时用弹框提醒，比底部提示更明显。
  if (needsPassword(form.piWeb.hostname, form.piWeb.password)) {
    setStatus(statusEl, "监听地址已开放到局域网，请设置访问密码", "err");
    window.alert(
      "监听主机名不是本机回环地址，Pi Web 将暴露到局域网。\n\n" +
      "请先在「访问密码」中设置一个足够长的密码，再点保存。",
    );
    fields.password.focus();
    return false;
  }

  const before = snapshot ? JSON.parse(JSON.stringify(snapshot.settings)) : null;
  setStatus(statusEl, "正在保存…");
  const result = await api.saveSettings(form);
  if (!result.ok) {
    setStatus(statusEl, result.message, "err");
    return false;
  }
  if (result.snapshot) {
    snapshot = result.snapshot;
    renderForm(result.snapshot);
    renderProviders(result.snapshot);
    renderLan(result.snapshot);
  }

  // 启动参数变了就询问是否立即重启；取消则把配置回退到保存之前。
  if (before && result.snapshot && needsRestart(before, result.snapshot.settings)) {
    const confirmed = window.confirm(
      "启动参数已保存，需要重启 Pi Web Box 才能生效。\n\n" + "现在重启吗？选择“取消”将放弃本次修改。",
    );
    if (confirmed) {
      setStatus(statusEl, "正在重启…", "ok");
      void api.restartApp();
      return true;
    }
    const rollback = await api.saveSettings(before);
    if (rollback.snapshot) {
      snapshot = rollback.snapshot;
      renderForm(rollback.snapshot);
      renderProviders(rollback.snapshot);
      renderLan(rollback.snapshot);
    }
    setStatus(statusEl, "已取消，配置已回退", "err");
    return false;
  }

  setStatus(statusEl, "已保存，重启 Pi Web Box 后生效", "ok");
  return true;
}

document.getElementById("save").addEventListener("click", () => void save());

document.getElementById("saveEnhance").addEventListener("click", async () => {
  setStatus(enhanceStatus, "正在保存…");
  const result = await api.saveSettings(collectForm());
  if (!result.ok) {
    setStatus(enhanceStatus, result.message, "err");
    return;
  }
  if (result.snapshot) {
    snapshot = result.snapshot;
    renderProviders(result.snapshot);
  }
  // 增强模型属于立即生效的配置，不涉及重启。
  setStatus(enhanceStatus, "已保存，即刻生效", "ok");
});

document.getElementById("resetPiWeb").addEventListener("click", async () => {
  const result = await api.resetSettings();
  if (result.snapshot) {
    snapshot = result.snapshot;
    renderForm(result.snapshot);
    renderProviders(result.snapshot);
    renderLan(result.snapshot);
  }
  setStatus(statusEl, result.ok ? "已恢复默认设置，重启后生效" : result.message, result.ok ? "ok" : "err");
});

// 两个开关都立即保存，避免用户忘记点保存。
for (const [element, message] of [
  [fields.traySwitch, () => (fields.traySwitch.checked ? "已开启：关闭窗口后留在托盘" : "已关闭：关闭窗口将退出应用")],
  [fields.trayIconSwitch, () => (fields.trayIconSwitch.checked ? "已开启：显示托盘图标" : "已关闭：隐藏托盘图标")],
]) {
  element.addEventListener("change", async () => {
    const result = await api.saveSettings(collectForm());
    if (!result.ok) {
      setStatus(statusEl, result.message, "err");
      element.checked = !element.checked;
      return;
    }
    // 用返回值回填表单，确保界面显示的就是真正保存下来的状态。
    if (result.snapshot) {
      snapshot = result.snapshot;
      renderForm(result.snapshot);
    }
    setStatus(statusEl, message(), "ok");
  });
}

// ── 局域网地址（仅在监听非回环地址时显示）──
let currentLanAddress = "";
function renderLan(data) {
  currentLanAddress = data.lanAddress || "";
  if (currentLanAddress) {
    lanRow.hidden = false;
    lanAddress.textContent = currentLanAddress;
  } else {
    lanRow.hidden = true;
  }
}

document.getElementById("openLan").addEventListener("click", () => {
  if (currentLanAddress) void api.openExternal(currentLanAddress);
});

// ── 用量记录插件 ──
function renderExtension(info) {
  if (!info) return;
  if (info.installed && info.upToDate) {
    extHint.innerHTML = `已安装且为当前版本：<code>${info.installPath}</code>`;
    installExt.textContent = "已安装";
    installExt.disabled = true;
  } else if (info.installed) {
    extHint.innerHTML = `已安装，但版本与内置版本不同，可点「安装」更新：<code>${info.installPath}</code>`;
    installExt.textContent = "更新";
    installExt.disabled = false;
  } else if (!info.sourceAvailable) {
    extHint.textContent = "安装包内未找到内置插件，无法自动安装。";
    installExt.disabled = true;
  } else {
    extHint.innerHTML = `尚未安装。安装位置：<code>${info.installPath}</code>`;
    installExt.textContent = "安装";
    installExt.disabled = false;
  }
}

document.getElementById("recheckExt").addEventListener("click", async () => {
  extHint.textContent = "正在检测…";
  renderExtension(await api.checkUsageExtension());
});

installExt.addEventListener("click", async () => {
  installExt.disabled = true;
  extHint.textContent = "正在安装…";
  const result = await api.installUsageExtension();
  extHint.textContent = result.message;
  renderExtension(await api.checkUsageExtension());
});

document.getElementById("openUsage").addEventListener("click", () => void api.openUsage());

// ── 关于 ──
function renderAbout(about) {
  if (!about) return;
  aboutVersion.textContent = about.version;
  aboutQq.textContent = about.qq;
  aboutRuntime.textContent = `Electron ${about.electron} · Node ${about.node} · Chromium ${about.chrome}`;
}

document.getElementById("openGithub").addEventListener("click", () => {
  if (snapshot?.about?.github) void api.openExternal(snapshot.about.github);
});
document.getElementById("openLog").addEventListener("click", () => void api.openLog());
document.getElementById("showDataFile").addEventListener("click", () => {
  setStatus(aboutStatus, snapshot?.settingsFilePath || "", "ok");
});

// ── 其它按钮 ──
document.getElementById("refreshTitleBar").addEventListener("click", async () => {
  await api.refreshTitleBar();
  setStatus(statusEl, "已重新同步标题栏外观", "ok");
});

document.getElementById("restart").addEventListener("click", () => {
  if (!window.confirm("确定要重启 Pi Web Box 吗？\n\n当前的 Pi Web 服务会重新启动，正在进行的操作可能中断。")) return;
  setStatus(statusEl, "正在重启…");
  void api.restartApp();
});

// ── 导航切换 ──
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

// ── 主题跟随 ──
function applyPalette(palette, isDark) {
  const root = document.documentElement;
  root.style.setProperty("--bg", palette.background);
  root.style.setProperty("--bg-panel", palette.panel);
  root.style.setProperty("--border", palette.border);
  root.style.setProperty("--text", palette.text);
  root.style.setProperty("--text-muted", palette.textMuted);
  root.style.setProperty("--accent", palette.accent);
  // 标题栏底色用面板色（对应 pi-web 顶部工具栏区域），
  // 与主窗口标题栏取的是同一处颜色。
  root.style.setProperty("--titlebar-bg", palette.panel);
  root.dataset.theme = palette.id;
  // 品牌图标按主题深浅切换，深色主题用白色 logo。
  const brand = document.getElementById("brandIcon");
  if (brand && window.__PI_WEB_BOX_ICONS__) {
    brand.src = isDark ? window.__PI_WEB_BOX_ICONS__.dark : window.__PI_WEB_BOX_ICONS__.light;
  }
  // 自绘标题栏的图标也要跟着切。
  window.__piWebBoxSetTitleBarIcon?.(isDark);
}

// 主题名文案是可选展示项，用可选链兜底：
// 之前这里的元素缺失会让整个脚本抛错，导致后面的表单填充、供应商下拉、
// 关于信息与插件检测全部不执行。
function setThemeName(text) {
  if (themeName) themeName.textContent = text;
}

api.onSettingsTheme(({ palette }) => {
  applyPalette(palette, palette.id === "dark" || palette.id === "pine");
  setThemeName(palette.label);
});

// 首次渲染：主题色板已由主进程写入页面，这里只补充数据与图标。
const boot = window.__PI_WEB_BOX_BOOT__ || {};
if (boot.palette) {
  applyPalette({ id: boot.theme, ...boot.palette }, !!boot.isDark);
  setThemeName(boot.label || "—");
}

// 初始化流程整体包一层：任何单点异常都不应阻断其余模块的渲染。
api.getSettings().then((data) => {
  snapshot = data;
  const steps = [
    ["表单", () => renderForm(data)],
    ["供应商", () => renderProviders(data)],
    ["局域网地址", () => renderLan(data)],
    ["关于", () => renderAbout(data.about)],
    ["用量插件", () => renderExtension(data.usageExtension)],
  ];
  for (const [label, run] of steps) {
    try {
      run();
    } catch (error) {
      console.error(`[Pi Web Box] 渲染${label}失败：`, error);
    }
  }
  if (!boot.label) setThemeName(data.themeLabel || "—");
});
