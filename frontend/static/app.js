const ORANGE = "#ff7900";
const BLACK = "#000000";
const GRAY = "#8f8f8f";
const LIGHT = "#dedede";
const GREEN = "#009845"; // Qlik-style "selected" green

const FIELDS = ["event_type", "region", "plan", "city"];
const FIELD_LABELS = { event_type: "Usage", region: "Region", plan: "Plan", city: "City" };
const FIELD_EMPTY = { event_type: "All services", region: "All regions", plan: "All plans", city: "All cities" };
const BOOKMARK_KEY = "oeg-bookmarks-v1";

const state = {
  view: "overview",
  network: null, customers: null, filters: null,
  compareA: null, compareData: null,     // pinned state A + its fetched payloads
  sel: emptySelection(),
  past: [], future: [],                  // selection history (back / forward)
  sort: { towers: { key: "event_count", dir: -1 }, subs: { key: "event_count", dir: -1 } },
  towerQuery: "", subscriberQuery: "",
  openField: null,
  requestId: 0,
};

function emptySelection() {
  return { dateFrom: "", dateTo: "", granularity: "hour",
           event_type: [], region: [], plan: [], city: [] };
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
    ];
    if (state.compareA) {
      const paramsA = paramsFor(state.compareA);
      jobs.push(fetchJson("/api/network", paramsA), fetchJson("/api/customers", paramsA));
    }
    const [network, customers, filters, compareNetwork, compareCustomers] = await Promise.all(jobs);
    if (requestId !== state.requestId) return;
    state.network = network;
    state.customers = customers;
    state.filters = filters;
    state.compareData = state.compareA ? { network: compareNetwork, customers: compareCustomers } : null;
    renderAll();
    const updated = new Date(network.generated_at);
    $("#updatedAt").textContent = `Updated ${updated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    $("#pipelineStatus").textContent = "Pipeline live";
    $("#footerState").textContent = "Live warehouse";
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
    kpiCard("Latest run", formatDate(n.latest_hour), "UTC")
  ].join("");
  $("#heroEvents").textContent = compact(n.total_events);
  $("#heroQuality").textContent = `${formatNumber(n.quarantine_rate_pct, 2)}%`;
  $("#heroSubscribers").textContent = compact(c.active_subscribers);
}

/* ── Canvas helpers ───────────────────────────────────────────── */

function setupCanvas(canvas) {
  const cssHeight = Number(canvas.getAttribute("height")) || 280;
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

function drawLineChart(canvas, labels, series, colors, formatter = compact, dashedIndexes = new Set()) {
  const { context, width, height } = setupCanvas(canvas);
  const padding = { left: 52, right: 18, top: 16, bottom: 40 };
  const values = series.flatMap((item) => item.values).map(Number);
  const max = Math.max(...values, 1);
  drawGrid(context, width, height, padding);
  context.fillStyle = "#666"; context.font = "11px Arial";
  for (let i = 0; i <= 4; i += 1) {
    const value = max - (max * i / 4);
    const y = padding.top + ((height - padding.top - padding.bottom) * i / 4);
    context.fillText(formatter(value), 4, y + 4);
  }
  series.forEach((item, seriesIndex) => {
    context.strokeStyle = colors[seriesIndex] || ORANGE;
    context.lineWidth = seriesIndex === 0 ? 3 : 2;
    context.setLineDash(dashedIndexes.has(seriesIndex) ? [6, 5] : []);
    context.beginPath();
    item.values.forEach((raw, index) => {
      const x = padding.left + (index * (width - padding.left - padding.right) / Math.max(labels.length - 1, 1));
      const y = height - padding.bottom - (Number(raw) / max * (height - padding.top - padding.bottom));
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.stroke();
  });
  context.setLineDash([]);
  context.fillStyle = "#666"; context.textAlign = "center";
  const ticks = Math.min(5, labels.length);
  for (let i = 0; i < ticks; i += 1) {
    const index = Math.round(i * (labels.length - 1) / Math.max(ticks - 1, 1));
    const x = padding.left + (index * (width - padding.left - padding.right) / Math.max(labels.length - 1, 1));
    const label = labels[index] ? new Date(labels[index]).toLocaleString("en-GB", { day: "2-digit", hour: "2-digit", timeZone: "UTC" }) : "";
    context.fillText(label, x, height - 12);
  }
  context.textAlign = "left";
}

/* ── Charts ───────────────────────────────────────────────────── */

function renderTrafficChart() {
  const rows = state.network.hourly;
  const labels = [...new Set(rows.map((row) => row.hour_utc))];
  const types = ["data", "voice", "sms"];
  const series = types.map((type) => ({
    name: type,
    values: labels.map((hour) => Number(rows.find((row) => row.hour_utc === hour && row.event_type === type)?.event_count || 0))
  }));
  const colors = [ORANGE, BLACK, GRAY];
  const dashed = new Set();
  if (state.compareData) {
    // Overlay pinned state A as a dashed total line for visual comparison.
    const rowsA = state.compareData.network.hourly;
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
  const canvas = $("#mixChart");
  const { context, width, height } = setupCanvas(canvas);
  const total = rows.reduce((sum, row) => sum + Number(row.event_count), 0) || 1;
  const colors = { data: ORANGE, voice: BLACK, sms: GRAY };
  const radius = Math.min(width, height) * .33;
  let angle = -Math.PI / 2;
  mixSlices = [];
  rows.forEach((row) => {
    const slice = Number(row.event_count) / total * Math.PI * 2;
    const selected = state.sel.event_type.includes(row.event_type);
    context.beginPath(); context.moveTo(width / 2, height / 2); context.arc(width / 2, height / 2, radius + (selected ? 8 : 0), angle, angle + slice); context.closePath();
    context.fillStyle = colors[row.event_type] || LIGHT; context.fill();
    if (selected) { context.strokeStyle = GREEN; context.lineWidth = 3; context.stroke(); }
    mixSlices.push({ from: angle, to: angle + slice, type: row.event_type });
    angle += slice;
  });
  context.beginPath(); context.arc(width / 2, height / 2, radius * .56, 0, Math.PI * 2); context.fillStyle = "white"; context.fill();
  context.fillStyle = BLACK; context.textAlign = "center"; context.font = "bold 28px Arial"; context.fillText(compact(total), width / 2, height / 2 + 4);
  context.fillStyle = "#666"; context.font = "11px Arial"; context.fillText("EVENTS", width / 2, height / 2 + 24); context.textAlign = "left";
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
  const { context, width, height } = setupCanvas($("#towerMap"));
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
    context.beginPath(); context.arc(x, y, 2.5 + intensity * 7, 0, Math.PI * 2);
    context.fillStyle = `rgba(255,121,0,${.28 + intensity * .72})`; context.fill();
  });
  context.fillStyle = "rgba(255,255,255,.72)"; context.font = "bold 12px Arial"; context.fillText("EGYPT TOWER FOOTPRINT", 18, 24);
}

function renderWeekday() {
  const rows = state.customers.weekday;
  const labels = ["Weekday", "Weekend"];
  const types = ["data", "voice", "sms"];
  const series = types.map((type) => ({ values: labels.map((day) => Number(rows.find((row) => row.day_type === day && row.event_type === type)?.event_count || 0)) }));
  drawLineChart($("#weekdayChart"), labels, series, [ORANGE, BLACK, GRAY]);
}

function renderQuality() {
  const rows = state.network.quarantine;
  drawLineChart($("#qualityChart"), rows.map((row) => row.hour_utc), [{ values: rows.map((row) => row.rate_pct) }], [ORANGE], (value) => `${formatNumber(value, 1)}%`);
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
    summary.textContent = state.sel[field].length ? state.sel[field].join(", ") : FIELD_EMPTY[field];
    summary.closest(".field-tile").classList.toggle("has-selection", state.sel[field].length > 0);
  });
  $("#dateFrom").value = state.sel.dateFrom;
  $("#dateTo").value = state.sel.dateTo;
}

function renderFieldPopover() {
  const popover = $("#fieldPopover");
  if (!state.openField || !state.filters) { popover.hidden = true; return; }
  const field = state.openField;
  const values = state.filters.fields[field];
  popover.innerHTML = `
    <div class="popover-head"><b>${FIELD_LABELS[field]}</b>
      <button class="text-button" data-popover-clear="${field}">Clear field</button>
      <button class="popover-close" aria-label="Close">×</button></div>
    <input type="search" class="popover-search" placeholder="Search values…" aria-label="Search ${FIELD_LABELS[field]} values">
    <div class="popover-values">${values.map((item) => `
      <button class="popover-value${item.selected ? " selected" : (item.possible ? "" : " excluded")}"
              data-field="${field}" data-value="${escapeHtml(item.value)}">
        <span class="value-state" aria-hidden="true"></span>
        <span class="value-name">${escapeHtml(item.value)}</span>
        <span class="value-count">${compact(item.event_count)}</span>
      </button>`).join("")}</div>`;
  const tile = $(`.field-tile[data-field="${field}"]`);
  const rect = tile.getBoundingClientRect();
  popover.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
  popover.style.top = `${rect.bottom + window.scrollY + 6}px`;
  popover.hidden = false;
  popover.querySelector(".popover-search").addEventListener("input", (event) => {
    const query = event.target.value.toLowerCase();
    popover.querySelectorAll(".popover-value").forEach((button) => {
      button.style.display = button.dataset.value.toLowerCase().includes(query) ? "" : "none";
    });
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
  FIELDS.forEach((field) => state.filters.fields[field].forEach((item) => {
    if (item.value.toLowerCase().includes(lowered)) hits.push({ field, ...item });
  }));
  box.innerHTML = hits.length ? hits.slice(0, 12).map((hit) => `
    <button class="search-hit${hit.selected ? " selected" : ""}" data-field="${hit.field}" data-value="${escapeHtml(hit.value)}">
      <b>${FIELD_LABELS[hit.field]}</b> ${escapeHtml(hit.value)}
      <span>${compact(hit.event_count)} events${hit.selected ? " · selected" : ""}</span>
    </button>`).join("") : '<p class="search-empty">No dimension values match.</p>';
  box.hidden = false;
}

/* ── Rendering root ───────────────────────────────────────────── */

function renderAll() {
  renderKpis(); renderTrafficChart(); renderMixChart(); renderHeatmap(); renderMap(); renderWeekday(); renderQuality(); renderTables();
  const regionRows = Object.fromEntries(state.network.regions.map((row) => [row.region, row]));
  const planRows = Object.fromEntries(state.customers.plans.map((row) => [row.plan_type, row]));
  const cityRows = Object.fromEntries(state.customers.cities.map((row) => [row.city, row]));
  renderSelectableBars("#regionBars", "region", regionRows, "event_count");
  renderSelectableBars("#planBars", "plan", planRows, "event_count");
  renderSelectableBars("#cityBars", "city", cityRows, "subscriber_count");
  renderSelectionChips();
  renderFieldPopover();
  renderCompareStrip();
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

  // Field tiles open the associative value popover.
  $$(".field-tile").forEach((tile) => tile.addEventListener("click", (event) => {
    event.stopPropagation();
    $("#bookmarkPanel").hidden = true;
    state.openField = state.openField === tile.dataset.field ? null : tile.dataset.field;
    renderFieldPopover();
  }));

  // One delegated listener: popover values, chips, bar rows, legends, search hits.
  document.addEventListener("click", (event) => {
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
      if (bookmark) commit((sel) => Object.assign(sel, cloneSel(bookmark.sel)));
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
    if (event.target.closest(".bookmark-save")) {
      const name = prompt("Bookmark name:", summarizeSelection(state.sel).slice(0, 40));
      if (name) {
        const bookmarks = loadBookmarks();
        bookmarks.unshift({ name, summary: summarizeSelection(state.sel), sel: cloneSel(state.sel) });
        localStorage.setItem(BOOKMARK_KEY, JSON.stringify(bookmarks.slice(0, 20)));
        renderBookmarkPanel();
      }
      return;
    }
    if (event.target.closest(".popover-close")) {
      state.openField = null; $("#fieldPopover").hidden = true; $("#bookmarkPanel").hidden = true; return;
    }
    // Click-away closes popovers.
    if (!event.target.closest("#fieldPopover")) { state.openField = null; $("#fieldPopover").hidden = true; }
    if (!event.target.closest("#bookmarkPanel") && !event.target.closest("#bookmarkButton")) $("#bookmarkPanel").hidden = true;
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

  $("#compareButton").addEventListener("click", () => {
    if (state.compareA) { state.compareA = null; state.compareData = null; renderAll(); return; }
    state.compareA = cloneSel(state.sel);
    loadData();
  });

  $$(".granularity-toggle button").forEach((button) => button.addEventListener("click", () => {
    if (state.sel.granularity !== button.dataset.granularity) commit((sel) => { sel.granularity = button.dataset.granularity; });
  }));

  $("#mixChart").addEventListener("click", mixChartClick);

  $("#globalSearch").addEventListener("input", (event) => renderSearchResults(event.target.value.trim()));
  $("#globalSearch").addEventListener("focus", (event) => renderSearchResults(event.target.value.trim()));

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
  $(".export-overview").addEventListener("click", exportSummary);
  $("#helpButton").addEventListener("click", () => alert("Orange Egypt Telecom Intelligence\n\n• Click any chart element, bar, or legend to select it — every visual responds (associative model).\n• Field tiles open value lists: green = selected, white = possible, grey = excluded.\n• ‹ › arrows step back/forward through selection history.\n• ⇄ Compare pins the current state as A; change selections to build B and read the deltas.\n• ☆ Bookmarks save selection states for one-click recall.\n• Search dimensions from the top bar; sort tables by clicking headers."));

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { state.openField = null; $("#fieldPopover").hidden = true; $("#bookmarkPanel").hidden = true; $("#searchResults").hidden = true; }
  });

  let resizeTimer; window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => state.network && renderAll(), 150); });
}

bindEvents();
setView("overview", false);
loadData();
setInterval(loadData, 10 * 60 * 1000);
