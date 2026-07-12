// api/chat.js — WITH-KV VERSION
// Receives a user message, loads that user's conversation history from
// Vercel KV, calls OpenAI with full context, saves the updated history
// back to KV, and returns the assistant's reply. History persists on
// Vercel, keyed by userId, across any number of separate sessions.

import { getHistory, setHistory } from '../lib/redis.js';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MAX_HISTORY_MESSAGES = 20;
const MAX_STORED_MESSAGES = 200;

// Shifts the day boundary used for date tagging, in hours, so "day" aligns
// with your respondents' local time zone instead of UTC. E.g. set to -5 for
// US Eastern. Optional; defaults to 0 (UTC day boundaries).
const DAY_TZ_OFFSET_HOURS = Number(process.env.DAY_TZ_OFFSET_HOURS || 0);

// If a message arrives more than this many minutes after the previous one,
// on the SAME calendar date, it's treated as a new (rare) same-day session.
const SESSION_GAP_MINUTES = Number(process.env.SESSION_GAP_MINUTES || 30);

// Returns today's calendar date as "YYYY-MM-DD" — this IS the day tag.
// Using the real date (rather than an incrementing counter) means no
// history lookup or per-user anchor is needed: it's unique per day and
// identical for every message sent on the same day, computed fresh every
// time straight from the clock.
function dateKey(ts) {
  return new Date(ts + DAY_TZ_OFFSET_HOURS * 3600 * 1000).toISOString().slice(0, 10);
}

// Determines the date tag and session number for the CURRENT message.
// - date is always just today's date (see dateKey above).
// - session increments only if there's a long gap (SESSION_GAP_MINUTES)
//   within the SAME date — multiple sessions can share a date, which is
//   expected to be uncommon. Session resets to 1 on a new date.
function computeDateAndSession(history) {
  const date = dateKey(Date.now());
  if (!history.length) return { date, session: 1 };
  const last = history[history.length - 1];
  if (last.date === date) {
    const gapMinutes = (Date.now() - (last.ts || Date.now())) / 60000;
    return { date, session: gapMinutes > SESSION_GAP_MINUTES ? (last.session || 1) + 1 : (last.session || 1) };
  }
  return { date, session: 1 };
}

// Safety net: strips a leaked "(Date: ..., Session N)" tag if the model
// echoes the pattern back at the start of its own reply, despite being
// told not to. The tag is metadata for the model, never meant to be shown.
const LEAKED_DATE_TAG_RE = /^\(Date:\s*[\d-]+,\s*Session\s*\d+\)\s*/i;

function stripLeakedDateTag(text) {
  return text.replace(LEAKED_DATE_TAG_RE, '').trim();
}

// --- Screen-time capture ----------------------------------------------
// Run as its own dedicated call reviewing the RESPONDENT's message
// directly — not signaled via a hidden tag the main advisor has to
// remember to append. A tag buried in a long, multi-part system prompt is
// a fragile signal (easy for the model to forget under instruction load);
// asking a narrowly-scoped question in isolation is far more reliable,
// same pattern as the safety classifier above.
async function extractScreenTimeMinutes(message, recentContext) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You review a message from a survey respondent who is being asked how much time they ' +
            'spent on social media the previous day. Determine whether the respondent\'s LATEST ' +
            'message gives a clear, specific answer (a duration or a number) — not vague language ' +
            'like "not much," "a lot," or a non-answer. If it does, respond with ONLY a whole number: ' +
            'the total number of minutes that duration represents (e.g. "an hour and a half" -> 90, ' +
            '"2 hours" -> 120, "45 min" -> 45, "2h 15m" -> 135, "90" -> 90). If it does NOT give a ' +
            'clear answer, respond with ONLY the word NONE.',
        },
        {
          role: 'user',
          content:
            (recentContext ? 'Recent conversation context:\n' + recentContext + '\n\n' : '') +
            'Latest message to evaluate: ' + message,
        },
      ],
      temperature: 0,
      max_tokens: 10,
    });
    const answer = completion.choices?.[0]?.message?.content?.trim() || '';
    return /^\d+$/.test(answer) ? parseInt(answer, 10) : null;
  } catch (err) {
    console.error('screen time extraction error:', err);
    return null;
  }
}

