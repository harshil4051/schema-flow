import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const PORT = Number(process.env.PORT) || 3000;
const WEBFLOW_V2 = "https://api.webflow.com/v2";

const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));
app.use(express.static(root));

const mapType = {
  faq: "FAQPage with 5+ relevant Q&A pairs",
  art: "Article with all required metadata",
  how: "HowTo with 4+ numbered steps",
  bc: "BreadcrumbList showing page hierarchy",
  org: "Organization with complete business details",
  prod: "Product with pricing and availability",
};

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    openai: !!process.env.OPENAI_API_KEY,
    service: "SchemaFlow AI",
  });
});

app.post("/api/ai/generate", async (req, res) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return res.status(503).json({
      error:
        "OPENAI_API_KEY is not set on the server. Copy env.example to .env, add your key, and restart npm start.",
    });
  }

  const { type, title, slug, context, cmsContext, mode, selectedExtraTypes, canonicalUrl, siteBaseUrl } = req.body || {};
  const t = mapType[type] || "JSON-LD for schema.org";
  const cmsBlock =
    cmsContext && String(cmsContext).trim()
      ? `\n\nCMS / collection fields (use facts from here when relevant):\n${String(cmsContext).trim()}`
      : "";

  const promptBasic = `Generate a complete valid JSON-LD ${t} schema for this Webflow page:

Page Title: ${title || "Untitled"}
URL Slug: ${slug || "/"}
Canonical URL: ${canonicalUrl || "Not provided"}
Site Base URL: ${siteBaseUrl || "Not provided"}
Context: ${context && String(context).trim() ? String(context).trim() : "No extra context provided"}${cmsBlock}

RULES:
- Return ONLY raw JSON-LD, no markdown, no backticks, no explanation
- Must have @context "https://schema.org" and @type
- Make it realistic and SEO-optimised for the page topic
- NEVER use placeholder domains like "yourwebsite.com", "example.com", or unrelated domains
- Use provided Canonical URL / Site Base URL for url/@id/item fields
- For FAQ: include 5 genuinely helpful Q&A pairs
- For Article: use today's date in ISO where applicable
- For HowTo: include 4 clear actionable steps`;

  const promptBundle = `You are an AI Schema Generator for Webflow.

Your job is to:
1) Analyze the selected page content, URL, and CMS data.
2) Detect page type automatically.
3) Suggest relevant schema types for UI selection.
4) Generate valid JSON-LD using schema.org.
5) Return output in exact JSON format below.

Input:
- Page Title: ${title || "Untitled"}
- URL Slug: ${slug || "/"}
- Canonical URL: ${canonicalUrl || "Not provided"}
- Site Base URL: ${siteBaseUrl || "Not provided"}
- Context: ${context && String(context).trim() ? String(context).trim() : "No extra context provided"}${cmsBlock}
- User selected extra schema types: ${
    Array.isArray(selectedExtraTypes) && selectedExtraTypes.length ? selectedExtraTypes.join(", ") : "none"
  }

Classify pageType into one of:
- homepage
- article/blog
- faq
- service
- product
- generic webpage

Suggestion rules:
- Homepage: Organization(required), WebSite(required), BreadcrumbList(optional)
- Article/blog: Article(required), BreadcrumbList(recommended), FAQPage(optional)
- FAQ: FAQPage(required)
- Service: WebPage, Service, FAQPage, BreadcrumbList
- Product: Product(required), Offer(required), Review(optional), BreadcrumbList

Return ONLY this JSON:
{
  "ui": {
    "pageType": "...",
    "recommendedSchemas": [
      { "type": "Organization", "required": true }
    ]
  },
  "schema": {
    "@context": "https://schema.org",
    "@graph": []
  }
}

Rules:
- No markdown, no backticks, no comments.
- Use real content from input.
- Keep valid schema.org JSON-LD only.
- Output one flat @graph only (no nested @graph inside graph items).
- Never use placeholder/fake domains; always use provided Canonical URL / Site Base URL.
- Production-ready clean JSON.`;

  try {
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: mode === "bundle" ? promptBundle : promptBasic }],
        temperature: 0.35,
        max_tokens: 2500,
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      const errMsg = data?.error?.message || r.statusText || "OpenAI request failed";
      return res.status(r.status >= 400 && r.status < 600 ? r.status : 502).json({ error: errMsg });
    }

    let txt = data?.choices?.[0]?.message?.content || "{}";
    txt = txt.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
    if (mode === "bundle") {
      try {
        const parsed = JSON.parse(txt);
        if (!parsed?.ui || !parsed?.schema) throw new Error("Invalid bundle shape");
        return res.json({ bundle: parsed, model });
      } catch {
        return res.status(502).json({ error: "AI returned invalid bundle JSON" });
      }
    }
    return res.json({ text: txt, model });
  } catch (e) {
    return res.status(500).json({ error: e.message || "AI generation failed" });
  }
});

