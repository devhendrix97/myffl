create table if not exists fantasypros_projections (
  season_year integer not null,
  projection_type text not null check (projection_type in ('season','weekly')),
  week_number integer not null default 0,
  position text not null,
  fantasypros_player_id text not null,
  nfl_player_id text references nfl_players(nfl_player_id),
  display_name text not null,
  team_abbreviation text,
  projected_stats_json text not null,
  source_updated_at text,
  fetched_at_utc text not null,
  primary key (season_year,projection_type,week_number,position,fantasypros_player_id)
);

create index if not exists idx_fantasypros_projections_player
  on fantasypros_projections(nfl_player_id,season_year,projection_type,week_number);

create index if not exists idx_fantasypros_projections_position
  on fantasypros_projections(season_year,projection_type,week_number,position);
