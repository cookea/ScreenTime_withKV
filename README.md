# Variant: WITH VERCEL KV

Conversation history is stored server-side on Vercel, in a KV (Redis)
database, keyed by `userId`. The Qualtrics widget is "dumb" — it doesn't
carry any state itself; it just asks the backend for history on load and
sends one message at a time.

## Where messages live
- **At rest:** Vercel KV (`chat:<userId>` key), indefinitely (until you
  add expiry/cleanup logic).
- **In transit:** Vercel ⇄ OpenAI, same as any version.

## Pros
- Cross-session, cross-device memory works automatically and simply, as
  long as `userId` is stable — no extra Directory/API complexity needed.
- Widget code is simpler (no local history bookkeeping).
- No message-length ceiling from Qualtrics field limits — KV can hold much
  larger histories.

## Cons
- PII (the actual conversation content) is stored outside Qualtrics, on
  Vercel infrastructure — this is the property the "stateless" variant
  was built to avoid.
- You now have a database to secure, back up, and apply a retention/
  deletion policy to, separately from Qualtrics's own data governance.

## Setup
See `../COMPARISON.md` for the side-by-side setup steps, or:
1. `npm install`
2. Deploy to Vercel, attach a KV database (Storage → Create Database → KV)
3. Set env vars: `OPENAI_API_KEY`, `ALLOWED_ORIGIN`
4. Paste `qualtrics-widget.js` into a Qualtrics question, set `BACKEND_URL`
5. Populate `UserId` embedded data (SSO, panel field, or login question)

## Files
- `api/chat.js` — reads/writes history to KV, calls OpenAI
- `api/history.js` — returns stored history for a userId
- `qualtrics-widget.js` — thin client, no local state
- `package.json` — includes `@vercel/kv`
