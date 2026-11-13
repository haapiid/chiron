// Every Pons curve trade and every launch on Robinhood Chain, kept as hourly buckets.
// From these come the 24 h volume and price history of each token, and the candidates for the quiver
// (only after the rug scan in scan.mjs passes).
import fs from "node:fs";
import { ethers } from "ethers";
import { provider, curveI, factoryI, erc20I, PONS_FACTORY, multicall, curves, lc, steady, sleep } from "./chain.mjs";
import { scan } from "./scan.mjs";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("../data/memes.json", import.meta.url));
const HOUR = 3_600_000, KEEP_H = 7 * 24, SPAN = 25_000;    // the RPC allows 30k blocks per getLogs
const BACKFILL_H = Number(process.env.MEME_BACKFILL_H || 24);
const LAUNCHED = ethers.id("TokenLaunched(address,address,address,address,uint256,uint256)");
const BUY = curveI.getEvent("CurveBuy").topicHash, SELL = curveI.getEvent("CurveSell").topicHash;

// M.tokens[token] = { curve, symbol, launched, first, last, px, h: { [hourStart]: [buyEth, sellEth, trades, lastPx] } }
// M.hours[hourStart] = [buyEth, sellEth, trades, launches]
export const M = (() => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return { block: 0, tokens: {}, hours: {}, curves: {} }; } })();
M.curves ||= {};
const save = () => { const tmp = FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(M)); fs.renameSync(tmp, FILE); };
const hourOf = (t) => Math.floor(t / HOUR) * HOUR;

// curve -> { token, ethPair } or null, from the factory record (cached on disk: a curve never changes token)
async function curveInfo(addrs) {
  const miss = [...new Set(addrs.map(lc))].filter((a) => !(a in M.curves));
  if (!miss.length) return;
  const toks = await multicall(miss.map((a) => [a, curveI, "token", []]));
  const recs = await multicall(miss.map((a, k) => toks[k] ? [PONS_FACTORY, factoryI, "getLaunchedToken", [toks[k][0]]] : [PONS_FACTORY, factoryI, "getLaunchedToken", [ethers.ZeroAddress]]));
  miss.forEach((a, k) => {
    const r = recs[k]?.[0];
    M.curves[a] = toks[k] && r && r.exists && lc(r.curve) === a && r.pairToken === ethers.ZeroAddress ? lc(toks[k][0]) : null;
  });
}

const tsCache = new Map();
async function timeOf(n) {
  const k = Math.floor(n / 600) * 600;                       // one header per ~1 minute of blocks is close enough for hourly buckets
  if (!tsCache.has(k)) { const b = await steady(() => provider.getBlock(k)); tsCache.set(k, b ? b.timestamp * 1000 : Date.now()); if (tsCache.size > 4000) tsCache.clear(); }
  return tsCache.get(k);
}

async function getLogs(filter, a, b) {
  try { return await steady(() => provider.getLogs({ ...filter, fromBlock: a, toBlock: b })); }
  catch (e) {
    if (b - a < 50) throw e;
    const m = Math.floor((a + b) / 2);                       // more than 10,000 logs in one answer: split the range
    return [...(await getLogs(filter, a, m)), ...(await getLogs(filter, m + 1, b))];
  }
}

