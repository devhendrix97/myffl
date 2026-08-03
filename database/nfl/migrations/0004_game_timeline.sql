create table if not exists nfl_event_plays (
  nfl_event_id text not null,
  provider_play_id text not null,
  data_scope text not null,
  sequence_number integer not null,
  drive_id text,
  team_id text,
  period integer not null,
  clock text not null,
  play_type text not null,
  play_text text not null,
  stat_yardage integer not null default 0,
  home_score integer not null default 0,
  away_score integer not null default 0,
  scoring_play integer not null default 0,
  turnover integer not null default 0,
  start_json text,
  end_json text,
  participants_json text not null default '[]',
  updated_at_utc text not null,
  primary key(nfl_event_id, provider_play_id, data_scope)
);

create index if not exists idx_event_plays_timeline
  on nfl_event_plays(data_scope, nfl_event_id, sequence_number);
