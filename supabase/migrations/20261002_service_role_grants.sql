-- 국세청 확인 서버(verify-business, recheck-businesses)가 쓰는 테이블·함수 권한
-- (이 프로젝트는 service_role 기본 권한이 없어 직접 줘야 함)
grant select, insert, update on public.business_verifications to service_role;
grant select, insert, update on public.nts_job_runs to service_role;
grant execute on function public.set_business_nts_visibility(uuid, boolean) to service_role;
