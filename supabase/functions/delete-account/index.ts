// 회원 탈퇴: 올린 물건·업체 소개를 내리고, 내 정보를 지운 뒤 계정을 닫는다.
//   - 결제 후 수령 완료·정산이 끝나지 않은 거래가 있으면 탈퇴할 수 없음 (orders_in_progress)
//   - 거래·채팅 기록은 법정 보관 기간 때문에 남기고, 프로필만 '탈퇴한 회원'으로 바꿈
//   - 계정은 soft delete: 다시 로그인할 수 없고, 같은 이메일로 새로 가입할 수 있음
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

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who } = await admin.auth.getUser(token);
  const user = who?.user;
  if (!user) return json({ code: "login_required" }, 401);
  const uid = user.id;

  // 끝나지 않은 거래: 결제됐는데 구매자가 아직 수령 완료를 안 했거나, 판매자 정산이 남은 주문
  const { data: orders, error: oErr } = await admin.from("market_orders")
    .select("id,buyer_id,seller_id,received_at").eq("status", "paid").or(`buyer_id.eq.${uid},seller_id.eq.${uid}`);
  if (oErr) { console.error("orders", oErr); return json({ code: "failed" }, 500); }
  if ((orders || []).some((o) => !o.received_at)) return json({ code: "orders_in_progress" }, 409);
  const { data: pending, error: sErr } = await admin.from("order_settlements")
    .select("id").eq("seller_id", uid).in("status", ["scheduled", "failed"]).limit(1);
  if (sErr) { console.error("settlements", sErr); return json({ code: "failed" }, 500); }
  if (pending && pending.length) return json({ code: "orders_in_progress" }, 409);

  const now = new Date().toISOString();
  const steps: [string, PromiseLike<{ error: unknown }>][] = [
    ["subscriptions", admin.from("biz_subscriptions")
      .update({ status: "ended", next_charge_at: null, billing_key: "", canceled_at: now, updated_at: now })
      .eq("owner_id", uid).in("status", ["active", "past_due", "canceled"])],
    ["products", admin.from("products").update({ status: "deleted" }).eq("seller_profile_id", uid).neq("status", "deleted")],
    ["businesses", admin.from("businesses").update({ status: "deleted" }).eq("owner_id", uid).neq("status", "deleted")],
    ["payout", admin.from("seller_payout_accounts").delete().eq("profile_id", uid)],
    ["verification", admin.from("business_verifications").delete().eq("profile_id", uid)],
    ["addresses", admin.from("addresses").delete().eq("profile_id", uid)],
    ["favorites", admin.from("favorites").delete().eq("profile_id", uid)],
    ["business_likes", admin.from("business_likes").delete().eq("profile_id", uid)],
    ["keyword_alerts", admin.from("keyword_alerts").delete().eq("profile_id", uid)],
    ["notifications", admin.from("notifications").delete().eq("profile_id", uid)],
  ];
  for (const [name, run] of steps) {
    const { error } = await run;
    if (error) { console.error(name, error); return json({ code: "failed", step: name }, 500); }
  }

  const { error: pErr } = await admin.from("profiles").update({
    name: "탈퇴한 회원", phone: null, email: null, avatar_url: null, marketing_opt_in: false,
    status: "withdrawn", withdrawn_at: now,
  }).eq("id", uid);
  if (pErr) { console.error("profile", pErr); return json({ code: "failed", step: "profile" }, 500); }

  // soft delete: auth.users 행은 남겨(거래 기록의 연결 유지) 로그인만 막는다
  const { error: dErr } = await admin.auth.admin.deleteUser(uid, true);
  if (dErr) { console.error("auth", dErr); return json({ code: "failed", step: "auth" }, 500); }

  return json({ ok: true });
});
