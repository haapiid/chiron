// The landing page: the sky wears the live quiver, and the chapters below read the same public state.
const sky = Sky.init($("sky"), $("stars"), document.querySelector(".hero h1"));
let shown = false, artDone = false;

/** a chapter shows its picture only when the file is in site/img (ch-seven, ch-rule, ch-record, ch-limits) */
function art(files) {
  if (artDone) return; artDone = true;
  for (const head of document.querySelectorAll("[data-art]")) {
    const file = files.find((f) => f.replace(/\.(webp|jpg|jpeg|png|avif)$/i, "") === head.dataset.art);
    if (!file) continue;
    const img = head.querySelector("img");
    img.onload = () => head.classList.remove("bare");
    img.src = "/img/" + file;
  }
}

function render(st) {
  const q = st.quiver;
  sky.setMembers([...q.members].sort((a, b) => b.weight - a.weight).map((m) => ({ symbol: m.symbol, weight: m.weight, href: pons(m.token) })));
  $("fSlots").textContent = `${q.members.length} of ${q.size}`;
  $("fNext").textContent = until(q.next);
  $("fVol").textContent = `${ethf(st.market.buyEth + st.market.sellEth, 0)} ETH`;
  renderQuiver($("arrows"), st);
  renderLog($("log"), st, 8);
  renderRecord(st, { books: $("books"), chart: $("eq"), note: $("recNote") });
  for (const el of document.querySelectorAll("[data-rule]")) { const v = st.rules[el.dataset.rule]; if (v != null) el.textContent = el.dataset.rule === "capWeight" ? Math.round(v * 100) : el.dataset.rule === "maxCostBps" ? v / 100 : v; }
  const errs = Object.keys(st.health.errors || {});
  $("health").textContent = errs.length ? `chain reads are slow (${errs.join(", ")})` : `block ${Number(st.health.block).toLocaleString("en-US")}`;
  art(st.art || []);
}

async function tick() { try { render(await api("/api/state")); } catch { $("health").textContent = "server not answering, retrying"; } }
tick(); setInterval(tick, 30_000);
loadToken();

// chapters fade up as they arrive; the arrows fly out once, when the quiver comes into view
const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { rootMargin: "0px 0px -8% 0px" });
document.querySelectorAll(".reveal").forEach((e) => io.observe(e));
new IntersectionObserver((es, o) => es.forEach((e) => { if (e.isIntersecting && !shown) { shown = true; $("arrows").classList.add("in"); o.disconnect(); } }), { rootMargin: "0px 0px -18% 0px" }).observe($("arrows"));
// reaching for the quiver looses a volley from the button
$("heroCta").addEventListener("pointerenter", (e) => { const r = e.currentTarget.getBoundingClientRect(), h = $("sky").getBoundingClientRect(); sky.volley({ x: r.right - h.left, y: r.top + r.height / 2 - h.top }); });
