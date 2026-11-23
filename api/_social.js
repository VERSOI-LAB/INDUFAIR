// 인스타그램·스레드 주간 게시물 (여러 장 슬라이드) — 데이터 모으기 · 표지 문구 고르기 · 슬라이드 그리기 · 캡션
// 목표: 지원사업으로 눈길을 끌고 → 매물 구경 → "나도 팔아 볼까" → 가입
// api/social.js 가 /social/weekly.json(목록·캡션)과 /social/weekly/1.jpg … 를 내려주고, supabase/functions/social-publish 가 올림
var fs = require('fs');
var path = require('path');
var canvas = require('@napi-rs/canvas');
var L = require('./_lib');
var S = require('./seo');

var W = 1080, H = 1350;
var FONT = 'NanumSquareRound';
var C = { yellow: '#FFB800', yellowSoft: '#FFF6DD', navy: '#191F28', text: '#191F28', sub: '#4E5968', hint: '#8B95A1', line: '#E5E8EB', card: '#F7F8FA', red: '#E5443A', redSoft: '#FFF0EF', blue: '#2F5BD3', blueSoft: '#EAF2FE', white: '#FFFFFF' };
// 공장·제조 사장님에게 맞는 공고 고르기 (전체 건수는 그대로, 슬라이드에 크게 보여 줄 것만 고름)
//   3 제조·설비  2 산업·기술(수출·R&D·인증·시설 등)  1.5 분류만 기술·수출  1 일반 기업 지원  0 그 밖(소상공인 생활 지원 등)  -1 농림수산·외식·관광 등 업종이 다른 것
var MFG = /제조|공장|스마트공장|소부장|뿌리|부품|소재|자동화|금형|용접|주조|도금|열처리|산업단지|산단|생산성|공정\s*개선|설비|기계|장비|로봇|공작|가공|금속|화학|섬유|플라스틱|사출|전자부품|반도체|자동차부품|조선|기자재/;
var IND = /산업|기술개발|기술|R&D|연구개발|시제품|인증|특허|지식재산|수출|해외|무역|물류|디지털\s*전환|DX|AI|스마트|에너지|탄소|안전|ESG|시설|생산|품질|판로|바이어|전시회|박람회|혁신|공급망/;
var OFF = /농업|농가|농기계|농산|농촌|농식품|귀농|어업|어로|어촌|수산|축산|가축|임산|산림|양식|비료|퇴비|과수|감귤|원예|화훼|음식점|외식|모범음식|식품위생|관광|숙박|문화예술|공연|체육|반려|미용|전통시장|상점가|골목상권|청년몰|카드수수료|임대료/;
var FIT = /중소기업|중견기업|기업|창업|인력|고용|마케팅|컨설팅|경영/;
function score(p) { var t = p.title || ''; if (OFF.test(t)) return -1; return MFG.test(t) ? 3 : IND.test(t) ? 2 : /^(기술|수출)$/.test(p.category || '') ? 1.5 : FIT.test(t) ? 1 : 0; }
var industrial = function (p) { return score(p) >= 1.5; }; // 제목에 산업 낱말이 있거나 분류가 기술·수출
function pick(list, n, min) { // 맞는 것 먼저(점수 → 원래 순서). min 개보다 적으면 나머지에서 채움
  var good = list.map(function (p, i) { return { p: p, s: score(p), i: i }; }).filter(function (x) { return x.s >= 0; })
    .sort(function (a, b) { return b.s - a.s || a.i - b.i; }).map(function (x) { return x.p; }).slice(0, n);
  return good.length >= (min || n) ? good : good.concat(list.filter(function (p) { return good.indexOf(p) < 0; })).slice(0, min || n);
}
var HASHTAGS = '#정부지원사업 #지원사업 #중소기업 #소상공인 #제조업 #공장 #중고기계 #산업용품 #공구 #판다산다';

// ---- 데이터 ----
function weekNo(isoDate) { // ISO 주 번호 (표지 문구·매물 돌리기용)
  var d = new Date(isoDate + 'T00:00:00Z'), day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  var first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d - first) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
}
function seeded(seed) { var s = seed % 2147483647 || 1; return function () { s = s * 16807 % 2147483647; return (s - 1) / 2147483646; }; }
function dday(end, today) {
  if (!end) return '상시';
  var n = Math.round((Date.parse(end) - Date.parse(today)) / 86400000);
  return n === 0 ? '오늘 마감' : 'D-' + n;
}
var label = function (r) { return r === '전남광주' ? '광주·전남' : (r || '전국'); };
var shortTitle = function (t) { return String(t || '').replace(/^\s*\[[^\]]+\]\s*/, '').replace(/\s*\([^)]*\)\s*/g, ' ').trim(); };

