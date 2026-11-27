-- 유료 서비스: 업체 플랜(무료·프로·비즈) + 이용권(견적권·매입 제안권) + 광고 자리
--   결제는 계좌이체만 (토스페이먼츠 안 씀). 회사 통장 입금을 팝빌 계좌조회로 확인하고, 세금계산서도 팝빌로 자동 발행
--   흐름: 업체가 주문(create_billing_order) → 입금자명 코드·금액 안내 → Edge Function bank-sync 가 10분마다 입금 내역을 가져와
--         코드·금액이 맞으면 주문 처리(apply_billing_order: 플랜 기간·이용권 넣기) → 세금계산서 발행
--   맞지 않는 입금은 운영자 화면(/admin/billing)의 '확인 필요'에 남음
--   가격은 billing_products 한 곳에서 (공급가액 = 부가세 별도 금액, 입금액 = 공급가액 + 부가세 10%)
--   가입 후 30일은 프로 플랜을 무료로 씀 (첫 달 무료)
--   회원 간 거래 대금은 여전히 다루지 않음. 여기서 받는 돈은 모두 회사 자신의 서비스 이용요금
--   20261003_biz_premium.sql, 20261122_rfq.sql, 20261123_rfq_sell.sql, 20261123_weekly_briefing.sql 다음에 실행. 여러 번 실행해도 안전

-- 0) 토스 자동결제 끄기 ----------------------------------------------------------------
--    더 이상 카드로 청구하지 않음. 이미 결제한 기간(premium_until)은 그대로 둠
select cron.unschedule('biz-billing-cron') where exists (select 1 from cron.job where jobname = 'biz-billing-cron');
do $$ begin
  if to_regclass('public.biz_subscriptions') is not null then
    update public.biz_subscriptions set status = 'canceled', next_charge_at = null, canceled_at = coalesce(canceled_at, now()), updated_at = now()
     where status in ('active', 'past_due');
  end if;
end $$;

-- 1) 설정: 입금 받을 계좌 (화면에 보여 줌) ---------------------------------------------------
create table if not exists public.billing_settings (
  id integer primary key default 1 check (id = 1),
  bank_name text not null default '',        -- 예: 기업은행
  account_no text not null default '',       -- 예: 123-456789-01-012
  account_holder text not null default '',   -- 예: 베르소이
  pay_days integer not null default 3,       -- 주문 후 며칠 안에 입금
  updated_at timestamptz not null default now()
);
insert into public.billing_settings (id) values (1) on conflict (id) do nothing;
alter table public.billing_settings enable row level security;
drop policy if exists billing_settings_read on public.billing_settings;
create policy billing_settings_read on public.billing_settings for select to anon, authenticated using (true);
revoke all on public.billing_settings from anon, authenticated;
grant select on public.billing_settings to anon, authenticated;
grant all on public.billing_settings to service_role;

-- 2) 상품 (가격표) ------------------------------------------------------------------------
--    supply_amount = 공급가액(부가세 별도). 입금액은 공급가액 + 부가세(10%, 원 단위 버림 없이 정확히 나눠떨어지게 1,000원 단위로 정함)
create table if not exists public.billing_products (
  code text primary key,
  kind text not null check (kind in ('plan', 'pack', 'ad')),
  name text not null,
  tier text check (tier in ('pro', 'biz')),
  months integer not null default 0,
  quote_credits integer not null default 0,
  offer_credits integer not null default 0,
  supply_amount integer not null check (supply_amount >= 0),
  list_supply integer,            -- 할인 전 금액 (화면에 줄 그어 표시, 12개월 할인)
  sort integer not null default 0,
  active boolean not null default true
);
alter table public.billing_products enable row level security;
drop policy if exists billing_products_read on public.billing_products;
create policy billing_products_read on public.billing_products for select to anon, authenticated using (true);
revoke all on public.billing_products from anon, authenticated;
grant select on public.billing_products to anon, authenticated;
grant all on public.billing_products to service_role;

insert into public.billing_products (code, kind, name, tier, months, quote_credits, offer_credits, supply_amount, list_supply, sort) values
  ('pro_1',    'plan', '프로 플랜 1개월',  'pro', 1,  0, 0,  30000,   30000, 10),
  ('pro_3',    'plan', '프로 플랜 3개월',  'pro', 3,  0, 0,  90000,   90000, 11),
  ('pro_12',   'plan', '프로 플랜 12개월', 'pro', 12, 0, 0, 300000,  360000, 12),
  ('biz_1',    'plan', '비즈 플랜 1개월',  'biz', 1,  0, 0,  90000,   90000, 20),
  ('biz_3',    'plan', '비즈 플랜 3개월',  'biz', 3,  0, 0, 270000,  270000, 21),
  ('biz_12',   'plan', '비즈 플랜 12개월', 'biz', 12, 0, 0, 900000, 1080000, 22),
  ('quote_10', 'pack', '견적권 10장',      null,  0, 10, 0,  20000,   20000, 30),
  ('offer_3',  'pack', '매입 제안권 3장',  null,  0,  0, 3,  30000,   30000, 31),
  ('ad',       'ad',   '광고 게재',        null,  0,  0, 0,      0,    null, 90)
on conflict (code) do update set kind = excluded.kind, name = excluded.name, tier = excluded.tier, months = excluded.months,
  quote_credits = excluded.quote_credits, offer_credits = excluded.offer_credits, sort = excluded.sort;
-- 가격(supply_amount·list_supply)은 처음 한 번만 넣고, 그 뒤에는 이 파일을 다시 실행해도 바꾸지 않음 (운영 중 바꾼 가격 보호)
-- 가격 바꾸기: update billing_products set supply_amount = 35000, list_supply = 35000 where code = 'pro_1';

-- 플랜별 30일 기준 보낼 수 있는 수 (-1 = 무제한). 여기 한 곳에서 바꿈
--   kind 'buy' = 구해요 견적, 'sell' = 설비 처분 매입 제안
create or replace function public.plan_limit(p_tier text, p_kind text)
returns integer language sql immutable as $$
  select case when p_kind = 'sell'
    then case p_tier when 'biz' then 10 when 'pro' then 3 else 0 end
    else case p_tier when 'biz' then -1 when 'pro' then 30 else 3 end end;
$$;

-- 3) 업체 플랜 -----------------------------------------------------------------------------
--    premium_until 은 지금처럼 '노출 혜택'(맨 앞 고정·매일 끌어올리기·추천 물건)이 끝나는 시각 (유료 플랜·첫 달 무료·초대 보상 모두)
--    plan_tier/plan_until 은 돈을 내고 산 플랜 (견적·제안 한도를 정함)
alter table public.businesses add column if not exists plan_tier text;
alter table public.businesses add column if not exists plan_until timestamptz;
alter table public.businesses drop constraint if exists businesses_plan_tier_check;
alter table public.businesses add constraint businesses_plan_tier_check check (plan_tier is null or plan_tier in ('pro', 'biz'));

-- 가입 후 첫 달 무료가 끝나는 시각 (가입 30일 뒤)
create or replace function public.trial_until(p_uid uuid)
returns timestamptz language sql stable security definer set search_path = public, auth as $$
  select u.created_at + interval '30 days' from auth.users u where u.id = p_uid;
$$;
revoke execute on function public.trial_until(uuid) from anon, authenticated, public;

