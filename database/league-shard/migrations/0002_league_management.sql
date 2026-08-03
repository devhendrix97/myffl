alter table leagues add column logo_object_key text;
alter table leagues add column league_format text not null default 'redraft';
alter table leagues add column time_zone text not null default 'America/Chicago';
alter table leagues add column max_teams integer not null default 12;
alter table leagues add column commissioner_user_id text;
alter table leagues add column maintenance_mode integer not null default 0;

alter table league_seasons add column regular_season_weeks integer not null default 14;
alter table league_seasons add column playoff_team_count integer not null default 6;
alter table league_seasons add column playoff_start_week integer not null default 15;
alter table league_seasons add column revision_number integer not null default 1;

alter table league_members add column status text not null default 'active';
alter table league_members add column invited_by_user_id text;
alter table league_members add column updated_at_utc text;
alter table league_members add column revision_number integer not null default 1;

alter table fantasy_teams add column abbreviation text;
alter table fantasy_teams add column revision_number integer not null default 1;

create table if not exists league_invitations (
  league_invitation_id text primary key,
  league_id text not null references leagues(league_id),
  code_hash text not null unique,
  created_by_user_id text not null,
  created_at_utc text not null,
  expires_at_utc text,
  revoked_at_utc text,
  max_uses integer,
  use_count integer not null default 0
);

create table if not exists league_settings (
  league_setting_id text primary key,
  league_id text not null references leagues(league_id),
  setting_key text not null,
  value_json text not null,
  revision_number integer not null default 1,
  updated_by_user_id text not null,
  updated_at_utc text not null,
  unique(league_id, setting_key)
);

create table if not exists roster_definitions (
  roster_definition_id text primary key,
  league_season_id text not null references league_seasons(league_season_id),
  name text not null,
  revision_number integer not null default 1,
  created_at_utc text not null,
  updated_at_utc text not null,
  unique(league_season_id, name)
);

create table if not exists roster_slots (
  roster_slot_id text primary key,
  roster_definition_id text not null references roster_definitions(roster_definition_id),
  slot_type text not null,
  display_name text not null,
  slot_count integer not null,
  eligible_positions_json text not null,
  contributes_points integer not null,
  lock_behavior text not null,
  injury_eligibility text,
  display_order integer not null
);

create table if not exists schedule_settings (
  schedule_setting_id text primary key,
  league_season_id text not null unique references league_seasons(league_season_id),
  regular_season_start_week integer not null,
  regular_season_end_week integer not null,
  schedule_method text not null,
  rivalry_weeks_json text not null,
  playoff_team_count integer not null,
  playoff_start_week integer not null,
  playoff_round_length integer not null,
  reseed integer not null,
  consolation_bracket integer not null,
  third_place_matchup integer not null,
  tiebreakers_json text not null,
  revision_number integer not null default 1,
  updated_at_utc text not null
);

create table if not exists fantasy_team_seasons (
  fantasy_team_season_id text primary key,
  fantasy_team_id text not null references fantasy_teams(fantasy_team_id),
  league_season_id text not null references league_seasons(league_season_id),
  status text not null,
  created_at_utc text not null,
  unique(fantasy_team_id, league_season_id)
);

create table if not exists fantasy_team_managers (
  fantasy_team_manager_id text primary key,
  fantasy_team_id text not null references fantasy_teams(fantasy_team_id),
  user_id text not null,
  manager_role text not null,
  assigned_at_utc text not null,
  removed_at_utc text,
  unique(fantasy_team_id, user_id)
);

create table if not exists league_activity (
  league_activity_id text primary key,
  league_id text not null references leagues(league_id),
  actor_user_id text,
  activity_type text not null,
  message text not null,
  created_at_utc text not null,
  metadata_json text not null
);

create index if not exists idx_league_members_league_status
  on league_members(league_id, status, joined_at_utc);
create index if not exists idx_league_invitations_league
  on league_invitations(league_id, revoked_at_utc, expires_at_utc);
create index if not exists idx_fantasy_teams_season
  on fantasy_teams(league_season_id, created_at_utc);
create index if not exists idx_roster_slots_definition
  on roster_slots(roster_definition_id, display_order);
create index if not exists idx_league_activity_recent
  on league_activity(league_id, created_at_utc desc);
