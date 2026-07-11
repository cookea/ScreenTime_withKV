// api/history.js — WITH-KV VERSION
// Returns a user's stored conversation history from Vercel KV. Called
// when the Qualtrics widget loads, so returning users see their prior
// messages even in a brand-new survey session.

import { getHistory } from '../lib/redis.js';

// Comma-separated list of allowed origins — see chat.js for details.
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { userId } = req.query;
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'userId is required' });
  }

  try {
    const history = await getHistory(`chat:${userId}`);
    return res.status(200).json({ history });
  } catch (err) {
    console.error('history handler error:', err);
    return res.status(500).json({ error: 'Could not load history.' });
  }
}
