// 네이버 블로그 글 자동 준비 (Verify JWT 끔). 표·cron: supabase/migrations/20261128_blog_drafts.sql
//   발행 요일: 월 = 지원사업 · 수 = 중고 구매 체크 / 고장·정비 / 처분·폐업 (돌아가며) · 금 = 안전·법규 / 현장 Q&A (번갈아)
//   한 편 = 여러 단계. 단계마다 함수를 다시 불러서 이어 감 (Edge Function 실행 시간 제한에 걸리지 않게)
//     research(안전·법규만: 웹 검색으로 공식 자료 확인) → write(제목 5개·훅·본문) → review(검수, 문제 있으면 한 번 고쳐 씀) → image(AI 이미지) → ready(운영자 푸시)
//   글 규칙(코드로도 검사): 모든 문장 "~해요"체 · 핵심 문장은 **…** (화면·복사에서 빨간 굵은 글씨) · 공백 빼고 500자 이상 · AI 이미지 1장 이상
//
//   { run: true }                          cron: 다음 발행일(이틀 안) 글이 없으면 만들기 + 멈춘 글 이어 가기
//   { make: true, date?, pillar?, topic_id? }   운영자: 그날 글을 (다시) 만들기. date 없으면 다음 발행일
//   { continue: id, step? }                단계 이어 가기 (함수 자신 또는 운영자). step: "write" | "image" 로 다시 시작도 가능
//   운영자 = Authorization: Bearer <로그인한 운영자(app_admins)의 토큰> 또는 <service_role 키>
// 비밀값: ANTHROPIC_API_KEY (글)
//         OPENAI_API_KEY (이미지, 기본 gpt-image-1 — OPENAI_IMAGE_MODEL 로 바꿀 수 있음) 또는 GEMINI_API_KEY (GEMINI_IMAGE_MODEL, 기본 gemini-2.5-flash-image)
//         VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (준비되면 운영자에게 푸시, 채팅 알림과 같음)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";
import webpush from "npm:web-push@3.6.7";

const MODEL = "claude-opus-5-5";
const MIN_CHARS = 500;          // 본문 최소 글자 수 (공백 빼고)
const MIN_KEYS = 2;             // 핵심 문장(빨간 굵은 글씨) 최소 개수
const MAX_WRITES = 3;           // 규칙 검사에 떨어지면 다시 쓰는 횟수
const MAX_STEPS = 14;           // 한 편에 함수 호출 최대 (무한 반복 막기)
const STALE_MIN = 12;           // 이만큼 멈춰 있으면 cron 이 이어 감

type Pillar = "support" | "buying" | "maintenance" | "disposal" | "safety" | "qna";
type Block = { type: "heading" | "paragraph" | "list" | "image"; text: string; items: string[] };
type Draft = {
  titles: { text: string; score: number }[]; hook: string; answer: string; blocks: Block[];
  image_prompts: { prompt: string; alt: string }[]; tags: string[]; sources: { title: string; url: string }[];
};
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const env = (k: string) => Deno.env.get(k) || "";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" },
});
const clip = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
const kstDate = (offsetDays = 0) => new Date(Date.now() + 9 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400_000).toISOString().slice(0, 10);
const dow = (d: string) => new Date(d + "T00:00:00Z").getUTCDay();

// ---- 요일·묶음 ----
const PILLAR: Record<Pillar, { name: string; guide: string }> = {
  support: {
    name: "지원사업",
    guide: "이번 주 마감되거나 새로 나온 정부·지자체 지원사업 가운데 공장·제조·산업 사장님에게 맞는 것 3~5개를 골라 소개해요. 공고마다 무엇을 지원하는지, 누가 받을 수 있는지, 마감일, 신청 방법(공고 원문 확인)을 정리해요. 공고 제목·기관·마감일·금액은 <자료>에 적힌 그대로만 써요. 마지막에 '우리 회사가 받을 수 있는 공고만 골라 보기(30초 진단)'를 자연스럽게 권해요.",
  },
  buying: {
    name: "중고 구매 체크",
    guide: "중고 산업용품·기계를 살 때 현장에서 바로 써먹는 확인 방법을 알려 줘요. '이것만은 꼭 보세요' 같은 결론을 먼저, 그다음 체크리스트와 이유. 판매자에게 물어볼 질문도 넣어요.",
  },
  maintenance: {
    name: "고장·정비",
    guide: "장비 고장의 흔한 원인과 점검 순서를 알려 줘요. 사장님이 직접 확인할 수 있는 것과 기사를 불러야 하는 것을 나눠요. 전기·유압·압력처럼 위험한 작업은 전원 차단·잔압 제거 같은 안전 주의를 꼭 넣어요.",
  },
  disposal: {
    name: "처분·폐업",
    guide: "안 쓰는 장비·재고·공장 설비를 손해 보지 않고 처분하는 방법을 알려 줘요. 고철로 넘기면 손해인 경우, 제값 받는 준비(사진·사양·작동 영상), 거래 조건(운송·상차·세금계산서) 같은 실무 위주로요.",
  },
  safety: {
    name: "안전·법규",
    guide: "산업 안전·법규를 사장님 눈높이로 풀어 줘요. 시행일·대상·의무·벌칙 같은 사실은 <자료>(공식 자료 검색 결과)에 있는 것만 정확히 쓰고, 자료에 없으면 쓰지 마요. 출처 기관을 본문에 밝히고, 마지막에 '정확한 기준은 ○○에서 확인해 보세요'로 안내해요.",
  },
  qna: {
    name: "현장 Q&A",
    guide: "현장에서 실제로 나오는 질문 하나에 답하는 Q&A 글이에요. 글 앞부분에 질문을 소개하고(게시판 질문이면 글쓴이를 알 수 있는 내용은 빼고 다듬어서), 바로 결론부터 말한 뒤 이유·조건·주의할 점을 풀어요.",
  },
};
const WED: Pillar[] = ["buying", "maintenance", "disposal"];
const FRI: Pillar[] = ["safety", "qna"];

