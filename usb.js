// With no WiFi the node can reach the broker through this page. It writes the
// messages it would publish as @@ lines on its USB serial port, and this page
// publishes them with a broker connection of its own and passes the node's
// subscriptions back down the cable. The protocol is described in node.ino.

const usb = {
  port: null, reader: null, writer: null, piped: null,
  mode: null, bridge: null, subs: new Set(), queue: Promise.resolve(), note: "Not connected.",
  weatherAt: 0, weatherTry: 0,
};
const NODE_TOPICS = `irrigation/${NODE}/`;
// the request the node makes itself, see weather.h in the firmware
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast?latitude=-29.86&longitude=31.03"
  + "&hourly=temperature_2m,relative_humidity_2m,precipitation,shortwave_radiation,wind_speed_10m"
  + "&timezone=UTC&timeformat=unixtime&past_days=3&forecast_days=4";
const WEATHER_EVERY_MS = 3600 * 1000;
const WEATHER_RETRY_MS = 5 * 60 * 1000;

function usbRefresh() {
  el("usb-connect").hidden = !!usb.port;
  el("usb-disconnect").hidden = !usb.port;
  let text = usb.note;
  if (!("serial" in navigator)) text = "This browser cannot open USB ports. Use Chrome or Edge on a computer.";
  else if (usb.port && !usb.mode) text = "Port open, waiting for the node.";
  else if (usb.port && usb.mode === "wifi") text = "The node is on WiFi. The USB link is standing by.";
  else if (usb.port && !localStorage.getItem("broker-password")) text = "Sign in to the broker first. The page needs the password to publish for the node.";
  else if (usb.port && usb.mode !== "usb") text = "Linking the node to the broker.";
  else if (usb.port) text = "Carrying the node's data to the broker. Keep this tab open.";
  el("usb-note").textContent = text;
}

function usbSend(line) {
  usb.queue = usb.queue
    .then(() => usb.writer && usb.writer.write(new TextEncoder().encode(line + "\n")))
    .catch(() => {});
}

function usbHi() { usbSend(`@@hi ${Math.floor(Date.now() / 1000)}`); }

// Without WiFi the node cannot download its weather, so while this page carries the
// link it fetches the same response and sends it down the cable
async function usbWeather() {
  const t = Date.now();
  if (t - usb.weatherAt < WEATHER_EVERY_MS || t - usb.weatherTry < WEATHER_RETRY_MS) return;
  usb.weatherTry = t;
  try {
    const r = await fetch(WEATHER_URL);
    if (!r.ok) return;
    const body = await r.json();
    body.fetched_at = Math.floor(Date.now() / 1000);
    usbSend(`@@msg ${NODE_TOPICS}weather_set ${JSON.stringify(body)}`);
    usb.weatherAt = Date.now();
  } catch (err) {
    // offline as well, the node keeps its stored copy
  }
}

// The page's own client carries a last will, so closing the tab or losing the
// laptop's connection marks the node offline the way its own session would
function openBridge() {
  const password = localStorage.getItem("broker-password");
  if (usb.bridge || !password) return;
  usb.bridge = mqtt.connect(BROKER, {
    username: USER, password, clean: true, reconnectPeriod: 3000, connectTimeout: 10000,
    will: { topic: `${NODE_TOPICS}status`, payload: "offline", qos: 1, retain: true },
  });
  usb.bridge.on("connect", () => {
    if (usb.subs.size) usb.bridge.subscribe([...usb.subs]);
    usbRefresh();
  });
  usb.bridge.on("message", (topic, payload) => {
    if (usb.subs.has(topic)) usbSend(`@@msg ${topic} ${payload.toString().replace(/\n/g, " ")}`);
  });
}

// A clean disconnect does not fire the will. When the node itself is still
// online on WiFi the status is left alone.
function closeBridge(markOffline) {
  const b = usb.bridge;
  if (!b) return;
  usb.bridge = null;
  if (markOffline && b.connected) b.publish(`${NODE_TOPICS}status`, "offline", { qos: 1, retain: true }, () => b.end());
  else b.end();
}

