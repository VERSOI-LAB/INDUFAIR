// VERSOI — shared auth/session layer. Include after supabase-client.js on every page.
// Syncs the header login state, guards protected pages, and exposes window.VERSOI.
(function () {
  if (!window.sb) { console.error('[VERSOI] sb client missing — include supabase-client.js first'); return; }

  var PATH = location.pathname.split('/').pop() || 'index.html';

  var BUYER_PROTECTED = ['mypage.html', 'order.html', 'shipping.html', 'cancel.html', 'account.html', 'cart.html'];
  var SELLER_PROTECTED = ['seller-dashboard.html', 'seller-products.html', 'seller-orders.html',
    'seller-inquiries.html', 'seller-settlement.html', 'seller-tax.html', 'seller-account.html'];

  function byText(root, texts) {
    var els = root.querySelectorAll('button, a');
    var out = [];
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || '').trim();
      if (texts.indexOf(t) !== -1) out.push(els[i]);
    }
    return out;
  }

  function goLogin() {
    var next = encodeURIComponent(location.pathname.split('/').pop() + location.search);
    location.href = 'login.html?redirect=' + next;
  }

  async function currentUser() {
    var res = await window.sb.auth.getSession();
    var session = res && res.data && res.data.session;
    if (!session) return null;
    var uid = session.user.id;
    var profRes = await window.sb.from('profiles').select('*').eq('id', uid).maybeSingle();
    var memberRes = await window.sb.from('company_members')
      .select('company_id, role, is_owner, status, companies(name)')
      .eq('profile_id', uid).eq('status', 'active').order('is_owner', { ascending: false }).limit(1).maybeSingle();
    return {
      id: uid,
      email: session.user.email,
      profile: profRes.data || null,
      company: memberRes.data ? { id: memberRes.data.company_id, name: memberRes.data.companies ? memberRes.data.companies.name : '', role: memberRes.data.role, isOwner: memberRes.data.is_owner } : null
    };
  }

  function syncHeader(user) {
    var actions = document.querySelector('.header-actions');
    if (!actions) return;

    var loginBtns = byText(actions, ['로그인']);
    var signupBtns = byText(actions, ['회원가입']);
    var mypageBtns = byText(actions, ['마이페이지']);
    var logoutBtns = byText(actions, ['로그아웃']);

    if (user) {
      loginBtns.forEach(function (el) {
        el.textContent = (user.profile && user.profile.name ? user.profile.name : user.email) + '님';
        el.classList.add('btn-ghost');
        if (el.tagName === 'A') el.setAttribute('href', user.company ? 'seller-dashboard.html' : 'mypage.html');
        else el.onclick = function () { location.href = user.company ? 'seller-dashboard.html' : 'mypage.html'; };
      });
      signupBtns.forEach(function (el) {
        el.textContent = '로그아웃';
        el.onclick = function (e) { e.preventDefault(); doLogout(); };
        if (el.tagName === 'A') el.setAttribute('href', '#');
      });
      mypageBtns.forEach(function (el) {
        if (el.tagName === 'A') el.setAttribute('href', user.company ? 'seller-dashboard.html' : 'mypage.html');
      });
      logoutBtns.forEach(function (el) {
        el.onclick = function (e) { e.preventDefault(); doLogout(); };
      });
    } else {
      mypageBtns.forEach(function (el) {
        el.textContent = '로그인';
        if (el.tagName === 'A') { el.setAttribute('href', 'login.html'); }
        else el.onclick = function () { goLogin(); };
      });
      logoutBtns.forEach(function (el) {
        el.textContent = '회원가입';
        el.onclick = null;
        if (el.tagName === 'A') el.setAttribute('href', 'signup.html');
        else el.onclick = function () { location.href = 'signup.html'; };
      });
      loginBtns.forEach(function (el) {
        el.onclick = function (e) { e.preventDefault(); goLogin(); };
        if (el.tagName === 'A') el.setAttribute('href', 'login.html');
      });
      signupBtns.forEach(function (el) {
        el.onclick = function (e) { e.preventDefault(); location.href = 'signup.html'; };
        if (el.tagName === 'A') el.setAttribute('href', 'signup.html');
      });
    }

    // admin topbar user chip (seller center pages)
    var adminUser = document.querySelector('.admin-user .lbl b');
    var adminUserSpan = document.querySelector('.admin-user .lbl span');
    var adminAvatar = document.querySelector('.admin-user .avatar');
    if (adminUser && user) {
      var name = user.company ? user.company.name : (user.profile ? user.profile.name : user.email);
      adminUser.childNodes[0].nodeValue = name + ' ';
      if (adminUserSpan) adminUserSpan.textContent = user.email;
      if (adminAvatar) adminAvatar.textContent = name.charAt(0);
    }
  }

  async function doLogout() {
    await window.sb.auth.signOut();
    location.href = 'index.html';
  }

  async function updateBadges(user) {
    if (!user) return;
    try {
      var cartRes = await window.sb.from('cart_items').select('id', { count: 'exact', head: true }).eq('profile_id', user.id);
      var cartBtn = document.querySelector('a[aria-label="장바구니"] .icon-count');
      if (cartBtn && typeof cartRes.count === 'number') cartBtn.textContent = cartRes.count;

      var notifRes = await window.sb.from('notifications').select('id', { count: 'exact', head: true }).eq('profile_id', user.id).eq('is_read', false);
      var notifBtns = document.querySelectorAll('[aria-label="알림"] .icon-count');
      notifBtns.forEach(function (el) { if (typeof notifRes.count === 'number') el.textContent = notifRes.count; });
    } catch (e) { /* non-fatal */ }
  }

  async function init() {
    var user = await currentUser();

    if (BUYER_PROTECTED.indexOf(PATH) !== -1 && !user) { goLogin(); return; }
    if (SELLER_PROTECTED.indexOf(PATH) !== -1) {
      if (!user) { goLogin(); return; }
      if (!user.company) { location.href = 'seller-apply.html'; return; }
    }

    syncHeader(user);
    updateBadges(user);

    window.VERSOI = window.VERSOI || {};
    window.VERSOI.user = user;
    window.VERSOI.signOut = doLogout;
    window.VERSOI.requireAuth = function () { if (!user) { goLogin(); return false; } return true; };
    document.dispatchEvent(new CustomEvent('versoi:ready', { detail: { user: user } }));
  }

  window.sb.auth.onAuthStateChange(function () { /* handled per-page via versoi:ready on load */ });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
