-- 이야기 신고 처리: 운영자 · 자동 검토 기록 · 검토 화면용 함수 · 운영자 알림
--   새 글/새 댓글/새 신고 → Edge Function community-push 가 자동 검토(Claude, 키가 없으면 규칙)하고
--   분명한 위반이면 숨김, 애매하면 '검토 필요'로 운영자에게 웹 푸시. 운영자는 /community/admin 에서 처리

-- 1) 운영자 명단 (판다산다 운영팀 계정)
create table if not exists public.app_admins (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.app_admins enable row level security;
revoke all on public.app_admins from anon, authenticated;
grant select on public.app_admins to service_role;
-- 운영자 계정: versoi.labs@gmail.com
insert into public.app_admins (profile_id)
  select u.id from auth.users u join public.profiles p on p.id = u.id
  where lower(u.email) = 'versoi.labs@gmail.com'
on conflict do nothing;

create or replace function public.is_app_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_admins where profile_id = auth.uid());
$$;
revoke execute on function public.is_app_admin() from public, anon;
grant execute on function public.is_app_admin() to authenticated;

-- 2) 신고 처리 결과
alter table public.story_reports add column if not exists resolved_at timestamptz;
alter table public.story_reports add column if not exists resolution text;
alter table public.story_reports drop constraint if exists story_reports_resolution_check;
alter table public.story_reports add constraint story_reports_resolution_check
  check (resolution is null or resolution in ('hidden', 'kept', 'restored', 'auto_hidden'));

-- 3) 자동 검토 기록
create table if not exists public.story_moderation (
  id bigint generated always as identity primary key,
  target_kind text not null check (target_kind in ('post', 'comment')),
  target_id bigint not null,
  trigger text not null check (trigger in ('new', 'report')),
  verdict text not null check (verdict in ('hide', 'keep', 'review')),
  reason text check (reason is null or length(reason) <= 300),
  reviewer text not null check (reviewer in ('ai', 'rule')),
  created_at timestamptz not null default now()
);
create index if not exists story_moderation_target_idx on public.story_moderation (target_kind, target_id, created_at desc);
alter table public.story_moderation enable row level security;
revoke all on public.story_moderation from anon, authenticated;
grant select, insert on public.story_moderation to service_role;

-- 서버(자동 검토)가 결과를 남기고, 숨김 판정이면 숨김 + 열린 신고를 '자동 숨김'으로 닫음
create or replace function public.story_record_review(p_kind text, p_id bigint, p_trigger text, p_verdict text, p_reason text, p_reviewer text)
returns text language plpgsql security definer set search_path = public as $$
begin
  insert into public.story_moderation (target_kind, target_id, trigger, verdict, reason, reviewer)
  values (p_kind, p_id, p_trigger, p_verdict, left(p_reason, 300), p_reviewer);
  if p_verdict = 'hide' then
    perform set_config('ps.internal', '1', true);
    if p_kind = 'post' then
      update public.story_posts set status = 'hidden' where id = p_id and status = 'active';
      update public.story_reports set resolved_at = now(), resolution = 'auto_hidden' where post_id = p_id and resolved_at is null;
    else
      update public.story_comments set status = 'hidden' where id = p_id and status = 'active';
      update public.story_reports set resolved_at = now(), resolution = 'auto_hidden' where comment_id = p_id and resolved_at is null;
    end if;
    perform set_config('ps.internal', '', true);
  end if;
  return 'ok';
end $$;
revoke execute on function public.story_record_review(text, bigint, text, text, text, text) from public, anon, authenticated;
grant execute on function public.story_record_review(text, bigint, text, text, text, text) to service_role;

-- 4) 검토 화면: 신고됐거나 숨겨졌거나 '검토 필요' 판정을 받은 글·댓글
create or replace function public.story_admin_queue()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  if not public.is_app_admin() then return null; end if;
  with targets as (
    select 'post'::text as kind, p.id, p.id as post_id, p.body, p.author_id, p.status, p.report_count, p.created_at
    from public.story_posts p
    where p.status = 'hidden'
       or exists (select 1 from public.story_reports r where r.post_id = p.id and r.resolved_at is null)
       or (select m.verdict from public.story_moderation m where m.target_kind = 'post' and m.target_id = p.id order by m.created_at desc, m.id desc limit 1) = 'review'
    union all
    select 'comment', c.id, c.post_id, c.body, c.author_id, c.status, c.report_count, c.created_at
    from public.story_comments c
    where c.status = 'hidden'
       or exists (select 1 from public.story_reports r where r.comment_id = c.id and r.resolved_at is null)
       or (select m.verdict from public.story_moderation m where m.target_kind = 'comment' and m.target_id = c.id order by m.created_at desc, m.id desc limit 1) = 'review'
  )
  select coalesce(jsonb_agg(row_to_json(x) order by x.open_reports desc, x.created_at desc), '[]'::jsonb) into out from (
    select t.kind, t.id, t.post_id, left(t.body, 400) as body, t.status, t.report_count, t.created_at,
      (select name from public.profiles where id = t.author_id) as author_name,
      (select count(*) from public.story_reports r where r.resolved_at is null and ((t.kind = 'post' and r.post_id = t.id) or (t.kind = 'comment' and r.comment_id = t.id))) as open_reports,
      (select jsonb_agg(distinct r.reason) from public.story_reports r where (t.kind = 'post' and r.post_id = t.id) or (t.kind = 'comment' and r.comment_id = t.id)) as reasons,
      (select jsonb_build_object('verdict', m.verdict, 'reason', m.reason, 'reviewer', m.reviewer, 'at', m.created_at)
         from public.story_moderation m where m.target_kind = t.kind and m.target_id = t.id order by m.created_at desc limit 1) as review
    from targets t
  ) x;
  return out;
