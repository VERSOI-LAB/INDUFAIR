// 지원사업 공고 자동 수집: 기업마당 지원사업정보 API → support_programs (공고번호 기준 upsert)
// pg_cron 이 매일 2번 { } 로 호출. 처음 한 번은 { "pages": 20 } 으로 불러 지난 공고까지 채운다
// 필요한 비밀값: BIZINFO_API_KEY. cron 이 JWT 없이 부르므로 'Verify JWT' 를 끈다. 30분 안 재실행은 무시
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const API = "https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do";
const SITE = "https://www.bizinfo.go.kr";
const PAGE_UNIT = 100;
// 기업마당 지역 해시태그 그대로 (광주·전남은 "전남광주" 하나로 묶여 있음)
const REGIONS = ["서울", "부산", "대구", "인천", "전남광주", "대전", "울산", "세종", "경기", "강원", "충북", "충남", "전북", "경북", "경남", "제주"];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Item = Record<string, unknown>;
const str = (v: unknown, max = 500) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

// HTML 태그·엔티티를 지운 글
function plain(html: unknown, max: number) {
  const s = String(html ?? "")
    .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  return s ? s.slice(0, max) : null;
}

// "20261101 ~ 20261130", "2026-11-01 ~ 2026.11.30" → 날짜 두 개. "상시", "예산 소진시" 등은 null
function period(text: string | null) {
  const s = String(text || "");
  const hits = [...s.matchAll(/(20\d{2})[-.\/]?(\d{2})[-.\/]?(\d{2})/g)];
  const found = hits.map((m) => `${m[1]}-${m[2]}-${m[3]}`).filter((d) => !isNaN(Date.parse(d)));
  // 날짜가 하나뿐이고 "~" 뒤에 있으면 마감일 ("~ 20261130")
  if (found.length === 1 && s.indexOf("~") !== -1 && s.indexOf("~") < (hits[0].index ?? 0)) return { start: null, end: found[0] };
  return { start: found[0] || null, end: found.length > 1 ? found[found.length - 1] : null };
}

function regionOf(tags: string | null) {
  const list = String(tags || "").split(/[,#\s]+/).filter(Boolean);
  // 예전 표기("광주", "전남")도 같은 지역으로
  if (list.some((t) => t === "광주" || t === "전남")) return "전남광주";
  return REGIONS.find((r) => list.includes(r)) || "전국";
}

function toRow(it: Item) {
  const id = str(it.pblancId ?? it.seq, 100);
  const title = str(it.pblancNm ?? it.title);
  if (!id || !title) return null;
  let url = str(it.pblancUrl ?? it.link, 1000) || "";
  if (url.startsWith("/")) url = SITE + url;
  if (!/^https?:\/\//.test(url)) url = SITE + "/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=" + encodeURIComponent(id);
  const applyText = str(it.reqstBeginEndDe ?? it.reqstDt, 200);
  const p = period(applyText);
  const tags = str(it.hashtags ?? it.hashTags, 1000);
  const posted = str(it.creatPnttm ?? it.pubDate, 40);
  const postedAt = posted && !isNaN(Date.parse(posted.replace(" ", "T") + "+09:00")) ? new Date(posted.replace(" ", "T") + "+09:00").toISOString()
    : posted && !isNaN(Date.parse(posted)) ? new Date(posted).toISOString() : null;
  return {
    source: "bizinfo", external_id: id, title,
    agency: str(it.jrsdInsttNm ?? it.author, 200), executor: str(it.excInsttNm, 200),
    category: str(it.pldirSportRealmLclasCodeNm ?? it.lcategory, 50),
    region: regionOf(tags), target: str(it.trgetNm, 500),
    summary: plain(it.bsnsSumryCn ?? it.description, 2000), hashtags: tags,
    apply_text: applyText, apply_start: p.start, apply_end: p.end,
    url, posted_at: postedAt, updated_at: new Date().toISOString(),
  };
}

async function fetchPage(key: string, page: number): Promise<Item[] | string> {
  const q = new URLSearchParams({ crtfcKey: key, dataType: "json", pageIndex: String(page), pageUnit: String(PAGE_UNIT), searchCnt: String(PAGE_UNIT) });
  const r = await fetch(API + "?" + q.toString(), { headers: { Accept: "application/json" } });
  if (!r.ok) return "http_" + r.status;
  const text = await r.text();
  let d: Record<string, unknown>;
  try { d = JSON.parse(text); } catch { return "not_json"; }
  if (d.reqErr) return "api_error: " + String(d.reqErr).slice(0, 200);
  const arr = d.jsonArray as unknown;
  const items = Array.isArray(arr) ? arr : Array.isArray((arr as Item)?.item) ? (arr as Item).item : [];
  return items as Item[];
}

Deno.serve(async (req) => {
  const key = Deno.env.get("BIZINFO_API_KEY");
  if (!key) return json({ code: "not_configured" }, 503);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* 빈 요청 */ }
  const pages = Math.min(20, Math.max(1, Number(body.pages) || 3));

  const { data: run } = await admin.from("support_sync_runs").select("last_run_at").eq("id", 1).maybeSingle();
  if (run && Date.now() - new Date(run.last_run_at).getTime() < 30 * 60_000) return json({ skipped: "ran_recently" });
  await admin.from("support_sync_runs").upsert({ id: 1, last_run_at: new Date().toISOString() });

  let fetched = 0, saved = 0;
  const errors: string[] = [];
  for (let page = 1; page <= pages; page++) {
    const items = await fetchPage(key, page);
    if (typeof items === "string") { errors.push(`page ${page}: ${items}`); break; }
    fetched += items.length;
    const rows = items.map(toRow).filter((x): x is NonNullable<typeof x> => !!x);
    // 같은 묶음 안의 중복 공고번호는 하나만
    const uniq = [...new Map(rows.map((r) => [r.external_id, r])).values()];
    if (uniq.length) {
      const { error } = await admin.from("support_programs").upsert(uniq, { onConflict: "source,external_id" });
      if (error) { errors.push(`page ${page}: ${error.message}`); break; }
      saved += uniq.length;
    }
    if (items.length < PAGE_UNIT) break; // 마지막 페이지
  }

  // 마감이 반년 넘게 지난 공고는 정리
  const old = new Date(Date.now() - 180 * 86400_000).toISOString().slice(0, 10);
  await admin.from("support_programs").delete().lt("apply_end", old);

  const result = { fetched, saved, errors, at: new Date().toISOString() };
  await admin.from("support_sync_runs").update({ last_result: result }).eq("id", 1);
  return json(result, errors.length && !saved ? 502 : 200);
});
