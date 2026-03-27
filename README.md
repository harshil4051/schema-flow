## SchemaFlow AI (Webflow Schema Injector)

This repo serves a single-page UI (`index.html`) and exposes API routes under `/api/*` via an Express server.

### What to commit to GitHub

- Keep `env.example`
- **Do not commit** `.env` (already ignored by `.gitignore`)
- **Do not commit** `node_modules/` (already ignored by `.gitignore`)

If you already have `.env` locally, it will stay on your machine only.

### Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

### Deploy on Vercel

1. Push this repo to GitHub.
2. In Vercel, click **New Project** → import your GitHub repo.
3. In Vercel Project Settings → **Environment Variables**, add:
   - **OPENAI_API_KEY**: your OpenAI key (required for AI generation)
   - **OPENAI_MODEL**: optional (defaults to `gpt-4o-mini`)
4. Deploy.

Notes:
- `vercel.json` routes all traffic through `api/index.js`, which runs the Express app and serves `index.html` + static assets from the repo root.
- The UI will call `/api/health` and `/api/ai/generate` on the same domain (no CORS issues on Vercel).