async function pillarFor(admin: SupabaseClient, date: string): Promise<Pillar | null> {
  const d = dow(date);
  if (d === 1) return "support";
  const group = d === 3 ? WED : d === 5 ? FRI : null;
  if (!group) return null;
  // 가장 오래 안 쓴 묶음 (같으면 정해 둔 순서)
  const { data } = await admin.from("blog_drafts").select("pillar,slot_date").in("pillar", group).lt("slot_date", date).order("slot_date", { ascending: false }).limit(20);
  const last = new Map<string, string>();
  for (const r of data || []) if (!last.has(r.pillar)) last.set(r.pillar, r.slot_date);
  return [...group].sort((a, b) => (last.get(a) || "").localeCompare(last.get(b) || "") || group.indexOf(a) - group.indexOf(b))[0];
}

// ---- 자료 ----
// 지원사업: api/_social.js 와 같은 기준으로 공장·제조 사장님에게 맞는 공고를 고름
const MFG = /제조|공장|스마트공장|소부장|뿌리|부품|소재|자동화|금형|용접|주조|도금|열처리|산업단지|산단|생산성|공정\s*개선|설비|기계|장비|로봇|공작|가공|금속|화학|섬유|플라스틱|사출|전자부품|반도체|자동차부품|조선|기자재/;
const IND = /산업|기술개발|기술|R&D|연구개발|시제품|인증|특허|지식재산|수출|해외|무역|물류|디지털\s*전환|DX|AI|스마트|에너지|탄소|안전|ESG|시설|생산|품질|판로|바이어|전시회|박람회|혁신|공급망/;
const OFF = /농업|농가|농기계|농산|농촌|농식품|귀농|어업|어로|어촌|수산|축산|가축|임산|산림|양식|비료|퇴비|과수|감귤|원예|화훼|음식점|외식|모범음식|식품위생|관광|숙박|문화예술|공연|체육|반려|미용|전통시장|상점가|골목상권|청년몰|카드수수료|임대료/;
const FIT = /중소기업|중견기업|기업|창업|인력|고용|마케팅|컨설팅|경영/;
const score = (p: Row) => { const t = p.title || ""; if (OFF.test(t)) return -1; return MFG.test(t) ? 3 : IND.test(t) ? 2 : /^(기술|수출)$/.test(p.category || "") ? 1.5 : FIT.test(t) ? 1 : 0; };

async function supportFacts(admin: SupabaseClient, slot: string) {
  const cols = "id,title,agency,executor,category,region,target,summary,apply_text,apply_end,url,posted_at";
  const [closing, fresh] = await Promise.all([
    admin.from("support_programs").select(cols).gte("apply_end", slot).lte("apply_end", addDays(slot, 6)).order("apply_end").limit(200),
    admin.from("support_programs").select(cols).gte("posted_at", addDays(slot, -8) + "T00:00:00+09:00").order("posted_at", { ascending: false }).limit(200),
  ]);
  const seen = new Set<number>();
  const all = [...(closing.data || []).map((p) => ({ ...p, kind: "이번 주 마감" })), ...(fresh.data || []).map((p) => ({ ...p, kind: "새 공고" }))]
    .filter((p) => !seen.has(p.id) && seen.add(p.id) && score(p) >= 1)
    .sort((a, b) => score(b) - score(a) || String(a.apply_end || "9999").localeCompare(String(b.apply_end || "9999")))
    .slice(0, 12);
  if (!all.length) return null;
  const text = all.map((p, i) => [
    `${i + 1}. [${p.kind}] ${p.title}`,
    `   기관: ${[p.agency, p.executor].filter(Boolean).join(" / ") || "-"} · 분야: ${p.category || "-"} · 지역: ${p.region === "전남광주" ? "광주·전남" : p.region || "전국"}`,
    `   신청 기간: ${p.apply_text || (p.apply_end ? "~" + p.apply_end : "상시")}`,
    `   대상: ${clip(p.target, 200) || "-"}`,
    `   내용: ${clip(p.summary, 500) || "-"}`,
    `   공고 원문: ${p.url}`,
  ].join("\n")).join("\n\n");
  return { topic: `${slot} 주간 제조·산업 지원사업`, facts: `발행일 ${slot} 기준, 마감 ${slot} ~ ${addDays(slot, 6)} 이거나 지난 일주일 새로 올라온 공고 (기업마당 수집)\n\n${text}`, sources: all.slice(0, 5).map((p) => ({ title: p.title, url: p.url })) };
}

