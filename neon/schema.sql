-- ====================================================================
-- NEON POSTGRES SCHEMA & HELPER FUNCTIONS
-- Project: Bounty Hunter To-Do List Progressive Web App
-- Features: Daily Tasks, Bonus Pool, Recurring Tasks, User Settings & Functions
-- Auth: Links user_id to neon_auth.user(id)
-- ====================================================================

-- 1. Create Daily Tasks Table
create table if not exists public.daily_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references neon_auth."user"(id) on delete cascade,
  title text not null,
  notes text,
  color text,
  completed boolean not null default false,
  order_index integer not null default 0,
  date_assigned date not null default current_date,
  created_at timestamptz not null default timezone('utc'::text, now()),
  is_bonus boolean default false,
  bounty_started_at timestamptz,
  bounty_earned integer,
  bounty_amount integer default 100,
  completed_at timestamptz
);

-- 2. Create Bonus Pool Tasks Table
create table if not exists public.pool_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references neon_auth."user"(id) on delete cascade,
  title text not null,
  notes text,
  color text,
  bounty_amount integer default 10,
  created_at timestamptz not null default timezone('utc'::text, now())
);

alter table public.pool_tasks add column if not exists bounty_amount integer default 10;

-- 3. Create Recurring Tasks Table
create table if not exists public.recurring_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references neon_auth."user"(id) on delete cascade,
  title text not null,
  notes text,
  color text,
  frequency text not null check (frequency in ('daily', 'weekly')),
  day_of_week integer check (day_of_week between 0 and 6),
  created_at timestamptz not null default timezone('utc'::text, now())
);

-- 4. Create User Settings Table
create table if not exists public.user_settings (
  user_id uuid primary key references neon_auth."user"(id) on delete cascade,
  reset_time text not null default '04:00',
  last_reset_date date,
  day_ended_date date,
  total_bounty_claimed integer not null default 0,
  updated_at timestamptz not null default timezone('utc'::text, now())
);

alter table public.user_settings add column if not exists total_bounty_claimed integer not null default 0;

-- 5. Indexes for Fast Filtering & Ordering
create index if not exists idx_daily_tasks_user_date on public.daily_tasks(user_id, date_assigned, order_index);
create index if not exists idx_pool_tasks_user on public.pool_tasks(user_id);
create index if not exists idx_recurring_tasks_user on public.recurring_tasks(user_id);
