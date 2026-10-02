-- 키워드 알림: 내가 등록한 단어
create table if not exists public.keyword_alerts (
  id bigint generated always as identity primary key,
  profile_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  keyword text not null check (length(keyword) between 1 and 30),
  created_at timestamptz not null default now(),
  unique (profile_id, keyword)
);
alter table public.keyword_alerts enable row level security;
drop policy if exists keyword_alerts_owner on public.keyword_alerts;
create policy keyword_alerts_owner on public.keyword_alerts for all to authenticated
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());