async function collect() {
  var w = await S.weeklyData();
  var got = await Promise.all([
    L.rest('products?select=id,title,price,region,product_images(url,sort_order)&status=in.(selling,reserved)&price=gt.0&order=created_at.desc&limit=200'),
    L.rest('rfq_requests?select=id,kind,title,region,budget,quote_count&status=eq.open&expires_at=gt.' + encodeURIComponent(new Date().toISOString()) + '&order=created_at.desc&limit=6')
  ]);
  var wk = weekNo(w.week.mon);
  var rnd = seeded(wk * 7919 + Number(w.week.mon.slice(0, 4)));
  // 매물: 사진 있는 것 중 매주 다른 4개 (같은 이름 앞부분은 하나만)
  var prods = (got[0] || []).filter(function (p) { return (p.product_images || []).length; })
    .map(function (p) { return { p: p, k: rnd() }; }).sort(function (a, b) { return a.k - b.k; }).map(function (x) { return x.p; });
  var seen = {}, picks = [];
  prods.forEach(function (p) { var key = shortTitle(p.title).split(/\s+/)[0]; if (picks.length < 4 && !seen[key]) { seen[key] = 1; picks.push(p); } });
  // 마감 임박 TOP3: 이번 주 마감 중 산업·제조 관련을 마감 빠른 순으로 먼저, 모자라면 그다음으로 맞는 것
  // 제목이 산업·제조인 것 먼저, 같은 수준이면 마감 빠른 순
  var ind = w.closing.map(function (p, i) { return { p: p, s: score(p), i: i }; }).filter(function (x) { return x.s >= 1.5; })
    .sort(function (a, b) { return b.s - a.s || a.i - b.i; }).map(function (x) { return x.p; });
  var top = ind.slice(0, 3);
  if (top.length < 3) top = top.concat(pick(w.closing.filter(function (p) { return top.indexOf(p) < 0; }), 3 - top.length));
  return { today: w.today, week: w.week, wk: wk, closing: w.closing, top: top, fresh: w.fresh, freshPick: pick(w.fresh, 5, 3),
    closingInd: ind.length, freshInd: w.fresh.filter(industrial).length,
    freshMfg: w.fresh.filter(function (p) { return score(p) >= 3; }).length,
    picks: picks, productCount: (got[0] || []).length, rfq: got[1] || [] };
}

// ---- 표지 문구 (매주 돌아가며, 숫자가 있을 때만) ----
function hooks(d) {
  var list = [];
  // 숫자는 산업·제조 관련 공고 기준 (공장·제조 사장님이 볼 것만)
  if (d.closingInd >= 3) list.push({ key: 'closing', lines: ['사장님, 이번 주', '산업 지원금 ' + d.closingInd + '건이', '마감됩니다'], hi: 1, sub: '놓치기 전에 넘겨서 확인하세요', sticker: 'sell' });
  if (d.freshInd >= 5) list.push({ key: 'fresh', lines: ['이번 주 새로 나온', '제조·산업 지원사업', d.freshInd + '건'], hi: 2, sub: '우리 공장에 맞는 건 몇 개일까?', sticker: 'curious' });
  if (d.picks.length >= 2) list.push({ key: 'idle', lines: ['공장 구석', '안 쓰는 장비,', '돈이 됩니다'], hi: 2, sub: '사진 한 장이면 판매 등록 끝', sticker: 'carry' });
  if (d.closingInd >= 1) list.push({ key: 'top3', lines: ['모르면 손해 보는', '이번 주 산업 지원금', 'TOP 3'], hi: 2, sub: '제조·산업 공고를 마감 순으로 골랐어요', sticker: 'checking' });
  if (!list.length) list.push({ key: 'basic', lines: ['팔 땐 판다,', '살 땐 산다'], hi: 1, sub: '공장 사장님을 위한 산업용품 직거래', sticker: 'hello' });
  return list[d.wk % list.length];
}

