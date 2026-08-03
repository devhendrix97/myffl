create table if not exists league_schedules (
  league_schedule_id text primary key,
  league_season_id text not null references league_seasons(league_season_id),
  week_number integer not null,
  schedule_type text not null default 'regular' check (schedule_type in ('regular','playoff','consolation','third-place')),
  generated_at_utc text not null,
  revision_number integer not null default 1,
  unique (league_season_id, week_number)
);

create table if not exists matchups (
  matchup_id text primary key,
  league_schedule_id text not null references league_schedules(league_schedule_id),
  league_season_id text not null references league_seasons(league_season_id),
  week_number integer not null,
  matchup_number integer not null,
  status text not null default 'scheduled' check (status in ('scheduled','live','final','corrected')),
  data_scope text not null default 'production',
  revision_number integer not null default 1,
  updated_at_utc text not null,
  finalized_at_utc text,
  unique (league_season_id, week_number, matchup_number)
);

create table if not exists matchup_teams (
  matchup_team_id text primary key,
  matchup_id text not null references matchups(matchup_id),
  fantasy_team_id text not null references fantasy_teams(fantasy_team_id),
  side text not null check (side in ('home','away','bye')),
  score_milli integer not null default 0,
  bench_points_milli integer not null default 0,
  projected_score_milli integer not null default 0,
  win_probability_milli integer not null default 500,
  remaining_players integer not null default 0,
  result text check (result in ('win','loss','tie')),
  revision_number integer not null default 1,
  updated_at_utc text not null,
  unique (matchup_id, fantasy_team_id),
  unique (matchup_id, side)
);

create table if not exists matchup_score_history (
  matchup_score_history_id text primary key,
  matchup_id text not null references matchups(matchup_id),
  matchup_revision_number integer not null,
  home_score_milli integer not null,
  away_score_milli integer not null,
  home_projection_milli integer not null,
  away_projection_milli integer not null,
  data_scope text not null,
  reason text not null,
  recorded_at_utc text not null,
  unique (matchup_id, matchup_revision_number)
);

create table if not exists standings (
  standing_id text primary key,
  league_season_id text not null references league_seasons(league_season_id),
  fantasy_team_id text not null references fantasy_teams(fantasy_team_id),
  rank_number integer not null,
  wins integer not null default 0,
  losses integer not null default 0,
  ties integer not null default 0,
  points_for_milli integer not null default 0,
  points_against_milli integer not null default 0,
  division_wins integer not null default 0,
  division_losses integer not null default 0,
  division_ties integer not null default 0,
  all_play_wins integer not null default 0,
  all_play_losses integer not null default 0,
  bench_points_milli integer not null default 0,
  streak_type text,
  streak_count integer not null default 0,
  playoff_status text not null default 'alive' check (playoff_status in ('alive','clinched','eliminated','champion')),
  revision_number integer not null default 1,
  updated_at_utc text not null,
  unique (league_season_id, fantasy_team_id),
  unique (league_season_id, rank_number)
);

create table if not exists standing_snapshots (
  standing_snapshot_id text primary key,
  league_season_id text not null references league_seasons(league_season_id),
  week_number integer not null,
  revision_number integer not null,
  standings_json text not null,
  created_at_utc text not null,
  unique (league_season_id, week_number, revision_number)
);

create table if not exists playoff_brackets (
  playoff_bracket_id text primary key,
  league_season_id text not null references league_seasons(league_season_id),
  bracket_type text not null check (bracket_type in ('championship','consolation')),
  status text not null default 'pending' check (status in ('pending','active','completed')),
  revision_number integer not null default 1,
  generated_at_utc text not null,
  completed_at_utc text,
  unique (league_season_id, bracket_type)
);

create table if not exists playoff_rounds (
  playoff_round_id text primary key,
  playoff_bracket_id text not null references playoff_brackets(playoff_bracket_id),
  round_number integer not null,
  display_name text not null,
  start_week integer not null,
  week_count integer not null default 1,
  reseed integer not null default 0,
  status text not null default 'pending' check (status in ('pending','active','completed')),
  unique (playoff_bracket_id, round_number)
);

create table if not exists playoff_matchups (
  playoff_matchup_id text primary key,
  playoff_round_id text not null references playoff_rounds(playoff_round_id),
  matchup_number integer not null,
  higher_seed integer,
  lower_seed integer,
  higher_fantasy_team_id text references fantasy_teams(fantasy_team_id),
  lower_fantasy_team_id text references fantasy_teams(fantasy_team_id),
  higher_score_milli integer not null default 0,
  lower_score_milli integer not null default 0,
  winner_fantasy_team_id text references fantasy_teams(fantasy_team_id),
  source_higher text,
  source_lower text,
  revision_number integer not null default 1,
  updated_at_utc text not null,
  unique (playoff_round_id, matchup_number)
);

create table if not exists realtime_event_log (
  realtime_event_id text primary key,
  league_id text not null references leagues(league_id),
  league_season_id text references league_seasons(league_season_id),
  channel text not null,
  event_type text not null,
  entity_id text,
  source_revision integer,
  payload_json text not null,
  data_scope text not null,
  created_at_utc text not null
);

create index if not exists idx_matchups_week on matchups(league_season_id, week_number, matchup_number);
create index if not exists idx_matchup_teams_team on matchup_teams(fantasy_team_id, matchup_id);
create index if not exists idx_matchup_history_recent on matchup_score_history(matchup_id, matchup_revision_number desc);
create index if not exists idx_standings_rank on standings(league_season_id, rank_number);
create index if not exists idx_playoff_rounds_order on playoff_rounds(playoff_bracket_id, round_number);
create index if not exists idx_realtime_event_channel on realtime_event_log(channel, created_at_utc desc);
