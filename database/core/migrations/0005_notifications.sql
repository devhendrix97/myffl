create table if not exists notifications (
  notification_id text primary key,
  user_id text not null references users(user_id),
  league_id text,
  notification_type text not null,
  title text not null,
  body text not null,
  entity_type text,
  entity_id text,
  action_url text,
  created_at_utc text not null,
  read_at_utc text,
  email_delivered_at_utc text,
  desktop_delivered_at_utc text,
  browser_push_delivered_at_utc text
);

create table if not exists notification_preferences (
  user_id text not null references users(user_id),
  league_id text not null default '',
  notification_type text not null default '*',
  in_app_enabled integer not null default 1 check (in_app_enabled in (0,1)),
  email_enabled integer not null default 0 check (email_enabled in (0,1)),
  desktop_enabled integer not null default 1 check (desktop_enabled in (0,1)),
  browser_push_enabled integer not null default 0 check (browser_push_enabled in (0,1)),
  updated_at_utc text not null,
  primary key (user_id,league_id,notification_type)
);

create table if not exists push_subscriptions (
  push_subscription_id text primary key,
  user_id text not null references users(user_id),
  endpoint text not null unique,
  p256dh text not null,
  auth_secret text not null,
  user_agent text,
  created_at_utc text not null,
  last_used_at_utc text not null,
  revoked_at_utc text
);

create index if not exists idx_notifications_user_recent on notifications(user_id,created_at_utc desc);
create index if not exists idx_notifications_user_unread on notifications(user_id,read_at_utc,created_at_utc desc);
create index if not exists idx_push_subscriptions_user on push_subscriptions(user_id,revoked_at_utc);
