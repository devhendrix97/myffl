alter table users add column last_login_at_utc text;
alter table users add column password_changed_at_utc text;

create index if not exists idx_refresh_tokens_active_user
  on refresh_tokens(user_id, revoked_at_utc, expires_at_utc);
create index if not exists idx_email_verifications_active_user
  on email_verifications(user_id, completed_at_utc, expires_at_utc);
create index if not exists idx_password_resets_active_user
  on password_reset_requests(user_id, completed_at_utc, expires_at_utc);
