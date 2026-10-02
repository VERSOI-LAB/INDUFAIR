// 매일 국세청 상태 재확인: 휴업·폐업·미등록이면 업체 소개 숨김, 다시 계속사업자면 복구
// 공개 정보만 다루므로 로그인 없이 호출 가능(pg_cron), 1시간 안 재실행은 무시
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { bizDigits, bizNoValid, ntsStatus } from "./nts.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* 빈 요청 */ }

  // probe: 번호 1개 상태만 확인(저장 없음) — 키가 동작하는지 점검용
  if (typeof body.probe === "string") {
    const d = bizDigits(body.probe);
    if (!bizNoValid(d)) return json({ probe: d, status: "invalid_number" });
    const st = await ntsStatus([d]);
    return json({ probe: d, status: st ? st[d] : "nts_unavailable" });
  }

  const { data: run } = await admin.from("nts_job_runs").select("last_run_at").eq("id", 1).maybeSingle();
  if (run && Date.now() - new Date(run.last_run_at).getTime() < 3600_000) return json({ skipped: "ran_recently" });
  await admin.from("nts_job_runs").upsert({ id: 1, last_run_at: new Date().toISOString() });

  const { data: rows, error } = await admin.from("business_verifications")
    .select("profile_id,biz_reg_no,nts_status").order("nts_checked_at", { ascending: true, nullsFirst: true }).limit(100);
  if (error || !rows?.length) return json({ checked: 0, error: error?.message });

  const st = await ntsStatus(rows.map((r) => r.biz_reg_no));
  if (!st) return json({ checked: 0, error: "nts_unavailable" });

  let hidden = 0, restored = 0;
  for (const r of rows) {
    const s = st[bizDigits(r.biz_reg_no)];
    if (!s) continue;
    await admin.from("business_verifications").update({ nts_status: s, nts_checked_at: new Date().toISOString() }).eq("profile_id", r.profile_id);
    if (s === "active") {
      const { data } = await admin.rpc("set_business_nts_visibility", { p_owner: r.profile_id, p_hide: false });
      restored += Number(data || 0);
    } else {
      const { data } = await admin.rpc("set_business_nts_visibility", { p_owner: r.profile_id, p_hide: true });
      hidden += Number(data || 0);
    }
  }
  return json({ checked: rows.length, hidden, restored });
});
