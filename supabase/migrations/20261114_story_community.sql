-- 이야기 (커뮤니티): 당근 '동네생활'처럼 편하게 묻고 수다 떠는 곳
--   주제: question 궁금해요 · daily 일상·잡담 · seek 구해요·소개해요 · tip 정보·노하우
--   글 사진은 product-images 버킷의 {내 id}/community/... 에 올림
--   공감 수·댓글 수·조회 수·신고 수는 트리거만 바꿀 수 있음(ps.internal). 신고 5번이면 자동 숨김
--   새 댓글 → Edge Function community-push 가 글쓴이에게 웹 푸시 (Verify JWT 끔)
--   ※ DB 에 예전 사이트가 만든 빈 community_posts / community_comments 테이블(구조 다름)이 있어 이름을 story_* 로 씀. 예전 테이블은 건드리지 않음

-- 1) 글
create table if not exists public.story_posts (
  id bigint generated always as identity primary key,
  author_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  topic text not null check (topic in ('question', 'daily', 'seek', 'tip')),
  body text not null check (length(btrim(body)) between 1 and 3000),
  images jsonb not null default '[]'::jsonb check (jsonb_typeof(images) = 'array' and jsonb_array_length(images) <= 4),
  region text check (region is null or length(region) <= 60),
  like_count integer not null default 0,
  comment_count integer not null default 0,
  view_count integer not null default 0,
  report_count integer not null default 0,
  status text not null default 'active' check (status in ('active', 'hidden', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists story_posts_feed_idx on public.story_posts (status, created_at desc);
create index if not exists story_posts_topic_idx on public.story_posts (topic, created_at desc);
create index if not exists story_posts_author_idx on public.story_posts (author_id, created_at desc);

-- 2) 댓글 (한 단계)
create table if not exists public.story_comments (
  id bigint generated always as identity primary key,
  post_id bigint not null references public.story_posts(id) on delete cascade,
  author_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 1000),
  report_count integer not null default 0,
  status text not null default 'active' check (status in ('active', 'hidden', 'deleted')),
  created_at timestamptz not null default now()
);
create index if not exists story_comments_post_idx on public.story_comments (post_id, created_at);

-- 3) 공감 (한 사람 한 번)
create table if not exists public.story_likes (
  post_id bigint not null references public.story_posts(id) on delete cascade,
  profile_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, profile_id)
);

-- 4) 신고 (글 또는 댓글 하나에, 한 사람 한 번)
create table if not exists public.story_reports (
  id bigint generated always as identity primary key,
  reporter_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  post_id bigint references public.story_posts(id) on delete cascade,
  comment_id bigint references public.story_comments(id) on delete cascade,
  reason text check (reason is null or length(reason) <= 300),
  created_at timestamptz not null default now(),
  check ((post_id is null) <> (comment_id is null))
);
create unique index if not exists story_reports_post_uq on public.story_reports (reporter_id, post_id) where post_id is not null;
create unique index if not exists story_reports_comment_uq on public.story_reports (reporter_id, comment_id) where comment_id is not null;

-- ---- 지킴이: 사용자는 숫자·작성자·숨김 상태를 못 바꿈 ----
create or replace function public.story_posts_guard()
returns trigger language plpgsql as $$
begin
  if current_setting('ps.internal', true) is distinct from '1' then
    if tg_op = 'INSERT' then
      new.author_id := auth.uid();
      new.like_count := 0; new.comment_count := 0; new.view_count := 0; new.report_count := 0;
      new.status := 'active'; new.created_at := now(); new.updated_at := now();
    else
      new.author_id := old.author_id; new.created_at := old.created_at;
      new.like_count := old.like_count; new.comment_count := old.comment_count;
      new.view_count := old.view_count; new.report_count := old.report_count;
      -- 본인은 지우기(deleted)만 할 수 있음. 숨김 글을 되살리거나 지운 글을 복구 못 함
      if new.status <> old.status and not (new.status = 'deleted') then new.status := old.status; end if;
      if old.status <> 'active' then new.body := old.body; new.images := old.images; new.topic := old.topic; new.status := old.status; end if;
      new.updated_at := now();
    end if;
  end if;
  return new;
end $$;
drop trigger if exists story_posts_guard on public.story_posts;
create trigger story_posts_guard before insert or update on public.story_posts
  for each row execute function public.story_posts_guard();

create or replace function public.story_comments_guard()
returns trigger language plpgsql as $$
begin
  if current_setting('ps.internal', true) is distinct from '1' then
    if tg_op = 'INSERT' then
      new.author_id := auth.uid(); new.report_count := 0; new.status := 'active'; new.created_at := now();
    else
      -- 본인은 지우기만 (내용 수정 없음)
      new.author_id := old.author_id; new.post_id := old.post_id; new.body := old.body;
      new.report_count := old.report_count; new.created_at := old.created_at;
      if not (old.status = 'active' and new.status = 'deleted') then new.status := old.status; end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists story_comments_guard on public.story_comments;
create trigger story_comments_guard before insert or update on public.story_comments
  for each row execute function public.story_comments_guard();

-- ---- 숫자 맞추기 ----
create or replace function public.story_recount_comments()
returns trigger language plpgsql security definer set search_path = public as $$
declare pid bigint := coalesce(new.post_id, old.post_id);
begin
  perform set_config('ps.internal', '1', true);
  update public.story_posts set comment_count =
    (select count(*) from public.story_comments c where c.post_id = pid and c.status = 'active')
  where id = pid;
  perform set_config('ps.internal', '', true);
  return null;
end $$;
drop trigger if exists story_comments_count on public.story_comments;
create trigger story_comments_count after insert or update of status or delete on public.story_comments
  for each row execute function public.story_recount_comments();

