// 판다산다 공용 스크립트: 로그인 상태, 하단 탭바, 포맷 유틸, 상품 카드.
// supabase-js CDN → js/supabase-client.js → js/app.js 순서로 불러온다.
(function () {
  var sb = window.sb;
  var PS = window.PS = {};

  PS.FUNCTIONS_URL = 'https://rqjfergjfhcrcuvfuhkm.supabase.co/functions/v1';

  PS.CATEGORIES = ['기계장비', '집진기', '에어콤프레샤', '모터', '펌프', '전기부품', '공구', '중고부품', '기타'];
  PS.CONDITIONS = { great: '아주 좋아요', good: '괜찮아요', broken: '고장 있어요' };
  PS.USAGE = { lt1: '1년 미만', '1to3': '1~3년', gt3: '3년 이상' };
  PS.STATUS = { selling: '판매중', reserved: '예약중', sold: '판매완료' };

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

  PS.firstImage = function (p) {
    var imgs = (p.product_images || []).slice().sort(function (a, b) { return a.sort_order - b.sort_order; });
    return imgs.length ? imgs[0].url : null;
  };

  function photoHtml(p) {
    var url = PS.firstImage(p);
    var img = url ? '<img src="' + PS.esc(url) + '" alt="" loading="lazy">' : '<div class="noimg">📦</div>';
    if (p.status === 'sold') img += '<div class="sold-cover">판매완료</div>';
    return img;
  }

  function statusBadge(p) {
    if (p.status === 'reserved') return '<span class="badge reserved">예약중</span>';
    if (p.status === 'sold') return '<span class="badge sold">판매완료</span>';
    return '';
  }

  PS.productUrl = function (id) { return '/product/' + encodeURIComponent(id); };

  // 홈: 2열 카드
  PS.cardHtml = function (p) {
    return '<a class="card" href="' + PS.productUrl(p.id) + '">' +
      '<div class="ph">' + photoHtml(p) + '</div>' +
      '<div class="t">' + PS.esc(p.title) + '</div>' +
      '<div class="p">' + statusBadge(p) + PS.won(p.price) + '</div>' +
      '<div class="m">' + PS.esc(p.region || '') + (p.region ? ' · ' : '') + PS.ago(p.created_at) + '</div>' +
      '</a>';
  };

  // 산다/마이: 당근식 한 줄
  PS.rowHtml = function (p) {
    var stats = [];
    if (p.inquiry_count) stats.push('💬 ' + p.inquiry_count);
    if (p.like_count) stats.push('♡ ' + p.like_count);
    return '<a class="row" href="' + PS.productUrl(p.id) + '">' +
      '<div class="ph">' + photoHtml(p) + '</div>' +
      '<div class="info">' +
        '<div class="t">' + PS.esc(p.title) + '</div>' +
        '<div class="m">' + PS.esc(p.region || '') + (p.region ? ' · ' : '') + PS.ago(p.created_at) + '</div>' +
        '<div class="p">' + statusBadge(p) + PS.won(p.price) + '</div>' +
        '<div class="s">' + stats.join('') + '</div>' +
      '</div></a>';
  };

  PS.PRODUCT_LIST_COLUMNS = 'id,title,price,region,status,created_at,like_count,inquiry_count,view_count,product_images(url,sort_order)';

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

  PS.ready = (async function () {
    try {
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

  // ---- 하단 탭바 ----
  var TABS = [
    { key: 'home', href: '/', icon: '🏠', label: '홈' },
    { key: 'sell', href: '/sell', icon: '📷', label: '판다' },
    { key: 'buy', href: '/buy', icon: '🔍', label: '산다' },
    { key: 'chat', href: '/chat', icon: '💬', label: '채팅' },
    { key: 'my', href: '/mypage', icon: '🐼', label: '마이' }
  ];

  PS.renderTabbar = function (active) {
    var nav = document.createElement('nav');
    nav.className = 'tabbar';
    nav.setAttribute('aria-label', '메뉴');
    nav.innerHTML = TABS.map(function (t) {
      return '<a href="' + t.href + '" class="' + (t.key === active ? 'on' : '') + '"' + (t.key === active ? ' aria-current="page"' : '') + '>' +
        '<span class="ti" aria-hidden="true">' + t.icon + '</span>' + t.label +
        (t.key === 'chat' ? '<span class="dot" id="chatDot"></span>' : '') + '</a>';
    }).join('');
    document.body.appendChild(nav);
    PS.ready.then(function (user) { if (user) refreshChatDot(); });
  };

  async function refreshChatDot() {
    var res = await sb.from('messages').select('id', { count: 'exact', head: true })
      .is('read_at', null).neq('sender_id', PS.user.id);
    var dot = document.getElementById('chatDot');
    if (dot) dot.classList.toggle('show', (res.count || 0) > 0);
  }
})();
