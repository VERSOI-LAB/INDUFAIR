// 이야기 댓글 알림: 새 댓글이 저장되면 DB 트리거(on_story_comment_push)가 { comment_id } 로 호출
// 글쓴이의 모든 브라우저 구독(push_subscriptions)으로 웹 푸시. 같은 댓글은 한 번만(story_push_sent), 내 글에 내가 단 댓글은 보내지 않음
// 비밀값은 chat-push 와 같음: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT. 트리거가 JWT 없이 부르므로 'Verify JWT' 를 끈다
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
  const commentId = Number(b.comment_id);
  if (!Number.isSafeInteger(commentId) || commentId <= 0) return json({ code: "bad_request" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: c } = await admin.from("story_comments")
    .select("id,post_id,author_id,body,created_at,status").eq("id", commentId).maybeSingle();
  if (!c || c.status !== "active") return json({ code: "not_found" }, 404);
  // 방금 저장된 댓글만 (오래된 댓글로 다시 부르는 것 막기)
  if (Date.now() - new Date(c.created_at).getTime() > 5 * 60 * 1000) return json({ code: "too_old" });

  const { data: post } = await admin.from("story_posts").select("id,author_id,body,status").eq("id", c.post_id).maybeSingle();
  if (!post || post.status !== "active") return json({ code: "post_not_found" }, 404);
  if (post.author_id === c.author_id) return json({ ok: true, sent: 0, reason: "own_post" });

  // 한 번만 보냄
  const { error: dup } = await admin.from("story_push_sent").insert({ comment_id: c.id });
  if (dup) return json({ code: "already_sent" });

  const { data: subs } = await admin.from("push_subscriptions").select("id,endpoint,p256dh,auth").eq("profile_id", post.author_id);
  if (!subs || !subs.length) return json({ ok: true, sent: 0 });

  const { data: who } = await admin.from("profiles").select("name").eq("id", c.author_id).maybeSingle();
  const text = String(c.body || "").replace(/\s+/g, " ").trim();
  const payload = JSON.stringify({
    title: "내 이야기에 댓글이 달렸어요",
    body: (who?.name || "이웃") + ": " + (text.length > 100 ? text.slice(0, 100) + "…" : text),
    url: "/community/" + post.id,
    tag: "community-" + post.id, // 같은 글 알림은 하나로 묶임
  });

  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 60 * 60 * 24 });
      sent++;
      await admin.from("push_subscriptions").update({ last_used_at: new Date().toISOString() }).eq("id", s.id);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await admin.from("push_subscriptions").delete().eq("id", s.id);
      else console.error("push", code, (e as Error).message);
    }
  }));
  return json({ ok: true, sent });
});
