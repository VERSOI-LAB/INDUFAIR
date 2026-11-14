// 사람끼리: 바로 채팅 시작, 차단·차단 해제, 내가 차단한 사람 목록
// app.js 다음에 불러 씀 (PS, sb 필요)
(function () {
  var cache = null; // 내가 차단한 사람 id 집합

  PS.myBlocks = async function (fresh) {
    if (!PS.user) return {};
    if (cache && !fresh) return cache;
    var r = await sb.from('user_blocks').select('blocked_id');
    cache = {};
    (r.data || []).forEach(function (b) { cache[b.blocked_id] = true; });
    return cache;
  };

  PS.isBlocked = async function (id) { return !!(await PS.myBlocks())[id]; };

  // 바로 채팅: 있으면 그 방으로, 없으면 만들어서 이동
  PS.startDirectChat = async function (otherId) {
    if (!PS.requireLogin()) return;
    var r = await sb.rpc('start_direct_chat', { p_other: otherId });
    var d = r.data || {};
    if (r.error || !d.id) {
      PS.toast(d.error === 'blocked' ? '차단한(또는 나를 차단한) 사용자와는 채팅할 수 없어요'
        : d.error === 'self' ? '나와는 채팅할 수 없어요' : '채팅을 열지 못했어요. 잠시 후 다시 해 주세요');
      return;
    }
    location.href = '/chat/' + d.id;
  };

  // 차단 / 해제. 끝나면 onDone(차단 여부)
  PS.toggleBlock = async function (otherId, name, onDone) {
    if (!PS.requireLogin()) return;
    var blocked = await PS.isBlocked(otherId);
    var who = name || '이 사용자';
    if (!blocked && !confirm(who + '님을 차단할까요?\n\n서로 채팅할 수 없고, ' + who + '님의 이야기 글과 댓글이 보이지 않아요. 상대에게는 알리지 않아요.')) return;
    if (blocked && !confirm(who + '님 차단을 풀까요?')) return;
    var r = blocked
      ? await sb.from('user_blocks').delete().eq('blocker_id', PS.user.id).eq('blocked_id', otherId)
      : await sb.from('user_blocks').insert({ blocker_id: PS.user.id, blocked_id: otherId });
    if (r.error && r.error.code !== '23505') { PS.toast('잠시 후 다시 해 주세요'); return; }
    if (cache) { if (blocked) delete cache[otherId]; else cache[otherId] = true; }
    PS.toast(blocked ? '차단을 풀었어요' : '차단했어요');
    if (onDone) onDone(!blocked);
  };
})();
