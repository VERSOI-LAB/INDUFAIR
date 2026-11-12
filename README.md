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
| `/pay-seller` | `pay-seller.html` | 안전결제 판매자 신청 (사업자 인증 + 통신판매업 신고 확인) |

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
