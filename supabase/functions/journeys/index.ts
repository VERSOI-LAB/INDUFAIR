// 행동별 자동 메시지: 웹 푸시 + 이메일. cron 이 매일 한국시간 10:30 에 { run: true } 로 부른다 (Verify JWT 끔)
//   { run: true }                      실제로 보냄
//   { dry_run: true, only?: "biz_weekly" }  누구에게 무엇이 갈지 목록만 돌려줌 (보내지 않음, 기록 안 함)
//   dry_run·only 는 운영자만 (Authorization: Bearer <service_role 키>). 실제 발송은 08~21시에만, 30분 안 재실행은 무시
// 비밀값: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (채팅 알림과 같음)
//         RESEND_API_KEY(선택: 없으면 이메일 없이 푸시만), EMAIL_FROM(예: 판다산다 <noreply@pandasanda.com>, Resend 에서 도메인 인증)
// 규칙: supabase/migrations/20261122_journeys.sql 맨 위 설명
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SITE = "https://www.pandasanda.com";
const SENDER = "베르소이(VERSOI) · 판다산다 · 경기도 성남시 수정구 창업로 18, 876호 · 고객센터 010-5616-8835";
const DAY_CAP = 1;            // 한 사람에게 하루 최대 (법정 안내 제외)
const WEEK_CAP = 3;           // 7일 최대
const EMAIL_MAX_PER_RUN = 150; // Resend 기본 초당 2건 제한 + 함수 실행 시간 안에서
const EMAIL_GAP_MS = 600;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const clip = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const won = (n: number) => !n ? "가격 협의" : n >= 10000 && n % 10000 === 0 ? (n / 10000).toLocaleString("ko-KR") + "만 원" : n.toLocaleString("ko-KR") + "원";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const regionLabel = (r: string) => r === "전남광주" ? "광주·전남" : r;

type Kind = "info" | "ads" | "legal";
type Cand = { profile_id: string; ref: string; email: string | null; ads_push: boolean; ads_email: boolean; info_email: boolean; data: Record<string, any> };
type Msg = { title: string; body: string; path: string; cta: string; email?: boolean } | null;
type Journey = { key: string; kind: Kind; mondayOnly?: boolean; build: (d: Record<string, any>) => Msg };