// 이야기 게시판 질문 중 반응 있는 것을 Q&A 주제 후보로 넣어 둠 (개인정보는 글 쓸 때 뺌)
async function harvestQuestions(admin: SupabaseClient) {
  const { data } = await admin.from("story_posts").select("id,body,comment_count,like_count")
    .eq("topic", "question").eq("status", "active").gte("comment_count", 2).gte("created_at", new Date(Date.now() - 60 * 86400_000).toISOString())
    .order("comment_count", { ascending: false }).limit(10);
  if (!data?.length) return;
  const { data: have } = await admin.from("blog_topics").select("source_ref").eq("source", "community").in("source_ref", data.map((p) => String(p.id)));
  const known = new Set((have || []).map((r) => r.source_ref));
  const rows = data.filter((p) => !known.has(String(p.id)))
    .map((p) => ({ pillar: "qna", idea: clip(p.body, 190), angle: "이야기 게시판에 올라온 실제 질문이에요. 댓글 내용도 참고해요.", priority: 6, source: "community", source_ref: String(p.id) }));
  if (rows.length) await admin.from("blog_topics").insert(rows); // 같은 글이 동시에 들어오면 고유 색인이 막음
}

async function communityContext(admin: SupabaseClient, postId: string) {
  const { data: c } = await admin.from("story_comments").select("body").eq("post_id", Number(postId)).eq("status", "active").order("created_at").limit(10);
  return (c || []).map((x, i) => `댓글 ${i + 1}: ${clip(x.body, 300)}`).join("\n");
}

// ---- Claude ----
const claude = () => new Anthropic({ apiKey: env("ANTHROPIC_API_KEY"), maxRetries: 1, timeout: 140_000 });
// deno-lint-ignore no-explicit-any
const textOf = (res: any) => (res.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
// deno-lint-ignore no-explicit-any
async function ask(params: Record<string, unknown>): Promise<any> {
  // deno-lint-ignore no-explicit-any
  const res: any = await claude().beta.messages.create({
    model: MODEL, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", // 안전 분류기가 거절하면 서버가 다른 모델로 다시 시도
    ...params,
    // deno-lint-ignore no-explicit-any
  } as any);
  if (res.stop_reason === "refusal") throw new Error("AI 가 이 주제로 글쓰기를 거절했어요. 주제를 바꿔 다시 만들어 주세요");
  if (res.stop_reason === "max_tokens") throw new Error("AI 응답이 길이 제한에 걸렸어요. 다시 시도해 주세요");
  return res;
}

const DRAFT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["titles", "hook", "answer", "blocks", "image_prompts", "tags", "sources"],
  properties: {
    titles: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "score"], properties: { text: { type: "string" }, score: { type: "integer" } } } },
    hook: { type: "string" },
    answer: { type: "string" },
    blocks: { type: "array", items: { type: "object", additionalProperties: false, required: ["type", "text", "items"], properties: { type: { type: "string", enum: ["heading", "paragraph", "list", "image"] }, text: { type: "string" }, items: { type: "array", items: { type: "string" } } } } },
    image_prompts: { type: "array", items: { type: "object", additionalProperties: false, required: ["prompt", "alt"], properties: { prompt: { type: "string" }, alt: { type: "string" } } } },
    tags: { type: "array", items: { type: "string" } },
    sources: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "url"], properties: { title: { type: "string" }, url: { type: "string" } } } },
  },
};

const WRITER = `너는 판다산다(공구·기계 같은 산업용품을 신품·중고로 사고파는 앱, pandasanda.com)의 네이버 블로그 글을 쓰는 사람이에요. 읽는 사람은 공장·제조업 사장님, 설비 담당자, 공구·기계를 사고파는 사람들이에요.

반드시 지킬 것
1. 말투: 모든 문장을 친근한 "~해요"체로 써요 (~해요, ~예요, ~이에요, ~돼요, ~거든요, ~세요, ~할까요?). "~습니다·~입니다·~합니다·~됩니다·~습니까" 같은 합쇼체는 제목·훅·본문·목록 어디에도 한 번도 쓰지 마요. 반말도 안 돼요.
2. 제목(titles) 5개: 제목만 보고도 궁금해서 누르고 싶게 써요. 숫자, 손해 피하기("모르면 손해"), 구체적 장면("보러 가서"), 반전("진짜 이유") 가운데 2개 이상을 써요. 핵심 검색어는 앞 15자 안에, 길이는 40자 이하(32자 안팎 권장). 각 제목에 1~10 점수(score)를 매겨요. 제목이 약속한 답은 반드시 본문에 있어야 해요.
3. 훅(hook): 본문 첫 줄이에요. 제목의 궁금증을 한 번 더 키우는 한두 문장(80자 이하). 답을 다 말하지는 않되, 곧 알려 준다는 기대를 줘요.
4. 답(answer): 이 주제에 대한 핵심 답을 한두 문장으로 써요. 본문 앞부분에 같은 뜻의 핵심 문장으로 들어가야 해요.
5. 본문(blocks): 주제에 대한 답과 핵심 내용이 본문에 정확하고 구체적으로 다 들어 있어야 해요. 낚시 금지. 첫 두세 문단 안에 결론을 먼저 말하고, 그다음 이유·방법·체크리스트로 풀어요.
   - 소제목(heading) 3~5개, 문단(paragraph)은 2~4문장으로 짧게, 체크리스트는 list(items 에 항목, text 는 비워도 돼요). heading·paragraph·image 의 items 는 빈 배열.
   - 핵심 문장(독자가 꼭 가져가야 할 답·결론·경고)은 문장 하나를 통째로 **두 별표**로 감싸요. 글 전체에 3~6개, 첫 핵심 문장은 첫 소제목 전후에. 소제목에는 쓰지 않아요. 별표는 핵심 문장 표시에만 써요.
   - 이미지 자리(type "image", text 는 그 이미지 한 줄 설명)를 1~2개, 글 흐름에 맞는 곳에 넣어요.
   - 분량: 훅 포함 공백 빼고 1,200~2,000자. 공백 빼고 800자보다 짧으면 안 돼요.
   - 마지막 문단은 자연스러운 마무리와 판다산다 안내 한 문장(광고처럼 들리지 않게). 링크 주소는 본문에 쓰지 마요(따로 붙여요).
6. 사실: 숫자·법 조항·금액·기간·기관 이름은 <자료>에 있는 것만 써요. 자료에 없는 통계·수치·사례는 지어내지 마요. 일반적인 현장 지식은 써도 되지만, 장비마다 다른 것은 "보통", "제조사 설명서 기준으로"처럼 범위를 밝혀요. 위험한 작업은 안전 주의를 같이 써요.
7. image_prompts: 이미지 자리마다 하나씩, 같은 순서로. prompt 는 영어로, 한국의 작은 공장·작업장·창고 현장을 보여 주는 사실적인 사진 느낌으로 구체적으로 써요. 글자·숫자·로고·상표·간판·사람 얼굴 클로즈업은 넣지 않게 해요. alt 는 한국어 한 줄 설명.
8. tags: 네이버 검색에 쓰일 태그 8~10개 (# 없이, 띄어쓰기 없이).
9. sources: <자료>에서 실제로 쓴 출처(제목, 주소). 없으면 빈 배열. 지어낸 주소는 넣지 마요.`;

