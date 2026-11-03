# patchqueue

Shows what's actionable right now in your team's Phabricator queue, and how long each
item has been waiting. Runs as a [Quick](https://quick.mozilla.cloud) site, or from the terminal.

The dashboard has three views; switch between them with the buttons at the top. Your last
choice is remembered, and `?view=board|people|list` in the URL picks one directly.

- **Board**: kanban columns of compact cards.
- **People**: one group per person whose move it is, longest wait first. Team members come first.
- **List**: one table of every patch, sorted by how long it has waited.

Every patch has one stage, based on whose move it is:

- **Needs review**: waiting on reviewers. This covers reviews the team owes, plus team
  patches waiting on outside reviewers. Team reviewers are shown in bold.
- **Author must respond**: a team patch has changes requested or planned, or a reviewer
  commented and the author hasn't replied.
- **Ready to land**: a team patch is accepted but not landed.
- **Drafts**: every revision Phabricator considers a draft (status Draft, or the `isDraft`
  flag set alongside another status), whether a team member wrote it or the team is a
  reviewer on it. Drafts never go stale, and don't count as reviews owed.
  Drafts are hidden until you click "Show drafts" (applies to every view); the terminal
  report hides them unless you pass `--wip`.

Wait times are styled in four steps so old patches stand out: light gray under a day, bold
for 1–3 days, an outlined pill from 3 days up to `staleDays`, and a solid black pill past
`staleDays`. Activity from bots such as phab-bot is ignored throughout.

Each patch says who needs to act next and what they need to do: "boek to review", "jdoe to
reply", "boek to land", "jdoe to add reviewers", and so on. It also shows how long the patch
has waited (time since it entered its current state). Hover over a patch to see the last
human action.

Authors and reviewers appear with their Phabricator profile pictures. Image URLs come from
`user.query`, are looked up once per person, and are cached with the board. Anyone without a
picture (including reviewer groups), or whose image fails to load, is shown with initials.

## Configure

Put your team's Phabricator usernames in `site/team.json`, which is gitignored:

```sh
cp site/team.example.json site/team.json   # then edit "members"
```

Everything else (reviewer groups that count as the team, ignored reviewers and bots,
`staleDays`) is in `site/team.config.js`. Redeploy after editing either file.

`team.json` is kept out of git, not out of the site: `quick deploy` uploads it, and any
staffer who opens the site can read it.

## How it runs on Quick

Quick serves `site/` as static files behind Mozilla SSO; there is no server. Each viewer's
browser calls Phabricator's Conduit API directly (it allows cross-origin requests) and
the results are cached in the site's shared Quick storage, so everyone sees the same board:

- `quick.db` collection `revisions`: one document per revision on the board, holding the
  revision and its cached transaction history
- `quick.data` key `names`: PHID-to-name and avatar lookups
- `quick.data` key `board`: team PHIDs and when (and by whom) the board was last refreshed
- `quick.data` key `refresh_lock`: set while someone runs a full refresh

Anyone can view the cached board. To refresh, click **Token** and paste a Phabricator API
token (Settings → Conduit API Tokens). It is kept in that browser's `localStorage` only and
never written to the site's storage.

- **Refresh all** re-fetches the whole queue and writes only the revisions that changed,
  plus drops any that left the queue. The shared lock stops several viewers from refreshing
  at once; a lock older than 5 minutes is assumed abandoned.
- **↻** on a card re-fetches just that revision (one request, plus history if it
  changed). A revision that has landed, been abandoned, or no longer needs the team's
  review disappears from the board.
- Opening the page with a token starts a full refresh if the board is more than 20 minutes
  old. There is no cron any more, so the board is only as fresh as the last visit.

Changes from anyone's refresh appear live on every open page.

**Visibility:** every Mozilla staffer can open a Quick site and read its storage. A refresh
caches whatever the refresher's token can see, which can include titles of
security-restricted revisions.

## Deploy

```sh
npm run deploy      # quick deploy site boek-patchqueue
```

Only `site/` is uploaded, including the gitignored `team.json`; the deploy refuses to run
without it. Change the site name in `package.json` if you want a different one.

## Run locally

```sh
npm run report              # terminal output; token read from ~/.arcrc
npm run report -- --json
npm run report -- --wip     # include drafts
npm test
```

The terminal report keeps its own history cache in `.cache/`.

## Request volume and rate limits

Phabricator rate-limits per user, and the cooldown can last a long time. To stay polite:

- Only open revisions are fetched, and transaction history is only fetched for revisions
  that will actually appear in the queue.
- History is cached (Quick storage for the site, `.cache/` for the CLI) and re-fetched
  incrementally, only when a revision changes.
- Requests are spaced at least 200 ms apart, at most 3 in flight, and retry with backoff on 429.
- The dashboard caps a full refresh at 500 requests (`BUDGET` in `site/index.html`).
  Revisions not reached are marked "loading history" and filled in on the next refresh.

## Layout

- `site/index.html`: the dashboard, including refresh and token handling
- `site/team.config.js`: team configuration
- `site/lib/conduit.js`: Conduit client (fetch, throttling, retries, budget)
- `site/lib/collect.js`: finds the team's open revisions and syncs their history into the cache
- `site/lib/analyze.js`: pure categorization logic (unit tested in `test/`)
- `site/lib/store.js`: the shared cache in Quick storage
- `bin/report.js`: terminal report
