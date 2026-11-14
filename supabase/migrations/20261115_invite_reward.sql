-- 친구 초대 보상: 초대한 친구가 가입하면 초대한 사람의 업체가 7일 동안 '프리미엄'(맨 위 고정 + 매일 자동 끌어올리기)
--   - 한 사람이 30일 동안 받을 수 있는 보상은 4명(28일)까지 (가짜 가입 막기)
--   - 업체가 없으면 '대기'로 쌓아 두었다가 업체를 등록하면 바로 적용
--   - 유료 프리미엄과 겹치면 더 늦은 만료일을 씀 (결제 갱신이 보상 기간을 줄이지 않게)

create table if not exists public.referral_rewards (
  id bigint generated always as identity primary key,
  inviter_id uuid not null references public.profiles(id) on delete cascade,
  invitee_id uuid not null unique references public.profiles(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete set null,
  days integer not null default 7,
  status text not null check (status in ('applied', 'pending', 'capped')),
  created_at timestamptz not null default now(),
  applied_at timestamptz
);
create index if not exists referral_rewards_inviter_idx on public.referral_rewards (inviter_id, created_at desc);
alter table public.referral_rewards enable row level security;
drop policy if exists referral_rewards_own on public.referral_rewards;
create policy referral_rewards_own on public.referral_rewards for select to authenticated using (inviter_id = auth.uid());
revoke all on public.referral_rewards from anon, authenticated;
grant select (id, days, status, created_at, applied_at) on public.referral_rewards to authenticated;

-- 결제 갱신이 보상으로 늘어난 기간을 줄이지 않게: 더 늦은 쪽으로
create or replace function public.set_business_premium(p_business_id uuid, p_until timestamptz, p_bump boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('ps.internal', '1', true);
  update public.businesses
     set premium_until = greatest(p_until, coalesce(premium_until, p_until)),
         bumped_at = case when p_bump then now() else bumped_at end
   where id = p_business_id;
  perform set_config('ps.internal', '', true);
end $$;

-- 업체에 보상 기간 더하기 (지금 프리미엄이면 그 끝에서 이어서)
create or replace function public.add_premium_days(p_business_id uuid, p_days integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('ps.internal', '1', true);
  update public.businesses
     set premium_until = greatest(now(), coalesce(premium_until, now())) + make_interval(days => p_days),
         bumped_at = now()
   where id = p_business_id;
  perform set_config('ps.internal', '', true);
end $$;
revoke execute on function public.add_premium_days(uuid, integer) from anon, authenticated, public;

-- 보상 주기 (claim_referral 에서 부름)
create or replace function public.grant_referral_reward(p_inviter uuid, p_invitee uuid)
returns text language plpgsql security definer set search_path = public as $$
declare recent integer; biz uuid; st text;
begin
  select count(*) into recent from referral_rewards
   where inviter_id = p_inviter and status <> 'capped' and created_at > now() - interval '30 days';
  if recent >= 4 then st := 'capped';
  else
    select id into biz from businesses where owner_id = p_inviter and status = 'active'
     order by premium_until desc nulls last, created_at limit 1;
    st := case when biz is null then 'pending' else 'applied' end;
  end if;
  insert into referral_rewards (inviter_id, invitee_id, business_id, days, status, applied_at)
  values (p_inviter, p_invitee, biz, case when st = 'capped' then 0 else 7 end, st, case when st = 'applied' then now() end)
  on conflict (invitee_id) do nothing;
  if st = 'applied' and found then perform add_premium_days(biz, 7); end if;
  return st;
end $$;
revoke execute on function public.grant_referral_reward(uuid, uuid) from anon, authenticated, public;

-- 업체를 처음 등록하면 쌓여 있던 보상 적용
create or replace function public.apply_pending_referral_rewards()
returns trigger language plpgsql security definer set search_path = public as $$
declare d integer;
begin
  select coalesce(sum(days), 0) into d from referral_rewards where inviter_id = new.owner_id and status = 'pending';
  if d > 0 then
    update referral_rewards set status = 'applied', business_id = new.id, applied_at = now()
     where inviter_id = new.owner_id and status = 'pending';
    perform add_premium_days(new.id, d);
  end if;
  return null;
end $$;
drop trigger if exists businesses_apply_referral on public.businesses;
create trigger businesses_apply_referral after insert on public.businesses
  for each row execute function public.apply_pending_referral_rewards();

-- 가입 기록 + 보상
create or replace function public.claim_referral(p_code text)
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); p record; inviter uuid;
begin
  if me is null then return 'login'; end if;
  select id, created_at, referred_by into p from profiles where id = me;
  if p.id is null then return 'no_profile'; end if;
  if p.referred_by is not null then return 'already'; end if;
  if p.created_at < now() - interval '7 days' then return 'too_late'; end if;
  select id into inviter from profiles where invite_code = lower(trim(p_code)) and coalesce(status, 'active') <> 'withdrawn';
  if inviter is null then return 'bad_code'; end if;
  if inviter = me then return 'self'; end if;
  update profiles set referred_by = inviter, referred_at = now() where id = me;
  perform grant_referral_reward(inviter, me);
  return 'ok';
end $$;

-- 내 초대 현황: 코드, 가입한 친구 수, 받은 상위 노출 일수, 업체 등록 시 적용될 일수
create or replace function public.my_invite()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'code', (select invite_code from profiles where id = auth.uid()),
    'invited', (select count(*) from profiles where referred_by = auth.uid()),
    'reward_days', (select coalesce(sum(days), 0) from referral_rewards where inviter_id = auth.uid() and status = 'applied'),
    'pending_days', (select coalesce(sum(days), 0) from referral_rewards where inviter_id = auth.uid() and status = 'pending'))
  where auth.uid() is not null;
$$;
