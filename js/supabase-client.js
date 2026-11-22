// PANDA SANDA(판다산다) — shared Supabase client. Include AFTER the supabase-js CDN <script>
// and BEFORE any page-specific script that uses `sb`.
(function () {
  var SUPABASE_URL = 'https://rqjfergjfhcrcuvfuhkm.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_RdtDN6VAPjOikX0CS-oT4A___yzI5w2';

  if (!window.supabase || !window.supabase.createClient) {
    console.error('[PANDA SANDA(판다산다)] supabase-js not loaded — include the CDN script before supabase-client.js');
    return;
  }

  window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  // ---- 친구 초대: ?ref=코드 로 들어오면 기억했다가, 가입(로그인)하면 '누가 데려왔는지' 기록 ----
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var ref = (location.search.match(/[?&]ref=([a-z0-9]{8})(?:&|$)/i) || [])[1];
  if (ref && !store.get('ps_ref')) store.set('ps_ref', ref.toLowerCase() + '|' + Date.now());
  var claiming = false;
  window.sb.auth.onAuthStateChange(function (event, session) {
    if (event === 'SIGNED_OUT') store.del('ps_my_ref'); // 다른 사람이 같은 기기에서 로그인할 때 섞이지 않게
    var saved = store.get('ps_ref');
    if (!saved || !session || claiming) return;
    var parts = saved.split('|');
    if (Date.now() - Number(parts[1] || 0) > 30 * 86400000) { store.del('ps_ref'); return; } // 30일 지나면 버림
    claiming = true;
    setTimeout(function () { // 인증 처리 중에는 다른 요청을 바로 보내지 않는 게 안전
      window.sb.rpc('claim_referral', { p_code: parts[0] }).then(function (r) {
        claiming = false;
        if (!r.error && r.data !== 'no_profile') store.del('ps_ref'); // 프로필이 아직 없으면 다음에 다시
      });
    }, 0);
  });

  // 내 초대 코드를 붙인 주소 (로그인 안 했으면 그냥 주소)
  window.psInviteUrl = async function (path) {
    var url = 'https://www.pandasanda.com' + (path || '/');
    var code = store.get('ps_my_ref');
    if (!code) {
      var u = await window.sb.auth.getSession();
      if (!u.data || !u.data.session) return url;
      var r = await window.sb.rpc('my_invite');
      code = r.data && r.data.code;
      if (code) store.set('ps_my_ref', code);
    }
    return code ? url + (url.indexOf('?') < 0 ? '?' : '&') + 'ref=' + code : url;
  };

  // 공유: 휴대폰은 공유 창, 아니면 주소 복사
  window.psShare = async function (title, text, path) {
    var how = await shareOnce(title, text, await window.psInviteUrl(path));
    if (how !== 'cancel' && window.psTrack) window.psTrack('share', { target: path || '/', how: how });
    return how;
  };
  async function shareOnce(title, text, url) {
    if (navigator.share) {
      try { await navigator.share({ title: title, text: text, url: url }); return 'shared'; } catch (e) { if (e && e.name === 'AbortError') return 'cancel'; }
    }
    try { await navigator.clipboard.writeText((text ? text + '\n' : '') + url); return 'copied'; } catch (e) {}
    window.prompt('아래 주소를 복사해 주세요', url);
    return 'prompt';
  }

  // ---- 마케팅 측정: psTrack('이벤트이름', { 추가 정보 }) ----
  //   - 우리 DB(marketing_events)에 쌓음. 쿠키 없음, 90일 뒤 자동 삭제 (supabase/migrations/20261122_marketing_events.sql)
  //   - GA4_ID 를 넣으면 Google Analytics 4 에도 같이 보냄. 켜기 전에 개인정보처리방침(쿠키 항목, 처리 위탁)을 먼저 고칠 것
  var GA4_ID = ''; // 예) 'G-XXXXXXXXXX'
  var isBot = navigator.webdriver || /bot|crawl|spider|slurp|headless|lighthouse/i.test(navigator.userAgent || '');
  var session = {
    get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  };
  function anonId() {
    var id = store.get('ps_aid');
    if (!id || !/^[a-z0-9]{8,32}$/.test(id)) {
      id = (Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^a-z0-9]/g, '').slice(0, 24);
      store.set('ps_aid', id);
    }
    return id;
  }
  function clip(s, n) { return String(s == null ? '' : s).slice(0, n); }
  // 처음 들어온 경로(UTM·검색·외부 링크)를 기억 → 가입·전환이 어느 채널 덕분인지 알 수 있게. 새 UTM 으로 오면 새로 씀
  var qs = new URLSearchParams(location.search);
  var refHost = '';
  try { refHost = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, '') : ''; } catch (e) {}
  if (refHost === location.hostname.replace(/^www\./, '')) refHost = '';
  var utmNow = {};
  ['source', 'medium', 'campaign', 'content', 'term'].forEach(function (k) { var v = qs.get('utm_' + k); if (v) utmNow[k] = clip(v, 80); });
  if (ref) { utmNow.source = utmNow.source || 'invite'; utmNow.medium = utmNow.medium || 'referral'; }
  var firstTouch = null;
  try { firstTouch = JSON.parse(store.get('ps_utm') || 'null'); } catch (e) {}
  if (!isBot && (Object.keys(utmNow).length || !firstTouch)) {
    firstTouch = Object.assign({}, utmNow, { referrer: refHost || undefined, landing: clip(location.pathname, 120), at: new Date().toISOString().slice(0, 10) });
    store.set('ps_utm', JSON.stringify(firstTouch));
  }

  if (GA4_ID && !isBot) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA4_ID);
    var gs = document.createElement('script');
    gs.async = true; gs.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA4_ID);
    document.head.appendChild(gs);
  }

  // 페이지를 바로 옮겨도 기록이 끊기지 않게 keepalive 로 보냄. 실패해도 화면에는 영향 없음
  window.psTrack = async function (name, props) {
    if (isBot || !/^[a-z][a-z0-9_]{1,39}$/.test(name)) return;
    var clean = {};
    Object.keys(props || {}).slice(0, 15).forEach(function (k) {
      var v = props[k];
      if (v == null) return;
      clean[clip(k, 30)] = typeof v === 'number' || typeof v === 'boolean' ? v : clip(v, 120);
    });
    if (window.gtag) { try { window.gtag('event', name, clean); } catch (e) {} }
    // 기록에 남기면 안 되는 주소 값(수신거부 토큰, 결제 키 등)은 빼고
    var sp = new URLSearchParams(location.search);
    ['t', 'token', 'paymentKey', 'authKey', 'customerKey', 'orderId', 'code'].forEach(function (k) { sp.delete(k); });
    var at = clip(location.pathname + (sp.toString() ? '?' + sp : ''), 300);
    try {
      var s = await window.sb.auth.getSession();
      var token = s.data && s.data.session ? s.data.session.access_token : SUPABASE_ANON_KEY;
      fetch(SUPABASE_URL + '/rest/v1/marketing_events', {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token, Prefer: 'return=minimal' },
        body: JSON.stringify({ anon_id: anonId(), name: name, path: at, props: clean, utm: firstTouch || {} })
      }).catch(function () {});
    } catch (e) {}
  };

  // 자동 메시지(푸시·이메일)를 눌러 들어옴: ?jm=메시지이름 → 기록하고 주소에서 지움 (supabase/functions/journeys)
  var jm = qs.get('jm');
  if (jm && /^[a-z0-9_]{2,40}$/.test(jm)) {
    window.psTrack('journey_click', { journey: jm });
    qs.delete('jm');
    try { history.replaceState(history.state, '', location.pathname + (qs.toString() ? '?' + qs : '') + location.hash); } catch (e) {}
  }

  // 방문 시작 (브라우저 탭 세션마다 한 번): 어디서 왔는지
  if (!session.get('ps_ss')) {
    session.set('ps_ss', '1');
    window.psTrack('session_start', Object.assign({ landing: location.pathname, referrer: refHost }, utmNow));
  }

  // 가입: 계정이 만들어진 지 15분 안에 처음 로그인된 순간 한 번 (이메일 확인 링크·카카오 로그인 모두)
  window.sb.auth.onAuthStateChange(function (event, sess) {
    if (event !== 'SIGNED_IN' || !sess || !sess.user) return;
    var u = sess.user, key = 'ps_su_' + u.id;
    if (store.get(key) || Date.now() - Date.parse(u.created_at) > 15 * 60000) return;
    store.set(key, '1');
    setTimeout(function () { window.psTrack('sign_up', { method: (u.app_metadata && u.app_metadata.provider) || 'email', invited: !!store.get('ps_ref') }); }, 0);
  });
})();
