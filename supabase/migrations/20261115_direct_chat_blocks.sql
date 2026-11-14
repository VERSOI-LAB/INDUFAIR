-- 이야기에서 사람끼리 바로 채팅 + 사용자 차단
-- 1) user_blocks: 내가 차단한 사람. 서로 어느 쪽이든 차단이면 채팅을 시작·보낼 수 없음
-- 2) chats: 물건·업체 없이 두 사람만 있는 '바로 채팅' 허용 (두 사람 사이에 하나만)
-- 3) start_direct_chat(상대): 있으면 그 방, 없으면 새로 만들어 id 를 돌려줌

-- 1) 차단 ---------------------------------------------------------------------
create table if not exists public.user_blocks (
  blocker_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
alter table public.user_blocks enable row level security;

drop policy if exists user_blocks_select_own on public.user_blocks;
create policy user_blocks_select_own on public.user_blocks for select to authenticated using (blocker_id = auth.uid());
drop policy if exists user_blocks_insert_own on public.user_blocks;
create policy user_blocks_insert_own on public.user_blocks for insert to authenticated with check (blocker_id = auth.uid());
drop policy if exists user_blocks_delete_own on public.user_blocks;
create policy user_blocks_delete_own on public.user_blocks for delete to authenticated using (blocker_id = auth.uid());
grant select, insert, delete on public.user_blocks to authenticated;
grant select on public.user_blocks to service_role;

-- 두 사람 중 누구든 상대를 차단했는지 (상대가 나를 차단한 건 RLS 로 못 보므로 security definer)
create or replace function public.is_blocked_between(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_blocks where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a));
$$;
revoke execute on function public.is_blocked_between(uuid, uuid) from anon, public;
grant execute on function public.is_blocked_between(uuid, uuid) to authenticated, service_role;

-- 2) 바로 채팅 ----------------------------------------------------------------
alter table public.chats drop constraint if exists chats_target_check;
alter table public.chats add constraint chats_target_check check (product_id is null or business_id is null);
create unique index if not exists chats_direct_pair_key on public.chats (least(buyer_id, seller_id), greatest(buyer_id, seller_id))
  where product_id is null and business_id is null;

-- 차단된 사이에서는 메시지를 보낼 수 없음 (물건·업체 채팅 포함)
drop policy if exists messages_insert_member on public.messages;
create policy messages_insert_member on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and read_at is null
    and exists (
      select 1 from public.chats c
      where c.id = chat_id and auth.uid() in (c.buyer_id, c.seller_id)
        and not public.is_blocked_between(c.buyer_id, c.seller_id)
    )
  );

-- 3) 바로 채팅 시작 -----------------------------------------------------------
create or replace function public.start_direct_chat(p_other uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  cid uuid;
begin
  if me is null then return jsonb_build_object('error', 'login'); end if;
  if p_other is null or p_other = me then return jsonb_build_object('error', 'self'); end if;
  if not exists (select 1 from profiles where id = p_other) then return jsonb_build_object('error', 'not_found'); end if;
  if is_blocked_between(me, p_other) then return jsonb_build_object('error', 'blocked'); end if;

  select id into cid from chats
  where product_id is null and business_id is null
    and least(buyer_id, seller_id) = least(me, p_other) and greatest(buyer_id, seller_id) = greatest(me, p_other);
  if cid is null then
    insert into chats (buyer_id, seller_id) values (me, p_other)
    on conflict do nothing returning id into cid;
    if cid is null then -- 동시에 만들어진 경우
      select id into cid from chats
      where product_id is null and business_id is null
        and least(buyer_id, seller_id) = least(me, p_other) and greatest(buyer_id, seller_id) = greatest(me, p_other);
    end if;
  end if;
  return jsonb_build_object('id', cid);
end $$;
revoke execute on function public.start_direct_chat(uuid) from anon, public;
grant execute on function public.start_direct_chat(uuid) to authenticated;

-- 물건 채팅 수 트리거: 바로 채팅은 물건이 없으니 아무것도 안 함 (기존 update 는 product_id null 이면 0건)
