// 인스타그램·스레드 자동 발행. cron 이 매주 월요일 한국시간 10:00 에 { run: true } 로 부른다 (Verify JWT 끔)
//   { run: true }                         월요일이면 이번 주 카드를 올림 (같은 주·같은 곳은 한 번만, 실패한 주는 다시 시도)
//   { dry_run: true }                     올릴 이미지 주소·캡션만 돌려줌 (운영자만)
//   { run: true, force: true, only? }     요일·중복 상관없이 지금 올림 (운영자만, only: "instagram" | "threads")
//   운영자 = Authorization: Bearer <service_role 키>
// 비밀값: INSTAGRAM_ACCESS_TOKEN, THREADS_ACCESS_TOKEN — 둘 중 있는 것만 올림
//   인스타 토큰은 두 방식 모두 됨 (앞글자로 구분):
//     · 통합 로그인(Facebook 로그인, 새 앱의 기본) — 시스템 사용자 토큰(EAA…, 만료 없음) → graph.facebook.com.
//       인스타 계정 id 는 INSTAGRAM_USER_ID 비밀값, 없으면 연결된 페이지에서 찾음
//     · 인스타그램 로그인(IG…, 60일) → graph.instagram.com, 30일마다 자동 갱신
//   스레드 토큰(60일)은 30일마다 자동 갱신. 갱신한 토큰은 social_accounts 에 저장
// 이미지: https://www.pandasanda.com/support/weekly.jpg (api/weekly-image.js, 1080×1350 JPEG)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const SITE = "https://www.pandasanda.com";
const IG = "https://graph.instagram.com";
const FB = "https://graph.facebook.com";
const TH = "https://graph.threads.net/v1.0";
const REFRESH_AFTER_DAYS = 30;  // 장기 토큰은 60일. 반쯤 지나면 갱신
const HASHTAGS = "#정부지원사업 #지원사업 #중소기업 #소상공인 #제조업 #스마트공장 #창업지원 #판다산다";

