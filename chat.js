// The assistant. It runs in this page and calls Fireworks directly with a key kept in
// this browser, so the key is never in the repository or on the broker. Tools act on
// the same data and broker connection as the rest of the dashboard.
const CHAT_URL = "https://api.fireworks.ai/inference/v1/chat/completions";
const CHAT_MODEL = "accounts/fireworks/models/gpt-oss-120b";
const CHAT_KEEP = 16;
const CHAT_ROUNDS = 5;
const KEY_STORE = "fireworks-key";
const SEEN_STORE = "chat-seen";
// a valve that has not answered within this long after a command is shown as waiting
const VALVE_PENDING_MS = 4000;
const OFFLINE_AFTER_MS = 30000;
const RAIN_NOTE_MM = 2;

const chat = {
  history: [], busy: false, unread: 0, typing: null, valve: null,
  reachable: null, unreachableSince: 0, decision: null, greeted: false,
};

const SETTINGS = {
  threshold: { label: "Watering level", unit: " %", scale: 100, min: 5, max: 95 },
  lead: { label: "Lead time", unit: " h", scale: 1, min: 1, max: 24 },
  pulse_s: { label: "Watering pulse", unit: " s", scale: 1, min: 1, max: 120 },
  auto: { label: "Automatic watering", bool: true },
  check_s: { label: "Watering check wait", unit: " s", scale: 1, min: 10, max: 1800 },
  check_rise: { label: "Rise that counts as watered", unit: " %", scale: 100, min: 1, max: 50 },
};

const TOOLS = [
  ["water", "Open the valve to water the plant for a number of seconds. The node closes it itself.",
    { seconds: { type: "integer", description: "1 to 600. Leave out to use the node's pulse length." } }],
  ["set_valve", "Open the valve and leave it open, or close it.", { open: { type: "boolean" } }, ["open"]],
  ["get_readings", "Latest sensor readings, shown as tiles.",
    { only: { type: "array", items: { type: "string", enum: ["soil", "soil_temp", "air_temp", "humidity", "rain", "light"] },
      description: "Which readings to show. Leave out for all." } }],
  ["get_forecast", "The node's soil moisture forecast for the next 24 hours, the time until the watering level and the decision."],
  ["get_weather", "Open-Meteo weather at the site now and for the next 24 hours."],
  ["get_model_inputs", "The inputs the models were given for the live forecast and the change each horizon model predicts. Use to explain what the ML model is doing."],
  ["get_accuracy", "How far off the live forecasts were against what the probe later measured, by horizon, with skill against no change."],
  ["get_history", "Summary of one past day: soil range, waterings, time below the watering level.",
    { day: { type: "string", description: "today, yesterday, or YYYY-MM-DD" } }],
  ["update_setting", "Change a node setting. Percentages are whole numbers.",
    { name: { type: "string", enum: Object.keys(SETTINGS) }, value: { type: ["number", "boolean"] } }, ["name", "value"]],
  ["go_to_page", "Show a page of the dashboard.", { page: { type: "string", enum: PAGES } }, ["page"]],
].map(([name, description, properties = {}, required = []]) =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } }));

function chatKey() {
  try { return localStorage.getItem(KEY_STORE) || ""; } catch { return ""; }
}

function seen(key) {
  try { return JSON.parse(localStorage.getItem(SEEN_STORE) || "[]").includes(key); } catch { return false; }
}

function markSeen(key) {
  try {
    const list = JSON.parse(localStorage.getItem(SEEN_STORE) || "[]").filter((k) => k !== key);
    list.push(key);
    localStorage.setItem(SEEN_STORE, JSON.stringify(list.slice(-50)));
  } catch { /* private window, repeats are harmless */ }
}

