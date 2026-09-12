// Small SVG line charts drawn by hand. Time on the x axis in unix seconds, values
// on the y axis. Each chart gets a crosshair and a tooltip on hover.
const Charts = (() => {
  const W = 640;
  const PAD = { top: 18, right: 14, bottom: 26, left: 42 };
  const tooltip = () => document.getElementById("tooltip");

  function scale(d0, d1, r0, r1) {
    const k = (r1 - r0) / ((d1 - d0) || 1);
    return (v) => r0 + (v - d0) * k;
  }

  function hourTicks(t0, t1, step) {
    const out = [];
    const d = new Date(t0 * 1000);
    d.setMinutes(0, 0, 0);
    d.setHours(Math.ceil(d.getHours() / step) * step);
    for (let t = d.getTime() / 1000; t <= t1; t += step * 3600) {
      if (t >= t0) out.push(t);
    }
    return out;
  }

  function valueTicks(y0, y1) {
    const span = y1 - y0;
    const raw = span / 3;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
    const out = [];
    for (let v = Math.ceil(y0 / step) * step; v <= y1 + 1e-9; v += step) out.push(v);
    return out;
  }

  function clock(t) {
    return new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function whenLabel(t) {
    const d = new Date(t * 1000);
    return d.toLocaleDateString([], { weekday: "short" }) + " " + clock(t);
  }

  function pathFor(points, x, y, gap) {
    let d = "";
    let prev = null;
    for (const [t, v] of points) {
      if (v === null || v === undefined || Number.isNaN(v)) { prev = null; continue; }
      const cmd = prev === null || t - prev > gap ? "M" : "L";
      d += `${cmd}${x(t).toFixed(1)},${y(v).toFixed(1)}`;
      prev = t;
    }
    return d;
  }

  function nearest(points, t) {
    let best = null;
    for (const p of points) {
      if (p[1] === null || Number.isNaN(p[1])) continue;
      if (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    }
    return best;
  }

  function draw(el, o) {
    const H = o.small ? 132 : 240;
    const pad = { ...PAD };
    if (o.small) { pad.left = 38; pad.top = 24; }
    const x = scale(o.x[0], o.x[1], pad.left, W - pad.right);
    let [y0, y1] = o.y;
    if (y1 - y0 < 1e-9) { y0 -= 1; y1 += 1; }
    const y = scale(y0, y1, H - pad.bottom, pad.top);
    const fmt = o.format || ((v) => String(Math.round(v)));
    const gap = o.gap || 3600;

    let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
    if (o.title) s += `<text class="title" x="${pad.left}" y="12">${o.title}</text>`;

    for (const v of valueTicks(y0, y1)) {
      s += `<line class="grid-line" x1="${pad.left}" x2="${W - pad.right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`;
      s += `<text class="axis-text" x="${pad.left - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${fmt(v)}</text>`;
    }
    for (const t of hourTicks(o.x[0], o.x[1], o.step || 6)) {
      s += `<text class="axis-text" x="${x(t).toFixed(1)}" y="${H - 8}" text-anchor="middle">${clock(t)}</text>`;
    }

    if (o.threshold !== undefined) {
      s += `<line class="threshold" x1="${pad.left}" x2="${W - pad.right}" y1="${y(o.threshold).toFixed(1)}" y2="${y(o.threshold).toFixed(1)}"/>`;
    }
    if (o.now !== undefined) {
      s += `<line class="now" x1="${x(o.now).toFixed(1)}" x2="${x(o.now).toFixed(1)}" y1="${pad.top}" y2="${H - pad.bottom}"/>`;
      s += `<text class="axis-text" x="${(x(o.now) + 4).toFixed(1)}" y="${pad.top + 10}">now</text>`;
    }

    let any = false;
    for (const series of o.series) {
      const pts = series.points.filter((p) => p[1] !== null && !Number.isNaN(p[1]));
      if (!pts.length) continue;
      any = true;
      s += `<path class="series ${series.cls}" d="${pathFor(series.points, x, y, gap)}"/>`;
      if (series.dots) {
        for (const [t, v] of pts) {
          s += `<circle class="marker ${series.cls}" cx="${x(t).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.5"/>`;
        }
      }
    }
    if (!any) {
      s += `<text class="empty" x="${(W / 2).toFixed(0)}" y="${(H / 2).toFixed(0)}" text-anchor="middle">${o.empty || "Nothing recorded yet"}</text>`;
    }
    s += `<line class="crosshair" id="cross" y1="${pad.top}" y2="${H - pad.bottom}" x1="0" x2="0" visibility="hidden"/>`;
    s += `<rect class="hover" x="${pad.left}" y="${pad.top}" width="${W - pad.left - pad.right}" height="${H - pad.top - pad.bottom}"/>`;
    s += "</svg>";
    el.innerHTML = s;

    const svg = el.querySelector("svg");
    const cross = svg.querySelector("#cross");
    const hover = svg.querySelector(".hover");
    hover.addEventListener("mousemove", (ev) => {
      const box = svg.getBoundingClientRect();
      const vx = (ev.clientX - box.left) * (W / box.width);
      const t = o.x[0] + (vx - pad.left) / (W - pad.left - pad.right) * (o.x[1] - o.x[0]);
      cross.setAttribute("x1", vx.toFixed(1));
      cross.setAttribute("x2", vx.toFixed(1));
      cross.setAttribute("visibility", "visible");
      const lines = [];
      let when = t;
      for (const series of o.series) {
        const p = nearest(series.points, t);
        if (!p || Math.abs(p[0] - t) > (o.snap || 1800)) continue;
        when = p[0];
        lines.push(`${series.name}: <b>${fmt(p[1])}</b>${o.unit || ""}`);
      }
      const tip = tooltip();
      if (!lines.length) { tip.hidden = true; return; }
      tip.innerHTML = `<div class="when">${whenLabel(when)}</div>` + lines.join("<br>");
      tip.hidden = false;
      const tw = tip.offsetWidth;
      const left = ev.clientX + 14 + tw > window.innerWidth ? ev.clientX - 14 - tw : ev.clientX + 14;
      tip.style.left = `${left}px`;
      tip.style.top = `${ev.clientY + 14}px`;
    });
    hover.addEventListener("mouseleave", () => {
      cross.setAttribute("visibility", "hidden");
      tooltip().hidden = true;
    });
  }

  return { draw };
})();
