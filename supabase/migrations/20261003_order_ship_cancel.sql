-- 주문 발송·취소
--   발송: 판매자가 배송업체·송장번호를 넣고 '발송함'
--   취소(전액 환불): 발송 전에는 구매자가 바로, 판매자는 언제든 사유를 적어서. 발송 뒤 구매자는 '취소 요청' → 판매자 동의 시 환불
--   실제 환불(토스 결제 취소)과 '취소됨' 처리는 Edge Function order-cancel 만 함

alter table public.market_orders
  add column if not exists shipped_at timestamptz,
  add column if not exists carrier text,
  add column if not exists tracking_no text,
  add column if not exists cancel_request_status text,      -- null | 'requested' | 'rejected'
  add column if not exists cancel_request_reason text,
  add column if not exists cancel_requested_at timestamptz,
  add column if not exists canceled_at timestamptz,
  add column if not exists canceled_by text,                -- 'buyer' | 'seller'
  add column if not exists cancel_reason text;
alter table public.market_orders drop constraint if exists market_orders_cancel_request_status_check;
alter table public.market_orders add constraint market_orders_cancel_request_status_check
  check (cancel_request_status is null or cancel_request_status in ('requested', 'rejected'));
alter table public.market_orders drop constraint if exists market_orders_canceled_by_check;
alter table public.market_orders add constraint market_orders_canceled_by_check
  check (canceled_by is null or canceled_by in ('buyer', 'seller'));

-- 1) 판매자: 발송함 (다시 부르면 송장 정보 수정). 결과: 'ok' | 'not_seller' | 'not_paid' | 'bad_input'
create or replace function public.ship_market_order(p_order_id uuid, p_carrier text, p_tracking_no text)
returns text language plpgsql security definer set search_path = public as $$
declare o record; v_carrier text := nullif(btrim(coalesce(p_carrier, '')), ''); v_no text := nullif(btrim(coalesce(p_tracking_no, '')), '');
begin
  select id, seller_id, status, shipped_at into o from market_orders where id = p_order_id;
  if not found or o.seller_id is distinct from auth.uid() then return 'not_seller'; end if;
  if o.status <> 'paid' then return 'not_paid'; end if;
  if v_carrier is null or length(v_carrier) > 30 or length(coalesce(v_no, '')) > 40 then return 'bad_input'; end if;
  update market_orders
     set shipped_at = coalesce(shipped_at, now()), carrier = v_carrier, tracking_no = v_no
   where id = p_order_id;
  return 'ok';
end $$;
revoke execute on function public.ship_market_order(uuid, text, text) from anon, public;
grant execute on function public.ship_market_order(uuid, text, text) to authenticated;

-- 2) 구매자: 발송된 주문의 취소 요청. 결과: 'ok' | 'not_buyer' | 'not_paid' | 'not_shipped' | 'bad_input'
create or replace function public.request_order_cancel(p_order_id uuid, p_reason text)
returns text language plpgsql security definer set search_path = public as $$
declare o record; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select id, buyer_id, status, shipped_at into o from market_orders where id = p_order_id;
  if not found or o.buyer_id is distinct from auth.uid() then return 'not_buyer'; end if;
  if o.status <> 'paid' then return 'not_paid'; end if;
  if o.shipped_at is null then return 'not_shipped'; end if;  -- 발송 전에는 요청 없이 바로 취소
  if v_reason is null or length(v_reason) > 500 then return 'bad_input'; end if;
  update market_orders
     set cancel_request_status = 'requested', cancel_request_reason = v_reason, cancel_requested_at = now()
   where id = p_order_id;
  return 'ok';
end $$;
revoke execute on function public.request_order_cancel(uuid, text) from anon, public;
grant execute on function public.request_order_cancel(uuid, text) to authenticated;

-- 3) 판매자: 취소 요청 거절. 결과: 'ok' | 'not_seller' | 'no_request'
create or replace function public.reject_order_cancel(p_order_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare o record;
begin
  select id, seller_id, status, cancel_request_status into o from market_orders where id = p_order_id;
  if not found or o.seller_id is distinct from auth.uid() then return 'not_seller'; end if;
  if o.status <> 'paid' or o.cancel_request_status is distinct from 'requested' then return 'no_request'; end if;
  update market_orders set cancel_request_status = 'rejected' where id = p_order_id;
  return 'ok';
end $$;
revoke execute on function public.reject_order_cancel(uuid) from anon, public;
grant execute on function public.reject_order_cancel(uuid) to authenticated;
