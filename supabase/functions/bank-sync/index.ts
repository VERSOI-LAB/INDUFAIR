// 계좌이체 입금 확인 + 세금계산서 자동 발행 (팝빌). 토스페이먼츠는 쓰지 않음
//   { action: "cron" }          pg_cron 이 한국시간 07~23시 10분마다 부름: 입금 내역 가져오기 → 주문과 맞추기 → 세금계산서 발행. 4분 안에 다시 부르면 건너뜀
//   { action: "sync" }          (운영자) 지금 바로 위와 같은 일
//   { action: "invoice" }       (운영자) 발행이 안 된 세금계산서·수정세금계산서만 다시 발행
//   { action: "test_deposit", amount, depositor }  (운영자, 팝빌 테스트 모드이거나 팝빌 키가 없을 때만) 가짜 입금을 넣어 흐름 확인
//   운영자 = Authorization: Bearer <로그인한 운영자(app_admins)의 토큰> 또는 <service_role 키>
// 비밀값 (supabase secrets set ...)
//   POPBILL_LINK_ID, POPBILL_SECRET_KEY   팝빌 연동 아이디·비밀키 (팝빌 > 연동신청 후 메일로 받음)
//   POPBILL_IS_TEST                        "true" 면 테스트베드(popbill-test), 실제 운영은 "false"
//   POPBILL_CORP_NUM                       우리 사업자번호 (숫자 10자리, 팝빌 회원)
//   POPBILL_USER_ID                        (선택) 팝빌 회원 아이디
//   POPBILL_BANK_CODE, POPBILL_BANK_ACCOUNT  입금 받는 계좌: 기관코드 4자리(예: 0003 기업은행, 0004 국민, 0088 신한, 0020 우리, 0081 하나, 0011 농협), 계좌번호 숫자만
//                                          (팝빌 계좌조회에 이 계좌를 먼저 등록하고 정액제 신청)
//   COMPANY_NAME, COMPANY_CEO, COMPANY_ADDR, COMPANY_BIZ_TYPE, COMPANY_BIZ_CLASS, COMPANY_EMAIL  세금계산서 공급자(우리) 정보
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (선택) 입금 확인 웹 푸시 (채팅 알림과 같은 값)
// 배포: supabase functions deploy bank-sync --no-verify-jwt
// 규칙: supabase/migrations/20261127_billing.sql 맨 위 설명
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SITE = "https://www.pandasanda.com";
const env = (k: string, d = "") => (Deno.env.get(k) ?? d).trim();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" },
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");

// 한국 날짜 yyyyMMdd (n 일 전)
function kstYmd(d = new Date(), minusDays = 0) {
  const t = new Date(d.getTime() + 9 * 3600_000 - minusDays * 86400_000);
  return t.toISOString().slice(0, 10).replace(/-/g, "");
}

// ---------- 팝빌 (링크허브 인증) ----------
type Cfg = { linkId: string; secret: string; test: boolean; corpNum: string; userId: string };
function popbillCfg(): Cfg | null {
  const linkId = env("POPBILL_LINK_ID"), secret = env("POPBILL_SECRET_KEY"), corpNum = digits(env("POPBILL_CORP_NUM"));
  if (!linkId || !secret || corpNum.length !== 10) return null;
  return { linkId, secret, test: env("POPBILL_IS_TEST", "true") !== "false", corpNum, userId: env("POPBILL_USER_ID") };
}

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let tokenCache: { token: string; exp: number } | null = null;

