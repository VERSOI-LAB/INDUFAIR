// 지원사업 공고 + 교육·행사 자동 수집: 기업마당 지원사업정보·행사정보 API → support_programs, biz_events (번호 기준 upsert)
// pg_cron 이 매일 2번 { } 로 호출. 처음 한 번은 { "pages": 20 } 으로 불러 지난 공고까지 채운다
// 필요한 비밀값: BIZINFO_API_KEY. cron 이 JWT 없이 부르므로 'Verify JWT' 를 끈다. 30분 안 재실행은 무시
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const API = "https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do";
const EVENT_API = "https://www.bizinfo.go.kr/uss/rss/bizinfoEventApi.do"; // 교육·세미나·전시회·설명회
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

// 지역 정하기: ① 제목 앞 "[울산]" ② 지역 해시태그가 딱 하나일 때 그 지역 ③ 그 밖(태그 없음·여러 지역)은 전국
//   전국 사업은 해시태그에 16개 지역이 모두 붙어 오므로 첫 번째 태그를 쓰면 안 됨
const toRegion = (t: string) => (t === "광주" || t === "전남" || t.startsWith("전남광주") ? "전남광주" : REGIONS.includes(t) ? t : null);
function regionOf(tags: string | null, title = "") {
  const head = title.match(/^\s*\[([^\]]+)\]/);
  const fromTitle = head ? toRegion(head[1].trim()) : null;
  if (fromTitle) return fromTitle;
  const found = new Set(String(tags || "").split(/[,#\s]+/).map((t) => toRegion(t)).filter(Boolean));
  return found.size === 1 ? [...found][0] as string : "전국";
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
    region: regionOf(tags, title), target: str(it.trgetNm, 500),
    summary: plain(it.bsnsSumryCn ?? it.description, 2000), hashtags: tags,
    apply_text: applyText, apply_start: p.start, apply_end: p.end,
    url, posted_at: postedAt, updated_at: new Date().toISOString(),
  };
}

// 행사(교육·세미나·전시회·설명회) 한 건 → biz_events 행
function toEventRow(it: Item) {
  const id = str(it.eventInfoId ?? it.seq, 100);
  const title = str(it.nttNm ?? it.title);
  if (!id || !title) return null;
  const applyText = str(it.rceptPd, 200);
  // 실제 응답 이름은 문서와 다름: eventBeginEndDe, orginlUrlAdres (2026-11 확인)
  const eventText = str(it.eventBeginEndDe ?? it.BeginEndDe ?? it.eventPeriod, 200);
  const a = period(applyText), e = period(eventText);
  const tags = str(it.hashtags ?? it.hashTags, 1000);
  const area = str(it.areaNm, 50) || "";
  const reg = String(it.registDe ?? "").replace(/\D/g, "");
  const origin = str(it.orginlUrlAdres ?? it.originUrlAdres ?? it.originUrl, 1000);
  return {
    source: "bizinfo", external_id: id, title,
    event_type: (str(it.eventInfoTyNm ?? it.eventType, 50) || "").split("@")[0] || null, // "교육@기타" → 교육
    category: (str(it.pldirSportRealmLclasCodeNm ?? it.lcategory, 50) || "").split("@").filter(Boolean).join("·") || null,
    // 제목 앞 [전국]/[서울] 이 가장 정확(지역 칸은 주최 기관 소재지일 때가 많음)
    region: /^\s*\[전국\]/.test(title) ? "전국" : (title.match(/^\s*\[([^\]]+)\]/) && toRegion(title.match(/^\s*\[([^\]]+)\]/)![1].trim()))
      || toRegion(area) || (area === "전국" ? "전국" : regionOf(tags, title)),
    organizer: str(it.originEngnNm ?? it.originOrg, 200),
    summary: plain(it.nttCn ?? it.description, 2000), hashtags: tags,
    apply_text: applyText, apply_start: a.start, apply_end: a.end,
    event_text: eventText, event_start: e.start, event_end: e.end || e.start,
    url: SITE + "/web/lay1/bbs/S1T122C127/AX/210/view.do?eventInfoId=" + encodeURIComponent(id),
    origin_url: origin && /^https?:\/\//.test(origin) ? origin : null,
    posted_at: reg.length === 8 ? `${reg.slice(0, 4)}-${reg.slice(4, 6)}-${reg.slice(6, 8)}T00:00:00+09:00` : null,
    updated_at: new Date().toISOString(),
  };
}