end $$;
revoke execute on function public.story_admin_queue() from public, anon;
grant execute on function public.story_admin_queue() to authenticated;

-- 처리할 것 개수 (마이 메뉴 숫자)
create or replace function public.story_admin_open_count()
returns integer language sql stable security definer set search_path = public as $$
  select case when public.is_app_admin() then
    (select count(distinct coalesce('p' || post_id::text, 'c' || comment_id::text))::int from public.story_reports where resolved_at is null)
  else 0 end;
$$;
revoke execute on function public.story_admin_open_count() from public, anon;
grant execute on function public.story_admin_open_count() to authenticated;

-- 운영자 처리: hide 숨기기 · keep 그대로 두기 · restore 되살리기 (신고 수도 0으로)
create or replace function public.story_admin_decide(p_kind text, p_id bigint, p_action text)
returns text language plpgsql security definer set search_path = public as $$
declare res text := case p_action when 'hide' then 'hidden' when 'keep' then 'kept' when 'restore' then 'restored' end;
begin
  if not public.is_app_admin() then return 'forbidden'; end if;
  if res is null or p_kind not in ('post', 'comment') then return 'bad_input'; end if;
  perform set_config('ps.internal', '1', true);
  if p_kind = 'post' then
    update public.story_posts set
      status = case when p_action = 'hide' and status = 'active' then 'hidden' when p_action = 'restore' and status = 'hidden' then 'active' else status end,
      report_count = case when p_action = 'restore' then 0 else report_count end
    where id = p_id;
    update public.story_reports set resolved_at = now(), resolution = res where post_id = p_id and resolved_at is null;
  else
    update public.story_comments set
      status = case when p_action = 'hide' and status = 'active' then 'hidden' when p_action = 'restore' and status = 'hidden' then 'active' else status end,
      report_count = case when p_action = 'restore' then 0 else report_count end
    where id = p_id;
    update public.story_reports set resolved_at = now(), resolution = res where comment_id = p_id and resolved_at is null;
  end if;
  perform set_config('ps.internal', '', true);
  -- 같은 대상에 남은 '검토 필요' 판정은 처리 끝으로 (다시 목록에 안 뜨게)
  insert into public.story_moderation (target_kind, target_id, trigger, verdict, reason, reviewer)
  values (p_kind, p_id, 'report', case when p_action = 'hide' then 'hide' else 'keep' end, '운영자 처리: ' || res, 'rule');
  return 'ok';
end $$;
revoke execute on function public.story_admin_decide(text, bigint, text) from public, anon;
grant execute on function public.story_admin_decide(text, bigint, text) to authenticated;

-- 5) 새 글·새 신고 → community-push (새 댓글은 이미 on_story_comment_push 가 부름)
create or replace function public.on_story_post_review()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://rqjfergjfhcrcuvfuhkm.supabase.co/functions/v1/community-push',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('post_id', new.id),
    timeout_milliseconds := 60000 -- 자동 검토(AI) 시간이 걸릴 수 있음
  );
  return null;
exception when others then return null;
end $$;
drop trigger if exists story_posts_review on public.story_posts;
create trigger story_posts_review after insert on public.story_posts
  for each row execute function public.on_story_post_review();

create or replace function public.on_story_report_review()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://rqjfergjfhcrcuvfuhkm.supabase.co/functions/v1/community-push',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('report_id', new.id),
    timeout_milliseconds := 60000
  );
  return null;
exception when others then return null;
end $$;
drop trigger if exists story_reports_review on public.story_reports;
create trigger story_reports_review after insert on public.story_reports
  for each row execute function public.on_story_report_review();

grant select on public.story_reports to service_role;

-- 새 댓글 트리거도 자동 검토 시간을 고려해 기다리는 시간을 늘림
create or replace function public.on_story_comment_push()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://rqjfergjfhcrcuvfuhkm.supabase.co/functions/v1/community-push',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('comment_id', new.id),
    timeout_milliseconds := 60000
  );
  return null;
exception when others then
  return null; -- 알림이 실패해도 댓글은 저장
end $$;

grant update on public.story_posts, public.story_comments to service_role;