async function ingest(a, b) {
  const [trades, launches] = [await getLogs({ topics: [[BUY, SELL]] }, a, b), await getLogs({ address: PONS_FACTORY, topics: [LAUNCHED] }, a, b)];
  await curveInfo(trades.map((l) => l.address));
  const syms = new Set();
  for (const l of launches) {
    const token = lc(ethers.getAddress("0x" + l.topics[1].slice(26))), curve = lc(ethers.getAddress("0x" + l.topics[2].slice(26)));
    const at = await timeOf(l.blockNumber), H = hourOf(at);
    const t = (M.tokens[token] ||= { curve, first: at, last: at, h: {} });
    t.launched = at;
    (M.hours[H] ||= [0, 0, 0, 0])[3]++;
  }
  for (const l of trades) {
    const token = M.curves[lc(l.address)]; if (!token) continue;
    const ev = curveI.parseLog(l), buy = ev.name === "CurveBuy";
    const eth = +ethers.formatEther(buy ? ev.args.quoteIn : ev.args.quoteOut);
    const tok = +ethers.formatUnits(buy ? ev.args.tokensOut : ev.args.tokensIn, 18);
    const at = await timeOf(l.blockNumber), H = hourOf(at);
    const t = (M.tokens[token] ||= { curve: lc(l.address), first: at, last: at, h: {} });
    t.last = Math.max(t.last, at); t.first = Math.min(t.first, at);
    if (tok > 0) t.px = eth / tok;
    const b = (t.h[H] ||= [0, 0, 0]);
    b[buy ? 0 : 1] += eth; b[2]++;
    if (tok > 0) b[3] = t.px;
    const g = (M.hours[H] ||= [0, 0, 0, 0]);
    g[buy ? 0 : 1] += eth; g[2]++;
    if (!t.symbol) syms.add(token);
  }
  if (syms.size) {
    const list = [...syms], r = await multicall(list.map((t) => [t, erc20I, "symbol", []]));
    list.forEach((t, k) => { M.tokens[t].symbol = String(r[k]?.[0] || "?").slice(0, 24); });
  }
}

function prune() {
  const cut = hourOf(Date.now()) - KEEP_H * HOUR;
  for (const H of Object.keys(M.hours)) if (+H < cut) delete M.hours[H];
  for (const [k, t] of Object.entries(M.tokens)) {
    for (const H of Object.keys(t.h)) if (+H < cut) delete t.h[H];
    if (t.last < cut) delete M.tokens[k];
  }
}

let running = false;
/** read every new block since the last poll (the first run reaches back BACKFILL_H hours, slowly) */
export async function poll() {
  if (running) return; running = true;
  try {
    const head = await steady(() => provider.getBlockNumber());
    if (!M.block) M.block = head - Math.round(BACKFILL_H * 3600 * 9.7);   // about 9.7 blocks a second on this chain
    while (M.block < head) {
      const to = Math.min(head, M.block + SPAN);
      await ingest(M.block + 1, to);
      M.block = to;
      if (head - to > SPAN) await sleep(1500);                  // backfill: give the shared RPC room
    }
    prune(); save();
  } finally { running = false; }
}

// ---------- views ----------
// (for a token's buckets only the first three sums mean something: the fourth slot holds a price there)
const sumHours = (h, from, to) => Object.entries(h).filter(([H]) => +H >= from && +H < to).reduce((s, [, v]) => s.map((x, i) => x + (v[i] || 0)), [0, 0, 0, 0]);
/** buy and sell ETH, trades and launches over the last `hours`, and the same per hour over the days before it */
export function marketWindow(hours = 6) {
  // only hours actually read count: right after a start the window may hold less than `hours` of data
  const now = hourOf(Date.now()) + HOUR, first = Math.min(...Object.keys(M.hours).map(Number), now);
  const from = Math.max(now - hours * HOUR, first), span = Math.max(1, (Date.now() - from) / HOUR);
  const recent = sumHours(M.hours, from, now);
  const known = Object.keys(M.hours).map(Number).filter((H) => H < from);
  const baseH = known.length ? (from - Math.min(...known)) / HOUR : 0;
  const base = baseH ? sumHours(M.hours, from - baseH * HOUR, from).map((x) => x / baseH) : null;
  return { hours: +span.toFixed(2), buyEth: recent[0], sellEth: recent[1], trades: recent[2], launches: recent[3], basePerHour: base, baseHours: baseH };
}

/** tokens traded in the last `days`, most active first: the universe used to find a wallet's memecoins */
export function universe(days = 7) {
  const cut = Date.now() - days * 86_400_000;
  return Object.entries(M.tokens).filter(([, t]) => t.last >= cut).map(([token, t]) => ({ token, curve: t.curve, symbol: t.symbol || "?" }));
}