function esc(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function inline(text) {
  return esc(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
}

// Paragraphs, bold, code and lists, which is all the replies are asked to use
function markdown(text) {
  const blocks = [];
  let list = null;
  for (const raw of text.trim().split("\n")) {
    const line = raw.trim();
    const item = line.match(/^([-*•]|\d+[.)])\s+(.*)$/);
    if (item) {
      const tag = /\d/.test(item[1]) ? "ol" : "ul";
      if (!list || list.tag !== tag) { list = { tag, items: [] }; blocks.push(list); }
      list.items.push(inline(item[2]));
      continue;
    }
    list = null;
    if (line) blocks.push(`<p>${inline(line.replace(/^#+\s*/, ""))}</p>`);
  }
  return blocks.map((b) => (typeof b === "string" ? b : `<${b.tag}>${b.items.map((i) => `<li>${i}</li>`).join("")}</${b.tag}>`)).join("");
}

function scrollChat() {
  const log = el("chat-log");
  log.scrollTop = log.scrollHeight;
}

function addNode(node) {
  const log = el("chat-log");
  if (chat.typing && chat.typing.parentNode === log) log.insertBefore(node, chat.typing);
  else log.appendChild(node);
  scrollChat();
  return node;
}

function addMessage(kind, html) {
  const div = document.createElement("div");
  div.className = `msg ${kind}`;
  div.innerHTML = html;
  return addNode(div);
}

function addCard(card) {
  const wrap = document.createElement("div");
  wrap.className = "msg card-msg";
  wrap.appendChild(card);
  return addNode(wrap);
}

function cardFrom(html, cls) {
  const div = document.createElement("div");
  div.className = `cc ${cls || ""}`;
  div.innerHTML = html;
  return div;
}

function head(title, sub) {
  return `<div class="cc-head"><span class="cc-title">${esc(title)}</span><span class="cc-sub">${esc(sub || "")}</span></div>`;
}

// A message the page writes itself. It goes into the history too, so a follow up
// question like "why?" has something to refer to.
function post(text, card) {
  addMessage("bot", markdown(text));
  if (card) addCard(card);
  chat.history.push({ role: "assistant", content: text });
  if (document.body.dataset.chat !== "open") {
    chat.unread += 1;
    el("chat-unread").textContent = String(chat.unread);
    show(el("chat-unread"), true);
  }
}

function setChatOpen(open) {
  document.body.dataset.chat = open ? "open" : "closed";
  el("chat").dataset.open = String(open);
  el("chat-open").setAttribute("aria-expanded", String(open));
  el("chat-open").setAttribute("aria-label", open ? "Close the assistant" : "Open the assistant");
  if (!open) return;
  chat.unread = 0;
  show(el("chat-unread"), false);
  if (!chatKey() && !el("chat-log").querySelector(".key-note")) {
    addMessage("note key-note", 'Add a Fireworks key in <a href="#settings">Settings</a> to chat.');
  }
  scrollChat();
  if (!narrow.matches) el("chat-input").focus();
}

function setBusy(busy) {
  chat.busy = busy;
  el("chat-send").disabled = busy;
  const h = document.querySelector(".chat-head");
  if (busy) h.dataset.busy = ""; else delete h.dataset.busy;
  el("chat-sub").textContent = busy ? "Thinking" : "Ask about the plant or tell it what to do";
  if (busy) {
    chat.typing = document.createElement("div");
    chat.typing.className = "msg bot typing";
    chat.typing.innerHTML = "<i></i><i></i><i></i>";
    el("chat-log").appendChild(chat.typing);
    scrollChat();
  } else if (chat.typing) {
    chat.typing.remove();
    chat.typing = null;
  }
}

function soilNow() {
  return data.state ? Math.round(pct(data.state.soil_raw)) : null;
}

function snapshot() {
  const s = data.state, f = data.forecast, c = data.config, w = data.watering;
  const watered = (s && s.last_watering) || (f && f.last_watering) || 0;
  return {
    now: new Date().toString(),
    node_online: nodeReachable(),
    soil_moisture_pct: soilNow(),
    valve: s ? (s.relay ? "open" : "closed") : "unknown",
    last_watered: watered ? `${clock(watered)}, ${ago((now() - watered) * 1000)}` : "not yet",
    forecast: f && f.ready
      ? { decision: f.decision, hours_until_watering_level: f.crossing, computed: clock(f.at) }
      : (f ? notReady(f) : "none yet"),
    settings: {
      watering_level_pct: Math.round(c.threshold * 100), lead_h: c.lead, pulse_s: c.pulse_s, auto: c.auto,
      check_wait_s: c.check_s, check_rise_pct: Math.round(c.check_rise * 100),
    },
    last_watering_check: w ? { state: w.state, valve_opened: clock(w.opened_at), rise_pct: Math.round(w.rise * 100) } : "none",
  };
}

function systemPrompt() {
  return `You are the assistant built into the dashboard of a small smart irrigation node. You can read its live data and control its valve and settings through tools.
${KNOWLEDGE}
How to answer:
- Keep replies short, one to three sentences, unless the user asks for an explanation. Plain language.
- Every tool draws a card in the chat with its numbers, so do not list them all again. Say what they mean.
- Call the matching tool whenever the user asks about readings, the forecast, the weather, the model, accuracy or a past day, even if the number is in the live state below, so the card is shown.
- To water, call water. Use the seconds the user gives, otherwise leave seconds out. Say watering has started, not that it is done. The card shows the countdown and whether the water reached the soil.
- Never say an action happened unless the tool result says ok. If the node is offline, say so.
- No markdown tables or headings. Short bullet lists are fine. Soil moisture percentages are relative saturation.

Live state:
${JSON.stringify(snapshot())}`;
}

function trimmed() {
  const h = chat.history.slice(-CHAT_KEEP);
  while (h.length && h[0].role !== "user") h.shift();
  return h;
}

async function complete(messages, extra) {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${chatKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: CHAT_MODEL, messages, reasoning_effort: "low", temperature: 0.3, max_tokens: 1500, ...extra }),
  });
  if (res.status === 401 || res.status === 403) throw new Error("Fireworks refused the key. Check it in Settings.");
  if (res.status === 429) throw new Error("Too many requests. Wait a moment and try again.");
  if (!res.ok) throw new Error(`Fireworks answered ${res.status}.`);
  return (await res.json()).choices[0].message;
}

