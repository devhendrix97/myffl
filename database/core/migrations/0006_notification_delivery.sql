alter table notifications add column delivery_key text;
alter table notifications add column in_app_visible integer not null default 1 check (in_app_visible in (0,1));
create unique index if not exists idx_notifications_delivery_key on notifications(delivery_key) where delivery_key is not null;
