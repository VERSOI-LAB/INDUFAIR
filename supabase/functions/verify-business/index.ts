// 사업자 인증: 번호 검증식 + 국세청 상태조회(계속사업자만) → business_verifications 저장
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { bizDigits, bizFormat, bizNoValid, ntsStatus } from "./nts.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : null);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ code: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who } = await admin.auth.getUser(token);
  const user = who?.user;
  if (!user) return json({ code: "login_required" }, 401);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ code: "bad_request" }, 400); }

  const company = clip(b.company_name, 100);
  const regno = bizDigits(String(b.biz_reg_no || ""));
  if (!company) return json({ code: "name_required" });
  if (!bizNoValid(regno)) return json({ code: "invalid_number" });
  const fmt = bizFormat(regno);

  const { data: used } = await admin.from("business_verifications").select("profile_id").eq("biz_reg_no", fmt).neq("profile_id", user.id).maybeSingle();
  if (used) return json({ code: "already_used" });

  // 국세청: 계속사업자만 통과. 응답이 없으면(장애·키 활성화 전) 일단 'pending' 으로 두고 정기 확인에서 다시 본다
  const st = await ntsStatus([regno]);
  const nts = st ? st[regno] : null;
  if (nts === "suspended" || nts === "closed" || nts === "unregistered") return json({ code: nts });

  const certPath = clip(b.cert_path, 300);
  const row = {
    profile_id: user.id,
    company_name: company,
    ceo_name: clip(b.ceo_name, 50),
    biz_reg_no: fmt,
    biz_type: clip(b.biz_type, 60),
    biz_item: clip(b.biz_item, 60),
    address: clip(b.address, 200),
    cert_path: certPath && certPath.startsWith(user.id + "/") ? certPath : null,
    verified_at: new Date().toISOString(),
    nts_status: nts === "active" ? "active" : "pending",
    nts_checked_at: nts ? new Date().toISOString() : null,
  };
  const { error } = await admin.from("business_verifications").upsert(row, { onConflict: "profile_id" });
  if (error) {
    console.error("save verification", error);
    return json({ code: "save_failed" }, 500);
  }
  return json({ code: "ok", nts_status: row.nts_status, company_name: company, biz_reg_no: fmt });
});
