// VERSOI Seller Center — shared helpers for seller-*.html pages.
// Include after js/auth.js. All seller-*.html pages are SELLER_PROTECTED in auth.js,
// so by the time `versoi:ready` fires, window.VERSOI.user and .company are guaranteed non-null.
(function () {
  window.SC = window.SC || {};

  SC.won = function (n) {
    n = Number(n || 0);
    return '₩' + n.toLocaleString('ko-KR');
  };

  SC.dt = function (iso, withTime) {
    if (!iso) return '-';
    var d = new Date(iso);
    var p = function (n) { return String(n).padStart(2, '0'); };
    var s = d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate());
    if (withTime) s += ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    return s;
  };

  SC.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var STATUS_LABEL = {
    selling: '판매 중', stopped: '판매 중지', soldout: '품절', deleted: '삭제',
    pending_payment: '결제대기', paid: '결제완료', preparing: '배송준비', shipping: '배송중',
    delivered: '배송완료', confirmed: '구매확정', canceled: '취소', refund_requested: '반품요청', refunded: '환불완료',
    pending: '답변 대기', answered: '답변 완료',
    scheduled: '정산 예정', completed: '정산 완료',
    draft: '작성 중', issued: '발행 완료', taxable: '과세', zero_rate: '영세율', exempt: '면세'
  };
  SC.label = function (status) { return STATUS_LABEL[status] || status; };

  var STATUS_BADGE = {
    selling: 'badge-good', paid: 'badge-good', delivered: 'badge-good', confirmed: 'badge-good',
    completed: 'badge-good', issued: 'badge-good', answered: 'badge-good',
    stopped: 'badge-up', canceled: 'badge-up', refunded: 'badge-muted', deleted: 'badge-muted',
    soldout: 'badge-warn', pending: 'badge-warn', pending_payment: 'badge-warn', scheduled: 'badge-accent',
    draft: 'badge-muted', preparing: 'badge-accent', shipping: 'badge-accent', refund_requested: 'badge-warn',
    taxable: 'badge-good', zero_rate: 'badge-accent', exempt: 'badge-muted'
  };
  SC.badgeCls = function (status) { return STATUS_BADGE[status] || 'badge-muted'; };

  // Runs cb(user) once auth.js has resolved the session. On seller-*.html pages
  // user.company is guaranteed present (auth.js redirects otherwise).
  SC.ready = function (cb) {
    if (window.VERSOI && window.VERSOI.user) { cb(window.VERSOI.user); return; }
    document.addEventListener('versoi:ready', function (e) { cb(e.detail.user); });
  };
})();
