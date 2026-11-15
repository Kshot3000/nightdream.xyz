/* NightDream — live data layer.
   Sources (all keyless, CORS-open, verified 2026-09-26):
   - CoinGecko  /api/v3            → prices, mcap, volume, charts, OHLC, metadata
     (keyless by default; optional runtime key, see cgKey below)
   - DexScreener /latest/dex       → DEX pairs, buys/sells, liquidity —
     SundaeSwap, WingRiders and other indexed venues on Cardano
   - GeckoTerminal /api/v2         → Minswap pools on Cardano (DexScreener
     doesn't index Minswap's pools, so this is the venue's data source)
     ALSO the fallback price feed: when CoinGecko is unreachable/blocked, the
     token table is filled from per-token DexScreener quotes (+ MinSwap agg
     for ADA) so the site never goes blank on a single feed failure.
   - Koios      /api/v1            → on-chain asset info, holders, address/wallet data
   - MinSwap aggregator            → ADA/USD reference price
   - Midnight network strip: same-origin snapshot only. NightForge
     (mainnet.nightforge.jp) answers 410 Gone, and Midnight's own mainnet
     indexer was retired on Oct 9, 2026 in favour of Blockfrost, which needs
     a project token that must never ship in browser code.
   Every fetch is cached (memory + localStorage) and fails soft → null.
   UI must always handle null with skeletons / error states + retry. */
