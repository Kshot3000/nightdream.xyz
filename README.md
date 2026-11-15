# NightDream.xyz — Cardano + Midnight Analytics Desk

Live Cardano market analytics in the spirit of the late TapTools: token screener, token deep-dives with
candlestick charts, DEX liquidity analytics, real wallet portfolios (CIP-30), and a Midnight (NIGHT/DUST) desk.


**Live site:** https://nightdream.xyz/

> **Unaudited, read-only analytics.** NightDream is not a wallet, exchange or redemption portal. It
> reads public market and on-chain data in your browser; wallet connect only asks for address access
> and never signs anything. It cannot see or claim your NIGHT allocation, prices and on-chain reads can
> be stale when an upstream feed fails, and the DUST calculator and thaw schedule are models, not
> promises of tokens or yield. The code has not had a security audit.

## What it does

- **Overview** — live ADA + NIGHT pulse, price charts, top movers, trending by volume, liquidity snapshot, portfolio mini
- **Markets** — sortable/filterable screener over 84 curated Cardano assets (search by ticker, name, policy ID, or asset unit)
- **Token pages** — live price, line/candle charts (24H/7D/30D/1Y), market stats, buys-vs-sells, DEX markets table, on-chain data (policy ID, fingerprint, decimals, supply, holder count), project links, description
- **Portfolio** — connect Eternl / Lace / Vespr / Typhon / Gero / Flint (any CIP-30 wallet; Nami has been folded into Lace) for a live read-only portfolio: net worth, allocation, positions, NFTs, on-chain activity; or track any `addr1…`/`stake1…` address without connecting
- **DEX analytics** — 24h volume aggregated from DexScreener + GeckoTerminal (Minswap liquidity) across tracked tokens, per-DEX share, top pairs table
- **Staking pools** — stake-pool rankings from Koios: active stake, saturation, margin, pledge, delegators, blocks; sortable + searchable, with oversaturation warnings (server snapshot; the page shows its age)
- **Governance** — on-chain governance actions with Yes/No/Abstain vote tallies and a DRep voting-power leaderboard, from Koios (server snapshot; the page shows its age)
- **Midnight desk** — NIGHT price stats + chart (CoinGecko), NIGHT redemption tracker (countdown to the Dec 4, 2026 end of thawing, then the ~90-day grace period; thaw-schedule calculator), DUST generation model calculator, Cardano ↔ Midnight bridge mental model (the NIGHT token bridge is not live on mainnet yet), and a dated Midnight network snapshot
- **Watchlist + ⌘K command palette** — persisted locally

## Data sources (no backend)