// --- Tone post-processing --------------------------------------------------
// A separate rewrite pass applied AFTER the advisor's substantive reply is
// generated. This keeps the underlying logic/content of the conversation
// identical across conditions — only the delivery style changes. The tone
// instructions themselves come from Qualtrics (FriendlyTone / ControlTone,
// selected by the Condition Embedded Data field — see qualtrics-widget.js),
// not hardcoded here.
async function applyToneRewrite(text, toneInstructions) {
  if (!toneInstructions || !toneInstructions.trim()) return text;
  try {
    const toneCompletion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You rewrite a message to match a specified tone, without changing its meaning, ' +
            'facts, questions, or requests. Do not add new information, remove information, or ' +
            'answer on the respondent\'s behalf — only change how it is delivered. Return ONLY ' +
            'the rewritten message, with no preamble, quotation marks, or commentary. Tone to ' +
            'apply: ' + toneInstructions.trim(),
        },
        { role: 'user', content: text },
      ],
      temperature: 0.7,
      max_tokens: 500,
    });
    const rewritten = toneCompletion.choices?.[0]?.message?.content?.trim();
    if (!rewritten) return text;
    // Defensive: strip any leaked date/session tag that might have crept
    // back in during rewriting.
    return stripLeakedDateTag(rewritten);
  } catch (err) {
    console.error('tone rewrite error:', err);
    // Fail open: show the un-toned reply rather than erroring the whole request.
    return text;
  }
}

// --- Safety monitoring ------------------------------------------------
// Every respondent message is screened by a dedicated classifier call
// BEFORE the normal advisor pipeline runs. This is deliberately a
// separate, narrowly-scoped call rather than folded into the main
// advisor prompt, so it's simple to audit and can't be diluted by
// AdvisorInstructions or tone rewriting.
async function isDistressFlagged(message, recentContext) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are a safety classifier reviewing a message from a research survey respondent ' +
            'talking to an AI chat advisor about screen time and social media use. Determine ' +
            'whether the respondent\'s LATEST message shows signs of a genuine, serious risk to ' +
            'their own safety (e.g. suicidal ideation, self-harm) or someone else\'s safety (e.g. ' +
            'intent to harm another person) — not just general sadness, stress, or venting about ' +
            'daily life or screen time habits. Use the recent conversation only for context. ' +
            'Respond with ONLY the single word YES if there are clear or concerning signs of risk. ' +
            'Respond with ONLY the single word NO otherwise. When genuinely uncertain, prefer YES.',
        },
        {
          role: 'user',
          content:
            (recentContext ? 'Recent conversation context:\n' + recentContext + '\n\n' : '') +
            'Latest message to classify: ' + message,
        },
      ],
      temperature: 0,
      max_tokens: 5,
    });
    const answer = completion.choices?.[0]?.message?.content?.trim().toUpperCase() || '';
    return answer.startsWith('YES');
  } catch (err) {
    console.error('safety classifier error:', err);
    // Fail open on the classifier itself erroring (e.g. API outage) so a
    // transient failure doesn't silently disable the whole advisor. This is
    // a judgment call — consider failing closed (treat as flagged) instead
    // if you'd rather over-trigger than risk a missed check.
    return false;
  }
}

// Shown to the respondent instead of a normal reply when a message is
// flagged. This is intentionally a FIXED template, not freely generated by
// the model — the wording of crisis resources shouldn't be left to chance.
// Override via the "CrisisClosingMessage" Embedded Data field if you want
// different wording, but keep real crisis resources in it.
const DEFAULT_CRISIS_CLOSING_MESSAGE =
  "I want to pause our conversation for a moment. It sounds like you might be going through " +
  "something really difficult right now, and I want to make sure you get support from people " +
  "who can help.\n\n" +
  "If you're in the US, you can reach the 988 Suicide & Crisis Lifeline anytime by calling or " +
  "texting 988, or chatting at 988lifeline.org. You can also text HOME to 741741 to reach the " +
  "Crisis Text Line. If you or someone else is in immediate danger, please call 911.\n\n" +
  "A member of the research team has also been notified so they can follow up with you. Thank " +
  "you for being part of this study, and please take care of yourself.";

