import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const seasonYear = Number(process.argv[2] ?? new Date().getUTCFullYear());
const seasonTypes = [
  { id: 1, weeks: 5 },
  { id: 2, weeks: 18 },
  { id: 3, weeks: 6 },
];
const now = new Date().toISOString();

const rows = [];
for (const seasonType of seasonTypes) {
  for (let week = 1; week <= seasonType.weeks; week++) {
    const listUrl = `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${seasonYear}/types/${seasonType.id}/weeks/${week}/events?lang=en&region=us&limit=100`;
    const list = await getJson(listUrl);
    const refs = Array.isArray(list.items) ? list.items.map((item) => item.$ref).filter(Boolean) : [];
    if (!refs.length && seasonType.id === 3 && week > 1) break;
    for (const ref of refs) rows.push(await eventRows(ref, seasonType.id, week));
  }
}

const dir = mkdtempSync(join(tmpdir(), "myffl-schedule-"));
try {
  const chunks = [];
  for (let index = 0; index < rows.length; index += 60) chunks.push(rows.slice(index, index + 60));
  for (const [index, chunk] of chunks.entries()) {
    const file = join(dir, `schedule-${index + 1}.sql`);
    writeFileSync(file, chunk.map(sqlForEvent).join("\n"));
    const result = spawnSync(pnpmCommand(), pnpmArgs([
      "exec",
      "wrangler",
      "d1",
      "execute",
      "myffl-nfl",
      "--remote",
      "--env",
      "production",
      "--config",
      "workers/api/wrangler.jsonc",
      "--file",
      file,
    ]), { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.error(`wrangler exited with status ${result.status} while applying chunk ${index + 1}.`);
      process.exit(result.status ?? 1);
    }
  }
  console.log(`Synced ${rows.length} ESPN core schedule events for ${seasonYear}.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

async function eventRows(ref, seasonType, week) {
  const event = await getJson(coreHttps(ref));
  const providerId = String(event.id ?? "");
  if (!providerId) throw new Error(`Core event missing id: ${ref}`);
  const competition = Array.isArray(event.competitions) ? event.competitions[0] ?? {} : {};
  const competitors = Array.isArray(competition.competitors) ? competition.competitors : [];
  const home = competitors.find((item) => item.homeAway === "home") ?? {};
  const away = competitors.find((item) => item.homeAway === "away") ?? {};
  const status = await competitionStatus(competition);
  const statusType = status.type ?? {};
  const state = String(statusType.state ?? "pre");
  const startsAt = String(event.date ?? competition.date ?? now);
  const started = state !== "pre" || Date.parse(startsAt) <= Date.now();
  const [homeScore, awayScore] = started ? await Promise.all([score(home), score(away)]) : [0, 0];
  return {
    eventId: `espn-event-${providerId}`,
    providerId,
    seasonYear,
    seasonType,
    week,
    startsAt,
    state,
    statusDetail: statusType.detail ?? statusType.description ?? null,
    period: numberValue(status.period),
    clock: String(status.displayClock ?? "0:00"),
    completed: statusType.completed === true ? 1 : 0,
    homeTeamId: teamId(home),
    awayTeamId: teamId(away),
    homeScore,
    awayScore,
  };
}

async function competitionStatus(competition) {
  if (competition.status && Object.keys(competition.status).length) return competition.status;
  const ref = competition.$ref;
  if (!ref) return {};
  return getJson(`${coreHttps(ref).replace(/\?.*$/, "")}/status?lang=en&region=us`);
}

async function score(competitor) {
  if (typeof competitor.score?.value === "number") return Math.trunc(competitor.score.value);
  const ref = competitor.score?.$ref;
  if (!ref) return 0;
  const payload = await getJson(coreHttps(ref));
  return numberValue(payload.value);
}

function teamId(competitor) {
  const direct = competitor.id ? String(competitor.id) : null;
  const fromRef = typeof competitor.team?.$ref === "string" ? competitor.team.$ref.match(/\/teams\/(\d+)(?:\?|$)/)?.[1] : null;
  const providerId = direct ?? fromRef;
  return providerId ? `espn-team-${providerId}` : null;
}

function sqlForEvent(row) {
  return `
insert into nfl_events
  (nfl_event_id, provider, provider_event_id, season_year, season_type, week,
   starts_at_utc, status, created_at_utc, updated_at_utc)
values (${q(row.eventId)}, 'espn', ${q(row.providerId)}, ${row.seasonYear}, ${row.seasonType}, ${row.week},
  ${q(row.startsAt)}, ${q(row.state)}, ${q(now)}, ${q(now)})
on conflict(provider, provider_event_id) do update set
  season_year = excluded.season_year,
  season_type = excluded.season_type,
  week = excluded.week,
  starts_at_utc = excluded.starts_at_utc,
  status = excluded.status,
  updated_at_utc = excluded.updated_at_utc;
insert into nfl_event_snapshots
  (nfl_event_id, data_scope, status, status_detail, period, clock, completed,
   home_team_id, away_team_id, home_score, away_score, situation_json, updated_at_utc)
values (${q(row.eventId)}, 'production', ${q(row.state)}, ${q(row.statusDetail)}, ${row.period}, ${q(row.clock)}, ${row.completed},
  ${q(row.homeTeamId)}, ${q(row.awayTeamId)}, ${row.homeScore}, ${row.awayScore}, null, ${q(now)})
on conflict(nfl_event_id, data_scope) do update set
  status = excluded.status,
  status_detail = excluded.status_detail,
  period = excluded.period,
  clock = excluded.clock,
  completed = excluded.completed,
  home_team_id = coalesce(excluded.home_team_id, nfl_event_snapshots.home_team_id),
  away_team_id = coalesce(excluded.away_team_id, nfl_event_snapshots.away_team_id),
  home_score = excluded.home_score,
  away_score = excluded.away_score,
  situation_json = excluded.situation_json,
  updated_at_utc = excluded.updated_at_utc;`;
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`ESPN returned ${response.status} for ${url}`);
  return response.json();
}

function q(value) {
  if (value === null || value === undefined) return "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function coreHttps(ref) {
  return ref.replace(/^http:\/\//i, "https://");
}

function pnpmCommand() {
  return process.platform === "win32" ? "cmd.exe" : "pnpm";
}

function pnpmArgs(args) {
  return process.platform === "win32" ? ["/c", "pnpm", ...args] : args;
}
