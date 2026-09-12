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

const el = (id) => document.getElementById(id);
const status = el("status");
const statusText = el("status-text");
const dot = status.querySelector(".dot");
const relay = el("relay");

const data = {
  state: null, forecast: null, forecasts: [], hourly: { hours: [], raw: [] },
  history: null, config: { auto: false, threshold: 0.3, lead: 2, pulse_s: 10, dry_raw: 4095, wet_raw: 2548 },
};
let client = null;
let lastMessage = 0;
let nodeOnline = false;

function show(section, on) { section.hidden = !on; }

function setStatus(state, text) {
  status.dataset.state = state;
  statusText.textContent = text;
}

function ago(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} h ${m - h * 60} min ago`;
}

function refreshStatus() {
  if (!client || !client.connected) return;
  if (!lastMessage) {
    setStatus("idle", nodeOnline ? "Node online, waiting for readings" : "Waiting for the node");
    return;
  }
  const since = Date.now() - lastMessage;
  if (!nodeOnline) setStatus("offline", `Node offline, last reading ${ago(since)}`);
  else if (since > STALE_MS) setStatus("offline", `No readings for ${ago(since)}`);
  else setStatus("online", `Online, last reading ${ago(since)}`);
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

function renderReadings(s) {
  const sat = pct(s.soil_raw);
  el("soil").textContent = fmt(sat, 0);
  el("soil-fill").style.width = `${Math.max(0, Math.min(100, sat))}%`;
  el("soil-temp").textContent = fmt(s.soil_temp, 1);
  el("air-temp").textContent = fmt(s.air_temp, 1);
  el("humidity").textContent = fmt(s.humidity, 0);
  el("rain").textContent = s.rain_raw > RAIN_WET_ABOVE ? "Wet" : "Dry";
  el("light").textContent = s.light_raw;
  relay.checked = !!s.relay;
  relay.disabled = false;
  el("relay-text").textContent = s.relay ? "Open" : "Closed";
  el("signal").textContent = `Signal ${s.rssi} dBm`;
  const h = Math.floor(s.uptime_s / 3600);
  const m = Math.floor((s.uptime_s % 3600) / 60);
  el("uptime").textContent = h ? `Up ${h} h ${m} min` : `Up ${m} min`;
}

function historyPoints(field, scaleBy) {
  const h = data.history;
  if (!h) return [];
  return h.t.map((t, i) => {
    const v = h[field][i];
    return [t, v === MISSING ? null : v / (scaleBy || 1)];
  });
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
    step: 6, now: t, unit: " %", gap: 900, snap: 3600,
    threshold: data.config.threshold * 100,
    format: (v) => `${Math.round(v)}`,
    series: [
      { name: "Measured", cls: "observed", points: measured },
      { name: "Predicted", cls: "predicted", points: predicted, dots: true },
    ],
    empty: "Waiting for the node's first readings",
  });

  const line = el("countdown");
  const prov = el("provisional");
  if (!f || !f.ready) {
    line.textContent = "Waiting for the first hour of readings before the model can run.";
    show(prov, false);
    return;
  }
  const thr = Math.round(f.threshold * 100);
  const nowPct = Math.round(f.levels[0] * 100);
  const endPct = Math.round(f.levels[f.levels.length - 1] * 100);
  if (f.crossing === 0) {
    line.innerHTML = `The soil is already below the watering threshold, <b>${nowPct} %</b> against ${thr} %.`;
  } else if (f.crossing === null) {
    line.innerHTML = `Stays above the threshold for the next 24 hours. The model expects <b>${nowPct} %</b> to become <b>${endPct} %</b> by then.`;
  } else {
    const due = f.decision === "irrigate" ? " That is inside the lead time, so watering is due." : "";
    line.innerHTML = `Reaches the watering threshold in about <b>${f.crossing.toFixed(1)} h</b>.${due}`;
  }
  let note = "";
  if (f.inference_ms !== undefined) {
    note = `Computed on the ESP32 at ${new Date(f.at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, five models in ${f.inference_ms} ms.`;
  }
  if (!f.full) {
    note += `${note ? " " : ""}Built on ${f.history_hours} of the 24 hours of history the model was trained with, so the trajectory is provisional until tomorrow.`;
  }
  if (f.last_watering) {
    note += `${note ? " " : ""}Last watered ${ago((t - f.last_watering) * 1000)}.`;
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
      { name: "Measured", cls: "observed", points: measured, dots: true },
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

  const text = el("skill-text");
  if (!headline) {
    text.textContent = "Every hour the node records what it expects the soil to do. Once that hour has passed, the forecast is compared with what the probe measured, and with the simplest alternative of assuming nothing changes. Nothing is old enough to check yet.";
    return;
  }
  const verdict = headline.skill > 0
    ? `That is a skill of ${headline.skill.toFixed(2)}, where 1 would be perfect and 0 would be no better than assuming no change.`
    : `That is a skill of ${headline.skill.toFixed(2)}, so the model has not beaten the no-change guess yet.`;
  const prov = headline.provisional ? " These forecasts were made with less than a day of history." : "";
  text.textContent = `Over ${headline.n} checked two hour forecasts the model was off by ${headline.m.toFixed(1)} points of saturation on average, against ${headline.p.toFixed(1)} for assuming nothing changes. ${verdict}${prov}`;
}

function renderTraces() {
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
    const figure = el(id);
    Charts.draw(figure, {
      x: [t - LOOKBACK_S, t], y: [lo, hi], step: 4, small: true, gap: 900, snap: 600,
      title: figure.dataset.title, format: (v) => v.toFixed(digits),
      series: [{ name: figure.dataset.title.split(",")[0], cls: "observed", points }],
      empty: "Nothing yet",
    });
  }
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
  renderHero();
  renderCheck();
  renderTraces();
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
    client.subscribe(["state", "status", "forecast", "forecasts", "soil_hourly", "history", "config"]
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
      dot.classList.remove("tick");
      void dot.offsetWidth;
      dot.classList.add("tick");
    } else if (kind === "forecast") {
      data.forecast = JSON.parse(text);
      renderHero();
    } else if (kind === "forecasts") {
      data.forecasts = JSON.parse(text).items || [];
      renderCheck();
    } else if (kind === "soil_hourly") {
      data.hourly = JSON.parse(text);
      renderCheck();
    } else if (kind === "history") {
      data.history = JSON.parse(text);
      renderHero();
      renderTraces();
    } else if (kind === "config") {
      data.config = { ...data.config, ...JSON.parse(text) };
      renderSettings();
      if (data.state) renderReadings(data.state);
      renderAll();
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

setInterval(refreshStatus, 1000);
setInterval(() => { if (data.history) renderAll(); }, 60000);

const saved = localStorage.getItem("broker-password");
if (saved) connect(saved); else show(el("login"), true);
