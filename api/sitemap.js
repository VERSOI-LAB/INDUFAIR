// /sitemap.xml — 고정 페이지 + 판매중인 물건 + 공개된 업체 주소를 매번 DB 에서 만들어 준다.
var L = require('./_lib');
var G = require('./landing');
var S = require('./seo');

var STATIC = ['/', '/buy', '/business', '/community', '/support', '/support/weekly', '/diagnose', '/price', '/events', '/terms', '/privacy', '/policy'];
var PAGE = 1000;     // Supabase REST 한 번에 받는 최대 행 수
var MAX = 40000;     // 사이트맵 하나에 넣을 수 있는 주소는 50,000개까지

async function all(table, filter, dateCol, extra) {
  var out = [];
  for (var from = 0; from < MAX; from += PAGE) {
    var rows = await L.rest(table + '?select=id,' + dateCol + (extra ? ',' + extra : '') + '&' + filter + '&order=' + dateCol + '.desc', { Range: from + '-' + (from + PAGE - 1) });
    if (!rows) break;
    out = out.concat(rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

function entry(loc, date) {
  return '  <url><loc>' + L.esc(loc) + '</loc>' + (date ? '<lastmod>' + String(date).slice(0, 10) + '</lastmod>' : '') + '</url>\n';
}

// 매물이 S.MIN_INDEX 개 이상인 시세·카테고리·지역 페이지만 (적은 페이지는 noindex 라 사이트맵에서도 뺌)
function seoPages(products) {
  var n = {};
  var add = function (u) { n[u] = (n[u] || 0) + 1; };
  products.forEach(function (p) {
    var cat = p.categories && p.categories.name;
    if (cat && S.CATS.indexOf(cat) !== -1) add(S.catUrl(cat));
    S.areaTokens(p.region).forEach(function (a) { add(S.areaUrl(a)); if (cat && S.CATS.indexOf(cat) !== -1) add(S.areaUrl(a, cat)); });
    var t = Number(p.price) > 0 ? String(p.title || '').toLowerCase() : ''; // 시세는 가격 있는 매물만 (seo.js 와 같게)
    Object.keys(S.ITEMS).forEach(function (k) {
      if (S.ITEMS[k].some(function (w) { return t.indexOf(w.toLowerCase()) !== -1; })) add(S.priceUrl(k));
    });
  });
  return Object.keys(n).filter(function (u) { return n[u] >= S.MIN_INDEX; });
}

module.exports = async function (req, res) {
  var today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  var got = await Promise.all([
    all('products', 'status=in.(selling,reserved)', 'created_at', 'title,price,region,categories(name)'),
    all('businesses', 'status=eq.active', 'bumped_at'),
    // 아직 마감 안 된 지원사업 (상시 포함)
    all('support_programs', 'or=(apply_end.gte.' + today + ',apply_end.is.null)', 'updated_at'),
    // 아직 안 끝난 교육·행사
    all('biz_events', 'or=(event_end.gte.' + today + ',event_end.is.null)', 'updated_at'),
    // 이야기 (숨김·삭제 제외)
    all('story_posts', 'status=eq.active', 'updated_at')
  ]);

  var xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    STATIC.map(function (p) { return entry(L.SITE + p); }).join('') +
    // 지원사업 모아보기: 지역, 분야 (지역×분야는 지역 페이지에서 링크로 이어짐)
    G.REGIONS.map(function (r) { return entry(L.SITE + G.areaUrl(r), today); }).join('') +
    G.FIELDS.map(function (f) { return entry(L.SITE + G.fieldUrl(f), today); }).join('') +
    seoPages(got[0]).map(function (u) { return entry(L.SITE + u, today); }).join('') +
    got[0].map(function (p) { return entry(L.SITE + '/product/' + p.id, p.created_at); }).join('') +
    got[1].map(function (b) { return entry(L.SITE + '/biz/' + b.id, b.bumped_at); }).join('') +
    got[2].map(function (s) { return entry(L.SITE + '/support/' + s.id, s.updated_at); }).join('') +
    got[3].map(function (e) { return entry(L.SITE + '/events/' + e.id, e.updated_at); }).join('') +
    got[4].map(function (c) { return entry(L.SITE + '/community/' + c.id, c.updated_at); }).join('') +
    '</urlset>\n';

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  res.status(200).send(xml);
};
