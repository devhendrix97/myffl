create table if not exists player_projections (
  provider text not null,
  season_year integer not null,
  projection_type text not null check (projection_type in ('season','weekly')),
  week_number integer not null default 0,
  provider_player_id text not null,
  nfl_player_id text references nfl_players(nfl_player_id),
  display_name text not null,
  team_id text references nfl_teams(nfl_team_id),
  position text,
  projected_stats_json text not null,
  source_updated_at_utc text not null,
  fetched_at_utc text not null,
  primary key(provider, season_year, projection_type, week_number, provider_player_id)
);

create index if not exists idx_player_projections_player
  on player_projections(nfl_player_id, season_year, projection_type, week_number);

create index if not exists idx_player_projections_week
  on player_projections(provider, season_year, projection_type, week_number, position);
