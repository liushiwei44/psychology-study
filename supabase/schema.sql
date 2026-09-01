-- 心理咨询师备考台：每位用户一行学习状态。
-- 在 Supabase Dashboard -> SQL Editor 中完整执行本文件。

create table if not exists public.study_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  progress jsonb not null default '{"version":1,"attempts":{},"daily":{},"mockHistory":[],"settings":{"dailyTarget":50}}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.study_states enable row level security;

revoke all on table public.study_states from anon, authenticated;
grant select, insert, update, delete on table public.study_states to authenticated;

drop policy if exists "Users can read their own study state" on public.study_states;
create policy "Users can read their own study state"
on public.study_states for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own study state" on public.study_states;
create policy "Users can create their own study state"
on public.study_states for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own study state" on public.study_states;
create policy "Users can update their own study state"
on public.study_states for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own study state" on public.study_states;
create policy "Users can delete their own study state"
on public.study_states for delete
to authenticated
using ((select auth.uid()) = user_id);

