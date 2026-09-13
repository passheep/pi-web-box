"use strict";

// 用量统计窗口渲染脚本：查询区间、热力图、模型明细与悬浮提示。
const api = window.piWebBox;

const el = {
  subtitle: document.getElementById("subtitle"),
  todayTokens: document.getElementById("todayTokens"),
  todayRequests: document.getElementById("todayRequests"),
  rangeTokens: document.getElementById("rangeTokens"),
  rangeCost: document.getElementById("rangeCost"),
  from: document.getElementById("from"),
  to: document.getElementById("to"),
  model: document.getElementById("model"),
  apply: document.getElementById("apply"),
  heat: document.getElementById("heat"),
  heatMonths: document.getElementById("heatMonths"),
  heatRange: document.getElementById("heatRange"),
  modelRows: document.getElementById("modelRows"),
  tip: document.getElementById("tip"),
  pluginWarn: document.getElementById("pluginWarn"),
};

function formatTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function formatCost(value) {
  const n = Number(value) || 0;
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatNumber(value) {
  return (Number(value) || 0).toLocaleString("zh-CN");
}

// ── 概览卡片 ──
function renderSummary(overview) {
  const today = overview.today || {};
  const range = overview.range || {};
  el.todayTokens.innerHTML = `${formatTokens(today.totalTokens)}<span class="u">token</span>`;
  el.todayRequests.textContent = formatNumber(today.requests);
  el.rangeTokens.innerHTML = `${formatTokens(range.totalTokens)}<span class="u">token</span>`;
  el.rangeCost.textContent = formatCost(range.cost);

  const latest = overview.lastRecordAt ? new Date(overview.lastRecordAt).toLocaleString("zh-CN") : "无记录";
  el.subtitle.textContent = `数据来自 pi 的用量日志 · 最近记录：${latest}`;
}

// ── 热力图：按周分列，每列 7 天 ──
function renderHeatmap(overview) {
  const cells = overview.heatmap || [];
  el.heat.innerHTML = "";
  el.heatMonths.innerHTML = "";
  if (!cells.length) {
    el.heatRange.textContent = "暂无数据";
    return;
  }

  // 每 7 天一组，第一列可能不足 7 天，用占位格补齐行位置。
  const weekCount = Math.ceil(cells.length / 7);
  const firstDate = new Date(`${cells[0].date}T00:00:00`);
  const firstWeekday = (firstDate.getDay() + 6) % 7; // 周一为 0

  for (let week = 0; week < weekCount; week += 1) {
    const column = document.createElement("div");
    column.className = "week";
    for (let day = 0; day < 7; day += 1) {
      const index = week * 7 + day;
      const cellData = cells[index];
      const cell = document.createElement("div");
      cell.className = "cell";
      // 第一周里属于上月的空位隐藏掉，保持日历对齐。
      if (!cellData || (week === 0 && day < firstWeekday)) {
        cell.classList.add("future");
      } else {
        cell.dataset.level = String(cellData.level);
        cell.dataset.date = cellData.date;
        cell.dataset.tokens = String(cellData.totalTokens);
        cell.dataset.cost = String(cellData.cost);
        cell.dataset.requests = String(cellData.requests);
      }
      column.appendChild(cell);
    }
    el.heat.appendChild(column);
  }

  // 月份标签：在每月第一列上方标注月份。
  let lastMonth = "";
  for (let week = 0; week < weekCount; week += 1) {
    const span = document.createElement("span");
    const index = week * 7;
    const date = cells[Math.min(index, cells.length - 1)];
    const month = date ? date.date.slice(0, 7) : "";
    const monthNumber = date ? String(Number(date.date.slice(5, 7))) : "";
    if (month && month !== lastMonth) {
      span.textContent = `${monthNumber}月`;
      lastMonth = month;
    }
    el.heatMonths.appendChild(span);
  }

  const withData = cells.filter((cell) => cell.totalTokens > 0).length;
  el.heatRange.textContent = `${cells[0].date} ~ ${cells[cells.length - 1].date} · ${withData} 天有记录`;
}

// 悬浮提示：显示日期、用量、花费与请求数。
function bindTooltip() {
  el.heat.addEventListener("mouseover", (event) => {
    const cell = event.target.closest(".cell");
    if (!cell || cell.classList.contains("future")) return;
    const tokens = Number(cell.dataset.tokens) || 0;
    const cost = Number(cell.dataset.cost) || 0;
    const requests = Number(cell.dataset.requests) || 0;
    el.tip.innerHTML = tokens > 0
      ? `<b>${cell.dataset.date}</b><br>${formatNumber(tokens)} token · ${formatCost(cost)}<br>${requests} 次请求`
      : `<b>${cell.dataset.date}</b><br>无记录`;
    el.tip.classList.add("on");
  });

  el.heat.addEventListener("mousemove", (event) => {
    const rect = el.tip.getBoundingClientRect();
    // 靠近右边缘时向左翻转，避免提示被窗口裁掉。
    const x = Math.min(event.clientX + 14, window.innerWidth - rect.width - 8);
    const y = Math.max(event.clientY - rect.height - 12, 8);
    el.tip.style.left = `${x}px`;
    el.tip.style.top = `${y}px`;
  });

  el.heat.addEventListener("mouseleave", () => el.tip.classList.remove("on"));
}

// ── 模型明细 ──
function renderModels(range) {
  const rows = range.byModel || [];
  if (!rows.length) {
    el.modelRows.innerHTML = '<tr><td colspan="5" class="empty">该区间没有数据</td></tr>';
    return;
  }
  const max = Math.max(...rows.map((row) => row.totalTokens), 1);
  el.modelRows.innerHTML = rows
    .map(
      (row) => `<tr>
        <td title="${row.model}">${row.model}</td>
        <td class="num">${formatNumber(row.totalTokens)}</td>
        <td class="num">${formatNumber(row.requests)}</td>
        <td class="num">${formatCost(row.cost)}</td>
        <td><div class="bar" style="width:${Math.max(2, Math.round((row.totalTokens / max) * 100))}%"></div></td>
      </tr>`,
    )
    .join("");
}

// ── 模型筛选下拉：从全天数据里收集模型名 ──
function fillModelOptions(overview) {
  const names = new Set();
  for (const cell of overview.heatmap || []) void cell;
  for (const row of overview.range?.byModel || []) names.add(row.model);
  const current = el.model.value;
  el.model.innerHTML = '<option value="">全部模型</option>';
  for (const name of [...names].sort()) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    el.model.appendChild(option);
  }
  if (current && names.has(current)) el.model.value = current;
}

