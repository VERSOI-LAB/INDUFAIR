-- 사용기간에 '신품' 추가
alter table public.products drop constraint if exists products_usage_period_check;
alter table public.products add constraint products_usage_period_check
  check (usage_period is null or usage_period in ('new','lt1','1to3','gt3'));
