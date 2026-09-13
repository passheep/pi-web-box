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
$r1 = [PiWebBoxDwm]::DwmSetWindowAttribute($h, 35, [ref]$caption, 4)
$r2 = [PiWebBoxDwm]::DwmSetWindowAttribute($h, 34, [ref]$caption, 4)
# 36 = DWMWA_TEXT_COLOR 标题文字色，20 = DWMWA_USE_IMMERSIVE_DARK_MODE 深色标题栏
$r3 = [PiWebBoxDwm]::DwmSetWindowAttribute($h, 36, [ref]$symbol, 4)
$r4 = [PiWebBoxDwm]::DwmSetWindowAttribute($h, 20, [ref]$dark, 4)
# 输出各次调用的 HRESULT，全部为 0 才算成功；
# 失败时主进程会把它写进日志，便于判断颜色被系统拒绝的情况。
Write-Output "DWM result: caption=$r1 border=$r2 text=$r3 darkmode=$r4"
if (($r1 -ne 0) -or ($r2 -ne 0) -or ($r3 -ne 0) -or ($r4 -ne 0)) { Write-Output "FAILED" }
`;
}

/**
 * 标题栏配色器。主题切换时调用 apply，内部会合并连续请求，
 * 避免用户快速点选主题时反复拉起 PowerShell 进程。
 */
export class TitleBarColorizer {
  // 按窗口句柄分别记录已应用的颜色：多个窗口可能用同一个色值，
  // 只用一个字段记录会误判为“已应用”，导致子窗口从未被着色。
  private readonly applied = new Map<string, string>();
  // 待处理队列：早前用单个 pending 槽位，两个窗口先后请求会互相覆盖。
  private readonly queue: Array<{ hwnd: string; background: string }> = [];
  private running = false;

  constructor(private readonly log: (message: string) => void = () => {}) {}

  apply(hwnd: string, background: string): void {
    if (process.platform !== "win32" || !hwnd) return;
    if (this.applied.get(hwnd) === background) return;
    this.enqueue(hwnd, background);
  }

  /**
   * 强制重新着色。系统在焦点切换、子窗口开关时会重绘标题栏，
   * 此时缓存不可靠，必须忽略缓存重新下发。
   */
  reapply(hwnd: string, background: string): void {
    if (process.platform !== "win32" || !hwnd) return;
    this.applied.delete(hwnd);
    this.enqueue(hwnd, background);
  }

  /** 同一个窗口只保留最后一次请求，避免快速切换主题时排队。 */
  private enqueue(hwnd: string, background: string): void {
    const existing = this.queue.findIndex((item) => item.hwnd === hwnd);
    if (existing >= 0) this.queue[existing].background = background;
    else this.queue.push({ hwnd, background });
    void this.drain();
  }

  /** 窗口销毁后清掉记录，句柄可能被系统复用。 */
  forget(hwnd: string): void {
    this.applied.delete(hwnd);
  }

  /** 清空全部记录，用于手动刷新标题栏。 */
  reset(): void {
    this.applied.clear();
    this.queue.length = 0;
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
      while (this.queue.length) {
        const { hwnd, background } = this.queue.shift()!;
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
        (error, stdout, stderr) => {
          if (error) {
            // 旧版 Windows 不支持该属性，这里只记录失败原因，不影响主流程。
            this.log(`Could not color the native title bar: ${error.message}`);
          } else if (/FAILED/i.test(stdout) || /FAILED/i.test(stderr)) {
            // DWM 调用返回失败码时输出出来，便于判断是否被系统拒绝。
            this.log(`DWM rejected title bar color: ${(stdout || stderr).trim().slice(0, 200)}`);
          } else {
            this.applied.set(hwnd, background);
            this.log(`Applied title bar color ${background} to hwnd=${hwnd}.`);
          }
          resolve();
        },
      );
    });
  }
}
