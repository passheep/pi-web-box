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
  assert.match(script, /attachShadow/);
  assert.match(script, /mouseenter/);
  assert.match(script, /mouseleave/);
  assert.match(script, /translateY\(8px\) scale\(\.97\)/);
  assert.doesNotThrow(() => new Function(script));
});
