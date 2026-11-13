// The landing page: the sky wears the live quiver, and the sections below read the same public state.
const sky = Sky.init($("sky"), $("stars"), document.querySelector(".hero h1"));
let shown = false;

function render(st) {
  const q = st.quiver;
  sky.setMembers([...q.members].sort((a, b) => b.weight - a.weight).map((m) => ({ symbol: m.symbol, weight: m.weight, href: pons(m.token) })));
  $("fSlots").textContent = `${q.members.length} of ${q.size}`;
  $("fNext").textContent = until(q.next);
  $("fVol").textContent = `${ethf(st.market.buyEth + st.market.sellEth, 1)} ETH`;
  renderQuiver($("arrows"), st);
  renderLog($("log"), st, 7);
  renderRecord(st, { books: $("books"), chart: $("eq"), note: $("recNote") });
  for (const el of document.querySelectorAll("[data-rule]")) { const v = st.rules[el.dataset.rule]; if (v != null) el.textContent = el.dataset.rule === "capWeight" ? Math.round(v * 100) : el.dataset.rule === "maxCostBps" ? v / 100 : v; }
  const errs = Object.keys(st.health.errors || {});
  $("health").textContent = errs.length ? `Reading the chain is slow right now (${errs.join(", ")})` : `Pons read to block ${Number(st.health.block).toLocaleString("en-US")}`;
}

async function tick() { try { render(await api("/api/state")); } catch { $("health").textContent = "The server is not answering. Retrying."; } }
tick(); setInterval(tick, 30_000);
loadToken();

// the arrows fly out once, when the quiver scrolls into view
new IntersectionObserver((es, io) => es.forEach((e) => { if (e.isIntersecting && !shown) { shown = true; $("arrows").classList.add("in"); io.disconnect(); } }), { rootMargin: "0px 0px -20% 0px" }).observe($("arrows"));
// reaching for the quiver looses a volley from the button
$("heroCta").addEventListener("pointerenter", (e) => { const r = e.currentTarget.getBoundingClientRect(), h = $("sky").getBoundingClientRect(); sky.volley({ x: r.right - h.left, y: r.top + r.height / 2 - h.top }); });
