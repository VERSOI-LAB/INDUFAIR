// 토스페이먼츠 결제 승인: 결제창 성공 후 paymentKey·orderId·amount 를 받아 금액을 검증하고 승인 요청
// 필요한 비밀값: TOSS_SECRET_KEY (토스페이먼츠 개발자센터의 시크릿 키, test_sk_... 또는 live_sk_...)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ code: "method_not_allowed" }, 405);

  const secret = Deno.env.get("TOSS_SECRET_KEY");
  if (!secret) return json({ code: "not_configured" }, 503);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who } = await admin.auth.getUser(token);
  const user = who?.user;
  if (!user) return json({ code: "login_required" }, 401);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ code: "bad_request" }, 400); }
  const paymentKey = typeof b.paymentKey === "string" ? b.paymentKey : "";
  const orderId = typeof b.orderId === "string" ? b.orderId : "";
  const amount = Number(b.amount);
  if (!paymentKey || !orderId || !Number.isFinite(amount)) return json({ code: "bad_request" }, 400);

  const { data: order } = await admin.from("market_orders")
    .select("id,buyer_id,product_id,total_amount,status").eq("order_no", orderId).maybeSingle();
  if (!order || order.buyer_id !== user.id) return json({ code: "order_not_found" }, 404);
  if (order.status === "paid") return json({ ok: true, already: true });
  if (order.status !== "pending") return json({ code: "order_closed" }, 409);
  // 결제창에서 넘어온 금액이 주문 금액과 다르면 승인하지 않음 (금액 위변조 방지)
  if (order.total_amount !== amount) return json({ code: "amount_mismatch" }, 400);

  const res = await fetch("https://api.tosspayments.com/v1/payments/confirm", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(secret + ":"), "Content-Type": "application/json", "Idempotency-Key": orderId },
    body: JSON.stringify({ paymentKey, orderId, amount }),
  });
  const pay = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("toss confirm", res.status, pay);
    await admin.from("market_orders").update({ status: "failed" }).eq("id", order.id).eq("status", "pending");
    return json({ code: "confirm_failed", message: pay?.message || null }, 400);
  }

  await admin.from("market_orders").update({
    status: "paid", payment_key: paymentKey, payment_method: pay?.method || null, paid_at: pay?.approvedAt || new Date().toISOString(),
  }).eq("id", order.id);
  // 물건 상태는 바꾸지 않음 (소모품처럼 계속 파는 물건이 많아서, 판매자가 판매관리에서 직접 바꿈)
  return json({ ok: true });
});
