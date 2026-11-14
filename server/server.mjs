// CHIRON server: reads Pons every minute, redraws the quiver every thirty, runs the paper books, and serves the site
// and a JSON API. Users sign in with one signed message; every plan is a list of transactions their wallet signs.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { ethPrice, lc, multicall, curves, factoryI, provider, PONS_FACTORY, CHAIN_ID, EXPLORER } from "./chain.mjs";
import * as memes from "./memes.mjs";
import * as record from "./record.mjs";
import { RULES, verdict, draw, plan } from "./quiver.mjs";
import * as W from "./wallet.mjs";
import * as T from "./burn.mjs";
import { rpcHealth } from "./rpc.mjs";

const PORT = +(process.env.PORT || 5496), HOST = process.env.HOST || "127.0.0.1";
const DATA = fileURLToPath(new URL("../data/", import.meta.url)), SITE = fileURLToPath(new URL("../site/", import.meta.url));
const LOGO = fileURLToPath(new URL("../logo/", import.meta.url));   // the logo files, served at /logo/
const FILE = path.join(DATA, "state.json");
fs.mkdirSync(DATA, { recursive: true });
const DRAW_EVERY = 30 * 60_000;

// ---------- state ----------
const S = (() => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; } })();
S.quiver ||= { members: [], at: null, log: [] }; S.alumni ||= []; S.record ||= record.fresh(); S.users ||= {};
S.secret ||= crypto.randomBytes(32).toString("hex");
let dirty = true;
const save = () => { if (!dirty) return; const tmp = FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(S), { mode: 0o600 }); fs.renameSync(tmp, FILE); dirty = false; };
setInterval(save, 30_000);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { dirty = true; save(); } finally { process.exit(0); } });

const errors = {};
const note = (k, e) => { errors[k] = e ? { at: Date.now(), msg: String(e.message || e).slice(0, 200) } : null; if (e) console.error(`[${k}]`, e.message || e); };

// ---------- Chiron's own token (its CA is set in /studio) ----------
// A share of every buy goes into it, as a step of its own, while it is still on its Pons curve.
const OWN_SHARE = Math.min(0.25, Math.max(0, Number(process.env.CHIRON_SHARE ?? 0.1) || 0));
let ownCache = { at: 0, v: null };
async function ownToken() {
  if (Date.now() - ownCache.at < 5 * 60_000) return ownCache.v;
  let v = null;
  try {
    const cfg = T.tokenConfig();
    if (cfg.ca && OWN_SHARE > 0) {
      const rec = (await multicall([[PONS_FACTORY, factoryI, "getLaunchedToken", [cfg.ca]]]))[0]?.[0];
      if (rec && rec.exists && rec.pairToken === ethers.ZeroAddress) {
        const curve = lc(rec.curve), live = (await curves([curve]))[curve];
        v = { token: lc(cfg.ca), symbol: cfg.symbol, curve, share: OWN_SHARE, tradable: !!live && !live.graduated };
      }
    }
    note("own");
  } catch (e) { note("own", e); return ownCache.v; }
  ownCache = { at: Date.now(), v };
  return v;
}

// the buyback wallet's balance, shown on the site: what is left to spend on buybacks
let buybackEth = null;
async function readWallets() { try { buybackEth = +(+ethers.formatEther(await provider.getBalance(T.WALLETS.buyback))).toFixed(5); note("wallets"); } catch (e) { note("wallets", e); } }

// ---------- loops ----------
let eth = S.eth || null, polledAt = 0;
async function minute() {
  try { await memes.poll(); polledAt = Date.now(); note("pons"); } catch (e) { note("pons", e); }
  ownToken(); readWallets();
  try { eth = await ethPrice(); S.eth = eth; S.ethAt = Date.now(); note("price"); dirty = true; } catch (e) { note("price", e); }
}

let drawing = false;
/** keep the members that still pass, drop the ones that do not, fill free slots with the best candidates */
async function redraw() {
  if (drawing) return;
  if (Date.now() - polledAt > 10 * 60_000) return;            // never judge volume on stale trades
  drawing = true;
  try {
    const prev = S.quiver.members, now = Date.now();
    const read = await memes.readings(prev);
    const staying = prev.filter((m) => !verdict(read[m.token])).length;
    const cands = await memes.candidates(RULES.size - staying, { minVolEth: RULES.minVolEth, minAgeH: RULES.minAgeH, maxCostBps: RULES.maxCostBps, skip: new Set(prev.map((m) => m.token)) });
    const d = draw(prev, read, cands, now);
    for (const o of d.outs) {
      S.quiver.log.unshift({ t: now, type: "out", token: o.token, symbol: o.symbol, why: o.why });
      S.alumni = [{ token: o.token, symbol: o.symbol, curve: o.curve, why: o.why, out: now }, ...S.alumni.filter((a) => a.token !== o.token)];
    }
    for (const m of d.ins) S.quiver.log.unshift({ t: now, type: "in", token: m.token, symbol: m.symbol, why: `${m.volEth.toFixed(2)} ETH traded in 24 h, rug risk ${m.risk}/100` });
    S.quiver.log.length = Math.min(S.quiver.log.length, 200);
    S.alumni = S.alumni.filter((a) => now - a.out < 90 * 86_400_000).slice(0, 80);
    S.quiver.members = d.members; S.quiver.at = now; dirty = true;
    note("quiver");
  } catch (e) { note("quiver", e); } finally { drawing = false; }
}

