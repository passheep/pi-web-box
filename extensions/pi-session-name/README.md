# pi-session-name

为 pi 的新 Session 自动生成带日期的名称。

示例：

```text
20260821-开发会话自动命名插件
20260821-修复登录接口异常
```

## 功能

- 新建空白 Session 后，在提交第一条普通用户消息时异步调用 LLM 自动命名，不阻塞主会话请求。
- 命名请求使用**配置文件里指定的模型**（`~/.pi/agent/pi-session-name.json`），不跟随当前会话所选模型；未配置模型、模型不存在或无认证时直接使用备用名称。
- 配置由 Pi Web Box 的「Box 设置 → 会话命名」写入，本扩展每次命名前重新读取，**改完即刻生效，不需要 `/reload`**：
  - `enabled`：是否启用自动命名；关闭后不自动命名（`/session-name rename` 手动命令仍可用）。
  - `provider` / `model`：命名使用的供应商与模型标识（来自 pi 的 `models.json`）。
- 命名请求关闭思考（`reasoning.effort = "none"`），命名更快更省 token。
- 日期使用 Session 创建时的本地日期，格式固定为 `YYYYMMDD-标题`；标题后缀最多 30 个字符，简洁高效。
- 恢复已有 Session、执行 `/reload` 时不会重复自动命名。
- LLM 命名请求设置独立的 20 秒超时并关闭自动重试；命名失败只使用备用名称，不影响主 Agent。
- 命名生命周期会异步写入 `~/.pi/agent/pi-session-name.log`，记录请求开始、结束、取消、错误、停止原因和名称应用结果；可通过环境变量 `PI_SESSION_NAME_LOG_FILE` 指定其他路径。日志不记录 API Key。
- 命名请求完成后立即写入 Session 名称；如果主 Agent 仍在运行，名称也会先更新，不再等待主回复结束。
- 主回复结束时，`agent_settled` 会等待尚未完成的命名请求，超时后使用备用名称，再让 pi-web 刷新右上角 Session 信息。
- 等待上限为 15 秒；超时、LLM 不可用或生成失败时，使用 `YYYYMMDD-新对话` 作为备用名称，避免会话一直处于未结束状态。
- 命名应用后通过通知显示结果。
- 支持命令：
  - `/session-name`：查看当前名称。
  - `/session-name rename`：立即返回并在后台根据当前分支的用户和助手文本调用 LLM 重新命名；名称生成完成后立即应用。

## 配置

配置文件位于 pi 的 agent 目录（可用 `PI_CODING_AGENT_DIR` 覆盖），可用环境变量 `PI_SESSION_NAME_CONFIG_FILE` 指定其它路径：

```json
{
  "enabled": true,
  "provider": "cc-switch-deep-seek",
  "model": "deepseek-flash"
}
```

文件缺失或内容损坏时，使用内置默认配置（`enabled: true` + 上面的供应商与模型），与历史行为一致。

## 安装

由 Pi Web Box 的「Box 设置 → 会话命名 → 安装」一键复制到：

```text
C:/Users/<用户名>/.pi/agent/extensions/pi-session-name
```

也可以手动把整个目录复制到该位置；pi 会从全局扩展目录自动发现 `index.ts`。安装后在 pi 中执行：

```text
/reload
```

## 测试

```powershell
node --test index.test.ts
```
