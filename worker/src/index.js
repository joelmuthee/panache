// The Panache Store — Cloudflare Worker
// GET    /api/items                  → public, full catalog
// GET    /api/health                 → public liveness
// GET    /api/ig-fetch?url=          → public, single IG post {code, imageUrl, imageUrls, caption, postUrl, isCarousel}
// GET    /api/ig-proxy?url=          → public, CORS-friendly pipe of an IG CDN image
// GET    /api/ig-feed?username=&user_id=&count=&max_id= → public, profile-feed (seed-time)
// GET    /api/ig-discover?user_id=&limit= → auth, AI-classified fresh candidates for admin sync widget
// GET    /api/ig-accept-license      → auth, one-time CF Workers AI EULA accept
// GET    /api/ig-classify?shortcode= → auth, debug a single post against both classifiers
// POST   /api/bulk                   → auth, replace entire catalog
// POST   /api/items                  → auth, create
// PATCH  /api/items/:id              → auth, update
// DELETE /api/items/:id              → auth, delete
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

// Master token = billing/agency only. Controls the suspend flag. The shop's
// ADMIN_TOKEN can NOT flip suspend, so the owner can't reactivate themselves.
const isMaster = (req, env) => {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  return env.MASTER_TOKEN && auth.slice(7).trim() === env.MASTER_TOKEN.trim();
};

const suspendBlock = async (req, env) => {
  if (isMaster(req, env)) return null;
  if ((await env.ITEMS.get("suspended")) === "1") {
    return json({ error: "account suspended; contact billing to restore the store" }, 403);
  }
  return null;
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

// ---- Caption → brand/category/stock heuristics for IG sync ----
// Panache stocks women's footwear primarily (Heels, Flats, Sandals, Boots,
// Sneakers, Loafers) + a Men's Shoes bucket. Order matters: specific models
// before generic brand fallbacks.
const PANACHE_BRANDS = [
  ["nike air force",   "Nike Air Force",    "Sneakers"],
  ["air force",        "Nike Air Force",    "Sneakers"],
  ["nike air max",     "Nike Air Max",      "Sneakers"],
  ["air max",          "Nike Air Max",      "Sneakers"],
  ["nike cortez",      "Nike Cortez",       "Sneakers"],
  ["nike dunk",        "Nike Dunk",         "Sneakers"],
  ["jordan",           "Jordan",            "Sneakers"],
  ["adidas samba",     "Adidas Samba",      "Sneakers"],
  ["samba",            "Adidas Samba",      "Sneakers"],
  ["stan smith",       "Adidas Stan Smith", "Sneakers"],
  ["adidas",           "Adidas",            "Sneakers"],
  ["puma",             "Puma",              "Sneakers"],
  ["converse",         "Converse",          "Sneakers"],
  ["vans",             "Vans",              "Sneakers"],
  ["new balance",      "New Balance",       "Sneakers"],
  ["asics",            "Asics",             "Sneakers"],
  ["reebok",           "Reebok",            "Sneakers"],
  ["nike",             "Nike",              "Sneakers"],
  ["timberland",       "Timberland",        "Boots"],
  ["dr martens",       "Dr Martens",        "Boots"],
  ["doc martens",      "Dr Martens",        "Boots"],
  ["ugg",              "UGG",               "Boots"],
  ["chelsea boot",     "Chelsea Boots",     "Boots"],
  ["ankle boot",       "Ankle Boots",       "Boots"],
  ["cole haan",        "Cole Haan",         "Loafers"],
  ["clarks",           "Clarks",            "Loafers"],
  ["clark ",           "Clarks",            "Loafers"],
  ["birkenstock",      "Birkenstock",       "Sandals"],
  ["havaianas",        "Havaianas",         "Sandals"],
  ["tory burch",       "Tory Burch",        "Flats"],
  ["kate spade",       "Kate Spade",        "Flats"],
  ["michael kors",     "Michael Kors",      "Heels"],
  [/\bmk\b/,           "Michael Kors",      "Heels"],
  ["nine west",        "Nine West",         "Heels"],
  ["steve madden",     "Steve Madden",      "Heels"],
  ["jessica simpson",  "Jessica Simpson",   "Heels"],
  ["aldo",             "ALDO",              "Heels"],
  // Generic style keywords (no brand) — used when caption lacks a brand name.
  ["stiletto",         null,                "Heels"],
  ["pump",             null,                "Heels"],
  ["high heel",        null,                "Heels"],
  ["heel",             null,                "Heels"],
  ["ballerina",        null,                "Flats"],
  ["ballet flat",      null,                "Flats"],
  ["flats",            null,                "Flats"],
  ["loafer",           null,                "Loafers"],
  ["mocassin",         null,                "Loafers"],
  ["moccasin",         null,                "Loafers"],
  ["sandal",           null,                "Sandals"],
  ["flip flop",        null,                "Sandals"],
  ["slide",            null,                "Sandals"],  // Panache umbrella: slides are sandals
  ["boot",             null,                "Boots"],
  ["sneaker",          null,                "Sneakers"],
  ["trainer",          null,                "Sneakers"],
  ["men's",            null,                "Men's Shoes"],
  ["mens ",            null,                "Men's Shoes"],
];

function deriveBrand(caption) {
  let text = (caption || "").toLowerCase().trim();
  text = text.replace(/^[a-z0-9._]+ /, "");  // strip leading "username "
  const padded = " " + text + " ";
  for (const [key, name, cat] of PANACHE_BRANDS) {
    if (key instanceof RegExp) {
      if (key.test(padded)) return [name, cat];
    } else if (padded.includes(key)) {
      return [name, cat];
    }
  }
  return [null, null];
}

// Pull a price out of a caption — ONLY when unambiguous (money marker / k suffix /
// price·bei·now), so auto-sync never puts a WRONG price on the live shop. Returns
// an integer KES amount, or 0 when no clear price is posted ("Price on request").
function parsePriceFromCaption(caption) {
  const text = (caption || "").replace(/\s+/g, " ").trim();
  if (!text) return 0;
  const cands = [];
  const push = (raw, mult, index) => {
    if (raw == null) return;
    const n = Math.round(parseFloat(String(raw).replace(/,/g, "")) * (mult || 1));
    if (Number.isFinite(n) && n >= 100 && n <= 1000000) cands.push({ n, index });
  };
  let m, re;
  re = /(?:ksh?s?|kes)\s*\.?\s*([\d,]+(?:\.\d+)?)\s*(k)?/gi;
  while ((m = re.exec(text))) push(m[1], m[2] ? 1000 : 1, m.index);
  re = /@\s*([\d,]+(?:\.\d+)?)\s*(k)?/gi;
  while ((m = re.exec(text))) push(m[1], m[2] ? 1000 : 1, m.index);
  re = /([\d,]+(?:\.\d+)?)\s*\/[=\-]/gi;
  while ((m = re.exec(text))) push(m[1], 1, m.index);
  re = /(?:price|bei|now|going for)\s*:?\s*(?:ksh?s?\s*)?([\d,]+(?:\.\d+)?)\s*(k)?/gi;
  while ((m = re.exec(text))) push(m[1], m[2] ? 1000 : 1, m.index);
  re = /(?:^|[^a-z0-9.])(\d{1,3}(?:\.\d+)?)\s*k\b/gi;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 6), m.index).toLowerCase();
    if (/siz|sz/.test(before)) continue;
    push(m[1], 1000, m.index);
  }
  if (!cands.length) return 0;
  cands.sort((a, b) => a.index - b.index);
  return cands[0].n;
}

