// 지원사업 모아보기 (검색 유입용): /support/area/경기, /support/field/수출, /support/area/경기/수출
// support.html 틀에 서버에서 목록을 그려 넣는다. 화면 스크립트는 이 주소면 그대로 둔다.
var L = require('./_lib');

var REGIONS = ['서울', '부산', '대구', '인천', '전남광주', '대전', '울산', '세종', '경기', '강원', '충북', '충남', '전북', '경북', '경남', '제주'];
var FIELDS = ['경영', '기술', '금융', '수출', '인력', '내수', '창업'];
var label = function (r) { return r === '전남광주' ? '광주·전남' : r; };
var areaUrl = function (r, f) { return '/support/area/' + encodeURIComponent(r) + (f ? '/' + encodeURIComponent(f) : ''); };
var fieldUrl = function (f) { return '/support/field/' + encodeURIComponent(f); };

function dday(end, today) {
  if (!end) return { cls: 'always', label: '상시' };
  var d = Math.round((Date.parse(end) - Date.parse(today)) / 86400000);
  if (d === 0) return { cls: 'today', label: '오늘 마감' };
  return { cls: d <= 7 ? 'soon' : 'open', label: 'D-' + d };
}

function row(p, today) {
  var d = dday(p.apply_end, today);
  var meta = [p.category, label(p.region || '전국'), p.agency].filter(Boolean).join(' · ');
  return '<a class="sp-row" href="/support/' + p.id + '"><span class="sp-dday sp-' + d.cls + '">' + d.label + '</span>' +
    '<div class="sp-info"><div class="sp-t">' + L.esc(p.title) + '</div><div class="sp-m">' + L.esc(meta) + '</div></div></a>';
}

function chips(items, on) {
  return '<div class="chips" style="flex-wrap:wrap;margin-top:10px">' + items.map(function (x) {
    return '<a class="chip' + (x[0] === on ? ' on' : '') + '" href="' + x[1] + '">' + L.esc(x[0]) + '</a>';
  }).join('') + '</div>';
}

