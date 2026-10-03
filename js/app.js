// 판다산다 공용 스크립트: 로그인 상태, 하단 탭바, 포맷 유틸, 상품 카드.
// supabase-js CDN → js/supabase-client.js → js/app.js 순서로 불러온다.
(function () {
  var sb = window.sb;
  var PS = window.PS = {};

  PS.FUNCTIONS_URL = 'https://rqjfergjfhcrcuvfuhkm.supabase.co/functions/v1';

  // 카카오맵 JavaScript 키 (Kakao Developers > 앱 키). 비어 있으면 무료 지도(OpenStreetMap)로 보여준다.
  PS.KAKAO_JS_KEY = 'eed04d223c75e55f7d445b88ca168023';
  // 토스페이먼츠 클라이언트 키 (공개용, test_ck_... 또는 live_ck_...). 비어 있으면 결제 버튼이 '준비 중'으로 안내
  PS.TOSS_CLIENT_KEY = '';

  // 대분류 5개 (중·소분류는 나중에 categories.parent_id 로 추가)
  PS.CATEGORIES = ['중고장터', '산업기계', '공구·부품', '자동화·전기', '물류·창고'];
  PS.CATEGORY_ICON = { '중고장터': 'used', '산업기계': 'machine', '공구·부품': 'tools', '자동화·전기': 'electric', '물류·창고': 'logistics' };
  PS.categoryIcon = function (name, size) {
    var key = PS.CATEGORY_ICON[name] || 'used';
    return '<img class="i3d" src="/이미지/categories/' + key + '.webp" alt="" width="' + size + '" height="' + size + '" style="width:' + size + 'px;height:' + size + 'px">';
  };
  PS.CONDITIONS = { great: '아주 좋아요', good: '괜찮아요', broken: '고장 있어요' };
  PS.USAGE = { new: '신품', lt1: '1년 미만', '1to3': '1~3년', gt3: '3년 이상' };
  PS.STATUS = { selling: '판매중', sold: '판매완료' };

  PS.esc = function (s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  // 5000000 → "500만원", 12500000 → "1,250만원", 150000000 → "1억 5,000만원", 35000 → "35,000원"
  PS.won = function (n) {
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
  };

  PS.ago = function (iso) {
    var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return '방금 전';
    if (s < 3600) return Math.floor(s / 60) + '분 전';
    if (s < 86400) return Math.floor(s / 3600) + '시간 전';
    if (s < 86400 * 7) return Math.floor(s / 86400) + '일 전';
    if (s < 86400 * 30) return Math.floor(s / 86400 / 7) + '주 전';
    var d = new Date(iso);
    return (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
  };

  PS.param = function (name) {
    return new URLSearchParams(location.search).get(name);
  };

  // /product/abc 또는 /product.html?id=abc 둘 다 지원
  PS.idFromUrl = function (prefix) {
    var q = PS.param('id');
    if (q) return q;
    var m = location.pathname.match(new RegExp('/' + prefix + '/([^/?#]+)'));
    return m ? decodeURIComponent(m[1]) : null;
  };

  PS.toast = function (msg) {
    var el = document.getElementById('psToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'psToast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(PS._toastTimer);
    PS._toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  };

  // ---- 판다 스티커 / 선 아이콘 ----
  // 스티커: /이미지/stickers/{name}.webp (sell, buy, ready, delivery, inquiry, checking, best, good,
  // curious, thanks, carry, searching, working, factory, fighting, happy, sorry, hello, done)
  PS.sticker = function (name, size, cls) {
    return '<img class="stk' + (cls ? ' ' + cls : '') + '" src="/이미지/stickers/' + name + '.webp" alt="" width="' + size + '" height="' + size + '" style="width:' + size + 'px;height:' + size + 'px">';
  };

  // 3D 아이콘: /이미지/icons/{name}.webp (home, sell, buy, search, chat, user, heart, request, camera,
  // idea, location, delivery, chart, support, trash, calendar, globe, handshake)
  PS.icon3d = function (name, size, cls) {
    return '<img class="i3d' + (cls ? ' ' + cls : '') + '" src="/이미지/icons/' + name + '.webp" alt="" width="' + size + '" height="' + size + '" style="width:' + size + 'px;height:' + size + 'px">';
  };

  var ICON_PATHS = {
    camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    chat: '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1z"/>',
    heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z"/>',
    send: '<path d="M4 12l16-8-6 16-2-7-8-1z"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    trash: '<path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13"/>',
    pin: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    bag: '<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M12 8l1.2 2.8L16 12l-2.8 1.2L12 16l-1.2-2.8L8 12l2.8-1.2z"/>',
    tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.5"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    chevron: '<path d="M9 5l7 7-7 7"/>'
  };
  PS.icon = function (name, size, fill) {
    size = size || 22;
    return '<svg class="ico" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="' + (fill ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON_PATHS[name] || '') + '</svg>';
  };

  // 정적 HTML의 <i data-icon="camera" data-size="22"></i>, <i data-sticker="hello" data-size="96"></i> 를 실제 그림으로 바꾼다
  PS.hydrate = function (root) {
    (root || document).querySelectorAll('[data-icon]').forEach(function (el) {
      el.outerHTML = PS.icon(el.dataset.icon, Number(el.dataset.size) || 22, el.hasAttribute('data-fill'));
    });
    (root || document).querySelectorAll('[data-icon3d]').forEach(function (el) {
      el.outerHTML = PS.icon3d(el.dataset.icon3d, Number(el.dataset.size) || 28, el.className);
    });
    (root || document).querySelectorAll('[data-sticker]').forEach(function (el) {
      el.outerHTML = PS.sticker(el.dataset.sticker, Number(el.dataset.size) || 96, el.className);
    });
  };

  PS.avatarHtml = function (url) {
    return url ? '<img src="' + PS.esc(url) + '" alt="">' : PS.sticker('good', 64, 'avatar-stk');
  };

  PS.firstImage = function (p) {
    var imgs = (p.product_images || []).slice().sort(function (a, b) { return a.sort_order - b.sort_order; });
    return imgs.length ? imgs[0].url : null;
  };

  function photoHtml(p) {
    var url = PS.firstImage(p);
    var img = url ? '<img src="' + PS.esc(url) + '" alt="" loading="lazy">' : '<div class="noimg">' + PS.icon3d('sell', 64) + '</div>';
    if (p.status === 'sold') img += '<div class="sold-cover">판매완료</div>';
    return img;
  }

  // 상태 뱃지: 신품 / 사용감 없음 / 사용감 있음 / 수리필요 (반짝이는 작은 뱃지)
  PS.conditionBadge = function (p) {
    var k = p.usage_period === 'new' ? 'new' : p.condition === 'great' ? 'clean' : p.condition === 'good' ? 'used' : p.condition === 'broken' ? 'fix' : '';
    if (!k) return '';
    var label = { new: '신품', clean: '사용감 없음', used: '사용감 있음', fix: '수리필요' }[k];
    return '<span class="cbadge cb-' + k + '">' + label + '</span>';
  };

  function statusBadge(p) {
    if (p.status === 'sold') return '<span class="badge sold">판매완료</span>';
    return '';
  }

  PS.productUrl = function (id) { return '/product/' + encodeURIComponent(id); };
  PS.profileUrl = function (id) { return '/profile/' + encodeURIComponent(id); };

  // 홈: 2열 카드
  // 규격(옵션)이 2개 이상이면 구매할 때 고름. 옵션 가격이 없으면 기본 가격
  PS.options = function (p) { return Array.isArray(p && p.options) && p.options.length > 1 ? p.options : []; };
  PS.optionPrice = function (p, i) {
    var o = PS.options(p)[i];
    return o && Number(o.price) > 0 ? Number(o.price) : Number(p.price) || 0;
  };
  PS.priceLabel = function (p) {
    var opts = PS.options(p);
    if (!opts.length) return PS.won(p.price);
    var prices = opts.map(function (_, i) { return PS.optionPrice(p, i); }).filter(function (n) { return n > 0; });
    if (!prices.length) return PS.won(0);
    var min = Math.min.apply(null, prices), max = Math.max.apply(null, prices);
    return PS.won(min) + (max > min ? '~' : '');
  };
  // 배송비: 0이면 포함(무료), 아니면 별도. 판매자가 정한 기준 금액(min) 이상 같이 사면 무료
  PS.shipLabel = function (p, min) {
    var f = Number(p && p.shipping_fee) || 0;
    if (!f) return '배송비 포함';
    return '배송비 ' + f.toLocaleString('ko-KR') + '원 별도' + (min > 0 ? ' · ' + PS.won(min) + ' 이상 무료' : '');
  };
  // 판매자별 배송비 무료 기준 금액 { sellerId: 300000 }
  PS.freeShipMins = async function (ids) {
    ids = ids.filter(function (v, i, a) { return v && a.indexOf(v) === i; });
    if (!ids.length) return {};
    var r = await sb.rpc('get_free_ship_min', { p_ids: ids });
    var m = {};
    (r.data || []).forEach(function (x) { if (x.free_ship_min > 0) m[x.id] = x.free_ship_min; });
    return m;
  };
  // 한 판매자 묶음: 상품 합계와 배송비 (가장 큰 배송비 한 번, 기준 이상이면 0) — 서버 create_market_order_cart와 같은 규칙
  PS.groupShip = function (lines, min) {
    var sub = 0, fee = 0;
    lines.forEach(function (l) { sub += l.price * l.qty; fee = Math.max(fee, Number(l.fee) || 0); });
    if (min > 0 && sub >= min) fee = 0;
    return { sub: sub, fee: fee, left: min > 0 && fee > 0 ? min - sub : 0 };
  };

  // 장바구니 (이 기기에 저장) [{ pid, opt, qty }]
  PS.cart = {
    key: function () { return 'ps_cart_' + (PS.user ? PS.user.id : 'guest'); },
    items: function () { try { return JSON.parse(localStorage.getItem(PS.cart.key()) || '[]'); } catch (e) { return []; } },
    save: function (arr) { try { localStorage.setItem(PS.cart.key(), JSON.stringify(arr)); } catch (e) {} },
    add: function (pid, opt, qty) {
      var arr = PS.cart.items();
      var hit = arr.filter(function (x) { return x.pid === pid && x.opt === opt; })[0];
      if (hit) hit.qty = Math.min(999, hit.qty + qty); else arr.push({ pid: pid, opt: opt, qty: qty });
      PS.cart.save(arr);
    },
    setQty: function (pid, opt, qty) {
      var arr = PS.cart.items().map(function (x) { if (x.pid === pid && x.opt === opt) x.qty = qty; return x; });
      PS.cart.save(arr.filter(function (x) { return x.qty > 0; }));
    },
    removeMany: function (keys) { // keys: ['pid|opt', ...]
      PS.cart.save(PS.cart.items().filter(function (x) { return keys.indexOf(x.pid + '|' + x.opt) < 0; }));
    },
    count: function () { return PS.cart.items().length; }
  };
  // 새로 추가된 컬럼(SQL 실행 전일 수 있음)을 빼 가며 한 건 조회
  PS.selectProduct = async function (cols, extras, id) {
    for (var n = extras.length; n >= 0; n--) {
      var r = await sb.from('products').select(cols + (n ? ',' + extras.slice(0, n).join(',') : '')).eq('id', id).maybeSingle();
      if (!r.error || n === 0) { r.extras = extras.slice(0, n); return r; }
    }
  };
  // "품명 (규격)" → { name, spec }
  PS.splitTitle = function (t) {
    var m = String(t || '').match(/^(.+?)\s*[(\[]([^()\[\]]+)[)\]]\s*$/);
    return m ? { name: m[1], spec: m[2] } : { name: String(t || ''), spec: '' };
  };
  PS.cardHtml = function (p) {
    return '<a class="card" href="' + PS.productUrl(p.id) + '">' +
      '<div class="ph">' + photoHtml(p) + '</div>' +
      '<div class="t">' + PS.conditionBadge(p) + PS.esc(p.title) + '</div>' +
      '<div class="p">' + statusBadge(p) + PS.won(p.price) + '</div>' +
      '<div class="m">' + PS.esc(p.region || '') + (p.region ? ' · ' : '') + PS.ago(p.created_at) + '</div>' +
      '</a>';
  };

  // 산다/마이: 당근식 한 줄
  PS.rowHtml = function (p) {
    var stats = [];
    if (p.inquiry_count) stats.push('<span>' + PS.icon('chat', 14) + ' ' + p.inquiry_count + '</span>');
    if (p.like_count) stats.push('<span>' + PS.icon('heart', 14) + ' ' + p.like_count + '</span>');
    return '<a class="row" href="' + PS.productUrl(p.id) + '">' +
      '<div class="ph">' + photoHtml(p) + '</div>' +
      '<div class="info">' +
        '<div class="t">' + PS.conditionBadge(p) + PS.esc(p.title) + '</div>' +
        '<div class="m">' + PS.esc(p.region || '') + (p.region ? ' · ' : '') + PS.ago(p.created_at) + '</div>' +
        '<div class="p">' + statusBadge(p) + PS.won(p.price) + '</div>' +
        '<div class="s">' + stats.join('') + '</div>' +
      '</div></a>';
  };

  PS.PRODUCT_LIST_COLUMNS = 'id,title,price,region,status,condition,usage_period,created_at,like_count,inquiry_count,view_count,product_images(url,sort_order)';

  // ---- 동네 업체 ----
  PS.bizUrl = function (id) { return '/biz/' + encodeURIComponent(id); };
  PS.BIZ_COLUMNS = 'id,owner_id,name,tagline,category_id,region,lat,lng,like_count,view_count,bumped_at,created_at,status,business_images(url,sort_order)';
  PS.distLabel = function (km) {
    if (km == null || km > 999) return '';
    return km < 1 ? Math.max(10, Math.round(km * 100) * 10) + 'm' : (km < 10 ? km.toFixed(1) : Math.round(km)) + 'km';
  };
  // 당근 '동네가게' 카드: 사진 위에 한 줄 소개, 아래 업체명 · 분류 · 찜 · 거리
  PS.bizCardHtml = function (b, opts) {
    opts = opts || {};
    var img = PS.firstImage({ product_images: b.business_images });
    var meta = [opts.categoryName, b.like_count ? '찜 ' + b.like_count : '', PS.distLabel(opts.km)].filter(Boolean).join(' · ');
    return '<a class="bizcard' + (opts.active ? ' hl' : '') + '" href="' + PS.bizUrl(b.id) + '" data-biz="' + PS.esc(b.id) + '">' +
      '<div class="bz-ph">' + (img ? '<img src="' + PS.esc(img) + '" alt="" loading="lazy">' : '<div class="noimg">' + PS.icon3d('home', 64) + '</div>') + '</div>' +
      (b.tagline ? '<div class="bz-quote"><span>“</span>' + PS.esc(b.tagline) + '</div>' : '') +
      '<div class="bz-name">' + PS.esc(b.name) + '</div>' +
      '<div class="bz-meta">' + PS.esc(meta) + '</div></a>';
  };
  // ---- 결제한 주문 (판매관리의 주문 내역 / 구매내역의 결제한 주문) ----
  PS.ORDER_COLUMNS = 'id,order_no,buyer_id,seller_id,product_id,product_title,option_name,item_amount,shipping_fee,total_amount,' +
    'recipient,phone,zipcode,address,status,payment_method,paid_at,created_at,' +
    'market_order_items(product_id,product_title,option_name,unit_price,qty,line_amount)';
  // 결제가 끝난 주문과 취소된 주문만 (결제창에서 그만둔 주문은 제외)
  // 발송·취소 정보 (컬럼이 아직 없으면 빼고 조회)
  PS.ORDER_EXTRA_COLUMNS = 'shipped_at,carrier,tracking_no,cancel_request_status,cancel_request_reason,cancel_requested_at,canceled_at,canceled_by,cancel_reason';
  PS.CARRIERS = [
    'CJ대한통운', '우체국택배', '한진택배', '롯데택배', '로젠택배',          // 종합 택배
    'GS25 편의점택배', 'CU 편의점택배', '홈픽',                              // 편의점·방문 수거
    '경동택배', '대신택배', '합동택배', '건영택배', '천일택배', '일양로지스', // 화물·기업 물류
    '화물·용달', '직접 전달'
  ];
  PS.CARRIERS_NO_TRACKING = ['화물·용달', '직접 전달']; // 송장번호 없이도 발송 처리 가능
  PS.myOrders = async function (role) {
    var q = function (cols) {
      return sb.from('market_orders').select(cols)
        .eq(role === 'seller' ? 'seller_id' : 'buyer_id', PS.user.id).in('status', ['paid', 'canceled'])
        .order('created_at', { ascending: false }).limit(200);
    };
    var res = await q(PS.ORDER_COLUMNS + ',' + PS.ORDER_EXTRA_COLUMNS);
    if (res.error) res = await q(PS.ORDER_COLUMNS);
    return res.error ? [] : (res.data || []);
  };
  // role: 'seller' 는 받는 분·배송지를 크게, 'buyer' 는 판매자와 내 배송지. names: { profileId: { name } }
  PS.orderCardHtml = function (o, role, names) {
    var d = new Date(o.paid_at || o.created_at);
    var when = d.getFullYear() + '.' + (d.getMonth() + 1) + '.' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    var items = (o.market_order_items || []).length ? o.market_order_items
      : [{ product_id: o.product_id, product_title: o.product_title, option_name: o.option_name, qty: 1, line_amount: o.item_amount }];
    var other = (names || {})[role === 'seller' ? o.buyer_id : o.seller_id] || {};
    var won = function (n) { return Number(n || 0).toLocaleString('ko-KR') + '원'; };
    var md = function (iso) { var x = new Date(iso); return (x.getMonth() + 1) + '.' + x.getDate(); };
    var seller = role === 'seller', paid = o.status === 'paid', shipped = !!o.shipped_at, req = o.cancel_request_status;
    // 배송·취소 상태 한 줄
    var state = '';
    if (o.status === 'canceled') {
      state = '<p class="ostate cancel"><b>' + (o.canceled_by === 'seller' ? '판매자가 취소' : o.canceled_by === 'buyer' ? '구매자가 취소' : '취소됨') +
        (o.canceled_at ? ' · ' + md(o.canceled_at) : '') + '</b>' + (o.cancel_reason ? '사유: ' + PS.esc(o.cancel_reason) : '') + '<br>결제 금액은 전액 환불돼요.</p>';
    } else if (paid) {
      state = shipped
        ? '<p class="ostate ship"><b>발송함 · ' + md(o.shipped_at) + '</b>' + PS.esc(o.carrier || '') + (o.tracking_no ? ' ' + PS.esc(o.tracking_no) : '') + '</p>'
        : '<p class="ostate"><b>배송 준비 중</b>' + (seller ? '물건을 보낸 뒤 "발송함"을 눌러 주세요' : '판매자가 발송하면 송장번호가 보여요') + '</p>';
      if (req === 'requested') state += '<p class="ostate cancel"><b>' + (seller ? '구매자가 취소를 요청했어요' : '취소 요청 중') + '</b>' +
        '사유: ' + PS.esc(o.cancel_request_reason || '') + (seller ? '' : '<br>판매자의 답을 기다리고 있어요') + '</p>';
      if (req === 'rejected' && !seller) state += '<p class="ostate cancel"><b>판매자가 취소 요청에 동의하지 않았어요</b>채팅으로 판매자와 이야기해 보세요</p>';
    }
    // 할 수 있는 일
    var btn = function (act, label, cls) { return '<button type="button" class="btn small ' + (cls || 'white') + '" data-oact="' + act + '" data-oid="' + PS.esc(o.id) + '">' + label + '</button>'; };
    var acts = '';
    if (paid && seller) {
      if (req === 'requested') acts += btn('approve', '취소 동의 (전액 환불)', '') + btn('reject', '요청 거절');
      acts += btn('ship', shipped ? '송장 수정' : '발송함', shipped || req === 'requested' ? 'white' : '') + (req === 'requested' ? '' : btn('cancel', '주문 취소'));
    } else if (paid) {
      if (!shipped) acts += btn('cancel', '주문 취소');
      else if (req !== 'requested') acts += btn('request', req === 'rejected' ? '취소 다시 요청' : '취소 요청');
    }
    return '<article class="ocard' + (o.status === 'canceled' ? ' off' : '') + '">' +
      '<header><span class="badge ' + (o.status === 'paid' ? 'paid' : 'sold') + '">' + (o.status === 'paid' ? '결제완료' : '취소됨') + '</span>' +
        '<time>' + when + '</time><span class="no">' + PS.esc(o.order_no) + '</span></header>' + state +
      '<ul class="oitems">' + items.map(function (it) {
        var t = PS.esc(it.product_title) + (it.option_name ? ' <small>' + PS.esc(it.option_name) + '</small>' : '');
        return '<li>' + (it.product_id ? '<a href="' + PS.productUrl(it.product_id) + '">' + t + '</a>' : '<span>' + t + '</span>') +
          '<em>' + (it.qty || 1) + '개 · ' + won(it.line_amount) + '</em></li>';
      }).join('') + '</ul>' +
      '<dl class="osum"><dt>상품 합계</dt><dd>' + won(o.item_amount) + '</dd><dt>배송비</dt><dd>' + (o.shipping_fee ? won(o.shipping_fee) : '무료') + '</dd>' +
        '<dt class="tot">결제 금액</dt><dd class="tot">' + won(o.total_amount) + '</dd></dl>' +
      '<dl class="oship">' +
        (role === 'seller' ? '<dt>구매자</dt><dd>' + PS.esc(other.name || '구매자') + '</dd>'
          : '<dt>판매자</dt><dd><a href="' + PS.profileUrl(o.seller_id) + '">' + PS.esc(other.name || '판매자') + ' ›</a></dd>') +
        '<dt>받는 분</dt><dd>' + PS.esc(o.recipient) + '</dd>' +
        '<dt>연락처</dt><dd>' + (role === 'seller' ? '<a href="tel:' + PS.esc(String(o.phone).replace(/[^0-9+]/g, '')) + '">' + PS.esc(o.phone) + '</a>' : PS.esc(o.phone)) + '</dd>' +
        '<dt>' + (role === 'seller' ? '보낼 곳' : '배송지') + '</dt><dd>' + (o.zipcode ? '(' + PS.esc(o.zipcode) + ') ' : '') + PS.esc(o.address) + '</dd>' +
      '</dl>' + (acts ? '<div class="oacts">' + acts + '</div>' : '') + '</article>';
  };

  // 주문 카드의 버튼(발송함·주문 취소·취소 요청·동의·거절) 동작. getOrder(id) 는 주문 한 건, reload() 는 목록 다시 불러오기
  PS.bindOrderActions = function (listEl, role, getOrder, reload) {
    var bg = null, sheet = null;
    function close() { if (sheet) { sheet.classList.remove('show'); bg.classList.remove('show'); } }
    function open(html) {
      if (!sheet) {
        bg = document.createElement('div'); bg.className = 'sheet-bg';
        sheet = document.createElement('div'); sheet.className = 'sheet osheet'; sheet.setAttribute('role', 'dialog');
        document.body.appendChild(bg); document.body.appendChild(sheet);
        bg.addEventListener('click', close);
      }
      sheet.innerHTML = '<div class="handle"></div>' + html;
      bg.classList.add('show'); sheet.classList.add('show');
      return sheet;
    }
    // 서버(order-cancel): 토스 결제 취소 + 주문을 취소됨으로
    async function refund(orderId, reason) {
      var token = await PS.accessToken();
      var res = await fetch(PS.FUNCTIONS_URL + '/order-cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ orderId: orderId, reason: reason || '' })
      });
      var d = await res.json().catch(function () { return {}; });
      if (res.ok && d.ok) return '';
      return d.code === 'not_configured' ? '결제가 아직 준비 중이라 취소할 수 없어요'
        : d.code === 'already_shipped' ? '이미 발송된 주문이에요. 취소 요청을 보내 주세요'
        : (d.message || '취소하지 못했어요. 잠시 후 다시 해 주세요');
    }
    function done(msg) { close(); PS.toast(msg); reload(); }

    listEl.addEventListener('click', async function (e) {
      var b = e.target.closest('[data-oact]');
      if (!b) return;
      var act = b.dataset.oact, o = getOrder(b.dataset.oid);
      if (!o) return;

      if (act === 'ship') {
        var s = open('<h3>' + (o.shipped_at ? '송장 정보 수정' : '발송 정보 입력') + '</h3>' +
          '<label class="field"><span>배송업체</span><select class="input" id="oCarrier">' + PS.CARRIERS.map(function (c) {
            return '<option' + (c === o.carrier ? ' selected' : '') + '>' + PS.esc(c) + '</option>';
          }).join('') + '</select></label>' +
          '<label class="field"><span>송장번호</span><input class="input" id="oTrack" inputmode="numeric" maxlength="40" autocomplete="off" placeholder="숫자만 입력" value="' + PS.esc(o.tracking_no || '') + '"></label>' +
          '<p class="ohint" id="oTrackHint">화물·용달이나 직접 전달은 송장번호 없이 저장할 수 있어요.</p>' +
          '<button type="button" class="btn" id="oSubmit" style="margin-top:16px">' + (o.shipped_at ? '저장하기' : '발송함') + '</button>');
        s.querySelector('#oSubmit').addEventListener('click', async function () {
          var carrier = s.querySelector('#oCarrier').value, no = s.querySelector('#oTrack').value.trim();
          if (!no && PS.CARRIERS_NO_TRACKING.indexOf(carrier) < 0) { PS.toast('송장번호를 써 주세요'); return; }
          this.disabled = true;
          var r = await sb.rpc('ship_market_order', { p_order_id: o.id, p_carrier: carrier, p_tracking_no: no });
          this.disabled = false;
          if (r.error || r.data !== 'ok') { PS.toast('저장하지 못했어요. 잠시 후 다시 해 주세요'); return; }
          done(o.shipped_at ? '송장 정보를 바꿨어요' : '발송 처리했어요');
        });
        return;
      }

      if (act === 'cancel' || act === 'request') {
        var isReq = act === 'request', seller = role === 'seller';
        var s2 = open('<h3>' + (isReq ? '취소 요청' : '주문 취소') + '</h3>' +
          '<p class="ohint">' + (isReq ? '이미 발송된 주문이라 판매자가 동의해야 취소돼요. 사유를 적어 요청해 주세요.'
            : seller ? '사유는 구매자에게 그대로 보여요. 취소하면 결제 금액이 전액 환불돼요.' : '취소하면 결제 금액이 전액 환불돼요.') + '</p>' +
          '<label class="field"><span>' + (isReq ? '요청 사유' : '취소 사유') + '</span><textarea class="textarea" id="oReason" maxlength="500" style="min-height:110px" placeholder="' +
            (seller ? '예) 재고가 부족해요 / 이미 판매된 물건이에요' : '예) 다른 물건으로 잘못 주문했어요') + '"></textarea></label>' +
          '<button type="button" class="btn danger" id="oSubmit" style="margin-top:16px">' + (isReq ? '취소 요청 보내기' : '주문 취소하고 환불하기') + '</button>');
        s2.querySelector('#oSubmit').addEventListener('click', async function () {
          var reason = s2.querySelector('#oReason').value.trim();
          if (!reason) { PS.toast('사유를 써 주세요'); return; }
          this.disabled = true;
          if (isReq) {
            var r2 = await sb.rpc('request_order_cancel', { p_order_id: o.id, p_reason: reason });
            this.disabled = false;
            if (r2.error || r2.data !== 'ok') { PS.toast('요청하지 못했어요. 잠시 후 다시 해 주세요'); return; }
            done('판매자에게 취소를 요청했어요');
          } else {
            var err = await refund(o.id, reason);
            this.disabled = false;
            if (err) { PS.toast(err); return; }
            done('주문을 취소했어요. 결제 금액은 환불돼요');
          }
        });
        return;
      }

      if (act === 'approve') {
        if (!confirm('구매자의 취소 요청에 동의할까요?\n결제 금액이 전액 환불돼요.')) return;
        b.disabled = true;
        var err2 = await refund(o.id, '');
        b.disabled = false;
        if (err2) { PS.toast(err2); return; }
        done('취소에 동의했어요. 결제 금액은 환불돼요');
        return;
      }

      if (act === 'reject') {
        if (!confirm('구매자의 취소 요청을 거절할까요?')) return;
        b.disabled = true;
        var r3 = await sb.rpc('reject_order_cancel', { p_order_id: o.id });
        b.disabled = false;
        if (r3.error || r3.data !== 'ok') { PS.toast('처리하지 못했어요. 잠시 후 다시 해 주세요'); return; }
        done('취소 요청을 거절했어요');
      }
    });
  };

  PS.myVerification = async function () {
    if (!PS.user) return null;
    var r = await sb.from('business_verifications').select('company_name,biz_reg_no,verified_at,nts_status').eq('profile_id', PS.user.id).maybeSingle();
    if (r.error) r = await sb.from('business_verifications').select('company_name,biz_reg_no,verified_at').eq('profile_id', PS.user.id).maybeSingle();
    return r.error ? null : r.data;
  };
  // 국세청 상태 배지
  PS.ntsBadge = function (v) {
    var s = v && v.nts_status;
    if (s === 'active') return '<span class="verified">✓ 국세청 확인 완료</span>';
    if (s === 'suspended') return '<span class="verified" style="background:#FFF4D6;color:#8A6400">휴업 중</span>';
    if (s === 'closed' || s === 'unregistered') return '<span class="verified" style="background:#FFF0EF;color:var(--danger)">' + (s === 'closed' ? '폐업' : '국세청 미등록') + '</span>';
    return '<span class="verified" style="background:#F2F3F5;color:var(--sub)">국세청 확인 중</span>';
  };

  // ---- 시세: 비슷한 이름 → 같은 분류 순으로, 최근 가격의 중간값 ±10% ----
  PS.marketPrice = async function (title, categoryId) {
    var cols = PS.PRODUCT_LIST_COLUMNS;
    var items = [];
    var words = (title || '').split(/\s+/).filter(function (w) { return w.length >= 2; });
    if (words.length) {
      var r1 = await sb.from('products').select(cols).neq('status', 'deleted').gt('price', 0)
        .ilike('title', '%' + words[0].replace(/[%_,()]/g, '') + '%').order('created_at', { ascending: false }).limit(50);
      items = r1.data || [];
    }
    if (items.length < 3 && categoryId) {
      var r2 = await sb.from('products').select(cols).neq('status', 'deleted').gt('price', 0)
        .eq('category_id', categoryId).order('created_at', { ascending: false }).limit(50);
      if ((r2.data || []).length > items.length) items = r2.data;
    }
    if (items.length < 3) return { count: items.length, items: items };
    var prices = items.map(function (p) { return p.price; }).sort(function (a, b) { return a - b; });
    var mid = prices[Math.floor(prices.length / 2)];
    var man = function (n) { return Math.max(10000, Math.round(n / 10000) * 10000); };
    return { count: items.length, items: items, lo: man(mid * 0.9), hi: man(mid * 1.1), rec: man(mid) };
  };

  // ---- 최근 본 물건 (이 기기에만 저장) ----
  PS.recentIds = function () {
    try { return JSON.parse(localStorage.getItem('ps_recent') || '[]'); } catch (e) { return []; }
  };
  PS.addRecent = function (id) {
    try {
      var ids = PS.recentIds().filter(function (x) { return x !== id; });
      ids.unshift(id);
      localStorage.setItem('ps_recent', JSON.stringify(ids.slice(0, 50)));
    } catch (e) {}
  };

  // ---- 내 동네 (이 기기에 저장: 지도 시작 위치, 판매 지역 기본값) ----
  PS.getHome = function () {
    try {
      var h = JSON.parse(localStorage.getItem('ps_home') || 'null');
      if (h && h.region) return h;
      var r = localStorage.getItem('ps_region');
      return r ? { region: r } : null;
    } catch (e) { return null; }
  };
  PS.setHome = function (home) {
    try {
      localStorage.setItem('ps_home', JSON.stringify(home));
      localStorage.setItem('ps_region', home.region);
    } catch (e) {}
  };

  // ---- 로그인 상태 ----
  PS.user = null;
  PS.profile = null;

  PS.goLogin = function () {
    location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
  };

  PS.requireLogin = function () {
    if (PS.user) return true;
    PS.goLogin();
    return false;
  };

  PS.signOut = async function () {
    await sb.auth.signOut();
    location.href = '/';
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { PS.hydrate(); });
  else PS.hydrate();

  // 메일 링크(가입 확인·비밀번호 재설정)로 들어오면 주소의 #access_token 으로 로그인시킨다
  PS.hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (PS.hashParams.get('type') === 'recovery' && !/^\/reset-password/.test(location.pathname)) {
    location.replace('/reset-password' + location.hash);
  }

  PS.ready = (async function () {
    try {
      if (PS.hashParams.get('access_token') && PS.hashParams.get('refresh_token')) {
        await sb.auth.setSession({ access_token: PS.hashParams.get('access_token'), refresh_token: PS.hashParams.get('refresh_token') });
        history.replaceState(null, '', location.pathname + location.search);
      }
      var res = await sb.auth.getSession();
      var session = res.data.session;
      if (session) {
        PS.user = session.user;
        var pr = await sb.from('profiles').select('id,name,phone,avatar_url').eq('id', session.user.id).maybeSingle();
        PS.profile = pr.data || { id: session.user.id, name: (session.user.email || '').split('@')[0] };
      }
    } catch (e) {
      console.error('[판다산다] 로그인 상태 확인 실패', e);
    }
    return PS.user;
  })();

  // supabase 요청은 결과를 받아야(then) 실제로 전송된다. 결과가 필요 없는 요청은 이걸로 보낸다.
  PS.fire = function (query) {
    return Promise.resolve(query).then(function (r) {
      if (r && r.error) console.warn('[판다산다]', r.error);
      return r;
    }, function (e) { console.warn('[판다산다]', e); });
  };

  PS.accessToken = async function () {
    var res = await sb.auth.getSession();
    return res.data.session ? res.data.session.access_token : null;
  };

  // 판매자 이름 등 공개 프로필 (이메일/전화 제외)
  PS.publicProfiles = async function (ids) {
    ids = ids.filter(function (v, i, a) { return v && a.indexOf(v) === i; });
    if (!ids.length) return {};
    var res = await sb.rpc('get_public_profiles', { p_ids: ids });
    var map = {};
    (res.data || []).forEach(function (p) { map[p.id] = p; });
    return map;
  };

  // PC 에서 넓게 쓰는 페이지 (홈·물건·업체·프로필). 나머지는 가운데 한 컬럼 (app.css 의 html.pc-wide)
  if (/^\/(index(\.html)?)?$|^\/(product|business|biz\/(?!new|verify)|profile)/.test(location.pathname)) document.documentElement.classList.add('pc-wide');

  // PC 에서 홈과 같은 좌우 여백(내용 폭 70%)을 쓰는 페이지: 채팅·마이와 마이 하위 화면, 결제, 물건 수정 (app.css 의 html.pc-70)
  if (/^\/(chat|mypage|sales|purchases|favorites|recent|keywords|settings|neighborhood|price|shipping|cart|checkout|edit|my-biz|biz-premium|biz-new|biz-verify|biz\/(new|verify))(\/|\.html|$)/.test(location.pathname)) document.documentElement.classList.add('pc-70');

  // ---- 하단 탭바 ----
  var TABS = [
    { key: 'home', href: '/', icon: 'home', label: '홈' },
    { key: 'sell', href: '/sell', icon: 'sell', label: '판다' },
    { key: 'buy', href: '/buy', icon: 'buy', label: '산다' },
    { key: 'chat', href: '/chat', icon: 'chat', label: '채팅' },
    { key: 'my', href: '/mypage', icon: 'user', label: '마이' }
  ];

  PS.renderTabbar = function (active) {
    if (document.querySelector('nav.tabbar')) return; // 한 번만
    var nav = document.createElement('nav');
    nav.className = 'tabbar';
    nav.setAttribute('aria-label', '메뉴');
    // PC(넓은 화면)에서는 이 탭바가 상단 헤더가 된다: 로고와 검색창은 PC 에서만 보임 (app.css)
    nav.innerHTML = '<a class="tb-logo" href="/" aria-label="판다산다 홈"><img src="/이미지/web/logo-wordmark.png" alt="판다산다"></a>' + TABS.map(function (t) {
      return '<a href="' + t.href + '" class="' + (t.key === active ? 'on' : '') + '"' + (t.key === active ? ' aria-current="page"' : '') + '>' +
        '<span class="ti" aria-hidden="true">' + PS.icon3d(t.icon, 30) + '</span>' + t.label +
        (t.key === 'chat' ? '<span class="dot" id="chatDot"></span>' : '') + '</a>';
    }).join('') + (active === 'buy' && location.pathname === '/buy' ? '' :
      '<form class="search tb-search" action="/buy" role="search"><span aria-hidden="true" style="display:flex">' + PS.icon('search', 18) + '</span>' +
      '<input name="q" type="search" placeholder="무엇을 찾으시나요?" autocomplete="off" aria-label="검색어"></form>');
    document.body.appendChild(nav);
    PS.ready.then(function (user) { if (user) refreshChatDot(); });
  };

  async function refreshChatDot() {
    var res = await sb.from('messages').select('id', { count: 'exact', head: true })
      .is('read_at', null).neq('sender_id', PS.user.id);
    var dot = document.getElementById('chatDot');
    if (dot) dot.classList.toggle('show', (res.count || 0) > 0);
  }

  // 하단 탭바는 모든 페이지에 항상 고정 (페이지가 직접 그리지 않으면 주소로 판단해 자동으로)
  function autoTabbar() {
    if (document.querySelector('nav.tabbar')) return;
    var path = location.pathname;
    var key = path === '/' || path === '/index' ? 'home'
      : /^\/sell/.test(path) ? 'sell'
      : /^\/(buy|product|checkout|pay-|biz\/(?!new|verify)|business)/.test(path) ? 'buy'
      : /^\/chat/.test(path) ? 'chat'
      : /^\/(mypage|sales|purchases|favorites|recent|keywords|settings|neighborhood|price|my-biz|biz-premium|biz\/new|biz\/verify|biz-new|biz-verify)/.test(path) ? 'my' : '';
    PS.renderTabbar(key);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(autoTabbar, 0); });
  else setTimeout(autoTabbar, 0);
})();