type Platform = "instagram" | "threads";
type Weekly = { today: string; week: { mon: string; label: string; range: string }; closing: Prog[]; fresh: Prog[] };
type Prog = { id: number; title: string; agency?: string; category?: string; region?: string; apply_end?: string | null };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clip = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + "…" : s;
const dday = (p: Prog, today: string) => {
  if (!p.apply_end) return "상시";
  const n = Math.round((Date.parse(p.apply_end) - Date.parse(today)) / 86400_000);
  return n === 0 ? "오늘 마감" : "D-" + n;
};
// 에러 문구에 토큰이 섞이지 않게
const safe = (s: unknown) => String(s ?? "").replace(/access_token=[^&\s"]+/g, "access_token=***").slice(0, 480);

function captions(d: Weekly) {
  const utm = (src: string) => `?utm_source=${src}&utm_medium=social&utm_campaign=weekly_${d.week.mon}`;
  const lines = (n: number) => d.closing.slice(0, n).map((p) => `· [${dday(p, d.today)}] ${p.title}`);
  const head = `📢 ${d.week.label} 마감 임박 정부지원사업 ${d.closing.length}건\n${d.week.range} 마감 공고를 모았어요.`;
  // 인스타: 캡션 링크는 눌리지 않으므로 "프로필 링크" 안내 (2,200자까지)
  const instagram = [head, "", ...lines(8), d.closing.length > 8 ? `외 ${d.closing.length - 8}건` : "",
    "", "전체 목록과 우리 회사 맞춤 공고 30초 진단은 프로필 링크 👉 판다산다", "", HASHTAGS].filter((x, i, a) => x !== "" || a[i - 1] !== "").join("\n");
  // 스레드: 500자까지, 링크가 눌림
  const tail = `\n\n전체 보기 👉 ${SITE}/support/weekly${utm("threads")}`;
  let body = head + "\n\n";
  for (const l of lines(8)) { if ((body + l + "\n").length + tail.length + 12 > 500) break; body += l + "\n"; }
  const shown = body.split("\n· ").length - 1;
  if (d.closing.length > shown) body += `외 ${d.closing.length - shown}건`;
  const threads = clip(body.trimEnd() + tail, 500);
  return { instagram: clip(instagram, 2200), threads };
}

// ---- 토큰 ----
async function account(admin: SupabaseClient, p: Platform) {
  const { data: row } = await admin.from("social_accounts").select("*").eq("platform", p).maybeSingle();
  let token: string | null = row?.access_token || null;
  let refreshedAt: string | null = row?.token_refreshed_at || null;
  let userId: string | null = row?.user_id || null;
  if (!token) { // 처음: 비밀값에서
    token = Deno.env.get(p === "instagram" ? "INSTAGRAM_ACCESS_TOKEN" : "THREADS_ACCESS_TOKEN") || null;
    if (!token) return null;
    refreshedAt = new Date().toISOString();
  }
  // 인스타 토큰 종류: IG… = 인스타그램 로그인(graph.instagram.com), 그 밖(EAA… 시스템 사용자 등) = 통합 로그인(graph.facebook.com, 만료 없음)
  const fb = p === "instagram" && !token.startsWith("IG");
  const host = p === "threads" ? TH : fb ? FB : IG;
  // 30일 지나면 갱신 (실패하면 쓰던 토큰으로 계속). 시스템 사용자 토큰은 만료가 없어 갱신하지 않음
  if (!fb && refreshedAt && Date.now() - Date.parse(refreshedAt) > REFRESH_AFTER_DAYS * 86400_000) {
    const url = p === "instagram"
      ? `${IG}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`
      : `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(token)}`;
    const r = await fetch(url).then((x) => x.json()).catch(() => null);
    if (r?.access_token) { token = r.access_token; refreshedAt = new Date().toISOString(); }
    else console.error("token refresh", p, safe(JSON.stringify(r)));
  }
  if (fb) userId = Deno.env.get("INSTAGRAM_USER_ID") || userId;
  if (!userId) {
    let me;
    if (fb) { // 통합 로그인: 토큰이 볼 수 있는 페이지에 연결된 인스타 비즈니스 계정
      me = await fetch(`${FB}/me/accounts?fields=instagram_business_account{id,username}&access_token=${encodeURIComponent(token!)}`).then((x) => x.json()).catch(() => null);
      userId = (me?.data || []).map((a: { instagram_business_account?: { id: string } }) => a.instagram_business_account?.id).find(Boolean) || null;
    } else {
      me = await fetch(p === "instagram" ? `${IG}/me?fields=user_id,username&access_token=${encodeURIComponent(token!)}` : `${TH}/me?fields=id,username&access_token=${encodeURIComponent(token!)}`)
        .then((x) => x.json()).catch(() => null);
      userId = (p === "instagram" ? me?.user_id || me?.id : me?.id) || null;
    }
    if (!userId) throw new Error("계정 확인 실패" + (fb ? " (INSTAGRAM_USER_ID 비밀값에 인스타 계정 id 를 넣어 주세요)" : "") + ": " + safe(JSON.stringify(me?.error || me)));
  }
  await admin.from("social_accounts").upsert({ platform: p, user_id: userId, access_token: token, token_refreshed_at: refreshedAt, updated_at: new Date().toISOString() });
  return { token: token!, userId, host };
}

async function post(url: string, params: Record<string, string>) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(safe(d.error?.message || JSON.stringify(d)));
  return d;
}
// 컨테이너가 준비될 때까지 (최대 ~40초)
async function waitReady(base: string, id: string, token: string) {
  for (let i = 0; i < 8; i++) {
    const s = await fetch(`${base}/${id}?fields=status_code,status&access_token=${encodeURIComponent(token)}`).then((x) => x.json()).catch(() => ({}));
    const st = s.status_code || s.status;
    if (st === "FINISHED" || st === "PUBLISHED") return;
    if (st === "ERROR" || st === "EXPIRED") throw new Error("미디어 준비 실패: " + safe(JSON.stringify(s)));
    await sleep(5000);
  }
}

async function publish(p: Platform, acc: { token: string; userId: string; host: string }, imageUrl: string, caption: string) {
  if (p === "instagram") { // graph.instagram.com 또는 graph.facebook.com — 경로는 같음
    const c = await post(`${acc.host}/${acc.userId}/media`, { image_url: imageUrl, caption, access_token: acc.token });
    await waitReady(acc.host, c.id, acc.token);
    const m = await post(`${acc.host}/${acc.userId}/media_publish`, { creation_id: c.id, access_token: acc.token });
    return m.id as string;
  }
  const c = await post(`${TH}/${acc.userId}/threads`, { media_type: "IMAGE", image_url: imageUrl, text: caption, access_token: acc.token });
  await waitReady(TH, c.id, acc.token);
  const m = await post(`${TH}/${acc.userId}/threads_publish`, { creation_id: c.id, access_token: acc.token });
  return m.id as string;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ code: "method_not_allowed" }, 405);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ code: "bad_request" }, 400); }
  const dry = b.dry_run === true, force = b.force === true;
  if (!dry && b.run !== true) return json({ code: "bad_request" }, 400);
  const isAdmin = (req.headers.get("Authorization") || "") === "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if ((dry || force || b.only) && !isAdmin) return json({ code: "forbidden" }, 403);
  const kst = new Date(Date.now() + 9 * 3600_000);
  if (!dry && !force && kst.getUTCDay() !== 1) return json({ code: "not_monday" });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const d: Weekly | null = await fetch(`${SITE}/support/weekly.json`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null);
  if (!d) return json({ code: "weekly_data_failed" }, 502);
  if (!d.closing.length) return json({ code: "nothing_closing" });
  const imageUrl = `${SITE}/support/weekly.jpg?v=${d.week.mon}`;
  const cap = captions(d);
  if (dry) return json({ ok: true, dry_run: true, image_url: imageUrl, captions: cap, configured: { instagram: !!Deno.env.get("INSTAGRAM_ACCESS_TOKEN"), threads: !!Deno.env.get("THREADS_ACCESS_TOKEN") } });

  // 이미지가 실제로 열리는지 먼저 (인스타는 JPEG 만)
  const head = await fetch(imageUrl).catch(() => null);
  if (!head || !head.ok || !(head.headers.get("content-type") || "").includes("image/jpeg")) return json({ code: "image_failed", status: head?.status }, 502);
  await head.arrayBuffer().catch(() => {});

  const result: Record<string, unknown> = {};
  for (const p of ["instagram", "threads"] as Platform[]) {
    if (typeof b.only === "string" && b.only !== p) continue;
    let acc;
    try { acc = await account(admin, p); } catch (e) { result[p] = { status: "failed", error: safe((e as Error).message) }; continue; }
    if (!acc) { result[p] = { status: "not_configured" }; continue; }
    // 같은 주 한 번만: 기록을 먼저 잡음 (실패했던 주는 다시)
    const { error: dup } = await admin.from("social_posts").insert({ platform: p, week: d.week.mon });
    if (dup) {
      const { data: prev } = await admin.from("social_posts").select("status").eq("platform", p).eq("week", d.week.mon).maybeSingle();
      if (prev?.status === "published" && !force) { result[p] = { status: "already_posted" }; continue; }
      if (prev?.status === "pending" && !force) { result[p] = { status: "in_progress" }; continue; }
      await admin.from("social_posts").update({ status: "pending", error: null, updated_at: new Date().toISOString() }).eq("platform", p).eq("week", d.week.mon);
    }
    try {
      const id = await publish(p, acc, imageUrl, p === "instagram" ? cap.instagram : cap.threads);
      await admin.from("social_posts").update({ status: "published", media_id: id, updated_at: new Date().toISOString() }).eq("platform", p).eq("week", d.week.mon);
      await admin.from("marketing_events").insert({ name: "social_published", path: "/support/weekly", props: { platform: p, week: d.week.mon, closing: d.closing.length } });
      result[p] = { status: "published", media_id: id };
    } catch (e) {
      const msg = safe((e as Error).message);
      await admin.from("social_posts").update({ status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("platform", p).eq("week", d.week.mon);
      console.error("publish", p, msg);
      result[p] = { status: "failed", error: msg };
    }
  }
  return json({ ok: true, week: d.week.mon, result });
});
