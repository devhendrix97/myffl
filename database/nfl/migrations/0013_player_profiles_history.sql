alter table nfl_players add column season_outlook text;

create table if not exists player_season_stats (
  provider text not null,
  season_year integer not null,
  provider_player_id text not null,
  nfl_player_id text references nfl_players(nfl_player_id),
  display_name text not null,
  team_id text references nfl_teams(nfl_team_id),
  position text,
  stats_json text not null,
  source_updated_at_utc text not null,
  fetched_at_utc text not null,
  primary key(provider, season_year, provider_player_id)
);

create index if not exists idx_player_season_stats_player
  on player_season_stats(nfl_player_id, season_year desc);
