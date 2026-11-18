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

  await notifyTelegram(env, lead);
  await bump(env, "lead", lead.source, lead.country).catch(() => {});
  return { ok: true, id };
}

// ---------- telegram ----------
async function tgChatId(env) {
  return env.TELEGRAM_CHAT_ID || (await env.LEADS.get("cfg:tg_chat")) || "";
}

async function tgSend(env, chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  return r.ok;
}

async function notifyTelegram(env, lead) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const chatId = await tgChatId(env);
  if (!chatId) return;
  const wa = lead.contact.replace(/[^\d+]/g, "");
  const waLink = /^\+?\d{8,15}$/.test(wa) ? `\nWhatsApp: https://wa.me/${wa.replace("+", "")}` : "";
  const text = [
    "🔔 New lead from your website",
    "",
    `👤 ${lead.name}`,
    `📞 ${lead.contact}${waLink}`,
    `🛠 ${lead.need}${lead.details ? ": " + lead.details : ""}`,
    lead.business && `🏪 ${lead.business}`,
    lead.timeline && `⏱ ${lead.timeline}`,
    lead.country && `🌍 ${lead.country}`,
  ].filter(Boolean).join("\n");
  try { await tgSend(env, chatId, text); } catch (_) { /* lead is already stored */ }
}

