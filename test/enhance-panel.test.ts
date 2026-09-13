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