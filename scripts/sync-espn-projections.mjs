import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const seasonYear = Number(process.argv[2] ?? new Date().getUTCFullYear());
const apiDir = new URL("../workers/api/", import.meta.url);
const endpoint = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${seasonYear}/players?view=kona_player_info`;
const fetchedAt = new Date().toISOString();

const response = await fetch(endpoint, {
  headers: {
    accept: "application/json",
    "user-agent": "myFFL/0.5 projection-seed (+https://myfflapp.com)",
    "x-fantasy-filter": JSON.stringify({
      players: {
        limit: 2000,
        sortPercOwned: { sortPriority: 1, sortAsc: false },
      },
    }),
  },
});

if (!response.ok) throw new Error(`ESPN fantasy players returned ${response.status}`);
const parsed = await response.json();
const players = Array.isArray(parsed) ? parsed : [];
const statements = [
  `delete from player_projections where provider = 'espn' and season_year = ${seasonYear};`,
];
let projectionRows = 0;

for (const player of players) {
  const providerPlayerId = string(player.id);
  if (!providerPlayerId) continue;
  const playerId = `espn-player-${providerPlayerId}`;
  const displayName = string(player.fullName) ?? string(player.displayName) ?? string(player.name) ?? `ESPN Player ${providerPlayerId}`;
  const position = positionFromPlayer(player);
  statements.push(
    `insert into nfl_players (nfl_player_id, display_name, position, current_team_id, headshot_object_key, headshot_source_url, created_at_utc, updated_at_utc)
     values (${q(playerId)}, ${q(displayName)}, ${q(position)}, null, null, null, ${q(fetchedAt)}, ${q(fetchedAt)})
     on conflict(nfl_player_id) do update set display_name = excluded.display_name,
       position = coalesce(excluded.position, nfl_players.position),
       updated_at_utc = excluded.updated_at_utc;`,
    `insert into provider_player_mappings (provider, provider_player_id, nfl_player_id, created_at_utc)
     values ('espn', ${q(providerPlayerId)}, ${q(playerId)}, ${q(fetchedAt)})
     on conflict(provider, provider_player_id) do update set nfl_player_id = excluded.nfl_player_id;`,
  );
  for (const stat of Array.isArray(player.stats) ? player.stats : []) {
    if (Number(stat.statSourceId) !== 1 || Number(stat.seasonId) !== seasonYear) continue;
    const splitType = Number(stat.statSplitTypeId);
    const projectionType = splitType === 0 ? "season" : splitType === 1 ? "weekly" : null;
    if (!projectionType) continue;
    const weekNumber = projectionType === "weekly" ? Number(stat.scoringPeriodId) : 0;
    if (projectionType === "weekly" && (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 22)) continue;
    const normalized = normalizeStats(stat.stats ?? {});
    if (!Object.keys(normalized).length) continue;
    statements.push(
      `insert into player_projections
        (provider, season_year, projection_type, week_number, provider_player_id, nfl_player_id,
         display_name, team_id, position, projected_stats_json, source_updated_at_utc, fetched_at_utc)
       values ('espn', ${seasonYear}, ${q(projectionType)}, ${weekNumber}, ${q(providerPlayerId)}, ${q(playerId)},
         ${q(displayName)}, null, ${q(position)}, ${q(JSON.stringify(normalized))}, ${q(fetchedAt)}, ${q(fetchedAt)});`,
    );
    projectionRows++;
  }
}

if (projectionRows < 100) throw new Error(`Only found ${projectionRows} projection rows; refusing to overwrite D1 with a partial dataset.`);

const dir = join(tmpdir(), `myffl-espn-projections-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const chunks = chunk(statements, 300);
for (let index = 0; index < chunks.length; index++) {
  const file = join(dir, `chunk-${String(index + 1).padStart(3, "0")}.sql`);
  writeFileSync(file, chunks[index].join("\n"), "utf8");
  const result = spawnSync("pnpm", ["exec", "wrangler", "d1", "execute", "NFL_DB", "--env", "production", "--remote", "--file", file], {
    cwd: apiDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(JSON.stringify({ seasonYear, players: players.length, projectionRows, fetchedAt }, null, 2));

function normalizeStats(stats) {
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
  return normalized;
}

function assign(stats, key, value) {
  const parsed = number(value);
  if (parsed !== undefined) stats[key] = parsed;
}

function positionFromPlayer(player) {
  const abbreviation = string(player.position?.abbreviation) ?? string(player.defaultPosition);
  if (abbreviation) return abbreviation.toUpperCase();
  return ({ 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" })[Number(player.defaultPositionId)] ?? null;
}

function q(value) {
  return value === null || value === undefined ? "null" : `'${String(value).replaceAll("'", "''")}'`;
}

function string(value) {
  return typeof value === "string" && value.length ? value : typeof value === "number" ? String(value) : undefined;
}

function number(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value.replaceAll(",", ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
