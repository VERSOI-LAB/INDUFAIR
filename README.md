# 판다산다 (PANDASANDA)

팔 땐 **판다**, 살 땐 **산다**. 공구부터 기계까지, 산업용품 신품·중고 거래를 사진 한 장으로 쉽고 빠르게.

## 화면
| URL | 파일 | 내용 |
|---|---|---|
| `/` | `index.html` | 판다/산다 큰 버튼 + 방금 올라온 물건 |
| `/sell` | `sell.html` | 사진 → AI 인식 → 가격(시세 추천) → 설명(선택) → 지역(GPS) → 등록 |
| `/buy` | `buy.html` | 검색 + 카테고리 칩 + 당근식 목록 |
| `/product/:id` | `product.html` | 사진 슬라이드, 가격, 찜·전화·채팅 |
| `/chat`, `/chat/:id` | `chat.html` | 채팅 목록 / 채팅방 (실시간, 읽음 표시) |
| `/mypage` | `mypage.html` | 내 물건(판매중·판매완료), 통계, 찜 |
| `/login` | `login.html` | 이메일 로그인/가입 한 화면 |
| `/support`, `/support/:id` | `support.html` | 정부 지원사업 공고 (기업마당에서 매일 2번 자동 수집, 마감 임박순·분야·지역 필터) |
| `/community`, `/community/:id`, `/community/write` | `community.html` | 이야기: 당근 동네생활처럼 묻고 수다 떠는 곳 (주제 4개, 내 동네 글만 보기, 공감·댓글·신고, 댓글 달리면 웹 푸시) |
| `/diagnose` | `diagnose.html` | 지원사업 30초 진단: 업종·지역·규모·업력 → 맞춤 공고 (익명은 3건만, 로그인하면 전부 + 답 저장 + 마감 알림 자동 설정). 홈·지원사업 목록·지역별 모아보기에서 띠로 연결 |
| `/price/:item` | `api/seo.js` | 품목별 시세 (예: `/price/에어콤프레샤`): 등록 매물 가격의 가운데 50% 범위, 판매 중·판매 완료 매물 |
| `/buy/c/:cat`, `/buy/area/:area[/:cat]` | `api/seo.js` | 카테고리·지역(시·군·구)별 매물 (예: `/buy/area/분당구/산업기계`) |
| `/support/weekly` | `api/seo.js` | 이번 주(오늘~7일 뒤) 마감 지원사업 + 지난 일주일 새 공고. 데이터는 `/support/weekly.json` |
| `/weekly-card` | `weekly-card.html` | 운영자용: 주간 카드 이미지(1080×1350) 저장 + 블로그·카페·카톡 채널용 글 복사 (채널별 UTM 자동) |
| `/unsubscribe` | `unsubscribe.html` | 이메일 수신거부 (메일의 링크, 로그인 없이) |
| `/events`, `/events/:id` | `support.html` | 교육·세미나·전시회·설명회 (기업마당 행사정보, 같은 함수가 같이 수집) |
| `/pay-seller` | `pay-seller.html` | 안전결제 판매자 신청 (사업자 인증 + 통신판매업 신고 확인) |

### 지원사업·교육 행사 자동 수집
1. 기업마당(bizinfo.go.kr) > 정책정보 개방 API 에서 인증키 발급 (지원사업·행사정보 같은 키로 동작)
2. Supabase Edge Function 비밀값에 `BIZINFO_API_KEY` 추가 (행사 키를 따로 받으면 `BIZINFO_EVENT_API_KEY`)
3. `supabase/functions/sync-support-programs` 배포 (Verify JWT 끔)
4. `supabase/migrations/20261114_support_programs.sql`, `20261114_biz_events.sql` 실행 (테이블 + 매일 06시·18시 자동 실행)
5. 처음 한 번은 지난 공고까지 채우기: 함수에 `{"pages": 20}` 로 POST (30분 안 재실행은 무시)
6. 필드 점검: `{"probe": "events"}` 또는 `{"probe": "programs"}` 로 POST 하면 원본 응답 한 건을 돌려줌 (저장 없음)

검색 노출: `/product/:id`·`/biz/:id` 는 `api/page.js` 가 제목·설명·사진을 html 에 미리 채워 내려주고, `/sitemap.xml` 은 `api/sitemap.js` 가 DB 에서 만든다 (Vercel 함수, 로컬 서버에서는 동작하지 않음).