async function send(text) {
  text = text.trim();
  if (chat.busy || !text) return;
  addMessage("user", esc(text));
  chat.history.push({ role: "user", content: text });
  if (!chatKey()) {
    addMessage("note", 'Add a Fireworks key in <a href="#settings">Settings</a> first.');
    return;
  }
  setBusy(true);
  try {
    for (let round = 0; round < CHAT_ROUNDS; round++) {
      const m = await complete([{ role: "system", content: systemPrompt() }, ...trimmed()], { tools: TOOLS });
      const calls = m.tool_calls || [];
      const content = (m.content || "").trim();
      chat.history.push(calls.length ? { role: "assistant", content, tool_calls: calls } : { role: "assistant", content });
      if (content) addMessage("bot", markdown(content));
      if (!calls.length) break;
      for (const call of calls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* treated as no arguments */ }
        let out;
        try { out = runTool(call.function.name, args); } catch (e) { out = { result: { ok: false, error: e.message } }; }
        if (out.card) addCard(out.card);
        chat.history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out.result) });
      }
    }
  } catch (e) {
    addMessage("error", esc(e.message === "Failed to fetch" ? "Could not reach Fireworks. Check the internet connection." : e.message));
  } finally {
    setBusy(false);
  }
}

function canAct() {
  if (!client || !client.connected) return "The page is not connected to the broker.";
  if (!nodeReachable()) return "The node is offline.";
  return null;
}

function publishRelay(payload) {
  client.publish(`irrigation/${NODE}/relay/set`, String(payload));
}

function runTool(name, a) {
  const tool = {
    water: toolWater, set_valve: toolValve, get_readings: toolReadings, get_forecast: toolForecast,
    get_weather: toolWeather, get_model_inputs: toolInputs, get_accuracy: toolAccuracy,
    get_history: toolHistory, update_setting: toolSetting, go_to_page: toolPage,
  }[name];
  if (!tool) return { result: { ok: false, error: `no tool called ${name}` } };
  return tool(a || {});
}

function toolWater(a) {
  const problem = canAct();
  if (problem) return { result: { ok: false, error: problem } };
  const seconds = Math.round(Math.min(600, Math.max(1, Number(a.seconds) || data.config.pulse_s)));
  publishRelay(seconds);
  return { result: { ok: true, seconds, note: "The valve is opening. The node closes it and checks the soil rises." }, card: valveCard(seconds) };
}

function toolValve(a) {
  const problem = canAct();
  if (problem) return { result: { ok: false, error: problem } };
  publishRelay(a.open ? "on" : "off");
  return { result: { ok: true, valve: a.open ? "opening, stays open until closed" : "closing" }, card: valveCard(null, !!a.open) };
}