async function books() {
  try { await record.step(S.record, S.quiver.members); note("record"); dirty = true; } catch (e) { note("record", e); }
}

(async () => {
  ownToken(); readWallets();                                // looked up at once, not after the first long read of Pons
  await minute();
  setInterval(minute, 60_000);
  await redraw(); setInterval(redraw, DRAW_EVERY);
  // a first start with no trades read yet finds no candidate: look again soon instead of waiting half an hour
  const early = setInterval(() => { if (S.quiver.members.length >= RULES.size) clearInterval(early); else redraw(); }, 5 * 60_000);
  await books(); setInterval(books, 5 * 60_000);
})();

// ---------- sessions: one signed message, then an HMAC cookie ----------
const nonces = new Map();
const hmac = (s) => crypto.createHmac("sha256", S.secret).update(s).digest("base64url");
const mint = (addr) => { const exp = Date.now() + 7 * 86_400_000, body = `${addr}.${exp}`; return `${body}.${hmac(body)}`; };
function whoami(req) {
  const c = (req.headers.cookie || "").split(/;\s*/).find((p) => p.startsWith("chiron="))?.slice(7);
  if (!c) return null;
  const [addr, exp, mac] = c.split(".");
  if (!addr || !exp || !mac || +exp < Date.now()) return null;
  const want = hmac(`${addr}.${exp}`);
  return want.length === mac.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac)) ? addr : null;
}
const loginMessage = (addr, nonce) => `Sign in to CHIRON\n\nThis signature proves you own this wallet. It sends nothing and costs no gas.\n\nWallet: ${addr}\nChain: Robinhood Chain (${CHAIN_ID})\nNonce: ${nonce}`;
const isLocal = (req) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || "");

// ---------- plans: built per user, kept 15 minutes ----------
const plans = new Map();                                   // id -> { address, steps, at, action }
const cleanSlip = (v) => (Number.isFinite(+v) ? Math.min(0.1, Math.max(0.005, +v)) : 0.03);
const userOf = (a) => (S.users[a] ||= { slippage: 0.03, runs: [] });
const walletCache = new Map();
async function wallet(addr, fresh = false) {
  const c = walletCache.get(addr);
  if (c && !fresh && Date.now() - c.at < 15_000) return c.v;
  const v = await W.holdings(addr, S.quiver.members, S.alumni, eth?.mid, await ownToken());
  walletCache.set(addr, { at: Date.now(), v }); if (walletCache.size > 2000) walletCache.clear();
  return v;
}

// ---------- http ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon" };
const send = (res, code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...headers }); res.end(JSON.stringify(body)); };
const body = (req) => new Promise((ok, no) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > 20_000) { no(new Error("Request too large.")); req.destroy(); } }); req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { no(new Error("Bad JSON.")); } }); });
const ipOf = (req) => (/^(::ffff:)?127\.0\.0\.1$|^::1$/.test(req.socket.remoteAddress || "") && req.headers["x-real-ip"]) || req.socket.remoteAddress || "";
const hits = new Map();
const limited = (key, n, ms) => { const now = Date.now(), a = (hits.get(key) || []).filter((t) => now - t < ms); a.push(now); hits.set(key, a); if (hits.size > 20_000) hits.clear(); return a.length > n; };

// pictures the owner has dropped into site/img: chapters (ch-seven, ch-rule, ch-record, ch-limits) and the walker's cut-out (chiron)
const chapterArt = () => { try { return fs.readdirSync(path.join(SITE, "img")).filter((f) => /^(ch-[a-z]+|chiron)\.(webp|jpe?g|png|avif)$/i.test(f)); } catch { return []; } };

