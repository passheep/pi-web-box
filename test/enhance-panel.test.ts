import test from "node:test";
import assert from "node:assert/strict";
import { buildEnhancePanelScript } from "../src/enhance-panel.js";
import { THEME_PALETTES } from "../src/themes.js";

/** 构造一份最简的控件数据，用于检查生成的脚本内容。 */
function buildScript(): string {
  return buildEnhancePanelScript({
    palette: THEME_PALETTES.light,
    configured: true,
    scenes: [
      { id: "general", label: "通用" },
      { id: "coding", label: "编程" },
    ],
    defaultScene: "general",
    titleConfigured: true,
    titleModelLabel: "magpie/workbuddy2api/Deepseek-V4.1-Flash",
  });
}

test("enhance panel script is syntactically valid", () => {
  assert.doesNotThrow(() => new Function(buildScript()));
});

test("enhance panel renders the scene selector and enhance button", () => {
  const script = buildScript();
  assert.match(script, /id="scene"/);
  assert.match(script, /id="enhance"/);
  assert.match(script, /id="toBottom"/);
  assert.match(script, /通用/);
  assert.match(script, /编程/);
});

// 保存设置会重复注入控件；用 getElementById 只能删掉第一个，
// 残留的旧控件会让按钮在同一行里越堆越多。
test("enhance panel removes every stale instance before mounting", () => {
  const script = buildScript();
  assert.match(script, /querySelectorAll\("#pi-web-box-enhance"\)/);
  assert.doesNotMatch(script, /getElementById\("pi-web-box-enhance"\)\?\.remove\(\)/);
});

