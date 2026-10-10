// 검색 로봇용 서버 렌더에 쓰는 공용 도구. 파일명이 _ 로 시작하면 Vercel 이 함수로 배포하지 않는다.
var fs = require('fs');
var path = require('path');

var SITE = 'https://www.pandasanda.com';
var SUPABASE_URL = 'https://rqjfergjfhcrcuvfuhkm.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_RdtDN6VAPjOikX0CS-oT4A___yzI5w2'; // js/supabase-client.js 와 같은 공개 키

// 공개(anon) 권한으로 REST 조회. 실패하면 null
async function rest(query, headers) {
  try {
    var r = await fetch(SUPABASE_URL + '/rest/v1/' + query, {
      headers: Object.assign({ apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY }, headers || {})
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// <script type="application/ld+json"> 안에 안전하게 넣기
function jsonLd(obj) {
  return '<script type="application/ld+json">' + JSON.stringify(obj).replace(/</g, '\\u003c') + '</script>';
}

function absUrl(u) {
  if (!u) return '';
  return /^https?:\/\//.test(u) ? u : SITE + encodeURI(u.charAt(0) === '/' ? u : '/' + u);
}

// 줄바꿈·연속 공백을 정리하고 n자로 자름 (meta description 용)
function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).trim() + '…' : s;
}

// js/app.js 의 PS.won 과 같은 표기
function won(n) {
  n = Number(n) || 0;
  if (n === 0) return '가격 협의';
  if (n < 10000) return n.toLocaleString('ko-KR') + '원';
  var eok = Math.floor(n / 100000000);
  var man = Math.floor((n % 100000000) / 10000);
  var rest = n % 10000;
  if (rest && !eok && man < 100) return n.toLocaleString('ko-KR') + '원';
  var out = '';
  if (eok) out += eok.toLocaleString('ko-KR') + '억';
  if (man) out += (out ? ' ' : '') + man.toLocaleString('ko-KR') + '만';
  return out + '원';
}

function sortedImages(list) {
  return (list || []).slice().sort(function (a, b) { return a.sort_order - b.sort_order; });
}

var templates = {};
// 배포본에 같이 묶인 html(vercel.json 의 includeFiles)을 읽고, 없으면 사이트에서 받아 온다
async function template(name, req) {
  if (templates[name]) return templates[name];
  var html = null;
  try {
    html = fs.readFileSync(path.join(process.cwd(), name + '.html'), 'utf8');
  } catch (e) {
    var r = await fetch('https://' + req.headers.host + '/' + name);
    if (r.ok) html = await r.text();
  }
  if (html) templates[name] = html;
  return html;
}

module.exports = { SITE: SITE, rest: rest, esc: esc, jsonLd: jsonLd, absUrl: absUrl, clip: clip, won: won, sortedImages: sortedImages, template: template };
