-- 이야기 글 맨 위 고정 (운영자만). 고정된 글은 목록 맨 위에 항상 보임
alter table public.story_posts add column if not exists pinned_at timestamptz;
create index if not exists story_posts_pinned_idx on public.story_posts (pinned_at desc) where pinned_at is not null;

-- 글쓴이는 고정 여부를 바꿀 수 없음 (운영자 함수로만)
create or replace function public.story_posts_guard()
returns trigger language plpgsql as $$
begin
  if current_setting('ps.internal', true) is distinct from '1' then
    if tg_op = 'INSERT' then
      new.author_id := auth.uid();
      new.like_count := 0; new.comment_count := 0; new.view_count := 0; new.report_count := 0;
      new.status := 'active'; new.created_at := now(); new.updated_at := now();
      new.pinned_at := null;
    else
      new.author_id := old.author_id; new.created_at := old.created_at;
      new.like_count := old.like_count; new.comment_count := old.comment_count;
      new.view_count := old.view_count; new.report_count := old.report_count;
      new.pinned_at := old.pinned_at;
      -- 본인은 지우기(deleted)만 할 수 있음. 숨김 글을 되살리거나 지운 글을 복구 못 함
      if new.status <> old.status and not (new.status = 'deleted') then new.status := old.status; end if;
      if old.status <> 'active' then new.body := old.body; new.images := old.images; new.topic := old.topic; new.status := old.status; end if;
      new.updated_at := now();
    end if;
  end if;
  return new;
end $$;

-- 운영자: 고정 / 고정 풀기
create or replace function public.story_admin_pin(p_id bigint, p_on boolean)
returns text language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.is_app_admin() then return 'forbidden'; end if;
  perform set_config('ps.internal', '1', true);
  update story_posts set pinned_at = case when p_on then now() else null end where id = p_id and status = 'active';
  get diagnostics n = row_count;
  perform set_config('ps.internal', '', true);
  return case when n > 0 then 'ok' else 'not_found' end;
end $$;
revoke execute on function public.story_admin_pin(bigint, boolean) from anon, public;
grant execute on function public.story_admin_pin(bigint, boolean) to authenticated;

-- 친구 초대 이벤트 공지(23번) 고정
do $$ begin
  perform set_config('ps.internal', '1', true);
  update public.story_posts set pinned_at = now() where id = 23 and status = 'active' and pinned_at is null;
end $$;
select id, pinned_at from public.story_posts where pinned_at is not null;
