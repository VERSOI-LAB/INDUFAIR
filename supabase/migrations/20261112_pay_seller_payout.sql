-- 안전결제 판매자 신청은 정산 계좌를 등록한 뒤에만 (판매 대금을 받을 곳이 있어야 함)
create or replace function public.request_pay_seller(p_mail_order_no text, p_exempt boolean, p_cert_path text)
returns text language plpgsql security definer set search_path = public as $$
declare v record; v_no text := nullif(btrim(coalesce(p_mail_order_no, '')), ''); v_path text := nullif(btrim(coalesce(p_cert_path, '')), '');
begin
  if auth.uid() is null then return 'login_required'; end if;
  select * into v from business_verifications where profile_id = auth.uid();
  if not found then return 'not_verified'; end if;
  if v.nts_status <> 'active' then return 'nts_not_active'; end if;
  if v.pay_status = 'approved' then return 'already_approved'; end if;
  if not exists (select 1 from seller_payout_accounts where profile_id = auth.uid()) then return 'payout_required'; end if;
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
