-- 설비 일괄 처분 ("처분해요") — 구해요(20261122_rfq.sql)를 뒤집은 것. 같은 표·견적·한도·채팅·알림을 그대로 씀
--   kind = 'buy'(구해요: 업체가 판매 견적) | 'sell'(처분해요: 공장이 설비 목록을 올리고 매입 업체가 매입 제안가를 보냄)
--   처분해요는 30일 동안 열림, 사진 10장까지, 처분 사유·희망 시기
--   기존 요청은 모두 'buy' 로 그대로. 여러 번 실행해도 안전

alter table public.rfq_requests add column if not exists kind text not null default 'buy';
alter table public.rfq_requests add column if not exists photo_urls text[] not null default '{}';
alter table public.rfq_requests add column if not exists reason text not null default '';
alter table public.rfq_requests add column if not exists timeline text not null default '';
alter table public.rfq_requests drop constraint if exists rfq_requests_kind_check;
alter table public.rfq_requests add constraint rfq_requests_kind_check check (kind in ('buy', 'sell'));
alter table public.rfq_requests drop constraint if exists rfq_requests_photo_urls_check;
alter table public.rfq_requests add constraint rfq_requests_photo_urls_check check (cardinality(photo_urls) <= 10);
alter table public.rfq_requests drop constraint if exists rfq_requests_reason_check;
alter table public.rfq_requests add constraint rfq_requests_reason_check check (reason in ('', '폐업', '이전', '설비 교체', '재고 정리', '기타'));
alter table public.rfq_requests drop constraint if exists rfq_requests_timeline_check;
alter table public.rfq_requests add constraint rfq_requests_timeline_check check (length(timeline) <= 30);
-- 처분해요는 설비 목록이 길어서 내용 한도를 넉넉하게
alter table public.rfq_requests drop constraint if exists rfq_requests_detail_check;
alter table public.rfq_requests add constraint rfq_requests_detail_check check (length(detail) <= 3000);
create index if not exists rfq_requests_kind_idx on public.rfq_requests (kind, status, created_at desc);
grant select (kind, photo_urls, reason, timeline) on public.rfq_requests to anon, authenticated;

-- 올리기: 예전 7개 인자 호출(구해요 화면)도 그대로 동작 (새 인자는 기본값)
drop function if exists public.create_rfq(text, text, text, text, text, integer, text);
create or replace function public.create_rfq(p_title text, p_detail text, p_category text, p_region text, p_quantity text, p_budget integer, p_photo_url text,
  p_kind text default 'buy', p_photo_urls text[] default '{}', p_reason text default '', p_timeline text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); rid uuid; photos text[];
begin
  if me is null then return jsonb_build_object('error', 'login'); end if;
  if (select count(*) from rfq_requests where buyer_id = me and status = 'open' and expires_at > now()) >= 5 then return jsonb_build_object('error', 'too_many_open'); end if;
  if (select count(*) from rfq_requests where buyer_id = me and created_at > now() - interval '1 day') >= 10 then return jsonb_build_object('error', 'too_many_today'); end if;
  -- https 사진 주소만
  select coalesce(array_agg(u), '{}') into photos from unnest(coalesce(p_photo_urls, '{}')) u where u like 'https://%' and length(u) <= 500;
  insert into rfq_requests (buyer_id, kind, title, detail, category, region, quantity, budget, photo_url, photo_urls, reason, timeline, expires_at)
  values (me, coalesce(p_kind, 'buy'), btrim(p_title), coalesce(btrim(p_detail), ''), p_category, coalesce(btrim(p_region), ''), coalesce(btrim(p_quantity), ''), p_budget,
          coalesce(nullif(btrim(coalesce(p_photo_url, '')), ''), photos[1]), photos, coalesce(p_reason, ''), coalesce(btrim(p_timeline), ''),
          now() + case when p_kind = 'sell' then interval '30 days' else interval '14 days' end)
  returning id into rid;
  return jsonb_build_object('id', rid);
exception when check_violation then
  return jsonb_build_object('error', 'bad_input');
end $$;
revoke execute on function public.create_rfq(text, text, text, text, text, integer, text, text, text[], text, text) from anon, public;
grant execute on function public.create_rfq(text, text, text, text, text, integer, text, text, text[], text, text) to authenticated;

-- 상세: kind·사진들·사유·시기 추가
create or replace function public.rfq_view(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid(); r rfq_requests; role text; quotes jsonb := '[]'::jsonb; mine jsonb; q_biz uuid; q_name text; q_left integer;
begin
  select * into r from rfq_requests where id = p_id;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if me is not null and r.buyer_id = me then
    role := 'buyer';
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'seller_id', x.seller_id, 'business_id', x.business_id, 'business_name', b.name,
             'premium', coalesce(b.premium_until > now(), false), 'price', x.price, 'message', x.message, 'lead_time', x.lead_time, 'created_at', x.created_at)
             order by x.created_at), '[]'::jsonb)
      into quotes
      from rfq_quotes x left join businesses b on b.id = x.business_id
     where x.rfq_id = p_id;
  elsif me is not null then
    select jsonb_build_object('price', x.price, 'message', x.message, 'lead_time', x.lead_time, 'created_at', x.created_at) into mine
      from rfq_quotes x where x.rfq_id = p_id and x.seller_id = me;
    select business_id, business_name, left_count into q_biz, q_name, q_left from rfq_quota(me);
    role := case when mine is not null then 'quoted' when q_biz is null then 'need_biz' else 'seller' end;
  else
    role := 'guest';
  end if;
  return jsonb_build_object(
    'rfq', jsonb_build_object('id', r.id, 'kind', r.kind, 'title', r.title, 'detail', r.detail, 'category', r.category, 'region', r.region, 'quantity', r.quantity,
      'budget', r.budget, 'photo_url', r.photo_url, 'photo_urls', r.photo_urls, 'reason', r.reason, 'timeline', r.timeline,
      'status', case when r.status = 'open' and r.expires_at <= now() then 'expired' else r.status end,
      'quote_count', r.quote_count, 'expires_at', r.expires_at, 'created_at', r.created_at),
    'role', role, 'quotes', quotes, 'my_quote', mine,
    'quota', case when q_biz is null then null else jsonb_build_object('business_id', q_biz, 'business_name', q_name, 'left', q_left) end);
end $$;
revoke execute on function public.rfq_view(uuid) from public;
grant execute on function public.rfq_view(uuid) to anon, authenticated;

-- 마이 화면: 요청 종류(rfq_kind) 추가 — 결과 형식이 바뀌므로 지우고 다시 만듦
drop function if exists public.my_rfqs();
create or replace function public.my_rfqs()
returns table (id uuid, title text, status text, quote_count integer, created_at timestamptz, expires_at timestamptz, kind text, rfq_kind text)
language sql stable security definer set search_path = public as $$
  select r.id, r.title, case when r.status = 'open' and r.expires_at <= now() then 'expired' else r.status end, r.quote_count, r.created_at, r.expires_at, 'request', r.kind
    from rfq_requests r where r.buyer_id = auth.uid()
  union all
  select r.id, r.title, case when r.status = 'open' and r.expires_at <= now() then 'expired' else r.status end, r.quote_count, q.created_at, r.expires_at, 'quote', r.kind
    from rfq_quotes q join rfq_requests r on r.id = q.rfq_id where q.seller_id = auth.uid()
  order by 5 desc limit 100;
$$;
revoke execute on function public.my_rfqs() from anon, public;
grant execute on function public.my_rfqs() to authenticated;
