import { isDarkTheme, THEME_PALETTES, type ThemePalette } from "./themes.js";

export type SettingsViewData = {
  // 当前 Pi Web 主题，用于让设置窗口跟随 Pi Web 的外观。
  theme: string;
  systemDark: boolean;
  // 品牌图标（深/浅两版），按主题切换，避免深色主题里黑 logo 看不清。
  iconDataUrl: string;
  darkIconDataUrl: string;
  lightIconDataUrl: string;
  // 交互脚本内容。设置页写在 userData 目录下，无法直接引用 build 里的脚本文件，
  // 所以由主进程读入后内联到页面中，配合 CSP 的 script-src 'unsafe-inline' 使用。
  rendererScript: string;
};

// 基础样式。颜色全部走前面注入的主题变量，这里不重复声明颜色，
// 否则会覆盖掉 Pi Web 当前主题的配色。
const BASE_CSS = `
  :root {
    color-scheme: light dark;
    font-family: "Segoe UI", system-ui, -apple-system, "Microsoft YaHei", sans-serif;
    font-size: 14px;
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; color: var(--text); background: var(--bg); }
  .layout { display: grid; grid-template-columns: 178px 1fr; min-height: 100vh; }
  .side { border-right: 1px solid var(--border); background: var(--bg-panel); padding: 16px 10px; }
  .side .brand { display: flex; align-items: center; gap: 9px; padding: 0 8px 14px; }
  .side .brand img { width: 22px; height: 22px; }
  .side .brand b { font-size: 13.5px; font-weight: 650; }
  .side .brand span { display: block; font-size: 11px; color: var(--text-muted); font-weight: 400; }
  .nav { display: flex; flex-direction: column; gap: 2px; }
  .nav button { display: flex; align-items: center; gap: 9px; width: 100%; padding: 8px 9px; border: 0; border-radius: 7px; background: transparent; color: var(--text); font: inherit; font-size: 13.5px; text-align: left; cursor: pointer; }
  .nav button:hover { background: var(--bg-hover); }
  .nav button[aria-current="true"] { background: var(--bg-hover); font-weight: 600; }
  .nav button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .nav svg { width: 15px; height: 15px; flex: none; color: var(--text-muted); }
  .main { padding: 22px 26px 26px; overflow: auto; }
  .pane[hidden] { display: none; }
  h1 { font-size: 16.5px; font-weight: 650; margin: 0 0 3px; }
  .desc { margin: 0 0 18px; font-size: 12.5px; color: var(--text-muted); }
  .group { border: 1px solid var(--border); border-radius: 10px; background: var(--bg); overflow: hidden; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 13px 15px; border-bottom: 1px solid var(--border); }
  .row:last-child { border-bottom: 0; }
  .row.stack { display: block; }
  .row .label { font-size: 13.5px; font-weight: 600; }
  .row .hint { margin-top: 3px; font-size: 12px; color: var(--text-muted); line-height: 1.55; }
  .row .control { flex: none; }
  .row.stack .control { margin-top: 9px; }
  /* 开关：与 pi-web 的控件圆角保持一致 */
  .switch { position: relative; display: inline-block; width: 40px; height: 22px; flex: none; }
  .switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
  .switch .track { position: absolute; inset: 0; border-radius: 11px; background: var(--border); transition: background 160ms ease; pointer-events: none; }
  .switch .thumb { position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.28); transition: transform 160ms ease; pointer-events: none; }
  .switch input:checked ~ .track { background: var(--accent); }
  .switch input:checked ~ .thumb { transform: translateX(18px); }
  .switch input:focus-visible ~ .track { outline: 2px solid var(--accent); outline-offset: 2px; }
  .switch input:disabled { cursor: not-allowed; }
  .switch input:disabled ~ .track { opacity: .55; }
  input[type="text"], input[type="password"] { width: 100%; padding: 7px 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg); color: var(--text); font: inherit; font-size: 13px; }
  input[type="text"]:focus, input[type="password"]:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
  input[type="text"]::placeholder, input[type="password"]::placeholder { color: var(--text-muted); opacity: .75; }
  input.mono { font-family: Consolas, ui-monospace, monospace; font-size: 12.5px; }
  button.btn { padding: 7px 13px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg-panel); color: var(--text); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; white-space: nowrap; }
  button.btn:hover { background: var(--bg-hover); }
  button.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-contrast); }
  button.btn.primary:hover { filter: brightness(1.08); }
  button.btn:disabled { opacity: .6; cursor: not-allowed; }
  .actions { display: flex; align-items: center; gap: 10px; margin-top: 16px; }
  .actions .status { font-size: 12.5px; color: var(--text-muted); }
  .actions .status.ok { color: var(--accent); }
  .actions .status.err { color: #c0392b; }
  .spacer { flex: 1; }
  code { padding: 2px 5px; border-radius: 4px; background: var(--bg-panel); font-family: Consolas, ui-monospace, monospace; font-size: 12px; }
  .preview { display: flex; align-items: center; gap: 10px; padding: 10px 15px; border-bottom: 1px solid var(--border); background: var(--bg-panel); font-size: 12px; color: var(--text-muted); }
  .preview b { color: var(--text); font-weight: 600; }
  .swatches { display: flex; gap: 7px; }
  .swatch { width: 20px; height: 20px; border: 1px solid var(--border); border-radius: 6px; }
  /* 说明框：用于解释场景差异等只需阅读的内容 */
  .warnbox { margin-top: 14px; padding: 11px 13px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-panel); font-size: 12.5px; line-height: 1.7; color: var(--text-muted); }
  .warnbox b { color: var(--text); font-weight: 650; }
  /* 下拉框：与输入框保持同一套观感 */
  select { width: 100%; padding: 7px 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg); color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
  select:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
  select:disabled { opacity: .6; cursor: not-allowed; }
  /* 自定义滚动条：跟随当前主题的边框与面板色 */
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 5px; border: 2px solid var(--bg); }
  ::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }
  @media (prefers-reduced-motion: reduce) { .switch .track, .switch .thumb { transition: none; } }
`;