// Build a public product description from an IG caption. Keep the descriptive
// text the owner wrote, but strip the parts that don't belong on the storefront:
// hashtags, the price (it has its own field — prices must NOT appear in the
// description), contact/CTA tails, and SOLD flags. Em/en dashes go to commas per
// the copy standard. Falls back to the canned line when nothing useful survives.
// Do NOT strip a leading word as an "IG handle" here — feed-API captions have no
// handle prefix, so that strip eats the first real product word.
const DEFAULT_DESC = "Quality footwear, photographed exactly as it is. Visit Piedmont Plaza, Ngong Road or order countrywide.";
function captionToDescription(caption) {
  let t = (caption || "").replace(/\r/g, "").trim();
  if (!t) return DEFAULT_DESC;
  t = t.split(/whastup|whatsapp|wa\.me|dm to order|dm to buy|inbox|order now|0\d{8,9}|\+?254\d{6,}/i)[0];
  t = t
    .replace(/#[^\s#]+/g, "")
    .replace(/\d[\d,]*(?:\.\d+)?\s*\/[=\-]/g, "")                      // 4500/= 4500/-
    .replace(/(?:ksh?s?\.?|kes)\s*\.?\s*\d[\d,]*(?:\.\d+)?\s*k?\b/gi, "") // Ksh 4500 / KES4500
    .replace(/@\s*\d[\d,]*(?:\.\d+)?\s*k?\b/gi, "")                    // @4500
    .replace(/\b(?:price|bei|now|going for)\s*:?\s*(?:ksh?s?\s*)?\d[\d,]*\s*k?\b/gi, "")
    .replace(/\s*\/[=\-]/g, "")                                        // orphan /= /-
    .replace(/\s*@(?!\w)/g, "")                                        // orphan @
    .replace(/\bsold(?:\s*out)?\b/gi, "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/[•|]+/g, " ")
    .replace(/\s+([.,!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s.,\-:;]+|[\s.,\-:;]+$/g, "")
    .trim();
  return t.length >= 8 ? t : DEFAULT_DESC;
}

function parseCaptionForBag(caption) {
  const text = (caption || "").trim();
  const lower = text.toLowerCase();
  let [brand, category] = deriveBrand(caption);
  // Name + description from the price-stripped caption, so no "@1750/=" ever
  // lands in the NAME (the fallback used to take the raw caption clause).
  const desc = captionToDescription(caption);
  const hasCaption = desc !== DEFAULT_DESC;
  let name, description;
  if (brand) {
    name = brand;
    description = hasCaption ? desc : DEFAULT_DESC;
  } else if (hasCaption) {
    // No brand — the descriptor is the name (first clause, Title Case); the rest
    // becomes the description, falling back to the canned line when there's none.
    const head = (desc.split(/[.!?\n]|,(?=\s)/)[0] || "").trim();
    name = (head || desc).slice(0, 70).replace(/\b\w/g, c => c.toUpperCase());
    const rest = desc.slice(head.length).replace(/^[\s.,!?]+/, "").trim();
    description = rest.length >= 10 ? rest : DEFAULT_DESC;
    category = category || "Heels";
  } else {
    name = "New Pair";
    description = DEFAULT_DESC;
    category = category || "Heels";
  }
  // Panache uses stock: {EU_size_string: qty} — matching admin's schema. Sizes
  // 35-46 covers women's footwear and the rare men's listings.
  const stock = {};

  // Multi-size patterns first: "sizes 36, 37, 38" / "EU 36/37/38".
  const multi = lower.match(/sizes?\s+([\d,\s\/\-]+)/);
  if (multi) {
    multi[1].split(/[,\s\/]+/).forEach(part => {
      const m = part.match(/(\d{2})/);
      if (m) {
        const n = +m[1];
        if (n >= 35 && n <= 46) stock[String(n)] = 1;
      }
    });
  }
  // Hyphen ranges like "36-40" → expand to each size in range.
  const range = lower.match(/(\d{2})\s*[-–to]+\s*(\d{2})/);
  if (range && !Object.keys(stock).length) {
    const a = +range[1], b = +range[2];
    if (a >= 35 && b <= 46 && b - a < 12) {
      for (let n = a; n <= b; n++) stock[String(n)] = 1;
    }
  }
  // Single "#38", "EU 38", "Size 38", "38eu" patterns — only if multi missed.
  if (!Object.keys(stock).length) {
    const singles = lower.match(/(?:#|eu\s*|size\s*)(\d{2})|(\d{2})\s*eu\b/g) || [];
    singles.forEach(s => {
      const m = s.match(/(\d{2})/);
      if (m) {
        const n = +m[1];
        if (n >= 35 && n <= 46) stock[String(n)] = 1;
      }
    });
  }
  if (!Object.keys(stock).length) stock["One Size"] = 1;
  return {
    name: name || "New Pair",
    category: category || "Heels",
    stock,
    price: parsePriceFromCaption(caption),
    description,
  };
}

function looksLikeProduct(caption) {
  if (!caption) return false;
  const lower = caption.toLowerCase();
  if (/#\s*\d{2}|\beu\s*\d{2}|\bsize\s+\d|\d{2}\s*eu\b|sizes?\s+\d{2}/.test(lower)) return true;
  for (const [key] of PANACHE_BRANDS) {
    if (key instanceof RegExp ? key.test(lower) : lower.includes(key)) return true;
  }
  return false;
}

// Coerce model categories to Panache's allowed vocabulary. Silvarkicks-style
// suggestions (Slides, Crossbody, Tshirt, etc.) shouldn't survive — Panache
// is footwear only. Slides collapse into Sandals.
const PANACHE_CATEGORIES_SET = new Set(["Heels", "Flats", "Sandals", "Boots", "Sneakers", "Loafers", "Men's Shoes"]);
function coercePanacheCategory(c) {
  if (!c) return null;
  const t = String(c).trim();
  if (PANACHE_CATEGORIES_SET.has(t)) return t;
  if (/^slides?$/i.test(t)) return "Sandals";
  if (/^(stilettos?|pumps?|high\s*heels?)$/i.test(t)) return "Heels";
  if (/^ballerinas?$/i.test(t)) return "Flats";
  if (/^(oxfords?|brogues?|derbys?|formal)$/i.test(t)) return "Men's Shoes";
  if (/^sports?\/?athletic$/i.test(t)) return "Sneakers";
  if (/^trainers?$/i.test(t)) return "Sneakers";
  if (/^moccasins?$|^mocassins?$/i.test(t)) return "Loafers";
  // Anything we can't safely map (Crossbody, Tote, Tshirt, Other) → null so the
  // admin's category dropdown falls back to the heuristic suggestion.
  return null;
}

function arrayToB64(buf) {
  let s = "";
  const CHUNK = 8192;
  for (let i = 0; i < buf.length; i += CHUNK) {
    s += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

// Vision-model classifier — Llama 3.2 11B Vision (Workers AI free tier) looks
// at the actual photo + caption. Returns { is_shoe, name, category, reason } or
// { _debug } on failure.
async function classifyPostWithVision(env, caption, imageUrl) {
  if (!env.AI || !imageUrl) return null;
  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return { _debug: `img fetch ${imgRes.status}` };
    const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
    const trimmed = (caption || "").replace(/\s+/g, " ").slice(0, 400);
    const prompt = `You sort Instagram posts from The Panache, a Nairobi women's footwear shop (with a small men's section). You're given ONE photo + ONE caption. Decide:
1. Is this a single pair of shoes for sale? (is_shoe true|false)
2. What brand/model? (name — short, e.g. "ALDO Pillow Walk Heel", "Steve Madden Sandals", or "New Pair" if unknown)
3. What category? Pick EXACTLY one from this list:
   Heels, Flats, Sandals, Boots, Sneakers, Loafers, Men's Shoes
NEVER use Slides, Crossbody, Tote, Tshirts, or any other category — Panache only stocks women's footwear and men's shoes. Slides collapse into Sandals.

Category guide:
- Heels: visible heel >2 inches, dress shoe shape, stiletto, pump, kitten heel, block heel.
- Flats: low or no heel, ballet flat, pointed flat, pump without heel, espadrille without wedge.
- Sandals: open-toe with straps OR slip-on slides/flip-flops/pool slides — anything strappy or open-toe.
- Boots: ankle-high or taller — ankle boots, chelsea boots, knee boots, combat boots.
- Sneakers: athletic or casual lace-up, trainer, runner, basketball-style.
- Loafers: slip-on dress shoe, penny loafer, mocassin, driving shoe.
- Men's Shoes: visibly masculine cut (men's oxfords, men's sneakers, men's loafers, men's boots).

is_shoe=false ONLY for: shop intros, banners, owner photos, marketing slides, sale announcements without a specific pair. Posts with a size signal (#38, EU 39, size 40, sizes 36-40) are ALWAYS shoes.

Caption: """${trimmed}"""

Reply with strict minified JSON, no prose, no code fences:
{"is_shoe":true|false,"name":"<brand+model or New Pair>","category":"<one from the list>","reason":"<3-6 words>"}`;
    const result = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
      prompt,
      image: Array.from(imgBytes),
      max_tokens: 200,
      temperature: 0.1,
    });
    // Vision response shape varies by Workers AI build. Sometimes already a
    // parsed object, sometimes a JSON string.
    let parsed = null;
    if (result?.response && typeof result.response === "object") {
      parsed = result.response;
    } else {
      let text = "";
      if (typeof result?.response === "string") text = result.response;
      else if (typeof result?.description === "string") text = result.description;
      else if (typeof result === "string") text = result;
      text = text.trim();
      if (text) {
        const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (m) {
          try { parsed = JSON.parse(m[0]); } catch (_) {}
        }
      }
    }
    if (!parsed) return { _debug: "could not parse vision output", raw: JSON.stringify(result).slice(0, 400) };
    return {
      is_shoe: !!parsed.is_shoe,
      name: parsed.name || null,
      category: parsed.category || null,
      reason: parsed.reason || "",
      via: "vision",
    };
  } catch (err) {
    return { _debug: `vision throw: ${err.message}` };
  }
}

// Text-only LLM classifier — fallback when the vision call fails or to give a
// second signal for name (text decodes brand shorthand better than vision).
async function classifyPostWithAi(env, caption) {
  if (!env.AI || !caption) return null;
  const trimmed = caption.replace(/\s+/g, " ").slice(0, 400);
  const prompt = `You sort Instagram posts from The Panache, a Nairobi women's footwear shop. Each post is either ONE specific pair of shoes for sale, OR a non-product post. Reply with strict minified JSON only, no prose, no code fences.

Schema:
{"is_shoe": true|false, "name": "<short brand + model OR generic descriptor>", "category": "<one of: Heels, Flats, Sandals, Boots, Sneakers, Loafers, Men's Shoes>", "reason": "<3-6 words>"}

NEVER output "Slides", "Crossbody", "Tote", "Tshirts" or any other category — Panache only stocks women's footwear and men's shoes. Map slides → Sandals.

Rules:
- The shop posts a SINGLE pair per listing. Captions are short, often a brand or style + sizes.
- is_shoe = true whenever there is a size signal (EU/#/size followed by a number 35-46, or "sizes 36-40"). Even if no brand is named, the post is a shoe. Use "New Pair" as the name in that case.
- is_shoe = false ONLY for: shop intros, owner photos, marketing banners, anything with no specific pair and no size.
- Brand hints: ALDO/Steve Madden/Nine West/Jessica Simpson/Michael Kors → Heels by default; Cole Haan/Clarks → Loafers; Birkenstock/Havaianas → Sandals; Tory Burch/Kate Spade → Flats; Nike/Adidas/Puma/Converse/Vans/New Balance → Sneakers; Timberland/Dr Martens/UGG → Boots.
- name should be brand + model when known (e.g. "ALDO Kitten Heels", "Steve Madden Black Sandals"). Strip sizes and phone numbers. Unknown brand + size → "New Pair".
- category must match the model. When the caption says "men's" or "for men", category = "Men's Shoes".

Caption: """${trimmed}"""`;
  try {
    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 120,
    });
    const text = (result?.response || "").trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    return {
      is_shoe: !!parsed.is_shoe,
      name: parsed.name || null,
      category: parsed.category || null,
      reason: parsed.reason || "",
    };
  } catch (_) {
    return null;
  }
}

// IG response normalisers — kept module-level so /api/ig-feed + /api/ig-discover
// can mix sources without going via HTTP (Workers can't fetch their own URL).
function extractFromTimelineNode(node) {
  const shortcode = node.shortcode || node.code;
  let imageUrls = [];
  const children = node.edge_sidecar_to_children?.edges || [];
  if (children.length) {
    imageUrls = children.map(({ node: c }) => c.display_url || c.image_versions2?.candidates?.[0]?.url).filter(Boolean);
  } else if (node.display_url) {
    imageUrls = [node.display_url];
  } else if (node.image_versions2?.candidates?.length) {
    imageUrls = [node.image_versions2.candidates[0].url];
  }
  const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || node.caption?.text || "";
  return {
    shortcode,
    imageUrl: imageUrls[0],
    imageUrls,
    caption,
    isCarousel: imageUrls.length > 1,
    postUrl: `https://www.instagram.com/p/${shortcode}/`,
    takenAt: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : (node.taken_at ? new Date(node.taken_at * 1000).toISOString() : null),
  };
}

function extractFromFeedItem(m) {
  const carousel = m.carousel_media || [];
  let imageUrls = [];
  if (carousel.length) {
    imageUrls = carousel.map(c => c.image_versions2?.candidates?.[0]?.url).filter(Boolean);
  } else if (m.image_versions2?.candidates?.length) {
    imageUrls = [m.image_versions2.candidates[0].url];
  }
  const shortcode = m.code;
  const caption = m.caption?.text || "";
  return {
    shortcode,
    imageUrl: imageUrls[0],
    imageUrls,
    caption,
    isCarousel: imageUrls.length > 1,
    postUrl: `https://www.instagram.com/p/${shortcode}/`,
    takenAt: m.taken_at ? new Date(m.taken_at * 1000).toISOString() : null,
  };
}

// 3-tier feed fetch — embedded timeline, then GraphQL, then /api/v1/feed/user/.
async function fetchIgFeed({ username, userId: directUserId, count = 50, maxId = "" } = {}) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1",
    "X-IG-App-ID": "936619743392459",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": `https://www.instagram.com/${username || ""}/`,
  };
  let userId, user = null, profile = null;
  if (directUserId) {
    userId = directUserId;
    profile = { id: userId, username: username || null };
  } else {
    const pRes = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, { headers });
    if (!pRes.ok) return { error: `profile lookup ${pRes.status}` };
    const pData = await pRes.json();
    user = pData?.data?.user;
    if (!user?.id) return { error: "user id not found" };
    userId = user.id;
    profile = {
      id: userId,
      username: user.username,
      fullName: user.full_name,
      biography: user.biography,
      profilePicUrl: user.profile_pic_url_hd || user.profile_pic_url,
      followers: user.edge_followed_by?.count,
    };
  }
  const qsTail = `?count=${count}${maxId ? `&max_id=${encodeURIComponent(maxId)}` : ""}`;
  let items = [];
  let moreAvailable = false;
  let nextMaxId = null;
  const embedded = user?.edge_owner_to_timeline_media;
  if (!maxId && embedded?.edges?.length) {
    items = embedded.edges.map(({ node }) => extractFromTimelineNode(node)).filter(it => it.imageUrl);
    moreAvailable = !!embedded.page_info?.has_next_page;
    nextMaxId = embedded.page_info?.end_cursor || null;
  }
  if (items.length < count && (maxId || moreAvailable || directUserId)) {
    const cursor = maxId || nextMaxId;
    const variables = encodeURIComponent(JSON.stringify({ id: userId, first: count, after: cursor || null }));
    const gqlRes = await fetch(`https://www.instagram.com/graphql/query/?query_hash=003056d32c2554def87228bc3fd9668a&variables=${variables}`, { headers });
    if (gqlRes.ok) {
      const gData = await gqlRes.json();
      const media = gData?.data?.user?.edge_owner_to_timeline_media;
      if (media?.edges?.length) {
        items = items.concat(media.edges.map(({ node }) => extractFromTimelineNode(node)).filter(it => it.imageUrl));
        moreAvailable = !!media.page_info?.has_next_page;
        nextMaxId = media.page_info?.end_cursor || null;
      }
    }
  }
  if (!items.length) {
    let fRes = await fetch(`https://www.instagram.com/api/v1/feed/user/${userId}/${qsTail}`, { headers });
    if (!fRes.ok) fRes = await fetch(`https://i.instagram.com/api/v1/feed/user/${userId}/${qsTail}`, { headers });
    if (!fRes.ok) return { error: `feed fetch ${fRes.status}`, profile };
    const fData = await fRes.json();
    items = (fData.items || []).map(extractFromFeedItem).filter(it => it.imageUrl);
    moreAvailable = !!fData.more_available;
    nextMaxId = fData.next_max_id || null;
  }
  return { profile, items, count: items.length, more_available: moreAvailable, next_max_id: nextMaxId };
}

