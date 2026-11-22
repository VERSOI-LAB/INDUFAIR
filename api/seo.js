// 검색 유입용 자동 페이지 (서버에서 다 그려서 내려줌, 화면 스크립트는 탭바·하단 정보만)
//   /price/:item                 품목별 시세 (예: /price/에어콤프레샤) — 판다산다에 올라온 등록 가격 기준
//   /buy/c/:cat                  카테고리별 매물
//   /buy/area/:area[/:cat]       지역(시·군·구)별 매물 (예: /buy/area/분당구/산업기계)
//   /support/weekly              이번 주 마감 지원사업 (블로그·카톡 채널에 매주 공유하는 주소)
// 매물이 3개보다 적은 페이지는 noindex (빈 페이지로 검색 품질 점수가 깎이지 않게), 사이트맵에도 넣지 않음
var L = require('./_lib');

var MIN_INDEX = 3;
var CATS = ['중고장터', '산업기계', '공구·부품', '자동화·전기', '물류·창고'];
// 품목 시세: 주소에 쓰는 이름 → 제목에서 찾을 말 (흔한 다른 표기 포함)
var ITEMS = {
  '에어콤프레샤': ['콤프레샤', '컴프레서', '콤프레서', '컴프레샤'],
  '집진기': ['집진기'],
  '모터': ['모터'],
  '서보모터': ['서보모터', '서보 모터'],
  '감속기': ['감속기'],
  '인버터': ['인버터'],
  'PLC': ['PLC'],
  '펌프': ['펌프'],
  '지게차': ['지게차'],
  '핸드파레트': ['핸드파레트', '핸드자키', '핸드 파레트', '핸드파렛트'],
  '용접기': ['용접기'],
  '선반(공작기계)': ['범용선반', 'CNC선반', 'CNC 선반', '선반기'],
  '밀링': ['밀링'],
  '호이스트': ['호이스트'],
  '그라인더': ['그라인더', '연삭기'],
  '레귤레이터': ['레귤레이터'],
  '에어실린더': ['실린더'],
  '발전기': ['발전기'],
  '칠러': ['칠러', '냉각기'],
  '컨베이어': ['컨베이어', '콘베어', '컨베어']
};
var COLS = 'id,title,price,region,status,condition,usage_period,created_at,product_images(url,sort_order)';

var priceUrl = function (item) { return '/price/' + encodeURIComponent(item); };
var catUrl = function (c) { return '/buy/c/' + encodeURIComponent(c); };
var areaUrl = function (a, c) { return '/buy/area/' + encodeURIComponent(a) + (c ? '/' + encodeURIComponent(c) : ''); };
// "성남시 분당구 정자동" → ["성남시", "분당구"]  (시·군·구만)
function areaTokens(region) {
  return String(region || '').split(/\s+/).filter(function (w) { return /^[가-힣]{1,6}(시|군|구)$/.test(w) && !/^(특별|광역)/.test(w); });
}
var man = function (n) { return Math.max(10000, Math.round(n / 10000) * 10000); };
var kstToday = function () { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); };
function ilikeAny(words) {
  return 'or=(' + words.map(function (w) { return 'title.ilike.*' + encodeURIComponent(w.replace(/[*,()]/g, '')) + '*'; }).join(',') + ')';
}

