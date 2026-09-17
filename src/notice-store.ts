/**
 * 通知消息本地存储模块。
 *
 * 背景：Pi Web 页面右上角的提示存在时间较短，容易来不及看清就消失。
 * 本模块负责把每条提示持久化到 userData 下的 SQLite 数据库（node:sqlite），
 * 供消息中心按游标倒序分页懒加载，并维护「已读水位」计算未读数。
 *
 * 设计要点：
 * - 去重只按 (sessionId, eventId) 唯一索引判断，绝不按文本去重；
 *   eventId 缺失时自动生成 UUID，因此这类消息不会互相去重。
 * - 已读水位单调递增：markRead 只前进不后退，unread = sequence > 水位的条数。
 * - 查询按 sequence DESC 倒序，limit 钳制在 1..100（默认 30），
 *   nextCursor 返回本页最后一条的 sequence，翻页传 before 即可继续向更旧的消息加载。
 * - 输入做长度与类型校验：非法输入返回 false，不写入；数据库层的异常向上抛给调用方捕获。
 * - 不实现删除与清理：消息只增不减，序列号因此稳定，可安全作为分页游标。
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { NoticeInput, NoticePage, NoticeQuery, NoticeRecord } from "./desktop-contracts.js";

/** 消息正文长度上限：超长直接拒绝（返回 false），避免异常数据撑爆数据库。 */
const MAX_MESSAGE_LENGTH = 2000;
/** 次要字段统一长度上限；拒绝超长值，不截断 ID，以免产生错误去重。 */
const MAX_FIELD_LENGTH = 200;
/** 单页默认条数。 */
const DEFAULT_PAGE_LIMIT = 30;
/** 单页最小条数。 */
const MIN_PAGE_LIMIT = 1;
/** 单页最大条数，保证懒加载每次都很轻。 */
const MAX_PAGE_LIMIT = 100;
/** 元数据表里「已读水位」的键名。 */
const READ_WATERMARK_KEY = "read_watermark";

/** 建表语句：sequence 为自增主键，天然承担倒序分页游标的职责。 */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS notices (
    sequence     INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id     TEXT NOT NULL,
    session_id   TEXT NOT NULL DEFAULT '',
    session_name TEXT NOT NULL DEFAULT '',
    message      TEXT NOT NULL,
    level        TEXT NOT NULL DEFAULT 'info',
    source       TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_notices_dedupe ON notices (session_id, event_id);
  CREATE TABLE IF NOT EXISTS notice_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

/** 数据库行结构（列名蛇形，读取后转换成契约里的驼峰字段）。 */
interface NoticeRow {
  sequence: number | bigint;
  event_id: string;
  session_id: string;
  session_name: string;
  message: string;
  level: string;
  source: string;
  created_at: number | bigint;
}

/** 单页条数钳制：非法值回退默认 30，合法值收敛到 1..100。 */
function clampLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
  const rounded = Math.floor(limit);
  if (rounded < MIN_PAGE_LIMIT) return MIN_PAGE_LIMIT;
  if (rounded > MAX_PAGE_LIMIT) return MAX_PAGE_LIMIT;
  return rounded;
}

/** 游标校验：只接受正整数，其余（含 0、负数、非数字）视为「从头开始」。 */
function normalizeCursor(before: unknown): number | undefined {
  if (typeof before !== "number" || !Number.isSafeInteger(before) || before <= 0) return undefined;
  return before;
}

/** 数据库行 → 契约记录。 */
function toRecord(row: NoticeRow): NoticeRecord {
  return {
    sequence: Number(row.sequence),
    eventId: row.event_id,
    sessionId: row.session_id,
    sessionName: row.session_name,
    message: row.message,
    level: row.level,
    source: row.source,
    createdAt: Number(row.created_at),
  };
}

export class NoticeStore {
  private readonly db: DatabaseSync;
  private closed = false;
  private readonly insertStmt;
  private readonly firstPageStmt;
  private readonly beforePageStmt;
  private readonly maxSequenceStmt;
  private readonly unreadStmt;
  private readonly getWatermarkStmt;
  private readonly setWatermarkStmt;

