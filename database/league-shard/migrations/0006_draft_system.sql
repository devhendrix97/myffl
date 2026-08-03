create table if not exists drafts (
  draft_id text primary key,
  league_season_id text not null unique references league_seasons(league_season_id),
  draft_type text not null check (draft_type in ('snake','linear','third-round-reversal','offline')),
  status text not null check (status in ('setup','scheduled','active','paused','completed')),
  scheduled_at_utc text,
  rounds integer not null,
  pick_seconds integer not null,
  autopick_enabled integer not null default 1,
  current_overall_pick integer not null default 1,
  pick_deadline_utc text,
  revision_number integer not null default 1,
  created_by_user_id text not null,
  created_at_utc text not null,
  updated_at_utc text not null,
  started_at_utc text,
  completed_at_utc text
);

create table if not exists draft_slots (
  draft_slot_id text primary key,
  draft_id text not null references drafts(draft_id),
  slot_number integer not null,
  fantasy_team_id text not null references fantasy_teams(fantasy_team_id),
  original_fantasy_team_id text not null references fantasy_teams(fantasy_team_id),
  created_at_utc text not null,
  unique (draft_id, slot_number),
  unique (draft_id, fantasy_team_id)
);

create table if not exists draft_picks (
  draft_pick_id text primary key,
  draft_id text not null references drafts(draft_id),
  overall_pick integer not null,
  round_number integer not null,
  slot_number integer not null,
  fantasy_team_id text not null references fantasy_teams(fantasy_team_id),
  nfl_player_id text,
  selection_source text not null check (selection_source in ('manager','autopick','commissioner','offline','skip')),
  selected_by_user_id text,
  status text not null check (status in ('active','undone','replaced','skipped')),
  made_at_utc text not null,
  updated_at_utc text not null,
  revision_number integer not null default 1
);

create unique index if not exists idx_draft_picks_active_number
  on draft_picks(draft_id, overall_pick) where status in ('active','skipped');
create unique index if not exists idx_draft_picks_active_player
  on draft_picks(draft_id, nfl_player_id) where nfl_player_id is not null and status = 'active';

create table if not exists draft_queues (
  draft_queue_id text primary key,
  draft_id text not null references drafts(draft_id),
  fantasy_team_id text not null references fantasy_teams(fantasy_team_id),
  user_id text not null,
  autopick_enabled integer not null default 0,
  revision_number integer not null default 1,
  updated_at_utc text not null,
  unique (draft_id, fantasy_team_id, user_id)
);

create table if not exists draft_queue_players (
  draft_queue_player_id text primary key,
  draft_queue_id text not null references draft_queues(draft_queue_id),
  nfl_player_id text not null,
  priority integer not null,
  created_at_utc text not null,
  unique (draft_queue_id, nfl_player_id),
  unique (draft_queue_id, priority)
);

create table if not exists draft_rankings (
  draft_ranking_id text primary key,
  draft_id text not null references drafts(draft_id),
  user_id text not null,
  nfl_player_id text not null,
  rank_number integer not null,
  updated_at_utc text not null,
  unique (draft_id, user_id, nfl_player_id),
  unique (draft_id, user_id, rank_number)
);

create table if not exists fantasy_roster_players (
  fantasy_roster_player_id text primary key,
  league_season_id text not null references league_seasons(league_season_id),
  fantasy_team_id text not null references fantasy_teams(fantasy_team_id),
  nfl_player_id text not null,
  position text not null,
  roster_status text not null default 'active',
  acquisition_type text not null,
  acquisition_id text,
  acquired_at_utc text not null,
  released_at_utc text,
  revision_number integer not null default 1
);

create unique index if not exists idx_roster_active_player_league
  on fantasy_roster_players(league_season_id, nfl_player_id) where released_at_utc is null;
create index if not exists idx_roster_team_active
  on fantasy_roster_players(fantasy_team_id, released_at_utc, acquired_at_utc);

create table if not exists draft_audit_events (
  draft_audit_event_id text primary key,
  draft_id text not null references drafts(draft_id),
  actor_user_id text,
  action text not null,
  entity_type text not null,
  entity_id text,
  before_json text,
  after_json text,
  correlation_id text not null,
  created_at_utc text not null
);

create index if not exists idx_draft_slots_order on draft_slots(draft_id, slot_number);
create index if not exists idx_draft_picks_board on draft_picks(draft_id, round_number, overall_pick);
create index if not exists idx_draft_queue_priority on draft_queue_players(draft_queue_id, priority);
create index if not exists idx_draft_audit_recent on draft_audit_events(draft_id, created_at_utc desc);
