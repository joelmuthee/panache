// The Panache Store — Cloudflare Worker
// GET    /api/items         → public
// GET    /api/ig-fetch?url= → public, single IG post {code, imageUrl, imageUrls, caption, postUrl, isCarousel}
// GET    /api/ig-proxy?url= → public, CORS-friendly pipe of an IG CDN image
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

// Decode HTML entities IG slathers across og:description and the embed Caption
// div. Named entities + decimal (&#064;) + hex (&#x40;). Without this, captions
// contain literal "&#064;" instead of "@", which breaks admin's @<price> parser.
const decodeEntities = (s) => (s || "")
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&apos;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&nbsp;/g, " ")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
  .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));

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

    // ---- IG quick-add: server-side fetch of a public Instagram post ----
    // Powers admin's "⚡ Fetch from Instagram" panel. CORS prevents the admin's
    // browser from doing this directly, so we go through the Worker.
    // Reference implementation: Website Designs/ryker-luxury/worker/src/index.js
    //
    // Shortcode regex per CATALOG-STANDARDS: accept all IG public URL shapes —
    //   /p/<code>/         photo posts
    //   /reel/<code>/      single reel
    //   /reels/<code>/     plural — some share sheets emit this
    //   /tv/<code>/        IGTV
    //   /share/reel/<code>/, /share/p/<code>/   share-sheet shortlinks
    if (request.method === "GET" && path === "/api/ig-fetch") {
      const igUrl = url.searchParams.get("url");
      if (!igUrl) return json({ error: "url required" }, 400);
      const m = igUrl.match(/instagram\.com\/(?:share\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
      if (!m) return json({ error: "not an Instagram post URL" }, 400);
      const code = m[1];

      // Full browser-shape headers — IG actively blocks lean User-Agents.
      const headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "max-age=0",
        "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"macOS"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      };

      try {
        let caption = "", imageUrl = "", imageUrls = [];

        // 1. Embed page — most bot-friendly source for caption + cover image.
        const embedRes = await fetch(`https://www.instagram.com/p/${code}/embed/captioned/`, { headers });
        if (embedRes.ok) {
          const html = await embedRes.text();
          const img = html.match(/<img[^>]+class=["'][^"']*EmbeddedMediaImage[^"']*["'][^>]+src=["']([^"']+)["']/i)
            || html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
          if (img) imageUrl = img[1].replace(/&amp;/g, "&");
          const capDiv = html.match(/<div[^>]+class=["'][^"']*Caption[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
          if (capDiv) caption = decodeEntities(capDiv[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
          if (!caption) {
            const desc = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
            if (desc) caption = decodeEntities(desc[1]);
          }
        }

        // 2. JSON endpoint — gives full carousel image list.
        try {
          const jsonRes = await fetch(`https://www.instagram.com/p/${code}/?__a=1&__d=dis`, {
            headers: { ...headers, "X-IG-App-ID": "936619743392459" },
          });
          if (jsonRes.ok) {
            const text = await jsonRes.text();
            if (text.trim().startsWith("{")) {
              const data = JSON.parse(text);
              const media = data?.graphql?.shortcode_media || data?.items?.[0] || data?.shortcode_media;
              if (media) {
                const children = media.edge_sidecar_to_children?.edges?.map(e => e.node) || media.carousel_media || [];
                if (children.length) {
                  imageUrls = children.map(c => c.display_url || c.image_versions2?.candidates?.[0]?.url).filter(Boolean);
                }
                if (!imageUrls.length) {
                  const single = media.display_url || media.image_versions2?.candidates?.[0]?.url;
                  if (single) imageUrls = [single];
                }
                if (!caption) {
                  const cap = media.edge_media_to_caption?.edges?.[0]?.node?.text || media.caption?.text;
                  if (cap) caption = cap;
                }
              }
            }
          }
        } catch (_) {}

        // 3. Final fallback: post-page OG tags.
        if (!imageUrl && !imageUrls.length) {
          const pageRes = await fetch(`https://www.instagram.com/p/${code}/`, { headers });
          if (pageRes.ok) {
            const html = await pageRes.text();
            const img = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
            const desc = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
            if (img) imageUrl = img[1].replace(/&amp;/g, "&");
            if (desc && !caption) {
              caption = decodeEntities(desc[1]);
              const m1 = caption.match(/^"(.+)"\s*-\s*@/s);
              if (m1) caption = m1[1];
            }
          }
        }

        if (!imageUrls.length && imageUrl) imageUrls = [imageUrl];
        if (!imageUrls.length) return json({ error: "Instagram blocked the request. Paste images manually instead." }, 502);

        return json({
          code,
          imageUrl: imageUrls[0],
          imageUrls,
          caption,
          postUrl: `https://www.instagram.com/p/${code}/`,
          isCarousel: imageUrls.length > 1,
        });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // ---- IG image proxy ----
    // Pipes an IG CDN image through the Worker so the admin can download it
    // without hitting CORS (IG CDN doesn't send Access-Control-Allow-Origin).
    // Host allowlist: cdninstagram.com, fbcdn.net only. Sends Referer so the
    // CDN doesn't 403 the request.
    if (request.method === "GET" && path === "/api/ig-proxy") {
      const target = url.searchParams.get("url");
      if (!target) return json({ error: "url required" }, 400);
      try {
        const u = new URL(target);
        if (!/cdninstagram\.com$|fbcdn\.net$/.test(u.hostname)) {
          return json({ error: "host not allowed" }, 400);
        }
        const res = await fetch(target, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": "https://www.instagram.com/",
          },
        });
        if (!res.ok) return json({ error: `upstream ${res.status}` }, 502);
        return new Response(res.body, {
          headers: {
            "Content-Type": res.headers.get("Content-Type") || "image/jpeg",
            "Cache-Control": "public, max-age=3600",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    return json({ error: "not found" }, 404);
  },
};
