/**
 * Rebuilds power.json by mirroring KeepTradeCut's own league power rankings.
 *
 * KTC runs the rankings for a Sleeper league at
 *   keeptradecut.com/dynasty/power-rankings/league-overview  (leagueId + platform=2)
 * and embeds the finished board in that page as a `var leagueTeams = [...]`
 * literal: every team's score, raw and age-adjusted value, average age, and the
 * full roster broken out by position with per-player and per-pick values.
 *
 * We parse that literal rather than recomputing anything, so the site shows the
 * same numbers the league sees on KTC. Sleeper is used only to map KTC's team
 * ids (Sleeper owner ids) onto roster ids, which is how the rest of the site
 * keys its data.
 *
 * No credentials: both sources are public. If either is unreachable or the page
 * shape changes, the committed power.json is left alone.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "power.json");
const HISTORY = join(ROOT, "history.json");

const LEAGUE = "1329967656165462016";
const SLEEPER = "https://api.sleeper.app/v1";
const KTC_BOARD =
  "https://keeptradecut.com/dynasty/power-rankings/league-overview" +
  `?leagueId=${LEAGUE}&platform=2`; // platform 2 = Sleeper

const json = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url.split("?")[0]} → HTTP ${res.status}`);
  return res.json();
};

/** Pull a `var <name> = [ ... ];` array literal out of a page. */
function extractArray(html, name) {
  const at = html.search(new RegExp(`${name}\\s*=\\s*\\[`));
  if (at === -1) throw new Error(`KTC page shape changed — ${name} not found`);
  const open = html.indexOf("[", at);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return JSON.parse(html.slice(open, i + 1));
  }
  throw new Error(`${name} literal did not terminate`);
}

async function ktcBoard() {
  const res = await fetch(KTC_BOARD, {
    headers: { "user-agent": "any-given-sunday-league-site", accept: "text/html" },
  });
  if (!res.ok) throw new Error(`KTC → HTTP ${res.status}`);
  const teams = extractArray(await res.text(), "leagueTeams");
  if (!Array.isArray(teams) || !teams.length) throw new Error("KTC returned no teams");
  return teams;
}

const round1 = (n) => Math.round(Number(n) * 10) / 10;

/** A rostered player, trimmed to what the page shows. */
const player = (p) => ({
  name: p.playerName,
  pos: p.position,
  team: p.team || null,
  age: p.age ? round1(p.age) : null,
  value: p.value ?? null,
  rank: p.positionalRank ?? null,
  rookie: !!p.rookie,
});

/** A future rookie pick. `from` is set when it came from another team. */
const pick = (p) => ({
  name: p.pickString || p.playerName,
  year: p.year ?? null,
  round: p.round ?? null,
  value: p.value ?? null,
  from: p.from || null,
});

const groupOf = (t, key, fn) => (t.display && Array.isArray(t.display[key]) ? t.display[key].map(fn) : []);

async function build() {
  const history = JSON.parse(await readFile(HISTORY, "utf8"));
  const season = history.meta.currentSeason;

  const [teams, rosters] = await Promise.all([ktcBoard(), json(`${SLEEPER}/league/${LEAGUE}/rosters`)]);

  // KTC's teamId is the Sleeper owner id; the rest of the site keys off roster id.
  const ridByOwner = new Map(rosters.map((r) => [String(r.owner_id), r.roster_id]));

  const ranked = teams
    .map((t) => {
      const groups = {
        qb: groupOf(t, "qbs", player),
        rb: groupOf(t, "rbs", player),
        wr: groupOf(t, "wrs", player),
        te: groupOf(t, "tes", player),
        picks: groupOf(t, "picks", pick),
      };
      const valueOf = (list) => list.reduce((n, x) => n + (x.value || 0), 0);
      return {
        rank: t.adjValRank ?? t.rawValRank ?? null,
        rid: ridByOwner.get(String(t.teamId)) ?? null,
        team: String(t.name || "").trim(),
        score: t.teamScore ?? null,
        total: t.total ?? null,
        adjTotal: t.adjTotal ?? null,
        avgAge: t.avgAge ? round1(t.avgAge) : null,
        rawRank: t.rawValRank ?? null,
        groups,
        groupValues: {
          qb: valueOf(groups.qb), rb: valueOf(groups.rb),
          wr: valueOf(groups.wr), te: valueOf(groups.te), picks: valueOf(groups.picks),
        },
        counts: {
          qb: groups.qb.length, rb: groups.rb.length,
          wr: groups.wr.length, te: groups.te.length, picks: groups.picks.length,
        },
        best: [...groups.qb, ...groups.rb, ...groups.wr, ...groups.te]
          .sort((a, b) => (b.value || 0) - (a.value || 0))
          .slice(0, 3)
          .map(({ name, pos, value }) => ({ name, pos, value })),
      };
    })
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));

  const unmapped = ranked.filter((t) => t.rid == null).length;
  if (unmapped > ranked.length / 2) throw new Error(`${unmapped} teams could not be matched to a Sleeper roster`);

  // Movement since the last published board.
  let previous = {};
  try {
    const old = JSON.parse(await readFile(OUT, "utf8"));
    if (old.meta && old.meta.season === season) {
      previous = Object.fromEntries(old.rankings.map((t) => [t.team, t.rank]));
    }
  } catch { /* first run */ }
  for (const t of ranked) t.move = previous[t.team] ? previous[t.team] - t.rank : 0;

  return {
    meta: {
      season,
      generated: new Date().toISOString(),
      leagueId: LEAGUE,
      source: "KeepTradeCut league power rankings",
      sourceUrl: KTC_BOARD,
      note: "Scores, values and age adjustments are KeepTradeCut's own — this mirrors their board rather than recomputing it.",
    },
    rankings: ranked,
  };
}

try {
  const data = await build();
  await writeFile(OUT, JSON.stringify(data, null, 1) + "\n");
  const players = data.rankings.reduce((n, t) => n + t.counts.qb + t.counts.rb + t.counts.wr + t.counts.te, 0);
  const picks = data.rankings.reduce((n, t) => n + t.counts.picks, 0);
  console.log(`power.json rebuilt from KTC — ${data.rankings.length} teams, ${players} players, ${picks} picks`);
} catch (err) {
  console.error(`Power rankings refresh failed: ${err.message}`);
  console.error("Keeping the committed power.json.");
}
