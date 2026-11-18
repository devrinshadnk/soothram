// ---------------------------------------------------------------------------
// Soothram website lead API (free: no AI, runs on the Cloudflare Workers free plan)
//
// Routes
//   POST /lead   { name, contact, need, details?, business?, timeline?, source? } -> { ok }
//   GET  /leads  (Authorization: Bearer <ADMIN_TOKEN>) -> newest leads as JSON
// ---------------------------------------------------------------------------

const RATE_LIMIT = 40;         // requests per IP per hour

// ---------- helpers ----------
const clip = (v, n = 300) => (typeof v === "string" ? v.trim().slice(0, n) : "");

function cors(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
  const ok = allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0] || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (data, status, headers) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

async function rateLimited(env, ip) {
  if (!env.LEADS) return false;
  const key = `rl:${ip}:${Math.floor(Date.now() / 3_600_000)}`;
  const n = parseInt((await env.LEADS.get(key)) || "0", 10);
  if (n >= RATE_LIMIT) return true;
  await env.LEADS.put(key, String(n + 1), { expirationTtl: 3700 });
  return false;
}

async function saveLead(env, raw, meta) {
  const lead = {
    name: clip(raw.name, 120),
    contact: clip(raw.contact, 160),
    need: clip(raw.need, 300),
    details: clip(raw.details, 1000),
    business: clip(raw.business, 160),
    budget: clip(raw.budget, 120),
    timeline: clip(raw.timeline, 120),
    language: clip(raw.language, 40),
    source: clip(raw.source || meta.source, 40),
    page: clip(meta.page, 200),
    country: meta.country || "",
    created: new Date().toISOString(),
  };
  if (!lead.name || !lead.contact || !lead.need) {
    return { ok: false, error: "name, contact and need are required" };
  }
  const id = `lead:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
  await env.LEADS.put(id, JSON.stringify(lead));

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const text = [
      "New lead from soothram website",
      `Name: ${lead.name}`,
      `Contact: ${lead.contact}`,
      `Need: ${lead.need}`,
      lead.details && `Details: ${lead.details}`,
      lead.business && `Business: ${lead.business}`,
      lead.budget && `Budget: ${lead.budget}`,
      lead.timeline && `Timeline: ${lead.timeline}`,
      `Via: ${lead.source} ${lead.country}`,
    ].filter(Boolean).join("\n");
    try {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
      });
    } catch (_) { /* lead is already stored */ }
  }
  return { ok: true, id };
}

// ---------- router ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const h = cors(origin, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: h });

    const ip = request.headers.get("CF-Connecting-IP") || "local";
    const meta = {
      page: request.headers.get("Referer") || "",
      country: request.cf?.country || "",
      source: "form",
    };

    try {
      if (url.pathname === "/lead" && request.method === "POST") {
        if (await rateLimited(env, ip)) return json({ error: "too many requests" }, 429, h);
        const body = await request.json().catch(() => ({}));
        if (body.website) return json({ ok: true }, 200, h); // honeypot field filled = bot
        const r = await saveLead(env, body, meta);
        return json(r, r.ok ? 200 : 400, h);
      }

      if (url.pathname === "/leads" && request.method === "GET") {
        const auth = request.headers.get("Authorization") || "";
        if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: "unauthorized" }, 401, h);
        const list = await env.LEADS.list({ prefix: "lead:", limit: 200 });
        const leads = await Promise.all(
          list.keys.map(async (k) => ({ id: k.name, ...JSON.parse((await env.LEADS.get(k.name)) || "{}") })),
        );
        leads.sort((a, b) => (a.created < b.created ? 1 : -1));
        return json({ count: leads.length, leads }, 200, h);
      }

      if (url.pathname === "/") return json({ ok: true, service: "soothram-chat" }, 200, h);
      return json({ error: "not found" }, 404, h);
    } catch (err) {
      return json({ error: "server error" }, 500, h);
    }
  },
};