function usbLine(line) {
  if (!line.startsWith("@@")) return;
  const space = line.indexOf(" ");
  const kind = line.slice(2, space < 0 ? undefined : space);
  const rest = space < 0 ? "" : line.slice(space + 1);
  if (kind === "hello") {
    // the node asks again for what it needs each time it gains a link
    if (rest !== "usb") usb.subs.clear();
    if (rest !== usb.mode) { usb.mode = rest; usbRefresh(); }
    if (rest === "wifi") {
      closeBridge(false);
      usbHi();
    } else {
      openBridge();
      if (usb.bridge && usb.bridge.connected) usbHi();
      if (rest === "usb") usbWeather();
    }
  } else if (kind === "pub") {
    const a = rest.indexOf(" ");
    const b = rest.indexOf(" ", a + 1);
    const topic = rest.slice(a + 1, b);
    if (usb.bridge && topic.startsWith(NODE_TOPICS)) {
      usb.bridge.publish(topic, rest.slice(b + 1), { retain: rest.slice(0, a) === "1" });
    }
  } else if (kind === "sub") {
    usb.subs.add(rest);
    if (usb.bridge && usb.bridge.connected) usb.bridge.subscribe(rest);
  } else if (kind === "unsub") {
    usb.subs.delete(rest);
    if (usb.bridge && usb.bridge.connected) usb.bridge.unsubscribe(rest);
  }
}

async function usbRead(port) {
  const decoder = new TextDecoderStream();
  usb.piped = port.readable.pipeTo(decoder.writable).catch(() => {});
  usb.reader = decoder.readable.getReader();
  let buffered = "";
  try {
    for (;;) {
      const { value, done } = await usb.reader.read();
      if (done) break;
      buffered += value;
      let end;
      while ((end = buffered.indexOf("\n")) >= 0) {
        usbLine(buffered.slice(0, end).replace(/\r$/, ""));
        buffered = buffered.slice(end + 1);
      }
    }
  } catch (err) {
    // the cable was pulled or the board reset
  }
  if (usb.port === port) usbStop("The node was unplugged.");
}

async function usbStart(port) {
  if (usb.port) return;
  try {
    await port.open({ baudRate: 115200, bufferSize: 65536 });
  } catch (err) {
    usb.note = "The port is busy. Close any serial monitor or upload using it, then connect again.";
    usbRefresh();
    return;
  }
  usb.port = port;
  usb.mode = null;
  usb.weatherAt = usb.weatherTry = 0;
  usb.writer = port.writable.getWriter();
  usbRefresh();
  usbRead(port);
}

async function usbStop(note) {
  const port = usb.port;
  if (!port) return;
  usb.port = null;
  usb.mode = null;
  usb.subs.clear();
  usb.note = note;
  closeBridge(true);
  try { await usb.reader.cancel(); } catch (err) {}
  try { await usb.piped; } catch (err) {}
  try { usb.writer.releaseLock(); } catch (err) {}
  usb.reader = usb.writer = null;
  try { await port.close(); } catch (err) {}
  usbRefresh();
}

function remembered() {
  try { return localStorage.getItem("usb-link") === "on"; } catch (err) { return false; }
}

el("usb-connect").addEventListener("click", async () => {
  let port;
  try {
    port = await navigator.serial.requestPort();
  } catch (err) {
    return;
  }
  localStorage.setItem("usb-link", "on");
  usbStart(port);
});

el("usb-disconnect").addEventListener("click", () => {
  localStorage.setItem("usb-link", "off");
  usbStop("Not connected.");
});

// A port chosen once can be reopened without asking, so a reload or a replug
// picks the link up again on its own
if ("serial" in navigator) {
  navigator.serial.getPorts().then((ports) => { if (ports.length && remembered()) usbStart(ports[0]); });
  navigator.serial.addEventListener("connect", (ev) => { if (remembered()) usbStart(ev.target); });
  navigator.serial.addEventListener("disconnect", (ev) => { if (ev.target === usb.port) usbStop("The node was unplugged."); });
}
usbRefresh();
