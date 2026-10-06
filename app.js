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
const DAY_S = 86400;
const MIN_HERO_S = 4 * 3600;
const MIN_TRACE_S = 3600;
const RUN_GAP_S = 300;
const PAGES = ["dashboard", "history", "model", "settings"];
const DAY_COLUMNS = ["t", "soil", "rain", "light", "soil_temp_x100", "air_temp_x10", "humidity_x10", "relay"];
const SIM_TIMEOUT_MS = 6000;
// the node sends a reading a second, the history ring keeps one every two minutes
const LIVE_KEEP = 900;
const REDRAW_MS = 1000;
// how long a passed watering check stays on screen, and how far past its deadline a
// check can still be waiting before it must have been cut off by a restart
const CHECK_OK_SHOW_S = 60;
const CHECK_SLACK_S = 30;
const TITLE = document.title;

// skill against persistence per horizon from the training run, all stations pooled
const TRAINED_SKILL = { labels: ["2 h", "4 h", "8 h", "16 h", "24 h"], values: [0.05, 0.08, 0.13, 0.20, 0.20] };

// 08:00, 12:00, 18:00 and midnight in Durban, as UTC hours. The node looks up the
// real weather for that hour and moves the calendar onto the training clock itself.
const TIME_OF_DAY = { morning: 6, midday: 10, evening: 16, night: 22 };
const SITE_ZONE = "Africa/Johannesburg";
// past this the node is forecasting from its stored copy rather than a fresh one
const WEATHER_STALE_S = 3 * 3600;

const el = (id) => document.getElementById(id);
const statusText = el("status-text");
const relay = el("relay");

const data = {
  state: null, forecast: null, forecasts: [], weather: null, hourly: { hours: [], raw: [] },
  history: null, live: [], days: {}, scores: [], config: { auto: false, threshold: 0.3, lead: 2, pulse_s: 10, dry_raw: 4095, wet_raw: 2548, check_s: 120, check_rise: 0.03 },
  watering: null,
};
let client = null;
let lastMessage = 0;
let lastDraw = 0;
let nodeOnline = false;
let page = "dashboard";
let dayChosen = null;
let dayCache = null;
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
  forecastAge();
  renderWatering();
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

// Links in the top bar on a wide screen, a menu that drops down on a narrow one
const narrow = matchMedia("(max-width: 760px)");

function setMenu(open) {
  document.body.dataset.menu = open ? "open" : "closed";
  el("menu").setAttribute("aria-expanded", String(open));
}

// the underline under the current page slides across to the new one
function placeMark() {
  const a = document.querySelector(".pages a[aria-current]");
  if (!a || narrow.matches) return;
  const mark = el("pages-mark");
  mark.style.width = `${a.offsetWidth}px`;
  mark.style.transform = `translateX(${a.offsetLeft}px)`;
}

