-- 배송비: 0 = 배송비 포함(무료), 0보다 크면 별도 배송비로 결제 금액에 더함
alter table public.products add column if not exists shipping_fee integer not null default 0;
alter table public.products drop constraint if exists products_shipping_fee_check;
alter table public.products add constraint products_shipping_fee_check check (shipping_fee >= 0 and shipping_fee <= 1000000);

-- 주문 만들기: 배송비를 물건에 설정된 값으로 (금액은 항상 서버가 계산)
create or replace function public.create_market_order(p_product_id uuid, p_address_id bigint, p_option integer default null)
returns table (order_no text, total_amount integer, order_name text)
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_p record;
  v_a record;
  v_no text;
  v_fee integer;
  v_price integer;
  v_opt jsonb;
  v_opt_name text;
begin
  if v_uid is null then raise exception 'login required'; end if;
  select id, title, price, status, seller_profile_id, options, shipping_fee into v_p from products where id = p_product_id;
  if not found then raise exception 'product not found'; end if;
  if v_p.status <> 'selling' then raise exception 'not for sale'; end if;
  if v_p.seller_profile_id = v_uid then raise exception 'own product'; end if;

  v_price := v_p.price;
  if jsonb_typeof(v_p.options) = 'array' and jsonb_array_length(v_p.options) > 1 then
    if p_option is null or p_option < 0 or p_option >= jsonb_array_length(v_p.options) then raise exception 'option required'; end if;
    v_opt := v_p.options -> p_option;
    v_opt_name := v_opt ->> 'name';
    v_price := coalesce(nullif((v_opt ->> 'price')::integer, 0), v_p.price);
  end if;
  if v_price is null or v_price <= 0 then raise exception 'price required'; end if;
  v_fee := greatest(coalesce(v_p.shipping_fee, 0), 0);

  select * into v_a from addresses where id = p_address_id and profile_id = v_uid;
  if not found then raise exception 'address not found'; end if;

  v_no := 'PS' || to_char(now() at time zone 'Asia/Seoul', 'YYMMDDHH24MISS') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
  insert into market_orders (order_no, buyer_id, seller_id, product_id, product_title, option_name, item_amount, shipping_fee, total_amount,
                             recipient, phone, zipcode, address)
  values (v_no, v_uid, v_p.seller_profile_id, v_p.id, v_p.title, v_opt_name, v_price, v_fee, v_price + v_fee,
          v_a.recipient, v_a.phone, v_a.zipcode, trim(v_a.addr1 || ' ' || coalesce(v_a.addr2, '')));
  return query select v_no, v_price + v_fee, left(v_p.title || coalesce(' · ' || v_opt_name, ''), 100);
end $$;
revoke execute on function public.create_market_order(uuid, bigint, integer) from anon, public;
grant execute on function public.create_market_order(uuid, bigint, integer) to authenticated;
