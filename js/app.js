// 판다산다 공용 스크립트: 로그인 상태, 하단 탭바, 포맷 유틸, 상품 카드.
// supabase-js CDN → js/supabase-client.js → js/app.js 순서로 불러온다.
(function () {
  var sb = window.sb;
  var PS = window.PS = {};

  PS.FUNCTIONS_URL = 'https://rqjfergjfhcrcuvfuhkm.supabase.co/functions/v1';
  // 사업자 정보 (전자상거래법 표시 사항). 홈·약관·개인정보처리방침 하단과 설정의 고객센터에 쓰인다
  PS.BIZ = {
    name: '베르소이(VERSOI)', ceo: '이재희', regNo: '550-38-01564', mailOrderNo: '신고 준비 중',
    address: '경기도 성남시 수정구 창업로 18, 876호(시흥동)', phone: '010-5616-8835', email: 'versoi.labs@gmail.com'
  };

  // 카카오맵 JavaScript 키 (Kakao Developers > 앱 키). 비어 있으면 무료 지도(OpenStreetMap)로 보여준다.
  PS.KAKAO_JS_KEY = 'eed04d223c75e55f7d445b88ca168023';
  // 토스페이먼츠 클라이언트 키 (공개용). 비어 있으면 결제 버튼이 '준비 중'으로 안내
  //   test_gck_/live_gck_ : 결제위젯(주문서형) 연동 키 → 결제 화면에 토스 결제위젯을 그림
  //   test_ck_/live_ck_   : API 개별 연동 키 → 결제창을 띄움
  // 서버(Supabase Secrets)의 TOSS_SECRET_KEY 는 같은 종류의 시크릿 키여야 한다 (gck ↔ gsk, ck ↔ sk)
  PS.TOSS_CLIENT_KEY = 'test_gck_docs_Ovk5rk1EwkEbP0W43n07xlzm';
  // 안전결제(구매하기)는 '안전결제 판매자'로 승인된 사업자만 (국세청 계속사업자 + 통신판매업 확인).
  // 개인(비사업자) 판매자 물건은 채팅으로 직접 거래. 판매 대금은 토스페이먼츠 지급대행으로 지급한다.
  // 서버(주문 생성·결제 승인)에서도 같은 조건으로 막으므로 여기는 화면 표시용
  var paySellerCache = {};
  PS.paySellers = async function (ids) {
    ids = ids.filter(function (id, i) { return id && ids.indexOf(id) === i && !(id in paySellerCache); });
    if (ids.length) {
      var r = await sb.rpc('get_pay_sellers', { p_ids: ids });
      var ok = (r.data || []).map(function (x) { return x.id; });
      ids.forEach(function (id) { paySellerCache[id] = !r.error && ok.indexOf(id) !== -1; });
    }
    return paySellerCache;
  };
  PS.canPay = async function (sellerId) { return !!(await PS.paySellers([sellerId]))[sellerId]; };
  PS.isTestPay = function () { return /^test_/.test(PS.TOSS_CLIENT_KEY); };
  PS.isWidgetPay = function () { return /^(test|live)_gck_/.test(PS.TOSS_CLIENT_KEY); };
  // 결제 심사용 계정. 오픈 전까지 로그인 화면 아래에 보여 준다 (없으면 null)
  PS.REVIEW_ACCOUNT = { id: 'pandasanda@gmail.com', pw: '000000' };

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
  // 수령 완료와 정산 (정산 건은 판매자에게만 보임)
  PS.ORDER_SETTLE_COLUMNS = 'received_at,received_auto,order_settlements(fee_rate,fee_amount,net_amount,due_at,status,paid_at)';
  PS.FEE_RATE = 0.05;        // 판매 수수료율 (상품 금액 기준). 실제 계산은 DB 의 settlement_fee_rate() — 바꿀 때 같이 바꿀 것
  PS.AUTO_RECEIVE_DAYS = 14; // 발송 후 이만큼 지나면 자동 수령 처리
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
    // 새 컬럼이 아직 없으면(마이그레이션 전) 차례로 줄여서 조회
    var res = await q(PS.ORDER_COLUMNS + ',' + PS.ORDER_EXTRA_COLUMNS + ',' + PS.ORDER_SETTLE_COLUMNS);
    if (res.error) res = await q(PS.ORDER_COLUMNS + ',' + PS.ORDER_EXTRA_COLUMNS);
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
    // 수령·정산 상태
    var received = !!o.received_at;
    var st = Array.isArray(o.order_settlements) ? o.order_settlements[0] : o.order_settlements; // 판매자에게만 내려옴
    if (paid && received) state += '<p class="ostate ship"><b>' + (o.received_auto ? '자동 수령 확인' : '수령 완료') + ' · ' + md(o.received_at) + '</b>' +
      (o.received_auto ? '발송 후 ' + PS.AUTO_RECEIVE_DAYS + '일이 지나 자동으로 수령 처리됐어요' : (seller ? '구매자가 물건을 받았어요' : '물건을 받았다고 확인했어요')) + '</p>';
    if (paid && seller && shipped) {
      if (st && st.status === 'paid') {
        state += '<p class="ostate settle"><b>정산 완료 · ' + md(st.paid_at) + '</b>' + won(st.net_amount) + ' 입금</p>';
      } else if (st && st.status !== 'canceled') {
        state += '<p class="ostate settle"><b>' + (new Date(st.due_at) > new Date() ? '정산 예정 · ' + md(st.due_at) : '정산 처리 중') + '</b>' +
          '정산 금액 ' + won(st.net_amount) + ' (상품 ' + won(o.item_amount) + ' − 수수료 ' + Math.round(st.fee_rate * 100) + '% ' + won(st.fee_amount) +
          (o.shipping_fee ? ' + 배송비 ' + won(o.shipping_fee) : '') + ')</p>';
      } else if (!received) {
        var auto = new Date(new Date(o.shipped_at).getTime() + PS.AUTO_RECEIVE_DAYS * 86400000);
        var fee = Math.floor(o.item_amount * PS.FEE_RATE);
        state += '<p class="ostate settle"><b>정산 대기</b>구매자가 수령 완료를 누르면 3일 안에, 누르지 않으면 ' + md(auto) + ' 이후 자동으로 정산돼요' +
          (req === 'requested' ? ' (취소 요청에 답하기 전에는 보류)' : '') + '<br>예상 정산 금액 ' + won(o.item_amount - fee + o.shipping_fee) +
          ' (수수료 ' + Math.round(PS.FEE_RATE * 100) + '% ' + won(fee) + ' 제외)</p>';
      }
    }
    var settled = !!(st && st.status === 'paid');
    // 할 수 있는 일
    var btn = function (act, label, cls) { return '<button type="button" class="btn small ' + (cls || 'white') + '" data-oact="' + act + '" data-oid="' + PS.esc(o.id) + '">' + label + '</button>'; };
    var acts = '';
    if (paid && seller) {
      if (req === 'requested') acts += btn('approve', '취소 동의 (전액 환불)', '') + btn('reject', '요청 거절');
      if (!received) acts += btn('ship', shipped ? '송장 수정' : '발송함', shipped || req === 'requested' ? 'white' : '');
      if (req !== 'requested' && !settled) acts += btn('cancel', '주문 취소'); // 정산이 끝난 주문은 취소 불가
    } else if (paid) {
      if (!shipped) acts += btn('cancel', '주문 취소');
      else if (!received && req !== 'requested') acts += btn('receive', '수령 완료', '') + btn('request', req === 'rejected' ? '취소 다시 요청' : '취소 요청');
    }
    if (paid && received) acts += btn('review', '거래 후기 남기기');
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
        : d.code === 'already_settled' ? '이미 정산이 끝난 주문이라 여기서 취소할 수 없어요. 고객센터로 알려 주세요'
        : d.code === 'already_shipped' ? '이미 발송된 주문이에요. 취소 요청을 보내 주세요'
        : (d.message || '취소하지 못했어요. 잠시 후 다시 해 주세요');
    }
    function done(msg) { close(); PS.toast(msg); reload(); }

    listEl.addEventListener('click', async function (e) {
      var b = e.target.closest('[data-oact]');
      if (!b) return;
      var act = b.dataset.oact, o = getOrder(b.dataset.oid);
      if (!o) return;
      if (act === 'review') { PS.openReview({ orderId: o.id }); return; }

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

      if (act === 'receive') {
        if (!confirm('물건을 받으셨나요?\n수령 완료를 누르면 취소 요청을 할 수 없고, 판매자에게 정산돼요.')) return;
        b.disabled = true;
        var r4 = await sb.rpc('confirm_order_received', { p_order_id: o.id });
        b.disabled = false;
        if (r4.error || r4.data !== 'ok') { PS.toast(r4.data === 'cancel_pending' ? '취소 요청에 대한 답을 먼저 기다려 주세요' : '처리하지 못했어요. 잠시 후 다시 해 주세요'); return; }
        done('수령 완료! 이용해 주셔서 고마워요');
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

  // ---- 신뢰: 거래 후기 · 사기 신고 (개인 간 직접 거래는 플랫폼이 돈을 다루지 않으므로 이걸로 보완) ----
  PS.REPORT_REASONS = { fraud: '돈을 받고 물건을 안 보내요 (사기)', fake_item: '설명과 전혀 다른 물건이에요', no_show: '약속을 어기고 연락이 끊겼어요', abusive: '욕설·비매너', etc: '기타' };
  PS.RATINGS = { good: '좋았어요', ok: '보통이에요', bad: '별로였어요' };
  var trustCache = {};
  // 여러 사람의 신뢰 요약 { id: { review_count, good, ok, bad, warned } }
  PS.trust = async function (ids) {
    var need = ids.filter(function (id, i) { return id && ids.indexOf(id) === i && !(id in trustCache); });
    if (need.length) {
      var r = await sb.rpc('get_trust', { p_ids: need });
      need.forEach(function (id) { trustCache[id] = null; });
      (r.data || []).forEach(function (t) { trustCache[t.id] = t; });
    }
    return trustCache;
  };
  // "후기 12 · 좋아요 92%" 한 줄 (후기 없으면 빈 문자열)
  PS.trustLine = function (t) {
    if (!t || !t.review_count) return '';
    return '후기 ' + t.review_count + ' · 좋았어요 ' + Math.round(t.good / t.review_count * 100) + '%';
  };
  PS.warnHtml = function (t) {
    if (!t || !t.warned) return '';
    return '<div class="trust-warn"><b>⚠️ 여러 번 사기 신고를 받은 사용자예요</b>운영팀이 확인하고 있어요. 먼저 돈을 보내지 말고, 만나서 물건을 확인한 뒤 거래해 주세요.</div>';
  };
  // 직접 거래 안전 수칙
  PS.SAFE_TRADE_TIPS = ['되도록 만나서 물건을 확인한 뒤 돈을 주세요', '물건을 받기 전에 먼저 송금하지 마세요', '송금 전 경찰청 사이버범죄 신고시스템에서 상대 계좌·전화번호를 조회해 보세요', '판다산다 밖 메신저나 링크로 옮기자고 하면 의심하세요'];
  PS.CYBER_COP_URL = 'https://ecrm.police.go.kr/'; // 경찰청 사이버범죄 신고시스템 (사기 신고·계좌 조회)
  // 메시지에 계좌번호처럼 보이는 숫자가 있는가
  PS.hasAccountNo = function (text) {
    text = String(text || '').replace(/01[016789][- .]?\d{3,4}[- .]?\d{4}/g, ''); // 휴대폰 번호는 빼고
    return /(?:^|\D)(?:\d[\d -]{8,20}\d)(?:\D|$)/.test(text || '') && /계좌|입금|송금|은행|뱅크|농협|국민|신한|우리|하나|기업|새마을|우체국|\d{2,6}-\d{2,6}-\d{2,8}/.test(text || '');
  };

  var trustSheet = null;
  function sheetOpen(html) {
    if (!trustSheet) {
      var bg = document.createElement('div'); bg.className = 'sheet-bg'; bg.id = 'trustBg';
      var sh = document.createElement('div'); sh.className = 'sheet'; sh.id = 'trustSheet'; sh.setAttribute('role', 'dialog');
      document.body.appendChild(bg); document.body.appendChild(sh);
      bg.addEventListener('click', sheetClose);
      trustSheet = sh;
    }
    trustSheet.innerHTML = '<div class="handle"></div>' + html;
    trustSheet.classList.add('show'); document.getElementById('trustBg').classList.add('show');
    return trustSheet;
  }
  function sheetClose() {
    if (!trustSheet) return;
    trustSheet.classList.remove('show'); document.getElementById('trustBg').classList.remove('show');
  }

  // ---- 목록 검색 (판매완료·주문 내역): 글자 + 기간 ----
  // el 에 검색 줄을 그리고, 바뀔 때마다 onChange(). f.test(['판매자', '물건', ...], iso날짜) 로 거름
  PS.makeFilter = function (el, placeholder, onChange) {
    var st = { q: '', period: 'all', from: '', to: '' };
    var PERIODS = { all: '전체', '1m': '1개월', '3m': '3개월', '6m': '6개월', custom: '직접 선택' };
    var timer = null;
    function draw() {
      el.innerHTML = '<div class="lfilter">' +
        '<label class="lf-q">' + PS.icon('search', 18) + '<input type="search" id="lfQ" placeholder="' + PS.esc(placeholder) + '" value="' + PS.esc(st.q) + '" autocomplete="off" aria-label="검색어"></label>' +
        '<div class="lf-p" role="group" aria-label="기간">' + Object.keys(PERIODS).map(function (k) {
          return '<button type="button" data-p="' + k + '" class="' + (st.period === k ? 'on' : '') + '" aria-pressed="' + (st.period === k) + '">' + PERIODS[k] + '</button>';
        }).join('') + '</div>' +
        (st.period === 'custom' ? '<div class="lf-d"><input type="date" class="input" id="lfFrom" value="' + st.from + '" aria-label="시작일"><span>~</span><input type="date" class="input" id="lfTo" value="' + st.to + '" aria-label="종료일"></div>' : '') +
        '</div>';
    }
    draw();
    el.addEventListener('input', function (e) {
      if (e.target.id === 'lfQ') { st.q = e.target.value; clearTimeout(timer); timer = setTimeout(onChange, 150); }
    });
    el.addEventListener('change', function (e) {
      if (e.target.id === 'lfFrom') { st.from = e.target.value; onChange(); }
      if (e.target.id === 'lfTo') { st.to = e.target.value; onChange(); }
    });
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-p]');
      if (!b) return;
      st.period = b.dataset.p;
      draw();
      onChange();
    });
    function bounds() {
      if (st.period === 'all') return null;
      if (st.period === 'custom') {
        return { from: st.from ? new Date(st.from + 'T00:00:00') : null, to: st.to ? new Date(st.to + 'T23:59:59.999') : null };
      }
      var d = new Date();
      d.setMonth(d.getMonth() - Number(st.period.charAt(0)));
      return { from: d, to: null };
    }
    var norm = function (t) { return String(t || '').toLowerCase().replace(/\s+/g, ''); };
    return {
      active: function () { return !!st.q.trim() || st.period !== 'all'; },
      test: function (texts, iso) {
        var q = norm(st.q);
        if (q && !texts.some(function (t) { return norm(t).indexOf(q) !== -1; })) return false;
        var b = bounds();
        if (b) {
          var t = iso ? new Date(iso) : null;
          if (!t) return false;
          if (b.from && t < b.from) return false;
          if (b.to && t > b.to) return false;
        }
        return true;
      },
      setPlaceholder: function (ph) { placeholder = ph; var i = el.querySelector('#lfQ'); if (i) i.placeholder = ph; }
    };
  };
  // 주문 하나에서 검색할 글자들
  PS.orderTexts = function (o, names, role) {
    var other = role === 'seller' ? o.buyer_id : o.seller_id;
    var items = Array.isArray(o.market_order_items) ? o.market_order_items : [];
    return [(names[other] && names[other].name) || '', o.product_title, o.order_no, o.recipient || ''].concat(items.map(function (it) { return it.product_title; }));
  };
  PS.FILTER_EMPTY = '<div class="empty" style="padding:40px 0">' + '<b>조건에 맞는 내역이 없어요</b>검색어나 기간을 바꿔 보세요</div>';

  // ---- 정산 계좌 등록·변경 (판매내역·안전결제 신청·마이에서 같이 씀) ----
  PS.BANKS = ['KB국민', '신한', '우리', '하나', 'NH농협', 'IBK기업', 'SC제일', '카카오뱅크', '토스뱅크', '케이뱅크', '새마을금고', '우체국', '수협', '신협', '부산', 'iM뱅크(대구)', '경남', '광주', '전북', '제주', 'KDB산업'];
  PS.myPayoutAccount = async function () {
    if (!PS.user) return null;
    var r = await sb.from('seller_payout_accounts').select('bank_name,account_no,holder_name').eq('profile_id', PS.user.id).maybeSingle();
    return r.error ? null : r.data;
  };
  // opts: { account, onSaved }
  PS.openPayoutAccount = function (opts) {
    opts = opts || {};
    if (!PS.user) return PS.goLogin();
    var a = opts.account || {};
    var sh = sheetOpen('<h3 style="font-size:19px;font-weight:800">정산 계좌</h3>' +
      '<p style="color:var(--sub);font-size:14px;margin-top:4px">안전결제로 팔린 판매 대금이 이 계좌로 들어와요. 판매자 본인(사업자) 명의 계좌만 쓸 수 있어요.</p>' +
      '<label class="field"><span>은행</span><select class="input" id="acBank" style="appearance:auto">' + PS.BANKS.map(function (b) {
        return '<option' + (b === a.bank_name ? ' selected' : '') + '>' + PS.esc(b) + '</option>';
      }).join('') + '</select></label>' +
      '<label class="field"><span>계좌번호</span><input class="input" id="acNo" inputmode="numeric" maxlength="30" autocomplete="off" placeholder="숫자만 입력" value="' + PS.esc(a.account_no || '') + '"></label>' +
      '<label class="field"><span>예금주</span><input class="input" id="acHolder" maxlength="30" autocomplete="off" placeholder="통장에 적힌 이름 (상호 또는 대표자)" value="' + PS.esc(a.holder_name || '') + '"></label>' +
      '<button type="button" class="btn" id="acSave" style="margin-top:16px">저장하기</button>');
    sh.querySelector('#acSave').onclick = async function () {
      var b = this;
      var no = sh.querySelector('#acNo').value.replace(/[^0-9-]/g, ''), holder = sh.querySelector('#acHolder').value.trim();
      if (no.replace(/-/g, '').length < 6) { PS.toast('계좌번호를 확인해 주세요'); return; }
      if (!holder) { PS.toast('예금주를 써 주세요'); return; }
      b.disabled = true;
      var row = { profile_id: PS.user.id, bank_name: sh.querySelector('#acBank').value, account_no: no, holder_name: holder, updated_at: new Date().toISOString() };
      var r = await sb.from('seller_payout_accounts').upsert(row);
      b.disabled = false;
      if (r.error) { PS.toast('저장하지 못했어요. 잠시 후 다시 해 주세요'); return; }
      sheetClose();
      PS.toast('정산 계좌를 저장했어요');
      if (opts.onSaved) opts.onSaved(row);
    };
  };

  // 사기 신고. opts: { name, productId, chatId }
  PS.openReport = function (targetId, opts) {
    opts = opts || {};
    if (!PS.user) return PS.goLogin();
    var sh = sheetOpen('<h3 style="font-size:19px;font-weight:800">' + PS.esc(opts.name || '이 사용자') + '님 신고하기</h3>' +
      '<p style="color:var(--sub);font-size:14px;margin-top:4px">운영팀이 확인해요. 서로 다른 여러 명에게 신고되면 다른 이용자에게 주의 표시가 보여요.</p>' +
      '<div style="margin-top:8px">' + Object.keys(PS.REPORT_REASONS).map(function (k, i) {
        return '<label class="chk" style="display:flex;gap:8px;align-items:center;padding:10px 0;font-size:16px"><input type="radio" name="rpReason" value="' + k + '"' + (i ? '' : ' checked') + '>' + PS.REPORT_REASONS[k] + '</label>';
      }).join('') + '</div>' +
      '<label class="field"><span>자세한 내용 (선택)</span><textarea class="input" id="rpDetail" rows="3" maxlength="1000" placeholder="언제, 얼마를, 어떻게 거래했는지 써 주시면 확인이 빨라요" style="height:auto;padding-top:10px"></textarea></label>' +
      '<p style="font-size:13px;color:var(--sub);margin-top:8px">돈을 보냈는데 물건을 못 받았다면 <a href="' + PS.CYBER_COP_URL + '" target="_blank" rel="noopener" style="text-decoration:underline">경찰청 사이버범죄 신고시스템</a>에도 꼭 신고해 주세요.</p>' +
      '<button type="button" class="btn" id="rpSend" style="margin-top:14px">신고하기</button>');
    sh.querySelector('#rpSend').onclick = async function () {
      var b = this; b.disabled = true;
      var reason = (sh.querySelector('input[name=rpReason]:checked') || {}).value || 'etc';
      var r = await sb.rpc('report_user', { p_target: targetId, p_reason: reason, p_detail: sh.querySelector('#rpDetail').value, p_product_id: opts.productId || null, p_chat_id: opts.chatId || null });
      b.disabled = false;
      var code = r.error ? 'error' : r.data;
      if (code === 'ok') { sheetClose(); delete trustCache[targetId]; PS.toast('신고했어요. 운영팀이 확인할게요'); return; }
      PS.toast({ already: '이미 신고한 사용자예요', self: '나를 신고할 수는 없어요', too_many: '오늘은 더 신고할 수 없어요. 고객센터로 알려 주세요', login_required: '다시 로그인해 주세요' }[code] || '신고하지 못했어요. 잠시 후 다시 해 주세요');
    };
  };

  // 거래 후기. opts: { chatId } 또는 { orderId }, name
  PS.openReview = function (opts) {
    if (!PS.user) return PS.goLogin();
    var rating = 'good';
    var sh = sheetOpen('<h3 style="font-size:19px;font-weight:800">' + (opts.name ? PS.esc(opts.name) + '님과의 거래 어땠나요?' : '거래 어땠나요?') + '</h3>' +
      '<div class="rate-pick" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:14px">' + Object.keys(PS.RATINGS).map(function (k) {
        return '<button type="button" class="btn ' + (k === 'good' ? '' : 'white') + ' small" data-rate="' + k + '">' + { good: '😊', ok: '🙂', bad: '😞' }[k] + ' ' + PS.RATINGS[k] + '</button>';
      }).join('') + '</div>' +
      '<label class="field"><span>한 줄 후기 (선택)</span><textarea class="input" id="rvText" rows="3" maxlength="300" placeholder="예) 약속 시간 잘 지키고 물건 상태도 설명대로였어요" style="height:auto;padding-top:10px"></textarea></label>' +
      '<p style="font-size:13px;color:var(--sub);margin-top:8px">후기는 상대 프로필에 공개되고, 한 거래에 한 번만 남길 수 있어요.</p>' +
      '<button type="button" class="btn" id="rvSend" style="margin-top:14px">후기 남기기</button>');
    sh.querySelector('.rate-pick').onclick = function (e) {
      var b = e.target.closest('[data-rate]'); if (!b) return;
      rating = b.dataset.rate;
      this.querySelectorAll('[data-rate]').forEach(function (x) { x.classList.toggle('white', x !== b); });
    };
    sh.querySelector('#rvSend').onclick = async function () {
      var b = this; b.disabled = true;
      var r = await sb.rpc('write_trade_review', { p_chat_id: opts.chatId || null, p_order_id: opts.orderId || null, p_rating: rating, p_comment: sh.querySelector('#rvText').value });
      b.disabled = false;
      var code = r.error ? 'error' : r.data;
      if (code === 'ok') { sheetClose(); trustCache = {}; PS.toast('후기를 남겼어요. 고마워요!'); if (opts.onDone) opts.onDone(); return; }
      PS.toast({ already: '이미 후기를 남긴 거래예요', not_traded: '서로 대화를 나눈 거래에만 후기를 남길 수 있어요', not_member: '내 거래가 아니에요', login_required: '다시 로그인해 주세요' }[code] || '후기를 남기지 못했어요. 잠시 후 다시 해 주세요');
    };
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

  // 배송·취소·환불 안내 요약 (물건 상세, 결제 화면). 내용은 policy.html, 이용약관 제17조~제19조와 같아야 한다
  PS.policyHtml = function (open) {
    return '<details class="policy"' + (open ? ' open' : '') + '><summary>배송·취소·환불 안내</summary>' +
      '<h4>배송</h4><ul>' +
        '<li>판매자가 결제일부터 3영업일 안에 택배 또는 화물로 보내요. 보내면 주문 내역에서 택배사와 송장번호를 볼 수 있어요.</li>' +
        '<li><b>결제일부터 최대 14일 안에 받아요.</b> 택배는 보통 보낸 날부터 1~3일, 화물은 판매자와 정한 날에 도착해요.</li>' +
        '<li>크거나 무거운 물건은 판매자와 채팅으로 배송 방법과 날짜를 정해요.</li>' +
        '<li>배송비는 물건마다 다르고, 결제 전에 물품 금액과 따로 보여 드려요.</li></ul>' +
      '<h4>취소·환불</h4><ul>' +
        '<li>판매자가 보내기 전에는 주문 내역에서 바로 취소할 수 있고, 전액 환불돼요.</li>' +
        '<li>보낸 뒤에는 주문 내역에서 취소를 요청하고, 판매자가 동의하면 전액 환불돼요.</li>' +
        '<li>받은 물건이 설명과 다르거나 고장·파손된 경우, 받은 날부터 7일 안에 판매자 채팅이나 고객센터로 알려 주시면 반품 후 환불해 드려요. 이때 반품 배송비는 판매자가 내요.</li>' +
        '<li>사업자가 판매한 물건은 받은 날부터 7일 안에 단순 변심으로도 반품할 수 있어요. 이때 반품 배송비는 구매자가 내고, 사용했거나 훼손되어 가치가 떨어진 물건은 반품이 어려울 수 있어요.</li>' +
        '<li>환불은 결제한 수단으로 돌려 드리며, 카드사에 따라 3~7영업일이 걸릴 수 있어요.</li>' +
        '<li>교환은 판매자와 채팅으로 상의해 주세요.</li></ul>' +
      '<p><a href="/policy">배송·취소·환불 안내 전체 보기</a> · 고객센터 <a href="tel:' + PS.BIZ.phone + '">' + PS.BIZ.phone + '</a></p>' +
      '</details>';
  };

  // <footer class="site-foot" id="siteFoot"> 에 사업자 정보를 채운다
  PS.renderFooter = function () {
    var el = document.getElementById('siteFoot');
    if (!el) return;
    var b = PS.BIZ;
    el.innerHTML =
      '<b>판다산다 고객센터 <a href="tel:' + b.phone + '">' + b.phone + '</a></b>' +
      '<p>상호 ' + b.name + ' · 대표자 ' + b.ceo + '<br>' +
        '사업자등록번호 ' + b.regNo + ' · 통신판매업 신고번호 ' + b.mailOrderNo + '<br>' +
        '사업장 주소 ' + b.address + '<br>' +
        '전화 <a href="tel:' + b.phone + '">' + b.phone + '</a> · 이메일 <a href="mailto:' + b.email + '">' + b.email + '</a></p>' +
      '<p>판다산다는 회사가 직접 판매하는 물건을 제외하고는 통신판매중개자로서 거래 당사자가 아니며, 회원이 올린 물건 정보와 거래에 대한 책임은 해당 판매자에게 있습니다.</p>' +
      '<p class="links"><a href="/terms">이용약관</a><a href="/privacy"><strong>개인정보처리방침</strong></a><a href="/policy">배송·취소·환불 안내</a></p>';
  };

  PS.signOut = async function () {
    // 이 기기로는 더 이상 이 계정의 채팅 알림이 오지 않게 (공용 PC 등)
    try { if ('serviceWorker' in navigator && PS.push) await Promise.race([PS.push.disable(), new Promise(function (r) { setTimeout(r, 2000); })]); } catch (e) {}
    await sb.auth.signOut();
    location.href = '/';
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { PS.hydrate(); PS.renderFooter(); });
  else { PS.hydrate(); PS.renderFooter(); }

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
  if (/^\/(chat|mypage|sales|purchases|favorites|recent|keywords|settings|neighborhood|price|shipping|cart|checkout|edit|pay-seller|my-biz|biz-premium|biz-new|biz-verify|biz\/(new|verify))(\/|\.html|$)/.test(location.pathname)) document.documentElement.classList.add('pc-70');

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

  // 안 읽은 채팅 수: 탭바 숫자 배지 + 브라우저 탭 제목 앞 (n)
  var baseTitle = null;
  async function refreshChatDot() {
    if (!PS.user) return;
    var res = await sb.from('messages').select('id', { count: 'exact', head: true })
      .is('read_at', null).neq('sender_id', PS.user.id);
    var n = res.count || 0;
    PS.unreadChats = n;
    var dot = document.getElementById('chatDot');
    if (dot) { dot.classList.toggle('show', n > 0); dot.textContent = n > 99 ? '99+' : n ? String(n) : ''; }
    if (baseTitle === null) baseTitle = document.title.replace(/^\(\d+\+?\)\s*/, '');
    document.title = (n ? '(' + (n > 99 ? '99+' : n) + ') ' : '') + baseTitle;
  }
  PS.refreshChatDot = refreshChatDot;

  // ---- 새 채팅 알림 (사이트를 열어 둔 동안) ----
  // 어느 화면에 있든 새 메시지가 오면 배지 갱신 + 위쪽 알림 띠. 'ps:message' 이벤트로 화면에도 알림
  function showMessageBanner(m, name) {
    var el = document.getElementById('psMsgBanner');
    if (!el) {
      el = document.createElement('a');
      el.id = 'psMsgBanner';
      el.className = 'msg-banner';
      document.body.appendChild(el);
    }
    el.href = '/chat/' + m.chat_id;
    el.innerHTML = '<span class="mb-ico" aria-hidden="true">' + PS.icon3d('chat', 28) + '</span><span class="mb-tx"><b>' + PS.esc(name || '이웃') + '님의 새 메시지</b>' +
      '<span>' + PS.esc(String(m.message || '').slice(0, 80)) + '</span></span>';
    el.classList.add('show');
    clearTimeout(PS._bannerTimer);
    PS._bannerTimer = setTimeout(function () { el.classList.remove('show'); }, 5000);
  }
  function watchMessages() {
    if (!PS.user || PS._msgWatch) return;
    PS._msgWatch = sb.channel('ps-inbox-' + PS.user.id)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, async function (payload) {
        var m = payload.new;
        if (!m || m.sender_id === PS.user.id) return;
        window.dispatchEvent(new CustomEvent('ps:message', { detail: m }));
        // 그 채팅방을 보고 있으면 배지·띠 없이 (채팅방이 직접 읽음 처리)
        var inRoom = PS.idFromUrl('chat') === m.chat_id && document.visibilityState === 'visible';
        setTimeout(refreshChatDot, inRoom ? 1500 : 0);
        if (inRoom) return;
        var who = (await PS.publicProfiles([m.sender_id]))[m.sender_id];
        showMessageBanner(m, who && who.name);
      })
      .subscribe();
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refreshChatDot(); });
  }
  PS.ready.then(function (user) { if (user) { watchMessages(); PS.push.sync(); } });

  // ---- 웹 푸시 (사이트를 닫아도 휴대폰·PC 알림) ----
  // 공개 키. 비밀 키는 Supabase Edge Function 비밀값(VAPID_PRIVATE_KEY)에만 있다
  PS.VAPID_PUBLIC_KEY = 'BCfvZwThfSlnH4f_hBfj5xcBkwoopNdEVkMR-WPesRh_PwljcAT_zvCOFRSH7mcp9c7HNBcRvkSpofLwcUDdO-s';
  function b64ToBytes(b64) {
    var s = (b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(s), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  PS.push = {
    // 'unsupported' | 'ios_install' (아이폰: 홈 화면에 추가해야 함) | 'denied' | 'default' | 'granted'
    state: function () {
      var ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
      var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return ios && !standalone ? 'ios_install' : 'unsupported';
      if (ios && !standalone) return 'ios_install';
      return Notification.permission;
    },
    // 알림 켜기: 권한 요청 → 구독 → 서버 저장. 결과: 'ok' | 'denied' | 'unsupported' | 'error'
    enable: async function () {
      var st = PS.push.state();
      if (st === 'unsupported' || st === 'ios_install') return 'unsupported';
      try {
        var perm = await Notification.requestPermission();
        if (perm !== 'granted') return 'denied';
        return (await PS.push.sync(true)) ? 'ok' : 'error';
      } catch (e) { console.warn('[판다산다] 알림 켜기 실패', e); return 'error'; }
    },
    // 권한이 있으면 이 브라우저 구독을 지금 로그인한 계정에 저장 (계정을 바꿔 로그인해도 맞춰짐)
    sync: async function (force) {
      try {
        if (!PS.user || PS.push.state() !== 'granted') return false;
        var reg = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
        var sub = await reg.pushManager.getSubscription();
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(PS.VAPID_PUBLIC_KEY) });
        var j = sub.toJSON();
        var key = 'ps_push_saved';
        var mark = PS.user.id + '|' + j.endpoint;
        var saved = null;
        try { saved = localStorage.getItem(key); } catch (e) {}
        if (!force && saved === mark) return true;
        var r = await sb.rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_user_agent: navigator.userAgent });
        if (r.error || r.data !== 'ok') return false;
        try { localStorage.setItem(key, mark); } catch (e) {}
        return true;
      } catch (e) { console.warn('[판다산다] 알림 구독 실패', e); return false; }
    },
    // 이 브라우저 알림 끄기
    disable: async function () {
      try {
        var reg = await navigator.serviceWorker.getRegistration('/sw.js');
        var sub = reg && await reg.pushManager.getSubscription();
        if (sub) {
          await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
          await sub.unsubscribe();
        }
        try { localStorage.removeItem('ps_push_saved'); } catch (e) {}
        return true;
      } catch (e) { return false; }
    },
    // 알림 켜기 안내 띠 (채팅 목록 등). 켤 필요가 없으면 빈 문자열
    promptHtml: function () {
      var st = PS.push.state();
      var off = false;
      try { off = localStorage.getItem('ps_push_prompt_off') === '1'; } catch (e) {}
      if (off || st === 'granted' || st === 'unsupported') return '';
      if (st === 'ios_install') return '<div class="push-prompt"><div><b>채팅 알림을 받으려면</b><span>Safari 아래 공유 버튼 → "홈 화면에 추가" 후, 홈 화면의 판다산다에서 알림을 켜 주세요</span></div><button type="button" class="pp-x" aria-label="닫기">✕</button></div>';
      if (st === 'denied') return '<div class="push-prompt"><div><b>채팅 알림이 꺼져 있어요</b><span>브라우저 주소창 옆 사이트 설정에서 알림을 허용해 주세요</span></div><button type="button" class="pp-x" aria-label="닫기">✕</button></div>';
      return '<div class="push-prompt"><div><b>새 채팅이 오면 알려 드릴까요?</b><span>사이트를 닫아도 휴대폰·PC로 알림이 와요</span></div><button type="button" class="btn small" id="ppOn">알림 켜기</button><button type="button" class="pp-x" aria-label="닫기">✕</button></div>';
    },
    bindPrompt: function (root, rerender) {
      root.addEventListener('click', async function (e) {
        if (e.target.closest('.pp-x')) {
          try { localStorage.setItem('ps_push_prompt_off', '1'); } catch (err) {}
          var box = e.target.closest('.push-prompt'); if (box) box.remove();
        }
        var on = e.target.closest('#ppOn');
        if (on) {
          on.disabled = true;
          var r = await PS.push.enable();
          PS.toast(r === 'ok' ? '알림을 켰어요! 새 채팅이 오면 알려 드릴게요' : r === 'denied' ? '알림이 허용되지 않았어요' : '이 브라우저에서는 알림을 켤 수 없어요');
          if (rerender) rerender();
        }
      });
    }
  };

  // 하단 탭바는 모든 페이지에 항상 고정 (페이지가 직접 그리지 않으면 주소로 판단해 자동으로)
  function autoTabbar() {
    if (document.querySelector('nav.tabbar')) return;
    var path = location.pathname;
    var key = path === '/' || path === '/index' ? 'home'
      : /^\/sell/.test(path) ? 'sell'
      : /^\/(buy|product|checkout|pay-(?!seller)|biz\/(?!new|verify)|business)/.test(path) ? 'buy'
      : /^\/chat/.test(path) ? 'chat'
      : /^\/(mypage|sales|purchases|favorites|recent|keywords|settings|neighborhood|price|pay-seller|my-biz|biz-premium|biz\/new|biz\/verify|biz-new|biz-verify)/.test(path) ? 'my' : '';
    PS.renderTabbar(key);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(autoTabbar, 0); });
  else setTimeout(autoTabbar, 0);
})();