-- 주인이 직접 혜택 컬럼을 바꾸지 못하게 (서버 함수만). 새 업체는 첫 달 무료 기간 동안 노출 혜택을 받음
create or replace function public.businesses_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare t timestamptz;
begin
  if current_setting('ps.internal', true) is distinct from '1' then
    if tg_op = 'INSERT' then
      new.like_count := 0; new.view_count := 0; new.report_count := 0;
      new.status := 'active'; new.hidden_reason := null; new.bumped_at := now(); new.created_at := now();
      t := trial_until(new.owner_id);
      new.premium_until := case when t > now() then t end;
      new.plan_tier := null; new.plan_until := null;
    else
      new.like_count := old.like_count; new.view_count := old.view_count; new.report_count := old.report_count;
      new.bumped_at := old.bumped_at; new.created_at := old.created_at; new.owner_id := old.owner_id;
      new.hidden_reason := old.hidden_reason;
      new.premium_until := old.premium_until;
      new.plan_tier := old.plan_tier; new.plan_until := old.plan_until;
      if old.status = 'hidden' and new.status = 'active' then new.status := 'hidden'; end if;
    end if;
  end if;
  return new;
end $$;

-- 지금 쓰는 플랜: 'biz' | 'pro' | 'free'
--   유료 비즈 > 유료 프로 = 첫 달 무료 = 초대 보상(premium_until) > 무료
create or replace function public.biz_tier(p_uid uuid)
returns text language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from businesses where owner_id = p_uid and status = 'active' and plan_tier = 'biz' and plan_until > now()) then 'biz'
    when exists (select 1 from businesses where owner_id = p_uid and status = 'active' and ((plan_tier = 'pro' and plan_until > now()) or premium_until > now())) then 'pro'
    when trial_until(p_uid) > now() then 'pro'
    else 'free' end;
$$;
revoke execute on function public.biz_tier(uuid) from anon, authenticated, public;

-- 4) 이용권 지갑 ---------------------------------------------------------------------------
create table if not exists public.credit_wallets (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  quote_credits integer not null default 0 check (quote_credits >= 0),
  offer_credits integer not null default 0 check (offer_credits >= 0),
  updated_at timestamptz not null default now()
);
alter table public.credit_wallets enable row level security;
drop policy if exists credit_wallets_own on public.credit_wallets;
create policy credit_wallets_own on public.credit_wallets for select to authenticated using (profile_id = auth.uid());
revoke all on public.credit_wallets from anon, authenticated;
grant select on public.credit_wallets to authenticated;
grant all on public.credit_wallets to service_role;

create table if not exists public.credit_ledger (
  id bigint generated always as identity primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('quote', 'offer')),
  delta integer not null,
  reason text not null check (reason in ('purchase', 'use', 'refund', 'admin')),
  order_id uuid,
  quote_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists credit_ledger_profile_idx on public.credit_ledger (profile_id, created_at desc);
alter table public.credit_ledger enable row level security;
drop policy if exists credit_ledger_own on public.credit_ledger;
create policy credit_ledger_own on public.credit_ledger for select to authenticated using (profile_id = auth.uid());
revoke all on public.credit_ledger from anon, authenticated;
grant select on public.credit_ledger to authenticated;
grant all on public.credit_ledger to service_role;

create or replace function public.add_credits(p_uid uuid, p_kind text, p_delta integer, p_reason text, p_order uuid, p_quote uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare left_n integer;
begin
  insert into credit_wallets (profile_id) values (p_uid) on conflict (profile_id) do nothing;
  if p_kind = 'quote' then
    update credit_wallets set quote_credits = greatest(0, quote_credits + p_delta), updated_at = now() where profile_id = p_uid returning quote_credits into left_n;
  else
    update credit_wallets set offer_credits = greatest(0, offer_credits + p_delta), updated_at = now() where profile_id = p_uid returning offer_credits into left_n;
  end if;
  insert into credit_ledger (profile_id, kind, delta, reason, order_id, quote_id) values (p_uid, p_kind, p_delta, p_reason, p_order, p_quote);
  return left_n;
end $$;
revoke execute on function public.add_credits(uuid, text, integer, text, uuid, uuid) from anon, authenticated, public;

-- 5) 광고 자리 -----------------------------------------------------------------------------
--    운영자가 광고주와 계약하고 등록. 지원사업 목록·상세, 교육·행사 목록, 30초 진단 결과에 '광고' 표시와 함께 1개
create table if not exists public.ad_campaigns (
  id uuid primary key default gen_random_uuid(),
  advertiser text not null check (length(advertiser) between 1 and 60),
  placement text not null check (placement in ('support_list', 'support_detail', 'events', 'diagnose')),
  title text not null check (length(title) between 1 and 40),
  body text not null default '' check (length(body) <= 80),
  image_url text check (image_url is null or (image_url like 'https://%' and length(image_url) <= 500)),
  link_url text not null check (link_url like 'https://%' and length(link_url) <= 500),
  cta text not null default '자세히 보기' check (length(cta) between 1 and 12),
  starts_on date not null,
  ends_on date not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'ended')),
  note text not null default '',
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);
alter table public.ad_campaigns enable row level security;
revoke all on public.ad_campaigns from anon, authenticated;
grant all on public.ad_campaigns to service_role;

-- 지금 보여 줄 광고 (한국 날짜 기준 기간 안, 켜진 것). 여러 개면 무작위로 하나
create or replace function public.active_ad(p_placement text)
returns table (id uuid, advertiser text, title text, body text, image_url text, link_url text, cta text)
language sql volatile security definer set search_path = public as $$
  select a.id, a.advertiser, a.title, a.body, a.image_url, a.link_url, a.cta
    from ad_campaigns a
   where a.placement = p_placement and a.status = 'active'
     and (now() at time zone 'Asia/Seoul')::date between a.starts_on and a.ends_on
   order by random() limit 1;
$$;
revoke execute on function public.active_ad(text) from public;
grant execute on function public.active_ad(text) to anon, authenticated;

-- 광고 문의 (광고 안내 화면 /ads 의 문의 양식, 로그인 없이도)
create table if not exists public.ad_inquiries (
  id bigint generated always as identity primary key,
  company text not null check (length(company) between 1 and 60),
  contact_name text not null default '' check (length(contact_name) <= 30),
  phone text not null default '' check (length(phone) <= 20),
  email text not null check (length(email) between 3 and 120 and email like '%@%'),
  placement text not null default '' check (length(placement) <= 40),
  message text not null default '' check (length(message) <= 1000),
  profile_id uuid references public.profiles(id) on delete set null,
  status text not null default 'new' check (status in ('new', 'done')),
  created_at timestamptz not null default now()
);
alter table public.ad_inquiries enable row level security;
revoke all on public.ad_inquiries from anon, authenticated;
grant all on public.ad_inquiries to service_role;

