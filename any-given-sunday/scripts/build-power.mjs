/**
 * Rebuilds power.json — dynasty power rankings for the current season.
 *
 * Two public sources, no credentials:
 *   - Sleeper: current rosters (so a trade or waiver claim shows up on the next run)
 *   - KeepTradeCut: dynasty player values, 1QB set (this league starts one QB)
 *
 * The composite score blends roster value with on-field results. Before Week 1
 * there are no results, so it leans entirely on value; once games are played the
 * weights below apply. Every component is published alongside the score so the
 * league can argue with the math rather than the black box.
 *
 * Failure is soft: if either source is unreachable or the name matching falls
 * apart, the committed power.json is left alone.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "power.json");
const HISTORY = join(ROOT, "history.json");

const LEAGUE = "1329967656165462016";
const SLEEPER = "https://api.sleeper.app/v1";
const KTC = "https://keeptradecut.com/dynasty-rankings";

const WEIGHTS = { value: 0.55, points: 0.28, record: 0.17 };
const DEPTH = 15;          // starters + meaningful bench; deeper than this is noise in a 10-team league
const ROUNDS = 4;          // the rookie draft is four rounds
const MIN_MATCH_RATE = 0.7; // below this, name matching has gone wrong — don't publish

const json = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
};

/** KTC ships the rankings as a `playersArray` literal inside the page. */
async function ktcValues() {
  const res = await fetch(KTC, { headers: { "user-agent": "any-given-sunday-league-site" } });
  if (!res.ok) throw new Error(`KTC → HTTP ${res.status}`);
  const html = await res.text();
  const start = html.indexOf("var playersArray");
  if (start === -1) throw new Error("KTC page shape changed — playersArray not found");
  const open = html.indexOf("[", start);
  let depth = 0, end = -1;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) { end = i + 1; break; }
  }
  if (end === -1) throw new Error("KTC playersArray did not terminate");
  const players = JSON.parse(html.slice(open, end));
  const byKey = new Map();
  for (const p of players) {
    const v = (p.oneQBValues && p.oneQBValues.value) ?? p.value;
    if (!v || !p.playerName || p.position === "RDP") continue;
    byKey.set(key(p.playerName, p.position), { value: v, name: p.playerName, pos: p.position, team: p.team });
  }
  return { players: byKey, pickValue: pickValues(players) };
}

/**
 * Rookie draft picks, from KTC's "RDP" entries: "2027 1st", "2027 Early 2nd", …
 * A generic entry is used when KTC publishes one; otherwise the Early/Mid/Late
 * values for that year and round are averaged, which is what an untraded pick
 * is worth before anyone knows where it lands.
 */
const ORDINALS = { "1st": 1, "2nd": 2, "3rd": 3, "4th": 4 };
function pickValues(players) {
  const generic = new Map(), tiered = new Map();
  for (const p of players) {
    if (p.position !== "RDP" || !p.playerName) continue;
    const v = (p.oneQBValues && p.oneQBValues.value) ?? p.value;
    if (!v) continue;
    const m = /^(\d{4})\s+(?:(early|mid|late)\s+)?(1st|2nd|3rd|4th)$/i.exec(p.playerName.trim());
    if (!m) continue;
    const k = `${m[1]}-${ORDINALS[m[3].toLowerCase()]}`;
    if (m[2]) {
      if (!tiered.has(k)) tiered.set(k, []);
      tiered.get(k).push(v);
    } else generic.set(k, v);
  }
  return (season, round) => {
    const k = `${season}-${round}`;
    if (generic.has(k)) return generic.get(k);
    const t = tiered.get(k);
    return t && t.length ? Math.round(t.reduce((a, b) => a + b, 0) / t.length) : 0;
  };
}

/** Who owns which future pick: everyone owns their own until a trade says otherwise. */
function pickOwnership(traded, rosterIds, seasons, rounds) {
  const owner = new Map();
  for (const season of seasons)
    for (let round = 1; round <= rounds; round++)
      for (const rid of rosterIds) owner.set(`${season}|${round}|${rid}`, rid);
  for (const t of traded) {
    const k = `${t.season}|${t.round}|${t.roster_id}`;
    if (owner.has(k)) owner.set(k, t.owner_id);
  }
  return owner;
}

const SUFFIX = /\b(jr|sr|ii|iii|iv|v)\b/g;
const key = (name, pos) =>
  String(name).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, "").replace(SUFFIX, "").replace(/\s+/g, " ").trim() + "|" + (pos || "");

