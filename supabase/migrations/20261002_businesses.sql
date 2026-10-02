-- 동네 업체 홍보 피드 (사업자 인증 업체만)

-- 1) 사업자 인증 ------------------------------------------------------------
create table if not exists public.business_verifications (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  company_name text not null,
  ceo_name text,
  biz_reg_no text not null unique,
  biz_type text,
  biz_item text,
  address text,
  cert_path text,
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.business_verifications enable row level security;
drop policy if exists biz_verif_select_own on public.business_verifications;
create policy biz_verif_select_own on public.business_verifications for select to authenticated
  using (profile_id = auth.uid());

-- 사업자등록번호 검증식(국세청)
create or replace function public.biz_reg_no_valid(p text)
returns boolean language plpgsql immutable as $$
declare
  d text := regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g');
  w int[] := array[1,3,7,1,3,7,1,3,5];
  s int := 0;
  i int;
begin
  if length(d) <> 10 then return false; end if;
  for i in 1..9 loop s := s + substr(d, i, 1)::int * w[i]; end loop;
  s := s + (substr(d, 9, 1)::int * 5) / 10;
  return (10 - s % 10) % 10 = substr(d, 10, 1)::int;
end $$;

-- 인증 신청: 번호가 맞으면 바로 인증 (사용자는 테이블에 직접 쓸 수 없음)
create or replace function public.submit_business_verification(
  p_company_name text, p_ceo_name text, p_biz_reg_no text,
  p_biz_type text, p_biz_item text, p_address text, p_cert_path text)
returns text language plpgsql security definer set search_path = public as $$
declare
  d text := regexp_replace(coalesce(p_biz_reg_no, ''), '[^0-9]', '', 'g');
  fmt text;
begin
  if auth.uid() is null then return 'login_required'; end if;
  if coalesce(trim(p_company_name), '') = '' then return 'name_required'; end if;
  if not public.biz_reg_no_valid(d) then return 'invalid_number'; end if;
  fmt := substr(d, 1, 3) || '-' || substr(d, 4, 2) || '-' || substr(d, 6, 5);
  if exists (select 1 from public.business_verifications where biz_reg_no = fmt and profile_id <> auth.uid()) then
    return 'already_used';
  end if;
  insert into public.business_verifications (profile_id, company_name, ceo_name, biz_reg_no, biz_type, biz_item, address, cert_path, verified_at)
  values (auth.uid(), left(trim(p_company_name), 100), left(p_ceo_name, 50), fmt, left(p_biz_type, 60), left(p_biz_item, 60), left(p_address, 200), p_cert_path, now())
  on conflict (profile_id) do update set
    company_name = excluded.company_name, ceo_name = excluded.ceo_name, biz_reg_no = excluded.biz_reg_no,
    biz_type = excluded.biz_type, biz_item = excluded.biz_item, address = excluded.address,
    cert_path = coalesce(excluded.cert_path, public.business_verifications.cert_path), verified_at = now();
  return 'ok';
end $$;
revoke execute on function public.submit_business_verification(text, text, text, text, text, text, text) from anon, public;
grant execute on function public.submit_business_verification(text, text, text, text, text, text, text) to authenticated;

-- 사업자등록증 사진: 비공개 버킷 (본인만)
insert into storage.buckets (id, name, public) values ('biz-docs', 'biz-docs', false) on conflict (id) do nothing;
drop policy if exists biz_docs_own_select on storage.objects;
create policy biz_docs_own_select on storage.objects for select to authenticated
  using (bucket_id = 'biz-docs' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists biz_docs_own_insert on storage.objects;
create policy biz_docs_own_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'biz-docs' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists biz_docs_own_delete on storage.objects;
create policy biz_docs_own_delete on storage.objects for delete to authenticated
  using (bucket_id = 'biz-docs' and (storage.foldername(name))[1] = auth.uid()::text);

-- 2) 업체 소개 ---------------------------------------------------------------
create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  name text not null check (length(name) between 1 and 40),
  tagline text not null check (length(tagline) between 1 and 40),
  description text not null default '' check (length(description) <= 2000),
  category_id bigint references public.categories(id) on delete set null,
  phone text,
  region text,
  lat double precision,
  lng double precision,
  like_count integer not null default 0,
  view_count integer not null default 0,
  report_count integer not null default 0,
  status text not null default 'active' check (status in ('active', 'hidden', 'deleted')),
  bumped_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists businesses_feed_idx on public.businesses (status, bumped_at desc);
create index if not exists businesses_owner_idx on public.businesses (owner_id);
alter table public.businesses enable row level security;

drop policy if exists businesses_select on public.businesses;
create policy businesses_select on public.businesses for select
  using (status = 'active' or owner_id = auth.uid());
drop policy if exists businesses_insert on public.businesses;
create policy businesses_insert on public.businesses for insert to authenticated
  with check (
    owner_id = auth.uid()
    and exists (select 1 from public.business_verifications v where v.profile_id = auth.uid())
    and (select count(*) from public.businesses b where b.owner_id = auth.uid() and b.status <> 'deleted') < 3
  );
drop policy if exists businesses_update_own on public.businesses;
create policy businesses_update_own on public.businesses for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- 찜·조회·신고 수, 끌어올림, 숨김은 본인이 직접 못 바꾸게 (내부 함수만)
create or replace function public.businesses_guard()
returns trigger language plpgsql as $$
begin
  if current_setting('ps.internal', true) is distinct from '1' then
    if tg_op = 'INSERT' then
      new.like_count := 0; new.view_count := 0; new.report_count := 0;
      new.status := 'active'; new.bumped_at := now(); new.created_at := now();
    else
      new.like_count := old.like_count; new.view_count := old.view_count; new.report_count := old.report_count;
      new.bumped_at := old.bumped_at; new.created_at := old.created_at; new.owner_id := old.owner_id;
      if old.status = 'hidden' and new.status = 'active' then new.status := 'hidden'; end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists businesses_guard on public.businesses;
create trigger businesses_guard before insert or update on public.businesses
  for each row execute function public.businesses_guard();

-- 사진
create table if not exists public.business_images (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  url text not null,
  sort_order integer not null default 0
);
alter table public.business_images enable row level security;
drop policy if exists business_images_select on public.business_images;
create policy business_images_select on public.business_images for select
  using (exists (select 1 from public.businesses b where b.id = business_id and (b.status = 'active' or b.owner_id = auth.uid())));
drop policy if exists business_images_write on public.business_images;
create policy business_images_write on public.business_images for all to authenticated
  using (exists (select 1 from public.businesses b where b.id = business_id and b.owner_id = auth.uid()))
  with check (exists (select 1 from public.businesses b where b.id = business_id and b.owner_id = auth.uid()));

-- 찜
create table if not exists public.business_likes (
  id bigint generated always as identity primary key,
  profile_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (profile_id, business_id)
);
alter table public.business_likes enable row level security;
drop policy if exists business_likes_own on public.business_likes;
create policy business_likes_own on public.business_likes for all to authenticated
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());

