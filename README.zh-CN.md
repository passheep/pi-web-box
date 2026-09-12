# Pi Web Box

[English](./README.md)

Pi Web Box 是一个 Windows 便携桌面窗口：双击 EXE 后，它会静默启动已有的 `pi-web` 命令，并在独立窗口中展示 Pi Web 页面，不会弹出黑框终端。任务栏和窗口使用高对比度图标，应用不显示 File/Edit 等原生菜单。便携版 EXE、任务栏和桌面快捷方式使用“深色底 + 白色 Pi”的高对比度通用图标，在深浅色背景下都能看清。Pi Web 中需要打开新标签页的功能（例如“完整历史”）会自动交给系统默认浏览器打开。页面右下角提供版本悬浮按钮，可查看 Pi、Pi Web 和 Pi Web Box 版本，并打开对应官网。

## 前置条件

- Windows 10/11（当前构建目标为 Windows x64）
- Node.js **22.19.0 或更高版本**
- 已安装 Pi Web：

```powershell
npm install -g @agegr/pi-web@latest
```

本项目不会把 Pi Web 和 Node.js 打包进 EXE。便携版依赖系统中可执行的 `pi-web.cmd`，这样可以直接使用你通过 npm 更新的 Pi Web 版本。

## 开发

在 `pi-web-box` 目录执行：

```powershell
npm install
npm run typecheck
npm run dev
```

开发模式不会修改桌面，也不会自动创建快捷方式。

## 构建便携版

```powershell
npm install
npm run dist
```

构建配置会显式使用 `https://npmmirror.com/mirrors/electron/` 下载 Electron，以避免旧版全局 npm 镜像配置影响打包。

产物位于：

```text
dist/Pi Web Box Portable-0.4.1.exe
```

这是单文件便携版，不需要安装。将 EXE 放到任意有写入权限（或只读也可以运行）的目录即可。

## 日常使用

首次双击 EXE 后，应用会在当前用户桌面创建或更新：

```text
Pi Web Box.lnk
```

快捷方式目标始终是本次启动的 EXE，因此移动便携版后，只需从新位置启动一次，快捷方式就会自动更新。关闭窗口会完全退出应用，并清理由应用本次启动的 Pi Web 服务；如果检测到已有 Pi Web 服务占用默认端口，则会复用它，不会停止外部服务。

每次启动都会联网查询 `@earendil-works/pi-coding-agent` 和 `@agegr/pi-web` 的 npm 最新版本。发现新版本时会先询问是否更新；确认后，启动页会显示当前组件、进度条和 npm/pnpm 实时输出。更新完成后，用户点击“确认并重启”，Pi Web Box 会重新启动并使用新版本。断网或版本查询失败不会阻止正常启动。Pi 按检测到的全局包管理器更新（npm/pnpm），Pi Web 同理。

默认端口为 `30141`。如果该端口被其他程序占用，应用会自动选择一个可用的本地回环端口。服务只监听 `127.0.0.1`，不会开放局域网访问。

## 故障排查

错误会显示在应用窗口内，不会弹出终端。日志文件位于 Electron 用户数据目录下：

```text
%APPDATA%/Pi Web Box/logs/pi-web.log
```

如果找不到命令，可以通过环境变量指定绝对路径：

```powershell
$env:PI_WEB_BOX_COMMAND = 'C:\Users\你的用户名\AppData\Local\npm-global\pi-web.cmd'
```

也可以指定首选端口或 Node.js 路径：

```powershell
$env:PI_WEB_BOX_PORT = '30141'
$env:PI_WEB_BOX_NODE = 'C:\\Program Files\\nodejs\\node.exe'
```

排查或自动化测试时可跳过版本查询：

```powershell
$env:PI_WEB_BOX_SKIP_UPDATE_CHECK = '1'
```

如果需要使用自定义 npm registry 查询最新版本：

```powershell
$env:PI_WEB_BOX_REGISTRY = 'https://registry.npmmirror.com'
```

常见修复方法：

1. 执行 `node --version`，确认版本至少为 `22.19.0`。
2. 执行 `where pi-web`，确认 PATH 中存在 `pi-web.cmd`。
3. 重新执行 `npm install -g @agegr/pi-web@latest`。
4. 查看错误页中的“打开日志”。

Pi Web 页面右下角使用白底黑色 Pi 悬浮图标，鼠标移入后会通过动画展开组件版本面板，移出后自动隐藏。点击面板中的 Pi 会在默认浏览器打开 `https://pi.dev`，点击 Pi Web 会打开 `https://github.com/agegr/pi-web`。

Pi Web 继续使用当前用户的 pi 配置、凭据、会话和项目文件；Pi Web Box 不会修改这些内容。