async function getData(env) {
  const raw = await env.ITEMS.get("data");
  if (!raw) return { items: [], settings: {} };
  try { return JSON.parse(raw); } catch { return { items: [], settings: {} }; }
}

async function putData(env, data) {
  await env.ITEMS.put("data", JSON.stringify(data));
}

// ---- IG auto-sync (cron) ----------------------------------------------------
// Same discover→classify→commit pipeline as the admin widget, minus the human
// review. Panache stores images as inline base64 data URLs (no KV image host),
// so the worker fetches the cover, base64-encodes it, and inlines it on the item.
// Panache's fleet stagger offset is :30 (Iman :00, Ryker :10, ThriftLux :20).
const IG_AUTOSYNC_USER_ID = "5474622302"; // @thepanachekenya
const AUTOSYNC_MAX_ITEMS = 20;
async function runIgAutoSync(env) {
  if ((await env.ITEMS.get("suspended")) === "1") return { ok: false, skipped: "suspended" };
  let cfg;
  try { cfg = JSON.parse(await env.ITEMS.get("autosync")) || {}; } catch { cfg = {}; }
  if (cfg.enabled === false) return { ok: false, skipped: "disabled" };

  const data = await getData(env);
  if (!Array.isArray(data.items)) data.items = [];
  const existingIds = new Set(data.items.map(i => i.id));
  const existingPostUrls = new Set(data.items.map(i => i.postUrl).filter(Boolean));
  // Permanent "already pulled" ledger — the tombstone the in-catalog check can't
  // be. A shortcode here is never auto-added again, even after the owner deletes it.
  const ledgerRaw = await env.ITEMS.get("ig_synced_codes");
  const syncedCodes = new Set(ledgerRaw ? JSON.parse(ledgerRaw) : []);

  const feed = await fetchIgFeed({ userId: IG_AUTOSYNC_USER_ID, count: 24 });
  if (!feed.items) return { ok: false, error: feed.error || "feed empty" };

  const fresh = feed.items.filter(it =>
    it.imageUrl && it.shortcode &&
    !existingIds.has(`ig_${it.shortcode}`) &&
    !syncedCodes.has(it.shortcode) &&
    !existingPostUrls.has(`https://www.instagram.com/p/${it.shortcode}/`)
  ).slice(0, AUTOSYNC_MAX_ITEMS + 3);

  const newItems = [];
  const skipped = [];
  for (const it of fresh) {
    if (newItems.length >= AUTOSYNC_MAX_ITEMS) break;
    const heuristic = looksLikeProduct(it.caption);
    const [vision, text] = await Promise.all([
      classifyPostWithVision(env, it.caption, it.imageUrl),
      classifyPostWithAi(env, it.caption),
    ]);
    const visionOk = vision && !vision._debug;
    const isShoe = heuristic || (visionOk && vision.is_shoe) || (text && text.is_shoe);
    if (!isShoe) { skipped.push({ shortcode: it.shortcode, reason: "not a shoe" }); continue; }

    const sug = parseCaptionForBag(it.caption);
    const looksLikeFragment = (n) => !n || /^(size|tn|hh|js\d+|nb)$/i.test(String(n).trim());
    let name = sug.name;
    if (text?.is_shoe && !looksLikeFragment(text.name) && text.name !== "New Pair") name = text.name.trim();
    else if (visionOk && vision.is_shoe && !looksLikeFragment(vision.name) && vision.name !== "New Pair") name = vision.name.trim();
    let category = sug.category;
    if (visionOk && vision.is_shoe && vision.category) { const c = coercePanacheCategory(vision.category); if (c) category = c; }
    else if (text?.is_shoe && text.category) { const c = coercePanacheCategory(text.category); if (c) category = c; }
    if (!PANACHE_CATEGORIES_SET.has(category)) category = "Heels";

    try {
      const r = await fetch(it.imageUrl);
      if (!r.ok) throw new Error(`image fetch ${r.status}`);
      const b64 = arrayToB64(new Uint8Array(await r.arrayBuffer()));
      const stock = Object.keys(sug.stock || {}).length ? sug.stock : { "One Size": 1 };
      newItems.push({
        id: `ig_${it.shortcode}`,
        name: (name || "New Pair").slice(0, 80),
        category,
        description: sug.description,
        price: sug.price || 0, // parsed from caption; 0 (blank) only when no price posted
        stock,
        sales: [],
        image: `data:image/jpeg;base64,${b64}`,
        postUrl: `https://www.instagram.com/p/${it.shortcode}/`,
        createdAt: it.takenAt || new Date().toISOString(),
        autoSynced: true,
      });
    } catch (e) {
      skipped.push({ shortcode: it.shortcode, reason: e.message });
    }
  }

  if (newItems.length) {
    data.items = newItems.concat(data.items);
    await putData(env, data);
    for (const i of newItems) syncedCodes.add(i.id.slice(3));
    await env.ITEMS.put("ig_synced_codes", JSON.stringify([...syncedCodes]));
  }
  return { ok: true, added: newItems.length, names: newItems.map(i => i.name), skipped };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runIgAutoSync(env));
  },
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    // Health
    if (path === "/api/health") return json({ ok: true, time: new Date().toISOString() });

    // --- Share page: HTML with OpenGraph tags so WhatsApp / FB / iMessage
    //     render a rich preview (shoe photo + name) when someone shares an
    //     enquiry link. WhatsApp's crawler will NOT preview a bare image URL —
    //     it needs an HTML page with og:image. Served from the worker domain
    //     (NOT the catalog zone) so the *.pages.dev custom domain's bot
    //     protection can't 403 facebookexternalhit. Humans get redirected
    //     straight to the catalogue. Reference pattern: thriftlux worker.
    {
      const shareMatch = path.match(/^\/share\/([^/]+)$/);
      if (request.method === "GET" && shareMatch) {
        const id = decodeURIComponent(shareMatch[1]);
        const catalog = "https://thepanache.essenceautomations.com/";
        const raw = await env.ITEMS.get("data");
        const data = raw ? JSON.parse(raw) : { items: [] };
        const item = (data.items || []).find((i) => i.id === id);
        if (!item) return Response.redirect(catalog, 302);
        const esc = (s) => String(s == null ? "" : s)
          .replace(/&/g, "&amp;").replace(/</g, "&lt;")
          .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        // Image must be an absolute https URL on a domain that returns 200
        // directly. Item images are stored as relative `images/items/<id>.jpg`,
        // so prepend the catalog Pages domain.
        let img = item.image || "";
        if (img && !/^https?:\/\//i.test(img)) img = `${catalog}${img.replace(/^\/+/, "")}`;
        const priceTxt = item.price > 0 ? ` · Ksh ${Number(item.price).toLocaleString("en-KE")}` : "";
        const desc = (item.description || `Authentic ALDO shoes at The Panache Store, Nairobi.`).slice(0, 200);
        const html = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(item.name)} · The Panache Store</title>
<meta property="og:type" content="product">
<meta property="og:title" content="${esc(item.name)}${esc(priceTxt)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:secure_url" content="${esc(img)}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1080">
<meta property="og:image:height" content="1080">
<meta property="og:image:alt" content="${esc(item.name)}">
<meta property="og:url" content="${catalog}">
<meta property="og:site_name" content="The Panache Store">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(item.name)}${esc(priceTxt)}">
<meta name="twitter:image" content="${esc(img)}">
<meta http-equiv="refresh" content="0; url=${catalog}">
</head><body style="font-family:system-ui,sans-serif;background:#1a0d2e;color:#f5e9c8;text-align:center;padding:60px 20px;">
<p>Opening The Panache Store…</p>
<p><a href="${catalog}" style="color:#d4af37;">Tap here if you're not redirected</a></p>
<script>location.replace(${JSON.stringify(catalog)});</script>
</body></html>`;
        return new Response(html, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300", ...CORS },
        });
      }
    }

    // GET /api/items — public
    if (request.method === "GET" && path === "/api/items") {
      const data = await getData(env);
      // Billing kill-switch: stored in its own KV key so the owner's admin
      // publishes (which only write "data") can never clear it.
      data.suspended = (await env.ITEMS.get("suspended")) === "1";
      // PRIVACY: strip buyer PII (sales[].buyerName/buyerPhone/notes, soldTo) for
      // unauthed callers. The storefront only reads sold/price/salePrice/sales.length,
      // never buyer details. The admin sends a Bearer token and gets the full data.
      const admin = authed(request, env);
      if (!admin && Array.isArray(data.items)) {
        data.items = data.items.map(b => {
          if (!b || typeof b !== "object") return b;
          let nb = b;
          if ("soldTo" in nb) { const { soldTo, ...r } = nb; nb = r; }
          if (Array.isArray(nb.sales)) nb = { ...nb, sales: nb.sales.map(s => {
            if (!s || typeof s !== "object") return s;
            const { buyerName, buyerPhone, notes, name, phone, buyer, ...keep } = s;
            return keep;
          }) };
          return nb;
        });
      }
      // The manually-added clients list is owner-only CRM PII — never public.
      if (!admin && data.clients) delete data.clients;
      return json(data, 200, admin ? { "Cache-Control": "no-store" } : { "Cache-Control": "public, max-age=10" });
    }

    // Billing only: flip the suspend flag. Authed by MASTER_TOKEN (not the shop admin token).
    if (request.method === "POST" && path === "/api/suspend") {
      if (!isMaster(request, env)) return json({ error: "unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const suspended = !!body.suspended;
      await env.ITEMS.put("suspended", suspended ? "1" : "0");
      return json({ ok: true, suspended });
    }

    // ---- Insights: site-wide event tracking (aggregated in KV) ----
    // Public visitors POST events here; the admin reads the aggregate back.
    // Sums every visitor on every device into one shared "stats" tally.
    const TRACK_METRICS = new Set(["itemViews", "itemEnquiries", "itemWishlist", "itemIgClicks", "searchNoResults"]);
    if (request.method === "POST" && path === "/api/track") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const metric = String(body.metric || "");
      const key = String(body.key || "").slice(0, 80).trim();
      if (!TRACK_METRICS.has(metric) || !key) return json({ error: "bad metric/key" }, 400);
      let stats;
      try { stats = JSON.parse(await env.ITEMS.get("stats")) || {}; } catch { stats = {}; }
      stats[metric] = stats[metric] || {};
      if (metric === "searchNoResults" && !(key in stats[metric]) && Object.keys(stats[metric]).length >= 800) {
        return json({ ok: true, capped: true });
      }
      stats[metric][key] = (stats[metric][key] || 0) + 1;
      stats._lastUpdated = new Date().toISOString();
      await env.ITEMS.put("stats", JSON.stringify(stats));
      return json({ ok: true });
    }

    if (request.method === "GET" && path === "/api/insights") {
      if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
      let stats;
      try { stats = JSON.parse(await env.ITEMS.get("stats")) || {}; } catch { stats = {}; }
      return json(stats);
    }

    if (request.method === "POST" && path === "/api/insights-reset") {
      if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
      const blocked = await suspendBlock(request, env); if (blocked) return blocked;
      await env.ITEMS.put("stats", JSON.stringify({ _lastUpdated: new Date().toISOString() }));
      return json({ ok: true });
    }

    // POST /api/bulk — replace entire catalog
    if (request.method === "POST" && path === "/api/bulk") {
      if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
      const blocked = await suspendBlock(request, env); if (blocked) return blocked;
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      if (!Array.isArray(body.items)) return json({ error: "items must be an array" }, 400);
      const payload = { items: body.items, settings: body.settings || {} };
      if (Array.isArray(body.clients)) payload.clients = body.clients;
      await putData(env, payload);
      // Tombstone every IG-sourced item in this save so the auto-sync cron can't
      // re-add one the owner later deletes (Panache's manual sync commits here).
      try {
        const codes = body.items.filter(i => i && typeof i.id === "string" && i.id.startsWith("ig_")).map(i => i.id.slice(3));
        if (codes.length) {
          const led = new Set(JSON.parse((await env.ITEMS.get("ig_synced_codes")) || "[]"));
          let changed = false;
          for (const c of codes) if (!led.has(c)) { led.add(c); changed = true; }
          if (changed) await env.ITEMS.put("ig_synced_codes", JSON.stringify([...led]));
        }
      } catch (_) {}
      return json({ ok: true, count: body.items.length });
    }

    // Admin/agency: run the IG auto-sync on demand (same code the cron runs).
    if (request.method === "POST" && path === "/api/autosync-run") {
      if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
      const res = await runIgAutoSync(env);
      return json(res);
    }

    // POST /api/items — create
    if (request.method === "POST" && path === "/api/items") {
      if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
      const blocked = await suspendBlock(request, env); if (blocked) return blocked;
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
        const blocked = await suspendBlock(request, env); if (blocked) return blocked;
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
        const blocked = await suspendBlock(request, env); if (blocked) return blocked;
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
    // Host allowlist: cdninstagram.com, fbcdn.net only.
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

    // ---- IG feed: server-side fetch of a profile's recent posts ----
    // Used at seed-time to backfill a new catalog. Public so seed scripts don't
    // need the admin token.
    if (request.method === "GET" && path === "/api/ig-feed") {
      const username = url.searchParams.get("username");
      const count = Math.min(parseInt(url.searchParams.get("count") || "50", 10), 100);
      const maxId = url.searchParams.get("max_id") || "";
      const directUserId = url.searchParams.get("user_id") || "";
      if (!username && !directUserId) return json({ error: "username or user_id required" }, 400);
      try {
        const result = await fetchIgFeed({ username, userId: directUserId, count, maxId });
        return json(result, result.error ? 502 : 200);
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // One-time CF Workers AI EULA accept. Llama 3.2 Vision returns
    // "5016: ... you must submit the prompt 'agree'" on the first call per
    // account. Hit this once with admin auth after first deploy.
    if (request.method === "GET" && path === "/api/ig-accept-license") {
      if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
      try {
        const r = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", { prompt: "agree", max_tokens: 8 });
        return json({ ok: true, response: r });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // Debug: classify a single IG shortcode through both vision + text models.
    // GET /api/ig-classify?shortcode=...&caption=... (caption optional, admin auth)
    if (request.method === "GET" && path === "/api/ig-classify") {
      if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
      const sc = url.searchParams.get("shortcode");
      const capOverride = url.searchParams.get("caption");
      if (!sc) return json({ error: "shortcode required" }, 400);
      try {
        const feed = await fetchIgFeed({ userId: "5474622302", count: 50 });
        const found = (feed.items || []).find(i => i.shortcode === sc);
        const imageUrl = found?.imageUrl || null;
        const caption = capOverride || found?.caption || "";
        const vision = await classifyPostWithVision(env, caption, imageUrl);
        const text = await classifyPostWithAi(env, caption);
        return json({ shortcode: sc, caption, imageUrl, vision, text_only: text });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // ---- IG sync: discover new candidates (admin-only preview) ----
    // GET /api/ig-discover?user_id=...&limit=20
    //
    // PANACHE NOTE: dedup happens CLIENT-SIDE against localStorage `items[]`,
    // not server-side against KV. The admin's working items[] is typically
    // ahead of whatever's in KV (admin uses localStorage as source of truth and
    // syncs to data.json periodically). So this endpoint just returns the
    // latest N candidates from IG with AI-suggested name/category/stock — the
    // admin filters out anything already in its local items[] before rendering.
    if (request.method === "GET" && path === "/api/ig-discover") {
      if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
      const username = url.searchParams.get("username");
      const directUserId = url.searchParams.get("user_id");
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 50);
      if (!username && !directUserId) return json({ error: "username or user_id required" }, 400);

      try {
        const feedData = await fetchIgFeed({ username, userId: directUserId, count: 50 });
        if (!feedData.items) return json({ error: feedData.error || "feed empty" }, 502);

        // Classification pipeline (per candidate, in parallel):
        //   1. Heuristic (regex/brand keywords). Liberal, fast, free.
        //   2. Vision model — actually sees the photo (best for category).
        //   3. Text-only LLM — best for decoding brand shorthand from caption.
        //   4. Final is_shoe = heuristic OR vision.is_shoe OR text.is_shoe.
        //   5. Name prefers text answer, then vision, then heuristic.
        //   6. Category prefers vision (it saw the photo), then text, then heuristic.
        //   7. All categories pass through coercePanacheCategory() so we never
        //      ship hallucinated buckets to the admin dropdown.
        const slice = feedData.items.slice(0, limit * 2);
        const classified = await Promise.all(slice.map(async (it) => {
          const heuristic = looksLikeProduct(it.caption);
          const [vision, text] = await Promise.all([
            classifyPostWithVision(env, it.caption, it.imageUrl),
            classifyPostWithAi(env, it.caption),
          ]);
          const visionOk = vision && !vision._debug;
          const isShoe = heuristic || (visionOk && vision.is_shoe) || (text && text.is_shoe);
          if (!isShoe) return null;
          const heuristicSuggestion = parseCaptionForBag(it.caption);

          // Name fallback chain.
          const looksLikeFragment = (n) => !n || /^(size|tn|hh|js\d+|nb)$/i.test(n.trim());
          let name = heuristicSuggestion.name;
          if (text?.is_shoe && !looksLikeFragment(text.name) && text.name !== "New Pair") {
            name = text.name.trim();
          } else if (visionOk && vision.is_shoe && !looksLikeFragment(vision.name) && vision.name !== "New Pair") {
            name = vision.name.trim();
          } else if (visionOk && vision.is_shoe && vision.name === "New Pair") {
            name = "New Pair";
          }

          // Category fallback chain — coerce everything through the Panache
          // vocabulary before returning.
          let category = heuristicSuggestion.category;
          if (visionOk && vision.is_shoe && vision.category) {
            const c = coercePanacheCategory(vision.category);
            if (c) category = c;
          } else if (text?.is_shoe && text.category) {
            const c = coercePanacheCategory(text.category);
            if (c) category = c;
          }
          if (!PANACHE_CATEGORIES_SET.has(category)) category = "Heels"; // last-resort default

          const reason = visionOk ? vision.reason : (text?.reason || (heuristic ? "matched product heuristic" : ""));
          let classifier = "heuristic";
          if (visionOk && text) classifier = "vision+text";
          else if (visionOk) classifier = "vision";
          else if (text) classifier = "text";

          return {
            ...it,
            suggested: {
              name,
              category,
              stock: heuristicSuggestion.stock,
              price: heuristicSuggestion.price,
              description: heuristicSuggestion.description,
            },
            ai_reason: reason,
            classifier,
          };
        }));
        const candidates = classified.filter(Boolean).slice(0, limit);

        return json({
          count: candidates.length,
          scanned: slice.length,
          items: candidates,
          profile: feedData.profile,
          ai_enabled: !!env.AI,
        });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    return json({ error: "not found" }, 404);
  },
};
