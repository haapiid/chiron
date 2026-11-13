// Robinhood Chain reads for CHIRON: addresses, one multicall helper, the ETH price and Pons curve quotes.
// Everything here is read-only. Transactions are built in wallet.mjs and signed by the user's own wallet.
import { ethers } from "ethers";
import { provider, isBusy } from "./rpc.mjs";

export { provider };
export const CHAIN_ID = 4663;
export const EXPLORER = "https://robinhoodchain.blockscout.com";
// Uniswap v3 on Robinhood Chain, used only to read the ETH price from the WETH/USDG pool
const QUOTER = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";       // 6 decimals
const ETH_FEE = 100;
export const PONS_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";

export const erc20I = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)", "function symbol() view returns (string)", "function name() view returns (string)",
]);
export const curveI = new ethers.Interface([
  "function token() view returns (address)", "function graduated() view returns (bool)",
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function feeBps() view returns (uint256)", "function creatorTaxBps() view returns (uint256)",
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)",
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
]);
export const factoryI = new ethers.Interface([
  "function getLaunchedToken(address token) view returns (tuple(address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint256 initialLiquidity, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, bool exists))",
]);
const quoterI = new ethers.Interface(["function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)"]);
const mcI = new ethers.Interface(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])"]);

export const lc = (a) => String(a).toLowerCase();
export const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
export async function steady(f, n = 3) {
  for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (i >= n || !isBusy(e)) throw e; await sleep(5000 * (i + 1)); } }
}

/** Many eth_calls as one request. Each entry is [target, iface, fn, args]; a failed call comes back as null. */
export async function multicall(calls, chunk = 250) {
  const out = [];
  for (let i = 0; i < calls.length; i += chunk) {
    const part = calls.slice(i, i + chunk);
    const data = mcI.encodeFunctionData("aggregate3", [part.map(([target, iface, fn, args]) => ({ target, allowFailure: true, callData: iface.encodeFunctionData(fn, args) }))]);
    const raw = await steady(() => provider.call({ to: MULTICALL, data }));
    const res = mcI.decodeFunctionResult("aggregate3", raw)[0];
    res.forEach((r, k) => { const [, iface, fn] = part[k]; try { out.push(r.success ? iface.decodeFunctionResult(fn, r.returnData) : null); } catch { out.push(null); } });
  }
  return out;
}

/** USD price of ETH from a 100 USDG buy and the matching sell on the WETH/USDG pool: { ask, bid, mid } */
export async function ethPrice() {
  const path = (a, b) => ethers.solidityPacked(["address", "uint24", "address"], [a, ETH_FEE, b]);
  const [buy] = await multicall([[QUOTER, quoterI, "quoteExactInput", [path(USDG, WETH), 100_000_000n]]]);
  if (!buy) throw new Error("The ETH price could not be read.");
  const [sell] = await multicall([[QUOTER, quoterI, "quoteExactInput", [path(WETH, USDG), buy[0]]]]);
  const eth = +ethers.formatEther(buy[0]), back = sell ? +ethers.formatUnits(sell[0], 6) : 100;
  if (!eth) throw new Error("The ETH price could not be read.");
  const ask = 100 / eth, bid = back / eth;
  return { ask, bid, mid: (ask + bid) / 2 };
}

// ---------- Pons curves ----------
const PONS_FEE_BPS = 100n;
/** ETH out (wei) for selling `amount` on the curve right now, after the curve fee and the creator tax */
export function curveSellQuote(c, amount) {
  const gross = (c.qr * amount) / (c.tr + amount);
  return (gross * (10_000n - (c.fee ?? PONS_FEE_BPS) - (c.tax ?? 0n))) / 10_000n;
}
/** tokens out for buying with `wei` on the curve, same constant-product model */
export function curveBuyQuote(c, wei) {
  const net = (wei * (10_000n - (c.fee ?? PONS_FEE_BPS) - (c.tax ?? 0n))) / 10_000n;
  return (c.tr * net) / (c.qr + net);
}
/** reserves, fee, tax and graduation for many curves in one multicall */
export async function curves(list) {
  const calls = list.flatMap((c) => [[c, curveI, "getReserves", []], [c, curveI, "feeBps", []], [c, curveI, "creatorTaxBps", []], [c, curveI, "graduated", []]]);
  const r = await multicall(calls, 200);
  return Object.fromEntries(list.map((c, k) => {
    const [res, fee, tax, grad] = r.slice(k * 4, k * 4 + 4);
    return [lc(c), res ? { qr: res[0], tr: res[1], fee: fee ? fee[0] : PONS_FEE_BPS, tax: tax ? tax[0] : 0n, graduated: grad ? grad[0] : false } : null];
  }));
}
