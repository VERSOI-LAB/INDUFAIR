-- 지원사업 마감 임박 알림
-- 관심 지역·분야를 고르면, 매일 아침 9시(한국시간)에 마감이 가까운 공고를 웹 푸시로 알려 준다.
-- 보내기는 community-push 함수({ deadline_digest: true }), 같은 공고는 한 사람에게 한 번만.

create table if not exists public.support_alerts (
  profile_id uuid primary key default auth.uid() references public.profiles(id) on delete cascade,
  regions text[] not null default '{}',   -- 비어 있으면 모든 지역. '전국' 공고는 항상 포함
  fields text[] not null default '{}',    -- 비어 있으면 모든 분야
  days integer not null default 3 check (days between 1 and 14), -- 마감 며칠 전에 알릴지
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(regions) <= 17 and cardinality(fields) <= 10)
);
alter table public.support_alerts enable row level security;
drop policy if exists support_alerts_own on public.support_alerts;
create policy support_alerts_own on public.support_alerts for all to authenticated
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());
grant select, insert, update, delete on public.support_alerts to authenticated;
grant select on public.support_alerts to service_role;

create table if not exists public.support_alert_sent (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  program_id bigint not null references public.support_programs(id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (profile_id, program_id)
);
alter table public.support_alert_sent enable row level security;
revoke all on public.support_alert_sent from anon, authenticated;
grant select, insert, delete on public.support_alert_sent to service_role;

-- 매일 한국시간 9시 (UTC 0시)
select cron.unschedule('support-deadline-digest') where exists (select 1 from cron.job where jobname = 'support-deadline-digest');
select cron.schedule('support-deadline-digest', '0 0 * * *', $$
  select net.http_post(
    url := 'https://rqjfergjfhcrcuvfuhkm.supabase.co/functions/v1/community-push',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"deadline_digest": true}'::jsonb,
    timeout_milliseconds := 60000
  );
$$);

-- 오래된 발송 기록 정리 (마감 지난 공고는 다시 보낼 일이 없음)
select cron.unschedule('support-alert-sent-cleanup') where exists (select 1 from cron.job where jobname = 'support-alert-sent-cleanup');
select cron.schedule('support-alert-sent-cleanup', '30 0 * * 0', $$
  delete from public.support_alert_sent where sent_at < now() - interval '60 days';
$$);