async function build() {
  const history = JSON.parse(await readFile(HISTORY, "utf8"));
  const teams = history.teams;
  const season = history.meta.currentSeason;
  const rows = history.seasons[season] || {};

  const [rosters, players, ktc, traded] = await Promise.all([
    json(`${SLEEPER}/league/${LEAGUE}/rosters`),
    json(`${SLEEPER}/players/nfl`),
    ktcValues(),
    json(`${SLEEPER}/league/${LEAGUE}/traded_picks`).catch(() => []),
  ]);
  const values = ktc.players;

  // Pick classes worth counting: the next three rookie drafts.
  const rosterIds = rosters.map((r) => r.roster_id);
  const pickSeasons = [season + 1, season + 2, season + 3].map(String);
  const owner = pickOwnership(traded, rosterIds, pickSeasons, ROUNDS);
  const picksByTeam = new Map(rosterIds.map((rid) => [rid, []]));
  for (const [k, ownerRid] of owner) {
    const [ps, rd, orig] = k.split("|");
    const value = ktc.pickValue(ps, Number(rd));
    if (!value) continue;
    const held = picksByTeam.get(Number(ownerRid));
    if (held) held.push({ season: Number(ps), round: Number(rd), from: Number(orig), value });
  }

  let looked = 0, matched = 0;
  const valueOf = (pid) => {
    const p = players[pid];
    if (!p || !p.position || ["K", "DEF"].includes(p.position)) return null; // KTC doesn't value kickers or defenses
    looked++;
    const hit = values.get(key(p.full_name || `${p.first_name} ${p.last_name}`, p.position));
    if (hit) matched++;
    return hit ? { value: hit.value, name: hit.name, pos: p.position } : null;
  };

  const teamRows = rosters.map((r) => {
    const held = (r.players || []).map(valueOf).filter(Boolean).sort((a, b) => b.value - a.value);
    const core = held.slice(0, DEPTH);
    const picks = (picksByTeam.get(r.roster_id) || []).sort((a, b) => b.value - a.value);
    const playerValue = core.reduce((n, p) => n + p.value, 0);
    const picksValue = picks.reduce((n, p) => n + p.value, 0);
    return {
      rid: r.roster_id,
      team: teams[r.roster_id] || `Team ${r.roster_id}`,
      value: playerValue + picksValue,
      playerValue, picksValue,
      picks: picks.length,
      bestPicks: picks.slice(0, 3).map((p) => ({
        label: `${p.season} ${["", "1st", "2nd", "3rd", "4th"][p.round]}${p.from === r.roster_id ? "" : " (" + (teams[p.from] || "Team " + p.from) + ")"}`,
        value: p.value,
      })),
      top: core.slice(0, 3).map((p) => ({ name: p.name, pos: p.pos, value: p.value })),
      counted: core.length,
      rostered: (r.players || []).length,
    };
  });

  if (looked && matched / looked < MIN_MATCH_RATE) {
    throw new Error(`only ${matched}/${looked} players matched KTC — refusing to publish`);
  }

  const played = Object.values(rows).some((r) => r.w + r.l + r.t > 0);
  const basis = played ? season : Object.keys(history.seasons).map(Number).filter((y) => y < season).pop();
  const basisRows = played ? rows : history.seasons[basis] || {};

  const scale = (vals) => {
    const lo = Math.min(...vals), hi = Math.max(...vals);
    return (v) => (hi === lo ? 50 : ((v - lo) / (hi - lo)) * 100);
  };
  const ppg = (rid) => {
    const r = basisRows[rid];
    const g = r ? r.w + r.l + r.t : 0;
    return g ? r.pf / g : 0;
  };
  const winPct = (rid) => {
    const r = basisRows[rid];
    const g = r ? r.w + r.l + r.t : 0;
    return g ? r.w / g : 0;
  };

  const sv = scale(teamRows.map((t) => t.value));
  const sp = scale(teamRows.map((t) => ppg(t.rid)));
  const sw = scale(teamRows.map((t) => winPct(t.rid)));
  const hasResults = teamRows.some((t) => ppg(t.rid) > 0);

  const ranked = teamRows.map((t) => {
    const parts = {
      value: Math.round(sv(t.value) * 10) / 10,
      points: Math.round(sp(ppg(t.rid)) * 10) / 10,
      record: Math.round(sw(winPct(t.rid)) * 10) / 10,
    };
    const score = hasResults
      ? parts.value * WEIGHTS.value + parts.points * WEIGHTS.points + parts.record * WEIGHTS.record
      : parts.value;
    return { ...t, parts, ppg: Math.round(ppg(t.rid) * 100) / 100, score: Math.round(score * 10) / 10 };
  }).sort((a, b) => b.score - a.score);

  ranked.forEach((t, i) => { t.rank = i + 1; });

  let previous = {};
  try {
    const old = JSON.parse(await readFile(OUT, "utf8"));
    if (old.meta && old.meta.season === season) previous = Object.fromEntries(old.rankings.map((t) => [t.rid, t.rank]));
  } catch { /* first run */ }
  for (const t of ranked) t.move = previous[t.rid] ? previous[t.rid] - t.rank : 0;

  return {
    meta: {
      season, basis, basisIsPriorSeason: !played,
      generated: new Date().toISOString(),
      depth: DEPTH, rounds: ROUNDS, pickSeasons: pickSeasons.map(Number),
      weights: hasResults ? WEIGHTS : { value: 1, points: 0, record: 0 },
      matched, looked,
          sources: ["Sleeper rosters and traded picks", "KeepTradeCut dynasty values (1QB), players and rookie picks"],
    },
    rankings: ranked,
  };
}

try {
  const data = await build();
  await writeFile(OUT, JSON.stringify(data, null, 1) + "\n");
  const picks = data.rankings.reduce((n, t) => n + t.picks, 0);
  console.log(`power.json rebuilt — ${data.rankings.length} teams, ${data.meta.matched}/${data.meta.looked} players valued, ${picks} draft picks counted`);
} catch (err) {
  console.error(`Power rankings refresh failed: ${err.message}`);
  console.error("Keeping the committed power.json.");
}
