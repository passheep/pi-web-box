# Pi Web Box

[English](./README.en.md)

Pi Web Box 是基于 [Pi Web](https://github.com/agegr/pi-web) 的 Windows 桌面增强客户端（Electron）。Pi Web 是 [pi 编码智能体](https://pi.dev/)的本地 Web 界面；Pi Web Box 不修改 Pi Web 本身，而是把它装进一个原生子窗口，在其基础上叠加多标签、消息历史等桌面体验。不捆绑 Node.js 和 Pi Web，始终使用你通过 npm 管理的版本。

## 在 Pi Web 基础上增强了什么

- **多标签会话**：最多 6 个标签复用同一个 Pi Web 服务，支持拖拽排序、中键关闭及 Ctrl+T / Ctrl+W / Ctrl+Tab 快捷键。每个打开的标签使用不重复的彩点标识，会话运行时显示环形动画；关闭标签只关闭页面，不会中止后台会话。
- **本地消息中心**：右上角入口与未读角标；历史通知倒序展示，每页 30 条，滚动到底自动加载更早消息，点击可跳转对应会话。数据保存在本地 `%APPDATA%/Pi Web Box/notifications.sqlite`，仅记录 Box 页面实际收到的消息，退出或断线期间不补录。
- **窗口体验**：三窗口自绘标题栏，颜色自动跟随 Pi Web 的五种外观（浅色、深色、雾青、蔷薇、松夜）；最小化至托盘、窗口位置记忆、桌面高对比度图标。
- **托盘角标与通知**：有会话运行时托盘叠加绿色角标并显示运行数量；会话转空闲时发送桌面通知。
- **Token 统计**：把 Pi 的用量日志渲染成 GitHub 风格热力图，支持今日/区间用量、花费与分模型排行，可一键安装配套 `pi-usage-log` 扩展。
- **提示词增强**：聊天输入框旁的「增强」按钮，用你在 Pi 里配置好的模型把草稿改写得更清晰，支持通用、编程、生图三种场景。
- **一键更新 pi 与 pi-web**：启动时查询 npm 最新版本，确认后在界面内完成更新并重启，全程无终端窗口。

## 工作原理

启动后自动探测（或按设置拉起）本机的 `pi-web` 命令，默认监听 `127.0.0.1:30141`；若已有健康的 Pi Web 服务则直接复用，不会重复启动或停止外部服务。Pi Web 的配置、凭据、会话与项目文件与 pi 共用，Box 不修改这些内容。

## 安装

到 [Releases](https://github.com/passheep/pi-web-box/releases) 下载 Windows x64 安装包（`Pi Web Box Setup-<版本>.exe`），按向导安装即可；更新日志见 [release-notes](./release-notes/)。

前置条件：

- Windows 10/11
- Node.js **22.19.0 或更高版本**
- 已安装 pi 与 Pi Web：

```powershell
npm install -g @earendil-works/pi-coding-agent@latest
npm install -g @agegr/pi-web@latest
```

## 配置

应用内 **Box 设置** 可修改以下 Pi Web 启动参数，保存后重启生效：

| 配置项 | 对应参数 | 说明 |
| --- | --- | --- |
| 服务端口 | `--port` | 默认 `30141`，被占用时自动改用其它可用端口 |
| 监听主机名 | `--hostname` | 默认仅本机访问，改 `0.0.0.0` 开放局域网 |
| 访问密码 | `PI_WEB_PASSWORD` | 启用浏览器密码登录 |
| pi-web / Node.js 路径 | — | 留空时从 `PATH` 自动探测 |

设置保存在 `%APPDATA%/Pi Web Box/settings.json`；配置写错导致无法启动时，可在启动页一键重置。日志位于 `%APPDATA%/Pi Web Box/logs/pi-web.log`。

## 开发与构建

```powershell
npm install
npm run typecheck
npm test
npm run dev      # 从源码运行
npm run dist     # 构建安装包到 dist/
```

> 打包前请先退出正在运行的 Pi Web Box，否则 Windows 会锁住 dist 中的 EXE 导致构建卡住。

## 故障排查

1. `node --version` 确认不低于 22.19.0。
2. `where pi-web` 确认 PATH 中存在 `pi-web.cmd`。
3. 重新执行 `npm install -g @agegr/pi-web@latest`。
4. 查看错误页中的「打开日志」。

Pi Web 页面里需要新标签页的功能（例如「完整历史」）会交给系统默认浏览器打开。Pi Web Box 继续使用当前用户的 pi 配置与数据，不会修改它们。
