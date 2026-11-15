/* NightDream data snapshots — runs server-side (no browser, no CORS).
 *
 * Koios and NightForge do not send `Access-Control-Allow-Origin` on their GET
 * responses, so browsers block cross-origin fetch() from nightdream.xyz. These
 * snapshots are fetched server-side on a schedule (see docs/SNAPSHOTS.md) and committed to
 * data/snapshots/, which the site loads same-origin. The page code keeps its
 * live-fetch path as a fallback, but snapshots are the primary source.
 *
 * Usage: node scripts/koios-snapshot.mjs
 * Writes (only on success; a failed section keeps the previous file):
 *   data/snapshots/pools.json       { rows, fetchedAt }      — top-150 pools
 *   data/snapshots/governance.json  { proposals, dreps, drepCount, fetchedAt }
 *   data/snapshots/midnight.json    { overview, health, fetchedAt }
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KOIOS = "https://api.koios.rest/api/v1";
const NF = "https://mainnet.nightforge.jp/api";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "snapshots");
const SLEEP_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, timeoutMs = 45000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (attempt === 1) throw e;
      await sleep(2000);
    }
  }
}

async function postJSON(url, body, timeoutMs = 45000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (attempt === 1) throw e;
      await sleep(2000);
    }
  }
}

function write(name, obj) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), JSON.stringify(obj));
  console.log(`wrote ${name} (${(JSON.stringify(obj).length / 1024).toFixed(0)} KB)`);
}

async function snapshotPools() {
  const list = await getJSON(
    `${KOIOS}/pool_list?select=pool_id_bech32,ticker,margin,active_stake,pool_status,retiring_epoch,pledge,fixed_cost`
  );
  if (!Array.isArray(list)) throw new Error("pool_list not an array");
  const reg = list
    .filter((p) => p && p.pool_status === "registered" && !p.retiring_epoch)
    .sort((a, b) => Number(b.active_stake || 0) - Number(a.active_stake || 0))
    .slice(0, 150);
  if (!reg.length) throw new Error("no registered pools");
  const byId = {};
  for (let i = 0; i < reg.length; i += 60) {
    const info = await postJSON(KOIOS + "/pool_info", {
      _pool_bech32_ids: reg.slice(i, i + 60).map((p) => p.pool_id_bech32),
    });
    (Array.isArray(info) ? info : []).forEach((p) => { if (p) byId[p.pool_id_bech32] = p; });
    await sleep(SLEEP_MS);
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
  write("pools.json", { rows, fetchedAt: Date.now() });
}

async function snapshotGovernance() {
  const list = await getJSON(
    `${KOIOS}/proposal_list?select=proposal_id,proposal_type,proposed_epoch,ratified_epoch,enacted_epoch,expired_epoch,dropped_epoch,expiration,deposit,proposal_tx_hash&limit=100`
  );
  if (!Array.isArray(list)) throw new Error("proposal_list not an array");
  const statusOf = (p) => p.enacted_epoch != null ? "Enacted"
    : p.ratified_epoch != null ? "Ratified"
    : p.dropped_epoch != null ? "Dropped"
    : p.expired_epoch != null ? "Expired" : "Active";
  const proposals = list.map((p) => ({
    id: p.proposal_id, type: p.proposal_type, status: statusOf(p),
    proposedEpoch: p.proposed_epoch, expiration: p.expiration,
    deposit: p.deposit != null ? Number(p.deposit) : null, tally: null,
  })).sort((a, b) => b.proposedEpoch - a.proposedEpoch);
  const withTally = proposals.filter((p) => p.status === "Active")
    .concat(proposals.filter((p) => p.status !== "Active")).slice(0, 10);
  for (const p of withTally) {
    try {
      const v = await getJSON(`${KOIOS}/proposal_votes?_proposal_id=${encodeURIComponent(p.id)}`, 30000);
      if (Array.isArray(v)) {
        const tally = { yes: 0, no: 0, abstain: 0, total: v.length };
        for (const x of v) {
          const vote = String(x.vote || "").toLowerCase();
          if (vote === "yes") tally.yes++;
          else if (vote === "no") tally.no++;
          else tally.abstain++;
        }
        p.tally = tally;
      }
    } catch { /* tally stays null — page renders "no votes yet" */ }
    await sleep(SLEEP_MS);
  }
  const dreps = await getJSON(`${KOIOS}/drep_list`);
  let board = [];
  if (Array.isArray(dreps) && dreps.length) {
    const ids = dreps.map((d) => d.drep_id);
    const infos = [];
    for (let i = 0; i < ids.length; i += 50) {
      const r = await postJSON(KOIOS + "/drep_info", { _drep_ids: ids.slice(i, i + 50) });
      if (Array.isArray(r)) infos.push(...r);
      await sleep(SLEEP_MS);
    }
    board = infos
      .map((d) => ({ id: d.drep_id, power: d.amount != null ? Number(d.amount) : 0, active: d.active }))
      .filter((d) => d.power > 0)
      .sort((a, b) => b.power - a.power)
      .slice(0, 100);
  }
  write("governance.json", {
    proposals,
    dreps: board,
    drepCount: Array.isArray(dreps) ? dreps.length : 0,
    fetchedAt: Date.now(),
  });
}

async function snapshotMidnight() {
  /* NightForge answered every request with HTTP 410 Gone from Oct 2026, and
     Midnight's own mainnet indexer was retired on Oct 9, 2026 (Blockfrost now
     hosts it and needs a project token). Try NightForge once in case it
     returns; otherwise keep the last midnight.json untouched. The site labels
     it with its real date and never calls it "live". */
  let overview;
  try {
    overview = await getJSON(`${NF}/analytics/overview`, 20000);
  } catch (e) {
    throw new Error(`midnight skipped: NightForge unavailable (${e.message}); kept previous snapshot`);
  }
  let health = null;
  try { health = await getJSON(`${NF}/health`, 20000); } catch { /* optional */ }
  if (!overview || typeof overview !== "object") throw new Error("nightforge overview empty");
  write("midnight.json", { overview, health, fetchedAt: Date.now() });
}

const results = await Promise.allSettled([
  snapshotPools().then(() => "pools"),
  snapshotGovernance().then(() => "governance"),
  snapshotMidnight().then(() => "midnight"),
]);
const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
const failed = results.filter((r) => r.status === "rejected");
for (const f of failed) console.error("FAILED:", f.reason?.message || f.reason);
console.log(`done: ${ok.join(", ") || "none"} ok, ${failed.length} failed`);
if (!existsSync(join(OUT, "pools.json")) && !existsSync(join(OUT, "governance.json")) && !existsSync(join(OUT, "midnight.json"))) {
  console.error("no snapshots exist at all — failing");
  process.exit(1);
}
process.exit(0);
