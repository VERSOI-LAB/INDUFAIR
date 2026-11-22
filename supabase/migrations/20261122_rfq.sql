-- "이거 구해요" 견적 요청
--   구매자: 찾는 물건을 올림 (14일 동안 열림, 한 사람 동시에 5건·하루 10건까지)
--   업체(운영 중인 업체 소개가 있는 사람): 견적을 보냄. 무료는 30일에 3건, 프리미엄 업체가 있으면 무제한
--   구매자 정보(buyer_id)는 누구에게도 보이지 않음. 견적이 마음에 들면 구매자만 채팅을 시작할 수 있음 (업체 스팸 방지)
--   견적은 구매자와 그 견적을 낸 업체만 봄
--   알림: 새 요청 → 같은 분류·지역 업체에게, 새 견적 → 구매자에게 (Edge Function rfq-push, Verify JWT 끔)

-- 0) 같은 이름인데 구조가 다른 테이블이 이미 있으면 (예전에 대시보드에서 만든 것 등) 지우지 않고 이름만 바꿔 보관
--    rfq_requests → rfq_requests_old_20261122 (buyer_id 가 없을 때), rfq_quotes → rfq_quotes_old_20261122 (seller_id 가 없을 때)
--    그 테이블의 인덱스도 같이 이름을 바꿔서 아래 새 인덱스와 겹치지 않게. 필요 없으면 나중에 직접 drop
do $$
declare t text; col text; idx record;
begin
  foreach t in array array['rfq_quotes', 'rfq_requests'] loop
    col := case t when 'rfq_requests' then 'buyer_id' else 'seller_id' end;
    if to_regclass('public.' || t) is not null
       and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = col) then
      for idx in select indexname from pg_indexes where schemaname = 'public' and tablename = t loop
        execute format('alter index public.%I rename to %I', idx.indexname, left(idx.indexname, 40) || '_old_20261122');
      end loop;
      execute format('alter table public.%I rename to %I', t, t || '_old_20261122');
      raise notice '기존 % 테이블을 %_old_20261122 로 이름을 바꿔 보관했어요', t, t;
    end if;
  end loop;
end $$;

-- 예전에 같은 이름으로 만든 함수가 있으면 결과 형식이 달라 바꿀 수 없으므로 먼저 지움 (아래에서 다시 만듦)
drop function if exists public.rfq_quota(uuid);
drop function if exists public.rfq_view(uuid);
drop function if exists public.my_rfqs();
drop function if exists public.rfq_targets(uuid);
drop function if exists public.create_rfq(text, text, text, text, text, integer, text);
drop function if exists public.submit_quote(uuid, integer, text, text);
drop function if exists public.close_rfq(uuid);

-- 1) 요청 -----------------------------------------------------------------------
create table if not exists public.rfq_requests (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (length(title) between 2 and 60),
  detail text not null default '' check (length(detail) <= 1000),
  category text not null check (category in ('중고장터', '산업기계', '공구·부품', '자동화·전기', '물류·창고')),
  region text not null default '' check (length(region) <= 40),
  quantity text not null default '' check (length(quantity) <= 30),
  budget integer check (budget is null or budget between 0 and 10000000000),
  photo_url text check (photo_url is null or (photo_url like 'https://%' and length(photo_url) <= 500)),
  status text not null default 'open' check (status in ('open', 'closed', 'expired')),
  quote_count integer not null default 0,
  notified_count integer not null default 0,
  expires_at timestamptz not null default now() + interval '14 days',
  created_at timestamptz not null default now()
);
create index if not exists rfq_requests_open_idx on public.rfq_requests (status, created_at desc);
create index if not exists rfq_requests_buyer_idx on public.rfq_requests (buyer_id, created_at desc);
alter table public.rfq_requests enable row level security;
drop policy if exists rfq_requests_read on public.rfq_requests;
create policy rfq_requests_read on public.rfq_requests for select to anon, authenticated using (true);
revoke all on public.rfq_requests from anon, authenticated;
-- buyer_id 는 빼고 공개 (목록·상세는 누구나 볼 수 있음. 내 요청인지는 rfq_view 가 알려 줌)
grant select (id, title, detail, category, region, quantity, budget, photo_url, status, quote_count, expires_at, created_at) on public.rfq_requests to anon, authenticated;
grant all on public.rfq_requests to service_role;

