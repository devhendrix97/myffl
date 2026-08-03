create table if not exists platform_admins (
  user_id text primary key references users(user_id),
  admin_role text not null check (admin_role in ('owner', 'operator', 'support')),
  active integer not null default 1 check (active in (0, 1)),
  created_by_user_id text references users(user_id),
  created_at_utc text not null,
  updated_at_utc text not null
);

create index if not exists idx_platform_admins_active
  on platform_admins(active, admin_role);
