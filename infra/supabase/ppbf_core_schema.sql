-- PPBF Core Tables + RLS (Run this in Supabase SQL Editor)
create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'coach', 'member', 'guest')) default 'member',
  full_name text,
  created_at timestamp with time zone default now()
);

alter table public.user_profiles enable row level security;

create policy "Users can view own profile" on public.user_profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on public.user_profiles for update using (auth.uid() = id);
create policy "Admins full access" on public.user_profiles for all using (exists (select 1 from public.user_profiles where id = auth.uid() and role = 'admin'));
