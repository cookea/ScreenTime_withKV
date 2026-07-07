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

// --- Advisor configuration -------------------------------------------------
// This is the fallback used when the Qualtrics survey doesn't supply its
// own instructions via the "AdvisorInstructions" Embedded Data field. Edit
// this directly if you want a hardcoded default; otherwise control it
// per-survey from Qualtrics (see qualtrics-widget.js).
const DEFAULT_ADVISOR_INSTRUCTIONS =
  'You are a helpful advisor assisting a survey respondent. Be concise, ' +
  'supportive, and stay on topic. Remember context from earlier in this ' +
  'conversation and across the person\'s previous sessions.';

function buildSystemPrompt(firstName, instructions) {
  var greeting = firstName
    ? 'The respondent\'s first name is ' + firstName + '. Greet them by name at the ' +
      'start of the conversation and use their name naturally where appropriate. '
    : '';
  var body = instructions && instructions.trim() ? instructions.trim() : DEFAULT_ADVISOR_INSTRUCTIONS;
  return greeting + body;
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
    const { userId, message, firstName, instructions } = req.body || {};

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

    const historyKey = `chat:${userId}`;

    // Load prior history from KV — this is what makes memory persist
    // across sessions, since it's keyed on userId, not the Qualtrics session.
    let history = await getHistory(historyKey);

    history.push({ role: 'user', content: message, ts: Date.now() });

    const contextMessages = history
      .slice(-MAX_HISTORY_MESSAGES)
      .map(({ role, content }) => ({ role, content }));

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: buildSystemPrompt(safeFirstName, safeInstructions) }, ...contextMessages],
      temperature: 0.7,
      max_tokens: 500,
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Sorry, I didn't catch that. Could you rephrase?";

    history.push({ role: 'assistant', content: reply, ts: Date.now() });

    // Persist to Redis — this write is exactly what the stateless version removes.
    await setHistory(historyKey, history.slice(-MAX_STORED_MESSAGES));

    return res.status(200).json({ reply });
  } catch (err) {
    console.error('chat handler error:', err);
    return res.status(500).json({ error: 'Something went wrong processing your request.' });
  }
}
