// api/chat.js — WITH-KV VERSION
// Receives a user message, loads that user's conversation history from
// Vercel KV, calls OpenAI with full context, saves the updated history
// back to KV, and returns the assistant's reply. History persists on
// Vercel, keyed by userId, across any number of separate sessions.

import { getHistory, setHistory } from '../lib/redis.js';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
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

// The model signals a captured screen-time estimate by appending this exact
// machine-readable tag to the end of its reply. We extract the minute value
// and strip the tag before the reply is ever shown to the respondent.
const SCREEN_TIME_TAG_RE = /\[\[SCREEN_TIME_MINUTES:\s*(\d+)\s*\]\]/i;

function extractScreenTimeMinutes(text) {
  const withoutLeakedTag = text.replace(LEAKED_DATE_TAG_RE, '');
  const match = withoutLeakedTag.match(SCREEN_TIME_TAG_RE);
  if (!match) return { cleaned: withoutLeakedTag.trim(), minutes: null };
  const minutes = parseInt(match[1], 10);
  const cleaned = withoutLeakedTag.replace(SCREEN_TIME_TAG_RE, '').trim();
  return { cleaned, minutes: Number.isFinite(minutes) ? minutes : null };
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

// Also always included — governs how a captured estimate gets signaled back
// to the survey so it can be saved as data, without the respondent ever
// seeing the machine-readable tag itself.
const SCREEN_TIME_CAPTURE_RULES =
  'As soon as the respondent gives a clear, specific answer about how much ' +
  'time they spent on social media the previous day, convert that amount to a ' +
  'single whole number of total minutes (e.g. "an hour and a half" = 90, "2 ' +
  'hours" = 120, "45 min" = 45, "2h 15m" = 135), and append a hidden tag on its ' +
  'own line at the very end of your reply, in exactly this format with no other ' +
  'text on that line: [[SCREEN_TIME_MINUTES: N]] — where N is that whole number. ' +
  'Only include this tag once you have a clear, confident estimate; do not ' +
  'include it while still asking a clarifying or follow-up question. Never ' +
  'mention this tag to the respondent, explain it, or refer to it in any way — ' +
  'it is invisible metadata, not part of the conversation.';

function buildSystemPrompt(firstName, instructions, advisorName) {
  var nameLine = advisorName ? 'Your name is ' + advisorName + '. ' : '';
  var greeting = firstName
    ? 'The respondent\'s first name is ' + firstName + '. Greet them by name at the ' +
      'start of the conversation and use their name naturally where appropriate. '
    : '';
  var body = instructions && instructions.trim() ? instructions.trim() : DEFAULT_ADVISOR_INSTRUCTIONS;
  return nameLine + greeting + CORE_BEHAVIOR_RULES + ' ' + SCREEN_TIME_CAPTURE_RULES + ' ' + body;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId, message, firstName, instructions, advisorName } = req.body || {};

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

    const historyKey = `chat:${userId}`;

    // Load prior history from KV — this is what makes memory persist
    // across sessions, since it's keyed on userId, not the Qualtrics session.
    let history = await getHistory(historyKey);
    const { date, session } = computeDateAndSession(history);

    history.push({ role: 'user', content: message, ts: Date.now(), date, session });

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
    const { cleaned: reply, minutes: screenTimeMinutes } = extractScreenTimeMinutes(rawReply);

    history.push({ role: 'assistant', content: reply, ts: Date.now(), date, session });

    // Persist to Redis — this write is exactly what the stateless version removes.
    await setHistory(historyKey, history.slice(-MAX_STORED_MESSAGES));

    return res.status(200).json({ reply, date, session, screenTimeMinutes });
  } catch (err) {
    console.error('chat handler error:', err);
    return res.status(500).json({ error: 'Something went wrong processing your request.' });
  }
}
