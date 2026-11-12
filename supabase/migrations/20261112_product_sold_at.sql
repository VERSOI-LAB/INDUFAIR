-- 판매완료 날짜: 상태가 '판매완료'로 바뀐 때를 기록 (판매관리·구매내역에서 날짜로 찾기)
-- 이전에 판매완료된 물건은 비어 있고, 화면에서는 등록일(또는 마지막 채팅일)로 대신 보여줌
alter table public.products add column if not exists sold_at timestamptz;

create or replace function public.products_sold_at()
returns trigger language plpgsql as $$
begin
  if new.status = 'sold' and (tg_op = 'INSERT' or old.status is distinct from 'sold') then
    new.sold_at := now();
  elsif new.status <> 'sold' then
    new.sold_at := null;
  elsif tg_op = 'UPDATE' then
    new.sold_at := old.sold_at; -- 판매완료 상태에서는 직접 못 바꿈
  end if;
  return new;
end $$;
drop trigger if exists products_sold_at on public.products;
create trigger products_sold_at before insert or update of status, sold_at on public.products
  for each row execute function public.products_sold_at();
