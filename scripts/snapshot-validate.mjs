/* Guards the public, same-origin Cardano snapshots before publication.
 * These are integrity/shape checks, not proof that an upstream API is correct.
 * They prevent an error page, empty result, malformed timestamp or NaN
 * from silently replacing the previous known-good market dataset.
 */
const finiteNonNegative = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
const ageOk = (at, now) => Number.isSafeInteger(at)
  && at <= now + 5 * 60_000 && at >= now - 60 * 60_000;

export function validateSnapshot(name, snapshot, now = Date.now()) {
  if (!["pools", "governance"].includes(name)) {
    throw new Error("Only refreshable Koios snapshot types may be published");
  }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
      || !ageOk(snapshot.fetchedAt, now)) {
    throw new Error(name + " snapshot has an invalid or non-current fetch timestamp");
  }
  if (name === "pools") {
    if (!Array.isArray(snapshot.rows) || snapshot.rows.length < 25 || snapshot.rows.length > 150) {
      throw new Error("Pool snapshot is empty, truncated or oversized");
    }
    const seen = new Set();
    for (const row of snapshot.rows) {
      if (!row || typeof row.poolId !== "string" || !/^pool1[a-z0-9]{20,}$/.test(row.poolId)
          || seen.has(row.poolId) || !finiteNonNegative(row.activeStake)
          || (row.saturation !== null && !finiteNonNegative(row.saturation))
          || (row.margin !== null && !finiteNonNegative(row.margin))
          || (row.ticker !== null && typeof row.ticker !== "string")) {
        throw new Error("Pool snapshot contains missing/duplicate identities or invalid numbers");
      }
      seen.add(row.poolId);
    }
  } else {
    if (!Array.isArray(snapshot.proposals) || snapshot.proposals.length < 1
        || snapshot.proposals.length > 100
        || !Array.isArray(snapshot.dreps) || snapshot.dreps.length > 100
        || !Number.isSafeInteger(snapshot.drepCount) || snapshot.drepCount < snapshot.dreps.length) {
      throw new Error("Governance snapshot contains invalid proposal or DRep lists");
    }
    const seen = new Set();
    for (const proposal of snapshot.proposals) {
      if (!proposal || typeof proposal.id !== "string" || proposal.id.length < 20
          || seen.has(proposal.id) || !Number.isInteger(proposal.proposedEpoch)
          || !["Active", "Enacted", "Ratified", "Dropped", "Expired"].includes(proposal.status)
          || (proposal.tally !== null && (!proposal.tally
              || !["yes","no","abstain","total"].every(k => Number.isSafeInteger(proposal.tally[k]) && proposal.tally[k] >= 0)))) {
        throw new Error("Governance snapshot contains invalid or duplicate proposals");
      }
      seen.add(proposal.id);
    }
    for (const drep of snapshot.dreps) {
      if (!drep || typeof drep.id !== "string" || drep.id.length < 15
          || !finiteNonNegative(drep.power)) {
        throw new Error("Governance snapshot contains an invalid DRep entry");
      }
    }
  }
  return snapshot;
}

export function snapshotFreshness(snapshot, now = Date.now()) {
  if (!snapshot || !Number.isSafeInteger(snapshot.fetchedAt)) return "invalid";
  return now - snapshot.fetchedAt < 36 * 60 * 60_000 ? "fresh" : "stale";
}