// ---- 공통 틀 ----
function rowHtml(p) {
  var img = L.sortedImages(p.product_images)[0];
  var badge = p.usage_period === 'new' ? '신품' : p.condition === 'great' ? '사용감 없음' : p.condition === 'good' ? '사용감 있음' : p.condition === 'broken' ? '수리필요' : '';
  var bcls = { '신품': 'new', '사용감 없음': 'clean', '사용감 있음': 'used', '수리필요': 'fix' }[badge];
  return '<a class="row" href="/product/' + L.esc(p.id) + '"><div class="ph">' +
    (img ? '<img src="' + L.esc(img.url) + '" alt="" loading="lazy">' : '<div class="noimg"></div>') +
    (p.status === 'sold' ? '<div class="sold-cover">판매완료</div>' : '') + '</div>' +
    '<div class="info"><div class="t">' + (badge ? '<span class="cbadge cb-' + bcls + '">' + badge + '</span>' : '') + L.esc(p.title) + '</div>' +
    '<div class="m">' + L.esc(p.region || '') + '</div>' +
    '<div class="p">' + (p.status === 'sold' ? '<span class="badge sold">판매완료</span>' : '') + L.esc(L.won(p.price)) + '</div></div></a>';
}
function chips(list, on) {
  return '<div class="chips" style="flex-wrap:wrap;margin-top:10px">' + list.map(function (x) {
    return '<a class="chip' + (x[0] === on ? ' on' : '') + '" href="' + x[1] + '">' + L.esc(x[0]) + '</a>';
  }).join('') + '</div>';
}
function shell(o) {
  return '<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">\n<meta name="color-scheme" content="light">\n<meta name="theme-color" content="#FFFFFF">\n' +
    '<title>' + L.esc(o.title) + '</title>\n<meta name="description" content="' + L.esc(o.desc) + '">\n' +
    (o.index ? '<link rel="canonical" href="' + L.esc(o.url) + '">\n' : '<meta name="robots" content="noindex, follow">\n') +
    '<meta property="og:type" content="website">\n<meta property="og:site_name" content="판다산다">\n' +
    '<meta property="og:title" content="' + L.esc(o.ogTitle || o.title) + '">\n<meta property="og:description" content="' + L.esc(o.desc) + '">\n' +
    '<meta property="og:url" content="' + L.esc(o.url) + '">\n' +
    '<meta property="og:image" content="' + L.esc(o.image || L.SITE + '/이미지/web/og-share.jpg') + '">\n' +
    '<link rel="icon" href="/favicon.ico" sizes="48x48">\n<link rel="icon" href="/icon-192.png" type="image/png" sizes="192x192">\n' +
    '<link rel="manifest" href="/manifest.webmanifest">\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n<link rel="stylesheet" href="/app.css">\n' +
    '<style>.lead{color:var(--sub);margin-top:10px;line-height:1.6;font-size:15px}.sd-h{font-size:18px;font-weight:800;margin-top:28px}' +
    '.pbox{margin-top:16px;padding:20px;border-radius:18px;background:var(--primary-light)}.pbox .k{font-size:14px;color:var(--sub)}' +
    '.pbox .v{font-size:30px;font-weight:800;margin-top:4px}.pbox .r{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:10px;font-size:14px;color:var(--sub)}.pbox .r b{color:var(--text)}' +
    '.note{margin-top:12px;font-size:13px;color:var(--hint);line-height:1.6}.cta2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:16px}.cta2 .btn{height:52px}' +
    '.row .noimg{width:100%;height:100%;background:#EEE}' +
    '@media (min-width:1101px){.seo-wrap{max-width:860px;margin:0 auto}}</style>\n' +
    (o.ld ? L.jsonLd(o.ld) + '\n' : '') + '</head>\n<body>\n<div class="app">\n' +
    '<header class="topbar"><a class="back" href="' + (o.back || '/buy') + '" aria-label="뒤로"><i data-icon="back" data-size="24"></i></a><h1>' + L.esc(o.bar) + '</h1></header>\n' +
    '<main class="page"><div class="seo-wrap">' + o.body + '</div><footer class="site-foot" id="siteFoot"></footer></main>\n</div>\n' +
    '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>\n' +
    '<script src="/js/supabase-client.js"></script>\n<script src="/js/app.js"></script>\n' +
    (o.track ? '<script>PS.track(' + JSON.stringify(o.track[0]) + ',' + JSON.stringify(o.track[1]).replace(/</g, '\\u003c') + ')</script>\n' : '') +
    '</body>\n</html>\n';
}