function formatTranscript(history) {
  return history
    .map((m) => '[' + (m.date || '?') + ' Session ' + (m.session || 1) + '] ' + m.role.toUpperCase() + ': ' + m.content)
    .join('\n');
}

// Sends the alert email via Resend (https://resend.com). Requires
// RESEND_API_KEY, RESEND_FROM_EMAIL, and ALERT_EMAIL_TO to be set as
// Vercel environment variables. The destination is ALWAYS the fixed
// ALERT_EMAIL_TO env var — never a client-supplied address — since this
// hits a public endpoint and the destination controls where potentially
// sensitive conversation data gets sent.
async function sendCrisisAlertEmail({ userId, date, session, history }) {
  const to = process.env.ALERT_EMAIL_TO;
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!to || !apiKey || !from) {
    console.error('sendCrisisAlertEmail: ALERT_EMAIL_TO, RESEND_API_KEY, or RESEND_FROM_EMAIL not configured');
    return;
  }
  const timestamp = new Date().toISOString();
  const body =
    'A conversation with the AI advisor was automatically flagged as a potential safety concern.\n\n' +
    'Date: ' + date + '\n' +
    'Session: ' + session + '\n' +
    'Timestamp (UTC): ' + timestamp + '\n' +
    'UserID: ' + userId + '\n\n' +
    '--- Conversation transcript ---\n\n' +
    formatTranscript(history);

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject: 'Flagged Conversation', text: body }),
    });
    if (!r.ok) console.error('sendCrisisAlertEmail: Resend API error', await r.text());
  } catch (err) {
    console.error('sendCrisisAlertEmail error:', err);
  }
}

// --- Advisor configuration -------------------------------------------------
// This is the fallback used when the Qualtrics survey doesn't supply its
// own instructions via the "AdvisorInstructions" Embedded Data field. Edit
// this directly if you want a hardcoded default; otherwise control it
// per-survey from Qualtrics (see qualtrics-widget.js).
const DEFAULT_ADVISOR_INSTRUCTIONS =
  'You are a helpful advisor assisting a survey respondent. Be concise, ' +
  'supportive, and stay on topic. Remember context from earlier in this ' +
  'conversation and across the person\'s previous sessions.';

// Always included in the system prompt, regardless of what AdvisorInstructions
// is set to — this is a behavior guarantee, not something a survey-level
// override should be able to silently disable.
const CORE_BEHAVIOR_RULES =
  'Each message below is prefixed with "(Date: YYYY-MM-DD, Session S)" — the ' +
  'actual calendar date it was sent on, plus a finer Session marker that only ' +
  'increases if there was a long gap within the SAME date (uncommon). This tag is ' +
  'for your reference only — NEVER include it, repeat it, or mention it in your ' +
  'own reply to the respondent. Your goal is to collect exactly one clear answer ' +
  'about the respondent\'s social media use from the previous day, once per ' +
  'calendar Date. If you already asked on that same Date and received a clear, ' +
  'specific answer, do not ask again that Date, even if a new Session starts ' +
  'within it. If their answer was vague, unclear, or they did not actually ' +
  'answer, you may ask again within the same Date to get a clear answer. Once ' +
  'the Date changes (the respondent returns on a later day), you should ask ' +
  'again, since it now refers to a different prior day\'s usage.';

function buildSystemPrompt(firstName, instructions, advisorName) {
  var nameLine = advisorName ? 'Your name is ' + advisorName + '. ' : '';
  var greeting = firstName
    ? 'The respondent\'s first name is ' + firstName + '. Greet them by name at the ' +
      'start of the conversation and use their name naturally where appropriate. '
    : '';
  var body = instructions && instructions.trim() ? instructions.trim() : DEFAULT_ADVISOR_INSTRUCTIONS;
  return nameLine + greeting + CORE_BEHAVIOR_RULES + ' ' + body;
}