// 우선순위 순서 (하루 1통이면 위에 있는 것이 먼저)
const JOURNEYS: Journey[] = [
  {
    key: "consent_reconfirm", kind: "legal",
    build: (d) => ({
      title: "광고성 정보 수신 동의 안내",
      body: `${d.agreed_on}에 판다산다 혜택·이벤트 소식(${[d.push && "웹 푸시", d.email && "이메일"].filter(Boolean).join("·")}) 받기에 동의하셨어요. 계속 받으시려면 그대로 두시고, 원치 않으면 설정에서 끌 수 있어요.`,
      path: "/settings", cta: "알림 설정 보기", email: true,
    }),
  },
  {
    key: "premium_expiring", kind: "info",
    // 유료 플랜이 끝나 감 / 첫 달 무료·초대 보상이 끝나 감 (자동 결제가 없으니 연장하려면 다시 입금)
    build: (d) => ({
      title: d.paid
        ? `${clip(d.name, 20)} ${d.tier === "biz" ? "비즈" : "프로"} 플랜이 ${d.until}에 끝나요`
        : `${clip(d.name, 20)} 무료 혜택이 ${d.until}에 끝나요`,
      body: d.paid
        ? "끝나면 맨 앞 고정·매일 자동 끌어올리기가 멈추고 견적은 30일 3건으로 돌아가요. 연장 신청 후 입금하면 끊기지 않고 이어져요."
        : "끝나면 맨 앞 고정·매일 자동 끌어올리기가 멈추고 견적은 30일 3건으로 돌아가요. 프로 플랜(월 3만 원, 부가세 별도)으로 이어서 쓸 수 있어요.",
      path: `/biz-premium?id=${d.business_id}`, cta: d.paid ? "플랜 연장하기" : "플랜 보기", email: true,
    }),
  },
  {
    key: "product_stale_7", kind: "info",
    build: (d) => ({
      title: `'${clip(d.title, 24)}' 올린 지 일주일이에요`,
      body: `아직 문의가 없어요. 가격(${won(d.price)})을 조금 조정하거나 끌어올리기를 하면 다시 맨 위에 보여요.`,
      path: `/product/${d.product_id}`, cta: "내 물건 확인하기", email: true,
    }),
  },
  {
    key: "product_stale_3", kind: "info",
    build: (d) => ({
      title: `'${clip(d.title, 24)}' 아직 문의가 없어요`,
      body: "끌어올리기를 하면 맨 위로 올라가요. 사진을 더 올리고 규격·상태를 적으면 문의가 늘어요.",
      path: `/product/${d.product_id}`, cta: "끌어올리기", email: false,
    }),
  },
  {
    key: "welcome_diagnose", kind: "info",
    build: () => ({
      title: "판다산다에 오신 걸 환영해요 🐼",
      body: "업종·지역만 고르면 우리 회사가 지금 신청할 수 있는 지원사업을 골라 드려요. 30초면 끝나요.",
      path: "/diagnose?from=journey", cta: "30초 진단하기", email: true,
    }),
  },
  {
    // 매주 월요일 지원사업 브리핑: 마감 알림을 켰거나 진단을 한 사람 (supabase/migrations/20261123_weekly_briefing.sql)
    key: "weekly_briefing", kind: "info", mondayOnly: true,
    build: (d) => d.count > 0 ? ({
      title: `이번 주 마감 ${d.region ? regionLabel(d.region) + " " : ""}지원사업 ${d.count}건`,
      body: `${clip(d.top, 40)}${d.count > 1 ? ` 외 ${d.count - 1}건` : ""} · 마감 전에 확인해 보세요`,
      path: d.region ? `/support/area/${encodeURIComponent(d.region)}` : "/support/weekly", cta: "이번 주 공고 보기", email: true,
    }) : null,
  },
  {
    key: "biz_weekly", kind: "info", mondayOnly: true,
    build: (d) => d.views_week > 0 ? ({
      title: `지난주 ${clip(d.name, 20)} 조회 ${d.views_week}회`,
      body: `지금까지 모두 ${d.views_total}회 조회됐어요. ` + (d.premium ? "프리미엄으로 동네 업체 맨 앞에 보이고 있어요." : "사진과 소개를 보강하면 문의로 이어지기 쉬워요."),
      path: "/my-biz", cta: "내 업체 관리", email: true,
    }) : null,
  },
  {
    key: "biz_upsell", kind: "ads",
    build: (d) => ({
      title: `${clip(d.name, 20)}, 조회 ${d.views_total}회를 넘었어요`,
      body: "프로 플랜(월 3만 원, 부가세 별도)이면 동네 업체 맨 앞에 고정되고 매일 자동으로 끌어올려지며, 견적을 30일에 30건까지 보낼 수 있어요. 자동 결제는 없어요.",
      path: `/biz-premium?id=${d.business_id}`, cta: "플랜 알아보기", email: true,
    }),
  },
  {
    key: "dormant_30", kind: "ads",
    build: (d) => d.new_programs > 0 ? ({
      title: `그동안 새 지원사업 ${d.new_programs}건이 올라왔어요`,
      body: "마감되기 전에 우리 회사에 맞는 공고를 확인해 보세요. 업종·지역만 고르면 골라 드려요.",
      path: "/diagnose?from=journey", cta: "맞춤 공고 보기", email: true,
    }) : null,
  },
];

// ---- 보내기 ----
function withJm(path: string, key: string) { return path + (path.includes("?") ? "&" : "?") + "jm=" + key; }