test("enhance panel keeps the back-to-bottom button hidden until it can scroll", () => {
  const script = buildScript();
  // 找不到滚动容器时必须隐藏按钮，避免出现按不动的悬浮球。
  assert.match(script, /if \(!scroller\) \{/);
  assert.match(script, /toBottom\.classList\.remove\("show", "has-new"\)/);
});

// 「生成标题」按钮紧跟「增强」，点击后调主进程完成命名并浮出结果提示。
test("enhance panel renders the title button next to the enhance button", () => {
  const script = buildScript();
  assert.match(script, /id="title"/);
  assert.match(script, /生成标题/);
  assert.match(script, /window\.piWebBox\.generateSessionTitle\(\)/);
  assert.match(script, /id="toast"/);
  // 按钮顺序：先增强、后生成标题（同一行相邻）。
  assert.ok(script.indexOf('id="enhance"') < script.indexOf('id="title"'));
  // 未配置命名模型时给出可读提示，而不是静默失败。
  assert.match(script, /尚未在 Box 设置的「会话命名」中选择命名模型/);
});

test("enhance panel shows the configured naming model in the tooltip data", () => {
  const script = buildScript();
  assert.match(script, /magpie\/workbuddy2api\/Deepseek-V4\.1-Flash/);
});

/** 只实现 findToolbarRow 用到的那部分 DOM，避免为了锚点测试引入 jsdom。 */
class FakeElement {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;

  constructor(tagName: string, attributes: Record<string, string> = {}) {
    this.tagName = tagName.toUpperCase();
    for (const [name, value] of Object.entries(attributes)) this.attributes.set(name, value);
  }

  append(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  closest(selector: string): FakeElement | null {
    let node: FakeElement | null = this;
    while (node) {
      const classes = (node.attributes.get("class") ?? "").split(/\s+/);
      if (selector.startsWith(".") && classes.includes(selector.slice(1))) return node;
      node = node.parentElement;
    }
    return null;
  }
}

function fakeDocument(root: FakeElement) {
  const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap((child) => all(child))];
  const matches = (node: FakeElement, selector: string): boolean => {
    const classes = (node.attributes.get("class") ?? "").split(/\s+/);
    const isListboxButton = node.tagName === "BUTTON" && node.attributes.get("aria-haspopup") === "listbox";
    switch (selector) {
      case '.model-selector button[aria-haspopup="listbox"]':
        return isListboxButton && !!node.closest(".model-selector");
      case 'button[aria-haspopup="listbox"]':
        return isListboxButton;
      case ".chat-input-controls":
        return classes.includes("chat-input-controls");
      case "button":
        return node.tagName === "BUTTON";
      default:
        throw new Error(`fakeDocument: unsupported selector ${selector}`);
    }
  };
  return {
    querySelector: (selector: string) => all(root).find((node) => matches(node, selector)) ?? null,
    querySelectorAll: (selector: string) => all(root).filter((node) => matches(node, selector)),
  };
}

/** 把注入脚本里的 findToolbarRow 单独取出来，喂几种真实 pi-web 的 DOM 结构。 */
function extractFindToolbarRow(): (document: unknown) => () => unknown {
  const script = buildScript();
  const definition = script.match(/const findToolbarRow = \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(definition, "注入脚本应包含 findToolbarRow");
  return new Function("document", `${definition[0]}\nreturn findToolbarRow;`) as (
    document: unknown,
  ) => () => unknown;
}

/**
 * 构造输入区。withModelSelector=false 模拟 pi-web「没有可用模型」时不渲染
 * 模型按钮；withControls=false 模拟 0.13 及更早版本（只有英文 title 可用）。
 */
function fakeToolbar(options: {
  title?: string;
  withModelSelector?: boolean;
  withControls?: boolean;
  emptyControls?: boolean;
}): { root: FakeElement; row: FakeElement; document: ReturnType<typeof fakeDocument> } {
  const { title = "", withModelSelector = true, withControls = true, emptyControls = false } = options;
  const root = new FakeElement("body");
  const controls = root.append(
    new FakeElement("div", { class: withControls ? "chat-input-controls" : "legacy-controls" }),
  );
  const row = emptyControls
    ? controls
    : controls.append(new FakeElement("div", { id: "toolbar", class: "group" }));
  if (withModelSelector) {
    const selector = row.append(new FakeElement("div", { class: "model-selector" }));
    selector.append(new FakeElement("button", { "aria-haspopup": "listbox", title }));
  } else if (title) {
    const group = row.append(new FakeElement("div", { class: "group" }));
    group.append(new FakeElement("button", { title }));
  }
  return { root, row, document: fakeDocument(root) };
}

// pi-web 0.14 起模型按钮的 title 会本地化，且切换中/禁用/无模型时还会变成别的文案。
// 旧实现只认 "Change model"，中文界面下整个控件会被 visibility:hidden 藏起来。
test("enhance panel finds the toolbar by DOM structure regardless of locale", () => {
  const createFinder = extractFindToolbarRow();
  for (const title of [
    "Change model",
    "更换模型",
    "更換模型",
    "正在切换模型",
    "没有可用模型",
    "some-model-name",
  ]) {
    const { row, document } = fakeToolbar({ title });
    assert.equal(createFinder(document)(), row, `title=${title} 时应归位到输入区左组`);
  }
});

test("enhance panel falls back to .chat-input-controls when the model button is absent", () => {
  const createFinder = extractFindToolbarRow();
  const { row, document } = fakeToolbar({ withModelSelector: false });
  assert.equal(createFinder(document)(), row, "无模型按钮时应挂到 .chat-input-controls 的第一组");
});

test("enhance panel still supports the legacy English title anchor", () => {
  const createFinder = extractFindToolbarRow();
  const { row, document } = fakeToolbar({
    title: "Change model",
    withModelSelector: false,
    withControls: false,
  });
  assert.equal(createFinder(document)(), row, "早期 pi-web 只有英文 title 可用");
});

test("enhance panel keeps the host hidden until an anchor exists", () => {
  const createFinder = extractFindToolbarRow();
  const { document } = fakeToolbar({ withModelSelector: false, emptyControls: true });
  assert.equal(createFinder(document)(), null, "没有可用锚点时应返回 null，由 placePanel 隐藏控件");
});