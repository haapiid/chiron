// One steady connection to Robinhood Chain for every module. The public RPC answers bursts with 429, which ethers
// turns into "exceeded maximum retry limit". Here a busy answer waits and tries again (next URL first, when RPC_URLS
// lists more than one), and every request shares one cooldown so a busy RPC is not hammered from ten places at once.
import { ethers } from "ethers";

export const RPC_URLS = (process.env.RPC_URLS || process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com").split(",").map((s) => s.trim()).filter(Boolean);
const NETWORK = ethers.Network.from(4663);
const BUSY = /429|too many|rate.?limit|retry limit|timeout|ECONNRESET|ETIMEDOUT|fetch failed|server response 5\d\d|SERVER_ERROR|bad gateway|service unavailable/i;
export const isBusy = (e) => BUSY.test(`${e?.code || ""} ${e?.shortMessage || ""} ${e?.message || ""}`);

let cooldownUntil = 0, failures = 0;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** How the RPC has been doing, for the studio. */
export const rpcHealth = () => ({ urls: RPC_URLS.length, coolingMs: Math.max(0, cooldownUntil - Date.now()), recentFailures: failures });

class SteadyProvider extends ethers.JsonRpcProvider {
  constructor(urls) {
    const reqs = urls.map((u) => { const r = new ethers.FetchRequest(u); r.timeout = 20_000; r.retryFunc = async () => false; return r; });
    super(reqs[0], NETWORK, { staticNetwork: NETWORK, batchMaxCount: 20 });
    this.reqs = reqs; this.at = 0;
  }
  async _send(payload) {
    for (let i = 0; ; i++) {
      const wait = cooldownUntil - Date.now(); if (wait > 0) await sleep(Math.min(wait, 15_000));
      const r = this.reqs[(this.at + i) % this.reqs.length].clone();
      r.body = JSON.stringify(payload); r.setHeader("content-type", "application/json");
      try {
        const res = await r.send();
        if (res.statusCode === 429) { const ra = Number(res.headers["retry-after"]) || 0; throw Object.assign(new Error("429 Too Many Requests"), { retryAfter: ra }); }
        res.assertOk();
        const body = Array.isArray(res.bodyJson) ? res.bodyJson : [res.bodyJson];
        if (body.some((x) => x?.error && BUSY.test(String(x.error.message)))) throw new Error(`rate limited: ${body.find((x) => x?.error).error.message}`);
        failures = Math.max(0, failures - 1);
        return body;
      } catch (e) {
        if (!isBusy(e) || i >= 6) throw e;
        failures++; this.at = (this.at + 1) % this.reqs.length;   // the next try goes to the next URL, if there is one
        const pause = Math.min(20_000, Math.max((e.retryAfter || 0) * 1000, 700 * 2 ** i));
        cooldownUntil = Math.max(cooldownUntil, Date.now() + pause);
      }
    }
  }
}

export const provider = new SteadyProvider(RPC_URLS);
