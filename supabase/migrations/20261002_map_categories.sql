-- 산다 지도 화면: 대분류 5개 + 물건 좌표

-- 1) 대분류 5개 (중·소분류는 나중에 parent_id 로 추가)
insert into public.categories (name, parent_id, icon, sort_order) values
  ('중고장터', null, 'used', 1),
  ('산업기계', null, 'machine', 2),
  ('공구·부품', null, 'tools', 3),
  ('자동화·전기', null, 'electric', 4),
  ('물류·창고', null, 'logistics', 5);

-- 2) 기존 상품을 새 분류로 옮기기
update public.products p set category_id = n.id
from public.categories o, public.categories n
where p.category_id = o.id and n.parent_id is null and n.name = case o.name
  when '기계장비' then '산업기계'
  when '집진기' then '산업기계'
  when '에어콤프레샤' then '산업기계'
  when '모터' then '산업기계'
  when '펌프' then '산업기계'
  when '공구' then '공구·부품'
  when '중고부품' then '공구·부품'
  when '전기부품' then '자동화·전기'
  else '중고장터' end
  and o.name in ('기계장비','집진기','에어콤프레샤','모터','펌프','공구','중고부품','전기부품','기타');

-- 3) 예전 9개 분류 삭제
delete from public.categories
where name in ('기계장비','집진기','에어콤프레샤','모터','펌프','전기부품','공구','중고부품','기타');

-- 4) 지도용 좌표 (동네 수준, 소수점 3자리 ≈ 100m)
alter table public.products
  add column if not exists lat double precision,
  add column if not exists lng double precision;
create index if not exists products_lat_lng_idx on public.products (lat, lng);

-- 이미 올라온 분당구 물건은 분당구 중심 좌표로
update public.products set lat = 37.383, lng = 127.119
where lat is null and region like '%분당%';
