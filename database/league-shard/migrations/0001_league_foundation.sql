create table if not exists leagues (
  league_id text primary key,
  league_name text not null,
  description text,
  privacy text not null,
  created_at_utc text not null,
  updated_at_utc text not null,
  archived_at_utc text,
  revision_number integer not null default 1
);

create table if not exists league_seasons (
  league_season_id text primary key,
  league_id text not null references leagues(league_id),
  season_year integer not null,
  status text not null,
  scoring_version_id text,
  created_at_utc text not null,
  updated_at_utc text not null,
  unique(league_id, season_year)
);

create table if not exists league_members (
  league_member_id text primary key,
  league_id text not null references leagues(league_id),
  user_id text not null,
  role text not null,
  joined_at_utc text not null,
  removed_at_utc text,
  unique(league_id, user_id)
);

create table if not exists fantasy_teams (
  fantasy_team_id text primary key,
  league_season_id text not null references league_seasons(league_season_id),
  manager_user_id text not null,
  team_name text not null,
  created_at_utc text not null,
  updated_at_utc text not null
);

create table if not exists scoring_versions (
  scoring_version_id text primary key,
  league_season_id text not null references league_seasons(league_season_id),
  version_number integer not null,
  status text not null,
  effective_at_utc text not null,
  created_by_user_id text not null,
  created_at_utc text not null,
  unique(league_season_id, version_number)
);

create table if not exists scoring_rules (
  scoring_rule_id text primary key,
  scoring_version_id text not null references scoring_versions(scoring_version_id),
  statistic_key text not null,
  enabled integer not null,
  calculation_type text not null,
  point_value_milli integer not null,
  increment_value text,
  threshold_value text,
  position_filter text,
  max_awards integer,
  display_order integer not null
);

create table if not exists league_audit_events (
  league_audit_event_id text primary key,
  league_id text not null references leagues(league_id),
  actor_user_id text,
  action text not null,
  entity_type text not null,
  entity_id text,
  correlation_id text not null,
  created_at_utc text not null,
  metadata_json text not null
);

create index if not exists idx_league_members_user_id on league_members(user_id);
create index if not exists idx_scoring_rules_version on scoring_rules(scoring_version_id);