공용: `app.css`(디자인 토큰), `js/app.js`(로그인 상태·탭바·포맷), `js/supabase-client.js`.

## DB
`supabase/migrations/20261002_pandasanda_simple_market.sql` 을 Supabase SQL Editor 에서 한 번 실행하세요.
(9개 카테고리, products 단순화, chats/messages + RLS + 실시간, 찜/채팅 수 자동 집계)

## 로컬 실행
```bash
python3 dev-server.py   # http://localhost:8743 (vercel.json 의 clean URL 흉내)
```

## 안전결제 판매자
토스페이먼츠 정책상 비사업자 개인의 판매 대금 정산(C2C)은 안 되므로, 안전결제(구매하기·카드결제·정산)는 **승인된 사업자 판매자**만 쓸 수 있다.
개인 판매자 물건은 채팅으로 직접 거래. 조건은 `supabase/migrations/20261112_pay_sellers.sql` 참고 (주문 생성 트리거와 `toss-confirm` 에서도 막음).

- 판매자: `/pay-seller` 에서 사업자 인증 → 통신판매업 신고번호(또는 면제) 신청
- 운영자 승인: `select approve_pay_seller('<profile_id>');` / 반려: `select reject_pay_seller('<profile_id>', '사유');`
- 신청 대기 목록: `select profile_id, company_name, biz_reg_no, mail_order_no, mail_order_exempt, mail_order_cert_path, pay_requested_at from business_verifications where pay_status = 'requested';`

## 직접 거래 신뢰 장치 (거래 후기 · 사기 신고)
개인 판매자 물건은 앱 밖에서 결제하고 플랫폼은 돈을 다루지 않는다. 대신 `supabase/migrations/20261112_trust.sql`:

- **거래 후기**: 양쪽이 모두 메시지를 보낸 채팅방, 또는 수령 완료된 안전결제 주문의 상대에게 거래마다 한 번 (좋았어요/보통/별로 + 한 줄). 프로필 '받은 후기' 탭, 상품·채팅 화면에 요약
- **사기 신고**: 상품·채팅·프로필에서. 한 사람이 같은 상대는 한 번, 하루 10건까지. 서로 다른 3명 이상이 신고(기각 제외)하거나 운영자가 확정하면 그 사람의 상품·채팅·프로필에 주의 표시
- **안전 수칙**: 안전결제가 아닌 상품·채팅에 직접 거래 수칙, 상대가 보낸 계좌번호에는 송금 전 조회 안내
- 운영: `select * from user_reports where status = 'open' order by created_at desc;` → `update user_reports set status = 'confirmed' | 'dismissed' where id = ...;` 부적절한 후기는 `delete from trade_reviews where id = ...;`

## 채팅 알림
- **사이트를 열어 둔 동안**: 어느 화면에서든 새 메시지가 오면 탭바 채팅 배지(숫자)·브라우저 탭 제목 `(n)`·화면 위 알림 띠. 채팅 목록은 자동으로 새로 고침 (`js/app.js` 의 `watchMessages`)
- **사이트를 닫아도 (웹 푸시)**: `sw.js` + `manifest.webmanifest` + `supabase/migrations/20261112_chat_push.sql` + Edge Function `chat-push`
  - 채팅 목록 위 "알림 켜기" 또는 설정 › 채팅 알림에서 켬. 기기(브라우저)마다 따로
  - 아이폰은 Safari에서 "홈 화면에 추가"한 뒤 홈 화면 앱에서만 켤 수 있음 (iOS 16.4+)
  - 그 채팅방을 보고 있으면 알림을 띄우지 않음. 로그아웃하면 그 기기 알림은 꺼짐
  - Edge Function 비밀값: `VAPID_PUBLIC_KEY`(= `js/app.js` 의 `PS.VAPID_PUBLIC_KEY`), `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`(mailto:...). `chat-push` 는 Verify JWT 끔

## 마케팅 측정
`supabase/migrations/20261122_marketing_events.sql` 실행 → 사이트 안 행동이 `marketing_events` 에 쌓인다 (쿠키 없음, 로봇 제외, 90일 뒤 자동 삭제).
브라우저에서 `PS.track('이름', { ... })` (`js/supabase-client.js` 의 `psTrack`). 들어온 경로(UTM·외부 사이트·초대 링크)가 모든 기록에 `utm` 으로 붙는다 (새 UTM 링크로 다시 오면 그걸로 바뀜).

