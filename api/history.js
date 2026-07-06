// api/history.js — WITH-KV VERSION
// Returns a user's stored conversation history from Vercel KV. Called
// when the Qualtrics widget loads, so returning users see their prior
// messages even in a brand-new survey session.

import { kv } from '@vercel/kv';

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { userId } = req.query;
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'userId is required' });
  }

  try {
    const history = (await kv.get(`chat:${userId}`)) || [];
    return res.status(200).json({ history });
  } catch (err) {
    console.error('history handler error:', err);
    return res.status(500).json({ error: 'Could not load history.' });
  }
}
