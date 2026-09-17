/**
 * notice-store 的单元测试。
 *
 * 约定（本次任务约束）：
 * - 大部分用例使用内存库 ':memory:'，速度快且互不影响；
 * - 覆盖持久化路径的用例使用 os.tmpdir() 下的明确临时目录，测试结束后
 *   只关闭连接，不删除任何临时文件（遵守「测试只能创建临时文件不能删除」的约定）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { NoticeStore } from "../src/notice-store.js";
import type { NoticeInput } from "../src/desktop-contracts.js";

/** 构造一条合法输入，便于用例按需覆盖字段。 */
function notice(overrides: Partial<NoticeInput> = {}): NoticeInput {
  return { message: "hello", ...overrides };
}

/** 在系统临时目录下创建独立的持久化数据库（测试结束后不清理）。 */
function tempStore(tag: string): { store: NoticeStore; dbPath: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), `pi-web-box-notice-${tag}-`));
  const dbPath = path.join(dir, "notices.db");
  return { store: new NoticeStore(dbPath), dbPath };
}

test("新增通知返回 true，查询按 sequence 倒序返回", () => {
  const store = new NoticeStore(":memory:");
  try {
    assert.equal(store.add(notice({ message: "第一条" })), true);
    assert.equal(store.add(notice({ message: "第二条" })), true);
    const page = store.query();
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0].message, "第二条");
    assert.equal(page.items[1].message, "第一条");
    assert.ok(page.items[0].sequence > page.items[1].sequence);
    // 新写入且未 markRead 时，全部计为未读。
    assert.equal(page.unread, 2);
    assert.equal(page.nextCursor, null);
  } finally {
    store.close();
  }
});

test("默认 limit 为 30，nextCursor 指向本页最旧一条", () => {
  const store = new NoticeStore(":memory:");
  try {
    for (let i = 1; i <= 35; i += 1) store.add(notice({ message: `m${i}` }));
    const page = store.query();
    assert.equal(page.items.length, 30);
    assert.equal(page.items[0].message, "m35");
    assert.equal(page.items[29].message, "m6");
    assert.equal(page.nextCursor, page.items[29].sequence);
    // 用游标翻第二页：剩余 5 条，翻完返回 null。
    const next = store.query({ before: page.nextCursor! });
    assert.equal(next.items.length, 5);
    assert.equal(next.items[0].message, "m5");
    assert.equal(next.items[4].message, "m1");
    assert.equal(next.nextCursor, null);
  } finally {
    store.close();
  }
});

test("limit 钳制到 1..100，非法值回退默认 30", () => {
  const store = new NoticeStore(":memory:");
  try {
    for (let i = 1; i <= 120; i += 1) store.add(notice({ message: `m${i}` }));
    assert.equal(store.query({ limit: 0 }).items.length, 1);
    assert.equal(store.query({ limit: -5 }).items.length, 1);
    assert.equal(store.query({ limit: 101 }).items.length, 100);
    assert.equal(store.query({ limit: 5 }).items.length, 5);
    assert.equal(store.query({ limit: Number.NaN }).items.length, 30);
    assert.equal(store.query({ limit: 2.9 }).items.length, 2);
    assert.equal(store.query().items.length, 30);
  } finally {
    store.close();
  }
});

test("before 只接受正整数游标，非法或 0 时从头开始", () => {
  const store = new NoticeStore(":memory:");
  try {
    for (let i = 1; i <= 5; i += 1) store.add(notice({ message: `m${i}` }));
    assert.equal(store.query({ before: 0 }).items.length, 5);
    assert.equal(store.query({ before: -3 }).items.length, 5);
    assert.equal(store.query({ before: Number.NaN }).items.length, 5);
    // 合法游标：sequence < 4 的只有 1..3。
    assert.deepEqual(store.query({ before: 4 }).items.map((r) => r.sequence), [3, 2, 1]);
  } finally {
    store.close();
  }
});

