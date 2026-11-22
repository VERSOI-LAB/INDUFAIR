-- 행동별 자동 메시지 (웹 푸시 + 이메일). 보내기는 Edge Function `journeys` (매일 한국시간 10:30, cron)
--   정보성: 내 물건·내 업체·가입 안내처럼 이용자가 쓰는 서비스에 관한 것 → 동의 없이 보냄 (이메일은 끌 수 있음)
--   광고성: 혜택 권유·다시 오라는 안내 → 수신 동의(marketing_consents)한 사람에게만, 제목 앞 '(광고)', 수신거부 방법 표시
--   야간(21~08시)에는 보내지 않음 (cron 이 낮에만 돌기 때문). 한 사람에게 하루 1통, 7일 3통까지 (journey_sends 로 셈)

-- 1) 수신 동의 / 이메일 수신 설정 (한 사람 한 줄)
create table if not exists public.marketing_consents (
  profile_id uuid primary key default auth.uid() references public.profiles(id) on delete cascade,
  ads_push boolean not null default false,   -- 혜택·이벤트 웹 푸시 (광고성)
  ads_email boolean not null default false,  -- 혜택·이벤트 이메일 (광고성)
  info_email boolean not null default true,  -- 내 물건·업체 소식 이메일 (정보성, 끌 수 있음)
  agreed_at timestamptz,                     -- 광고 수신에 마지막으로 동의한 때 (2년마다 다시 알림)
  reconfirmed_at timestamptz,                -- 2년 알림을 보낸 때
  unsub_token uuid not null default gen_random_uuid() unique, -- 이메일 '수신거부' 링크용 (로그인 없이)
  updated_at timestamptz not null default now()
);
alter table public.marketing_consents enable row level security;
drop policy if exists marketing_consents_own on public.marketing_consents;
create policy marketing_consents_own on public.marketing_consents for all to authenticated
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());
revoke all on public.marketing_consents from anon, authenticated;
grant select (profile_id, ads_push, ads_email, info_email, agreed_at, updated_at) on public.marketing_consents to authenticated;
-- upsert 가 profile_id 도 다시 쓰므로 update 에 포함 (바꾸는 건 RLS 의 with check 가 막음)
grant insert (profile_id, ads_push, ads_email, info_email), update (profile_id, ads_push, ads_email, info_email) on public.marketing_consents to authenticated;
grant all on public.marketing_consents to service_role;

-- 광고 동의를 켜는 순간을 기록 (2년 재확인의 기준일). 화면은 agreed_at·unsub_token 열에 쓸 권한이 없고, 이 트리거만 채움
create or replace function public.marketing_consents_stamp() returns trigger
language plpgsql set search_path = public as $$
begin
  if (new.ads_push or new.ads_email)
     and (tg_op = 'INSERT' or not (old.ads_push or old.ads_email)) then
    new.agreed_at := now();
    new.reconfirmed_at := null;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists marketing_consents_stamp on public.marketing_consents;
create trigger marketing_consents_stamp before insert or update on public.marketing_consents
  for each row execute function public.marketing_consents_stamp();

-- 이메일 '수신거부' 링크 (/unsubscribe?t=...): 로그인 없이 토큰으로. kind = 'ads'(광고만) | 'all'(정보성 이메일까지)
create or replace function public.email_unsubscribe(p_token uuid, p_kind text default 'ads')
returns text language plpgsql security definer set search_path = public as $$
begin
  update marketing_consents
     set ads_email = false,
         info_email = case when p_kind = 'all' then false else info_email end
   where unsub_token = p_token;
  return case when found then 'ok' else 'not_found' end;
end $$;
revoke execute on function public.email_unsubscribe(uuid, text) from public;
grant execute on function public.email_unsubscribe(uuid, text) to anon, authenticated;

