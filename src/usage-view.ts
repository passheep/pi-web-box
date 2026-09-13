import { THEME_PALETTES, type ThemePalette } from "./themes.js";
import type { UsageOverview, UsageSummary } from "./usage.js";
import { buildTitleBarHtml, TITLE_BAR_CSS, TITLE_BAR_SCRIPT } from "./titlebar-view.js";

export type UsageViewData = {
  theme: string;
  systemDark: boolean;
  rendererScript: string;
  // 品牌图标（深浅两版），用于自绘标题栏。
  darkIconDataUrl: string;
  lightIconDataUrl: string;
  // 首次打开的默认查询区间。
  defaultFrom: string;
  defaultTo: string;
};

// 热力图用带透明度的绿色叠加在页面背景上，深浅两种主题下都能自然融合，
// 不需要为主题各写一套配色。
const HEAT_COLORS = [
  "transparent",
  "rgba(34, 153, 84, .28)",
  "rgba(34, 153, 84, .48)",
  "rgba(34, 153, 84, .70)",
  "rgba(34, 153, 84, .92)",
];

const BASE_CSS = `
  :root {
    color-scheme: light dark;
    font-family: "Segoe UI", system-ui, -apple-system, "Microsoft YaHei", sans-serif;
    font-size: 14px;
  }
  * { box-sizing: border-box; }
  /* 自绘标题栏 + 可滚动内容区，整体高度锁定在窗口内。 */
  body { margin: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; color: var(--text); background: var(--bg); }
  /* 隐藏滚动条但保留滚动能力：内容超长时仍可用滚轮/触控板滚动。 */
  body::-webkit-scrollbar, .page::-webkit-scrollbar, .heat-scroll::-webkit-scrollbar { width: 0; height: 0; }
  body, .page, .heat-scroll { scrollbar-width: none; -ms-overflow-style: none; }
  .page { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 20px 22px; }
  h1 { font-size: 16px; font-weight: 650; margin: 0 0 3px; }
  .desc { margin: 0 0 14px; font-size: 12.5px; color: var(--text-muted); }

  /* 概览卡片：数值全部跟随筛选区间，不再区分今日/区间。 */
  .cards { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 16px; }
  .card { border: 1px solid var(--border); border-radius: 10px; padding: 11px 13px; background: var(--bg-panel); }
  .card .k { font-size: 11.5px; color: var(--text-muted); }
  .card .v { margin-top: 4px; font-size: 19px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .card .u { margin-left: 3px; font-size: 11.5px; font-weight: 400; color: var(--text-muted); }

  /* 筛选栏：不换行，窗口宽度按这一行的实际需求确定。 */
  .filters { display: flex; flex-wrap: nowrap; align-items: center; gap: 8px; margin-bottom: 14px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-panel); white-space: nowrap; }
  .filters label { font-size: 12.5px; color: var(--text-muted); flex: none; }
  input[type="date"], select { padding: 6px 9px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg); color: var(--text); font: inherit; font-size: 12.5px; }
  input[type="date"] { flex: none; }
  #model { flex: 1; min-width: 120px; }
  input[type="date"]:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
  button.btn { padding: 6px 13px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg); color: var(--text); font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer; }
  button.btn:hover { background: var(--bg-hover); }
  button.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-contrast); }
  button.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .quick { display: flex; gap: 6px; }
  .quick button { padding: 4px 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text-muted); font: inherit; font-size: 11.5px; cursor: pointer; }
  .quick button:hover { background: var(--bg-hover); color: var(--text); }
  .quick button.active { background: var(--accent); border-color: var(--accent); color: var(--accent-contrast); }

  /* 热力图 */
  .section { margin-bottom: 16px; }
  .section > h2 { font-size: 13px; font-weight: 650; margin: 0 0 8px; }
  /* 灰框不裁剪内容，否则最右侧的月份标签会被切掉。 */
  .heat-wrap { border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: var(--bg-panel); overflow: visible; }
  /* 格子区宽度由周数决定，容器只负责裁剪，避免超出灰边框。 */
  .heat { display: flex; gap: 3px; width: max-content; }
  /* 格子区与月份标签共用同一容器宽度，最后一列标签才不会被裁。 */
  .heat-scroll { overflow: visible; }
  .heat .week { display: flex; flex-direction: column; gap: 3px; }
  .heat .cell { width: 11px; height: 11px; border-radius: 2.5px; background: var(--heat-0); outline: 1px solid var(--heat-outline); outline-offset: -1px; }
  .heat .cell[data-level="1"] { background: ${HEAT_COLORS[1]}; }
  .heat .cell[data-level="2"] { background: ${HEAT_COLORS[2]}; }
  .heat .cell[data-level="3"] { background: ${HEAT_COLORS[3]}; }
  .heat .cell[data-level="4"] { background: ${HEAT_COLORS[4]}; }
  .heat .cell:hover { outline: 1.5px solid var(--accent); outline-offset: 0; }
  .heat .cell.future { visibility: hidden; }
  .heat-legend { display: flex; align-items: center; justify-content: space-between; margin-top: 9px; font-size: 11.5px; color: var(--text-muted); }
  .heat-legend .scale { display: flex; align-items: center; gap: 4px; }
  .heat-legend .scale i { width: 11px; height: 11px; border-radius: 2.5px; display: block; }
  /* 月份标签与星期标签各占一行，两者高度一致才能让下面的格子横向对齐。 */
  /* 月份标签：宽度由脚本按横跨的周数写入，文字不换行。
     最后一个标签常常只剩一列宽，允许它溢出显示完整月份。 */
  .heat-months { display: flex; gap: 3px; height: 15px; margin: 0 0 4px; font-size: 11px; line-height: 15px; color: var(--text-muted); }
  .heat-months span { flex: none; overflow: visible; white-space: nowrap; }
  .heat-months span:last-child { position: relative; z-index: 1; }
  .heat-body { display: flex; gap: 6px; }
  /* 星期标签：与格子行严格对齐。
     右侧首个格子行的偏移是 15px（月份行高）+ 4px（下边距）= 19px；
     左侧 spacer 与首个标签之间还有 3px 的 flex gap，
     所以 spacer 高度取 16px，两者相加正好也是 19px。 */
  .heat-weekdays { display: flex; flex-direction: column; gap: 3px; font-size: 10px; color: var(--text-muted); }
  .heat-weekdays .spacer { height: 16px; margin: 0; flex: none; }
  .heat-weekdays span.day { height: 11px; line-height: 11px; flex: none; }

  /* 模型明细 */
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { padding: 7px 9px; text-align: left; border-bottom: 1px solid var(--border); }
  th { font-size: 11.5px; font-weight: 600; color: var(--text-muted); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; font-family: Consolas, ui-monospace, monospace; }
  tbody tr:last-child td { border-bottom: 0; }
  .empty { padding: 18px; text-align: center; font-size: 12.5px; color: var(--text-muted); }
  /* 占比只用百分比文字展示。 */
  .share { font-variant-numeric: tabular-nums; font-family: Consolas, ui-monospace, monospace; color: var(--text-muted); }

  /* 悬浮提示 */
  #tip { position: fixed; z-index: 2147483647; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font-size: 12px; line-height: 1.5; box-shadow: 0 6px 22px rgba(0,0,0,.22); pointer-events: none; opacity: 0; transition: opacity 120ms ease; white-space: nowrap; }
  #tip.on { opacity: 1; }
  #tip b { font-weight: 650; }
  .warn { margin-top: 10px; padding: 9px 11px; border: 1px solid var(--border); border-left: 3px solid #d97706; border-radius: 8px; background: var(--bg-panel); font-size: 12.5px; color: var(--text-muted); line-height: 1.6; }
  .warn b { color: var(--text); }
`;

