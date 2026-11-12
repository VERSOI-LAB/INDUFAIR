-- 채팅 알림 (웹 푸시)
--   새 메시지 → 트리거가 Edge Function chat-push 호출 → 받는 사람의 브라우저(휴대폰·PC)로 푸시
--   Edge Function 비밀값: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT(mailto:...)
--   chat-push 는 트리거가 JWT 없이 부르므로 'Verify JWT' 를 끈다. 같은 메시지는 한 번만 보냄(push_sent)

-- 1) 브라우저별 푸시 구독 (본인만 읽고 씀)
create table if not exists public.push_subscriptions (
  id bigint generated always as identity primary key,
  profile_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  endpoint text not null unique check (endpoint like 'https://%' and length(endpoint) <= 1000),
  p256dh text not null check (length(p256dh) <= 200),
  auth text not null check (length(auth) <= 100),
  user_agent text check (user_agent is null or length(user_agent) <= 300),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists push_subscriptions_profile_idx on public.push_subscriptions (profile_id);
alter table public.push_subscriptions enable row level security;
drop policy if exists push_subscriptions_owner on public.push_subscriptions;
create policy push_subscriptions_owner on public.push_subscriptions for all to authenticated
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());
revoke all on public.push_subscriptions from anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant select, update, delete on public.push_subscriptions to service_role;

-- 같은 브라우저(endpoint)를 다른 계정으로 다시 구독하면 그 계정으로 옮김
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text)
returns text language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return 'login_required'; end if;
  if p_endpoint is null or p_endpoint not like 'https://%' or length(p_endpoint) > 1000
     or coalesce(length(p_p256dh), 0) not between 1 and 200 or coalesce(length(p_auth), 0) not between 1 and 100 then return 'bad_input'; end if;
  insert into push_subscriptions (profile_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update set profile_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth,
    user_agent = excluded.user_agent, created_at = now();
  return 'ok';
end $$;
revoke execute on function public.save_push_subscription(text, text, text, text) from anon, public;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;

-- 2) 보낸 메시지 기록 (같은 메시지 중복 발송 방지)
create table if not exists public.push_sent (
  message_id bigint primary key references public.messages(id) on delete cascade,
  sent_at timestamptz not null default now()
);
alter table public.push_sent enable row level security;
revoke all on public.push_sent from anon, authenticated;
grant select, insert on public.push_sent to service_role;
grant select on public.messages, public.chats to service_role;

-- 3) 새 메시지 → chat-push 호출 (pg_net, 비동기라 메시지 저장을 늦추지 않음)
create or replace function public.on_message_push()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://rqjfergjfhcrcuvfuhkm.supabase.co/functions/v1/chat-push',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('message_id', new.id)
  );
  return null;
exception when others then
  return null; -- 알림이 실패해도 메시지는 저장
end $$;
drop trigger if exists messages_push on public.messages;
create trigger messages_push after insert on public.messages
  for each row execute function public.on_message_push();
