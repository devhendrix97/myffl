create table if not exists scoring_version_details (
  scoring_version_id text primary key references scoring_versions(scoring_version_id),
  source_preset_key text,
  revision_number integer not null default 1,
  effective_scope text,
  effective_from_week integer,
  effective_to_week integer,
  change_reason text,
  is_current integer not null default 0,
  applied_at_utc text
);

create table if not exists scoring_rule_details (
  scoring_rule_id text primary key references scoring_rules(scoring_rule_id),
  display_name text not null,
  description text not null,
  category text not null,
  positions_json text not null default '[]',
  tiers_json text not null default '[]',
  minimum_value text,
  condition_json text not null default '{}'
);

create table if not exists scoring_rule_history (
  scoring_rule_history_id text primary key,
  scoring_version_id text not null references scoring_versions(scoring_version_id),
  scoring_rule_id text not null,
  actor_user_id text not null,
  action text not null,
  before_json text,
  after_json text,
  created_at_utc text not null
);

create index if not exists idx_scoring_versions_season_status
  on scoring_versions(league_season_id, status, version_number desc);
create index if not exists idx_scoring_version_details_current
  on scoring_version_details(is_current, scoring_version_id);
create index if not exists idx_scoring_rule_history_version
  on scoring_rule_history(scoring_version_id, created_at_utc desc);
