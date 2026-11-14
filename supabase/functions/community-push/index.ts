// 이야기 알림 + 자동 검토. DB 트리거가 JWT 없이 부르므로 'Verify JWT' 를 끈다
//   { comment_id } 새 댓글 → 글쓴이에게 웹 푸시 + 댓글 자동 검토
//   { post_id }    새 글   → 글 자동 검토
//   { report_id }  새 신고 → 신고된 글/댓글 자동 검토 + 운영자(app_admins)에게 웹 푸시
//   { deadline_digest: true } 매일 아침 cron → 지원사업 마감 임박 알림 (support_alerts)
//   { invite_promo: true } 매월 1일 cron → 업체 주인에게 친구 초대 보상 안내 (invite_promo_state)
// 자동 검토: 먼저 규칙(욕설·계좌·링크 여러 개·전화번호)에 걸리면 바로 숨김. 아니면 ANTHROPIC_API_KEY 가 있을 때 Claude 가 판단(hide/keep/review)
//   hide 판정이면 바로 숨김(story_record_review). AI 의 hide·review 는 운영자에게 알림, 규칙 숨김은 알림 없음
// 비밀값: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT(채팅 알림과 같음), ANTHROPIC_API_KEY(선택)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import Anthropic from "npm:@anthropic-ai/sdk";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Verdict = { verdict: "hide" | "keep" | "review"; reason: string; reviewer: "ai" | "rule" };

// ---- 자동 검토 ----
const GUIDE = `당신은 산업용품 거래 사이트 '판다산다'의 커뮤니티 '이야기' 검토자입니다.
이야기는 공장·현장·산업 종사자들이 장비 질문, 현장 이야기, 업체 소개, 정보 공유를 하는 곳입니다.
아래 글이 운영 기준을 어기는지 판단해 JSON 으로만 답하세요.

숨김(hide) - 분명하게 해당할 때만:
- 사이트와 관계없는 광고·홍보 도배, 불법 대출·도박·성인 광고, 피싱 링크
- 특정인을 향한 욕설·비하·혐오 표현, 협박
- 돈을 먼저 보내게 하는 등 사기를 유도하는 내용
- 다른 사람의 전화번호·계좌·주소 같은 개인정보를 본인 동의 없이 올린 것
- 음란한 내용

검토 필요(review) - 위반일 수도 있지만 확실하지 않을 때 (예: 본인 업체 홍보인지 정보 공유인지 애매함, 가벼운 비속어, 글쓴이 본인 연락처)
그대로 두기(keep) - 위에 해당하지 않는 평범한 질문·잡담·정보·업체 소개·신고가 부당해 보이는 경우

거친 현장 말투나 불만, 다른 업체·제품에 대한 솔직한 후기는 그 자체로 위반이 아닙니다. 애매하면 hide 대신 review 를 고르세요.
reason 은 운영자가 읽을 한국어 한 문장(60자 이내)으로 쓰세요.`;

const SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["hide", "keep", "review"] },
    reason: { type: "string" },
  },
  required: ["verdict", "reason"],
  additionalProperties: false,
};

async function aiReview(text: string, context: string): Promise<Verdict | null> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return null;
  try {
    const client = new Anthropic({ apiKey: key, maxRetries: 1, timeout: 60_000 });
    // deno-lint-ignore no-explicit-any
    const params: any = {
      model: "claude-opus-5-5",
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default", // 안전 분류기가 거절하면 서버가 다른 모델로 다시 시도
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: GUIDE,
      messages: [{ role: "user", content: `${context}\n\n<글>\n${text.slice(0, 3000)}\n</글>` }],
    };
    const res = await client.beta.messages.create(params);
    if (res.stop_reason === "refusal") return { verdict: "review", reason: "자동 검토가 판단을 거절했어요. 직접 확인해 주세요", reviewer: "ai" };
    // deno-lint-ignore no-explicit-any
    const block = (res.content as any[]).find((b) => b.type === "text");
    if (!block) return null;
    const out = JSON.parse(block.text);
    if (!["hide", "keep", "review"].includes(out.verdict)) return null;
    return { verdict: out.verdict, reason: String(out.reason || "").slice(0, 120), reviewer: "ai" };
  } catch (e) {
    console.error("ai review", (e as Error).message);
    return null;
  }
}

