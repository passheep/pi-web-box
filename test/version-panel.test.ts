import test from "node:test";
import assert from "node:assert/strict";
import { buildVersionPanelScript } from "../src/version-panel.js";

test("version panel contains component versions and external links", () => {
  const script = buildVersionPanelScript({
    pi: "0.84.2",
    piWeb: "0.8.9",
    piWebBox: "0.4.0",
    iconDataUrl: "data:image/png;base64,abc",
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
  assert.doesNotThrow(() => new Function(script));
});
