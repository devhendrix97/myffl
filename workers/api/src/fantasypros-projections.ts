import { ApiException, readJson } from "./http";
import { type HandlerResult } from "./auth";
import { mapPlayers, type FantasyProsPlayer, type InternalPlayer } from "./fantasypros";

export type ProjectionType = "season" | "weekly";

export interface FantasyProsProjectionImportResult {
  imported: number;
  mapped: number;
  position: string;
  projectionType: ProjectionType;
  seasonYear: number;
  weekNumber?: number;
}

interface ProjectionBody {
  csv?: string;
  seasonYear?: number;
  projectionType?: ProjectionType;
  weekNumber?: number;
  position?: string;
  sourceUpdatedAt?: string;
}

interface ProjectionRow {
  player: FantasyProsPlayer;
  stats: Record<string, number>;
}

export async function handleFantasyProsProjectionRequest(
  request: Request,
  url: URL,
  env: Env,
): Promise<HandlerResult<unknown> | undefined> {
  if (url.pathname !== "/api/internal/fantasypros/projections/csv" || request.method !== "POST") return undefined;
  requireImportToken(request, env);
  const body = await readJson<ProjectionBody>(request);
  const csv = body.csv?.trim();
  if (!csv) throw new ApiException(400, "csv_required", "FantasyPros projection CSV content is required.");
  const seasonYear = Number(body.seasonYear ?? new Date().getUTCFullYear());
  if (!Number.isInteger(seasonYear) || seasonYear < 2020 || seasonYear > 2100) {
    throw new ApiException(400, "invalid_season_year", "Choose a valid FantasyPros season year.");
  }
  const projectionType = body.projectionType === "season" ? "season" : "weekly";
  const weekNumber = projectionType === "weekly" ? await projectionWeek(env.NFL_DB, seasonYear, body.weekNumber) : undefined;
  const position = normalizePosition(body.position);
  const result = await importFantasyProsProjectionCsv(env, csv, {
    seasonYear,
    projectionType,
    weekNumber,
    position,
    sourceUpdatedAt: body.sourceUpdatedAt,
  });
  return { status: 201, data: { ...result, sourceName: "FantasyPros projections", importedAtUtc: new Date().toISOString() } };
}

export async function importFantasyProsProjectionCsv(
  env: Env,
  csvText: string,
  options: { seasonYear: number; projectionType: ProjectionType; weekNumber?: number; position: string; sourceUpdatedAt?: string },
): Promise<FantasyProsProjectionImportResult> {
  const position = normalizePosition(options.position);
  const rows = csvRowsToProjectionRows(csvText, position);
  const internal = await loadInternalPlayers(env.NFL_DB);
  const mapped = mapPlayers(rows.map((row) => row.player), internal);
  const fetchedAt = new Date().toISOString();
  let imported = 0;

  for (let index = 0; index < rows.length; index += 75) {
    const chunk = rows.slice(index, index + 75);
    await env.NFL_DB.batch(chunk.map((row, offset) => {
      const match = mapped[index + offset];
      return env.NFL_DB.prepare(
        `insert into fantasypros_projections
          (season_year,projection_type,week_number,position,fantasypros_player_id,nfl_player_id,
           display_name,team_abbreviation,projected_stats_json,source_updated_at,fetched_at_utc)
         values(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
         on conflict(season_year,projection_type,week_number,position,fantasypros_player_id) do update set
           nfl_player_id=excluded.nfl_player_id,display_name=excluded.display_name,
           team_abbreviation=excluded.team_abbreviation,projected_stats_json=excluded.projected_stats_json,
           source_updated_at=excluded.source_updated_at,fetched_at_utc=excluded.fetched_at_utc`,
      ).bind(
        options.seasonYear,
        options.projectionType,
        options.projectionType === "weekly" ? options.weekNumber ?? 0 : 0,
        position,
        String(row.player.player_id),
        match?.nflPlayerId ?? null,
        row.player.player_name,
        row.player.player_team_id ?? null,
        JSON.stringify(row.stats),
        options.sourceUpdatedAt ?? null,
        fetchedAt,
      );
    }));
    imported += chunk.length;
  }

  await env.NFL_DB.prepare(
    `delete from fantasypros_projections
     where season_year=?1 and projection_type=?2 and week_number=?3 and position=?4 and fetched_at_utc<>?5`,
  ).bind(
    options.seasonYear,
    options.projectionType,
    options.projectionType === "weekly" ? options.weekNumber ?? 0 : 0,
    position,
    fetchedAt,
  ).run();

  return {
    imported,
    mapped: mapped.filter((item) => item.nflPlayerId).length,
    position,
    projectionType: options.projectionType,
    seasonYear: options.seasonYear,
    weekNumber: options.projectionType === "weekly" ? options.weekNumber : undefined,
  };
}