// 규칙 검토: 욕설·계좌번호·링크 여러 개·전화번호가 있으면 바로 숨김 (운영자가 '숨겨진 것'에서 되살릴 수 있음)
const BAD_WORDS = /씨발|시발(?!점)|ㅅㅂ|병신|ㅄ|개새끼|좆|느금|니애미|꺼져/;
function ruleReview(text: string): Verdict {
  const t = String(text || "");
  const links = (t.match(/https?:\/\/|www\.|\.com\b|\.kr\b|open\.kakao|t\.me\//gi) || []).length;
  const phone = /01[016789][- .]?\d{3,4}[- .]?\d{4}/.test(t);
  const account = /(?:^|\D)\d{2,6}-\d{2,6}-\d{2,8}(?:\D|$)/.test(t) && /계좌|입금|송금|은행/.test(t);
  if (BAD_WORDS.test(t)) return { verdict: "hide", reason: "욕설로 보이는 단어가 있어요", reviewer: "rule" };
  if (account) return { verdict: "hide", reason: "계좌번호로 보이는 내용이 있어요", reviewer: "rule" };
  if (links >= 2) return { verdict: "hide", reason: "외부 링크가 여러 개 있어요(광고 의심)", reviewer: "rule" };
  if (phone) return { verdict: "hide", reason: "전화번호가 들어 있어요", reviewer: "rule" };
  return { verdict: "keep", reason: "규칙상 문제 없음", reviewer: "rule" };
}

// 운영자 알림: 사람이 판단해야 할 때만. 규칙으로 숨긴 건 조용히 숨김
const needsAdmin = (v: Verdict) => v.verdict === "review" || (v.verdict === "hide" && v.reviewer === "ai");

async function review(admin: SupabaseClient, kind: "post" | "comment", id: number, text: string, trigger: "new" | "report", context: string) {
  // 규칙에 걸리면 AI 를 부르지 않고 바로 숨김 (비용 없음). 나머지만 AI(키가 있을 때)
  const r = ruleReview(text);
  const v = r.verdict === "hide" ? r : (await aiReview(text, context)) || r;
  await admin.rpc("story_record_review", { p_kind: kind, p_id: id, p_trigger: trigger, p_verdict: v.verdict, p_reason: v.reason, p_reviewer: v.reviewer });
  return v;
}

// ---- 웹 푸시 ----
async function pushTo(admin: SupabaseClient, profileIds: string[], payload: Record<string, unknown>) {
  if (!profileIds.length) return 0;
  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return 0;
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") || "mailto:admin@pandasanda.com", pub, priv);
  const { data: subs } = await admin.from("push_subscriptions").select("id,endpoint,p256dh,auth").in("profile_id", profileIds);
  let sent = 0;
  await Promise.all((subs || []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 60 * 60 * 24 });
      sent++;
      await admin.from("push_subscriptions").update({ last_used_at: new Date().toISOString() }).eq("id", s.id);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await admin.from("push_subscriptions").delete().eq("id", s.id);
      else console.error("push", code, (e as Error).message);
    }
  }));
  return sent;
}

async function adminIds(admin: SupabaseClient) {
  const { data } = await admin.from("app_admins").select("profile_id");
  return (data || []).map((r) => r.profile_id as string);
}

const clip = (s: string, n: number) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
const VERDICT_KO = { hide: "자동으로 숨겼어요", review: "검토가 필요해요", keep: "문제 없어 보여요" };

