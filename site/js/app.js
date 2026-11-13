// The app: the live quiver, the record, and the wallet side (sign in, holdings against the quiver's shares,
// and the three plans: buy all seven, rotate, sell everything). Every step is a transaction the wallet signs.
const CHAIN = { chainId: "0x1237", chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"], blockExplorerUrls: ["https://robinhoodchain.blockscout.com"] };
const wal = window.ethereum;
let me = null, st = null, hold = null, plan = null, stopping = false, running = false, explorer = CHAIN.blockExplorerUrls[0];

// ---------- tabs ----------
const TABS = ["seven", "record", "wallet"];
function show(tab) {
  if (!TABS.includes(tab)) tab = "seven";
  document.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== tab));
  document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  if (location.hash.slice(1) !== tab) history.replaceState(null, "", "#" + tab);
}
document.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => show(b.dataset.tab)));
addEventListener("hashchange", () => show(location.hash.slice(1)));
show(location.hash.slice(1));

// ---------- public state ----------
function renderState() {
  const q = st.quiver; explorer = st.explorer || explorer;
  $("kSlots").textContent = `${q.members.length} of ${q.size}`;
  $("kNext").textContent = until(q.next);
  $("kVol").textContent = `${ethf(st.market.buyEth + st.market.sellEth, 1)} ETH`;
  $("kNew").textContent = Number(st.market.launches).toLocaleString("en-US");
  renderQuiver($("arrows"), st);
  renderLog($("log"), st, 25);
  renderRecord(st, { books: $("books"), chart: $("eq"), note: $("recNote") });
  const tr = st.record.quiver.trades;
  $("trades").innerHTML = tr.length ? tr.map((t) => `<tr><td class="mute">${ago(t.t)}</td><td>${esc(t.side)}</td><td><b>${esc(t.what)}</b></td><td class="r">${ethf(t.eth)}</td><td class="mute">${esc(t.why)}</td></tr>`).join("")
    : `<tr><td colspan="5" class="mute">The books open once ${st.openAt} slots are filled.</td></tr>`;
  const errs = Object.keys(st.health.errors || {});
  $("health").textContent = errs.length ? `Chain reads are slow right now (${errs.join(", ")}).` : `Block ${Number(st.health.block).toLocaleString("en-US")}. The seven were last checked ${ago(q.at)}.`;
  renderSplit();
}
async function tick() { try { st = await api("/api/state"); renderState(); } catch { $("health").textContent = "The server is not answering. Retrying."; } }
tick(); setInterval(tick, 30_000);
loadToken();

// ---------- wallet ----------
const hex = (s) => "0x" + Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");
async function ensureChain() {
  const id = await wal.request({ method: "eth_chainId" });
  if (id === CHAIN.chainId) return;
  try { await wal.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN.chainId }] }); }
  catch (e) { if (e.code === 4902 || /Unrecognized|not added/i.test(e.message)) await wal.request({ method: "wallet_addEthereumChain", params: [CHAIN] }); else throw e; }
}
const walletErr = (e) => (e?.code === 4001 ? "You declined in the wallet." : e?.message || String(e));

async function signIn() {
  show("wallet"); $("gateErr").textContent = "";
  if (!wal) { $("noWallet").hidden = false; return; }
  try {
    const [addr] = await wal.request({ method: "eth_requestAccounts" });
    await ensureChain();
    const { message } = await api("/api/auth/nonce", { method: "POST", body: JSON.stringify({ address: addr }) });
    const signature = await wal.request({ method: "personal_sign", params: [hex(message), addr] });
    await api("/api/auth/verify", { method: "POST", body: JSON.stringify({ message, signature }) });
    await boot();
  } catch (e) { $("gateErr").textContent = walletErr(e); }
}

async function boot() {
  try { const u = await api("/api/me"); me = u.address; $("slip").value = String(u.slippage); renderRuns(u.runs); }
  catch { me = null; }
  $("gate").hidden = !!me; $("dash").hidden = !me;
  $("connect").textContent = me ? short(me) : "Connect wallet";
  if (me) loadWallet();
}

