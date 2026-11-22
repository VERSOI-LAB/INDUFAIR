-- 매주 월요일 지원사업 브리핑 (자동 메시지 weekly_briefing) — journey_candidates 에 한 갈래 추가
--   받는 사람: 지원사업 마감 알림(support_alerts)을 켰거나 30초 진단(company_profiles)을 한 사람
--   내용: 그 사람 지역(+전국)에서 오늘~7일 안 마감 공고 수와 가장 급한 공고. 0건이면 보내지 않음
--   나머지 메시지 규칙은 20261122_journeys.sql 과 똑같음. 여러 번 실행해도 안전

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
    union all
    -- 매주 월요일 지원사업 브리핑 (서버가 요일을 봄): 마감 알림을 켰거나 진단을 한 사람에게, 그 사람 지역(+전국) 기준 이번 주 마감 공고 (정보성: 본인이 요청한 알림)
    select w.pid, to_char(now() at time zone 'Asia/Seoul', 'IYYY-IW'),
           jsonb_build_object('count', s.cnt, 'top', s.top, 'region', case when cardinality(w.regions) = 1 then w.regions[1] else null end)
      from (select sa.profile_id as pid, sa.regions from support_alerts sa
            union all
            select cp.profile_id, array[cp.region] from company_profiles cp
             where not exists (select 1 from support_alerts sa2 where sa2.profile_id = cp.profile_id)) w
      cross join lateral (
        select count(*)::integer as cnt, (array_agg(sp.title order by sp.apply_end, sp.posted_at desc))[1] as top
          from support_programs sp
         where sp.apply_end between (now() at time zone 'Asia/Seoul')::date and (now() at time zone 'Asia/Seoul')::date + 7
           and (cardinality(w.regions) = 0 or sp.region = '전국' or sp.region = any(w.regions))) s
     where p_journey = 'weekly_briefing' and s.cnt > 0
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
