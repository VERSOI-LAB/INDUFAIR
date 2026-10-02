-- 국세청 사업자 상태조회 연동

-- 1) 인증에 국세청 상태
alter table public.business_verifications
  add column if not exists nts_status text not null default 'pending',
  add column if not exists nts_checked_at timestamptz;
alter table public.business_verifications drop constraint if exists business_verifications_nts_status_check;
alter table public.business_verifications add constraint business_verifications_nts_status_check
  check (nts_status in ('active', 'pending', 'suspended', 'closed', 'unregistered'));

-- 국세청 확인 없이 인증하던 RPC 는 이제 쓰지 않음 (Edge Function verify-business 가 대신함)
revoke execute on function public.submit_business_verification(text, text, text, text, text, text, text) from authenticated;

-- 2) 업체 숨김 사유 (신고 / 국세청)
alter table public.businesses add column if not exists hidden_reason text;
alter table public.businesses drop constraint if exists businesses_hidden_reason_check;
alter table public.businesses add constraint businesses_hidden_reason_check
  check (hidden_reason is null or hidden_reason in ('reports', 'nts'));

create or replace function public.businesses_guard()
returns trigger language plpgsql as $$
begin
  if current_setting('ps.internal', true) is distinct from '1' then
    if tg_op = 'INSERT' then
      new.like_count := 0; new.view_count := 0; new.report_count := 0;
      new.status := 'active'; new.hidden_reason := null; new.bumped_at := now(); new.created_at := now();
    else
      new.like_count := old.like_count; new.view_count := old.view_count; new.report_count := old.report_count;
      new.bumped_at := old.bumped_at; new.created_at := old.created_at; new.owner_id := old.owner_id;
      new.hidden_reason := old.hidden_reason;
      if old.status = 'hidden' and new.status = 'active' then new.status := 'hidden'; end if;
    end if;
  end if;
  return new;
end $$;

create or replace function public.on_business_report()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform set_config('ps.internal', '1', true);
  update public.businesses set report_count = report_count + 1,
    hidden_reason = case when report_count + 1 >= 5 and status = 'active' then 'reports' else hidden_reason end,
    status = case when report_count + 1 >= 5 and status = 'active' then 'hidden' else status end
  where id = new.business_id;
  perform set_config('ps.internal', '', true);
  return null;
end $$;

-- 국세청 결과로 숨기기/복구 (정기 확인 함수만 사용)
create or replace function public.set_business_nts_visibility(p_owner uuid, p_hide boolean)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  perform set_config('ps.internal', '1', true);
  if p_hide then
    update public.businesses set status = 'hidden', hidden_reason = 'nts' where owner_id = p_owner and status = 'active';
  else
    update public.businesses set status = 'active', hidden_reason = null where owner_id = p_owner and status = 'hidden' and hidden_reason = 'nts';
  end if;
  get diagnostics n = row_count;
  perform set_config('ps.internal', '', true);
  return n;
end $$;
revoke execute on function public.set_business_nts_visibility(uuid, boolean) from anon, authenticated, public;

-- 3) 업체 등록: 국세청 확인 중이거나 계속사업자일 때만
drop policy if exists businesses_insert on public.businesses;
create policy businesses_insert on public.businesses for insert to authenticated
  with check (
    owner_id = auth.uid()
    and exists (select 1 from public.business_verifications v where v.profile_id = auth.uid() and v.nts_status in ('active', 'pending'))
    and (select count(*) from public.businesses b where b.owner_id = auth.uid() and b.status <> 'deleted') < 3
  );

-- 4) 정기 확인: 마지막 실행 시각 + 매일 새벽 3시(한국시간) 실행
create table if not exists public.nts_job_runs (
  id integer primary key,
  last_run_at timestamptz not null default now()
);
alter table public.nts_job_runs enable row level security;

select cron.unschedule('recheck-businesses') where exists (select 1 from cron.job where jobname = 'recheck-businesses');
select cron.schedule('recheck-businesses', '0 18 * * *', $$
  select net.http_post(
    url := 'https://rqjfergjfhcrcuvfuhkm.supabase.co/functions/v1/recheck-businesses',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);
