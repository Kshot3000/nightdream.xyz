/* NightDream — app shell. All market data is LIVE (CoinGecko/DexScreener/Koios).
   Boot paints skeletons, loads the token universe, then renders for real. */
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const fmt = ND.fmt;
  const chClass = (n) => (n > 0 ? "up" : n < 0 ? "down" : "flat");
  const watch = new Set(JSON.parse(localStorage.getItem("nd.watch") || "[]"));
  const chartRanges = { ADA: "30D", NIGHT: "30D", TOKEN: "7D" };
  let chartType = "line"; // line | candle
  let marketSort = { key: "mcap", dir: -1 };
  let currentToken = null;
  let currentRoute = "overview";
  let dexAggCache = null, dexAggAt = 0;

  function saveWatch() { localStorage.setItem("nd.watch", JSON.stringify([...watch])); }
  function toggleWatch(id) {
    if (watch.has(id)) watch.delete(id); else watch.add(id);
    saveWatch();
    $$(`[data-star="${CSS.escape(id)}"]`).forEach((b) => {
      b.classList.toggle("on", watch.has(id));
      b.setAttribute("aria-pressed", watch.has(id) ? "true" : "false"); // a11y: expose toggle state
    });
    if (currentRoute === "watchlist") renderWatchlist();
    if (currentRoute === "overview") renderWatchPanel();
  }

  function toast(msg) {
    const host = $("#toastHost") || document.body;
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => t.remove(), 2800);
  }

  function freshLabel() {
    if (!ND._marketsAt) return "connecting…";
    const s = Math.floor((Date.now() - ND._marketsAt) / 1000);
    if (s < 60) return `live · ${s}s ago`;
    return `live · ${Math.floor(s / 60)}m ago`;
  }
  function paintFresh() {
    const label = freshLabel();
    const df = $("#dataFresh");
    if (df) df.innerHTML = `<span class="pulse"></span> ${label}`;
    const mf = $("#marketsFresh");
    if (mf) mf.textContent = label;
    const lu = $("#lastUpdated");
    if (lu) lu.textContent = ND._marketsAt ? "Updated " + fmt.timeAgo(ND._marketsAt) : "";
  }

  /* token icon: CoinGecko image with letter fallback */
  function icon(t, sm) {
    const cls = "token-avatar" + (sm ? " sm" : "");
    const tick = (t && t.ticker ? t.ticker : "?").replace(/'/g, "");
    if (t && t.image) {
      return `<img class="${cls}" src="${t.image}" alt="" loading="lazy" decoding="async" onerror="this.outerHTML=window.ND.__fbIcon('${tick}','${cls}')">`;
    }
    return window.ND.__fbIcon(tick, cls);
  }
  ND.__fbIcon = (ticker, cls) => {
    const ch = String(ticker || "?").replace(/^\$/, "").charAt(0).toUpperCase() || "?";
    return `<span class="${cls}">${ch}</span>`;
  };
  /* Honest feed badge: shown when the table was filled by the DexScreener
     fallback because CoinGecko was unreachable from the visitor's network. */
  function feedBadge() {
    if (window.LIVE && LIVE.feed && LIVE.feed() === "dexscreener") {
      return `<span class="tag fallback" title="CoinGecko is unreachable from your network — showing live DexScreener prices instead. Market-cap ranks and sparklines are unavailable on the fallback feed.">Fallback feed</span>`;
    }
    return "";
  }
  function paintFeedBadges() {
    const b = feedBadge();
    const m = $("#feedBadgeSlot"); if (m) m.innerHTML = b;
    const o = $("#ovFeedBadge"); if (o) o.innerHTML = b;
  }

  /* DEX venue logos (self-hosted ecosystem assets) keyed by DexScreener dexId */
  const DEX_LOGOS = {
    minswap: "minswap.png",
    sundaeswap: "sundaeswap.png",
    wingriders: "wingriders.png",
    vyfi: "vyfi.png",
  };
  function dexCell(name) {
    const key = String(name || "").toLowerCase().replace(/[^a-z]/g, "");
    const file = DEX_LOGOS[key];
    const img = file ? `<img src="./assets/ecosystem/${file}" alt="" loading="lazy" decoding="async" />` : "";
    return `<span class="dex-cell">${img}<span>${name || "—"}</span></span>`;
  }
  function liqBar(liq, maxLiq) {
    const pct = maxLiq > 0 ? ((liq || 0) / maxLiq * 100).toFixed(1) : 0;
    return `<div>${fmt.usdx(liq)}</div><div class="liq-bar"><i style="width:${pct}%"></i></div>`;
  }

  const skel = (n, h) => Array.from({ length: n }).map(() =>
    `<div class="skel" style="height:${h || 14}px;margin:8px 0"></div>`).join("");
  const skelCards = (n) => Array.from({ length: n }).map(() =>
    `<div class="stat-card"><div class="skel" style="height:11px;width:55%"></div><div class="skel" style="height:22px;width:75%;margin-top:10px"></div><div class="skel" style="height:11px;width:45%;margin-top:8px"></div></div>`).join("");
  /* Markets-feed error state (used when the token-universe fetch failed and there
     is no data to show — avoids an endless skeleton when feeds are unreachable). */
  const marketsErrHTML = (msg) =>
    `<div class="empty" style="padding:28px 16px"><strong>${msg || "Market data couldn't load"}</strong>` +
    `<span class="muted" style="display:block;margin-top:4px">The price feed appears to be unreachable from your network. Nothing was changed locally.</span><br>` +
    `<button class="btn btn-sm" type="button" data-retry-markets>Retry</button></div>`;
  const bindMarketsRetry = (root) => root.querySelectorAll("[data-retry-markets]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      b.disabled = true; b.textContent = "Retrying…";
      await ND.ensureMarkets(true);
      render();
    }));
  const marketsFailed = () => ND._marketsTried && ND._marketsError && !ND.TOKENS.length;
  /* DEX-feed error state: explained message + retry (busts the 10-min cache so the
     retry actually re-hits DexScreener). Used when the feed returned nothing. */
  const dexErrHTML = () =>
    `<div class="empty" style="padding:28px 16px"><strong>DEX feed unavailable</strong>` +
    `<span class="muted" style="display:block;margin-top:4px">DexScreener and GeckoTerminal appear to be unreachable from your network. Nothing was changed locally.</span><br>` +
    `<button class="btn btn-sm" type="button" data-retry-dex>Retry</button></div>`;
  const bindDexRetry = (root) => root?.querySelectorAll("[data-retry-dex]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      b.disabled = true; b.textContent = "Retrying…";
      dexAggCache = null; // force a fresh fetch, not a cached empty result
      render();
    }));
  const bindNightForgeRetry = (root) => root?.querySelectorAll("[data-retry-nightforge]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      b.disabled = true; b.textContent = "Retrying…";
      paintMidnightNetwork();
    }));
  /* Koios-feed error state (token-detail On-chain panel): explained message +
     retry — failed Koios fetches aren't cached, so retry just re-hits Koios. */
  const koiosErrHTML = () =>
    `<div class="empty" style="padding:16px 8px"><strong>On-chain data unavailable</strong>` +
    `<span class="muted" style="display:block;margin-top:4px">Koios appears to be unreachable from your network, or this asset isn't indexed yet. Nothing was changed locally.</span><br>` +
    `<button class="btn btn-sm" type="button" data-retry-koios>Retry</button></div>`;
  const bindKoiosRetry = (root, repaint) => root?.querySelectorAll("[data-retry-koios]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      b.disabled = true; b.textContent = "Retrying…";
      repaint();
    }));
  /* Chart error overlay (canvas stays, dimmed): message + retry inside .chart-wrap */
  function chartError(canvas, msg, retry) {
    const wrap = canvas?.closest(".chart-wrap");
    if (!wrap) return;
    canvas.style.opacity = "0.25";
    let ov = wrap.querySelector(".chart-error");
    if (!ov) { ov = document.createElement("div"); ov.className = "chart-error"; wrap.appendChild(ov); }
    ov.innerHTML = `<div class="empty" style="padding:16px"><strong>${msg}</strong><br><button class="btn btn-sm" type="button">Retry</button></div>`;
    ov.querySelector("button")?.addEventListener("click", (e) => { e.stopPropagation(); clearChartError(canvas); retry(); });
  }
  function clearChartError(canvas) {
    canvas.style.opacity = "";
    canvas.closest(".chart-wrap")?.querySelector(".chart-error")?.remove();
  }

  /* ——— Router ——— */
  function parseHash() {
    const h = (location.hash || "#overview").replace(/^#/, "");
    const i = h.indexOf("/");
    return i < 0 ? { route: h || "overview", param: null }
      : { route: h.slice(0, i), param: decodeURIComponent(h.slice(i + 1)) };
  }
  function navigate(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }
  const ROUTES = ["overview", "markets", "token", "portfolio", "dex", "staking", "governance", "midnight", "watchlist"];

  function render() {
    const { route, param } = parseHash();
    currentRoute = ROUTES.includes(route) ? route : "overview";
    closeSidebar();
    $$(".section").forEach((p) => p.classList.toggle("visible", p.dataset.section === currentRoute));
    $$("[data-route]").forEach((a) => {
      const on = a.dataset.route === currentRoute;
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    document.title = "NightDream.xyz — " + currentRoute.charAt(0).toUpperCase() + currentRoute.slice(1);
    if (currentRoute === "overview") renderOverview();
    if (currentRoute === "markets") renderMarkets();
    if (currentRoute === "token") renderToken(param);
    if (currentRoute === "portfolio") WALLET_UI.render();
    if (currentRoute === "dex") renderDex();
    if (currentRoute === "staking") renderStaking();
    if (currentRoute === "governance") renderGovernance();
    if (currentRoute === "midnight") renderMidnight();
    if (currentRoute === "watchlist") renderWatchlist();
    syncToggleAria(); // reflect .active toggle state to assistive tech
  }

  // a11y: mirror .active toggle-button state onto aria-pressed
  function syncToggleAria() {
    $$(".seg-btn, .tab").forEach((b) => b.setAttribute("aria-pressed", b.classList.contains("active") ? "true" : "false"));
  }

  /* ——— Shared DEX aggregation (top tracked tokens → pairs) ——— */
  async function getDexAgg() {
    if (dexAggCache && Date.now() - dexAggAt < 10 * 60 * 1000) return dexAggCache;
    const top = [...ND.TOKENS].filter((t) => t.unit && t.unit !== "lovelace")
      .sort((a, b) => (b.mcap || 0) - (a.mcap || 0)).slice(0, 12);
    const pairs = [];
    let gtSeen = false;
    for (let i = 0; i < top.length; i += 4) {
      const chunk = await Promise.all(top.slice(i, i + 4).map((t) => LIVE.dexPairsAll(t.unit)));
      chunk.forEach((d) => {
        if (!d) return;
        pairs.push(...d.pairs);
        if (d.sources && d.sources.geckoterminal) gtSeen = true;
      });
    }
    const byDex = new Map();
    const seen = new Set();
    const uniq = [];
    for (const p of pairs) {
      const k = p.pairAddress || p.url || (p.pair + "|" + p.dex);
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(p);
      const e = byDex.get(p.dex) || { name: p.dex, vol24: 0, liq: 0, pairs: 0 };
      e.vol24 += p.vol24; e.liq += p.liq; e.pairs++;
      byDex.set(p.dex, e);
    }
    dexAggCache = {
      pairs: uniq.sort((a, b) => b.vol24 - a.vol24),
      dexes: [...byDex.values()].sort((a, b) => b.vol24 - a.vol24),
      gt: gtSeen, // GeckoTerminal (Minswap) contributed real pools
    };
    dexAggAt = Date.now();
    return dexAggCache;
  }

  /* ——— Overview ——— */
  async function renderOverview() {
    const T = ND.TOKENS;
    if (!T.length) {
      if (marketsFailed()) {
        $("#overviewStats").innerHTML = marketsErrHTML();
        bindMarketsRetry($("#overviewStats"));
        $("#ovMovers").innerHTML = $("#ovTrending").innerHTML = $("#ovWatch").innerHTML = "";
      } else {
        $("#overviewStats").innerHTML = skelCards(8);
        $("#ovMovers").innerHTML = skel(6);
        $("#ovTrending").innerHTML = skel(5);
        $("#ovWatch").innerHTML = skel(3);
      }
      return;
    }
    paintFeedBadges();
    const ada = ND.getToken("ADA");
    const night = T.find((t) => t.cg === "midnight-3");
    const c24 = (t) => [ "price", fmt.prx(t.price, t.price < 1 ? 4 : 2), fmt.pct(t.ch24) + " 24h", t.ch24 ];
    /* card() must tolerate a missing token: the c24 tuple is computed inside
       the guard so a CoinGecko response that omits an id can't throw and
       blank the whole overview. */
    const card = (t) => { if (!t) return ""; const extra = c24(t); return `
      <div class="stat-card"><div class="stat-label">${t.ticker} · ${extra[0]}</div>
      <div class="stat-value">${extra[1]}</div>
      <div class="stat-sub ${chClass(extra[3])}">${extra[2]}</div></div>`; };
    $("#overviewStats").innerHTML =
      card(ada) +
      (ada ? `<div class="stat-card"><div class="stat-label">ADA · mcap</div><div class="stat-value" title="${fmt.exactUsd(ada.mcap)}">${fmt.usd(ada.mcap)}</div><div class="stat-sub">${ada.rank ? "Rank #" + ada.rank : ""}</div></div>
      <div class="stat-card"><div class="stat-label">ADA · vol 24h</div><div class="stat-value" title="${fmt.exactUsd(ada.vol)}">${fmt.usd(ada.vol)}</div><div class="stat-sub ${chClass(ada.ch7d)}">${fmt.pct(ada.ch7d)} 7d</div></div>
      <div class="stat-card"><div class="stat-label">Tracked assets</div><div class="stat-value">${T.length}</div><div class="stat-sub">CoinGecko universe</div></div>` : "") +
      card(night) +
      (night ? `<div class="stat-card"><div class="stat-label">NIGHT · mcap</div><div class="stat-value" title="${fmt.exactUsd(night.mcap)}">${fmt.usd(night.mcap)}</div><div class="stat-sub">${night.rank ? "Rank #" + night.rank : ""}</div></div>
      <div class="stat-card"><div class="stat-label">NIGHT · vol 24h</div><div class="stat-value" title="${fmt.exactUsd(night.vol)}">${fmt.usd(night.vol)}</div><div class="stat-sub ${chClass(night.ch7d)}">${fmt.pct(night.ch7d)} 7d</div></div>
      <div class="stat-card"><div class="stat-label">NIGHT · ATH</div><div class="stat-value">${night.ath ? fmt.prx(night.ath, 4) : "—"}</div><div class="stat-sub"><a href="#midnight">Midnight desk →</a></div></div>` : "");
    paintFresh();
    drawOverviewChart("ADA", chartRanges.ADA);
    drawOverviewChart("NIGHT", chartRanges.NIGHT);

    const gainers = [...T].filter((t) => (t.ch24 || 0) > 0).sort((a, b) => b.ch24 - a.ch24).slice(0, 5);
    const losers = [...T].filter((t) => (t.ch24 || 0) < 0).sort((a, b) => a.ch24 - b.ch24).slice(0, 5);
    $("#ovMovers").innerHTML = [...gainers, ...losers].map((t) => `
      <a class="list-row row-link" href="#token/${t.ticker}">
        <div class="token-cell">${icon(t, 1)}<strong>${t.ticker}</strong></div>
        <span class="${chClass(t.ch24)}">${fmt.pct(t.ch24)}</span>
      </a>`).join("");
    const trending = [...T].filter((t) => t.ticker !== "ADA").sort((a, b) => (b.vol || 0) - (a.vol || 0)).slice(0, 5);
    $("#ovTrending").innerHTML = trending.map((t, i) => `
      <a class="list-row row-link" href="#token/${t.ticker}">
        <div class="token-cell"><span class="rank-badge${i < 3 ? " top" : ""}">#${i + 1}</span>${icon(t, 1)}<div class="token-meta"><strong>${t.ticker}</strong><span>${t.name}</span></div></div>
        <div style="text-align:right"><div>${fmt.prx(t.price, 6)}</div><div class="${chClass(t.ch24)}" style="font-size:12px">${fmt.pct(t.ch24)}</div></div>
      </a>`).join("");
    renderWatchPanel();
    renderPfMiniPanel();

    // liquidity snapshot
    $("#ovPools").querySelector("tbody").innerHTML = `<tr><td colspan="4">${skel(4)}</td></tr>`;
    getDexAgg().then((agg) => {
      if (currentRoute !== "overview") return;
      const rows = agg.pairs.slice(0, 5);
      const maxLiq = Math.max(...rows.map((p) => p.liq || 0), 1);
      const tb = $("#ovPools").querySelector("tbody");
      tb.innerHTML = rows.map((p) => `
        <tr><td><strong>${p.pair}</strong></td><td>${dexCell(p.dex)}</td><td>${liqBar(p.liq, maxLiq)}</td><td>${fmt.usdx(p.vol24)}</td></tr>`).join("")
        || (agg.dexes.length
          ? `<tr><td colspan="4" class="muted">No pair data.</td></tr>`
          : `<tr><td colspan="4"><div class="empty" style="padding:18px 8px"><strong>DEX feed unavailable</strong><br><button class="btn btn-sm" type="button" data-retry-dex>Retry</button></div></td></tr>`);
      bindDexRetry(tb);
    });
  }

  async function drawOverviewChart(which, range) {
    const cg = which === "ADA" ? "cardano" : "midnight-3";
    const cv = which === "ADA" ? $("#ovAdaChart") : $("#ovNightChart");
    if (!cv) return;
    const days = range === "24H" ? 1 : range === "7D" ? 7 : 30;
    const series = await LIVE.chart(cg, days);
    if (currentRoute !== "overview" || !$(which === "ADA" ? "#ovAdaChart" : "#ovNightChart")) return;
    if (!series) { chartError(cv, `${which} chart unavailable`, () => { if (currentRoute === "overview") drawOverviewChart(which, range); }); return; }
    const opts = which === "NIGHT"
      ? { range, color: "#2ee6c5", fill: "rgba(46,230,197,0.10)", chartLabel: `${which} price chart` }
      : { range, chartLabel: `${which} price chart` };
    NDCharts.drawLineChart(cv, series, opts);
  }

  function renderWatchPanel() {
    const el = $("#ovWatch");
    if (!el) return;
    const items = [...watch].map((id) => ND.getToken(id)).filter(Boolean).slice(0, 6);
    el.innerHTML = items.length ? items.map((t) => `
      <div class="list-row">
        <div class="token-cell"><a class="row-link" href="#token/${t.ticker}">${icon(t, 1)}<strong>${t.ticker}</strong></a>
          <button class="star-btn on" data-star="${t.ticker}" type="button" aria-pressed="true" aria-label="Remove ${t.ticker} from watchlist">★</button></div>
        <span class="${chClass(t.ch24)}">${fmt.pct(t.ch24)}</span>
      </div>`).join("")
      : `<div class="empty" style="padding:20px"><strong>No favorites yet</strong>Star tokens from Markets.</div>`;
    el.querySelectorAll("[data-star]").forEach((b) =>
      b.addEventListener("click", (e) => { e.stopPropagation(); toggleWatch(b.dataset.star); }));
  }

  function renderPfMiniPanel() {
    const el = $("#ovPortfolio");
    if (!el) return;
    const s = WALLET.state;
    if (s.connected && s.positions.length) {
      el.innerHTML = `
        <div class="pf-mini-worth">${fmt.usdx(s.totalUsd)}<span class="muted"> net worth</span></div>
        ${s.positions.slice(0, 3).map((p) => `
          <div class="list-row"><div class="token-cell">${icon({ ticker: p.ticker, image: p.image }, 1)}<strong>${p.ticker}</strong></div>
          <span>${fmt.usdx(p.value)}</span></div>`).join("")}
        <a class="btn btn-sm btn-ghost" href="#portfolio" style="margin-top:8px">Open portfolio</a>`;
    } else {
      el.innerHTML = `<p class="muted" style="font-size:13px;margin:0 0 10px">Connect a Cardano wallet to see your live net worth here.</p>
        <a class="btn btn-sm" href="#portfolio">Connect wallet</a>`;
    }
  }

  /* ——— Markets ——— */
  function marketCats() {
    return [...new Set(ND.TOKENS.map((t) => t.category))].sort();
  }
  function filteredMarketTokens() {
    const q = ($("#marketSearch")?.value || "").toLowerCase().trim();
    const cat = $("#marketCat")?.value || "";
    const tab = $("#marketTabs .tab.active")?.dataset.mtab || "all";
    const onlyWatch = $("#watchOnly")?.checked;
    let list = ND.TOKENS.filter((t) => t.ticker !== "ADA");
    if (tab !== "all") list = list.filter((t) => t.category === tab);
    if (cat) list = list.filter((t) => t.category === cat);
    if (onlyWatch) list = list.filter((t) => watch.has(t.ticker));
    if (q) list = list.filter((t) =>
      t.ticker.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) ||
      (t.policy && t.policy.includes(q)) || (t.unit && t.unit.includes(q)));
    const { key, dir } = marketSort;
    list.sort((a, b) => {
      const av = a[key], bv = b[key];
      if (typeof av === "string") return dir * String(av).localeCompare(String(bv));
      return dir * ((av || 0) - (bv || 0));
    });
    return list;
  }
  function renderMarkets() {
    const tb = $("#marketsTable").querySelector("tbody");
    if (!ND.TOKENS.length) {
      if (marketsFailed()) {
        tb.innerHTML = `<tr><td colspan="9">${marketsErrHTML()}</td></tr>`;
        bindMarketsRetry(tb);
      } else {
        tb.innerHTML = `<tr><td colspan="9">${skel(8)}</td></tr>`;
      }
      return;
    }
    const sel = $("#marketCat");
    if (sel && !sel.dataset.built) {
      sel.dataset.built = "1";
      sel.innerHTML = `<option value="">All categories</option>` +
        marketCats().map((c) => `<option>${c}</option>`).join("");
    }
    renderMarketTokens();
    paintFresh();
    paintFeedBadges();
  }
  function renderMarketTokens() {
    const tb = $("#marketsTable").querySelector("tbody");
    if (!tb) return;
    const list = filteredMarketTokens();
    const mc = $("#marketCount");
    if (mc) mc.textContent = `${list.length} assets`;
    if (!list.length) {
      tb.innerHTML = `<tr><td colspan="9"><div class="empty" style="padding:40px 20px"><strong>No tokens match your search or filters</strong><span class="muted">Try a different search term or category.</span><br><button class="btn btn-sm" type="button" data-clear-filters>Clear search &amp; filters</button></div></td></tr>`;
      tb.querySelectorAll("[data-clear-filters]").forEach((b) =>
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          const ms = $("#marketSearch"); if (ms) ms.value = "";
          const mc = $("#marketCat"); if (mc) mc.value = "";
          const wo = $("#watchOnly"); if (wo) wo.checked = false;
          $$("#marketTabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.mtab === "all"));
          syncToggleAria(); // keep aria-pressed in sync after filter reset
          renderMarketTokens();
          const search = $("#marketSearch");
          if (search) search.focus({ preventScroll: true });
        }));
      return;
    }
    tb.innerHTML = list.map((t, i) => `
      <tr>
        <td><button class="star-btn ${watch.has(t.ticker) ? "on" : ""}" data-star="${t.ticker}" type="button" aria-pressed="${watch.has(t.ticker)}" aria-label="Toggle watchlist for ${t.ticker}">★</button></td>
        <td class="rank-cell">${i + 1}</td>
        <td><a class="token-cell row-link" href="#token/${t.ticker}" data-goto="token/${t.ticker}">${icon(t, 1)}<div class="token-meta"><strong>${t.ticker}</strong><span>${t.name}</span></div></a></td>
        <td>${fmt.prx(t.price, t.price < 0.01 ? 6 : 4)}</td>
        <td class="${chClass(t.ch1h)}">${fmt.pct(t.ch1h)}</td>
        <td class="${chClass(t.ch24)}">${fmt.pct(t.ch24)}</td>
        <td class="${chClass(t.ch7d)}">${fmt.pct(t.ch7d)}</td>
        <td>${t.vol ? `<span title="${fmt.exactUsd(t.vol)}">${fmt.usd(t.vol)}</span>` : "—"}</td>
        <td>${t.mcap ? `<span title="${fmt.exactUsd(t.mcap)}">${fmt.usd(t.mcap)}</span>` : "—"}</td>
      </tr>`).join("");
    tb.querySelectorAll("[data-star]").forEach((b) =>
      b.addEventListener("click", (e) => { e.stopPropagation(); toggleWatch(b.dataset.star); }));
    tb.querySelectorAll("tr").forEach((tr) => {
      tr.style.cursor = "pointer";
      tr.addEventListener("click", (e) => {
        if (e.target.closest("[data-star]")) return;
        const cell = tr.querySelector("[data-goto]");
        if (cell) location.hash = "#" + cell.dataset.goto;
      });
    });
  }

  /* ——— Token detail ——— */
  async function renderToken(id) {
    const t = ND.getToken(id) || ND.TOKENS.find((x) => x.cg === String(id || "").toLowerCase());
    const host = $("#tokenPage");
    if (!t) {
      host.innerHTML = `<div class="empty" style="padding:60px 20px"><strong>Token not found</strong><a href="#markets">Back to markets</a></div>`;
      return;
    }
    currentToken = t;
    host.innerHTML = `
      <div class="token-banner">
        <div class="big-avatar">${icon(t)}</div>
        <div style="flex:1;min-width:200px">
          <h1>${t.name} <button class="star-btn ${watch.has(t.ticker) ? "on" : ""}" data-star="${t.ticker}" type="button" aria-pressed="${watch.has(t.ticker)}" aria-label="Toggle watchlist for ${t.ticker}" style="font-size:18px">★</button></h1>
          <div class="price-row"><span class="price">${fmt.prx(t.price, t.price < 0.01 ? 6 : 4)}</span>
            <span class="${chClass(t.ch24)}">${fmt.pct(t.ch24)} 24h</span>
            <span class="${chClass(t.ch7d)}">${fmt.pct(t.ch7d)} 7d</span></div>
          <div class="links-row" id="tokenLinks"></div>
        </div>
        <div><select id="tokenPicker" class="token-picker" aria-label="Choose token"></select><div style="margin-top:8px"><span class="tag">${t.category}</span> ${t.rank ? `<span class="muted" style="font-size:12px">Rank #${t.rank}</span>` : ""}</div></div>
      </div>
      <div class="token-stats-row" id="tokenStatRow"></div>
      <div class="panel-grid">
        <section class="panel">
          <div class="panel-head"><h2>Price chart</h2>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <div class="seg" id="chartType">
                <button class="seg-btn ${chartType === "line" ? "active" : ""}" data-ctype="line">Line</button>
                <button class="seg-btn ${chartType === "candle" ? "active" : ""}" data-ctype="candle">Candles</button>
              </div>
              <div class="seg" id="tokenRange">
                ${["24H", "7D", "30D", "1Y"].map((r) => `<button class="seg-btn ${chartRanges.TOKEN === r ? "active" : ""}" data-range="${r}">${r}</button>`).join("")}
              </div>
            </div>
          </div>
          <div class="chart-wrap"><canvas id="tokenChart" class="chart-lg"></canvas></div>
          <div id="hoverReadout" class="hover-readout"></div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Buys vs sells · 24h</h2><span class="muted" style="font-size:11px">DexScreener</span></div>
          <div id="buysSells">${skel(3)}</div>
          <div class="panel-head" style="margin-top:16px"><h2>Market stats</h2></div>
          <div id="tokenStats">${skel(6)}</div>
        </section>
      </div>
      <div class="panel" style="margin-bottom:12px">
        <div class="panel-head"><h2>DEX markets</h2><span class="muted" style="font-size:11px">DexScreener + GeckoTerminal · Cardano pairs</span></div>
        <div class="table-wrap"><table class="data-table" id="tokenPairsTable">
          <thead><tr><th>DEX</th><th>Pair</th><th>Price</th><th>24h</th><th>Vol 24h</th><th>Liquidity</th><th>Buys/Sells</th><th></th></tr></thead>
          <tbody><tr><td colspan="8">${skel(4)}</td></tr></tbody></table></div>
      </div>
      <div class="panel-grid equal">
        <section class="panel"><div class="panel-head"><h2>On-chain</h2><span class="muted" style="font-size:11px">Koios</span></div><div id="tokenOnchain">${skel(5)}</div></section>
        <section class="panel"><div class="panel-head"><h2>About</h2></div><div id="tokenAbout">${skel(4)}</div></section>
      </div>`;
    host.querySelector("[data-star]").addEventListener("click", (e) => toggleWatch(e.target.dataset.star));
    const picker = host.querySelector("#tokenPicker");
    if (picker) {
      const seen = new Map();
      ND.TOKENS.forEach((x) => { if (!seen.has(x.ticker)) seen.set(x.ticker, x); });
      picker.innerHTML = [...seen.values()].sort((a, b) => a.ticker.localeCompare(b.ticker))
        .map((x) => `<option value="${x.ticker}"${x.ticker === t.ticker ? " selected" : ""}>${x.ticker} — ${x.name}</option>`).join("");
      picker.addEventListener("change", (e) => { location.hash = "#token/" + e.target.value; });
    }

    const statRow = (rows) => {
      $("#tokenStatRow").innerHTML = rows.map(([k, v]) =>
        `<div class="token-stat"><div class="lbl">${k}</div><div class="val">${v}</div></div>`).join("");
    };
    statRow([
      ["Mcap", fmt.usdx(t.mcap)], ["FDV", fmt.usdx(t.fdv)],
      ["Vol 24h", fmt.usdx(t.vol)], ["ATH", t.ath ? fmt.prx(t.ath, 4) : "—"],
      ["ATL", t.atl ? fmt.prx(t.atl, 6) : "—"], ["Category", t.category],
    ]);
    paintTokenChart(t);

    // detail → links, about, supplies (CoinGecko)
    const paintTokenMeta = async () => {
      const about = $("#tokenAbout");
      if (!about) return;
      const d = await LIVE.detail(t.cg);
      if (currentToken !== t || !$("#tokenPage")) return;
      if (!d) {
        /* CoinGecko-feed error state: explained message + retry (busts nothing —
           failed fetches aren't cached, so retry just re-hits CoinGecko). */
        about.innerHTML =
          `<div class="empty" style="padding:16px 8px"><strong>Token details unavailable</strong>` +
          `<span class="muted" style="display:block;margin-top:4px">CoinGecko appears to be unreachable from your network. The price and chart data above use cached or DEX-fallback feeds.</span><br>` +
          `<button class="btn btn-sm" type="button" data-retry-meta>Retry</button></div>`;
        about.querySelector("[data-retry-meta]")?.addEventListener("click", (e) => {
          e.stopPropagation();
          e.currentTarget.disabled = true; e.currentTarget.textContent = "Retrying…";
          paintTokenMeta();
        });
        return;
      }
      const L = d.links || {};
      const items = [];
      const hp = (L.homepage || []).filter(Boolean)[0];
      if (hp) items.push(`<a class="link-out" href="${hp}" target="_blank" rel="noopener">Website ↗</a>`);
      const ex = (L.blockchain_site || []).filter(Boolean)[0];
      if (ex) items.push(`<a class="link-out" href="${ex}" target="_blank" rel="noopener">Explorer ↗</a>`);
      if (L.twitter_screen_name) items.push(`<a class="link-out" href="https://x.com/${L.twitter_screen_name}" target="_blank" rel="noopener">X ↗</a>`);
      if (L.telegram_channel_identifier && !/\s/.test(L.telegram_channel_identifier)) items.push(`<a class="link-out" href="https://t.me/${L.telegram_channel_identifier}" target="_blank" rel="noopener">Telegram ↗</a>`);
      const tl = $("#tokenLinks");
      if (tl) tl.innerHTML = items.join("");
      const desc = (d.description && d.description.en || "").replace(/<[^>]*>/g, "").split(". ").slice(0, 3).join(". ");
      const ta = $("#tokenAbout");
      if (ta) ta.innerHTML = desc
        ? `<p style="font-size:13px;line-height:1.6">${desc}${desc.endsWith(".") ? "" : "."}</p><p class="muted" style="font-size:11px">Source: CoinGecko</p>`
        : `<p class="muted">No description available.</p>`;
      const md = d.market_data || {};
      statRow([
        ["Mcap", fmt.usdx(t.mcap)], ["FDV", fmt.usdx(t.fdv)],
        ["Vol 24h", fmt.usdx(t.vol)], ["ATH", t.ath ? fmt.prx(t.ath, 4) : "—"],
        ["Circulating", md.circulating_supply ? fmt.numx(md.circulating_supply) : "—"],
        ["Total supply", md.total_supply ? fmt.numx(md.total_supply) : "—"],
        ["Max supply", md.max_supply ? fmt.numx(md.max_supply) : "—"],
        ["Category", t.category],
      ]);
      const ts = $("#tokenStats");
      if (ts) ts.innerHTML = [
        ["Market cap", fmt.usdx(t.mcap)], ["FDV", fmt.usdx(t.fdv)],
        ["Volume 24h", fmt.usdx(t.vol)], ["ATH", t.ath ? fmt.prx(t.ath, 4) : "—"],
        ["ATL", t.atl ? fmt.prx(t.atl, 6) : "—"],
        ["Circulating", md.circulating_supply ? fmt.numx(md.circulating_supply) : "—"],
        ["Total supply", md.total_supply ? fmt.numx(md.total_supply) : "—"],
        ["Max supply", md.max_supply ? fmt.numx(md.max_supply) : "—"],
      ].map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join("");
    };
    paintTokenMeta();

    // on-chain (Koios)
    const paintOnchain = async () => {
      const oc = $("#tokenOnchain");
      if (!oc) return;
      if (!t.policy) {
        oc.innerHTML = `
          <div class="kv"><span>Type</span><span>Native asset (ADA)</span></div>
          <div class="kv"><span>Explorer</span><a href="https://cardanoscan.io" target="_blank" rel="noopener">Cardanoscan ↗</a></div>`;
        return;
      }
      oc.innerHTML = skel(5);
      const info = await LIVE.koiosAsset(t.policy, t.asset);
      if (currentToken !== t || !$("#tokenOnchain")) return;
      if (!info) {
        /* Fail-soft: unexplained — rows tell the visitor nothing, and a null
           asset_info can mean Koios is unreachable OR the asset simply isn't
           indexed — so show why + retry instead of silent placeholders. */
        $("#tokenOnchain").innerHTML = koiosErrHTML();
        bindKoiosRetry($("#tokenOnchain"), paintOnchain);
        return;
      }
      const meta = (info && info.token_registry_metadata) || {};
      const dec = info && info.decimals != null ? Number(info.decimals)
        : meta.decimals != null ? Number(meta.decimals) : 0;
      $("#tokenOnchain").innerHTML = `
        <div class="kv"><span>Policy ID</span><button class="asset-id" data-copy="${t.policy}" title="${t.policy}">${fmt.hexShort(t.policy, 16)}</button></div>
        <div class="kv"><span>Fingerprint</span><code style="font-size:11px"${info.fingerprint ? ` title="${info.fingerprint}"` : ""}>${info.fingerprint ? fmt.hexShort(info.fingerprint, 16) : "—"}</code></div>
        <div class="kv"><span>Decimals</span><span>${meta.decimals != null ? meta.decimals : "—"}</span></div>
        <div class="kv"><span>Total supply</span><span>${fmt.numx(Number(info.total_supply) / Math.pow(10, dec))}</span></div>
        <div class="kv"><span>Explorer</span><a href="https://cardanoscan.io/token/${t.unit}" target="_blank" rel="noopener">Cardanoscan ↗</a></div>`;
      const cp = $("#tokenOnchain [data-copy]");
      if (cp) cp.addEventListener("click", () => {
        navigator.clipboard?.writeText(cp.dataset.copy).then(() => toast("Policy ID copied"));
      });
    };
    paintOnchain();

    // buys/sells + pairs (DexScreener + GeckoTerminal for Minswap pools)
    LIVE.dexPairsAll(t.unit).then((dex) => {
      if (currentToken !== t || !$("#tokenPage")) return;
      const bs = $("#buysSells"), pt = $("#tokenPairsTable")?.querySelector("tbody");
      if (!dex) {
        // ADA is the native asset: DexScreener has no per-token endpoint for it,
        // so surface the top ADA-quoted pairs from the shared DEX aggregation.
        if (t.ticker === "ADA") { renderAdaPairs(bs, pt, t); return; }
        // Distinguish a feed outage from a token with genuinely no pairs —
        // "down" only when BOTH feeds failed.
        const feedDown = !LIVE.dexUp() && !LIVE.gtUp();
        if (bs) bs.innerHTML = feedDown ? dexErrHTML() : `<p class="muted">No DEX pair data found.</p>`;
        if (pt) pt.innerHTML = feedDown
          ? `<tr><td colspan="8">${dexErrHTML()}</td></tr>`
          : `<tr><td colspan="8" class="muted">No DEX pairs found for this token.</td></tr>`;
        bindDexRetry(bs); bindDexRetry(pt);
        return;
      }
      const tot = dex.buys + dex.sells;
      const bp = tot ? (dex.buys / tot) * 100 : 50;
      if (bs) bs.innerHTML = `
        <div class="bs-bar"><span class="bs-buy" style="width:${bp}%"></span><span class="bs-sell" style="width:${100 - bp}%"></span></div>
        <div class="bs-legend">
          <span><i class="dot-swatch" style="background:#2ee6c5"></i>${fmt.numx(dex.buys)} buys · ${fmt.usdx(dex.buyVol)}</span>
          <span><i class="dot-swatch" style="background:#ff6b7a"></i>${fmt.numx(dex.sells)} sells · ${fmt.usdx(dex.sellVol)}</span>
        </div>
        <div class="muted" style="font-size:11px;margin-top:6px">24h DEX activity · DexScreener + GeckoTerminal (buys/sells from DexScreener only)</div>`;
      if (pt) pt.innerHTML = dex.pairs.slice(0, 12).map((p) => `
        <tr><td><strong>${p.dex}</strong></td><td>${p.pair}</td>
        <td>${p.priceUsd ? fmt.prx(p.priceUsd, 6) : "—"}</td>
        <td class="${chClass(p.ch24)}">${fmt.pct(p.ch24)}</td>
        <td>${fmt.usdx(p.vol24)}</td><td>${fmt.usdx(p.liq)}</td>
        <td><span class="up">${p.buys24 == null ? "—" : p.buys24}</span> / <span class="down">${p.sells24 == null ? "—" : p.sells24}</span></td>
        <td><a href="${p.url}" target="_blank" rel="noopener">Trade ↗</a></td></tr>`).join("");
    });
  }

  async function renderAdaPairs(bs, pt, t) {
    const agg = await getDexAgg().catch(() => null);
    if (currentToken !== t || !$("#tokenPage")) return;
    const feedDown = !agg || !(agg.dexes && agg.dexes.length);
    const adaPairs = ((agg && agg.pairs) || [])
      .filter((p) => /(^|\/)ADA(\/|$)/.test(p.pair || ""))
      .sort((a, b) => (b.liq || 0) - (a.liq || 0))
      .slice(0, 8);
    if (!adaPairs.length) {
      if (bs) bs.innerHTML = feedDown ? dexErrHTML() : `<p class="muted">No DEX pair data found.</p>`;
      if (pt) pt.innerHTML = feedDown
        ? `<tr><td colspan="8">${dexErrHTML()}</td></tr>`
        : `<tr><td colspan="8" class="muted">No DEX pairs found for this token.</td></tr>`;
      bindDexRetry(bs); bindDexRetry(pt);
      return;
    }
    let buys = 0, sells = 0, vol = 0;
    adaPairs.forEach((p) => { buys += p.buys24 || 0; sells += p.sells24 || 0; vol += p.vol24 || 0; });
    const tot = buys + sells;
    const bp = tot ? (buys / tot) * 100 : 50;
    if (bs) bs.innerHTML = `
      <div class="bs-bar"><span class="bs-buy" style="width:${bp}%"></span><span class="bs-sell" style="width:${100 - bp}%"></span></div>
      <div class="bs-legend">
        <span><i class="dot-swatch" style="background:#2ee6c5"></i>${fmt.numx(buys)} buys</span>
        <span><i class="dot-swatch" style="background:#ff6b7a"></i>${fmt.numx(sells)} sells</span>
        <span class="muted">${fmt.usdx(vol)} 24h vol</span>
      </div>
      <div class="muted" style="font-size:11px;margin-top:6px">Top ADA pairs across tracked tokens · DexScreener</div>`;
    if (pt) pt.innerHTML = adaPairs.map((p) => `
      <tr><td><strong>${p.dex}</strong></td><td>${p.pair}</td>
      <td>${p.priceUsd ? fmt.prx(p.priceUsd, 6) : "—"}</td>
      <td class="${chClass(p.ch24)}">${fmt.pct(p.ch24)}</td>
      <td>${fmt.usdx(p.vol24)}</td><td>${fmt.usdx(p.liq)}</td>
      <td><span class="up">${p.buys24 == null ? "—" : p.buys24}</span> / <span class="down">${p.sells24 == null ? "—" : p.sells24}</span></td>
      <td><a href="${p.url}" target="_blank" rel="noopener">Trade ↗</a></td></tr>`).join("");
  }

  async function paintTokenChart(t) {
    const cv = $("#tokenChart");
    if (!cv) return;
    clearChartError(cv);
    const range = chartRanges.TOKEN;
    if (chartType === "candle") {
      const candles = await LIVE.ohlc(t.cg, range);
      if (currentToken !== t || !$("#tokenChart")) return;
      if (candles && candles.length > 1) {
        NDCharts.drawCandles($("#tokenChart"), candles, {
          chartLabel: `${t.ticker} price chart`,
          onHover: (c) => {
            const el = $("#hoverReadout");
            if (el) el.textContent = c ? `O ${fmt.exactUsd(c.o)} · H ${fmt.exactUsd(c.h)} · L ${fmt.exactUsd(c.l)} · C ${fmt.exactUsd(c.c)}` : "";
          },
        });
        return;
      }
      toast("Candles unavailable for this range — line chart shown");
    }
    const series = await LIVE.chart(t.cg, range);
    if (currentToken !== t || !$("#tokenChart")) return;
    if (!series) { chartError($("#tokenChart"), "Price chart unavailable", () => { if (currentToken === t) paintTokenChart(t); }); return; }
    NDCharts.drawLineChart($("#tokenChart"), series, {
      range,
      chartLabel: `${t.ticker} price chart`,
      onHover: (p) => {
        const el = $("#hoverReadout");
        if (el) el.textContent = p ? `${fmt.exactUsd(p.v)} · ${new Date(p.t).toLocaleString()}` : "";
      },
    });
  }

  /* ——— Portfolio / wallet UI ——— */
  const WALLET_UI = {
    render() {
      const s = WALLET.state;
      const provs = WALLET.providers();
      if (!s.connected && !s.watchOnly.length && !s.loading) return this.renderConnect(provs);
      if (s.loading) {
        $("#pfConnect").innerHTML = "";
        $("#pfDash").style.display = "block";
        $("#pfStats").innerHTML = skelCards(4);
        return;
      }
      if (s.error) {
        $("#pfDash").style.display = "none";
        $("#pfConnect").innerHTML = `<div class="panel"><div class="empty"><strong>${s.error}</strong><br><br><button class="btn" id="pfRetry" type="button">Retry</button></div></div>`;
        $("#pfRetry")?.addEventListener("click", () => { WALLET.refresh().then(() => this.render()); });
        return;
      }
      this.renderDash();
    },
    renderConnect(provs) {
      $("#pfDash").style.display = "none";
      const cards = provs.length ? provs.map((p) => `
        <button class="wallet-card" data-wallet="${p.key}" type="button">
          ${p.icon ? `<img src="${p.icon}" alt="" loading="lazy" decoding="async">` : `<span class="token-avatar">${p.name.charAt(0)}</span>`}
          <strong>${p.name}</strong><span class="muted">Connect</span>
        </button>`).join("")
        : `<div class="empty"><strong>No Cardano wallet extension detected</strong><span class="muted">Install one to continue:</span>
          <div class="install-row">${Object.entries(WALLET.INSTALL).map(([k, u]) =>
            `<a href="${u}" target="_blank" rel="noopener">${k}</a>`).join("")}</div></div>`;
      $("#pfConnect").innerHTML = `
        <div class="panel" style="margin-bottom:12px"><div class="panel-head"><h2>Connect a wallet</h2></div>
          <p class="muted" style="font-size:13px">NightDream reads your public addresses through Koios. Nothing is signed, nothing leaves your wallet.</p>
          <div class="wallet-grid">${cards}</div></div>
        <div class="panel"><div class="panel-head"><h2>Or track an address</h2></div>
          <p class="muted" style="font-size:13px">Paste any Cardano address (addr1… or stake1…) to watch it without connecting.</p>
          <div class="row-flex"><input id="watchAddr" class="input" aria-label="Cardano address to track" placeholder="addr1… / stake1…"><button class="btn btn-primary" id="watchAddBtn" type="button">Track</button></div>
        </div>`;
      $$("#pfConnect [data-wallet]").forEach((b) =>
        b.addEventListener("click", async () => {
          b.disabled = true;
          try { await WALLET.connect(b.dataset.wallet); toast("Wallet connected"); }
          catch (e) { toast(e.message || "Connection failed"); }
          this.render();
        }));
      $("#watchAddBtn")?.addEventListener("click", async () => {
        try { await WALLET.addWatchOnly($("#watchAddr").value); toast("Address tracked"); this.render(); }
        catch (e) { toast(e.message); }
      });
    },
    renderDash() {
      const s = WALLET.state;
      $("#pfConnect").innerHTML = "";
      $("#pfDash").style.display = "block";
      const best = [...s.positions].sort((a, b) => (b.ch24 || -999) - (a.ch24 || -999))[0];
      const worst = [...s.positions].sort((a, b) => (a.ch24 || 999) - (b.ch24 || 999))[0];
      const stat = (label, value, sub, ch) => `
        <div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>
        <div class="stat-sub ${chClass(ch)}">${sub}</div></div>`;
      $("#pfStats").innerHTML =
        stat("Net worth", fmt.usdx(s.totalUsd), s.updatedAt ? "updated " + fmt.timeAgo(s.updatedAt) : "", 0) +
        stat("Positions", String(s.positions.length), s.nfts.length + " NFTs", 0) +
        stat("Best 24h", best ? best.ticker : "—", best ? fmt.pct(best.ch24) : "", best ? best.ch24 : 0) +
        stat("Worst 24h", worst ? worst.ticker : "—", worst ? fmt.pct(worst.ch24) : "", worst ? worst.ch24 : 0);

      requestAnimationFrame(() => {
        const cv = $("#pfAllocChart");
        if (!cv) return;
        NDCharts.drawDonut(cv, s.positions.slice(0, 8).map((p) => ({
          label: p.ticker, pct: s.totalUsd ? (p.value / s.totalUsd) * 100 : 0,
        })), { chartLabel: "Portfolio allocation" });
      });
      const colors = ["#8b7cff", "#2ee6c5", "#ffb020", "#ff6b7a", "#5b8cff", "#c084fc", "#34d399", "#94a3b8"];
      $("#pfAllocLegend").innerHTML = s.positions.slice(0, 8).map((p, i) => `
        <span><span><i class="dot-swatch" style="background:${colors[i % colors.length]}"></i>${p.ticker}</span>
        <span>${s.totalUsd ? ((p.value / s.totalUsd) * 100).toFixed(1) : 0}% · ${fmt.usdx(p.value)}</span></span>`).join("");

      $("#pf-tokens").innerHTML = `<div class="table-wrap"><table class="data-table"><thead><tr>
        <th>Token</th><th>Amount</th><th>Price</th><th>Value</th><th>24h</th></tr></thead><tbody>
        ${s.positions.map((p) => `
          <tr><td><div class="token-cell">${icon({ ticker: p.ticker, image: p.image }, 1)}<div class="token-meta"><strong>${p.ticker}</strong><span>${p.name}</span></div></div></td>
          <td title="${fmt.exactNum(p.qty)}">${p.qty.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
          <td>${p.price ? fmt.prx(p.price, 6) : "—"}</td><td>${fmt.usdx(p.value)}</td>
          <td class="${chClass(p.ch24)}">${fmt.pct(p.ch24)}</td></tr>`).join("")
          || `<tr><td colspan="5" class="muted">No token positions found.</td></tr>`}
        </tbody></table></div>`;

      $("#pf-nfts").innerHTML = s.nfts.length
        ? `<div class="nft-grid">${s.nfts.slice(0, 24).map((n) => `
          <div class="nft-card"><div class="nft-art">${(n.name || "?").charAt(0).toUpperCase()}</div>
          <div class="nft-name">${n.name}</div><div class="muted" style="font-size:11px">${fmt.hexShort(n.unit, 10)}</div></div>`).join("")}</div>`
        : `<div class="empty"><strong>No NFTs detected</strong><span class="muted">Single-unit unknown assets show up here.</span></div>`;

      const wallets = [];
      if (s.connected) wallets.push({ label: s.providerName + " · connected", addr: s.address, on: true });
      s.watchOnly.forEach((w) => wallets.push({ label: "Tracked address", addr: w, on: false }));
      $("#pf-wallets").innerHTML = wallets.map((w) => `
        <div class="list-row"><div><strong>${w.label}</strong><div class="muted" style="font-size:12px">${w.addr}</div></div>
        <span class="tag ${w.on ? "" : "markets"}">${w.on ? "connected" : "tracked"}</span></div>`).join("") + `
        <div class="row-flex" style="margin-top:12px"><input id="watchAddr2" class="input" aria-label="Another Cardano address to track" placeholder="Track another addr1… / stake1…">
        <button class="btn btn-sm" id="watchAddBtn2" type="button">Track</button>
        ${s.connected ? `<button class="btn btn-sm btn-ghost" id="pfDisconnect" type="button">Disconnect</button>` : ""}</div>`;
      $("#watchAddBtn2")?.addEventListener("click", async () => {
        try { await WALLET.addWatchOnly($("#watchAddr2").value); toast("Address tracked"); this.render(); }
        catch (e) { toast(e.message); }
      });
      $("#pfDisconnect")?.addEventListener("click", () => { WALLET.disconnect(); this.render(); renderPfMiniPanel(); });

      $("#pf-activity").innerHTML = `<div class="table-wrap"><table class="data-table"><thead><tr><th>Transaction</th><th>Time</th><th>Fee</th></tr></thead>
        <tbody id="pfActivityBody"></tbody></table></div>`;
      const paintActivity = () => {
        const tb = $("#pfActivityBody");
        if (!tb) return;
        /* No addr1… payment address at all (stake1-only tracking): a feed
           failure and a missing address must not look identical — show why
           there's nothing to load, without a misleading Retry button. */
        const hasPayAddr = WALLET.state.address || WALLET.state.watchOnly.some((w) => w.startsWith("addr1"));
        if (!hasPayAddr) {
          tb.innerHTML = `<tr><td colspan="3" class="muted">Activity needs a payment address (addr1…)&thinsp;—&thinsp;stake addresses track assets, not transactions.</td></tr>`;
          return;
        }
        tb.innerHTML = `<tr><td colspan="3">${skel(3)}</td></tr>`;
        WALLET.tradeHistory(15).then((txs) => {
          const t2 = $("#pfActivityBody");
          if (!t2) return;
          if (!txs) {
            /* Fail-soft: Koios address_txs returned nothing — explained
               message + retry instead of the old silent "unavailable".
               Failed fetches aren't cached, so retry re-hits Koios. */
            t2.innerHTML = `<tr><td colspan="3"><div class="empty" style="padding:16px 8px"><strong>Activity unavailable</strong>` +
              `<span class="muted" style="display:block;margin-top:4px">Koios appears to be unreachable from your network. Nothing was changed locally.</span><br>` +
              `<button class="btn btn-sm" type="button" data-retry-activity>Retry</button></div></td></tr>`;
            t2.querySelectorAll("[data-retry-activity]").forEach((b) =>
              b.addEventListener("click", (e) => {
                e.stopPropagation();
                b.disabled = true; b.textContent = "Retrying…";
                paintActivity();
              }));
            return;
          }
          t2.innerHTML = txs.map((x) => `
            <tr><td><a href="https://cardanoscan.io/transaction/${x.tx_hash}" target="_blank" rel="noopener"><code>${x.tx_hash.slice(0, 12)}…</code> ↗</a></td>
            <td>${x.block_time ? new Date(x.block_time * 1000).toLocaleString() : "—"}</td>
            <td class="muted">${x.fee ? fmt.ada(Number(x.fee) / 1e6) : ""}</td></tr>`).join("")
            || `<tr><td colspan="3" class="muted">No recent transactions.</td></tr>`;
        });
      };
      paintActivity();
    },
  };
  window.WALLET_UI = WALLET_UI;

  /* ——— DEX ——— */
  async function renderDex() {
    $("#dexList").innerHTML = skel(6);
    $("#dexPulse").innerHTML = skelCards(4);
    $("#poolsTable").querySelector("tbody").innerHTML = `<tr><td colspan="7">${skel(6)}</td></tr>`;
    const dn = $("#dexNote");
    if (dn) dn.textContent = "Aggregating top pairs from DexScreener + GeckoTerminal…";
    const agg = await getDexAgg();
    if (currentRoute !== "dex") return;
    const totVolRaw = agg.dexes.reduce((s, d) => s + d.vol24, 0);
    const totVol = totVolRaw || 1;
    const totLiq = agg.pairs.reduce((s, p) => s + (p.liq || 0), 0);
    const totPairs = agg.dexes.reduce((s, d) => s + (d.pairs || 0), 0);
    const top = agg.dexes[0];
    const pstat = (label, value, sub) => `
      <div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>
      <div class="stat-sub">${sub}</div></div>`;
    const dexFeedDown = !agg.dexes.length;
    const srcTag = agg.gt ? "live · DexScreener + GeckoTerminal" : "live · DexScreener";
    /* Feed-down: the four pulse cards showed bare "—" values with no explanation
       and no retry in that region — collapse them into one explained panel +
       retry (mirrors the dexErrHTML pattern used for the list/table below). */
    $("#dexPulse").innerHTML = dexFeedDown
      ? `<div class="empty" style="grid-column:1/-1;padding:24px 16px"><strong>DEX stats unavailable</strong>` +
        `<span class="muted" style="display:block;margin-top:4px">Both DEX feeds (DexScreener and GeckoTerminal) appear to be unreachable from your network, so tracked volume, liquidity, pair and venue counts can't be computed. Nothing was changed locally.</span><br>` +
        `<button class="btn btn-sm" type="button" data-retry-dex>Retry</button></div>`
      : pstat("Tracked DEX volume 24h", totVolRaw ? fmt.usdx(totVolRaw) : "—", srcTag) +
        pstat("Liquidity tracked", totLiq ? fmt.usdx(totLiq) : "—", agg.pairs.length + " top pairs") +
        pstat("Pairs tracked", totPairs ? fmt.numx(totPairs) : "—", agg.dexes.length + " venues") +
        pstat("Top venue", top ? top.name : "—", top && totVolRaw ? ((top.vol24 / totVol) * 100).toFixed(1) + "% of volume" : "—");
    bindDexRetry($("#dexPulse"));
    requestAnimationFrame(() => {
      const b = $("#dexVolChart"), d = $("#dexShareChart");
      if (!b || !d) return;
      NDCharts.drawBars(b, agg.dexes.slice(0, 8).map((x) => ({ label: x.name, pct: (x.vol24 / totVol) * 100 })), { chartLabel: "DEX 24h volume" });
      NDCharts.drawDonut(d, agg.dexes.map((x) => ({ label: x.name, pct: (x.vol24 / totVol) * 100 })), { chartLabel: "DEX volume share" });
    });
    const colors = ["#8b7cff", "#2ee6c5", "#ffb020", "#ff6b7a", "#5b8cff", "#c084fc", "#34d399", "#94a3b8"];
    $("#dexShareLegend").innerHTML = agg.dexes.map((d, i) => `
      <span><span><i class="dot-swatch" style="background:${colors[i % colors.length]}"></i>${d.name}</span>
      <span>${((d.vol24 / totVol) * 100).toFixed(1)}%</span></span>`).join("");
    $("#dexList").innerHTML = agg.dexes.map((d) => `
      <div class="list-row">${dexCell(d.name)}<span>${fmt.usdx(d.vol24)} · ${d.pairs} pairs</span></div>`).join("")
      || dexErrHTML();
    const vis = agg.pairs.slice(0, 20);
    const maxLiq = Math.max(...vis.map((p) => p.liq || 0), 1);
    $("#poolsTable").querySelector("tbody").innerHTML = vis.map((p) => `
      <tr><td><strong>${p.pair}</strong></td><td>${dexCell(p.dex)}</td><td>${liqBar(p.liq, maxLiq)}</td>
      <td>${fmt.usdx(p.vol24)}</td><td class="${chClass(p.ch24)}">${fmt.pct(p.ch24)}</td>
      <td><span class="up">${p.buys24 == null ? "—" : p.buys24}</span> / <span class="down">${p.sells24 == null ? "—" : p.sells24}</span></td>
      <td><a href="${p.url}" target="_blank" rel="noopener">View ↗</a></td></tr>`).join("")
      || `<tr><td colspan="7">${dexErrHTML()}</td></tr>`;
    bindDexRetry($("#dexList"));
    bindDexRetry($("#poolsTable"));
    if (dn) dn.textContent = dexFeedDown
      ? "DEX feed unreachable · DexScreener · nothing changed locally"
      : `24h volume aggregated from top pairs of 12 tracked tokens · ${agg.gt ? "DexScreener + GeckoTerminal" : "DexScreener"} · updated ${fmt.timeAgo(dexAggAt)}`;
  }

  /* ——— Staking pools ——— */
  let _stake = null, _stakeAt = 0, _stakeSortKey = "stake", _stakeSortDir = -1, _stakeQ = "";

  function satCell(sat) {
    if (sat == null || Number.isNaN(sat)) return "—";
    const cls = sat > 100 ? "over" : sat > 80 ? "warn" : "";
    return `<div title="${sat.toFixed(2)}% live saturation">${sat.toFixed(1)}%` +
      `<div class="liq-bar"><i class="${cls}" style="width:${Math.min(sat, 100).toFixed(1)}%"></i></div></div>`;
  }
  function adaCell(lovelace) {
    const ada = lovelace / 1e6;
    const exact = fmt.exactNum(ada) + " ₳";
    return `<span title="${exact}">${fmt.ada(ada)}</span>`;
  }

  async function renderStaking() {
    $("#stakPulse").innerHTML = skelCards(4);
    $("#stakePoolsTable").querySelector("tbody").innerHTML = `<tr><td colspan="7">${skel(8)}</td></tr>`;
    const sn = $("#stakNote");
    if (sn) sn.textContent = "Fetching stake pools from Koios…";
    const res = await LIVE.koiosPools();
    if (currentRoute !== "staking") return;
    const err = `<div class="empty" style="grid-column:1/-1;padding:24px 16px"><strong>Stake pools unavailable</strong>` +
      `<span class="muted" style="display:block;margin-top:4px">Koios appears to be unreachable from your network, so pool rankings can't be computed. Nothing was changed locally.</span><br>` +
      `<button class="btn btn-sm" type="button" data-retry-staking>Retry</button></div>`;
    if (!res || !res.rows.length) {
      $("#stakPulse").innerHTML = err;
      $("#stakePoolsTable").querySelector("tbody").innerHTML = `<tr><td colspan="7">${err}</td></tr>`;
      if (sn) sn.textContent = "Koios · unreachable · nothing changed locally";
      bindStakingRetry($("#stakPulse"));
      bindStakingRetry($("#stakePoolsTable"));
      return;
    }
    _stake = res.rows;
    _stakeAt = res.fetchedAt;
    _stakeQ = $("#stakeSearch") ? $("#stakeSearch").value : "";
    if (sn) sn.textContent = `registered pools ranked by active stake · Koios · updated ${fmt.timeAgo(_stakeAt)}`;
    paintStaking();
  }

  function paintStaking() {
    if (!_stake) return;
    const q = _stakeQ.trim().toLowerCase();
    let rows = _stake.filter((r) =>
      !q || (r.ticker && r.ticker.toLowerCase().includes(q)) || r.poolId.toLowerCase().includes(q));
    const key = _stakeSortKey, dir = _stakeSortDir;
    const val = (r) => key === "pool" ? (r.ticker || r.poolId)
      : key === "stake" ? r.activeStake : key === "sat" ? (r.saturation == null ? -1 : r.saturation)
      : key === "margin" ? (r.margin == null ? -1 : r.margin) : key === "pledge" ? r.pledge
      : key === "delegators" ? (r.delegators == null ? -1 : r.delegators) : (r.blocks == null ? -1 : r.blocks);
    rows = rows.slice().sort((a, b) => {
      const x = val(a), y = val(b);
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir;
    });
    const satOver = _stake.filter((r) => r.saturation != null && r.saturation > 100).length;
    const margins = _stake.map((r) => r.margin).filter((m) => m != null);
    const avgMargin = margins.length ? margins.reduce((s, m) => s + m, 0) / margins.length : null;
    const totStake = _stake.reduce((s, r) => s + r.activeStake, 0);
    const pstat = (label, value, sub) => `
      <div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>
      <div class="stat-sub">${sub}</div></div>`;
    $("#stakPulse").innerHTML =
      pstat("Pools ranked", fmt.numx(_stake.length), "registered · active stake") +
      pstat("Oversaturated", satOver ? `<span class="down">${satOver}</span>` : "0", "over 100% · rewards capped") +
      pstat("Avg margin", avgMargin != null ? (avgMargin * 100).toFixed(1) + "%" : "—", "of ranked pools") +
      pstat("Ranked active stake", adaCell(totStake), "combined · top pools");
    $("#stakePoolsTable").querySelector("tbody").innerHTML = rows.map((r) => `
      <tr><td><strong>${r.ticker || "—"}</strong><br>
        <span class="muted" title="${r.poolId}">${r.poolId.slice(0, 14)}…</span></td>
      <td>${adaCell(r.activeStake)}</td>
      <td>${satCell(r.saturation)}</td>
      <td>${r.margin != null ? (r.margin * 100).toFixed(1) + "%" : "—"}</td>
      <td>${adaCell(r.pledge)}</td>
      <td>${r.delegators != null ? fmt.numx(r.delegators) : "—"}</td>
      <td>${r.blocks != null ? fmt.numx(r.blocks) : "—"}</td></tr>`).join("")
      || `<tr><td colspan="7"><div class="empty">No pools match your search.</div></td></tr>`;
    $$("#stakePoolsTable th").forEach((x) => {
      const on = x.dataset.sort === _stakeSortKey;
      x.classList.toggle("sorted", on);
      if (on) x.setAttribute("aria-sort", _stakeSortDir === 1 ? "ascending" : "descending");
      else x.removeAttribute("aria-sort");
    });
  }

  function bindStakingRetry(scope) {
    scope?.querySelectorAll("[data-retry-staking]").forEach((b) => b.addEventListener("click", () => {
      b.disabled = true;
      b.textContent = "Retrying…";
      renderStaking();
    }));
  }

  /* ——— Governance ——— */
  let _gov = null, _govAt = 0, _govQ = "";

  function govStatusCls(s) {
    return s === "Enacted" || s === "Ratified" ? "up" : s === "Dropped" || s === "Expired" ? "down" : "";
  }
  function govIdShort(id) {
    return id.length > 22 ? id.slice(0, 18) + "…" : id;
  }
  function tallyBar(t) {
    if (!t || !t.total) return '<span class="muted">no votes yet</span>';
    const y = (t.yes / t.total * 100).toFixed(1), n = (t.no / t.total * 100).toFixed(1);
    return `<div class="tally" title="Yes ${t.yes} · No ${t.no} · Abstain ${t.abstain}">` +
      `<i style="width:${y}%;background:var(--green)"></i>` +
      `<i style="width:${n}%;background:var(--red)"></i>` +
      `<i style="flex:1;background:#5b6470"></i></div>`;
  }

  async function renderGovernance() {
    $("#govPulse").innerHTML = skelCards(4);
    $("#govActive").innerHTML = skelCards(2);
    $("#govRecentTable").querySelector("tbody").innerHTML = `<tr><td colspan="6">${skel(8)}</td></tr>`;
    $("#govDrepTable").querySelector("tbody").innerHTML = `<tr><td colspan="4">${skel(10)}</td></tr>`;
    const note = $("#govNote");
    if (note) note.textContent = "Fetching governance data from Koios…";
    const res = await LIVE.koiosGovernance();
    if (currentRoute !== "governance") return;
    if (!res) {
      const err = `<div class="empty" style="grid-column:1/-1;padding:24px 16px"><strong>Governance data unavailable</strong>` +
        `<span class="muted" style="display:block;margin-top:4px">Koios appears to be unreachable from your network. Nothing was changed locally.</span><br>` +
        `<button class="btn btn-sm" type="button" data-retry-gov>Retry</button></div>`;
      $("#govPulse").innerHTML = err;
      $("#govActive").innerHTML = "";
      $("#govRecentTable").querySelector("tbody").innerHTML = `<tr><td colspan="6">${err}</td></tr>`;
      $("#govDrepTable").querySelector("tbody").innerHTML = `<tr><td colspan="4"><div class="empty" style="padding:16px 8px"><strong>DRep leaderboard unavailable</strong><span class="muted" style="display:block;margin-top:4px">Koios is unreachable, so DRep voting power can't be loaded. Use Retry above.</span></div></td></tr>`;
      if (note) note.textContent = "Koios · unreachable · nothing changed locally";
      $$("[data-retry-gov]").forEach((b) => b.addEventListener("click", () => {
        b.disabled = true; b.textContent = "Retrying…"; renderGovernance();
      }));
      return;
    }
    _gov = res;
    _govAt = res.fetchedAt;
    _govQ = $("#govSearch") ? $("#govSearch").value : "";
    if (note) note.textContent = `on-chain governance actions · Koios · updated ${fmt.timeAgo(_govAt)}`;
    paintGovernance();
  }

  function paintGovernance() {
    if (!_gov) return;
    const q = _govQ.trim().toLowerCase();
    const match = (p) => !q || p.type.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || p.status.toLowerCase().includes(q);
    const active = _gov.proposals.filter((p) => p.status === "Active").filter(match);
    const recent = _gov.proposals.filter((p) => p.status !== "Active").filter(match).slice(0, 30);
    const totPower = _gov.dreps.reduce((s, d) => s + d.power, 0);
    const pstat = (label, value, sub) => `
      <div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>
      <div class="stat-sub">${sub}</div></div>`;
    $("#govPulse").innerHTML =
      pstat("Active actions", fmt.numx(_gov.proposals.filter((p) => p.status === "Active").length), "awaiting votes · on-chain") +
      pstat("Proposals tracked", fmt.numx(_gov.proposals.length), "most recent 100 · Koios") +
      pstat("DReps scanned", fmt.numx(_gov.drepCount), "page scanned · Koios") +
      pstat("Top-100 DRep power", adaCell(totPower), "combined voting stake");
    $("#govActive").innerHTML = active.length ? active.map((p) => `
      <div class="stat-card">
        <div class="stat-label">${p.type} · <span class="${govStatusCls(p.status)}">${p.status}</span></div>
        <div style="font-size:13px;margin:6px 0" title="${p.id}">${govIdShort(p.id)}</div>
        <div class="stat-sub">proposed epoch ${p.proposedEpoch} · expires epoch ${p.expiration}${p.deposit != null ? " · deposit " + fmt.ada(p.deposit / 1e6) : ""}</div>
        <div style="margin-top:8px">${tallyBar(p.tally)}</div>
        <div class="stat-sub" style="margin-top:4px">${p.tally ? `Yes ${p.tally.yes} · No ${p.tally.no} · Abstain ${p.tally.abstain}` : "vote tally unavailable"}</div>
      </div>`).join("")
      : `<div class="empty" style="grid-column:1/-1">${q ? "No active actions match your search." : "No active governance actions right now — every recent proposal has been decided."}</div>`;
    $("#govRecentTable").querySelector("tbody").innerHTML = recent.map((p) => `
      <tr><td><strong>${p.type}</strong><br><span class="muted" title="${p.id}">${govIdShort(p.id)}</span></td>
      <td class="${govStatusCls(p.status)}">${p.status}</td>
      <td>${p.proposedEpoch}</td>
      <td>${p.deposit != null ? adaCell(p.deposit) : "—"}</td>
      <td style="min-width:120px">${tallyBar(p.tally)}</td>
      <td class="muted">${p.tally ? `Y ${p.tally.yes} / N ${p.tally.no} / A ${p.tally.abstain}` : "—"}</td></tr>`).join("")
      || `<tr><td colspan="6"><div class="empty">No proposals match your search.</div></td></tr>`;
    $("#govDrepTable").querySelector("tbody").innerHTML = _gov.dreps.slice(0, 50).map((d, i) => `
      <tr><td class="muted">${i + 1}</td>
      <td><span title="${d.id}">${govIdShort(d.id)}</span></td>
      <td>${adaCell(d.power)}</td>
      <td>${d.active ? '<span class="up">active</span>' : '<span class="muted">inactive</span>'}</td></tr>`).join("")
      || `<tr><td colspan="4"><div class="empty"><strong>DRep leaderboard unavailable</strong><span class="muted" style="display:block;margin-top:4px">Koios responded without any DRep entries, so voting power can't be shown right now. Use Retry above.</span></div></td></tr>`;
  }

  /* ——— Midnight ——— */
  async function renderMidnight() {
    const night = ND.TOKENS.find((t) => t.cg === "midnight-3");
    if (!night) {
      // Fail-soft instead of endless skeletons: fields render as —, and the
      // DUST calculator keeps working off the network-parameter model
      // (the 5-minute refresh loop re-checks for NIGHT automatically).
      $("#nightStats").innerHTML = ["NIGHT price", "Mcap", "FDV", "Vol 24h"].map((l) =>
        `<div class="stat-card"><div class="stat-label">${l}</div><div class="stat-value">—</div>` +
        `<div class="stat-sub">NIGHT data unavailable · retries automatically</div></div>`).join("");
      $("#dustNote").textContent = ND.MIDNIGHT.generationNote;
      $("#bridgeNote").textContent = ND.MIDNIGHT.bridgeNote;
      updateDustCalc();
      paintRedemption();
      return;
    }
    const stat = (label, value, sub, ch) => `
      <div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>
      <div class="stat-sub ${chClass(ch)}">${sub}</div></div>`;
    $("#nightStats").innerHTML =
      stat("NIGHT price", fmt.prx(night.price, 4), fmt.pct(night.ch24) + " 24h", night.ch24) +
      stat("Mcap", fmt.usdx(night.mcap), night.rank ? "Rank #" + night.rank : "", 0) +
      stat("FDV", fmt.usdx(night.fdv), fmt.pct(night.ch7d) + " 7d", night.ch7d) +
      stat("Vol 24h", fmt.usdx(night.vol), "CoinGecko", 0);
    $("#dustNote").textContent = ND.MIDNIGHT.generationNote;
    $("#bridgeNote").textContent = ND.MIDNIGHT.bridgeNote;
    updateDustCalc();
    paintRedemption();
    drawNightChart(chartRanges.NIGHT);
    paintMidnightNetwork();
  }
  async function paintMidnightNetwork() {
    const host = $("#mnNetStats");
    const src = $("#mnNetSource");
    if (!host) return;
    host.innerHTML = skelCards(6);
    const o = await LIVE.nightforgeOverview();
    if (!o) {
      host.innerHTML = `<div class="empty" style="grid-column:1/-1;padding:18px">
        <strong>NightForge unreachable</strong>
        <span class="muted">Network stats retry automatically on the next refresh, or retry now. NIGHT price above still comes from CoinGecko.</span><br>
        <button class="btn btn-sm" type="button" data-retry-nightforge>Retry</button>
      </div>`;
      bindNightForgeRetry(host);
      if (src) src.textContent = "NightForge · offline";
      return;
    }
    const fmtN = (n) => (n == null ? "—" : fmt.numx(n));
    const items = [
      ["Blocks", fmtN(o.blocks)],
      ["TPS", o.tps != null ? Number(o.tps).toFixed(3) : "—"],
      ["Shielded", o.shieldedRatio != null ? (o.shieldedRatio * 100).toFixed(1) + "%" : "—"],
      ["Avg block", o.avgBlockTime != null ? o.avgBlockTime + "s" : "—"],
      ["Bridge ops", fmtN(o.bridgeOps)],
      ["Committee", o.committeeSize != null ? String(o.committeeSize) : "—"],
    ];
    host.innerHTML = items.map(([label, value]) => `
      <div class="stat-card"><div class="stat-label">${label} · live</div>
      <div class="stat-value">${value}</div></div>`).join("");
    if (src) src.textContent = "NightForge · live";
  }
  /* ——— NIGHT redemption tracker ———
     Fixed public schedule (Glacier claim window closed Oct 20, 2025; redemption
     thaws Dec 2025 → Dec 4, 2026; 90-day grace after). The thaw calculator is
     pure local computation from the user's own inputs — NightDream has no
     per-address claim API and never pretends to. */
  const REDEEM_CLOSE = Date.UTC(2026, 11, 4);
  const GRACE_END = Date.UTC(2027, 2, 4);
  const THAW_DAYS = 90;

  function paintRedemption() {
    const phase = $("#redeemPhase"), stats = $("#redeemStats");
    if (!phase || !stats) return;
    const now = Date.now();
    const daysTo = (t) => Math.max(0, Math.ceil((t - now) / 86400000));
    let phaseTxt, closeVal, closeSub;
    if (now < REDEEM_CLOSE) {
      phaseTxt = "final thaw window · Sep 6 → Dec 4, 2026";
      closeVal = daysTo(REDEEM_CLOSE) + " days";
      closeSub = "redemption closes Dec 4, 2026";
    } else if (now < GRACE_END) {
      phaseTxt = "grace period · until ~Mar 4, 2027";
      closeVal = daysTo(GRACE_END) + " days";
      closeSub = "grace period ends ~Mar 4, 2027";
    } else {
      phaseTxt = "redemption ended";
      closeVal = "ended";
      closeSub = "redemption + grace period over";
    }
    phase.textContent = phaseTxt;
    const card = (label, value, sub) =>
      `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div>`;
    stats.innerHTML =
      card("Redemption closes", closeVal, closeSub) +
      card("Grace period ends", "~Mar 4, 2027", "90 days after close") +
      card("Thaw model", "4 × 25%", "90 days apart") +
      card("Lost-and-Found", "~252M NIGHT", "for eligible non-claimants");
    try {
      const a = localStorage.getItem("nd.redeem.alloc"), f = localStorage.getItem("nd.redeem.first");
      if (a && $("#redeemAlloc") && !$("#redeemAlloc").value) $("#redeemAlloc").value = a;
      if (f && $("#redeemFirst") && !$("#redeemFirst").value) $("#redeemFirst").value = f;
    } catch (_) {}
    paintRedeemTable();
  }

  function paintRedeemTable() {
    const tb = $("#redeemTable")?.querySelector("tbody");
    if (!tb) return;
    const alloc = parseFloat($("#redeemAlloc")?.value), first = $("#redeemFirst")?.value;
    if (!(alloc > 0) || !first) {
      tb.innerHTML = `<tr><td colspan="4"><div class="empty">Enter your allocation and first thaw date to build your schedule.</div></td></tr>`;
      return;
    }
    const d0 = new Date(first + "T00:00:00");
    if (Number.isNaN(d0.getTime())) {
      tb.innerHTML = `<tr><td colspan="4"><div class="empty">That date doesn't look valid — check the first-thaw field.</div></td></tr>`;
      return;
    }
    const now = Date.now();
    let html = "";
    for (let i = 0; i < 4; i++) {
      const d = new Date(d0);
      d.setDate(d.getDate() + i * THAW_DAYS);
      const past = d.getTime() <= now;
      html += `<tr><td>${i + 1} of 4</td>` +
        `<td>${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>` +
        `<td>${fmt.numx(Math.round((alloc / 4) * 100) / 100)} NIGHT</td>` +
        `<td>${past ? '<span class="up">thawed</span>' : '<span class="muted">upcoming</span>'}</td></tr>`;
    }
    tb.innerHTML = html;
  }

  async function drawNightChart(range) {
    const days = range === "24H" ? 1 : range === "7D" ? 7 : 30;
    const series = await LIVE.chart("midnight-3", days);
    const cv = $("#nightDeepChart");
    if (!series || currentRoute !== "midnight" || !cv) {
      if (currentRoute === "midnight" && cv) chartError(cv, "NIGHT chart unavailable", () => drawNightChart(range));
      return;
    }
    clearChartError(cv);
    NDCharts.drawLineChart(cv, series, { range, color: "#2ee6c5", fill: "rgba(46,230,197,0.10)", chartLabel: "NIGHT price chart" });
  }
  function updateDustCalc() {
    const rawHoldings = Number($("#nightHoldings")?.value ?? 0);
    const rawFactor = Number($("#genFactor")?.value ?? 0.0146);
    const el = $("#dustResult");
    if (!el) return;
    if (!Number.isFinite(rawHoldings) || !Number.isFinite(rawFactor) || rawHoldings < 0 || rawFactor < 0) {
      el.innerHTML = `<strong class="down">Invalid input</strong><br/><span class="muted">Enter a non-negative NIGHT holding and generation factor.</span>`;
      return;
    }
    const holdings = rawHoldings;
    // round to 4dp: keeps float artifacts (e.g. 0.014600000344216824) out of the math
    const factor = Number(rawFactor.toFixed(4));
    const cap = holdings * ND.MIDNIGHT.dustPerNightMax;
    const rate = holdings * factor;
    el.innerHTML = `<strong>Capacity:</strong> ~${fmt.numx(cap)} DUST max (5 × NIGHT)<br/>
      <strong>Est. generation:</strong> ~${fmt.estx(rate)} DUST / day<br/>
      <span class="muted">Model estimate — real rates follow Midnight network parameters.</span>`;
  }

  /* ——— Watchlist ——— */
  function renderWatchlist() {
    const ids = [...watch].map((id) => ND.getToken(id)).filter(Boolean);
    const tb = $("#watchTable").querySelector("tbody");
    const empty = $("#watchEmpty");
    if (!ids.length) { tb.innerHTML = ""; empty.style.display = "block"; return; }
    empty.style.display = "none";
    tb.innerHTML = ids.map((t) => `
      <tr><td><button class="star-btn on" data-star="${t.ticker}" type="button" aria-pressed="true" aria-label="Toggle watchlist for ${t.ticker}">★</button></td>
      <td><a class="token-cell row-link" href="#token/${t.ticker}">${icon(t, 1)}<div class="token-meta"><strong>${t.ticker}</strong><span>${t.name}</span></div></a></td>
      <td>${fmt.prx(t.price, 6)}</td><td class="${chClass(t.ch24)}">${fmt.pct(t.ch24)}</td>
      <td>${fmt.usdx(t.vol)}</td><td>${fmt.usdx(t.mcap)}</td>
      <td><a class="btn btn-sm" href="#token/${t.ticker}">Open</a></td></tr>`).join("");
    tb.querySelectorAll("[data-star]").forEach((b) => b.addEventListener("click", () => toggleWatch(b.dataset.star)));
  }

  /* ——— ⌘K ——— */
  let cmdkOpener = null, cmdkRestoring = false;
  function openCmdk() {
    cmdkOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    $("#cmdk").classList.add("open");
    const input = $("#cmdkInput");
    input.value = "";
    paintCmdk("");
    setTimeout(() => input.focus(), 10);
  }
  function closeCmdk() {
    const opener = cmdkOpener; cmdkOpener = null;
    $("#cmdk").classList.remove("open");
    $("#cmdkInput")?.removeAttribute("aria-activedescendant");
    // return focus to whatever opened the dialog (unless it was programmatic-only)
    if (opener && document.contains(opener)) {
      cmdkRestoring = opener.id === "globalSearch"; // globalSearch focus handler re-opens; suppress it here
      opener.focus({ preventScroll: true });
      cmdkRestoring = false;
    }
  }
  function paintCmdk(q) {
    q = (q || "").toLowerCase().trim();
    const pages = [
      { label: "Overview", hint: "Desk", hash: "#overview" },
      { label: "Markets", hint: "Tokens", hash: "#markets" },
      { label: "Portfolio", hint: "Wallets", hash: "#portfolio" },
      { label: "DEX / Liquidity", hint: "Pools", hash: "#dex" },
      { label: "Midnight", hint: "NIGHT · DUST", hash: "#midnight" },
      { label: "Watchlist", hint: "Saved", hash: "#watchlist" },
    ].map((p) => ({ ...p, hay: p.label.toLowerCase() }));
    const tokens = ND.TOKENS.map((t) => ({
      label: `${t.ticker} · ${t.name}`, hint: fmt.prx(t.price, 4), hash: `#token/${t.ticker}`,
      hay: `${t.ticker} ${t.name} ${t.policy} ${t.unit}`.toLowerCase(),
    }));
    let items = [...pages, ...tokens];
    if (q) items = items.filter((i) => i.hay.includes(q));
    items = items.slice(0, 20);
    const list = $("#cmdkList");
    list.innerHTML = items.length ? items.map((i, idx) => `
      <div class="cmdk-item ${idx === 0 ? "active" : ""}" role="option" id="cmdk-item-${idx}" aria-selected="${idx === 0 ? "true" : "false"}" data-hash="${i.hash}">
        <span>${i.label}</span><span class="hint">${i.hint || ""}</span></div>`).join("")
      : `<div class="cmdk-empty">No matches</div>`;
    list.querySelectorAll(".cmdk-item").forEach((el) =>
      el.addEventListener("click", () => { closeCmdk(); navigate(el.dataset.hash); }));
    // a11y: point the combobox input at the active option so screen readers
    // announce it during arrow-key navigation (aria-selected alone doesn't).
    const input = $("#cmdkInput");
    if (input) { items.length ? input.setAttribute("aria-activedescendant", "cmdk-item-0") : input.removeAttribute("aria-activedescendant"); }
  }

  /* ——— Events ——— */
  function bind() {
    window.addEventListener("hashchange", () => { closeCmdk(); closeSidebar(); render(); });
    $("#menuBtn")?.addEventListener("click", () => {
      const sb = $("#sidebar");
      const open = !sb.classList.contains("open");
      sb.classList.toggle("open", open);
      $("#sidebarOverlay").classList.toggle("show", open);
      $("#menuBtn").setAttribute("aria-expanded", open ? "true" : "false");
    });
    $("#sidebarOverlay")?.addEventListener("click", closeSidebar);
    $("#connectBtn")?.addEventListener("click", () => navigate("#portfolio"));

    // segmented controls (overview / token / midnight)
    document.addEventListener("click", (e) => {
      const seg = e.target.closest(".seg-btn");
      if (!seg) return;
      const group = seg.closest(".seg");
      if (!group || !group.id) return;
      $$(".seg-btn", group).forEach((b) => b.classList.remove("active"));
      seg.classList.add("active");
      if (group.id === "ovAdaRange") { chartRanges.ADA = seg.dataset.range; drawOverviewChart("ADA", chartRanges.ADA); }
      if (group.id === "ovNightRange") { chartRanges.NIGHT = seg.dataset.range; drawOverviewChart("NIGHT", chartRanges.NIGHT); }
      if (group.id === "nightRange") { chartRanges.NIGHT = seg.dataset.range; drawNightChart(chartRanges.NIGHT); }
      if (group.id === "tokenRange") { chartRanges.TOKEN = seg.dataset.range; if (currentToken) paintTokenChart(currentToken); }
      if (group.id === "chartType") { chartType = seg.dataset.ctype; if (currentToken) paintTokenChart(currentToken); }
      syncToggleAria();
    });

    // market tabs (category quick filters)
    $("#marketTabs")?.addEventListener("click", (e) => {
      const tab = e.target.closest("[data-mtab]");
      if (!tab) return;
      $$("#marketTabs .tab").forEach((t) => t.classList.toggle("active", t === tab));
      syncToggleAria();
      renderMarketTokens();
    });

    ["marketSearch", "marketCat", "watchOnly"].forEach((id) => {
      const el = $("#" + id);
      if (!el) return;
      el.addEventListener("input", renderMarketTokens);
      el.addEventListener("change", renderMarketTokens);
    });

    // Sortable headers are keyboard-operable (Enter/Space) as well as clickable,
    // and expose their state via aria-sort — a <th> is not natively focusable
    // or activatable, so without this sorting was mouse-only.
    const syncSortAria = (tableSel, key, dir) => $$(tableSel + " th").forEach((x) => {
      const on = x.dataset.sort === key;
      x.classList.toggle("sorted", on);
      if (on) x.setAttribute("aria-sort", dir === 1 ? "ascending" : "descending");
      else x.removeAttribute("aria-sort");
    });
    const applyMarketSort = (key) => {
      if (marketSort.key === key) marketSort.dir *= -1;
      else { marketSort.key = key; marketSort.dir = key === "ticker" ? 1 : -1; }
      syncSortAria("#marketsTable", key, marketSort.dir);
      renderMarketTokens();
    };
    const applyStakeSort = (key) => {
      if (_stakeSortKey === key) _stakeSortDir *= -1;
      else { _stakeSortKey = key; _stakeSortDir = key === "pool" ? 1 : -1; }
      paintStaking();
    };
    const sortKeydown = (apply) => (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const th = e.target.closest("[data-sort]");
      if (!th) return;
      e.preventDefault();
      apply(th.dataset.sort);
    };
    $("#marketsTable")?.querySelector("thead")?.addEventListener("click", (e) => {
      const th = e.target.closest("[data-sort]");
      if (!th) return;
      applyMarketSort(th.dataset.sort);
    });
    $("#marketsTable")?.querySelector("thead")?.addEventListener("keydown", sortKeydown(applyMarketSort));

    // governance search
    $("#govSearch")?.addEventListener("input", (e) => { _govQ = e.target.value; paintGovernance(); });
    $("#stakeSearch")?.addEventListener("input", (e) => { _stakeQ = e.target.value; paintStaking(); });
    $("#stakePoolsTable")?.querySelector("thead")?.addEventListener("click", (e) => {
      const th = e.target.closest("[data-sort]");
      if (!th) return;
      applyStakeSort(th.dataset.sort);
    });
    $("#stakePoolsTable")?.querySelector("thead")?.addEventListener("keydown", sortKeydown(applyStakeSort));

    // portfolio tabs
    $("#pfTabs")?.addEventListener("click", (e) => {
      const tab = e.target.closest("[data-tab]");
      if (!tab) return;
      $$("#pfTabs .tab").forEach((t) => t.classList.toggle("active", t === tab));
      $$(".tab-panel", $("#portfolio")).forEach((p) =>
        p.classList.toggle("active", p.id === "pf-" + tab.dataset.tab));
      syncToggleAria();
    });

    // midnight calc
    $("#nightHoldings")?.addEventListener("input", updateDustCalc);
    $("#genFactor")?.addEventListener("input", updateDustCalc);

    // redemption thaw calculator (local inputs, saved in this browser)
    const saveRedeem = () => {
      try {
        localStorage.setItem("nd.redeem.alloc", $("#redeemAlloc")?.value || "");
        localStorage.setItem("nd.redeem.first", $("#redeemFirst")?.value || "");
      } catch (_) {}
      paintRedeemTable();
    };
    $("#redeemAlloc")?.addEventListener("input", saveRedeem);
    $("#redeemFirst")?.addEventListener("change", saveRedeem);

    // ⌘K
    $("#globalSearch")?.addEventListener("click", openCmdk);
    $("#globalSearch")?.addEventListener("focus", (ev) => { if (cmdkRestoring) { ev.target.blur(); return; } ev.target.blur(); openCmdk(); });
    $("#cmdk")?.addEventListener("click", (e) => { if (e.target.id === "cmdk") closeCmdk(); });
    $("#cmdkInput")?.addEventListener("input", (e) => paintCmdk(e.target.value));
    $("#cmdkInput")?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeCmdk();
      if (e.key === "Tab") {
        // focus trap: aria-modal=true claims the background is inert, so Tab
        // must cycle within the dialog instead of leaking to page content
        const els = [...$("#cmdk").querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
          .filter((el) => !el.disabled && el.getClientRects().length);
        if (!els.length) { e.preventDefault(); return; }
        const first = els[0], last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        return;
      }
      if (e.key === "Enter") {
        const active = $(".cmdk-item.active");
        if (active) { closeCmdk(); navigate(active.dataset.hash); }
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = $$(".cmdk-item");
        const i = items.findIndex((x) => x.classList.contains("active"));
        items.forEach((x) => x.classList.remove("active"));
        const next = e.key === "ArrowDown" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
        items[next]?.classList.add("active");
        items.forEach((x) => x.setAttribute("aria-selected", x.classList.contains("active") ? "true" : "false"));
        items[next]?.scrollIntoView({ block: "nearest" });
        const nextItem = items[next];
        if (nextItem) e.target.setAttribute("aria-activedescendant", nextItem.id);
        else e.target.removeAttribute("aria-activedescendant");
      }
    });
    window.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        $("#cmdk").classList.contains("open") ? closeCmdk() : openCmdk();
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (document.activeElement?.tagName || "").toLowerCase();
        const typing = tag === "input" || tag === "textarea" || tag === "select" ||
          document.activeElement?.isContentEditable;
        if (!typing && !$("#cmdk").classList.contains("open")) {
          e.preventDefault();
          openCmdk();
        }
      }
      if (e.key === "Escape") {
        closeCmdk();
        if ($("#sidebar")?.classList.contains("open")) {
          closeSidebar();
          $("#menuBtn")?.focus();
        }
      }
    });

    window.addEventListener("resize", () => {
      const { route, param } = parseHash();
      if (route === "token" && currentToken) paintTokenChart(currentToken);
    });

    setInterval(paintFresh, 15000);
  }

  function closeSidebar() {
    $("#sidebar")?.classList.remove("open");
    $("#sidebarOverlay")?.classList.remove("show");
    $("#menuBtn")?.setAttribute("aria-expanded", "false");
  }

  $("#copyDonate")?.addEventListener("click", async () => {
    const addr = $("#donateAddr")?.textContent?.trim();
    if (!addr) return;
    try { await navigator.clipboard.writeText(addr); toast("ADA donation address copied"); }
    catch (_) { toast("Copy failed — select the address"); }
  });
  $("#donateAddr")?.addEventListener("click", () => $("#copyDonate")?.click());
  $("#copyDonateBtc")?.addEventListener("click", async () => {
    const addr = $("#donateAddrBtc")?.textContent?.trim();
    if (!addr) return;
    try { await navigator.clipboard.writeText(addr); toast("BTC donation address copied"); }
    catch (_) { toast("Copy failed — select the address"); }
  });
  $("#donateAddrBtc")?.addEventListener("click", () => $("#copyDonateBtc")?.click());

  /* ——— Boot ——— */
  async function boot() {
    bind();
    if (!location.hash) location.hash = "#overview";
    render(); // skeletons
    paintFresh();
    await ND.ensureMarkets();
    paintFresh();
    render(); // live
    setInterval(async () => {
      await ND.ensureMarkets(true);
      dexAggCache = null;
      paintFresh();
      if (["overview", "markets", "watchlist", "midnight"].includes(currentRoute)) render();
    }, 5 * 60 * 1000);
  }
  boot();
})();
