create table if not exists league_messages (
  league_message_id text primary key,
  league_id text not null references leagues(league_id),
  league_season_id text references league_seasons(league_season_id),
  channel text not null default 'league' check (channel in ('league','draft')),
  author_user_id text not null,
  message_type text not null default 'text' check (message_type in ('text','image','gif','poll','announcement')),
  body text not null default '',
  attachment_key text,
  attachment_url text,
  reply_to_message_id text references league_messages(league_message_id),
  pinned integer not null default 0 check (pinned in (0,1)),
  revision_number integer not null default 1,
  created_at_utc text not null,
  edited_at_utc text,
  deleted_at_utc text
);

create table if not exists direct_messages (
  direct_message_id text primary key,
  league_id text not null references leagues(league_id),
  sender_user_id text not null,
  recipient_user_id text not null,
  body text not null,
  revision_number integer not null default 1,
  created_at_utc text not null,
  edited_at_utc text,
  deleted_at_utc text
);

create table if not exists message_reactions (
  league_message_id text not null references league_messages(league_message_id),
  user_id text not null,
  reaction text not null,
  created_at_utc text not null,
  primary key (league_message_id,user_id,reaction)
);

create table if not exists polls (
  poll_id text primary key,
  league_message_id text not null unique references league_messages(league_message_id),
  question text not null,
  allows_multiple integer not null default 0 check (allows_multiple in (0,1)),
  closes_at_utc text,
  created_at_utc text not null
);

create table if not exists poll_options (
  poll_option_id text primary key,
  poll_id text not null references polls(poll_id),
  display_text text not null,
  display_order integer not null,
  unique (poll_id,display_order)
);

create table if not exists poll_votes (
  poll_option_id text not null references poll_options(poll_option_id),
  user_id text not null,
  created_at_utc text not null,
  primary key (poll_option_id,user_id)
);

create table if not exists message_mentions (
  league_message_id text not null references league_messages(league_message_id),
  mentioned_user_id text not null,
  created_at_utc text not null,
  primary key (league_message_id,mentioned_user_id)
);

create table if not exists message_read_state (
  league_id text not null references leagues(league_id),
  channel text not null check (channel in ('league','draft')),
  user_id text not null,
  last_read_message_id text references league_messages(league_message_id),
  read_at_utc text not null,
  primary key (league_id,channel,user_id)
);

create table if not exists weekly_reports (
  weekly_report_id text primary key,
  league_id text not null references leagues(league_id),
  league_season_id text not null references league_seasons(league_season_id),
  week_number integer not null,
  status text not null default 'published' check (status in ('draft','published')),
  report_json text not null,
  generated_at_utc text not null,
  published_at_utc text,
  revision_number integer not null default 1,
  unique (league_season_id,week_number)
);

create index if not exists idx_league_messages_recent on league_messages(league_id,channel,created_at_utc desc);
create index if not exists idx_direct_messages_recent on direct_messages(league_id,sender_user_id,recipient_user_id,created_at_utc desc);
create index if not exists idx_message_reactions_message on message_reactions(league_message_id);
create index if not exists idx_poll_votes_option on poll_votes(poll_option_id);
create index if not exists idx_weekly_reports_week on weekly_reports(league_season_id,week_number desc);