// Finds the chat of whoever last messaged the bot and saves it, then sends a test message.
async function tgLink(env) {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, error: "TELEGRAM_BOT_TOKEN secret is not set" };
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates`);
  const data = await r.json().catch(() => ({}));
  if (!data.ok) return { ok: false, error: "Telegram rejected the bot token" };
  const msgs = (data.result || []).map((u) => u.message || u.edited_message).filter(Boolean);
  const last = msgs[msgs.length - 1];
  if (!last) return { ok: false, error: "No message found. Open your bot in Telegram, send it 'hi', then try again." };
  await env.LEADS.put("cfg:tg_chat", String(last.chat.id));
  const sent = await tgSend(env, last.chat.id, "✅ Connected! New website leads will arrive here.");
  return { ok: sent, chat: last.chat.first_name || last.chat.title || "", error: sent ? undefined : "Could not send the test message" };
}

// ---------- visit stats (D1: exact counts) ----------
const EVENTS = ["visit", "chat_open", "lead"];
const uaeDay = (offsetDays = 0) => new Date(Date.now() + 4 * 3600_000 - offsetDays * 86400_000).toISOString().slice(0, 10);

async function bump(env, event, src = "", country = "") {
  if (!EVENTS.includes(event) || !env.STATS) return;
  await env.STATS.prepare("INSERT INTO events (day, event, src, country, ts) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(uaeDay(), event, src, country, Date.now()).run();
}

async function stats(env, days) {
  const from = uaeDay(days - 1);
  const daily = await env.STATS.prepare(
    "SELECT day, SUM(event='visit') AS visit, SUM(event='chat_open') AS chat_open, SUM(event='lead') AS lead FROM events WHERE day >= ?1 GROUP BY day ORDER BY day DESC").bind(from).all();
  const sources = await env.STATS.prepare(
    "SELECT src, COUNT(*) AS n FROM events WHERE event='visit' AND day >= ?1 GROUP BY src ORDER BY n DESC").bind(from).all();
  const countries = await env.STATS.prepare(
    "SELECT country, COUNT(*) AS n FROM events WHERE event='visit' AND day >= ?1 GROUP BY country ORDER BY n DESC LIMIT 10").bind(from).all();
  const totals = { visit: 0, chat_open: 0, lead: 0 };
  for (const r of daily.results) for (const e of EVENTS) totals[e] += r[e] || 0;
  return {
    days, totals,
    sources: Object.fromEntries(sources.results.map((r) => [r.src || "direct", r.n])),
    countries: Object.fromEntries(countries.results.map((r) => [r.country || "?", r.n])),
    daily: daily.results,
  };
}

// ---------- telegram stats bot ----------
function ago(iso) {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}

async function latestLeads(env, n = 5) {
  const list = await env.LEADS.list({ prefix: "lead:", limit: 1000 });
  const keys = list.keys.map((k) => k.name).sort().slice(-n).reverse();
  const leads = await Promise.all(keys.map(async (k) => JSON.parse((await env.LEADS.get(k)) || "null")));
  return leads.filter(Boolean);
}

async function statsText(env) {
  const day = (o) => uaeDay(o);
  const q = async (sql, ...b) => (await env.STATS.prepare(sql).bind(...b).all()).results;
  const row = async (from, to) => (await q(
    "SELECT SUM(event='visit') v, SUM(event='chat_open') c, SUM(event='lead') l FROM events WHERE day BETWEEN ?1 AND ?2", from, to))[0] || {};
  const fmt = (r) => `${r.v || 0} visits · ${r.c || 0} chats · ${r.l || 0} ${r.l === 1 ? "lead" : "leads"}`;
  const t = await row(day(0), day(0)), y = await row(day(1), day(1)), w = await row(day(6), day(0)), m = await row(day(29), day(0));
  const src = await q("SELECT COALESCE(NULLIF(src,''),'direct') s, COUNT(*) n FROM events WHERE event='visit' AND day >= ?1 GROUP BY s ORDER BY n DESC LIMIT 5", day(6));
  const ctry = await q("SELECT COALESCE(NULLIF(country,''),'?') c, COUNT(*) n FROM events WHERE event='visit' AND day >= ?1 GROUP BY c ORDER BY n DESC LIMIT 5", day(6));
  const leads = await latestLeads(env, 5);
  return [
    "📊 soothram.pages.dev",
    "",
    `Today: ${fmt(t)}`,
    `Yesterday: ${fmt(y)}`,
    `Last 7 days: ${fmt(w)}`,
    `Last 30 days: ${fmt(m)}`,
    src.length ? `\nFrom (7 days): ${src.map((r) => `${r.s} ${r.n}`).join(", ")}` : "",
    ctry.length ? `Countries (7 days): ${ctry.map((r) => `${r.c} ${r.n}`).join(", ")}` : "",
    "",
    leads.length
      ? "👤 Latest leads:\n" + leads.map((l) => `• ${l.name} · ${l.contact} · ${l.need} (${ago(l.created)})`).join("\n")
      : "👤 No leads yet.",
  ].filter((x, i, a) => !(x === "" && a[i - 1] === "")).join("\n");
}

async function tgSetupWebhook(env, origin) {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, error: "TELEGRAM_BOT_TOKEN secret is not set" };
  const secret = crypto.randomUUID().replace(/-/g, "");
  await env.LEADS.put("cfg:tg_secret", secret);
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: `${origin}/telegram/webhook`, secret_token: secret, allowed_updates: ["message"] }),
  });
  const d = await r.json().catch(() => ({}));
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands: [{ command: "stats", description: "Website visits, chats and leads" }] }),
  }).catch(() => {});
  return { ok: !!d.ok, error: d.ok ? undefined : d.description };
}

async function tgWebhook(env, request) {
  const secret = await env.LEADS.get("cfg:tg_secret");
  if (!secret || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) return;
  const upd = await request.json().catch(() => ({}));
  const msg = upd.message;
  if (!msg || !msg.text) return;
  const owner = await tgChatId(env);
  if (String(msg.chat.id) !== String(owner)) return; // only answer the owner
  const text = msg.text.trim().toLowerCase();
  if (text.startsWith("/stats") || ["stats", "count", "show my site stats"].includes(text)) {
    await tgSend(env, owner, await statsText(env));
  } else {
    await tgSend(env, owner, "Send /stats to see your website visits, chats and leads. New leads arrive here automatically.");
  }
}

// ---------- router ----------
export default {
  // Daily summary to Telegram (cron in wrangler.toml)
  async scheduled(event, env, ctx) {
    if (!env.TELEGRAM_BOT_TOKEN || !env.STATS) return;
    const chat = await tgChatId(env);
    if (chat) ctx.waitUntil(statsText(env).then((t) => tgSend(env, chat, "☀️ Good morning! Daily summary\n\n" + t)));
  },

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

      if (url.pathname === "/telegram/link" && request.method === "POST") {
        const auth = request.headers.get("Authorization") || "";
        if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: "unauthorized" }, 401, h);
        const r = await tgLink(env);
        return json(r, r.ok ? 200 : 400, h);
      }

      if (url.pathname === "/hit" && request.method === "POST") {
        const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((x) => x.trim());
        if (!allowed.includes(origin)) return new Response(null, { status: 204, headers: h });
        const body = await request.json().catch(() => ({}));
        const src = String(body.src || "direct").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 20) || "direct";
        await bump(env, String(body.e || ""), src, request.cf?.country || "");
        return new Response(null, { status: 204, headers: h });
      }

      if (url.pathname === "/stats" && request.method === "GET") {
        const auth = request.headers.get("Authorization") || "";
        if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: "unauthorized" }, 401, h);
        const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "7", 10) || 7, 1), 60);
        return json(await stats(env, days), 200, h);
      }

      if (url.pathname === "/telegram/webhook" && request.method === "POST") {
        await tgWebhook(env, request);
        return new Response("ok", { status: 200 });
      }

      if (url.pathname === "/telegram/setup" && request.method === "POST") {
        const auth = request.headers.get("Authorization") || "";
        if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: "unauthorized" }, 401, h);
        const r = await tgSetupWebhook(env, url.origin);
        return json(r, r.ok ? 200 : 400, h);
      }

      if (url.pathname === "/telegram/stats-now" && request.method === "POST") {
        const auth = request.headers.get("Authorization") || "";
        if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: "unauthorized" }, 401, h);
        const chat = await tgChatId(env);
        const ok = chat ? await tgSend(env, chat, await statsText(env)) : false;
        return json({ ok }, ok ? 200 : 400, h);
      }

      if (url.pathname === "/") return json({ ok: true, service: "soothram-chat" }, 200, h);
      return json({ error: "not found" }, 404, h);
    } catch (err) {
      return json({ error: "server error" }, 500, h);
    }
  },
};
