-- 장바구니 묶음 주문 + 판매자별 배송비 무료 기준
-- 같은 판매자 물건을 합친 금액이 그 판매자의 기준 금액 이상이면 배송비 0원

-- 1) 판매자별 배송비 무료 기준 (null 또는 0 = 기준 없음)
alter table public.profiles add column if not exists free_ship_min integer;
alter table public.profiles drop constraint if exists profiles_free_ship_min_check;
alter table public.profiles add constraint profiles_free_ship_min_check check (free_ship_min is null or (free_ship_min >= 0 and free_ship_min <= 100000000));

-- 누구나 판매자의 기준 금액만 볼 수 있게 (프로필 전체는 비공개 유지)
create or replace function public.get_free_ship_min(p_ids uuid[])
returns table (id uuid, free_ship_min integer)
language sql stable security definer set search_path = public as $$
  select p.id, p.free_ship_min from profiles p where p.id = any(p_ids);
$$;
grant execute on function public.get_free_ship_min(uuid[]) to anon, authenticated;

-- 판다산다: 30만원 이상 배송비 무료
update public.profiles set free_ship_min = 300000 where id = '1bdc6eb2-6017-4740-a825-7dc325f37e42';

-- 2) 주문에 담긴 물건들
create table if not exists public.market_order_items (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.market_orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_title text not null,
  option_name text,
  unit_price integer not null check (unit_price >= 0),
  qty integer not null check (qty between 1 and 999),
  line_amount integer not null check (line_amount >= 0)
);
create index if not exists market_order_items_order_idx on public.market_order_items (order_id);
alter table public.market_order_items enable row level security;
drop policy if exists market_order_items_select on public.market_order_items;
create policy market_order_items_select on public.market_order_items for select to authenticated
  using (exists (select 1 from market_orders o where o.id = order_id and (o.buyer_id = auth.uid() or o.seller_id = auth.uid())));
grant select on public.market_order_items to authenticated;
grant select, insert on public.market_order_items to service_role;

-- 3) 주문 만들기 (여러 물건, 한 판매자). 금액·배송비는 모두 서버가 계산
--    p_items: [{"product_id": "...", "option": 0, "qty": 2}, ...]
create or replace function public.create_market_order_cart(p_items jsonb, p_address_id bigint)
returns table (order_no text, total_amount integer, order_name text)
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_it jsonb;
  v_p record;
  v_a record;
  v_seller uuid;
  v_price integer;
  v_qty integer;
  v_opt integer;
  v_opt_name text;
  v_sub integer := 0;
  v_fee integer := 0;
  v_min integer;
  v_no text;
  v_order uuid;
  v_first_title text;
  v_first_opt text;
  v_first_pid uuid;
  v_n integer := 0;
  v_lines jsonb := '[]'::jsonb;
begin
  if v_uid is null then raise exception 'login required'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 50 then raise exception 'no items'; end if;

  for v_it in select * from jsonb_array_elements(p_items) loop
    select id, title, price, status, seller_profile_id, options, shipping_fee into v_p from products where id = (v_it ->> 'product_id')::uuid;
    if not found then raise exception 'product not found'; end if;
    if v_p.status <> 'selling' then raise exception 'not for sale'; end if;
    if v_p.seller_profile_id = v_uid then raise exception 'own product'; end if;
    if v_seller is null then v_seller := v_p.seller_profile_id;
    elsif v_seller <> v_p.seller_profile_id then raise exception 'one seller per order'; end if;

    v_qty := coalesce((v_it ->> 'qty')::integer, 1);
    if v_qty < 1 or v_qty > 999 then raise exception 'bad qty'; end if;
    v_price := v_p.price; v_opt_name := null;
    if jsonb_typeof(v_p.options) = 'array' and jsonb_array_length(v_p.options) > 1 then
      v_opt := (v_it ->> 'option')::integer;
      if v_opt is null or v_opt < 0 or v_opt >= jsonb_array_length(v_p.options) then raise exception 'option required'; end if;
      v_opt_name := v_p.options -> v_opt ->> 'name';
      v_price := coalesce(nullif((v_p.options -> v_opt ->> 'price')::integer, 0), v_p.price);
    end if;
    if v_price is null or v_price <= 0 then raise exception 'price required'; end if;

    v_sub := v_sub + v_price * v_qty;
    v_fee := greatest(v_fee, coalesce(v_p.shipping_fee, 0));  -- 묶음 배송: 가장 큰 배송비 한 번
    v_n := v_n + 1;
    if v_n = 1 then v_first_title := v_p.title; v_first_opt := v_opt_name; v_first_pid := v_p.id; end if;
    v_lines := v_lines || jsonb_build_object('pid', v_p.id, 'title', v_p.title, 'opt', v_opt_name, 'price', v_price, 'qty', v_qty);
  end loop;

  select free_ship_min into v_min from profiles where id = v_seller;
  if coalesce(v_min, 0) > 0 and v_sub >= v_min then v_fee := 0; end if;

  select * into v_a from addresses where id = p_address_id and profile_id = v_uid;
  if not found then raise exception 'address not found'; end if;

  v_no := 'PS' || to_char(now() at time zone 'Asia/Seoul', 'YYMMDDHH24MISS') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
  insert into market_orders (order_no, buyer_id, seller_id, product_id, product_title, option_name, item_amount, shipping_fee, total_amount,
                             recipient, phone, zipcode, address)
  values (v_no, v_uid, v_seller, case when v_n = 1 then v_first_pid end,
          v_first_title || case when v_n > 1 then ' 외 ' || (v_n - 1) || '건' else '' end,
          case when v_n = 1 then v_first_opt end, v_sub, v_fee, v_sub + v_fee,
          v_a.recipient, v_a.phone, v_a.zipcode, trim(v_a.addr1 || ' ' || coalesce(v_a.addr2, '')))
  returning id into v_order;

  insert into market_order_items (order_id, product_id, product_title, option_name, unit_price, qty, line_amount)
  select v_order, (l ->> 'pid')::uuid, l ->> 'title', l ->> 'opt', (l ->> 'price')::integer, (l ->> 'qty')::integer,
         (l ->> 'price')::integer * (l ->> 'qty')::integer
  from jsonb_array_elements(v_lines) l;

  return query select v_no, v_sub + v_fee, left(v_first_title || case when v_n > 1 then ' 외 ' || (v_n - 1) || '건' else '' end, 100);
end $$;
revoke execute on function public.create_market_order_cart(jsonb, bigint) from anon, public;
grant execute on function public.create_market_order_cart(jsonb, bigint) to authenticated;