// ---- 슬라이드 목록 ----
function plan(d) {
  var s = ['cover'];
  if (d.closing.length) s.push('top3');
  if (d.fresh.length) s.push('fresh');
  if (d.rfq.length) s.push('wanted');
  if (d.picks.length >= 2) s.push('picks');
  s.push('seller', 'join');
  return s;
}

// ---- 캡션 ----
function captions(d, h, slides) {
  var utm = function (src) { return '?utm_source=' + src + '&utm_medium=social&utm_campaign=weekly_' + d.week.mon; };
  var top = d.top.map(function (p) { return '· [' + dday(p.apply_end, d.today) + '] ' + shortTitle(p.title); });
  var hookLine = h.lines.join(' ').replace(/\s+/g, ' ');
  var body = [
    '📢 ' + hookLine,
    '👉 넘겨서 보세요 (' + slides.length + '장)',
    '',
    top.length ? '이번 주 마감 임박 산업·제조 지원금' : '', top.join('\n'),
    top.length ? '' : '',
    d.picks.length >= 2 ? '🛒 이번 주 판다산다 픽: ' + d.picks.slice(0, 3).map(function (p) { return shortTitle(p.title).split(/\s+/).slice(0, 3).join(' '); }).join(', ') : '',
    '🏭 공장에 잠든 장비, 사진 한 장으로 판매 등록하세요 (등록 무료)',
    ''
  ];
  var join = ['판다산다 가입하면 (30초)', '✔ 우리 회사 맞춤 지원금 마감 알림', '✔ 사진 한 장으로 산업용품 판매 등록', '✔ 찾는 물건은 "구해요"로 업체 견적'];
  var instagram = body.concat(join, ['', '가입·전체 목록은 프로필 링크 👉 @panda_sanda_', '', HASHTAGS]).filter(function (x, i, a) { return x !== '' || a[i - 1] !== ''; }).join('\n');
  var tLink = '\n\n30초 가입 👉 https://www.pandasanda.com/' + utm('threads');
  var threads = ['📢 ' + hookLine, ''].concat(top.slice(0, 3), ['', '공장에 잠든 장비는 사진 한 장으로 판매 등록, 지원금은 맞춤 알림으로.']).join('\n');
  if ((threads + tLink).length > 500) threads = threads.slice(0, 500 - tLink.length - 1) + '…';
  return { instagram: instagram.slice(0, 2200), threads: threads + tLink };
}

async function manifest() {
  var d = await collect();
  var h = hooks(d), slides = plan(d);
  return { week: d.week, hook: h.key, slides: slides, captions: captions(d, h, slides), counts: { closing: d.closing.length, fresh: d.fresh.length, picks: d.picks.length, products: d.productCount, rfq: d.rfq.length } };
}

