// The quiver rule, as pure functions: which memecoins hold the seven slots, how one buy is split across them,
// and what a wallet's plan looks like. The same functions move the paper books, so the record on the site is the rule itself.

export const RULES = {
  size: 7,            // slots in the quiver
  minVolEth: 0.5,     // 24 h Pons volume a token needs to get in
  keepVolEth: 0.2,    // 24 h volume under which a member is dropped
  minAgeH: 6,         // hours since launch before a token can get in
  maxRisk: 30,        // rug-scan score (0-100) a token must stay under, with no high flag
  maxCostBps: 500,    // curve fee + creator tax per trade (in 1/100 %) a token may charge to get in
  capWeight: 0.25,    // the largest share one token may take
  minBuyEth: 0.0002,  // buys under this are skipped
};

/**
 * Should a member stay? `s` is its latest reading: { graduated, scan: { ok, why } | null, volEth }.
 * Returns null to keep it, or the reason it leaves. A reading that failed (null fields) never drops a member.
 */
export function verdict(s, R = RULES) {
  if (!s) return null;
  if (s.graduated === true) return "graduated off its Pons curve";
  if (s.scan && s.scan.ok === false && s.scan.risk != null) return `failed the rug scan: ${s.scan.why}`;
  if (s.volEth != null && s.volEth < R.keepVolEth) return `24 h volume fell to ${s.volEth.toFixed(2)} ETH`;
  return null;
}

/**
 * Shares for a list of tokens with a 24 h volume: the square root of volume, no token above the cap.
 * Returns the shares in the same order; they add up to 1.
 */
export function weigh(list, cap = RULES.capWeight) {
  const n = list.length;
  if (!n) return [];
  const limit = Math.max(cap, 1 / n);
  const raw = list.map((t) => Math.sqrt(Math.max(t.volEth || 0, 1e-6)));
  const w = new Array(n).fill(0), fixed = new Array(n).fill(false);
  for (let pass = 0; pass < n; pass++) {
    const room = 1 - w.reduce((s, x, i) => s + (fixed[i] ? x : 0), 0);
    const sum = raw.reduce((s, x, i) => s + (fixed[i] ? 0 : x), 0);
    let over = false;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      w[i] = (raw[i] / sum) * room;
      if (w[i] > limit + 1e-12) { w[i] = limit; fixed[i] = true; over = true; }
    }
    if (!over) break;
  }
  return w;
}

/**
 * One draw. `prev` are the current members, `readings[token]` their latest reading (see verdict),
 * `cands` the outsiders that qualify right now, best first. Members that still fly straight keep their slot;
 * free slots go to the best candidates. Returns { members (with weight), ins, outs }.
 */
export function draw(prev, readings, cands, now, R = RULES) {
  const members = [], outs = [], ins = [];
  for (const m of prev) {
    const s = readings[m.token], why = verdict(s, R);
    if (why) { outs.push({ token: m.token, symbol: m.symbol, curve: m.curve, why }); continue; }
    members.push({ ...m, volEth: s?.volEth ?? m.volEth, risk: s?.scan?.risk ?? m.risk, cost: s?.cost ?? m.cost ?? null });
  }
  const have = new Set([...members.map((m) => m.token), ...outs.map((o) => o.token)]);
  for (const c of cands) {
    if (members.length >= R.size) break;
    if (have.has(c.token)) continue;
    have.add(c.token);
    const m = { token: c.token, symbol: c.symbol, curve: c.curve, volEth: c.volEth, risk: c.risk, cost: c.cost ?? null, since: now };
    members.push(m); ins.push(m);
  }
  const w = weigh(members, R.capWeight);
  members.forEach((m, i) => { m.weight = +w[i].toFixed(4); });
  return { members, ins, outs };
}

const round = (x) => Math.round(x * 1e8) / 1e8;

/**
 * A plan for one wallet (or one paper book).
 *   action "buy":    spend `eth` across the members by weight
 *   action "rotate": sell what is held but no longer a member, spread that ETH (plus `spare`) over the members furthest under their share
 *   action "sell":   sell everything held
 * `held` = [{ token, symbol, curve, raw, eth, member }] where eth is what selling it all returns now.
 * Returns { action, sells: [{ token, symbol, curve, raw, eth }], buys: [{ token, symbol, curve, eth }], note }.
 */
export function plan({ action, eth = 0, members = [], held = [], spare = 0 }, R = RULES) {
  const out = { action, sells: [], buys: [], note: "" };
  const sellAll = (h) => ({ token: h.token, symbol: h.symbol, curve: h.curve, raw: String(h.raw), eth: round(h.eth) });
  const buy = (m, x) => ({ token: m.token, symbol: m.symbol, curve: m.curve, eth: round(x) });

  if (action === "sell") {
    out.sells = held.filter((h) => h.eth > 0).map(sellAll);
    out.note = out.sells.length ? "Every quiver token in the wallet goes back to ETH." : "There is nothing from the quiver in this wallet.";
    return out;
  }
  if (!members.length) { out.note = "The quiver is empty right now: no token passes the rule."; return out; }

  if (action === "buy") {
    if (!(eth > 0)) { out.note = "Enter how much ETH to spend."; return out; }
    out.buys = members.map((m) => buy(m, eth * m.weight)).filter((b) => b.eth >= R.minBuyEth);
    out.note = out.buys.length ? `${round(eth)} ETH split across ${out.buys.length} tokens by their share.` : `That amount is too small to split: each buy would be under ${R.minBuyEth} ETH.`;
    return out;
  }

  if (action === "rotate") {
    const isMember = new Set(members.map((m) => m.token));
    const leaving = held.filter((h) => !isMember.has(h.token) && h.eth > 0);
    out.sells = leaving.map(sellAll);
    // 2% is held back from the sale: the price can move between the plan and the last signature
    const fresh = leaving.reduce((s, h) => s + h.eth, 0) * 0.98 + spare;
    if (!(fresh > 0)) { out.note = "Nothing you hold has left the quiver. No rotation needed."; return out; }
    const have = Object.fromEntries(held.filter((h) => isMember.has(h.token)).map((h) => [h.token, h.eth]));
    const total = Object.values(have).reduce((s, x) => s + x, 0) + fresh;
    const gaps = members.map((m) => Math.max(0, total * m.weight - (have[m.token] || 0)));
    const gapSum = gaps.reduce((s, x) => s + x, 0);
    if (gapSum > 0) out.buys = members.map((m, i) => buy(m, (fresh * gaps[i]) / gapSum)).filter((b) => b.eth >= R.minBuyEth);
    out.note = out.sells.length
      ? `${out.sells.length} token${out.sells.length > 1 ? "s" : ""} left the quiver. They are sold and the ETH goes to the members you are lightest in.`
      : "Free ETH goes to the members furthest under their share.";
    return out;
  }
  throw new Error("Unknown action.");
}