// The valve card follows the node: the ring counts down the time the node reports
// it has left, the switch is the valve, and the watering check lands at the bottom.
// Only the newest one stays live.
function valveCard(seconds, open = true) {
  if (chat.valve) chat.valve.card.dataset.live = "false";
  const ring = 2 * Math.PI * 33;
  const card = cardFrom(`
    ${head(seconds ? "Watering" : "Valve", seconds ? `${seconds} s from ${clock(now())}` : clock(now()))}
    <div class="ring"><svg viewBox="0 0 78 78"><circle class="ring-bg" cx="39" cy="39" r="33"/><circle class="ring-fg" cx="39" cy="39" r="33" stroke-dasharray="${ring.toFixed(1)}" stroke-dashoffset="0"/></svg>
      <div class="ring-text"><b>${seconds || "–"}</b><small>${seconds ? "s left" : ""}</small></div></div>
    <label class="switch"><input type="checkbox" ${open ? "checked" : ""}><span class="track" aria-hidden="true"></span><span class="sw-text">${open ? "Opening" : "Closing"}</span></label>
    <p class="cc-check"></p>`, "cc-valve");
  card.dataset.live = "true";
  const v = { card, seconds, ring, sentAt: Date.now(), since: now() - 2, wanted: open };
  card.querySelector("input").addEventListener("change", (ev) => {
    if (card.dataset.live !== "true" || canAct()) { ev.target.checked = !ev.target.checked; return; }
    v.wanted = ev.target.checked;
    v.sentAt = Date.now();
    if (v.wanted) { v.since = now() - 2; publishRelay(v.seconds || "on"); } else publishRelay("off");
    updateValve();
  });
  chat.valve = v;
  updateValve();
  return card;
}

function updateValve() {
  const v = chat.valve;
  if (!v) return;
  const s = data.state;
  const open = !!(s && s.relay);
  const pending = Date.now() - v.sentAt < VALVE_PENDING_MS && open !== v.wanted;
  const input = v.card.querySelector("input");
  input.checked = pending ? v.wanted : open;
  v.card.querySelector(".sw-text").textContent = pending ? (v.wanted ? "Opening" : "Closing") : open ? "Open" : "Closed";
  const text = v.card.querySelector(".ring-text");
  const fg = v.card.querySelector(".ring-fg");
  let fraction = open ? 1 : 0;
  if (pending && v.wanted) {
    text.innerHTML = v.seconds ? `<b>${v.seconds}</b><small>s left</small>` : "<b>…</b>";
    fraction = 1;
  } else if (open && s.relay_left_s !== undefined && v.seconds) {
    const left = Math.max(0, Math.round(s.relay_left_s - (Date.now() - lastMessage) / 1000));
    text.innerHTML = `<b>${left}</b><small>s left</small>`;
    fraction = left / v.seconds;
  } else {
    text.innerHTML = open ? "<b>Open</b>" : "<b>Done</b><small>closed</small>";
    if (!v.seconds && !open) text.innerHTML = "<b>Closed</b>";
  }
  fg.setAttribute("stroke-dashoffset", (v.ring * (1 - Math.min(1, fraction))).toFixed(1));

  const line = v.card.querySelector(".cc-check");
  const w = data.watering;
  if (!w || w.opened_at < v.since) { line.textContent = ""; return; }
  line.dataset.state = w.state;
  const t = Math.round(now());
  if (w.state === "watching") line.textContent = `Checking the soil rises, ${minSec(Math.max(0, w.opened_at + w.window_s - t))} left`;
  else if (w.state === "ok") line.textContent = `Water reached the soil, up ${Math.round(w.rise * 100)} %`;
  else if (w.state === "failed") line.textContent = "The soil did not rise. Check the tank, pump and tubing.";
}

const READINGS = {
  soil: ["Soil moisture", "%", "soil", "soil", 1, true, (s) => fmt(pct(s.soil_raw), 0)],
  soil_temp: ["Soil temperature", "°C", "soil-temp", "soil_temp_x100", 100, false, (s) => fmt(s.soil_temp, 1)],
  air_temp: ["Air temperature", "°C", "air-temp", "air_temp_x10", 10, false, (s) => fmt(s.air_temp, 1)],
  humidity: ["Humidity", "%", "humidity", "humidity_x10", 10, false, (s) => fmt(s.humidity, 0)],
  rain: ["Rain plate", "", "rain", "rain", 1, false, (s) => (s.rain_raw > RAIN_WET_ABOVE ? "Wet" : "Dry")],
  light: ["Light", "/ 4095", "light", "light", 1, false, (s) => String(s.light_raw)],
};

