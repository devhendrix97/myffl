create table if not exists fantasypros_daily_budgets (
  request_date text primary key,
  attempts integer not null check (attempts between 0 and 8),
  updated_at_utc text not null
);