window.LIVE = (function () {
  const CG = "https://api.coingecko.com/api/v3";
  /* CoinGecko key: optional, never committed. Requests go keyless to the
     public API by default. A deployer who wants a CoinGecko demo key sets it
     at runtime in js/config.local.js (gitignored; copy js/config.example.js):
       window.ND_CONFIG = { coingeckoDemoKey: "CG-..." };
     It is sent as the x_cg_demo_api_key query param, not a header, because a
     custom header triggers a CORS preflight that CoinGecko's edge rejects.
     Anything served to browsers is public, so only use a free key with no
     billing attached. If a keyed request is refused (bad or revoked key) we
     retry once keyless, and if CoinGecko is unreachable the DexScreener
     fallback feed fills the table. */
  const cgKey = function () {
    const k = window.ND_CONFIG && window.ND_CONFIG.coingeckoDemoKey;
    return typeof k === "string" && /^CG-[A-Za-z0-9]{8,64}$/.test(k) ? k : "";
  };
  const withCgKey = function (url) {
    const k = cgKey();
    return k ? url + (url.indexOf("?") === -1 ? "?" : "&") + "x_cg_demo_api_key=" + encodeURIComponent(k) : url;
  };
  const KOIOS = "https://api.koios.rest/api/v1";
  const DEXS = "https://api.dexscreener.com";
  const GT = "https://api.geckoterminal.com/api/v2";
  /* GeckoTerminal reachability flag — same pattern as dexUp. Set by jget so
     the UI can tell a feed outage apart from a token that genuinely has no
     Minswap pools. Starts true so the first render doesn't mislabel a cold
     cache as down. */
  let gtUp = true;
  /* DexScreener reachability flag — set by jget so the UI can tell a feed
     outage apart from a token that genuinely has no pairs. Starts true so
     the first render doesn't mislabel a cold cache as down. */
  let dexUp = true;
  const MINAGG = "https://agg-api.minswap.org/aggregator";

  const mem = new Map();
  const LS_PREFIX = "nd.live.v1.";

  function cacheGet(key) {
    const m = mem.get(key);
    if (m && m.exp > Date.now()) return m.val;
    try {
      const raw = localStorage.getItem(LS_PREFIX + key);
      if (!raw) return undefined;
      const o = JSON.parse(raw);
      if (o.exp > Date.now()) { mem.set(key, o); return o.val; }
    } catch (_) {}
    return undefined;
  }
  function cacheSet(key, val, ttlMs) {
    const o = { val, exp: Date.now() + ttlMs };
    mem.set(key, o);
    try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(o)); } catch (_) {}
  }
  function cacheDel(key) {
    mem.delete(key);
    try { localStorage.removeItem(LS_PREFIX + key); } catch (_) {}
  }

  async function jget(url, ttlMs, init) {
    const cached = cacheGet(url);
    if (cached !== undefined) return cached;
    const { timeout, ...fetchInit } = init || {};
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout || 20000);
    try {
      const isCg = url.indexOf(CG) === 0;
      let r = await fetch(isCg ? withCgKey(url) : url, { ...fetchInit, signal: ctrl.signal });
      /* keyed CG request refused (bad/revoked/over-quota key) → one keyless retry */
      if (isCg && cgKey() && (r.status === 400 || r.status === 401 || r.status === 403 || r.status === 429))
        r = await fetch(url, { ...fetchInit, signal: ctrl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      cacheSet(url, j, ttlMs);
      if (url.indexOf(DEXS) === 0) dexUp = true;
      if (url.indexOf(GT) === 0) gtUp = true;
      return j;
    } catch (e) {
      if (url.indexOf(DEXS) === 0) dexUp = false;
      if (url.indexOf(GT) === 0) gtUp = false;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  async function jpost(url, body, ttlMs) {
    const key = "POST " + url + " " + JSON.stringify(body);
    const cached = cacheGet(key);
    if (cached !== undefined) return cached;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      cacheSet(key, j, ttlMs);
      return j;
    } catch (e) {
      return null;
    }
  }

  const MIN5 = 5 * 60 * 1000, MIN30 = 30 * 60 * 1000, HOUR6 = 6 * 3600 * 1000;

  /* ——— Token markets (ONE batched CoinGecko call, DexScreener fallback) ——— */
  let _marketsInflight = null;
  let _feed = null; /* "coingecko" | "dexscreener" | null — which feed filled the table */
  function allIds() {
    const ids = window.NDU.TOKENS.map((t) => t.cg);
    ids.push("cardano");
    return [...new Set(ids)].join(",");
  }
  /* Fallback when CoinGecko is unreachable or blocking the visitor's network:
     per-token DexScreener quotes (cardano chain, best-liquidity pair) plus the
     MinSwap aggregator for ADA. Real data only — tokens without a quoted pair
     are omitted, and mcap / rank / sparkline stay null (rendered as —). */
  async function fallbackMarkets() {
    const seen = new Set();
    const jobs = [];
    for (const u of window.NDU.TOKENS) {
      if (!u.policy || seen.has(u.cg)) continue;
      seen.add(u.cg);
      jobs.push({ uni: u, unit: u.policy + (u.asset || "") });
    }
    const CONC = 6, out = [];
    const adaP = adaPrice().catch(() => null);
    for (let i = 0; i < jobs.length; i += CONC) {
      const batch = await Promise.all(jobs.slice(i, i + CONC).map(async ({ uni, unit }) => {
        try {
          const d = await dexPairsAll(unit);
          const p = d && d.pairs && d.pairs[0];
          if (!p || p.priceUsd == null) return null;
          return {
            id: uni.ticker, ticker: uni.ticker, name: uni.name, cg: uni.cg,
            policy: uni.policy, asset: uni.asset, unit,
            price: p.priceUsd, ch1h: null, ch24: p.ch24, ch7d: null,
            mcap: null, fdv: null, vol: p.vol24, liq: p.liq,
            holders: null, image: p.img || null, spark: [],
            rank: null, ath: null, atl: null,
            category: categoryFor(uni.cg, uni.ticker),
            fallback: true,
          };
        } catch (_) { return null; }
      }));
      for (const r of batch) if (r) out.push(r);
    }
    const ada = await adaP;
    if (ada && ada.price != null) {
      out.push({
        id: "ADA", ticker: "ADA", name: "Cardano", cg: "cardano",
        policy: "", asset: "", unit: "lovelace",
        price: ada.price, ch1h: null, ch24: ada.ch24, ch7d: null,
        mcap: null, fdv: null, vol: null, liq: null,
        holders: null, image: null, spark: [],
        rank: null, ath: null, atl: null,
        category: "L1", fallback: true,
      });
    }
    out.sort((a, b) => (a.ticker === "ADA" ? -1 : b.ticker === "ADA" ? 1 : (b.vol || 0) - (a.vol || 0)));
    return out;
  }
  async function markets(force) {
    if (force) { /* fall through and refetch */ }
    if (_marketsInflight) return _marketsInflight;
    _marketsInflight = (async () => {
      const url = `${CG}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(allIds())}` +
        `&order=market_cap_desc&per_page=250&page=1&sparkline=true&price_change_percentage=1h%2C24h%2C7d`;
      /* Cache entries carry their feed label so cached fallback rows still show
         the "Fallback feed" badge instead of silently masquerading as primary. */
      const key = "markets.v2";
      if (!force) {
        const c = cacheGet(key);
        if (c !== undefined) {
          _marketsInflight = null;
          if (c && c.feed) _feed = c.feed;
          return (c && c.rows) || [];
        }
      }
      const rows = await jget(url, MIN5);
      const out = [];
      if (rows && rows.length) {
        for (const r of rows) {
          const uni = window.NDU.byCg[r.id];
          const ticker = r.id === "cardano" ? "ADA" : (uni ? uni.ticker : (r.symbol || "").toUpperCase());
          const unit = uni && uni.policy ? uni.policy + uni.asset : (r.id === "cardano" ? "lovelace" : "");
          out.push({
            id: ticker, ticker, name: r.name, cg: r.id,
            policy: uni ? uni.policy : "", asset: uni ? uni.asset : "", unit,
            price: r.current_price, ch1h: r.price_change_percentage_1h_in_currency,
            ch24: r.price_change_percentage_24h, ch7d: r.price_change_percentage_7d_in_currency,
            mcap: r.market_cap, fdv: r.fully_diluted_valuation, vol: r.total_volume,
            liq: null, holders: null,
            image: r.image, spark: (r.sparkline && r.sparkline.price) || [],
            rank: r.market_cap_rank, ath: r.ath, atl: r.atl,
            category: categoryFor(r.id, ticker),
          });
        }
        _feed = "coingecko";
      } else {
        /* CoinGecko unreachable/blocked — fall back to DexScreener quotes so the
           site keeps showing real prices instead of going blank. */
        const fb = await fallbackMarkets();
        if (fb.length) { out.push(...fb); _feed = "dexscreener"; }
        else _feed = null;
      }
      if (out.length) cacheSet(key, { rows: out, feed: _feed }, MIN5);
      _marketsInflight = null;
      const stale = cacheGet(key);
      return out.length ? out : (stale && stale.rows) || null;
    })();
    return _marketsInflight;
  }

  const CATS = {
    cardano: "L1", "midnight-3": "Privacy", sundaeswap: "DEX", minswap: "DEX",
    wingriders: "DEX", "muesliswap-milk": "DEX", dexhunter: "DEX", cswap: "DEX",
    usd: "Stable", "usdm-2": "Stable", djed: "Stable", "anzens-usda": "Stable",
    "cicle-xreserve-bridged-usdc-cardano": "Stable", "wanchain-bridged-usdc-cardano": "Stable",
    snek: "Meme", hosky: "Meme", babysnek: "Meme", "charles-the-chad": "Meme", "ada-peepos": "Meme",
    "aada-finance": "Lending", "liqwid-finance": "Lending", "flow-lending": "Lending",
    "indigo-dao-governance-token": "DeFi", "optim-finance": "DeFi", fluidtokens: "DeFi",
    "world-mobile-token": "Infra", iagon: "Infra", "orcfax": "Infra", "nft-maker": "Infra",
    "jpg-store": "NFT", "clay-nation": "NFT",
    cornucopias: "Gaming", "palm-economy": "Gaming",
    "fetch-ai": "AI", "singularitynet": "AI", "rejuve-ai": "AI", talos: "AI", "cardanogpt": "AI", "nunet": "AI",
    "gold-fgld-finest-tokenized-gold": "RWA", "book-2": "RWA",
    meld: "DeFi", "paribus": "DeFi", "genius-yield": "DeFi",
  };
  function categoryFor(cgId, ticker) {
    return CATS[cgId] || "Token";
  }

  /* ——— Price charts ——— */
  async function chart(cgId, days) {
    const d = days === "1H" ? 1 : days === "24H" ? 1 : days === "7D" ? 7 : days === "30D" ? 30 : days === "1Y" ? 365 : 7;
    const url = `${CG}/coins/${cgId}/market_chart?vs_currency=usd&days=${d}`;
    const j = await jget(url, MIN5);
    if (!j || !j.prices) return null;
    return j.prices.map((p) => ({ t: p[0], v: p[1] }));
  }
  async function ohlc(cgId, days) {
    const d = days === "24H" ? 1 : days === "7D" ? 7 : days === "30D" ? 30 : 7;
    const url = `${CG}/coins/${cgId}/ohlc?vs_currency=usd&days=${d}`;
    const j = await jget(url, MIN5);
    if (!j || !j.length) return null;
    return j.map((c) => ({ t: c[0], o: c[1], h: c[2], l: c[3], c: c[4] }));
  }

  /* ——— Coin detail (links, description, supplies) ——— */
  async function detail(cgId) {
    const url = `${CG}/coins/${cgId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`;
    return jget(url, MIN30);
  }

  /* ——— DexScreener: pairs, buys/sells, liquidity ——— */
  async function dexPairs(unit) {
    if (!unit || unit === "lovelace") return null;
    const url = `${DEXS}/latest/dex/tokens/${unit}`;
    const j = await jget(url, 2 * 60 * 1000);
    if (!j || !j.pairs || !j.pairs.length) return null;
    const pairs = j.pairs.filter((p) => p.chainId === "cardano");
    if (!pairs.length) return null;
    let buys = 0, sells = 0, buyVol = 0, sellVol = 0, liq = 0, vol24 = 0;
    const rows = pairs.map((p) => {
      const tx = p.txns || {};
      const b5 = (tx.m5 && tx.m5.buys) || 0, s5 = (tx.m5 && tx.m5.sells) || 0;
      const b1 = (tx.h1 && tx.h1.buys) || 0, s1 = (tx.h1 && tx.h1.sells) || 0;
      const b6 = (tx.h6 && tx.h6.buys) || 0, s6 = (tx.h6 && tx.h6.sells) || 0;
      const b24 = (tx.h24 && tx.h24.buys) || 0, s24 = (tx.h24 && tx.h24.sells) || 0;
      buys += b24; sells += s24;
      const v = (p.volume && p.volume.h24) || 0;
      vol24 += v;
      const lq = (p.liquidity && p.liquidity.usd) || 0;
      liq += lq;
      // rough buy/sell volume split from counts
      const tot = b24 + s24;
      const bv = tot ? (v * b24) / tot : v / 2;
      buyVol += bv; sellVol += v - bv;
      return {
        dex: p.dexId, pair: (p.baseToken && p.baseToken.symbol) + "/" + (p.quoteToken && p.quoteToken.symbol),
        priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
        priceNative: p.priceNative, liq: lq, vol24: v,
        ch24: p.priceChange && p.priceChange.h24, ch5m: p.priceChange && p.priceChange.m5,
        buys24: b24, sells24: s24, buys1h: b1, sells1h: s1,
        url: p.url, pairAddress: p.pairAddress,
        img: p.info && p.info.imageUrl ? p.info.imageUrl : null,
      };
    });
    rows.sort((a, b) => b.liq - a.liq);
    return { pairs: rows, buys, sells, buyVol, sellVol, liquidity: liq, vol24 };
  }

  /* ——— GeckoTerminal: Minswap pools on Cardano ———
     DexScreener's /latest/dex/tokens endpoint does not index Minswap's
     pools (it only surfaces SundaeSwap/WingRiders on cardano), so Minswap
     liquidity has its own source: GeckoTerminal's free API, which indexes
     Minswap pools on the cardano network. Rows use the same shape as
     dexPairs() so callers can merge them. GeckoTerminal provides no
     buys/sells counts, so those stay null and the UI renders "—". */
  async function gtPools(unit) {
    if (!unit || unit === "lovelace") return null;
    const url = `${GT}/networks/cardano/tokens/${unit}/pools`;
    const j = await jget(url, 2 * 60 * 1000);
    if (!j || !Array.isArray(j.data) || !j.data.length) return null;
    const dexes = (j.included || []).filter((i) => i && i.type === "dex");
    const rows = j.data.map((p) => {
      const a = p.attributes || {};
      let venue = "minswap";
      try {
        const rel = p.relationships && p.relationships.dex && p.relationships.dex.data;
        const inc = rel && dexes.find((i) => i.id === rel.id);
        const nm = inc && inc.attributes && String(inc.attributes.name || "").toLowerCase();
        venue = nm.includes("minswap") ? "minswap" : (nm || "minswap");
      } catch (_) { venue = "minswap"; }
      const vol = a.volume_usd || {};
      const v = Number(vol.h24) || 0;
      const lq = Number(a.reserve_in_usd) || 0;
      const chg = a.price_change_percentage || {};
      const addr = a.address || "";
      return {
        dex: venue, pair: a.name || "—",
        priceUsd: a.base_token_price_usd ? Number(a.base_token_price_usd) : null,
        priceNative: null, liq: lq, vol24: v,
        ch24: chg.h24 != null ? Number(chg.h24) : null, ch5m: null,
        buys24: null, sells24: null, buys1h: null, sells1h: null,
        url: addr ? `https://www.geckoterminal.com/cardano/pools/${addr}` : null,
        pairAddress: addr || null, img: null,
      };
    });
    rows.sort((a, b) => b.liq - a.liq);
    let liq = 0, vol24 = 0;
    rows.forEach((r) => { liq += r.liq; vol24 += r.vol24; });
    return { pairs: rows, buys: 0, sells: 0, buyVol: 0, sellVol: 0, liquidity: liq, vol24 };
  }

  /* Merged per-token pairs: DexScreener (SundaeSwap, WingRiders, …) +
     GeckoTerminal (Minswap). One feed failing never blanks the other —
     `sources` tells the UI which feeds contributed real data. */
  async function dexPairsAll(unit) {
    const [ds, gt] = await Promise.all([dexPairs(unit), gtPools(unit)]);
    const rows = [];
    if (ds && ds.pairs) rows.push(...ds.pairs);
    if (gt && gt.pairs) rows.push(...gt.pairs);
    if (!rows.length) return null;
    let buys = 0, sells = 0, buyVol = 0, sellVol = 0, liq = 0, vol24 = 0;
    rows.forEach((r) => {
      liq += r.liq || 0; vol24 += r.vol24 || 0;
      // buy/sell split only exists on DexScreener rows — don't invent it for GT
      if (r.buys24 != null || r.sells24 != null) {
        const b = r.buys24 || 0, s = r.sells24 || 0, v = r.vol24 || 0;
        buys += b; sells += s;
        const tot = b + s, bv = tot ? (v * b) / tot : v / 2;
        buyVol += bv; sellVol += v - bv;
      }
    });
    rows.sort((a, b) => b.liq - a.liq);
    return { pairs: rows, buys, sells, buyVol, sellVol, liquidity: liq, vol24,
             sources: { dexscreener: !!(ds && ds.pairs), geckoterminal: !!(gt && gt.pairs) } };
  }

  /* ——— Koios on-chain ——— */
  async function koiosAsset(policy, assetName) {
    if (!policy) return null;
    const j = await jpost(`${KOIOS}/asset_info`, { _asset_list: [[policy, assetName || ""]] }, HOUR6);
    return j && j.length ? j[0] : null;
  }
  async function koiosHolders(policy, assetName) {
    if (!policy) return null;
    const j = await jpost(`${KOIOS}/asset_addresses`, { _asset_list: [[policy, assetName || ""]] }, MIN30);
    if (!j) return null;
    return j.length;
  }
  async function koiosAddressInfo(addresses) {
    return jpost(`${KOIOS}/address_info`, { _addresses: addresses }, 60 * 1000);
  }
  async function koiosAccountAssets(stakeAddresses) {
    return jpost(`${KOIOS}/account_assets`, { _stake_addresses: stakeAddresses }, 60 * 1000);
  }
  async function koiosAddressTxs(address, limit) {
    const url = `${KOIOS}/address_txs?_address=${encodeURIComponent(address)}&limit=${limit || 25}&order=block_time.desc`;
    return jget(url, 60 * 1000);
  }
  async function koiosTip() {
    return jget(`${KOIOS}/tip`, 60 * 1000);
  }

  /* ——— Same-origin snapshots (primary) ———
     Koios and NightForge don't send Access-Control-Allow-Origin on GET
     responses, so browsers block cross-origin fetch() from this site. A
     scheduled job (scripts/koios-snapshot.mjs; see docs/SNAPSHOTS.md) fetches
     the bulk datasets server-side into data/snapshots/, which loads
     same-origin with no CORS issue. Snapshots older than 36h are treated as
     stale: the live-fetch path is tried first, and if that fails too the
     stale snapshot is shown with stale: true so the UI can show its real age
     instead of a blank panel. */
  const SNAP_MAX_AGE = 36 * 3600 * 1000;
  async function snapshot(path, opts) {
    try {
      const r = await fetch(path, { cache: "no-store" });
      if (!r.ok) return null;
      const j = await r.json();
      if (!j || !j.fetchedAt) return null;
      const stale = Date.now() - j.fetchedAt > SNAP_MAX_AGE;
      if (stale && !(opts && opts.allowStale)) return null;
      return stale ? Object.assign({}, j, { stale: true }) : j;
    } catch { return null; }
  }

  /* ——— Cardano stake pools (Koios) ———
     Top-150 registered pools by active stake, enriched with live saturation,
     block count and delegators. Served from the 6-hour server snapshot;
     falls back to live Koios fetch. Fails soft → null (UI renders an
     explained error + retry, never skeletons or blanks). */
  /* Bulk Koios list endpoints are heavy: slim columns with ?select= and retry
     once after a short backoff (public Koios throttles burst traffic). */
  async function bulkGet(url, ttl) {
    let r = await jget(url, ttl, { timeout: 45000 });
    if (r == null) {
      await new Promise((res) => setTimeout(res, 1500));
      r = await jget(url, ttl, { timeout: 45000 });
    }
    return r;
  }

  async function koiosPools(limit = 150) {
    // Primary: fresh same-origin snapshot (no CORS issues)
    const snap = await snapshot("data/snapshots/pools.json");
    if (snap && Array.isArray(snap.rows) && snap.rows.length) return snap;
    const live = await koiosPoolsLive(limit).catch(() => null);
    if (live) return live;
    // Last resort: a stale snapshot (UI shows its real age)
    const old = await snapshot("data/snapshots/pools.json", { allowStale: true });
    return old && Array.isArray(old.rows) && old.rows.length ? old : null;
  }
  async function koiosPoolsLive(limit) {
    // Fallback: live Koios fetch (may be CORS-blocked in some browsers)
    const list = await bulkGet(
      `${KOIOS}/pool_list?select=pool_id_bech32,ticker,margin,active_stake,pool_status,retiring_epoch,pledge,fixed_cost`,
      HOUR6);
    if (!Array.isArray(list)) return null;
    const reg = list
      .filter((p) => p && p.pool_status === "registered" && !p.retiring_epoch)
      .sort((a, b) => Number(b.active_stake || 0) - Number(a.active_stake || 0))
      .slice(0, Math.max(1, limit));
    if (!reg.length) return null;
    // Koios caps POST bodies at 5120 bytes — batch pool_info in groups of 60
    const byId = {};
    for (let i = 0; i < reg.length; i += 60) {
      const info = await jpost(`${KOIOS}/pool_info`, { _pool_bech32_ids: reg.slice(i, i + 60).map((p) => p.pool_id_bech32) }, HOUR6);
      (Array.isArray(info) ? info : []).forEach((p) => { if (p) byId[p.pool_id_bech32] = p; });
    }
    const rows = reg.map((p) => {
      const i = byId[p.pool_id_bech32] || {};
      const margin = p.margin != null ? Number(p.margin) : null;
      return {
        ticker: p.ticker || null,
        poolId: p.pool_id_bech32,
        activeStake: Number(p.active_stake || 0),
        liveStake: Number(i.live_stake || 0) || Number(p.active_stake || 0),
        saturation: i.live_saturation != null ? Number(i.live_saturation) : null,
        margin: margin != null && !Number.isNaN(margin) ? margin : null,
        pledge: Number(p.pledge || 0),
        fixedCost: Number(p.fixed_cost || 0),
        delegators: i.live_delegators != null ? Number(i.live_delegators) : null,
        blocks: i.block_count != null ? Number(i.block_count) : null,
      };
    });
    return { rows, fetchedAt: Date.now() };
  }

  /* ——— ADA/USD reference ——— */
  async function adaPrice() {
    const j = await jget(`${MINAGG}/ada-price?currency=usd`, MIN5);
    if (j && j.value && j.value.price) return { price: j.value.price, ch24: j.value.change_24h };
    const s = await jget(`${CG}/simple/price?ids=cardano&vs_currencies=usd&include_24hr_change=true`, MIN5);
    if (s && s.cardano) return { price: s.cardano.usd, ch24: s.cardano.usd_24h_change };
    return null;
  }

  /* ——— Wallet token pricing helper ——— */
  async function priceForUnit(unit, adaUsd) {
    if (!unit) return null;
    if (unit === "lovelace") return adaUsd ? { usd: adaUsd, src: "ada" } : null;
    const uni = window.NDU.byUnit[unit];
    if (uni) {
      const mk = cacheGet("markets.v2");
      const mrows = (mk && mk.rows) || mk;
      const hit = mrows && mrows.find((t) => t.cg === uni.cg);
      if (hit && hit.price) return { usd: hit.price, ch24: hit.ch24, ticker: hit.ticker, name: hit.name, image: hit.image };
    }
    // long-tail: DexScreener + GeckoTerminal (Minswap) quote
    const d = await dexPairsAll(unit);
    if (d && d.pairs.length && d.pairs[0].priceUsd) {
      const p = d.pairs[0];
      return { usd: p.priceUsd, ticker: uni ? uni.ticker : unit.slice(0, 8), name: uni ? uni.name : "Unknown token" };
    }
    return null;
  }


  /* ——— Midnight network (NightForge explorer) ——— */
  const NF = "https://mainnet.nightforge.jp/api";
  /* Returns { overview, fetchedAt, stale? } or null. No live fallback: the
     NightForge API is gone (HTTP 410) — calling it only adds a failed request. */
  async function nightforgeOverview() {
    const snap = await snapshot("data/snapshots/midnight.json", { allowStale: true });
    return snap && snap.overview ? snap : null;
  }
  async function nightforgeHealth() {
    const snap = await snapshot("data/snapshots/midnight.json", { allowStale: true });
    return snap ? snap.health || null : null;
  }

  /* ——— Governance (Koios) ——— */
  const GOV_TTL = 12 * 3600 * 1000;

  async function koiosProposalVotes(proposalId) {
    try {
      const v = await jget(`${KOIOS}/proposal_votes?_proposal_id=${encodeURIComponent(proposalId)}`, GOV_TTL);
      if (!Array.isArray(v)) return null;
      const tally = { yes: 0, no: 0, abstain: 0, total: v.length };
      for (const x of v) {
        const vote = String(x.vote || "").toLowerCase();
        if (vote === "yes") tally.yes++;
        else if (vote === "no") tally.no++;
        else tally.abstain++;
      }
      return tally;
    } catch { return null; }
  }

  async function koiosGovernance() {
    // Primary: fresh same-origin snapshot (no CORS issues)
    const snap = await snapshot("data/snapshots/governance.json");
    if (snap && Array.isArray(snap.proposals) && snap.proposals.length) return snap;
    const live = await koiosGovernanceLive();
    if (live) return live;
    // Last resort: a stale snapshot (UI shows its real age)
    const old = await snapshot("data/snapshots/governance.json", { allowStale: true });
    return old && Array.isArray(old.proposals) && old.proposals.length ? old : null;
  }
  async function koiosGovernanceLive() {
    // Fallback: live Koios fetch (may be CORS-blocked in some browsers)
    // Each underlying request is cached 12h by jget/jpost, so repeat visits
    // re-aggregate from localStorage without new network traffic.
    try {
      // meta_json is huge — select only the columns the tracker renders
      const list = await bulkGet(
        `${KOIOS}/proposal_list?select=proposal_id,proposal_type,proposed_epoch,ratified_epoch,enacted_epoch,expired_epoch,dropped_epoch,expiration,deposit,proposal_tx_hash&limit=100`,
        GOV_TTL);
      if (!Array.isArray(list)) return null;
      const statusOf = (p) => p.enacted_epoch != null ? "Enacted"
        : p.ratified_epoch != null ? "Ratified"
        : p.dropped_epoch != null ? "Dropped"
        : p.expired_epoch != null ? "Expired" : "Active";
      const proposals = list.map((p) => ({
        id: p.proposal_id, type: p.proposal_type, status: statusOf(p),
        proposedEpoch: p.proposed_epoch, expiration: p.expiration,
        deposit: p.deposit != null ? Number(p.deposit) : null, tally: null,
      })).sort((a, b) => b.proposedEpoch - a.proposedEpoch);
      // vote tallies for active proposals + the 8 most recent (bounded fan-out)
      const withTally = proposals.filter((p) => p.status === "Active")
        .concat(proposals.filter((p) => p.status !== "Active")).slice(0, 10);
      await Promise.all(withTally.map(async (p) => {
        p.tally = await koiosProposalVotes(p.id);
      }));
      // DRep leaderboard: drep_list ids, then drep_info in 50-id batches (Koios body cap)
      const dreps = await bulkGet(`${KOIOS}/drep_list`, GOV_TTL);
      let board = [];
      if (Array.isArray(dreps) && dreps.length) {
        const ids = dreps.map((d) => d.drep_id);
        const infos = [];
        for (let i = 0; i < ids.length; i += 50) {
          const r = await jpost(`${KOIOS}/drep_info`, { _drep_ids: ids.slice(i, i + 50) }, GOV_TTL);
          if (Array.isArray(r)) infos.push(...r);
        }
        board = infos
          .map((d) => ({ id: d.drep_id, power: d.amount != null ? Number(d.amount) : 0, active: d.active }))
          .filter((d) => d.power > 0)
          .sort((a, b) => b.power - a.power)
          .slice(0, 100);
      }
      return {
        proposals,
        dreps: board,
        drepCount: Array.isArray(dreps) ? dreps.length : 0,
        fetchedAt: Date.now(),
      };
    } catch { return null; }
  }

  return {
    markets, chart, ohlc, detail, dexPairs, dexPairsAll, gtPools,
    koiosAsset, koiosHolders, koiosAddressInfo, koiosAccountAssets, koiosAddressTxs, koiosTip,
    koiosPools,
    koiosGovernance,
    adaPrice, priceForUnit, categoryFor,
    nightforgeOverview, nightforgeHealth,
    feed: () => _feed,
    cacheGet, cacheSet, cacheDel,
    CG, KOIOS, DEXS, GT, NF,
    dexUp: () => dexUp,
    gtUp: () => gtUp,
  };
})();
