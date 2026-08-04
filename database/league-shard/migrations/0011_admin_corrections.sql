create table if not exists admin_score_corrections (
  admin_score_correction_id text primary key,
  league_id text not null references leagues(league_id),
  league_season_id text not null references league_seasons(league_season_id),
  nfl_event_id text not null,
  nfl_player_id text not null,
  data_scope text not null,
  previous_points_milli integer not null,
  corrected_points_milli integer not null,
  reason text not null,
  status text not null check (status in ('applied','reverted')),
  actor_user_id text not null,
  correlation_id text not null,
  applied_at_utc text not null,
  reverted_at_utc text,
  reverted_by_user_id text
);

create index if not exists idx_admin_corrections_lookup on admin_score_corrections(league_id,league_season_id,nfl_event_id,nfl_player_id,applied_at_utc desc);