create or replace function public.submit_ad_inquiry(p_company text, p_contact_name text, p_phone text, p_email text, p_placement text, p_message text)
returns text language plpgsql security definer set search_path = public as $$
begin
  if coalesce(btrim(p_company), '') = '' or coalesce(p_email, '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return 'bad_input'; end if;
  if (select count(*) from ad_inquiries where lower(email) = lower(btrim(p_email)) and created_at > now() - interval '1 day') >= 3 then return 'too_many'; end if;
  if (select count(*) from ad_inquiries where created_at > now() - interval '1 day') >= 50 then return 'too_many'; end if;
  insert into ad_inquiries (company, contact_name, phone, email, placement, message, profile_id)
  values (btrim(p_company), coalesce(btrim(p_contact_name), ''), coalesce(btrim(p_phone), ''), btrim(p_email), coalesce(p_placement, ''), coalesce(btrim(p_message), ''), auth.uid());
  return 'ok';
exception when check_violation then
  return 'bad_input';
end $$;
revoke execute on function public.submit_ad_inquiry(text, text, text, text, text, text) from public;
grant execute on function public.submit_ad_inquiry(text, text, text, text, text, text) to anon, authenticated;

-- 6) 주문 ---------------------------------------------------------------------------------
create table if not exists public.billing_orders (
  id uuid primary key default gen_random_uuid(),
  order_no text not null unique,                    -- 세금계산서 문서번호로도 씀 (예: PS261127-A1B2C3)
  profile_id uuid references public.profiles(id) on delete set null,
  business_id uuid references public.businesses(id) on delete set null,
  ad_campaign_id uuid references public.ad_campaigns(id) on delete set null,
  product_code text not null references public.billing_products(code),
  item_name text not null,
  supply_amount integer not null check (supply_amount > 0),
  vat_amount integer not null check (vat_amount >= 0),
  total_amount integer not null check (total_amount > 0),
  depositor_code text not null,                     -- 입금자명에 넣을 코드 (예: PS4821)
  status text not null default 'pending' check (status in ('pending', 'paid', 'canceled', 'expired', 'refunded')),
  expires_at timestamptz not null,
  paid_at timestamptz,
  deposit_id bigint,
  applied jsonb not null default '{}'::jsonb,       -- 넣어 준 것 (플랜 기간, 이용권 장수): 환불할 때 씀
  -- 세금계산서 받는 쪽 (주문할 때 사업자 인증 정보로 채움)
  buyer_corp_num text not null,
  buyer_corp_name text not null,
  buyer_ceo text not null default '',
  buyer_addr text not null default '',
  buyer_biz_type text not null default '',
  buyer_biz_item text not null default '',
  buyer_email text not null default '',
  -- canceled: 발행 전에 전액 환불해서 발행하지 않음
  invoice_status text not null default 'pending' check (invoice_status in ('pending', 'issued', 'failed', 'canceled')),
  invoice_nts_no text,
  invoice_error text,
  invoice_issued_at timestamptz,
  -- 환불 (운영자가 이체한 뒤 기록. 수정세금계산서 자동 발행)
  refund_supply integer,
  refund_amount integer,
  refunded_at timestamptz,
  refund_invoice_status text check (refund_invoice_status is null or refund_invoice_status in ('pending', 'issued', 'failed')),
  refund_invoice_nts_no text,
  refund_invoice_error text,
  created_by_admin boolean not null default false,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.billing_orders drop constraint if exists billing_orders_invoice_status_check;
alter table public.billing_orders add constraint billing_orders_invoice_status_check check (invoice_status in ('pending', 'issued', 'failed', 'canceled'));
create index if not exists billing_orders_profile_idx on public.billing_orders (profile_id, created_at desc);
create index if not exists billing_orders_status_idx on public.billing_orders (status, created_at desc);
create index if not exists billing_orders_invoice_idx on public.billing_orders (invoice_status) where invoice_status in ('pending', 'failed');
-- 입금 대기 중인 주문끼리는 입금자명 코드가 겹치지 않게
create unique index if not exists billing_orders_code_pending_idx on public.billing_orders (depositor_code) where status = 'pending';
alter table public.billing_orders enable row level security;
drop policy if exists billing_orders_own on public.billing_orders;
create policy billing_orders_own on public.billing_orders for select to authenticated using (profile_id = auth.uid());
revoke all on public.billing_orders from anon, authenticated;
grant select (id, order_no, business_id, product_code, item_name, supply_amount, vat_amount, total_amount, depositor_code, status, expires_at, paid_at,
  applied, buyer_corp_name, buyer_email, invoice_status, invoice_issued_at, refund_amount, refunded_at, created_at)
  on public.billing_orders to authenticated;
grant all on public.billing_orders to service_role;

-- 7) 통장 입금 내역 (팝빌 계좌조회에서 가져옴) ------------------------------------------------
create table if not exists public.bank_deposits (
  id bigint generated always as identity primary key,
  tid text not null unique,                 -- 팝빌 거래내역 아이디 (같은 입금을 두 번 넣지 않게)
  traded_at timestamptz not null,
  amount integer not null,
  depositor text not null default '',       -- 적요·입금자명 (은행마다 들어가는 칸이 달라 합쳐서 저장)
  status text not null default 'new' check (status in ('new', 'matched', 'unmatched', 'ignored')),
  order_id uuid references public.billing_orders(id) on delete set null,
  raw jsonb,
  created_at timestamptz not null default now()
);
create index if not exists bank_deposits_status_idx on public.bank_deposits (status, traded_at desc);
alter table public.bank_deposits enable row level security;
revoke all on public.bank_deposits from anon, authenticated;
grant all on public.bank_deposits to service_role;

-- 마지막으로 입금 내역을 가져온 시각 (너무 자주 부르지 않게)
create table if not exists public.billing_sync_state (
  id integer primary key default 1 check (id = 1),
  last_sync_at timestamptz,
  last_result jsonb
);
insert into public.billing_sync_state (id) values (1) on conflict (id) do nothing;
alter table public.billing_sync_state enable row level security;
revoke all on public.billing_sync_state from anon, authenticated;
grant all on public.billing_sync_state to service_role;

-- 8) 주문 만들기 (업체 주인) --------------------------------------------------------------------
--    결과: { order } | { error: login | bad_product | need_verify | need_biz | other_tier | too_many }
create or replace function public.order_json(o billing_orders)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', o.id, 'order_no', o.order_no, 'business_id', o.business_id, 'product_code', o.product_code, 'item_name', o.item_name,
    'supply_amount', o.supply_amount, 'vat_amount', o.vat_amount, 'total_amount', o.total_amount, 'depositor_code', o.depositor_code,
    'status', o.status, 'expires_at', o.expires_at, 'paid_at', o.paid_at, 'applied', o.applied, 'buyer_corp_name', o.buyer_corp_name,
    'buyer_email', o.buyer_email, 'invoice_status', o.invoice_status, 'invoice_issued_at', o.invoice_issued_at,
    'refund_amount', o.refund_amount, 'refunded_at', o.refunded_at, 'created_at', o.created_at);
$$;

create or replace function public.new_depositor_code()
returns text language plpgsql volatile security definer set search_path = public as $$
declare c text; i integer := 0;
begin
  loop
    c := 'PS' || lpad((floor(random() * 10000))::integer::text, 4, '0');
    exit when not exists (select 1 from billing_orders where depositor_code = c and status in ('pending', 'expired') and created_at > now() - interval '30 days');
    i := i + 1;
    if i > 50 then c := 'PS' || lpad((floor(random() * 100000))::integer::text, 5, '0'); exit; end if;
  end loop;
  return c;
end $$;
revoke execute on function public.new_depositor_code() from anon, authenticated, public;

create or replace function public.new_order_no()
returns text language sql volatile as $$
  select 'PS' || to_char(now() at time zone 'Asia/Seoul', 'YYMMDD') || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 6));
$$;

