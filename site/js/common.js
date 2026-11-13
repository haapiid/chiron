// Shared by the landing page and the app: API calls, number formats, the quiver's arrows, the change log and the charts.
const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const r = await fetch(path, { credentials: "same-origin", ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status });
  return j;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = (x, d = 2) => (x == null ? "–" : "$" + Number(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const ethf = (x, d = 4) => (x == null ? "–" : Number(x).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: x && Math.abs(x) < 0.01 ? 6 : d }));
const pct = (x, d = 1) => (x == null ? "–" : (x > 0 ? "+" : "") + Number(x).toFixed(d) + "%");
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const ago = (t) => { if (!t) return "–"; const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const since = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`; };
const until = (t) => { if (!t) return "soon"; const s = Math.round((t - Date.now()) / 1000); return s <= 30 ? "any moment" : s < 3600 ? `in ${Math.round(s / 60)} min` : `in ${Math.round(s / 3600)} h`; };
const toast = (msg) => { const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); };
const copy = (text) => navigator.clipboard?.writeText(text).then(() => toast("Copied"), () => toast(text));
const pons = (token) => `https://ponsfamily.com/launchpad/${token}`;
const COL = { quiver: "#e9c08e", still: "#a9c2ee", single: "#b9a7e8" };

/** the $CHIRON contract address chip, once the owner has set it in the studio */
async function loadToken() {
  try {
    const t = await api("/api/token");
    if (!t.ca || !$("ca")) return;
    $("caText").textContent = `$${t.symbol} ${short(t.ca)}`; $("ca").title = "Copy " + t.ca; $("ca").hidden = false; $("ca").onclick = () => copy(t.ca);
  } catch {}
}

/** a tiny price line; green when the last point is above the first */
function spark(pts) {
  if (!pts || pts.length < 2) return `<svg class="spark" viewBox="0 0 84 26" aria-hidden="true"><line x1="0" x2="84" y1="13" y2="13" stroke="rgba(236,231,223,.18)" stroke-dasharray="2 4"/></svg>`;
  const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1;
  const d = pts.map((v, i) => `${((i / (pts.length - 1)) * 84).toFixed(1)},${(24 - ((v - lo) / span) * 22).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 84 26" aria-hidden="true"><polyline fill="none" stroke="${pts[pts.length - 1] >= pts[0] ? "#86d9a8" : "#ff8a72"}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" points="${d}"/></svg>`;
}

/**
 * The quiver as arrows: one row per slot, the shaft as long as the token's share of each buy.
 * Open slots show as a dashed shaft, so "5 of 7" is visible at a glance.
 */
function renderQuiver(el, st) {
  const q = st.quiver, max = Math.max(...q.members.map((m) => m.weight), 0.0001);
  const head = `<div class="arrow head"><span>Token</span><span>Share of a buy</span><span class="share"></span><span class="num">Price, 48 h</span><span class="num c-vol">Traded in 24 h</span><span class="num c-risk">Rug risk</span><span class="num c-since">Fees per trade</span></div>`;
  const rows = q.members.map((m, i) => `<div class="arrow">
    <a class="name" href="${pons(m.token)}" target="_blank" rel="noopener" title="Open $${esc(m.symbol)} on Pons">$${esc(m.symbol)}</a>
    <div class="shaft"><i style="--w:${((m.weight / max) * 100).toFixed(1)}%;--i:${i}"></i></div>
    <span class="share">${Math.round(m.weight * 100)}%</span>
    <span class="num">${spark(m.spark)}<small class="${m.change == null ? "" : m.change >= 0 ? "up" : "down"}">${m.change == null ? "no price yet" : pct(m.change * 100) + " in 24 h"}</small></span>
    <span class="num c-vol">${ethf(m.volEth, 2)} ETH</span>
    <span class="num c-risk">${m.risk ?? "–"}<small>of 100</small></span>
    <span class="num c-since">${m.cost == null ? "–" : (m.cost / 100).toFixed(1) + "%"}<small>in for ${since(m.since)}</small></span>
  </div>`);
  for (let i = q.members.length; i < q.size; i++) rows.push(`<div class="arrow empty"><span class="name">Open slot</span><div class="shaft"><i></i></div><span></span><span class="num"><small>waiting for a token that passes</small></span><span class="c-vol"></span><span class="c-risk"></span><span class="c-since"></span></div>`);
  const was = el.classList.contains("in");
  el.innerHTML = head + rows.join("");
  if (was) el.classList.add("in");
}

function renderLog(el, st, n = 8) {
  const log = st.quiver.log.slice(0, n);
  el.innerHTML = log.length ? log.map((l) => `<li><span class="io ${l.type}">${l.type === "in" ? "In" : "Out"}</span><span><b>$${esc(l.symbol)}</b> <span class="mute">${esc(l.why)}</span></span><span class="when">${ago(l.t)}</span></li>`).join("")
    : `<li><span></span><span class="mute">Nothing yet. The first seven are drawn once a day of Pons trades has been read.</span><span></span></li>`;
}

/** a line chart; series = [{ c: color, pts: [[t, v], ...] }], with an optional dashed base line */
function lineChart(svg, series, { w = 800, h = 280, pad = 30, base = null, fmt = (v) => v.toFixed(0), empty = "collecting data" } = {}) {
  const all = series.flatMap((s) => s.pts);
  if (all.length < 2) { svg.innerHTML = `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="15" fill="#8d93a0">${esc(empty)}</text>`; return; }
  const t0 = Math.min(...all.map((p) => p[0])), t1 = Math.max(...all.map((p) => p[0]));
  let v0 = Math.min(...all.map((p) => p[1]), base ?? Infinity), v1 = Math.max(...all.map((p) => p[1]), base ?? -Infinity);
  if (v1 - v0 < 1e-9) { v0 -= 1; v1 += 1; }
  const X = (t) => pad + ((t - t0) / (t1 - t0 || 1)) * (w - pad * 2), Y = (v) => h - pad - ((v - v0) / (v1 - v0)) * (h - pad * 2);
  let out = "";
  if (base != null) out += `<line x1="${pad}" x2="${w - pad}" y1="${Y(base)}" y2="${Y(base)}" stroke="rgba(236,231,223,.3)" stroke-dasharray="3 6"/>`;
  out += `<text x="${w - pad}" y="${pad - 10}" text-anchor="end" font-family="IBM Plex Mono,monospace" font-size="12" fill="#8d93a0">${fmt(v1)}</text><text x="${w - pad}" y="${h - 8}" text-anchor="end" font-family="IBM Plex Mono,monospace" font-size="12" fill="#8d93a0">${fmt(v0)}</text>`;
  for (const s of series) if (s.pts.length > 1) out += `<polyline fill="none" stroke="${s.c}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" points="${s.pts.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ")}"/>`;
  svg.innerHTML = out;
}

/** the three paper books: return since the start, counted in ETH, against the flat line of just holding ETH */
function renderRecord(st, { books, chart, note }) {
  const r = st.record, keys = ["quiver", "still", "single"];
  if (books) books.innerHTML = keys.map((k) => `<div class="book" style="--c:${COL[k]}"><div class="ret ${!st.recordStarted ? "" : r[k].ret >= 0 ? "up" : "down"}">${st.recordStarted ? pct(r[k].ret, 2) : "–"}</div><h3>${esc(r[k].name)}</h3><p>${esc(r[k].note)}</p></div>`).join("");
  if (chart) lineChart(chart, keys.map((k) => ({ c: COL[k], pts: r[k].curve.map(([t, v]) => [t, (v / st.start - 1) * 100]) })), { base: 0, fmt: (v) => pct(v, 1), empty: `The books open once ${st.openAt} slots are filled` });
  if (note) note.textContent = st.recordStarted
    ? `Opened ${ago(st.recordStarted)} with ${st.start} ETH each. Fills use live curve quotes with every fee and creator tax, which is why each book starts below zero. The dashed line is simply holding the ETH.`
    : `The books open with ${st.start} ETH each once ${st.openAt} slots are filled. Nothing is sent: fills use live curve quotes.`;
}

/** page chrome: the nav turns solid once the page scrolls, and marks the section in view */
(function chrome() {
  const nav = $("nav");
  if (nav && !document.body.classList.contains("app")) {
    const onScroll = () => nav.classList.toggle("solid", scrollY > 40);
    addEventListener("scroll", onScroll, { passive: true }); onScroll();
  }
  const links = document.querySelectorAll(".nav nav a[data-sec]");
  if (links.length && "IntersectionObserver" in window) {
    const so = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) links.forEach((a) => a.classList.toggle("on", a.dataset.sec === e.target.id)); }), { rootMargin: "-45% 0px -50% 0px" });
    links.forEach((a) => { const t = document.getElementById(a.dataset.sec); if (t) so.observe(t); });
  }
})();
