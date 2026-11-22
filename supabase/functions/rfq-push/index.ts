// "이거 구해요" 알림. DB 트리거(on_rfq_push)가 JWT 없이 부르므로 'Verify JWT' 를 끈다
//   { rfq_id }   새 요청 → 같은 분류·지역 업체 주인 30명까지 (rfq_targets)
//   { quote_id } 새 견적 → 요청한 사람
// 방금 생긴 것만(5분), 요청 알림은 한 번만(notified_count). 비밀값: VAPID_* (채팅 알림과 같음)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const clip = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
const won = (n: number | null) => n == null ? "" : !n ? "가격 협의" : n >= 10000 && n % 10000 === 0 ? (n / 10000).toLocaleString("ko-KR") + "만 원" : n.toLocaleString("ko-KR") + "원";
const fresh = (iso: string) => Date.now() - new Date(iso).getTime() < 5 * 60_000;

async function pushTo(admin: SupabaseClient, ids: string[], payload: Record<string, unknown>) {
  if (!ids.length) return 0;
  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return 0;
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") || "mailto:admin@pandasanda.com", pub, priv);
  const { data: subs } = await admin.from("push_subscriptions").select("id,endpoint,p256dh,auth").in("profile_id", ids);
  let sent = 0;
  await Promise.all((subs || []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 60 * 60 * 24 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await admin.from("push_subscriptions").delete().eq("id", s.id);
      else console.error("push", code, (e as Error).message);
    }
  }));
  return sent;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ code: "method_not_allowed" }, 405);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ code: "bad_request" }, 400); }
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const UUID = /^[0-9a-f-]{36}$/i;

  if (typeof b.rfq_id === "string" && UUID.test(b.rfq_id)) {
    const { data: r } = await admin.from("rfq_requests").select("id,title,region,category,budget,notified_count,created_at").eq("id", b.rfq_id).maybeSingle();
    if (!r || !fresh(r.created_at)) return json({ code: "skip" });
    // 한 번만: notified_count 를 0 → -1(보내는 중)로 먼저 바꾼 호출만 보냄. 끝나면 받은 업체 수로
    const { data: claimed } = await admin.from("rfq_requests").update({ notified_count: -1 }).eq("id", r.id).eq("notified_count", 0).select("id");
    if (!claimed || !claimed.length) return json({ code: "already_sent" });
    const { data: targets } = await admin.rpc("rfq_targets", { p_id: r.id });
    const ids = ((targets || []) as { owner_id: string }[]).map((t) => t.owner_id);
    const where = String(r.region || "").split(/\s+/).filter((w) => /(시|군|구)$/.test(w)).pop();
    const sent = await pushTo(admin, ids, {
      title: "새 견적 요청 · " + clip(r.title, 30),
      body: [r.category, where, r.budget ? "예산 " + won(r.budget) : ""].filter(Boolean).join(" · ") + " — 견적을 보내 보세요",
      url: "/rfq/" + r.id + "?jm=rfq_new",
      tag: "rfq-" + r.id,
    });
    await admin.from("rfq_requests").update({ notified_count: ids.length }).eq("id", r.id);
    await admin.from("marketing_events").insert({ name: "rfq_notified", path: "/rfq/" + r.id, props: { targets: ids.length, push: sent } });
    return json({ ok: true, targets: ids.length, sent });
  }

  if (typeof b.quote_id === "string" && UUID.test(b.quote_id)) {
    const { data: q } = await admin.from("rfq_quotes").select("id,rfq_id,price,created_at,businesses(name)").eq("id", b.quote_id).maybeSingle();
    if (!q || !fresh(q.created_at)) return json({ code: "skip" });
    const { data: r } = await admin.from("rfq_requests").select("id,title,buyer_id").eq("id", q.rfq_id).maybeSingle();
    if (!r) return json({ code: "not_found" }, 404);
    // deno-lint-ignore no-explicit-any
    const biz = (q as any).businesses?.name || "업체";
    const sent = await pushTo(admin, [r.buyer_id], {
      title: "견적이 도착했어요 · " + clip(r.title, 24),
      body: clip(biz, 20) + (q.price != null ? " · " + won(q.price) : "") + " — 확인하고 채팅으로 이어 가세요",
      url: "/rfq/" + r.id + "?jm=rfq_quote",
      tag: "rfq-quote-" + r.id,
    });
    return json({ ok: true, sent });
  }
  return json({ code: "bad_request" }, 400);
});