| 이벤트 | 언제 |
|---|---|
| `session_start` | 방문 시작 (탭 세션마다 한 번, 들어온 경로) |
| `sign_up` | 가입 (이메일·카카오, 초대 여부) |
| `login_start` | 카카오 로그인 버튼 누름 |
| `home_view`, `home_cta_click` | 홈 보기 / 홈에서 판매·구매·검색·지원사업·물건 누름 (A/B 문구 포함) |
| `product_create` | 물건 등록 |
| `chat_start` | 물건에서 새 채팅 시작 |
| `biz_create` | 업체 소개 처음 등록 |
| `alert_subscribe` | 키워드 알림 / 지원사업 마감 알림 켬 |
| `share` | 공유 (물건·업체·지원사업·이야기·초대) |
| `premium_view`, `premium_purchase` | 업체 프리미엄 화면 / 결제 |
| `purchase` | 안전결제 완료 |
| `diagnose_view`, `diagnose_complete` | 진단 화면 보기(어디서 왔는지 `from`) / 결과 보기 (고른 답) |
| `diagnose_unlock_click`, `diagnose_saved` | 익명이 "무료로 전체 보기" 누름 / 로그인 후 답 저장 |

진단 답은 `supabase/migrations/20261122_company_profiles.sql` 의 `company_profiles` 에 저장된다 (본인만 읽기). 진단 → 가입 전환: `select * from marketing_funnel(14) where step like 'diagnose%' or step = 'sign_up';`

운영자 확인 (SQL Editor):
- 단계별 사람 수: `select * from marketing_funnel(7);`
- 채널별 가입: `select * from marketing_signups_by_source(30);`

외부 홍보 링크에는 UTM 을 붙인다. 예) `/support?utm_source=naver_blog&utm_medium=content&utm_campaign=weekly_support`

**GA4**: `js/supabase-client.js` 의 `GA4_ID` 에 측정 ID 를 넣으면 같은 이벤트가 GA4 로도 간다. 켜기 전에 개인정보처리방침의 쿠키 항목("광고나 추적을 위한 쿠키를 쓰지 않습니다")과 처리 위탁(Google)을 먼저 고칠 것.

### 홈 문구 A/B 테스트
`index.html` 의 `HERO`. 방문자마다 a(거래 중심) / b(물건 + 지원금) 중 하나로 고정. 2주 정도 쌓은 뒤:
```sql
select v.props->>'variant' as variant,
       count(distinct v.anon_id) as viewers,
       count(distinct c.anon_id) as clickers,
       round(100.0 * count(distinct c.anon_id) / nullif(count(distinct v.anon_id), 0), 1) as click_rate
  from marketing_events v
  left join marketing_events c on c.name = 'home_cta_click' and c.anon_id = v.anon_id and c.props->>'variant' = v.props->>'variant'
 where v.name = 'home_view' and v.created_at > now() - interval '14 days'
 group by 1;
```
이긴 문구를 html 의 h1 으로 옮기고 테스트를 끝낸다.

## 카카오 로그인
1. Kakao Developers > 내 애플리케이션(지도에 쓰는 앱) > 카카오 로그인 활성화, Redirect URI 에 Supabase 콜백 주소(`<프로젝트 주소>/auth/v1/callback`) 추가
2. 동의항목: 닉네임(필수), 프로필 사진(선택). 이메일은 비즈 앱 전환 후에만 받을 수 있으니, 전이라면 Supabase 에서 "Allow users without an email" 을 켠다
3. 앱 키 > REST API 키 = Client ID, 보안 > Client Secret 발급·활성화 → Supabase > Authentication > Sign In / Providers > Kakao 에 넣고 켬
4. Supabase > Authentication > URL Configuration 의 Redirect URLs 에 사이트의 `/login**` 주소 추가
5. `js/app.js` 의 `PS.KAKAO_LOGIN = true` 로 바꾸면 로그인 화면에 노란 버튼이 나타난다

## 행동별 자동 메시지 (웹 푸시 + 이메일)
`supabase/migrations/20261122_journeys.sql` + Edge Function `journeys` (Verify JWT 끔). 매일 한국시간 10:30 에 cron 이 한 번 돌린다.

