create table if not exists transaction_settings (
  transaction_setting_id text primary key,
  league_season_id text not null unique references league_seasons(league_season_id),
  acquisition_mode text not null default 'waivers' check (acquisition_mode in ('free-agent','waivers','faab')),
  faab_budget_milli integer not null default 100000,
  minimum_bid_milli integer not null default 0,
  waiver_period_hours integer not null default 24,
  waiver_tiebreaker text not null default 'rolling-priority' check (waiver_tiebreaker in ('rolling-priority','reverse-standings','submission-time')),
  trade_deadline_week integer not null default 11,
  trade_review_mode text not null default 'commissioner' check (trade_review_mode in ('none','commissioner','league-vote')),
  trade_review_hours integer not null default 24,
  veto_threshold integer not null default 4,
  draft_pick_trading_enabled integer not null default 1,
  faab_trading_enabled integer not null default 1,
  revision_number integer not null default 1,
  updated_by_user_id text not null,
  updated_at_utc text not null
);

create table if not exists team_transaction_balances (
  team_transaction_balance_id text primary key,
  league_season_id text not null references league_seasons(league_season_id),
  fantasy_team_id text not null references fantasy_teams(fantasy_team_id),
  faab_remaining_milli integer not null,
  waiver_priority integer not null,
  revision_number integer not null default 1,
  updated_at_utc text not null,
  unique (league_season_id, fantasy_team_id),
  unique (league_season_id, waiver_priority)
);

create table if not exists transactions (
  transaction_id text primary key,
  league_season_id text not null references league_seasons(league_season_id),
  fantasy_team_id text references fantasy_teams(fantasy_team_id),
  transaction_type text not null check (transaction_type in ('add','drop','add-drop','waiver','trade','commissioner')),
  status text not null check (status in ('pending','succeeded','failed','cancelled','reversed')),
  source_entity_type text,
  source_entity_id text,
  actor_user_id text,
  failure_reason text,
  metadata_json text not null default '{}',
  revision_number integer not null default 1,
  created_at_utc text not null,
  processed_at_utc text
);

create table if not exists transaction_assets (
  transaction_asset_id text primary key,
  transaction_id text not null references transactions(transaction_id),
  fantasy_team_id text references fantasy_teams(fantasy_team_id),
  asset_type text not null check (asset_type in ('player','draft-pick','faab')),
  asset_id text,
  direction text not null check (direction in ('acquired','released')),
  amount_milli integer,
  metadata_json text not null default '{}'
);

create table if not exists waiver_periods (
  waiver_period_id text primary key,
  league_season_id text not null references league_seasons(league_season_id),
  period_number integer not null,
  opens_at_utc text not null,
  processes_at_utc text not null,
  status text not null check (status in ('open','processing','processed','cancelled')),
  revision_number integer not null default 1,
  created_at_utc text not null,
  processed_at_utc text,
  unique (league_season_id, period_number)
);

create table if not exists waiver_claim_groups (
  waiver_claim_group_id text primary key,
  waiver_period_id text not null references waiver_periods(waiver_period_id),
  fantasy_team_id text not null references fantasy_teams(fantasy_team_id),
  user_id text not null,
  revision_number integer not null default 1,
  submitted_at_utc text not null,
  unique (waiver_period_id, fantasy_team_id)
);

create table if not exists waiver_claims (
  waiver_claim_id text primary key,
  waiver_claim_group_id text not null references waiver_claim_groups(waiver_claim_group_id),
  add_nfl_player_id text not null,
  conditional_drop_roster_player_id text references fantasy_roster_players(fantasy_roster_player_id),
  bid_milli integer not null default 0,
  claim_order integer not null,
  priority_snapshot integer not null,
  status text not null check (status in ('pending','succeeded','failed','cancelled')),
  failure_reason text,
  transaction_id text references transactions(transaction_id),
  submitted_at_utc text not null,
  processed_at_utc text,
  revision_number integer not null default 1,
  unique (waiver_claim_group_id, claim_order)
);

create table if not exists trades (
  trade_id text primary key,
  league_season_id text not null references league_seasons(league_season_id),
  parent_trade_id text references trades(trade_id),
  proposed_by_team_id text not null references fantasy_teams(fantasy_team_id),
  status text not null check (status in ('draft','proposed','countered','accepted','rejected','cancelled','expired','under-review','vetoed','approved','processed','failed')),
  message text,
  expires_at_utc text not null,
  review_ends_at_utc text,
  revision_number integer not null default 1,
  created_by_user_id text not null,
  created_at_utc text not null,
  updated_at_utc text not null,
  processed_at_utc text,
  failure_reason text
);

create table if not exists trade_teams (
  trade_team_id text primary key,
  trade_id text not null references trades(trade_id),
  fantasy_team_id text not null references fantasy_teams(fantasy_team_id),
  response_status text not null default 'pending' check (response_status in ('pending','accepted','rejected')),
  responded_by_user_id text,
  responded_at_utc text,
  unique (trade_id, fantasy_team_id)
);

create table if not exists trade_assets (
  trade_asset_id text primary key,
  trade_id text not null references trades(trade_id),
  from_fantasy_team_id text not null references fantasy_teams(fantasy_team_id),
  to_fantasy_team_id text not null references fantasy_teams(fantasy_team_id),
  asset_type text not null check (asset_type in ('player','draft-pick','faab')),
  asset_id text,
  amount_milli integer,
  metadata_json text not null default '{}'
);

create table if not exists trade_votes (
  trade_vote_id text primary key,
  trade_id text not null references trades(trade_id),
  fantasy_team_id text not null references fantasy_teams(fantasy_team_id),
  user_id text not null,
  vote text not null check (vote in ('approve','veto')),
  created_at_utc text not null,
  unique (trade_id, fantasy_team_id)
);

create table if not exists traded_draft_picks (
  traded_draft_pick_id text primary key,
  league_season_id text not null references league_seasons(league_season_id),
  draft_season_year integer not null,
  round_number integer not null,
  original_fantasy_team_id text not null references fantasy_teams(fantasy_team_id),
  current_fantasy_team_id text not null references fantasy_teams(fantasy_team_id),
  source_trade_id text references trades(trade_id),
  revision_number integer not null default 1,
  updated_at_utc text not null,
  unique (league_season_id, draft_season_year, round_number, original_fantasy_team_id)
);

create index if not exists idx_transactions_season_recent on transactions(league_season_id, created_at_utc desc);
create index if not exists idx_transaction_assets_transaction on transaction_assets(transaction_id);
create index if not exists idx_waiver_period_due on waiver_periods(status, processes_at_utc);
create index if not exists idx_waiver_claim_processing on waiver_claims(status, priority_snapshot, bid_milli desc, submitted_at_utc);
create index if not exists idx_trades_season_recent on trades(league_season_id, updated_at_utc desc);
create index if not exists idx_trade_assets_trade on trade_assets(trade_id);