function showPage(name) {
  if (!PAGES.includes(name)) name = "dashboard";
  page = name;
  document.querySelectorAll(".page").forEach((s) => show(s, s.dataset.page === name));
  document.querySelectorAll(".pages a").forEach((a) => {
    if (a.dataset.page === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  setMenu(false);
  placeMark();
  window.scrollTo(0, 0);
  renderAll();
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
  if (s.link === "usb") el("signal").textContent = "USB, through a laptop";
  else el("signal").textContent = s.ssid ? `${s.ssid}, ${s.rssi} dBm` : `Signal ${s.rssi} dBm`;
  const h = Math.floor(s.uptime_s / 3600);
  const m = Math.floor((s.uptime_s % 3600) / 60);
  el("uptime").textContent = h ? `Up ${h} h ${m} min` : `Up ${m} min`;
  el("strip-valve").textContent = s.relay ? "Valve open" : "Valve closed";
  const watered = s.last_watering || (data.forecast && data.forecast.last_watering) || 0;
  el("last-watered").textContent = watered ? `${ago((now() - watered) * 1000)}, ${clock(watered)}` : "Not yet";
  el("strip-watered").textContent = watered ? `Watered ${ago((now() - watered) * 1000)}` : "";
}

function columnPoints(src, field, scaleBy) {
  if (!src) return [];
  return src.t.map((t, i) => {
    const v = src[field][i];
    return [t, v === MISSING ? null : v / (scaleBy || 1)];
  });
}

// A state message as a row in the history's own columns
function livePoint(s) {
  const x = (v, k) => (v === undefined ? MISSING : Math.round(v * k));
  return {
    t: s.t, soil: s.soil_raw, rain: s.rain_raw, light: s.light_raw,
    soil_temp_x100: x(s.soil_temp, 100), air_temp_x10: x(s.air_temp, 10), humidity_x10: x(s.humidity, 10),
    relay: s.relay ? 1 : 0,
  };
}

function addLive(s) {
  const h = data.history;
  const since = h && h.t.length ? h.t[h.t.length - 1] : 0;
  data.live = data.live.filter((p) => p.t > since && p.t < s.t).slice(-LIVE_KEEP + 1);
  if (s.t > since) data.live.push(livePoint(s));
}

// The two minute ring with every reading since its last point on the end
function withLive() {
  const h = data.history;
  const since = h && h.t.length ? h.t[h.t.length - 1] : 0;
  const tail = data.live.filter((p) => p.t > since);
  if (!tail.length) return h;
  const out = {};
  for (const k of DAY_COLUMNS) out[k] = (h ? h[k] : []).concat(tail.map((p) => p[k]));
  return out;
}

// The dashboard shows the current run only, the readings since the last gap in the
// ring, so a reboot does not leave a broken line. Earlier runs are on History.
function currentRun() {
  const h = withLive();
  if (!h || !h.t.length) return h;
  let start = h.t.length - 1;
  while (start > 0 && h.t[start] - h.t[start - 1] <= RUN_GAP_S) start--;
  if (start === 0) return h;
  const out = {};
  for (const k of DAY_COLUMNS) out[k] = h[k].slice(start);
  return out;
}

function historyPoints(field, scaleBy) { return columnPoints(currentRun(), field, scaleBy); }

function clock(t) {
  return new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// The live charts start at the first reading inside the last twelve hours, so a
// node switched on an hour ago fills them instead of leaving most of the width empty
function firstReading(t) {
  const run = currentRun();
  const ts = run ? run.t : [];
  const first = ts.find((v) => v >= t - LOOKBACK_S);
  return first === undefined ? t : first;
}

function windowStart(t, minSpan) { return Math.min(firstReading(t), t - minSpan); }

function tickStep(span) {
  const h = span / 3600;
  return h > 14 ? 6 : h > 7 ? 3 : h > 3 ? 1 : 0.5;
}

// One sentence on where a trajectory ends up, shared by the outlook and the scenario
// saturation cannot leave 0 to 100, even if a predicted change would take it there
function clampPct(level) { return Math.min(100, Math.max(0, Math.round(level * 100))); }

function outlookSentence(f) {
  const thr = Math.round(f.threshold * 100);
  const nowPct = clampPct(f.levels[0]);
  const endPct = clampPct(f.levels[f.levels.length - 1]);
  if (f.crossing === 0) return `Below the watering level: <b>${nowPct} %</b>, waters at ${thr} %.`;
  if (f.crossing === null) return `No water needed for 24 h. <b>${nowPct} %</b> now, <b>${endPct} %</b> by then.`;
  const due = f.decision === "irrigate" ? " Within the lead time." : "";
  return `Reaches the watering level in about <b>${f.crossing.toFixed(1)} h</b>.${due}`;
}

function notReady(f) {
  if (f && f.reason === "no weather") return "No weather for this hour yet, so the models cannot run.";
  return "Waiting for the first hour of readings.";
}

function renderHero() {
  const t = now();
  const f = data.forecast;
  const measured = historyPoints("soil").map(([ts, v]) => [ts, v === null ? null : pct(v)]);
  const predicted = f && f.ready
    ? f.hours.map((h, i) => [f.at + h * 3600, f.levels[i] * 100]) : [];
  const values = measured.concat(predicted).map((p) => p[1]).filter((v) => v !== null);
  const lo = Math.min(0, ...values), hi = Math.max(100, ...values);
  const x0 = windowStart(t, MIN_HERO_S);
  const first = firstReading(t);
  el("hero-sub").textContent = first > t - LOOKBACK_S + 300 && first < t - 60
    ? `Since ${clock(first)}, next 24 h` : "Last 12 h, next 24 h";

  Charts.draw(el("soil-chart"), {
    x: [x0, t + AHEAD_S], y: [Math.floor(lo / 10) * 10, Math.ceil(hi / 10) * 10],
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
    line.textContent = notReady(f);
    kpi.textContent = "–";
    pill.textContent = "Waiting";
    pill.dataset.state = "waiting";
    show(prov, false);
    show(el("horizons"), false);
    return;
  }
  const ms = f.inference_ms === undefined ? null : `${f.inference_ms} ms`;
  // the stamp itself is kept current by forecastAge every second
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
  forecastAge();
  show(prov, true);
}

function forecastAge() {
  const f = data.forecast;
  if (!f || !f.ready) return;
  const since = Math.max(0, now() - f.at) * 1000;
  el("provisional").textContent = since < 5000 ? "Updated just now" : `Updated ${ago(since)}`;
}

// at most once a second, so a burst of messages after a reconnect draws once
function drawLive() {
  if (page !== "dashboard" || document.hidden || Date.now() - lastDraw < REDRAW_MS) return;
  lastDraw = Date.now();
  renderHero();
  renderTraces();
}

function weatherPoints(name) {
  const w = data.weather;
  return w ? w.hourly.time.map((t, i) => [t, w.hourly[name][i]]) : [];
}

// Open-Meteo stamps an hour's rain at its end, so hours after "from" up to "to"
function weatherSum(name, from, to) {
  const values = weatherPoints(name).filter(([t, v]) => t > from && t <= to && v !== null).map((p) => p[1]);
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

function weatherAt(name, t) {
  const p = weatherPoints(name).find((q) => q[0] === t);
  return p ? p[1] : null;
}

function reading(label, value, unit, digits = 0) {
  const text = value === null || value === undefined ? "–" : Number(value).toFixed(digits);
  return `<div class="wx"><span class="tile-label">${label}</span><span class="tile-value"><b>${text}</b><small>${unit}</small></span></div>`;
}

function renderWeather() {
  const w = data.weather;
  const t = now();
  const hour = Math.floor(t / 3600) * 3600;
  if (w) {
    el("weather-title").textContent = `Weather in ${w.place}`;
    const age = t - w.fetched_at;
    let text = `Updated ${ago(age * 1000)}`;
    if (w.source === "usb") text += " over USB";
    if (age > WEATHER_STALE_S) text += ", using the stored copy";
    el("weather-sub").textContent = text;
    el("weather-sub").classList.toggle("warn-text", age > WEATHER_STALE_S);
  }
  el("weather-now").innerHTML = [
    reading("Temperature", weatherAt("temperature_2m", hour), "°C", 1),
    reading("Humidity", weatherAt("relative_humidity_2m", hour), "%"),
    reading("Wind", weatherAt("wind_speed_10m", hour), "km/h", 1),
    reading("Sunlight", weatherAt("shortwave_radiation", hour), "W/m²"),
    reading("Rain, last 24 h", weatherSum("precipitation", hour - DAY_S, hour), "mm", 1),
    reading("Rain, next 24 h", weatherSum("precipitation", hour, hour + DAY_S), "mm", 1),
  ].join("");
  const charts = [["weather-temp", "temperature_2m", 1, false], ["weather-rain", "precipitation", 1, true], ["weather-sun", "shortwave_radiation", 0, true]];
  for (const [id, name, digits, fromZero] of charts) {
    const points = weatherPoints(name);
    const values = points.map((p) => p[1]).filter((v) => v !== null);
    let lo = values.length ? Math.min(...values) : 0;
    let hi = values.length ? Math.max(...values) : 1;
    const padding = Math.max((hi - lo) * 0.15, digits ? 0.5 : 5);
    lo = fromZero ? 0 : lo - padding;
    hi += padding;
    // a dry day would otherwise stretch a trace of drizzle to the top of the chart
    if (name === "precipitation") hi = Math.max(hi, 1);
    const figure = el(id);
    Charts.draw(figure, {
      x: [hour - DAY_S, hour + DAY_S], y: [lo, hi], step: 12, now: t, shadeFrom: t, small: true,
      gap: 3600, snap: 1800, format: (v) => v.toFixed(digits),
      series: [{ name: figure.dataset.title.split(",")[0], cls: "accent", points, area: fromZero }],
      empty: "Waiting for the node's weather",
    });
  }
}

function signedPoints(v) {
  if (v === null || v === undefined) return "–";
  const p = v * 100;
  return `${p >= 0 ? "+" : "\u2212"}${Math.abs(p).toFixed(1)}`;
}

function inputRow(label, text, unit) {
  return `<li><span>${label}</span><b>${text}${text === "–" ? "" : unit}</b></li>`;
}

function num(v, digits) { return v === null || v === undefined ? "–" : Number(v).toFixed(digits); }

function renderInputs() {
  const f = data.forecast;
  const box = el("input-groups");
  if (!f || !f.inputs) {
    box.innerHTML = `<p class="sub">${f ? notReady(f) : "Waiting for the node's forecast."}</p>`;
    el("change-chart").innerHTML = "";
    el("inputs-decision").textContent = "";
    return;
  }
  const v = f.inputs;
  const durban = new Date(f.t * 1000).toLocaleString([], { timeZone: SITE_ZONE, weekday: "short", hour: "2-digit", minute: "2-digit" });
  const model = new Date(f.clock * 1000);
  const modelHour = model.toLocaleTimeString([], { timeZone: "UTC", hour: "2-digit", minute: "2-digit" });
  const modelDay = model.toLocaleDateString([], { timeZone: "UTC", day: "numeric", month: "long" });
  const groups = [
    ["Soil, from the probe", [
      inputRow("Moisture now", num(v.theta_rel_5 * 100, 0), " %"),
      inputRow("Change over the last hour", signedPoints(v.theta_rel_5_diff1), " pts"),
      inputRow("over 3 hours", signedPoints(v.theta_rel_5_diff3), " pts"),
      inputRow("over 6 hours", signedPoints(v.theta_rel_5_diff6), " pts"),
      inputRow("over 24 hours", signedPoints(v.theta_rel_5_diff24), " pts"),
    ]],
    ["Weather so far", [
      inputRow("Temperature", num(v.om_temperature_2m, 1), " °C"),
      inputRow("Humidity", num(v.om_relative_humidity_2m, 0), " %"),
      inputRow("Wind", num(v.om_wind_speed_10m, 1), " km/h"),
      inputRow("Sunlight", num(v.om_shortwave_radiation, 0), " W/m²"),
      inputRow("Rain, last 3 hours", num(v.om_precip_sum3, 1), " mm"),
      inputRow("Rain, last 24 hours", num(v.om_precip_sum24, 1), " mm"),
      inputRow("Rain, last 3 days", num(v.om_precip_sum72, 1), " mm"),
      inputRow("Mean temperature, last 24 hours", num(v.om_temperature_mean24, 1), " °C"),
    ]],
    ["Weather ahead, forecast", [
      inputRow("Rain, next 2 hours", num(v.fc_precipitation_sum_h2, 1), " mm"),
      inputRow("Rain, next 8 hours", num(v.fc_precipitation_sum_h8, 1), " mm"),
      inputRow("Rain, next 24 hours", num(v.fc_precipitation_sum_h24, 1), " mm"),
      inputRow("Sunlight, next 24 hours", num(v.fc_shortwave_radiation_sum_h24 / 1000, 1), " kWh/m²"),
      inputRow("Mean temperature, next 24 hours", num(v.fc_temperature_2m_mean_h24, 1), " °C"),
      inputRow("Mean humidity, next 24 hours", num(v.fc_relative_humidity_2m_mean_h24, 0), " %"),
    ]],
    ["Clock", [
      inputRow("Durban time", durban, ""),
      inputRow("What the models are told", `${modelHour}, ${modelDay}`, ""),
    ], "Moved on 8 h and half a year to match the US training clock"],
  ];
  box.innerHTML = groups.map(([title, rows, note]) =>
    `<div class="input-group"><h3>${title}</h3><ul class="horizons">${rows.join("")}</ul>${note ? `<p class="sub">${note}</p>` : ""}</div>`).join("");
  const count = Object.keys(v).length;
  el("inputs-sub").textContent = `${count} inputs at ${clock(f.at)}`;

  if (!f.ready) {
    el("change-chart").innerHTML = "";
    el("inputs-decision").textContent = notReady(f);
    return;
  }
  const changes = f.levels.slice(1).map((level) => Math.round((level - f.levels[0]) * 1000) / 10);
  Charts.bars(el("change-chart"), {
    labels: f.hours.slice(1).map((h) => `${h} h`), values: changes, name: "Change",
    format: (x) => `${x > 0 ? "+" : x < 0 ? "\u2212" : ""}${Math.abs(x).toFixed(1)}`,
  });
  el("inputs-decision").innerHTML = `${outlookSentence(f)} Decision: <b>${f.decision === "irrigate" ? "water now" : "hold"}</b>.`;
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
    empty: "Nothing to check yet",
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
    text.textContent = "Nothing old enough to check yet";
    return;
  }
  const prov = headline.provisional ? ", provisional" : "";
  text.textContent = `2 h ahead: off by ${headline.m.toFixed(1)} pts, no change ${headline.p.toFixed(1)} (${headline.n} checked${prov})`;
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
    empty: "Nothing to check yet",
  });
}

// One row per day from the node's own scorecard, newest first
function renderDays() {
  const body = el("day-table").querySelector("tbody");
  body.innerHTML = "";
  const days = (data.scores || []).slice().sort((a, b) => b.day - a.day);
  if (!days.length) {
    body.innerHTML = `<tr><td colspan="5" class="none">No days yet</td></tr>`;
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
  const x = [windowStart(t, MIN_TRACE_S), t];
  for (const [id, field, scaleBy, asPct] of specs) {
    let points = historyPoints(field, scaleBy);
    if (asPct) points = points.map(([ts, v]) => [ts, v === null ? null : pct(v)]);
    Charts.spark(el(id), points, { x });
  }
}

const TRACE_SPECS = [
  ["soil-temp", "soil_temp_x100", 100, 1],
  ["air-temp", "air_temp_x10", 10, 1],
  ["humidity", "humidity_x10", 10, 0],
  ["light", "light", 1, 0],
  ["rain", "rain", 1, 0],
];

// a value held until the next change, so the valve draws as open or closed
// rather than a slope between the two
function stepPoints(points) {
  const out = [];
  points.forEach((p, i) => {
    if (i && points[i - 1][1] !== p[1]) out.push([p[0], points[i - 1][1]]);
    out.push(p);
  });
  return out;
}

// The small charts, drawn from a set of columns: the live twelve hour history on
// the dashboard, or one day out of the day store on the history page
function drawTraces(prefix, src, o) {
  const specs = prefix === "day-" ? TRACE_SPECS.concat([["relay", "relay", 1, 0]]) : TRACE_SPECS;
  for (const [kind, field, scaleBy, digits] of specs) {
    let points = columnPoints(src, field, scaleBy);
    const values = points.map((p) => p[1]).filter((v) => v !== null);
    let lo = values.length ? Math.min(...values) : 0;
    let hi = values.length ? Math.max(...values) : 1;
    const padding = Math.max((hi - lo) * 0.2, digits ? 0.5 : 5);
    lo -= padding; hi += padding;
    // counts and percentages cannot go below zero, so the axis should not either
    if (!digits) lo = Math.max(0, lo);
    let format = (v) => v.toFixed(digits);
    if (field === "relay") {
      points = stepPoints(points);
      lo = 0; hi = 1.25;
      format = (v) => (v >= 1 ? "Open" : v <= 0 ? "Closed" : "");
    }
    const figure = el(prefix + kind);
    Charts.draw(figure, {
      x: o.x, y: [lo, hi], step: o.step, now: o.now, small: true, gap: o.gap, snap: o.snap,
      format,
      series: [{ name: figure.dataset.title.split(",")[0], cls: "accent", points, area: true }],
      empty: o.empty,
    });
  }
}

function renderTraces() {
  renderSparks();
  const t = now();
  const x0 = windowStart(t, MIN_TRACE_S);
  drawTraces("trace-", currentRun(), { x: [x0, t], step: tickStep(t - x0), gap: 900, snap: 600, empty: "Nothing yet" });
}

function localMidnight(t) {
  const d = new Date(t * 1000);
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
}

// Every point of every day the broker holds, sorted, and the local days they cover
function allDays() {
  if (dayCache) return dayCache;
  const rows = [];
  for (const d of Object.values(data.days)) {
    d.t.forEach((t, i) => rows.push(DAY_COLUMNS.map((c) => d[c][i])));
  }
  rows.sort((a, b) => a[0] - b[0]);
  const days = [...new Set(rows.map((r) => localMidnight(r[0])))].sort((a, b) => b - a);
  dayCache = { rows, days };
  return dayCache;
}

function dayColumns(day) {
  const src = {};
  DAY_COLUMNS.forEach((c) => { src[c] = []; });
  for (const r of allDays().rows) {
    if (r[0] < day || r[0] >= day + DAY_S) continue;
    r.forEach((v, i) => src[DAY_COLUMNS[i]].push(v));
  }
  return src;
}

function dayLabel(day) {
  const today = localMidnight(now());
  if (day === today) return "Today";
  if (day === localMidnight(today - DAY_S / 2)) return "Yesterday";
  return new Date(day * 1000).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

function fillDayPicker() {
  const pick = el("day-pick");
  const days = allDays().days;
  if (!days.length) {
    pick.innerHTML = "<option>No days yet</option>";
    pick.disabled = true;
    el("day-prev").disabled = true;
    el("day-next").disabled = true;
    dayChosen = null;
    return;
  }
  pick.disabled = false;
  if (dayChosen === null || !days.includes(dayChosen)) dayChosen = days[0];
  pick.innerHTML = days.map((d) => `<option value="${d}"${d === dayChosen ? " selected" : ""}>${dayLabel(d)}</option>`).join("");
  el("day-prev").disabled = days.indexOf(dayChosen) >= days.length - 1;
  el("day-next").disabled = days.indexOf(dayChosen) <= 0;
}

function stepDay(dir) {
  const days = allDays().days;
  const i = days.indexOf(dayChosen) + dir;
  if (i < 0 || i >= days.length) return;
  dayChosen = days[i];
  renderHistory();
}

function range(points, digits, unit) {
  const values = points.map((p) => p[1]).filter((v) => v !== null);
  if (!values.length) return "";
  return `${Math.min(...values).toFixed(digits)} to ${Math.max(...values).toFixed(digits)}${unit}`;
}

function renderHistory() {
  fillDayPicker();
  const t = now();
  const day = dayChosen === null ? localMidnight(t) : dayChosen;
  const src = dayChosen === null ? null : dayColumns(day);
  const x = [day, day + DAY_S];
  const live = t >= day && t < day + DAY_S ? t : undefined;
  const empty = dayChosen === null
    ? "No days yet"
    : "Nothing recorded on this day";
  const soil = columnPoints(src, "soil").map(([ts, v]) => [ts, v === null ? null : pct(v)]);
  const values = soil.map((p) => p[1]).filter((v) => v !== null);
  const lo = Math.min(0, ...values), hi = Math.max(100, ...values);
  Charts.draw(el("day-soil"), {
    x, y: [Math.floor(lo / 10) * 10, Math.ceil(hi / 10) * 10], step: 3, now: live,
    unit: " %", gap: 1200, snap: 600, threshold: data.config.threshold * 100, band: data.config.threshold * 100,
    format: (v) => `${Math.round(v)}`,
    series: [{ name: "Measured", cls: "soil", points: soil, area: true }],
    empty,
  });
  drawTraces("day-", src, { x, step: 6, now: live, gap: 1200, snap: 600, empty });

  const summary = el("day-summary");
  if (!src || !values.length) {
    summary.innerHTML = "";
    for (const [kind] of TRACE_SPECS.concat([["relay"]])) el(`day-now-${kind}`).textContent = "";
    return;
  }
  const stepS = Object.values(data.days)[0].step_s || 300;
  const thr = data.config.threshold * 100;
  const below = values.filter((v) => v < thr).length * stepS * 1000;
  let openings = 0;
  src.relay.forEach((r, i) => { if (r && !(i && src.relay[i - 1])) openings++; });
  const wet = src.rain.filter((r) => r > RAIN_WET_ABOVE).length * stepS * 1000;
  const rows = [
    ["Readings", `${values.length}`],
    ["Soil", `${Math.round(Math.min(...values))} to ${Math.round(Math.max(...values))} %`],
    ["Watered", openings ? (openings === 1 ? "once" : `${openings} times`) : "no"],
    ["Below the level", below ? duration(below) : "never"],
  ];
  summary.innerHTML = rows.map(([k, v]) => `<li><span>${k}</span><b>${v}</b></li>`).join("");
  el("day-now-soil-temp").textContent = range(columnPoints(src, "soil_temp_x100", 100), 1, " °C");
  el("day-now-air-temp").textContent = range(columnPoints(src, "air_temp_x10", 10), 1, " °C");
  el("day-now-humidity").textContent = range(columnPoints(src, "humidity_x10", 10), 0, " %");
  el("day-now-light").textContent = range(columnPoints(src, "light"), 0, "");
  el("day-now-rain").textContent = wet ? `Wet for ${duration(wet)}` : "Dry all day";
  el("day-now-relay").textContent = openings ? `Open ${openings === 1 ? "once" : `${openings} times`}` : "Closed all day";
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

function minSec(s) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function checkDismissed(w) {
  return localStorage.getItem("check-dismissed") === String(w.opened_at);
}

function renderWatering() {
  const w = data.watering;
  const notice = el("notice");
  const line = el("check-line");
  let state = w ? w.state : "";
  let text = "";
  let short = "";
  let showNotice = false;
  if (w) {
    const t = Math.round(now());
    const deadline = w.opened_at + w.window_s;
    const rise = Math.round(w.rise * 100);
    if (state === "watching" && t > deadline + CHECK_SLACK_S) {
      state = "stale";
      short = "The last check did not finish, the node restarted during it";
    } else if (state === "watching") {
      text = `Watering. Watching for the soil to rise by ${Math.round(w.rise_needed * 100)} %, ${minSec(Math.max(0, deadline - t))} left.`;
      short = "Checking that the water arrives";
      showNotice = true;
    } else if (state === "ok") {
      text = `Water reached the soil, up ${rise} % in ${duration((w.at - w.opened_at) * 1000)}.`;
      short = `Water reached the soil, up ${rise} %`;
      showNotice = t - w.at < CHECK_OK_SHOW_S;
    } else if (state === "failed") {
      text = `The valve opened at ${clock(w.opened_at)} but the soil had not risen after ${duration(w.window_s * 1000)}. Check the tank, the pump and the tubing.`;
      short = `No rise in the soil after the watering at ${clock(w.opened_at)}`;
      showNotice = !checkDismissed(w);
    }
  }
  line.textContent = short;
  line.dataset.state = state;
  notice.dataset.state = state;
  el("notice-text").textContent = text;
  show(notice, showNotice);
  document.title = state === "failed" && showNotice ? `(!) ${TITLE}` : TITLE;
}

function notifyFailed(w) {
  if (localStorage.getItem("notify") !== "1" || !("Notification" in window) || Notification.permission !== "granted") return;
  new Notification("Water did not reach the soil", {
    body: `The valve opened at ${clock(w.opened_at)} but the soil had not risen after ${duration(w.window_s * 1000)}.`,
    tag: `check-${w.opened_at}`,
  });
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
  set("check-s", c.check_s);
  set("check-rise", Math.round(c.check_rise * 100));
  const notify = localStorage.getItem("notify") === "1";
  el("notify").checked = notify;
  el("notify-text").textContent = notify ? "On" : "Off";
}

function renderAll() {
  if (page === "dashboard") { renderHero(); renderWeather(); renderTraces(); }
  else if (page === "history") renderHistory();
  else if (page === "model") {
    renderInputs();
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
    client.subscribe(["state", "status", "forecast", "forecasts", "soil_hourly", "history", "config", "sim", "scores", "weather", "watering", "days/+"]
      .map((s) => `irrigation/${NODE}/${s}`));
    refreshStatus();
    renderAll();
  });

  client.on("message", (topic, payload) => {
    const kind = topic.split("/").pop();
    const text = payload.toString();
    if (topic.includes("/days/")) {
      data.days[kind] = JSON.parse(text);
      dayCache = null;
      if (page === "history") renderHistory();
    } else if (kind === "status") {
      nodeOnline = text === "online";
      if (!nodeOnline) relay.disabled = true;
    } else if (kind === "state") {
      lastMessage = Date.now();
      nodeOnline = true;
      data.state = JSON.parse(text);
      renderReadings(data.state);
      if (data.state.t) { addLive(data.state); drawLive(); }
      document.querySelectorAll(".dot").forEach((d) => {
        d.classList.remove("tick");
        void d.offsetWidth;
        d.classList.add("tick");
      });
    } else if (kind === "forecast") {
      data.forecast = JSON.parse(text);
      renderHero();
      const kpi = document.querySelector(".kpi");
      kpi.classList.remove("fresh");
      void kpi.offsetWidth;
      kpi.classList.add("fresh");
      if (page === "model") renderInputs();
    } else if (kind === "weather") {
      data.weather = JSON.parse(text);
      if (page === "dashboard") renderWeather();
    } else if (kind === "forecasts") {
      data.forecasts = JSON.parse(text).items || [];
      if (page === "model") renderCheck();
    } else if (kind === "soil_hourly") {
      data.hourly = JSON.parse(text);
      if (page === "model") renderCheck();
    } else if (kind === "history") {
      data.history = JSON.parse(text);
      if (data.state) addLive(data.state);
      renderAll();
    } else if (kind === "config") {
      data.config = { ...data.config, ...JSON.parse(text) };
      renderSettings();
      if (data.state) renderReadings(data.state);
      renderAll();
    } else if (kind === "watering") {
      const before = data.watering;
      data.watering = JSON.parse(text);
      // only a check seen running fires a notification, never the retained copy at load
      if (data.watering.state === "failed" && before && before.state === "watching" && before.opened_at === data.watering.opened_at) {
        notifyFailed(data.watering);
      }
      renderWatering();
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
el("check-s").addEventListener("change", () => publishConfig({ check_s: Number(el("check-s").value) }));
el("check-rise").addEventListener("change", () => publishConfig({ check_rise: Number(el("check-rise").value) / 100 }));

el("notify").addEventListener("change", async () => {
  const wanted = el("notify").checked;
  let on = wanted && "Notification" in window;
  if (on && Notification.permission !== "granted") on = (await Notification.requestPermission()) === "granted";
  localStorage.setItem("notify", on ? "1" : "0");
  renderSettings();
  if (wanted && !on) el("notify-text").textContent = "Blocked by the browser";
});

el("notice-dismiss").addEventListener("click", () => {
  if (data.watering) localStorage.setItem("check-dismissed", String(data.watering.opened_at));
  renderWatering();
});

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

el("day-pick").addEventListener("change", () => { dayChosen = Number(el("day-pick").value); renderHistory(); });
el("day-prev").addEventListener("click", () => stepDay(1));
el("day-next").addEventListener("click", () => stepDay(-1));

el("menu").addEventListener("click", () => setMenu(document.body.dataset.menu !== "open"));
el("backdrop").addEventListener("click", () => setMenu(false));
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") setMenu(false); });
narrow.addEventListener("change", () => { setMenu(false); placeMark(); });
window.addEventListener("resize", placeMark);
document.fonts.ready.then(placeMark);
window.addEventListener("hashchange", () => showPage(location.hash.slice(1)));

showPage(location.hash.slice(1));
renderTrained();
showSimOutputs();
renderSim();
setInterval(refreshStatus, 1000);
setInterval(renderAll, 60000);

const saved = localStorage.getItem("broker-password");
if (saved) connect(saved); else show(el("login"), true);
