import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// pi-usage-log 写入的日志格式（与 PiDeck 解析器兼容的 10/11 字段数组）：
// [ts, sid, cwd, "provider/model", input, output, cacheRead, cacheWrite, totalTokens, cost, costKnown]
export type UsageRecord = {
  timestamp: number;
  sessionId: string;
  cwd: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
};

export type UsageDay = {
  date: string;
  totalTokens: number;
  cost: number;
  requests: number;
};

export type UsageModelSummary = {
  model: string;
  totalTokens: number;
  cost: number;
  requests: number;
  // 模型维度的分项用量，供明细表展示输入/输出/命中与命中率。
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheHitRate: number;
};

export type UsageSummary = {
  // 统计区间（本地日期，YYYY-MM-DD）。
  from: string;
  to: string;
  totalTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  requests: number;
  // 缓存读取量占输入侧总量的比例，用于展示缓存收益。
  cacheHitRate: number;
  byModel: UsageModelSummary[];
  byDay: UsageDay[];
};

export type UsageHeatCell = {
  date: string;
  totalTokens: number;
  cost: number;
  requests: number;
  // 0 表示无数据，1~4 表示由浅到深，用于热力图配色。
  level: number;
};

export type UsageOverview = {
  today: UsageSummary;
  range: UsageSummary;
  // 最近一年（含今天）的每日用量，按日期升序，空缺日期补 0。
  heatmap: UsageHeatCell[];
  // 生成热力图时使用的分位阈值，便于界面说明深浅含义。
  thresholds: number[];
  logFilePath: string;
  logExists: boolean;
  // 最近一次记录时间，用于提示数据是否还在更新。
  lastRecordAt: number | null;
};

/** usage.jsonl 的路径，跟随 pi 配置目录（PI_CODING_AGENT_DIR 可覆盖）。 */
export function usageLogPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "analytics", "usage.jsonl");
}

/** 本地日期字符串。用本地时区而不是 UTC，否则凌晨的记录会算到前一天。 */
export function toLocalDate(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 解析一行记录，格式不符时返回 null，不影响其余数据。 */
export function parseUsageLine(line: string): UsageRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let row: unknown;
  try {
    row = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(row) || row.length < 9) return null;
  const timestamp = Number(row[0]);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const modelField = String(row[3] ?? "");
  // 模型字段形如 provider/model，provider 中不含斜杠，按第一个斜杠切分。
  const slash = modelField.indexOf("/");
  const provider = slash > 0 ? modelField.slice(0, slash) : modelField;
  const model = slash > 0 ? modelField.slice(slash + 1) : modelField;
  return {
    timestamp,
    sessionId: String(row[1] ?? ""),
    cwd: String(row[2] ?? ""),
    provider,
    model,
    input: Number(row[4]) || 0,
    output: Number(row[5]) || 0,
    cacheRead: Number(row[6]) || 0,
    cacheWrite: Number(row[7]) || 0,
    totalTokens: Number(row[8]) || 0,
    cost: Number(row[9]) || 0,
  };
}

/** 读取全部用量记录。文件不存在或读取失败时返回空数组，不影响界面。 */
export function readUsageRecords(file: string = usageLogPath()): UsageRecord[] {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const records: UsageRecord[] = [];
  for (const line of content.split(/\r?\n/)) {
    const record = parseUsageLine(line);
    if (record) records.push(record);
  }
  return records;
}

function emptySummary(from: string, to: string): UsageSummary {
  return {
    from,
    to,
    totalTokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    requests: 0,
    cacheHitRate: 0,
    byModel: [],
    byDay: [],
  };
}