create or replace function public.sync_business_like_count()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform set_config('ps.internal', '1', true);
  if tg_op = 'INSERT' then
    update public.businesses set like_count = like_count + 1 where id = new.business_id;
  else
    update public.businesses set like_count = greatest(like_count - 1, 0) where id = old.business_id;
  end if;
  perform set_config('ps.internal', '', true);
  return null;
end $$;
drop trigger if exists business_likes_count on public.business_likes;
create trigger business_likes_count after insert or delete on public.business_likes
  for each row execute function public.sync_business_like_count();

-- 신고 (5건이면 자동 숨김)
create table if not exists public.business_reports (
  id bigint generated always as identity primary key,
  reporter_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  reason text check (length(reason) <= 200),
  created_at timestamptz not null default now(),
  unique (reporter_id, business_id)
);
alter table public.business_reports enable row level security;
drop policy if exists business_reports_insert on public.business_reports;
create policy business_reports_insert on public.business_reports for insert to authenticated
  with check (reporter_id = auth.uid()
    and not exists (select 1 from public.businesses b where b.id = business_id and b.owner_id = auth.uid()));
drop policy if exists business_reports_select_own on public.business_reports;
create policy business_reports_select_own on public.business_reports for select to authenticated
  using (reporter_id = auth.uid());

create or replace function public.on_business_report()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform set_config('ps.internal', '1', true);
  update public.businesses set report_count = report_count + 1,
    status = case when report_count + 1 >= 5 and status = 'active' then 'hidden' else status end
  where id = new.business_id;
  perform set_config('ps.internal', '', true);
  return null;
end $$;
drop trigger if exists business_reports_after_insert on public.business_reports;
create trigger business_reports_after_insert after insert on public.business_reports
  for each row execute function public.on_business_report();

-- 조회수, 끌어올리기(하루 1번)
create or replace function public.increment_business_view(p_business_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('ps.internal', '1', true);
  update public.businesses set view_count = view_count + 1 where id = p_business_id and status = 'active';
  perform set_config('ps.internal', '', true);
end $$;
grant execute on function public.increment_business_view(uuid) to anon, authenticated;

create or replace function public.bump_business(p_business_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare b public.businesses;
begin
  select * into b from public.businesses where id = p_business_id;
  if b.id is null or b.owner_id <> auth.uid() then return 'not_owner'; end if;
  if b.bumped_at > now() - interval '24 hours' then return 'too_soon'; end if;
  perform set_config('ps.internal', '1', true);
  update public.businesses set bumped_at = now() where id = p_business_id;
  perform set_config('ps.internal', '', true);
  return 'ok';
end $$;
revoke execute on function public.bump_business(uuid) from anon, public;
grant execute on function public.bump_business(uuid) to authenticated;

-- 3) 업체와 채팅 -------------------------------------------------------------
alter table public.chats alter column product_id drop not null;
alter table public.chats add column if not exists business_id uuid references public.businesses(id) on delete cascade;
alter table public.chats drop constraint if exists chats_target_check;
alter table public.chats add constraint chats_target_check check ((product_id is null) <> (business_id is null));
create unique index if not exists chats_business_buyer_key on public.chats (business_id, buyer_id) where business_id is not null;

drop policy if exists chats_insert_buyer on public.chats;
create policy chats_insert_buyer on public.chats for insert to authenticated
  with check (
    buyer_id = auth.uid() and (
      (product_id is not null and exists (select 1 from public.products p where p.id = product_id and p.seller_profile_id = seller_id and p.status <> 'deleted'))
      or (business_id is not null and exists (select 1 from public.businesses b where b.id = business_id and b.owner_id = seller_id and b.status = 'active'))
    )
  );