// ---- 그리기 도구 ----
var ready = false;
function fonts() {
  if (ready) return;
  ['R', 'B', 'EB'].forEach(function (w) { canvas.GlobalFonts.registerFromPath(path.join(process.cwd(), 'fonts', 'NanumSquareRound' + w + '.woff2'), FONT); });
  ready = true;
}
var F = function (w, px) { return w + ' ' + px + 'px ' + FONT; };
function rr(x, a, b, w, h, r) { x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath(); }
function fit(x, t, max) { t = String(t || ''); if (x.measureText(t).width <= max) return t; while (t.length && x.measureText(t + '…').width > max) t = t.slice(0, -1); return t + '…'; }
function wrap(x, t, max, n) { // 낱말 단위로 n 줄까지 (넘치면 마지막 줄 끝 …). 한 낱말이 한 줄보다 길면 글자 단위로
  var words = String(t || '').split(/\s+/).filter(Boolean), out = [], cur = '';
  for (var i = 0; i < words.length; i++) {
    var next = cur ? cur + ' ' + words[i] : words[i];
    if (x.measureText(next).width <= max) { cur = next; continue; }
    if (!cur) { // 낱말 하나가 너무 김
      var w = words[i], k = w.length; while (k > 1 && x.measureText(w.slice(0, k)).width > max) k--;
      out.push(w.slice(0, k)); words.splice(i + 1, 0, w.slice(k)); cur = '';
    } else { out.push(cur); cur = words[i]; }
    if (out.length === n - 1) { out.push(fit(x, [cur].concat(words.slice(i + 1)).join(' '), max)); return out; }
  }
  if (cur) out.push(cur);
  return out.slice(0, n);
}
var stickerCache = {};
async function sticker(name) {
  // 파일을 먼저 읽어서 넘김 (한글 폴더 이름을 주소로 오해하지 않게)
  if (!stickerCache[name]) stickerCache[name] = await canvas.loadImage(fs.readFileSync(path.join(process.cwd(), '이미지', 'stickers', name + '.webp')));
  return stickerCache[name];
}
async function remote(url) {
  try {
    // 매물 사진이 사이트 안 주소(/img/...)면: 함께 배포된 파일이 있으면 그걸, 없으면 사이트 전체 주소로
    if (/^\/[^/]/.test(url)) {
      try { return await canvas.loadImage(fs.readFileSync(path.join(process.cwd(), decodeURI(url.split('?')[0])))); } catch (e) {}
      url = L.absUrl(url);
    }
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 6000);
    var r = await fetch(url, { signal: ctl.signal }); clearTimeout(t);
    if (!r.ok) return null;
    return await canvas.loadImage(Buffer.from(await r.arrayBuffer()));
  } catch (e) { return null; }
}
// 제품 사진의 흰 여백을 잘라 냄 (흰색·투명이 아닌 픽셀이 있는 범위만 남김)
function trimWhite(img) {
  var w = img.width, h = img.height;
  if (!w || !h) return img;
  var c = canvas.createCanvas(w, h), g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  var px = g.getImageData(0, 0, w, h).data, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (var y = 0; y < h; y += 2) for (var x = 0; x < w; x += 2) {
    var i = (y * w + x) * 4;
    if (px[i + 3] > 24 && (px[i] < 238 || px[i + 1] < 238 || px[i + 2] < 238)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0 || (x1 - x0) * (y1 - y0) > w * h * 0.95) return img; // 다 흰색이거나 여백이 거의 없으면 그대로
  var m = Math.round(Math.max(x1 - x0, y1 - y0) * 0.04); // 살짝 숨 쉴 여백
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
  var out = canvas.createCanvas(x1 - x0 + 1, y1 - y0 + 1);
  out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}
function cover(x, img, a, b, w, h) { // 사진을 칸에 꽉 차게 (가운데 자르기)
  var k = Math.max(w / img.width, h / img.height), sw = w / k, sh = h / k;
  x.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, a, b, w, h);
}
async function drawSticker(x, name, cx, cy, size, disc) {
  var img = await sticker(name);
  if (disc) { x.fillStyle = disc; x.beginPath(); x.arc(cx, cy, size * 0.56, 0, Math.PI * 2); x.fill(); }
  var k = size / Math.max(img.width, img.height);
  x.drawImage(img, cx - img.width * k / 2, cy - img.height * k / 2, img.width * k, img.height * k);
}
function header(x, n, total, dark) { // 위쪽: 브랜드 + 쪽 번호
  x.font = F(800, 30); x.fillStyle = dark ? C.yellow : C.text; x.textAlign = 'left'; x.fillText('판다산다', 72, 92);
  x.font = F(700, 26); x.fillStyle = dark ? 'rgba(255,255,255,.6)' : C.hint; x.textAlign = 'right'; x.fillText(n + ' / ' + total, W - 72, 92); x.textAlign = 'left';
}
function chip(x, text, a, b, bg, fg) {
  x.font = F(800, 28); var w = x.measureText(text).width + 40;
  x.fillStyle = bg; rr(x, a, b, w, 52, 26); x.fill(); x.fillStyle = fg; x.fillText(text, a + 20, b + 36); return w;
}
function footer(x, text, dark) {
  x.fillStyle = dark ? 'rgba(255,255,255,.08)' : C.card; x.fillRect(0, H - 110, W, 110);
  x.font = F(700, 30); x.fillStyle = dark ? C.white : C.sub; x.textAlign = 'center'; x.fillText(text, W / 2, H - 46); x.textAlign = 'left';
}

