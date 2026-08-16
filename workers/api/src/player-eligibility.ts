export const FANTASY_PLAYER_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST", "DL", "LB", "DB"] as const;

export function fantasyPositionSql(column = "players.position"): string {
  return `${column} in (${FANTASY_PLAYER_POSITIONS.map((position) => `'${position}'`).join(",")})`;
}

export function isFantasyPosition(position: string | null | undefined): boolean {
  return Boolean(position && (FANTASY_PLAYER_POSITIONS as readonly string[]).includes(position));
}
