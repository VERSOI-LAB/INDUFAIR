-- 규격(옵션) 여러 개: [{ "name": "Φ6.3", "price": 12000 }, ...]  price 가 없거나 0이면 기본 가격
alter table public.products add column if not exists options jsonb not null default '[]'::jsonb;
alter table public.market_orders add column if not exists option_name text;

-- 주문 만들기: 규격을 고른 경우 그 규격 가격으로 (금액은 항상 서버가 계산)
drop function if exists public.create_market_order(uuid, bigint);
create or replace function public.create_market_order(p_product_id uuid, p_address_id bigint, p_option integer default null)
returns table (order_no text, total_amount integer, order_name text)
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_p record;
  v_a record;
  v_no text;
  v_fee integer := 0;  -- 배송비 (정책 정해지면 여기서 계산)
  v_price integer;
  v_opt jsonb;
  v_opt_name text;
begin
  if v_uid is null then raise exception 'login required'; end if;
  select id, title, price, status, seller_profile_id, options into v_p from products where id = p_product_id;
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

-- 이미 올린 물건 중 규격이 여러 개(Φ6.3/Φ7.9/Φ9.5)인 것은 고를 수 있게 옵션으로
update public.products p set
  options = (select jsonb_agg(jsonb_build_object('name', o)) from unnest(string_to_array('Φ6.3/Φ7.9/Φ9.5', '/')) o),
  title = regexp_replace(p.title, '\s*\(Φ6\.3/Φ7\.9/Φ9\.5[^)]*\)\s*$', '') || ' (Φ6.3/Φ7.9/Φ9.5)'
where p.status <> 'deleted' and p.title like '%(Φ6.3/Φ7.9/Φ9.5%' and p.options = '[]'::jsonb;
