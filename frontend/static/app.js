const ORANGE = "#ff7900";
const BLACK = "#000000";
const GRAY = "#8f8f8f";
const LIGHT = "#dedede";
const GREEN = "#009845"; // Qlik-style "selected" green

const FIELDS = ["event_type", "region", "plan", "city", "tower", "subscriber"];
const FIELD_LABELS = { event_type: "Usage", region: "Region", plan: "Plan", city: "City", tower: "Tower", subscriber: "Subscriber" };
const FIELD_EMPTY = { event_type: "All services", region: "All regions", plan: "All plans", city: "All cities", tower: "All towers", subscriber: "All subscribers" };
const BOOKMARK_KEY = "oeg-bookmarks-v1";
const ALERT_KEY = "oeg-alerts-v1";
const SERIES_COLORS = [ORANGE, BLACK, GRAY, "#4bb4e6", "#50be87", "#ffd200", "#a885d8"];
const chartHits = new Map();
const eCharts = new Map();

const state = {
  view: "overview",
  network: null, customers: null, filters: null, cross: null, catalog: null, system: null,
  crossConfig: { dimension: "region", splitBy: "event_type", metric: "events", limit: 10, chartType: "bar", drillPath: "", drillLevel: 0 },
  compareA: null, compareData: null,     // pinned state A + its fetched payloads
  sel: emptySelection(),
  past: [], future: [],                  // selection history (back / forward)
  sort: { towers: { key: "event_count", dir: -1 }, subs: { key: "event_count", dir: -1 } },
  towerQuery: "", subscriberQuery: "",
  openField: null,
  dynamicValues: { tower: [], subscriber: [] },
  dynamicQuery: { tower: "", subscriber: "" },
  requestId: 0,
};

function emptySelection() {
  return { dateFrom: "", dateTo: "", granularity: "hour",
           event_type: [], region: [], plan: [], city: [], tower: [], subscriber: [] };
}
const cloneSel = (sel) => JSON.parse(JSON.stringify(sel));
const selectionsEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "—").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[char]);
}

function formatNumber(value, decimals = 0) {
  const number = Number(value ?? 0);
  return new Intl.NumberFormat("en-EG", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals && number < 100 ? decimals : 0
  }).format(number);
}

function compact(value) {
  return new Intl.NumberFormat("en-EG", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value ?? 0));
}

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC"
  }).format(new Date(value));
}

/* ── Selection engine ─────────────────────────────────────────── */

function paramsFor(sel) {
  const params = new URLSearchParams();
  if (sel.dateFrom) params.set("date_from", sel.dateFrom);
  if (sel.dateTo) params.set("date_to", sel.dateTo);
  if (sel.granularity !== "hour") params.set("granularity", sel.granularity);
  FIELDS.forEach((field) => { if (sel[field].length) params.set(field, sel[field].join(",")); });
  return params;
}

function crossParamsFor(sel) {
  const params = paramsFor(sel);
  params.set("dimension", state.crossConfig.dimension);
  if (state.crossConfig.splitBy) params.set("split_by", state.crossConfig.splitBy);
  params.set("metric", state.crossConfig.metric);
  params.set("limit", String(state.crossConfig.limit));
  return params;
}

function commit(mutate) {
  state.past.push(cloneSel(state.sel));
  if (state.past.length > 60) state.past.shift();
  state.future = [];
  mutate(state.sel);
  loadData();
}

function toggleValue(field, value) {
  commit((sel) => {
    const index = sel[field].indexOf(value);
    if (index >= 0) sel[field].splice(index, 1); else sel[field].push(value);
  });
}

function historyBack() {
  if (!state.past.length) return;
  state.future.push(cloneSel(state.sel));
  state.sel = state.past.pop();
  loadData();
}

function historyForward() {
  if (!state.future.length) return;
  state.past.push(cloneSel(state.sel));
  state.sel = state.future.pop();
  loadData();
}

/* ── Data loading ─────────────────────────────────────────────── */

