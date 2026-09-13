# Pi Web Box

[English](./README.md)

Pi Web Box 是 Pi Web 的 Windows 桌面外壳：启动后会静默拉起已有的 `pi-web` 命令，并在独立窗口中展示 Pi Web 页面，不会弹出黑框终端。任务栏、托盘和桌面快捷方式统一使用“深色底 + 白色 Pi”的高对比度图标，在深浅色背景下都能看清；应用不显示 File/Edit 等原生菜单。Pi Web 中需要打开新标签页的功能（例如“完整历史”）会自动交给系统默认浏览器打开。

## 功能

- **标题栏自动跟随主题**：Windows 原生标题栏会用 Pi Web 当前的页面背景色填充，窗口和页面连成一体。Pi Web 有浅色、深色、雾青、蔷薇、松夜五种外观，切换后标题栏会自动同步，无需手动刷新。
- **Token 统计**：内置用量统计窗口，把 Pi 的用量日志渲染成 GitHub 风格的绿格子热力图（固定展示一整年，空白日期也占位），并给出今日/区间用量、花费和分模型排行，支持按日期区间与模型筛选。首次使用可一键安装配套的 `pi-usage-log` 扩展，让 Pi 自动记录用量。
- **提示词增强**：聊天输入框旁提供「增强」按钮，可选通用、编程、生图三种场景，调用你在 Pi 里配置好的模型把草稿改写得更清晰，结果以对照弹窗呈现，支持重新生成、采纳与取消。
- **回到底部**：消息向上滚动后浮现回到最新位置的按钮，有新消息时按钮上显示角标，滚回底部自动淡出。
- **托盘角标与通知**：有会话正在运行时，托盘图标叠加绿色角标并把提示文字改成运行中会话数量；会话从运行转为空闲时发送桌面通知。
- **关于面板**：页面右下角的悬浮按钮展开后，可查看 Pi、Pi Web 和 Pi Web Box 的版本，分别跳转对应官网与仓库，并进入 Box 设置、Token 统计与提示词增强设置。
- **Box 设置**：参考 Pi Web 设置面板的风格，分为「外观与行为」「Token 统计」「Pi Web 配置」「提示词增强」「关于」五个模块。
- **关闭后最小化至托盘**：默认开启，点关闭按钮会留在托盘并保持 Pi Web 服务运行，也可以在设置里改为直接退出；托盘图标本身也能单独关闭。
- **窗口位置记忆**：自动记住窗口的大小、位置和最大化状态，下次启动恢复原样；若窗口落在已拔掉的显示器上会自动回到屏幕中央。
- **Pi Web 启动配置**：可在界面里设置端口、监听主机名、允许的主机名、访问密码，以及 `pi-web` 和 Node.js 的路径，保存后重启生效。
- **配置重置**：启动页提供重置入口，配置写错导致 Pi Web 起不来时，可一键恢复默认并回到自动探测启动命令。
- **启动页与错误页**：不用打开终端就能看到当前步骤、进度条和 npm/pnpm 实时输出，失败时可在窗口内重试、重置或打开日志。

## 前置条件

- Windows 10/11（当前构建目标为 Windows x64）
- Node.js **22.19.0 或更高版本**
- 已安装 Pi Web：

```powershell
npm install -g @agegr/pi-web@latest
```

本项目不会把 Pi Web 和 Node.js 打包进 EXE，而是依赖系统中可执行的 `pi-web.cmd`，这样可以直接使用你通过 npm 更新的 Pi Web 版本。

## 开发

在 `pi-web-box` 目录执行：

```powershell
npm install
npm run typecheck
npm run dev
```

开发模式不会修改桌面，也不会自动创建快捷方式。

## 下载与安装

GitHub Release 每个版本同时提供两种产物，按需选择：

| 产物 | 类型 | 特点 |
| --- | --- | --- |
| `Pi Web Box Setup-<版本>.exe` | 安装包 | 向导式安装，可自选安装目录，自动创建开始菜单和桌面快捷方式，在“应用和功能”中注册卸载入口 |
| `Pi Web Box Portable-<版本>.exe` | 便携版 | 单文件，双击即用，无需安装，适合放 U 盘或临时使用 |

