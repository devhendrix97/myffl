create table if not exists provider_credentials (
  provider text primary key,
  encrypted_value_base64 text,
  iv_base64 text,
  key_version integer not null default 1,
  enabled integer not null default 0 check (enabled in (0,1)),
  last_four text,
  validated_at_utc text,
  created_by_user_id text not null references users(user_id),
  updated_by_user_id text not null references users(user_id),
  created_at_utc text not null,
  updated_at_utc text not null
);

create index if not exists idx_provider_credentials_enabled
  on provider_credentials(enabled,provider);
