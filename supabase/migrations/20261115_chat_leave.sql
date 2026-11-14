-- 채팅방 나가기 (목록에서 왼쪽으로 밀어서 '나가기')
-- 나간 사람에게는 목록에서 사라지고, 나가기 전 메시지는 다시 보이지 않음.
-- 상대가 새 메시지를 보내면 그 메시지부터 다시 목록에 나타남. 상대 화면에는 '상대방이 나갔어요' 표시.
alter table public.chats add column if not exists buyer_left_at timestamptz;
alter table public.chats add column if not exists seller_left_at timestamptz;

create or replace function public.leave_chat(p_chat_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); c record;
begin
  if me is null then return 'login'; end if;
  select id, buyer_id, seller_id into c from chats where id = p_chat_id;
  if c.id is null or me not in (c.buyer_id, c.seller_id) then return 'not_found'; end if;
  if me = c.buyer_id then update chats set buyer_left_at = now() where id = c.id;
  else update chats set seller_left_at = now() where id = c.id; end if;
  -- 남은 안 읽은 메시지는 읽은 것으로 (안 읽음 숫자에 남지 않게)
  update messages set read_at = now() where chat_id = c.id and sender_id <> me and read_at is null;
  return 'ok';
end $$;
revoke execute on function public.leave_chat(uuid) from anon, public;
grant execute on function public.leave_chat(uuid) to authenticated;
