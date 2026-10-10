// /product/:id, /biz/:id — 검색 로봇과 공유 미리보기가 읽을 수 있게 제목·설명·사진을 html 에 미리 채워 내려준다.
// 화면 자체는 기존처럼 product.html / business.html 의 스크립트가 다시 그린다.
var L = require('./_lib');

var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function optionPrices(p) {
  var opts = Array.isArray(p.options) && p.options.length > 1 ? p.options : [];
  return opts.map(function (o) { return Number(o.price) > 0 ? Number(o.price) : Number(p.price) || 0; })
    .filter(function (n) { return n > 0; });
}

async function loadProduct(id) {
  var base = 'id,title,price,description,brand,condition,region,status,created_at,categories(name),product_images(url,sort_order)';
  // options 컬럼이 없는 DB 에서도 동작하도록 한 번 더 시도 (PS.selectProduct 와 같은 이유)
  var rows = await L.rest('products?id=eq.' + id + '&select=' + base + ',options') ||
    await L.rest('products?id=eq.' + id + '&select=' + base);
  var p = rows && rows[0];
  return p && p.status !== 'deleted' ? p : null;
}

function productView(p) {
  var imgs = L.sortedImages(p.product_images);
  var prices = optionPrices(p);
  var min = prices.length ? Math.min.apply(null, prices) : Number(p.price) || 0;
  var max = prices.length ? Math.max.apply(null, prices) : min;
  var priceText = L.won(min) + (max > min ? '~' : '');
  var cat = p.categories ? p.categories.name : '';
  var url = L.SITE + '/product/' + p.id;
  var desc = L.clip([priceText, p.region, L.clip(p.description, 120)].filter(Boolean).join(' · '), 160);

  var ld = {
    '@context': 'https://schema.org', '@type': 'Product', name: p.title, url: url,
    image: imgs.map(function (im) { return L.absUrl(im.url); }),
    description: L.clip(p.description || p.title, 500)
  };
  if (!ld.image.length) delete ld.image;
  if (p.brand) ld.brand = { '@type': 'Brand', name: p.brand };
  if (cat) ld.category = cat;
  if (min > 0) {
    var avail = 'https://schema.org/' + (p.status === 'selling' ? 'InStock' : 'SoldOut');
    ld.offers = max > min
      ? { '@type': 'AggregateOffer', priceCurrency: 'KRW', lowPrice: min, highPrice: max, offerCount: prices.length, availability: avail, url: url }
      : { '@type': 'Offer', priceCurrency: 'KRW', price: min, availability: avail, url: url };
  }

  return {
    title: p.title + ' - 판다산다', desc: desc, url: url, image: imgs[0] ? L.absUrl(imgs[0].url) : '', ogType: 'product', ld: ld,
    slider: imgs[0] ? '<img src="' + L.esc(imgs[0].url) + '" alt="' + L.esc(p.title) + '">' : '',
    body: '<h1 class="title">' + L.esc(p.title) + '</h1>' +
      '<div class="meta">' + L.esc([cat, p.region].filter(Boolean).join(' · ')) + '</div>' +
      '<div class="price">' + L.esc(priceText) + '</div>' +
      (p.description ? '<div class="desc">' + L.esc(p.description) + '</div>' : '')
  };
}

async function loadBusiness(id) {
  var rows = await L.rest('businesses?id=eq.' + id + '&select=id,name,tagline,description,region,status,categories(name),business_images(url,sort_order)');
  var b = rows && rows[0];
  return b && b.status === 'active' ? b : null;
}

function businessView(b) {
  var imgs = L.sortedImages(b.business_images);
  var cat = b.categories ? b.categories.name : '';
  var url = L.SITE + '/biz/' + b.id;
  var meta = [cat, b.region].filter(Boolean).join(' · ');
  var ld = { '@context': 'https://schema.org', '@type': 'LocalBusiness', name: b.name, url: url, description: L.clip(b.tagline || b.description, 500) };
  if (imgs.length) ld.image = imgs.map(function (im) { return L.absUrl(im.url); });
  if (b.region) ld.address = { '@type': 'PostalAddress', addressCountry: 'KR', addressLocality: b.region };

  return {
    title: b.name + ' - 판다산다', desc: L.clip([b.tagline, meta, L.clip(b.description, 100)].filter(Boolean).join(' · '), 160),
    url: url, image: imgs[0] ? L.absUrl(imgs[0].url) : '', ogType: 'website', ld: ld,
    slider: imgs[0] ? '<img src="' + L.esc(imgs[0].url) + '" alt="' + L.esc(b.name) + '">' : '',
    body: '<h1 class="bname">' + L.esc(b.name) + '</h1>' +
      (meta ? '<div class="bmeta">' + L.esc(meta) + '</div>' : '') +
      (b.tagline ? '<div class="tagline"><span>“</span>' + L.esc(b.tagline) + '</div>' : '') +
      (b.description ? '<div class="desc">' + L.esc(b.description) + '</div>' : '')
  };
}

function head(v) {
  return '<title>' + L.esc(v.title) + '</title>\n' +
    '<meta name="description" content="' + L.esc(v.desc) + '">\n' +
    '<link rel="canonical" href="' + L.esc(v.url) + '">\n' +
    '<meta property="og:type" content="' + v.ogType + '">\n' +
    '<meta property="og:site_name" content="판다산다">\n' +
    '<meta property="og:title" content="' + L.esc(v.title) + '">\n' +
    '<meta property="og:description" content="' + L.esc(v.desc) + '">\n' +
    '<meta property="og:url" content="' + L.esc(v.url) + '">\n' +
    (v.image ? '<meta property="og:image" content="' + L.esc(v.image) + '">\n' : '') +
    L.jsonLd(v.ld);
}

// 치환 문자열의 $ 가 특수 처리되지 않도록 함수로 넘긴다
function swap(html, re, to) {
  return html.replace(re, function () { return to; });
}

module.exports = async function (req, res) {
  var isBiz = req.query.type === 'biz';
  var id = String(req.query.id || '');
  var html = await L.template(isBiz ? 'business' : 'product', req);
  if (!html) { res.status(500).send('template missing'); return; }

  var row = UUID.test(id) ? await (isBiz ? loadBusiness(id) : loadProduct(id)) : null;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!row) {
    // 없는 글: 화면은 기존 스크립트가 "찾을 수 없어요"를 그리고, 검색에서는 빠지게 한다
    res.setHeader('Cache-Control', 'public, s-maxage=60');
    res.status(404).send(swap(html, /<title>[^<]*<\/title>/, '<title>찾을 수 없어요 - 판다산다</title>\n<meta name="robots" content="noindex">'));
    return;
  }

  var v = isBiz ? businessView(row) : productView(row);
  html = swap(html, /<title>[^<]*<\/title>/, head(v));
  if (v.slider) html = swap(html, /(<div class="slider" id="slider">)[\s\S]*?(<\/div>\s*<div class="dots")/, '<div class="slider" id="slider">' + v.slider + '</div>\n    <div class="dots"');
  html = swap(html, /<main class="page" id="body"><\/main>/, '<main class="page" id="body">' + v.body + '</main>');

  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
  res.status(200).send(html);
};