| 메시지 | 받는 사람 | 종류 | 채널 |
|---|---|---|---|
| `consent_reconfirm` | 광고 수신 동의 후 23개월 (2년 재확인, 정보통신망법 제50조 제8항) | 법정 안내 | 푸시·이메일 |
| `premium_expiring` | 프리미엄이 3일 안에 끝나는데 자동결제 없음 | 정보성 | 푸시·이메일 |
| `product_stale_7` | 물건 올린 지 7일, 채팅 0건 | 정보성 | 푸시·이메일 |
| `product_stale_3` | 물건 올린 지 3일, 채팅 0건 | 정보성 | 푸시 |
| `welcome_diagnose` | 가입 다음 날, 진단·마감 알림 안 함 | 정보성 | 푸시·이메일 |
| `biz_weekly` | 업체 주인, 월요일 (지난주 조회수) | 정보성 | 푸시·이메일 |
| `biz_upsell` | 프리미엄 아닌 업체 조회 30회 이상, 30일에 한 번 | **광고성** | 동의한 채널만 |
| `dormant_30` | 마지막 방문 30~37일 전 (그동안 새 지원사업 수) | **광고성** | 동의한 채널만 |

규칙
- 위 표 순서가 우선순위. 한 사람에게 **하루 1통, 7일 3통**까지 (법정 안내는 제외). 같은 메시지(사람·종류·대상)는 한 번만
- 광고성: `marketing_consents` 에서 동의한 채널로만, 제목 앞 `(광고)`, 이메일 아래에 전송자 정보와 수신거부 링크
- 실제 발송은 08~21시에만 (누가 다른 시각에 불러도 거절). 정보성 이메일도 설정이나 메일의 링크에서 끌 수 있음
- 동의: 가입 화면 `(선택)` 체크박스(기본 꺼짐) 또는 설정 › 알림 받기. 바꾸면 날짜와 처리 결과를 화면에 알림
- 수신거부 링크: `/unsubscribe?t=토큰` (로그인 없이). 토큰은 방문 기록에 남기지 않음

설정
1. 마이그레이션 실행, `supabase functions deploy journeys --no-verify-jwt`
2. 이메일(선택): resend.com 가입 → 도메인(pandasanda.com) 인증 → Edge Function 비밀값 `RESEND_API_KEY`, `EMAIL_FROM`(예: `판다산다 <noreply@pandasanda.com>`). 없으면 푸시만 나감
3. 웹 푸시는 채팅 알림과 같은 VAPID 비밀값을 씀

운영
- 미리보기 (보내지 않음, 운영자 키 필요):
  `curl -X POST <함수 주소>/journeys -H "Authorization: Bearer <service_role 키>" -d '{"dry_run":true}'` · 하나만: `{"dry_run":true,"only":"biz_weekly"}`
- 메시지별 성과 (보냄 → 눌러서 들어옴):
```sql
select s.props->>'journey' as journey, count(*) as sent,
       count(distinct c.profile_id) as clicked,
       round(100.0 * count(distinct c.profile_id) / nullif(count(*), 0), 1) as click_rate
  from marketing_events s
  left join marketing_events c on c.name = 'journey_click' and c.profile_id = s.profile_id
   and c.props->>'journey' = s.props->>'journey' and c.created_at between s.created_at and s.created_at + interval '3 days'
 where s.name = 'journey_sent' and s.created_at > now() - interval '30 days'
 group by 1 order by 2 desc;
```
- 문구는 `supabase/functions/journeys/index.ts` 의 `JOURNEYS`, 대상 조건은 마이그레이션의 `journey_candidates`
- 카카오 알림톡을 붙일 때는 `JOURNEYS` 에 채널을 하나 더 두고 정보성 메시지만 알림톡으로 (광고는 친구톡·브랜드 메시지)

## 검색 유입 자동 페이지 (시세 · 지역 매물 · 주간 지원사업)
`api/seo.js` 가 서버에서 다 그려 내려준다 (Vercel 함수, 로컬 서버에서는 동작하지 않음). 30분 캐시.
- **매물이 3개보다 적은 페이지는 `noindex`**, 사이트맵에도 넣지 않음 (빈 페이지로 검색 품질 점수가 깎이지 않게). 매물이 늘면 자동으로 사이트맵에 들어감
- 시세 품목은 `api/seo.js` 의 `ITEMS` (주소 이름 → 제목에서 찾을 말). 같은 목록이 `js/app.js` 의 `PS.PRICE_ITEMS`(상품 화면 "○○ 시세 보기" 링크)와 `price.html` 칩에 있으니 바꿀 때 같이
- 시세는 판매자가 올린 가격 기준이고, 화면에도 그렇게 적혀 있음 (실거래가 아님)
- 상품 화면 아래 "○○ 시세 보기 · ○○구 매물 더 보기" 링크로 이어짐
- 방문은 `seo_view` 이벤트로 기록 (`kind`: price / area / cat / weekly)

