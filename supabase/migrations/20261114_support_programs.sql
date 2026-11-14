-- 정부·지자체 지원사업 공고 (기업마당 지원사업정보 API 자동 수집)
--   매일 2번(한국시간 06시·18시) pg_cron → Edge Function sync-support-programs → 공고번호 기준 upsert
--   Edge Function 비밀값: BIZINFO_API_KEY (기업마당 > 정책정보 개방 API 에서 발급)
--   sync-support-programs 는 cron 이 JWT 없이 부르므로 'Verify JWT' 를 끈다. 30분 안 재실행은 무시

-- 1) 공고 (누구나 읽기, 쓰기는 서버만)
create table if not exists public.support_programs (
  id bigint generated always as identity primary key,
  source text not null default 'bizinfo' check (source in ('bizinfo')),
  external_id text not null check (length(external_id) between 1 and 100),
  title text not null check (length(title) between 1 and 500),
  agency text,          -- 소관 기관 (예: 중소벤처기업부)
  executor text,        -- 수행 기관 (예: 중소기업기술정보진흥원)
  category text,        -- 분야: 금융·기술·인력·수출·내수·창업·경영·기타
  region text not null default '전국', -- 해시태그에서 뽑은 지역 (없으면 전국)
  target text,          -- 지원 대상
  summary text,         -- 사업 개요 (태그 지운 글, 2000자까지)
  hashtags text,
  apply_text text,      -- 신청 기간 원문 (예: "20261101 ~ 20261130", "상시 접수")
  apply_start date,
  apply_end date,       -- 비어 있으면 상시·예산 소진 시까지
  url text not null check (url like 'https://%' or url like 'http://%'),
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, external_id)
);
create index if not exists support_programs_end_idx on public.support_programs (apply_end);
create index if not exists support_programs_posted_idx on public.support_programs (posted_at desc);
create index if not exists support_programs_category_idx on public.support_programs (category);

alter table public.support_programs enable row level security;
drop policy if exists support_programs_read on public.support_programs;
create policy support_programs_read on public.support_programs for select to anon, authenticated using (true);
revoke all on public.support_programs from anon, authenticated;
grant select on public.support_programs to anon, authenticated;
grant select, insert, update, delete on public.support_programs to service_role;

-- 2) 마지막 수집 기록 (너무 자주 부르는 것 막기 + 결과 확인용)
create table if not exists public.support_sync_runs (
  id integer primary key,
  last_run_at timestamptz not null default now(),
  last_result jsonb
);
alter table public.support_sync_runs enable row level security;
revoke all on public.support_sync_runs from anon, authenticated;
grant select, insert, update on public.support_sync_runs to service_role;

-- 3) 매일 2번 수집 (UTC 21시·9시 = 한국시간 06시·18시)
select cron.unschedule('sync-support-programs') where exists (select 1 from cron.job where jobname = 'sync-support-programs');
select cron.schedule('sync-support-programs', '0 9,21 * * *', $$
  select net.http_post(
    url := 'https://rqjfergjfhcrcuvfuhkm.supabase.co/functions/v1/sync-support-programs',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);
