// lib/redis.js
// Shared Redis client using the standard REDIS_URL connection string
// (as provisioned by Vercel Marketplace Redis integrations, e.g. the
// "redis-rose-saddle" store). This replaces @vercel/kv, which only
// works with Upstash's REST API interface (KV_REST_API_URL/TOKEN) and
// is incompatible with a plain REDIS_URL.
//
// Reused across warm serverless invocations via a module-level
// singleton, so we don't open a new TCP connection on every request.

import Redis from 'ioredis';

let client;

export function getRedis() {
  if (!client) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error('Missing required environment variable REDIS_URL');
    }
    client = new Redis(url, {
      // Fail fast instead of hanging if the store is unreachable.
      maxRetriesPerRequest: 3,
      // Vercel functions are short-lived; avoid ioredis's default
      // reconnect/backoff chatter across invocations.
      lazyConnect: false,
    });
  }
  return client;
}

export async function getHistory(key) {
  const redis = getRedis();
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : [];
}

export async function setHistory(key, history) {
  const redis = getRedis();
  await redis.set(key, JSON.stringify(history));
}
