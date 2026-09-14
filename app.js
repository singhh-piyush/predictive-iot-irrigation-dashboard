const BROKER = "wss://bf2858433f4c4e3389ed899ed463d4ff.s1.eu.hivemq.cloud:8884/mqtt";
const USER = "irrigation";
const NODE = "node1";
const STALE_MS = 20000;
const RAIN_WET_ABOVE = 500;
const HORIZONS = [2, 4, 8, 16, 24];
const LOOKBACK_S = 12 * 3600;
const AHEAD_S = 24 * 3600;
const CHECK_SPAN_S = 48 * 3600;
const MISSING = -32768;
const PAGES = ["dashboard", "model", "settings"];
const SIM_TIMEOUT_MS = 6000;

// skill against persistence per horizon from the training run, all stations pooled
const TRAINED_SKILL = { labels: ["2 h", "4 h", "8 h", "16 h", "24 h"], values: [0.05, 0.08, 0.13, 0.20, 0.20] };

// the indoor weather profile the node uses puts solar noon at 18:00 UTC, so
// each time of day is expressed as an hour on that clock
const TIME_OF_DAY = { morning: 12, midday: 18, evening: 0, night: 6 };

const el = (id) => document.getElementById(id);
const statusText = el("status-text");
const relay = el("relay");

const data = {
  state: null, forecast: null, forecasts: [], hourly: { hours: [], raw: [] },
  history: null, scores: [], config: { auto: false, threshold: 0.3, lead: 2, pulse_s: 10, dry_raw: 4095, wet_raw: 2548 },
};
let client = null;
let lastMessage = 0;
let nodeOnline = false;
let page = "dashboard";
const sim = { id: 0, sent: false, hourStart: 0, theta: null, result: null, previous: null, timer: null, debounce: null };

function show(section, on) { section.hidden = !on; }

function setStatus(state, text) {
  document.body.dataset.node = state;
  statusText.textContent = text;
}

