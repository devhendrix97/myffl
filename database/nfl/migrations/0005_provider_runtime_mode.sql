create table if not exists provider_runtime_mode (
  sport_key text primary key,
  mode text not null check (mode in ('live', 'replay')),
  active_simulation_run_id text references simulation_runs(simulation_run_id),
  revision_number integer not null default 1,
  updated_by_user_id text not null,
  updated_at_utc text not null,
  check (
    (mode = 'live' and active_simulation_run_id is null) or
    (mode = 'replay' and active_simulation_run_id is not null)
  )
);

insert or ignore into provider_runtime_mode
  (sport_key, mode, active_simulation_run_id, revision_number, updated_by_user_id, updated_at_utc)
values ('nfl', 'live', null, 1, 'system', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