function toolReadings(a) {
  const s = data.state;
  if (!s) return { result: { ok: false, error: "No readings from the node yet." } };
  const keys = (Array.isArray(a.only) && a.only.filter((k) => READINGS[k]).length ? a.only.filter((k) => READINGS[k]) : Object.keys(READINGS));
  const result = { ok: true, at: clock(s.t), node_online: nodeReachable() };
  const tiles = keys.map((k) => {
    const [label, unit, kind] = READINGS[k];
    result[k] = `${READINGS[k][6](s)} ${unit}`.trim();
    return `<div class="tile" data-kind="${kind}"><span class="tile-label">${label}</span><span class="tile-value"><b>${READINGS[k][6](s)}</b><small>${unit}</small></span><figure class="spark" data-key="${k}"></figure></div>`;
  });
  const card = cardFrom(`${head("Readings", `at ${clock(s.t)}`)}<div class="tiles">${tiles.join("")}</div>`);
  const t = now();
  card.querySelectorAll(".spark").forEach((fig) => {
    const [, , , field, scaleBy, asPct] = READINGS[fig.dataset.key];
    let points = historyPoints(field, scaleBy);
    if (asPct) points = points.map(([ts, v]) => [ts, v === null ? null : pct(v)]);
    Charts.spark(fig, points, { x: [windowStart(t, MIN_TRACE_S), t] });
  });
  return { result, card };
}

function forecastChart(fig) {
  const t = now();
  const f = data.forecast;
  const measured = historyPoints("soil").map(([ts, v]) => [ts, v === null ? null : pct(v)]);
  const predicted = f && f.ready ? f.hours.map((h, i) => [f.at + h * 3600, f.levels[i] * 100]) : [];
  Charts.draw(fig, {
    x: [windowStart(t, MIN_HERO_S), t + AHEAD_S], y: [0, 100], step: 6, now: t, shadeFrom: t, unit: " %",
    gap: 900, snap: 3600, small: true, threshold: data.config.threshold * 100, band: data.config.threshold * 100,
    format: (v) => `${Math.round(v)}`,
    series: [
      { name: "Measured", cls: "soil", points: measured, area: true },
      { name: "Predicted", cls: "predicted", points: predicted, dots: true, gap: 9 * 3600 },
    ],
    empty: "No readings yet",
  });
}

function toolForecast() {
  const f = data.forecast;
  if (!f || !f.ready) return { result: { ok: false, error: f ? notReady(f) : "No forecast from the node yet." } };
  const kpi = f.crossing === 0 ? "Now" : f.crossing === null ? "24<small>h +</small>" : `${f.crossing.toFixed(1)}<small>h</small>`;
  const water = f.decision === "irrigate";
  const card = cardFrom(`${head("Soil forecast", `updated ${clock(f.at)}`)}
    <div class="kpi-line"><span class="kpi-value">${kpi}</span><span class="pill" data-state="${water ? "irrigate" : "hold"}">${water ? "Water now" : "Hold"}</span></div>
    <span class="cc-sub">until the watering level of ${Math.round(f.threshold * 100)} %</span>
    <figure class="chart small"></figure>`, "cc-forecast");
  forecastChart(card.querySelector("figure"));
  return {
    result: {
      ok: true, decision: f.decision, hours_until_watering_level: f.crossing, watering_level_pct: Math.round(f.threshold * 100),
      lead_h: f.lead, levels_pct: Object.fromEntries(f.hours.map((h, i) => [`${h}h`, clampPct(f.levels[i])])),
    },
    card,
  };
}

function toolWeather() {
  const w = data.weather;
  if (!w) return { result: { ok: false, error: "The node has no weather yet." } };
  const t = now();
  const hour = Math.floor(t / 3600) * 3600;
  const result = {
    ok: true, place: w.place, fetched: ago((t - w.fetched_at) * 1000),
    temperature_c: weatherAt("temperature_2m", hour), humidity_pct: weatherAt("relative_humidity_2m", hour),
    wind_kmh: weatherAt("wind_speed_10m", hour), sunlight_wm2: weatherAt("shortwave_radiation", hour),
    rain_last_24h_mm: weatherSum("precipitation", hour - DAY_S, hour), rain_next_24h_mm: weatherSum("precipitation", hour, hour + DAY_S),
  };
  for (const k of ["rain_last_24h_mm", "rain_next_24h_mm"]) if (result[k] !== null) result[k] = Math.round(result[k] * 10) / 10;
  const card = cardFrom(`${head(`Weather in ${w.place}`, `updated ${ago((t - w.fetched_at) * 1000)}`)}
    <div class="weather-now">${[
      reading("Temperature", result.temperature_c, "°C", 1),
      reading("Humidity", result.humidity_pct, "%"),
      reading("Wind", result.wind_kmh, "km/h", 0),
      reading("Sunlight", result.sunlight_wm2, "W/m²"),
      reading("Rain, past day", result.rain_last_24h_mm, "mm", 1),
      reading("Rain, next day", result.rain_next_24h_mm, "mm", 1),
    ].join("")}</div><figure class="chart small" style="--accent: var(--air-temp)" data-title="Temperature, °C"></figure>`);
  const points = weatherPoints("temperature_2m");
  const values = points.map((p) => p[1]).filter((v) => v !== null);
  const lo = values.length ? Math.min(...values) - 1 : 0, hi = values.length ? Math.max(...values) + 1 : 1;
  Charts.draw(card.querySelector("figure"), {
    x: [hour - DAY_S, hour + DAY_S], y: [lo, hi], step: 12, now: t, shadeFrom: t, small: true, gap: 3600, snap: 1800,
    format: (v) => v.toFixed(1), series: [{ name: "Temperature", cls: "accent", points }], empty: "No weather",
  });
  return { result, card };
}