function publicState() {
  const q = S.quiver;
  return {
    now: Date.now(), chainId: CHAIN_ID, explorer: EXPLORER, ethUsd: eth?.mid || null, rules: RULES, art: chapterArt(), wallets: { creator: T.WALLETS.creator, buyback: T.WALLETS.buyback, buybackEth },
    own: ownCache.v && { token: ownCache.v.token, symbol: ownCache.v.symbol, share: ownCache.v.share, tradable: ownCache.v.tradable },
    quiver: {
      at: q.at, next: q.at ? q.at + DRAW_EVERY : null, size: RULES.size,
      members: q.members.map((m) => { const s = memes.series(m.token, 48); return { token: m.token, symbol: m.symbol, weight: m.weight, volEth: +m.volEth.toFixed(3), risk: m.risk, cost: m.cost ?? null, since: m.since, change: s.change, spark: s.pts.map((p) => p[1]) }; }),
      log: q.log.slice(0, 40),
    },
    market: memes.marketWindow(24),
    record: record.view(S.record), recordStarted: S.record.started, start: record.START, openAt: record.OPEN_AT,
    health: { rpc: rpcHealth(), errors: Object.fromEntries(Object.entries(errors).filter(([, v]) => v && Date.now() - v.at < 15 * 60_000)), block: memes.M.block, polledAt },
  };
}

