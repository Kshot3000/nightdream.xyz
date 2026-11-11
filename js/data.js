/* NightDream — shared state + formatters. Market data is LIVE (see live.js);
   ND.TOKENS is populated from CoinGecko on boot. No demo figures anywhere. */
window.ND = window.ND || {};

ND.META = {
  live: true,
  network: "Cardano mainnet",
  sources: ["CoinGecko", "DexScreener", "GeckoTerminal", "Koios", "MinSwap"],
};

/* Midnight economics (documented concepts — model inputs, not market data) */
ND.MIDNIGHT = {
  dustPerNightMax: 5,
  generationNote: "Each NIGHT can sustain up to 5 DUST capacity. Generation rate depends on holdings and Midnight network parameters (model estimates).",
  bridgeNote: "Cardano hosts NIGHT (cNIGHT); registering it lets your Midnight address generate DUST, which pays for shielded transactions. A two-way NIGHT token bridge is planned but not live on mainnet yet, so this diagram is a mental model, not a working route.",
};

/* ——— Output safety ———
   Token names, tickers, NFT names, pair labels and wallet names come from
   third-party feeds and from on-chain metadata that anyone can mint, so every
   such string is escaped before it is placed into innerHTML, and every
   external link goes through safeUrl (http/https only). */
ND.esc = function (v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/`/g, "&#96;");
};
ND.safeUrl = function (u) {
  try {
    const url = new URL(String(u || ""), "https://nightdream.xyz/");
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch (_) { return ""; }
};
/* Image sources: https URLs and inline raster data: URIs only (wallet icons
   are usually data: URIs; SVG data URIs are allowed because <img> never runs
   their scripts). */
ND.safeImg = function (u) {
  const s = String(u || "");
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/i.test(s)) return s;
  const h = ND.safeUrl(s);
  return h.startsWith("https:") ? h : "";
};

/* NIGHT redemption schedule (midnight.gd/redeem, Midnight token guide).
   Thawing ends on Dec 4, 2026; the redemption portal stays open for a
   90-day grace period after that. Timestamps mark the END of each day in UTC
   so the countdown never flips to "ended" while it is still Dec 4 somewhere. */
ND.REDEEM = {
  thawEnd: Date.UTC(2026, 11, 5),     // end of Dec 4, 2026 (UTC)
  graceEnd: Date.UTC(2027, 2, 5),     // end of ~Mar 4, 2027 (UTC) — 90 days after
  thawDays: 90,
  windows: [
    ["Thaw 1", "Dec 10, 2025 – Mar 9, 2026"],
    ["Thaw 2", "Mar 10 – Jun 7, 2026"],
    ["Thaw 3", "Jun 8 – Sep 5, 2026"],
    ["Thaw 4", "Sep 6 – Dec 4, 2026"],
  ],
};
/* Pure phase function (unit-tested in tests/). */
ND.redeemPhase = function (now) {
  const R = ND.REDEEM;
  if (now < R.thawEnd) return "thaw";
  if (now < R.graceEnd) return "grace";
  return "ended";
};
/* Pure schedule builder: 4 equal tranches, 90 days apart from the first
   thaw date the user reads off the official portal. */
ND.thawSchedule = function (alloc, firstIso) {
  if (!(alloc > 0) || !firstIso || !/^\d{4}-\d{2}-\d{2}$/.test(firstIso)) return null;
  const [y, m, d] = firstIso.split("-").map(Number);
  const t0 = Date.UTC(y, m - 1, d);
  if (Number.isNaN(t0)) return null;
  const out = [];
  for (let i = 0; i < 4; i++) {
    out.push({ n: i + 1, at: t0 + i * ND.REDEEM.thawDays * 86400000, amount: alloc / 4 });
  }
  return out;
};

/* Live token list (filled by ND.ensureMarkets) */
ND.TOKENS = [];
ND._marketsAt = 0;

ND.ensureMarkets = async function (force) {
  const rows = await LIVE.markets(force);
  ND._marketsTried = true; /* at least one fetch attempt has completed */
  if (rows && rows.length) {
    ND.TOKENS = rows;
    ND._marketsAt = Date.now();
    ND._marketsError = false;
  } else if (!ND.TOKENS.length) {
    /* Only count as an error when there is no usable data at all;
       a failed refresh with a stale table in place stays quiet. */
    ND._marketsError = true;
  }
  return ND.TOKENS;
};

ND.getToken = function (id) {
  if (!id) return null;
  const q = String(id).toUpperCase();
  return ND.TOKENS.find((t) => t.ticker === q || t.id === q || t.cg === String(id).toLowerCase()) || null;
};

ND.getTokenByCg = function (cg) {
  return ND.TOKENS.find((t) => t.cg === cg) || null;
};

ND.fmt = {
  usd(n, d = 2) {
    if (n == null || Number.isNaN(n)) return "—";
    if (n === 0) return "$0.00";
    if (Math.abs(n) >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
    if (Math.abs(n) >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
    if (Math.abs(n) < 0.0001) return "$" + n.toExponential(2);
    if (Math.abs(n) < 0.01) return "$" + n.toFixed(6);
    if (Math.abs(n) < 1) return "$" + n.toFixed(4);
    return "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
  },
  ada(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }) + " ₳";
  },
  pct(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
  },
  num(n) {
    if (n == null) return "—";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
  },
  exactUsd(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 20 });
  },
  exactNum(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: 20 });
  },
  // Abbreviated number with the exact value in a title tooltip (no tooltip when identical).
  numx(n) {
    if (n == null || Number.isNaN(n)) return "—";
    const abbr = this.num(n), exact = this.exactNum(n);
    return exact === abbr ? abbr : `<span title="${exact}">${abbr}</span>`;
  },
  // Abbreviated USD with the exact value in a title tooltip (no tooltip when identical).
  usdx(n, d = 2) {
    if (n == null || Number.isNaN(n)) return "—";
    if (n === 0) return this.usd(0);
    const abbr = this.usd(n, d), exact = this.exactUsd(n);
    return exact === abbr ? abbr : `<span title="${exact}">${abbr}</span>`;
  },
  // Price with the exact value in a title tooltip (no tooltip when identical).
  prx(n, d = 4) {
    if (n == null || Number.isNaN(n)) return "—";
    if (n === 0) return this.usd(0);
    const abbr = this.usd(n, d), exact = this.exactUsd(n);
    return exact === abbr ? abbr : `<span title="${exact}">${abbr}</span>`;
  },
  // Estimated model figure (e.g. DUST calc): 2dp under 10K, abbreviated above,
  // exact value in a title tooltip (no tooltip when identical).
  estx(n, d = 2) {
    if (n == null || Number.isNaN(n)) return "—";
    const abbr = Math.abs(n) >= 10000 ? this.num(n)
      : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
    const exact = this.exactNum(n);
    return exact === abbr ? abbr : `<span title="${exact}">${abbr}</span>`;
  },
  timeAgo(ts) {
    const t = typeof ts === "number" ? ts : new Date(ts).getTime();
    const d = (Date.now() - t) / 1000;
    if (d < 0) return "just now";
    if (d < 60) return Math.floor(d) + "s ago";
    if (d < 3600) return Math.floor(d / 60) + "m ago";
    if (d < 86400) return Math.floor(d / 3600) + "h ago";
    return Math.floor(d / 86400) + "d ago";
  },
  date(ts) {
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  },
  hexShort(h, n = 12) {
    if (!h) return "—";
    return h.length > n * 2 + 1 ? h.slice(0, n) + "…" + h.slice(-n) : h;
  },
};
