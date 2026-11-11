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

## Scheduled refresh (not set up yet)

No workflow exists in this repo, which is why the snapshots went a month without a refresh in
Oct–Nov 2026. To schedule it, save this as `.github/workflows/snapshots.yml` (pushing workflow files
needs a token with the `workflow` scope, or add it in the GitHub web editor):

```yaml
name: snapshots
on:
  schedule: [{ cron: "17 */6 * * *" }]
  workflow_dispatch:
permissions:
  contents: write
concurrency: { group: snapshots, cancel-in-progress: false }
jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: node scripts/koios-snapshot.mjs
      - run: npm test
      - name: Commit snapshots
        run: |
          git add data/snapshots
          git diff --cached --quiet && exit 0
          git -c user.name=nightdream-snapshots -c user.email=actions@users.noreply.github.com \
            commit -m "data: refresh Koios snapshots"
          git push
```

## Live Midnight stats

Midnight retired `indexer.mainnet.midnight.network` on Oct 9, 2026. The public mainnet indexer is now
Blockfrost (`https://midnight-mainnet.blockfrost.io/api/v0`) and needs a project token. If one is
added, read it from a repository secret inside the scheduled job above and write `midnight.json`
there. Never put the token in `js/`.