const REVIEWER = `너는 네이버 블로그 글 검수자예요. 아래 기준으로 글을 꼼꼼히 보고, 고쳐야 할 것만 problems 에 구체적으로 적어요(어느 문장을 어떻게). 문제가 없으면 pass true, problems 빈 배열.
1. 제목이 약속한 답과 주제의 핵심 내용이 본문에 정확하고 구체적으로 있는가 (두루뭉술하거나 빠진 것)
2. 핵심 답·결론이 **별표** 핵심 문장으로 표시돼 있는가 (표시가 엉뚱한 문장에 있거나, 정작 답이 표시 안 됐는가)
3. <자료>에 없는 숫자·법 내용·금액·날짜·기관을 지어냈거나 자료와 다르게 쓴 곳
4. "~해요"체가 아닌 문장(합쇼체 "~습니다/~입니다", 반말)
5. 낚시성 과장, 틀리거나 위험할 수 있는 현장 조언(안전 주의 누락 포함)
사소한 표현 취향은 문제로 적지 마요.`;

const REVIEW_SCHEMA = { type: "object", additionalProperties: false, required: ["pass", "problems"], properties: { pass: { type: "boolean" }, problems: { type: "array", items: { type: "string" } } } };

// 안전·법규: 웹 검색으로 공식 자료 확인 → 메모
async function research(topic: string, angle: string) {
  const today = kstDate();
  // deno-lint-ignore no-explicit-any
  const messages: any[] = [{
    role: "user",
    content: `오늘은 ${today}이에요. 네이버 블로그 글(주제: "${topic}"${angle ? `, 담을 내용: ${angle}` : ""})에 쓸 사실을 확인해 주세요.
한국 공식 자료(국가법령정보센터 law.go.kr, 고용노동부 moel.go.kr, 안전보건공단 kosha.or.kr, 소방청, 정부24 등)를 먼저 찾고, 현재 기준으로 맞는 내용만 정리해요.
형식: 사실 한 줄마다 "- 내용 (출처: 기관/문서명, 주소)". 시행일·대상·의무·벌칙·금액은 원문 그대로. 확인이 안 된 건 "확인 안 됨"이라고 적어요. 마지막에 "출처 목록"으로 제목 | 주소 를 적어요.`,
  }];
  let out = "";
  for (let i = 0; i < 4; i++) {
    const res = await ask({
      max_tokens: 16000, output_config: { effort: "medium" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6, user_location: { type: "approximate", country: "KR", timezone: "Asia/Seoul" } }],
      messages,
    });
    out += "\n" + textOf(res);
    if (res.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: res.content });
  }
  const sources = [...out.matchAll(/([^\n|]{2,120})\s*\|\s*(https?:\/\/[^\s)]+)/g)].slice(0, 8).map((m) => ({ title: m[1].replace(/^[-\s]+/, "").trim(), url: m[2] }));
  return { facts: out.trim().slice(0, 12000), sources };
}

