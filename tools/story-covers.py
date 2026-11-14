# 이야기 글 표지(카드뉴스) 만들기: 주제 사진 + 어둡게 + 큰 한 줄 문구
import sys, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance

SRC = sys.argv[1]   # 이미지/community
OUT = sys.argv[2]   # 이미지/community/cover
os.makedirs(OUT, exist_ok=True)
FONT = '/System/Library/Fonts/AppleSDGothicNeo.ttc'
heavy = lambda s: ImageFont.truetype(FONT, s, index=16)
bold = lambda s: ImageFont.truetype(FONT, s, index=6)
semi = lambda s: ImageFont.truetype(FONT, s, index=4)

YELLOW = (245, 185, 66)
S = 1080

# id: (사진, 칩, 큰 문구, 강조할 줄 번호, 아랫줄)
POSTS = {
    7:  ('planner.jpg', '지원사업 꿀팁', ['마감 하루 지나서', '알았다면?'], 1, '마감 1·3·7일 전 알림 받는 법'),
    8:  ('cordless-drill.jpg', '공구 관리', ['배터리 수명,', '습관이 갈라요'], 1, '오래 쓰는 현장의 5가지 습관'),
    9:  ('air-compressor.jpg', '사기 전 필독', ['중고 컴프레셔', '체크리스트 7'], 1, '이것 안 보고 사면 후회해요'),
    10: ('used-machine.jpg', '시세 물어보기', ['창고 속 장비,', '얼마 받을까?'], 1, '한 줄로 먼저 물어보세요'),
    11: ('handshake.jpg', '추천 받아요', ['우리 동네', '수리·가공 맛집'], 1, '"여기 진짜 잘해요" 공유해요'),
    12: ('checklist.jpg', '작성 꿀팁', ['답 빨리 오는', '구해요 글 4줄'], 1, '찾는 것 · 지역 · 수량 · 일정'),
    13: ('tool-wall.jpg', '자랑 대회', ['공구 정리', '끝판왕은?'], 1, '우리 현장 사진 한 장 올려요'),
    14: ('winter-site.jpg', '겨울 현장 안전', ['영하의 아침,', '바로 돌리면 안 돼요'], 1, '겨울 현장 체크리스트 4'),
    15: ('factory-team.jpg', '한 줄 인사', ['다들 어디서', '무슨 일 하세요?'], 1, '동네 · 업종 · 오늘 점심'),
    16: ('documents.jpg', '경험 나눠요', ['서류 앞에서', '멈춘 적 있죠?'], 1, '지원사업 신청 경험담 모아요'),
    17: ('ideas.jpg', '기능 투표', ['판다산다에', '딱 하나 더한다면?'], 1, '댓글로 한 표 주세요'),
    18: ('machine-check.jpg', '노하우 모아요', ['중고 장비,', '어디부터 보세요?'], 1, '아워미터? 소리? 오일?'),
}

def cover(src):
    im = Image.open(src).convert('RGB')
    w, h = im.size; s = min(w, h)
    im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s)).resize((S, S), Image.LANCZOS)
    im = ImageEnhance.Color(im).enhance(0.85)
    # 아래로 갈수록 어둡게 (글씨가 잘 보이게)
    shade = Image.new('L', (S, S))
    d = ImageDraw.Draw(shade)
    for y in range(S):
        t = y / S
        a = int(70 + 175 * max(0, (t - 0.25) / 0.75) ** 1.2) if t > 0.25 else 70
        d.line([(0, y), (S, y)], fill=min(a, 235))
    black = Image.new('RGB', (S, S), (12, 14, 18))
    return Image.composite(black, im, shade)

def fit(draw, lines, maxw, start):
    size = start
    while size > 40:
        f = heavy(size)
        if all(draw.textlength(l, font=f) <= maxw for l in lines): return f, size
        size -= 4
    return heavy(size), size

for pid, (photo, chip, lines, hi, sub) in POSTS.items():
    im = cover(os.path.join(SRC, photo))
    dr = ImageDraw.Draw(im)
    M = 76
    f, size = fit(dr, lines, S - 2 * M, 118)
    lh = int(size * 1.18)
    subf = semi(42)
    chipf = bold(36)
    # 아래에서 위로 쌓기: 아랫줄 → 큰 문구 → 칩
    SAFE = 150  # PC 에서 4:3 으로 잘려도 보이게 (위아래 135px 잘림)
    y_sub = S - SAFE - 46
    y_text = y_sub - 34 - lh * len(lines)
    y_chip = y_text - 30 - 64
    # 칩
    cw = dr.textlength(chip, font=chipf) + 48
    dr.rounded_rectangle([M, y_chip, M + cw, y_chip + 64], radius=32, fill=YELLOW)
    dr.text((M + 24, y_chip + 32), chip, font=chipf, fill=(20, 20, 20), anchor='lm')
    # 큰 문구 (강조 줄은 노란색)
    for i, l in enumerate(lines):
        dr.text((M + 3, y_text + i * lh + 4), l, font=f, fill=(0, 0, 0))  # 살짝 그림자
        dr.text((M, y_text + i * lh), l, font=f, fill=YELLOW if i == hi else (255, 255, 255))
    # 아랫줄
    dr.text((M, y_sub), sub, font=subf, fill=(225, 228, 233))
    # 브랜드
    bf = bold(30)
    dr.text((S - M, SAFE), '판다산다 이야기', font=bf, fill=(255, 255, 255), anchor='ra')
    out = os.path.join(OUT, '%d.jpg' % pid)
    im.save(out, 'JPEG', quality=86, optimize=True, progressive=True)
    print(out, os.path.getsize(out) // 1024, 'KB', 'font', size)
