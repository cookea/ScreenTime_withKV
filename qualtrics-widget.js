/*
 * WITH-KV VERSION — paste into a Qualtrics question's "Add JavaScript" editor.
 * History is stored on Vercel (KV), keyed by userId, so this widget doesn't
 * need to carry the conversation itself — it just asks the backend for it.
 *
 * Before use:
 *  1. Replace BACKEND_URL with this version's deployed Vercel URL.
 *  2. Set up how "Login" gets populated (SSO, panel field, or login question).
 */

Qualtrics.SurveyEngine.addOnload(function () {
  var qthis = this;
  var BACKEND_URL = 'https://your-with-kv-app.vercel.app'; // <-- change this

  var containerId = 'chat-advisor-' + qthis.questionId;

  var userId = qthis.getEmbeddedData ? qthis.getEmbeddedData('Login') : null;
  if (!userId) userId = Qualtrics.SurveyEngine.getEmbeddedData('Login');
  if (!userId) {
    userId = 'anonymous-' + (Qualtrics.SurveyEngine.getEmbeddedData('ResponseID') || Date.now());
  }

  // Set an Embedded Data field named "Fname" earlier in your survey flow
  // (e.g. from a text-entry question or panel/SSO data) for this to work.
  var firstName = Qualtrics.SurveyEngine.getEmbeddedData('Fname') || '';

  // Optional: set an Embedded Data field named "AdvisorInstructions" to
  // control what the AI advisor is told to do, without editing any code.
  // If left blank/unset, the backend falls back to its built-in default.
  var advisorInstructions = Qualtrics.SurveyEngine.getEmbeddedData('AdvisorInstructions') || '';

  // --- Tone condition -----------------------------------------------------
  // Set an Embedded Data field named "Condition" in Survey Flow to either
  // "friendly" or "control" (case-insensitive) to select which tone
  // instructions get applied as a post-processing pass on every reply,
  // AFTER the advisor has already decided what to say. This only changes
  // delivery style, never the substance of the response. The actual tone
  // instructions live in two more Embedded Data fields you set yourself:
  //   FriendlyTone   e.g. "Warm, casual, upbeat, uses light humor."
  //   ControlTone    e.g. "Neutral, plain, professional, no embellishment."
  // If Condition doesn't match either value (or isn't set), no tone
  // post-processing is applied — the advisor's original reply is used as-is.
  var condition = (Qualtrics.SurveyEngine.getEmbeddedData('Condition') || '').trim().toLowerCase();
  var toneInstructions = '';
  if (condition === 'friendly') {
    toneInstructions = Qualtrics.SurveyEngine.getEmbeddedData('FriendlyTone') || '';
  } else if (condition === 'control') {
    toneInstructions = Qualtrics.SurveyEngine.getEmbeddedData('ControlTone') || '';
  }

  // Optional: set an Embedded Data field named "CrisisClosingMessage" to
  // override the fixed message shown if a respondent's message is flagged
  // by the safety check. If you customize this, keep real crisis resources
  // in it — see DEFAULT_CRISIS_CLOSING_MESSAGE in api/chat.js for the default.
  var crisisClosingMessage = Qualtrics.SurveyEngine.getEmbeddedData('CrisisClosingMessage') || '';

  // --- Greeting configuration -----------------------------------------------
  // Set these Embedded Data fields in Survey Flow to control the two
  // greeting messages without editing code. Use {{firstName}} and
  // {{advisorName}} as placeholders inside the templates.
  //   AdvisorName             e.g. "Aria"
  //   FirstSessionGreeting    shown the very first time this user has any
  //                           conversation history (i.e. KV history is empty)
  //   ReturningSessionGreeting shown after any prior history exists
  var advisorName = Qualtrics.SurveyEngine.getEmbeddedData('AdvisorName') || '';
  var firstSessionGreetingTpl =
    Qualtrics.SurveyEngine.getEmbeddedData('FirstSessionGreeting') ||
    'Hi {{firstName}}! I am {{advisorName}}, your AI screen-time management advisor.';
  var returningSessionGreetingTpl =
    Qualtrics.SurveyEngine.getEmbeddedData('ReturningSessionGreeting') ||
    'Welcome back, {{firstName}}! How have things been going?';

  function fillTemplate(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, function (match, key) {
      var value = vars[key];
      if (value) return value;
      if (key === 'firstName') return 'there';
      if (key === 'advisorName') return 'your AI advisor';
      return '';
    });
  }

  function firstSessionGreeting() {
    return fillTemplate(firstSessionGreetingTpl, { firstName: firstName, advisorName: advisorName });
  }
  function returningSessionGreeting() {
    return fillTemplate(returningSessionGreetingTpl, { firstName: firstName, advisorName: advisorName });
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
        appendMessage('assistant', firstSessionGreeting());
      } else {
        appendMessage('assistant', returningSessionGreeting());
      }
    })
    .catch(function () {
      statusEl.textContent = '';
      // Can't tell first-time vs. returning if the history fetch itself
      // failed, so default to the first-session greeting.
      appendMessage('assistant', firstSessionGreeting());
    });

  var conversationEnded = false;

  function sendMessage() {
    if (conversationEnded) return;
    var message = inputEl.value.trim();
    if (!message) return;
    appendMessage('user', message);
    inputEl.value = '';
    sendBtn.disabled = true;
    statusEl.textContent = 'Thinking…';

    fetch(BACKEND_URL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: userId, message: message, firstName: firstName, advisorName: advisorName, instructions: advisorInstructions, toneInstructions: toneInstructions, crisisClosingMessage: crisisClosingMessage }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        statusEl.textContent = '';
        appendMessage('assistant', data.reply || 'Sorry, something went wrong.');
        // The advisor signals a captured screen-time estimate (already
        // converted to minutes) via this field — save it as data.
        if (typeof data.screenTimeMinutes === 'number' && !isNaN(data.screenTimeMinutes)) {
          Qualtrics.SurveyEngine.setEmbeddedData('LastDayEst', data.screenTimeMinutes);
        }
        // The advisor's message was flagged by the safety check and the
        // conversation has been gently ended — lock the input so no further
        // messages can be sent in this widget instance.
        if (data.endConversation) {
          conversationEnded = true;
          inputEl.disabled = true;
          inputEl.placeholder = 'This conversation has ended.';
          sendBtn.disabled = true;
        }
      })
      .catch(function () {
        statusEl.textContent = '';
        appendMessage('assistant', 'Error reaching the advisor. Please try again.');
      })
      .finally(function () {
        if (!conversationEnded) sendBtn.disabled = false;
      });
  }

  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keypress', function (e) {
    if (e.key === 'Enter') sendMessage();
  });

  Qualtrics.SurveyEngine.setEmbeddedData('Login', userId);
});