// ---- 규칙 검사 ----
const plain = (s: string) => String(s || "").replace(/\*\*/g, "");
function bodyText(d: Draft) {
  return [d.hook, ...d.blocks.filter((b) => b.type !== "image").flatMap((b) => [b.text, ...(b.items || [])])].map(plain).join("\n");
}
const FORMAL = /(습니다|습니까|입니다|합니다|됩니다|십시오)[.!?]?(?=\s|$|["'”’)])/g;
function check(d: Draft) {
  const problems: string[] = [];
  const text = bodyText(d);
  const chars = text.replace(/\s/g, "").length;
  const all = [d.hook, ...d.blocks.flatMap((b) => [b.text, ...(b.items || [])])].join("\n");
  const keys = [...all.matchAll(/\*\*([^*\n]{4,}?)\*\*/g)].map((m) => m[1]);
  const stray = (all.replace(/\*\*([^*\n]{4,}?)\*\*/g, "").match(/\*\*/g) || []).length;
  const formal = [...[...d.titles.map((t) => t.text), text].join("\n").matchAll(FORMAL)].length;
  const images = d.blocks.filter((b) => b.type === "image").length;
  const headings = d.blocks.filter((b) => b.type === "heading").length;
  if ((d.titles || []).length < 3) problems.push("제목 후보를 5개 써 주세요.");
  if ((d.titles || []).some((t) => t.text.length > 45)) problems.push("제목은 40자 이하로 줄여 주세요.");
  if (!d.hook || d.hook.length > 120) problems.push("훅(본문 첫 줄)은 80자 안팎의 한두 문장으로 써 주세요.");
  if (chars < MIN_CHARS) problems.push(`본문이 공백 빼고 ${chars}자예요. 공백 빼고 1,200자 이상으로 내용을 더 구체적으로 채워 주세요.`);
  if (keys.length < MIN_KEYS) problems.push(`핵심 문장(**…**)이 ${keys.length}개예요. 주제의 답·결론 문장 3~6개를 **로 감싸 주세요.`);
  if (stray) problems.push("짝이 맞지 않거나 너무 짧은 ** 표시가 있어요. 핵심 문장 하나를 통째로 감싸 주세요.");
  if (formal) problems.push(`"~습니다/~입니다" 같은 합쇼체 문장이 ${formal}곳 있어요. 모두 "~해요"체로 바꿔 주세요.`);
  if (!images || !(d.image_prompts || []).length) problems.push("이미지 자리(type image)와 image_prompts 를 1개 이상 넣어 주세요.");
  if (headings < 2) problems.push("소제목(heading)을 3개 이상 넣어 주세요.");
  return { ok: !problems.length, problems, chars, keys: keys.length, formal, images };
}

// 이미지 자리와 프롬프트 개수 맞추기 (최대 2장)
function normalize(d: Draft): Draft {
  d.image_prompts = (d.image_prompts || []).filter((p) => p.prompt?.trim()).slice(0, 2);
  let n = 0;
  d.blocks = (d.blocks || []).filter((b) => b.type !== "image" || ++n <= d.image_prompts.length);
  if (d.image_prompts.length && !d.blocks.some((b) => b.type === "image")) {
    const at = Math.min(2, d.blocks.length);
    d.blocks.splice(at, 0, { type: "image", text: d.image_prompts[0].alt, items: [] });
  }
  d.tags = (d.tags || []).map((t) => t.replace(/^#/, "").replace(/\s+/g, "")).filter(Boolean).slice(0, 10);
  d.titles = (d.titles || []).filter((t) => t.text?.trim()).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5);
  return d;
}

async function previousTitles(admin: SupabaseClient) {
  const { data } = await admin.from("blog_drafts").select("titles,title_pick,topic").neq("status", "skipped").order("slot_date", { ascending: false }).limit(40);
  return (data || []).map((r) => r.titles?.[r.title_pick || 0]?.text || r.topic).filter(Boolean);
}

async function write(admin: SupabaseClient, row: Row, feedback: string[]) {
  const p = PILLAR[row.pillar as Pillar];
  const prev = await previousTitles(admin);
  const before = row.blocks?.length ? JSON.stringify({ titles: row.titles, hook: row.hook, answer: row.answer, blocks: row.blocks, image_prompts: row.image_prompts, tags: row.tags, sources: row.sources }) : "";
  const user = [
    `오늘: ${kstDate()} · 발행일: ${row.slot_date}`,
    `글 종류: ${p.name}\n${p.guide}`,
    `주제: ${row.topic}`,
    row.checks?.angle ? `꼭 담을 내용: ${row.checks.angle}` : "",
    `<자료>\n${row.facts || "(따로 준 자료 없음 — 일반적인 현장 지식만 쓰고, 구체적인 수치·법 내용은 쓰지 마요)"}\n</자료>`,
    prev.length ? `이미 쓴 글 제목(겹치지 않게):\n${prev.map((t: string) => "- " + t).join("\n")}` : "",
    feedback.length ? `<고칠 점>\n${feedback.map((f) => "- " + f).join("\n")}\n</고칠 점>\n아래 이전 글을 바탕으로 고칠 점을 모두 고쳐서 전체를 다시 써 주세요.\n<이전 글>\n${before}\n</이전 글>` : "",
  ].filter(Boolean).join("\n\n");
  const res = await ask({
    max_tokens: 16000, output_config: { effort: "medium", format: { type: "json_schema", schema: DRAFT_SCHEMA } },
    system: [{ type: "text", text: WRITER, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  });
  return normalize(JSON.parse(textOf(res)) as Draft);
}

async function review(row: Row) {
  const title = row.titles?.[0]?.text || "";
  const body = [row.hook, ...row.blocks.map((b: Block) => b.type === "heading" ? `## ${b.text}` : b.type === "list" ? (b.text ? b.text + "\n" : "") + b.items.map((i) => "- " + i).join("\n") : b.type === "image" ? `[이미지: ${b.text}]` : b.text)].join("\n\n");
  const res = await ask({
    max_tokens: 8000, output_config: { effort: "low", format: { type: "json_schema", schema: REVIEW_SCHEMA } },
    system: REVIEWER,
    messages: [{ role: "user", content: `<자료>\n${row.facts || "(없음 — 일반 현장 지식 글)"}\n</자료>\n\n주제: ${row.topic}\n핵심 답(작성자 의도): ${row.answer}\n\n제목: ${title}\n\n<본문>\n${body}\n</본문>` }],
  });
  return JSON.parse(textOf(res)) as { pass: boolean; problems: string[] };
}

// ---- 이미지 ----
const STYLE = " Photorealistic editorial photograph, natural light, shot in a real small Korean factory or workshop, realistic tools and machines, clean composition, 3:2 landscape. Absolutely no text, letters, numbers, signs, logos, brand names or watermarks. No close-up faces.";
async function genImage(prompt: string): Promise<{ bytes: Uint8Array; type: string }> {
  const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  if (env("OPENAI_API_KEY")) {
    const r = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + env("OPENAI_API_KEY") },
      body: JSON.stringify({ model: env("OPENAI_IMAGE_MODEL") || "gpt-image-1", prompt: prompt + STYLE, size: "1536x1024", quality: "medium", output_format: "jpeg", n: 1 }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.data?.[0]?.b64_json) throw new Error("OpenAI 이미지 " + r.status + " " + clip(j?.error?.message, 200));
    return { bytes: b64(j.data[0].b64_json), type: "image/jpeg" };
  }
  if (env("GEMINI_API_KEY")) {
    const model = env("GEMINI_IMAGE_MODEL") || "gemini-2.5-flash-image";
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": env("GEMINI_API_KEY") },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt + STYLE }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }),
    });
    const j = await r.json().catch(() => ({}));
    // deno-lint-ignore no-explicit-any
    const part = (j?.candidates?.[0]?.content?.parts || []).find((x: any) => x.inlineData?.data);
    if (!r.ok || !part) throw new Error("Gemini 이미지 " + r.status + " " + clip(j?.error?.message, 200));
    return { bytes: b64(part.inlineData.data), type: part.inlineData.mimeType || "image/png" };
  }
  throw new Error("이미지 만들 키가 없어요. Edge Function 비밀값에 OPENAI_API_KEY 또는 GEMINI_API_KEY 를 넣어 주세요");
}

// ---- 푸시 ----
async function notifyAdmins(admin: SupabaseClient, payload: Record<string, unknown>) {
  const pub = env("VAPID_PUBLIC_KEY"), priv = env("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return;
  webpush.setVapidDetails(env("VAPID_SUBJECT") || "mailto:admin@pandasanda.com", pub, priv);
  const { data: ids } = await admin.from("app_admins").select("profile_id");
  const { data: subs } = await admin.from("push_subscriptions").select("id,endpoint,p256dh,auth").in("profile_id", (ids || []).map((r) => r.profile_id));
  await Promise.all((subs || []).map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 86400 })
    .catch((e: unknown) => { const c = (e as { statusCode?: number }).statusCode; if (c === 404 || c === 410) return admin.from("push_subscriptions").delete().eq("id", s.id); })));
}

