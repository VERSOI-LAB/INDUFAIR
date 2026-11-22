-- 간편 로그인(카카오·구글) 이름·프로필 사진 채우기 보완
--   Supabase 는 간편 로그인 회원을 먼저 만들고(INSERT) 이름·사진 정보는 바로 뒤에 UPDATE 로 넣는다.
--   그래서 가입 순간(handle_new_user)에는 이름이 비어 이메일 앞부분이 이름이 됐다.
--   → 정보가 들어올 때(UPDATE) 이름이 '자동으로 만든 값'(이메일 앞부분/판다회원)이면 카카오·구글 이름으로 바꾸고,
--     프로필 사진이 없으면 카카오·구글 사진을 넣는다. 회원이 직접 바꾼 이름·사진은 건드리지 않는다.
create or replace function public.sync_oauth_profile()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  nm text := left(coalesce(
    nullif(trim(m->>'name'), ''), nullif(trim(m->>'full_name'), ''),
    nullif(trim(m->>'nickname'), ''), nullif(trim(m->>'user_name'), '')), 20);
  -- 카카오 사진 주소는 http:// 로 오므로 https:// 로 (k.kakaocdn.net 은 https 지원)
  pic text := regexp_replace(coalesce(nullif(m->>'avatar_url', ''), nullif(m->>'picture', ''), ''), '^http://', 'https://');
begin
  if nm is null and pic = '' then return new; end if;
  update public.profiles p set
    name = case when nm is not null and (p.name is null or p.name = '판다회원'
                 or p.name = split_part(coalesce(new.email, ''), '@', 1)) then nm else p.name end,
    avatar_url = case when p.avatar_url is null and pic like 'https://%' then pic else p.avatar_url end
  where p.id = new.id;
  return new;
end;
$function$;

drop trigger if exists on_auth_user_meta_updated on auth.users;
create trigger on_auth_user_meta_updated
  after update of raw_user_meta_data on auth.users
  for each row
  when (old.raw_user_meta_data is distinct from new.raw_user_meta_data)
  execute function public.sync_oauth_profile();

-- 이미 간편 로그인으로 가입한 회원도 한 번 맞춰 준다 (이름이 이메일 앞부분인 경우만)
update public.profiles p set
  name = left(coalesce(nullif(trim(u.raw_user_meta_data->>'name'), ''), nullif(trim(u.raw_user_meta_data->>'full_name'), ''), p.name), 20),
  avatar_url = coalesce(p.avatar_url, nullif(regexp_replace(coalesce(u.raw_user_meta_data->>'avatar_url', ''), '^http://', 'https://'), ''))
from auth.users u
where u.id = p.id
  and u.raw_app_meta_data->>'provider' in ('kakao', 'google')
  and p.name = split_part(coalesce(u.email, ''), '@', 1);