// 링크허브 토큰: 본문 sha256 과 날짜·버전·주소를 비밀키로 HMAC 서명 (팝빌 공식 SDK 와 같은 방식)
async function popbillToken(c: Cfg) {
  if (tokenCache && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  const service = c.test ? "POPBILL_TEST" : "POPBILL";
  const uri = "/" + service + "/Token";
  const body = JSON.stringify({ access_id: c.corpNum, scope: ["member", "110", "180"] });
  const xDate = new Date().toISOString();
  const bodyDigest = b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  // 함수 서버는 고정 IP 가 없어서 IP 제한 없이 ('*')
  const target = "POST\n" + bodyDigest + "\n" + xDate + "\n" + "*\n" + "2.0\n" + uri;
  const key = await crypto.subtle.importKey("raw", unb64(c.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = b64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(target)));
  const res = await fetch("https://auth.linkhub.co.kr" + uri, {
    method: "POST",
    headers: {
      "x-lh-date": xDate, "x-lh-version": "2.0", "x-lh-forwarded": "*",
      Authorization: "LINKHUB " + c.linkId + " " + sig, "Content-Type": "Application/json",
    },
    body,
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.session_token) throw new Error("popbill token: " + (d.message || res.status));
  tokenCache = { token: d.session_token, exp: Date.parse(d.expiration) || Date.now() + 30 * 60_000 };
  return tokenCache.token;
}

// method: GET | POST | ISSUE (팝빌은 POST + X-HTTP-Method-Override)
async function popbill(c: Cfg, method: string, path: string, body?: unknown) {
  const token = await popbillToken(c);
  const headers: Record<string, string> = { Authorization: "Bearer " + token, "Content-Type": "application/json;charset=utf-8" };
  if (c.userId) headers["x-pb-userid"] = c.userId;
  if (method !== "GET" && method !== "POST") headers["X-HTTP-Method-Override"] = method;
  const host = c.test ? "https://popbill-test.linkhub.co.kr" : "https://popbill.linkhub.co.kr";
  const res = await fetch(host + path, {
    method: method === "GET" ? "GET" : "POST", headers,
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}, (_k, v) => (v === null || v === "" || v === undefined ? undefined : v)),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`popbill ${path.split("?")[0]}: [${d.code ?? res.status}] ${d.message ?? ""}`);
  return d;
}

// ---------- 1) 통장 입금 내역 가져오기 ----------
async function fetchDeposits(admin: SupabaseClient, c: Cfg) {
  const bank = digits(env("POPBILL_BANK_CODE")), acct = digits(env("POPBILL_BANK_ACCOUNT"));
  if (bank.length !== 4 || !acct) return { skipped: "no_account" };
  // 어제~오늘 (밤 사이 입금도 놓치지 않게)
  const job = await popbill(c, "POST", `/EasyFin/Bank/BankAccount?BankCode=${bank}&AccountNumber=${acct}&SDate=${kstYmd(new Date(), 1)}&EDate=${kstYmd()}`);
  const jobId = String(job.jobID || "");
  if (jobId.length !== 18) throw new Error("popbill job: " + JSON.stringify(job));
  let state: Record<string, unknown> = {};
  for (let i = 0; i < 20; i++) { // 은행 조회는 보통 몇 초, 최대 40초 기다림
    await sleep(2000);
    state = await popbill(c, "GET", `/EasyFin/Bank/${jobId}/State`);
    if (String(state.jobState) === "3") break;
  }
  if (String(state.jobState) !== "3") return { skipped: "job_timeout" };
  if (Number(state.errorCode) !== 1) throw new Error("popbill job failed: " + (state.errorReason || state.errorCode));
  let added = 0;
  for (let page = 1; page <= 10; page++) {
    const r = await popbill(c, "GET", `/EasyFin/Bank/${jobId}?TradeType=I&Page=${page}&PerPage=500&Order=D`);
    const list: Record<string, string>[] = r.list || [];
    const rows = list.filter((x) => Number(x.accIn) > 0 && x.tid).map((x) => {
      const dt = String(x.trdt || x.trdate || ""); // yyyyMMddHHmmss (한국시간)
      const iso = dt.length >= 8
        ? `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}T${(dt.slice(8, 10) || "00")}:${(dt.slice(10, 12) || "00")}:${(dt.slice(12, 14) || "00")}+09:00`
        : new Date().toISOString();
      return {
        tid: String(x.tid), traded_at: iso, amount: Math.round(Number(x.accIn)),
        depositor: [x.remark1, x.remark2, x.remark3, x.remark4].filter(Boolean).join(" ").trim().slice(0, 200), raw: x,
      };
    });
    if (rows.length) {
      const { data, error } = await admin.from("bank_deposits").upsert(rows, { onConflict: "tid", ignoreDuplicates: true }).select("id");
      if (error) throw new Error("save deposits: " + error.message);
      added += (data || []).length;
    }
    if (page >= Number(r.pageCount || 1)) break;
  }
  return { added };
}

// ---------- 2) 세금계산서 ----------
function invoicer(c: Cfg) {
  return {
    invoicerCorpNum: c.corpNum,
    invoicerCorpName: env("COMPANY_NAME", "베르소이(VERSOI)"),
    invoicerCEOName: env("COMPANY_CEO"),
    invoicerAddr: env("COMPANY_ADDR", "경기도 성남시 수정구 창업로 18, 876호"),
    invoicerBizType: env("COMPANY_BIZ_TYPE"),
    invoicerBizClass: env("COMPANY_BIZ_CLASS"),
    invoicerEmail: env("COMPANY_EMAIL"),
    invoicerContactName: env("COMPANY_CEO"),
  };
}

type Order = Record<string, any>;
function invoiceBody(c: Cfg, o: Order, mgtKey: string, writeDate: string, supply: number, item: string, modify?: { code: number; org: string }) {
  const tax = Math.trunc(supply / 10);
  return {
    writeDate, chargeDirection: "정과금", issueType: "정발행", purposeType: "영수", taxType: "과세",
    ...invoicer(c), invoicerMgtKey: mgtKey,
    invoiceeType: "사업자", invoiceeCorpNum: digits(o.buyer_corp_num), invoiceeCorpName: o.buyer_corp_name,
    invoiceeCEOName: o.buyer_ceo || o.buyer_corp_name, invoiceeAddr: o.buyer_addr, invoiceeBizType: o.buyer_biz_type, invoiceeBizClass: o.buyer_biz_item,
    invoiceeEmail1: o.buyer_email, invoiceeContactName1: o.buyer_ceo,
    supplyCostTotal: String(supply), taxTotal: String(tax), totalAmount: String(supply + tax),
    detailList: [{ serialNum: 1, purchaseDT: writeDate, itemName: item.slice(0, 100), qty: "1", unitCost: String(supply), supplyCost: String(supply), tax: String(tax) }],
    ...(modify ? { modifyCode: modify.code, orgNTSConfirmNum: modify.org } : {}),
  };
}

async function issueInvoices(admin: SupabaseClient, c: Cfg | null) {
  const { data: todo } = await admin.from("billing_orders").select("*")
    .or("and(status.in.(paid,refunded),invoice_status.in.(pending,failed)),refund_invoice_status.in.(pending,failed)")
    .order("paid_at").limit(30);
  let issued = 0, failed = 0;
  for (const o of todo || []) {
    if (!c) { // 팝빌 키가 없으면 발행하지 않고 이유만 남김 (테스트용)
      await admin.from("billing_orders").update({ invoice_error: "팝빌 연동 전이라 발행하지 않았어요" }).eq("id", o.id).in("invoice_status", ["pending", "failed"]);
      continue;
    }
    // 원래 세금계산서 (발행 전에 일부 환불했으면 남은 금액으로)
    if (["pending", "failed"].includes(o.invoice_status)) {
      const supply = o.supply_amount - (o.refund_supply || 0);
      try {
        const r = await popbill(c, "ISSUE", "/Taxinvoice", {
          ...invoiceBody(c, o, o.order_no, kstYmd(new Date(o.paid_at)), supply, o.item_name),
          memo: "판다산다 주문 " + o.order_no, emailSubject: "[판다산다] " + o.item_name + " 세금계산서",
        });
        await admin.from("billing_orders").update({
          invoice_status: "issued", invoice_nts_no: r.ntsConfirmNum || null, invoice_error: null, invoice_issued_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq("id", o.id);
        o.invoice_status = "issued"; o.invoice_nts_no = r.ntsConfirmNum || null;
        issued++;
      } catch (e) {
        failed++;
        await admin.from("billing_orders").update({ invoice_status: "failed", invoice_error: String((e as Error).message).slice(0, 300) }).eq("id", o.id);
        continue;
      }
    }
    // 환불분 수정세금계산서: 전액이면 계약의 해제(4), 일부면 공급가액 변동(2). 금액은 마이너스
    if (o.invoice_status === "issued" && ["pending", "failed"].includes(o.refund_invoice_status)) {
      try {
        let org = o.invoice_nts_no;
        if (!org) { // 발행 결과에 승인번호가 없었으면 조회
          const info = await popbill(c, "GET", "/Taxinvoice/SELL/" + encodeURIComponent(o.order_no));
          org = info.ntsconfirmNum || info.ntsConfirmNum;
          if (org) await admin.from("billing_orders").update({ invoice_nts_no: org }).eq("id", o.id);
        }
        if (!org) throw new Error("원래 세금계산서의 국세청 승인번호가 아직 없어요 (다음 실행 때 다시)");
        const whole = o.refund_supply >= o.supply_amount;
        const r = await popbill(c, "ISSUE", "/Taxinvoice", {
          ...invoiceBody(c, o, o.order_no + "-R", kstYmd(new Date(o.refunded_at)), -o.refund_supply, o.item_name + " 환불", { code: whole ? 4 : 2, org }),
          memo: "판다산다 주문 " + o.order_no + " 환불", emailSubject: "[판다산다] " + o.item_name + " 환불 수정세금계산서",
        });
        await admin.from("billing_orders").update({ refund_invoice_status: "issued", refund_invoice_nts_no: r.ntsConfirmNum || null, refund_invoice_error: null }).eq("id", o.id);
        issued++;
      } catch (e) {
        failed++;
        await admin.from("billing_orders").update({ refund_invoice_status: "failed", refund_invoice_error: String((e as Error).message).slice(0, 300) }).eq("id", o.id);
      }
    }
  }
  return { issued, failed };
}

// ---------- 3) 입금 확인 알림 (웹 푸시, 있으면) ----------
async function notifyPaid(admin: SupabaseClient, ids: string[]) {
  const pub = env("VAPID_PUBLIC_KEY"), priv = env("VAPID_PRIVATE_KEY");
  if (!pub || !priv || !ids.length) return;
  webpush.setVapidDetails(env("VAPID_SUBJECT", "mailto:admin@pandasanda.com"), pub, priv);
  const { data: orders } = await admin.from("billing_orders").select("id,profile_id,business_id,item_name,product_code").in("id", ids);
  for (const o of orders || []) {
    if (!o.profile_id) continue;
    const { data: subs } = await admin.from("push_subscriptions").select("id,endpoint,p256dh,auth").eq("profile_id", o.profile_id);
    const payload = JSON.stringify({
      title: "입금을 확인했어요", body: o.item_name + " 적용을 시작했어요. 세금계산서는 메일로 보내 드려요.",
      url: SITE + "/biz-premium" + (o.business_id ? "?id=" + o.business_id : ""), tag: "billing-" + o.id,
    });
    for (const s of subs || []) {
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400 }); }
      catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await admin.from("push_subscriptions").delete().eq("id", s.id);
      }
    }
  }
}

