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
  // a rendered cut-out of Chiron (transparent background, seen from behind, hooves at the bottom edge) replaces the drawing
  const cut = files.find((f) => /^chiron\./i.test(f)), w = document.querySelector(".walker");
  if (cut && w) { const img = w.querySelector("img"); img.onload = () => { img.hidden = false; w.querySelector("svg").style.display = "none"; }; img.src = "/img/" + cut; }
}

/** chapter 05: the creator wallet, the buyback wallet and the token, each with its explorer link */
let token = null;
function renderOpen(st) {
  const w = st.wallets; if (!w) return;
  const link = (a) => `<a class="mono" href="${st.explorer}/address/${a}" target="_blank" rel="noopener" title="Open in the explorer">${a}</a><button class="copy" data-copy="${a}">Copy</button>`;
  const rows = [
    ["Creator wallet", "Launches $CHIRON on Pons. The creator fee from its trades lands here.", link(w.creator)],
    ["Buyback wallet", `Buys $CHIRON back and burns it. ${w.buybackEth == null ? "" : `It holds ${ethf(w.buybackEth, 5)} ETH to spend.`}`, link(w.buyback)],
    ["$" + esc(token?.symbol || "CHIRON"), token?.ca ? "The token, on its Pons curve." : "Not launched yet. Its address will show here the moment it is set.", token?.ca ? link(token.ca) : `<span class="mono mute">no address yet</span>`],
  ];
  if (token?.ca && token.deadBalance != null) rows.push(["Burned so far", "Tokens sitting at the dead address, gone for good.", `<span class="mono">${Number(token.deadBalance).toLocaleString("en-US", { maximumFractionDigits: 0 })} $${esc(token.symbol)}</span>`]);
  $("openRows").innerHTML = rows.map(([k, text, v]) => `<div class="open-row"><h3>${k}</h3><p>${text}</p><div class="open-v">${v}</div></div>`).join("");
}
document.addEventListener("click", (e) => { const a = e.target.closest?.("[data-copy]"); if (a) copy(a.dataset.copy); });

function render(st) {
  lastState = st;
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
  if (st.own?.tradable) { $("ownPct").textContent = Math.round(st.own.share * 100); $("ownSym").textContent = "$" + st.own.symbol; $("ownRule").hidden = false; }
  renderOpen(st);
  art(st.art || []);
}

// a turned phone or a resized window redraws the chart and the rest at the new size
let lastState = null, resizing = 0;
addEventListener("resize", () => { clearTimeout(resizing); resizing = setTimeout(() => lastState && render(lastState), 250); });
async function tick() { try { token = await api("/api/token").catch(() => token); render(await api("/api/state")); } catch { $("health").textContent = "server not answering, retrying"; } }
tick(); setInterval(tick, 30_000);
loadToken();

// chapters fade up as they arrive; the arrows fly out once, when the quiver comes into view
const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { rootMargin: "0px 0px -8% 0px" });
document.querySelectorAll(".reveal").forEach((e) => io.observe(e));
new IntersectionObserver((es, o) => es.forEach((e) => { if (e.isIntersecting && !shown) { shown = true; $("arrows").classList.add("in"); o.disconnect(); } }), { rootMargin: "0px 0px -18% 0px" }).observe($("arrows"));
// reaching for the quiver looses a volley from the button
$("heroCta").addEventListener("pointerenter", (e) => { const r = e.currentTarget.getBoundingClientRect(), h = $("sky").getBoundingClientRect(); sky.volley({ x: r.right - h.left, y: r.top + r.height / 2 - h.top }); });
