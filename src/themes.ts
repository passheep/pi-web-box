// pi-web 的外观主题定义。颜色取自 pi-web 的 CSS 变量（--bg、--bg-panel、--border 等），
// Box 设置窗口和自绘标题栏都按这套色板着色，保证与 Pi Web 页面视觉统一。
//
// 这里的色板只作为「回退值」：正常运行时会优先使用页面回传的实时颜色
// （见 resolvePalette），因此 pi-web 以后新增主题也能自动跟随。
export type ThemePalette = {
  id: string;
  label: string;
  background: string;
  panel: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
};

// 「页面实时色板」：只包含从页面 CSS 变量读到的颜色，字段可缺失。
export type LivePalette = Partial<Omit<ThemePalette, "id" | "label">>;

/** 色板里可以来自页面的颜色字段。 */
export const PALETTE_COLOR_KEYS = [
  "background",
  "panel",
  "border",
  "text",
  "textMuted",
  "accent",
] as const;

// 与 pi-web 0.12.x 的 [data-theme=...] 定义逐项对应。
export const THEME_PALETTES: Record<string, ThemePalette> = {
  light: {
    id: "light",
    label: "浅色",
    background: "#ffffff",
    panel: "#f5f5f5",
    border: "#e0e0e0",
    text: "#1a1a1a",
    textMuted: "#515c6b",
    accent: "#245bce",
  },
  mist: {
    id: "mist",
    label: "雾青",
    background: "#f4f8f7",
    panel: "#e9f0ee",
    border: "#afc4ba",
    text: "#202e2b",
    textMuted: "#455f56",
    accent: "#1e6559",
  },
  lilac: {
    id: "lilac",
    label: "丁香",
    background: "#f8f6fc",
    panel: "#efebf6",
    border: "#c4b8d8",
    text: "#2b2635",
    textMuted: "#574d68",
    accent: "#6a43a8",
  },
  sand: {
    id: "sand",
    label: "暖沙",
    background: "#faf6ee",
    panel: "#f1ebdf",
    border: "#cdbfa6",
    text: "#2e2a22",
    textMuted: "#5c5243",
    accent: "#7a4f10",
  },
  rose: {
    id: "rose",
    label: "蔷薇",
    background: "#fcf7f8",
    panel: "#f3edef",
    border: "#cdb5bf",
    text: "#34282e",
    textMuted: "#65505a",
    accent: "#914360",
  },
  dark: {
    id: "dark",
    label: "深色",
    background: "#1a1a1a",
    panel: "#242424",
    border: "#454545",
    text: "#e8e8e8",
    textMuted: "#b7b7b7",
    accent: "#a4c2f4",
  },
  pine: {
    id: "pine",
    label: "松夜",
    background: "#19201f",
    panel: "#212b28",
    border: "#4a5f52",
    text: "#e6ede8",
    textMuted: "#c3d0c6",
    accent: "#acccb7",
  },
  dusk: {
    id: "dusk",
    label: "暮紫",
    background: "#1e1a24",
    panel: "#26212e",
    border: "#54496a",
    text: "#ebe6f0",
    textMuted: "#c9c0d4",
    accent: "#cdb4f0",
  },
  ember: {
    id: "ember",
    label: "余烬",
    background: "#1f1a16",
    panel: "#28211c",
    border: "#5a4a3d",
    text: "#ede4da",
    textMuted: "#cfc0b0",
    accent: "#e8b27a",
  },
  slate: {
    id: "slate",
    label: "岩蓝",
    background: "#161b26",
    panel: "#1d2331",
    border: "#435069",
    text: "#e3e8f2",
    textMuted: "#bcc5d6",
    accent: "#8ccfe0",
  },
  zenburn: {
    id: "zenburn",
    label: "Zenburn",
    background: "#3f3f3f",
    panel: "#383838",
    border: "#6f6f6f",
    text: "#dcdccc",
    textMuted: "#cfcfbf",
    accent: "#f0dfaf",
  },
  "contrast-light": {
    id: "contrast-light",
    label: "高对比浅色",
    background: "#ffffff",
    panel: "#f3f3f3",
    border: "#5c5c5c",
    text: "#000000",
    textMuted: "#1f1f1f",
    accent: "#0034a0",
  },
  "contrast-dark": {
    id: "contrast-dark",
    label: "高对比深色",
    background: "#000000",
    panel: "#0f0f0f",
    border: "#a3a3a3",
    text: "#ffffff",
    textMuted: "#ebebeb",
    accent: "#ffd60a",
  },
};

