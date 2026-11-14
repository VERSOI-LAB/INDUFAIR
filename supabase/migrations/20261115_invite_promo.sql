-- 친구 초대 홍보: 업체 주인에게 화면 안내 + 한 달에 한 번 푸시
--   - '다시 보지 않기'를 누르면 dismissed_at 기록 → 화면 안내와 푸시 모두 멈춤
--   - 푸시는 아직 아무도 초대하지 않은 업체 주인에게만, 25일에 한 번까지

create table if not exists public.invite_promo_state (
  profile_id uuid primary key default auth.uid() references public.profiles(id) on delete cascade,
  dismissed_at timestamptz,
  last_push_at timestamptz
);
alter table public.invite_promo_state enable row level security;
drop policy if exists invite_promo_state_own on public.invite_promo_state;
create policy invite_promo_state_own on public.invite_promo_state for all to authenticated
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());
revoke all on public.invite_promo_state from anon, authenticated;
grant select, insert (profile_id, dismissed_at), update (profile_id, dismissed_at) on public.invite_promo_state to authenticated;
grant select, insert, update on public.invite_promo_state to service_role;

-- 푸시 받을 사람: 운영 중인 업체 주인 + 아직 초대 0명 + 안 끔 + 25일 안에 안 받음 + 푸시 구독 있음
create or replace function public.invite_promo_targets()
returns setof uuid language sql stable security definer set search_path = public as $$
  select distinct b.owner_id from businesses b
  where b.status = 'active'
    and exists (select 1 from push_subscriptions s where s.profile_id = b.owner_id)
    and not exists (select 1 from profiles p where p.referred_by = b.owner_id)
    and not exists (select 1 from invite_promo_state st where st.profile_id = b.owner_id
                      and (st.dismissed_at is not null or st.last_push_at > now() - interval '25 days'));
$$;
revoke execute on function public.invite_promo_targets() from anon, authenticated, public;
grant execute on function public.invite_promo_targets() to service_role;

-- 매월 1일 한국시간 오전 10시 (UTC 1시)
select cron.unschedule('invite-promo-push') where exists (select 1 from cron.job where jobname = 'invite-promo-push');
select cron.schedule('invite-promo-push', '0 1 1 * *', $$
  select net.http_post(
    url := 'https://rqjfergjfhcrcuvfuhkm.supabase.co/functions/v1/community-push',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"invite_promo": true}'::jsonb,
    timeout_milliseconds := 60000
  );
$$);
