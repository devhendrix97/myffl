create table if not exists player_event_scores (
  league_season_id text not null references league_seasons(league_season_id),
  nfl_event_id text not null,
  nfl_player_id text not null,
  data_scope text not null,
  scoring_version_id text not null references scoring_versions(scoring_version_id),
  position text,
  total_points_milli integer not null,
  input_hash text not null,
  calculation_version text not null,
  revision_number integer not null default 1,
  source_updated_at_utc text not null,
  calculated_at_utc text not null,
  primary key (league_season_id, nfl_event_id, nfl_player_id, data_scope)
);

create table if not exists player_event_score_components (
  player_event_score_component_id text primary key,
  league_season_id text not null,
  nfl_event_id text not null,
  nfl_player_id text not null,
  data_scope text not null,
  scoring_version_id text not null,
  scoring_rule_id text not null,
  statistic_key text not null,
  display_name text not null,
  raw_value_json text not null,
  points_milli integer not null,
  explanation text not null,
  display_order integer not null,
  calculated_at_utc text not null
);

create table if not exists player_event_score_revisions (
  player_event_score_revision_id text primary key,
  league_season_id text not null,
  nfl_event_id text not null,
  nfl_player_id text not null,
  data_scope text not null,
  scoring_version_id text not null,
  revision_number integer not null,
  previous_points_milli integer,
  total_points_milli integer not null,
  input_hash text not null,
  reason text not null,
  breakdown_json text not null,
  created_at_utc text not null,
  unique (league_season_id, nfl_event_id, nfl_player_id, data_scope, revision_number)
);

create table if not exists scoring_job_receipts (
  scoring_job_key text primary key,
  job_type text not null,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  attempt_count integer not null default 1,
  event_count integer not null default 0,
  player_count integer not null default 0,
  started_at_utc text not null,
  completed_at_utc text,
  last_error text
);

create index if not exists idx_player_event_scores_event
  on player_event_scores(nfl_event_id, data_scope, league_season_id);
create index if not exists idx_score_components_player_event
  on player_event_score_components(league_season_id, nfl_event_id, nfl_player_id, data_scope, display_order);
create index if not exists idx_score_revisions_player_event
  on player_event_score_revisions(league_season_id, nfl_event_id, nfl_player_id, data_scope, revision_number desc);