  constructor(filePath: string) {
    if (typeof filePath !== "string" || filePath.trim() === "") {
      throw new Error("NoticeStore 需要有效的数据库文件路径。");
    }
    // 文件库先保证父目录存在（userData 目录通常已存在，这里兜底）。
    if (filePath !== ":memory:") mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    try {
      this.db.exec(SCHEMA_SQL);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.insertStmt = this.db.prepare(
      `INSERT INTO notices (event_id, session_id, session_name, message, level, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, event_id) DO NOTHING`,
    );
    this.firstPageStmt = this.db.prepare(
      "SELECT * FROM notices ORDER BY sequence DESC LIMIT ?",
    );
    this.beforePageStmt = this.db.prepare(
      "SELECT * FROM notices WHERE sequence < ? ORDER BY sequence DESC LIMIT ?",
    );
    this.maxSequenceStmt = this.db.prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS m FROM notices",
    );
    this.unreadStmt = this.db.prepare(
      "SELECT COUNT(*) AS c FROM notices WHERE sequence > ?",
    );
    this.getWatermarkStmt = this.db.prepare(
      "SELECT value FROM notice_meta WHERE key = ?",
    );
    this.setWatermarkStmt = this.db.prepare(
      "INSERT INTO notice_meta (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value " +
      "WHERE CAST(excluded.value AS INTEGER) > CAST(notice_meta.value AS INTEGER)",
    );
  }

  /**
   * 写入一条通知。返回 true 表示新写入；返回 false 表示重复（命中
   * sessionId + eventId 唯一索引）或输入非法（message 缺失 / 空白 / 超长）。
   * 数据库层异常不在此捕获，由上层统一处理。
   */
  add(input: NoticeInput): boolean {
    this.assertOpen();
    if (!input || typeof input !== "object") return false;
    if (typeof input.message !== "string") return false;
    // 只校验非空，不改变原文内容（首尾空格保留原样）。
    if (input.message.trim() === "") return false;
    if (input.message.length > MAX_MESSAGE_LENGTH) return false;

    for (const value of [input.eventId, input.sessionId, input.sessionName, input.level, input.source]) {
      if (value !== undefined && (typeof value !== "string" || value.length > MAX_FIELD_LENGTH)) return false;
    }
    // eventId 缺失或为空白时生成 UUID；提供的有效 ID 保持原样，不合并不同 ID。
    const eventId = input.eventId?.trim() ? input.eventId : randomUUID();
    const sessionId = input.sessionId ?? "";
    const sessionName = input.sessionName ?? "";
    const level = input.level?.trim() || "info";
    const source = input.source ?? "";

    const result = this.insertStmt.run(eventId, sessionId, sessionName, input.message, level, source, Date.now());
    // 唯一索引冲突时 changes 为 0：视为重复消息，不算新增也未读。
    return Number(result.changes) > 0;
  }

  /**
   * 倒序分页查询。query.before 为上一页最后一条的 sequence（不含），
   * 缺省时从最新一页开始；返回 nextCursor 供下一页继续，翻完为 null。
   */
  query(query?: NoticeQuery): NoticePage {
    this.assertOpen();
    const limit = clampLimit(query?.limit);
    const before = normalizeCursor(query?.before);
    // 多取一条判断是否还有更旧的数据，避免多查一次 COUNT。
    const rows = (before === undefined
      ? this.firstPageStmt.all(limit + 1)
      : this.beforePageStmt.all(before, limit + 1)) as unknown as NoticeRow[];
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(toRecord);
    // 游标取本页最后一条（最旧一条）的 sequence，下一页从它的更旧侧继续。
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].sequence : null;
    return { items, nextCursor, unread: this.unreadCount() };
  }

  /**
   * 标记已读：把水位推进到 through（缺省推到最新一条）。
   * 水位只前进不后退，重复或回退调用都是空操作。
   */
  markRead(through?: number): void {
    this.assertOpen();
    // 非法水位不能意外标记全部已读；只有缺省参数表示读到最新。
    if (through !== undefined && (!Number.isSafeInteger(through) || through < 0)) return;
    const row = this.maxSequenceStmt.get() as unknown as { m: number | bigint };
    const max = Math.max(Number(row.m), 0);
    let target = max;
    if (typeof through === "number" && Number.isFinite(through)) {
      target = Math.min(Math.max(Math.floor(through), 0), max);
    }
    if (target <= this.readWatermark()) return;
    this.setWatermarkStmt.run(READ_WATERMARK_KEY, String(target));
  }

  /** 未读条数：sequence 大于已读水位的消息数。 */
  unreadCount(): number {
    this.assertOpen();
    const row = this.unreadStmt.get(this.readWatermark()) as unknown as { c: number | bigint };
    return Number(row.c);
  }

  /** 关闭数据库连接；重复调用是空操作。 */
  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  /** 已读水位：元数据表缺行时视为 0，坏值兜底为 0。 */
  private readWatermark(): number {
    const row = this.getWatermarkStmt.get(READ_WATERMARK_KEY) as unknown as { value: string } | undefined;
    const parsed = row ? Number(row.value) : 0;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("NoticeStore 已关闭，无法继续操作。");
  }
}
