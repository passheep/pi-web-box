import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildVersionPanelScript } from "../src/version-panel.js";

test("version panel contains component versions and external links", () => {
  const script = buildVersionPanelScript({
    pi: "0.84.2",
    piWeb: "0.8.9",
    piWebBox: "0.4.0",
    darkIconDataUrl: "data:image/png;base64,abc",
    lightIconDataUrl: "data:image/png;base64,abc",
  });
  assert.match(script, /0\.84\.2/);
  assert.match(script, /0\.8\.9/);
  assert.match(script, /0\.4\.0/);
  assert.match(script, /https:\/\/pi\.dev/);
  assert.match(script, /https:\/\/github\.com\/agegr\/pi-web/);
  // 面板里要能看到 Pi Web Box 自己的仓库入口。
  assert.match(script, /https:\/\/github\.com\/passheep\/pi-web-box/);
  // 标题与设置入口。
  assert.match(script, /关于/);
  assert.match(script, /Box 设置/);
  assert.match(script, /data-action/);
  assert.match(script, /openSettings/);
  // 外观主题监听：用于自动同步 Windows 标题栏。
  assert.match(script, /MutationObserver/);
  assert.match(script, /reportTheme/);
  assert.match(script, /data-theme/);
  assert.match(script, /attachShadow/);
  assert.match(script, /mouseenter/);
  assert.match(script, /mouseleave/);
  assert.match(script, /translateY\(8px\) scale\(\.97\)/);
  // 悬浮面板不再展示联系 QQ 与仓库地址（这些信息只在设置页保留）。
  assert.doesNotMatch(script, /联系 QQ/);
  assert.doesNotMatch(script, /class="meta"/);
  // 悬浮球展示真实品牌 logo（图片），不再使用手写的简化内联图形。
  assert.match(script, /class="logo"/);
  assert.match(script, /darkIconDataUrl/);
  assert.match(script, /lightIconDataUrl/);
  assert.doesNotThrow(() => new Function(script));
});

// 重复注入时旧控件必须全部清掉，否则会越点越多。
test("panel scripts clear every stale instance before mounting", () => {
  const script = buildVersionPanelScript({
    pi: "1",
    piWeb: "2",
    piWebBox: "3",
    darkIconDataUrl: "data:image/png;base64,abc",
    lightIconDataUrl: "data:image/png;base64,abc",
  });
  assert.match(script, /querySelectorAll\("#pi-web-box-version-panel"\)/);
});

// 月份标签必须按横跨的周数分配宽度，写死 11px 会把最右侧的月份裁成半个字。
test("heatmap month labels size themselves to the weeks they span", () => {
  const renderer = readFileSync(new URL("../src/usage-renderer.js", import.meta.url), "utf8");
  assert.match(renderer, /span\.style\.width/);
  assert.match(renderer, /spanWeeks/);
});

// 标题栏与 pi-web 顶栏同色，多一条分割线会显得割裂。
test("main title bar draws no separator line", () => {
  const view = readFileSync(new URL("../src/titlebar-view.ts", import.meta.url), "utf8");
  assert.match(view, /bar\.style\.borderBottom = "none"/);
});
