// The record: three paper books of 0.1 ETH each, filled at live Pons curve quotes (curve fee and creator tax
// included, nothing is sent). Everything is counted in ETH, so "just holding ETH" is the flat line at zero.
//   quiver  the seven slots, rotated by the rule
//   still   the opening seven, never rotated: shows whether rotating earns its keep
//   single  everything in the busiest token: shows what spreading the buy is worth
import { ethers } from "ethers";
import { plan, RULES } from "./quiver.mjs";
import { curves, curveSellQuote, curveBuyQuote, lc } from "./chain.mjs";

export const START = 0.1;      // retail size: a paper buy does not move the real curve, so a big book would overstate its own price impact
export const OPEN_AT = 4;      // the books open once this many slots are filled
export const BOOKS = {
  quiver: { name: "The quiver", note: "seven slots, rotated by the rule" },
  still: { name: "Never rotated", note: "the opening tokens, held as they were" },
  single: { name: "One token", note: "everything in the busiest one" },
};

const book = () => ({ cash: 0, pos: {}, mark: {}, trades: [], equity: [] });   // pos[token] = { raw, symbol, curve }
export const fresh = () => ({ started: null, books: Object.fromEntries(Object.keys(BOOKS).map((k) => [k, book()])) });

const num = (wei) => +ethers.formatEther(wei);
const usable = (c) => c && !c.graduated && c.tr > 0n;
const log = (b, side, what, eth, why) => { b.trades.unshift({ t: Date.now(), side, what, eth: +eth.toFixed(6), why }); b.trades.length = Math.min(b.trades.length, 120); };

function buy(b, m, eth, live, why) {
  const c = live[lc(m.curve)]; eth = Math.min(eth, b.cash);
  if (!usable(c) || eth < RULES.minBuyEth) return 0;
  const got = curveBuyQuote(c, ethers.parseEther(eth.toFixed(18)));
  const p = (b.pos[m.token] ||= { raw: "0", symbol: m.symbol, curve: m.curve });
  p.raw = (BigInt(p.raw) + got).toString(); b.cash -= eth;
  log(b, "buy", "$" + m.symbol, eth, why);
  return eth;
}
function sell(b, token, live, why) {
  const p = b.pos[token], c = p && live[lc(p.curve)];
  if (!p || !usable(c)) return 0;
  const eth = num(curveSellQuote(c, BigInt(p.raw)));
  b.cash += eth; delete b.pos[token]; delete b.mark[token];
  log(b, "sell", "$" + p.symbol, eth, why);
  return eth;
}
/** value of every position at its curve now; a curve that cannot be read keeps its last mark */
function remark(b, live) {
  for (const [t, p] of Object.entries(b.pos)) { const c = live[lc(p.curve)]; if (usable(c)) b.mark[t] = num(curveSellQuote(c, BigInt(p.raw))); }
  return b.cash + Object.keys(b.pos).reduce((s, t) => s + (b.mark[t] || 0), 0);
}

function open(H, members, live) {
  const top = [...members].sort((a, b) => b.volEth - a.volEth)[0];
  for (const [k, b] of Object.entries(H.books)) {
    b.cash = START;
    if (k === "single") buy(b, top, START, live, "opening: all in the busiest token");
    else for (const m of members) buy(b, m, START * m.weight, live, "opening: split by share");
  }
  H.started = Date.now();
}

/**
 * One step: open the books once enough slots are filled, close what graduated at its last curve value,
 * let the quiver book follow the rule (sell what left, spread the ETH over the lightest members), and record equity.
 */
export async function step(H, members) {
  const all = new Set(members.map((m) => lc(m.curve)));
  for (const b of Object.values(H.books)) for (const p of Object.values(b.pos)) all.add(lc(p.curve));
  if (!all.size) return;
  const live = await curves([...all]);
  if (!H.started) {
    const ready = members.filter((m) => usable(live[lc(m.curve)]));
    if (ready.length < OPEN_AT || ready.length !== members.length) return;
    open(H, members, live);
  }
  for (const b of Object.values(H.books)) for (const [t, p] of Object.entries(b.pos)) {
    if (live[lc(p.curve)]?.graduated) { const v = b.mark[t] || 0; b.cash += v; log(b, "close", "$" + p.symbol, v, "graduated off its curve; closed at its last curve value"); delete b.pos[t]; delete b.mark[t]; }
  }
  const q = H.books.quiver;
  remark(q, live);
  const isMember = new Set(members.map((m) => m.token));
  const held = Object.entries(q.pos).map(([token, p]) => ({ token, symbol: p.symbol, curve: p.curve, raw: p.raw, eth: q.mark[token] || 0, member: isMember.has(token) }));
  const leaving = held.some((h) => !h.member && usable(live[lc(h.curve)]));
  if (members.length && (leaving || q.cash >= 0.002)) {
    const p = plan({ action: "rotate", members, held, spare: q.cash });
    for (const s of p.sells) sell(q, s.token, live, "left the quiver");
    for (const b of p.buys) buy(q, b, b.eth, live, "rotation: filling the lightest slots");
  }
  const t = Date.now();
  for (const b of Object.values(H.books)) {
    b.equity.push([t, +remark(b, live).toFixed(6)]);
    // five-minute points for a day, hourly before that
    const cut = t - 86_400_000;
    b.equity = b.equity.filter(([ts], i, a) => ts >= cut || i === a.length - 1 || Math.floor(ts / 3_600_000) !== Math.floor(a[i + 1][0] / 3_600_000));
  }
}

/** the public view of the books */
export function view(H) {
  return Object.fromEntries(Object.entries(H.books).map(([k, b]) => {
    const last = b.equity[b.equity.length - 1]?.[1] ?? START;
    return [k, { ...BOOKS[k], equity: last, ret: +((last / START - 1) * 100).toFixed(2), cash: +b.cash.toFixed(6),
      pos: Object.entries(b.pos).map(([t, p]) => ({ token: t, symbol: p.symbol, eth: +(b.mark[t] || 0).toFixed(6) })).sort((a, c) => c.eth - a.eth),
      trades: b.trades.slice(0, 40), curve: b.equity }];
  }));
}