/** 生成设置窗口的完整 HTML，外观直接使用当前 Pi Web 主题的色板。 */
export function buildSettingsHtml(data: SettingsViewData): string {
  const palette: ThemePalette = THEME_PALETTES[data.theme] ??
    (data.systemDark ? THEME_PALETTES.dark : THEME_PALETTES.light);

  const themeVars = `
    --bg: ${palette.background};
    --bg-panel: ${palette.panel};
    --bg-hover: ${mix(palette.panel, palette.text, 0.06)};
    --border: ${palette.border};
    --text: ${palette.text};
    --text-muted: ${palette.textMuted};
    --accent: ${palette.accent};
    --accent-contrast: ${isLight(palette.background) ? "#ffffff" : "#182e22"};
  `;

  return `<!doctype html>
<html lang="zh-CN" data-theme="${escapeAttr(palette.id)}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline';" />
  <title>Pi Web Box 设置</title>
  <style>:root {${themeVars}}${BASE_CSS}</style>
</head>
<body>
  <div class="layout">
    <aside class="side">
      <div class="brand">
        <img id="brandIcon" src="${isDarkTheme(palette.id) ? data.darkIconDataUrl : data.lightIconDataUrl}" alt="" />
        <div><b>Pi Web Box</b><span>设置</span></div>
      </div>
      <nav class="nav" id="nav">
        <button type="button" data-pane="appearance" aria-current="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"></rect><path d="M3 9h18M9 21V9"></path></svg>
          外观与行为
        </button>
        <button type="button" data-pane="usage">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"></path><rect x="7" y="12" width="3" height="6" rx="1"></rect><rect x="12" y="8" width="3" height="10" rx="1"></rect><rect x="17" y="5" width="3" height="13" rx="1"></rect></svg>
          Token 统计
        </button>
        <button type="button" data-pane="piweb">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"></path></svg>
          Pi Web 配置
        </button>
        <button type="button" data-pane="enhance">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"></path></svg>
          提示词增强
        </button>
        <button type="button" data-pane="about">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 16v-4M12 8h.01"></path></svg>
          关于
        </button>
      </nav>
    </aside>

    <main class="main">
      <section class="pane" id="pane-appearance">
        <h1>外观与行为</h1>
        <p class="desc">窗口外观与标题栏颜色都会自动跟随 Pi Web 主题，无需手动干预。</p>
        <div class="group">
          <div class="row">
            <div>
              <div class="label">关闭后最小化至托盘</div>
              <div class="hint">开启后，点击窗口关闭按钮会隐藏到托盘并保持 Pi Web 服务运行；关闭此项则直接退出应用。</div>
            </div>
            <div class="control">
              <label class="switch" title="关闭后最小化至托盘">
                <input type="checkbox" id="traySwitch" />
                <span class="track"></span><span class="thumb"></span>
              </label>
            </div>
          </div>
          <div class="row">
            <div>
              <div class="label">显示托盘图标</div>
              <div class="hint">关闭后不在通知区域显示图标，也不会发送任务完成通知；此时建议同时关闭「关闭后最小化至托盘」，否则窗口关闭后将无法重新打开。</div>
            </div>
            <div class="control">
              <label class="switch" title="显示托盘图标">
                <input type="checkbox" id="trayIconSwitch" />
                <span class="track"></span><span class="thumb"></span>
              </label>
            </div>
          </div>
          <div class="row">
            <div>
              <div class="label">刷新标题栏外观</div>
              <div class="hint">标题栏一般会自动跟随 Pi Web 主题。若切换主题后标题栏颜色没有更新，可点此手动同步一次。</div>
            </div>
            <div class="control"><button class="btn" type="button" id="refreshTitleBar">刷新</button></div>
          </div>
          <div class="row">
            <div>
              <div class="label">重启 Pi Web Box</div>
              <div class="hint">重启会关闭并重新启动应用，同时用新配置重新拉起 Pi Web 服务。</div>
            </div>
            <div class="control"><button class="btn" type="button" id="restart">重启</button></div>
          </div>
        </div>
      </section>

      <section class="pane" id="pane-usage" hidden>
        <h1>Token 统计</h1>
        <p class="desc">用量数据来自 pi 的扩展插件，安装后每次助手回复都会记录 token 用量。</p>
        <div class="group">
          <div class="row">
            <div>
              <div class="label">用量记录插件</div>
              <div class="hint" id="extHint">正在检测…</div>
            </div>
            <div class="control" style="display:flex;gap:8px">
              <button class="btn" type="button" id="recheckExt">重新检测</button>
              <button class="btn primary" type="button" id="installExt">安装</button>
            </div>
          </div>
          <div class="row">
            <div>
              <div class="label">查看用量统计</div>
              <div class="hint">打开独立的统计窗口，查看今日用量、最近一年热力图与各模型占比，支持自定义起止日期与模型筛选。</div>
            </div>
            <div class="control"><button class="btn" type="button" id="openUsage">打开统计</button></div>
          </div>
        </div>
      </section>

      <section class="pane" id="pane-piweb" hidden>
        <h1>Pi Web 配置</h1>
        <p class="desc">对应 pi-web 的启动参数，保存后需要重启 Pi Web Box 生效。</p>
        <div class="group">
          <div class="row stack">
            <div>
              <div class="label">服务端口</div>
              <div class="hint">Pi Web 监听的端口，对应 <code>--port</code>。默认 30141；端口被占用时应用会自动改用其它可用端口。</div>
            </div>
            <div class="control"><input type="text" id="port" class="mono" placeholder="30141" inputmode="numeric" /></div>
          </div>
          <div class="row stack">
            <div>
              <div class="label">监听主机名</div>
              <div class="hint">对应 <code>--hostname</code>。默认 <code>127.0.0.1</code> 仅本机可访问；改为 <code>0.0.0.0</code> 会开放局域网访问，请同时设置密码。</div>
            </div>
            <div class="control"><input type="text" id="hostname" class="mono" placeholder="127.0.0.1" /></div>
          </div>
          <div class="row stack">
            <div>
              <div class="label">允许的主机名</div>
              <div class="hint">对应 <code>PI_WEB_ALLOWED_HOSTS</code>。反向代理或自定义域名需在此精确填写，多个值用逗号分隔。</div>
            </div>
            <div class="control"><input type="text" id="allowedHosts" class="mono" placeholder="例如：pi.example.com, pi.local" /></div>
          </div>
          <div class="row stack">
            <div>
              <div class="label">访问密码</div>
              <div class="hint">对应 <code>PI_WEB_PASSWORD</code>。留空表示不启用认证；启用后浏览器需要密码，API 客户端使用用户名 <code>pi</code> 的 Basic Auth。</div>
            </div>
            <div class="control"><input type="password" id="password" class="mono" placeholder="留空表示不启用认证" autocomplete="new-password" /></div>
          </div>
        </div>

        <div class="group" style="margin-top:14px">
          <div class="row stack">
            <div>
              <div class="label">pi-web 命令路径</div>
              <div class="hint">留空时从 <code>PATH</code> 自动探测，一般无需填写。找不到命令时可在此指定 <code>pi-web.cmd</code> 的完整路径。</div>
            </div>
            <div class="control"><input type="text" id="commandPath" class="mono" placeholder="自动探测" /></div>
          </div>
          <div class="row stack">
            <div>
              <div class="label">Node.js 路径</div>
              <div class="hint">留空时从 <code>PATH</code> 自动探测 <code>node.exe</code>。仅在多版本 Node 环境下需要指定。</div>
            </div>
            <div class="control"><input type="text" id="nodePath" class="mono" placeholder="自动探测" /></div>
          </div>
        </div>

        <div class="actions">
          <button class="btn primary" type="button" id="save">保存</button>
          <button class="btn" type="button" id="resetPiWeb">恢复默认</button>
          <span class="spacer"></span>
          <span class="status" id="status"></span>
        </div>
        <p class="desc" style="margin-top:12px">当前启动命令：<code id="commandLine">—</code></p>
        <p class="desc" id="lanRow" hidden>局域网访问地址：<code id="lanAddress">—</code>
          <button class="btn" type="button" id="openLan" style="margin-left:6px;padding:3px 9px;font-size:12px">打开</button>
        </p>
      </section>

      <section class="pane" id="pane-enhance" hidden>
        <h1>提示词增强</h1>
        <p class="desc">在 Pi Web 输入框旁提供「增强」按钮，用 AI 优化草稿后再发送。模型列表来自 pi 已配置的供应商。</p>
        <div class="group">
          <div class="row stack">
            <div>
              <div class="label">供应商</div>
              <div class="hint">从 pi 的 <code>models.json</code> 读取，只列出已配置 API Key 的供应商。</div>
            </div>
            <div class="control"><select id="enhanceProvider" style="width:100%"><option value="">未选择</option></select></div>
          </div>
          <div class="row stack">
            <div>
              <div class="label">模型</div>
              <div class="hint">建议选择响应快、成本低的模型，增强属于改写任务，不需要强推理能力。</div>
            </div>
            <div class="control"><select id="enhanceModel" style="width:100%"><option value="">请先选择供应商</option></select></div>
          </div>
        </div>
        <div class="actions">
          <button class="btn primary" type="button" id="saveEnhance">保存</button>
          <span class="spacer"></span>
          <span class="status" id="enhanceStatus"></span>
        </div>
        <div class="warnbox">
          <b>关于场景</b><br>
          增强按钮左侧可选择场景：<b>通用</b>按草稿本身的性质改写，<b>编程</b>补齐技术上下文与验证方式，<b>生图</b>整理主体、风格、构图、光线等画面要素。
          三种场景都不会改变你的原始目标，代码块、路径与命令会原样保留。
        </div>
      </section>

      <section class="pane" id="pane-about" hidden>
        <h1>关于</h1>
        <p class="desc">Pi Web Box 是 Pi Web 的 Windows 桌面外壳。</p>
        <div class="group">
          <div class="row"><div><div class="label">版本</div></div><div class="control"><code id="aboutVersion">—</code></div></div>
          <div class="row">
            <div><div class="label">项目仓库</div><div class="hint">查看源码、提交问题与下载新版本。</div></div>
            <div class="control"><button class="btn" type="button" id="openGithub">打开 GitHub</button></div>
          </div>
          <div class="row"><div><div class="label">联系 QQ</div></div><div class="control"><code id="aboutQq">—</code></div></div>
          <div class="row">
            <div><div class="label">运行环境</div><div class="hint" id="aboutRuntime">—</div></div>
            <div class="control"><button class="btn" type="button" id="openLog">打开日志</button></div>
          </div>
        </div>
        <div class="actions">
          <button class="btn" type="button" id="showDataFile">设置文件位置</button>
          <span class="spacer"></span>
          <span class="status" id="aboutStatus"></span>
        </div>
      </section>
    </main>
  </div>
  <script>window.__PI_WEB_BOX_ICONS__ = ${JSON.stringify({
    dark: data.darkIconDataUrl,
    light: data.lightIconDataUrl,
  }).replaceAll("<", "\\u003c")};
  window.__PI_WEB_BOX_BOOT__ = ${JSON.stringify({
    theme: palette.id,
    label: palette.label,
    isDark: isDarkTheme(palette.id),
    palette: {
      background: palette.background,
      panel: palette.panel,
      border: palette.border,
      text: palette.text,
      textMuted: palette.textMuted,
      accent: palette.accent,
    },
  }).replaceAll("<", "\\u003c")};</script>
  <script>${data.rendererScript}</script>
</body>
</html>`;
}

// 把两个颜色按比例混合，用于派生 hover 底色，公式与常规 alpha 混合一致。
function mix(base: string, overlay: string, ratio: number): string {
  const parse = (hex: string) => {
    const value = hex.replace("#", "");
    return [
      Number.parseInt(value.slice(0, 2), 16),
      Number.parseInt(value.slice(2, 4), 16),
      Number.parseInt(value.slice(4, 6), 16),
    ];
  };
  const [br, bg, bb] = parse(base);
  const [or, og, ob] = parse(overlay);
  const blend = (a: number, b: number) => Math.round(a * (1 - ratio) + b * ratio);
  return `#${[blend(br, or), blend(bg, og), blend(bb, ob)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function isLight(hex: string): boolean {
  const value = hex.replace("#", "");
  const [r, g, b] = [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}

function escapeAttr(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "");
}