async function runAll(admin: SupabaseClient, c: Cfg | null) {
  const out: Record<string, unknown> = {};
  if (c) {
    try { out.fetch = await fetchDeposits(admin, c); }
    catch (e) { out.fetch = { error: (e as Error).message }; console.error(e); }
  } else out.fetch = { skipped: "not_configured" };
  const { data: matched, error } = await admin.rpc("billing_auto_match");
  if (error) out.match = { error: error.message };
  else {
    out.matched = (matched || []).length;
    for (const id of matched || []) {
      const { data: o } = await admin.from("billing_orders").select("total_amount,product_code").eq("id", id).maybeSingle();
      if (o) await admin.from("marketing_events").insert({ name: "billing_paid", props: { order_id: id, product: o.product_code, amount: o.total_amount } });
    }
    await notifyPaid(admin, matched || []).catch((e) => console.error("notify", e));
  }
  out.invoice = await issueInvoices(admin, c);
  await admin.from("billing_sync_state").update({ last_sync_at: new Date().toISOString(), last_result: out }).eq("id", 1);
  return out;
}

async function isOperator(admin: SupabaseClient, req: Request) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  if (token === env("SUPABASE_SERVICE_ROLE_KEY")) return true;
  const { data } = await admin.auth.getUser(token);
  if (!data?.user) return false;
  const { data: row } = await admin.from("app_admins").select("profile_id").eq("profile_id", data.user.id).maybeSingle();
  return !!row;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({});
  if (req.method !== "POST") return json({ code: "method_not_allowed" }, 405);
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* 빈 본문 */ }
  const action = String(b.action || "");
  const c = popbillCfg();

  if (action === "cron") {
    // 누가 자주 불러도 팝빌 조회는 4분에 한 번만
    const { data: st } = await admin.from("billing_sync_state").select("last_sync_at").eq("id", 1).maybeSingle();
    if (st?.last_sync_at && Date.now() - Date.parse(st.last_sync_at) < 4 * 60_000) return json({ ok: true, skipped: "recent" });
    return json({ ok: true, ...(await runAll(admin, c)) });
  }

  if (!(await isOperator(admin, req))) return json({ code: "forbidden" }, 403);

  if (action === "sync") return json({ ok: true, ...(await runAll(admin, c)) });
  if (action === "invoice") return json({ ok: true, invoice: await issueInvoices(admin, c) });
  if (action === "test_deposit") {
    if (c && !c.test) return json({ code: "live_mode" }, 400); // 실제 운영 중에는 가짜 입금을 넣지 않음
    const amount = Math.round(Number(b.amount));
    if (!(amount > 0)) return json({ code: "bad_request" }, 400);
    const { error } = await admin.from("bank_deposits").insert({
      tid: "TEST-" + crypto.randomUUID(), traded_at: new Date().toISOString(), amount, depositor: String(b.depositor || "").slice(0, 60), raw: { test: true },
    });
    if (error) return json({ code: "db_error", message: error.message }, 500);
    const { data: matched } = await admin.rpc("billing_auto_match");
    const inv = await issueInvoices(admin, c);
    return json({ ok: true, matched: (matched || []).length, invoice: inv });
  }
  return json({ code: "bad_request" }, 400);
});