create or replace function public.create_billing_order(p_product text, p_business_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare me uuid := auth.uid(); p billing_products; v business_verifications; b businesses; o billing_orders; em text; days integer;
begin
  if me is null then return jsonb_build_object('error', 'login'); end if;
  select * into p from billing_products where code = p_product and active and kind in ('plan', 'pack') and supply_amount > 0;
  if not found then return jsonb_build_object('error', 'bad_product'); end if;
  -- 세금계산서를 받을 사업자 정보
  select * into v from business_verifications where profile_id = me;
  if not found then return jsonb_build_object('error', 'need_verify'); end if;
  if p.kind = 'plan' then
    select * into b from businesses where id = p_business_id and owner_id = me and status = 'active';
    if not found then return jsonb_build_object('error', 'need_biz'); end if;
    -- 다른 플랜을 쓰는 중이면 끝난 뒤에 바꿈 (남은 기간 계산은 고객센터에서)
    if b.plan_tier is not null and b.plan_tier <> p.tier and b.plan_until > now() then
      return jsonb_build_object('error', 'other_tier', 'tier', b.plan_tier, 'until', b.plan_until);
    end if;
  else
    select * into b from businesses where owner_id = me and status = 'active' order by premium_until desc nulls last, created_at limit 1;
  end if;
  -- 같은 상품을 이미 주문하고 입금 기다리는 중이면 그 주문을 그대로
  select * into o from billing_orders
   where profile_id = me and product_code = p.code and status = 'pending' and expires_at > now()
     and (p.kind <> 'plan' or business_id = b.id)
   order by created_at desc limit 1;
  if found then return jsonb_build_object('order', order_json(o), 'existing', true); end if;
  if (select count(*) from billing_orders where profile_id = me and status = 'pending' and expires_at > now()) >= 3 then
    return jsonb_build_object('error', 'too_many');
  end if;
  select email into em from auth.users where id = me;
  select pay_days into days from billing_settings where id = 1;
  insert into billing_orders (order_no, profile_id, business_id, product_code, item_name, supply_amount, vat_amount, total_amount, depositor_code, expires_at,
    buyer_corp_num, buyer_corp_name, buyer_ceo, buyer_addr, buyer_biz_type, buyer_biz_item, buyer_email)
  values (new_order_no(), me, b.id, p.code, p.name || case when p.kind = 'plan' and b.name is not null then ' (' || left(b.name, 20) || ')' else '' end,
    p.supply_amount, p.supply_amount / 10, p.supply_amount + p.supply_amount / 10, new_depositor_code(), now() + make_interval(days => coalesce(days, 3)),
    regexp_replace(v.biz_reg_no, '[^0-9]', '', 'g'), v.company_name, coalesce(v.ceo_name, ''), coalesce(v.address, ''), coalesce(v.biz_type, ''), coalesce(v.biz_item, ''), coalesce(em, ''))
  returning * into o;
  return jsonb_build_object('order', order_json(o));
end $$;
revoke execute on function public.create_billing_order(text, uuid) from anon, public;
grant execute on function public.create_billing_order(text, uuid) to authenticated;

-- 세금계산서 받을 이메일 바꾸기 (입금 전 주문만)
create or replace function public.set_order_email(p_id uuid, p_email text)
returns text language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_email, '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(p_email) > 120 then return 'bad_input'; end if;
  update billing_orders set buyer_email = btrim(p_email), updated_at = now()
   where id = p_id and profile_id = auth.uid() and (status = 'pending' or (status = 'paid' and invoice_status <> 'issued'));
  return case when found then 'ok' else 'not_found' end;
end $$;
revoke execute on function public.set_order_email(uuid, text) from anon, public;
grant execute on function public.set_order_email(uuid, text) to authenticated;

create or replace function public.cancel_billing_order(p_id uuid)
returns text language plpgsql security definer set search_path = public as $$
begin
  update billing_orders set status = 'canceled', updated_at = now() where id = p_id and profile_id = auth.uid() and status = 'pending';
  return case when found then 'ok' else 'not_found' end;
end $$;
revoke execute on function public.cancel_billing_order(uuid) from anon, public;
grant execute on function public.cancel_billing_order(uuid) to authenticated;

-- 9) 입금 확인 → 주문 처리 ---------------------------------------------------------------------
--    플랜: 같은 플랜을 쓰는 중이면 그 끝에서 이어서, 아니면 지금부터. 노출 혜택(premium_until)도 같이 늘림
--    이용권: 지갑에 더함. 광고: 캠페인을 켬
create or replace function public.apply_billing_order(p_order uuid, p_deposit bigint)
returns text language plpgsql security definer set search_path = public as $$
declare o billing_orders; p billing_products; b businesses; base timestamptz; till timestamptz; ap jsonb := '{}'::jsonb;
begin
  select * into o from billing_orders where id = p_order for update;
  if not found then return 'not_found'; end if;
  if o.status not in ('pending', 'expired') then return 'already'; end if;
  select * into p from billing_products where code = o.product_code;
  if p.kind = 'plan' then
    select * into b from businesses where id = o.business_id for update;
    if found then
      base := case when b.plan_tier = p.tier and b.plan_until > now() then b.plan_until else now() end;
      till := base + make_interval(months => p.months);
      perform set_config('ps.internal', '1', true);
      update businesses set plan_tier = p.tier, plan_until = till, premium_until = greatest(till, coalesce(premium_until, till)), bumped_at = now()
       where id = b.id;
      perform set_config('ps.internal', '', true);
      ap := jsonb_build_object('tier', p.tier, 'months', p.months, 'from', base, 'until', till);
    end if;
  elsif p.kind = 'pack' and o.profile_id is not null then
    if p.quote_credits > 0 then perform add_credits(o.profile_id, 'quote', p.quote_credits, 'purchase', o.id, null); end if;
    if p.offer_credits > 0 then perform add_credits(o.profile_id, 'offer', p.offer_credits, 'purchase', o.id, null); end if;
    ap := jsonb_build_object('quote', p.quote_credits, 'offer', p.offer_credits);
  elsif p.kind = 'ad' and o.ad_campaign_id is not null then
    update ad_campaigns set status = 'active' where id = o.ad_campaign_id and status in ('draft', 'paused');
    ap := jsonb_build_object('ad_campaign_id', o.ad_campaign_id);
  end if;
  update billing_orders set status = 'paid', paid_at = now(), deposit_id = p_deposit, applied = ap, invoice_status = 'pending', updated_at = now()
   where id = o.id;
  if p_deposit is not null then
    update bank_deposits set status = 'matched', order_id = o.id where id = p_deposit;
  end if;
  return 'ok';
end $$;
revoke execute on function public.apply_billing_order(uuid, bigint) from anon, authenticated, public;
grant execute on function public.apply_billing_order(uuid, bigint) to service_role;

-- 상호 비교용: (주)·주식회사·공백·기호를 뺌
create or replace function public.norm_name(p text)
returns text language sql immutable as $$
  select regexp_replace(regexp_replace(upper(coalesce(p, '')), '\(주\)|㈜|주식회사|\(유\)|유한회사', '', 'g'), '[^0-9A-Z가-힣]', '', 'g');
$$;