test("sessionId + eventId 相同去重，返回 false", () => {
  const store = new NoticeStore(":memory:");
  try {
    assert.equal(store.add(notice({ sessionId: "s1", eventId: "e1", message: "第一次" })), true);
    assert.equal(store.add(notice({ sessionId: "s1", eventId: "e1", message: "重复" })), false);
    // 文本相同但 eventId 不同：不按文本去重，两条都写入。
    assert.equal(store.add(notice({ sessionId: "s1", eventId: "e2", message: "第一次" })), true);
    // 不同会话同 eventId 也都写入。
    assert.equal(store.add(notice({ sessionId: "s2", eventId: "e1", message: "别的会话" })), true);
    assert.equal(store.query().items.length, 3);
  } finally {
    store.close();
  }
});

test("eventId 缺失时自动生成 UUID，不会互相去重", () => {
  const store = new NoticeStore(":memory:");
  try {
    assert.equal(store.add(notice({ message: "同文本" })), true);
    assert.equal(store.add(notice({ message: "同文本" })), true);
    // eventId 为空白字符串同样视为缺失。
    assert.equal(store.add(notice({ message: "同文本三", eventId: "   " })), true);
    const page = store.query();
    assert.equal(page.items.length, 3);
    for (const record of page.items) {
      assert.equal(record.eventId.length, 36);
      assert.ok(/^[0-9a-f-]{36}$/.test(record.eventId));
    }
  } finally {
    store.close();
  }
});

test("message 非法输入返回 false 且不写入", () => {
  const store = new NoticeStore(":memory:");
  try {
    assert.equal(store.add(notice({ message: "" })), false);
    assert.equal(store.add(notice({ message: "   " })), false);
    // message 非字符串视为非法。
    assert.equal(store.add({ message: 42 as unknown as string }), false);
    assert.equal(store.add(undefined as unknown as NoticeInput), false);
    assert.equal(store.add(null as unknown as NoticeInput), false);
    assert.equal(store.query().items.length, 0);
    assert.equal(store.unreadCount(), 0);
  } finally {
    store.close();
  }
});

test("message 和次要字段超长拒绝，避免截断 ID 造成错误去重", () => {
  const store = new NoticeStore(":memory:");
  try {
    assert.equal(store.add(notice({ message: "长".repeat(2001) })), false);
    assert.equal(store.query().items.length, 0);
    for (const field of ["sessionId", "sessionName", "eventId", "level", "source"]) {
      assert.equal(store.add(notice({ [field]: "x".repeat(201) })), false);
      assert.equal(store.add(notice({ [field]: 42 })), false);
    }
    assert.equal(store.add(notice({ message: "长".repeat(2000), eventId: "x".repeat(200) })), true);
    assert.equal(store.query().items.length, 1);
  } finally {
    store.close();
  }
});

test("level 缺省为 info，source 缺省为空字符串", () => {
  const store = new NoticeStore(":memory:");
  try {
    assert.equal(store.add(notice()), true);
    const record = store.query().items[0];
    assert.equal(record.level, "info");
    assert.equal(record.source, "");
    assert.equal(record.sessionId, "");
    assert.equal(record.sessionName, "");
    // createdAt 是毫秒时间戳，取一个宽松区间防时区/时钟问题。
    assert.ok(Math.abs(record.createdAt - Date.now()) < 60_000);
  } finally {
    store.close();
  }
});

test("markRead 推进已读水位，unread 相应减少", () => {
  const store = new NoticeStore(":memory:");
  try {
    for (let i = 1; i <= 4; i += 1) store.add(notice({ message: `m${i}` }));
    assert.equal(store.unreadCount(), 4);
    // 记下第二条的 sequence，只读到那里。
    const second = store.query({ limit: 4 }).items[2].sequence;
    store.markRead(second);
    assert.equal(store.unreadCount(), 2);
    // 重复标记是空操作，不回退。
    store.markRead(second);
    assert.equal(store.unreadCount(), 2);
    // markRead() 缺省推到最新。
    store.markRead();
    assert.equal(store.unreadCount(), 0);
    // 之后新消息再次计为未读。
    store.add(notice({ message: "新消息" }));
    assert.equal(store.unreadCount(), 1);
  } finally {
    store.close();
  }
});