| Source | Used for |
|---|---|
| [CoinGecko](https://www.coingecko.com) | Prices, mcap, volume, % changes, sparklines, charts, OHLC candles, token metadata — keyless public API by default; an optional demo key can be set at runtime in the gitignored `js/config.local.js` (see `js/config.example.js`), with a keyless retry if it is refused and the DexScreener fallback if CoinGecko is unreachable |
| [DexScreener](https://dexscreener.com) | Cardano DEX pairs, liquidity, 24h buys/sells |
| [GeckoTerminal](https://www.geckoterminal.com) | Minswap pool liquidity (merged with DexScreener on the DEX board; buys/sells still DexScreener-only) |
| [Koios](https://www.koios.rest) | On-chain asset info, holder counts, address/wallet balances, stake pool rankings, governance proposals, votes, DReps — bulk datasets via server snapshots in `data/snapshots/` (Koios sends no CORS headers, so browsers can't fetch it directly; see [docs/SNAPSHOTS.md](docs/SNAPSHOTS.md)) |
| [MinSwap aggregator](https://minswap.org) | ADA/USD reference price |
| NightForge (shut down) | Last saved Midnight network snapshot (blocks, TPS, shielded ratio, bridge ops, committee). The NightForge API now answers 410 Gone, so this strip is labelled with its snapshot date and is **not live** |

Responses are cached (60 seconds to 12 hours depending on endpoint, persisted in localStorage) and every panel
degrades gracefully with loading skeletons and plain-language error states. No demo or placeholder
figures are shown; snapshot-backed panels show when the snapshot was taken, and figures that are models
(DUST, thaw schedule) are labelled as models.

Everything from feeds and on-chain metadata (token names, NFT names, pair labels, wallet names, links)
is HTML-escaped before it is rendered, and outbound links are limited to `http(s)`.

## Privacy

- Wallet connection is **read-only** via CIP-30 (`enable()` only requests address access). Nothing is ever signed.
- Balances resolve through your wallet's public addresses via Koios. No keys or seed phrases are ever requested.
- The site loads Google AdSense (see `js/ads.js`, `docs/ADS.md`) and Google Fonts, which set their own cookies/requests; NightDream itself has no analytics.
- Watchlist and tracked addresses stay in your browser's localStorage.

## Run locally

```bash
git clone https://github.com/Kshot3000/nightdream.xyz
cd nightdream.xyz
python3 -m http.server 8000
# open http://localhost:8000/
```

No build step — static HTML/CSS/JS, deployable to any static host (GitHub Pages serves `main`).

## Tests

```bash
npm test          # Node 20+, no dependencies
```

Checks every script parses, the escaping/URL helpers, the NIGHT thaw/grace-period dates and the
thaw-schedule maths, that local assets referenced by `index.html` exist, that no retired endpoints are
linked, that snapshots parse, and a lint that feed/on-chain strings are escaped before `innerHTML`.

## Refreshing snapshots

```bash
npm run snapshots   # node scripts/koios-snapshot.mjs — writes data/snapshots/*.json
```

There is no scheduled job in this repo yet; see [docs/SNAPSHOTS.md](docs/SNAPSHOTS.md) for the
GitHub Actions workflow to add. Until it runs, panels fall back to live Koios (often CORS-blocked) and
then to the last snapshot, labelled as stale.

## Project layout

```
index.html        app shell + all pages
css/styles.css    dark purple/teal theme
css/fx.css        visual FX layer (living background, cinematic hero, glow hovers)
js/tokens.js      curated Cardano token universe (CoinGecko IDs + on-chain policy IDs)
js/live.js        cached data layer (CoinGecko / DexScreener / Koios / MinSwap)
js/data.js        shared state + formatters
js/wallet.js      CIP-30 discovery, bech32, Koios-backed portfolio builder
js/charts.js      canvas charts (line, candles, bars, donut, sparklines)
js/app.js         router + page renderers
js/bg.js          animated full-viewport background canvas (₳ embers, hexagon motif, node network)
js/ads.js         AdSense slot activation (user-approved, live)
scripts/          Koios snapshot fetcher + refresh helper
tests/            node:test checks (npm test)
```

## Limitations

- CoinGecko's free tier rate-limits aggressively; the app caches heavily and backs off, but very rapid
  refreshing may briefly show stale data (the freshness pill always shows data age).
- Holder counts come from Koios `asset_addresses` and can be slow on first load for large assets.
- NFT floor prices and LP position valuations are not currently sourced — NFTs list without prices.
- DUST generation figures on the Midnight page are a tunable model, not network data.
- The Midnight network strip is a dated snapshot. Live Midnight mainnet data now needs a Blockfrost
  project token (Midnight retired its own indexer on Oct 9, 2026); that token must stay server-side,
  so live stats need the snapshot job, not browser code.
- CoinGecko is called keyless by default, so some networks may be rate-limited or blocked by
  CoinGecko's edge; the DexScreener fallback then fills prices. Any key set in `js/config.local.js`
  is still visible to visitors once served; only a server-side proxy would hide it.
- A demo key was committed in earlier history (commit `5a01cde`). It is removed from the code now,
  history is not rewritten, so that key should be rotated in the CoinGecko dashboard.

## Custom domain (DNS)

**Live since 2026-09-27** at https://nightdream.xyz/ — apex resolves, GitHub Pages
HTTPS certificate is issued and "Enforce HTTPS" is on. The working record set is
documented in **[docs/DNS.md](docs/DNS.md)**.

## License

[Apache-2.0](LICENSE), matching the Midnight ecosystem. Independent project — not affiliated with the
Cardano Foundation, Input Output, Intersect, or the Midnight Foundation.

## Attribution / branding

Built by [@kshot9000](https://x.com/kshot9000).

**Donate ADA:**

```
addr1q8hnl6vl5a6k3rw3n5g3jtte696zcl76kfatzv7gpswa9r0dj7fma6klq55y4ffm7tf0em09udnyhuk4ah92pl5x9jpqjae44v
```

**Donate Bitcoin (BTC):**

```
3GnR7TWBXAB3pPztBWpNF4LMNEX5yX8vZK
```
