// 친구 초대 보상 홍보: 업체 주인에게 "친구 초대하면 내 업체가 일주일 동안 맨 위" 안내
// app.js, supabase-client.js(psShare) 다음에 불러 씀
(function () {
  var SHARE_TEXT = '산업용품 사고팔기, 동네 업체 찾기, 정부 지원사업 마감 알림까지. 판다산다 같이 써요!';

  async function send(btn) {
    if (btn) btn.disabled = true;
    var how = await window.psShare('판다산다', SHARE_TEXT, '/');
    if (btn) btn.disabled = false;
    if (how === 'copied') PS.toast('초대 링크를 복사했어요. 카톡에 붙여 넣어 보내 주세요');
    return how;
  }

  // '다시 보지 않기': 이 기기에 바로 기억하고, 계정에도 저장(다른 기기·월 1회 알림도 멈춤)
  var OFF = 'ps_inv_off';
  function isOffLocal() { try { return localStorage.getItem(OFF) === '1'; } catch (e) { return false; } }
  PS.inviteHidden = async function () {
    if (isOffLocal()) return true;
    if (!PS.user) return false;
    var r = await sb.from('invite_promo_state').select('dismissed_at').eq('profile_id', PS.user.id).maybeSingle();
    var off = !r.error && r.data && r.data.dismissed_at;
    if (off) { try { localStorage.setItem(OFF, '1'); } catch (e) {} }
    return !!off;
  };
  async function dismiss() {
    try { localStorage.setItem(OFF, '1'); } catch (e) {}
    document.querySelectorAll('[data-invite-banner]').forEach(function (b) { b.remove(); });
    close();
    if (PS.user) await sb.from('invite_promo_state').upsert({ profile_id: PS.user.id, dismissed_at: new Date().toISOString() });
    PS.toast('이제 초대 안내를 보여 드리지 않을게요. 마이 > 친구 초대하기에서 언제든 보낼 수 있어요');
  }

  // 화면에 넣는 배너
  PS.inviteBannerHtml = function () {
    return '<div class="push-prompt" data-invite-banner style="margin:14px 0 0;background:#FFF6DA">' +
      '<div><b>🎁 친구 초대하면 내 업체가 일주일 동안 맨 위에 떠요</b>' +
      '<span>동료가 내 링크로 가입할 때마다 7일 프리미엄 (한 달 4명까지)</span>' +
      '<button type="button" data-invite-off style="align-self:flex-start;font-size:12px;color:var(--hint);text-decoration:underline;padding:4px 0 0">다시 보지 않기</button></div>' +
      '<button type="button" class="btn small" data-invite-send>초대 링크 보내기</button></div>';
  };
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-invite-send]');
    if (b) send(b);
    if (e.target.closest('[data-invite-off]')) dismiss();
  });

  // 아래에서 올라오는 안내 창
  var sh = null, bg = null;
  function close() { if (sh) { sh.classList.remove('show'); bg.classList.remove('show'); } }
  PS.inviteSheet = function (title, text) {
    if (isOffLocal()) return;
    if (!sh) {
      bg = document.createElement('div'); bg.className = 'sheet-bg';
      sh = document.createElement('div'); sh.className = 'sheet'; sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-label', '친구 초대');
      document.body.appendChild(bg); document.body.appendChild(sh);
      bg.addEventListener('click', close);
    }
    sh.innerHTML = '<div class="handle"></div>' +
      '<div style="text-align:center;font-size:44px;line-height:1">🎁</div>' +
      '<h3 style="font-size:20px;font-weight:800;text-align:center;margin-top:10px;line-height:1.4">' + PS.esc(title) + '</h3>' +
      '<p style="color:var(--sub);font-size:15px;text-align:center;margin-top:8px;line-height:1.6">' + PS.esc(text) + '</p>' +
      '<button type="button" class="btn" id="invGo" style="margin-top:18px">카톡으로 초대 링크 보내기</button>' +
      '<button type="button" class="btn white" id="invLater" style="margin-top:10px">다음에 할게요</button>' +
      '<button type="button" data-invite-off style="display:block;margin:12px auto 0;font-size:13px;color:var(--hint);text-decoration:underline">다시 보지 않기</button>';
    bg.classList.add('show'); sh.classList.add('show');
    document.getElementById('invLater').onclick = close;
    document.getElementById('invGo').onclick = async function () { var how = await send(this); if (how !== 'cancel') close(); };
  };

  // 같은 안내를 너무 자주 띄우지 않기 (key 마다 days 일에 한 번)
  PS.inviteOnce = function (key, days) {
    try {
      var k = 'ps_inv_' + key, last = Number(localStorage.getItem(k) || 0);
      if (Date.now() - last < days * 86400000) return false;
      localStorage.setItem(k, String(Date.now()));
    } catch (e) {}
    return true;
  };
})();