// ---- 주제 고르기 + 자리 만들기 ----
async function pickTopic(admin: SupabaseClient, pillar: Pillar, topicId?: number) {
  if (pillar === "qna") await harvestQuestions(admin);
  let q = admin.from("blog_topics").select("*").eq("pillar", pillar);
  q = topicId ? q.eq("id", topicId) : q.is("used_at", null).order("priority", { ascending: false }).order("id");
  const { data } = await q.limit(1);
  if (data?.[0]) return data[0];
  if (topicId) return null;
  // 창고가 비면 AI 가 겹치지 않는 새 주제를 정함
  const prev = await previousTitles(admin);
  const res = await ask({
    max_tokens: 4000, output_config: { effort: "low", format: { type: "json_schema", schema: { type: "object", additionalProperties: false, required: ["idea", "angle"], properties: { idea: { type: "string" }, angle: { type: "string" } } } } },
    messages: [{ role: "user", content: `판다산다(산업용품 신품·중고 거래) 네이버 블로그의 "${PILLAR[pillar].name}" 글 주제를 하나 정해 주세요. ${PILLAR[pillar].guide}\n공장·제조 사장님이 실제로 검색할 만한 구체적인 질문이어야 하고, 중고 시세·가격표는 다루지 않아요. 아래 이미 쓴 글과 겹치지 않게.\n${prev.map((t: string) => "- " + t).join("\n")}\nidea: 주제 한 줄, angle: 꼭 담을 내용.` }],
  });
  const t = JSON.parse(textOf(res));
  const { data: ins } = await admin.from("blog_topics").insert({ pillar, idea: clip(t.idea, 190), angle: clip(t.angle, 480), source: "ai" }).select("*").single();
  return ins;
}

