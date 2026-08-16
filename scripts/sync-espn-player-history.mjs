import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const seasonYear = Number(process.argv[2] ?? new Date().getUTCFullYear());
const now = new Date().toISOString();
const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${seasonYear}/players?view=kona_player_info&scoringPeriodId=1&limit=2000`;
const payload = await getJson(url, { players: { limit: 2000 } });
const players = Array.isArray(payload) ? payload : Array.isArray(payload.players) ? payload.players : [];
const statements = [];

for (const player of players) {
  const providerPlayerId = string(player.id);
  if (!providerPlayerId) continue;
  const playerId = `espn-player-${providerPlayerId}`;
  const displayName = string(player.fullName) ?? string(player.displayName) ?? string(player.name) ?? `ESPN Player ${providerPlayerId}`;
  const position = positionFromFantasyPlayer(player);
  const teamId = numberValue(player.proTeamId) > 0 ? `espn-team-${numberValue(player.proTeamId)}` : null;
  const seasonOutlook = string(player.seasonOutlook);
  statements.push(`
insert into nfl_players
  (nfl_player_id, display_name, position, current_team_id, headshot_object_key, headshot_source_url, season_outlook, created_at_utc, updated_at_utc)
values (${q(playerId)}, ${q(displayName)}, ${q(position)}, ${q(teamId)}, null, null, ${q(seasonOutlook)}, ${q(now)}, ${q(now)})
on conflict(nfl_player_id) do update set
  display_name = excluded.display_name,
  position = coalesce(excluded.position, nfl_players.position),
  current_team_id = coalesce(excluded.current_team_id, nfl_players.current_team_id),
  season_outlook = coalesce(excluded.season_outlook, nfl_players.season_outlook),
  updated_at_utc = excluded.updated_at_utc;
insert into provider_player_mappings
  (provider, provider_player_id, nfl_player_id, created_at_utc)
values ('espn', ${q(providerPlayerId)}, ${q(playerId)}, ${q(now)})
on conflict(provider, provider_player_id) do nothing;`);

  for (const stat of Array.isArray(player.stats) ? player.stats : []) {
    if (numberValue(stat.statSourceId) !== 0 || numberValue(stat.statSplitTypeId) !== 0) continue;
    const statSeasonYear = numberValue(stat.seasonId);
    if (statSeasonYear <= 0) continue;
    const normalized = normalizeSeasonStats(stat.stats ?? {});
    if (!Object.keys(normalized).length) continue;
    statements.push(`
insert into player_season_stats
  (provider, season_year, provider_player_id, nfl_player_id, display_name, team_id, position, stats_json, source_updated_at_utc, fetched_at_utc)
values ('espn', ${statSeasonYear}, ${q(providerPlayerId)}, ${q(playerId)}, ${q(displayName)}, ${q(teamId)}, ${q(position)}, ${q(JSON.stringify(normalized))}, ${q(now)}, ${q(now)})
on conflict(provider, season_year, provider_player_id) do update set
  nfl_player_id = excluded.nfl_player_id,
  display_name = excluded.display_name,
  team_id = excluded.team_id,
  position = excluded.position,
  stats_json = excluded.stats_json,
  source_updated_at_utc = excluded.source_updated_at_utc,
  fetched_at_utc = excluded.fetched_at_utc;`);
  }
}

const dir = mkdtempSync(join(tmpdir(), "myffl-player-history-"));
try {
  const chunks = [];
  for (let index = 0; index < statements.length; index += 700) chunks.push(statements.slice(index, index + 700));
  for (const [index, chunk] of chunks.entries()) {
    const file = join(dir, `player-history-${index + 1}.sql`);
    writeFileSync(file, chunk.join("\n"));
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
  console.log(`Synced ${players.length} ESPN player profiles/history rows for ${seasonYear}.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function normalizeSeasonStats(stats) {
  const normalized = {};
  assign(normalized, "passing:ATT", stats["0"]);
  assign(normalized, "passing:CMP", stats["1"]);
  assign(normalized, "passing:YDS", stats["3"]);
  assign(normalized, "passing:TD", stats["4"]);
  assign(normalized, "passing:INT", stats["20"]);
  assign(normalized, "rushing:ATT", stats["23"]);
  assign(normalized, "rushing:YDS", stats["24"]);
  assign(normalized, "rushing:TD", stats["25"]);
  assign(normalized, "receiving:YDS", stats["42"]);
  assign(normalized, "receiving:TD", stats["43"]);
  assign(normalized, "receiving:REC", stats["53"]);
  assign(normalized, "fumbles:LOST", stats["72"]);
  assign(normalized, "kicking:FG", stats["83"]);
  assign(normalized, "kicking:XP", stats["86"]);
  assign(normalized, "defense:SACKS", stats["99"]);
  assign(normalized, "defense:INT", stats["100"]);
  assign(normalized, "defense:FR", stats["101"]);
  assign(normalized, "defense:TD", stats["102"]);
  assign(normalized, "games:GP", stats["210"]);
  return normalized;
}

function assign(target, key, value) {
  const parsed = Number(typeof value === "string" ? value.replaceAll(",", "") : value);
  if (Number.isFinite(parsed)) target[key] = parsed;
}

async function getJson(fetchUrl, fantasyFilter) {
  const headers = fantasyFilter ? { "x-fantasy-filter": JSON.stringify(fantasyFilter) } : undefined;
  const response = await fetch(fetchUrl, { headers });
  if (!response.ok) throw new Error(`ESPN returned ${response.status} for ${fetchUrl}`);
  return response.json();
}

function positionFromFantasyPlayer(player) {
  const abbreviation = string(player.position?.abbreviation) ?? string(player.defaultPosition);
  if (abbreviation) return abbreviation.toUpperCase();
  return ({ 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" })[numberValue(player.defaultPositionId)] ?? null;
}

function string(value) {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function q(value) {
  if (value === null || value === undefined) return "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function pnpmCommand() {
  return process.platform === "win32" ? "cmd.exe" : "pnpm";
}

function pnpmArgs(args) {
  return process.platform === "win32" ? ["/c", "pnpm", ...args] : args;
}
