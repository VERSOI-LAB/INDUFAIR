-- 보안: 회원이 자기 프로필에서 관리자 여부 같은 중요한 칸을 바꾸지 못하게 막는다.
-- 문제: profiles_update_own 정책과 칼럼 UPDATE 권한 때문에 로그인한 누구나 is_admin = true 로 바꿀 수 있었고,
--       그러면 is_admin() 을 쓰는 정책(회원·주문·정산 등 21개 표)에서 관리자 권한을 얻었다.
-- 해결: 사이트(로그인한 회원, anon)에서 오는 수정이면 아래 칸은 바뀌지 않게 막는다.
--       서버(service_role, 탈퇴 함수 등)와 SQL 편집기, 기존 관리자는 그대로 바꿀 수 있다.
--       사이트가 실제로 고치는 칸: name, phone, avatar_url, free_ship_min (그 밖의 일반 설정 칸도 그대로 허용)

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
       or new.email is distinct from old.email then
      raise exception '이 정보는 바꿀 수 없어요' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.profiles_guard();

-- 혹시 이미 스스로 관리자가 된 계정이 있는지 확인용 (결과만 보여 줌, 바꾸지 않음)
select id, name, created_at from public.profiles where is_admin = true;