module.exports = async function (req, res) {
  var kind = req.query.kind === 'field' ? 'field' : 'area';
  var v = String(req.query.v || ''), f = String(req.query.f || '');
  var region = kind === 'area' ? (v === '광주' || v === '전남' ? '전남광주' : v) : '';
  var field = kind === 'field' ? v : f;
  var ok = (kind === 'area' ? REGIONS.indexOf(region) !== -1 : true) && (!field || FIELDS.indexOf(field) !== -1) && (kind === 'area' || field);

  var html = await L.template('support', req);
  if (!html) { res.status(500).send('template missing'); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!ok) {
    res.setHeader('Cache-Control', 'public, s-maxage=300');
    res.status(404).send(html.replace(/<!--list-meta-->[\s\S]*?<!--\/list-meta-->\n?/, '').replace(/<title>[^<]*<\/title>/, '<title>찾을 수 없어요 - 판다산다</title>\n<meta name="robots" content="noindex">'));
    return;
  }

  var today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  var q = 'support_programs?select=id,title,agency,category,region,apply_end&or=(apply_end.gte.' + today + ',apply_end.is.null)' +
    (region ? '&region=eq.' + encodeURIComponent(region) : '') + (field ? '&category=eq.' + encodeURIComponent(field) : '') +
    '&order=apply_end.asc.nullslast,posted_at.desc&limit=200';
  var nation = region
    ? 'support_programs?select=id,title,agency,category,region,apply_end&or=(apply_end.gte.' + today + ',apply_end.is.null)&region=eq.' + encodeURIComponent('전국') +
      (field ? '&category=eq.' + encodeURIComponent(field) : '') + '&order=apply_end.asc.nullslast,posted_at.desc&limit=30'
    : null;
  var got = await Promise.all([L.rest(q), nation ? L.rest(nation) : Promise.resolve([])]);
  var rows = got[0] || [], wide = got[1] || [];

  var name = [region ? label(region) : '', field ? field + ' 분야' : ''].filter(Boolean).join(' ');
  var who = region ? label(region) + ' 지역 중소기업·소상공인' : '중소기업·소상공인';
  var title = name + ' 지원사업 모음 (마감 임박순) - 판다산다';
  var url = L.SITE + (kind === 'area' ? areaUrl(region, field) : fieldUrl(field));
  var soon = rows.filter(function (p) { return p.apply_end && p.apply_end <= new Date(Date.parse(today) + 7 * 86400000).toISOString().slice(0, 10); }).length;
  var desc = L.clip(who + '이 지금 신청할 수 있는 ' + (field ? field + ' 분야 ' : '') + '정부·지자체 지원사업 ' + rows.length + '건' +
    (soon ? ' (일주일 안 마감 ' + soon + '건)' : '') + '. 기업마당 공고를 매일 자동으로 모아 마감 임박순으로 보여 드려요.', 160);

  var ld = {
    '@context': 'https://schema.org', '@type': 'ItemList', name: name + ' 지원사업', url: url, numberOfItems: rows.length,
    itemListElement: rows.slice(0, 50).map(function (p, i) { return { '@type': 'ListItem', position: i + 1, url: L.SITE + '/support/' + p.id, name: p.title }; })
  };

  var body =
    '<h1 style="font-size:24px;font-weight:800;margin-top:18px;line-height:1.35">' + L.esc(name) + ' 지원사업</h1>' +
    '<p class="lead">' + L.esc(who) + '이 지금 신청할 수 있는 공고 <b>' + rows.length + '건</b>' + (soon ? ', 그중 <b style="color:var(--danger)">일주일 안 마감 ' + soon + '건</b>' : '') +
      '이에요. 기업마당 공고를 매일 자동으로 모아요.</p>' +
    (kind === 'area'
      ? chips([['전체', areaUrl(region)]].concat(FIELDS.map(function (x) { return [x, areaUrl(region, x)]; })), field || '전체')
      : '') +
    '<div style="margin-top:8px">' + (rows.length ? rows.map(function (p) { return row(p, today); }).join('')
      : '<p class="lead" style="padding:24px 0">지금 신청할 수 있는 공고가 없어요. 아래 다른 지역·분야를 둘러보세요.</p>') + '</div>' +
    (wide.length ? '<h2 class="sd-h">전국 대상 공고도 신청할 수 있어요</h2><div>' + wide.map(function (p) { return row(p, today); }).join('') + '</div>' : '') +
    '<a class="btn white" href="/support" style="margin-top:20px">전체 지원사업 검색하기</a>' +
    '<h2 class="sd-h">지역별 지원사업</h2>' + chips(REGIONS.map(function (r) { return [label(r), areaUrl(r, field)]; }), region ? label(region) : '') +
    '<h2 class="sd-h">분야별 지원사업</h2>' + chips(FIELDS.map(function (x) { return [x, kind === 'area' ? areaUrl(region, x) : fieldUrl(x)]; }), field) +
    '<div style="height:40px"></div>';

  var head = '<title>' + L.esc(title) + '</title>\n' +
    '<meta name="description" content="' + L.esc(desc) + '">\n' +
    '<link rel="canonical" href="' + L.esc(url) + '">\n' +
    '<meta property="og:type" content="website">\n<meta property="og:site_name" content="판다산다">\n' +
    '<meta property="og:title" content="' + L.esc(title) + '">\n<meta property="og:description" content="' + L.esc(desc) + '">\n' +
    '<meta property="og:url" content="' + L.esc(url) + '">\n<meta property="og:image" content="' + L.SITE + '/이미지/web/logo.jpg">\n' +
    (rows.length ? '' : '<meta name="robots" content="noindex">\n') + L.jsonLd(ld);

  html = html.replace(/<!--list-meta-->[\s\S]*?<!--\/list-meta-->\n?/, '').replace(/<title>[^<]*<\/title>/, function () { return head; })
    .replace(/<main class="page" id="body"><\/main>/, function () { return '<main class="page" id="body" data-ssr="landing">' + body + '</main>'; });
  res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=86400');
  res.status(200).send(html);
};

module.exports.REGIONS = REGIONS;
module.exports.FIELDS = FIELDS;
module.exports.areaUrl = areaUrl;
module.exports.fieldUrl = fieldUrl;
