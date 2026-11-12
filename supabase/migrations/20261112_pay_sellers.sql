-- 안전결제(카드결제·정산)는 '안전결제 판매자'로 승인된 사업자만
--   토스페이먼츠 정책: 사업자등록이 없는 개인(비사업자)이 판매하고 대금을 정산받는 C2C 구조는 입점 불가
--   → 개인 판매자 물건은 지금처럼 채팅으로 직접 거래 (플랫폼은 대금을 다루지 않음)
--   → 사업자 판매자: 사업자 인증(국세청 계속사업자) + 통신판매업신고 확인(운영자 승인) 후 안전결제 열림
--
-- 판매자 신청: request_pay_seller(신고번호, 면제 여부, 신고증 사진 경로) → pay_status = 'requested'
-- 운영자 승인: select approve_pay_seller('<profile_id>');  거절: select reject_pay_seller('<profile_id>', '사유');
-- 사업자등록번호가 바뀌면 승인은 처음부터 다시

-- 1) 사업자 인증에 통신판매업 신고·안전결제 승인 상태
alter table public.business_verifications
  add column if not exists mail_order_no text,
  add column if not exists mail_order_exempt boolean not null default false,  -- 간이과세자 등 신고 면제 대상
  add column if not exists mail_order_cert_path text,
  add column if not exists pay_status text not null default 'none',
  add column if not exists pay_requested_at timestamptz,
  add column if not exists pay_approved_at timestamptz,
  add column if not exists pay_reject_reason text;
alter table public.business_verifications drop constraint if exists business_verifications_pay_status_check;
alter table public.business_verifications add constraint business_verifications_pay_status_check
  check (pay_status in ('none', 'requested', 'approved', 'rejected'));

-- 사업자 정보(번호)가 바뀌면 안전결제 승인 초기화
create or replace function public.business_verifications_pay_reset()
returns trigger language plpgsql as $$
begin
  if new.biz_reg_no is distinct from old.biz_reg_no then
    new.pay_status := 'none'; new.pay_requested_at := null; new.pay_approved_at := null; new.pay_reject_reason := null;
    new.mail_order_no := null; new.mail_order_exempt := false; new.mail_order_cert_path := null;
  end if;
  return new;
end $$;
drop trigger if exists business_verifications_pay_reset on public.business_verifications;
create trigger business_verifications_pay_reset before update on public.business_verifications
  for each row execute function public.business_verifications_pay_reset();

-- 2) 안전결제 가능한 판매자인가: 승인됨 + 국세청 계속사업자
create or replace function public.pay_seller_ok(p_seller uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from business_verifications
                  where profile_id = p_seller and pay_status = 'approved' and nts_status = 'active');
$$;
revoke execute on function public.pay_seller_ok(uuid) from anon, authenticated, public;
grant execute on function public.pay_seller_ok(uuid) to service_role;

-- 화면용: 여러 판매자 중 안전결제 가능한 판매자 id 만 (승인 여부 외에는 아무것도 드러내지 않음)
create or replace function public.get_pay_sellers(p_ids uuid[])
returns table (id uuid)
language sql stable security definer set search_path = public as $$
  select bv.profile_id from business_verifications bv
   where bv.profile_id = any(p_ids) and bv.pay_status = 'approved' and bv.nts_status = 'active';
$$;
grant execute on function public.get_pay_sellers(uuid[]) to anon, authenticated;

-- 3) 주문은 안전결제 판매자에게만 (create_market_order / create_market_order_cart 모두 여기서 막힘)
create or replace function public.market_orders_pay_seller_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not pay_seller_ok(new.seller_id) then raise exception 'seller not payable'; end if;
  return new;
end $$;
drop trigger if exists market_orders_pay_seller_guard on public.market_orders;
create trigger market_orders_pay_seller_guard before insert on public.market_orders
  for each row execute function public.market_orders_pay_seller_guard();

-- 4) 판매자: 안전결제 신청. 결과: 'ok' | 'login_required' | 'not_verified' | 'nts_not_active' | 'mail_order_required' | 'already_approved'
create or replace function public.request_pay_seller(p_mail_order_no text, p_exempt boolean, p_cert_path text)
returns text language plpgsql security definer set search_path = public as $$
declare v record; v_no text := nullif(btrim(coalesce(p_mail_order_no, '')), ''); v_path text := nullif(btrim(coalesce(p_cert_path, '')), '');
begin
  if auth.uid() is null then return 'login_required'; end if;
  select * into v from business_verifications where profile_id = auth.uid();
  if not found then return 'not_verified'; end if;
  if v.nts_status <> 'active' then return 'nts_not_active'; end if;
  if v.pay_status = 'approved' then return 'already_approved'; end if;
  if not coalesce(p_exempt, false) and (v_no is null or length(v_no) > 40) then return 'mail_order_required'; end if;
  if v_path is not null and v_path not like auth.uid()::text || '/%' then v_path := null; end if;
  update business_verifications
     set mail_order_no = case when coalesce(p_exempt, false) then null else v_no end,
         mail_order_exempt = coalesce(p_exempt, false),
         mail_order_cert_path = coalesce(v_path, mail_order_cert_path),
         pay_status = 'requested', pay_requested_at = now(), pay_reject_reason = null
   where profile_id = auth.uid();
  return 'ok';
end $$;
revoke execute on function public.request_pay_seller(text, boolean, text) from anon, public;
grant execute on function public.request_pay_seller(text, boolean, text) to authenticated;

-- 5) 운영자: 승인 / 거절 (SQL Editor 또는 service_role)
create or replace function public.approve_pay_seller(p_profile uuid)
returns text language plpgsql security definer set search_path = public as $$
begin
  update business_verifications set pay_status = 'approved', pay_approved_at = now(), pay_reject_reason = null
   where profile_id = p_profile;
  return case when found then 'ok' else 'not_found' end;
end $$;
create or replace function public.reject_pay_seller(p_profile uuid, p_reason text)
returns text language plpgsql security definer set search_path = public as $$
begin
  update business_verifications set pay_status = 'rejected', pay_approved_at = null, pay_reject_reason = left(p_reason, 200)
   where profile_id = p_profile;
  return case when found then 'ok' else 'not_found' end;
end $$;
revoke execute on function public.approve_pay_seller(uuid) from anon, authenticated, public;
revoke execute on function public.reject_pay_seller(uuid, text) from anon, authenticated, public;
grant execute on function public.approve_pay_seller(uuid) to service_role;
grant execute on function public.reject_pay_seller(uuid, text) to service_role;

-- 6) 판다산다 공식 판매 계정(베르소이, 사업자)은 사업자 인증이 있으면 바로 승인
update public.business_verifications set pay_status = 'approved', pay_approved_at = now()
 where profile_id = '1bdc6eb2-6017-4740-a825-7dc325f37e42' and pay_status <> 'approved';
