import { app, shell } from "electron";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type IconTheme = "light" | "dark";

export class ShortcutManager {
  constructor(private readonly log: (message: string) => void) {}

  private getSourceIcon(): string {
    const fileName = "pi-logo-adaptive.ico";
    return app.isPackaged
      ? path.join(process.resourcesPath, "assets", fileName)
      : path.join(app.getAppPath(), "assets", fileName);
  }

  private async prepareStableIcon(): Promise<string> {
    const iconDirectory = path.join(app.getPath("userData"), "icons");
    const iconPath = path.join(iconDirectory, "pi-logo-adaptive.ico");
    await fs.mkdir(iconDirectory, { recursive: true });
    await fs.copyFile(this.getSourceIcon(), iconPath);
    return iconPath;
  }

  async createOrUpdate(theme: IconTheme): Promise<void> {
    if (process.platform !== "win32" || !app.isPackaged) return;

    const desktop = app.getPath("desktop");
    const shortcutPath = path.join(desktop, "Pi Web Box.lnk");
    const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const cwd = path.dirname(target);

    try {
      await fs.mkdir(desktop, { recursive: true });
      const icon = await this.prepareStableIcon();
      const operation = fsSync.existsSync(shortcutPath) ? "update" : "create";
      const ok = shell.writeShortcutLink(shortcutPath, operation, {
        target,
        cwd,
        description: "在独立窗口中打开 Pi Web",
        appUserModelId: "com.piweb.box",
        icon,
        iconIndex: 0,
      });
      if (!ok) throw new Error("Windows 未能写入快捷方式");
      this.log(`Desktop shortcut updated with adaptive icon (${theme} Windows theme): ${shortcutPath}`);
    } catch (error) {
      this.log(`Could not create desktop shortcut: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
