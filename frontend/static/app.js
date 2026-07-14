const ORANGE = "#ff7900";
const BLACK = "#000000";
const GRAY = "#8f8f8f";
const LIGHT = "#dedede";

const state = { view: "overview", network: null, customers: null, loading: false };
const filterIds = ["dateFrom", "dateTo", "eventType", "region", "plan", "city"];
const filterLabels = {
  dateFrom: "From", dateTo: "To", eventType: "Usage", region: "Region", plan: "Plan", city: "City"
};
const queryNames = {
  dateFrom: "date_from", dateTo: "date_to", eventType: "event_type", region: "region", plan: "plan", city: "city"
};

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

function currentParams() {
  const params = new URLSearchParams();
  filterIds.forEach((id) => {
    const value = $(`#${id}`).value;
    if (value) params.set(queryNames[id], value);
  });
  return params;
}

async function fetchJson(path) {
  const response = await fetch(`${path}?${currentParams()}`, { headers: { Accept: "application/json" } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function loadData() {
  if (state.loading) return;
  state.loading = true;
  document.body.classList.add("loading");
  $("#errorBanner").hidden = true;
  try {
    const [network, customers] = await Promise.all([
      fetchJson("/api/network"), fetchJson("/api/customers")
    ]);
    state.network = network;
    state.customers = customers;
    renderAll();
    const updated = new Date(network.generated_at);
    $("#updatedAt").textContent = `Updated ${updated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    $("#pipelineStatus").textContent = "Pipeline live";
    $("#footerState").textContent = "Live warehouse";
  } catch (error) {
    $("#errorBanner").textContent = error.message;
    $("#errorBanner").hidden = false;
    $("#pipelineStatus").textContent = "Connection issue";
    $("#footerState").textContent = "Check services";
  } finally {
    state.loading = false;
    document.body.classList.remove("loading");
  }
}

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

function drawLineChart(canvas, labels, series, colors, formatter = compact) {
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
    context.beginPath();
    item.values.forEach((raw, index) => {
      const x = padding.left + (index * (width - padding.left - padding.right) / Math.max(labels.length - 1, 1));
      const y = height - padding.bottom - (Number(raw) / max * (height - padding.top - padding.bottom));
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.stroke();
  });
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

function renderTrafficChart() {
  const rows = state.network.hourly;
  const labels = [...new Set(rows.map((row) => row.hour_utc))];
  const types = ["data", "voice", "sms"];
  const series = types.map((type) => ({
    name: type,
    values: labels.map((hour) => Number(rows.find((row) => row.hour_utc === hour && row.event_type === type)?.event_count || 0))
  }));
  drawLineChart($("#trafficChart"), labels, series, [ORANGE, BLACK, GRAY]);
}

function renderMixChart() {
  const rows = state.network.service_mix;
  const { context, width, height } = setupCanvas($("#mixChart"));
  const total = rows.reduce((sum, row) => sum + Number(row.event_count), 0) || 1;
  const colors = { data: ORANGE, voice: BLACK, sms: GRAY };
  const radius = Math.min(width, height) * .33;
  let angle = -Math.PI / 2;
  rows.forEach((row) => {
    const slice = Number(row.event_count) / total * Math.PI * 2;
    context.beginPath(); context.moveTo(width / 2, height / 2); context.arc(width / 2, height / 2, radius, angle, angle + slice); context.closePath();
    context.fillStyle = colors[row.event_type] || LIGHT; context.fill(); angle += slice;
  });
  context.beginPath(); context.arc(width / 2, height / 2, radius * .56, 0, Math.PI * 2); context.fillStyle = "white"; context.fill();
  context.fillStyle = BLACK; context.textAlign = "center"; context.font = "bold 28px Arial"; context.fillText(compact(total), width / 2, height / 2 + 4);
  context.fillStyle = "#666"; context.font = "11px Arial"; context.fillText("EVENTS", width / 2, height / 2 + 24); context.textAlign = "left";
  $("#mixLegend").innerHTML = rows.map((row) => `<span><i style="background:${colors[row.event_type] || LIGHT}"></i>${escapeHtml(row.event_type)} ${formatNumber(Number(row.event_count) / total * 100, 1)}%</span>`).join("");
}

function renderBars(target, rows, labelKey, valueKey, suffix = "") {
  const max = Math.max(...rows.map((row) => Number(row[valueKey])), 1);
  $(target).innerHTML = rows.map((row) => `<div class="bar-row"><span>${escapeHtml(row[labelKey])}</span><div class="bar-track"><div class="bar-fill" style="width:${Number(row[valueKey]) / max * 100}%"></div></div><strong>${escapeHtml(compact(row[valueKey]))}${suffix}</strong></div>`).join("");
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

function renderTables() {
  $("#towerTable").innerHTML = state.network.top_towers.map((row) => `<tr><td><b>${escapeHtml(row.cell_tower_id)}</b></td><td>${escapeHtml(row.region)}</td><td>${formatNumber(row.event_count)}</td><td>${formatNumber(row.unique_subscribers)}</td><td>${formatNumber(row.data_mb, 1)}</td><td>${formatNumber(row.voice_minutes, 1)}</td><td>${formatNumber(row.sms_messages)}</td></tr>`).join("");
  $("#customerTable").innerHTML = state.customers.top_subscribers.map((row) => `<tr><td><b>${escapeHtml(row.subscriber_id)}</b></td><td>${escapeHtml(row.plan_type)}</td><td>${escapeHtml(row.city)}</td><td>${formatNumber(row.event_count)}</td><td>${formatNumber(row.data_mb, 1)}</td><td>${formatNumber(row.voice_minutes, 1)}</td><td>${formatNumber(row.sms_messages)}</td><td>${escapeHtml(formatDate(row.last_activity))}</td></tr>`).join("");
}

function renderAll() {
  renderKpis(); renderTrafficChart(); renderMixChart(); renderMap(); renderWeekday(); renderQuality(); renderTables();
  renderBars("#regionBars", state.network.regions, "region", "event_count");
  renderBars("#planBars", state.customers.plans, "plan_type", "event_count");
  renderBars("#cityBars", state.customers.cities, "city", "subscriber_count");
  renderSelectionChips();
}

function renderSelectionChips() {
  const chips = filterIds.flatMap((id) => {
    const element = $(`#${id}`); const value = element.value;
    if (!value) return [];
    const display = element.tagName === "SELECT" ? element.selectedOptions[0].textContent : value;
    return `<span class="selection-chip"><b>${filterLabels[id]}</b>${escapeHtml(display)}<button data-clear-filter="${id}" aria-label="Clear ${filterLabels[id]}">×</button></span>`;
  });
  $("#selectionChips").innerHTML = chips.length ? chips.join("") : '<span class="selection-chip"><b>Selection</b>All live data</span>';
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
  $$(".network-filter").forEach((element) => element.classList.toggle("hidden-control", view === "customers"));
  $$(".customer-filter").forEach((element) => element.classList.toggle("hidden-control", view === "network" || view === "quality"));
  if (scroll) document.querySelector(`[data-section="${view}"]`).scrollIntoView({ behavior: "smooth", block: "start" });
  requestAnimationFrame(() => { if (state.network) renderAll(); });
}

function downloadCsv(filename, rows) {
  if (!rows?.length) return;
  const keys = Object.keys(rows[0]);
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [keys.map(quote).join(","), ...rows.map((row) => keys.map((key) => quote(row[key])).join(","))].join("\n");
  const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); link.download = filename; link.click(); URL.revokeObjectURL(link.href);
}

function exportSummary() {
  downloadCsv("orange-egypt-executive-summary.csv", [
    { ...state.network.kpis, ...state.customers.kpis, generated_at: state.network.generated_at }
  ]);
}

function bindEvents() {
  $$(".nav-link").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $$('[data-workspace]').forEach((button) => button.addEventListener("click", () => {
    setView(button.dataset.workspace === "commercial" ? "customers" : "network");
  }));
  $$('[data-view-jump]').forEach((button) => button.addEventListener("click", () => setView(button.dataset.viewJump)));
  filterIds.forEach((id) => $(`#${id}`).addEventListener("change", () => { renderSelectionChips(); loadData(); }));
  $("#selectionChips").addEventListener("click", (event) => {
    const id = event.target.dataset.clearFilter; if (!id) return; $(`#${id}`).value = ""; loadData();
  });
  $("#resetButton").addEventListener("click", () => { filterIds.forEach((id) => { $(`#${id}`).value = ""; }); loadData(); });
  $("#refreshButton").addEventListener("click", loadData);
  $("#fullscreenButton").addEventListener("click", () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  $("#languageButton").addEventListener("click", (event) => {
    const arabic = document.documentElement.lang !== "ar"; document.documentElement.lang = arabic ? "ar" : "en"; document.documentElement.dir = arabic ? "rtl" : "ltr"; event.currentTarget.innerHTML = arabic ? "<b>عربي</b>&nbsp;&nbsp;EN" : "عربي&nbsp;&nbsp;<b>EN</b>";
  });
  $$('[data-export="towers"]').forEach((button) => button.addEventListener("click", () => downloadCsv("orange-egypt-towers.csv", state.network?.towers)));
  $$('[data-export="customers"]').forEach((button) => button.addEventListener("click", () => downloadCsv("orange-egypt-subscribers.csv", state.customers?.top_subscribers)));
  $(".export-overview").addEventListener("click", exportSummary);
  $("#helpButton").addEventListener("click", () => alert("Orange Egypt Telecom Intelligence\n\nUse the selection rail to filter every compatible visual. Open Airflow or Metabase from the top utility bar for engineering detail."));
  let resizeTimer; window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => state.network && renderAll(), 150); });
}

bindEvents();
setView("overview", false);
loadData();
setInterval(loadData, 10 * 60 * 1000);
