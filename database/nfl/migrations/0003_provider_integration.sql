create table if not exists provider_sync_runs (
  provider_sync_run_id text primary key,
  provider text not null,
  resource text not null,
  data_scope text not null,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  records_seen integer not null default 0,
  records_written integer not null default 0,
  warning_count integer not null default 0,
  error_message text,
  started_at_utc text not null,
  completed_at_utc text
);

create table if not exists provider_sync_state (
  provider text not null,
  resource text not null,
  data_scope text not null,
  last_success_at_utc text,
  last_attempt_at_utc text not null,
  last_status text not null,
  last_run_id text,
  last_error text,
  primary key(provider, resource, data_scope)
);

create table if not exists provider_schema_warnings (
  provider_schema_warning_id text primary key,
  provider_sync_run_id text not null references provider_sync_runs(provider_sync_run_id),
  resource text not null,
  json_path text not null,
  message text not null,
  created_at_utc text not null
);

create table if not exists nfl_team_snapshots (
  nfl_team_id text not null,
  data_scope text not null,
  abbreviation text not null,
  display_name text not null,
  logo_url text,
  color_hex text,
  alternate_color_hex text,
  active integer not null default 1,
  updated_at_utc text not null,
  primary key(nfl_team_id, data_scope)
);

create table if not exists nfl_event_snapshots (
  nfl_event_id text not null,
  data_scope text not null,
  status text not null,
  status_detail text,
  period integer not null default 0,
  clock text,
  completed integer not null default 0,
  home_team_id text,
  away_team_id text,
  home_score integer not null default 0,
  away_score integer not null default 0,
  situation_json text,
  updated_at_utc text not null,
  primary key(nfl_event_id, data_scope)
);

create table if not exists nfl_player_game_stats (
  nfl_event_id text not null,
  nfl_player_id text not null,
  data_scope text not null,
  team_id text,
  position text,
  stats_json text not null,
  source_updated_at_utc text not null,
  primary key(nfl_event_id, nfl_player_id, data_scope)
);

create table if not exists nfl_player_injuries (
  provider_injury_id text not null,
  data_scope text not null,
  nfl_player_id text not null,
  team_id text,
  status text,
  injury_type text,
  short_comment text,
  long_comment text,
  injury_date_utc text,
  updated_at_utc text not null,
  primary key(provider_injury_id, data_scope)
);

create table if not exists simulation_scenarios (
  simulation_scenario_id text primary key,
  name text not null,
  description text not null,
  frame_count integer not null,
  fixture_prefix text not null,
  created_at_utc text not null
);

create table if not exists simulation_runs (
  simulation_run_id text primary key,
  simulation_scenario_id text not null references simulation_scenarios(simulation_scenario_id),
  created_by_user_id text not null,
  status text not null check (status in ('ready', 'playing', 'paused', 'completed', 'stopped')),
  speed_multiplier integer not null default 1,
  current_frame integer not null default -1,
  simulated_at_utc text,
  created_at_utc text not null,
  updated_at_utc text not null,
  stopped_at_utc text
);

create table if not exists simulation_event_log (
  simulation_event_id text primary key,
  simulation_run_id text not null references simulation_runs(simulation_run_id),
  frame_number integer not null,
  event_type text not null,
  message text not null,
  payload_json text not null,
  created_at_utc text not null
);

create index if not exists idx_provider_sync_runs_started
  on provider_sync_runs(data_scope, started_at_utc desc);
create index if not exists idx_event_snapshots_scope
  on nfl_event_snapshots(data_scope, updated_at_utc desc);
create index if not exists idx_player_stats_scope_event
  on nfl_player_game_stats(data_scope, nfl_event_id);
create index if not exists idx_simulation_events_run
  on simulation_event_log(simulation_run_id, frame_number, created_at_utc);
