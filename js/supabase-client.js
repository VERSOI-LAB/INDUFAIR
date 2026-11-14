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
    var url = await window.psInviteUrl(path);
    if (navigator.share) {
      try { await navigator.share({ title: title, text: text, url: url }); return 'shared'; } catch (e) { if (e && e.name === 'AbortError') return 'cancel'; }
    }
    try { await navigator.clipboard.writeText((text ? text + '\n' : '') + url); return 'copied'; } catch (e) {}
    window.prompt('아래 주소를 복사해 주세요', url);
    return 'prompt';
  };
})();