// /studio: the owner sets the CA and runs buybacks by hand
const digest = (x) => crypto.createHash("sha256").update(String(x)).digest(), misses = new Map();
function studioOk(req) {
  const ip = ipOf(req), now = Date.now(), m = (misses.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  if (m.length >= 10) return "locked";
  if (crypto.timingSafeEqual(digest(req.headers["x-studio-key"] || ""), digest(T.STUDIO_KEY))) return "ok";
  misses.set(ip, [...m, now]); if (misses.size > 5000) misses.clear(); return "bad";
}
async function studio(req, res, p) {
  const a = studioOk(req); if (a !== "ok") return send(res, a === "locked" ? 429 : 401, { error: a === "locked" ? "Too many wrong keys. Wait 10 minutes." : "Wrong studio key." });
  const k = `${req.method} ${p.slice("/api/studio".length)}`;
  if (k === "GET /status") return send(res, 200, await T.status());
  if (k === "POST /token") { const r = await T.saveToken(await body(req)); ownCache.at = 0; await ownToken(); return send(res, 200, r); }
  if (k === "POST /wallet") return send(res, 200, T.saveKey((await body(req)).privateKey || ""));
  if (k === "DELETE /wallet") return send(res, 200, T.removeKey());
  if (k === "POST /buyback") return send(res, 200, await T.buyback((await body(req)).usd));
  if (k === "POST /supply") return send(res, 200, await T.burnSupply((await body(req)).usd));
  if (k === "POST /burn-held") return send(res, 200, await T.burnHeld());
  return send(res, 404, { error: "Not found." });
}

async function api(req, res, p) {
  const m = req.method, me = whoami(req), ip = ipOf(req);
  if (p === "/api/state" && m === "GET") return send(res, 200, publicState());
  if (p === "/api/token" && m === "GET") return send(res, 200, await T.publicView());
  if (p.startsWith("/api/studio/")) return studio(req, res, p);

  if (p === "/api/auth/nonce" && m === "POST") {
    if (limited("nonce:" + ip, 20, 60_000)) return send(res, 429, { error: "Slow down a little." });
    const { address } = await body(req);
    if (!ethers.isAddress(address || "")) return send(res, 400, { error: "That is not a wallet address." });
    const nonce = crypto.randomBytes(12).toString("hex");
    nonces.set(nonce, Date.now() + 5 * 60_000); if (nonces.size > 10_000) nonces.clear();
    return send(res, 200, { message: loginMessage(ethers.getAddress(address), nonce) });
  }
  if (p === "/api/auth/verify" && m === "POST") {
    const { message, signature } = await body(req);
    const nonce = /Nonce: ([0-9a-f]{24})$/.exec(message || "")?.[1], claimed = /Wallet: (0x[0-9a-fA-F]{40})/.exec(message || "")?.[1];
    if (!nonce || !claimed || !(nonces.get(nonce) > Date.now())) return send(res, 400, { error: "This sign-in request expired. Try again." });
    nonces.delete(nonce);
    let signer; try { signer = ethers.verifyMessage(message, signature); } catch { return send(res, 400, { error: "Bad signature." }); }
    if (lc(signer) !== lc(claimed)) return send(res, 401, { error: "The signature is from another wallet." });
    userOf(lc(signer)); dirty = true;
    return send(res, 200, { address: lc(signer) }, { "set-cookie": `chiron=${mint(lc(signer))}; Path=/; HttpOnly; SameSite=Lax;${isLocal(req) ? "" : " Secure;"} Max-Age=${7 * 86400}` });
  }
  if (p === "/api/auth/logout" && m === "POST") return send(res, 200, { ok: true }, { "set-cookie": "chiron=; Path=/; Max-Age=0" });

  if (!me) return send(res, 401, { error: "Sign in with your wallet first." });
  const u = userOf(me);
  if (p === "/api/me" && m === "GET") return send(res, 200, { address: me, slippage: cleanSlip(u.slippage), runs: u.runs.slice(0, 50) });
  if (p === "/api/settings" && m === "POST") {
    u.slippage = cleanSlip((await body(req)).slippage); dirty = true;
    return send(res, 200, { slippage: u.slippage });
  }
  if (p === "/api/wallet" && m === "GET") {
    if (limited("w:" + me, 12, 60_000)) return send(res, 429, { error: "Give it a few seconds between refreshes." });
    return send(res, 200, await wallet(me, new URL(req.url, "http://x").searchParams.has("fresh")));
  }
  if (p === "/api/plan" && m === "POST") {
    if (limited("plan:" + me, 12, 60_000)) return send(res, 429, { error: "Give it a few seconds between plans." });
    const b = await body(req), action = String(b.action || "");
    if (!["buy", "rotate", "sell"].includes(action)) return send(res, 400, { error: "Unknown action." });
    const h = await wallet(me, true), amount = +b.eth;
    if (action === "buy") {
      if (!(amount > 0)) return send(res, 400, { error: "Enter how much ETH to spend." });
      if (amount > h.eth.free) return send(res, 400, { error: `This wallet has ${h.eth.free} ETH free to spend (a little is kept aside for gas).` });
    }
    const mine = await ownToken();
    const pl = plan({ action, eth: amount, members: S.quiver.members, held: h.held, own: mine?.tradable ? mine : null });
    const steps = W.stepsFor(pl), id = steps.length ? crypto.randomBytes(8).toString("hex") : null;
    if (id) plans.set(id, { address: me, steps, at: Date.now(), action });
    for (const [k, v] of plans) if (Date.now() - v.at > 15 * 60_000) plans.delete(k);
    return send(res, 200, { id, action, note: pl.note, steps: steps.map((s) => ({ kind: s.kind, symbol: s.symbol, token: s.token, eth: s.eth, text: W.describe(s) })) });
  }
  if (p === "/api/step" && m === "POST") {
    const { plan: id, i } = await body(req);
    const P = plans.get(id);
    if (!P || P.address !== me) return send(res, 404, { error: "This plan expired. Make a new one." });
    const step = P.steps[i]; if (!step) return send(res, 400, { error: "No such step." });
    return send(res, 200, await W.build(step, me, cleanSlip(u.slippage)));
  }
  if (p === "/api/step/done" && m === "POST") {
    const { plan: id, i, hash, approve } = await body(req);
    const P = plans.get(id);
    if (!P || P.address !== me || !P.steps[i] || !/^0x[0-9a-fA-F]{64}$/.test(hash || "")) return send(res, 400, { error: "Unknown plan or hash." });
    const r = await W.receipt(hash);
    if (!r) return send(res, 202, { pending: true });
    if (r.from !== me) return send(res, 400, { error: "That transaction was not sent by your wallet." });
    if (!approve) {
      u.runs.unshift({ at: Date.now(), action: P.action, text: W.describe(P.steps[i]), hash, ok: r.ok });
      u.runs.length = Math.min(u.runs.length, 200); walletCache.delete(me); dirty = true;
    }
    return send(res, 200, { ok: r.ok, block: r.block });
  }
  return send(res, 404, { error: "Not found." });
}

const ROUTES = { "/": "index.html", "/app": "app.html", "/studio": "studio.html" };
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname.startsWith("/api/")) {
    try { return await api(req, res, u.pathname); }
    catch (e) { return send(res, 400, { error: e.shortMessage || e.message || "Something went wrong." }); }
  }
  const logo = u.pathname.startsWith("/logo/"), base = logo ? LOGO : SITE;
  const rel = logo ? u.pathname.slice(6) : ROUTES[u.pathname] || u.pathname.slice(1);
  const f = path.normalize(path.join(base, rel));
  if (!f.startsWith(base) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
  const ext = path.extname(f), mtime = fs.statSync(f).mtime.toUTCString();
  // pages, styles and scripts are checked on every load, so a new stylesheet never meets an old page
  if (req.headers["if-modified-since"] === mtime) { res.writeHead(304, { "cache-control": "no-cache", "last-modified": mtime }); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[ext] || "application/octet-stream", "cache-control": /^\.(html|css|js)$/.test(ext) ? "no-cache" : "public, max-age=300", ...(mtime ? { "last-modified": mtime } : {}) });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(f).pipe(res);
}).listen(PORT, HOST, () => console.log(`CHIRON on http://${HOST}:${PORT}`));
