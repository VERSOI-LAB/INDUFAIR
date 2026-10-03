-- 물건 끌어올리기: 회원 누구나 하루에 한 번, 내가 올린 판매중 물건 하나를 맨 위로
-- (홈의 '방금 올라온 물건'과 산다의 추천순이 bumped_at 을 기준으로 봄)

-- 1) 물건에 끌어올린 시각 (처음에는 올린 시각과 같음)
alter table public.products add column if not exists bumped_at timestamptz;
update public.products set bumped_at = created_at where bumped_at is null;
alter table public.products alter column bumped_at set default now();
alter table public.products alter column bumped_at set not null;
create index if not exists products_bumped_idx on public.products (bumped_at desc);

-- 주인이 직접 bumped_at 을 바꾸지 못하게 (아래 함수만)
create or replace function public.products_bump_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_setting('ps.internal', true) is distinct from '1' then
    if tg_op = 'INSERT' then new.bumped_at := now();
    else new.bumped_at := old.bumped_at;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists products_bump_guard on public.products;
create trigger products_bump_guard before insert or update on public.products
  for each row execute function public.products_bump_guard();

-- 2) 회원별 마지막 끌어올린 시각 (함수만 읽고 씀)
create table if not exists public.product_bumps (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  bumped_at timestamptz not null default now()
);
alter table public.product_bumps enable row level security;
revoke all on public.product_bumps from anon, authenticated;

-- 3) 끌어올리기. 결과: 'ok' | 'too_soon' | 'not_owner' | 'not_selling'
create or replace function public.bump_product(p_product_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare p record; last timestamptz;
begin
  select id, seller_profile_id, status into p from public.products where id = p_product_id;
  if not found or p.seller_profile_id is distinct from auth.uid() then return 'not_owner'; end if;
  if p.status <> 'selling' then return 'not_selling'; end if;
  select bumped_at into last from public.product_bumps where profile_id = auth.uid();
  if last is not null and last > now() - interval '24 hours' then return 'too_soon'; end if;

  perform set_config('ps.internal', '1', true);
  update public.products set bumped_at = now() where id = p_product_id;
  perform set_config('ps.internal', '', true);
  insert into public.product_bumps (profile_id, bumped_at) values (auth.uid(), now())
    on conflict (profile_id) do update set bumped_at = excluded.bumped_at;
  return 'ok';
end $$;
revoke execute on function public.bump_product(uuid) from anon, public;
grant execute on function public.bump_product(uuid) to authenticated;