-- 새 입금을 주문과 맞춰 보기 (bank-sync 가 부름). 결과: 처리한 주문 id 들
--   ① 입금자명에 코드(PS0000)가 있고 금액이 같으면 → 처리 (입금 기한이 지난 지 7일 안 된 주문도)
--   ② 코드는 없지만 같은 금액으로 입금 기다리는 주문이 딱 하나이고, 입금자명이 그 주문의 상호와 같으면 → 처리
--   나머지는 '확인 필요'(unmatched)
create or replace function public.billing_auto_match()
returns uuid[] language plpgsql security definer set search_path = public as $$
declare d bank_deposits; o billing_orders; done uuid[] := '{}'; code text; n integer;
begin
  update billing_orders set status = 'expired', updated_at = now() where status = 'pending' and expires_at <= now();
  for d in select * from bank_deposits where status = 'new' and amount > 0 order by traded_at for update skip locked loop
    o := null;
    code := substring(upper(regexp_replace(d.depositor, '\s', '', 'g')) from 'PS[0-9]{4,5}');
    if code is not null then
      select * into o from billing_orders
       where depositor_code = code and total_amount = d.amount
         and (status = 'pending' or (status = 'expired' and expires_at > now() - interval '7 days'))
       order by created_at desc limit 1;
    end if;
    if o.id is null then
      select count(*) into n from billing_orders where status = 'pending' and total_amount = d.amount;
      if n = 1 then
        select * into o from billing_orders where status = 'pending' and total_amount = d.amount;
        if length(norm_name(o.buyer_corp_name)) < 2 or position(norm_name(o.buyer_corp_name) in norm_name(d.depositor)) = 0 then o := null; end if;
      end if;
    end if;
    if o.id is not null and apply_billing_order(o.id, d.id) = 'ok' then
      done := done || o.id;
    else
      update bank_deposits set status = 'unmatched' where id = d.id;
    end if;
  end loop;
  return done;
end $$;
revoke execute on function public.billing_auto_match() from anon, authenticated, public;
grant execute on function public.billing_auto_match() to service_role;

-- 10) 견적·매입 제안 한도 ------------------------------------------------------------------------
--    무료 30일 견적 3건·매입 제안 0건 / 프로 30건·3건 / 비즈 무제한·10건 (plan_limit). 다 쓰면 이용권 1장씩
alter table public.rfq_quotes add column if not exists paid_with text not null default 'plan';
alter table public.rfq_quotes drop constraint if exists rfq_quotes_paid_with_check;
alter table public.rfq_quotes add constraint rfq_quotes_paid_with_check check (paid_with in ('plan', 'credit'));

drop function if exists public.rfq_quota(uuid);
drop function if exists public.rfq_quota(uuid, text);
create or replace function public.rfq_quota(p_uid uuid, p_kind text default 'buy')
returns table (business_id uuid, business_name text, left_count integer, credits integer, tier text, plan_limit integer)
language sql stable security definer set search_path = public as $$
  with t as (select biz_tier(p_uid) as tier),
  used as (
    select count(*)::integer as n from rfq_quotes q join rfq_requests r on r.id = q.rfq_id
     where q.seller_id = p_uid and r.kind = p_kind and q.paid_with = 'plan' and q.created_at > now() - interval '30 days')
  select b.id, b.name,
         case when plan_limit(t.tier, p_kind) < 0 then -1 else greatest(0, plan_limit(t.tier, p_kind) - used.n) end,
         coalesce((select case when p_kind = 'sell' then w.offer_credits else w.quote_credits end from credit_wallets w where w.profile_id = p_uid), 0),
         t.tier, plan_limit(t.tier, p_kind)
    from businesses b, t, used
   where b.owner_id = p_uid and b.status = 'active'
   order by b.plan_until desc nulls last, b.premium_until desc nulls last, b.created_at
   limit 1;
$$;
revoke execute on function public.rfq_quota(uuid, text) from anon, authenticated, public;

create or replace function public.submit_quote(p_rfq uuid, p_price integer, p_message text, p_lead_time text)
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); r rfq_requests; q record; qid uuid; how text;
begin
  if me is null then return 'login'; end if;
  select * into r from rfq_requests where id = p_rfq for update;
  if not found then return 'not_found'; end if;
  if r.status <> 'open' or r.expires_at <= now() then return 'closed'; end if;
  if r.buyer_id = me then return 'own'; end if;
  if is_blocked_between(me, r.buyer_id) then return 'blocked'; end if;
  if exists (select 1 from rfq_quotes where rfq_id = p_rfq and seller_id = me) then return 'already'; end if;
  select * into q from rfq_quota(me, r.kind);
  if q.business_id is null then return 'need_biz'; end if;
  if q.left_count <> 0 then how := 'plan';
  elsif q.credits > 0 then how := 'credit';
  else return 'quota'; end if;
  insert into rfq_quotes (rfq_id, seller_id, business_id, price, message, lead_time, paid_with)
  values (p_rfq, me, q.business_id, p_price, btrim(p_message), coalesce(btrim(p_lead_time), ''), how)
  returning id into qid;
  if how = 'credit' then perform add_credits(me, case when r.kind = 'sell' then 'offer' else 'quote' end, -1, 'use', null, qid); end if;
  update rfq_requests set quote_count = quote_count + 1 where id = p_rfq;
  return 'ok';
exception when check_violation then
  return 'bad_input';
end $$;
revoke execute on function public.submit_quote(uuid, integer, text, text) from anon, public;
grant execute on function public.submit_quote(uuid, integer, text, text) to authenticated;

-- 상세: 한도에 이용권 장수·플랜 추가 (20261123_rfq_sell.sql 의 rfq_view 와 나머지는 같음)
create or replace function public.rfq_view(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid(); r rfq_requests; role text; quotes jsonb := '[]'::jsonb; mine jsonb;
  q_biz uuid; q_name text; q_left integer; q_credits integer; q_tier text; q_limit integer;
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
    select x.business_id, x.business_name, x.left_count, x.credits, x.tier, x.plan_limit into q_biz, q_name, q_left, q_credits, q_tier, q_limit
      from rfq_quota(me, r.kind) x;
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
    'quota', case when q_biz is null then null else jsonb_build_object('business_id', q_biz, 'business_name', q_name,
      'left', q_left, 'credits', q_credits, 'tier', q_tier, 'limit', q_limit) end);
end $$;
revoke execute on function public.rfq_view(uuid) from public;
grant execute on function public.rfq_view(uuid) to anon, authenticated;

-- 11) 내 플랜·이용권·주문 (업체 플랜 화면) -------------------------------------------------------
create or replace function public.my_billing()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid(); tier text; tu timestamptz; qb record; qs record;
begin
  if me is null then return jsonb_build_object('error', 'login'); end if;
  tier := biz_tier(me);
  tu := trial_until(me);
  select * into qb from rfq_quota(me, 'buy');
  select * into qs from rfq_quota(me, 'sell');
  return jsonb_build_object(
    'tier', tier,
    'trial_until', case when tu > now() then tu end,
    'verified', exists (select 1 from business_verifications where profile_id = me),
    'credits', jsonb_build_object(
      'quote', coalesce((select quote_credits from credit_wallets where profile_id = me), 0),
      'offer', coalesce((select offer_credits from credit_wallets where profile_id = me), 0)),
    'usage', jsonb_build_object(
      'buy', case when qb.business_id is null then null else jsonb_build_object('left', qb.left_count, 'limit', qb.plan_limit) end,
      'sell', case when qs.business_id is null then null else jsonb_build_object('left', qs.left_count, 'limit', qs.plan_limit) end),
    'businesses', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'plan_tier', case when b.plan_until > now() then b.plan_tier end,
        'plan_until', case when b.plan_until > now() then b.plan_until end, 'premium_until', case when b.premium_until > now() then b.premium_until end) order by b.created_at)
      from businesses b where b.owner_id = me and b.status = 'active'), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(order_json(o) order by o.created_at desc) from billing_orders o
      where o.id in (select x.id from billing_orders x where x.profile_id = me order by x.created_at desc limit 30)), '[]'::jsonb));
