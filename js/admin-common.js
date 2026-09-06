// INDUFAIR(인더페어) Admin Console — shared helpers for admin-*.html pages.
// Include after js/auth.js. All admin-*.html pages are ADMIN_PROTECTED in auth.js,
// so by the time `versoi:ready` fires, window.VERSOI.user.profile.is_admin is guaranteed true.
(function () {
  window.AC = window.AC || {};

  AC.won = function (n) {
    n = Number(n || 0);
    return '₩' + n.toLocaleString('ko-KR');
  };

  AC.dt = function (iso, withTime) {
    if (!iso) return '-';
    var d = new Date(iso);
    var p = function (n) { return String(n).padStart(2, '0'); };
    var s = d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate());
    if (withTime) s += ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    return s;
  };

  AC.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var STATUS_LABEL = {
    selling: '판매 중', stopped: '판매 중지', soldout: '품절', deleted: '삭제',
    pending_payment: '결제대기', paid: '결제완료', preparing: '배송준비', shipping: '배송중',
    delivered: '배송완료', confirmed: '구매확정', canceled: '취소', refund_requested: '반품요청', refunded: '환불완료',
    pending: '답변 대기', answered: '답변 완료',
    active: '활성', withdrawn: '탈퇴', suspended: '정지',
    business: '사업자', individual: '개인',
    scheduled: '정산 예정', completed: '정산 완료'
  };
  AC.label = function (status) { return STATUS_LABEL[status] || status; };

  var STATUS_BADGE = {
    selling: 'badge-good', paid: 'badge-good', delivered: 'badge-good', confirmed: 'badge-good',
    answered: 'badge-good', active: 'badge-good', completed: 'badge-good',
    stopped: 'badge-up', canceled: 'badge-up', suspended: 'badge-up', withdrawn: 'badge-muted', deleted: 'badge-muted',
    soldout: 'badge-warn', pending: 'badge-warn', pending_payment: 'badge-warn',
    preparing: 'badge-accent', shipping: 'badge-accent', refund_requested: 'badge-warn', scheduled: 'badge-accent'
  };
  AC.badgeCls = function (status) { return STATUS_BADGE[status] || 'badge-muted'; };

  // Runs cb(user) once auth.js has resolved the session. On admin-*.html pages
  // user.profile.is_admin is guaranteed true (auth.js redirects otherwise).
  AC.ready = function (cb) {
    if (window.VERSOI && window.VERSOI.user) { cb(window.VERSOI.user); return; }
    document.addEventListener('versoi:ready', function (e) { cb(e.detail.user); });
  };
})();
