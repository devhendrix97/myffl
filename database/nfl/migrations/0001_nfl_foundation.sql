create table if not exists nfl_teams (
  nfl_team_id text primary key,
  provider text not null,
  provider_team_id text not null,
  abbreviation text not null,
  display_name text not null,
  created_at_utc text not null,
  updated_at_utc text not null,
  unique(provider, provider_team_id)
);

create table if not exists nfl_players (
  nfl_player_id text primary key,
  display_name text not null,
  position text,
  current_team_id text,
  created_at_utc text not null,
  updated_at_utc text not null
);

create table if not exists provider_player_mappings (
  provider text not null,
  provider_player_id text not null,
  nfl_player_id text not null references nfl_players(nfl_player_id),
  created_at_utc text not null,
  primary key(provider, provider_player_id)
);

create table if not exists nfl_events (
  nfl_event_id text primary key,
  provider text not null,
  provider_event_id text not null,
  season_year integer not null,
  season_type integer not null,
  week integer not null,
  starts_at_utc text not null,
  status text not null,
  created_at_utc text not null,
  updated_at_utc text not null,
  unique(provider, provider_event_id)
);

create table if not exists provider_raw_archives (
  provider_raw_archive_id text primary key,
  provider text not null,
  provider_resource text not null,
  provider_resource_id text not null,
  r2_object_key text not null,
  parser_version text not null,
  captured_at_utc text not null
);

