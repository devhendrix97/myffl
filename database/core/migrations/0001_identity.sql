create table if not exists users (
  user_id text primary key,
  email text not null,
  email_normalized text not null unique,
  password_hash text not null,
  email_verified_at_utc text,
  created_at_utc text not null,
  updated_at_utc text not null,
  status text not null check (status in ('active', 'disabled', 'deleted'))
);

create table if not exists user_profiles (
  user_id text primary key references users(user_id),
  display_name text not null,
  profile_image_object_key text,
  created_at_utc text not null,
  updated_at_utc text not null
);

create table if not exists refresh_tokens (
  refresh_token_id text primary key,
  user_id text not null references users(user_id),
  token_hash text not null unique,
  created_at_utc text not null,
  expires_at_utc text not null,
  revoked_at_utc text,
  replaced_by_token_id text
);

create table if not exists email_verifications (
  email_verification_id text primary key,
  user_id text not null references users(user_id),
  token_hash text not null unique,
  created_at_utc text not null,
  expires_at_utc text not null,
  completed_at_utc text
);

create table if not exists password_reset_requests (
  password_reset_request_id text primary key,
  user_id text not null references users(user_id),
  token_hash text not null unique,
  created_at_utc text not null,
  expires_at_utc text not null,
  completed_at_utc text
);

create table if not exists league_directory (
  league_id text primary key,
  league_name text not null,
  current_season_id text,
  shard_key text not null,
  shard_binding_name text not null,
  league_status text not null,
  created_at_utc text not null,
  archived_at_utc text,
  revision_number integer not null default 1
);

create table if not exists database_shards (
  database_shard_id text primary key,
  shard_key text not null unique,
  binding_name text not null unique,
  shard_type text not null,
  status text not null,
  accepts_new_leagues integer not null,
  schema_version integer not null,
  estimated_storage_bytes integer not null default 0,
  league_count integer not null default 0,
  created_at_utc text not null,
  updated_at_utc text not null
);

create table if not exists audit_events (
  audit_event_id text primary key,
  actor_user_id text,
  action text not null,
  entity_type text not null,
  entity_id text,
  correlation_id text not null,
  created_at_utc text not null,
  metadata_json text not null
);

create index if not exists idx_users_email_normalized on users(email_normalized);
create index if not exists idx_refresh_tokens_user_id on refresh_tokens(user_id);
create index if not exists idx_audit_events_created_at on audit_events(created_at_utc);

