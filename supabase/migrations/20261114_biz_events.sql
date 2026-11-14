-- 중소기업 교육·세미나·전시회·설명회 (기업마당 행사정보 API 자동 수집)
--   지원사업과 같은 Edge Function sync-support-programs 가 매일 2번 같이 수집 (비밀값 BIZINFO_EVENT_API_KEY, 없으면 BIZINFO_API_KEY)

create table if not exists public.biz_events (
  id bigint generated always as identity primary key,
  source text not null default 'bizinfo' check (source in ('bizinfo')),
  external_id text not null check (length(external_id) between 1 and 100),
  title text not null check (length(title) between 1 and 500),
  event_type text,      -- 행사 유형 (교육·세미나·전시회·사업설명회 등)
  category text,        -- 분야 (예: 경영·창업)
  region text not null default '전국',
  organizer text,       -- 출처 기관
  summary text,         -- 행사 내용 (태그 지운 글, 2000자까지)
  hashtags text,
  apply_text text,      -- 접수 기간 원문
  apply_start date,
  apply_end date,
  event_text text,      -- 행사 기간 원문
  event_start date,
  event_end date,
  url text not null check (url like 'https://%' or url like 'http://%'), -- 기업마당 상세
  origin_url text,      -- 주최 기관 원문
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, external_id)
);
create index if not exists biz_events_start_idx on public.biz_events (event_start);
create index if not exists biz_events_end_idx on public.biz_events (event_end);
create index if not exists biz_events_posted_idx on public.biz_events (posted_at desc);

alter table public.biz_events enable row level security;
drop policy if exists biz_events_read on public.biz_events;
create policy biz_events_read on public.biz_events for select to anon, authenticated using (true);
revoke all on public.biz_events from anon, authenticated;
grant select on public.biz_events to anon, authenticated;
grant select, insert, update, delete on public.biz_events to service_role;
