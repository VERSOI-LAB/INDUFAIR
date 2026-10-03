// 주문 취소 (전액 환불): 토스페이먼츠 결제 취소 후 주문을 '취소됨'으로
//   구매자: 판매자가 발송하기 전에만 바로 취소 (발송 뒤에는 request_order_cancel 로 요청)
//   판매자: 결제된 주문은 언제든 취소 가능. 사유 필수 (구매자의 취소 요청에 동의하는 경우는 그 사유를 그대로 씀)
// 필요한 비밀값: TOSS_SECRET_KEY
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
  const orderId = typeof b.orderId === "string" ? b.orderId : "";
  let reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 500) : "";
  if (!orderId) return json({ code: "bad_request" }, 400);

  const { data: o } = await admin.from("market_orders")
    .select("id,order_no,buyer_id,seller_id,status,payment_key,shipped_at,cancel_request_status,cancel_request_reason")
    .eq("id", orderId).maybeSingle();
  if (!o || (o.buyer_id !== user.id && o.seller_id !== user.id)) return json({ code: "order_not_found" }, 404);
  if (o.status === "canceled") return json({ ok: true, already: true });
  if (o.status !== "paid" || !o.payment_key) return json({ code: "not_paid" }, 409);

  const by = o.seller_id === user.id ? "seller" : "buyer";
  if (by === "buyer" && o.shipped_at) return json({ code: "already_shipped" }, 409); // 발송 뒤에는 판매자 동의가 필요
  // 판매자가 구매자의 취소 요청에 동의하는 경우: 사유를 따로 안 쓰면 구매자의 요청 사유를 남김
  if (by === "seller" && !reason && o.cancel_request_status === "requested") {
    reason = "구매자 요청에 동의: " + (o.cancel_request_reason || "");
  }
  if (!reason) return json({ code: "reason_required" }, 400);

  // 전액 환불 (같은 주문은 한 번만)
  const res = await fetch("https://api.tosspayments.com/v1/payments/" + encodeURIComponent(o.payment_key) + "/cancel", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(secret + ":"), "Content-Type": "application/json", "Idempotency-Key": "cancel_" + o.order_no },
    body: JSON.stringify({ cancelReason: reason.slice(0, 200) }),
  });
  const pay = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("toss cancel", res.status, pay);
    return json({ code: "cancel_failed", message: pay?.message || null }, 400);
  }

  const { error } = await admin.from("market_orders").update({
    status: "canceled", canceled_at: new Date().toISOString(), canceled_by: by, cancel_reason: reason,
  }).eq("id", o.id).eq("status", "paid");
  if (error) {
    // 환불은 됐는데 저장이 안 된 경우: 다시 호출하면 토스가 같은 요청으로 처리(멱등)하고 여기서 다시 저장
    console.error("order cancel save", error.message);
    return json({ code: "save_failed" }, 500);
  }
  return json({ ok: true, by });
});