async function fetchJson(path, params) {
  const response = await fetch(`${path}?${params}`, { headers: { Accept: "application/json" } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function loadData() {
  // Last-write-wins: rapid successive selections each fetch; only the newest
  // request is allowed to render, so charts never show a stale state.
  const requestId = ++state.requestId;
  document.body.classList.add("loading");
  $("#errorBanner").hidden = true;
  try {
    const params = paramsFor(state.sel);
    const jobs = [
      fetchJson("/api/network", params),
      fetchJson("/api/customers", params),
      fetchJson("/api/filters", params),
      fetchJson("/api/cross", crossParamsFor(state.sel)),
      fetchJson("/api/catalog", new URLSearchParams()),
      fetchJson("/api/system", new URLSearchParams()),
    ];
    if (state.compareA) {
      const paramsA = paramsFor(state.compareA);
      jobs.push(fetchJson("/api/network", paramsA), fetchJson("/api/customers", paramsA));
    }
    const [network, customers, filters, cross, catalog, system, compareNetwork, compareCustomers] = await Promise.all(jobs);
    if (requestId !== state.requestId) return;
    state.network = network;
    state.customers = customers;
    state.filters = filters;
    state.cross = cross;
    state.catalog = catalog;
    state.system = system;
    state.compareData = state.compareA ? { network: compareNetwork, customers: compareCustomers } : null;
    renderAll();
    const updated = new Date(network.generated_at);
    $("#updatedAt").textContent = `Updated ${updated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    $("#pipelineStatus").textContent = "Pipeline live";
    $("#footerState").textContent = `Live warehouse · cache ${formatNumber(system.cache.hit_rate_pct, 1)}%`;
    evaluateAlerts();
  } catch (error) {
    if (requestId !== state.requestId) return;
    $("#errorBanner").textContent = error.message;
    $("#errorBanner").hidden = false;
    $("#pipelineStatus").textContent = "Connection issue";
    $("#footerState").textContent = "Check services";
  } finally {
    if (requestId === state.requestId) document.body.classList.remove("loading");
  }
}

/* ── KPIs ─────────────────────────────────────────────────────── */

function kpiCard(label, value, note, dark = false) {
  return `<article class="kpi-card${dark ? " dark" : ""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`;
}

function renderKpis() {
  const n = state.network.kpis;
  const c = state.customers.kpis;
  $("#overviewKpis").innerHTML = [
    kpiCard("Total events", compact(n.total_events), "Validated usage", true),
    kpiCard("Data traffic", `${formatNumber(n.data_gb, 2)} GB`, "Upload + download"),
    kpiCard("Voice", `${formatNumber(n.voice_minutes, 1)} min`, "Carried duration"),
    kpiCard("SMS", compact(n.sms_messages), "Messages carried"),
    kpiCard("Active towers", formatNumber(n.active_towers), "With selected traffic"),
    kpiCard("Quality", `${formatNumber(n.quarantine_rate_pct, 2)}%`, "Quarantine rate")
  ].join("");
  $("#networkKpis").innerHTML = [
    kpiCard("Usage events", compact(n.total_events), "Current selection", true),
    kpiCard("Data", `${formatNumber(n.data_gb, 2)} GB`, "Network traffic"),
    kpiCard("Voice", `${formatNumber(n.voice_minutes, 1)} min`, "Completed calls"),
    kpiCard("SMS", compact(n.sms_messages), "Messages"),
    kpiCard("Towers", formatNumber(n.active_towers), "Active footprint"),
    kpiCard("Subscribers", compact(n.active_subscribers), "Active in period")
  ].join("");
  $("#customerKpis").innerHTML = [
    kpiCard("Subscribers", formatNumber(c.total_subscribers), "Selected base", true),
    kpiCard("Active", formatNumber(c.active_subscribers), "Current status"),
    kpiCard("Average data", `${formatNumber(c.avg_data_mb, 2)} MB`, "Per active user"),
    kpiCard("Average voice", `${formatNumber(c.avg_voice_minutes, 2)} min`, "Per active user")
  ].join("");
  $("#qualityKpis").innerHTML = [
    kpiCard("Quarantine rate", `${formatNumber(n.quarantine_rate_pct, 2)}%`, "Target below 5%", true),
    kpiCard("Raw rows", formatNumber(n.raw_rows), "Latest hour"),
    kpiCard("Fact rows", formatNumber(n.fact_rows), "Accepted records"),
    kpiCard("Latest run", formatDate(n.latest_interval), "UTC")
  ].join("");
  $("#heroEvents").textContent = compact(n.total_events);
  $("#heroQuality").textContent = `${formatNumber(n.quarantine_rate_pct, 2)}%`;
  $("#heroSubscribers").textContent = compact(c.active_subscribers);
}

/* ── Canvas helpers ───────────────────────────────────────────── */

function chartFor(element) {
  if (!window.echarts) throw new Error("Apache ECharts failed to load");
  let chart = eCharts.get(element.id);
  if (!chart) {
    chart = window.echarts.init(element, null, { renderer: "canvas", useDirtyRect: true });
    eCharts.set(element.id, chart);
  }
  return chart;
}

function analyticsToolbox(name, zoom = false) {
  const feature = {
    dataView: { readOnly: true, title: "View data" },
    restore: { title: "Reset view" },
    saveAsImage: { name: `orange-egypt-${name}`, title: "Save image", pixelRatio: 2 },
  };
  if (zoom) feature.dataZoom = { title: { zoom: "Zoom", back: "Undo zoom" } };
  return { show: true, right: 4, top: 0, itemSize: 16, feature };
}

function applyChart(element, option, onClick) {
  const chart = chartFor(element);
  chart.off("click");
  if (onClick) chart.on("click", onClick);
  chart.setOption({
    animationDuration: 380,
    animationDurationUpdate: 260,
    color: SERIES_COLORS,
    textStyle: { fontFamily: "Arial, Helvetica, sans-serif", color: "#333" },
    aria: { enabled: true, decal: { show: true } },
    ...option,
  }, { notMerge: true, lazyUpdate: true });
  return chart;
}

function axisTooltip(formatter) {
  return {
    trigger: "axis", renderMode: "richText", confine: true,
    backgroundColor: "#000", borderColor: ORANGE, borderWidth: 2,
    textStyle: { color: "#fff" }, valueFormatter: (value) => formatter(Number(value)),
    axisPointer: { type: "shadow", label: { backgroundColor: ORANGE, color: "#000" } },
  };
}

function setupCanvas(canvas) {
  // canvas.height updates the HTML height attribute. Preserve the authored
  // logical height once so high-DPI redraws never grow the chart repeatedly.
  if (!canvas.dataset.chartHeight) {
    canvas.dataset.chartHeight = String(Number(canvas.getAttribute("height")) || 280);
  }
  const cssHeight = Number(canvas.dataset.chartHeight);
  const width = Math.max(300, canvas.clientWidth);
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = width * ratio;
  canvas.height = cssHeight * ratio;
  canvas.style.height = `${cssHeight}px`;
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, cssHeight);
  return { context, width, height: cssHeight };
}

function drawGrid(context, width, height, padding, lines = 4) {
  context.strokeStyle = "#e4e4e4";
  context.lineWidth = 1;
  for (let i = 0; i <= lines; i += 1) {
    const y = padding.top + ((height - padding.top - padding.bottom) * i / lines);
    context.beginPath(); context.moveTo(padding.left, y); context.lineTo(width - padding.right, y); context.stroke();
  }
}

function shortAxisLabel(label) {
  const parsed = new Date(label);
  if (Number.isNaN(parsed.getTime())) return String(label ?? "");
  return parsed.toLocaleString("en-GB", { day: "2-digit", hour: "2-digit", timeZone: "UTC" });
}

function categoryAxisLabel(label, maxChars) {
  const text = String(label ?? "");
  return text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1))}…` : text;
}

function drawLineChart(canvas, labels, series, colors, formatter = compact, dashedIndexes = new Set()) {
  const zoom = labels.length > 12;
  applyChart(canvas, {
    color: colors, toolbox: analyticsToolbox(canvas.id, true), tooltip: axisTooltip(formatter),
    legend: { top: 2, left: 4, data: series.map((item) => item.name) },
    grid: { left: 58, right: 24, top: 54, bottom: zoom ? 76 : 46, containLabel: true },
    xAxis: { type: "category", data: labels.map(shortAxisLabel), boundaryGap: false,
      axisLabel: { hideOverlap: true, color: "#666" }, axisLine: { lineStyle: { color: "#aaa" } } },
    yAxis: { type: "value", axisLabel: { formatter, color: "#666" }, splitLine: { lineStyle: { color: "#e5e5e5" } } },
    dataZoom: zoom ? [{ type: "inside" }, { type: "slider", height: 20, bottom: 8 }] : [],
    series: series.map((item, index) => ({
      name: item.name || `Series ${index + 1}`, type: "line", data: item.values.map(Number),
      symbol: "circle", symbolSize: 7, showSymbol: labels.length < 50,
      lineStyle: { width: index === 0 ? 3 : 2, type: dashedIndexes.has(index) ? "dashed" : "solid" },
      emphasis: { focus: "series" },
    })),
  }, (params) => {
    const item = series[params.seriesIndex];
    if (item?.filterField && item.filterValue) toggleValue(item.filterField, item.filterValue);
  });
}

function drawHorizontalBarChart(canvas, rows, labelKey, valueKey, color = ORANGE, formatter = compact, options = {}) {
  const data = rows || [];
  const labels = data.map((row) => String(row[labelKey] ?? "—"));
  applyChart(canvas, {
    color: [color], toolbox: analyticsToolbox(canvas.id), tooltip: axisTooltip(formatter),
    grid: { left: 18, right: 42, top: 42, bottom: 12, containLabel: true },
    xAxis: { type: "value", axisLabel: { formatter }, splitLine: { lineStyle: { color: "#e5e5e5" } } },
    yAxis: { type: "category", inverse: true, data: labels, axisLabel: { width: 110, overflow: "truncate", color: "#333" } },
    series: [{ name: options.seriesName || "Value", type: "bar", data: data.map((row) => Number(row[valueKey] || 0)),
      showBackground: true, backgroundStyle: { color: "#f1f1f1" },
      label: { show: true, position: "right", formatter: (params) => formatter(params.value), fontWeight: 700 },
      itemStyle: { color }, emphasis: { itemStyle: { color: GREEN } } }],
  }, (params) => {
    const selected = String(data[params.dataIndex]?.[labelKey] ?? params.name);
    if (options.onSelect) options.onSelect(selected);
    else if (options.filterField) toggleValue(options.filterField, selected);
  });
}

function drawGroupedBarChart(canvas, labels, series, colors, formatter = compact, options = {}) {
  const zoom = labels.length > 8;
  const chartType = options.chartType === "line" ? "line" : "bar";
  applyChart(canvas, {
    color: colors, toolbox: analyticsToolbox(canvas.id, true), tooltip: axisTooltip(formatter),
    legend: { top: 2, left: 4, type: "scroll", data: series.map((item) => item.name) },
    grid: { left: 55, right: 24, top: 58, bottom: zoom ? 80 : 48, containLabel: true },
    xAxis: { type: "category", data: labels, axisLabel: { hideOverlap: true, interval: 0,
      rotate: labels.length > 8 ? 28 : 0, formatter: (value) => categoryAxisLabel(value, 14) } },
    yAxis: { type: "value", axisLabel: { formatter }, splitLine: { lineStyle: { color: "#e5e5e5" } } },
    dataZoom: zoom ? [{ type: "inside" }, { type: "slider", height: 20, bottom: 5 }] : [],
    series: series.map((item) => ({ name: item.name, type: chartType, data: item.values.map(Number),
      stack: options.stack ? "total" : undefined, smooth: chartType === "line", symbolSize: 7,
      emphasis: { focus: "series" } })),
  }, (params) => {
    const item = series[params.seriesIndex];
    const selected = String(labels[params.dataIndex] ?? params.name);
    if (options.onSelect) options.onSelect(selected);
    else if (options.labelField) toggleValue(options.labelField, selected);
    else if (item?.filterField && item.filterValue) toggleValue(item.filterField, item.filterValue);
  });
}

function drawPieChart(element, rows, labelKey, valueKey, formatter = compact, options = {}) {
  const data = (rows || []).map((row) => ({ name: String(row[labelKey]), value: Number(row[valueKey] || 0) }));
  applyChart(element, {
    toolbox: analyticsToolbox(element.id),
    tooltip: { trigger: "item", renderMode: "richText", valueFormatter: formatter, confine: true },
    legend: { type: "scroll", orient: "vertical", right: 4, top: 42, bottom: 10 },
    series: [{ name: options.seriesName || "Value", type: "pie", radius: ["38%", "72%"], center: ["42%", "54%"],
      selectedMode: "multiple", label: { formatter: "{b}\n{d}%" }, data,
      emphasis: { scaleSize: 8, itemStyle: { shadowBlur: 12, shadowColor: "rgba(0,0,0,.25)" } } }],
  }, (params) => {
    if (options.onSelect) options.onSelect(params.name);
    else if (options.filterField) toggleValue(options.filterField, params.name);
  });
}

/* ── Charts ───────────────────────────────────────────────────── */

function renderTrafficChart() {
  const rows = state.network.traffic_trend;
  const labels = [...new Set(rows.map((row) => row.hour_utc))];
  const types = ["data", "voice", "sms"];
  const series = types.map((type) => ({
    name: type,
    filterField: "event_type",
    filterValue: type,
    values: labels.map((hour) => Number(rows.find((row) => row.hour_utc === hour && row.event_type === type)?.event_count || 0))
  }));
  const colors = [ORANGE, BLACK, GRAY];
  const dashed = new Set();
  if (state.compareData) {
    // Overlay pinned state A as a dashed total line for visual comparison.
    const rowsA = state.compareData.network.traffic_trend;
    series.push({
      name: "A total",
      values: labels.map((hour) => rowsA
        .filter((row) => row.hour_utc === hour)
        .reduce((sum, row) => sum + Number(row.event_count), 0))
    });
    colors.push(GREEN);
    dashed.add(series.length - 1);
  }
  drawLineChart($("#trafficChart"), labels, series, colors, compact, dashed);
  $$(".granularity-toggle button").forEach((button) =>
    button.classList.toggle("active", button.dataset.granularity === state.sel.granularity));
}

let mixSlices = [];

function renderMixChart() {
  const rows = state.network.service_mix;
  const total = rows.reduce((sum, row) => sum + Number(row.event_count), 0) || 1;
  const colors = { data: ORANGE, voice: BLACK, sms: GRAY };
  applyChart($("#mixChart"), {
    color: rows.map((row) => colors[row.event_type] || LIGHT),
    toolbox: analyticsToolbox("service-mix"),
    tooltip: { trigger: "item", renderMode: "richText", confine: true, valueFormatter: compact },
    legend: { show: false },
    graphic: [{ type: "text", left: "center", top: "44%", style: { text: compact(total), font: "900 28px Arial", fill: BLACK, textAlign: "center" } },
      { type: "text", left: "center", top: "56%", style: { text: "EVENTS", font: "700 11px Arial", fill: "#666", textAlign: "center" } }],
    series: [{ name: "Service mix", type: "pie", radius: ["48%", "76%"], center: ["50%", "50%"],
      selectedMode: "multiple", data: rows.map((row) => ({ name: row.event_type, value: Number(row.event_count), selected: state.sel.event_type.includes(row.event_type) })),
      label: { formatter: "{b}\n{d}%" }, emphasis: { scaleSize: 8 } }],
  }, (params) => toggleValue("event_type", params.name));
  $("#mixLegend").innerHTML = rows.map((row) => `<button class="mix-item${state.sel.event_type.includes(row.event_type) ? " selected" : ""}" data-select-type="${escapeHtml(row.event_type)}"><i style="background:${colors[row.event_type] || LIGHT}"></i>${escapeHtml(row.event_type)} ${formatNumber(Number(row.event_count) / total * 100, 1)}%</button>`).join("");
}

function mixChartClick(event) {
  const canvas = $("#mixChart");
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left - rect.width / 2;
  const y = event.clientY - rect.top - rect.height / 2;
  const distance = Math.hypot(x, y);
  const radius = Math.min(rect.width, rect.height) * .33;
  if (distance < radius * .56 || distance > radius + 10) return;
  let angle = Math.atan2(y, x);
  if (angle < -Math.PI / 2) angle += Math.PI * 2;
  const slice = mixSlices.find((item) => angle >= item.from && angle < item.to);
  if (slice) toggleValue("event_type", slice.type);
}

/* Selectable bar lists: values render from the associative filter panel so
   excluded values stay visible (grey) — Qlik's green/white/grey states. */
function renderSelectableBars(target, field, rowsByValue, valueKey) {
  const fieldValues = state.filters.fields[field];
  const max = Math.max(...fieldValues.map((item) => Number(rowsByValue[item.value]?.[valueKey] ?? item.event_count)), 1);
  $(target).innerHTML = fieldValues.map((item) => {
    const metric = Number(rowsByValue[item.value]?.[valueKey] ?? (item.possible ? item.event_count : 0));
    const stateClass = item.selected ? " selected" : (item.possible ? "" : " excluded");
    return `<button class="bar-row selectable${stateClass}" data-field="${field}" data-value="${escapeHtml(item.value)}">
      <span>${escapeHtml(item.value)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${metric / max * 100}%"></div></div>
      <strong>${escapeHtml(compact(metric))}</strong></button>`;
  }).join("");
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function renderHeatmap() {
  const rows = state.network.heatmap || [];
  const lookup = {};
  rows.forEach((row) => { lookup[`${row.day_of_week}-${row.hour_of_day}`] = Number(row.event_count); });
  const max = Math.max(...rows.map((row) => Number(row.event_count)), 1);
  let html = '<div class="heatmap-row heatmap-head"><span class="heatmap-label"></span>';
  for (let hour = 0; hour < 24; hour += 1) html += `<span class="heatmap-hour">${hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}</span>`;
  html += "</div>";
  WEEKDAYS.forEach((day, index) => {
    html += `<div class="heatmap-row"><span class="heatmap-label">${day}</span>`;
    for (let hour = 0; hour < 24; hour += 1) {
      const value = lookup[`${index + 1}-${hour}`] || 0;
      const intensity = value / max;
      html += `<span class="heatmap-cell" style="background:rgba(255,121,0,${(intensity * .92 + (value ? .08 : 0)).toFixed(3)})" title="${day} ${String(hour).padStart(2, "0")}:00 UTC — ${formatNumber(value)} events"></span>`;
    }
    html += "</div>";
  });
  $("#heatmap").innerHTML = html;
}

function renderMap() {
  const towers = state.network.towers;
  const canvas = $("#towerMap");
  const { context, width, height } = setupCanvas(canvas);
  const hits = [];
  context.fillStyle = "#080808"; context.fillRect(0, 0, width, height);
  context.strokeStyle = "#292929"; context.lineWidth = 1;
  for (let x = 0; x <= width; x += width / 8) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke(); }
  for (let y = 0; y <= height; y += height / 5) { context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke(); }
  if (!towers.length) return;
  const lats = towers.map((tower) => Number(tower.latitude)); const lons = towers.map((tower) => Number(tower.longitude));
  const minLat = Math.min(...lats); const maxLat = Math.max(...lats); const minLon = Math.min(...lons); const maxLon = Math.max(...lons);
  const maxEvents = Math.max(...towers.map((tower) => Number(tower.event_count)), 1);
  towers.forEach((tower) => {
    const x = 24 + ((Number(tower.longitude) - minLon) / Math.max(maxLon - minLon, .001)) * (width - 48);
    const y = height - 24 - ((Number(tower.latitude) - minLat) / Math.max(maxLat - minLat, .001)) * (height - 48);
    const intensity = Number(tower.event_count) / maxEvents;
    const radius = 2.5 + intensity * 7;
    context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = `rgba(255,121,0,${.28 + intensity * .72})`; context.fill();
    hits.push({ shape: "point", x, y, radius: Math.max(radius, 7), label: tower.cell_tower_id,
      series: tower.region, formatted: `${formatNumber(tower.event_count)} events`,
      field: "tower", filterValue: tower.cell_tower_id });
  });
  context.fillStyle = "rgba(255,255,255,.72)"; context.font = "bold 12px Arial"; context.fillText("EGYPT TOWER FOOTPRINT", 18, 24);
  chartHits.set(canvas.id, hits);
  canvas.classList.add("is-interactive");
}

function renderTopTowers() {
  drawHorizontalBarChart(
    $("#topTowerChart"),
    (state.network.top_towers || []).slice(0, 10),
    "cell_tower_id",
    "event_count",
    ORANGE,
    compact,
    { seriesName: "Usage events", filterField: "tower" }
  );
}

function renderRegionalData() {
  const rows = [...(state.network.regions || [])].sort((a, b) => Number(b.data_gb) - Number(a.data_gb));
  drawHorizontalBarChart($("#regionDataChart"), rows, "region", "data_gb", ORANGE,
    (value) => `${formatNumber(value, 2)} GB`, { seriesName: "Data traffic", filterField: "region" });
}

function renderPlanData() {
  drawHorizontalBarChart(
    $("#planDataChart"),
    state.customers.plan_data || [],
    "plan_type",
    "avg_mb_per_subscriber",
    ORANGE,
    (value) => `${formatNumber(value, 1)} MB`,
    { seriesName: "Average data", filterField: "plan" }
  );
}

function renderCityActivity() {
  const rows = state.customers.cities || [];
  drawGroupedBarChart(
    $("#cityActivityChart"),
    rows.map((row) => row.city),
    [
      { name: "Active", values: rows.map((row) => row.active_subscribers) },
      { name: "Total", values: rows.map((row) => row.subscriber_count) },
    ],
    [ORANGE, BLACK],
    compact,
    { labelField: "city" }
  );
}

function renderTopSubscribers() {
  drawHorizontalBarChart(
    $("#topSubscriberChart"),
    (state.customers.top_subscribers || []).slice(0, 10),
    "subscriber_id",
    "event_count",
    ORANGE,
    compact,
    { seriesName: "Usage events", filterField: "subscriber" }
  );
}

function renderWeekday() {
  const rows = state.customers.weekday;
  const labels = ["Weekday", "Weekend"];
  const types = ["data", "voice", "sms"];
  const series = types.map((type) => ({ name: type, filterField: "event_type", filterValue: type,
    values: labels.map((day) => Number(rows.find((row) => row.day_type === day && row.event_type === type)?.event_count || 0)) }));
  drawGroupedBarChart($("#weekdayChart"), labels, series, [ORANGE, BLACK, GRAY]);
}

function renderQuality() {
  const rows = state.network.quarantine;
  drawLineChart($("#qualityChart"), rows.map((row) => row.interval_start), [{ name: "Quarantine rate", values: rows.map((row) => row.rate_pct) }], [ORANGE], (value) => `${formatNumber(value, 1)}%`);
}

function renderQualityVolume() {
  const rows = state.network.quarantine || [];
  drawLineChart(
    $("#qualityVolumeChart"),
    rows.map((row) => row.interval_start),
    [
      { name: "Raw", values: rows.map((row) => row.raw_rows) },
      { name: "Accepted", values: rows.map((row) => row.fact_rows) },
      { name: "Quarantine", values: rows.map((row) => row.quarantine_rows) },
    ],
    [BLACK, ORANGE, GRAY]
  );
}

function crossFormatter(value) {
  if (state.cross?.metric === "data_mb") return `${formatNumber(value, 1)} MB`;
  if (state.cross?.metric === "voice_minutes") return `${formatNumber(value, 1)} min`;
  return compact(value);
}

function activeDrillPath() {
  return state.catalog?.drill_paths?.find((path) => path.id === state.crossConfig.drillPath) || null;
}

function selectCrossValue(value) {
  const dimension = state.cross?.dimension;
  if (!dimension || !FIELDS.includes(dimension)) return;
  const alreadySelected = state.sel[dimension].includes(value);
  const path = activeDrillPath();
  if (path && !alreadySelected) {
    const index = path.dimensions.indexOf(dimension);
    if (index >= 0 && index < path.dimensions.length - 1) {
      state.crossConfig.drillLevel = index + 1;
      state.crossConfig.dimension = path.dimensions[index + 1];
      state.crossConfig.splitBy = "";
    }
  }
  toggleValue(dimension, value);
}

function renderDrillBreadcrumb() {
  const target = $("#drillBreadcrumb");
  const path = activeDrillPath();
  if (!path) { target.hidden = true; target.innerHTML = ""; return; }
  target.innerHTML = `<span>Drill path:</span>${path.dimensions.map((dimension, index) => {
    const meta = state.catalog.dimensions.find((item) => item.id === dimension);
    return `<button data-drill-level="${index}" class="${dimension === state.crossConfig.dimension ? "active" : ""}">${escapeHtml(meta?.label || dimension)}</button>${index < path.dimensions.length - 1 ? "<span>›</span>" : ""}`;
  }).join("")}`;
  target.hidden = false;
}

function renderCrossAnalysis() {
  const data = state.cross;
  if (!data) return;
  $("#crossDimension").value = data.dimension;
  $("#crossSplit").value = data.split_by || "";
  $("#crossMetric").value = data.metric;
  $("#crossLimit").value = String(data.limit);
  $("#crossChartType").value = state.crossConfig.chartType;
  $("#crossDrillPath").value = state.crossConfig.drillPath;
  $$("#crossSplit option").forEach((option) => {
    option.disabled = option.value !== "" && option.value === data.dimension;
  });

  const labels = [...new Set(data.rows.map((row) => row.dimension_value))];
  const seriesNames = [...new Set(data.rows.map((row) => row.series_value))];
  const filterField = FIELDS.includes(data.dimension) ? data.dimension : null;
  if (data.split_by) {
    const series = seriesNames.map((seriesName) => ({
      name: seriesName,
      values: labels.map((label) => Number(data.rows.find((row) =>
        row.dimension_value === label && row.series_value === seriesName)?.metric_value || 0)),
    }));
    drawGroupedBarChart($("#crossChart"), labels, series, SERIES_COLORS, crossFormatter, {
      labelField: filterField,
      chartType: state.crossConfig.chartType,
      stack: state.crossConfig.chartType === "stacked",
      onSelect: selectCrossValue,
    });
  } else if (state.crossConfig.chartType === "pie") {
    drawPieChart($("#crossChart"), data.rows, "dimension_value", "metric_value", crossFormatter,
      { seriesName: data.metric_label, filterField, onSelect: selectCrossValue });
  } else if (state.crossConfig.chartType === "line") {
    drawGroupedBarChart($("#crossChart"), labels, [{ name: data.metric_label, values: data.rows.map((row) => Number(row.metric_value)) }],
      [ORANGE], crossFormatter, { labelField: filterField, chartType: "line", onSelect: selectCrossValue });
  } else {
    drawHorizontalBarChart($("#crossChart"), data.rows, "dimension_value", "metric_value",
      ORANGE, crossFormatter, { seriesName: data.metric_label, filterField, onSelect: selectCrossValue });
  }

  $("#crossSubtitle").textContent = data.split_label
    ? `${data.dimension_label} × ${data.split_label}` : data.dimension_label;
  $("#crossTitle").textContent = `${data.metric_label} comparison`;
  $("#crossDimensionHead").textContent = data.dimension_label;
  $("#crossSeriesHead").textContent = data.split_label || "Series";
  $("#crossMetricHead").textContent = data.metric_label;
  const splitFilterField = FIELDS.includes(data.split_by) ? data.split_by : null;
  $("#crossLegend").innerHTML = data.split_by ? seriesNames.map((name, index) => {
    const interaction = splitFilterField ? ` data-field="${splitFilterField}" data-value="${escapeHtml(name)}"` : "";
    return `<button class="mix-item"${interaction}><i style="background:${SERIES_COLORS[index % SERIES_COLORS.length]}"></i>${escapeHtml(name)}</button>`;
  }).join("") : '<span><i style="background:#ff7900"></i>Selected metric</span>';
  $("#crossTable").innerHTML = data.rows.map((row) => `<tr>
    <td><b>${escapeHtml(row.dimension_value)}</b></td><td>${escapeHtml(row.series_value)}</td>
    <td>${escapeHtml(crossFormatter(row.metric_value))}</td><td>${escapeHtml(crossFormatter(row.total_value))}</td>
  </tr>`).join("");
  renderDrillBreadcrumb();
}

function chartHitAt(canvas, event) {
  const hits = chartHits.get(canvas.id) || [];
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  return hits.find((hit) => hit.shape === "rect"
    ? x >= hit.x && x <= hit.x + hit.width && y >= hit.y && y <= hit.y + hit.height
    : Math.hypot(x - hit.x, y - hit.y) <= hit.radius);
}

function moveChartTooltip(event) {
  const canvas = event.target.closest("canvas");
  if (!canvas) return;
  const tooltip = $("#chartTooltip");
  const hit = chartHitAt(canvas, event);
  if (!hit) { tooltip.hidden = true; return; }
  tooltip.innerHTML = `<b>${escapeHtml(hit.label)}</b>${escapeHtml(hit.series)}: ${escapeHtml(hit.formatted)}${hit.field ? "<small>Click to filter all analytics</small>" : ""}`;
  tooltip.style.left = `${Math.min(event.clientX + 14, window.innerWidth - 250)}px`;
  tooltip.style.top = `${Math.min(event.clientY + 14, window.innerHeight - 90)}px`;
  tooltip.hidden = false;
}

function clickChartHit(event) {
  const canvas = event.target.closest("canvas");
  if (!canvas || canvas.id === "mixChart") return;
  const hit = chartHitAt(canvas, event);
  if (hit?.field && hit.filterValue && FIELDS.includes(hit.field)) {
    toggleValue(hit.field, hit.filterValue);
  }
}

/* ── Tables: sortable + searchable ────────────────────────────── */

function sortRows(rows, { key, dir }) {
  return [...rows].sort((a, b) => {
    const left = a[key]; const right = b[key];
    const numeric = !Number.isNaN(Number(left)) && !Number.isNaN(Number(right));
    if (numeric) return (Number(left) - Number(right)) * dir;
    return String(left ?? "").localeCompare(String(right ?? "")) * dir;
  });
}

function markSortHeaders(tableSelector, sort) {
  $$(`${tableSelector} th`).forEach((th) => {
    th.classList.toggle("sorted-asc", th.dataset.sort === sort.key && sort.dir === 1);
    th.classList.toggle("sorted-desc", th.dataset.sort === sort.key && sort.dir === -1);
  });
}

function renderTables() {
  let towers = state.network.towers;
  if (state.towerQuery) {
    const query = state.towerQuery.toLowerCase();
    towers = towers.filter((row) => row.cell_tower_id.toLowerCase().includes(query) || row.region.toLowerCase().includes(query));
  }
  towers = sortRows(towers, state.sort.towers).slice(0, 25);
  $("#towerTable").innerHTML = towers.map((row) => `<tr><td><b>${escapeHtml(row.cell_tower_id)}</b></td><td>${escapeHtml(row.region)}</td><td>${formatNumber(row.event_count)}</td><td>${formatNumber(row.unique_subscribers)}</td><td>${formatNumber(row.data_mb, 1)}</td><td>${formatNumber(row.voice_minutes, 1)}</td><td>${formatNumber(row.sms_messages)}</td></tr>`).join("");
  markSortHeaders("#towerTableRoot", state.sort.towers);

  let subscribers = state.customers.top_subscribers;
  if (state.subscriberQuery) {
    const query = state.subscriberQuery.toLowerCase();
    subscribers = subscribers.filter((row) => row.subscriber_id.toLowerCase().includes(query) || row.city.toLowerCase().includes(query) || row.plan_type.toLowerCase().includes(query));
  }
  subscribers = sortRows(subscribers, state.sort.subs);
  $("#customerTable").innerHTML = subscribers.map((row) => `<tr><td><b>${escapeHtml(row.subscriber_id)}</b></td><td>${escapeHtml(row.plan_type)}</td><td>${escapeHtml(row.city)}</td><td>${formatNumber(row.event_count)}</td><td>${formatNumber(row.data_mb, 1)}</td><td>${formatNumber(row.voice_minutes, 1)}</td><td>${formatNumber(row.sms_messages)}</td><td>${escapeHtml(formatDate(row.last_activity))}</td></tr>`).join("");
  markSortHeaders("#customerTableRoot", state.sort.subs);
}

/* ── Selection bar, field popovers, bookmarks, search ─────────── */

function selectionEntries(sel) {
  const entries = [];
  if (sel.dateFrom) entries.push({ field: "dateFrom", label: "From", value: sel.dateFrom });
  if (sel.dateTo) entries.push({ field: "dateTo", label: "To", value: sel.dateTo });
  FIELDS.forEach((field) => sel[field].forEach((value) =>
    entries.push({ field, label: FIELD_LABELS[field], value })));
  return entries;
}

function renderSelectionChips() {
  const entries = selectionEntries(state.sel);
  $("#selectionChips").innerHTML = entries.length
    ? entries.map((entry) => `<span class="selection-chip"><b>${entry.label}</b>${escapeHtml(entry.value)}<button data-chip-field="${entry.field}" data-chip-value="${escapeHtml(entry.value)}" aria-label="Clear ${entry.label} ${escapeHtml(entry.value)}">×</button></span>`).join("")
    : '<span class="selection-chip"><b>Selection</b>All live data</span>';
  $("#historyBack").disabled = !state.past.length;
  $("#historyForward").disabled = !state.future.length;
  FIELDS.forEach((field) => {
    const summary = $(`[data-summary="${field}"]`);
    if (!summary) return;
    summary.textContent = state.sel[field].length ? state.sel[field].join(", ") : FIELD_EMPTY[field];
    summary.closest(".field-tile").classList.toggle("has-selection", state.sel[field].length > 0);
  });
  $("#dateFrom").value = state.sel.dateFrom;
  $("#dateTo").value = state.sel.dateTo;
}

async function loadDynamicValues(field, query = "") {
  const params = paramsFor(state.sel);
  params.set("field", field);
  params.set("q", query);
  params.set("limit", "60");
  try {
    const payload = await fetchJson("/api/values", params);
    state.dynamicValues[field] = payload.rows;
    state.dynamicQuery[field] = query;
    if (state.openField === field) renderFieldPopover();
  } catch (error) {
    $("#errorBanner").textContent = error.message;
    $("#errorBanner").hidden = false;
  }
}

function renderFieldPopover() {
  const popover = $("#fieldPopover");
  if (!state.openField || !state.filters) { popover.hidden = true; return; }
  const field = state.openField;
  const dynamic = field === "tower" || field === "subscriber";
  const values = dynamic ? state.dynamicValues[field] : state.filters.fields[field];
  popover.innerHTML = `
    <div class="popover-head"><b>${FIELD_LABELS[field]}</b>
      <button class="text-button" data-popover-clear="${field}">Clear field</button>
      <button class="popover-close" aria-label="Close">×</button></div>
    <input type="search" class="popover-search" value="${escapeHtml(dynamic ? state.dynamicQuery[field] : "")}" placeholder="Search values…" aria-label="Search ${FIELD_LABELS[field]} values">
    <div class="popover-values">${values.length ? values.map((item) => `
      <button class="popover-value${item.selected ? " selected" : (item.possible ? "" : " excluded")}"
              data-field="${field}" data-value="${escapeHtml(item.value)}">
        <span class="value-state" aria-hidden="true"></span>
        <span class="value-name">${escapeHtml(item.value)}</span>
        <span class="value-count">${compact(item.event_count)}</span>
      </button>`).join("") : `<p class="search-empty">${dynamic ? "Type to search or wait for values…" : "No possible values"}</p>`}</div>`;
  const tile = $(`.field-tile[data-field="${field}"]`);
  const rect = tile.getBoundingClientRect();
  popover.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
  popover.style.top = `${rect.bottom + window.scrollY + 6}px`;
  popover.hidden = false;
  let searchTimer;
  popover.querySelector(".popover-search").addEventListener("input", (event) => {
    const query = event.target.value.trim();
    if (dynamic) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadDynamicValues(field, query), 240);
    } else {
      popover.querySelectorAll(".popover-value").forEach((button) => {
        button.style.display = button.dataset.value.toLowerCase().includes(query.toLowerCase()) ? "" : "none";
      });
    }
  });
}

function loadBookmarks() {
  try { return JSON.parse(localStorage.getItem(BOOKMARK_KEY)) || []; } catch { return []; }
}

function renderBookmarkPanel() {
  const panel = $("#bookmarkPanel");
  const bookmarks = loadBookmarks();
  panel.innerHTML = `
    <div class="popover-head"><b>Bookmarks</b><button class="popover-close" aria-label="Close">×</button></div>
    <button class="orange-button bookmark-save">＋ Save current selection</button>
    <div class="bookmark-list">${bookmarks.length ? bookmarks.map((bookmark, index) => `
      <div class="bookmark-row">
        <button class="bookmark-apply" data-bookmark="${index}">${escapeHtml(bookmark.name)}</button>
        <small>${escapeHtml(bookmark.summary)}</small>
        <button class="bookmark-delete" data-bookmark-delete="${index}" aria-label="Delete bookmark">×</button>
      </div>`).join("") : '<p class="bookmark-empty">No bookmarks yet. Make a selection and save it.</p>'}</div>`;
}

function summarizeSelection(sel) {
  const entries = selectionEntries(sel);
  return entries.length ? entries.map((entry) => `${entry.label}: ${entry.value}`).join(" · ") : "All live data";
}

const ALERT_METRICS = [
  ["total_events", "Total events"], ["data_gb", "Data traffic (GB)"],
  ["voice_minutes", "Voice minutes"], ["sms_messages", "SMS messages"],
  ["active_towers", "Active towers"], ["active_subscribers", "Active subscribers"],
  ["quarantine_rate_pct", "Quarantine rate (%)"],
];

function loadAlerts() {
  try { return JSON.parse(localStorage.getItem(ALERT_KEY)) || []; } catch { return []; }
}

function saveAlerts(alerts) {
  localStorage.setItem(ALERT_KEY, JSON.stringify(alerts.slice(0, 30)));
}

function currentMetricValues() {
  return { ...(state.network?.kpis || {}), ...(state.customers?.kpis || {}) };
}

function evaluateAlerts() {
  if (!state.network || !state.customers) return;
  const values = currentMetricValues();
  const alerts = loadAlerts();
  let changed = false;
  alerts.forEach((alert) => {
    const value = Number(values[alert.metric] ?? 0);
    const triggered = alert.operator === ">" ? value > alert.threshold : value < alert.threshold;
    if (alert.triggered !== triggered || alert.lastValue !== value) changed = true;
    if (triggered && !alert.triggered) showToast(`Alert triggered: ${alert.label} ${alert.operator} ${formatNumber(alert.threshold, 2)}`);
    alert.triggered = triggered;
    alert.lastValue = value;
    alert.checkedAt = new Date().toISOString();
  });
  if (changed) saveAlerts(alerts);
  const triggeredCount = alerts.filter((alert) => alert.triggered).length;
  $("#alertButton").textContent = triggeredCount ? `⚑ Alerts (${triggeredCount})` : "⚑ Alerts";
  $("#alertButton").classList.toggle("active-mode", triggeredCount > 0);
  if (!$("#alertPanel").hidden) renderAlertPanel();
}

function renderAlertPanel() {
  const panel = $("#alertPanel");
  const alerts = loadAlerts();
  panel.innerHTML = `
    <div class="popover-head"><b>Data alerts</b><button class="popover-close" aria-label="Close">×</button></div>
    <small>Rules are evaluated after every refresh and stored only in this browser.</small>
    <div class="alert-form">
      <select id="alertMetric" style="grid-column:span 2">${ALERT_METRICS.map(([key, label]) => `<option value="${key}">${label}</option>`).join("")}</select>
      <select id="alertOperator"><option value=">">Above</option><option value="<">Below</option></select>
      <input id="alertThreshold" type="number" step="any" value="5" aria-label="Alert threshold">
      <button class="orange-button alert-create">Create alert</button>
    </div>
    <div>${alerts.length ? alerts.map((alert, index) => `<div class="alert-row ${alert.triggered ? "triggered" : "ok"}">
      <div><b>${escapeHtml(alert.label)} ${escapeHtml(alert.operator)} ${formatNumber(alert.threshold, 2)}</b>
      <small>Current ${formatNumber(alert.lastValue, 2)} · ${alert.triggered ? "Triggered" : "Within range"}</small></div>
      <button class="alert-delete" data-alert-delete="${index}" aria-label="Delete alert">×</button></div>`).join("") : '<p class="bookmark-empty">No alert rules yet.</p>'}</div>`;
}

function showToast(message) {
  const previous = $(".toast");
  if (previous) previous.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

function shareableUrl() {
  const params = paramsFor(state.sel);
  params.set("view", state.view);
  Object.entries(state.crossConfig).forEach(([key, value]) => params.set(`cross_${key}`, String(value)));
  return `${location.origin}${location.pathname}?${params}`;
}

async function shareAnalysis() {
  const url = shareableUrl();
  history.replaceState(null, "", url);
  try {
    await navigator.clipboard.writeText(url);
    showToast("Shareable analysis link copied");
  } catch {
    prompt("Copy this shareable analysis link:", url);
  }
}

function restoreSharedState() {
  const params = new URLSearchParams(location.search);
  if (!params.size) return;
  state.sel.dateFrom = params.get("date_from") || "";
  state.sel.dateTo = params.get("date_to") || "";
  state.sel.granularity = params.get("granularity") || "hour";
  FIELDS.forEach((field) => { state.sel[field] = (params.get(field) || "").split(",").filter(Boolean); });
  const view = params.get("view");
  if (["overview", "network", "customers", "cross", "quality"].includes(view)) state.view = view;
  const map = { dimension: "dimension", splitBy: "splitBy", metric: "metric", chartType: "chartType", drillPath: "drillPath" };
  Object.entries(map).forEach(([key, property]) => {
    const value = params.get(`cross_${key}`);
    if (value !== null) state.crossConfig[property] = value;
  });
  const limit = Number(params.get("cross_limit"));
  if ([5, 10, 15, 20].includes(limit)) state.crossConfig.limit = limit;
  const level = Number(params.get("cross_drillLevel"));
  if (Number.isInteger(level) && level >= 0) state.crossConfig.drillLevel = level;
}

function renderCompareStrip() {
  const strip = $("#compareStrip");
  if (!state.compareA || !state.compareData) {
    strip.hidden = true;
    $("#compareButton").classList.remove("active-mode");
    $("#compareButton").textContent = "⇄ Compare";
    return;
  }
  $("#compareButton").classList.add("active-mode");
  $("#compareButton").textContent = "⇄ Exit compare";
  const a = { ...state.compareData.network.kpis, ...state.compareData.customers.kpis };
  const b = { ...state.network.kpis, ...state.customers.kpis };
  const metrics = [
    ["Events", "total_events", 0], ["Data GB", "data_gb", 2], ["Voice min", "voice_minutes", 1],
    ["SMS", "sms_messages", 0], ["Subscribers", "active_subscribers", 0], ["Quarantine %", "quarantine_rate_pct", 2],
  ];
  strip.innerHTML = `
    <div class="compare-states">
      <span class="compare-tag state-a">A · ${escapeHtml(summarizeSelection(state.compareA))}</span>
      <span class="compare-tag state-b">B · ${escapeHtml(summarizeSelection(state.sel))}</span>
    </div>
    <div class="compare-grid">${metrics.map(([label, key, decimals]) => {
      const valueA = Number(a[key] ?? 0); const valueB = Number(b[key] ?? 0);
      const delta = valueA ? ((valueB - valueA) / valueA) * 100 : (valueB ? 100 : 0);
      const direction = delta > 0.05 ? "up" : (delta < -0.05 ? "down" : "flat");
      const arrow = direction === "up" ? "▲" : (direction === "down" ? "▼" : "＝");
      return `<div class="compare-cell">
        <span>${label}</span>
        <div class="compare-values"><b class="value-a">${formatNumber(valueA, decimals)}</b><b class="value-b">${formatNumber(valueB, decimals)}</b></div>
        <small class="delta ${direction}">${arrow} ${formatNumber(Math.abs(delta), 1)}%</small>
      </div>`;
    }).join("")}</div>`;
  strip.hidden = false;
}

/* ── Global smart search ──────────────────────────────────────── */

function renderSearchResults(query) {
  const box = $("#searchResults");
  if (!query || !state.filters) { box.hidden = true; box.innerHTML = ""; return; }
  const lowered = query.toLowerCase();
  const hits = [];
  FIELDS.forEach((field) => (state.filters.fields[field] || state.dynamicValues[field] || []).forEach((item) => {
    if (item.value.toLowerCase().includes(lowered)) hits.push({ field, ...item });
  }));
  box.innerHTML = hits.length ? hits.slice(0, 12).map((hit) => `
    <button class="search-hit${hit.selected ? " selected" : ""}" data-field="${hit.field}" data-value="${escapeHtml(hit.value)}">
      <b>${FIELD_LABELS[hit.field]}</b> ${escapeHtml(hit.value)}
      <span>${compact(hit.event_count)} events${hit.selected ? " · selected" : ""}</span>
    </button>`).join("") : '<p class="search-empty">No dimension values match.</p>';
  box.hidden = false;
}

let globalSearchTimer;
function updateGlobalSearch(query) {
  renderSearchResults(query);
  clearTimeout(globalSearchTimer);
  if (query.length < 2) return;
  globalSearchTimer = setTimeout(async () => {
    await Promise.all([loadDynamicValues("tower", query), loadDynamicValues("subscriber", query)]);
    renderSearchResults(query);
  }, 280);
}

/* ── Rendering root ───────────────────────────────────────────── */

function renderAll() {
  renderKpis();
  if (state.view === "network") {
    renderTrafficChart(); renderMixChart(); renderHeatmap(); renderMap();
    renderTopTowers(); renderRegionalData(); renderTables();
  } else if (state.view === "customers") {
    renderPlanData(); renderCityActivity(); renderWeekday(); renderTopSubscribers(); renderTables();
  } else if (state.view === "cross") {
    renderCrossAnalysis();
  } else if (state.view === "quality") {
    renderQuality(); renderQualityVolume();
  }
  const regionRows = Object.fromEntries(state.network.regions.map((row) => [row.region, row]));
  const planRows = Object.fromEntries(state.customers.plans.map((row) => [row.plan_type, row]));
  const cityRows = Object.fromEntries(state.customers.cities.map((row) => [row.city, row]));
  if (state.view === "network") renderSelectableBars("#regionBars", "region", regionRows, "event_count");
  if (state.view === "customers") {
    renderSelectableBars("#planBars", "plan", planRows, "event_count");
    renderSelectableBars("#cityBars", "city", cityRows, "subscriber_count");
  }
  renderSelectionChips();
  renderFieldPopover();
  renderCompareStrip();
  requestAnimationFrame(() => eCharts.forEach((chart) => chart.resize()));
}

function setView(view, scroll = true) {
  state.view = view;
  $$(".nav-link").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  const workspace = view === "customers" ? "commercial" : "operations";
  $$('[data-workspace]').forEach((button) => {
    const active = button.dataset.workspace === workspace;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $$(".dashboard-section").forEach((section) => section.classList.toggle("is-hidden", section.dataset.section !== view));
  if (scroll) document.querySelector(`[data-section="${view}"]`).scrollIntoView({ behavior: "smooth", block: "start" });
  requestAnimationFrame(() => { if (state.network) renderAll(); });
}

/* ── Export ───────────────────────────────────────────────────── */

function downloadCsv(filename, rows) {
  if (!rows?.length) return;
  const keys = Object.keys(rows[0]);
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [keys.map(quote).join(","), ...rows.map((row) => keys.map((key) => quote(row[key])).join(","))].join("\n");
  const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); link.download = filename; link.click(); URL.revokeObjectURL(link.href);
}

function exportSummary() {
  downloadCsv("orange-egypt-executive-summary.csv", [
    { ...state.network.kpis, ...state.customers.kpis, selection: summarizeSelection(state.sel), generated_at: state.network.generated_at }
  ]);
}

/* ── Events ───────────────────────────────────────────────────── */

function bindEvents() {
  $$(".nav-link").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $$('[data-workspace]').forEach((button) => button.addEventListener("click", () => {
    setView(button.dataset.workspace === "commercial" ? "customers" : "network");
  }));
  $$('[data-view-jump]').forEach((button) => button.addEventListener("click", () => setView(button.dataset.viewJump)));

  ["dateFrom", "dateTo"].forEach((id) => $(`#${id}`).addEventListener("change", (event) => {
    commit((sel) => { sel[id] = event.target.value; });
  }));

  ["crossDimension", "crossSplit", "crossMetric", "crossLimit", "crossChartType", "crossDrillPath"].forEach((id) =>
    $(`#${id}`).addEventListener("change", () => {
      const drillPathId = $("#crossDrillPath").value;
      if (id === "crossDrillPath") {
        state.crossConfig.drillPath = drillPathId;
        state.crossConfig.drillLevel = 0;
        const path = state.catalog?.drill_paths?.find((item) => item.id === drillPathId);
        if (path) {
          $("#crossDimension").value = path.dimensions[0];
          $("#crossSplit").value = "";
        }
      } else if (id === "crossDimension") {
        state.crossConfig.drillPath = "";
        $("#crossDrillPath").value = "";
      }
      state.crossConfig.dimension = $("#crossDimension").value;
      state.crossConfig.splitBy = $("#crossSplit").value;
      state.crossConfig.metric = $("#crossMetric").value;
      state.crossConfig.limit = Number($("#crossLimit").value);
      state.crossConfig.chartType = $("#crossChartType").value;
      if (state.crossConfig.chartType === "pie") {
        state.crossConfig.splitBy = "";
        $("#crossSplit").value = "";
      }
      if (state.crossConfig.dimension === state.crossConfig.splitBy) {
        state.crossConfig.splitBy = "";
        $("#crossSplit").value = "";
      }
      loadData();
    })
  );

  // Field tiles open the associative value popover.
  $$(".field-tile").forEach((tile) => tile.addEventListener("click", (event) => {
    event.stopPropagation();
    $("#bookmarkPanel").hidden = true; $("#alertPanel").hidden = true;
    state.openField = state.openField === tile.dataset.field ? null : tile.dataset.field;
    renderFieldPopover();
    if (state.openField === "tower" || state.openField === "subscriber") loadDynamicValues(state.openField);
  }));

  // One delegated listener: popover values, chips, bar rows, legends, search hits.
  document.addEventListener("click", (event) => {
    const drillButton = event.target.closest("[data-drill-level]");
    if (drillButton) {
      const path = activeDrillPath();
      const level = Number(drillButton.dataset.drillLevel);
      if (path?.dimensions[level]) {
        state.crossConfig.drillLevel = level;
        state.crossConfig.dimension = path.dimensions[level];
        state.crossConfig.splitBy = "";
        loadData();
      }
      return;
    }
    const valueButton = event.target.closest("[data-field][data-value]");
    if (valueButton) { toggleValue(valueButton.dataset.field, valueButton.dataset.value); return; }
    const typeButton = event.target.closest("[data-select-type]");
    if (typeButton) { toggleValue("event_type", typeButton.dataset.selectType); return; }
    const chip = event.target.closest("[data-chip-field]");
    if (chip) {
      commit((sel) => {
        const field = chip.dataset.chipField;
        if (field === "dateFrom" || field === "dateTo") sel[field] = "";
        else sel[field] = sel[field].filter((value) => value !== chip.dataset.chipValue);
      });
      return;
    }
    const clearField = event.target.closest("[data-popover-clear]");
    if (clearField) { commit((sel) => { sel[clearField.dataset.popoverClear] = []; }); return; }
    const applyBookmark = event.target.closest("[data-bookmark]");
    if (applyBookmark) {
      const bookmark = loadBookmarks()[Number(applyBookmark.dataset.bookmark)];
      if (bookmark) {
        if (bookmark.crossConfig) state.crossConfig = { ...state.crossConfig, ...bookmark.crossConfig };
        if (bookmark.view) setView(bookmark.view, false);
        commit((sel) => Object.assign(sel, emptySelection(), cloneSel(bookmark.sel)));
      }
      $("#bookmarkPanel").hidden = true;
      return;
    }
    const deleteBookmark = event.target.closest("[data-bookmark-delete]");
    if (deleteBookmark) {
      const bookmarks = loadBookmarks();
      bookmarks.splice(Number(deleteBookmark.dataset.bookmarkDelete), 1);
      localStorage.setItem(BOOKMARK_KEY, JSON.stringify(bookmarks));
      renderBookmarkPanel();
      return;
    }
    const deleteAlert = event.target.closest("[data-alert-delete]");
    if (deleteAlert) {
      const alerts = loadAlerts();
      alerts.splice(Number(deleteAlert.dataset.alertDelete), 1);
      saveAlerts(alerts); evaluateAlerts(); renderAlertPanel();
      return;
    }
    if (event.target.closest(".alert-create")) {
      const metric = $("#alertMetric").value;
      const label = ALERT_METRICS.find(([key]) => key === metric)?.[1] || metric;
      const operator = $("#alertOperator").value;
      const threshold = Number($("#alertThreshold").value);
      if (Number.isFinite(threshold)) {
        const alerts = loadAlerts();
        alerts.unshift({ metric, label, operator, threshold, triggered: false, lastValue: 0 });
        saveAlerts(alerts); evaluateAlerts(); renderAlertPanel();
      }
      return;
    }
    if (event.target.closest(".bookmark-save")) {
      const name = prompt("Bookmark name:", summarizeSelection(state.sel).slice(0, 40));
      if (name) {
        const bookmarks = loadBookmarks();
        bookmarks.unshift({ name, summary: `${state.view} · ${summarizeSelection(state.sel)}`, sel: cloneSel(state.sel),
          crossConfig: { ...state.crossConfig }, view: state.view });
        localStorage.setItem(BOOKMARK_KEY, JSON.stringify(bookmarks.slice(0, 20)));
        renderBookmarkPanel();
      }
      return;
    }
    if (event.target.closest(".popover-close")) {
      state.openField = null; $("#fieldPopover").hidden = true; $("#bookmarkPanel").hidden = true; $("#alertPanel").hidden = true; return;
    }
    // Click-away closes popovers.
    if (!event.target.closest("#fieldPopover")) { state.openField = null; $("#fieldPopover").hidden = true; }
    if (!event.target.closest("#bookmarkPanel") && !event.target.closest("#bookmarkButton")) $("#bookmarkPanel").hidden = true;
    if (!event.target.closest("#alertPanel") && !event.target.closest("#alertButton")) $("#alertPanel").hidden = true;
    if (!event.target.closest(".global-search")) $("#searchResults").hidden = true;
  });

  $("#historyBack").addEventListener("click", historyBack);
  $("#historyForward").addEventListener("click", historyForward);
  $("#resetButton").addEventListener("click", () => commit((sel) => Object.assign(sel, emptySelection())));

  $("#bookmarkButton").addEventListener("click", (event) => {
    event.stopPropagation();
    state.openField = null; $("#fieldPopover").hidden = true;
    renderBookmarkPanel();
    const panel = $("#bookmarkPanel");
    const rect = event.currentTarget.getBoundingClientRect();
    panel.style.left = `${Math.min(rect.left, window.innerWidth - 320)}px`;
    panel.style.top = `${rect.bottom + window.scrollY + 6}px`;
    panel.hidden = !panel.hidden;
  });

  $("#alertButton").addEventListener("click", (event) => {
    event.stopPropagation();
    state.openField = null; $("#fieldPopover").hidden = true; $("#bookmarkPanel").hidden = true;
    renderAlertPanel();
    const panel = $("#alertPanel");
    const rect = event.currentTarget.getBoundingClientRect();
    panel.style.left = `${Math.min(rect.left, window.innerWidth - 380)}px`;
    panel.style.top = `${rect.bottom + window.scrollY + 6}px`;
    panel.hidden = !panel.hidden;
  });

  $("#shareButton").addEventListener("click", shareAnalysis);
  $("#printButton").addEventListener("click", () => window.print());

  $("#compareButton").addEventListener("click", () => {
    if (state.compareA) { state.compareA = null; state.compareData = null; renderAll(); return; }
    state.compareA = cloneSel(state.sel);
    loadData();
  });

  $$(".granularity-toggle button").forEach((button) => button.addEventListener("click", () => {
    if (state.sel.granularity !== button.dataset.granularity) commit((sel) => { sel.granularity = button.dataset.granularity; });
  }));

  document.addEventListener("mousemove", moveChartTooltip);
  document.addEventListener("mouseout", (event) => {
    if (event.target.closest?.("canvas") && !event.relatedTarget?.closest?.("canvas")) {
      $("#chartTooltip").hidden = true;
    }
  });
  document.addEventListener("click", clickChartHit);

  $("#globalSearch").addEventListener("input", (event) => updateGlobalSearch(event.target.value.trim()));
  $("#globalSearch").addEventListener("focus", (event) => updateGlobalSearch(event.target.value.trim()));

  $$("#towerTableRoot th, #customerTableRoot th").forEach((th) => th.addEventListener("click", () => {
    const table = th.closest("table").id === "towerTableRoot" ? "towers" : "subs";
    const sort = state.sort[table];
    if (sort.key === th.dataset.sort) sort.dir *= -1; else { sort.key = th.dataset.sort; sort.dir = -1; }
    renderTables();
  }));
  $("#towerSearch").addEventListener("input", (event) => { state.towerQuery = event.target.value.trim(); renderTables(); });
  $("#subscriberSearch").addEventListener("input", (event) => { state.subscriberQuery = event.target.value.trim(); renderTables(); });

  $("#refreshButton").addEventListener("click", loadData);
  $("#fullscreenButton").addEventListener("click", () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  $("#languageButton").addEventListener("click", (event) => {
    const arabic = document.documentElement.lang !== "ar"; document.documentElement.lang = arabic ? "ar" : "en"; document.documentElement.dir = arabic ? "rtl" : "ltr"; event.currentTarget.innerHTML = arabic ? "<b>عربي</b>&nbsp;&nbsp;EN" : "عربي&nbsp;&nbsp;<b>EN</b>";
  });
  $$('[data-export="towers"]').forEach((button) => button.addEventListener("click", () => downloadCsv("orange-egypt-towers.csv", state.network?.towers)));
  $$('[data-export="customers"]').forEach((button) => button.addEventListener("click", () => downloadCsv("orange-egypt-subscribers.csv", state.customers?.top_subscribers)));
  $("#exportCross").addEventListener("click", () => downloadCsv("orange-egypt-cross-analysis.csv", state.cross?.rows));
  $(".export-overview").addEventListener("click", exportSummary);
  $("#helpButton").addEventListener("click", () => alert("Orange Egypt Associative Analytics\n\n• Hover charts for exact values; click marks to filter every dashboard.\n• Use chart toolboxes to zoom, inspect data, reset, and export PNG images.\n• Cross Analysis supports certified measures, four chart types, Top N, and guided drill paths.\n• Field tiles use Qlik-style states: green selected, white possible, grey excluded. Tower and Subscriber search on demand.\n• History arrows step through selection history; Compare creates A/B alternate states.\n• Bookmarks preserve selections, the active sheet, and Cross Analysis setup.\n• Share copies a restorable analysis URL; Print / PDF produces the current sheet.\n• Alerts evaluate KPI thresholds after every refresh and stay private to this browser."));

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { state.openField = null; $("#fieldPopover").hidden = true; $("#bookmarkPanel").hidden = true; $("#searchResults").hidden = true; }
  });

  let resizeTimer; window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => state.network && renderAll(), 150); });
}

restoreSharedState();
bindEvents();
setView(state.view, false);
loadData();
setInterval(loadData, 10 * 60 * 1000);
