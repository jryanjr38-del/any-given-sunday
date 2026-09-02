/**
 * Rebuilds power.json by mirroring KeepTradeCut's own league power rankings.
 *
 * KTC's league board lives at
 *   keeptradecut.com/dynasty/power-rankings/league-overview  (leagueId + platform=2)
 * but the page ships only the roster skeleton — team ids, player ids, picks.
 * The scores, age-adjusted values and position breakouts are computed by their
 * JavaScript in the browser, so a plain fetch gets nothing useful. We therefore
 * load the page in headless Chromium, wait for their code to finish, and read
 * the finished `window.leagueTeams` board straight out of the page.
 *
 * Nothing is recomputed here: every number on the site's power rankings is
 * KTC's own. Sleeper is used only to map KTC's team ids (Sleeper owner ids)
 * onto roster ids, which is how the rest of the site keys its data.
 *
 * Requires Playwright, installed at job time by the GitHub Action — this script
 * is not part of the Netlify build, which serves the committed power.json.
 * No credentials: both sources are public. If anything fails, the committed
 * power.json is left alone.
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
const PAGE_TIMEOUT = 90_000;

/** Read the finished board out of a real browser. */
async function ktcBoard() {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    });
    await page.goto(KTC_BOARD, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });

    // Their script enriches leagueTeams in place; `display` is the last thing added.
    await page.waitForFunction(
      () => Array.isArray(window.leagueTeams) && window.leagueTeams.length &&
            window.leagueTeams.every((t) => t && t.display && typeof t.teamScore === "number"),
      null,
      { timeout: PAGE_TIMEOUT, polling: 500 },
    );

    // Trim inside the page so only what the site renders crosses the boundary.
    return await page.evaluate(() => {
      const r1 = (n) => (n == null ? null : Math.round(Number(n) * 10) / 10);
      const player = (p) => ({
        name: p.playerName, pos: p.position, team: p.team || null,
        age: r1(p.age), value: p.value ?? null,
        rank: p.positionalRank ?? null, rookie: !!p.rookie,
      });
      const pick = (p) => ({
        name: p.pickString || p.playerName, year: p.year ?? null,
        round: p.round ?? null, value: p.value ?? null, from: p.from || null,
      });
      return window.leagueTeams.map((t) => ({
        teamId: String(t.teamId),
        name: String(t.name || "").trim(),
        rank: t.adjValRank ?? t.rawValRank ?? null,
        rawRank: t.rawValRank ?? null,
        score: t.teamScore ?? null,
        total: t.total ?? null,
        adjTotal: t.adjTotal == null ? null : Math.round(t.adjTotal),
        avgAge: r1(t.avgAge),
        groups: {
          qb: (t.display.qbs || []).map(player),
          rb: (t.display.rbs || []).map(player),
          wr: (t.display.wrs || []).map(player),
          te: (t.display.tes || []).map(player),
          picks: (t.display.picks || []).map(pick),
        },
      }));
    });
  } finally {
    await browser.close();
  }
}

async function build() {
  const history = JSON.parse(await readFile(HISTORY, "utf8"));
  const season = history.meta.currentSeason;

  const [teams, rostersRes] = await Promise.all([
    ktcBoard(),
    fetch(`${SLEEPER}/league/${LEAGUE}/rosters`, { headers: { accept: "application/json" } }),
  ]);
  if (!rostersRes.ok) throw new Error(`Sleeper rosters → HTTP ${rostersRes.status}`);
  const rosters = await rostersRes.json();

  if (!teams.length) throw new Error("KTC returned no teams");
  const ridByOwner = new Map(rosters.map((r) => [String(r.owner_id), r.roster_id]));
  const sum = (list) => list.reduce((n, x) => n + (x.value || 0), 0);

  const ranked = teams
    .map((t) => {
      const g = t.groups;
      return {
        ...t,
        teamId: undefined,
        rid: ridByOwner.get(t.teamId) ?? null,
        groupValues: { qb: sum(g.qb), rb: sum(g.rb), wr: sum(g.wr), te: sum(g.te), picks: sum(g.picks) },
        counts: { qb: g.qb.length, rb: g.rb.length, wr: g.wr.length, te: g.te.length, picks: g.picks.length },
        best: [...g.qb, ...g.rb, ...g.wr, ...g.te]
          .sort((a, b) => (b.value || 0) - (a.value || 0))
          .slice(0, 3)
          .map(({ name, pos, value }) => ({ name, pos, value })),
      };
    })
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));

  if (ranked.some((t) => t.score == null)) throw new Error("KTC board arrived without team scores");
  const unmapped = ranked.filter((t) => t.rid == null).length;
  if (unmapped > ranked.length / 2) throw new Error(`${unmapped} teams could not be matched to a Sleeper roster`);

  let previous = {};
  try {
    const old = JSON.parse(await readFile(OUT, "utf8"));
    if (old.meta && old.meta.season === season) {
      previous = Object.fromEntries(old.rankings.map((t) => [t.team || t.name, t.rank]));
    }
  } catch { /* first run */ }
  for (const t of ranked) {
    t.team = t.name;
    delete t.name;
    t.move = previous[t.team] ? previous[t.team] - t.rank : 0;
  }

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
  console.log(`power.json mirrored from KTC — ${data.rankings.length} teams, ${players} players, ${picks} picks`);
} catch (err) {
  console.error(`Power rankings refresh failed: ${err.message}`);
  console.error("Keeping the committed power.json.");
}
