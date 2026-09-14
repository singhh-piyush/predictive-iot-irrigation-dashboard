// Small SVG line charts drawn by hand. Time on the x axis in unix seconds, values
// on the y axis. Each chart gets a crosshair and a tooltip on hover.
const Charts = (() => {
  const WIDE = 640, NARROW = 320;
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

  // Hours before or after a reference point, for charts with no real clock
  function relLabel(t, from) {
    const h = Math.round((t - from) / 3600);
    return h === 0 ? "now" : `${h > 0 ? "+" : "\u2212"}${Math.abs(h)} h`;
  }

  function relTicks(t0, t1, from, step) {
    const out = [];
    for (let t = from - Math.ceil((from - t0) / (step * 3600)) * step * 3600; t <= t1; t += step * 3600) {
      if (t >= t0) out.push(t);
    }
    return out;
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

  // Closed shapes under each unbroken run of the line, down to the baseline
  function areaFor(points, x, y, gap, base) {
    let d = "";
    let run = [];
    const flush = () => {
      if (run.length < 2) { run = []; return; }
      d += `M${x(run[0][0]).toFixed(1)},${base.toFixed(1)}`;
      for (const [t, v] of run) d += `L${x(t).toFixed(1)},${y(v).toFixed(1)}`;
      d += `L${x(run[run.length - 1][0]).toFixed(1)},${base.toFixed(1)}Z`;
      run = [];
    };
    let prev = null;
    for (const p of points) {
      if (p[1] === null || Number.isNaN(p[1])) { flush(); prev = null; continue; }
      if (prev !== null && p[0] - prev > gap) flush();
      run.push(p);
      prev = p[0];
    }
    flush();
    return d;
  }

  // Tiny line with no axes, for the reading tiles. o.x is the time window.
  function spark(el, points, o) {
    const pts = points.filter((p) => p[1] !== null && !Number.isNaN(p[1]) && p[0] >= o.x[0] && p[0] <= o.x[1]);
    if (pts.length < 2) { el.innerHTML = ""; return; }
    const W = 120, H = 30;
    let lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    const x = scale(o.x[0], o.x[1], 1, W - 1);
    const y = scale(lo, hi, H - 2, 3);
    const gap = o.gap || 900;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`
      + `<path class="fill" d="${areaFor(pts, x, y, gap, H)}"/>`
      + `<path class="line" d="${pathFor(pts, x, y, gap)}"/></svg>`;
  }

  // Points inside the window plus one either side, so a line still enters and
  // leaves the plot at the right angle. The clip path hides the rest.
  function inWindow(points, x0, x1) {
    let first = -1, last = -1;
    points.forEach((p, i) => {
      if (p[0] < x0) first = i;
      if (p[0] <= x1) last = i;
    });
    return points.slice(Math.max(0, first), Math.min(points.length, last + 2));
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
    const W = o.small ? NARROW : WIDE;
    const H = o.small ? 140 : 240;
    const pad = { ...PAD };
    if (o.small) { pad.left = 36; pad.top = 12; pad.right = 10; }
    const x = scale(o.x[0], o.x[1], pad.left, W - pad.right);
    let [y0, y1] = o.y;
    if (y1 - y0 < 1e-9) { y0 -= 1; y1 += 1; }
    const y = scale(y0, y1, H - pad.bottom, pad.top);
    const fmt = o.format || ((v) => String(Math.round(v)));
    const gap = o.gap || 3600;

    const clipId = `clip-${el.id || Math.random().toString(36).slice(2)}`;
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
    s += `<clipPath id="${clipId}"><rect x="${pad.left}" y="${pad.top}" width="${W - pad.left - pad.right}" height="${H - pad.top - pad.bottom}"/></clipPath>`;
    if (o.title) s += `<text class="title" x="${pad.left}" y="12">${o.title}</text>`;
    if (o.shadeFrom !== undefined) {
      s += `<rect class="shade" x="${x(o.shadeFrom).toFixed(1)}" y="${pad.top}" width="${(W - pad.right - x(o.shadeFrom)).toFixed(1)}" height="${H - pad.top - pad.bottom}"/>`;
    }
    if (o.band !== undefined) {
      const top = Math.min(Math.max(y(o.band), pad.top), H - pad.bottom);
      s += `<rect class="band" x="${pad.left}" y="${top.toFixed(1)}" width="${W - pad.left - pad.right}" height="${(H - pad.bottom - top).toFixed(1)}"/>`;
    }

    for (const v of valueTicks(y0, y1)) {
      s += `<line class="grid-line" x1="${pad.left}" x2="${W - pad.right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`;
      s += `<text class="axis-text" x="${pad.left - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${fmt(v)}</text>`;
    }
    const ticks = o.relative ? relTicks(o.x[0], o.x[1], o.now, o.step || 6) : hourTicks(o.x[0], o.x[1], o.step || 6);
    for (const t of ticks) {
      const label = o.relative ? relLabel(t, o.now) : clock(t);
      s += `<text class="axis-text" x="${x(t).toFixed(1)}" y="${H - 8}" text-anchor="middle">${label}</text>`;
    }

    if (o.threshold !== undefined) {
      s += `<line class="threshold" x1="${pad.left}" x2="${W - pad.right}" y1="${y(o.threshold).toFixed(1)}" y2="${y(o.threshold).toFixed(1)}"/>`;
    }
    if (o.now !== undefined) {
      s += `<line class="now" x1="${x(o.now).toFixed(1)}" x2="${x(o.now).toFixed(1)}" y1="${pad.top}" y2="${H - pad.bottom}"/>`;
      if (!o.relative) {
        // the label sits to the left of the line when the line is at the right edge
        const flip = x(o.now) > W - pad.right - 34;
        s += `<text class="axis-text" x="${(x(o.now) + (flip ? -4 : 4)).toFixed(1)}" y="${pad.top + 10}"${flip ? ' text-anchor="end"' : ""}>now</text>`;
      }
    }

    let any = false;
    s += `<g clip-path="url(#${clipId})">`;
    for (const series of o.series) {
      const shown = inWindow(series.points, o.x[0], o.x[1]);
      const pts = shown.filter((p) => p[1] !== null && !Number.isNaN(p[1]));
      if (!pts.length) continue;
      any = true;
      const sgap = series.gap || gap;
      if (series.area) {
        const base = y(Math.max(y0, 0));
        s += `<path class="area ${series.cls}" d="${areaFor(shown, x, y, sgap, base)}"/>`;
      }
      s += `<path class="series ${series.cls}" d="${pathFor(shown, x, y, sgap)}"/>`;
      if (series.dots) {
        for (const [t, v] of pts) {
          s += `<circle class="marker ${series.cls}" cx="${x(t).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.5"/>`;
        }
      }
    }
    s += "</g>";
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
      tip.innerHTML = `<div class="when">${o.relative ? relLabel(when, o.now) : whenLabel(when)}</div>` + lines.join("<br>");
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

  // Vertical bars from a zero baseline, for the skill by horizon figure
  function bars(el, o) {
    const W = o.small ? NARROW : WIDE, H = o.small ? 150 : 200;
    const pad = o.small ? { top: 16, right: 8, bottom: 22, left: 34 } : { top: 22, right: 14, bottom: 26, left: 42 };
    const n = o.values.length;
    const lo = Math.min(0, ...o.values), hi = Math.max(0, ...o.values);
    const y = scale(lo, hi * 1.15 || 1, H - pad.bottom, pad.top);
    const slot = (W - pad.left - pad.right) / n;
    const bw = Math.min(slot * 0.5, o.small ? 28 : 48);
    const fmt = o.format || ((v) => String(v));
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
    for (const v of valueTicks(lo, hi * 1.15 || 1)) {
      s += `<line class="grid-line" x1="${pad.left}" x2="${W - pad.right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`;
      s += `<text class="axis-text" x="${pad.left - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${fmt(v)}</text>`;
    }
    s += `<line class="baseline" x1="${pad.left}" x2="${W - pad.right}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>`;
    o.values.forEach((v, i) => {
      const cx = pad.left + slot * (i + 0.5);
      const top = Math.min(y(v), y(0)), bottom = Math.max(y(v), y(0));
      const r = Math.min(4, (bottom - top) / 2);
      const x0 = cx - bw / 2, x1 = cx + bw / 2;
      const d = v >= 0
        ? `M${x0},${bottom}V${top + r}a${r},${r} 0 0 1 ${r},-${r}H${x1 - r}a${r},${r} 0 0 1 ${r},${r}V${bottom}Z`
        : `M${x0},${top}V${bottom - r}a${r},${r} 0 0 0 ${r},${r}H${x1 - r}a${r},${r} 0 0 0 ${r},-${r}V${top}Z`;
      s += `<path class="bar${v < 0 ? " neg" : ""}" d="${d}" data-i="${i}"/>`;
      s += `<text class="bar-label" x="${cx.toFixed(1)}" y="${(v >= 0 ? top - 6 : bottom + 14).toFixed(1)}" text-anchor="middle">${fmt(v)}</text>`;
      s += `<text class="axis-text" x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle">${o.labels[i]}</text>`;
    });
    s += "</svg>";
    el.innerHTML = s;
    el.querySelectorAll(".bar").forEach((bar) => {
      bar.addEventListener("mousemove", (ev) => {
        const i = Number(bar.dataset.i);
        const tip = tooltip();
        tip.innerHTML = `<div class="when">${o.labels[i]}</div>${o.name || ""}: <b>${fmt(o.values[i])}</b>`;
        tip.hidden = false;
        tip.style.left = `${ev.clientX + 14}px`;
        tip.style.top = `${ev.clientY + 14}px`;
      });
      bar.addEventListener("mouseleave", () => { tooltip().hidden = true; });
    });
  }

  return { draw, spark, bars };
})();