/** 生成用量统计窗口的完整 HTML。 */
export function buildUsageHtml(data: UsageViewData): string {
  const palette: ThemePalette = THEME_PALETTES[data.theme] ??
    (data.systemDark ? THEME_PALETTES.dark : THEME_PALETTES.light);
  const themeVars = `
    --bg: ${palette.background};
    --bg-panel: ${palette.panel};
    /* 自绘标题栏底色：与 pi-web 顶部工具栏同色 */
    --titlebar-bg: ${palette.panel};
    --bg-hover: ${mix(palette.panel, palette.text, 0.06)};
    --border: ${palette.border};
    --text: ${palette.text};
    --text-muted: ${palette.textMuted};
    --accent: ${palette.accent};
    --accent-contrast: ${isLight(palette.background) ? "#ffffff" : "#182e22"};
    --heat-0: ${isLight(palette.background) ? "rgba(27, 31, 35, .06)" : "rgba(255, 255, 255, .07)"};
    --heat-outline: ${isLight(palette.background) ? "rgba(27, 31, 35, .06)" : "rgba(255, 255, 255, .04)"};
    --legend-1: ${HEAT_COLORS[1]};
    --legend-2: ${HEAT_COLORS[2]};
    --legend-3: ${HEAT_COLORS[3]};
    --legend-4: ${HEAT_COLORS[4]};
  `;

  return `<!doctype html>
<html lang="zh-CN" data-theme="${escapeAttr(palette.id)}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline';" />
  <title>Token 用量统计</title>
  <style>:root {${themeVars}}${TITLE_BAR_CSS}${BASE_CSS}</style>
</head>
<body>
  ${buildTitleBarHtml({
    title: "Token 用量统计",
    iconDataUrl: isLight(palette.background) ? data.lightIconDataUrl : data.darkIconDataUrl,
  })}
  <div class="page">
    <h1>Token 用量统计</h1>

    <div class="cards">
      <div class="card"><div class="k">总 Token</div><div class="v" id="sumTotal">—</div></div>
      <div class="card"><div class="k">输入 Token</div><div class="v" id="sumInput">—</div></div>
      <div class="card"><div class="k">输出 Token</div><div class="v" id="sumOutput">—</div></div>
      <div class="card"><div class="k">缓存命中 Token</div><div class="v" id="sumCache">—</div></div>
      <div class="card"><div class="k">缓存命中率</div><div class="v" id="sumHitRate">—</div></div>
    </div>

    <div class="filters">
      <span class="quick">
        <button type="button" data-range="today">今天</button>
        <button type="button" data-range="yesterday">昨天</button>
        <button type="button" data-days="7">7 天</button>
        <button type="button" data-days="30">30 天</button>
        <button type="button" data-days="90">90 天</button>
        <button type="button" data-days="365">一年</button>
      </span>
      <label for="from">起止</label>
      <input type="date" id="from" value="${escapeAttr(data.defaultFrom)}" />
      <span style="color:var(--text-muted)">~</span>
      <input type="date" id="to" value="${escapeAttr(data.defaultTo)}" />
      <label for="model">模型</label>
      <select id="model"><option value="">全部模型</option></select>
      <button class="btn primary" type="button" id="apply">查询</button>
    </div>

    <div class="section">
      <h2>模型明细</h2>
      <div style="border:1px solid var(--border);border-radius:10px;overflow:hidden">
        <table>
          <thead><tr>
            <th>模型</th>
            <th class="num">输入 token</th>
            <th class="num">输出 token</th>
            <th class="num">命中 token</th>
            <th class="num">命中率</th>
            <th class="num">合计 token</th>
            <th class="num">请求</th>
            <th class="num">占比</th>
          </tr></thead>
          <tbody id="modelRows"><tr><td colspan="8" class="empty">暂无数据</td></tr></tbody>
        </table>
      </div>
    </div>

    <div class="section">
      <h2>最近一年用量</h2>
      <div class="heat-wrap">
        <div class="heat-body">
          <div class="heat-weekdays">
            <div class="spacer"></div>
            <span class="day">一</span><span class="day"></span><span class="day">三</span><span class="day"></span><span class="day">五</span><span class="day"></span><span class="day">日</span>
          </div>
          <div class="heat-scroll">
            <div class="heat-months" id="heatMonths"></div>
            <div class="heat" id="heat"></div>
          </div>
        </div>
        <div class="heat-legend">
          <span id="heatRange">—</span>
          <span class="scale">
            少
            <i style="background:var(--heat-0)"></i>
            <i style="background:var(--legend-1)"></i>
            <i style="background:var(--legend-2)"></i>
            <i style="background:var(--legend-3)"></i>
            <i style="background:var(--legend-4)"></i>
            多
          </span>
        </div>
      </div>
      <div class="warn" id="pluginWarn" hidden></div>
    </div>
  </div>
  <div id="tip" role="tooltip"></div>
  <script>window.__PI_WEB_BOX_ICONS__ = ${JSON.stringify({
    dark: data.darkIconDataUrl,
    light: data.lightIconDataUrl,
  }).replaceAll("<", "\\u003c")};</script>
  <script>${TITLE_BAR_SCRIPT}</script>
  <script>${data.rendererScript}</script>
</body>
</html>`;
}

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

/** 汇总信息里需要在界面展示的数字，统一在这里格式化，避免前后端口径不一致。 */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

export type { UsageSummary, UsageOverview };

/**
 * 热力图固定展示 53 周，格子区宽度可以提前算出来：
 * 每列 11px 加 3px 间距。
 */
export const HEATMAP_WEEKS = 53;
const HEAT_CELL = 11;
const HEAT_GAP = 3;

/** 热力图格子区的像素宽度（不含星期标签与内边距）。 */
export function heatmapGridWidth(weeks = HEATMAP_WEEKS): number {
  return weeks * HEAT_CELL + (weeks - 1) * HEAT_GAP;
}

/**
 * 统计窗口的初始宽度。
 * 实测查询条件行单排约需 873px（含页面内边距），这里取 920 留些余量；
 * 渲染层加载后会再按实际宽度调用 fitUsageWindow 精确微调。
 */
export function usageWindowWidth(): number {
  return 920;
}
