# Any Given Sunday

League site for the Any Given Sunday dynasty league (Sleeper, est. 2022).
Static HTML on Netlify — no build step beyond a data pull, no framework, no database.

## The three files that matter

| File | What it is | Who edits it |
|---|---|---|
| `index.html` | The whole site — markup, styles, and rendering in one file | Rarely; only for design changes |
| `history.json` | Every number on the page: standings, schedule, season tables, record book, head-to-head | Nobody by hand — it's regenerated |
| `power.json` | Power rankings — roster value, points, record, and the blended score | Nobody by hand — it's regenerated |
| `writeups.json` | The weekly write-ups, newest first | **You**, through the GitHub web editor |

## Posting a write-up

Open `writeups.json` on GitHub, click the pencil, and add an entry at the top of the array:

```json
{
  "season": 2026,
  "week": 3,
  "author": "Commish",
  "date": "2026-09-22",
  "title": "Somebody had to lose that one",
  "body": "First paragraph.\n\nSecond paragraph."
}
```

`week: 0` files under Preseason. Paragraphs are separated by `\n\n`.
Commit to `main` and Netlify redeploys in about a minute.

## Power rankings

`scripts/build-power.mjs` pulls current rosters from Sleeper and dynasty values from
KeepTradeCut's public rankings page (1QB values — this league starts one QB), matches
players by name and position, and scores each team:

- **55%** KeepTradeCut value — the roster's top 15 players plus every rookie pick it owns through the next three drafts (traded picks follow their new owner)
- **28%** points per game
- **17%** win rate

each scaled across the ten teams. Before Week 1 there are no results, so the preseason
board is value only. Change the mix at `WEIGHTS` in the script; change how deep it counts
at `DEPTH`. Kickers and defenses are skipped — KTC doesn't value them. Picks use KTC's generic value for that year and round, or the average of its Early/Mid/Late tiers when no generic entry exists.

The page shows the three components as bars next to each team, so the ranking argues for
itself. If fewer than 70% of rostered players match a KTC entry, the script assumes the
matching broke and refuses to publish rather than shipping a wrong board.

## How the numbers stay current

`scripts/build-history.mjs` reads Sleeper's public API — no API key, no login — walks
back through every past season via `previous_league_id`, and rewrites `history.json`.
It runs in two places:

- **GitHub Actions**, every morning at 8am Eastern (`.github/workflows/refresh.yml`), committing anything that changed
- **Netlify**, on every deploy, so a manual deploy is never stale

Standings and the record book only really move on Tuesdays, but power rankings follow
roster moves, so the job runs daily — a Thursday trade is on the board Friday morning.
To refresh immediately, open the repo's **Actions** tab and run the workflow by hand.

If Sleeper is down or answers oddly, the script logs the failure and leaves the
committed `history.json` in place. A bad week of data can't take the site down.

Run either by hand with `node scripts/build-history.mjs` or `node scripts/build-power.mjs` (Node 20+).

## First-time setup

1. Push this repo to GitHub.
2. Netlify → **Add new site → Import an existing project** → pick the repo.
   `netlify.toml` already sets the build command and publish directory, so Netlify's
   suggested defaults should be correct.
3. Deploy. Set a custom domain under **Domain management** if you want one.
4. In the repo's **Actions** tab, enable workflows so the Tuesday refresh can run.

## Changing the league

League ids live at the top of `scripts/build-history.mjs`. Only the current season's
id is needed — earlier seasons are discovered automatically. `FALLBACK_TEAMS` is a
safety net for team names, and `MY_ROSTER` is the roster id highlighted in green.
