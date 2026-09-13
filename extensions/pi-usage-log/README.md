# pi-usage-log

pi 全局扩展：恢复本地用量日志（`usage.jsonl`）的写入，让 PiDeck「设置 → 用量统计」页面恢复显示新数据。

## 背景

pi 从 **0.84.3** 起移除了本地用量日志 `~/.pi/agent/analytics/usage.jsonl` 的写入逻辑，
导致 PiDeck 用量统计页数据停更（只显示 0.84.2 及更早写入的记录）。
PiDeck 的读取端正常工作，只是数据源不再产生数据。本扩展补上写入端。

## 行为

- 监听 `message_end` 事件，只处理 assistant 消息；
- 按 PiDeck 解析器兼容格式追加一行 JSON 数组（10/11 字段）：

  ```text
  [ts, sid, cwd, "provider/model", input, output, cacheRead, cacheWrite, totalTokens, cost, costKnown]
  ```

- `sid` 取当前会话文件路径，临时会话记为 `ephemeral`；
- 总 token 为 0 的空回复（中止/出错）不记录；
- 进程内按 `ts|sid|model` 去重，与 PiDeck 解析器一致；
- 写日志失败静默忽略，绝不影响会话正常运行。

## 安装

放在全局自动发现目录：

```text
C:\Users\<用户名>\.pi\agent\extensions\pi-usage-log\
```

目录中包含 `index.ts` 与 `package.json`。保存后执行 `/reload` 或重启 pi / PiDeck。

## 验证

1. 重启 PiDeck 并正常对话一轮；
2. 打开「设置 → 用量统计」，应能看到今天的新记录；
3. 或直接查看 `~/.pi/agent/analytics/usage.jsonl` 文件末尾行时间戳是否为当前时间。

## 测试

```bash
cd C:/000Program/pi/pi-usage-log
npm test
```
