# Data snapshots

Koios sends no CORS headers, so the browser can't call it from nightdream.xyz. `scripts/koios-snapshot.mjs`
fetches the bulk datasets server-side and writes them to `data/snapshots/`:

| File | Contents | Status |
|---|---|---|
| `pools.json` | top-150 registered stake pools | refreshed by the script |
| `governance.json` | governance actions, vote tallies, DRep leaderboard | refreshed by the script |
| `midnight.json` | Midnight network overview | **frozen** — the NightForge API answers 410 Gone |

The site uses a snapshot as-is while it is under 36 hours old. After that it tries live Koios, then
falls back to the old snapshot and labels it stale with its real age.

## Scheduled refresh and integrity guards

The repository contains two workflows:

- `.github/workflows/refresh-snapshots.yml`: every six hours (minute 17 UTC)
  and manual workflow dispatch, calls `scripts/koios-snapshot.mjs`, runs all
  tests, and commits **only** successful pool/governance JSON updates to
  `main`. The job needs `contents: write`; branch protection or repository
  policy can still block automatic pushes. GitHub cron scheduling is best-effort
  and may delay jobs — confirm real runs in the Actions tab.
- `.github/workflows/site-tests.yml`: read-only Node tests for source changes
  and pull requests, including snapshot validation.

The writer checks each Koios result's shape, current timestamp, unique pool
and proposal IDs, reasonable bounds and numeric values before replacing a
known-good snapshot. Writes use a same-directory temporary file and atomic
rename. A failed feed leaves its previous file unchanged; if *both* Koios
feeds fail, the command returns a failing exit status to alert the team.

The UI distinguishes snapshots over 36 hours old from fresh ones. These are
time labels, **not** proof of real-time chain finality or upstream accuracy.
No stale snapshot is silently relabeled as fresh.

To run a one-off refresh from an authorized development machine:

```bash
node scripts/koios-snapshot.mjs
npm test
```

If no files update, check Koios availability, quota, and the Actions logs.
Do not regenerate timestamp fields artificially.

## Live Midnight stats

The NightForge endpoint is retired and is no longer requested by the job. The retained
`midnight.json` is historical and shows its original October 2026 date.
A new live Midnight source must be approved and validated separately. Blockfrost
Midnight access requires a project token; it belongs in a protected repository
secret and server-side job, **never** in browser JavaScript or a public JSON file.
A new source must publish only real observed metrics and preserve the last
known-good timestamp on failure.
