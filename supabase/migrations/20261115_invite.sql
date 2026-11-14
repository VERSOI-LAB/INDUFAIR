-- 친구 초대: 내 초대 링크(https://www.pandasanda.com/?ref=코드)로 들어와 가입하면 '누가 데려왔는지' 기록
-- 보상은 아직 없음(운영 정책 정해지면 추가). 마이 > 친구 초대하기에서 가입한 친구 수를 보여 줌

alter table public.profiles add column if not exists invite_code text;
alter table public.profiles add column if not exists referred_by uuid references public.profiles(id) on delete set null;
alter table public.profiles add column if not exists referred_at timestamptz;
update public.profiles set invite_code = lower(substr(md5(id::text || random()::text), 1, 8)) where invite_code is null;
alter table public.profiles alter column invite_code set default lower(substr(md5(gen_random_uuid()::text), 1, 8));
create unique index if not exists profiles_invite_code_key on public.profiles (invite_code);
create index if not exists profiles_referred_by_idx on public.profiles (referred_by) where referred_by is not null;

-- 보호 칸에 초대 정보도 추가 (사이트에서 직접 못 바꿈, claim_referral 로만)
create or replace function public.profiles_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') and not public.is_admin() then
    if new.id is distinct from old.id
       or new.is_admin is distinct from old.is_admin
       or new.status is distinct from old.status
       or new.withdrawn_at is distinct from old.withdrawn_at
       or new.created_at is distinct from old.created_at
       or new.member_type is distinct from old.member_type
       or new.email is distinct from old.email
       or new.invite_code is distinct from old.invite_code
       or new.referred_by is distinct from old.referred_by
       or new.referred_at is distinct from old.referred_at then
      raise exception '이 정보는 바꿀 수 없어요' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- 가입 직후(7일 안) 한 번만, 내가 아닌 사람의 코드로
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
  return 'ok';
end $$;
revoke execute on function public.claim_referral(text) from anon, public;
grant execute on function public.claim_referral(text) to authenticated;

-- 내 초대 코드와 가입한 친구 수
create or replace function public.my_invite()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('code', (select invite_code from profiles where id = auth.uid()),
    'invited', (select count(*) from profiles where referred_by = auth.uid()))
  where auth.uid() is not null;
$$;
revoke execute on function public.my_invite() from anon, public;
grant execute on function public.my_invite() to authenticated;