async function pushTo(admin: SupabaseClient, profileId: string, payload: Record<string, unknown>) {
  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return 0;
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") || "mailto:admin@pandasanda.com", pub, priv);
  const { data: subs } = await admin.from("push_subscriptions").select("id,endpoint,p256dh,auth").eq("profile_id", profileId);
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

function emailHtml(m: NonNullable<Msg>, kind: Kind, url: string, unsubUrl: string) {
  const ad = kind === "ads";
  return `<!doctype html><html lang="ko"><body style="margin:0;background:#F5F6F8;font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;color:#191F28">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
  <div style="background:#fff;border-radius:16px;padding:28px 24px">
    <div style="font-size:14px;font-weight:800;color:#B07A00">판다산다</div>
    <h1 style="margin:10px 0 0;font-size:21px;line-height:1.4">${ad ? "(광고) " : ""}${esc(m.title)}</h1>
    <p style="margin:12px 0 0;font-size:16px;line-height:1.65;color:#4E5968">${esc(m.body)}</p>
    <a href="${esc(url)}" style="display:block;margin-top:24px;padding:16px;border-radius:12px;background:#FFB800;color:#191F28;text-align:center;font-size:17px;font-weight:800;text-decoration:none">${esc(m.cta)}</a>
  </div>
  <p style="margin:16px 4px 0;font-size:12px;line-height:1.7;color:#8B95A1">
    ${ad ? "본 메일은 혜택·이벤트 소식 받기에 동의하신 분께 보내는 광고성 메일이에요.<br>" : kind === "legal" ? "본 메일은 정보통신망법에 따라 2년마다 보내는 수신 동의 안내예요.<br>" : "본 메일은 판다산다 이용과 관련된 안내예요.<br>"}
    ${esc(SENDER)}<br>
    <a href="${esc(unsubUrl)}" style="color:#8B95A1">${ad ? "광고 메일 수신거부" : "이메일 수신 설정"}</a> · <a href="${SITE}/settings" style="color:#8B95A1">알림 설정</a>
  </p>
</div></body></html>`;
}

async function sendEmail(to: string, subject: string, html: string, unsubUrl: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({
        from: Deno.env.get("EMAIL_FROM") || "판다산다 <noreply@pandasanda.com>",
        to: [to], subject, html,
        headers: { "List-Unsubscribe": `<${unsubUrl}>` },
      }),
    });
    if (!r.ok) console.error("email", r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) { console.error("email", (e as Error).message); return false; }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ code: "method_not_allowed" }, 405);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ code: "bad_request" }, 400); }
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const dry = b.dry_run === true;
  if (!dry && b.run !== true) return json({ code: "bad_request" }, 400);
  const only = typeof b.only === "string" ? b.only : null;
  // 미리보기(받는 사람·물건 이름이 보임)와 특정 메시지만 보내기는 운영자(service_role 키)만
  const isAdmin = (req.headers.get("Authorization") || "") === "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if ((dry || only) && !isAdmin) return json({ code: "forbidden" }, 403);
  // 야간(21~08시) 발송 금지: cron 이 아닌 때에 누가 불러도 낮에만
  const kstHour = new Date(Date.now() + 9 * 3600_000).getUTCHours();
  if (!dry && (kstHour < 8 || kstHour >= 21)) return json({ code: "quiet_hours" });

  // 실제 발송은 하루에 한 번만 (cron 이 겹치거나 누가 다시 불러도)
  if (!dry) {
    const { data: last } = await admin.from("journey_sends").select("sent_at").order("sent_at", { ascending: false }).limit(1).maybeSingle();
    if (last && Date.now() - Date.parse(last.sent_at) < 30 * 60_000) return json({ code: "too_soon" });
  }

  const kstNow = new Date(Date.now() + 9 * 3600_000);
  const isMonday = kstNow.getUTCDay() === 1;
  const todayStartUtc = new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()) - 9 * 3600_000).toISOString();

  // 횟수 제한용: 최근 7일 보낸 기록 (법정 안내 제외)
  const { data: recent } = await admin.from("journey_sends").select("profile_id,journey,sent_at")
    .gt("sent_at", new Date(Date.now() - 7 * 86400_000).toISOString()).neq("journey", "consent_reconfirm").limit(50000);
  const week = new Map<string, number>(), today = new Map<string, number>();
  const bump = (pid: string) => { week.set(pid, (week.get(pid) || 0) + 1); today.set(pid, (today.get(pid) || 0) + 1); };
  for (const r of recent || []) {
    week.set(r.profile_id, (week.get(r.profile_id) || 0) + 1);
    if (r.sent_at >= todayStartUtc) today.set(r.profile_id, (today.get(r.profile_id) || 0) + 1);
  }

  const emailOn = !!Deno.env.get("RESEND_API_KEY");
  let emailsLeft = EMAIL_MAX_PER_RUN;
  const report: Record<string, { candidates: number; sent: number; push: number; email: number; skipped: Record<string, number> }> = {};
  const preview: unknown[] = [];

  for (const j of JOURNEYS) {
    if (only && j.key !== only) continue;
    if (j.mondayOnly && !isMonday && !only) continue;
    const { data: cands, error } = await admin.rpc("journey_candidates", { p_journey: j.key });
    if (error) { console.error(j.key, error.message); report[j.key] = { candidates: -1, sent: 0, push: 0, email: 0, skipped: { error: 1 } }; continue; }
    const rep = report[j.key] = { candidates: (cands || []).length, sent: 0, push: 0, email: 0, skipped: {} as Record<string, number> };
    const skip = (why: string) => { rep.skipped[why] = (rep.skipped[why] || 0) + 1; };

    for (const c of (cands || []) as Cand[]) {
      const m = j.build(c.data || {});
      if (!m) { skip("no_content"); continue; }
      if (j.kind !== "legal") {
        if ((today.get(c.profile_id) || 0) >= DAY_CAP) { skip("day_cap"); continue; }
        if ((week.get(c.profile_id) || 0) >= WEEK_CAP) { skip("week_cap"); continue; }
      }
      const canPush = j.kind !== "ads" || c.ads_push;
      const canEmail = emailOn && !!c.email && m.email !== false &&
        (j.kind === "ads" ? c.ads_email : j.kind === "info" ? c.info_email : true);
      if (!canPush && !canEmail) { skip("no_consent"); continue; }

      const title = (j.kind === "ads" ? "(광고) " : "") + m.title;
      const url = SITE + withJm(m.path, j.key);
      if (dry) {
        preview.push({ journey: j.key, profile_id: c.profile_id, ref: c.ref, title, body: m.body, url, push: canPush, email: canEmail });
        rep.sent++; if (j.kind !== "legal") bump(c.profile_id);
        continue;
      }

      // 먼저 기록해서 두 번 보내기를 막음 (같은 profile·journey·ref 는 한 번)
      const { data: row, error: dup } = await admin.from("journey_sends")
        .insert({ profile_id: c.profile_id, journey: j.key, ref: c.ref }).select("id").single();
      if (dup || !row) { skip("already_sent"); continue; }

      const push = canPush ? await pushTo(admin, c.profile_id, { title, body: m.body, url: withJm(m.path, j.key), tag: "journey-" + j.key }) : 0;
      let email = false;
      if (canEmail && emailsLeft > 0) {
        const token = (await admin.rpc("consent_token", { p_profile: c.profile_id })).data;
        const unsubUrl = `${SITE}/unsubscribe?t=${token}${j.kind === "ads" ? "" : "&k=all"}`;
        email = await sendEmail(c.email!, title, emailHtml(m, j.kind, url, unsubUrl), unsubUrl);
        emailsLeft--;
        await sleep(EMAIL_GAP_MS);
      } else if (canEmail) skip("email_run_cap");

      if (!push && !email) { // 아무것도 안 갔으면 기록을 지워 횟수에 세지 않음
        await admin.from("journey_sends").delete().eq("id", row.id);
        skip("not_delivered");
        continue;
      }
      await admin.from("journey_sends").update({ push_sent: push, email_sent: email }).eq("id", row.id);
      await admin.from("marketing_events").insert({ profile_id: c.profile_id, name: "journey_sent", path: m.path, props: { journey: j.key, push, email } });
      if (j.key === "consent_reconfirm") await admin.from("marketing_consents").update({ reconfirmed_at: new Date().toISOString() }).eq("profile_id", c.profile_id);
      rep.sent++; rep.push += push; rep.email += email ? 1 : 0;
      if (j.kind !== "legal") bump(c.profile_id);
    }
  }

  // 월요일: 이번 주 조회수 기록 (다음 주 리포트의 기준)
  if (!dry && isMonday && !only) await admin.rpc("biz_snapshot_views");

  return json(dry ? { ok: true, dry_run: true, report, preview: preview.slice(0, 200) } : { ok: true, report });
});
