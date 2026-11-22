-- 마케팅 측정: 사이트 안 행동 기록 (가입·판매 등록·채팅 시작·업체 등록·알림 켜기·공유 …)
--   - 어느 채널(UTM·검색·카톡 공유)에서 온 사람이 무엇을 했는지 보고, 나중에 '행동별 자동 메시지'의 재료로 씀
--   - 브라우저(js/supabase-client.js 의 psTrack)가 넣기만 하고, 읽기는 운영자(service_role)만
--   - 쿠키는 쓰지 않음. 개인정보처리방침의 '접속 기록 3개월'에 맞춰 90일 지나면 자동 삭제

create table if not exists public.marketing_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  profile_id uuid default auth.uid() references public.profiles(id) on delete cascade, -- 로그인 안 했으면 비어 있음
  anon_id text check (anon_id ~ '^[a-z0-9]{8,32}$'),   -- 브라우저마다 무작위 값 (로그인 전후 행동을 이어 보기 위해)
  name text not null check (name ~ '^[a-z][a-z0-9_]{1,39}$'),
  path text check (length(path) <= 300),
  props jsonb not null default '{}'::jsonb check (pg_column_size(props) <= 2000),
  utm jsonb not null default '{}'::jsonb check (pg_column_size(utm) <= 1000) -- 처음 들어온 경로 (source·medium·campaign·referrer·landing)
);
create index if not exists marketing_events_name_idx on public.marketing_events (name, created_at desc);
create index if not exists marketing_events_profile_idx on public.marketing_events (profile_id, created_at desc) where profile_id is not null;
create index if not exists marketing_events_anon_idx on public.marketing_events (anon_id, created_at desc);

alter table public.marketing_events enable row level security;
drop policy if exists marketing_events_insert on public.marketing_events;
-- 남의 이름으로는 못 넣음: profile_id 는 비우거나(기본값 auth.uid()) 내 것만
create policy marketing_events_insert on public.marketing_events for insert to anon, authenticated
  with check (profile_id is not distinct from auth.uid());
revoke all on public.marketing_events from anon, authenticated;
grant insert (anon_id, name, path, props, utm) on public.marketing_events to anon, authenticated;
grant all on public.marketing_events to service_role;

-- 90일 지난 기록은 매일 새벽에 지움
create extension if not exists pg_cron;
select cron.unschedule('marketing-events-retention') where exists (select 1 from cron.job where jobname = 'marketing-events-retention');
select cron.schedule('marketing-events-retention', '20 19 * * *', $$
  delete from public.marketing_events where created_at < now() - interval '90 days';
$$);

-- 운영자용 단계별 전환 (최근 n일): select * from marketing_funnel(7);
create or replace function public.marketing_funnel(p_days integer default 7)
returns table (step text, people bigint, events bigint)
language sql stable security definer set search_path = public as $$
  select name, count(distinct coalesce(profile_id::text, anon_id)), count(*)
    from marketing_events
   where created_at > now() - make_interval(days => p_days)
   group by name
   order by 2 desc;
$$;

-- 운영자용 채널별 가입 (최근 n일): select * from marketing_signups_by_source(30);
create or replace function public.marketing_signups_by_source(p_days integer default 30)
returns table (source text, medium text, campaign text, signups bigint)
language sql stable security definer set search_path = public as $$
  select coalesce(utm->>'source', utm->>'referrer', '(직접)'), coalesce(utm->>'medium', ''), coalesce(utm->>'campaign', ''), count(*)
    from marketing_events
   where name = 'sign_up' and created_at > now() - make_interval(days => p_days)
   group by 1, 2, 3
   order by 4 desc;
$$;
revoke execute on function public.marketing_funnel(integer) from anon, authenticated, public;
revoke execute on function public.marketing_signups_by_source(integer) from anon, authenticated, public;
grant execute on function public.marketing_funnel(integer) to service_role;
grant execute on function public.marketing_signups_by_source(integer) to service_role;
