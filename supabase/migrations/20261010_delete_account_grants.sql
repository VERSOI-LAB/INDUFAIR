-- 회원 탈퇴 서버(delete-account)가 쓰는 테이블 권한
-- (이 프로젝트는 service_role 기본 권한이 없어 직접 줘야 함)
grant select, update on public.businesses to service_role;
grant select, update on public.profiles to service_role;
grant select, delete on public.seller_payout_accounts to service_role;
grant select, delete on public.business_verifications to service_role;
grant select, delete on public.addresses to service_role;
grant select, delete on public.favorites to service_role;
grant select, delete on public.business_likes to service_role;
grant select, delete on public.keyword_alerts to service_role;
grant select, delete on public.notifications to service_role;
