// VERSOI — shared auth/session layer. Include after supabase-client.js on every page.
// Syncs the header login state, guards protected pages, and exposes window.VERSOI.
(function () {
  if (!window.sb) { console.error('[VERSOI] sb client missing — include supabase-client.js first'); return; }

  var PATH = location.pathname.split('/').pop() || 'index.html';

  var BUYER_PROTECTED = ['mypage.html', 'order.html', 'shipping.html', 'cancel.html', 'account.html', 'cart.html',
    'favorites.html', 'coupons.html', 'inquiries.html', 'my-listings.html'];
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

  // ---- header search icon: prompts for a term, sends to goods.html?q= ----
  function wireSearchIcon() {
    document.querySelectorAll('[aria-label="검색"]').forEach(function (btn) {
      if (btn.closest('form')) return; // real inline search forms (index.html) handle themselves
      if (btn._versoiWired) return;
      btn._versoiWired = true;
      btn.addEventListener('click', function () {
        var q = prompt('검색어를 입력하세요');
        if (q && q.trim()) location.href = 'goods.html?q=' + encodeURIComponent(q.trim());
      });
    });
  }

  // ---- notification bell dropdown (works for both .header-actions and .admin-top-actions) ----
  var NOTIF_STYLE_ID = 'versoi-notif-style';
  function ensureNotifStyle() {
    if (document.getElementById(NOTIF_STYLE_ID)) return;
    var css = '.versoi-notif-panel{position:absolute;top:calc(100% + 8px);right:0;width:320px;max-height:420px;' +
      'overflow-y:auto;background:var(--surface,#fff);border:1px solid var(--border,#E3E8F0);border-radius:14px;' +
      'box-shadow:var(--shadow-3,0 20px 48px rgba(10,21,48,.16));z-index:200;display:none;}' +
      '.versoi-notif-panel.open{display:block;}' +
      '.versoi-notif-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;' +
      'border-bottom:1px solid var(--border,#E3E8F0);font-weight:800;font-size:.9rem;}' +
      '.versoi-notif-head button{font-size:.74rem;font-weight:700;color:var(--accent,#1E56E0);}' +
      '.versoi-notif-item{display:block;padding:12px 16px;border-bottom:1px solid var(--border,#E3E8F0);' +
      'font-size:.82rem;color:var(--text-secondary,#4C5768);cursor:pointer;text-align:left;width:100%;background:none;}' +
      '.versoi-notif-item:last-child{border-bottom:none;}' +
      '.versoi-notif-item:hover{background:var(--bg-soft,#ECF1F8);}' +
      '.versoi-notif-item.unread{background:var(--accent-soft,#E9F0FE);}' +
      '.versoi-notif-item b{display:block;color:var(--text,#0F1A2E);font-weight:700;margin-bottom:2px;}' +
      '.versoi-notif-item span{display:block;font-size:.72rem;color:var(--text-tertiary,#8992A3);margin-top:4px;}' +
      '.versoi-notif-empty{padding:28px 16px;text-align:center;color:var(--text-tertiary,#8992A3);font-size:.82rem;}';
    var style = document.createElement('style');
    style.id = NOTIF_STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function fmtNotifDate(iso) {
    var d = new Date(iso);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return (d.getMonth() + 1) + '.' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function wireNotificationBell(user) {
    if (!user) return;
    ensureNotifStyle();
    var bells = document.querySelectorAll('[aria-label="알림"]');
    bells.forEach(function (bell) {
      if (bell._versoiWired) return;
      bell._versoiWired = true;

      var wrapper = document.createElement('span');
      wrapper.style.position = 'relative';
      wrapper.style.display = 'inline-flex';
      bell.parentNode.insertBefore(wrapper, bell);
      wrapper.appendChild(bell);

      var panel = document.createElement('div');
      panel.className = 'versoi-notif-panel';
      panel.innerHTML = '<div class="versoi-notif-head"><span>알림</span><button type="button" data-mark-all>모두 읽음</button></div><div class="versoi-notif-body"></div>';
      wrapper.appendChild(panel);
      var body = panel.querySelector('.versoi-notif-body');

      async function loadAndRender() {
        var res = await window.sb.from('notifications').select('*').eq('profile_id', user.id).order('created_at', { ascending: false }).limit(15);
        var rows = res.data || [];
        if (!rows.length) { body.innerHTML = '<div class="versoi-notif-empty">알림이 없습니다.</div>'; return; }
        body.innerHTML = rows.map(function (n) {
          return '<button type="button" class="versoi-notif-item' + (n.is_read ? '' : ' unread') + '" data-id="' + n.id + '" data-link="' + (n.link || '') + '">' +
            '<b>' + n.title.replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }) + '</b>' +
            (n.content || '').replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }) +
            '<span>' + fmtNotifDate(n.created_at) + '</span></button>';
        }).join('');
      }

      bell.addEventListener('click', function (e) {
        e.stopPropagation();
        var willOpen = !panel.classList.contains('open');
        document.querySelectorAll('.versoi-notif-panel.open').forEach(function (p) { p.classList.remove('open'); });
        if (willOpen) { panel.classList.add('open'); loadAndRender(); }
      });
      panel.addEventListener('click', function (e) { e.stopPropagation(); });

      panel.addEventListener('click', async function (e) {
        var markAllBtn = e.target.closest('[data-mark-all]');
        if (markAllBtn) {
          var unreadRes = await window.sb.from('notifications').select('id').eq('profile_id', user.id).eq('is_read', false);
          var ids = (unreadRes.data || []).map(function (n) { return n.id; });
          if (ids.length) await window.sb.rpc('mark_notifications_read', { p_ids: ids });
          await loadAndRender();
          document.querySelectorAll('[aria-label="알림"] .icon-count').forEach(function (el) { el.textContent = '0'; });
          return;
        }
        var item = e.target.closest('.versoi-notif-item');
        if (item) {
          var id = Number(item.getAttribute('data-id'));
          await window.sb.rpc('mark_notifications_read', { p_ids: [id] });
          var link = item.getAttribute('data-link');
          if (link) location.href = link;
          else { item.classList.remove('unread'); updateBadges(user); }
        }
      });
    });
    document.addEventListener('click', function () {
      document.querySelectorAll('.versoi-notif-panel.open').forEach(function (p) { p.classList.remove('open'); });
    });
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
    wireSearchIcon();
    wireNotificationBell(user);

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
