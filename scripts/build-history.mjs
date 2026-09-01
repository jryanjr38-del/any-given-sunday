/**
 * Rebuilds history.json from Sleeper's public API.
 *
 * Runs in two places:
 *   - GitHub Actions, every Tuesday morning (commits the result)
 *   - Netlify, on every deploy (so a manual deploy is always current)
 *
 * No credentials: every endpoint used here is public and unauthenticated.
 * If Sleeper is unreachable or answers with anything unexpected, the script
 * leaves the committed history.json untouched and exits 0 — a bad week of
 * data never takes the site down.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "history.json");

const CURRENT_LEAGUE = "1329967656165462016"; // 2026; earlier seasons are followed via previous_league_id
const API = "https://api.sleeper.app/v1";
const REG_SEASON_WEEKS = 14;

/* Team names come from Sleeper's user list. This map is the fallback and the
   tiebreaker: rosters keep their id across seasons even when an owner renames
   the team, and the site keys everything off roster id. */
const FALLBACK_TEAMS = {
  1: "Rum Hammers", 2: "Thunder Gun Express", 3: "Jimmy Marino", 4: "The Uncletaker",
  5: "druppert", 6: "Kenzos", 7: "IR Specialist", 8: "Shadynasty",
  9: "Los Muertos", 10: "Brendawg21",
};
const MY_ROSTER = 2; // Thunder Gun Express — highlighted on the site