function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m - h * 60} min`;
}

function ago(ms) { return `${duration(ms)} ago`; }

function nodeReachable() {
  return !!client && client.connected && nodeOnline && lastMessage && Date.now() - lastMessage <= STALE_MS;
}

function refreshStatus() {
  if (!client || !client.connected) return;
  if (!lastMessage) {
    setStatus("idle", nodeOnline ? "Node online, waiting for readings" : "Waiting for the node");
  } else {
    const since = Date.now() - lastMessage;
    if (!nodeOnline) setStatus("offline", `Node offline, last reading ${ago(since)}`);
    else if (since > STALE_MS) setStatus("offline", `No readings for ${duration(since)}`);
    else setStatus("online", `Online, ${ago(since)}`);
  }
  const reachable = nodeReachable();
  document.querySelectorAll(".choice").forEach((b) => { b.disabled = !reachable; });
  document.querySelectorAll(".sim-controls input, .sim-controls select").forEach((i) => { i.disabled = !reachable; });
  if (!sim.result && !sim.sent) el("sim-note").textContent = reachable ? "Move a slider to start." : "The node is offline. The model runs on it.";
}

function fmt(v, digits) {
  return v === undefined || v === null ? "–" : Number(v).toFixed(digits);
}

// relative saturation in percent, from the probe's dry and wet readings
function pct(raw) {
  const c = data.config;
  return (raw - c.dry_raw) / (c.wet_raw - c.dry_raw) * 100;
}

function now() { return Date.now() / 1000; }

// Sidebar. On a wide screen it sits beside the content and the choice is kept,
// on a narrow one it slides over the content and starts closed.
const narrow = matchMedia("(max-width: 900px)");

function setSide(open, remember) {
  document.body.dataset.side = open ? "open" : "closed";
  el("menu").setAttribute("aria-expanded", String(open));
  if (remember && !narrow.matches) localStorage.setItem("sidebar", open ? "open" : "closed");
}

function initSide() {
  if (narrow.matches) setSide(false);
  else setSide(localStorage.getItem("sidebar") !== "closed");
}

function showPage(name) {
  if (!PAGES.includes(name)) name = "dashboard";
  page = name;
  document.querySelectorAll(".page").forEach((s) => show(s, s.dataset.page === name));
  document.querySelectorAll(".pages a").forEach((a) => {
    if (a.dataset.page === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  el("page-title").textContent = name[0].toUpperCase() + name.slice(1);
  if (narrow.matches) setSide(false);
  window.scrollTo(0, 0);
  if (data.history) renderAll();
}

function renderReadings(s) {
  const sat = pct(s.soil_raw);
  el("soil").textContent = fmt(sat, 0);
  el("soil-temp").textContent = fmt(s.soil_temp, 1);
  el("air-temp").textContent = fmt(s.air_temp, 1);
  el("humidity").textContent = fmt(s.humidity, 0);
  el("rain").textContent = s.rain_raw > RAIN_WET_ABOVE ? "Wet" : "Dry";
  el("light").textContent = s.light_raw;
  el("now-soil-temp").textContent = s.soil_temp === undefined ? "" : `${fmt(s.soil_temp, 1)} °C`;
  el("now-air-temp").textContent = s.air_temp === undefined ? "" : `${fmt(s.air_temp, 1)} °C`;
  el("now-humidity").textContent = s.humidity === undefined ? "" : `${fmt(s.humidity, 0)} %`;
  el("now-light").textContent = `${s.light_raw}`;
  el("now-rain").textContent = s.rain_raw > RAIN_WET_ABOVE ? "Wet" : "Dry";
  relay.checked = !!s.relay;
  relay.disabled = false;
  el("relay-text").textContent = s.relay ? "Open" : "Closed";
  el("signal").textContent = `Signal ${s.rssi} dBm`;
  const h = Math.floor(s.uptime_s / 3600);
  const m = Math.floor((s.uptime_s % 3600) / 60);
  el("uptime").textContent = h ? `Up ${h} h ${m} min` : `Up ${m} min`;
  el("strip-valve").textContent = s.relay ? "Valve open" : "Valve closed";
}

function historyPoints(field, scaleBy) {
  const h = data.history;
  if (!h) return [];
  return h.t.map((t, i) => {
    const v = h[field][i];
    return [t, v === MISSING ? null : v / (scaleBy || 1)];
  });
}

// One sentence on where a trajectory ends up, shared by the outlook and the scenario
// saturation cannot leave 0 to 100, even if a predicted change would take it there
function clampPct(level) { return Math.min(100, Math.max(0, Math.round(level * 100))); }

function outlookSentence(f) {
  const thr = Math.round(f.threshold * 100);
  const nowPct = clampPct(f.levels[0]);
  const endPct = clampPct(f.levels[f.levels.length - 1]);
  if (f.crossing === 0) {
    return `The soil is already below the watering threshold, <b>${nowPct} %</b> against ${thr} %.`;
  }
  if (f.crossing === null) {
    return `Stays above the threshold for the next 24 hours. The model expects <b>${nowPct} %</b> to become <b>${endPct} %</b> by then.`;
  }
  const due = f.decision === "irrigate" ? " That is inside the lead time, so watering is due." : "";
  return `Reaches the watering threshold in about <b>${f.crossing.toFixed(1)} h</b>.${due}`;
}

function renderHero() {
  const t = now();
  const f = data.forecast;
  const measured = historyPoints("soil").map(([ts, v]) => [ts, v === null ? null : pct(v)]);
  const predicted = f && f.ready
    ? f.hours.map((h, i) => [f.at + h * 3600, f.levels[i] * 100]) : [];
  const values = measured.concat(predicted).map((p) => p[1]).filter((v) => v !== null);
  const lo = Math.min(0, ...values), hi = Math.max(100, ...values);

  Charts.draw(el("soil-chart"), {
    x: [t - LOOKBACK_S, t + AHEAD_S], y: [Math.floor(lo / 10) * 10, Math.ceil(hi / 10) * 10],
    step: 6, now: t, shadeFrom: t, unit: " %", gap: 900, snap: 3600,
    threshold: data.config.threshold * 100, band: data.config.threshold * 100,
    format: (v) => `${Math.round(v)}`,
    series: [
      { name: "Measured", cls: "soil", points: measured, area: true },
      { name: "Predicted", cls: "predicted", points: predicted, dots: true, gap: 9 * 3600 },
    ],
    empty: "Waiting for the node's first readings",
  });

  const line = el("countdown");
  const prov = el("provisional");
  const kpi = el("kpi-hours");
  const pill = el("decision");
  if (!f || !f.ready) {
    line.textContent = "Waiting for the first hour of readings before the model can run.";
    kpi.textContent = "–";
    pill.textContent = "Waiting";
    pill.dataset.state = "waiting";
    show(prov, false);
    show(el("horizons"), false);
    return;
  }
  const ms = f.inference_ms === undefined ? null : `${f.inference_ms} ms`;
  el("inference").textContent = ms ? `On device, ${ms}` : "On device";
  if (f.crossing === 0) kpi.innerHTML = "Now";
  else if (f.crossing === null) kpi.innerHTML = `24<small>h +</small>`;
  else kpi.innerHTML = `${f.crossing.toFixed(1)}<small>h</small>`;
  pill.textContent = f.decision === "irrigate" ? "Water now" : "Hold";
  pill.dataset.state = f.decision === "irrigate" ? "irrigate" : "hold";
  line.innerHTML = outlookSentence(f);
  const horizons = el("horizons");
  horizons.innerHTML = f.hours.slice(1).map((h, i) => `<li><span>in ${h} h</span><b>${clampPct(f.levels[i + 1])} %</b></li>`).join("");
  show(horizons, true);
  let note = `Computed on the node at ${new Date(f.at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
  if (!f.full) {
    note += ` Built on ${f.history_hours} of the 24 hours of history the model was trained with, so provisional until tomorrow.`;
  }
  if (f.last_watering) {
    note += ` Last watered ${ago((t - f.last_watering) * 1000)}.`;
  }
  prov.textContent = note;
  show(prov, !!note);
}

// Pair every logged forecast with what the hourly record later measured
function verification() {
  const theta = new Map();
  data.hourly.hours.forEach((h, i) => theta.set(h, pct(data.hourly.raw[i])));
  const pairs = {};
  for (const h of HORIZONS) pairs[h] = [];
  for (const item of data.forecasts) {
    HORIZONS.forEach((h, k) => {
      const observed = theta.get(item.t + h * 3600);
      if (observed === undefined) return;
      pairs[h].push({ t: item.t, predicted: item.levels[k + 1] * 100,
                      persisted: item.levels[0] * 100, observed, full: item.full });
    });
  }
  return pairs;
}

function rmse(rows, key) {
  const sq = rows.reduce((acc, r) => acc + (r[key] - r.observed) ** 2, 0);
  return Math.sqrt(sq / rows.length);
}

function renderCheck() {
  const t = now();
  const pairs = verification();
  const measured = data.hourly.hours.map((h, i) => [h, pct(data.hourly.raw[i])]);
  const predicted = data.forecasts.map((item) => [item.t + 2 * 3600, item.levels[1] * 100]);
  const values = measured.concat(predicted).map((p) => p[1]);
  const lo = Math.min(0, ...values), hi = Math.max(100, ...values);
  Charts.draw(el("check-chart"), {
    x: [t - CHECK_SPAN_S, t + 2 * 3600], y: [Math.floor(lo / 10) * 10, Math.ceil(hi / 10) * 10],
    step: 12, now: t, unit: " %", gap: 5400, snap: 1800,
    format: (v) => `${Math.round(v)}`,
    series: [
      { name: "Measured", cls: "soil", points: measured, dots: true },
      { name: "Predicted 2 h earlier", cls: "predicted", points: predicted, dots: true },
    ],
    empty: "The first comparison appears two hours after the node's first full hour",
  });

  const body = el("skill-table").querySelector("tbody");
  body.innerHTML = "";
  let headline = null;
  for (const h of HORIZONS) {
    const all = pairs[h];
    const full = all.filter((r) => r.full);
    const rows = full.length ? full : all;
    const tr = document.createElement("tr");
    if (!rows.length) {
      tr.innerHTML = `<td>${h} h</td><td class="none">none yet</td><td class="none">–</td><td class="none">–</td><td class="none">–</td>`;
    } else {
      const m = rmse(rows, "predicted"), p = rmse(rows, "persisted");
      const skill = p > 0 ? 1 - (m * m) / (p * p) : 0;
      const tag = full.length ? "" : " provisional";
      tr.innerHTML = `<td>${h} h</td><td>${rows.length}${tag}</td><td>${m.toFixed(1)} pts</td><td>${p.toFixed(1)} pts</td><td>${skill.toFixed(2)}</td>`;
      if (h === 2) headline = { n: rows.length, m, p, skill, provisional: !full.length };
    }
    body.appendChild(tr);
  }

  renderErrors(pairs[2], t);
  renderDays();
  const text = el("skill-text");
  if (!headline) {
    text.textContent = "Each forecast is checked against what the probe measured later. Nothing is old enough to check yet.";
    return;
  }
  const prov = headline.provisional ? " Made with less than a day of history." : "";
  text.textContent = `Over ${headline.n} two hour forecasts the model was off by ${headline.m.toFixed(1)} points, no change by ${headline.p.toFixed(1)}.${prov}`;
}

function renderErrors(rows, t) {
  const model = rows.map((r) => [r.t + 2 * 3600, Math.abs(r.predicted - r.observed)]);
  const persist = rows.map((r) => [r.t + 2 * 3600, Math.abs(r.persisted - r.observed)]);
  const hi = Math.max(5, ...model.map((p) => p[1]), ...persist.map((p) => p[1]));
  Charts.draw(el("error-chart"), {
    x: [t - 72 * 3600, t], y: [0, Math.ceil(hi * 1.2)], step: 12, now: t, unit: " pts", gap: 5400, snap: 1800,
    format: (v) => v.toFixed(1),
    series: [
      { name: "No change", cls: "persist", points: persist, dots: true },
      { name: "Model", cls: "predicted", points: model, dots: true },
    ],
    empty: "The first checked forecast appears two hours after the first full hour",
  });
}

// One row per day from the node's own scorecard, newest first
function renderDays() {
  const body = el("day-table").querySelector("tbody");
  body.innerHTML = "";
  const days = (data.scores || []).slice().sort((a, b) => b.day - a.day);
  if (!days.length) {
    body.innerHTML = `<tr><td colspan="5" class="none">The node writes a row here at the end of each checked hour</td></tr>`;
    return;
  }
  for (const d of days) {
    const n = d.n[0];
    if (!n) continue;
    const m = Math.sqrt(d.sm[0] / n) * 100, p = Math.sqrt(d.sp[0] / n) * 100;
    const skill = d.sp[0] > 0 ? 1 - d.sm[0] / d.sp[0] : 0;
    const label = new Date(d.day * 1000).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
    const prov = d.prov ? `, ${d.prov} provisional` : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${label}</td><td>${n}${prov}</td><td>${m.toFixed(1)} pts</td><td>${p.toFixed(1)} pts</td><td>${skill.toFixed(2)}</td>`;
    body.appendChild(tr);
  }
}

function renderSparks() {
  const specs = [
    ["spark-soil", "soil", 1, true],
    ["spark-soil-temp", "soil_temp_x100", 100],
    ["spark-air-temp", "air_temp_x10", 10],
    ["spark-humidity", "humidity_x10", 10],
    ["spark-rain", "rain", 1],
    ["spark-light", "light", 1],
  ];
  const t = now();
  for (const [id, field, scaleBy, asPct] of specs) {
    let points = historyPoints(field, scaleBy);
    if (asPct) points = points.map(([ts, v]) => [ts, v === null ? null : pct(v)]);
    Charts.spark(el(id), points, { x: [t - LOOKBACK_S, t] });
  }
}

function renderTraces() {
  renderSparks();
  const t = now();
  const specs = [
    ["trace-soil-temp", "soil_temp_x100", 100, 1],
    ["trace-air-temp", "air_temp_x10", 10, 1],
    ["trace-humidity", "humidity_x10", 10, 0],
    ["trace-light", "light", 1, 0],
    ["trace-rain", "rain", 1, 0],
  ];
  for (const [id, field, scaleBy, digits] of specs) {
    const points = historyPoints(field, scaleBy);
    const values = points.map((p) => p[1]).filter((v) => v !== null);
    let lo = values.length ? Math.min(...values) : 0;
    let hi = values.length ? Math.max(...values) : 1;
    const padding = Math.max((hi - lo) * 0.2, digits ? 0.5 : 5);
    lo -= padding; hi += padding;
    // counts and percentages cannot go below zero, so the axis should not either
    if (!digits) lo = Math.max(0, lo);
    const figure = el(id);
    Charts.draw(figure, {
      x: [t - LOOKBACK_S, t], y: [lo, hi], step: 6, small: true, gap: 900, snap: 600,
      format: (v) => v.toFixed(digits),
      series: [{ name: figure.dataset.title.split(",")[0], cls: "accent", points, area: true }],
      empty: "Nothing yet",
    });
  }
}

// Slider positions for each preset: moisture now, hours since watering, drying a day
const PRESETS = { "watered-now": [85, 1, 10], "watered-yesterday": [60, 20, 15], drying: [40, 25, 22], dry: [25, 25, 4] };

function simInputs() {
  return { now: Number(el("sim-now").value), watered: Number(el("sim-watered").value), rate: Number(el("sim-rate").value) };
}

function showSimOutputs() {
  const i = simInputs();
  el("out-now").textContent = `${i.now} %`;
  el("out-watered").textContent = i.watered >= 25 ? "over a day ago" : `${i.watered} h ago`;
  el("out-rate").textContent = `${i.rate} % a day`;
}

// Twenty five hourly values, oldest first. Drying is a straight line back in
// time and a watering inside the window is a step up of 35 points.
function sliderHistory() {
  const i = simInputs();
  const perHour = i.rate / 100 / 24;
  const out = [];
  for (let k = 0; k <= 24; k++) {
    const age = 24 - k;
    let v = i.now / 100 + perHour * age;
    if (i.watered < 25 && age > i.watered) v -= 0.35;
    out.push(Math.round(Math.min(0.98, Math.max(0.02, v)) * 1000) / 1000);
  }
  return out;
}

function scenarioHourStart() {
  const hour = TIME_OF_DAY[el("sim-hour").value];
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  return d.getTime() / 1000;
}

function applyPreset(name) {
  const [nowPct, watered, rate] = PRESETS[name];
  el("sim-now").value = nowPct;
  el("sim-watered").value = watered;
  el("sim-rate").value = rate;
  simChanged(name);
}

// Any change redraws the history at once and sends it to the node a moment
// later, so dragging a slider does not flood the broker
function simChanged(preset) {
  showSimOutputs();
  document.querySelectorAll(".choice").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scenario === preset)));
  if (sim.result) sim.previous = { hourStart: sim.hourStart, result: sim.result };
  sim.result = null;
  sim.theta = sliderHistory();
  sim.hourStart = scenarioHourStart();
  renderSim();
  clearTimeout(sim.debounce);
  sim.debounce = setTimeout(runSim, 350);
}

function runSim() {
  if (!nodeReachable()) return;
  sim.id += 1;
  sim.sent = true;
  const badge = el("sim-badge");
  badge.textContent = "Running on the node";
  badge.dataset.state = "busy";
  el("sim-note").textContent = "Sent to the node.";
  client.publish(`irrigation/${NODE}/sim/set`, JSON.stringify({ id: sim.id, hour_start: sim.hourStart, theta: sim.theta }));
  clearTimeout(sim.timer);
  sim.timer = setTimeout(() => {
    if (sim.result) return;
    badge.textContent = "No answer";
    el("sim-note").textContent = "No answer from the node. Move a slider to try again.";
  }, SIM_TIMEOUT_MS);
}

function renderSim() {
  const figure = el("sim-chart");
  const hs = sim.hourStart || scenarioHourStart();
  const theta = sim.theta || sliderHistory();
  const history = theta.map((v, i) => [hs - (24 - i) * 3600, v * 100]);
  const r = sim.result;
  const predicted = r && r.ready ? r.hours.map((h, i) => [hs + h * 3600, r.levels[i] * 100]) : [];
  const prev = sim.previous;
  const previous = prev && prev.result.ready ? prev.result.hours.map((h, i) => [hs + h * 3600, prev.result.levels[i] * 100]) : [];
  const persist = [[hs, theta[24] * 100], [hs + 24 * 3600, theta[24] * 100]];
  Charts.draw(figure, {
    x: [hs - 24 * 3600, hs + 24 * 3600], y: [0, 100], step: 6, now: hs, shadeFrom: hs, relative: true,
    unit: " %", gap: 25 * 3600, snap: 3600, threshold: data.config.threshold * 100, band: data.config.threshold * 100,
    format: (v) => `${Math.round(v)}`,
    series: [
      { name: "History", cls: "soil", points: history, area: true },
      { name: "No change", cls: "persist", points: persist },
      { name: "Previous run", cls: "previous", points: previous, dots: true },
      { name: "Predicted", cls: "predicted", points: predicted, dots: true },
    ],
  });
  const kpi = el("sim-kpi"), pill = el("sim-decision"), note = el("sim-note"), time = el("sim-time");
  if (!r) {
    kpi.textContent = "–";
    pill.textContent = "Waiting";
    pill.dataset.state = "waiting";
    show(time, false);
    return;
  }
  const badge = el("sim-badge");
  delete badge.dataset.state;
  badge.textContent = "On device";
  if (!r.ready) { note.textContent = "The node could not run that history."; return; }
  if (r.crossing === 0) kpi.innerHTML = "Now";
  else if (r.crossing === null) kpi.innerHTML = `24<small>h +</small>`;
  else kpi.innerHTML = `${r.crossing.toFixed(1)}<small>h</small>`;
  pill.textContent = r.decision === "irrigate" ? "Water now" : "Hold";
  pill.dataset.state = r.decision === "irrigate" ? "irrigate" : "hold";
  const when = el("sim-hour").options[el("sim-hour").selectedIndex].text.toLowerCase();
  note.innerHTML = `Starting at ${when}: ${outlookSentence(r)}`;
  time.textContent = r.inference_ms === undefined ? "Ran on the node." : `Ran on the node in ${r.inference_ms} ms.`;
  show(time, true);
}

function renderTrained() {
  Charts.bars(el("skill-chart"), { ...TRAINED_SKILL, name: "Skill", small: true, format: (v) => v.toFixed(2) });
}

function renderSettings() {
  const c = data.config;
  const set = (id, v) => { const input = el(id); if (document.activeElement !== input) input.value = v; };
  el("auto").checked = !!c.auto;
  el("auto-text").textContent = c.auto ? "On" : "Off";
  set("threshold", Math.round(c.threshold * 100));
  set("lead", c.lead);
  set("pulse", c.pulse_s);
  set("dry", c.dry_raw);
  set("wet", c.wet_raw);
}

function renderAll() {
  if (page === "dashboard") { renderHero(); renderTraces(); }
  else if (page === "model") {
    renderCheck();
    renderSim();
    if (!sim.sent && nodeReachable()) simChanged(null);
  }
}

function publishConfig(patch) {
  client.publish(`irrigation/${NODE}/config/set`, JSON.stringify(patch));
}

function connect(password) {
  setStatus("idle", "Connecting");
  client = mqtt.connect(BROKER, { username: USER, password, clean: true, reconnectPeriod: 3000, connectTimeout: 10000 });

  client.on("connect", () => {
    localStorage.setItem("broker-password", password);
    show(el("login"), false);
    show(el("app"), true);
    client.subscribe(["state", "status", "forecast", "forecasts", "soil_hourly", "history", "config", "sim", "scores"]
      .map((s) => `irrigation/${NODE}/${s}`));
    refreshStatus();
    renderAll();
  });

  client.on("message", (topic, payload) => {
    const kind = topic.split("/").pop();
    const text = payload.toString();
    if (kind === "status") {
      nodeOnline = text === "online";
      if (!nodeOnline) relay.disabled = true;
    } else if (kind === "state") {
      lastMessage = Date.now();
      nodeOnline = true;
      data.state = JSON.parse(text);
      renderReadings(data.state);
      document.querySelectorAll(".dot").forEach((d) => {
        d.classList.remove("tick");
        void d.offsetWidth;
        d.classList.add("tick");
      });
    } else if (kind === "forecast") {
      data.forecast = JSON.parse(text);
      renderHero();
    } else if (kind === "forecasts") {
      data.forecasts = JSON.parse(text).items || [];
      if (page === "model") renderCheck();
    } else if (kind === "soil_hourly") {
      data.hourly = JSON.parse(text);
      if (page === "model") renderCheck();
    } else if (kind === "history") {
      data.history = JSON.parse(text);
      renderAll();
    } else if (kind === "config") {
      data.config = { ...data.config, ...JSON.parse(text) };
      renderSettings();
      if (data.state) renderReadings(data.state);
      renderAll();
    } else if (kind === "sim") {
      const r = JSON.parse(text);
      if (r.id === sim.id) { sim.result = r; renderSim(); }
    } else if (kind === "scores") {
      data.scores = JSON.parse(text).days || [];
      if (page === "model") renderDays();
    }
    refreshStatus();
  });

  client.on("error", (err) => {
    if (/not authorized|bad user/i.test(err.message)) {
      client.end(true);
      client = null;
      localStorage.removeItem("broker-password");
      show(el("login"), true);
      const e = el("login-error");
      e.textContent = "That password was refused. Check it and try again.";
      show(e, true);
      setStatus("idle", "Not connected");
    }
  });

  client.on("close", () => {
    if (client) setStatus("offline", "Broker connection lost, retrying");
  });
}

el("login").addEventListener("submit", (ev) => {
  ev.preventDefault();
  show(el("login-error"), false);
  connect(el("password").value);
});

relay.addEventListener("change", () => {
  relay.disabled = true;
  el("relay-text").textContent = relay.checked ? "Opening" : "Closing";
  client.publish(`irrigation/${NODE}/relay/set`, relay.checked ? "on" : "off");
});

el("auto").addEventListener("change", () => publishConfig({ auto: el("auto").checked }));
el("threshold").addEventListener("change", () => publishConfig({ threshold: Number(el("threshold").value) / 100 }));
el("lead").addEventListener("change", () => publishConfig({ lead: Number(el("lead").value) }));
el("pulse").addEventListener("change", () => publishConfig({ pulse_s: Number(el("pulse").value) }));
el("dry").addEventListener("change", () => publishConfig({ dry_raw: Number(el("dry").value) }));
el("wet").addEventListener("change", () => publishConfig({ wet_raw: Number(el("wet").value) }));

el("forget").addEventListener("click", () => {
  localStorage.removeItem("broker-password");
  location.reload();
});

el("scenarios").addEventListener("click", (ev) => {
  const b = ev.target.closest(".choice");
  if (b) applyPreset(b.dataset.scenario);
});
for (const id of ["sim-now", "sim-watered", "sim-rate"]) el(id).addEventListener("input", () => simChanged(null));
el("sim-hour").addEventListener("change", () => simChanged(null));

el("menu").addEventListener("click", () => setSide(document.body.dataset.side !== "open", true));
el("backdrop").addEventListener("click", () => setSide(false));
narrow.addEventListener("change", initSide);
window.addEventListener("hashchange", () => showPage(location.hash.slice(1)));

initSide();
showPage(location.hash.slice(1));
renderTrained();
showSimOutputs();
renderSim();
setInterval(refreshStatus, 1000);
setInterval(() => { if (data.history) renderAll(); }, 60000);

const saved = localStorage.getItem("broker-password");
if (saved) connect(saved); else show(el("login"), true);
