// Bench endpoints for the resistive fork, raw ADC counts: 4095 in air, 2548 in
// a glass of water. Wetter soil reads lower on this board.
const SOIL_DRY = 4095;
const SOIL_WET = 2548;
const RAIN_WET_ABOVE = 500;

const BROKER = "wss://bf2858433f4c4e3389ed899ed463d4ff.s1.eu.hivemq.cloud:8884/mqtt";
const USER = "irrigation";
const NODE = "node1";
const STALE_MS = 20000;

const el = (id) => document.getElementById(id);
const status = el("status");
const statusText = el("status-text");
const dot = status.querySelector(".dot");
const relay = el("relay");

let client = null;
let lastMessage = 0;
let nodeOnline = false;

function show(section, on) {
  section.hidden = !on;
}

function setStatus(state, text) {
  status.dataset.state = state;
  statusText.textContent = text;
}

function ago(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  return `${m} min ${s - m * 60} s ago`;
}

function refreshStatus() {
  if (!client || !client.connected) return;
  if (!lastMessage) {
    setStatus("idle", nodeOnline ? "Node online, waiting for readings" : "Waiting for the node");
    return;
  }
  const since = Date.now() - lastMessage;
  if (!nodeOnline) {
    setStatus("offline", `Node offline, last reading ${ago(since)}`);
  } else if (since > STALE_MS) {
    setStatus("offline", `No readings for ${ago(since)}`);
  } else {
    setStatus("online", `Online, last reading ${ago(since)}`);
  }
}

function fmt(v, digits) {
  return v === undefined || v === null ? "–" : Number(v).toFixed(digits);
}

function render(state) {
  const sat = (SOIL_DRY - state.soil_raw) / (SOIL_DRY - SOIL_WET) * 100;
  const clamped = Math.max(0, Math.min(100, sat));
  el("soil").textContent = fmt(sat, 0);
  el("soil-fill").style.width = `${clamped}%`;
  el("soil-temp").textContent = fmt(state.soil_temp, 1);
  el("air-temp").textContent = fmt(state.air_temp, 1);
  el("humidity").textContent = fmt(state.humidity, 0);
  el("rain").textContent = state.rain_raw > RAIN_WET_ABOVE ? "Wet" : "Dry";
  el("light").textContent = state.light_raw;
  relay.checked = !!state.relay;
  relay.disabled = false;
  el("relay-text").textContent = state.relay ? "Open" : "Closed";
  el("signal").textContent = `Signal ${state.rssi} dBm`;
  const h = Math.floor(state.uptime_s / 3600);
  const m = Math.floor((state.uptime_s % 3600) / 60);
  el("uptime").textContent = h ? `Up ${h} h ${m} min` : `Up ${m} min`;
}

function connect(password) {
  setStatus("idle", "Connecting");
  client = mqtt.connect(BROKER, {
    username: USER,
    password,
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 10000,
  });

  client.on("connect", () => {
    localStorage.setItem("broker-password", password);
    show(el("login"), false);
    show(el("readings"), true);
    show(el("foot"), true);
    client.subscribe([`irrigation/${NODE}/state`, `irrigation/${NODE}/status`]);
    refreshStatus();
  });

  client.on("message", (topic, payload) => {
    if (topic.endsWith("/status")) {
      nodeOnline = payload.toString() === "online";
      if (!nodeOnline) relay.disabled = true;
    } else {
      lastMessage = Date.now();
      nodeOnline = true;
      render(JSON.parse(payload.toString()));
      dot.classList.remove("tick");
      void dot.offsetWidth;
      dot.classList.add("tick");
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

el("forget").addEventListener("click", () => {
  localStorage.removeItem("broker-password");
  location.reload();
});

setInterval(refreshStatus, 1000);

const saved = localStorage.getItem("broker-password");
if (saved) connect(saved); else show(el("login"), true);