const get = async (path) => {
  const res = await fetch(`${API}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
};

const round = (n) => Math.round(n * 100) / 100;

async function collectSeasons() {
  const seasons = [];
  let id = CURRENT_LEAGUE;
  while (id && seasons.length < 20) {
    const league = await get(`/league/${id}`);
    const [rosters, users] = await Promise.all([
      get(`/league/${id}/rosters`),
      get(`/league/${id}/users`).catch(() => []),
    ]);

    const nameByOwner = new Map();
    for (const u of users) {
      const name = (u.metadata && u.metadata.team_name) || u.display_name;
      if (name) nameByOwner.set(u.user_id, String(name).trim());
    }

    const weeks = [];
    for (let w = 1; w <= REG_SEASON_WEEKS; w++) {
      const entries = await get(`/league/${id}/matchups/${w}`).catch(() => []);
      if (Array.isArray(entries) && entries.length) weeks.push({ w, entries });
    }

    seasons.push({
      year: Number(league.season),
      leagueId: id,
      status: league.status,
      champion: Number((league.metadata || {}).latest_league_winner_roster_id) || null,
      names: Object.fromEntries(
        rosters.map((r) => [r.roster_id, nameByOwner.get(r.owner_id) || FALLBACK_TEAMS[r.roster_id] || `Team ${r.roster_id}`]),
      ),
      weeks,
    });
    id = league.previous_league_id;
  }
  return seasons.sort((a, b) => a.year - b.year);
}

function build(seasons) {
  const current = seasons[seasons.length - 1];
  const teams = { ...FALLBACK_TEAMS, ...current.names };
  const former = {};
  for (const s of seasons) {
    for (const [rid, name] of Object.entries(s.names)) {
      if (name && name !== teams[rid]) (former[rid] ||= {})[s.year] = name;
    }
  }

  const games = [];
  const seasonRows = {};
  for (const s of seasons) {
    const rows = (seasonRows[s.year] = {});
    for (const wk of s.weeks) {
      const byMatchup = new Map();
      for (const e of wk.entries) {
        if (e.matchup_id == null) continue;
        const list = byMatchup.get(e.matchup_id) || [];
        list.push([e.roster_id, round(e.points || 0)]);
        byMatchup.set(e.matchup_id, list);
      }
      for (const pair of byMatchup.values()) {
        if (pair.length !== 2) continue;
        const [[a, pa], [b, pb]] = pair;
        if (pa === 0 && pb === 0) continue; // unplayed week
        games.push({ yr: s.year, wk: wk.w, a, pa, b, pb });
        for (const [rid, mine, theirs] of [[a, pa, pb], [b, pb, pa]]) {
          const r = (rows[rid] ||= { w: 0, l: 0, t: 0, pf: 0, pa: 0, hi: 0, lo: Infinity });
          r.pf += mine; r.pa += theirs;
          r.hi = Math.max(r.hi, mine); r.lo = Math.min(r.lo, mine);
          if (mine > theirs) r.w++; else if (mine < theirs) r.l++; else r.t++;
        }
      }
    }
    const ordered = Object.entries(rows).sort((x, y) => y[1].w - x[1].w || y[1].pf - x[1].pf);
    ordered.forEach(([, r], i) => { r.seed = i + 1; });
    for (const r of Object.values(rows)) { r.pf = round(r.pf); r.pa = round(r.pa); if (r.lo === Infinity) r.lo = 0; }
  }

  const champs = {};
  for (const s of seasons) if (s.champion) champs[s.year] = s.champion;

  const alltime = {};
  for (const rid of Object.keys(teams)) {
    alltime[rid] = { w: 0, l: 0, t: 0, pf: 0, pa: 0, gp: 0, seasons: 0, titles: 0, playoffs: 0 };
  }
  for (const [yr, rows] of Object.entries(seasonRows)) {
    const complete = Number(yr) !== current.year || current.status === "complete";
    for (const [rid, r] of Object.entries(rows)) {
      const a = (alltime[rid] ||= { w: 0, l: 0, t: 0, pf: 0, pa: 0, gp: 0, seasons: 0, titles: 0, playoffs: 0 });
      a.w += r.w; a.l += r.l; a.t += r.t; a.pf += r.pf; a.pa += r.pa;
      a.gp += r.w + r.l + r.t; a.seasons++;
      if (complete && r.seed <= 6) a.playoffs++;
    }
  }
  for (const rid of Object.values(champs)) if (alltime[rid]) alltime[rid].titles++;
  for (const a of Object.values(alltime)) {
    a.pf = round(a.pf); a.pa = round(a.pa);
    a.ppg = a.gp ? round(a.pf / a.gp) : 0;
    a.pct = a.gp ? Math.round((a.w / a.gp) * 1000) / 1000 : 0;
  }

  const weekly = [];
  for (const g of games) {
    weekly.push({ pts: g.pa, rid: g.a, yr: g.yr, wk: g.wk, opp: g.b, opp_pts: g.pb });
    weekly.push({ pts: g.pb, rid: g.b, yr: g.yr, wk: g.wk, opp: g.a, opp_pts: g.pa });
  }
  weekly.sort((x, y) => y.pts - x.pts);

  const margins = games.map((g) => {
    const win = g.pa > g.pb ? g.a : g.b, lose = g.pa > g.pb ? g.b : g.a;
    return { m: round(Math.abs(g.pa - g.pb)), yr: g.yr, wk: g.wk, win, lose,
             wp: Math.max(g.pa, g.pb), lp: Math.min(g.pa, g.pb) };
  });

  const seasonList = [];
  for (const [yr, rows] of Object.entries(seasonRows)) {
    for (const [rid, r] of Object.entries(rows)) seasonList.push({ yr: Number(yr), rid: Number(rid), ...r });
  }

  const h2h = {};
  for (const g of games) {
    const [win, lose] = g.pa > g.pb ? [g.a, g.b] : [g.b, g.a];
    if (g.pa === g.pb) continue;
    (h2h[`${win}-${lose}`] ||= [0, 0])[0]++;
    (h2h[`${lose}-${win}`] ||= [0, 0])[1]++;
  }

  const sched = [];
  for (const wk of current.weeks) {
    const byMatchup = new Map();
    for (const e of wk.entries) {
      const list = byMatchup.get(e.matchup_id) || [];
      list.push({ rid: e.roster_id, pts: round(e.points || 0) });
      byMatchup.set(e.matchup_id, list);
    }
    sched.push({
      week: wk.w,
      games: [...byMatchup.values()].filter((p) => p.length === 2)
        .map((p) => p.sort((x, y) => x.rid - y.rid)),
    });
  }

  return {
    meta: {
      league: "Any Given Sunday", sport: "nfl", currentSeason: current.year,
      currentStatus: current.status, myRoster: MY_ROSTER,
      leagueIds: Object.fromEntries(seasons.map((s) => [s.year, s.leagueId])),
      generated: new Date().toISOString().slice(0, 10), source: "Sleeper public API",
    },
    teams, former, champs, alltime,
    seasons: seasonRows,
    top_weeks: weekly.slice(0, 15),
    low_weeks: weekly.slice(-10).reverse(),
    blowouts: [...margins].sort((x, y) => y.m - x.m).slice(0, 10),
    nailbiters: [...margins].sort((x, y) => x.m - y.m).slice(0, 10),
    shootouts: games.map((g) => ({ tot: round(g.pa + g.pb), yr: g.yr, wk: g.wk, a: g.a, b: g.b, ap: g.pa, bp: g.pb }))
      .sort((x, y) => y.tot - x.tot).slice(0, 10),
    season_best: [...seasonList].sort((x, y) => y.w - x.w || y.pf - x.pf).slice(0, 10)
      .map(({ yr, rid, w, l, pf }) => ({ yr, rid, w, l, pf })),
    season_pf: [...seasonList].sort((x, y) => y.pf - x.pf).slice(0, 10)
      .map(({ yr, rid, pf, w, l }) => ({ yr, rid, pf, w, l })),
    h2h,
    schedule: sched,
  };
}

try {
  const seasons = await collectSeasons();
  if (!seasons.length) throw new Error("no seasons returned");
  const data = build(seasons);
  const teamCount = Object.keys(data.teams).length;
  if (teamCount < 2) throw new Error(`only ${teamCount} teams resolved — refusing to overwrite`);
  await writeFile(OUT, JSON.stringify(data, null, 1) + "\n");
  console.log(`history.json rebuilt — ${seasons.length} seasons, ${Object.keys(data.h2h).length} series, generated ${data.meta.generated}`);
} catch (err) {
  console.error(`Sleeper refresh failed: ${err.message}`);
  try {
    const existing = JSON.parse(await readFile(OUT, "utf8"));
    console.error(`Keeping committed history.json (generated ${existing.meta?.generated ?? "unknown"}).`);
  } catch {
    console.error("No usable history.json on disk — the site will show its built-in fallback.");
  }
}