async function createSlot(admin: SupabaseClient, date: string, opts: { pillar?: Pillar; topicId?: number; replace?: boolean }) {
  const { data: old } = await admin.from("blog_drafts").select("id,status,topic_id").eq("slot_date", date).maybeSingle();
  if (old && !opts.replace) return { skipped: "exists", id: old.id };
  if (old?.status === "published") return { skipped: "published", id: old.id };
  const pillar = opts.pillar || await pillarFor(admin, date);
  if (!pillar) return { skipped: "not_publish_day" };
  const row: Row = {
    slot_date: date, pillar, status: "queued", attempts: 0, titles: [], title_pick: 0, hook: null, answer: null, blocks: [], image_prompts: [], images: [], tags: [], sources: [],
    facts: null, error: null, char_count: null, naver_url: null, published_at: null, checks: { step: pillar === "safety" ? "research" : "write", writes: 0, rewrites: 0 },
  };
  if (pillar === "support") {
    const s = await supportFacts(admin, date);
    if (!s) return { skipped: "no_support_programs" };
    Object.assign(row, { topic: s.topic, facts: s.facts, sources: s.sources, topic_id: null });
  } else {
    const t = await pickTopic(admin, pillar, opts.topicId);
    if (!t) return { skipped: "no_topic" };
    let facts: string | null = null;
    if (t.source === "community" && t.source_ref) {
      const { data: post } = await admin.from("story_posts").select("body").eq("id", Number(t.source_ref)).maybeSingle();
      facts = `이야기 게시판 질문(글쓴이 정보는 쓰지 마요):\n${clip(post?.body || t.idea, 1500)}\n\n${await communityContext(admin, t.source_ref)}`;
    }
    Object.assign(row, { topic: t.idea, topic_id: t.id, facts, checks: { ...row.checks, angle: t.angle || "" } });
  }
  if (old) {
    await admin.from("blog_drafts").update(row).eq("id", old.id);
    if (old.topic_id && old.topic_id !== row.topic_id) await admin.from("blog_topics").update({ used_at: null }).eq("id", old.topic_id);
    return { id: old.id, replaced: true };
  }
  const { data, error } = await admin.from("blog_drafts").insert(row).select("id").single();
  if (error) return { skipped: "db_error", message: error.message };
  return { id: data.id };
}

// ---- 단계 진행 ----
async function step(admin: SupabaseClient, id: number, forceStep?: string) {
  const { data: row } = await admin.from("blog_drafts").select("*").eq("id", id).maybeSingle();
  if (!row || ["published", "skipped"].includes(row.status)) return { done: true };
  if (row.attempts >= MAX_STEPS && !forceStep) return fail(admin, id, row.error || "여러 번 시도했지만 끝내지 못했어요. 다시 만들기를 눌러 주세요");
  const checks = { ...(row.checks || {}) };
  if (forceStep) Object.assign(checks, { step: forceStep, writes: forceStep === "write" ? 0 : checks.writes, rewrites: forceStep === "write" ? 0 : checks.rewrites, feedback: [] });
  const cur = checks.step || "write";
  // 차지하기 (동시에 두 번 돌지 않게)
  const { data: claimed } = await admin.from("blog_drafts").update({ attempts: (forceStep ? 0 : row.attempts) + 1, status: cur === "image" ? "imaging" : "writing", checks }).eq("id", id).eq("updated_at", row.updated_at).select("id");
  if (!claimed?.length) return { busy: true };
  try {
    if (cur === "research") {
      const r = await research(row.topic, checks.angle || "");
      await admin.from("blog_drafts").update({ facts: [row.facts, r.facts].filter(Boolean).join("\n\n"), sources: r.sources, checks: { ...checks, step: "write" } }).eq("id", id);
      return { next: true };
    }
    if (cur === "write") {
      const d = await write(admin, row, checks.feedback || []);
      const c = check(d);
      const writes = (checks.writes || 0) + 1;
      const base = { titles: d.titles, title_pick: 0, hook: d.hook, answer: d.answer, blocks: d.blocks, image_prompts: d.image_prompts, tags: d.tags, sources: d.sources.length ? d.sources : row.sources, char_count: c.chars };
      if (!c.ok && writes < MAX_WRITES) {
        await admin.from("blog_drafts").update({ ...base, checks: { ...checks, step: "write", writes, feedback: c.problems, rule: c } }).eq("id", id);
        return { next: true };
      }
      if (!c.ok) {
        await admin.from("blog_drafts").update({ ...base, checks: { ...checks, writes, rule: c } }).eq("id", id);
        return fail(admin, id, "규칙 검사를 통과하지 못했어요: " + c.problems.join(" / "));
      }
      // 고쳐 쓴 글은 다시 검수하지 않고 이미지로 (시간·비용 절약). 처음 쓴 글만 검수
      const nextStep = (checks.rewrites || 0) >= 1 ? "image" : "review";
      await admin.from("blog_drafts").update({ ...base, checks: { ...checks, step: nextStep, writes, feedback: [], rule: c } }).eq("id", id);
      return { next: true };
    }
    if (cur === "review") {
      const r = await review(row);
      const problems = (r.problems || []).filter(Boolean);
      if (!r.pass && problems.length && (checks.rewrites || 0) < 1) {
        await admin.from("blog_drafts").update({ checks: { ...checks, step: "write", writes: 0, rewrites: (checks.rewrites || 0) + 1, feedback: problems, review: r } }).eq("id", id);
        return { next: true };
      }
      await admin.from("blog_drafts").update({ checks: { ...checks, step: "image", review: r } }).eq("id", id);
      return { next: true };
    }
    if (cur === "image") {
      const prompts = (row.image_prompts || []) as { prompt: string; alt: string }[];
      if (!prompts.length) return fail(admin, id, "이미지 설명이 없어요. 다시 만들기를 눌러 주세요");
      const images: { url: string; alt: string }[] = [];
      for (const [i, p] of prompts.entries()) {
        const img = await genImage(p.prompt);
        const path = `${row.slot_date}/${id}-${i + 1}-${Date.now().toString(36)}.${img.type.includes("png") ? "png" : "jpg"}`;
        const up = await admin.storage.from("blog-images").upload(path, img.bytes, { contentType: img.type, upsert: true });
        if (up.error) throw new Error("이미지 저장 실패: " + up.error.message);
        images.push({ url: admin.storage.from("blog-images").getPublicUrl(path).data.publicUrl, alt: p.alt });
      }
      await admin.from("blog_drafts").update({ images, status: "ready", error: null, checks: { ...checks, step: "done" } }).eq("id", id);
      if (row.topic_id) await admin.from("blog_topics").update({ used_at: new Date().toISOString() }).eq("id", row.topic_id);
      const title = row.titles?.[0]?.text || row.topic;
      await notifyAdmins(admin, { title: `블로그 글 준비됐어요 (${row.slot_date.slice(5).replace("-", "/")})`, body: clip(title, 90), url: "/admin/blog?id=" + id, tag: "blog-draft" });
      return { done: true };
    }
    return fail(admin, id, "알 수 없는 단계: " + cur);
  } catch (e) {
    const msg = clip((e as Error).message, 600);
    console.error("blog-draft", id, cur, msg);
    // 잠깐의 오류는 cron 이 다시 이어 감 (단계는 그대로). 이미지 키가 없는 것처럼 고칠 게 있으면 실패로 표시
    if (/키가 없어요|거절/.test(msg) || row.attempts + 1 >= MAX_STEPS) return fail(admin, id, msg);
    await admin.from("blog_drafts").update({ error: msg }).eq("id", id);
    await new Promise((r) => setTimeout(r, 5000));
    return { next: true, error: msg }; // 같은 단계를 한 번 더 (MAX_STEPS 까지)
  }
}

