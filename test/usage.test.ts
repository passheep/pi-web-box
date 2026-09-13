import test from "node:test";
import assert from "node:assert/strict";
import { buildUsageOverview, buildHeatLevels, parseUsageLine, summarizeUsage, toLocalDate } from "../src/usage.js";

// 构造一条记录：字段顺序与 pi-usage-log 写入的格式一致。
const line = (ts: number, model: string, input: number, output: number, cacheRead: number, cost: number) =>
  JSON.stringify([ts, "sid-1", "C:\\work", model, input, output, cacheRead, 0, input + output + cacheRead, cost, cost > 0 ? 1 : 0]);

test("parseUsageLine reads the pi-usage-log format", () => {
  const record = parseUsageLine(line(Date.UTC(2026, 8, 10, 4, 0, 0), "sui-xiang/gpt-5.6-terra", 100, 50, 200, 0.5));
  assert.ok(record);
  assert.equal(record.provider, "sui-xiang");
  assert.equal(record.model, "gpt-5.6-terra");
  assert.equal(record.input, 100);
  assert.equal(record.output, 50);
  assert.equal(record.cacheRead, 200);
  assert.equal(record.totalTokens, 350);
  assert.equal(record.cost, 0.5);
});

test("parseUsageLine rejects malformed rows instead of throwing", () => {
  assert.equal(parseUsageLine(""), null);
  assert.equal(parseUsageLine("not json"), null);
  assert.equal(parseUsageLine("{}"), null);
  // 字段不足时跳过，避免统计里混入脏数据。
  assert.equal(parseUsageLine(JSON.stringify([1, 2, 3])), null);
  // 时间戳无效同样跳过。
  assert.equal(parseUsageLine(JSON.stringify([0, "s", "c", "m", 1, 2, 3, 4, 5, 0, 0])), null);
});

test("toLocalDate formats dates in local time", () => {
  // 用本地时间构造，避免时区差异导致断言不稳定。
  const local = new Date(2026, 8, 10, 23, 30).getTime();
  assert.equal(toLocalDate(local), "2026-09-10");
});

test("summarizeUsage aggregates within the inclusive range only", () => {
  const records = [
    parseUsageLine(line(new Date(2026, 8, 8, 10).getTime(), "p/a", 10, 10, 0, 1))!,
    parseUsageLine(line(new Date(2026, 8, 9, 10).getTime(), "p/a", 20, 20, 0, 2))!,
    parseUsageLine(line(new Date(2026, 8, 9, 12).getTime(), "p/b", 30, 30, 30, 3))!,
    // 区间外，不应计入
    parseUsageLine(line(new Date(2026, 8, 20, 10).getTime(), "p/a", 99, 99, 0, 9))!,
  ];
  const summary = summarizeUsage(records, "2026-09-08", "2026-09-09");
  assert.equal(summary.requests, 3);
  assert.equal(summary.input, 60);
  assert.equal(summary.cost, 6);
  assert.equal(summary.byModel.length, 2);
  // 按总量降序：a = 20 + 40 = 60，b = 90，所以 b 排在前面
  assert.deepEqual(summary.byModel.map((item) => item.model), ["b", "a"]);
  assert.equal(summary.byModel[0].totalTokens, 90);
  assert.equal(summary.byModel[1].totalTokens, 60);
  assert.equal(summary.byDay.length, 2);
});

test("cacheHitRate reflects cache reads against the input side", () => {
  const records = [parseUsageLine(line(new Date(2026, 8, 9, 10).getTime(), "p/a", 100, 10, 300, 0))!];
  const summary = summarizeUsage(records, "2026-09-09", "2026-09-09");
  // 命中率 = cacheRead / (input + cacheRead + cacheWrite) = 300 / 400
  assert.equal(summary.cacheHitRate, 0.75);
});

test("buildHeatLevels buckets values into four levels", () => {
  const { levels, thresholds } = buildHeatLevels([0, 10, 20, 30, 40, 1000]);
  assert.equal(levels[0], 0);
  assert.equal(thresholds.length, 3);
  // 最大值必须落在最深一级
  assert.equal(levels[levels.length - 1], 4);
  // 非零值不应该停留在 level 0
  for (let index = 1; index < levels.length; index += 1) {
    assert.ok(levels[index] >= 1);
  }
});

test("buildHeatLevels handles an all-empty dataset", () => {
  const { levels, thresholds } = buildHeatLevels([0, 0, 0]);
  assert.deepEqual(levels, [0, 0, 0]);
  assert.deepEqual(thresholds, []);
});

test("buildUsageOverview produces a full year of heatmap cells", () => {
  const today = new Date(2026, 8, 13);
  // 一条记录：input 10 + output 10 = 20 token
  const records = [parseUsageLine(line(new Date(2026, 8, 13, 10).getTime(), "p/a", 10, 10, 0, 1))!];
  const overview = buildUsageOverview(records, {
    from: "2026-08-15",
    to: "2026-09-13",
    today,
    logFile: "nonexistent-file-for-test",
  });
  // 一年份格子，起点对齐到周一，所以是 364~370 天之间。
  assert.ok(overview.heatmap.length >= 365 && overview.heatmap.length <= 371);
  // 最后一天必须是今天
  assert.equal(overview.heatmap[overview.heatmap.length - 1].date, "2026-09-13");
  // 今天的用量应落在最后一天：input 10 + output 10 = 20
  assert.equal(overview.heatmap[overview.heatmap.length - 1].totalTokens, 20);
  assert.equal(overview.today.totalTokens, 20);
  // 文件不存在时要如实反馈，便于界面提示安装插件
  assert.equal(overview.logExists, false);
});

test("heatmap fills gaps with zero-value cells", () => {
  const today = new Date(2026, 8, 13);
  const overview = buildUsageOverview([], { from: "2026-09-01", to: "2026-09-13", today, logFile: "nope" });
  assert.ok(overview.heatmap.every((cell) => cell.level === 0 && cell.totalTokens === 0));
  assert.equal(overview.lastRecordAt, null);
});
