// /support/weekly.jpg — 이번 주 지원사업 카드 이미지 (1080×1350 JPEG, 인스타 4:5)
// 인스타그램·스레드 자동 발행(supabase/functions/social-publish)이 이 주소를 그대로 넘긴다 (인스타는 공개 주소의 JPEG 만 받음)
// 그림은 weekly-card.html(운영자가 손으로 저장하는 카드)과 같은 배치. 데이터는 /support/weekly 와 같음 (api/seo.js 의 weeklyData)
var path = require('path');
var canvas = require('@napi-rs/canvas');
var S = require('./seo');

var FONT = 'NanumSquareRound';
var fontsReady = false;
function loadFonts() {
  if (fontsReady) return;
  ['R', 'B', 'EB'].forEach(function (w) {
    canvas.GlobalFonts.registerFromPath(path.join(process.cwd(), 'fonts', 'NanumSquareRound' + w + '.woff2'), FONT);
  });
  fontsReady = true;
}

var label = function (r) { return r === '전남광주' ? '광주·전남' : (r || '전국'); };
function dday(p, today) {
  if (!p.apply_end) return '상시';
  var n = Math.round((Date.parse(p.apply_end) - Date.parse(today)) / 86400000);
  return n === 0 ? '오늘 마감' : 'D-' + n;
}
function fit(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  while (text.length && ctx.measureText(text + '…').width > max) text = text.slice(0, -1);
  return text + '…';
}
function wrap2(ctx, text, max) {
  for (var i = 1; i <= text.length; i++) {
    if (ctx.measureText(text.slice(0, i)).width > max) return [text.slice(0, i - 1), fit(ctx, text.slice(i - 1), max)];
  }
  return [text];
}
function pill(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function draw(data) {
  loadFonts();
  var W = 1080, H = 1350, P = 72;
  var cv = canvas.createCanvas(W, H), ctx = cv.getContext('2d');
  var F = function (w, px) { return w + ' ' + px + 'px ' + FONT; };
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);
  // 머리
  ctx.fillStyle = '#FFB800'; ctx.fillRect(0, 0, W, 330);
  ctx.fillStyle = '#191F28';
  ctx.font = F(800, 36); ctx.fillText('판다산다 지원사업 브리핑', P, 104);
  ctx.font = F(800, 76); ctx.fillText(data.week.label + ' 마감 임박', P, 200);
  ctx.font = F(700, 34); ctx.fillText(data.week.range + ' · 마감 ' + data.closing.length + '건 · 새 공고 ' + data.fresh.length + '건', P, 268);
  // 목록
  var list = data.closing.slice(0, 7), y = 390, drawn = 0;
  if (!list.length) { ctx.font = F(700, 40); ctx.fillStyle = '#4E5968'; ctx.fillText('이번 주 마감 공고가 없어요', P, y + 60); }
  list.forEach(function (p) {
    if (y > 1060) return; // 바닥 띠와 겹치지 않게 (두 줄 제목 + 기관 줄이 들어갈 자리가 있을 때만)
    drawn++;
    var d = dday(p, data.today), soon = d === '오늘 마감' || (/^D-\d+$/.test(d) && Number(d.slice(2)) <= 3);
    ctx.font = F(800, 30);
    var pw = Math.max(120, ctx.measureText(d).width + 36);
    ctx.fillStyle = soon ? '#FFF0EF' : '#EAF2FE'; pill(ctx, P, y, pw, 52, 12); ctx.fill();
    ctx.fillStyle = soon ? '#E5443A' : '#2F5BD3'; ctx.textAlign = 'center'; ctx.fillText(d, P + pw / 2, y + 37); ctx.textAlign = 'left';
    ctx.fillStyle = '#191F28'; ctx.font = F(700, 36);
    var tx = P + pw + 24, tw = W - tx - P;
    var lines = wrap2(ctx, p.title, tw);
    lines.forEach(function (l, i) { ctx.fillText(l, tx, y + 38 + i * 46); });
    ctx.fillStyle = '#8B95A1'; ctx.font = F(400, 27);
    ctx.fillText(fit(ctx, [p.category, label(p.region), p.agency].filter(Boolean).join(' · '), tw), tx, y + 38 + lines.length * 46 + 4);
    y += 38 + lines.length * 46 + 48;
  });
  if (data.closing.length > drawn) { ctx.fillStyle = '#4E5968'; ctx.font = F(700, 30); ctx.fillText('외 ' + (data.closing.length - drawn) + '건 더', P, Math.min(y + 10, 1170)); }
  // 바닥
  ctx.fillStyle = '#191F28'; ctx.fillRect(0, H - 150, W, 150);
  ctx.fillStyle = '#FFFFFF'; ctx.font = F(800, 38); ctx.fillText('우리 회사 맞춤 공고 30초 진단', P, H - 86);
  ctx.fillStyle = '#FFB800'; ctx.font = F(700, 30); ctx.fillText('pandasanda.com/support/weekly', P, H - 40);
  return cv.toBuffer('image/jpeg', 90);
}

module.exports = async function (req, res) {
  try {
    var data = await S.weeklyData();
    var jpg = draw(data);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', jpg.length);
    // ?v=날짜 를 붙이면 새로 그림. 같은 주소는 30분 캐시
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600');
    res.status(200).send(jpg);
  } catch (e) {
    console.error('weekly-image', e);
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).send('image error');
  }
};
module.exports.draw = draw;
