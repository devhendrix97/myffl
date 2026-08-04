create table if not exists player_aliases (
  player_alias_id text primary key,
  nfl_player_id text not null references nfl_players(nfl_player_id),
  alias text not null,
  alias_normalized text not null,
  created_by_user_id text not null,
  created_at_utc text not null,
  unique (nfl_player_id,alias_normalized)
);

alter table nfl_players add column merged_into_player_id text;

create table if not exists nfl_event_admin_actions (
  nfl_event_admin_action_id text primary key,
  nfl_event_id text not null references nfl_events(nfl_event_id),
  action text not null,
  reason text not null,
  previous_status text,
  resulting_status text,
  actor_user_id text not null,
  correlation_id text not null,
  created_at_utc text not null
);

create index if not exists idx_player_alias_normalized on player_aliases(alias_normalized);
create index if not exists idx_event_admin_actions_recent on nfl_event_admin_actions(nfl_event_id,created_at_utc desc);
