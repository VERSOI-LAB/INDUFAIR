-- 업체 프리미엄 (월 정기결제)
-- 혜택: 매일 자동 끌어올리기 + 산다 화면 동네 업체 맨 앞 고정
-- 결제하지 않은 업체는 지금처럼 하루 한 번 직접 끌어올리기 (bump_business 그대로)
-- 결제·청구는 Edge Function biz-billing 이 처리 (토스페이먼츠 자동결제)

-- 1) 업체에 프리미엄 만료 시각 (공개: 목록 정렬·배지에 사용)
alter table public.businesses add column if not exists premium_until timestamptz;
create index if not exists businesses_premium_idx on public.businesses (premium_until) where premium_until is not null;

-- 주인이 직접 premium_until 을 바꾸지 못하게 (서버 함수만)
create or replace function public.businesses_guard()
returns trigger language plpgsql as $$
begin
  if current_setting('ps.internal', true) is distinct from '1' then
    if tg_op = 'INSERT' then
      new.like_count := 0; new.view_count := 0; new.report_count := 0;
      new.status := 'active'; new.hidden_reason := null; new.bumped_at := now(); new.created_at := now();
      new.premium_until := null;
    else
      new.like_count := old.like_count; new.view_count := old.view_count; new.report_count := old.report_count;
      new.bumped_at := old.bumped_at; new.created_at := old.created_at; new.owner_id := old.owner_id;
      new.hidden_reason := old.hidden_reason;
      new.premium_until := old.premium_until;
      if old.status = 'hidden' and new.status = 'active' then new.status := 'hidden'; end if;
    end if;
  end if;
  return new;
end $$;

-- 2) 구독 (업체 하나에 하나)
create table if not exists public.biz_subscriptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null unique references public.businesses(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  -- active: 이용 중 / canceled: 해지함(기간 끝까지 이용) / past_due: 결제 실패, 다시 시도 중 / ended: 끝남
  status text not null default 'active' check (status in ('active', 'canceled', 'past_due', 'ended')),
  amount integer not null default 10000 check (amount > 0),
  customer_key text not null,
  billing_key text not null,           -- 토스 자동결제 키 (비밀: 사용자에게 읽기 권한 없음)
  card_label text,                     -- 화면 표시용 (예: 신한 1234)
  period_end timestamptz not null,     -- 이번 결제로 이용할 수 있는 마지막 시각
  next_charge_at timestamptz,          -- 다음 청구 예정 (해지·종료면 null)
  fail_count integer not null default 0,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists biz_subscriptions_due_idx on public.biz_subscriptions (next_charge_at) where next_charge_at is not null;
alter table public.biz_subscriptions enable row level security;

drop policy if exists biz_subscriptions_select on public.biz_subscriptions;
create policy biz_subscriptions_select on public.biz_subscriptions for select to authenticated
  using (owner_id = auth.uid());

-- 사용자는 자기 구독의 표시용 컬럼만 읽을 수 있음 (billing_key·customer_key 제외, 쓰기 불가)
revoke all on public.biz_subscriptions from anon, authenticated;
grant select (id, business_id, owner_id, status, amount, card_label, period_end, next_charge_at, canceled_at, created_at)
  on public.biz_subscriptions to authenticated;
grant select, insert, update on public.biz_subscriptions to service_role;

-- 3) 결제 기록
create table if not exists public.biz_sub_payments (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid references public.biz_subscriptions(id) on delete set null,
  business_id uuid not null,
  owner_id uuid not null,
  order_id text not null unique,
  amount integer not null,
  status text not null check (status in ('paid', 'failed')),
  payment_key text,
  message text,
  created_at timestamptz not null default now()
);
alter table public.biz_sub_payments enable row level security;
drop policy if exists biz_sub_payments_select on public.biz_sub_payments;
create policy biz_sub_payments_select on public.biz_sub_payments for select to authenticated
  using (owner_id = auth.uid());
revoke all on public.biz_sub_payments from anon, authenticated;
grant select (id, business_id, order_id, amount, status, message, created_at) on public.biz_sub_payments to authenticated;
grant select, insert on public.biz_sub_payments to service_role;

-- Edge Function 이 업체·주인을 확인할 때 필요
grant select on public.businesses to service_role;

-- 4) 프리미엄 켜기/연장 (Edge Function 만 사용)
create or replace function public.set_business_premium(p_business_id uuid, p_until timestamptz, p_bump boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('ps.internal', '1', true);
  update public.businesses
     set premium_until = p_until,
         bumped_at = case when p_bump then now() else bumped_at end
   where id = p_business_id;
  perform set_config('ps.internal', '', true);
end $$;
revoke execute on function public.set_business_premium(uuid, timestamptz, boolean) from anon, authenticated, public;
grant execute on function public.set_business_premium(uuid, timestamptz, boolean) to service_role;

-- 5) 프리미엄 업체 매일 자동 끌어올리기 (한국시간 00:05)
create or replace function public.premium_daily_bump()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  perform set_config('ps.internal', '1', true);
  update public.businesses set bumped_at = now() where premium_until > now() and status = 'active';
  get diagnostics n = row_count;
  perform set_config('ps.internal', '', true);
  return n;
end $$;
revoke execute on function public.premium_daily_bump() from anon, authenticated, public;

select cron.unschedule('biz-premium-bump') where exists (select 1 from cron.job where jobname = 'biz-premium-bump');
select cron.schedule('biz-premium-bump', '5 15 * * *', $$ select public.premium_daily_bump(); $$);

-- 6) 매일 청구 (한국시간 오전 10시): 청구일이 된 구독만 결제. 여러 번 불려도 같은 달은 한 번만 결제됨
select cron.unschedule('biz-billing-cron') where exists (select 1 from cron.job where jobname = 'biz-billing-cron');
select cron.schedule('biz-billing-cron', '0 1 * * *', $$
  select net.http_post(
    url := 'https://rqjfergjfhcrcuvfuhkm.supabase.co/functions/v1/biz-billing',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"action": "cron"}'::jsonb
  );
$$);
