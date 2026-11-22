-- 간편 로그인(카카오·구글) 가입자의 이름 채우기
--   이메일 가입: raw_user_meta_data.name (가입 화면에서 쓴 이름)
--   구글: name / full_name, 카카오: name / nickname / user_name (카카오는 이메일을 안 줄 수도 있음)
--   어느 것도 없으면 '판다회원'
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_inv record;
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  insert into public.profiles (id, name, email, phone)
  values (
    new.id,
    left(coalesce(
      nullif(trim(m->>'name'), ''),
      nullif(trim(m->>'full_name'), ''),
      nullif(trim(m->>'nickname'), ''),
      nullif(trim(m->>'user_name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      '판다회원'
    ), 20),
    new.email,
    m->>'phone'
  );

  if new.email is not null then
    for v_inv in select * from public.company_invitations where email = new.email and status = 'pending' loop
      insert into public.company_members (company_id, profile_id, name, department, role, is_owner, status)
      values (v_inv.company_id, new.id, coalesce(v_inv.name, new.email), v_inv.department, v_inv.role, false, 'active')
      on conflict (company_id, profile_id) do nothing;
      update public.company_invitations set status = 'accepted' where id = v_inv.id;
      update public.profiles set member_type = 'business' where id = new.id;
    end loop;
  end if;

  return new;
end;
$function$;