/** 按日期区间聚合记录，区间为闭区间（本地日期）。 */
export function summarizeUsage(records: UsageRecord[], from: string, to: string): UsageSummary {
  const summary = emptySummary(from, to);
  const models = new Map<string, UsageModelSummary>();
  const days = new Map<string, UsageDay>();

  for (const record of records) {
    const date = toLocalDate(record.timestamp);
    if (date < from || date > to) continue;
    summary.totalTokens += record.totalTokens;
    summary.input += record.input;
    summary.output += record.output;
    summary.cacheRead += record.cacheRead;
    summary.cacheWrite += record.cacheWrite;
    summary.cost += record.cost;
    summary.requests += 1;

    const modelKey = record.model || "未识别";
    const modelEntry = models.get(modelKey) ?? {
      model: modelKey, totalTokens: 0, cost: 0, requests: 0,
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheHitRate: 0,
    };
    modelEntry.totalTokens += record.totalTokens;
    modelEntry.cost += record.cost;
    modelEntry.requests += 1;
    modelEntry.input += record.input;
    modelEntry.output += record.output;
    modelEntry.cacheRead += record.cacheRead;
    modelEntry.cacheWrite += record.cacheWrite;
    models.set(modelKey, modelEntry);

    const dayEntry = days.get(date) ?? { date, totalTokens: 0, cost: 0, requests: 0 };
    dayEntry.totalTokens += record.totalTokens;
    dayEntry.cost += record.cost;
    dayEntry.requests += 1;
    days.set(date, dayEntry);
  }

  // 缓存命中率的分母用输入侧总量，与常见口径一致。
  const inputSide = summary.input + summary.cacheRead + summary.cacheWrite;
  summary.cacheHitRate = inputSide > 0 ? summary.cacheRead / inputSide : 0;
  // 每个模型单独算一次命中率，口径与总量保持一致。
  for (const entry of models.values()) {
    const modelInputSide = entry.input + entry.cacheRead + entry.cacheWrite;
    entry.cacheHitRate = modelInputSide > 0 ? entry.cacheRead / modelInputSide : 0;
  }
  summary.byModel = [...models.values()].sort((left, right) => right.totalTokens - left.totalTokens);
  summary.byDay = [...days.values()].sort((left, right) => left.date.localeCompare(right.date));
  return summary;
}

/** 把用量值映射到 0~4 的深浅等级，用四分位避免个别超大值把其余格子压扁。 */
export function buildHeatLevels(values: number[]): { levels: number[]; thresholds: number[] } {
  const positive = values.filter((value) => value > 0).sort((left, right) => left - right);
  if (positive.length === 0) {
    return { levels: values.map(() => 0), thresholds: [] };
  }
  const quantile = (ratio: number) => {
    const index = Math.min(positive.length - 1, Math.max(0, Math.floor((positive.length - 1) * ratio)));
    return positive[index];
  };
  const thresholds = [quantile(0.25), quantile(0.5), quantile(0.75)];
  const levels = values.map((value) => {
    if (value <= 0) return 0;
    if (value <= thresholds[0]) return 1;
    if (value <= thresholds[1]) return 2;
    if (value <= thresholds[2]) return 3;
    return 4;
  });
  return { levels, thresholds };
}

/**
 * 生成从今天往前一整年的热力图数据，缺失日期补 0。
 * 起点对齐到周起始（周一），保证每一列是完整的一周。
 */
export function buildHeatmap(records: UsageRecord[], today: Date = new Date()): { cells: UsageHeatCell[]; thresholds: number[] } {
  const byDate = new Map<string, UsageDay>();
  for (const record of records) {
    const date = toLocalDate(record.timestamp);
    const entry = byDate.get(date) ?? { date, totalTokens: 0, cost: 0, requests: 0 };
    entry.totalTokens += record.totalTokens;
    entry.cost += record.cost;
    entry.requests += 1;
    byDate.set(date, entry);
  }

  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const start = new Date(end);
  start.setDate(start.getDate() - 364);
  // 向前对齐到周一（getDay 中 0 是周日）。
  const weekday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - weekday);

  const dates: string[] = [];
  const values: number[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const date = toLocalDate(cursor.getTime());
    dates.push(date);
    values.push(byDate.get(date)?.totalTokens ?? 0);
  }

  const { levels, thresholds } = buildHeatLevels(values);
  const cells: UsageHeatCell[] = dates.map((date, index) => {
    const entry = byDate.get(date);
    return {
      date,
      totalTokens: entry?.totalTokens ?? 0,
      cost: entry?.cost ?? 0,
      requests: entry?.requests ?? 0,
      level: levels[index],
    };
  });
  return { cells, thresholds };
}

/** 组装界面需要的完整用量概览：今日、区间明细与一年热力图。 */
export function buildUsageOverview(
  records: UsageRecord[],
  options: { from: string; to: string; today?: Date; logFile?: string },
): UsageOverview {
  const todayDate = options.today ?? new Date();
  const today = toLocalDate(todayDate.getTime());
  const heatmap = buildHeatmap(records, todayDate);
  return {
    today: summarizeUsage(records, today, today),
    range: summarizeUsage(records, options.from, options.to),
    heatmap: heatmap.cells,
    thresholds: heatmap.thresholds,
    logFilePath: options.logFile ?? usageLogPath(),
    logExists: fs.existsSync(options.logFile ?? usageLogPath()),
    lastRecordAt: records.length > 0 ? Math.max(...records.map((record) => record.timestamp)) : null,
  };
}
