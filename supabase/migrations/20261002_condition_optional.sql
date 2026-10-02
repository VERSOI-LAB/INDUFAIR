-- 상태(condition)를 고르지 않으면 비워 두고, 뱃지도 붙이지 않음
alter table public.products alter column condition drop not null;
alter table public.products alter column condition drop default;
alter table public.products drop constraint if exists products_condition_check;
alter table public.products add constraint products_condition_check
  check (condition is null or condition in ('great','good','broken'));
