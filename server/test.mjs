// Checks for the pieces that need no chain: the quiver rule (who stays, the shares, the plans) and the curve math.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { RULES, verdict, weigh, draw, plan } from "./quiver.mjs";
import { stepsFor, describe } from "./wallet.mjs";
import { curveSellQuote, curveBuyQuote } from "./chain.mjs";

let n = 0; const ok = (name, f) => { f(); n++; console.log("  ✔", name); };
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} is not ${b}`);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const tok = (token, volEth, extra = {}) => ({ token, symbol: token.toUpperCase(), curve: "c" + token, volEth, risk: 10, ...extra });
const good = (volEth = 1) => ({ graduated: false, scan: { ok: true, risk: 10, why: "no red flags" }, volEth });

ok("a member that still passes keeps its slot", () => {
  assert.equal(verdict(good()), null);
  assert.equal(verdict(null), null);                                                   // no reading: keep
});
ok("a member leaves when it graduates, fails the scan, or goes quiet", () => {
  assert.match(verdict({ ...good(), graduated: true }), /graduated/);
  assert.match(verdict({ ...good(), scan: { ok: false, risk: 55, why: "rug risk 55/100" } }), /rug scan/);
  assert.match(verdict(good(0.1)), /volume/);
  assert.equal(verdict(good(RULES.keepVolEth)), null);                                 // exactly at the floor stays
});
ok("a scan that did not finish, or a curve that could not be read, never drops a member", () => {
  assert.equal(verdict({ graduated: null, scan: { ok: false, risk: null, why: "scan did not finish" }, volEth: 1 }), null);
  assert.equal(verdict({ graduated: null, scan: null, volEth: 1 }), null);
});
ok("shares follow the square root of volume and add up to one", () => {
  const w = weigh([tok("a", 4), tok("b", 1), tok("c", 1), tok("d", 1), tok("e", 1), tok("f", 1), tok("g", 1)]);
  near(sum(w), 1); near(w[0] / w[1], 2);                                               // 4x the volume -> 2x the share
});
ok("no token takes more than the cap, and the rest share what is left", () => {
  const w = weigh([tok("a", 400), tok("b", 1), tok("c", 1), tok("d", 1), tok("e", 1), tok("f", 1), tok("g", 1)]);
  near(w[0], 0.25); near(sum(w), 1); near(w[1], 0.125);
  const two = weigh([tok("a", 9), tok("b", 1)]);                                       // two tokens cannot both stay under 25%
  near(sum(two), 1); near(two[0], 0.5);
  assert.deepEqual(weigh([]), []);
});
ok("a draw keeps members, drops failures and fills free slots with the best candidates", () => {
  const prev = [tok("a", 2, { since: 1 }), tok("b", 2, { since: 1 }), tok("c", 2, { since: 1 })];
  const read = { a: good(3), b: { ...good(), graduated: true }, c: good(2) };
  const cands = ["d", "e", "f", "g", "h", "i", "j"].map((t, k) => tok(t, 9 - k));
  const d = draw(prev, read, cands, 99);
  assert.equal(d.members.length, RULES.size);
  assert.deepEqual(d.outs.map((o) => o.token), ["b"]);
  assert.deepEqual(d.ins.map((m) => m.token), ["d", "e", "f", "g", "h"]);
  assert.equal(d.members.find((m) => m.token === "a").since, 1);                       // a member keeps its start date
  assert.equal(d.members.find((m) => m.token === "a").volEth, 3);                      // and gets its fresh volume
  assert.equal(d.members.find((m) => m.token === "d").since, 99);
  assert.equal(draw([], {}, [tok("k", 1, { cost: 290 })], 1).members[0].cost, 290);     // what a trade costs travels with the member
  near(sum(d.members.map((m) => m.weight)), 1, 1e-3);
});
ok("a token that just left cannot take its own slot back in the same draw", () => {
  const d = draw([tok("a", 2)], { a: good(0.05) }, [tok("a", 5), tok("b", 1)], 5);
  assert.deepEqual(d.members.map((m) => m.token), ["b"]);
});
ok("a full quiver takes no candidate", () => {
  const prev = "abcdefg".split("").map((t) => tok(t, 1));
  const d = draw(prev, {}, [tok("z", 50)], 5);
  assert.equal(d.ins.length, 0); assert.equal(d.members.length, 7);
});

const members = draw([], {}, [tok("a", 4), tok("b", 1), tok("c", 1), tok("d", 1)], 0).members;
ok("a buy is split across the members by share", () => {
  const p = plan({ action: "buy", eth: 0.1, members });
  assert.equal(p.buys.length, 4); near(sum(p.buys.map((b) => b.eth)), 0.1, 1e-7);
  near(p.buys[0].eth / p.buys[1].eth, members[0].weight / members[1].weight, 1e-3);
  assert.equal(p.sells.length, 0);
});
ok("a buy too small to split, or with an empty quiver, plans nothing", () => {
  assert.equal(plan({ action: "buy", eth: 0.0003, members }).buys.length, 0);
  assert.equal(plan({ action: "buy", eth: 1, members: [] }).buys.length, 0);
  assert.equal(plan({ action: "buy", eth: 0, members }).buys.length, 0);
});
ok("a rotation sells what left and buys the members the wallet is lightest in", () => {
  const held = [{ ...tok("x", 0), raw: "500", eth: 0.1, member: false }, { ...tok("a", 0), raw: "9", eth: 0.2, member: true }];
  const p = plan({ action: "rotate", members, held });
  assert.deepEqual(p.sells.map((s) => [s.token, s.raw]), [["x", "500"]]);
  near(sum(p.buys.map((b) => b.eth)), 0.098, 1e-7);                                     // 2% of the sale is held back
  assert.ok(!p.buys.some((b) => b.token === "a"), "a is already over its share");
  assert.deepEqual(p.buys.map((b) => b.token).sort(), ["b", "c", "d"]);
});
ok("a rotation with nothing to rotate plans nothing", () => {
  const p = plan({ action: "rotate", members, held: [{ ...tok("a", 0), raw: "9", eth: 0.2, member: true }] });
  assert.equal(p.sells.length + p.buys.length, 0); assert.match(p.note, /No rotation/);
});
ok("selling everything sells members and former members alike", () => {
  const held = [{ ...tok("x", 0), raw: "5", eth: 0.1, member: false }, { ...tok("a", 0), raw: "9", eth: 0.2, member: true }];
  const p = plan({ action: "sell", members, held });
  assert.equal(p.sells.length, 2); assert.equal(p.buys.length, 0);
  assert.equal(plan({ action: "sell", members: [], held }).sells.length, 2);            // works with an empty quiver too
});
ok("with Chiron's own token set, its share of a buy goes into it, after the seven", () => {
  const own = { token: "own", symbol: "CHIRON", curve: "cown", share: 0.1 };
  const p = plan({ action: "buy", eth: 0.1, members, own });
  assert.equal(p.buys.length, 5); assert.equal(p.buys[4].token, "own"); near(p.buys[4].eth, 0.01, 1e-7);
  near(sum(p.buys.map((b) => b.eth)), 0.1, 1e-7); assert.match(p.note, /10% buys \$CHIRON/);
  assert.equal(plan({ action: "buy", eth: 0.1, members, own: null }).buys.length, 4);
  assert.equal(plan({ action: "buy", eth: 0.0015, members, own }).buys.some((b) => b.own), false);   // its share would be under the smallest buy
});
ok("a rotation never sells Chiron's own token; selling everything does", () => {
  const held = [{ ...tok("own", 0), raw: "7", eth: 0.05, member: false, own: true }, { ...tok("a", 0), raw: "9", eth: 0.2, member: true }];
  assert.equal(plan({ action: "rotate", members, held }).sells.length, 0);
  assert.equal(plan({ action: "sell", members, held }).sells.length, 2);
});
ok("steps put every sale before every buy", () => {
  const held = [{ ...tok("x", 0), raw: "500", eth: 0.1, member: false }];
  const s = stepsFor(plan({ action: "rotate", members, held }));
  assert.equal(s[0].kind, "sell"); assert.ok(s.slice(1).every((x) => x.kind === "buy"));
  assert.equal(describe(s[0]), "Sell all your $X for about 0.1 ETH");
  assert.match(describe(s[1]), /^Buy \$[A-D] with 0\.\d+ ETH$/);
});
ok("curve math: a buy then a sell loses about the two fees", () => {
  const c = { qr: ethers.parseEther("5"), tr: ethers.parseUnits("800000000", 18), fee: 100n, tax: 0n };
  const t = curveBuyQuote(c, ethers.parseEther("0.1"));
  const c2 = { ...c, qr: c.qr + (ethers.parseEther("0.1") * 9900n) / 10000n, tr: c.tr - t };
  const back = +ethers.formatEther(curveSellQuote(c2, t));
  assert.ok(back > 0.0975 && back < 0.0985, `got ${back}`);
});
console.log(`\n${n} checks passed`);
process.exit(0);
