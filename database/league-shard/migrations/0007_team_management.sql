create table if not exists lineup_periods (
  lineup_period_id text primary key,
  league_season_id text not null references league_seasons(league_season_id),
  fantasy_team_id text not null references fantasy_teams(fantasy_team_id),
  week_number integer not null,
  revision_number integer not null default 1,
  updated_by_user_id text not null,
  updated_at_utc text not null,
  unique (league_season_id, fantasy_team_id, week_number)
);

create table if not exists lineup_assignments (
  lineup_assignment_id text primary key,
  lineup_period_id text not null references lineup_periods(lineup_period_id),
  fantasy_roster_player_id text not null references fantasy_roster_players(fantasy_roster_player_id),
  slot_type text not null,
  slot_index integer not null,
  assigned_at_utc text not null,
  locked_at_utc text,
  unique (lineup_period_id, fantasy_roster_player_id),
  unique (lineup_period_id, slot_type, slot_index)
);

create table if not exists lineup_revisions (
  lineup_revision_id text primary key,
  lineup_period_id text not null references lineup_periods(lineup_period_id),
  revision_number integer not null,
  actor_user_id text not null,
  reason text not null,
  assignments_json text not null,
  created_at_utc text not null,
  unique (lineup_period_id, revision_number)
);

create table if not exists player_watchlists (
  player_watchlist_id text primary key,
  league_season_id text not null references league_seasons(league_season_id),
  user_id text not null,
  nfl_player_id text not null,
  created_at_utc text not null,
  unique (league_season_id, user_id, nfl_player_id)
);

create index if not exists idx_lineup_period_team_week
  on lineup_periods(fantasy_team_id, week_number);
create index if not exists idx_lineup_assignments_period_slot
  on lineup_assignments(lineup_period_id, slot_type, slot_index);
create index if not exists idx_lineup_revisions_period
  on lineup_revisions(lineup_period_id, revision_number desc);
create index if not exists idx_watchlist_user
  on player_watchlists(league_season_id, user_id, created_at_utc desc);
