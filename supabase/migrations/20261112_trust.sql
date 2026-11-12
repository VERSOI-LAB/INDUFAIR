-- 개인 간 직접 거래(앱 밖 결제)의 신뢰 보완: 사기 신고 + 거래 후기
--   플랫폼은 직접 거래의 돈을 다루지 않음. 대신
--   1) 사기 신고: 같은 사람을 서로 다른 3명 이상이 신고하면 그 사람의 물건·채팅에 '주의' 표시 (운영자가 확인)
--   2) 거래 후기: 채팅으로 실제 대화한 상대(양쪽 다 메시지를 보냄) 또는 수령 완료된 안전결제 주문의 상대에게 한 번씩

-- 1) 사기 신고 ---------------------------------------------------------------
create table if not exists public.user_reports (
  id bigint generated always as identity primary key,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  target_id uuid not null references public.profiles(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  chat_id uuid references public.chats(id) on delete set null,
  reason text not null check (reason in ('fraud', 'fake_item', 'no_show', 'abusive', 'etc')),
  detail text check (detail is null or length(detail) <= 1000),
  status text not null default 'open' check (status in ('open', 'confirmed', 'dismissed')),  -- 운영자 처리
  created_at timestamptz not null default now(),
  unique (reporter_id, target_id),
  check (reporter_id <> target_id)
);
create index if not exists user_reports_target_idx on public.user_reports (target_id) where status <> 'dismissed';
alter table public.user_reports enable row level security;
drop policy if exists user_reports_select_own on public.user_reports;
create policy user_reports_select_own on public.user_reports for select to authenticated using (reporter_id = auth.uid());
revoke all on public.user_reports from anon, authenticated;
grant select on public.user_reports to authenticated;
grant select, update on public.user_reports to service_role;

-- 신고하기. 결과: 'ok' | 'login_required' | 'self' | 'bad_input' | 'already' | 'too_many'
create or replace function public.report_user(p_target uuid, p_reason text, p_detail text, p_product_id uuid, p_chat_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_detail text := nullif(btrim(coalesce(p_detail, '')), '');
begin
  if auth.uid() is null then return 'login_required'; end if;
  if p_target is null or p_target = auth.uid() then return 'self'; end if;
  if p_reason not in ('fraud', 'fake_item', 'no_show', 'abusive', 'etc') or length(coalesce(v_detail, '')) > 1000 then return 'bad_input'; end if;
  if not exists (select 1 from profiles where id = p_target) then return 'bad_input'; end if;
  if exists (select 1 from user_reports where reporter_id = auth.uid() and target_id = p_target) then return 'already'; end if;
  if (select count(*) from user_reports where reporter_id = auth.uid() and created_at > now() - interval '1 day') >= 10 then return 'too_many'; end if;
  insert into user_reports (reporter_id, target_id, product_id, chat_id, reason, detail)
  values (auth.uid(), p_target,
          (select id from products where id = p_product_id),
          (select id from chats where id = p_chat_id and auth.uid() in (buyer_id, seller_id)),
          p_reason, v_detail);
  return 'ok';
end $$;
revoke execute on function public.report_user(uuid, text, text, uuid, uuid) from anon, public;
grant execute on function public.report_user(uuid, text, text, uuid, uuid) to authenticated;

-- 2) 거래 후기 ---------------------------------------------------------------
create table if not exists public.trade_reviews (
  id bigint generated always as identity primary key,
  reviewer_id uuid not null references public.profiles(id) on delete cascade,
  reviewee_id uuid not null references public.profiles(id) on delete cascade,
  chat_id uuid references public.chats(id) on delete set null,
  order_id uuid references public.market_orders(id) on delete set null,
  product_title text,
  reviewer_role text not null check (reviewer_role in ('buyer', 'seller')),
  rating text not null check (rating in ('good', 'ok', 'bad')),
  comment text check (comment is null or length(comment) <= 300),
  created_at timestamptz not null default now(),
  check (reviewer_id <> reviewee_id),
  check (chat_id is not null or order_id is not null)
);
create unique index if not exists trade_reviews_chat_uq on public.trade_reviews (reviewer_id, chat_id) where chat_id is not null;
create unique index if not exists trade_reviews_order_uq on public.trade_reviews (reviewer_id, order_id) where order_id is not null;
create index if not exists trade_reviews_reviewee_idx on public.trade_reviews (reviewee_id, created_at desc);
alter table public.trade_reviews enable row level security;
drop policy if exists trade_reviews_select_own on public.trade_reviews;
create policy trade_reviews_select_own on public.trade_reviews for select to authenticated using (reviewer_id = auth.uid());
revoke all on public.trade_reviews from anon, authenticated;
grant select on public.trade_reviews to authenticated;
grant select, delete on public.trade_reviews to service_role;

-- 후기 남기기 (채팅 또는 주문 중 하나). 결과: 'ok' | 'login_required' | 'bad_input' | 'not_member' | 'not_traded' | 'already'
create or replace function public.write_trade_review(p_chat_id uuid, p_order_id uuid, p_rating text, p_comment text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid(); v_other uuid; v_role text; v_title text;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  c record; o record;
begin
  if v_me is null then return 'login_required'; end if;
  if p_rating not in ('good', 'ok', 'bad') or length(coalesce(v_comment, '')) > 300 then return 'bad_input'; end if;
  if (p_chat_id is null) = (p_order_id is null) then return 'bad_input'; end if;

  if p_chat_id is not null then
    select ch.id, ch.buyer_id, ch.seller_id, ch.product_id, pr.title into c
      from chats ch left join products pr on pr.id = ch.product_id where ch.id = p_chat_id;
    if not found or v_me not in (c.buyer_id, c.seller_id) then return 'not_member'; end if;
    if c.product_id is null then return 'not_traded'; end if;  -- 업체 문의 채팅은 후기 대상 아님
    -- 실제로 대화한 상대만: 양쪽 모두 메시지를 보냈어야 함
    if not exists (select 1 from messages where chat_id = c.id and sender_id = c.buyer_id)
       or not exists (select 1 from messages where chat_id = c.id and sender_id = c.seller_id) then return 'not_traded'; end if;
    if exists (select 1 from trade_reviews where reviewer_id = v_me and chat_id = c.id) then return 'already'; end if;
    v_other := case when v_me = c.buyer_id then c.seller_id else c.buyer_id end;
    v_role := case when v_me = c.buyer_id then 'buyer' else 'seller' end;
    v_title := c.title;
  else
    select id, buyer_id, seller_id, status, received_at, product_title into o from market_orders where id = p_order_id;
    if not found or v_me not in (o.buyer_id, o.seller_id) then return 'not_member'; end if;
    if o.status <> 'paid' or o.received_at is null then return 'not_traded'; end if;
    if exists (select 1 from trade_reviews where reviewer_id = v_me and order_id = o.id) then return 'already'; end if;
    v_other := case when v_me = o.buyer_id then o.seller_id else o.buyer_id end;
    v_role := case when v_me = o.buyer_id then 'buyer' else 'seller' end;
    v_title := o.product_title;
  end if;

  insert into trade_reviews (reviewer_id, reviewee_id, chat_id, order_id, product_title, reviewer_role, rating, comment)
  values (v_me, v_other, p_chat_id, p_order_id, left(v_title, 100), v_role, p_rating, v_comment);
  return 'ok';
end $$;
revoke execute on function public.write_trade_review(uuid, uuid, text, text) from anon, public;
grant execute on function public.write_trade_review(uuid, uuid, text, text) to authenticated;

-- 3) 공개용 요약·목록 -----------------------------------------------------------
-- 여러 사람의 신뢰 요약: 후기 수, 좋아요/보통/별로 수, 주의 표시(서로 다른 3명 이상 신고, 운영자가 기각한 신고 제외)
create or replace function public.get_trust(p_ids uuid[])
returns table (id uuid, review_count integer, good integer, ok integer, bad integer, warned boolean)
language sql stable security definer set search_path = public as $$
  select u.id,
    (select count(*)::int from trade_reviews r where r.reviewee_id = u.id),
    (select count(*)::int from trade_reviews r where r.reviewee_id = u.id and r.rating = 'good'),
    (select count(*)::int from trade_reviews r where r.reviewee_id = u.id and r.rating = 'ok'),
    (select count(*)::int from trade_reviews r where r.reviewee_id = u.id and r.rating = 'bad'),
    exists (select 1 from user_reports x where x.target_id = u.id and x.status = 'confirmed')
      or (select count(*) from user_reports x where x.target_id = u.id and x.status <> 'dismissed') >= 3
  from unnest(p_ids) as u(id);
$$;
grant execute on function public.get_trust(uuid[]) to anon, authenticated;

-- 받은 후기 목록 (작성자 이름은 공개 프로필 이름)
create or replace function public.get_reviews(p_profile uuid, p_limit integer default 30)
returns table (rating text, comment text, reviewer_role text, product_title text, created_at timestamptz, reviewer_name text, reviewer_avatar text)
language sql stable security definer set search_path = public as $$
  select r.rating, r.comment, r.reviewer_role, r.product_title, r.created_at, p.name, p.avatar_url
    from trade_reviews r left join profiles p on p.id = r.reviewer_id
   where r.reviewee_id = p_profile
   order by r.created_at desc
   limit least(greatest(coalesce(p_limit, 30), 1), 100);
$$;
grant execute on function public.get_reviews(uuid, integer) to anon, authenticated;
