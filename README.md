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

공용: `app.css`(디자인 토큰), `js/app.js`(로그인 상태·탭바·포맷), `js/supabase-client.js`.

## DB
`supabase/migrations/20261002_pandasanda_simple_market.sql` 을 Supabase SQL Editor 에서 한 번 실행하세요.
(9개 카테고리, products 단순화, chats/messages + RLS + 실시간, 찜/채팅 수 자동 집계)

## 로컬 실행
```bash
python3 dev-server.py   # http://localhost:8743 (vercel.json 의 clean URL 흉내)
```