async function load(options) {
  el.apply.disabled = true;
  const result = await api.queryUsage({
    from: el.from.value,
    to: el.to.value,
    model: el.model.value,
    includeHeatmap: !options || options.includeHeatmap !== false,
  });
  el.apply.disabled = false;
  if (!result || !result.ok) {
    el.subtitle.textContent = result?.message || "读取用量数据失败。";
    return;
  }
  const overview = result.overview;
  renderSummary(overview);
  renderHeatmap(overview);
  renderModels(overview.range);
  fillModelOptions(overview);

  // 数据源缺失时给出安装提示，避免用户以为是软件坏了。
  if (!overview.logExists) {
    el.pluginWarn.hidden = false;
    el.pluginWarn.innerHTML =
      "<b>尚未检测到用量日志。</b><br>请在「Box 设置 → 外观与行为」中安装「Token 用量记录」插件，并在 pi 中重新加载扩展后开始记录。";
  } else {
    el.pluginWarn.hidden = true;
  }
}

// 快捷区间按钮
for (const button of document.querySelectorAll(".quick button")) {
  button.addEventListener("click", () => {
    const days = Number(button.dataset.days) || 30;
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - (days - 1));
    const iso = (date) => date.toLocaleDateString("sv-SE");
    el.from.value = iso(from);
    el.to.value = iso(to);
    void load({ includeHeatmap: false });
  });
}

el.apply.addEventListener("click", () => void load({ includeHeatmap: false }));
el.model.addEventListener("change", () => void load({ includeHeatmap: false }));

bindTooltip();
void load({ includeHeatmap: true });

// 主题变化时同步窗口配色。
api.onSettingsTheme(({ palette }) => {
  const root = document.documentElement;
  root.style.setProperty("--bg", palette.background);
  root.style.setProperty("--bg-panel", palette.panel);
  root.style.setProperty("--border", palette.border);
  root.style.setProperty("--text", palette.text);
  root.style.setProperty("--text-muted", palette.textMuted);
  root.style.setProperty("--accent", palette.accent);
  root.dataset.theme = palette.id;
});