async function fail(admin: SupabaseClient, id: number, msg: string) {
  await admin.from("blog_drafts").update({ status: "failed", error: clip(msg, 900) }).eq("id", id);
  return { failed: msg };
}

// 다음 단계는 함수를 새로 불러서 (실행 시간을 단계마다 새로 받음)
async function kick(id: number, stepName?: string) {
  await fetch(env("SUPABASE_URL") + "/functions/v1/blog-draft", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + env("SUPABASE_SERVICE_ROLE_KEY") },
    body: JSON.stringify({ continue: id, ...(stepName ? { step: stepName } : {}) }),
  }).then((r) => r.body?.cancel()).catch((e) => console.error("kick", id, (e as Error).message));
}
async function runChain(admin: SupabaseClient, id: number, forceStep?: string) {
  const r = await step(admin, id, forceStep);
  if ((r as Row).next) await kick(id);
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

// 다음 발행일 (월·수·금) — from 날짜부터 within 일 안
function nextSlot(from: string, within: number) {
  for (let i = 0; i <= within; i++) { const d = addDays(from, i); if ([1, 3, 5].includes(dow(d))) return d; }
  return null;
}

function background(job: Promise<unknown>) {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) { rt.waitUntil(job); return true; }
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({});
  if (req.method !== "POST") return json({ code: "method_not_allowed" }, 405);
  let b: Row = {};
  try { b = await req.json(); } catch { /* 빈 본문 */ }
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
  if (!env("ANTHROPIC_API_KEY")) return json({ code: "no_anthropic_key", message: "Edge Function 비밀값에 ANTHROPIC_API_KEY 를 넣어 주세요" }, 500);

  if (b.run === true) {
    // 1) 내일·모레 발행일 글이 없으면 만들기
    const date = nextSlot(kstDate(1), 1);
    const made = date ? await createSlot(admin, date, {}) : { skipped: "no_slot" };
    // 2) 멈춘 글 이어 가기
    const { data: stuck } = await admin.from("blog_drafts").select("id").in("status", ["queued", "writing", "imaging"]).lt("updated_at", new Date(Date.now() - STALE_MIN * 60_000).toISOString()).limit(5);
    const ids = [...new Set([...((made as Row).id && !(made as Row).skipped ? [(made as Row).id] : []), ...(stuck || []).map((r) => r.id)])];
    background(Promise.all(ids.map((id) => kick(id))));
    return json({ ok: true, date, made, continuing: ids }, 202);
  }

  if (!(await isOperator(admin, req))) return json({ code: "forbidden" }, 403);

  if (b.continue) {
    const id = Number(b.continue), forceStep = typeof b.step === "string" && ["write", "image", "research"].includes(b.step) ? b.step : undefined;
    const job = runChain(admin, id, forceStep);
    if (background(job)) return json({ ok: true, accepted: true, id }, 202);
    await job; return json({ ok: true, id });
  }

  if (b.make === true) {
    const date = typeof b.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : nextSlot(kstDate(1), 7);
    if (!date) return json({ code: "no_slot" }, 400);
    const pillar = typeof b.pillar === "string" && b.pillar in PILLAR ? b.pillar as Pillar : undefined;
    const made = await createSlot(admin, date, { pillar, topicId: b.topic_id ? Number(b.topic_id) : undefined, replace: true });
    if ((made as Row).id && !(made as Row).skipped) background(kick((made as Row).id));
    return json({ ok: true, date, made }, 202);
  }

  return json({ code: "bad_request" }, 400);
});
