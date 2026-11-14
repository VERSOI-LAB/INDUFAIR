# 판다산다 (PANDASANDA)

산업용품 거래를 당근마켓처럼 쉽게 — **판다** · **산다** · 끝.

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
