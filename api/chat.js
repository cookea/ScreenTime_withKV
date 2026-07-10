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

// Shifts the day boundary used for day numbering, in hours, so "day" aligns
// with your respondents' local time zone instead of UTC. E.g. set to -5 for
// US Eastern. Optional; defaults to 0 (UTC day boundaries).
const DAY_TZ_OFFSET_HOURS = Number(process.env.DAY_TZ_OFFSET_HOURS || 0);

// If a message arrives more than this many minutes after the previous one,
// on the SAME calendar day, it's treated as a new (rare) same-day session.
// This does not affect day numbering or the once-per-day question logic.
const SESSION_GAP_MINUTES = Number(process.env.SESSION_GAP_MINUTES || 30);

function dayKey(ts) {
  return new Date(ts + DAY_TZ_OFFSET_HOURS * 3600 * 1000).toISOString().slice(0, 10);
}

// Determines the day number and session number for the CURRENT message.
// - day increments once per calendar day this userId sends a message on
//   (Day 1 = first day ever, Day 2 = the next day they message, etc).
// - session increments only if there's a long gap (SESSION_GAP_MINUTES)
//   within the SAME day — multiple sessions can share a day, which is
//   expected to be uncommon. Crossing into a new day always starts a new
//   session too, since it's necessarily a new visit.
function computeDayAndSession(history) {
  if (!history.length) return { day: 1, session: 1 };
  const last = history[history.length - 1];
  const lastDay = last.day || 1;
  const lastSession = last.session || 1;
  const lastTs = last.ts || Date.now();
  const now = Date.now();

  if (dayKey(lastTs) !== dayKey(now)) {
    return { day: lastDay + 1, session: lastSession + 1 };
  }
  const gapMinutes = (now - lastTs) / 60000;
  return { day: lastDay, session: gapMinutes > SESSION_GAP_MINUTES ? lastSession + 1 : lastSession };
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
  'Each message below is prefixed with "(Day D, Session S)". Day increases once ' +
  'per calendar day the respondent visits — Day 1 is the first day, Day 2 the next ' +
  'day they message you, and so on. Session is a finer marker that only increases ' +
  'if there is a long gap within the SAME day (uncommon); multiple sessions can ' +
  'share the same day. Your goal is to collect exactly one clear answer about the ' +
  'respondent\'s social media use from the previous day, once per Day. If you ' +
  'already asked earlier that same Day and received a clear, specific answer, do ' +
  'not ask again that Day, even if a new Session starts within it. If their answer ' +
  'was vague, unclear, or they did not actually answer, you may ask again within ' +
  'the same Day to get a clear answer. Once the Day number increases (the ' +
  'respondent returns on a new day), you should ask again, since it now refers to ' +
  'a different prior day\'s usage.';

function buildSystemPrompt(firstName, instructions, advisorName) {
  var nameLine = advisorName ? 'Your name is ' + advisorName + '. ' : '';
  var greeting = firstName
    ? 'The respondent\'s first name is ' + firstName + '. Greet them by name at the ' +
      'start of the conversation and use their name naturally where appropriate. '
    : '';
  var body = instructions && instructions.trim() ? instructions.trim() : DEFAULT_ADVISOR_INSTRUCTIONS;
  return nameLine + greeting + CORE_BEHAVIOR_RULES + ' ' + body;
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
    const { day, session } = computeDayAndSession(history);

    history.push({ role: 'user', content: message, ts: Date.now(), day, session });

    const contextMessages = history
      .slice(-MAX_HISTORY_MESSAGES)
      .map((m) => ({
        role: m.role,
        content: '(Day ' + (m.day || 1) + ', Session ' + (m.session || 1) + ') ' + m.content,
      }));

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: buildSystemPrompt(safeFirstName, safeInstructions, safeAdvisorName) }, ...contextMessages],
      temperature: 0.7,
      max_tokens: 500,
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Sorry, I didn't catch that. Could you rephrase?";

    history.push({ role: 'assistant', content: reply, ts: Date.now(), day, session });

    // Persist to Redis — this write is exactly what the stateless version removes.
    await setHistory(historyKey, history.slice(-MAX_STORED_MESSAGES));

    return res.status(200).json({ reply, day, session });
  } catch (err) {
    console.error('chat handler error:', err);
    return res.status(500).json({ error: 'Something went wrong processing your request.' });
  }
}
