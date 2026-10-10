// /sitemap.xml — 고정 페이지 + 판매중인 물건 + 공개된 업체 주소를 매번 DB 에서 만들어 준다.
var L = require('./_lib');

var STATIC = ['/', '/buy', '/terms', '/privacy'];
var PAGE = 1000;     // Supabase REST 한 번에 받는 최대 행 수
var MAX = 40000;     // 사이트맵 하나에 넣을 수 있는 주소는 50,000개까지

async function all(table, filter, dateCol) {
  var out = [];
  for (var from = 0; from < MAX; from += PAGE) {
    var rows = await L.rest(table + '?select=id,' + dateCol + '&' + filter + '&order=' + dateCol + '.desc', { Range: from + '-' + (from + PAGE - 1) });
    if (!rows) break;
    out = out.concat(rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

function entry(loc, date) {
  return '  <url><loc>' + L.esc(loc) + '</loc>' + (date ? '<lastmod>' + String(date).slice(0, 10) + '</lastmod>' : '') + '</url>\n';
}

module.exports = async function (req, res) {
  var got = await Promise.all([
    all('products', 'status=in.(selling,reserved)', 'created_at'),
    all('businesses', 'status=eq.active', 'bumped_at')
  ]);

  var xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    STATIC.map(function (p) { return entry(L.SITE + p); }).join('') +
    got[0].map(function (p) { return entry(L.SITE + '/product/' + p.id, p.created_at); }).join('') +
    got[1].map(function (b) { return entry(L.SITE + '/biz/' + b.id, b.bumped_at); }).join('') +
    '</urlset>\n';

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  res.status(200).send(xml);
};