// Comma-separated list of allowed origins, e.g.
// "https://ufl.yul1.qualtrics.com,https://survey.warrington.ufl.edu" — lets
// both Qualtrics preview and your live/distributed survey work at once
// without having to swap this every time you switch between them. A single
// "*" allows any origin (fine for early testing, not recommended once real
// respondent data is involved).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  // If the request's origin doesn't match anything in the allowlist, we
  // simply don't set the header — the browser then correctly blocks the
  // response, same end result as before but per-origin instead of global.
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId, message, firstName, instructions, advisorName, toneInstructions, crisisClosingMessage } = req.body || {};

    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'userId is required' });
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }
    if (message.length > 4000) {
      return res.status(400).json({ error: 'message too long' });
    }
    // firstName is optional and only used for personalization — sanitize
    // defensively since it flows into the system prompt.
    const safeFirstName =
      typeof firstName === 'string' ? firstName.trim().slice(0, 50) : '';
    // instructions is optional and overrides DEFAULT_ADVISOR_INSTRUCTIONS when
    // present — capped generously since it's meant to hold real guidance text.
    const safeInstructions =
      typeof instructions === 'string' ? instructions.trim().slice(0, 4000) : '';
    const safeAdvisorName =
      typeof advisorName === 'string' ? advisorName.trim().slice(0, 50) : '';
    const safeToneInstructions =
      typeof toneInstructions === 'string' ? toneInstructions.trim().slice(0, 2000) : '';
    const safeCrisisClosingMessage =
      typeof crisisClosingMessage === 'string' && crisisClosingMessage.trim()
        ? crisisClosingMessage.trim().slice(0, 2000)
        : DEFAULT_CRISIS_CLOSING_MESSAGE;

    const historyKey = `chat:${userId}`;

    // Load prior history from KV — this is what makes memory persist
    // across sessions, since it's keyed on userId, not the Qualtrics session.
    let history = await getHistory(historyKey);
    const { date, session } = computeDateAndSession(history);

    history.push({ role: 'user', content: message, ts: Date.now(), date, session });

    // --- Safety check & screen-time extraction: both run on the ---------
    // RESPONDENT's message, independent of what the advisor says back.
    const recentContext = history
      .slice(-7, -1)
      .map((m) => m.role.toUpperCase() + ': ' + m.content)
      .join('\n');
    const [flagged, screenTimeMinutes] = await Promise.all([
      isDistressFlagged(message, recentContext),
      extractScreenTimeMinutes(message, recentContext),
    ]);

    if (flagged) {
      history.push({ role: 'assistant', content: safeCrisisClosingMessage, ts: Date.now(), date, session });
      await setHistory(historyKey, history.slice(-MAX_STORED_MESSAGES));
      // Awaited deliberately: Vercel Node functions can terminate background
      // work once the response is sent, so a fire-and-forget call here risks
      // the email never actually going out. The email itself fails open
      // internally (logs and returns rather than throwing) so it can't block
      // the respondent from getting their closing message.
      await sendCrisisAlertEmail({ userId, date, session, history });
      return res.status(200).json({
        reply: safeCrisisClosingMessage,
        date,
        session,
        screenTimeMinutes: null,
        endConversation: true,
      });
    }

    const contextMessages = history
      .slice(-MAX_HISTORY_MESSAGES)
      .map((m) => ({
        role: m.role,
        content: '(Date: ' + (m.date || 'unknown') + ', Session ' + (m.session || 1) + ') ' + m.content,
      }));

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: buildSystemPrompt(safeFirstName, safeInstructions, safeAdvisorName) }, ...contextMessages],
      temperature: 0.7,
      max_tokens: 500,
    });

    const rawReply =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Sorry, I didn't catch that. Could you rephrase?";
    const cleaned = stripLeakedDateTag(rawReply);
    const reply = await applyToneRewrite(cleaned, safeToneInstructions);

    history.push({ role: 'assistant', content: reply, ts: Date.now(), date, session });

    // Persist to Redis — this write is exactly what the stateless version removes.
    await setHistory(historyKey, history.slice(-MAX_STORED_MESSAGES));

    return res.status(200).json({ reply, date, session, screenTimeMinutes });
  } catch (err) {
    console.error('chat handler error:', err);
    return res.status(500).json({ error: 'Something went wrong processing your request.' });
  }
}
