import test from "node:test";
import assert from "node:assert/strict";
import {
  getPalette,
  getThemeLabel,
  isDarkPalette,
  isDarkTheme,
  isKnownTheme,
  normalizePalette,
  resolvePalette,
  THEME_PALETTES,
} from "../src/themes.js";
import { getLuminance, getSymbolColor, resolveTitleBarBackground } from "../src/titlebar.js";

test("theme palette covers every theme shipped by pi-web", () => {
  assert.deepEqual(Object.keys(THEME_PALETTES).sort(), [
    "contrast-dark",
    "contrast-light",
    "dark",
    "dusk",
    "ember",
    "light",
    "lilac",
    "mist",
    "pine",
    "rose",
    "sand",
    "slate",
    "zenburn",
  ]);
  // 颜色必须取自 pi-web 的 --bg，标题栏才能和页面连成一片。
  assert.equal(THEME_PALETTES.light.background, "#ffffff");
  assert.equal(THEME_PALETTES.dark.background, "#1a1a1a");
  assert.equal(THEME_PALETTES.mist.background, "#f4f8f7");
  assert.equal(THEME_PALETTES.rose.background, "#fcf7f8");
  assert.equal(THEME_PALETTES.pine.background, "#19201f");
  assert.equal(THEME_PALETTES.sand.background, "#faf6ee");
  assert.equal(THEME_PALETTES["contrast-dark"].background, "#000000");
});

test("每个主题都有中文名，未知主题回显标识", () => {
  for (const [id, palette] of Object.entries(THEME_PALETTES)) {
    assert.ok(palette.label.length > 0, id);
    assert.equal(getThemeLabel(id), palette.label);
  }
  assert.equal(getThemeLabel("dusk"), "暮紫");
  assert.equal(getThemeLabel("sand"), "暖沙");
  // 没有内置色板的新主题也要能显示名字，便于用户看出 pi-web 加了主题。
  assert.equal(getThemeLabel("brand-new"), "brand-new");
  assert.equal(getThemeLabel(""), "");
});

test("isKnownTheme filters unknown values coming from the page", () => {
  assert.equal(isKnownTheme("pine"), true);
  assert.equal(isKnownTheme("zenburn"), true);
  assert.equal(isKnownTheme("auto"), false);
  assert.equal(isKnownTheme(""), false);
  assert.equal(isKnownTheme(undefined), false);
  assert.equal(isKnownTheme("constructor"), false);
});

test("isDarkTheme covers every dark theme", () => {
  for (const id of ["dark", "pine", "dusk", "ember", "slate", "zenburn", "contrast-dark"]) {
    assert.equal(isDarkTheme(id), true, id);
  }
  for (const id of ["light", "mist", "lilac", "sand", "rose", "contrast-light"]) {
    assert.equal(isDarkTheme(id), false, id);
  }
});

test("getPalette falls back to the system theme", () => {
  assert.equal(getPalette("mist", false).id, "mist");
  assert.equal(getPalette("", true).id, "dark");
  assert.equal(getPalette("", false).id, "light");
});

test("normalizePalette keeps only valid hex colors", () => {
  assert.deepEqual(
    normalizePalette({ background: "#ABCDEF ", panel: "rgb(1,2,3)", border: "", text: "#abc", nope: "#ffffff" }),
    { background: "#abcdef", text: "#abc" },
  );
  assert.deepEqual(normalizePalette(null), {});
  assert.deepEqual(normalizePalette("not an object"), {});
  assert.deepEqual(normalizePalette({}), {});
});

test("resolvePalette prefers live colors and falls back per field", () => {
  const live = normalizePalette({ background: "#123456", accent: "rgb(0,0,0)" });
  const palette = resolvePalette("sand", live, false);
  assert.equal(palette.id, "sand");
  assert.equal(palette.label, "暖沙");
  // 页面实测优先，缺失或非法的字段回退到内置色板。
  assert.equal(palette.background, "#123456");
  assert.equal(palette.panel, THEME_PALETTES.sand.panel);
  assert.equal(palette.accent, THEME_PALETTES.sand.accent);
});

test("resolvePalette supports themes without built-in colors", () => {
  const live = normalizePalette({
    background: "#0b0b0b",
    panel: "#111111",
    border: "#222222",
    text: "#eeeeee",
    textMuted: "#999999",
    accent: "#66ccff",
  });
  const palette = resolvePalette("brand-new", live, false);
  assert.equal(palette.id, "brand-new");
  assert.equal(palette.label, "brand-new");
  assert.equal(palette.background, "#0b0b0b");
  assert.equal(palette.accent, "#66ccff");
  assert.ok(isDarkPalette(palette));
  // 页面读不到颜色时回退到与系统主题匹配的色板，主题标识仍然保留。
  const fallback = resolvePalette("brand-new", {}, true);
  assert.equal(fallback.id, "brand-new");
  assert.equal(fallback.background, THEME_PALETTES.dark.background);
  assert.equal(resolvePalette("", {}, false).id, "light");
});

test("isDarkPalette decides by background luminance", () => {
  assert.equal(isDarkPalette(THEME_PALETTES.dusk), true);
  assert.equal(isDarkPalette(THEME_PALETTES.slate), true);
  assert.equal(isDarkPalette(THEME_PALETTES["contrast-dark"]), true);
  assert.equal(isDarkPalette(THEME_PALETTES.sand), false);
  assert.equal(isDarkPalette(THEME_PALETTES["contrast-light"]), false);
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
