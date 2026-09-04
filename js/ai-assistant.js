// VERSOI — shared AI assistant chat widget. Include after js/auth.js on any page
// that has an "AI 비서" trigger. Exposes window.VERSOI.openAIChat().
(function () {
  var FUNCTIONS_URL = 'https://rqjfergjfhcrcuvfuhkm.supabase.co/functions/v1';
  var STYLE_ID = 'versoi-ai-style';
  var panel, messagesEl, inputEl, sendBtn;
  var history = [];
  var built = false;

  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      '.versoi-ai-panel{position:fixed;right:20px;bottom:20px;width:360px;max-width:calc(100vw - 32px);' +
      'height:520px;max-height:calc(100vh - 100px);background:var(--surface,#fff);border:1px solid var(--border,#E3E8F0);' +
      'border-radius:var(--radius-l,16px);box-shadow:var(--shadow-3,0 20px 48px rgba(10,21,48,.2));z-index:500;' +
      'display:none;flex-direction:column;overflow:hidden;}' +
      '.versoi-ai-panel.open{display:flex;}' +
      '.versoi-ai-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;' +
      'background:var(--navy-900,#0F1A2E);color:#fff;flex-shrink:0;}' +
      '.versoi-ai-head b{font-size:.9rem;font-weight:800;display:flex;align-items:center;gap:6px;}' +
      '.versoi-ai-head button{color:#fff;opacity:.8;width:28px;height:28px;display:flex;align-items:center;justify-content:center;}' +
      '.versoi-ai-head button:hover{opacity:1;}' +
      '.versoi-ai-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;}' +
      '.versoi-ai-msg{max-width:84%;padding:10px 13px;border-radius:14px;font-size:.84rem;line-height:1.6;white-space:pre-wrap;}' +
      '.versoi-ai-msg.user{align-self:flex-end;background:var(--accent,#1E56E0);color:#fff;border-bottom-right-radius:4px;}' +
      '.versoi-ai-msg.assistant{align-self:flex-start;background:var(--bg-soft,#ECF1F8);color:var(--text,#0F1A2E);border-bottom-left-radius:4px;}' +
      '.versoi-ai-msg.assistant.typing{color:var(--text-tertiary,#8992A3);}' +
      '.versoi-ai-input-row{display:flex;gap:8px;padding:12px;border-top:1px solid var(--border,#E3E8F0);flex-shrink:0;}' +
      '.versoi-ai-input-row textarea{flex:1;border:1px solid var(--border,#E3E8F0);border-radius:10px;padding:9px 12px;' +
      'font-size:.84rem;font-family:inherit;color:var(--text,#0F1A2E);resize:none;max-height:80px;}' +
      '.versoi-ai-input-row textarea:focus{outline:none;border-color:var(--accent,#1E56E0);}' +
      '.versoi-ai-input-row button{flex-shrink:0;width:38px;height:38px;border-radius:10px;background:var(--accent,#1E56E0);' +
      'color:#fff;display:flex;align-items:center;justify-content:center;}' +
      '.versoi-ai-input-row button:disabled{opacity:.5;}' +
      '@media (max-width:480px){.versoi-ai-panel{right:8px;left:8px;bottom:8px;width:auto;}}';
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function appendMessage(role, text, isTyping) {
    var el = document.createElement('div');
    el.className = 'versoi-ai-msg ' + role + (isTyping ? ' typing' : '');
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function buildWidget() {
    if (built) return;
    built = true;
    ensureStyle();
    var wrap = document.createElement('div');
    wrap.className = 'versoi-ai-panel';
    wrap.innerHTML =
      '<div class="versoi-ai-head"><b>' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>' +
      'AI 산업 비서</b><button type="button" class="versoi-ai-close" aria-label="닫기"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>' +
      '<div class="versoi-ai-messages"></div>' +
      '<div class="versoi-ai-input-row"><textarea rows="1" placeholder="궁금한 점을 물어보세요"></textarea>' +
      '<button type="button" aria-label="전송"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button></div>';
    document.body.appendChild(wrap);

    panel = wrap;
    messagesEl = wrap.querySelector('.versoi-ai-messages');
    inputEl = wrap.querySelector('textarea');
    sendBtn = wrap.querySelector('.versoi-ai-input-row button');

    wrap.querySelector('.versoi-ai-close').addEventListener('click', closeChat);
    sendBtn.addEventListener('click', send);
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });

    appendMessage('assistant', '안녕하세요! VERSOI AI 산업 비서입니다.\n제품 검색, 견적요청, 서비스 이용에 대해 무엇이든 물어보세요.');
  }

  async function send() {
    var text = inputEl.value.trim();
    if (!text || sendBtn.disabled) return;
    inputEl.value = '';
    appendMessage('user', text);
    history.push({ role: 'user', content: text });
    sendBtn.disabled = true;
    var typingEl = appendMessage('assistant', '입력 중...', true);

    try {
      var sessionRes = await window.sb.auth.getSession();
      var token = sessionRes.data.session ? sessionRes.data.session.access_token : null;
      var res = await fetch(FUNCTIONS_URL + '/ai-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ messages: history })
      });
      var data = await res.json();
      typingEl.remove();
      if (!res.ok || data.error) {
        appendMessage('assistant', data.error || 'AI 응답을 가져오지 못했습니다. 잠시 후 다시 시도해주세요.');
      } else {
        appendMessage('assistant', data.reply);
        history.push({ role: 'assistant', content: data.reply });
      }
    } catch (e) {
      typingEl.remove();
      appendMessage('assistant', '네트워크 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
    }
    sendBtn.disabled = false;
    inputEl.focus();
  }

  function openChat() {
    if (!window.VERSOI || !window.VERSOI.requireAuth || !window.VERSOI.requireAuth()) return;
    buildWidget();
    panel.classList.add('open');
    inputEl.focus();
  }

  function closeChat() {
    if (panel) panel.classList.remove('open');
  }

  window.VERSOI = window.VERSOI || {};
  window.VERSOI.openAIChat = openChat;
})();
