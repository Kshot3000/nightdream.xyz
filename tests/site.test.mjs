// NightDream checks: run with `npm test` (Node 20+, no dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

function loadND() {
  const ctx = { URL };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read("js/data.js"), ctx);
  return ctx.ND;
}

test("every JS file parses", () => {
  const files = readdirSync(join(ROOT, "js")).filter((f) => f.endsWith(".js")).map((f) => join(ROOT, "js", f));
  files.push(join(ROOT, "scripts/koios-snapshot.mjs"));
  for (const f of files) execFileSync(process.execPath, ["--check", f]);
});

test("esc() neutralises HTML in feed and on-chain strings", () => {
  const ND = loadND();
  const evil = `<img src=x onerror="alert(1)">'\``;
  const out = ND.esc(evil);
  assert.ok(!/[<>"'`]/.test(out), out);
  assert.equal(ND.esc(null), "");
  assert.equal(ND.esc(42), "42");
});

test("safeUrl() only allows http(s)", () => {
  const ND = loadND();
  assert.equal(ND.safeUrl("javascript:alert(1)"), "");
  assert.equal(ND.safeUrl(" JaVaScRiPt:alert(1)"), "");
  assert.equal(ND.safeUrl("data:text/html,<script>"), "");
  assert.equal(ND.safeUrl("https://minswap.org/x"), "https://minswap.org/x");
  assert.equal(ND.safeUrl(undefined), "https://nightdream.xyz/");
});

test("safeImg() allows https and raster/svg data URIs only", () => {
  const ND = loadND();
  assert.equal(ND.safeImg("javascript:1"), "");
  assert.equal(ND.safeImg("http://insecure.example/a.png"), "");
  assert.equal(ND.safeImg("data:text/html;base64,AAAA"), "");
  assert.ok(ND.safeImg("data:image/png;base64,AAAA"));
  assert.ok(ND.safeImg("https://assets.coingecko.com/a.png"));
});

test("NIGHT redemption phases follow the published schedule", () => {
  const ND = loadND();
  // still thawing at the very end of Dec 4, 2026 UTC
  assert.equal(ND.redeemPhase(Date.UTC(2026, 11, 4, 23, 59)), "thaw");
  // Dec 4 evening in US Central (UTC-6) is still Dec 4 → still thawing
  assert.equal(ND.redeemPhase(Date.UTC(2026, 11, 4, 12)), "thaw");
  assert.equal(ND.redeemPhase(Date.UTC(2026, 11, 5, 0, 1)), "grace");
  assert.equal(ND.redeemPhase(Date.UTC(2027, 2, 4, 23)), "grace");
  assert.equal(ND.redeemPhase(Date.UTC(2027, 2, 5, 1)), "ended");
  // grace period is 90 days after thawing ends
  assert.equal((ND.REDEEM.graceEnd - ND.REDEEM.thawEnd) / 86400000, 90);
  assert.equal(ND.REDEEM.windows[3][1], "Sep 6 – Dec 4, 2026");
});

test("thaw schedule: 4 × 25%, 90 days apart, last thaw by Dec 4, 2026", () => {
  const ND = loadND();
  const rows = ND.thawSchedule(1000, "2025-12-10");
  assert.equal(rows.length, 4);
  rows.forEach((r) => assert.equal(r.amount, 250));
  assert.equal((rows[1].at - rows[0].at) / 86400000, 90);
  // Day-90 schedule (latest first day, Mar 9, 2026) → day 360 = Dec 4, 2026
  const late = ND.thawSchedule(4, "2026-03-09");
  assert.equal(new Date(late[3].at).toISOString().slice(0, 10), "2026-12-04");
  assert.equal(ND.thawSchedule(0, "2026-01-01"), null);
  assert.equal(ND.thawSchedule(10, "not-a-date"), null);
});

test("local assets referenced by index.html exist", () => {
  const html = read("index.html");
  const refs = [...html.matchAll(/(?:src|href)="(\.?\/?(?:assets|css|js|data)\/[^"?#]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 5);
  const OPTIONAL = new Set(["./js/config.local.js"]); // gitignored runtime config
  for (const r of refs) if (!OPTIONAL.has(r)) assert.ok(existsSync(join(ROOT, r.replace(/^\.?\//, ""))), `missing ${r}`);
  for (const f of ["CNAME", "ads.txt", ".nojekyll", "LICENSE"]) assert.ok(existsSync(join(ROOT, f)), f);
});

test("no links to retired endpoints or pages", () => {
  const all = ["index.html", "README.md", ...readdirSync(join(ROOT, "js")).map((f) => "js/" + f)].map(read).join("\n");
  assert.ok(!all.includes("nightforge.jp/api/docs"), "NightForge docs page is gone (410)");
  assert.ok(!all.includes("indexer.mainnet.midnight.network"), "Midnight-hosted mainnet indexer retired Oct 9, 2026");
  assert.ok(!all.includes("midnight.gd/how-to-get-night"), "use midnight.gd/redeem");
});

test("snapshot UI never calls stale Midnight data live", () => {
  const app = read("js/app.js");
  assert.ok(!/NightForge · live/.test(app));
  assert.ok(!/\$\{label\} · live/.test(app));
});

test("snapshots parse and carry fetchedAt", () => {
  for (const f of ["pools", "governance", "midnight"]) {
    const j = JSON.parse(read(`data/snapshots/${f}.json`));
    assert.equal(typeof j.fetchedAt, "number", f);
  }
});

test("feed/on-chain strings are escaped before innerHTML (lint)", () => {
  const app = read("js/app.js");
  // Raw ${obj.field} for fields that come from feeds, wallets or chain metadata.
  const risky = /\$\{(?:t|p|n|x|d|w|r|best|worst)\.(?:name|ticker|pair|dex|label|addr|url|image|icon|type|status|error)\}/g;
  const hits = [...app.matchAll(risky)].map((m) => m[0]);
  // the command-palette label is built raw and escaped when rendered (${esc(i.label)})
  const allowed = new Set(["${t.ticker}", "${t.name}"]);
  const bad = hits.filter((h) => !allowed.has(h));
  assert.deepEqual(bad, []);
  assert.ok(!/onerror="/.test(app), "no inline onerror handlers with interpolated data");
  assert.ok(app.includes("${esc(i.label)}"));
});

test("wallet install links are https", () => {
  const w = read("js/wallet.js");
  const block = w.slice(w.indexOf("const INSTALL"), w.indexOf("};", w.indexOf("const INSTALL")));
  for (const m of block.matchAll(/"(https?:[^"]+)"/g)) assert.ok(m[1].startsWith("https://"), m[1]);
});

// ---- CoinGecko key handling (js/live.js) ----
function loadLive(config, respond) {
  const calls = [];
  const ctx = {
    URL, AbortController, setTimeout, clearTimeout, console,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url) => {
      calls.push(String(url));
      const res = respond(String(url), calls.length);
      return { ok: res.status === 200, status: res.status, json: async () => res.body };
    },
  };
  ctx.window = ctx;
  if (config) ctx.ND_CONFIG = config;
  vm.createContext(ctx);
  vm.runInContext(read("js/live.js"), ctx);
  return { LIVE: ctx.LIVE, calls };
}
const cgOk = { status: 200, body: { cardano: { usd: 0.5, usd_24h_change: 1 } } };
const minswapDown = { status: 503, body: null };

test("no CoinGecko key is committed in js/", () => {
  for (const f of readdirSync(join(ROOT, "js")).filter((f) => f.endsWith(".js") && f !== "config.local.js")) {
    assert.ok(!/CG-[A-Za-z0-9]{12,}/.test(read("js/" + f)), `key-like string in js/${f}`);
  }
  assert.ok(!existsSync(join(ROOT, "js/config.local.js")) || read(".gitignore").includes("js/config.local.js"));
});

test("CoinGecko requests are keyless by default", async () => {
  const { LIVE, calls } = loadLive(null, (u) => (u.includes("coingecko") ? cgOk : minswapDown));
  assert.equal((await LIVE.adaPrice()).price, 0.5);
  const cg = calls.filter((u) => u.includes("coingecko"));
  assert.equal(cg.length, 1);
  assert.ok(!cg[0].includes("x_cg_demo_api_key"));
});

test("an optional runtime key is appended, and a refused key retries keyless", async () => {
  const key = "CG-abcdefghijklmnop";
  const ok = loadLive({ coingeckoDemoKey: key }, (u) => (u.includes("coingecko") ? cgOk : minswapDown));
  await ok.LIVE.adaPrice();
  assert.ok(ok.calls.some((u) => u.includes("x_cg_demo_api_key=" + key)));

  const bad = loadLive({ coingeckoDemoKey: key }, (u) =>
    !u.includes("coingecko") ? minswapDown : u.includes("x_cg_demo_api_key") ? { status: 401, body: null } : cgOk,
  );
  assert.equal((await bad.LIVE.adaPrice()).price, 0.5);
  const cg = bad.calls.filter((u) => u.includes("coingecko"));
  assert.equal(cg.length, 2);
  assert.ok(!cg[1].includes("x_cg_demo_api_key"));
});

test("a malformed runtime key is ignored", async () => {
  const { LIVE, calls } = loadLive({ coingeckoDemoKey: "x\"&evil=1" }, (u) => (u.includes("coingecko") ? cgOk : minswapDown));
  await LIVE.adaPrice();
  assert.ok(!calls.some((u) => u.includes("evil")));
});

test("numText() renders only finite numbers", () => {
  const ND = loadND();
  assert.equal(ND.numText(6), "6");
  assert.equal(ND.numText("18"), "18");
  assert.equal(ND.numText(0), "0");
  assert.equal(ND.numText(null), "\u2014");
  assert.equal(ND.numText(undefined), "\u2014");
  assert.equal(ND.numText("<img src=x onerror=alert(1)>"), "\u2014");
  assert.equal(ND.numText({ toString: () => "<b>" }), "\u2014");
  assert.equal(ND.numText(NaN), "\u2014");
  assert.equal(ND.numText(Infinity), "\u2014");
  assert.equal(ND.numText("", "n/a"), "n/a");
});

test("decimals and DexScreener txn counts never reach innerHTML raw (lint)", () => {
  const app = read("js/app.js");
  assert.ok(!/\$\{\s*meta\.decimals\b/.test(app) && !/\?\s*meta\.decimals\s*:/.test(app), "raw meta.decimals");
  assert.ok(!/(\$\{|\?|:)\s*p\.(buys|sells)24\b(?!\))/.test(app.replace(/numText\(p\.(buys|sells)24\)/g, "")), "raw buys24/sells24");
});
