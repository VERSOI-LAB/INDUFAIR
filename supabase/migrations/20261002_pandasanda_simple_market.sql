-- 판다산다: B2B 몰 → "산업용품 당근마켓" 단순화

-- 1) 카테고리: 9개 평면 카테고리로 교체 (참조 테이블 모두 0행)
update public.products set category_id = null;
delete from public.categories where parent_id is not null;
delete from public.categories;
insert into public.categories (name, parent_id, icon, sort_order) values
  ('기계장비', null, '⚙️', 1),
  ('집진기', null, '🌀', 2),
  ('에어콤프레샤', null, '💨', 3),
  ('모터', null, '🔄', 4),
  ('펌프', null, '💧', 5),
  ('전기부품', null, '⚡', 6),
  ('공구', null, '🔧', 7),
  ('중고부품', null, '🔩', 8),
  ('기타', null, '📦', 9);

-- 2) 상품: 쉬운 필드만 사용
alter table public.products
  add column if not exists brand text,
  add column if not exists usage_period text,
  add column if not exists phone_visible boolean not null default true;

alter table public.products alter column market_type set default 'used';
alter table public.products alter column stock set default 1;
alter table public.products alter column trade_type set default 'direct';
alter table public.products alter column description set default '';
alter table public.products alter column price_suggest_allowed set default false;
alter table public.products alter column condition set default 'good';
alter table public.products alter column status set default 'selling';

alter table public.products drop constraint if exists products_status_check;
alter table public.products add constraint products_status_check
  check (status in ('selling','reserved','sold','deleted'));
alter table public.products drop constraint if exists products_condition_check;
alter table public.products add constraint products_condition_check
  check (condition in ('great','good','broken'));
alter table public.products drop constraint if exists products_usage_period_check;
alter table public.products add constraint products_usage_period_check
  check (usage_period is null or usage_period in ('lt1','1to3','gt3'));

create index if not exists products_status_created_idx on public.products (status, created_at desc);
create index if not exists products_seller_idx on public.products (seller_profile_id);

-- 3) 판매자 공개 정보 (이메일/전화는 노출하지 않음)
create or replace function public.get_public_profiles(p_ids uuid[])
returns table (id uuid, name text, avatar_url text)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.avatar_url from public.profiles p where p.id = any(p_ids);
$$;
grant execute on function public.get_public_profiles(uuid[]) to anon, authenticated;

-- 로그인한 사용자에게만, 판매자가 공개한 경우에만 전화번호 제공
create or replace function public.get_seller_phone(p_product_id uuid)
returns text
language sql stable security definer set search_path = public as $$
  select pr.phone from public.products p
  join public.profiles pr on pr.id = p.seller_profile_id
  where p.id = p_product_id and p.phone_visible and auth.uid() is not null;
$$;
revoke execute on function public.get_seller_phone(uuid) from anon, public;
grant execute on function public.get_seller_phone(uuid) to authenticated;

-- 4) 찜 수 자동 집계
create or replace function public.sync_like_count()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.products set like_count = like_count + 1 where id = new.product_id;
  elsif tg_op = 'DELETE' then
    update public.products set like_count = greatest(like_count - 1, 0) where id = old.product_id;
  end if;
  return null;
end; $$;
drop trigger if exists favorites_like_count on public.favorites;
create trigger favorites_like_count after insert or delete on public.favorites
  for each row execute function public.sync_like_count();

-- 5) 채팅
create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  buyer_id uuid not null references public.profiles(id) on delete cascade,
  seller_id uuid not null references public.profiles(id) on delete cascade,
  last_message text,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  unique (product_id, buyer_id),
  check (buyer_id <> seller_id)
);
create index if not exists chats_buyer_idx on public.chats (buyer_id, last_message_at desc);
create index if not exists chats_seller_idx on public.chats (seller_id, last_message_at desc);

create table if not exists public.messages (
  id bigint generated always as identity primary key,
  chat_id uuid not null references public.chats(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  message text not null check (length(message) between 1 and 2000),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists messages_chat_idx on public.messages (chat_id, created_at);

alter table public.chats enable row level security;
alter table public.messages enable row level security;

drop policy if exists chats_select_member on public.chats;
create policy chats_select_member on public.chats for select to authenticated
  using (auth.uid() in (buyer_id, seller_id));
drop policy if exists chats_insert_buyer on public.chats;
create policy chats_insert_buyer on public.chats for insert to authenticated
  with check (
    buyer_id = auth.uid()
    and exists (select 1 from public.products p where p.id = product_id and p.seller_profile_id = seller_id and p.status <> 'deleted')
  );

drop policy if exists messages_select_member on public.messages;
create policy messages_select_member on public.messages for select to authenticated
  using (exists (select 1 from public.chats c where c.id = chat_id and auth.uid() in (c.buyer_id, c.seller_id)));
drop policy if exists messages_insert_member on public.messages;
create policy messages_insert_member on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and read_at is null
    and exists (select 1 from public.chats c where c.id = chat_id and auth.uid() in (c.buyer_id, c.seller_id))
  );

-- 새 메시지 → 채팅방 마지막 메시지 갱신 + 상품 채팅 수
create or replace function public.on_new_message()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.chats set last_message = left(new.message, 200), last_message_at = new.created_at
  where id = new.chat_id;
  return null;
end; $$;
drop trigger if exists messages_after_insert on public.messages;
create trigger messages_after_insert after insert on public.messages
  for each row execute function public.on_new_message();

create or replace function public.on_new_chat()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.products set inquiry_count = inquiry_count + 1 where id = new.product_id;
  return null;
end; $$;
drop trigger if exists chats_after_insert on public.chats;
create trigger chats_after_insert after insert on public.chats
  for each row execute function public.on_new_chat();

-- 읽음 처리: 상대가 보낸 메시지만
create or replace function public.mark_chat_read(p_chat_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.messages m set read_at = now()
  from public.chats c
  where m.chat_id = p_chat_id and c.id = m.chat_id
    and auth.uid() in (c.buyer_id, c.seller_id)
    and m.sender_id <> auth.uid() and m.read_at is null;
$$;
revoke execute on function public.mark_chat_read(uuid) from anon, public;
grant execute on function public.mark_chat_read(uuid) to authenticated;

-- 실시간
do $$ begin
  begin alter publication supabase_realtime add table public.messages; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.chats; exception when duplicate_object then null; end;
end $$;
alter table public.messages replica identity full;
