-- 업체 프리미엄: 추천 물건 (산다 화면 '추천순' 맨 앞에 보임)
-- 프리미엄 이용 중인 업체의 대표가 자기가 올린 판매중 물건 중 업체당 최대 4개를 고름
-- (20261003_biz_premium.sql 다음에 실행)

create table if not exists public.biz_featured (
  business_id uuid not null references public.businesses(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (business_id, product_id)
);
create index if not exists biz_featured_product_idx on public.biz_featured (product_id);
alter table public.biz_featured enable row level security;

-- 누구나 읽기 (목록 정렬에 사용). 쓰기는 아래 함수로만
drop policy if exists biz_featured_select on public.biz_featured;
create policy biz_featured_select on public.biz_featured for select using (true);
revoke all on public.biz_featured from anon, authenticated;
grant select on public.biz_featured to anon, authenticated;

-- 추천 물건 넣기/빼기. 결과: 'ok' | 'not_owner' | 'not_premium' | 'not_my_product' | 'full'
create or replace function public.set_biz_featured(p_business_id uuid, p_product_id uuid, p_on boolean)
returns text language plpgsql security definer set search_path = public as $$
declare b public.businesses%rowtype;
begin
  select * into b from public.businesses where id = p_business_id;
  if not found or b.owner_id is distinct from auth.uid() or b.status = 'deleted' then return 'not_owner'; end if;

  if not p_on then
    delete from public.biz_featured where business_id = p_business_id and product_id = p_product_id;
    return 'ok';
  end if;

  if b.premium_until is null or b.premium_until <= now() then return 'not_premium'; end if;
  if not exists (select 1 from public.products p
                  where p.id = p_product_id and p.seller_profile_id = auth.uid() and p.status = 'selling') then
    return 'not_my_product';
  end if;
  if exists (select 1 from public.biz_featured where business_id = p_business_id and product_id = p_product_id) then return 'ok'; end if;
  if (select count(*) from public.biz_featured where business_id = p_business_id) >= 4 then return 'full'; end if;

  insert into public.biz_featured (business_id, product_id) values (p_business_id, p_product_id);
  return 'ok';
end $$;
revoke execute on function public.set_biz_featured(uuid, uuid, boolean) from anon, public;
grant execute on function public.set_biz_featured(uuid, uuid, boolean) to authenticated;
