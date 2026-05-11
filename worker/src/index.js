// The Panache Store — Cloudflare Worker
// GET    /api/items         → public
// POST   /api/bulk          → auth, replace entire catalog
// POST   /api/items         → auth, create
// PATCH  /api/items/:id     → auth, update
// DELETE /api/items/:id     → auth, delete
// Auth: Authorization: Bearer <ADMIN_TOKEN>  (set via `wrangler secret put ADMIN_TOKEN`)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });

const authed = (req, env) => {
  const h = req.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") && env.ADMIN_TOKEN && h.slice(7).trim() === env.ADMIN_TOKEN;
};

async function getData(env) {
  const raw = await env.ITEMS.get("data");
  if (!raw) return { items: [], settings: {} };
  try { return JSON.parse(raw); } catch { return { items: [], settings: {} }; }
}

async function putData(env, data) {
  await env.ITEMS.put("data", JSON.stringify(data));
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    // Health
    if (path === "/api/health") return json({ ok: true, time: new Date().toISOString() });

    // GET /api/items — public
    if (request.method === "GET" && path === "/api/items") {
      const data = await getData(env);
      return json(data, 200, { "Cache-Control": "public, max-age=10" });
    }

    // POST /api/bulk — replace entire catalog
    if (request.method === "POST" && path === "/api/bulk") {
      if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      if (!Array.isArray(body.items)) return json({ error: "items must be an array" }, 400);
      await putData(env, { items: body.items, settings: body.settings || {} });
      return json({ ok: true, count: body.items.length });
    }

    // POST /api/items — create
    if (request.method === "POST" && path === "/api/items") {
      if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
      let item;
      try { item = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      if (!item.name || item.price == null) return json({ error: "name and price required" }, 400);
      const data = await getData(env);
      item.id = item.id || `item_${Date.now()}`;
      data.items.unshift(item);
      await putData(env, data);
      return json(item, 201);
    }

    // /api/items/:id
    const match = path.match(/^\/api\/items\/([^/]+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]);

      if (request.method === "PATCH") {
        if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
        let patch;
        try { patch = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
        const data = await getData(env);
        const idx = data.items.findIndex(i => i.id === id);
        if (idx === -1) return json({ error: "not found" }, 404);
        data.items[idx] = { ...data.items[idx], ...patch, id };
        await putData(env, data);
        return json(data.items[idx]);
      }

      if (request.method === "DELETE") {
        if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
        const data = await getData(env);
        const before = data.items.length;
        data.items = data.items.filter(i => i.id !== id);
        if (data.items.length === before) return json({ error: "not found" }, 404);
        await putData(env, data);
        return json({ ok: true });
      }

      if (request.method === "GET") {
        const data = await getData(env);
        const item = data.items.find(i => i.id === id);
        if (!item) return json({ error: "not found" }, 404);
        return json(item);
      }
    }

    return json({ error: "not found" }, 404);
  },
};