export function csvRowsToProjectionRows(csvText: string, positionInput: string): ProjectionRow[] {
  const position = normalizePosition(positionInput);
  const rows = parseCsvRows(csvText);
  const headerIndex = rows.findIndex((row) => row.some((cell) => normalizeHeader(cell) === "player"));
  if (headerIndex < 0) throw new ApiException(400, "invalid_projection_csv", "Projection CSV must include a Player column.");
  const headers = rows[headerIndex].map(normalizeHeader);
  const playerIndex = headers.indexOf("player");
  const teamIndex = headers.indexOf("team");
  if (playerIndex < 0 || teamIndex < 0) throw new ApiException(400, "invalid_projection_csv", "Projection CSV must include Player and Team columns.");

  const projections: ProjectionRow[] = [];
  for (const cells of rows.slice(headerIndex + 1)) {
    const playerName = cleanCell(cells[playerIndex]);
    const team = cleanCell(cells[teamIndex]);
    if (!playerName || playerName === "\u00a0") continue;
    const stats = statsForPosition(position, headers, cells);
    const playerId = `${normalizeName(playerName)}-${team || "FA"}-${position}`;
    projections.push({
      player: {
        player_id: playerId,
        player_name: playerName,
        player_team_id: team || undefined,
        player_position_id: position,
        rank_ecr: 1,
      },
      stats,
    });
  }
  return projections;
}

function statsForPosition(position: string, headers: string[], cells: string[]): Record<string, number> {
  const stats: Record<string, number> = {};
  const numericCells = cells.map(number);
  const afterTeam = headers.findIndex((header) => header === "team") + 1;

  if (position === "QB") {
    assign(stats, "passing:ATT", numericCells[afterTeam]);
    assign(stats, "passing:CMP", numericCells[afterTeam + 1]);
    assign(stats, "passing:YDS", numericCells[afterTeam + 2]);
    assign(stats, "passing:TD", numericCells[afterTeam + 3]);
    assign(stats, "passing:INT", numericCells[afterTeam + 4]);
    assign(stats, "rushing:ATT", numericCells[afterTeam + 5]);
    assign(stats, "rushing:YDS", numericCells[afterTeam + 6]);
    assign(stats, "rushing:TD", numericCells[afterTeam + 7]);
    assign(stats, "fumbles:LOST", numericCells[afterTeam + 8]);
    return stats;
  }

  if (position === "RB") {
    assign(stats, "rushing:ATT", numericCells[afterTeam]);
    assign(stats, "rushing:YDS", numericCells[afterTeam + 1]);
    assign(stats, "rushing:TD", numericCells[afterTeam + 2]);
    assign(stats, "receiving:REC", numericCells[afterTeam + 3]);
    assign(stats, "receiving:YDS", numericCells[afterTeam + 4]);
    assign(stats, "receiving:TD", numericCells[afterTeam + 5]);
    assign(stats, "fumbles:LOST", numericCells[afterTeam + 6]);
    return stats;
  }

  if (position === "WR" || position === "TE") {
    assign(stats, "receiving:REC", numericCells[afterTeam]);
    assign(stats, "receiving:YDS", numericCells[afterTeam + 1]);
    assign(stats, "receiving:TD", numericCells[afterTeam + 2]);
    assign(stats, "rushing:ATT", numericCells[afterTeam + 3]);
    assign(stats, "rushing:YDS", numericCells[afterTeam + 4]);
    assign(stats, "rushing:TD", numericCells[afterTeam + 5]);
    assign(stats, "fumbles:LOST", numericCells[afterTeam + 6]);
    return stats;
  }

  for (let index = afterTeam; index < headers.length; index++) {
    const header = headers[index];
    if (header === "fpts") continue;
    const key = genericProjectionKey(position, header);
    if (key) assign(stats, key, numericCells[index]);
  }
  return stats;
}

