alter table league_directory add column commissioner_user_id text;
alter table league_directory add column privacy text not null default 'private';
alter table league_directory add column season_year integer;
alter table league_directory add column max_teams integer;
alter table league_directory add column member_count integer not null default 0;
alter table league_directory add column updated_at_utc text;

create table if not exists user_league_directory (
  user_id text not null references users(user_id),
  league_id text not null references league_directory(league_id),
  role text not null,
  fantasy_team_id text,
  joined_at_utc text not null,
  removed_at_utc text,
  primary key(user_id, league_id)
);

create table if not exists league_invitation_directory (
  invitation_id text primary key,
  league_id text not null references league_directory(league_id),
  code_hash text not null unique,
  shard_binding_name text not null,
  expires_at_utc text,
  revoked_at_utc text,
  created_at_utc text not null
);

create table if not exists league_creation_requests (
  request_id text primary key,
  user_id text not null references users(user_id),
  league_id text not null references league_directory(league_id),
  response_json text not null,
  created_at_utc text not null
);

insert or ignore into database_shards (
  database_shard_id, shard_key, binding_name, shard_type, status,
  accepts_new_leagues, schema_version, estimated_storage_bytes,
  league_count, created_at_utc, updated_at_utc
) values (
  'shard_leagues_001', 'leagues-001', 'LEAGUE_DB_001', 'league', 'active',
  1, 2, 0, 0, datetime('now'), datetime('now')
);

create index if not exists idx_user_league_directory_user
  on user_league_directory(user_id, removed_at_utc, joined_at_utc desc);
create index if not exists idx_user_league_directory_league
  on user_league_directory(league_id, removed_at_utc);
create index if not exists idx_invitation_directory_league
  on league_invitation_directory(league_id, revoked_at_utc);
create index if not exists idx_league_directory_status
  on league_directory(league_status, created_at_utc desc);
