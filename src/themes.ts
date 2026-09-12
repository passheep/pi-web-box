// pi-web 的外观主题定义。颜色取自 pi-web 的 CSS 变量（--bg、--bg-panel、--border 等），
// Box 设置窗口和 Windows 标题栏都按这套色板着色，保证与 Pi Web 页面视觉统一。
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
};

// pi-web 里 dark 与 pine 都是深色系，决定标题栏按钮和文字的明暗。
const DARK_THEMES = new Set(["dark", "pine"]);

export function isKnownTheme(value: unknown): value is string {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(THEME_PALETTES, value);
}

export function isDarkTheme(theme: string): boolean {
  return DARK_THEMES.has(theme);
}

/** 按主题取色板，未知主题回退到与系统主题匹配的浅色或深色。 */
export function getPalette(theme: string, systemDark: boolean): ThemePalette {
  if (isKnownTheme(theme)) return THEME_PALETTES[theme];
  return systemDark ? THEME_PALETTES.dark : THEME_PALETTES.light;
}