function renderWallet() {
  const h = hold, total = h.totalEth;
  $("total").textContent = `${ethf(total)} ETH`;
  $("totalSub").textContent = h.held.length ? `in ${h.held.length} Chiron token${h.held.length > 1 ? "s" : ""}${h.totalUsd != null ? `, about ${usd(h.totalUsd)}` : ""}` : "from Chiron in this wallet";
  $("freeTxt").textContent = `${ethf(h.eth.free)} ETH free to spend in ${short(me)}. A little is kept aside for gas.`;
  const maxW = Math.max(...h.held.map((x) => Math.max(x.weight, total ? x.eth / total : 0)), 0.0001);
  $("holds").innerHTML = h.held.length ? h.held.map((x) => {
    const mine = total ? x.eth / total : 0;
    return `<div class="hold ${x.member || x.own ? "" : "gone"}"><a class="name" href="${pons(x.token)}" target="_blank" rel="noopener">$${esc(x.symbol)}</a>
      <div class="bars"><i style="--w:${((mine / maxW) * 100).toFixed(1)}%"></i><i style="--w:${((x.weight / maxW) * 100).toFixed(1)}%"></i></div>
      <div class="val">${ethf(x.eth)} ETH<small>${Math.round(mine * 100)}% of yours</small><small>${x.member ? Math.round(x.weight * 100) + "% in Chiron" : x.own ? "Chiron's own token" : "no longer in the seven"}</small></div>
      ${x.member || x.own ? "" : `<div class="why">Left the seven: ${esc(x.why || "it no longer passes the rule")}.</div>`}</div>`;
  }).join("") : `<p class="mute">Nothing from Chiron in this wallet yet. Name an amount to buy all seven.</p>`;
  $("unpriced").textContent = h.unpriced.length ? `Not counted: ${h.unpriced.map((u) => `$${u.symbol} (${u.why})`).join(", ")}.` : "";
  $("rotateBox").hidden = !h.left;
  $("rotateTxt").textContent = h.left ? `${h.left} token${h.left > 1 ? "s" : ""} you hold ${h.left > 1 ? "have" : "has"} left the seven. A rotation sells ${h.left > 1 ? "them" : "it"} and moves the ETH to the slots you are lightest in.` : "";
  $("sellBtn").disabled = !h.held.length;
}

async function loadWallet(fresh = false) {
  $("wErr").textContent = "";
  try { hold = await api("/api/wallet" + (fresh ? "?fresh=1" : "")); renderWallet(); }
  catch (e) { if (e.status === 401) return boot(); $("wErr").textContent = e.message; }
}

// ---------- the buy box: a live preview of the split ----------
function renderSplit() {
  const v = +$("amount").value, ms = st?.quiver.members || [];
  if (!ms.length) { $("split").innerHTML = `<li>No token passes the rule right now, so there is nothing to buy.</li>`; return; }
  // Chiron's own token takes its share first; the seven split the rest
  const own = st?.own?.tradable ? st.own : null, rest = own ? 1 - own.share : 1;
  const row = (name, part) => `<li><span>${name}</span><b>${v > 0 ? ethf(v * part, 5) + " ETH" : Math.round(part * 100) + "%"}</b></li>`;
  $("split").innerHTML = ms.map((m) => row("$" + esc(m.symbol), m.weight * rest)).join("") + (own ? row("$" + esc(own.symbol), own.share) : "");
  $("ownTxt").hidden = !own;
  if (own) $("ownTxt").textContent = `${Math.round(own.share * 100)}% of each buy goes into $${own.symbol}, Chiron's own token, as a last step you sign.`;
}
$("amount").addEventListener("input", renderSplit);
$("presets").onclick = (e) => {
  const v = e.target.dataset?.v; if (!v) return;
  $("amount").value = v === "max" ? String(hold?.eth.free ?? "") : v; renderSplit();
};
$("slip").onchange = async () => { try { await api("/api/settings", { method: "POST", body: JSON.stringify({ slippage: +$("slip").value }) }); toast("Slippage limit saved"); } catch (e) { toast(e.message); } };

// ---------- plans ----------
const TITLES = { buy: "Buy", rotate: "Rotate", sell: "Sell" };
async function makePlan(action, errEl, eth) {
  if (running) return;
  errEl.textContent = "";
  try {
    const p = await api("/api/plan", { method: "POST", body: JSON.stringify({ action, eth }) });
    if (!p.id) { errEl.textContent = p.note; return; }
    plan = p;
    $("planbox").hidden = false; $("planTitle").textContent = `${TITLES[action]}: ${p.steps.length} step${p.steps.length > 1 ? "s" : ""} to sign`;
    $("planNote").textContent = p.note; $("runErr").textContent = ""; $("runOk").textContent = "";
    $("steps").innerHTML = p.steps.map((s, i) => `<li id="st${i}"><span>${esc(s.text)}</span><span class="st">waiting</span></li>`).join("");
    $("run").hidden = false; $("run").disabled = false; $("cancel").hidden = false;
    $("planbox").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  } catch (e) { if (e.status === 401) return boot(); errEl.textContent = e.message; }
}

