/**
 * Box 设置窗口真实渲染回归：新面板内容、侧栏顺序、主题实时跟随。
 * 独立数据目录与桩 IPC，不启动 Pi、不读写用户的设置文件。
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "box-settings-"));
app.setPath("userData", userData);

const { buildSettingsHtml } = require("../build/settings-view.js");
const { THEME_PALETTES } = require("../build/themes.js");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const icon = (name) => `data:image/png;base64,${fs.readFileSync(path.join(root, "assets", name)).toString("base64")}`;

const extension = (name, displayName, installed, upToDate) => ({
  name, displayName, description: "", installed, installPath: `C:\\demo\\.pi\\agent\\extensions\\${name}`,
  sourceAvailable: true, upToDate,
});
const snapshot = {
  settings: {
    minimizeToTrayOnClose: true, showTrayIcon: true, notifyOnPrompt: true,
    piWeb: { port: "30141", hostname: "127.0.0.1", allowedHosts: "", password: "", commandPath: "", nodePath: "" },
    enhance: { provider: "", model: "" },
  },
  settingsFilePath: path.join(userData, "settings.json"),
  commandLine: "pi-web --no-open",
  versions: { pi: "0.85.0", piWeb: "0.12.2", piWebBox: "0.7.4" },
  theme: "sand",
  themeLabel: "暖沙",
  providers: [{ id: "magpie", name: "Magpie", hasApiKey: true, models: [{ id: "cn:glm-5.3", name: "GLM 5.3" }] }],
  usageExtension: extension("pi-usage-log", "Token 用量记录", true, true),
  pi: {
    directory: "C:\\demo\\.pi\\agent",
    directoryExists: true,
    agentsFile: "C:\\demo\\.pi\\agent\\AGENTS.md",
    agentsExists: true,
  },
  sessionName: {
    config: { enabled: true, provider: "magpie", model: "cn:glm-5.3" },
    configPath: "C:\\demo\\.pi\\agent\\pi-session-name.json",
    extension: extension("pi-session-name", "会话自动命名", false, false),
  },
  lanAddress: "",
  about: { version: "0.7.4", github: "https://github.com/passheep/pi-web-box", qq: "1", electron: "1", node: "1", chrome: "1" },
};

ipcMain.handle("pi-web-box:get-settings", () => snapshot);
ipcMain.handle("pi-web-box:save-settings", () => ({ ok: true, message: "已保存", snapshot }));
ipcMain.handle("pi-web-box:reset-settings", () => ({ ok: true, message: "已恢复默认设置", snapshot }));
ipcMain.handle("pi-web-box:check-extension", () => snapshot.sessionName.extension);
ipcMain.handle("pi-web-box:install-extension", () => ({ ok: true, message: "已安装", snapshot }));
ipcMain.handle("pi-web-box:open-pi-path", () => ({ ok: true, message: "" }));
ipcMain.handle("pi-web-box:create-agents-file", () => ({ ok: true, message: "已创建 AGENTS.md", snapshot }));
ipcMain.handle("pi-web-box:save-session-name", () => ({ ok: true, message: "已保存，即刻生效", snapshot }));

const watchdog = setTimeout(() => { console.error("FAIL timeout"); app.exit(1); }, 30000);

(async () => {
  await app.whenReady();
  const win = new BrowserWindow({
    width: 780, height: 620, show: false, frame: false,
    webPreferences: { preload: path.join(root, "build/preload.js"), sandbox: true, contextIsolation: true },
  });
  const errors = [];
  win.webContents.on("console-message", (_event, details) => {
    if (details?.level === "error") errors.push(String(details.message).slice(0, 200));
  });

  const html = buildSettingsHtml({
    theme: "sand",
    systemDark: false,
    palette: THEME_PALETTES.sand,
    rendererScript: fs.readFileSync(path.join(root, "build/settings-renderer.js"), "utf8"),
    darkIconDataUrl: icon("pi-logo-on-dark.png"),
    lightIconDataUrl: icon("pi-logo-on-light.png"),
  });
  const htmlPath = path.join(userData, "settings.html");
  fs.writeFileSync(htmlPath, html, "utf8");
  await win.loadFile(htmlPath);
  await wait(800);

  // 1) 侧栏顺序符合约定，手动刷新标题栏的旧入口已移除。
  const nav = await win.webContents.executeJavaScript("[...document.querySelectorAll('#nav button')].map((b) => b.dataset.pane)");
  assert.deepEqual(nav, ["appearance", "usage", "pi", "piweb", "enhance", "sessionname", "about"]);
  assert.equal(await win.webContents.executeJavaScript("!!document.getElementById('refreshTitleBar')"), false);
  console.log("PASS 侧栏顺序：外观与行为/Token 统计/Pi 配置/Pi Web 配置/提示词增强/会话命名/关于，无手动刷新入口");

  // 2) Pi 配置面板：路径与按钮状态来自快照，已存在时不显示「新建」。
  await win.webContents.executeJavaScript("document.querySelector('[data-pane=\"pi\"]')?.click(); void 0");
  await wait(150);
  assert.deepEqual(
    await win.webContents.executeJavaScript(`({
      hidden: document.getElementById("pane-pi").hidden,
      directory: document.getElementById("piDirectory").textContent,
      hint: document.getElementById("agentsHint").textContent,
      createHidden: document.getElementById("createAgents").hidden,
      openDisabled: document.getElementById("openAgents").disabled,
    })`),
    {
      hidden: false,
      directory: "C:\\demo\\.pi\\agent",
      hint: "对所有项目生效的规则文件：C:\\demo\\.pi\\agent\\AGENTS.md",
      createHidden: true,
      openDisabled: false,
    },
  );
  console.log("PASS Pi 配置面板：目录、AGENTS.md 路径与按钮状态正确");

  // 3) 会话命名面板：开关、模型下拉、插件状态与配置文件路径。
  await win.webContents.executeJavaScript("document.querySelector('[data-pane=\"sessionname\"]')?.click(); void 0");
  await wait(150);
  assert.deepEqual(
    await win.webContents.executeJavaScript(`({
      hidden: document.getElementById("pane-sessionname").hidden,
      enabled: document.getElementById("sessionNameEnabled").checked,
      provider: document.getElementById("sessionNameProvider").value,
      model: document.getElementById("sessionNameModel").value,
      configPath: document.getElementById("sessionNameConfigPath").textContent,
      extButton: document.getElementById("installSessionNameExt").textContent,
    })`),
    {
      hidden: false,
      enabled: true,
      provider: "magpie",
      model: "cn:glm-5.3",
      configPath: "C:\\demo\\.pi\\agent\\pi-session-name.json",
      extButton: "安装",
    },
  );
  console.log("PASS 会话命名面板：开关、命名模型与插件安装状态渲染正确");

  // 3b) 面板内容超过窗口高度时必须能滚动，且保存按钮固定在底部不随内容滚走。
  win.setContentSize(780, 520);
  await wait(200);
  const scroll = await win.webContents.executeJavaScript(`(() => {
    const pane = document.getElementById("pane-sessionname");
    const body = pane.querySelector(".pane-body");
    const foot = pane.querySelector(".pane-foot");
    const footRect = foot.getBoundingClientRect();
    return {
      scrollable: getComputedStyle(body).overflowY === "auto",
      overflows: body.scrollHeight > body.clientHeight,
      footInsideWindow: footRect.bottom <= window.innerHeight + 1 && footRect.top >= 0,
      bodyBottomAboveFoot: body.getBoundingClientRect().bottom <= footRect.top + 1,
      // 最后一行提示需要在滚动到底之后才能看到
      lastRowVisibleBefore: (() => {
        const rows = pane.querySelectorAll(".pane-body .row");
        const last = rows[rows.length - 1].getBoundingClientRect();
        return last.bottom <= window.innerHeight + 1;
      })(),
    };
  })()`);
  assert.equal(scroll.scrollable, true);
  assert.equal(scroll.overflows, true, "会话命名面板内容应超过窗口高度（否则用例不具备回归意义）");
  assert.equal(scroll.footInsideWindow, true, "保存按钮必须固定在可视区域内");
  assert.equal(scroll.bodyBottomAboveFoot, true, "滚动区不能盖住底部操作条");
  assert.equal(scroll.lastRowVisibleBefore, false, "最后一行提示默认被截断，需要滚动查看");
  assert.equal(
    await win.webContents.executeJavaScript(`(() => {
      const body = document.getElementById("pane-sessionname").querySelector(".pane-body");
      body.scrollTop = body.scrollHeight;
      const rows = document.querySelectorAll("#pane-sessionname .pane-body .row");
      const last = rows[rows.length - 1].getBoundingClientRect();
      return last.bottom <= window.innerHeight + 1;
    })()`),
    true,
    "滚动到底后应能看到最后一行",
  );
  console.log("PASS 会话命名面板可滚动，底部保存条固定，滚到底能看到全部内容");
  win.setContentSize(780, 620);
  await wait(200);

  // 4) 主题实时跟随：主进程推送新色板后，变量、data-theme 与图标同步更新。
  win.webContents.send("pi-web-box:settings-theme", { palette: THEME_PALETTES.dusk, theme: "dusk", isDark: true });
  await wait(200);
  assert.deepEqual(
    await win.webContents.executeJavaScript(`(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        bg: style.getPropertyValue("--bg").trim(),
        panel: style.getPropertyValue("--bg-panel").trim(),
        accent: style.getPropertyValue("--accent").trim(),
        theme: document.documentElement.dataset.theme,
        brandDark: document.getElementById("brandIcon").src === window.__PI_WEB_BOX_ICONS__.dark,
      };
    })()`),
    {
      bg: THEME_PALETTES.dusk.background,
      panel: THEME_PALETTES.dusk.panel,
      accent: THEME_PALETTES.dusk.accent,
      theme: "dusk",
      brandDark: true,
    },
  );
  console.log("PASS 设置窗口跟随实时色板（含 data-theme 与深色 logo 切换）");

  assert.equal(errors.length, 0, errors.join("\n"));
})().then(
  () => finish(0),
  (error) => { console.error(error); finish(1); },
);

function finish(code) {
  clearTimeout(watchdog);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.destroy();
  }
  app.exit(code);
}