// ---- 슬라이드 ----
var DRAW = {
  cover: async function (x, d, h, n, total) {
    x.fillStyle = C.yellow; x.fillRect(0, 0, W, H);
    // 배경 무늬: 큰 원
    x.fillStyle = 'rgba(255,255,255,.22)'; x.beginPath(); x.arc(W - 120, H - 300, 420, 0, Math.PI * 2); x.fill();
    x.font = F(800, 30); x.fillStyle = C.text; x.fillText('판다산다 주간 브리핑', 72, 120);
    chip(x, d.week.label, 72, 150, C.navy, C.yellow);
    var size = h.lines.length > 2 ? 118 : 140, y = 380;
    h.lines.forEach(function (l, i) {
      x.font = F(800, size);
      if (i === h.hi) { // 강조 줄: 남색 띠 위 노란 글씨
        var tw = x.measureText(l).width;
        x.fillStyle = C.navy; rr(x, 60, y - size + 14, tw + 36, size + 18, 18); x.fill();
        x.fillStyle = C.yellow; x.fillText(l, 78, y);
      } else { x.fillStyle = C.text; x.fillText(l, 72, y); }
      y += size + 36;
    });
    x.font = F(700, 40); x.fillStyle = C.text; x.fillText(h.sub, 72, y + 30);
    await drawSticker(x, h.sticker, W - 270, H - 330, 460, null);
    // 넘겨 보기
    x.fillStyle = C.navy; rr(x, 72, H - 170, 330, 84, 42); x.fill();
    x.font = F(800, 34); x.fillStyle = C.white; x.fillText('넘겨서 보기  →', 108, H - 115);
  },
  top3: async function (x, d, h, n, total) {
    x.fillStyle = C.white; x.fillRect(0, 0, W, H); header(x, n, total);
    chip(x, '마감 임박', 72, 140, C.redSoft, C.red);
    x.font = F(800, 64); x.fillStyle = C.text; x.fillText('이번 주 꼭 볼 산업 지원금', 72, 280);
    await drawSticker(x, 'checking', W - 150, 190, 200, null);
    var y = 330;
    d.top.forEach(function (p, i) {
      x.fillStyle = C.card; rr(x, 60, y, W - 120, 270, 28); x.fill();
      x.font = F(800, 90); x.fillStyle = C.yellow; x.fillText(String(i + 1), 96, y + 120);
      var dd = dday(p.apply_end, d.today);
      x.font = F(800, 30); var pw = x.measureText(dd).width + 36;
      x.fillStyle = C.red; rr(x, 190, y + 44, pw, 50, 14); x.fill(); x.fillStyle = C.white; x.fillText(dd, 208, y + 79);
      x.font = F(800, 42); x.fillStyle = C.text;
      wrap(x, shortTitle(p.title), W - 120 - 170 - 40, 2).forEach(function (l, k) { x.fillText(l, 190, y + 150 + k * 54); });
      x.font = F(400, 28); x.fillStyle = C.hint; x.fillText(fit(x, [p.category, label(p.region), p.agency].filter(Boolean).join(' · '), W - 330), 190, y + 246);
      y += 294;
    });
    footer(x, d.closingInd >= d.top.length ? '이번 주 마감 산업·제조 공고 ' + d.closingInd + '건 · 전체는 프로필 링크에서' : '이번 주 마감 공고 ' + d.closing.length + '건 전체는 프로필 링크에서');
  },
  fresh: async function (x, d, h, n, total) {
    x.fillStyle = C.white; x.fillRect(0, 0, W, H); header(x, n, total);
    chip(x, 'NEW', 72, 140, C.blueSoft, C.blue);
    x.font = F(800, 64); x.fillStyle = C.text; x.fillText('새로 나온 지원사업', 72, 280);
    x.font = F(700, 38); x.fillStyle = C.sub; x.fillText('지난 일주일 산업·제조 관련 ' + d.freshInd + '건' + (d.freshMfg ? ' (제조·설비 ' + d.freshMfg + '건)' : ''), 72, 340);
    await drawSticker(x, 'searching', W - 160, 220, 230, null);
    var y = 400, COL = 200, tx = 72 + COL, tw = W - 72 - tx;
    d.freshPick.forEach(function (p, i) {
      if (y > 1060) return;
      var sc = score(p), mfg = sc >= 3, tag = mfg ? '제조·설비' : sc >= 1.5 ? '산업·기술' : (p.category || '지원');
      if (i) { x.strokeStyle = C.line; x.lineWidth = 2; x.beginPath(); x.moveTo(72, y); x.lineTo(W - 72, y); x.stroke(); }
      x.font = F(800, 26); var cw = Math.min(COL - 24, x.measureText(tag).width + 32);
      x.fillStyle = mfg ? C.yellowSoft : C.card; rr(x, 72, y + 30, cw, 46, 23); x.fill();
      x.fillStyle = mfg ? '#8A6400' : C.sub; x.textAlign = 'center'; x.fillText(tag, 72 + cw / 2, y + 62); x.textAlign = 'left';
      x.font = F(800, 38); x.fillStyle = C.text;
      var lines = wrap(x, shortTitle(p.title), tw, 2);
      lines.forEach(function (l, k) { x.fillText(l, tx, y + 66 + k * 50); });
      x.font = F(400, 26); x.fillStyle = C.hint;
      x.fillText(fit(x, label(p.region) + ' · ' + dday(p.apply_end, d.today) + (p.agency ? ' · ' + p.agency : ''), tw), tx, y + 66 + lines.length * 50 + 8);
      y += 66 + lines.length * 50 + 46;
    });
    footer(x, '우리 회사 맞춤 공고만 골라 받기 → 프로필 링크');
  },
  wanted: async function (x, d, h, n, total) {
    x.fillStyle = C.white; x.fillRect(0, 0, W, H); header(x, n, total);
    chip(x, '구해요 · 처분해요', 72, 140, C.yellowSoft, '#8A6400');
    x.font = F(800, 64); x.fillStyle = C.text; x.fillText('지금 이걸 찾는 사람이', 72, 280); x.fillText('있어요', 72, 360);
    await drawSticker(x, 'inquiry', W - 170, 260, 260, null);
    var y = 430;
    d.rfq.slice(0, 4).forEach(function (r) {
      x.fillStyle = C.card; rr(x, 60, y, W - 120, 170, 24); x.fill();
      chip(x, r.kind === 'sell' ? '처분해요' : '구해요', 96, y + 30, r.kind === 'sell' ? C.redSoft : C.blueSoft, r.kind === 'sell' ? C.red : C.blue);
      x.font = F(800, 40); x.fillStyle = C.text; x.fillText(fit(x, r.title, W - 240), 96, y + 126);
      y += 196;
    });
    footer(x, '업체라면 견적을 보내 보세요 → 프로필 링크');
  },
  picks: async function (x, d, h, n, total) {
    x.fillStyle = C.white; x.fillRect(0, 0, W, H); header(x, n, total);
    chip(x, '이번 주 판다산다 픽', 72, 140, C.yellow, C.text);
    x.font = F(800, 64); x.fillStyle = C.text; x.fillText('지금 판매 중인 물건', 72, 280);
    var picks = d.picks.slice(0, 4), cw = 456, chh = 330, gap = 24, x0 = 72, y0 = 330;
    var imgs = await Promise.all(picks.map(function (p) { var im = (p.product_images || []).slice().sort(function (a, b) { return a.sort_order - b.sort_order; })[0]; return im ? remote(im.url) : null; }));
    picks.forEach(function (p, i) {
      var cx = x0 + (i % 2) * (cw + gap), cy = y0 + Math.floor(i / 2) * (chh + 120);
      x.save(); rr(x, cx, cy, cw, chh, 24); x.clip();
      x.fillStyle = C.white; x.fillRect(cx, cy, cw, chh);
      if (imgs[i]) { // 제품 사진은 흰 바탕이 많아서 잘리지 않게 칸 안에 맞춤
        var im = trimWhite(imgs[i]), pad = 28, k = Math.min((cw - pad * 2) / im.width, (chh - pad * 2) / im.height);
        x.drawImage(im, cx + (cw - im.width * k) / 2, cy + (chh - im.height * k) / 2, im.width * k, im.height * k);
      }
      else { x.font = F(700, 28); x.fillStyle = C.hint; x.textAlign = 'center'; x.fillText('사진', cx + cw / 2, cy + chh / 2 + 10); x.textAlign = 'left'; }
      x.restore();
      x.strokeStyle = C.line; x.lineWidth = 2; rr(x, cx, cy, cw, chh, 24); x.stroke();
      x.font = F(700, 30); x.fillStyle = C.text; x.fillText(fit(x, shortTitle(p.title), cw), cx, cy + chh + 44);
      x.font = F(800, 34); x.fillStyle = C.text; x.fillText(L.won(p.price), cx, cy + chh + 88);
    });
    footer(x, '판다산다에서 판매자와 바로 채팅으로 거래');
  },
  seller: async function (x, d, h, n, total) {
    x.fillStyle = C.yellowSoft; x.fillRect(0, 0, W, H); header(x, n, total);
    x.font = F(800, 92); x.fillStyle = C.text; x.fillText('공장에 잠든 장비,', 72, 250);
    x.fillStyle = C.navy; x.font = F(800, 92); var tw = x.measureText('돈이 됩니다').width;
    rr(x, 60, 280, tw + 36, 112, 18); x.fill(); x.fillStyle = C.yellow; x.fillText('돈이 됩니다', 78, 368);
    var steps = [['사진 한 장 찍기', '휴대폰으로 찰칵'], ['AI가 이름·시세 찾기', '무슨 물건인지, 얼마쯤인지'], ['가격 쓰면 등록 끝', '사려는 사람이 채팅으로 연락']];
    var y = 470;
    steps.forEach(function (s, i) {
      x.fillStyle = C.white; rr(x, 60, y, 680, 150, 26); x.fill();
      x.fillStyle = C.yellow; x.beginPath(); x.arc(130, y + 75, 42, 0, Math.PI * 2); x.fill();
      x.font = F(800, 44); x.fillStyle = C.text; x.textAlign = 'center'; x.fillText(String(i + 1), 130, y + 91); x.textAlign = 'left';
      x.font = F(800, 40); x.fillStyle = C.text; x.fillText(s[0], 200, y + 70);
      x.font = F(400, 28); x.fillStyle = C.sub; x.fillText(s[1], 200, y + 114);
      y += 174;
    });
    await drawSticker(x, 'carry', W - 200, 820, 380, null);
    chip(x, '등록 무료', 72, y + 20, C.navy, C.yellow);
    x.font = F(700, 32); x.fillStyle = C.sub; x.fillText('공구·부품부터 중고 기계까지', 270, y + 57);
    footer(x, '판매 등록은 프로필 링크 → 판다(판매하기)');
  },
  join: async function (x, d, h, n, total) {
    x.fillStyle = C.navy; x.fillRect(0, 0, W, H); header(x, n, total, true);
    x.font = F(800, 76); x.fillStyle = C.white; x.fillText('30초 가입하면', 72, 250);
    x.fillStyle = C.yellow; x.fillText('이렇게 달라져요', 72, 344);
    var items = [['우리 회사 맞춤 지원금', '마감 3일 전에 알림으로'], ['사진 한 장으로 판매', 'AI가 이름·시세까지'], ['찾는 물건은 "구해요"', '업체들이 견적을 보내 줘요']];
    var y = 400;
    items.forEach(function (it) {
      x.fillStyle = 'rgba(255,255,255,.08)'; rr(x, 60, y, W - 120, 150, 26); x.fill();
      x.fillStyle = C.yellow; x.beginPath(); x.arc(126, y + 75, 32, 0, Math.PI * 2); x.fill();
      x.strokeStyle = C.navy; x.lineWidth = 8; x.lineCap = 'round'; x.beginPath(); x.moveTo(110, y + 76); x.lineTo(122, y + 88); x.lineTo(144, y + 62); x.stroke();
      x.font = F(800, 42); x.fillStyle = C.white; x.fillText(it[0], 186, y + 70);
      x.font = F(400, 30); x.fillStyle = 'rgba(255,255,255,.7)'; x.fillText(it[1], 186, y + 114);
      y += 166;
    });
    x.fillStyle = C.yellow; rr(x, 60, y + 56, 640, 120, 60); x.fill();
    x.font = F(800, 42); x.fillStyle = C.text; x.fillText('프로필 링크 → 무료 가입', 104, y + 132);
    await drawSticker(x, 'hello', W - 190, y + 124, 230, C.white);
    x.font = F(700, 28); x.fillStyle = 'rgba(255,255,255,.6)'; x.textAlign = 'center'; x.fillText('pandasanda.com · 팔 땐 판다, 살 땐 산다', W / 2, H - 56); x.textAlign = 'left';
  }
};

async function render(name, d, h, slides) {
  fonts();
  var cv = canvas.createCanvas(W, H), x = cv.getContext('2d');
  var n = slides.indexOf(name) + 1;
  await DRAW[name](x, d, h, n, slides.length);
  return cv.toBuffer('image/jpeg', 90);
}

// n 번째(1부터) 슬라이드 그리기
async function slide(n) {
  var d = await collect(), h = hooks(d), slides = plan(d);
  var name = slides[n - 1];
  if (!name) return null;
  return render(name, d, h, slides);
}

module.exports = { collect: collect, hooks: hooks, plan: plan, captions: captions, manifest: manifest, render: render, slide: slide, DRAW: DRAW };