/** 24 h stats per token, for picking */
export function stats(token, hours = 24) {
  const t = M.tokens[lc(token)]; if (!t) return null;
  const now = hourOf(Date.now()) + HOUR, s = sumHours(t.h, now - hours * HOUR, now);
  return { token: lc(token), curve: t.curve, symbol: t.symbol || "?", buyEth: s[0], sellEth: s[1], trades: s[2], volEth: s[0] + s[1], ageH: t.launched ? (Date.now() - t.launched) / HOUR : null, px: t.px || null };
}

// ---------- picks: the memecoins the agent is allowed to buy ----------
const scanned = new Map();                                       // token -> { at, ok, risk, why }
const SCAN_TTL = 30 * 60_000;
export async function vet(token) {
  const k = lc(token), c = scanned.get(k);
  if (c && Date.now() - c.at < SCAN_TTL) return c;
  let out;
  try {
    const s = await scan(provider, k);
    const high = (s.flags || []).filter((f) => f.level === "high").map((f) => f.title);
    out = { at: Date.now(), ok: s.risk.score < 30 && !high.length, risk: s.risk.score, why: high[0] || (s.risk.score >= 30 ? `rug risk ${s.risk.score}/100` : "no red flags in the scan"), symbol: s.facts?.token?.symbol };
  } catch (e) { out = { at: Date.now() - SCAN_TTL + 120_000, ok: false, risk: null, why: `scan did not finish (${e.message.slice(0, 60)})` }; }
  scanned.set(k, out);
  return out;
}

/**
 * Up to `n` outsiders that qualify for a slot right now, busiest first: enough 24 h volume, old enough,
 * still on their curve, not charging more than `maxCostBps` per trade, and passing the rug scan. Tokens in `skip` are left out.
 */
export async function candidates(n, { minVolEth = 0.5, minAgeH = 6, maxCostBps = 500, skip = new Set() } = {}) {
  if (n <= 0) return [];
  const cands = universe(1).filter((u) => !skip.has(u.token)).map((u) => stats(u.token))
    .filter((s) => s && s.volEth >= minVolEth && (s.ageH == null || s.ageH >= minAgeH)).sort((a, b) => b.volEth - a.volEth).slice(0, n * 4);
  if (!cands.length) return [];
  const live = await curves(cands.map((c) => c.curve));
  const out = [];
  for (const c of cands) {
    const cv = live[lc(c.curve)];
    if (!cv || cv.graduated || cv.tr === 0n) continue;
    const cost = Number(cv.fee + cv.tax);                       // what one trade pays: curve fee + creator tax, in 1/100 %
    if (cost > maxCostBps) continue;
    const v = await vet(c.token);
    if (!v.ok) continue;
    out.push({ cost, token: c.token, symbol: String(c.symbol && c.symbol !== "?" ? c.symbol : v.symbol || "?").slice(0, 24), curve: c.curve, volEth: c.volEth, risk: v.risk });
    if (out.length >= n) break;
  }
  return out;
}

/**
 * The latest reading of each member, for the keep-or-drop verdict: { graduated, scan, volEth }.
 * A field that could not be read stays null, so a busy RPC never drops a token by accident.
 */
export async function readings(members) {
  if (!members.length) return {};
  const live = await curves(members.map((m) => m.curve)).catch(() => ({}));
  const out = {};
  for (const m of members) {
    const cv = live[lc(m.curve)], s = stats(m.token);
    out[m.token] = { cost: cv ? Number(cv.fee + cv.tax) : null, graduated: cv ? cv.graduated : null, scan: await vet(m.token).catch(() => null), volEth: s ? s.volEth : 0 };
  }
  return out;
}

/** hourly prices (ETH per token) over the last `hours`, and the move across them */
export function series(token, hours = 48) {
  const t = M.tokens[lc(token)]; if (!t) return { pts: [], change: null };
  const cut = hourOf(Date.now()) - hours * HOUR;
  const pts = Object.entries(t.h).filter(([H, v]) => +H >= cut && v[3] > 0).map(([H, v]) => [+H, v[3]]).sort((a, b) => a[0] - b[0]);
  const day = pts.filter(([H]) => H >= hourOf(Date.now()) - 24 * HOUR);
  const change = day.length > 1 && t.px ? t.px / day[0][1] - 1 : null;
  return { pts, change, px: t.px || null };
}