end $$;
revoke execute on function public.my_billing() from anon, public;
grant execute on function public.my_billing() to authenticated;

-- 12) 운영자 (/admin/billing) ---------------------------------------------------------------------
create or replace function public.admin_billing_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_app_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  return jsonb_build_object(
    'settings', (select to_jsonb(s) from billing_settings s where id = 1),
    'sync', (select to_jsonb(s) from billing_sync_state s where id = 1),
    'unmatched', coalesce((select jsonb_agg(to_jsonb(d) - 'raw' order by d.traded_at desc) from bank_deposits d where d.status = 'unmatched'), '[]'::jsonb),
    'pending', coalesce((select jsonb_agg(to_jsonb(o) order by o.created_at desc) from billing_orders o
      where o.status = 'pending' or (o.status = 'expired' and o.expires_at > now() - interval '7 days')), '[]'::jsonb),
    'invoice_todo', coalesce((select jsonb_agg(to_jsonb(o) order by o.paid_at) from billing_orders o
      where (o.status in ('paid', 'refunded') and o.invoice_status in ('pending', 'failed')) or o.refund_invoice_status in ('pending', 'failed')), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(to_jsonb(o) order by o.paid_at desc) from (select * from billing_orders
      where status in ('paid', 'refunded') order by paid_at desc limit 50) o), '[]'::jsonb),
    'month', (select jsonb_build_object('count', count(*), 'supply', coalesce(sum(supply_amount - coalesce(refund_supply, 0)), 0))
      from billing_orders where status in ('paid', 'refunded') and paid_at >= date_trunc('month', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul'),
    'ads', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at desc) from ad_campaigns a where a.status <> 'ended' or a.ends_on > current_date - 60), '[]'::jsonb),
    'ad_stats', coalesce((select jsonb_object_agg(k, v) from (
      select props->>'ad_id' as k, jsonb_build_object('views', count(*) filter (where name = 'ad_view'), 'clicks', count(*) filter (where name = 'ad_click')) as v
        from marketing_events where name in ('ad_view', 'ad_click') and created_at > now() - interval '90 days' and props ? 'ad_id' group by 1) s), '{}'::jsonb),
    'inquiries', coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at desc) from (select * from ad_inquiries order by created_at desc limit 50) i), '[]'::jsonb));
end $$;
revoke execute on function public.admin_billing_overview() from anon, public;
grant execute on function public.admin_billing_overview() to authenticated;

-- 확인 필요 입금을 주문에 연결 (금액이 달라도 운영자가 확인했으면 처리)
create or replace function public.admin_match_deposit(p_deposit bigint, p_order uuid)
returns text language plpgsql security definer set search_path = public as $$
declare d bank_deposits;
begin
  if not is_app_admin() then return 'forbidden'; end if;
  select * into d from bank_deposits where id = p_deposit for update;
  if not found or d.status = 'matched' then return 'bad_deposit'; end if;
  return apply_billing_order(p_order, p_deposit);
end $$;
revoke execute on function public.admin_match_deposit(bigint, uuid) from anon, public;
grant execute on function public.admin_match_deposit(bigint, uuid) to authenticated;

-- 판다산다 이용요금이 아닌 입금 (다른 거래 등)
create or replace function public.admin_ignore_deposit(p_deposit bigint)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not is_app_admin() then return 'forbidden'; end if;
  update bank_deposits set status = 'ignored' where id = p_deposit and status in ('new', 'unmatched');
  return case when found then 'ok' else 'not_found' end;
end $$;
revoke execute on function public.admin_ignore_deposit(bigint) from anon, public;
grant execute on function public.admin_ignore_deposit(bigint) to authenticated;

-- 통장 조회 없이 입금을 확인했을 때 (예: 다른 통장으로 받음)
create or replace function public.admin_mark_paid(p_order uuid, p_note text)
returns text language plpgsql security definer set search_path = public as $$
declare r text;
begin
  if not is_app_admin() then return 'forbidden'; end if;
  r := apply_billing_order(p_order, null);
  if r = 'ok' then update billing_orders set note = left(coalesce(p_note, ''), 200) where id = p_order; end if;
  return r;
end $$;
revoke execute on function public.admin_mark_paid(uuid, text) from anon, public;
grant execute on function public.admin_mark_paid(uuid, text) to authenticated;