/**
 * Experimental Browser Bot:
 * Opens Webflow Designer page settings URL, fills schema/code editor, and clicks Save.
 * Requires the user to provide a valid `settingsUrl` where the schema/custom code editor is visible.
 */
app.post("/api/bot/sync", async (req, res) => {
  const { settingsUrl, schema, target, bindField, fieldName } = req.body || {};
  if (!settingsUrl || !schema) {
    return res.status(400).json({ error: "settingsUrl and schema are required" });
  }

  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    return res.status(501).json({
      error: "Browser bot dependency missing. Run: npm install playwright",
    });
  }

  const profileDir = process.env.BOT_PROFILE_DIR || path.join(root, ".bot-profile");
  const browserType = playwright.chromium;
  let context;
  try {
    context = await browserType.launchPersistentContext(profileDir, {
      headless: false,
      viewport: { width: 1400, height: 900 },
    });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(settingsUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(2500);

    if (bindField && fieldName) {
      // Try to bind CMS field in Schema markup section.
      const addFieldBtn = page.getByRole("button", { name: /add field/i }).first();
      if (await addFieldBtn.count()) {
        await addFieldBtn.click({ timeout: 4000 });
        await page.waitForTimeout(500);
        const option = page.getByText(fieldName, { exact: false }).first();
        if (await option.count()) {
          await option.click({ timeout: 4000 });
          await page.waitForTimeout(400);
        } else {
          await context.close();
          return res.status(422).json({ error: `Could not find field option: ${fieldName}` });
        }
      } else {
        await context.close();
        return res.status(422).json({ error: "Could not find '+ Add Field' button in current settings page." });
      }
    }

    // Try to keep schema inside script tag for custom code targets.
    const scriptTag = `<script type="application/ld+json">\n${schema}\n<\/script>`;
    const valueToWrite = target === "schemaField" ? schema : scriptTag;

    // Try common editable targets in Webflow settings panel.
    const candidateSelectors = [
      "textarea",
      "[contenteditable='true']",
      ".cm-content",
      ".monaco-editor textarea",
    ];

    let wrote = false;
    for (const sel of candidateSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        try {
          await loc.click({ timeout: 2000 });
          // Clear and type robustly across editor types.
          await page.keyboard.press("Control+A");
          await page.keyboard.type(valueToWrite, { delay: 1 });
          wrote = true;
          break;
        } catch {
          // Continue trying next selector.
        }
      }
    }

    if (!wrote) {
      await context.close();
      return res.status(422).json({
        error: "Could not find an editable schema/code field in the current Webflow settings page.",
      });
    }

    // Try save buttons.
    const saveCandidates = [
      page.getByRole("button", { name: /^save$/i }),
      page.getByRole("button", { name: /^save\s*$/i }),
      page.locator("button:has-text('Save')").first(),
    ];
    let saved = false;
    for (const btn of saveCandidates) {
      try {
        if (await btn.count()) {
          await btn.click({ timeout: 3000 });
          saved = true;
          break;
        }
      } catch {}
    }

    await page.waitForTimeout(1200);
    await context.close();
    return res.json({ ok: true, saved, target, bindField: !!bindField });
  } catch (e) {
    try { if (context) await context.close(); } catch {}
    return res.status(500).json({ error: e.message || "Browser bot sync failed" });
  }
});

/** Proxy Webflow API v2 — forwards Authorization Bearer token from the client */
app.use("/api/webflow", async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const pathPart = u.pathname || "/";
  const url = `${WEBFLOW_V2}${pathPart}${u.search}`;

  const auth = req.headers.authorization;
  if (!auth || !/^Bearer\s+\S+/.test(auth)) {
    return res.status(401).json({ error: "Missing or invalid Authorization Bearer token for Webflow" });
  }

  const headers = {
    Authorization: auth,
    Accept: "application/json",
    "Accept-Version": "2.0.0",
  };

  const init = { method: req.method, headers };
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.body != null && Object.keys(req.body).length) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(req.body);
  }

  try {
    const r = await fetch(url, init);
    const text = await r.text();
    const ct = r.headers.get("content-type") || "";
    res.status(r.status);
    if (ct.includes("application/json")) {
      try {
        return res.json(JSON.parse(text));
      } catch {
        return res.type("application/json").send(text);
      }
    }
    return res.send(text);
  } catch (e) {
    return res.status(502).json({ error: e.message || "Webflow proxy failed" });
  }
});

// Vercel: this file is imported by `api/index.js` and must not start a listener.
// Local dev/prod: `npm start` runs this file directly, so we start the server.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`SchemaFlow AI — http://localhost:${PORT}`);
    console.log(`Webflow proxy: /api/webflow/*  →  ${WEBFLOW_V2}`);
    console.log(`OpenAI: ${process.env.OPENAI_API_KEY ? "configured" : "NOT SET (add OPENAI_API_KEY to .env)"}`);
  });
}

export default app;