-- 2) 견적 -----------------------------------------------------------------------
create table if not exists public.rfq_quotes (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid not null references public.rfq_requests(id) on delete cascade,
  seller_id uuid not null references public.profiles(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete set null,
  price integer check (price is null or price between 0 and 10000000000),
  message text not null check (length(message) between 1 and 500),
  lead_time text not null default '' check (length(lead_time) <= 30),
  created_at timestamptz not null default now(),
  unique (rfq_id, seller_id)
);
create index if not exists rfq_quotes_seller_idx on public.rfq_quotes (seller_id, created_at desc);
alter table public.rfq_quotes enable row level security;
revoke all on public.rfq_quotes from anon, authenticated;
grant all on public.rfq_quotes to service_role;
-- 읽기·쓰기는 아래 함수로만

-- 3) 함수 -----------------------------------------------------------------------
-- 견적을 보낼 수 있는 업체와 남은 횟수 (-1 = 무제한)
create or replace function public.rfq_quota(p_uid uuid)
returns table (business_id uuid, business_name text, left_count integer)
language sql stable security definer set search_path = public as $$
  select b.id, b.name,
         case when exists (select 1 from businesses x where x.owner_id = p_uid and x.status = 'active' and x.premium_until > now()) then -1
              else greatest(0, 3 - (select count(*)::integer from rfq_quotes q where q.seller_id = p_uid and q.created_at > now() - interval '30 days')) end
    from businesses b
   where b.owner_id = p_uid and b.status = 'active'
   order by b.premium_until desc nulls last, b.created_at
   limit 1;
$$;
revoke execute on function public.rfq_quota(uuid) from anon, authenticated, public;

create or replace function public.create_rfq(p_title text, p_detail text, p_category text, p_region text, p_quantity text, p_budget integer, p_photo_url text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); rid uuid;
begin
  if me is null then return jsonb_build_object('error', 'login'); end if;
  if (select count(*) from rfq_requests where buyer_id = me and status = 'open' and expires_at > now()) >= 5 then return jsonb_build_object('error', 'too_many_open'); end if;
  if (select count(*) from rfq_requests where buyer_id = me and created_at > now() - interval '1 day') >= 10 then return jsonb_build_object('error', 'too_many_today'); end if;
  insert into rfq_requests (buyer_id, title, detail, category, region, quantity, budget, photo_url)
  values (me, btrim(p_title), coalesce(btrim(p_detail), ''), p_category, coalesce(btrim(p_region), ''), coalesce(btrim(p_quantity), ''), p_budget,
          nullif(btrim(coalesce(p_photo_url, '')), ''))
  returning id into rid;
  return jsonb_build_object('id', rid);
exception when check_violation then
  return jsonb_build_object('error', 'bad_input');
end $$;
revoke execute on function public.create_rfq(text, text, text, text, text, integer, text) from anon, public;
grant execute on function public.create_rfq(text, text, text, text, text, integer, text) to authenticated;

-- 상세 화면: 요청 + 내 역할 + (구매자면) 받은 견적 전부 / (업체면) 내 견적과 남은 횟수
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
    'rfq', jsonb_build_object('id', r.id, 'title', r.title, 'detail', r.detail, 'category', r.category, 'region', r.region, 'quantity', r.quantity,
      'budget', r.budget, 'photo_url', r.photo_url, 'status', case when r.status = 'open' and r.expires_at <= now() then 'expired' else r.status end,
      'quote_count', r.quote_count, 'expires_at', r.expires_at, 'created_at', r.created_at),
    'role', role, 'quotes', quotes, 'my_quote', mine,
    'quota', case when q_biz is null then null else jsonb_build_object('business_id', q_biz, 'business_name', q_name, 'left', q_left) end);
end $$;
revoke execute on function public.rfq_view(uuid) from public;
grant execute on function public.rfq_view(uuid) to anon, authenticated;

create or replace function public.submit_quote(p_rfq uuid, p_price integer, p_message text, p_lead_time text)
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); r rfq_requests; q_biz uuid; q_left integer;
begin
  if me is null then return 'login'; end if;
  select * into r from rfq_requests where id = p_rfq for update;
  if not found then return 'not_found'; end if;
  if r.status <> 'open' or r.expires_at <= now() then return 'closed'; end if;
  if r.buyer_id = me then return 'own'; end if;
  if is_blocked_between(me, r.buyer_id) then return 'blocked'; end if;
  if exists (select 1 from rfq_quotes where rfq_id = p_rfq and seller_id = me) then return 'already'; end if;
  select business_id, left_count into q_biz, q_left from rfq_quota(me);
  if q_biz is null then return 'need_biz'; end if;
  if q_left = 0 then return 'quota'; end if;
  insert into rfq_quotes (rfq_id, seller_id, business_id, price, message, lead_time)
  values (p_rfq, me, q_biz, p_price, btrim(p_message), coalesce(btrim(p_lead_time), ''));
  update rfq_requests set quote_count = quote_count + 1 where id = p_rfq;
  return 'ok';