-- 수신거부 토큰 (보낼 때 서버가 부름. 줄이 없으면 기본값으로 만듦)
create or replace function public.consent_token(p_profile uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  insert into marketing_consents (profile_id) values (p_profile) on conflict (profile_id) do nothing;
  select unsub_token into t from marketing_consents where profile_id = p_profile;
  return t;
end $$;
revoke execute on function public.consent_token(uuid) from anon, authenticated, public;
grant execute on function public.consent_token(uuid) to service_role;

-- 2) 보낸 기록: 같은 메시지 두 번 막기(unique) + 하루·일주일 횟수 제한
create table if not exists public.journey_sends (
  id bigint generated always as identity primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  journey text not null,
  ref text not null,              -- 무엇에 대한 메시지인지 (물건 id, 업체 id + 주, 달 …)
  push_sent integer not null default 0,
  email_sent boolean not null default false,
  sent_at timestamptz not null default now(),
  unique (profile_id, journey, ref)
);
create index if not exists journey_sends_profile_idx on public.journey_sends (profile_id, sent_at desc);
alter table public.journey_sends enable row level security;
revoke all on public.journey_sends from anon, authenticated;
grant all on public.journey_sends to service_role;

select cron.unschedule('journey-sends-cleanup') where exists (select 1 from cron.job where jobname = 'journey-sends-cleanup');
select cron.schedule('journey-sends-cleanup', '40 19 * * 0', $$
  delete from public.journey_sends where sent_at < now() - interval '400 days';
$$);

-- 3) 업체 조회수 주간 기록 (주간 리포트의 '지난주 조회수' 계산용)
create table if not exists public.biz_view_snapshots (
  business_id uuid not null references public.businesses(id) on delete cascade,
  taken_on date not null,
  view_count integer not null,
  primary key (business_id, taken_on)
);
alter table public.biz_view_snapshots enable row level security;
revoke all on public.biz_view_snapshots from anon, authenticated;
grant all on public.biz_view_snapshots to service_role;

create or replace function public.biz_snapshot_views()
returns integer language sql security definer set search_path = public as $$
  with ins as (
    insert into biz_view_snapshots (business_id, taken_on, view_count)
    select id, (now() at time zone 'Asia/Seoul')::date, view_count from businesses where status = 'active'
    on conflict (business_id, taken_on) do update set view_count = excluded.view_count
    returning 1
  ) select count(*)::integer from ins;
$$;
revoke execute on function public.biz_snapshot_views() from anon, authenticated, public;
grant execute on function public.biz_snapshot_views() to service_role;

