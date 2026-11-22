-- 회원 간 안전결제 중단 (2026-11)
--   회원 간 거래는 채팅으로 조건을 정하고 당사자끼리 직접 거래한다. 회사는 회원 간 거래의 대금을 받거나 보관하지 않는다.
--   토스페이먼츠 결제는 회사가 직접 파는 유료 서비스(업체 프리미엄 정기결제, Edge Function biz-billing)에만 쓴다.
--   화면 스위치: js/app.js 의 PS.SAFE_PAY. 다시 켤 때는 20261112_pay_sellers.sql 의 두 함수를 다시 실행한다.

-- 1) 안전결제 판매자 목록을 비운다 (상품 화면의 '구매하기'가 나오지 않음)
create or replace function public.get_pay_sellers(p_ids uuid[])
returns table (id uuid)
language sql stable security definer set search_path = public as $$
  select null::uuid where false;
$$;
grant execute on function public.get_pay_sellers(uuid[]) to anon, authenticated;

-- 2) 새 주문을 만들 수 없게 막는다 (create_market_order / create_market_order_cart 모두 여기서 막힘)
create or replace function public.market_orders_pay_seller_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  raise exception 'seller not payable';
end $$;

-- 3) 결제하지 않고 남은 주문서(pending)는 취소로 정리 (돈이 오간 주문 아님)
update public.market_orders set status = 'canceled' where status = 'pending';
