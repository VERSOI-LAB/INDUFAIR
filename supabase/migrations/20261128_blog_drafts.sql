-- 네이버 블로그 글 자동 준비 (1단계: 글·이미지는 자동, 올리기는 운영자가 붙여 넣고 예약발행)
--   발행 요일: 월 = 지원사업 · 수 = 중고 구매 체크 / 고장·정비 / 처분·폐업 (돌아가며) · 금 = 안전·법규 / 현장 Q&A (번갈아)
--   cron 이 일·화·목 한국시간 21:00 에 Edge Function blog-draft 를 { run: true } 로 부름 → 다음 발행일 글을 만들어 둠
--   만들기: 주제 고르기 → (안전·법규는 웹 검색으로 사실 확인) → Claude 가 제목 5개·훅·본문 → 규칙 검사·검수 → AI 이미지 → 운영자 푸시
--   운영자 화면: /admin/blog (blog-admin.html). 읽기·고치기는 운영자(app_admins)만
--   여러 번 실행해도 안전

-- 1) 주제 창고
create table if not exists public.blog_topics (
  id bigint generated always as identity primary key,
  pillar text not null check (pillar in ('support', 'buying', 'maintenance', 'disposal', 'safety', 'qna')),
  idea text not null check (length(idea) between 2 and 200),     -- 다룰 질문·주제 (제목 그대로가 아니어도 됨)
  angle text check (angle is null or length(angle) <= 500),       -- 꼭 담을 내용·관점 (선택)
  priority integer not null default 0,                             -- 높을수록 먼저
  source text not null default 'seed' check (source in ('seed', 'manual', 'community', 'ai')),
  source_ref text,                                                 -- community: story_posts.id
  used_at timestamptz,                                             -- 글로 만든 때 (비어 있으면 아직 안 씀)
  created_at timestamptz not null default now()
);
create index if not exists blog_topics_pick_idx on public.blog_topics (pillar, used_at, priority desc, id);
create unique index if not exists blog_topics_community_uq on public.blog_topics (source_ref) where source = 'community';

-- 2) 글 초안 (발행일 하루에 한 편)
create table if not exists public.blog_drafts (
  id bigint generated always as identity primary key,
  slot_date date not null unique,                 -- 올릴 날 (한국 날짜, 월·수·금)
  pillar text not null check (pillar in ('support', 'buying', 'maintenance', 'disposal', 'safety', 'qna')),
  topic_id bigint references public.blog_topics(id) on delete set null,
  topic text,                                     -- 실제로 다룬 주제 (한 줄)
  status text not null default 'queued' check (status in ('queued', 'writing', 'imaging', 'ready', 'failed', 'published', 'skipped')),
  attempts integer not null default 0,
  titles jsonb not null default '[]'::jsonb,      -- [{ text, score }]
  title_pick integer not null default 0,          -- titles 중 고른 것 (0부터)
  hook text,                                      -- 본문 첫 줄
  answer text,                                    -- 주제에 대한 답 한두 문장 (검수용)
  blocks jsonb not null default '[]'::jsonb,      -- [{ type: heading|paragraph|list|image, text, items[] }], 핵심 문장은 **…**
  image_prompts jsonb not null default '[]'::jsonb,
  images jsonb not null default '[]'::jsonb,      -- [{ url, alt }]
  tags jsonb not null default '[]'::jsonb,
  sources jsonb not null default '[]'::jsonb,     -- [{ title, url }]
  facts text,                                     -- 글에 쓴 자료 (공고 목록·검색 메모) — 검수·확인용
  checks jsonb not null default '{}'::jsonb,      -- 글자 수, 핵심 문장 수, 검수 결과 등
  char_count integer,
  error text check (error is null or length(error) <= 1000),
  naver_url text check (naver_url is null or naver_url ~ '^https://(m\.)?blog\.naver\.com/'),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists blog_drafts_status_idx on public.blog_drafts (status, slot_date);

alter table public.blog_topics enable row level security;
alter table public.blog_drafts enable row level security;
revoke all on public.blog_topics, public.blog_drafts from anon, authenticated;
grant all on public.blog_topics, public.blog_drafts to service_role;
grant select, insert, update, delete on public.blog_topics to authenticated;
grant select, update on public.blog_drafts to authenticated;

drop policy if exists blog_topics_admin on public.blog_topics;
create policy blog_topics_admin on public.blog_topics for all to authenticated
  using (public.is_app_admin()) with check (public.is_app_admin());
drop policy if exists blog_drafts_admin on public.blog_drafts;
create policy blog_drafts_admin on public.blog_drafts for all to authenticated
  using (public.is_app_admin()) with check (public.is_app_admin());

-- 운영자 화면에서는 고른 제목·발행 주소·상태(발행 완료·건너뛰기)만 바꿀 수 있게
revoke update on public.blog_drafts from authenticated;
grant update (title_pick, status, naver_url, published_at) on public.blog_drafts to authenticated;
create or replace function public.blog_drafts_guard()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if current_user = 'authenticated' and new.status is distinct from old.status
     and new.status not in ('published', 'skipped', 'ready') then
    raise exception 'status % is not allowed here', new.status;
  end if;
  return new;
end $$;
drop trigger if exists blog_drafts_guard on public.blog_drafts;
create trigger blog_drafts_guard before update on public.blog_drafts for each row execute function public.blog_drafts_guard();

-- 3) AI 이미지 보관 (공개 읽기: 네이버에 붙여 넣을 때 주소로 불러옴)
insert into storage.buckets (id, name, public) values ('blog-images', 'blog-images', true) on conflict (id) do nothing;

