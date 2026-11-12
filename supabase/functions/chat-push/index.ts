// 채팅 알림: 새 메시지가 저장되면 DB 트리거(on_message_push)가 { message_id } 로 호출
// 받는 사람의 모든 브라우저 구독(push_subscriptions)으로 웹 푸시를 보냄. 같은 메시지는 한 번만(push_sent)
// 필요한 비밀값: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (예: mailto:you@example.com)
// 트리거가 JWT 없이 부르므로 이 함수는 'Verify JWT' 를 끈다
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ code: "method_not_allowed" }, 405);
  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return json({ code: "not_configured" }, 503);
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") || "mailto:admin@pandasanda.com", pub, priv);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ code: "bad_request" }, 400); }
  const messageId = Number(b.message_id);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return json({ code: "bad_request" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: msg } = await admin.from("messages")
    .select("id,chat_id,sender_id,message,created_at").eq("id", messageId).maybeSingle();
  if (!msg) return json({ code: "not_found" }, 404);
  // 방금 저장된 메시지만 (오래된 메시지로 다시 부르는 것 막기)
  if (Date.now() - new Date(msg.created_at).getTime() > 5 * 60 * 1000) return json({ code: "too_old" });
  // 한 번만 보냄
  const { error: dup } = await admin.from("push_sent").insert({ message_id: msg.id });
  if (dup) return json({ code: "already_sent" });

  const { data: chat } = await admin.from("chats").select("id,buyer_id,seller_id").eq("id", msg.chat_id).maybeSingle();
  if (!chat) return json({ code: "chat_not_found" }, 404);
  const to = msg.sender_id === chat.buyer_id ? chat.seller_id : chat.buyer_id;

  const { data: subs } = await admin.from("push_subscriptions").select("id,endpoint,p256dh,auth").eq("profile_id", to);
  if (!subs || !subs.length) return json({ ok: true, sent: 0 });

  const { data: sender } = await admin.from("profiles").select("name").eq("id", msg.sender_id).maybeSingle();
  const text = String(msg.message || "");
  const payload = JSON.stringify({
    title: (sender?.name || "이웃") + "님의 새 메시지",
    body: text.length > 120 ? text.slice(0, 120) + "…" : text,
    url: "/chat/" + chat.id,
    tag: "chat-" + chat.id, // 같은 채팅방 알림은 하나로 묶임
  });

  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 60 * 60 * 24, urgency: "high" });
      sent++;
      await admin.from("push_subscriptions").update({ last_used_at: new Date().toISOString() }).eq("id", s.id);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // 브라우저가 구독을 끊었으면 지움
      if (code === 404 || code === 410) await admin.from("push_subscriptions").delete().eq("id", s.id);
      else console.error("push", code, (e as Error).message);
    }
  }));
  return json({ ok: true, sent });
});