### 매주 월요일 할 일 (5분)
1. `/weekly-card` 열기 → **카드 이미지 저장**
2. 네이버 블로그: 이미지 + "블로그용 복사" 글 / 카페: "카페용 복사" / 카카오톡 채널: 이미지 + "카톡 채널용 복사"
3. 링크에 `utm_source=naver_blog|naver_cafe|kakao_channel`, `utm_campaign=weekly_<월요일 날짜>` 가 붙어 있어 채널별 가입은 `select * from marketing_signups_by_source(30);` 로 확인

## 구해요 (견적 요청)
`rfq.html` (`/rfq` 목록 · `/rfq/new` 올리기 · `/rfq/:id` 상세 · `/rfq?mine=1` 내 요청·보낸 견적) + `supabase/migrations/20261122_rfq.sql` + Edge Function `rfq-push` (Verify JWT 끔).

- 구매자: 찾는 물건을 올림 (14일 열림, 동시에 5건·하루 10건까지, 제목·내용에 전화번호 쓰면 막음)
- 업체(운영 중인 업체 소개가 있는 사람): 견적 1건씩. **무료 30일 3건, 프리미엄 업체가 있으면 무제한** → 다 쓰면 프리미엄 안내
- 구매자 정보는 공개되지 않음. 견적은 구매자와 낸 업체만 보고, **채팅은 구매자만 시작** (첫 메시지에 어떤 요청인지 자동으로 남김)
- 알림: 새 요청 → 같은 분류·지역 업체 주인 30명까지(같은 분류+지역 → 같은 분류 → 같은 지역 순), 새 견적 → 구매자. 웹 푸시
- 들어오는 곳: 홈 띠, 산다에서 검색 결과가 없을 때 "'○○' 구해요 올리고 견적 받기", 마이 › 구해요·받은 견적, 업체 소개 관리
- 쓰기는 모두 함수(`create_rfq`, `submit_quote`, `close_rfq`)로만, 읽기는 `rfq_view`·`my_rfqs`
- 측정: `rfq_create`, `rfq_quote`, `rfq_chat`, `rfq_close`, `rfq_quota_full`(무료 다 씀 → 프리미엄 안내 봄), `rfq_cta`, 서버 `rfq_notified`

운영 확인:
```sql
-- 요청별 알린 업체 수·견적 수 (최근 30일)
select title, category, region, notified_count, quote_count, status, created_at from rfq_requests where created_at > now() - interval '30 days' order by created_at desc;
-- 견적 0건 요청 비율 (업체가 부족한 분류·지역 찾기)
select category, count(*) as requests, count(*) filter (where quote_count = 0) as no_quote from rfq_requests group by 1 order by 2 desc;
```
설정: 마이그레이션 실행 → `supabase functions deploy rfq-push --no-verify-jwt`

### 설비 일괄 처분 (처분해요)
구해요를 뒤집은 것: 공장이 설비 목록·사진(10장)·처분 사유·희망 시기를 올리면 매입 업체가 **매입 제안가**를 보냄. 같은 표(`rfq_requests.kind = 'sell'`)·견적·한도(무료 30일 3건, 프리미엄 무제한)·채팅·알림을 씀. 30일 동안 열림.
- 화면: `/rfq?k=sell`(목록 탭), `/rfq/new?kind=sell`(올리기), 상세는 같은 `/rfq/:id`. 안내 페이지 `/liquidation`(검색 유입용, FAQ 구조화 데이터)
- 들어오는 곳: 판다(물건 올리기) 첫 화면 "공장 정리·이전으로 설비가 많나요?", 마이 › 구해요·처분, 구해요 목록 탭
- SQL: `supabase/migrations/20261123_rfq_sell.sql` (열 추가 + `create_rfq`·`rfq_view`·`my_rfqs` 확장, 예전 호출도 그대로 동작). **SQL 실행 → `rfq-push` 다시 배포 → 사이트 배포** 순서
- 측정: `liquidation_view`, `rfq_create`(kind=sell, reason, photos), `rfq_cta`(from=liquidation_*)