// 主题中文名。与 THEME_PALETTES 分开维护：即使 pi-web 加了新主题
// （此时没有静态色板），也只需在这里补一个名字，色值仍会自动跟随页面。
export const THEME_LABELS: Record<string, string> = Object.fromEntries(
  Object.values(THEME_PALETTES).map((palette) => [palette.id, palette.label]),
);

// pi-web 里属于深色系的主题，决定标题栏按钮、logo 与热力图的明暗。
const DARK_THEMES = new Set([
  "dark",
  "pine",
  "dusk",
  "ember",
  "slate",
  "zenburn",
  "contrast-dark",
]);

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isKnownTheme(value: unknown): value is string {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(THEME_PALETTES, value);
}

export function isDarkTheme(theme: string): boolean {
  return DARK_THEMES.has(theme);
}

/** 主题中文名；未知主题直接回显主题标识，便于用户看出 pi-web 新增了主题。 */
export function getThemeLabel(theme: string): string {
  if (!theme) return "";
  return THEME_LABELS[theme] ?? theme;
}

/** 只接受 #rgb / #rrggbb，避免把页面上的 rgb()/var() 之类写进样式。 */
export function isValidHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value.trim());
}

/**
 * 归一化页面回传的实时色板：只保留合法的十六进制颜色，其余字段丢弃。
 * 页面结构变化或取值失败时不会污染已有颜色。
 */
export function normalizePalette(raw: unknown): LivePalette {
  if (!raw || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;
  const palette: LivePalette = {};
  for (const key of PALETTE_COLOR_KEYS) {
    const value = source[key];
    if (isValidHexColor(value)) palette[key] = value.trim().toLowerCase();
  }
  return palette;
}

/** 按背景亮度判断深浅：不依赖主题 id，pi-web 新增主题也能正确判断。 */
export function isDarkPalette(palette: ThemePalette): boolean {
  const value = palette.background.replace("#", "");
  const full = value.length === 3 ? value.split("").map((char) => char + char).join("") : value;
  const [red, green, blue] = [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
  if (![red, green, blue].every((channel) => Number.isFinite(channel))) return isDarkTheme(palette.id);
  return 0.299 * red + 0.587 * green + 0.114 * blue <= 150;
}

/**
 * 合成最终色板：页面实测颜色优先，缺失或非法的字段回退到内置色板，
 * 内置里也没有的主题回退到与系统主题匹配的浅色 / 深色。
 */
export function resolvePalette(theme: string, live: LivePalette | undefined, systemDark: boolean): ThemePalette {
  const fallback = isKnownTheme(theme)
    ? THEME_PALETTES[theme]
    : systemDark
      ? THEME_PALETTES.dark
      : THEME_PALETTES.light;
  const palette: ThemePalette = { ...fallback, id: theme || fallback.id, label: getThemeLabel(theme) || fallback.label };
  if (!live) return palette;
  for (const key of PALETTE_COLOR_KEYS) {
    const value = live[key];
    if (isValidHexColor(value)) palette[key] = value.trim().toLowerCase();
  }
  return palette;
}

/** 按主题取内置色板，未知主题回退到与系统主题匹配的浅色或深色。 */
export function getPalette(theme: string, systemDark: boolean): ThemePalette {
  if (isKnownTheme(theme)) return THEME_PALETTES[theme];
  return systemDark ? THEME_PALETTES.dark : THEME_PALETTES.light;
}