function toolInputs() {
  const f = data.forecast;
  if (!f || !f.inputs) return { result: { ok: false, error: f ? notReady(f) : "No forecast from the node yet." } };
  const v = f.inputs;
  const rows = [
    ["Moisture now", `${num(v.theta_rel_5 * 100, 0)} %`],
    ["Change, last hour", `${signedPoints(v.theta_rel_5_diff1)} pts`],
    ["Change, last 24 h", `${signedPoints(v.theta_rel_5_diff24)} pts`],
    ["Temperature", `${num(v.om_temperature_2m, 1)} °C`],
    ["Sunlight", `${num(v.om_shortwave_radiation, 0)} W/m²`],
    ["Rain, last 24 h", `${num(v.om_precip_sum24, 1)} mm`],
    ["Rain forecast, next 24 h", `${num(v.fc_precipitation_sum_h24, 1)} mm`],
  ];
  const card = cardFrom(`${head("What the models saw", `${Object.keys(v).length} inputs at ${clock(f.at)}`)}
    <ul class="horizons">${rows.map(([k, x]) => `<li><span>${k}</span><b>${x}</b></li>`).join("")}</ul>
    <figure class="chart small"></figure>`);
  const changes = f.ready ? f.levels.slice(1).map((level) => Math.round((level - f.levels[0]) * 1000) / 10) : [];
  if (f.ready) {
    Charts.bars(card.querySelector("figure"), {
      labels: f.hours.slice(1).map((h) => `${h} h`), values: changes, name: "Change", small: true,
      format: (x) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(1)}`,
    });
  }
  const result = { ok: true, computed: clock(f.at), inference_ms: f.inference_ms, predicted_change_pts: Object.fromEntries(f.hours.slice(1).map((h, i) => [`${h}h`, changes[i]])) };
  for (const [k, x] of rows) result[k] = x;
  return { result, card };
}

function toolAccuracy() {
  const pairs = verification();
  const rows = HORIZONS.map((h) => {
    const full = pairs[h].filter((r) => r.full);
    const use = full.length ? full : pairs[h];
    if (!use.length) return { h, n: 0 };
    const m = rmse(use, "predicted"), p = rmse(use, "persisted");
    return { h, n: use.length, model: m, none: p, skill: p > 0 ? 1 - (m * m) / (p * p) : 0 };
  });
  if (!rows.some((r) => r.n)) return { result: { ok: false, error: "No forecast is old enough to check yet." } };
  const card = cardFrom(`${head("How the forecasts did", "last three days")}
    <table><thead><tr><th>Ahead</th><th>Checked</th><th>Model</th><th>No change</th><th>Skill</th></tr></thead><tbody>${rows.map((r) => (r.n
      ? `<tr><td>${r.h} h</td><td>${r.n}</td><td>${r.model.toFixed(1)}</td><td>${r.none.toFixed(1)}</td><td class="${r.skill < 0 ? "neg" : ""}">${r.skill.toFixed(2)}</td></tr>`
      : `<tr><td>${r.h} h</td><td class="none" colspan="4">none yet</td></tr>`)).join("")}</tbody></table>`);
  const result = { ok: true, error_unit: "points of soil moisture" };
  for (const r of rows) result[`${r.h}h`] = r.n ? { checked: r.n, model_error: +r.model.toFixed(2), no_change_error: +r.none.toFixed(2), skill: +r.skill.toFixed(2) } : "none yet";
  return { result, card };
}

function toolHistory(a) {
  const days = allDays().days;
  if (!days.length) return { result: { ok: false, error: "No days recorded yet." } };
  const today = localMidnight(now());
  let day = today;
  if (a.day === "yesterday") day = localMidnight(today - DAY_S / 2);
  else if (a.day && /^\d{4}-\d{2}-\d{2}$/.test(a.day)) day = localMidnight(new Date(`${a.day}T12:00:00`).getTime() / 1000);
  if (!days.includes(day)) return { result: { ok: false, error: `Nothing recorded on that day. Days held: ${days.map(dayLabel).join(", ")}` } };
  const src = dayColumns(day);
  const soil = src.soil.map(pct);
  let openings = 0;
  src.relay.forEach((r, i) => { if (r && !(i && src.relay[i - 1])) openings++; });
  const stepS = Object.values(data.days)[0].step_s || 300;
  const below = soil.filter((v) => v < data.config.threshold * 100).length * stepS * 1000;
  const result = {
    ok: true, day: dayLabel(day), readings: soil.length,
    soil_min_pct: Math.round(Math.min(...soil)), soil_max_pct: Math.round(Math.max(...soil)),
    waterings: openings, time_below_watering_level: below ? duration(below) : "never",
  };
  const card = cardFrom(`${head(dayLabel(day), `${soil.length} readings`)}<ul class="horizons">
    <li><span>Soil</span><b>${result.soil_min_pct} to ${result.soil_max_pct} %</b></li>
    <li><span>Watered</span><b>${openings ? (openings === 1 ? "once" : `${openings} times`) : "no"}</b></li>
    <li><span>Below the watering level</span><b>${result.time_below_watering_level}</b></li></ul>`);
  return { result, card };
}

function settingText(spec, nodeValue) {
  if (spec.bool) return nodeValue ? "on" : "off";
  return `${Math.round(nodeValue * spec.scale)}${spec.unit}`;
}

function toolSetting(a) {
  const spec = SETTINGS[a.name];
  if (!spec) return { result: { ok: false, error: `unknown setting ${a.name}` } };
  if (!client || !client.connected) return { result: { ok: false, error: "The page is not connected to the broker." } };
  let value;
  if (spec.bool) value = a.value === true || a.value === "true";
  else {
    const n = Number(a.value);
    if (!Number.isFinite(n) || n < spec.min || n > spec.max) return { result: { ok: false, error: `${spec.label} must be ${spec.min} to ${spec.max}${spec.unit}` } };
    value = n / spec.scale;
  }
  const before = data.config[a.name];
  publishConfig({ [a.name]: value });
  const card = cardFrom(`<div class="cc-setting"><span>${spec.label}: ${esc(settingText(spec, before))} → <b>${esc(settingText(spec, value))}</b></span><button type="button" class="quiet-button">Undo</button></div>`);
  card.querySelector("button").addEventListener("click", (ev) => {
    publishConfig({ [a.name]: before });
    ev.target.disabled = true;
    ev.target.textContent = "Undone";
  }, { once: true });
  return { result: { ok: true, setting: spec.label, from: settingText(spec, before), to: settingText(spec, value) }, card };
}

function toolPage(a) {
  if (!PAGES.includes(a.page)) return { result: { ok: false, error: "no such page" } };
  location.hash = a.page;
  return { result: { ok: true, showing: a.page } };
}

// Messages the page sends on its own, worded here rather than by the model so they
// cost nothing and arrive with the chat closed. Each one is sent once.
function watchEvents() {
  const reachable = nodeReachable();
  if (chat.reachable && !reachable) {
    if (!chat.unreachableSince) chat.unreachableSince = Date.now();
    if (Date.now() - chat.unreachableSince > OFFLINE_AFTER_MS && !chat.offlineSaid) {
      chat.offlineSaid = true;
      post(`The node went offline at ${clock(now() - OFFLINE_AFTER_MS / 1000)}. Readings and watering from here are paused until it is back.`);
    }
  } else if (reachable) {
    if (chat.offlineSaid) post("The node is back online.");
    chat.offlineSaid = false;
    chat.unreachableSince = 0;
    chat.reachable = true;
  }

  const w = data.watering;
  if (w && (w.state === "ok" || w.state === "failed")) {
    const key = `check:${w.opened_at}:${w.state}`;
    const fresh = now() - w.at < 600;
    const mine = chat.valve && w.opened_at >= chat.valve.since;
    if (!seen(key) && (fresh || w.state === "failed") && !mine) {
      if (w.state === "ok") post(`Water reached the soil after the watering at ${clock(w.opened_at)}, up ${Math.round(w.rise * 100)} %.`);
      else {
        const card = cardFrom(`${head("Water did not arrive", clock(w.opened_at))}<p class="cc-check">The valve opened but the soil had not risen ${Math.round(w.rise_needed * 100)} % after ${duration(w.window_s * 1000)}. Check the tank, the pump and the tubing.</p>`);
        card.dataset.tone = "alert";
        post("The last watering did not reach the soil.", card);
      }
    }
    if (!seen(key)) markSeen(key);
  }

  const f = data.forecast;
  if (f && f.ready) {
    if (chat.decision === "hold" && f.decision === "irrigate") {
      post(`The forecast says the soil reaches the watering level in about ${f.crossing.toFixed(1)} h, inside the ${f.lead} h lead time. ${data.config.auto ? "The node will water." : "Automatic watering is off, so ask me to water if you want to."}`);
    }
    chat.decision = f.decision;
  }

  if (!chat.greeted && reachable && data.state && f && data.weather) {
    chat.greeted = true;
    greet();
  }
}

function greet() {
  const f = data.forecast;
  const soil = soilNow();
  if (!f.ready) post(`Hi. The soil is at ${soil} %. ${notReady(f)}`);
  else if (f.decision === "irrigate") post(`Hi. The soil is at ${soil} % and due to reach the watering level within ${f.lead} h.`);
  else if (f.crossing === null) post(`Hi, all good. The soil is at ${soil} % and should not need water for at least 24 h.`);
  else post(`Hi, all good. The soil is at ${soil} % and should reach the watering level in about ${f.crossing.toFixed(1)} h.`);
  const hour = Math.floor(now() / 3600) * 3600;
  const rain = weatherSum("precipitation", hour, hour + DAY_S);
  const key = `rain:${localMidnight(now())}`;
  if (rain !== null && rain >= RAIN_NOTE_MM && !seen(key)) {
    markSeen(key);
    post(`Rain is forecast in ${data.weather.place}, about ${rain.toFixed(1)} mm in the next 24 h. The models take it into account.`);
  }
}

function keyNote() {
  const k = chatKey();
  el("chat-key-note").textContent = k ? `Saved, ending ${k.slice(-4)}` : "Not set";
}

el("chat-open").addEventListener("click", () => setChatOpen(document.body.dataset.chat !== "open"));
el("chat-close").addEventListener("click", () => setChatOpen(false));
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && document.body.dataset.chat === "open") setChatOpen(false); });
el("chat-clear").addEventListener("click", () => {
  if (chat.busy) return;
  chat.history = [];
  chat.valve = null;
  el("chat-log").innerHTML = "";
  if (!chatKey()) addMessage("note key-note", 'Add a Fireworks key in <a href="#settings">Settings</a> to chat.');
});
el("chat-log").addEventListener("click", (ev) => {
  if (ev.target.closest('a[href="#settings"]') && narrow.matches) setChatOpen(false);
});
el("chat-chips").addEventListener("click", (ev) => {
  const chip = ev.target.closest(".chip");
  if (chip) send(chip.textContent);
});
el("chat-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const input = el("chat-input");
  const text = input.value;
  if (chat.busy) return;
  input.value = "";
  input.style.height = "";
  send(text);
});
el("chat-input").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); el("chat-form").requestSubmit(); }
});
el("chat-input").addEventListener("input", (ev) => {
  ev.target.style.height = "";
  ev.target.style.height = `${Math.min(120, ev.target.scrollHeight)}px`;
});

el("chat-key-save").addEventListener("click", () => {
  const k = el("chat-key").value.trim();
  if (!k) return;
  try { localStorage.setItem(KEY_STORE, k); } catch { el("chat-key-note").textContent = "This browser will not store it"; return; }
  el("chat-key").value = "";
  keyNote();
  el("chat-log").querySelectorAll(".key-note").forEach((n) => n.remove());
});
el("chat-key-forget").addEventListener("click", () => {
  try { localStorage.removeItem(KEY_STORE); } catch { /* nothing stored */ }
  keyNote();
});
el("chat-key-test").addEventListener("click", async () => {
  if (!chatKey()) { el("chat-key-note").textContent = "Save a key first"; return; }
  el("chat-key-note").textContent = "Testing";
  try {
    await complete([{ role: "user", content: "Say ok." }], { max_tokens: 50 });
    el("chat-key-note").textContent = `Working, ending ${chatKey().slice(-4)}`;
  } catch (e) {
    el("chat-key-note").textContent = e.message === "Failed to fetch" ? "Could not reach Fireworks" : e.message;
  }
});

document.body.dataset.chat = "closed";
keyNote();
setInterval(() => { updateValve(); watchEvents(); }, 1000);