function genericProjectionKey(position: string, header: string): string | undefined {
  if (position === "K") {
    if (header === "fg") return "kicking:FG";
    if (header === "xpt" || header === "xp") return "kicking:XP";
  }
  if (position === "DST") {
    if (header === "sack" || header === "sacks") return "defense:SACKS";
    if (header === "int" || header === "ints") return "defense:INT";
    if (header === "fr") return "defense:FR";
    if (header === "td" || header === "tds") return "defense:TD";
  }
  return undefined;
}

function requireImportToken(request: Request, env: Env): void {
  const expected = env.FANTASYPROS_CSV_IMPORT_TOKEN?.trim();
  if (!expected) throw new ApiException(503, "csv_import_not_configured", "FantasyPros CSV automation is not configured.");
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1].trim() !== expected) {
    throw new ApiException(403, "csv_import_forbidden", "FantasyPros CSV automation token is invalid.");
  }
}

async function loadInternalPlayers(db: D1Database): Promise<InternalPlayer[]> {
  const rows = await db.prepare(
    `select players.nfl_player_id,players.display_name,players.position,teams.abbreviation
     from nfl_players players left join nfl_teams teams on teams.nfl_team_id=players.current_team_id
     where players.merged_into_player_id is null`,
  ).all<InternalPlayer>();
  return rows.results ?? [];
}

async function projectionWeek(db: D1Database, seasonYear: number, input: unknown): Promise<number> {
  const explicit = Number(input);
  if (Number.isInteger(explicit) && explicit >= 1 && explicit <= 22) return explicit;
  const inferred = await db.prepare(
    `select coalesce(min(week),max(week),1) as week
     from nfl_events
     where season_year=?1 and season_type=2 and starts_at_utc>=?2`,
  ).bind(seasonYear, new Date().toISOString()).first<{ week: number }>();
  const week = Number(inferred?.week ?? 1);
  if (!Number.isInteger(week) || week < 1 || week > 22) {
    throw new ApiException(400, "invalid_week_number", "Weekly FantasyPros projections require an NFL week from 1 to 22.");
  }
  return week;
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === "\"" && source[index + 1] === "\"") { value += "\""; index++; }
      else if (char === "\"") quoted = false;
      else value += char;
    } else if (char === "\"") quoted = true;
    else if (char === ",") { row.push(value); value = ""; }
    else if (char === "\n") { row.push(value); rows.push(row); row = []; value = ""; }
    else if (char !== "\r") value += char;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

function assign(stats: Record<string, number>, key: string, value: number): void {
  if (Number.isFinite(value)) stats[key] = value;
}

function number(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanCell(value: unknown): string {
  return String(value ?? "").replace(/\u00c2/g, "").replace(/\u00a0/g, "").trim();
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/[^a-z0-9]/g, "");
}

function normalizePosition(value: unknown): string {
  const position = String(value ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  if (!["QB", "RB", "WR", "TE", "K", "DST"].includes(position)) {
    throw new ApiException(400, "invalid_position", "FantasyPros projection position must be QB, RB, WR, TE, K, or DST.");
  }
  return position;
}
