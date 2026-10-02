-- 판다산다 구매하기: 배송지(기존 addresses 재사용) + 주문(market_orders)
-- 결제는 토스페이먼츠. 주문 금액은 서버(RPC)가 상품 가격으로 정하고,
-- 결제 승인(paid 처리)은 Edge Function(toss-confirm)만 할 수 있음.

create table if not exists public.market_orders (
  id uuid primary key default gen_random_uuid(),
  order_no text not null unique,                 -- 토스 orderId
  buyer_id uuid not null references public.profiles(id) on delete cascade,
  seller_id uuid not null references public.profiles(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_title text not null,
  item_amount integer not null check (item_amount >= 0),
  shipping_fee integer not null default 0 check (shipping_fee >= 0),
  total_amount integer not null check (total_amount >= 0),
  recipient text not null,
  phone text not null,
  zipcode text,
  address text not null,
  status text not null default 'pending' check (status in ('pending','paid','canceled','failed')),
  payment_key text,
  payment_method text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists market_orders_buyer_idx on public.market_orders (buyer_id, created_at desc);
create index if not exists market_orders_seller_idx on public.market_orders (seller_id, created_at desc);

alter table public.market_orders enable row level security;
drop policy if exists market_orders_select on public.market_orders;
create policy market_orders_select on public.market_orders for select to authenticated
  using (buyer_id = auth.uid() or seller_id = auth.uid());
-- insert/update 정책 없음: 주문 생성은 RPC, 결제 확정은 service_role(Edge Function)만

grant select on public.market_orders to authenticated;
grant select, insert, update on public.market_orders to service_role;
grant select, update on public.products to service_role;

-- 주문 만들기: 금액은 상품 가격으로 서버가 계산
create or replace function public.create_market_order(p_product_id uuid, p_address_id bigint)
returns table (order_no text, total_amount integer, order_name text)
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_p record;
  v_a record;
  v_no text;
  v_fee integer := 0;  -- 배송비 (정책 정해지면 여기서 계산)
begin
  if v_uid is null then raise exception 'login required'; end if;
  select id, title, price, status, seller_profile_id into v_p from products where id = p_product_id;
  if not found then raise exception 'product not found'; end if;
  if v_p.status <> 'selling' then raise exception 'not for sale'; end if;
  if v_p.seller_profile_id = v_uid then raise exception 'own product'; end if;
  select * into v_a from addresses where id = p_address_id and profile_id = v_uid;
  if not found then raise exception 'address not found'; end if;

  v_no := 'PS' || to_char(now() at time zone 'Asia/Seoul', 'YYMMDDHH24MISS') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
  insert into market_orders (order_no, buyer_id, seller_id, product_id, product_title, item_amount, shipping_fee, total_amount,
                             recipient, phone, zipcode, address)
  values (v_no, v_uid, v_p.seller_profile_id, v_p.id, v_p.title, v_p.price, v_fee, v_p.price + v_fee,
          v_a.recipient, v_a.phone, v_a.zipcode, trim(v_a.addr1 || ' ' || coalesce(v_a.addr2, '')));
  return query select v_no, v_p.price + v_fee, left(v_p.title, 100);
end $$;
revoke execute on function public.create_market_order(uuid, bigint) from anon, public;
grant execute on function public.create_market_order(uuid, bigint) to authenticated;