-- 4) 메시지별 받을 사람 고르기. 결과: 받을 사람, 중복 막기용 ref, 이메일(auth), 동의 상태, 메시지에 넣을 값
--    서버(journeys 함수)가 동의·횟수 제한을 한 번 더 보고 보냄
create or replace function public.journey_candidates(p_journey text)
returns table (profile_id uuid, ref text, email text, ads_push boolean, ads_email boolean, info_email boolean, data jsonb)
language sql stable security definer set search_path = public, auth as $$
  with c as (
    -- 가입 다음 날, 아직 진단·지원사업 알림을 안 했으면: 30초 진단 안내 (정보성: 서비스 이용 안내)
    select u.id as pid, 'signup' as ref, '{}'::jsonb as data
      from auth.users u
     where p_journey = 'welcome_diagnose'
       and u.created_at between now() - interval '48 hours' and now() - interval '24 hours'
       and not exists (select 1 from company_profiles cp where cp.profile_id = u.id)
       and not exists (select 1 from support_alerts sa where sa.profile_id = u.id)
    union all
    -- 물건 올리고 3일 / 7일 동안 채팅 0건 (정보성: 내 물건)
    select p.seller_profile_id, p.id::text,
           jsonb_build_object('product_id', p.id, 'title', p.title, 'price', p.price, 'days', case when p_journey = 'product_stale_3' then 3 else 7 end)
      from products p
     where p_journey in ('product_stale_3', 'product_stale_7')
       and p.status = 'selling' and coalesce(p.inquiry_count, 0) = 0
       and p.created_at between now() - make_interval(days => case when p_journey = 'product_stale_3' then 3 else 7 end) - interval '1 day'
                            and now() - make_interval(days => case when p_journey = 'product_stale_3' then 3 else 7 end)
    union all
    -- 업체 주간 리포트 (월요일만, 서버가 요일을 봄): 지난 기록 대비 조회수 (정보성: 내 업체)
    select b.owner_id, b.id::text || ':' || to_char(now() at time zone 'Asia/Seoul', 'IYYY-IW'),
           jsonb_build_object('business_id', b.id, 'name', b.name, 'views_total', b.view_count,
             'views_week', b.view_count - s.view_count,
             'premium', coalesce(b.premium_until > now(), false))
      from businesses b
      left join lateral (select view_count from biz_view_snapshots x where x.business_id = b.id
                          and x.taken_on < (now() at time zone 'Asia/Seoul')::date order by taken_on desc limit 1) s on true
     where p_journey = 'biz_weekly' and b.status = 'active' and s.view_count is not null
    union all
    -- 프리미엄이 3일 안에 끝나는데 자동결제가 없음 (정보성: 내가 쓰는 유료 서비스)
    select b.owner_id, b.id::text || ':' || to_char(b.premium_until, 'YYYY-MM-DD'),
           jsonb_build_object('business_id', b.id, 'name', b.name, 'until', to_char(b.premium_until at time zone 'Asia/Seoul', 'FMMM월 FMDD일'))
      from businesses b
     where p_journey = 'premium_expiring' and b.status = 'active'
       and b.premium_until between now() and now() + interval '3 days'
       and not exists (select 1 from biz_subscriptions s where s.business_id = b.id and s.status in ('active', 'past_due'))
    union all
    -- 프리미엄 아닌 업체가 조회 30회 넘음, 등록 7일 지남: 프리미엄 권유 (광고성, 30일에 한 번)
    select b.owner_id, b.id::text || ':' || to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM'),
           jsonb_build_object('business_id', b.id, 'name', b.name, 'views_total', b.view_count)
      from businesses b
     where p_journey = 'biz_upsell' and b.status = 'active'
       and coalesce(b.premium_until, '-infinity') < now() and b.view_count >= 30
       and b.created_at < now() - interval '7 days'
       and not exists (select 1 from journey_sends j where j.profile_id = b.owner_id and j.journey = 'biz_upsell' and j.sent_at > now() - interval '30 days')
    union all
    -- 마지막 방문이 30~37일 전: 그동안 새 지원사업 수 (광고성, 그 달 한 번)
    select e.pid, to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM'),
           jsonb_build_object('new_programs', (select count(*) from support_programs sp where sp.posted_at > e.last_at))
      from (select me.profile_id as pid, max(me.created_at) as last_at
              from marketing_events me where me.profile_id is not null group by me.profile_id) e
     where p_journey = 'dormant_30' and e.last_at between now() - interval '37 days' and now() - interval '30 days'
    union all
    -- 광고 수신 동의 2년 재확인 (정보통신망법 제50조 제8항, 23개월째에 알림)
    select mc.profile_id, to_char(mc.agreed_at, 'YYYY-MM-DD'),
           jsonb_build_object('agreed_on', to_char(mc.agreed_at at time zone 'Asia/Seoul', 'YYYY년 FMMM월 FMDD일'),
             'push', mc.ads_push, 'email', mc.ads_email)
      from marketing_consents mc
     where p_journey = 'consent_reconfirm' and (mc.ads_push or mc.ads_email)
       and mc.agreed_at < now() - interval '23 months' and mc.reconfirmed_at is null
  )
  select c.pid, c.ref, u.email, coalesce(mc.ads_push, false), coalesce(mc.ads_email, false), coalesce(mc.info_email, true), c.data
    from c
    join auth.users u on u.id = c.pid
    join profiles pr on pr.id = c.pid
    left join marketing_consents mc on mc.profile_id = c.pid
   limit 5000;
$$;
revoke execute on function public.journey_candidates(text) from anon, authenticated, public;
grant execute on function public.journey_candidates(text) to service_role;

-- 5) 매일 한국시간 10:30 (UTC 01:30)
select cron.unschedule('journeys-daily') where exists (select 1 from cron.job where jobname = 'journeys-daily');
select cron.schedule('journeys-daily', '30 1 * * *', $$
  select net.http_post(
    url := 'https://rqjfergjfhcrcuvfuhkm.supabase.co/functions/v1/journeys',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"run": true}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
