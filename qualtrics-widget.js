/*
 * WITH-KV VERSION — paste into a Qualtrics question's "Add JavaScript" editor.
 * History is stored on Vercel (KV), keyed by userId, so this widget doesn't
 * need to carry the conversation itself — it just asks the backend for it.
 *
 * Before use:
 *  1. Replace BACKEND_URL with this version's deployed Vercel URL.
 *  2. Set up how "UserId" gets populated (SSO, panel field, or login question).
 */

Qualtrics.SurveyEngine.addOnload(function () {
  var qthis = this;
  var BACKEND_URL = 'https://your-with-kv-app.vercel.app'; // <-- change this

  var containerId = 'chat-advisor-' + qthis.questionId;

  var userId = qthis.getEmbeddedData ? qthis.getEmbeddedData('UserId') : null;
  if (!userId) userId = Qualtrics.SurveyEngine.getEmbeddedData('UserId');
  if (!userId) {
    userId = 'anonymous-' + (Qualtrics.SurveyEngine.getEmbeddedData('ResponseID') || Date.now());
  }

  var html =
    '<div id="' + containerId + '" class="chat-advisor-widget">' +
      '<div id="' + containerId + '-log" style="height:320px;overflow-y:auto;' +
        'border:1px solid #ccc;border-radius:8px;padding:12px;margin-bottom:10px;' +
        'background:#fafafa;font-family:sans-serif;font-size:14px;"></div>' +
      '<div style="display:flex;gap:8px;">' +
        '<input type="text" id="' + containerId + '-input" placeholder="Type your message..." ' +
          'style="flex:1;padding:10px;border:1px solid #ccc;border-radius:6px;" />' +
        '<button id="' + containerId + '-send" ' +
          'style="padding:10px 18px;border:none;border-radius:6px;background:#0074D9;color:#fff;cursor:pointer;">Send</button>' +
      '</div>' +
      '<div id="' + containerId + '-status" style="font-size:12px;color:#888;margin-top:4px;"></div>' +
    '</div>';

  document.getElementById(qthis.questionId).insertAdjacentHTML('beforeend', html);

  var logEl = document.getElementById(containerId + '-log');
  var inputEl = document.getElementById(containerId + '-input');
  var sendBtn = document.getElementById(containerId + '-send');
  var statusEl = document.getElementById(containerId + '-status');

  function appendMessage(role, text) {
    var wrap = document.createElement('div');
    wrap.style.margin = '8px 0';
    wrap.style.textAlign = role === 'user' ? 'right' : 'left';
    var bubble = document.createElement('span');
    bubble.style.display = 'inline-block';
    bubble.style.padding = '8px 12px';
    bubble.style.borderRadius = '14px';
    bubble.style.maxWidth = '80%';
    bubble.style.background = role === 'user' ? '#DCF8C6' : '#F1F0F0';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    logEl.appendChild(wrap);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // Ask Vercel for this user's history — this round trip is unique to the KV version.
  statusEl.textContent = 'Loading conversation…';
  fetch(BACKEND_URL + '/api/history?userId=' + encodeURIComponent(userId))
    .then(function (r) { return r.json(); })
    .then(function (data) {
      statusEl.textContent = '';
      (data.history || []).forEach(function (m) {
        appendMessage(m.role === 'user' ? 'user' : 'assistant', m.content);
      });
      if (!data.history || !data.history.length) {
        appendMessage('assistant', 'Hi! How can I help you today?');
      }
    })
    .catch(function () {
      statusEl.textContent = '';
      appendMessage('assistant', 'Hi! How can I help you today?');
    });

  function sendMessage() {
    var message = inputEl.value.trim();
    if (!message) return;
    appendMessage('user', message);
    inputEl.value = '';
    sendBtn.disabled = true;
    statusEl.textContent = 'Thinking…';

    fetch(BACKEND_URL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: userId, message: message }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        statusEl.textContent = '';
        appendMessage('assistant', data.reply || 'Sorry, something went wrong.');
      })
      .catch(function () {
        statusEl.textContent = '';
        appendMessage('assistant', 'Error reaching the advisor. Please try again.');
      })
      .finally(function () {
        sendBtn.disabled = false;
      });
  }

  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keypress', function (e) {
    if (e.key === 'Enter') sendMessage();
  });

  Qualtrics.SurveyEngine.setEmbeddedData('UserId', userId);
});