// 관심 지역·분야 공고가 마감 N일 안으로 들어오면 한 번 알림. 한 사람에게 하루 한 통으로 묶음
const regionLabel = (r: string) => r === "전남광주" ? "광주·전남" : r;
async function deadlineDigest(admin: SupabaseClient) {
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const plus = (n: number) => new Date(Date.parse(today) + n * 86400_000).toISOString().slice(0, 10);
  const { data: alerts } = await admin.from("support_alerts").select("profile_id,regions,fields,days");
  if (!alerts || !alerts.length) return { ok: true, people: 0 };
  const { data: progs } = await admin.from("support_programs").select("id,title,region,category,apply_end")
    .gte("apply_end", today).lte("apply_end", plus(14)).order("apply_end", { ascending: true }).limit(2000);
  let people = 0, pushes = 0;
  for (const a of alerts) {
    const until = plus(a.days || 3);
    const hits = (progs || []).filter((p) =>
      p.apply_end <= until &&
      (!a.regions?.length || p.region === "전국" || a.regions.includes(p.region)) &&
      (!a.fields?.length || a.fields.includes(p.category)));
    if (!hits.length) continue;
    const { data: sent } = await admin.from("support_alert_sent").select("program_id")
      .eq("profile_id", a.profile_id).in("program_id", hits.map((p) => p.id));
    const done = new Set((sent || []).map((x) => x.program_id));
    const fresh = hits.filter((p) => !done.has(p.id));
    if (!fresh.length) continue;
    const first = fresh[0];
    const d = Math.round((Date.parse(first.apply_end) - Date.parse(today)) / 86400_000);
    const where = a.regions?.length === 1 ? regionLabel(a.regions[0]) + " " : "";
    const n = await pushTo(admin, [a.profile_id], {
      title: fresh.length === 1 ? `${where}지원사업 마감 ${d === 0 ? "오늘" : "D-" + d}` : `${where}관심 지원사업 ${fresh.length}건이 곧 마감돼요`,
      body: clip(first.title, 80) + (fresh.length > 1 ? ` 외 ${fresh.length - 1}건` : ""),
      url: fresh.length === 1 ? "/support/" + first.id : (a.regions?.length === 1 ? "/support/area/" + encodeURIComponent(a.regions[0]) : "/support"),
      tag: "support-deadline",
    });
    people++;
    if (n > 0) { // 알림이 실제로 간 사람만 기록 (나중에 알림을 켜면 그때 받도록)
      pushes += n;
      await admin.from("support_alert_sent").insert(fresh.map((p) => ({ profile_id: a.profile_id, program_id: p.id })));
    }
  }
  return { ok: true, people, pushes };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ code: "method_not_allowed" }, 405);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ code: "bad_request" }, 400); }
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const fresh = (iso: string) => Date.now() - new Date(iso).getTime() < 5 * 60 * 1000; // 방금 생긴 것만 (다시 부르기 막기)

  // ---- 지원사업 마감 임박 알림 (매일 아침 cron) ----
  if (b.deadline_digest === true) return json(await deadlineDigest(admin));

  // ---- 친구 초대 홍보 (매월 1일 cron): 아직 초대 0명인 업체 주인에게, 25일에 한 번, '다시 보지 않기' 누른 사람 제외 ----
  if (b.invite_promo === true) {
    const { data: ids } = await admin.rpc("invite_promo_targets");
    let sent = 0;
    for (const id of (ids || []) as string[]) {
      const n = await pushTo(admin, [id], {
        title: "🎁 친구 초대하면 내 업체가 일주일 동안 맨 위에 떠요",
        body: "동료가 내 초대 링크로 가입할 때마다 업체 프리미엄 7일을 드려요 (한 달 4명까지)",
        url: "/my-biz",
        tag: "invite-promo",
      });
      await admin.from("invite_promo_state").upsert({ profile_id: id, last_push_at: new Date().toISOString() });
      sent += n;
    }
    return json({ ok: true, people: (ids || []).length, sent });
  }

  // ---- 새 글: 자동 검토 ----
  if (b.post_id != null) {
    const id = Number(b.post_id);
    const { data: p } = await admin.from("story_posts").select("id,body,status,created_at").eq("id", id).maybeSingle();
    if (!p || p.status !== "active" || !fresh(p.created_at)) return json({ code: "skip" });
    const v = await review(admin, "post", id, p.body, "new", "새로 올라온 글입니다.");
    if (needsAdmin(v)) await pushTo(admin, await adminIds(admin), { title: "이야기 새 글 · " + VERDICT_KO[v.verdict], body: clip(v.reason + " — " + p.body, 110), url: "/community/admin", tag: "story-admin" });
    return json({ ok: true, verdict: v });
  }

  // ---- 새 신고: 자동 검토 + 운영자 알림 ----
  if (b.report_id != null) {
    const { data: r } = await admin.from("story_reports").select("id,post_id,comment_id,reason,created_at").eq("id", Number(b.report_id)).maybeSingle();
    if (!r || !fresh(r.created_at)) return json({ code: "skip" });
    const kind = r.post_id ? "post" : "comment";
    const id = Number(r.post_id || r.comment_id);
    const { data: t } = await admin.from(kind === "post" ? "story_posts" : "story_comments").select("id,body,status").eq("id", id).maybeSingle();
    if (!t) return json({ code: "target_not_found" }, 404);
    // 같은 대상을 최근 1시간 안에 이미 검토했으면 다시 부르지 않음 (신고가 몰려도 비용 한 번)
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recent } = await admin.from("story_moderation").select("verdict,reason,reviewer").eq("target_kind", kind).eq("target_id", id).eq("trigger", "report").gt("created_at", since).order("created_at", { ascending: false }).limit(1);
    const v: Verdict = t.status === "active" && !(recent && recent.length)
      ? await review(admin, kind, id, t.body, "report", `이 ${kind === "post" ? "글" : "댓글"}은 이용자에게 '${r.reason || "기타"}'(으)로 신고됐습니다. 신고가 맞는지 판단하세요.`)
      : (recent && recent[0]) as Verdict || { verdict: "review", reason: "이미 숨겨진 상태예요", reviewer: "rule" };
    const sent = await pushTo(admin, await adminIds(admin), {
      title: `이야기 신고 · ${VERDICT_KO[v.verdict] || "확인해 주세요"}`,
      body: clip(`[${r.reason || "기타"}] ${t.body}`, 110),
      url: "/community/admin",
      tag: "story-admin",
    });
    return json({ ok: true, verdict: v, sent });
  }

  // ---- 새 댓글: 글쓴이 알림 + 자동 검토 ----
  const commentId = Number(b.comment_id);
  if (!Number.isSafeInteger(commentId) || commentId <= 0) return json({ code: "bad_request" }, 400);
  const { data: c } = await admin.from("story_comments").select("id,post_id,author_id,body,created_at,status").eq("id", commentId).maybeSingle();
  if (!c || c.status !== "active") return json({ code: "not_found" }, 404);
  if (!fresh(c.created_at)) return json({ code: "too_old" });

  const v = await review(admin, "comment", c.id, c.body, "new", "새로 달린 댓글입니다.");
  if (needsAdmin(v)) await pushTo(admin, await adminIds(admin), { title: "이야기 새 댓글 · " + VERDICT_KO[v.verdict], body: clip(v.reason + " — " + c.body, 110), url: "/community/admin", tag: "story-admin" });
  if (v.verdict === "hide") return json({ ok: true, sent: 0, reason: "hidden", verdict: v }); // 숨긴 댓글은 글쓴이에게 알리지 않음

  const { data: post } = await admin.from("story_posts").select("id,author_id,status").eq("id", c.post_id).maybeSingle();
  if (!post || post.status !== "active") return json({ code: "post_not_found" }, 404);
  if (post.author_id === c.author_id) return json({ ok: true, sent: 0, reason: "own_post", verdict: v });
  const { error: dup } = await admin.from("story_push_sent").insert({ comment_id: c.id });
  if (dup) return json({ code: "already_sent" });

  const { data: who } = await admin.from("profiles").select("name").eq("id", c.author_id).maybeSingle();
  const sent = await pushTo(admin, [post.author_id], {
    title: "내 이야기에 댓글이 달렸어요",
    body: (who?.name || "이웃") + ": " + clip(c.body, 100),
    url: "/community/" + post.id,
    tag: "community-" + post.id, // 같은 글 알림은 하나로 묶임
  });
  return json({ ok: true, sent, verdict: v });
});
