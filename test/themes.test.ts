import test from "node:test";
import assert from "node:assert/strict";
import { getPalette, isDarkTheme, isKnownTheme, THEME_PALETTES } from "../src/themes.js";
import { getLuminance, getSymbolColor, resolveTitleBarBackground } from "../src/titlebar.js";

test("theme palette covers the five Pi Web themes", () => {
  assert.deepEqual(Object.keys(THEME_PALETTES).sort(), ["dark", "light", "mist", "pine", "rose"]);
  // 颜色必须取自 pi-web 的 --bg，标题栏才能和页面连成一片。
  assert.equal(THEME_PALETTES.light.background, "#ffffff");
  assert.equal(THEME_PALETTES.dark.background, "#1a1a1a");
  assert.equal(THEME_PALETTES.mist.background, "#f4f8f7");
  assert.equal(THEME_PALETTES.rose.background, "#fcf7f8");
  assert.equal(THEME_PALETTES.pine.background, "#19201f");
});

test("isKnownTheme filters unknown values coming from the page", () => {
  assert.equal(isKnownTheme("pine"), true);
  assert.equal(isKnownTheme("auto"), false);
  assert.equal(isKnownTheme(""), false);
  assert.equal(isKnownTheme(undefined), false);
  assert.equal(isKnownTheme("constructor"), false);
});

test("isDarkTheme matches Pi Web dark and pine", () => {
  assert.equal(isDarkTheme("dark"), true);
  assert.equal(isDarkTheme("pine"), true);
  assert.equal(isDarkTheme("light"), false);
  assert.equal(isDarkTheme("mist"), false);
  assert.equal(isDarkTheme("rose"), false);
});

test("getPalette falls back to the system theme", () => {
  assert.equal(getPalette("mist", false).id, "mist");
  assert.equal(getPalette("", true).id, "dark");
  assert.equal(getPalette("", false).id, "light");
});

test("resolveTitleBarBackground prefers the measured page background", () => {
  assert.equal(resolveTitleBarBackground("light", "#123456", false), "#123456");
  // 页面颜色读取失败时回退到内置色板。
  assert.equal(resolveTitleBarBackground("pine", "", false), "#19201f");
  assert.equal(resolveTitleBarBackground("", "", true), "#1a1a1a");
  assert.equal(resolveTitleBarBackground("", "", false), "#ffffff");
});

test("symbol color follows the background luminance", () => {
  assert.equal(getSymbolColor("#ffffff"), "#18181b");
  assert.equal(getSymbolColor("#19201f"), "#f4f4f5");
  assert.ok(getLuminance("#ffffff") > getLuminance("#000000"));
});