-- 4) 일·화·목 한국시간 21:00 (UTC 12:00) → 다음 날(월·수·금) 글 준비. 멈춘 글 다시 시도도 같이
select cron.unschedule('blog-draft') where exists (select 1 from cron.job where jobname = 'blog-draft');
select cron.schedule('blog-draft', '0 12 * * 0,2,4', $$
  select net.http_post(
    url := 'https://rqjfergjfhcrcuvfuhkm.supabase.co/functions/v1/blog-draft',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"run": true}'::jsonb,
    timeout_milliseconds := 30000
  );
$$);

-- 5) 처음 주제 (운영자 화면에서 더 넣고 지울 수 있음. 다 쓰면 AI 가 겹치지 않는 새 주제를 스스로 정함)
insert into public.blog_topics (pillar, idea, angle, priority)
select v.pillar, v.idea, v.angle, v.priority
from (values
  -- 중고 구매 체크
  ('buying', '중고 선반·밀링 보러 가서 꼭 확인할 것', '전원 넣고 돌려 보기, 주축 소리·유격, 베드 마모, 백래시, 사진으로 안 보이는 것', 5),
  ('buying', '중고 지게차 살 때 사고 나는 체크 포인트', '사용 시간계, 마스트·체인, 배터리(전동) 상태, 누유, 서류(검사·등록)', 5),
  ('buying', '중고 에어컴프레샤 고르는 법', '스크류 vs 왕복동, 운전 시간, 오일 상태, 탱크 부식·검사, 전기 용량(단상·삼상)', 4),
  ('buying', '중고 용접기 살 때 속지 않는 법', '전압(220/380), 출력 테스트, 토치·케이블 소모품, 인버터 기판 고장 징후', 4),
  ('buying', '중고 사출기 구매 전 반드시 볼 것', '형체력·사출량 맞추기, 유압 누유, 히터밴드, 컨트롤러 단종 여부', 3),
  ('buying', '중고 기계 직거래 vs 매매상, 뭐가 나을까', '가격·AS·운송·설치·세금계산서 차이, 사기 피하는 법', 3),
  ('buying', '중고 공구 대량 구매할 때 손해 안 보는 법', '정품 확인, 배터리 공구 충전 횟수, 소모품 호환', 2),
  -- 고장·정비
  ('maintenance', '겨울마다 지게차 배터리가 갑자기 죽는 이유', '저온 용량 저하, 충전 습관, 전해액, 단자 부식 — 배터리 탓이 아닌 경우', 5),
  ('maintenance', '공장 동파 사고 막는 겨울 점검 리스트', '배관·냉각수·에어 라인 드레인, 컴프레샤 응축수, 보온', 5),
  ('maintenance', '에어컴프레샤 압력이 안 올라갈 때 확인 순서', '누설, 흡입 필터, 밸브, 벨트, 언로더 — 혼자 볼 수 있는 것과 기사 부를 것', 4),
  ('maintenance', '기계 모터가 뜨거워지는 진짜 이유', '과부하, 결상, 베어링, 냉각팬, 인버터 설정', 4),
  ('maintenance', '유압유 언제 갈아야 할까', '색·냄새·수분, 사용 시간 기준, 필터 같이 교체, 섞어 쓰면 안 되는 이유', 3),
  ('maintenance', '여름철 공장 장비 과열 막는 법', '환기·냉각수·먼지 청소, 인버터·제어반 온도', 2),
  ('maintenance', '전동공구 배터리 오래 쓰는 보관법', '완충·완방 습관, 온도, 장기 보관 잔량', 3),
  -- 처분·폐업
  ('disposal', '공장 정리할 때 고철값에 넘기면 손해 보는 장비', '중고로 팔리는 장비 vs 고철로 갈 것 구분, 사진·사양 정리', 5),
  ('disposal', '중고 기계 제값 받고 파는 사진 찍는 법', '명판, 작동 영상, 사용 시간, 정면·측면·제어반', 5),
  ('disposal', '폐업할 때 기계·재고 처분 순서', '처분 시기, 일괄 매각 vs 개별 판매, 세금계산서·부가세, 운송', 4),
  ('disposal', '안 쓰는 재고 공구·자재 현금으로 바꾸는 법', '묶음 판매, 규격 정리, 가격 매기는 요령', 3),
  ('disposal', '기계 팔 때 운송·상차는 누가 책임질까', '거래 조건 미리 정하기, 크레인·지게차 비용, 파손 책임', 3),
  -- 안전·법규
  ('safety', '50인 미만 사업장도 중대재해처벌법 적용, 지금 해야 할 것', '2024년 1월부터 적용, 사업주 의무, 작은 공장이 먼저 할 것 (공식 자료로 확인)', 5),
  ('safety', '지게차 운전, 자격증 없으면 안 되는 경우', '면허·교육 기준(최대하중 등), 무자격 운전 시 책임 (공식 자료로 확인)', 5),
  ('safety', '안전검사 대상 기계, 검사 안 받으면 어떻게 될까', '크레인·리프트·압력용기 등 대상과 주기, 과태료 (공식 자료로 확인)', 4),
  ('safety', '공장 소화기·소방 점검, 사장님이 챙길 것', '소화기 교체 시기, 자체 점검, 위반 시 불이익 (공식 자료로 확인)', 3),
  ('safety', '산업안전 지원금·안전장비 보조, 받을 수 있는 것', '안전보건공단 지원사업 등 (공식 자료로 확인)', 4),
  ('safety', '중고 기계 살 때 안전인증(KCs) 꼭 봐야 하는 이유', '안전인증 대상 기계, 방호장치, 인증 없는 기계 사용 책임 (공식 자료로 확인)', 3),
  -- 현장 Q&A
  ('qna', '220V 기계를 380V 공장에서 써도 되나요?', '변압기, 단상·삼상, 모터 결선 — 하면 안 되는 것', 5),
  ('qna', '중고 기계에도 세금계산서 받을 수 있나요?', '사업자 간 거래, 개인 판매자, 부가세 환급', 4),
  ('qna', '공장 임대 계약 끝나면 설치한 기계는 어떻게 하나요?', '원상복구, 이전 비용, 중고로 넘기기', 3),
  ('qna', '삼상 전기 없는 곳에서 삼상 기계 돌리는 방법은?', '인버터(단상 입력), 위상변환기, 한전 증설 — 장단점', 4),
  ('qna', '중고 기계 고장 나면 판매자에게 책임 물을 수 있나요?', '하자 고지, 거래 전 확인, 계약서에 넣을 것', 3)
) as v(pillar, idea, angle, priority)
where not exists (select 1 from public.blog_topics where source = 'seed');
