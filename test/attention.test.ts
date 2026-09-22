/**
 * attention 的单元测试。
 *
 * 覆盖两层：
 * - describeAttention：通知文案的拼装与截断（纯函数）；
 * - AttentionController：待回答弹窗的去重、撤销与提醒通道选择。
 * 控制器不依赖 Electron，窗口 / 托盘 / 通知全部用桩函数替换。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  AttentionController,
  describeAttention,
  isAttentionMethod,
  type AttentionDeps,
  type AttentionRequest,
} from "../src/attention.js";

function request(overrides: Partial<AttentionRequest> = {}): AttentionRequest {
  return {
    tabId: "1",
    sessionId: "s1",
    requestId: "r1",
    method: "select",
    title: "选哪个方案？",
    message: "",
    optionCount: 3,
    ...overrides,
  };
}

function harness(initial: { focused?: boolean; visible?: boolean; enabled?: boolean } = {}) {
  const state = { focused: initial.focused ?? false, visible: initial.visible ?? true, enabled: initial.enabled ?? true };
  const calls: string[] = [];
  const notices: Array<{ sessionId: string; title: string; body: string }> = [];
  const logs: string[] = [];
  const deps: AttentionDeps = {
    enabled: () => state.enabled,
    isFocused: () => state.focused,
    isVisible: () => state.visible,
    flash: (active) => calls.push(`flash:${active}`),
    setTrayAttention: (active) => calls.push(`tray:${active}`),
    notify: (notice) => notices.push(notice),
    sessionName: (id) => (id === "s1" ? "重构会话" : ""),
    log: (message) => logs.push(message),
  };
  return { state, calls, notices, logs, deps, controller: new AttentionController(deps) };
}

test("isAttentionMethod 只认需要用户回答的扩展弹窗方法", () => {
  for (const method of ["select", "confirm", "input", "editor", "custom"]) {
    assert.equal(isAttentionMethod(method), true, method);
  }
  for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "", undefined, 7]) {
    assert.equal(isAttentionMethod(method), false, String(method));
  }
});

test("describeAttention 带会话名、选项数与 confirm 的 message", () => {
  assert.deepEqual(describeAttention(request(), "重构会话"), {
    sessionId: "s1",
    title: "重构会话 · 需要你的回答",
    body: "选哪个方案？（3 个选项）",
  });
  // 会话名未知时不拼前缀，仍然能看出是 Pi Web Box 在等人回答。
  assert.equal(describeAttention(request(), "").title, "Pi Web Box · 需要你的回答");
  // confirm 的问题正文在 message 里，title 只是弹窗标题，两者都在时以 message 为准。
  assert.deepEqual(
    describeAttention(request({ method: "confirm", title: "确认", message: "确认删除这条记录吗？", optionCount: 0 }), "重构会话"),
    { sessionId: "s1", title: "重构会话 · 需要你的回答", body: "确认删除这条记录吗？" },
  );
  assert.deepEqual(
    describeAttention(request({ method: "confirm", title: "", message: "确认删除吗？", optionCount: 0 }), "重构会话"),
    { sessionId: "s1", title: "重构会话 · 需要你的回答", body: "确认删除吗？" },
  );
  // 选项数只对 select 有意义。
  assert.equal(describeAttention(request({ method: "input", optionCount: 5 }), "").body, "选哪个方案？");
});

test("describeAttention 只取标题首行，超长正文截断", () => {
  const multiline = request({
    title: "[数据库] 用哪个方案？\n\n--- 1. A 预览 ---\n细节\n--- 2. B 预览 ---",
  });
  // select 的 title 后面会跟整块预览正文，通知只取首行的那一问。
  assert.equal(describeAttention(multiline, "").body, "[数据库] 用哪个方案？（3 个选项）");
  const long = describeAttention(request({ title: "问".repeat(300) }), "").body;
  // 截断只作用于问题正文，尾部的选项数提示完整保留。
  assert.equal(long, `${"问".repeat(120)}…（3 个选项）`);
  // 完全没有正文（custom 面板）时回落到通用文案。
  assert.equal(
    describeAttention(request({ method: "custom", title: "", message: "", optionCount: 0 }), "").body,
    "有扩展弹窗正在等待你的回答。",
  );
});

test("窗口在后台时新弹窗同时触发任务栏闪烁与系统通知", () => {
  const h = harness({ focused: false, visible: true });
  h.controller.raise(request());
  assert.deepEqual(h.calls, ["flash:true"]);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].title, "重构会话 · 需要你的回答");
  assert.equal(h.controller.count, 1);
});

test("窗口隐藏到托盘时改为闪烁托盘图标", () => {
  const h = harness({ focused: false, visible: false });
  h.controller.raise(request());
  assert.deepEqual(h.calls, ["tray:true"]);
  assert.equal(h.notices.length, 1);
  // 窗口重新显示后交还给任务栏闪烁（先开任务栏、再关托盘）。
  h.state.visible = true;
  h.controller.refresh();
  assert.deepEqual(h.calls, ["tray:true", "flash:true", "tray:false"]);
});

test("窗口在前台时不打扰，切走后立刻接上提醒", () => {
  const h = harness({ focused: true, visible: true });
  h.controller.raise(request());
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.notices, []);
  assert.equal(h.controller.count, 1);
  h.state.focused = false;
  h.controller.refresh();
  assert.deepEqual(h.calls, ["flash:true"]);
  // 前台期间只记录状态，不再补发历史通知，避免切走时被旧消息轰炸。
  assert.deepEqual(h.notices, []);
});

test("同一弹窗重复上报只提醒一次，多个弹窗全部关闭才停止闪烁", () => {
  const h = harness({ focused: false, visible: true });
  h.controller.raise(request());
  h.controller.raise(request({ title: "重绘后的同一弹窗" }));
  assert.equal(h.notices.length, 1);
  assert.equal(h.controller.count, 1);
  h.controller.raise(request({ requestId: "r2", title: "第二个问题" }));
  assert.equal(h.notices.length, 2);
  assert.deepEqual(h.calls, ["flash:true"]); // 闪烁状态不重复下发
  h.controller.resolve("1", "r1");
  assert.deepEqual(h.calls, ["flash:true"]);
  h.controller.resolve("1", "r2");
  assert.deepEqual(h.calls, ["flash:true", "flash:false"]);
  assert.equal(h.controller.count, 0);
  // 撤销不存在的弹窗不改变任何状态。
  h.controller.resolve("1", "r2");
  assert.deepEqual(h.calls, ["flash:true", "flash:false"]);
});

test("页面重载或标签关闭时整批撤销该标签的等待状态", () => {
  const h = harness({ focused: false, visible: true });
  h.controller.raise(request({ tabId: "1", requestId: "r1" }));
  h.controller.raise(request({ tabId: "1", requestId: "r2" }));
  h.controller.raise(request({ tabId: "2", requestId: "r3" }));
  h.controller.clearTab("1");
  assert.equal(h.controller.count, 1);
  assert.deepEqual(h.calls, ["flash:true"]); // 另一个标签仍在等待，闪烁继续
  h.controller.clearTab("2");
  assert.deepEqual(h.calls, ["flash:true", "flash:false"]);
  h.controller.clearTab("2");
  assert.deepEqual(h.calls, ["flash:true", "flash:false"]);
});

test("窗口获得焦点即清空全部提醒并停止闪烁", () => {
  const h = harness({ focused: false, visible: true });
  h.controller.raise(request());
  h.controller.clearAll();
  assert.deepEqual(h.calls, ["flash:true", "flash:false"]);
  assert.equal(h.controller.count, 0);
  // 焦点事件可能重复到达，不应产生多余的闪烁切换。
  h.controller.clearAll();
  assert.deepEqual(h.calls, ["flash:true", "flash:false"]);
});

test("关闭设置开关后不提醒，重新打开立刻恢复", () => {
  const h = harness({ focused: false, visible: true, enabled: false });
  h.controller.raise(request());
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.notices, []);
  assert.equal(h.controller.count, 0);
  // 重新打开开关后，新弹窗照常提醒。
  h.state.enabled = true;
  h.controller.raise(request());
  assert.deepEqual(h.calls, ["flash:true"]);
  assert.equal(h.notices.length, 1);
  // 开关在提醒期间被关掉：立即停止闪烁，不清空等待状态。
  h.state.enabled = false;
  h.controller.refresh();
  assert.deepEqual(h.calls, ["flash:true", "flash:false"]);
  assert.equal(h.controller.count, 1);
});

test("闪烁回调抛错只记录日志，不影响后续弹窗处理", () => {
  const h = harness({ focused: false, visible: true });
  h.deps.flash = () => { throw new Error("窗口已销毁"); };
  assert.doesNotThrow(() => h.controller.raise(request()));
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /任务栏闪烁/);
  assert.equal(h.controller.count, 1);
  // 托盘回调同样只记日志，不阻断状态更新。
  const tray = harness({ focused: false, visible: false });
  tray.deps.setTrayAttention = () => { throw new Error("托盘不可用"); };
  assert.doesNotThrow(() => tray.controller.raise(request()));
  assert.equal(tray.logs.length, 1);
  assert.match(tray.logs[0], /托盘闪烁/);
  assert.equal(tray.controller.count, 1);
});