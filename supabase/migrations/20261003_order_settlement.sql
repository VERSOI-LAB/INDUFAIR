-- 주문 수령 완료와 정산
--   구매자가 '수령 완료' → 3일 뒤 정산 예정
--   수령 완료를 누르지 않으면 발송 후 14일에 자동 수령 처리 → 바로 정산 예정 (취소 요청이 대기 중이면 보류)
--   정산 금액 = 상품 금액 - 수수료(상품 금액의 5%) + 배송비
--   실제 송금(토스 지급대행)은 아직 연결 전: 정산 건은 'scheduled' 로 쌓이고, 송금 후 mark_settlement_paid 로 완료 처리

-- 수수료율 (바꿀 때는 여기 한 곳만)
create or replace function public.settlement_fee_rate() returns numeric language sql immutable as $$ select 0.05::numeric $$;

alter table public.market_orders
  add column if not exists received_at timestamptz,
  add column if not exists received_auto boolean not null default false;

-- 1) 판매자 정산 계좌 (본인만 읽고 씀)
create table if not exists public.seller_payout_accounts (
  profile_id uuid primary key default auth.uid() references public.profiles(id) on delete cascade,
  bank_name text not null check (length(bank_name) between 1 and 20),
  account_no text not null check (account_no ~ '^[0-9-]{6,30}$'),
  holder_name text not null check (length(holder_name) between 1 and 30),
  updated_at timestamptz not null default now()
);
alter table public.seller_payout_accounts enable row level security;
drop policy if exists seller_payout_accounts_owner on public.seller_payout_accounts;
create policy seller_payout_accounts_owner on public.seller_payout_accounts for all to authenticated
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());
revoke all on public.seller_payout_accounts from anon, authenticated;
grant select, insert, update, delete on public.seller_payout_accounts to authenticated;
grant select on public.seller_payout_accounts to service_role;

-- 2) 정산 건 (주문 하나에 하나)
create table if not exists public.order_settlements (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.market_orders(id) on delete cascade,
  seller_id uuid not null references public.profiles(id) on delete cascade,
  item_amount integer not null,
  shipping_fee integer not null,
  fee_rate numeric not null,
  fee_amount integer not null,
  net_amount integer not null,
  due_at timestamptz not null,
  -- scheduled: 정산 예정(또는 송금 대기) / paid: 정산 완료 / failed: 송금 실패 / canceled: 주문 취소로 없어짐
  status text not null default 'scheduled' check (status in ('scheduled', 'paid', 'failed', 'canceled')),
  paid_at timestamptz,
  payout_ref text,
  message text,
  created_at timestamptz not null default now()
);
create index if not exists order_settlements_seller_idx on public.order_settlements (seller_id, created_at desc);
create index if not exists order_settlements_due_idx on public.order_settlements (due_at) where status = 'scheduled';
alter table public.order_settlements enable row level security;
drop policy if exists order_settlements_select on public.order_settlements;
create policy order_settlements_select on public.order_settlements for select to authenticated
  using (seller_id = auth.uid());
revoke all on public.order_settlements from anon, authenticated;
grant select on public.order_settlements to authenticated;
grant select, insert, update on public.order_settlements to service_role;

-- 정산 건 만들기 (내부용)
create or replace function public.create_order_settlement(p_order_id uuid, p_due timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare o record; v_rate numeric := settlement_fee_rate(); v_fee integer;
begin
  select id, seller_id, item_amount, shipping_fee into o from market_orders where id = p_order_id;
  v_fee := floor(o.item_amount * v_rate);
  insert into order_settlements (order_id, seller_id, item_amount, shipping_fee, fee_rate, fee_amount, net_amount, due_at)
  values (o.id, o.seller_id, o.item_amount, o.shipping_fee, v_rate, v_fee, o.item_amount - v_fee + o.shipping_fee, p_due)
  on conflict (order_id) do nothing;
end $$;
revoke execute on function public.create_order_settlement(uuid, timestamptz) from anon, authenticated, public;

-- 3) 구매자: 수령 완료. 결과: 'ok' | 'not_buyer' | 'not_paid' | 'not_shipped' | 'cancel_pending' | 'already'
create or replace function public.confirm_order_received(p_order_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare o record;
begin
  select id, buyer_id, status, shipped_at, received_at, cancel_request_status into o from market_orders where id = p_order_id;
  if not found or o.buyer_id is distinct from auth.uid() then return 'not_buyer'; end if;
  if o.status <> 'paid' then return 'not_paid'; end if;
  if o.shipped_at is null then return 'not_shipped'; end if;
  if o.received_at is not null then return 'already'; end if;
  if o.cancel_request_status = 'requested' then return 'cancel_pending'; end if; -- 취소 요청 중에는 먼저 답을 받아야 함
  update market_orders set received_at = now(), received_auto = false where id = p_order_id;
  perform create_order_settlement(p_order_id, now() + interval '3 days');
  return 'ok';
end $$;
revoke execute on function public.confirm_order_received(uuid) from anon, public;
grant execute on function public.confirm_order_received(uuid) to authenticated;

-- 4) 자동 수령 처리: 발송 후 14일, 취소 요청 대기 중이 아닌 주문 (매시간)
create or replace function public.auto_confirm_orders()
returns integer language plpgsql security definer set search_path = public as $$
declare o record; n integer := 0;
begin
  for o in select id from market_orders
            where status = 'paid' and received_at is null and shipped_at <= now() - interval '14 days'
              and cancel_request_status is distinct from 'requested'
            limit 500 loop
    update market_orders set received_at = now(), received_auto = true where id = o.id;
    perform create_order_settlement(o.id, now());
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.auto_confirm_orders() from anon, authenticated, public;

select cron.unschedule('auto-confirm-orders') where exists (select 1 from cron.job where jobname = 'auto-confirm-orders');
select cron.schedule('auto-confirm-orders', '10 * * * *', $$ select public.auto_confirm_orders(); $$);

-- 5) 수령 완료된 주문은 구매자가 취소 요청할 수 없음
create or replace function public.request_order_cancel(p_order_id uuid, p_reason text)
returns text language plpgsql security definer set search_path = public as $$
declare o record; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select id, buyer_id, status, shipped_at, received_at into o from market_orders where id = p_order_id;
  if not found or o.buyer_id is distinct from auth.uid() then return 'not_buyer'; end if;
  if o.status <> 'paid' then return 'not_paid'; end if;
  if o.shipped_at is null then return 'not_shipped'; end if;  -- 발송 전에는 요청 없이 바로 취소
  if o.received_at is not null then return 'received'; end if;
  if v_reason is null or length(v_reason) > 500 then return 'bad_input'; end if;
  update market_orders
     set cancel_request_status = 'requested', cancel_request_reason = v_reason, cancel_requested_at = now()
   where id = p_order_id;
  return 'ok';
end $$;

-- 6) 송금 후 정산 완료 처리 (서버만: 토스 지급대행 연결 뒤 사용, 그 전에는 운영자가 SQL 로 호출)
create or replace function public.mark_settlement_paid(p_settlement_id uuid, p_payout_ref text)
returns text language plpgsql security definer set search_path = public as $$
begin
  update order_settlements set status = 'paid', paid_at = now(), payout_ref = p_payout_ref
   where id = p_settlement_id and status in ('scheduled', 'failed');
  return case when found then 'ok' else 'not_found' end;
end $$;
revoke execute on function public.mark_settlement_paid(uuid, text) from anon, authenticated, public;
grant execute on function public.mark_settlement_paid(uuid, text) to service_role;
