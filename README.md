# CHIRON

A quiver of seven Pons memecoins on Robinhood Chain. Code keeps seven slots filled with tokens that pass a rug scan and still trade; a user picks an amount of ETH and their wallet buys all seven, split by a rule anyone can read. When a token leaves the quiver the user can rotate (sell it, move the ETH to the slots they are lightest in), and one plan sells everything back to ETH. Users sign every trade with their own wallet. No custody, no vault, no keys.

Built on the engine of ARCHY (Pons reader, rug scan, wallet-signed steps, paper books, studio). The barbell, the stock tokens, the market score and the AI note are gone.

## How it works
- **Read** (`server/memes.mjs`, `server/chain.mjs`): every Pons curve trade and launch, as hourly buckets (7 days kept) with the last price of each hour; the ETH price from the WETH/USDG pool.
- **Rule** (`server/quiver.mjs`, pure functions): `verdict` (does a member keep its slot), `weigh` (shares), `draw` (one redraw), `plan` (buy / rotate / sell for a wallet or a paper book).
  - To get a slot: at least 0.5 ETH traded in 24 h, launched more than 6 h ago, still on its curve, curve fee + creator tax at most 5% per trade, rug risk under 30 with no high flag.
  - To lose it: graduated off the curve, failed a later scan, or 24 h volume under 0.2 ETH. A reading that could not be made never drops a token.
  - Shares: square root of 24 h volume, no token above 25%.
  - Redrawn every 30 minutes (`redraw` in `server/server.mjs`); tokens that left are remembered 90 days so wallets holding them can still sell.
- **Scan** (`server/scan.mjs`, unchanged from ARCHY): the rug scan behind "risk".
- **Wallet** (`server/wallet.mjs`): holdings of current and former members read from the chain and valued at what selling returns now; a plan becomes ordered steps (sales first), each one a Pons curve `sell` or `buy` priced again right before it is signed, with the user's slippage limit. Approvals are exact amounts.
- **Record** (`server/record.mjs`): three paper books of 0.1 ETH filled at live curve quotes: the rotated quiver, the opening tokens never rotated, and everything in the busiest token. Counted in ETH, so holding ETH is the zero line.
- **Studio** (`/studio`, `server/burn.mjs`): the owner sets the $CHIRON contract address and runs buyback-and-burn by hand.

## Run
```
npm install
cp .env.example .env     # all optional
npm test                 # the rule, the plans, the curve math
npm start                # http://127.0.0.1:5496
```
Pages: `/` landing, `/app` the quiver (the seven, the record, my wallet), `/studio` owner panel.
API: `/api/state` (public), `/api/token`, `/api/auth/nonce|verify|logout`, `/api/me`, `/api/settings`, `/api/wallet`, `/api/plan`, `/api/step`, `/api/step/done`.

The first start reads 24 hours of Pons trades from the public RPC, which takes a while; the quiver fills once that is done. State lives in `data/` (not in git).

## Site
Static HTML/CSS/JS in `site/`, no build step, in the same visual family as ARCHY (thin Jost, IBM Plex Mono, navy / ivory / gold). The hero is two canvases: `js/dusk.js` (a WebGL dusk sea: sky, turning moon from `img/moon.jpg`, ridges, mist, mirrored water) and `js/sky.js` (Sagittarius from its real star positions, seven stars carrying the live members, arrows of light). Each chapter shows a picture when its file exists in `site/img/` (`ch-seven`, `ch-rule`, `ch-record`, `ch-limits`, as webp/jpg/png); without one the chapter is text only. Everything animated has a reduced-motion still.

## Honest limits
Pons curve tokens only. Every trade pays the curve fee (1%) and the token's creator tax, so buying and selling straight back loses several percent. A full buy is one transaction per token. The rug scan catches common traps, not every one; memecoins can go to zero. Not advice; not affiliated with Robinhood, Pons or Uniswap.