async function fetchPage(key: string, page: number, api = API): Promise<Item[] | string> {
  const q = new URLSearchParams({ crtfcKey: key, dataType: "json", pageIndex: String(page), pageUnit: String(PAGE_UNIT), searchCnt: String(PAGE_UNIT) });
  const r = await fetch(api + "?" + q.toString(), { headers: { Accept: "application/json" } });
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

  // probe: 원본 응답 한 건만 보기(저장 없음) — 필드 이름 점검용. { "probe": "events" | "programs" }
  if (body.probe === "events" || body.probe === "programs") {
    const ek = Deno.env.get("BIZINFO_EVENT_API_KEY") || key;
    const q = new URLSearchParams({ crtfcKey: body.probe === "events" ? ek : key, dataType: "json", pageIndex: "1", pageUnit: "1", searchCnt: "1" });
    const r = await fetch((body.probe === "events" ? EVENT_API : API) + "?" + q.toString());
    const d = await r.json().catch(() => null) as Record<string, unknown> | null;
    const arr = d?.jsonArray as unknown;
    const first = Array.isArray(arr) ? arr[0] : Array.isArray((arr as Item)?.item) ? ((arr as Item).item as Item[])[0] : arr;
    return json({ status: r.status, top: d ? Object.keys(d) : null, first });
  }

  const { data: run } = await admin.from("support_sync_runs").select("last_run_at").eq("id", 1).maybeSingle();
  if (run && Date.now() - new Date(run.last_run_at).getTime() < 30 * 60_000) return json({ skipped: "ran_recently" });
  await admin.from("support_sync_runs").upsert({ id: 1, last_run_at: new Date().toISOString() });

  // 여러 페이지를 받아 table 에 공고번호 기준 upsert
  async function sync(api: string, apiKey: string, table: string, map: (it: Item) => Record<string, unknown> | null) {
    let fetched = 0, saved = 0;
    const errors: string[] = [];
    for (let page = 1; page <= pages; page++) {
      const items = await fetchPage(apiKey, page, api);
      if (typeof items === "string") { errors.push(`page ${page}: ${items}`); break; }
      fetched += items.length;
      const rows = items.map(map).filter((x): x is Record<string, unknown> => !!x);
      // 같은 묶음 안의 중복 번호는 하나만
      const uniq = [...new Map(rows.map((r) => [r.external_id, r])).values()];
      if (uniq.length) {
        const { error } = await admin.from(table).upsert(uniq, { onConflict: "source,external_id" });
        if (error) { errors.push(`page ${page}: ${error.message}`); break; }
        saved += uniq.length;
      }
      if (items.length < PAGE_UNIT) break; // 마지막 페이지
    }
    return { fetched, saved, errors };
  }

  const programs = await sync(API, key, "support_programs", toRow);
  const events = await sync(EVENT_API, Deno.env.get("BIZINFO_EVENT_API_KEY") || key, "biz_events", toEventRow);

  // 마감이 반년 넘게 지난 공고, 끝난 지 한 달 넘은 행사는 정리
  const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
  await admin.from("support_programs").delete().lt("apply_end", day(180));
  await admin.from("biz_events").delete().lt("event_end", day(30));

  const result = { ...programs, events, at: new Date().toISOString() };
  await admin.from("support_sync_runs").update({ last_result: result }).eq("id", 1);
  return json(result, programs.errors.length && !programs.saved && !events.saved ? 502 : 200);
});
