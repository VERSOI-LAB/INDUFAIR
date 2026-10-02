// 판다산다 공용 스크립트: 로그인 상태, 하단 탭바, 포맷 유틸, 상품 카드.
// supabase-js CDN → js/supabase-client.js → js/app.js 순서로 불러온다.
(function () {
  var sb = window.sb;
  var PS = window.PS = {};

  PS.FUNCTIONS_URL = 'https://rqjfergjfhcrcuvfuhkm.supabase.co/functions/v1';

  PS.CATEGORIES = ['기계장비', '집진기', '에어콤프레샤', '모터', '펌프', '전기부품', '공구', '중고부품', '기타'];
  PS.CONDITIONS = { great: '아주 좋아요', good: '괜찮아요', broken: '고장 있어요' };
  PS.USAGE = { new: '신품', lt1: '1년 미만', '1to3': '1~3년', gt3: '3년 이상' };
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
    plus: '<path d="M12 5v14M5 12h14"/>'
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

  function statusBadge(p) {
    if (p.status === 'reserved') return '<span class="badge reserved">예약중</span>';
    if (p.status === 'sold') return '<span class="badge sold">판매완료</span>';
    return '';
  }

  PS.productUrl = function (id) { return '/product/' + encodeURIComponent(id); };
  PS.profileUrl = function (id) { return '/profile/' + encodeURIComponent(id); };

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
    if (p.inquiry_count) stats.push('<span>' + PS.icon('chat', 14) + ' ' + p.inquiry_count + '</span>');
    if (p.like_count) stats.push('<span>' + PS.icon('heart', 14) + ' ' + p.like_count + '</span>');
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
    { key: 'home', href: '/', icon: 'home', label: '홈' },
    { key: 'sell', href: '/sell', icon: 'sell', label: '판다' },
    { key: 'buy', href: '/buy', icon: 'buy', label: '산다' },
    { key: 'chat', href: '/chat', icon: 'chat', label: '채팅' },
    { key: 'my', href: '/mypage', icon: 'user', label: '마이' }
  ];

  PS.renderTabbar = function (active) {
    var nav = document.createElement('nav');
    nav.className = 'tabbar';
    nav.setAttribute('aria-label', '메뉴');
    nav.innerHTML = TABS.map(function (t) {
      return '<a href="' + t.href + '" class="' + (t.key === active ? 'on' : '') + '"' + (t.key === active ? ' aria-current="page"' : '') + '>' +
        '<span class="ti" aria-hidden="true">' + PS.icon3d(t.icon, 30) + '</span>' + t.label +
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