const mark = (i, cls, text, link) => { const li = $("st" + i); if (!li) return; li.className = cls; li.querySelector(".st").innerHTML = link ? `<a class="link" href="${explorer}/tx/${link}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text); };
async function sendTx(tx) {
  await ensureChain();
  return wal.request({ method: "eth_sendTransaction", params: [{ from: me, to: tx.to, data: tx.data, value: tx.value }] });
}
async function confirmTx(i, hash, approve) {
  for (let k = 0; k < 30; k++) {
    const r = await api("/api/step/done", { method: "POST", body: JSON.stringify({ plan: plan.id, i, hash, approve }) }).catch((e) => ({ error: e.message }));
    if (r.error) throw new Error(r.error);
    if (!r.pending) return r.ok;
  }
  throw new Error("The transaction is taking long. Check it in the explorer, then refresh.");
}

async function run() {
  if (!plan || running) return;
  running = true; stopping = false; $("stop").disabled = false; $("runErr").textContent = ""; $("runOk").textContent = "";
  $("run").disabled = true; $("stop").hidden = false; $("cancel").hidden = true;
  try {
    for (let i = 0; i < plan.steps.length; i++) {
      if (stopping) throw new Error("Stopped. Steps already signed stay done. Make a new plan for the rest.");
      mark(i, "", "pricing");
      let b = await api("/api/step", { method: "POST", body: JSON.stringify({ plan: plan.id, i }) });
      if (b.approve) {
        mark(i, "", "approve in your wallet");
        const h = await sendTx(b.approve);
        mark(i, "", "approving", h);
        if (!(await confirmTx(i, h, true))) throw new Error("The approval failed on chain.");
        b = await api("/api/step", { method: "POST", body: JSON.stringify({ plan: plan.id, i }) });
      }
      mark(i, "", `sign in your wallet, expect ${b.expect || "–"}`);
      const hash = await sendTx(b.tx);
      mark(i, "", "confirming", hash);
      const ok = await confirmTx(i, hash, false);
      mark(i, ok ? "done" : "fail", ok ? "done" : "failed", hash);
      if (!ok) throw new Error(`Step ${i + 1} failed on chain, most often because the price moved past your slippage limit. Nothing after it was sent.`);
    }
    $("runOk").textContent = "Every step is done.";
    $("run").hidden = true;
  } catch (e) { $("runErr").textContent = walletErr(e); $("run").hidden = true; }
  finally {
    running = false; $("stop").hidden = true; $("cancel").hidden = false; plan = null;
    setTimeout(() => { loadWallet(true); api("/api/me").then((u) => renderRuns(u.runs)).catch(() => {}); }, 2500);
  }
}

function renderRuns(runs) {
  if (!runs?.length) return;
  $("runs").innerHTML = runs.map((r) => `<tr><td class="mute">${ago(r.at)}</td><td>${esc(r.text)}</td><td class="r">${r.ok ? "done" : "failed"} <a class="link" href="${explorer}/tx/${r.hash}" target="_blank" rel="noopener">tx</a></td></tr>`).join("");
}

$("signin").onclick = signIn;
$("connect").onclick = () => (me ? show("wallet") : signIn());
$("refresh").onclick = () => loadWallet(true);
$("buyBtn").onclick = () => { const v = +$("amount").value; if (!(v > 0)) { $("buyErr").textContent = "Enter how much ETH to spend."; return; } makePlan("buy", $("buyErr"), v); };
$("rotateBtn").onclick = () => makePlan("rotate", $("wErr"));
$("sellBtn").onclick = () => makePlan("sell", $("wErr"));
$("run").onclick = run;
$("stop").onclick = () => { stopping = true; $("stop").disabled = true; };
$("cancel").onclick = () => { if (running) return; plan = null; $("planbox").hidden = true; };
$("signout").onclick = () => api("/api/auth/logout", { method: "POST" }).finally(() => location.reload());
wal?.on?.("accountsChanged", (a) => { if (me && a[0]?.toLowerCase() !== me) api("/api/auth/logout", { method: "POST" }).finally(() => location.reload()); });
boot();