// ---- /price/:item ----
async function pricePage(item) {
  var words = ITEMS[item];
  if (!words) return null;
  var rows = await L.rest('products?select=' + COLS + '&status=in.(selling,reserved,sold)&price=gt.0&' + ilikeAny(words) + '&order=created_at.desc&limit=200') || [];
  var used = rows.filter(function (p) { return p.usage_period !== 'new'; });
  var fresh = rows.filter(function (p) { return p.usage_period === 'new'; });
  function stat(list) {
    if (list.length < MIN_INDEX) return null;
    var s = list.map(function (p) { return p.price; }).sort(function (a, b) { return a - b; });
    var at = function (q) { return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
    return { n: s.length, mid: man(at(0.5)), lo: man(at(0.25)), hi: man(at(0.75)), min: s[0], max: s[s.length - 1] };
  }
  var all = stat(rows), su = stat(used), sn = stat(fresh);
  var name = item.replace(/\(.*\)/, '');
  var year = kstToday().slice(0, 4);
  var index = !!all;
  var desc = all
    ? L.clip(year + '년 ' + name + ' 중고·신품 시세: 판다산다 등록 매물 ' + all.n + '건 기준 보통 ' + L.won(all.lo) + '~' + L.won(all.hi) + ' (가운데 값 ' + L.won(all.mid) + '). 지금 판매 중인 ' + name + ' 매물도 바로 확인하세요.', 160)
    : L.clip(name + ' 중고·신품 시세와 매물. 판다산다에서는 사진 한 장으로 산업용품을 사고팔 수 있어요.', 160);
  var selling = rows.filter(function (p) { return p.status !== 'sold'; }).slice(0, 20);
  var sold = rows.filter(function (p) { return p.status === 'sold'; }).slice(0, 10);
  var statLine = function (label, s) { return s ? '<span>' + label + ' <b>' + L.esc(L.won(s.mid)) + '</b> (' + s.n + '건)</span>' : ''; };

  var body = '<h1 style="font-size:24px;font-weight:800;margin-top:18px;line-height:1.35">' + L.esc(name) + ' 시세</h1>' +
    '<p class="lead">판다산다에 올라온 ' + L.esc(name) + ' 매물의 등록 가격을 모아 계산했어요. 마력·규격·상태에 따라 차이가 크니 비슷한 매물과 함께 비교해 보세요.</p>' +
    (all
      ? '<div class="pbox"><div class="k">보통 거래되는 가격 (등록 매물 ' + all.n + '건)</div><div class="v">' + L.esc(L.won(all.lo)) + ' ~ ' + L.esc(L.won(all.hi)) + '</div>' +
        '<div class="r"><span>가운데 값 <b>' + L.esc(L.won(all.mid)) + '</b></span>' + statLine('중고', su) + statLine('신품', sn) + '</div></div>' +
        '<p class="note">가격의 가운데 50%를 보여 줘요. 실제 거래 가격이 아니라 판매자가 올린 가격이에요.</p>'
      : '<div class="pbox"><div class="k">아직 매물이 적어 시세를 계산하지 못했어요</div><div class="v" style="font-size:20px">첫 번째 ' + L.esc(name) + ' 판매자가 되어 보세요</div></div>') +
    '<div class="cta2"><a class="btn" href="/sell">내 ' + L.esc(name) + ' 팔기</a><a class="btn white" href="/keywords">새 매물 알림 받기</a></div>' +
    (selling.length ? '<h2 class="sd-h">지금 판매 중인 ' + L.esc(name) + '</h2><div class="list">' + selling.map(rowHtml).join('') + '</div>' : '') +
    (sold.length ? '<h2 class="sd-h">최근 판매 완료</h2><div class="list">' + sold.map(rowHtml).join('') + '</div>' : '') +
    '<a class="btn white" href="/buy?q=' + encodeURIComponent(words[0]) + '" style="margin-top:20px">' + L.esc(name) + ' 전체 검색하기</a>' +
    '<h2 class="sd-h">다른 품목 시세</h2>' + chips(Object.keys(ITEMS).map(function (k) { return [k.replace(/\(.*\)/, ''), priceUrl(k)]; }), name) +
    '<div style="height:40px"></div>';

  var ld = all ? {
    '@context': 'https://schema.org', '@type': 'Product', name: '중고 ' + name, url: L.SITE + priceUrl(item),
    description: desc,
    offers: { '@type': 'AggregateOffer', priceCurrency: 'KRW', lowPrice: all.min, highPrice: all.max, offerCount: all.n }
  } : null;
  return {
    index: index, url: L.SITE + priceUrl(item), title: year + ' ' + name + ' 중고 시세·가격 (매물 ' + rows.length + '건) - 판다산다',
    desc: desc, bar: name + ' 시세', back: '/price', body: body, ld: ld, track: ['seo_view', { kind: 'price', item: item, n: rows.length }]
  };
}

// ---- /buy/c/:cat, /buy/area/:area[/:cat] ----
async function buyPage(area, cat) {
  if (cat && CATS.indexOf(cat) === -1) return null;
  if (area && !/^[가-힣]{1,6}(시|군|구)$/.test(area)) return null;
  var q = 'products?select=' + COLS + (cat ? ',categories!inner(name)&categories.name=eq.' + encodeURIComponent(cat) : '') +
    '&status=in.(selling,reserved)' + (area ? '&region=ilike.*' + encodeURIComponent(area) + '*' : '') + '&order=bumped_at.desc&limit=60';
  var rows = await L.rest(q) || [];
  // ilike 는 '구로구' 안의 '로구' 같은 것까지 걸리므로, 시·군·구 낱말이 정확히 같은 것만 남김
  if (area) rows = rows.filter(function (p) { return areaTokens(p.region).indexOf(area) !== -1; });
  var name = [area, cat].filter(Boolean).join(' ');
  var index = rows.length >= MIN_INDEX;
  var url = L.SITE + (area ? areaUrl(area, cat) : catUrl(cat));
  var desc = L.clip((area ? area + ' 근처 ' : '') + (cat || '산업용품') + ' 중고·신품 매물 ' + rows.length + '건. 공구부터 기계까지 판다산다에서 사진 한 장으로 사고팔아요.', 160);
  // 이 지역에서 많이 나오는 다른 지역·카테고리로 이어지는 링크
  var body = '<h1 style="font-size:24px;font-weight:800;margin-top:18px;line-height:1.35">' + L.esc(name) + ' 중고 매물</h1>' +
    '<p class="lead">' + (area ? L.esc(area) + ' 근처에서 ' : '') + '지금 판매 중인 ' + L.esc(cat || '산업용품') + ' <b>' + rows.length + '건</b>이에요.</p>' +
    (area ? chips([['전체', areaUrl(area)]].concat(CATS.map(function (c) { return [c, areaUrl(area, c)]; })), cat || '전체')
          : chips(CATS.map(function (c) { return [c, catUrl(c)]; }), cat)) +
    (rows.length ? '<div class="list" style="margin-top:8px">' + rows.map(rowHtml).join('') + '</div>'
      : '<div class="empty" style="padding:40px 0"><b>아직 올라온 물건이 없어요</b>첫 번째로 판매해 보세요!</div>') +
    '<div class="cta2"><a class="btn" href="/sell">내 물건 팔기</a><a class="btn white" href="/buy' + (cat ? '?c=' + encodeURIComponent(cat) : '') + '">전체 매물 보기</a></div>' +
    '<h2 class="sd-h">품목별 시세</h2>' + chips(Object.keys(ITEMS).slice(0, 12).map(function (k) { return [k.replace(/\(.*\)/, ''), priceUrl(k)]; })) +
    '<div style="height:40px"></div>';
  var ld = {
    '@context': 'https://schema.org', '@type': 'ItemList', name: name + ' 중고 매물', url: url, numberOfItems: rows.length,
    itemListElement: rows.slice(0, 30).map(function (p, i) { return { '@type': 'ListItem', position: i + 1, url: L.SITE + '/product/' + p.id, name: p.title }; })
  };
  return {
    index: index, url: url, title: name + ' 중고 매물 ' + rows.length + '건 · 산업용품 직거래 - 판다산다',
    desc: desc, bar: name, back: '/buy', body: body, ld: ld, track: ['seo_view', { kind: area ? 'area' : 'cat', area: area || '', cat: cat || '', n: rows.length }]
  };
}

// ---- /support/weekly ----
// 목록은 '오늘 ~ 7일 뒤 마감'. 이름(○월 ○주차)은 그 주의 월요일 기준, 일요일이면 다음 주로 (월요일 아침에 올리는 걸 일요일에 미리 만들 때)
function weekInfo(today) {
  var d = new Date(today + 'T00:00:00Z');
  var base = d.getUTCDay() === 0 ? new Date(d.getTime() + 86400000) : d;
  var mon = new Date(base.getTime() - ((base.getUTCDay() + 6) % 7) * 86400000);
  var end = new Date(d.getTime() + 7 * 86400000);
  var nth = Math.floor((mon.getUTCDate() - 1) / 7) + 1;
  var md = function (x) { return (x.getUTCMonth() + 1) + '.' + x.getUTCDate(); };
  return { mon: mon.toISOString().slice(0, 10), label: (mon.getUTCMonth() + 1) + '월 ' + nth + '주차', range: md(d) + ' ~ ' + md(end) };
}
async function weeklyData() {
  var today = kstToday(), w = weekInfo(today);
  var until = new Date(Date.parse(today) + 7 * 86400000).toISOString().slice(0, 10);
  var weekAgo = new Date(Date.parse(today) - 7 * 86400000).toISOString();
  var got = await Promise.all([
    L.rest('support_programs?select=id,title,agency,category,region,apply_end&apply_end=gte.' + today + '&apply_end=lte.' + until + '&order=apply_end.asc,posted_at.desc&limit=100'),
    L.rest('support_programs?select=id,title,agency,category,region,apply_end&posted_at=gte.' + encodeURIComponent(weekAgo) + '&order=posted_at.desc&limit=100')
  ]);
  return { today: today, week: w, closing: got[0] || [], fresh: got[1] || [] };
}
async function weeklyPage() {
  var d = await weeklyData();
  var label = function (r) { return r === '전남광주' ? '광주·전남' : r; };
  var row = function (p) {
    var n = p.apply_end ? Math.round((Date.parse(p.apply_end) - Date.parse(d.today)) / 86400000) : null;
    var dd = n == null ? '상시' : n === 0 ? '오늘 마감' : 'D-' + n;
    var cls = n == null ? 'always' : n <= 7 ? 'soon' : 'open';
    return '<a class="sp-row" href="/support/' + p.id + '?utm_source=weekly&utm_medium=page"><span class="sp-dday sp-' + cls + '">' + dd + '</span><div class="sp-info"><div class="sp-t">' + L.esc(p.title) +
      '</div><div class="sp-m">' + L.esc([p.category, label(p.region || '전국'), p.agency].filter(Boolean).join(' · ')) + '</div></div></a>';
  };
  var title = d.week.label + ' 마감 정부지원사업 ' + d.closing.length + '건 · 새 공고 ' + d.fresh.length + '건';
  var desc = L.clip(d.week.range + ' 마감 정부·지자체 지원사업 ' + d.closing.length + '건과 지난 일주일 새로 올라온 공고 ' + d.fresh.length + '건을 모았어요. 기업마당 공고를 매일 자동으로 정리해요.', 160);
  var body = '<h1 style="font-size:24px;font-weight:800;margin-top:18px;line-height:1.35">' + L.esc(d.week.label) + ' 지원사업 브리핑</h1>' +
    '<p class="lead">' + L.esc(d.week.range) + ' 마감 <b style="color:var(--danger)">' + d.closing.length + '건</b>, 지난 일주일 새 공고 <b>' + d.fresh.length + '건</b></p>' +
    '<a class="dg-banner" href="/diagnose?from=weekly"><span class="dg-ico" aria-hidden="true">✓</span><span class="dg-tx"><b>이 중 우리 회사에 맞는 공고는?</b><span>업종·지역·규모만 고르면 30초 진단</span></span><span class="dg-arrow" aria-hidden="true">›</span></a>' +
    '<h2 class="sd-h">일주일 안에 마감</h2>' + (d.closing.length ? '<div>' + d.closing.slice(0, 40).map(row).join('') + '</div>' : '<p class="lead">이번 주 마감 공고가 없어요.</p>') +
    (d.fresh.length ? '<h2 class="sd-h">새로 올라온 공고</h2><div>' + d.fresh.slice(0, 30).map(row).join('') + '</div>' : '') +
    '<div class="cta2"><a class="btn" href="/diagnose?from=weekly">맞춤 공고 진단</a><a class="btn white" href="/support">전체 지원사업</a></div>' +
    '<p class="note">기업마당(bizinfo.go.kr) 공고를 모은 것이에요. 신청 자격·서류·기간은 꼭 공고 원문에서 확인해 주세요. 매일 아침·저녁 새로 고쳐져요.</p><div style="height:40px"></div>';
  var ld = {
    '@context': 'https://schema.org', '@type': 'ItemList', name: title, url: L.SITE + '/support/weekly', numberOfItems: d.closing.length,
    itemListElement: d.closing.slice(0, 40).map(function (p, i) { return { '@type': 'ListItem', position: i + 1, url: L.SITE + '/support/' + p.id, name: p.title }; })
  };
  return { index: true, url: L.SITE + '/support/weekly', title: title + ' - 판다산다', ogTitle: d.week.label + ' 마감 임박 지원사업 ' + d.closing.length + '건', desc: desc, bar: '이번 주 지원사업', back: '/support', body: body, ld: ld, track: ['seo_view', { kind: 'weekly' }] };
}

module.exports = async function (req, res) {
  var kind = String(req.query.kind || '');
  var o = null;
  try {
    if (kind === 'price') o = await pricePage(String(req.query.v || ''));
    else if (kind === 'buy') o = await buyPage(String(req.query.area || ''), String(req.query.c || ''));
    else if (kind === 'weekly') o = await weeklyPage();
    else if (kind === 'weekly_json') { // 카드 만들기 화면(weekly-card.html)이 쓰는 데이터
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, s-maxage=1800');
      res.status(200).send(JSON.stringify(await weeklyData()));
      return;
    }
  } catch (e) { console.error('seo', kind, e); }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!o || (kind === 'buy' && !req.query.area && !req.query.c)) {
    res.setHeader('Cache-Control', 'public, s-maxage=300');
    res.status(404).send(shell({ index: false, url: L.SITE, title: '찾을 수 없어요 - 판다산다', desc: '', bar: '찾을 수 없어요', body: '<div class="empty" style="padding:60px 0"><b>찾는 페이지가 없어요</b><a class="btn" href="/buy" style="margin-top:20px">매물 보러 가기</a></div>' }));
    return;
  }
  res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=86400');
  res.status(200).send(shell(o));
};
module.exports.ITEMS = ITEMS;
module.exports.CATS = CATS;
module.exports.MIN_INDEX = MIN_INDEX;
module.exports.priceUrl = priceUrl;
module.exports.catUrl = catUrl;
module.exports.areaUrl = areaUrl;
module.exports.areaTokens = areaTokens;
module.exports.ilikeAny = ilikeAny;
module.exports.weeklyData = weeklyData;