create or replace function public.story_recount_likes()
returns trigger language plpgsql security definer set search_path = public as $$
declare pid bigint := coalesce(new.post_id, old.post_id);
begin
  perform set_config('ps.internal', '1', true);
  update public.story_posts set like_count =
    (select count(*) from public.story_likes l where l.post_id = pid)
  where id = pid;
  perform set_config('ps.internal', '', true);
  return null;
end $$;
drop trigger if exists story_likes_count on public.story_likes;
create trigger story_likes_count after insert or delete on public.story_likes
  for each row execute function public.story_recount_likes();

-- 신고 5번이면 숨김
create or replace function public.story_on_report()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform set_config('ps.internal', '1', true);
  if new.post_id is not null then
    update public.story_posts set report_count = report_count + 1,
      status = case when report_count + 1 >= 5 and status = 'active' then 'hidden' else status end
    where id = new.post_id;
  else
    update public.story_comments set report_count = report_count + 1,
      status = case when report_count + 1 >= 5 and status = 'active' then 'hidden' else status end
    where id = new.comment_id;
  end if;
  perform set_config('ps.internal', '', true);
  return null;
end $$;
drop trigger if exists story_reports_after_insert on public.story_reports;
create trigger story_reports_after_insert after insert on public.story_reports
  for each row execute function public.story_on_report();

-- 조회수 (글 열 때 한 번)
create or replace function public.story_view(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('ps.internal', '1', true);
  update public.story_posts set view_count = view_count + 1 where id = p_id and status = 'active';
  perform set_config('ps.internal', '', true);
end $$;
revoke execute on function public.story_view(bigint) from public;
grant execute on function public.story_view(bigint) to anon, authenticated;

-- ---- 권한 ----
-- 정책 안에서 같은 테이블을 다시 읽으면 RLS 가 무한 반복되므로, 확인·세기는 권한 검사 없는 함수로
create or replace function public.story_post_open(p_id bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.story_posts where id = p_id and status = 'active');
$$;
create or replace function public.story_my_recent(p_kind text)
returns integer language sql stable security definer set search_path = public as $$
  select case when p_kind = 'post' then
      (select count(*)::int from public.story_posts where author_id = auth.uid() and created_at > now() - interval '1 day')
    else
      (select count(*)::int from public.story_comments where author_id = auth.uid() and created_at > now() - interval '1 hour')
    end;
$$;
revoke execute on function public.story_post_open(bigint), public.story_my_recent(text) from public;
grant execute on function public.story_post_open(bigint) to anon, authenticated;
grant execute on function public.story_my_recent(text) to authenticated;

alter table public.story_posts enable row level security;
alter table public.story_comments enable row level security;
alter table public.story_likes enable row level security;
alter table public.story_reports enable row level security;

drop policy if exists story_posts_read on public.story_posts;
create policy story_posts_read on public.story_posts for select to anon, authenticated
  using (status = 'active' or author_id = auth.uid());
drop policy if exists story_posts_insert on public.story_posts;
create policy story_posts_insert on public.story_posts for insert to authenticated
  with check (
    author_id = auth.uid()
    -- 도배 막기: 하루 20개까지
    and public.story_my_recent('post') < 20
  );
drop policy if exists story_posts_update on public.story_posts;
create policy story_posts_update on public.story_posts for update to authenticated
  using (author_id = auth.uid()) with check (author_id = auth.uid());

drop policy if exists story_comments_read on public.story_comments;
create policy story_comments_read on public.story_comments for select to anon, authenticated
  using (status = 'active' and public.story_post_open(post_id));
drop policy if exists story_comments_insert on public.story_comments;
create policy story_comments_insert on public.story_comments for insert to authenticated
  with check (
    author_id = auth.uid()
    and public.story_post_open(post_id)
    and public.story_my_recent('comment') < 60 -- 도배 막기: 1시간 60개까지
  );
drop policy if exists story_comments_update on public.story_comments;
create policy story_comments_update on public.story_comments for update to authenticated
  using (author_id = auth.uid()) with check (author_id = auth.uid());

drop policy if exists story_likes_own on public.story_likes;
create policy story_likes_own on public.story_likes for all to authenticated
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());

drop policy if exists story_reports_insert on public.story_reports;
create policy story_reports_insert on public.story_reports for insert to authenticated
  with check (reporter_id = auth.uid());
drop policy if exists story_reports_own on public.story_reports;
create policy story_reports_own on public.story_reports for select to authenticated
  using (reporter_id = auth.uid());

revoke all on public.story_posts, public.story_comments, public.story_likes, public.story_reports from anon, authenticated;
grant select on public.story_posts, public.story_comments to anon;
grant select, insert, update on public.story_posts, public.story_comments to authenticated;
grant select, insert, delete on public.story_likes to authenticated;
grant select, insert on public.story_reports to authenticated;
grant select on public.story_posts, public.story_comments to service_role;

-- ---- 새 댓글 → 글쓴이에게 웹 푸시 (community-push) ----
create table if not exists public.story_push_sent (
  comment_id bigint primary key references public.story_comments(id) on delete cascade,
  sent_at timestamptz not null default now()
);
alter table public.story_push_sent enable row level security;
revoke all on public.story_push_sent from anon, authenticated;
grant select, insert on public.story_push_sent to service_role;

create or replace function public.on_story_comment_push()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://rqjfergjfhcrcuvfuhkm.supabase.co/functions/v1/community-push',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('comment_id', new.id)
  );
  return null;
exception when others then
  return null; -- 알림이 실패해도 댓글은 저장
end $$;
drop trigger if exists story_comments_push on public.story_comments;
create trigger story_comments_push after insert on public.story_comments
  for each row execute function public.on_story_comment_push();