安装包默认按当前用户安装（不需要管理员权限），卸载时不会删除 Pi Web Box 的配置和日志。

## 构建

```powershell
npm install
npm run dist
```

构建配置会显式使用 `https://npmmirror.com/mirrors/electron/` 下载 Electron，以避免旧版全局 npm 镜像配置影响打包。

产物位于：

```text
dist/Pi Web Box Setup-0.5.0.exe       # 安装包
```

需要时也可以单独构建其它目标：

```powershell
npm run dist:nsis        # 只构建安装包
npm run dist:portable    # 只构建便携版
npm run dist:both        # 安装包和便携版一起构建
```

> 打包前请关闭正在运行的 Pi Web Box。如果 dist 里同版本的 EXE 正在运行，Windows 会锁住文件，构建会卡在 `building target=` 不动。

## 日常使用

首次双击 EXE 后，应用会在当前用户桌面创建或更新：

```text
Pi Web Box.lnk
```

快捷方式目标始终是本次启动的 EXE，因此移动便携版后，只需从新位置启动一次，快捷方式就会自动更新。关闭窗口会完全退出应用，并清理由应用本次启动的 Pi Web 服务；如果检测到已有 Pi Web 服务占用默认端口，则会复用它，不会停止外部服务。

每次启动都会联网查询 `@earendil-works/pi-coding-agent` 和 `@agegr/pi-web` 的 npm 最新版本。发现新版本时会先询问是否更新；确认后，启动页会显示当前组件、进度条和 npm/pnpm 实时输出。更新完成后，用户点击“确认并重启”，Pi Web Box 会重新启动并使用新版本。断网或版本查询失败不会阻止正常启动。Pi 按检测到的全局包管理器更新（npm/pnpm），Pi Web 同理。

默认端口为 `30141`。如果该端口被其他程序占用，应用会自动选择一个可用的本地回环端口。

### Pi Web 配置项

以下配置可以在应用内的 **Box 设置 → Pi Web 配置** 中修改，保存后重启 Pi Web Box 生效：

| 配置项 | 对应参数 | 说明 |
| --- | --- | --- |
| 服务端口 | `--port` | 默认 `30141`，被占用时自动改用其它可用端口 |
| 监听主机名 | `--hostname` | 默认 `127.0.0.1` 仅本机访问；改为 `0.0.0.0` 会开放局域网访问，此时设置页会显示可用的内网地址 |
| 允许的主机名 | `PI_WEB_ALLOWED_HOSTS` | 反向代理或自定义域名需精确填写，多个值用逗号分隔 |
| 访问密码 | `PI_WEB_PASSWORD` | 启用浏览器密码登录，API 客户端使用用户名 `pi` 的 Basic Auth |
| pi-web 命令路径 | — | 留空时从 `PATH` 自动探测 |
| Node.js 路径 | — | 留空时从 `PATH` 自动探测 |

设置保存在 `%APPDATA%/Pi Web Box/settings.json`。如果配置写错导致 Pi Web 无法启动，可在启动页点「重置配置」恢复默认。

### Token 统计

统计窗口读取 Pi 的用量日志，位置在：

```text
~/.pi/agent/analytics/usage.jsonl
```

热力图固定展示最近一年（周一为一周起始），没有记录的日期留空占位，颜色深浅按当天的 Token 用量分档。如果该日志文件还不存在，说明 Pi 尚未记录用量，可在 **Box 设置 → Token 统计** 点「一键安装」装好配套扩展；安装后重启 Pi Web Box，用量会在后续对话中自动累积。

### 提示词增强

增强功能使用你在 Pi 里已经配置好的模型，因此需要先在 **Box 设置 → 提示词增强** 中选择一个供应商和模型。API Key 只在应用主进程内读取，不会写进页面或日志，也不会另存一份。

### 外观

标题栏会跟随 Pi Web 的当前主题自动上色，支持浅色、深色、雾青、蔷薇、松夜五种外观。关于面板与设置窗口的配色同样跟随主题，深浅色背景下都会自动切换到对应版本的 Logo。

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