exception when check_violation then
  return 'bad_input';
end $$;
revoke execute on function public.submit_quote(uuid, integer, text, text) from anon, public;
grant execute on function public.submit_quote(uuid, integer, text, text) to authenticated;

create or replace function public.close_rfq(p_id uuid)
returns text language plpgsql security definer set search_path = public as $$
begin
  update rfq_requests set status = 'closed' where id = p_id and buyer_id = auth.uid() and status = 'open';
  return case when found then 'ok' else 'not_found' end;
end $$;
revoke execute on function public.close_rfq(uuid) from anon, public;
grant execute on function public.close_rfq(uuid) to authenticated;

-- 내가 올린 요청 / 내가 견적 낸 요청 (마이 화면)
create or replace function public.my_rfqs()
returns table (id uuid, title text, status text, quote_count integer, created_at timestamptz, expires_at timestamptz, kind text)
language sql stable security definer set search_path = public as $$
  select r.id, r.title, case when r.status = 'open' and r.expires_at <= now() then 'expired' else r.status end, r.quote_count, r.created_at, r.expires_at, 'request'
    from rfq_requests r where r.buyer_id = auth.uid()
  union all
  select r.id, r.title, case when r.status = 'open' and r.expires_at <= now() then 'expired' else r.status end, r.quote_count, q.created_at, r.expires_at, 'quote'
    from rfq_quotes q join rfq_requests r on r.id = q.rfq_id where q.seller_id = auth.uid()
  order by 5 desc limit 100;
$$;
revoke execute on function public.my_rfqs() from anon, public;
grant execute on function public.my_rfqs() to authenticated;

-- 알림 받을 업체 주인: 같은 분류이면서 같은 지역 → 같은 분류 → 같은 지역 순, 30명까지 (rfq-push 가 부름)
create or replace function public.rfq_targets(p_id uuid)
returns table (owner_id uuid, score integer)
language sql stable security definer set search_path = public as $$
  with r as (select * from rfq_requests where id = p_id),
  words as (select w from r, regexp_split_to_table(r.region, '\s+') w where w ~ '^[가-힣]{1,6}(시|군|구)$')
  select b.owner_id, max((case when c.name = r.category then 2 else 0 end) + (case when exists (select 1 from words where b.region like '%' || words.w || '%') then 1 else 0 end))::integer as score
    from businesses b cross join r left join categories c on c.id = b.category_id
   where b.status = 'active' and b.owner_id <> r.buyer_id
     and (c.name = r.category or exists (select 1 from words where b.region like '%' || words.w || '%'))
     and not is_blocked_between(b.owner_id, r.buyer_id)
   group by b.owner_id
   order by 2 desc
   limit 30;
$$;
revoke execute on function public.rfq_targets(uuid) from anon, authenticated, public;
grant execute on function public.rfq_targets(uuid) to service_role;

-- 4) 알림 트리거 (pg_net, 실패해도 저장은 됨) -------------------------------------
create or replace function public.on_rfq_push()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://rqjfergjfhcrcuvfuhkm.supabase.co/functions/v1/rfq-push',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := case when tg_table_name = 'rfq_requests' then jsonb_build_object('rfq_id', new.id) else jsonb_build_object('quote_id', new.id) end
  );
  return null;
exception when others then
  return null;
end $$;
drop trigger if exists rfq_requests_push on public.rfq_requests;
create trigger rfq_requests_push after insert on public.rfq_requests for each row execute function public.on_rfq_push();
drop trigger if exists rfq_quotes_push on public.rfq_quotes;
create trigger rfq_quotes_push after insert on public.rfq_quotes for each row execute function public.on_rfq_push();

-- 5) 14일 지나면 마감 (매일 새벽) -------------------------------------------------
select cron.unschedule('rfq-expire') where exists (select 1 from cron.job where jobname = 'rfq-expire');
select cron.schedule('rfq-expire', '10 18 * * *', $$
  update public.rfq_requests set status = 'expired' where status = 'open' and expires_at <= now();
$$);
