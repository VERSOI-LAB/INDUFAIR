-- 인스타그램·스레드 자동 발행: 매주 월요일 한국시간 10:00 에 이번 주 지원사업 카드(/support/weekly.jpg) + 캡션을 올림
--   보내기는 Edge Function social-publish (Verify JWT 끔, cron 이 부름)
--   토큰은 처음엔 Edge Function 비밀값(INSTAGRAM_ACCESS_TOKEN / THREADS_ACCESS_TOKEN)에서 읽고, 30일마다 자동 갱신해서 여기에 저장
--   같은 주에 같은 곳에 두 번 올리지 않게 social_posts 에 기록 (실패한 주는 다시 시도 가능)
--   읽기·쓰기는 서버(service_role)만. 여러 번 실행해도 안전

create table if not exists public.social_accounts (
  platform text primary key check (platform in ('instagram', 'threads')),
  user_id text,                       -- 인스타 비즈니스 계정 id / 스레드 사용자 id (처음 실행 때 /me 로 채움)
  access_token text,                  -- 장기 토큰 (60일). 30일마다 갱신
  token_refreshed_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.social_accounts enable row level security;
revoke all on public.social_accounts from anon, authenticated;
grant all on public.social_accounts to service_role;

create table if not exists public.social_posts (
  id bigint generated always as identity primary key,
  platform text not null check (platform in ('instagram', 'threads')),
  week date not null,                 -- 그 주 월요일
  status text not null default 'pending' check (status in ('pending', 'published', 'failed', 'skipped')),
  media_id text,                      -- 올라간 게시물 id
  error text check (length(error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, week)
);
alter table public.social_posts enable row level security;
revoke all on public.social_posts from anon, authenticated;
grant all on public.social_posts to service_role;

-- 매주 월요일 한국시간 10:00 (UTC 월요일 01:00)
select cron.unschedule('social-publish-weekly') where exists (select 1 from cron.job where jobname = 'social-publish-weekly');
select cron.schedule('social-publish-weekly', '0 1 * * 1', $$
  select net.http_post(
    url := 'https://rqjfergjfhcrcuvfuhkm.supabase.co/functions/v1/social-publish',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"run": true}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
