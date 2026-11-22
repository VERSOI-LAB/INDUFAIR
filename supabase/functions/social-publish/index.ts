// 인스타그램·스레드 자동 발행 (여러 장 슬라이드). cron 이 매주 월요일 한국시간 10:00 에 { run: true } 로 부른다 (Verify JWT 끔)
//   슬라이드 목록·캡션: https://www.pandasanda.com/social/weekly.json, 이미지: /social/weekly/1.jpg … (api/social.js, api/_social.js)
//   2장 이상이면 캐러셀, 1장이면 한 장 게시. 올리는 데 시간이 걸려 요청은 바로 202 로 답하고 뒤에서 처리 (결과는 social_posts)
//   { run: true }                         월요일이면 이번 주 게시물을 올림 (같은 주·같은 곳은 한 번만, 실패한 주는 다시 시도)
//   { dry_run: true }                     올릴 이미지 주소·캡션만 돌려줌 (운영자만)
//   { run: true, force: true, only? }     요일·중복 상관없이 지금 올림 (운영자만, only: "instagram" | "threads")
//   운영자 = Authorization: Bearer <service_role 키>
// 비밀값: INSTAGRAM_ACCESS_TOKEN, THREADS_ACCESS_TOKEN — 둘 중 있는 것만 올림
//   인스타 토큰은 두 방식 모두 됨 (앞글자로 구분):
//     · 통합 로그인(Facebook 로그인, 새 앱의 기본) — 시스템 사용자 토큰(EAA…, 만료 없음) → graph.facebook.com.
//       인스타 계정 id 는 INSTAGRAM_USER_ID 비밀값, 없으면 연결된 페이지에서 찾음
//     · 인스타그램 로그인(IG…, 60일) → graph.instagram.com, 30일마다 자동 갱신
//   스레드 토큰(60일)은 30일마다 자동 갱신. 갱신한 토큰은 social_accounts 에 저장
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const SITE = "https://www.pandasanda.com";
const IG = "https://graph.instagram.com";
const FB = "https://graph.facebook.com";
const TH = "https://graph.threads.net/v1.0";
const REFRESH_AFTER_DAYS = 30;  // 장기 토큰은 60일. 반쯤 지나면 갱신

