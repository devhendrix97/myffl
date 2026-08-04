create table if not exists fantasypros_rankings (
  season_year integer not null,
  scoring text not null,
  fantasypros_player_id text not null,
  nfl_player_id text references nfl_players(nfl_player_id),
  display_name text not null,
  team_abbreviation text,
  position text not null,
  overall_rank integer not null,
  position_rank text,
  tier integer,
  rank_min integer,
  rank_max integer,
  rank_average real,
  rank_std_dev real,
  player_page_url text,
  source_updated_at text,
  fetched_at_utc text not null,
  primary key (season_year,scoring,fantasypros_player_id)
);

create table if not exists fantasypros_sync_runs (
  fantasypros_sync_run_id text primary key,
  request_date text not null,
  season_year integer not null,
  scoring text not null,
  position_scope text not null,
  status text not null,
  records_seen integer not null default 0,
  records_mapped integer not null default 0,
  error_message text,
  started_at_utc text not null,
  completed_at_utc text
);

create index if not exists idx_fantasypros_rankings_order
  on fantasypros_rankings(season_year,scoring,overall_rank);
create index if not exists idx_fantasypros_rankings_player
  on fantasypros_rankings(nfl_player_id,season_year,scoring);
create index if not exists idx_fantasypros_sync_daily
  on fantasypros_sync_runs(request_date,status);