test("markRead 忽略非法参数与回退值", () => {
  const store = new NoticeStore(":memory:");
  try {
    store.add(notice());
    const seq = store.query().items[0].sequence;
    store.markRead(seq);
    assert.equal(store.unreadCount(), 0);
    // 回退值不生效。
    store.markRead(seq - 10);
    assert.equal(store.unreadCount(), 0);
    store.add(notice({ message: "保持未读" }));
    // 非法参数不改变水位，避免误将新消息全部标为已读。
    for (const value of [Number.NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      store.markRead(value);
      assert.equal(store.unreadCount(), 1);
    }
    store.markRead(Number.MAX_SAFE_INTEGER);
    assert.equal(store.unreadCount(), 0);
    store.add(notice());
    assert.equal(store.unreadCount(), 1);
  } finally {
    store.close();
  }
});

test("query 的 unread 与 unreadCount 一致，且翻页时保持一致", () => {
  const store = new NoticeStore(":memory:");
  try {
    for (let i = 1; i <= 35; i += 1) store.add(notice({ message: `m${i}` }));
    store.markRead();
    assert.equal(store.unreadCount(), 0);
    const first = store.query({ limit: 30 });
    assert.equal(first.unread, 0);
    const second = store.query({ before: first.nextCursor!, limit: 30 });
    assert.equal(second.unread, 0);
    // 期间来了一条新消息：两页查询都能看到相同的最新未读数。
    store.add(notice({ message: "插队" }));
    assert.equal(store.query({ before: second.nextCursor! }).unread, 1);
  } finally {
    store.close();
  }
});

test("持久化：文件库关闭后重开数据仍在，水位与 sequence 延续", () => {
  const { store, dbPath } = tempStore("persist");
  store.add(notice({ sessionId: "s1", eventId: "e1", message: "落盘一" }));
  store.add(notice({ sessionId: "s1", eventId: "e2", message: "落盘二" }));
  const seq = store.query().items[0].sequence;
  store.markRead(seq);
  store.close();
  // 重新打开同一个文件：记录、去重、水位、sequence 都延续。
  const reopened = new NoticeStore(dbPath);
  try {
    const page = reopened.query();
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0].message, "落盘二");
    assert.equal(page.unread, 0);
    // 老的 eventId 依然去重。
    assert.equal(reopened.add(notice({ sessionId: "s1", eventId: "e1", message: "重开后再来一条重复" })), false);
    // sequence 延续（不会重置为 1），新消息游标更大。
    assert.equal(reopened.add(notice({ sessionId: "s1", eventId: "e3", message: "落盘三" })), true);
    assert.ok(reopened.query().items[0].sequence > seq);
  } finally {
    reopened.close();
  }
});

test("重建实例后 sequence 从 1 开始（新库行为），互不影响", () => {
  const { store } = tempStore("fresh");
  try {
    store.add(notice({ message: "新库第一条" }));
    assert.equal(store.query().items[0].sequence, 1);
  } finally {
    store.close();
  }
});

test("close 后再操作抛错，重复 close 为空操作", () => {
  const store = new NoticeStore(":memory:");
  store.add(notice());
  store.close();
  assert.throws(() => store.add(notice()), /已关闭/);
  assert.throws(() => store.query(), /已关闭/);
  assert.throws(() => store.markRead(), /已关闭/);
  assert.throws(() => store.unreadCount(), /已关闭/);
  // 重复 close 不抛错。
  store.close();
});

test("构造函数：非法路径参数直接抛错", () => {
  assert.throws(() => new NoticeStore(""), /有效的数据库文件路径/);
  assert.throws(() => new NoticeStore("   "), /有效的数据库文件路径/);
});

test("构造函数自动创建缺失的父目录", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-web-box-notice-mkdir-"));
  const nested = path.join(dir, "a", "b", "notices.db");
  const store = new NoticeStore(nested);
  try {
    assert.equal(store.add(notice({ message: "嵌套目录" })), true);
    assert.equal(store.query().items.length, 1);
  } finally {
    store.close();
  }
});