type Platform = "instagram" | "threads";
type Manifest = { week: { mon: string; label: string }; slides: string[]; captions: { instagram: string; threads: string } };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 에러 문구에 토큰이 섞이지 않게
const safe = (s: unknown) => String(s ?? "").replace(/access_token=[^&\s"]+/g, "access_token=***").slice(0, 480);

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

// 미디어 컨테이너 하나 만들기 (준비될 때까지 기다림)
async function container(base: string, userId: string, edge: string, params: Record<string, string>, token: string) {
  const c = await post(`${base}/${userId}/${edge}`, { ...params, access_token: token });
  await waitReady(base, c.id, token);
  return c.id as string;
}

async function publish(p: Platform, acc: { token: string; userId: string; host: string }, images: string[], caption: string) {
  const ig = p === "instagram";
  const base = ig ? acc.host : TH, edge = ig ? "media" : "threads", text = ig ? "caption" : "text";
  let id: string;
  if (images.length === 1) {
    id = await container(base, acc.userId, edge, { ...(ig ? {} : { media_type: "IMAGE" }), image_url: images[0], [text]: caption }, acc.token);
  } else { // 캐러셀: 장마다 컨테이너 → 묶음 컨테이너
    const children: string[] = [];
    for (const url of images.slice(0, 10)) {
      children.push(await container(base, acc.userId, edge, { ...(ig ? {} : { media_type: "IMAGE" }), image_url: url, is_carousel_item: "true" }, acc.token));
    }
    id = await container(base, acc.userId, edge, { media_type: "CAROUSEL", children: children.join(","), [text]: caption }, acc.token);
  }
  const m = await post(`${base}/${acc.userId}/${ig ? "media_publish" : "threads_publish"}`, { creation_id: id, access_token: acc.token });
  return m.id as string;
}

async function run(admin: SupabaseClient, m: Manifest, images: string[], only: string | null, force: boolean) {
  const result: Record<string, unknown> = {};
  for (const p of ["instagram", "threads"] as Platform[]) {
    if (only && only !== p) continue;
    let acc;
    try { acc = await account(admin, p); } catch (e) { result[p] = { status: "failed", error: safe((e as Error).message) }; continue; }
    if (!acc) { result[p] = { status: "not_configured" }; continue; }
    // 같은 주 한 번만: 기록을 먼저 잡음 (실패했던 주는 다시)
    const { error: dup } = await admin.from("social_posts").insert({ platform: p, week: m.week.mon });
    if (dup) {
      const { data: prev } = await admin.from("social_posts").select("status,updated_at").eq("platform", p).eq("week", m.week.mon).maybeSingle();
      if (prev?.status === "published" && !force) { result[p] = { status: "already_posted" }; continue; }
      // 진행 중 표시가 10분 넘게 남아 있으면 멈춘 것으로 보고 다시
      if (prev?.status === "pending" && !force && Date.now() - Date.parse(prev.updated_at) < 10 * 60_000) { result[p] = { status: "in_progress" }; continue; }
      await admin.from("social_posts").update({ status: "pending", error: null, updated_at: new Date().toISOString() }).eq("platform", p).eq("week", m.week.mon);
    }
    try {
      const id = await publish(p, acc, images, p === "instagram" ? m.captions.instagram : m.captions.threads);
      await admin.from("social_posts").update({ status: "published", media_id: id, updated_at: new Date().toISOString() }).eq("platform", p).eq("week", m.week.mon);
      await admin.from("marketing_events").insert({ name: "social_published", path: "/social/weekly", props: { platform: p, week: m.week.mon, slides: images.length } });
      result[p] = { status: "published", media_id: id };
    } catch (e) {
      const msg = safe((e as Error).message);
      await admin.from("social_posts").update({ status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("platform", p).eq("week", m.week.mon);
      console.error("publish", p, msg);
      result[p] = { status: "failed", error: msg };
    }
  }
  console.log("social-publish", m.week.mon, JSON.stringify(result));
  return result;
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
  // 목록과 이미지를 같은 v 로 맞춰서 (그사이 공고가 바뀌어도 장수·내용이 어긋나지 않게)
  const v = Date.now().toString(36);
  const m: Manifest | null = await fetch(`${SITE}/social/weekly.json?v=${v}`).then((r) => r.ok ? r.json() : null).catch(() => null);
  if (!m || !m.slides?.length) return json({ code: "manifest_failed" }, 502);
  const images = m.slides.map((_, i) => `${SITE}/social/weekly/${i + 1}.jpg?v=${v}`);
  if (dry) return json({ ok: true, dry_run: true, week: m.week, slides: m.slides, images, captions: m.captions, configured: { instagram: !!Deno.env.get("INSTAGRAM_ACCESS_TOKEN"), threads: !!Deno.env.get("THREADS_ACCESS_TOKEN") } });

  // 첫 장이 실제로 열리는지 먼저 (인스타는 JPEG 만). 이때 그려 둔 것이 캐시돼서 Meta 가 빨리 가져감
  const first = await fetch(images[0]).catch(() => null);
  if (!first || !first.ok || !(first.headers.get("content-type") || "").includes("image/jpeg")) return json({ code: "image_failed", status: first?.status }, 502);
  await first.arrayBuffer().catch(() => {});
  await Promise.all(images.slice(1).map((u) => fetch(u).then((r) => r.arrayBuffer()).catch(() => null))); // 나머지도 미리 그려 둠

  const only = typeof b.only === "string" ? b.only : null;
  // 여러 장 올리는 데 1~2분 걸릴 수 있어 바로 답하고 뒤에서 처리 (cron 의 요청 시간 제한에 걸리지 않게)
  const job = run(admin, m, images, only, force);
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) { rt.waitUntil(job); return json({ ok: true, accepted: true, week: m.week.mon, slides: m.slides.length }, 202); }
  return json({ ok: true, week: m.week.mon, result: await job });
});
