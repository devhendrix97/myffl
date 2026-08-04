create table if not exists user_login_events (
  user_login_event_id text primary key,
  user_id text not null references users(user_id),
  client_type text not null,
  ip_address text,
  user_agent text,
  succeeded integer not null default 1 check (succeeded in (0,1)),
  created_at_utc text not null
);

create table if not exists admin_jobs (
  admin_job_id text primary key,
  job_type text not null,
  entity_type text not null,
  entity_id text,
  status text not null check (status in ('queued','running','succeeded','failed')),
  requested_by_user_id text not null references users(user_id),
  correlation_id text not null,
  request_json text not null,
  result_json text,
  error_message text,
  created_at_utc text not null,
  started_at_utc text,
  completed_at_utc text
);

create index if not exists idx_login_events_user_recent on user_login_events(user_id,created_at_utc desc);
create index if not exists idx_admin_jobs_recent on admin_jobs(status,created_at_utc desc);
