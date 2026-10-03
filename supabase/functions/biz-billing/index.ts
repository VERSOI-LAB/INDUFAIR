// 업체 프리미엄 정기결제 (토스페이먼츠 자동결제)
//   subscribe: 카드 등록(authKey) → 자동결제 키 발급 → 첫 달 결제 → 프리미엄 켜기        (로그인 필요)
//   cancel:    해지. 이미 결제한 기간 끝까지는 그대로 이용, 다음 청구 없음                (로그인 필요)
//   cron:      청구일이 된 구독 결제 (pg_cron 이 매일 호출). 실패하면 하루 뒤 다시, 3번 실패하면 종료
// 필요한 비밀값: TOSS_SECRET_KEY (자동결제 계약이 된 상점의 시크릿 키, test_sk_... 또는 live_sk_...)
// 배포: verify_jwt 끔 (cron 은 로그인 없이 호출). 로그인이 필요한 동작은 여기서 직접 확인
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const PRICE = 10000;
const ORDER_NAME = "판다산다 업체 프리미엄 (1개월)";
const MAX_FAILS = 3;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const addMonth = (from: Date) => { const d = new Date(from); d.setMonth(d.getMonth() + 1); return d; };
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

async function toss(secret: string, path: string, body: unknown, idem?: string) {
  const res = await fetch("https://api.tosspayments.com" + path, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(secret + ":"),
      "Content-Type": "application/json",
      ...(idem ? { "Idempotency-Key": idem } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

// 자동결제 키로 한 달치 결제
async function charge(admin: SupabaseClient, secret: string, s: {
  id: string | null; business_id: string; owner_id: string; customer_key: string; billing_key: string; amount: number;
}, orderId: string) {
  const r = await toss(secret, "/v1/billing/" + encodeURIComponent(s.billing_key), {
    customerKey: s.customer_key, amount: s.amount, orderId, orderName: ORDER_NAME,
  }, orderId);
  const paid = r.ok && r.data?.status === "DONE";
  const { error } = await admin.from("biz_sub_payments").insert({
    subscription_id: s.id, business_id: s.business_id, owner_id: s.owner_id, order_id: orderId, amount: s.amount,
    status: paid ? "paid" : "failed", payment_key: r.data?.paymentKey || null, message: paid ? null : (r.data?.message || null),
  });
  if (error) console.error("payment log", error.message);
  return { paid, message: r.data?.message as string | undefined };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ code: "method_not_allowed" }, 405);

  const secret = Deno.env.get("TOSS_SECRET_KEY");
  if (!secret) return json({ code: "not_configured" }, 503);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ code: "bad_request" }, 400); }
  const action = typeof b.action === "string" ? b.action : "";

  // ---------- 매일 청구 ----------
  if (action === "cron") {
    const now = new Date();
    const { data: due, error } = await admin.from("biz_subscriptions")
      .select("id,business_id,owner_id,customer_key,billing_key,amount,period_end,fail_count,status")
      .in("status", ["active", "past_due"]).lte("next_charge_at", now.toISOString()).limit(50);
    if (error) return json({ code: "db_error", message: error.message }, 500);
    let paidN = 0, failedN = 0, endedN = 0;
    for (const s of due || []) {
      const { data: biz } = await admin.from("businesses").select("id,status").eq("id", s.business_id).maybeSingle();
      if (!biz || biz.status === "deleted") {
        await admin.from("biz_subscriptions").update({ status: "ended", next_charge_at: null, updated_at: now.toISOString() }).eq("id", s.id);
        endedN++; continue;
      }
      // 같은 청구 회차는 주문번호가 같아서 두 번 결제되지 않음
      const orderId = "bizsub_" + s.id.replace(/-/g, "").slice(0, 12) + "_" + ymd(new Date(s.period_end)) + "_" + s.fail_count;
      const r = await charge(admin, secret, s, orderId);
      if (r.paid) {
        const base = new Date(s.period_end) > now ? new Date(s.period_end) : now;
        const end = addMonth(base);
        await admin.from("biz_subscriptions").update({
          status: "active", period_end: end.toISOString(), next_charge_at: end.toISOString(), fail_count: 0, updated_at: now.toISOString(),
        }).eq("id", s.id);
        await admin.rpc("set_business_premium", { p_business_id: s.business_id, p_until: end.toISOString(), p_bump: true });
        paidN++;
      } else {
        const fails = s.fail_count + 1;
        const over = fails >= MAX_FAILS;
        await admin.from("biz_subscriptions").update({
          status: over ? "ended" : "past_due", fail_count: fails,
          next_charge_at: over ? null : new Date(now.getTime() + 86400_000).toISOString(), updated_at: now.toISOString(),
        }).eq("id", s.id);
        if (over) endedN++; else failedN++;
      }
    }
    return json({ ok: true, paid: paidN, failed: failedN, ended: endedN });
  }

  // ---------- 여기부터 로그인 필요 ----------
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who } = await admin.auth.getUser(token);
  const user = who?.user;
  if (!user) return json({ code: "login_required" }, 401);

  const businessId = typeof b.businessId === "string" ? b.businessId : "";
  if (!businessId) return json({ code: "bad_request" }, 400);
  const { data: biz } = await admin.from("businesses").select("id,owner_id,status").eq("id", businessId).maybeSingle();
  if (!biz || biz.owner_id !== user.id || biz.status === "deleted") return json({ code: "business_not_found" }, 404);
  const { data: sub } = await admin.from("biz_subscriptions")
    .select("id,status,period_end,amount").eq("business_id", businessId).maybeSingle();
  const now = new Date();

  if (action === "cancel") {
    if (!sub || sub.status === "ended" || sub.status === "canceled") return json({ ok: true, already: true });
    await admin.from("biz_subscriptions").update({
      status: "canceled", canceled_at: now.toISOString(), next_charge_at: null, updated_at: now.toISOString(),
    }).eq("id", sub.id);
    return json({ ok: true, period_end: sub.period_end });
  }

  if (action === "subscribe") {
    const authKey = typeof b.authKey === "string" ? b.authKey : "";
    const customerKey = typeof b.customerKey === "string" ? b.customerKey : "";
    // customerKey 는 로그인한 사람의 것이어야 함 (남의 카드 등록 결과를 끼워 넣지 못하게)
    if (!authKey || customerKey !== user.id) return json({ code: "bad_request" }, 400);
    if (sub && sub.status === "active" && new Date(sub.period_end) > now) return json({ ok: true, already: true, period_end: sub.period_end });

    const issued = await toss(secret, "/v1/billing/authorizations/issue", { authKey, customerKey });
    if (!issued.ok || !issued.data?.billingKey) {
      console.error("billing issue", issued.data);
      return json({ code: "card_failed", message: issued.data?.message || null }, 400);
    }
    const billingKey = issued.data.billingKey as string;
    const cardNo = String(issued.data?.card?.number || issued.data?.cardNumber || "");
    const cardLabel = [issued.data?.cardCompany, cardNo.slice(-4).replace(/\D/g, "*")].filter(Boolean).join(" ") || null;

    // 해지했지만 아직 결제한 기간이 남아 있으면 지금은 청구하지 않고 그 끝에서 이어감
    const remaining = sub && new Date(sub.period_end) > now;
    let end = remaining ? new Date(sub!.period_end) : addMonth(now);
    const row = {
      business_id: businessId, owner_id: user.id, status: "active", amount: PRICE, customer_key: customerKey, billing_key: billingKey,
      card_label: cardLabel, period_end: end.toISOString(), next_charge_at: end.toISOString(), fail_count: 0, canceled_at: null,
      updated_at: now.toISOString(),
    };
    if (!remaining) {
      const orderId = "bizsub_" + businessId.replace(/-/g, "").slice(0, 12) + "_" + now.getTime();
      const r = await charge(admin, secret, { id: sub?.id || null, ...row }, orderId);
      if (!r.paid) return json({ code: "charge_failed", message: r.message || null }, 400);
      end = addMonth(now);
      row.period_end = end.toISOString(); row.next_charge_at = end.toISOString();
    }
    const { error } = await admin.from("biz_subscriptions").upsert(row, { onConflict: "business_id" });
    if (error) {
      // 결제는 됐는데 저장이 안 된 경우: 기록(biz_sub_payments)은 남아 있으니 수동 확인
      console.error("subscription save", error.message);
      return json({ code: "save_failed" }, 500);
    }
    await admin.rpc("set_business_premium", { p_business_id: businessId, p_until: end.toISOString(), p_bump: true });
    return json({ ok: true, period_end: end.toISOString(), charged: !remaining });
  }

  return json({ code: "bad_request" }, 400);
});
