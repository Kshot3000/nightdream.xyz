import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { validateSnapshot, snapshotFreshness } from "../scripts/snapshot-validate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function readSnapshot(name) {
  return JSON.parse(readFileSync(join(ROOT, "data/snapshots", name + ".json"), "utf8"));
}
const pools = readSnapshot("pools");
const governance = readSnapshot("governance");
const clone = value => JSON.parse(JSON.stringify(value));
const NOW = Math.max(pools.fetchedAt, governance.fetchedAt) + 60_000;

test("the existing checked-in Koios snapshots meet the expected data schema", () => {
  assert.equal(validateSnapshot("pools", pools, pools.fetchedAt), pools);
  assert.equal(validateSnapshot("governance", governance, governance.fetchedAt), governance);
});

test("refuse an empty, truncated, or corrupt pool refresh", () => {
  assert.throws(() => validateSnapshot("pools", {rows:[],fetchedAt:NOW}, NOW), /empty|truncated/);
  const broken=clone(pools);broken.fetchedAt=NOW;broken.rows[1].poolId=broken.rows[0].poolId;
  assert.throws(() => validateSnapshot("pools", broken, NOW), /duplicate/);
  const malicious=clone(pools);malicious.fetchedAt=NOW;malicious.rows[0].activeStake="99999999999999999999";
  assert.throws(() => validateSnapshot("pools", malicious, NOW), /invalid/);
  const missing=clone(pools);missing.fetchedAt=NOW;delete missing.rows[0].poolId;
  assert.throws(() => validateSnapshot("pools", missing, NOW), /invalid/);
});

test("refuse invalid governance data rather than misrepresent it as live", () => {
  const broken=clone(governance);broken.fetchedAt=NOW;broken.proposals=[];
  assert.throws(() => validateSnapshot("governance", broken, NOW), /invalid/);
  const dup=clone(governance);dup.fetchedAt=NOW;dup.proposals[1].id=dup.proposals[0].id;
  assert.throws(() => validateSnapshot("governance", dup, NOW), /duplicate/);
  const spoofed=clone(governance);spoofed.fetchedAt=NOW;spoofed.proposals[0].status="Approved by AI";
  assert.throws(() => validateSnapshot("governance", spoofed, NOW), /invalid/);
});

test("never publish old or future data as freshly fetched", () => {
  const old=clone(pools);old.fetchedAt=NOW-2*60*60_000;
  assert.throws(() => validateSnapshot("pools",old,NOW), /timestamp/);
  const future=clone(governance);future.fetchedAt=NOW+60*60_000;
  assert.throws(() => validateSnapshot("governance",future,NOW), /timestamp/);
  assert.throws(() => validateSnapshot("midnight",{fetchedAt:NOW},NOW), /Only refreshable/);
});

test("visitors can distinguish fresh snapshots from stale historic data", () => {
  assert.equal(snapshotFreshness({fetchedAt:NOW-1000},NOW),"fresh");
  assert.equal(snapshotFreshness({fetchedAt:NOW-40*60*60_000},NOW),"stale");
  assert.equal(snapshotFreshness(null,NOW),"invalid");
  const midnight=readSnapshot("midnight");
  assert.ok(midnight.fetchedAt<NOW);
});

test("scheduled update never silently passes when both Koios endpoints fail", () => {
  const source=readFileSync(join(ROOT,"scripts/koios-snapshot.mjs"),"utf8");
  assert.ok(source.includes("if (ok.length === 0)"));
  assert.ok(source.includes("process.exitCode = 1"));
  assert.ok(source.includes("validateSnapshot(dataset, obj)"));
  assert.ok(source.includes("renameSync(temporary, destination)"));
  assert.ok(!source.includes("snapshotMidnight().then"));
});

test("GitHub refresh job runs at least four times daily and commits only snapshots", () => {
  const wf=readFileSync(join(ROOT,".github/workflows/refresh-snapshots.yml"),"utf8");
  assert.match(wf,/17 \*\/6 \* \* \*/);
  assert.match(wf,/contents: write/);
  assert.match(wf,/npm test/);
  assert.ok(wf.includes("git add data/snapshots/pools.json data/snapshots/governance.json"));
  assert.ok(!wf.includes("git push --force"));
});