-- 환불 금액 계산 (이용약관 제17조와 같은 기준)
--   결제 후 7일 안이고 그 뒤로 견적·제안을 하나도 안 보냈으면 전액
--   플랜: 이미 시작한 달은 1개월 정가로 빼고 남은 금액 / 이용권: 남은 장수만큼 / 광고: 운영자가 금액을 정함
create or replace function public.billing_refund_quote(p_order uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare o billing_orders; p billing_products; monthly integer; used_months integer; sent integer; rest integer; bought integer; supply integer; is_full boolean;
begin
  select * into o from billing_orders where id = p_order;
  if not found or o.status <> 'paid' then return jsonb_build_object('error', 'not_paid'); end if;
  select * into p from billing_products where code = o.product_code;
  select count(*) into sent from rfq_quotes where seller_id = o.profile_id and created_at >= o.paid_at;
  is_full := o.paid_at > now() - interval '7 days' and sent = 0;
  if is_full then supply := o.supply_amount;
  elsif p.kind = 'plan' then
    select supply_amount into monthly from billing_products where code = p.tier || '_1';
    used_months := case when (o.applied->>'from')::timestamptz > now() then 0
                        else least(p.months, ceil(extract(epoch from now() - (o.applied->>'from')::timestamptz) / (30 * 86400.0))::integer) end;
    supply := greatest(0, o.supply_amount - used_months * coalesce(monthly, 0));
  elsif p.kind = 'pack' then
    bought := greatest(p.quote_credits, p.offer_credits);
    select least(bought, case when p.quote_credits > 0 then quote_credits else offer_credits end) into rest from credit_wallets where profile_id = o.profile_id;
    supply := (o.supply_amount * coalesce(rest, 0) / nullif(bought, 0))::integer / 10 * 10;
  else supply := null; -- 광고는 운영자가 정함
  end if;
  return jsonb_build_object('full', is_full, 'supply', supply, 'total', case when supply is null then null else supply + supply / 10 end,
    'used_months', used_months, 'rest_credits', rest);
end $$;
revoke execute on function public.billing_refund_quote(uuid) from anon, authenticated, public;

create or replace function public.admin_refund_quote(p_order uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_app_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  return billing_refund_quote(p_order);
end $$;
revoke execute on function public.admin_refund_quote(uuid) from anon, public;
grant execute on function public.admin_refund_quote(uuid) to authenticated;

-- 환불 기록 (운영자가 고객 계좌로 이체한 뒤). 넣어 준 혜택을 되돌리고 수정세금계산서를 발행 대기로
--   p_supply = 돌려준 공급가액 (부가세는 10% 자동)
create or replace function public.admin_refund_order(p_order uuid, p_supply integer)
returns text language plpgsql security definer set search_path = public as $$
declare o billing_orders; p billing_products; till timestamptz; frm timestamptz; cut integer; monthly integer;
begin
  if not is_app_admin() then return 'forbidden'; end if;
  select * into o from billing_orders where id = p_order for update;
  if not found or o.status <> 'paid' then return 'not_paid'; end if;
  if p_supply is null or p_supply <= 0 or p_supply > o.supply_amount then return 'bad_amount'; end if;
  select * into p from billing_products where code = o.product_code;
  if p.kind = 'plan' and o.business_id is not null then
    frm := (o.applied->>'from')::timestamptz; till := (o.applied->>'until')::timestamptz;
    if p_supply >= o.supply_amount then
      cut := p.months;
    else
      select supply_amount into monthly from billing_products where code = p.tier || '_1';
      cut := least(p.months, floor(p_supply::numeric / greatest(coalesce(monthly, 1), 1))::integer);
    end if;
    perform set_config('ps.internal', '1', true);
    update businesses
       set plan_until = greatest(now(), plan_until - make_interval(months => cut)),
           premium_until = case when premium_until = plan_until then greatest(now(), plan_until - make_interval(months => cut)) else premium_until end
     where id = o.business_id and plan_until is not null;
    perform set_config('ps.internal', '', true);
  elsif p.kind = 'pack' and o.profile_id is not null then
    cut := ceil(greatest(p.quote_credits, p.offer_credits) * p_supply::numeric / o.supply_amount)::integer;
    if p.quote_credits > 0 then perform add_credits(o.profile_id, 'quote', -cut, 'refund', o.id, null); end if;
    if p.offer_credits > 0 then perform add_credits(o.profile_id, 'offer', -cut, 'refund', o.id, null); end if;
  elsif p.kind = 'ad' and o.ad_campaign_id is not null and p_supply >= o.supply_amount then
    update ad_campaigns set status = 'ended' where id = o.ad_campaign_id;
  end if;
  -- 세금계산서: 이미 발행했으면 수정세금계산서(환불분)를 발행 대기로. 발행 전이면 전액 환불은 발행 안 함, 일부 환불은 남은 금액으로 발행
  update billing_orders set status = 'refunded', refund_supply = p_supply, refund_amount = p_supply + p_supply / 10, refunded_at = now(),
    refund_invoice_status = case when invoice_status = 'issued' then 'pending' else null end,
    invoice_status = case when invoice_status <> 'issued' and p_supply >= supply_amount then 'canceled' else invoice_status end,
    updated_at = now()
   where id = o.id;
  return 'ok';
end $$;
revoke execute on function public.admin_refund_order(uuid, integer) from anon, public;
grant execute on function public.admin_refund_order(uuid, integer) to authenticated;

-- 광고 만들기·고치기 (p.id 가 있으면 고침)
create or replace function public.admin_save_ad(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  if not is_app_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  if p ? 'id' and nullif(p->>'id', '') is not null then
    update ad_campaigns set advertiser = p->>'advertiser', placement = p->>'placement', title = p->>'title', body = coalesce(p->>'body', ''),
      image_url = nullif(p->>'image_url', ''), link_url = p->>'link_url', cta = coalesce(nullif(p->>'cta', ''), '자세히 보기'),
      starts_on = (p->>'starts_on')::date, ends_on = (p->>'ends_on')::date, status = coalesce(p->>'status', status), note = coalesce(p->>'note', note)
     where id = (p->>'id')::uuid returning id into rid;
  else
    insert into ad_campaigns (advertiser, placement, title, body, image_url, link_url, cta, starts_on, ends_on, status, note)
    values (p->>'advertiser', p->>'placement', p->>'title', coalesce(p->>'body', ''), nullif(p->>'image_url', ''), p->>'link_url',
      coalesce(nullif(p->>'cta', ''), '자세히 보기'), (p->>'starts_on')::date, (p->>'ends_on')::date, coalesce(p->>'status', 'draft'), coalesce(p->>'note', ''))
    returning id into rid;
  end if;
  return jsonb_build_object('id', rid);
exception when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format then
  return jsonb_build_object('error', 'bad_input');
end $$;
revoke execute on function public.admin_save_ad(jsonb) from anon, public;
grant execute on function public.admin_save_ad(jsonb) to authenticated;

-- 광고 계약 주문 (광고주가 회원이 아니어도 됨). 입금되면 광고가 자동으로 켜지고 세금계산서 발행
--   p_buyer: { corp_num, corp_name, ceo, addr, biz_type, biz_item, email }
create or replace function public.admin_create_ad_order(p_campaign uuid, p_supply integer, p_buyer jsonb, p_days integer default 7)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a ad_campaigns; o billing_orders; cn text := regexp_replace(coalesce(p_buyer->>'corp_num', ''), '[^0-9]', '', 'g');
begin
  if not is_app_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  select * into a from ad_campaigns where id = p_campaign;
  if not found then return jsonb_build_object('error', 'no_campaign'); end if;
  if p_supply is null or p_supply < 1000 or not biz_reg_no_valid(cn) or coalesce(p_buyer->>'corp_name', '') = '' then
    return jsonb_build_object('error', 'bad_input');
  end if;
  insert into billing_orders (order_no, ad_campaign_id, product_code, item_name, supply_amount, vat_amount, total_amount, depositor_code, expires_at,
    buyer_corp_num, buyer_corp_name, buyer_ceo, buyer_addr, buyer_biz_type, buyer_biz_item, buyer_email, created_by_admin)
  values (new_order_no(), a.id, 'ad', '판다산다 광고 게재 (' || to_char(a.starts_on, 'MM.DD') || '~' || to_char(a.ends_on, 'MM.DD') || ')',
    p_supply, p_supply / 10, p_supply + p_supply / 10, new_depositor_code(), now() + make_interval(days => greatest(1, coalesce(p_days, 7))),
    cn, p_buyer->>'corp_name', coalesce(p_buyer->>'ceo', ''), coalesce(p_buyer->>'addr', ''), coalesce(p_buyer->>'biz_type', ''),
    coalesce(p_buyer->>'biz_item', ''), coalesce(p_buyer->>'email', ''), true)
  returning * into o;
  return jsonb_build_object('order', order_json(o));
end $$;
revoke execute on function public.admin_create_ad_order(uuid, integer, jsonb, integer) from anon, public;
grant execute on function public.admin_create_ad_order(uuid, integer, jsonb, integer) to authenticated;

create or replace function public.admin_inquiry_done(p_id bigint)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not is_app_admin() then return 'forbidden'; end if;
  update ad_inquiries set status = 'done' where id = p_id;
  return case when found then 'ok' else 'not_found' end;
end $$;
revoke execute on function public.admin_inquiry_done(bigint) from anon, public;
grant execute on function public.admin_inquiry_done(bigint) to authenticated;

-- 광고 기간이 끝나면 끔, 1년 지난 광고 문의는 지움 (개인정보처리방침: 답변 후 1년 보관) (매일 새벽)
select cron.unschedule('ads-expire') where exists (select 1 from cron.job where jobname = 'ads-expire');
select cron.schedule('ads-expire', '20 15 * * *', $$
  update public.ad_campaigns set status = 'ended' where status in ('active', 'paused') and ends_on < (now() at time zone 'Asia/Seoul')::date;
  delete from public.ad_inquiries where created_at < now() - interval '1 year';
$$);

-- 13) 입금 확인 자동 실행: 한국시간 07~23시 10분마다 (UTC 22~14시) ---------------------------------------
select cron.unschedule('bank-sync') where exists (select 1 from cron.job where jobname = 'bank-sync');
select cron.schedule('bank-sync', '*/10 0-14,22-23 * * *', $$
  select net.http_post(
    url := 'https://rqjfergjfhcrcuvfuhkm.supabase.co/functions/v1/bank-sync',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"action": "cron"}'::jsonb,
    timeout_milliseconds := 60000
  );
$$);

-- 14) 플랜·혜택 끝나기 3일 전 알림: 자동결제가 없어졌으니 biz_subscriptions 조건을 빼고, 첫 달 무료인지 알려 줌 ------------
--     (20261123_weekly_briefing.sql 의 journey_candidates 에서 premium_expiring 갈래만 바뀜)
create or replace function public.journey_candidates(p_journey text)
returns table (profile_id uuid, ref text, email text, ads_push boolean, ads_email boolean, info_email boolean, data jsonb)
language sql stable security definer set search_path = public, auth as $$
  with c as (
    -- 가입 다음 날, 아직 진단·지원사업 알림을 안 했으면: 30초 진단 안내 (정보성: 서비스 이용 안내)
    select u.id as pid, 'signup' as ref, '{}'::jsonb as data
      from auth.users u
     where p_journey = 'welcome_diagnose'
       and u.created_at between now() - interval '48 hours' and now() - interval '24 hours'
       and not exists (select 1 from company_profiles cp where cp.profile_id = u.id)
       and not exists (select 1 from support_alerts sa where sa.profile_id = u.id)
    union all
    -- 물건 올리고 3일 / 7일 동안 채팅 0건 (정보성: 내 물건)
    select p.seller_profile_id, p.id::text,
           jsonb_build_object('product_id', p.id, 'title', p.title, 'price', p.price, 'days', case when p_journey = 'product_stale_3' then 3 else 7 end)
      from products p
     where p_journey in ('product_stale_3', 'product_stale_7')
       and p.status = 'selling' and coalesce(p.inquiry_count, 0) = 0
       and p.created_at between now() - make_interval(days => case when p_journey = 'product_stale_3' then 3 else 7 end) - interval '1 day'
                            and now() - make_interval(days => case when p_journey = 'product_stale_3' then 3 else 7 end)
    union all
    -- 업체 주간 리포트 (월요일만, 서버가 요일을 봄): 지난 기록 대비 조회수 (정보성: 내 업체)
    select b.owner_id, b.id::text || ':' || to_char(now() at time zone 'Asia/Seoul', 'IYYY-IW'),
           jsonb_build_object('business_id', b.id, 'name', b.name, 'views_total', b.view_count,
             'views_week', b.view_count - s.view_count,
             'premium', coalesce(b.premium_until > now(), false))
      from businesses b
      left join lateral (select view_count from biz_view_snapshots x where x.business_id = b.id
                          and x.taken_on < (now() at time zone 'Asia/Seoul')::date order by taken_on desc limit 1) s on true
     where p_journey = 'biz_weekly' and b.status = 'active' and s.view_count is not null
    union all
    -- 플랜·무료 혜택이 3일 안에 끝남 (정보성: 내가 쓰는 유료 서비스). 이미 연장 주문을 넣었으면 보내지 않음
    select b.owner_id, b.id::text || ':' || to_char(b.premium_until, 'YYYY-MM-DD'),
           jsonb_build_object('business_id', b.id, 'name', b.name, 'until', to_char(b.premium_until at time zone 'Asia/Seoul', 'FMMM월 FMDD일'),
             'paid', coalesce(b.plan_until >= b.premium_until, false),
             'tier', case when b.plan_until >= b.premium_until then b.plan_tier end)
      from businesses b
     where p_journey = 'premium_expiring' and b.status = 'active'
       and b.premium_until between now() and now() + interval '3 days'
       and not exists (select 1 from billing_orders o where o.business_id = b.id and o.status = 'pending' and o.expires_at > now())
    union all
    -- 플랜이 없는 업체가 조회 30회 넘음, 등록 7일 지남: 플랜 권유 (광고성, 30일에 한 번)
    select b.owner_id, b.id::text || ':' || to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM'),
           jsonb_build_object('business_id', b.id, 'name', b.name, 'views_total', b.view_count)
      from businesses b
     where p_journey = 'biz_upsell' and b.status = 'active'
       and coalesce(b.premium_until, '-infinity') < now() and b.view_count >= 30
       and b.created_at < now() - interval '7 days'
       and not exists (select 1 from journey_sends j where j.profile_id = b.owner_id and j.journey = 'biz_upsell' and j.sent_at > now() - interval '30 days')
    union all
    -- 마지막 방문이 30~37일 전: 그동안 새 지원사업 수 (광고성, 그 달 한 번)
    select e.pid, to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM'),
           jsonb_build_object('new_programs', (select count(*) from support_programs sp where sp.posted_at > e.last_at))
      from (select me.profile_id as pid, max(me.created_at) as last_at
              from marketing_events me where me.profile_id is not null group by me.profile_id) e
     where p_journey = 'dormant_30' and e.last_at between now() - interval '37 days' and now() - interval '30 days'
    union all
    -- 광고 수신 동의 2년 재확인 (정보통신망법 제50조 제8항, 23개월째에 알림)
    select mc.profile_id, to_char(mc.agreed_at, 'YYYY-MM-DD'),
           jsonb_build_object('agreed_on', to_char(mc.agreed_at at time zone 'Asia/Seoul', 'YYYY년 FMMM월 FMDD일'),
             'push', mc.ads_push, 'email', mc.ads_email)
      from marketing_consents mc
     where p_journey = 'consent_reconfirm' and (mc.ads_push or mc.ads_email)
       and mc.agreed_at < now() - interval '23 months' and mc.reconfirmed_at is null
    union all
    -- 매주 월요일 지원사업 브리핑 (서버가 요일을 봄): 마감 알림을 켰거나 진단을 한 사람에게, 그 사람 지역(+전국) 기준 이번 주 마감 공고 (정보성: 본인이 요청한 알림)
    select w.pid, to_char(now() at time zone 'Asia/Seoul', 'IYYY-IW'),
           jsonb_build_object('count', s.cnt, 'top', s.top, 'region', case when cardinality(w.regions) = 1 then w.regions[1] else null end)
      from (select sa.profile_id as pid, sa.regions from support_alerts sa
            union all
            select cp.profile_id, array[cp.region] from company_profiles cp
             where not exists (select 1 from support_alerts sa2 where sa2.profile_id = cp.profile_id)) w
      cross join lateral (
        select count(*)::integer as cnt, (array_agg(sp.title order by sp.apply_end, sp.posted_at desc))[1] as top
          from support_programs sp
         where sp.apply_end between (now() at time zone 'Asia/Seoul')::date and (now() at time zone 'Asia/Seoul')::date + 7
           and (cardinality(w.regions) = 0 or sp.region = '전국' or sp.region = any(w.regions))) s
     where p_journey = 'weekly_briefing' and s.cnt > 0
  )
  select c.pid, c.ref, u.email, coalesce(mc.ads_push, false), coalesce(mc.ads_email, false), coalesce(mc.info_email, true), c.data
    from c
    join auth.users u on u.id = c.pid
    join profiles pr on pr.id = c.pid
    left join marketing_consents mc on mc.profile_id = c.pid
   limit 5000;
$$;
revoke execute on function public.journey_candidates(text) from anon, authenticated, public;
grant execute on function public.journey_candidates(text) to service_role;
