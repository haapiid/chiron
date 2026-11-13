// A user's wallet: which quiver tokens it holds, what they are worth, and the unsigned transactions for a plan.
// CHIRON never holds a key for users. Each step is built with a fresh quote right before the wallet signs it.
import { ethers } from "ethers";
import { provider, erc20I, curveI, multicall, curves, curveSellQuote, curveBuyQuote, lc, steady } from "./chain.mjs";

export const GAS_RESERVE = ethers.parseEther(process.env.GAS_RESERVE_ETH || "0.0004");   // left in the wallet for gas
const num = (wei) => +ethers.formatEther(wei);
const r8 = (x) => Math.round(x * 1e8) / 1e8;

/**
 * What `address` holds of the quiver: current members and tokens that left it (`alumni`), each valued at what
 * selling it on its curve returns right now. `ethUsd` only adds dollar figures.
 */
export async function holdings(address, members, alumni, ethUsd) {
  const who = ethers.getAddress(address);
  const seen = new Set(), list = [];
  for (const m of members) { seen.add(m.token); list.push({ token: m.token, symbol: m.symbol, curve: m.curve, member: true, weight: m.weight }); }
  for (const a of alumni) if (!seen.has(a.token)) { seen.add(a.token); list.push({ token: a.token, symbol: a.symbol, curve: a.curve, member: false, weight: 0, why: a.why }); }
  const bal = list.length ? await multicall(list.map((t) => [t.token, erc20I, "balanceOf", [who]])) : [];
  const wei = await steady(() => provider.getBalance(who));
  const free = wei > GAS_RESERVE ? wei - GAS_RESERVE : 0n;
  const usd = (eth) => (ethUsd ? +(eth * ethUsd).toFixed(2) : null);
  const out = { address: lc(who), eth: { amount: r8(num(wei)), free: r8(num(free)), usd: usd(num(wei)) }, held: [], unpriced: [] };
  const mine = list.map((t, k) => ({ ...t, raw: bal[k]?.[0] || 0n })).filter((t) => t.raw > 0n);
  const live = mine.length ? await curves(mine.map((t) => t.curve)) : {};
  for (const t of mine) {
    const c = live[lc(t.curve)], amount = +ethers.formatUnits(t.raw, 18);
    if (!c || c.graduated) { out.unpriced.push({ token: t.token, symbol: t.symbol, amount, why: c?.graduated ? "it graduated to Uniswap, so it is not priced or sold here" : "its curve could not be read" }); continue; }
    const eth = num(curveSellQuote(c, t.raw));
    if (eth < 1e-7) continue;                                   // dust
    out.held.push({ token: t.token, symbol: t.symbol, curve: t.curve, member: t.member, weight: t.weight, why: t.why || null, raw: t.raw.toString(), amount, eth: r8(eth), usd: usd(eth) });
  }
  out.held.sort((a, b) => b.eth - a.eth);
  out.totalEth = r8(out.held.reduce((s, x) => s + x.eth, 0));
  out.totalUsd = usd(out.totalEth);
  out.left = out.held.filter((h) => !h.member).length;
  return out;
}

/** A plan as ordered steps. Selling comes first so the ETH exists before it is spent. */
export function stepsFor(p) {
  return [
    ...p.sells.map((s) => ({ kind: "sell", token: s.token, symbol: s.symbol, curve: s.curve, amount: s.raw, eth: s.eth })),
    ...p.buys.map((b) => ({ kind: "buy", token: b.token, symbol: b.symbol, curve: b.curve, eth: b.eth })),
  ];
}

const fmt = (x) => (x >= 1 ? x.toFixed(4) : x.toFixed(6)).replace(/0+$/, "").replace(/\.$/, "");
export const describe = (s) => s.kind === "sell" ? `Sell all your $${s.symbol} for about ${fmt(s.eth)} ETH` : `Buy $${s.symbol} with ${fmt(s.eth)} ETH`;

async function allowance(token, owner, spender) {
  const r = await multicall([[token, erc20I, "allowance", [owner, spender]]]);
  return r[0]?.[0] ?? 0n;
}
const minus = (x, slip) => (x * BigInt(Math.floor((1 - slip) * 10_000))) / 10_000n;
async function spendableEth(who, wantWei) {
  const bal = await steady(() => provider.getBalance(who));
  const free = bal > GAS_RESERVE ? bal - GAS_RESERVE : 0n;
  return wantWei < free ? wantWei : free;
}

/**
 * The transaction for one step, priced now. Returns { tx: { to, data, value }, expect } or { approve: tx, note } when the
 * wallet must first allow the curve to take the tokens (the same step is built again after the approval lands).
 */
export async function build(step, address, slippage) {
  const who = ethers.getAddress(address);
  const tx = (to, data, value = 0n) => ({ to: ethers.getAddress(to), data, value: "0x" + value.toString(16) });
  const c = (await curves([step.curve]))[lc(step.curve)];
  if (!c) throw new Error(`The $${step.symbol} curve could not be read. Try again.`);
  if (c.graduated) throw new Error(`$${step.symbol} has left its Pons curve, so it cannot be traded here.`);
  if (step.kind === "sell") {
    const amount = BigInt(step.amount);
    if ((await allowance(step.token, who, step.curve)) < amount) return { approve: tx(step.token, erc20I.encodeFunctionData("approve", [step.curve, amount])), note: `Allow the $${step.symbol} curve to take your tokens` };
    const out = curveSellQuote(c, amount);
    return { tx: tx(step.curve, curveI.encodeFunctionData("sell", [amount, minus(out, slippage), who])), expect: `${fmt(num(out))} ETH` };
  }
  if (step.kind === "buy") {
    const wei = await spendableEth(who, ethers.parseEther(step.eth.toFixed(18)));
    if (wei <= 0n) throw new Error("Not enough ETH left in the wallet for this buy (some is kept aside for gas).");
    // an eth_call of the real buy from this wallet gives the exact tokens out (launch tax and all)
    const data = curveI.encodeFunctionData("buy", [wei, 0n, who]);
    let out;
    try { out = curveI.decodeFunctionResult("buy", await steady(() => provider.call({ from: who, to: step.curve, value: wei, data })))[0]; }
    catch { out = curveBuyQuote(c, wei); }
    return { tx: tx(step.curve, curveI.encodeFunctionData("buy", [wei, minus(out, slippage), who]), wei), expect: `${(+ethers.formatUnits(out, 18)).toLocaleString("en-US", { maximumFractionDigits: 0 })} $${step.symbol}` };
  }
  throw new Error("Unknown step.");
}

/** wait for a user's transaction and report whether it worked */
export async function receipt(hash) {
  for (let i = 0; i < 40; i++) {
    const r = await steady(() => provider.getTransactionReceipt(hash)).catch(() => null);
    if (r) return { ok: r.status === 1, block: r.blockNumber, from: lc(r.from), to: lc(r.to || "") };
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  return null;
}
