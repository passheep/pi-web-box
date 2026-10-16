import test from "node:test";
import assert from "node:assert/strict";
import { buildEnhancePanelScript } from "../src/enhance-panel.js";
import { THEME_PALETTES } from "../src/themes.js";

/** 构造一份最简的控件数据，用于检查生成的脚本内容。 */
function buildScript(): string {
  return buildEnhancePanelScript({
    palette: THEME_PALETTES.light,
    configured: true,
    scenes: [
      { id: "general", label: "通用" },
      { id: "coding", label: "编程" },
    ],
    defaultScene: "general",
    titleConfigured: true,
    titleModelLabel: "magpie/workbuddy2api/Deepseek-V4.1-Flash",
  });
}

test("enhance panel script is syntactically valid", () => {
  assert.doesNotThrow(() => new Function(buildScript()));
});

test("enhance panel renders the scene selector and enhance button", () => {
  const script = buildScript();
  assert.match(script, /id="scene"/);
  assert.match(script, /id="enhance"/);
  assert.match(script, /id="toBottom"/);
  assert.match(script, /通用/);
  assert.match(script, /编程/);
});

// 保存设置会重复注入控件；用 getElementById 只能删掉第一个，
// 残留的旧控件会让按钮在同一行里越堆越多。
test("enhance panel removes every stale instance before mounting", () => {
  const script = buildScript();
  assert.match(script, /querySelectorAll\("#pi-web-box-enhance"\)/);
  assert.doesNotMatch(script, /getElementById\("pi-web-box-enhance"\)\?\.remove\(\)/);
});

test("enhance panel keeps the back-to-bottom button hidden until it can scroll", () => {
  const script = buildScript();
  // 找不到滚动容器时必须隐藏按钮，避免出现按不动的悬浮球。
  assert.match(script, /if \(!scroller\) \{/);
  assert.match(script, /toBottom\.classList\.remove\("show", "has-new"\)/);
});

// 「生成标题」按钮紧跟「增强」，点击后调主进程完成命名并浮出结果提示。
test("enhance panel renders the title button next to the enhance button", () => {
  const script = buildScript();
  assert.match(script, /id="title"/);
  assert.match(script, /生成标题/);
  assert.match(script, /window\.piWebBox\.generateSessionTitle\(\)/);
  assert.match(script, /id="toast"/);
  // 按钮顺序：先增强、后生成标题（同一行相邻）。
  assert.ok(script.indexOf('id="enhance"') < script.indexOf('id="title"'));
  // 未配置命名模型时给出可读提示，而不是静默失败。
  assert.match(script, /尚未在 Box 设置的「会话命名」中选择命名模型/);
});

test("enhance panel shows the configured naming model in the tooltip data", () => {
  const script = buildScript();
  assert.match(script, /magpie\/workbuddy2api\/Deepseek-V4\.1-Flash/);
});