-- 지원금 진단(/diagnose) 답: 업종·지역·규모·업력·관심 분야
--   - 진단을 마치고 로그인하면 저장 → 맞춤 지원사업 목록, 마감 알림(support_alerts), 나중에 맞춤 메시지에 씀
--   - 한 사람에 한 줄, 본인만 읽고 쓰기

create table if not exists public.company_profiles (
  profile_id uuid primary key default auth.uid() references public.profiles(id) on delete cascade,
  industry text not null check (industry in ('manufacturing', 'wholesale', 'construction', 'it', 'service', 'etc')),
  region text not null check (region in ('서울', '부산', '대구', '인천', '전남광주', '대전', '울산', '세종', '경기', '강원', '충북', '충남', '전북', '경북', '경남', '제주')),
  size text not null check (size in ('pre', 'micro', 'small', 'mid')),   -- 예비창업 / 1~4명 / 5~49명 / 50명 이상
  age text not null check (age in ('pre', 'lt3', '3to7', 'gt7')),        -- 예비창업 / 3년 미만 / 3~7년 / 7년 이상
  fields text[] not null default '{}' check (cardinality(fields) <= 7 and fields <@ array['경영', '기술', '금융', '수출', '인력', '내수', '창업']),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.company_profiles enable row level security;
drop policy if exists company_profiles_own on public.company_profiles;
create policy company_profiles_own on public.company_profiles for all to authenticated
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());
revoke all on public.company_profiles from anon, authenticated;
grant select, insert, update, delete on public.company_profiles to authenticated;
grant select on public.company_profiles to service_role;
