import { execFile } from "node:child_process";
import { getPalette, isDarkTheme } from "./themes.js";

/** 计算颜色亮度，用来判断标题栏文字该用深色还是浅色。 */
export function getLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return 0.299 * red + 0.587 * green + 0.114 * blue;
}

/** 标题栏文字与系统按钮的颜色，浅底用深色字，深底用浅色字。 */
export function getSymbolColor(background: string): string {
  return getLuminance(background) > 150 ? "#18181b" : "#f4f4f5";
}

/**
 * 解析最终要应用的标题栏背景色：优先使用页面实测到的 --bg，
 * 读取不到时回退到内置主题色板，再回退到与系统主题匹配的默认色。
 */
export function resolveTitleBarBackground(theme: string, pageBackground: string, systemDark: boolean): string {
  if (/^#[0-9a-f]{6}$/i.test(pageBackground)) return pageBackground.toLowerCase();
  return getPalette(theme, systemDark).background;
}

// COLORREF 采用 0x00BBGGRR 排列，需要按 BGR 组装。
function toColorRef(hex: string): number {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return (blue << 16) | (green << 8) | red;
}

// 通过 DWM 给 Windows 原生标题栏上色。Windows 11 才支持该属性，
// 旧系统会返回失败码但不报错，此时标题栏保持系统默认样式。
function buildDwmScript(hwnd: string, caption: string, symbol: string, dark: boolean): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PiWebBoxDwm {
  [DllImport("dwmapi.dll")]
  public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
}
"@
$h = [IntPtr][int64]${hwnd}
$caption = ${toColorRef(caption)}
$symbol = ${toColorRef(symbol)}
$dark = ${dark ? 1 : 0}
# 35 = DWMWA_CAPTION_COLOR 标题栏底色，34 = DWMWA_BORDER_COLOR 边框色
$null = [PiWebBoxDwm]::DwmSetWindowAttribute($h, 35, [ref]$caption, 4)
$null = [PiWebBoxDwm]::DwmSetWindowAttribute($h, 34, [ref]$caption, 4)
# 36 = DWMWA_TEXT_COLOR 标题文字色，20 = DWMWA_USE_IMMERSIVE_DARK_MODE 深色标题栏
$null = [PiWebBoxDwm]::DwmSetWindowAttribute($h, 36, [ref]$symbol, 4)
$null = [PiWebBoxDwm]::DwmSetWindowAttribute($h, 20, [ref]$dark, 4)
`;
}

/**
 * 标题栏配色器。主题切换时调用 apply，内部会合并连续请求，
 * 避免用户快速点选主题时反复拉起 PowerShell 进程。
 */
export class TitleBarColorizer {
  private applied = "";
  private running = false;
  private pending: { hwnd: string; background: string } | undefined;

  constructor(private readonly log: (message: string) => void = () => {}) {}

  apply(hwnd: string, background: string): void {
    if (process.platform !== "win32" || !hwnd) return;
    if (this.applied === background && !this.pending) return;
    this.pending = { hwnd, background };
    void this.drain();
  }

  /** 按主题名直接上色，页面没回传具体颜色时使用内置色板。 */
  applyTheme(hwnd: string, theme: string, systemDark: boolean): void {
    const background = resolveTitleBarBackground(theme, "", systemDark);
    this.apply(hwnd, background);
    this.lastTheme = theme;
  }

  private lastTheme = "";

  getTheme(): string {
    return this.lastTheme;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending) {
        const { hwnd, background } = this.pending;
        this.pending = undefined;
        await this.invoke(hwnd, background);
      }
    } finally {
      this.running = false;
    }
  }

  private invoke(hwnd: string, background: string): Promise<void> {
    const symbol = getSymbolColor(background);
    // 深色底使用深色标题栏模式，让系统按钮保持浅色描边。
    const dark = isDarkTheme(this.lastTheme) || getLuminance(background) <= 150;
    const script = buildDwmScript(hwnd, background, symbol, dark);
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return new Promise((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        { windowsHide: true, timeout: 8_000 },
        (error) => {
          if (error) {
            // 旧版 Windows 不支持该属性，这里只记录失败原因，不影响主流程。
            this.log(`Could not color the native title bar: ${error.message}`);
          } else {
            this.applied = background;
          }
          resolve();
        },
      );
    });
  }
}
