// The Panache Store — Admin
const ADMIN_PASSWORD = 'panache123';
const STORAGE_KEY = 'panache_data';
const INSIGHTS_KEY = 'panache_insights';
const ALL_EU_SIZES = ['35','36','37','38','39','40','41','42','43','44','45'];

let items = [];
let settings = {};
let clients = []; // manually-added clients (server-synced); sale buyers derived from sales[]
let accountSuspended = false;
const SUSPENDED_MSG = 'Your store is offline. Contact Essence Automations to restore it before making changes.';
let editingId = null;
let stagedImage = null; // { base64, ext, dataUrl }
let stagedExtras = [];
let pendingSaleId = null;
let pendingRestockId = null;

// ====== AUTH ======
const loginScreen = document.getElementById('loginScreen');
const dashboard = document.getElementById('dashboard');
const loginBtn = document.getElementById('loginBtn');
const loginPassword = document.getElementById('loginPassword');
const loginError = document.getElementById('loginError');

function checkAuth() {
  if (sessionStorage.getItem('panache_auth') === '1') {
    loginScreen.style.display = 'none';
    dashboard.style.display = 'block';
    init();
  }
}
loginBtn.addEventListener('click', login);
loginPassword.addEventListener('keypress', e => { if (e.key === 'Enter') login(); });

function login() {
  if (loginPassword.value === ADMIN_PASSWORD) {
    sessionStorage.setItem('panache_auth', '1');
    loginError.style.display = 'none';
    checkAuth();
  } else {
    loginError.style.display = 'block';
  }
}

document.getElementById('logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem('panache_auth');
  location.reload();
});

// ====== DATA ======
function migrateItem(item) {
  if (!item.sales) item.sales = [];
  if (!item.stock) {
    // Convert old sizes string to stock object
    const sizeStrs = (item.sizes || '').split(',').map(s => s.trim()).filter(Boolean);
    item.stock = {};
    if (!item.sold && sizeStrs.length) {
      sizeStrs.forEach(s => { item.stock[s] = 1; });
    }
    // If sold under old model, create a legacy sale record
    if (item.sold && item.soldAt && item.sales.length === 0) {
      item.sales.push({
        size: sizeStrs[0] || 'Legacy',
        qty: 1,
        salePrice: item.price,
        buyerName: item.soldTo || '',
        buyerPhone: '',
        notes: '',
        soldAt: item.soldAt,
      });
    }
  }
  return item;
}

// Keep item.sizes and item.sold in sync with item.stock so main.js still works
function syncLegacyFields(item) {
  const availSizes = Object.entries(item.stock || {}).filter(([, q]) => Number(q) > 0).map(([sz]) => sz);
  item.sizes = availSizes.join(',');
  item.sold = availSizes.length === 0;
  if (item.sold && !item.soldAt) item.soldAt = new Date().toISOString();
  else if (!item.sold) item.soldAt = null;
}

async function loadData() {
  // Bootstrap apiBase from the local cache or committed seed so we know which
  // worker to talk to, then load the AUTHORITATIVE copy from the server (KV).
  let boot = null;
  const local = localStorage.getItem(STORAGE_KEY);
  if (local) { try { boot = JSON.parse(local); } catch (e) {} }
  if (!boot) { try { boot = await (await fetch('data.json')).json(); } catch (e) {} }
  boot = boot || {};
  settings = boot.settings || {};
  items = (boot.items || []).map(migrateItem);
  clients = Array.isArray(boot.clients) ? boot.clients : [];
  // Server is the source of truth (KV). Authed fetch so we also receive the
  // owner-only clients[]. Falls back to the bootstrap copy if the server is down.
  if (settings.apiBase) {
    try {
      const res = await fetch(`${settings.apiBase}/api/items?_=${Date.now()}`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
      if (res.ok) {
        const json = await res.json();
        items = (json.items || []).map(migrateItem);
        settings = json.settings || settings;
        clients = Array.isArray(json.clients) ? json.clients : [];
        accountSuspended = !!json.suspended;
        cacheLocal();
      }
    } catch (e) { console.error('Server load failed, using local copy', e); }
  }
}

function cacheLocal() {
  items.forEach(syncLegacyFields);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ items, settings, clients })); } catch (e) {}
}

// Save = cache locally (instant) + publish to the server (KV) so edits sync
// across devices and reach the public site. Best-effort publish; the local
// cache always holds the latest and a sync failure is surfaced to the owner.
function saveData() {
  cacheLocal();
  publishToServer();
}
async function publishToServer() {
  if (accountSuspended) throw new Error(SUSPENDED_MSG);
  if (!settings.apiBase) return;
  try {
    const res = await fetch(`${settings.apiBase}/api/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ items, settings, clients }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); showToast('Saved on device, but server sync failed: ' + (e.error || res.status)); }
  } catch (e) { showToast('Saved on device, but server sync failed (offline?).'); }
}

// Billing kill-switch — owner can't flip it (only the master token can), but
// the admin reads it so we can show the owner WHY the public site is offline.
// Panache's admin loads the catalog from localStorage/data.json, so the flag is
// fetched separately from the worker's /api/items.
async function loadSuspendedFlag() {
  if (!settings.apiBase) return;
  try {
    const res = await fetch(`${settings.apiBase}/api/items?_=${Date.now()}`);
    const json = await res.json();
    accountSuspended = !!json.suspended;
  } catch (e) {}
}

// Owner-facing notice when billing has suspended the store. The public site is
// dark; this tells the owner why and how to restore (they can't unflip it).
function renderSuspendedBanner() {
  let b = document.getElementById('suspendedBanner');
  if (!accountSuspended) { if (b) b.remove(); return; }
  if (!b) {
    b = document.createElement('div');
    b.id = 'suspendedBanner';
    b.style.cssText = 'position:sticky;top:0;z-index:9000;background:#b00020;color:#fff;padding:12px 16px;text-align:center;font-size:14px;font-weight:600;line-height:1.4;';
    document.body.prepend(b);
  }
  b.innerHTML = 'Your store is currently offline. Please contact Essence Automations to restore it. <a href="https://wa.me/254720615606" style="color:#fff;text-decoration:underline;">Message us</a>';
}

// ====== TOAST ======
const toast = document.getElementById('toast');
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}


// ====== IN-PAGE DIALOGS (webview-safe replacements for confirm()/prompt()) ======
// WhatsApp/Instagram in-app browsers silently suppress native confirm()/prompt()
// (confirm() returns false without showing), so destructive admin actions did
// nothing. These promise-based modals work everywhere.
function confirmAction(message, okLabel = 'Confirm') {
  return new Promise(resolve => {
    const modal = document.getElementById('confirmModal');
    const msgEl = document.getElementById('confirmModalMsg');
    const okBtn = document.getElementById('confirmModalOk');
    const cancelBtn = document.getElementById('confirmModalCancel');
    msgEl.textContent = message;
    okBtn.textContent = okLabel;
    modal.style.display = 'flex';
    const cleanup = result => {
      modal.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

function chooseCategory() {
  return new Promise(resolve => {
    const modal = document.getElementById('categoryModal');
    const sel = document.getElementById('categoryModalSelect');
    const newWrap = document.getElementById('categoryModalNewWrap');
    const newInput = document.getElementById('categoryModalNew');
    const okBtn = document.getElementById('categoryModalOk');
    const cancelBtn = document.getElementById('categoryModalCancel');
    const cats = [...new Set(items.map(b => b.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    sel.innerHTML = cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')
      + '<option value="__new__">+ New category…</option>';
    newWrap.style.display = 'none';
    newInput.value = '';
    modal.style.display = 'flex';
    const onSelChange = () => {
      const isNew = sel.value === '__new__';
      newWrap.style.display = isNew ? '' : 'none';
      if (isNew) newInput.focus();
    };
    const cleanup = result => {
      modal.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      sel.removeEventListener('change', onSelChange);
      resolve(result);
    };
    const onOk = () => cleanup((sel.value === '__new__' ? newInput.value.trim() : sel.value) || null);
    const onCancel = () => cleanup(null);
    sel.addEventListener('change', onSelChange);
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// ====== HELPERS ======
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtKsh(n) { return 'Ksh ' + Number(n || 0).toLocaleString('en-KE'); }

function totalStock(item) {
  if (!item.stock) return item.sold ? 0 : 1;
  return Object.values(item.stock).reduce((s, q) => s + (Number(q) || 0), 0);
}

function totalUnitsSold(item) {
  return (item.sales || []).reduce((s, r) => s + (Number(r.qty) || 1), 0);
}

function totalRevenue(item) {
  return (item.sales || []).reduce((s, r) => s + (Number(r.salePrice || item.price) * (Number(r.qty) || 1)), 0);
}

function relTime(iso) {
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (sec < 60) return 'just now';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  const days = Math.floor(sec / 86400);
  if (days === 1) return 'yesterday';
  if (days < 30) return days + 'd ago';
  return new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
}

// Best-effort "added to the website" timestamp: explicit createdAt, else the IG
// post date (takenAt; epoch-seconds or ISO), else the millis baked into a manual id.
// Returns an ISO string, or null if nothing usable.
function itemAddedAt(bag) {
  if (bag.createdAt) return bag.createdAt;
  if (bag.takenAt != null) {
    const t = bag.takenAt;
    if (typeof t === 'number') return new Date(t < 1e12 ? t * 1000 : t).toISOString();
    return t;
  }
  const m = String(bag.id || '').match(/_(\d{10,})/);
  return m ? new Date(parseInt(m[1], 10)).toISOString() : null;
}

// ====== IMAGES ======
const imageInput = document.getElementById('imageInput');
const costInput = document.getElementById('costInput');
const imagePreview = document.getElementById('imagePreview');

imageInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    stagedImage = { base64: dataUrl.split(',')[1], ext, dataUrl };
    imagePreview.innerHTML = `<img src="${dataUrl}" style="max-width:200px;border-radius:8px;margin-top:4px;">`;
  };
  reader.readAsDataURL(file);
});

const extraImagesInput = document.getElementById('extraImagesInput');
const extraImagesPreview = document.getElementById('extraImagesPreview');

function readFileAsStaged(file) {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      resolve({ base64: dataUrl.split(',')[1], ext, dataUrl });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

extraImagesInput?.addEventListener('change', async e => {
  const files = [...e.target.files];
  for (const f of files) {
    if (stagedExtras.length >= 8) break;
    try { stagedExtras.push(await readFileAsStaged(f)); } catch (_) {}
  }
  renderExtraImagesPreview();
  e.target.value = '';
});

function renderExtraImagesPreview() {
  if (!extraImagesPreview) return;
  if (!stagedExtras.length) { extraImagesPreview.innerHTML = ''; return; }
  extraImagesPreview.innerHTML = stagedExtras.map((s, i) => `
    <div class="extra-img-thumb">
      <img src="${s.dataUrl || s.url}" alt="">
      <button class="extra-img-remove" data-extra-remove="${i}" aria-label="Remove">×</button>
    </div>
  `).join('');
  extraImagesPreview.querySelectorAll('[data-extra-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      stagedExtras.splice(parseInt(btn.dataset.extraRemove, 10), 1);
      renderExtraImagesPreview();
    });
  });
}

// ====== IG QUICK-ADD ======
document.getElementById('igQuickBtn')?.addEventListener('click', async () => {
  const url = document.getElementById('igQuickInput').value.trim();
  const status = document.getElementById('igQuickStatus');
  if (accountSuspended) { status.textContent = SUSPENDED_MSG; status.className = 'ig-quick-status err'; return; }
  if (!url) { status.textContent = 'Paste an Instagram URL first.'; status.className = 'ig-quick-status err'; return; }
  if (!/instagram\.com\/(?:p|reel|tv)\//i.test(url)) { status.textContent = 'That doesn\'t look like an IG post URL.'; status.className = 'ig-quick-status err'; return; }

  const apiBase = settings.apiBase || '';
  if (!apiBase) {
    status.textContent = 'IG auto-fill requires a server-side API. Paste the image directly below instead.';
    status.className = 'ig-quick-status err';
    // Pre-fill the post URL field at least
    document.getElementById('postUrlInput').value = url;
    return;
  }

  status.textContent = 'Fetching from Instagram...';
  status.className = 'ig-quick-status';

  try {
    const r = await fetch(`${apiBase}/api/ig-fetch?url=${encodeURIComponent(url)}`);
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || 'Fetch failed');

    async function downloadAndStage(imgUrl) {
      // CORS-critical: IG CDN doesn't send Access-Control-Allow-Origin, so we
      // MUST route image fetches through the Worker's /api/ig-proxy. Direct
      // fetches of cdninstagram.com / fbcdn.net throw "Failed to fetch" in
      // the browser. Per CATALOG-STANDARDS "Instagram quick-add" rules.
      const proxied = `${apiBase}/api/ig-proxy?url=${encodeURIComponent(imgUrl)}`;
      const res = await fetch(proxied);
      if (!res.ok) throw new Error('Image download failed');
      const blob = await res.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          resolve({ base64: dataUrl.split(',')[1], ext: 'jpg', dataUrl });
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }

    stagedImage = await downloadAndStage(data.imageUrl);
    imagePreview.innerHTML = `<img src="${stagedImage.dataUrl}" style="max-width:200px;border-radius:8px;margin-top:4px;">`;

    stagedExtras = [];
    const extras = (data.imageUrls || []).slice(1);
    for (const u of extras) {
      try { stagedExtras.push(await downloadAndStage(u)); } catch (_) {}
    }
    renderExtraImagesPreview();

    // Keep the descriptive text but drop the price (it has its own field), contact
    // tail, hashtags and SOLD flag. Em/en dashes → commas (copy standard).
    const cap = (data.caption || '').replace(/^[a-z0-9._]+\s+/i, '').trim();
    const desc = cap
      .split(/whastup|whatsapp|wa\.me|dm to order|dm to buy|inbox|order now|0\d{8,9}|\+?254\d{6,}/i)[0]
      .replace(/#[^\s#]+/g, '')
      .replace(/\d[\d,]*(?:\.\d+)?\s*\/[=\-]/g, '')
      .replace(/(?:ksh?s?\.?|kes)\s*\.?\s*\d[\d,]*(?:\.\d+)?\s*k?\b/gi, '')
      .replace(/@\s*\d[\d,]*(?:\.\d+)?\s*k?\b/gi, '')
      .replace(/\s*\/[=\-]/g, '')
      .replace(/\s*@(?!\w)/g, '')
      .replace(/\bsold(?:\s*out)?\b/gi, '')
      .replace(/\s*[—–]\s*/g, ', ')
      .replace(/\s+([.,!?])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s.,\-:;]+|[\s.,\-:;]+$/g, '')
      .trim();
    document.getElementById('descInput').value = desc;
    if (!document.getElementById('nameInput').value && cap) {
      const firstLine = cap.split(/[.!?\n]/)[0].trim().slice(0, 60);
      document.getElementById('nameInput').value = firstLine.charAt(0).toUpperCase() + firstLine.slice(1);
    }
    document.getElementById('postUrlInput').value = data.postUrl || url;

    { const _me = document.getElementById('manualEntry'); if (_me) _me.open = true; }
    status.textContent = '✓ Image and caption loaded. Review the name, category, price and stock, then Save.';
    status.className = 'ig-quick-status ok';
  } catch (err) {
    status.textContent = '✗ ' + err.message + ' — paste the image directly below instead.';
    status.className = 'ig-quick-status err';
  }
});

// ====== STOCK FORM ======
function getStockFromForm() {
  const stock = {};
  // Fixed grid
  document.querySelectorAll('.stock-qty[data-size]').forEach(inp => {
    const size = inp.dataset.size;
    const val = parseInt(inp.value, 10);
    if (!isNaN(val) && val > 0) stock[size] = val;
  });
  // Custom rows
  document.querySelectorAll('.custom-size-row').forEach(row => {
    const sz = row.querySelector('.custom-size-name')?.value.trim();
    const val = parseInt(row.querySelector('.custom-size-qty')?.value, 10);
    if (sz && !isNaN(val) && val > 0) stock[sz] = val;
  });
  return stock;
}

function setStockToForm(stock) {
  // Fill fixed grid
  document.querySelectorAll('.stock-qty[data-size]').forEach(inp => {
    const size = inp.dataset.size;
    inp.value = (stock && stock[size] > 0) ? stock[size] : '';
  });
  // Auto-populate custom rows for any stock key not in the fixed grid
  const fixedSizes = new Set(ALL_EU_SIZES);
  Object.entries(stock || {})
    .filter(([sz, qty]) => !fixedSizes.has(sz) && qty > 0)
    .forEach(([sz, qty]) => addCustomSizeRow(sz, qty));
}

function clearStockForm() {
  document.querySelectorAll('.stock-qty').forEach(inp => { inp.value = ''; });
  // Clear custom rows
  const rows = document.getElementById('customSizeRows');
  const group = document.getElementById('customSizeGroup');
  if (rows) rows.innerHTML = '';
  if (group) group.style.display = 'none';
}

function addCustomSizeRow(sizeVal = '', qtyVal = '') {
  const group = document.getElementById('customSizeGroup');
  const rows = document.getElementById('customSizeRows');
  if (!rows || !group) return;
  group.style.display = '';
  const wrap = document.createElement('div');
  wrap.className = 'stock-entry-item custom-size-row';
  wrap.style.flexDirection = 'row';
  wrap.style.gap = '4px';
  wrap.style.alignItems = 'center';
  const nameInp = document.createElement('input');
  nameInp.type = 'text'; nameInp.placeholder = 'Size'; nameInp.value = sizeVal;
  nameInp.className = 'custom-size-name';
  nameInp.style.cssText = 'width:70px;padding:6px 8px;font-size:12px;border:1px solid var(--line);border-radius:6px;font-family:inherit;';
  const qtyInp = document.createElement('input');
  qtyInp.type = 'number'; qtyInp.min = '0'; qtyInp.step = '1'; qtyInp.value = qtyVal;
  qtyInp.className = 'custom-size-qty';
  qtyInp.style.cssText = 'width:54px;padding:6px;font-size:12px;border:1px solid var(--line);border-radius:6px;font-family:inherit;';
  const del = document.createElement('button');
  del.type = 'button'; del.textContent = '×'; del.title = 'Remove';
  del.style.cssText = 'border:none;background:none;font-size:18px;color:#b00020;cursor:pointer;line-height:1;padding:0 2px;';
  del.addEventListener('click', () => { wrap.remove(); if (!rows.children.length) group.style.display = 'none'; });
  wrap.append(nameInp, qtyInp, del);
  rows.appendChild(wrap);
}

document.getElementById('addCustomSizeBtn')?.addEventListener('click', () => addCustomSizeRow());

// ====== AI DESCRIPTION ======
document.getElementById('aiBtn').addEventListener('click', () => {
  const name = document.getElementById('nameInput').value.trim();
  const cat = getCategoryValue();
  if (!name) { showToast('Enter the item name first.'); return; }
  document.getElementById('descInput').value = generateDescription(name, cat);
});

function generateDescription(name, cat) {
  const lower = name.toLowerCase();
  const colors = { black: 'sleek black', white: 'crisp white', nude: 'neutral nude', beige: 'warm beige', brown: 'rich brown', pink: 'soft pink', red: 'bold red', gold: 'metallic gold', silver: 'metallic silver', tan: 'warm tan' };
  let color = '';
  for (const c in colors) if (lower.includes(c)) { color = colors[c]; break; }

  const catMap = {
    Heels: 'heels', Flats: 'flats', Sandals: 'sandals', Boots: 'boots',
    Sneakers: 'sneakers', Loafers: 'loafers', "Men's Shoes": 'shoes',
  };
  const type = catMap[cat] || 'shoes';

  const openers = [
    `Authentic ALDO ${color || 'premium'} ${type} — new stock, never worn.`,
    `Brand new ALDO ${type}${color ? ' in ' + color : ''} — quality-checked before listing.`,
    `Fresh ALDO ${color || 'quality'} ${type}, straight from the brand.`,
  ];
  const mids = [
    `EU sizes available — tap Enquire to confirm your size.`,
    `Available in multiple EU sizes. WhatsApp us to check your size and pay.`,
    `New in. All sizes listed are in stock.`,
  ];
  const closes = [
    `Shop at Piedmont Plaza, Ngong Road or order countrywide via WhatsApp.`,
    `Pick up in Nairobi or we deliver. Tap Check availability to order.`,
    `Nationwide delivery available. Enquire on WhatsApp to place your order.`,
  ];
  return [
    openers[Math.floor(Math.random() * openers.length)],
    mids[Math.floor(Math.random() * mids.length)],
    closes[Math.floor(Math.random() * closes.length)],
  ].join(' ');
}

// ====== SAVE ITEM ======
document.getElementById('saveBtn').addEventListener('click', saveItem);
document.getElementById('cancelBtn').addEventListener('click', resetForm);

function saveItem() {
  const name = document.getElementById('nameInput').value.trim();
  const price = parseInt(document.getElementById('priceInput').value, 10);
  const desc = document.getElementById('descInput').value.trim();
  const cat = getCategoryValue();
  const postUrl = document.getElementById('postUrlInput').value.trim();
  const stock = getStockFromForm();

  if (!name) { showToast('Item name is required.'); return; }
  if (!price || price < 0) { showToast('Enter a valid price.'); return; }

  // Buying price (cost) — admin-only, optional, never rejected. Blank/0 = not recorded.
  const costRaw = costInput.value.trim();
  const cost = costRaw === '' ? 0 : Math.max(0, parseInt(costRaw, 10) || 0);

  if (editingId) {
    const item = items.find(i => i.id === editingId);
    if (!item) return;
    item.name = name;
    item.description = desc;
    item.price = price;
    item.category = cat;
    item.postUrl = postUrl;
    if (cost) item.cost = cost; else delete item.cost;
    // Merge stock: explicit 0 entries from form should remove size
    document.querySelectorAll('.stock-qty').forEach(inp => {
      const sz = inp.dataset.size;
      const val = parseInt(inp.value, 10);
      if (!isNaN(val) && val === 0) delete item.stock[sz];
      else if (inp.value === '') delete item.stock[sz];
      else if (val > 0) item.stock[sz] = val;
    });
    if (stagedImage) {
      item.image = stagedImage.dataUrl;
    }
    // Additional images: build from current extras
    const extraDataUrls = stagedExtras.map(s => s.dataUrl || s.url).filter(Boolean);
    if (extraDataUrls.length) {
      item.images = [item.image, ...extraDataUrls];
    }
    showToast('Item updated.');
  } else {
    if (!stagedImage) { showToast('Add an item image.'); return; }
    const newItem = {
      id: 'item_' + Date.now(),
      name, description: desc, price, category: cat,
      postUrl, image: stagedImage.dataUrl,
      stock, sales: [],
      createdAt: new Date().toISOString(),
    };
    if (cost) newItem.cost = cost;
    const extraDataUrls = stagedExtras.map(s => s.dataUrl || s.url).filter(Boolean);
    if (extraDataUrls.length) newItem.images = [newItem.image, ...extraDataUrls];
    items.unshift(newItem);
    showToast('Item added.');
  }

  saveData();
  resetForm();
  renderList();
  renderDashboard();
  renderInventory();
}

// ===== Category field helpers =====
// The form category <select> is a fixed list, but the shop owner can add their
// own. Picking "+ Add new category…" reveals a free-text box; any category that
// already exists on an item is auto-injected so it shows up for everyone after.
function toggleNewCategoryInput() {
  const sel = document.getElementById('catInput');
  const box = document.getElementById('categoryNewInput');
  if (!sel || !box) return;
  if (sel.value === '__new__') {
    box.style.display = '';
    box.focus();
  } else {
    box.style.display = 'none';
    box.value = '';
  }
}

// Read the chosen category, resolving the "+ Add new…" free-text path.
function getCategoryValue() {
  const sel = document.getElementById('catInput');
  if (!sel) return '';
  if (sel.value === '__new__') {
    return document.getElementById('categoryNewInput').value.trim();
  }
  return sel.value || '';
}

// Set the select to a category, injecting it as an option if it isn't a
// built-in one (so editing a custom-category item shows it selected).
function setCategoryValue(cat) {
  const sel = document.getElementById('catInput');
  const box = document.getElementById('categoryNewInput');
  if (!sel) return;
  if (box) { box.style.display = 'none'; box.value = ''; }
  const c = cat || '';
  if (!c) { sel.value = ''; return; }
  const exists = [...sel.options].some(o => o.value === c);
  if (!exists) ensureCategoryOption(c);
  sel.value = c;
}

// Ensure a category exists as a <option> in the select. Custom (owner-added)
// categories land in a dedicated "Your categories" group above "+ Add new…".
function ensureCategoryOption(cat) {
  const sel = document.getElementById('catInput');
  if (!sel || !cat) return;
  if ([...sel.options].some(o => o.value === cat)) return;
  let group = document.getElementById('customCatGroup');
  if (!group) {
    group = document.createElement('optgroup');
    group.id = 'customCatGroup';
    group.label = 'Your categories';
    const newOpt = [...sel.options].find(o => o.value === '__new__');
    sel.insertBefore(group, newOpt || null);
  }
  const opt = document.createElement('option');
  opt.value = cat;
  opt.textContent = cat;
  group.appendChild(opt);
}

// Sweep every category already used on an item into the dropdown, so an
// owner-added category becomes a permanent choice for all future items.
// Works for flat OR optgroup selects: the built-in option values are
// snapshotted once (before any custom injection) so we never re-classify
// a built-in as custom.
let _builtinCatValues = null;
function syncCustomCategories() {
  const sel = document.getElementById('catInput');
  if (!sel) return;
  if (!_builtinCatValues) {
    _builtinCatValues = new Set([...sel.options].map(o => o.value).filter(v => v && v !== '__new__'));
  }
  [...new Set(items.map(b => b.category).filter(Boolean))]
    .filter(c => !_builtinCatValues.has(c))
    .sort((a, b) => a.localeCompare(b))
    .forEach(ensureCategoryOption);
}

function resetForm() {
  editingId = null;
  document.getElementById('editingId').value = '';
  document.getElementById('nameInput').value = '';
  setCategoryValue('');
  document.getElementById('descInput').value = '';
  document.getElementById('priceInput').value = '';
  document.getElementById('postUrlInput').value = '';
  costInput.value = '';
  clearStockForm();
  imageInput.value = '';
  imagePreview.innerHTML = '';
  stagedImage = null;
  stagedExtras = [];
  renderExtraImagesPreview();
  const igInput = document.getElementById('igQuickInput');
  if (igInput) igInput.value = '';
  const igStatus = document.getElementById('igQuickStatus');
  if (igStatus) { igStatus.textContent = ''; igStatus.className = 'ig-quick-status'; }
  document.getElementById('formTitle').textContent = 'Add a new item';
  document.getElementById('cancelBtn').style.display = 'none';
  const igPanel = document.getElementById('igQuickPanel');
  const divider = document.getElementById('manualEntryDivider');
  if (igPanel) igPanel.style.display = '';
  if (divider) divider.style.display = '';
  { const _me = document.getElementById('manualEntry'); if (_me) _me.open = false; }
}

function editItem(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
  editingId = id;
  document.getElementById('editingId').value = id;
  document.getElementById('nameInput').value = item.name;
  setCategoryValue(item.category || '');
  document.getElementById('descInput').value = item.description || '';
  document.getElementById('priceInput').value = item.price;
  document.getElementById('postUrlInput').value = item.postUrl || '';
  costInput.value = item.cost || '';
  setStockToForm(item.stock || {});
  stagedImage = null;
  imagePreview.innerHTML = `<img src="${item.image}" style="max-width:200px;border-radius:8px;">`;
  stagedExtras = ((item.images && item.images.length > 1) ? item.images.slice(1) : []).map(url => ({ url, dataUrl: url }));
  renderExtraImagesPreview();
  document.getElementById('formTitle').textContent = 'Edit item';
  document.getElementById('cancelBtn').style.display = 'inline-block';
  const igPanel = document.getElementById('igQuickPanel');
  const divider = document.getElementById('manualEntryDivider');
  if (igPanel) igPanel.style.display = 'none';
  if (divider) divider.style.display = 'none';
  { const _me = document.getElementById('manualEntry'); if (_me) _me.open = true; }
  document.getElementById('formTitle').scrollIntoView({ behavior: 'auto', block: 'start' });
}

async function deleteItem(id) {
  if (!await confirmAction('Delete this item? This cannot be undone.', 'Delete')) return;
  items = items.filter(i => i.id !== id);
  saveData();
  renderList();
  renderDashboard();
  renderInventory();
  showToast('Item deleted.');
}

// ====== SALE MODAL ======
const saleModal = document.getElementById('saleModal');

function openSaleModal(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
  // If 2+ items are multi-selected and this is one of them, she means the batch.
  if (bulkSelected.size >= 2 && bulkSelected.has(id)) { bulkSell(); return; }
  pendingSaleId = id;
  document.getElementById('saleModalTitle').textContent = `Record sale: ${item.name}`;

  const saleSizeInput = document.getElementById('saleSizeInput');
  saleSizeInput.innerHTML = '';
  const stock = item.stock || {};
  const hasSizes = Object.keys(stock).length > 0;
  if (hasSizes) {
    Object.entries(stock).filter(([, q]) => q > 0).forEach(([sz, q]) => {
      const opt = document.createElement('option');
      opt.value = sz;
      opt.textContent = `EU ${sz} (${q} in stock)`;
      saleSizeInput.appendChild(opt);
    });
    if (!saleSizeInput.options.length) { showToast('All sizes are out of stock.'); return; }
  } else {
    const opt = document.createElement('option'); opt.value = 'One size'; opt.textContent = 'One size'; saleSizeInput.appendChild(opt);
  }

  document.getElementById('saleQtyInput').value = 1;
  document.getElementById('salePriceInput').value = item.price;
  document.getElementById('buyerName').value = '';
  document.getElementById('buyerPhone').value = '';
  document.getElementById('buyerNotes').value = '';
  document.querySelectorAll('#saleModalPay .pos-pay-btn').forEach(b => b.classList.toggle('active', b.dataset.pay === 'mpesa'));
  saleModal.style.display = 'flex';
  document.getElementById('buyerName').focus();
}

function closeSaleModal() { saleModal.style.display = 'none'; pendingSaleId = null; }

document.getElementById('saleSaveBtn').addEventListener('click', () => {
  const item = items.find(i => i.id === pendingSaleId);
  if (!item) return;
  const size = document.getElementById('saleSizeInput').value;
  const qty = parseInt(document.getElementById('saleQtyInput').value, 10) || 1;
  const salePrice = parseInt(document.getElementById('salePriceInput').value, 10) || item.price;
  const payMethod = document.querySelector('#saleModalPay .pos-pay-btn.active')?.dataset.pay || 'mpesa';
  const bName = document.getElementById('buyerName').value.trim();
  const bPhone = document.getElementById('buyerPhone').value.trim();
  const soldAt = new Date().toISOString();

  if (item.stock && item.stock[size] !== undefined) {
    item.stock[size] = Math.max(0, item.stock[size] - qty);
  }
  if (!item.sales) item.sales = [];
  // Owed feature: capture cash actually taken at the moment of sale.
  // Blank = paid in full (don't write amountPaid → historical sales stay paid).
  const _saleRec = {
    size, qty, salePrice, paymentMethod: payMethod, channel: 'shop',
    buyerName: bName,
    buyerPhone: bPhone,
    notes: document.getElementById('buyerNotes').value.trim(),
    soldAt,
  };
  const _salePaidRaw = (document.getElementById('salePaidInput')?.value || '').trim();
  if (_salePaidRaw !== '') {
    const _saleTotalNow = (Number(salePrice) || 0) * (Number(qty) || 1);
    _saleRec.amountPaid = Math.min(_saleTotalNow, Math.max(0, parseInt(_salePaidRaw, 10) || 0));
  }
  item.sales.push(_saleRec);

  closeSaleModal();
  saveData();
  renderList();
  renderDashboard();
  renderInventory();
  showToast(`Sale recorded — ${qty}× EU ${size} sold.`);
  lastPosSale = { name: item.name, size, qty, amount: salePrice, paymentMethod: payMethod, buyerName: bName, buyerPhone: bPhone, soldAt };
  showPosReceipt(lastPosSale);
  document.getElementById('posDash').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

document.getElementById('saleCancelBtn').addEventListener('click', closeSaleModal);
document.getElementById('saleModalPay')?.addEventListener('click', e => {
  const b = e.target.closest('.pos-pay-btn'); if (!b) return;
  document.querySelectorAll('#saleModalPay .pos-pay-btn').forEach(x => x.classList.toggle('active', x === b));
});
saleModal.addEventListener('click', e => { if (e.target === saleModal) closeSaleModal(); });

// ====== EDIT / UNDO A RECORDED SALE ======
let editingSale = null; // { itemId, soldAt }

async function undoSale(itemId, soldAt) {
  if (!await confirmAction('Undo this sale? The quantity goes back into stock.', 'Undo sale')) return;
  const item = items.find(i => i.id === itemId);
  if (!item) return;
  const idx = (item.sales || []).findIndex(x => x.soldAt === soldAt);
  if (idx === -1) return;
  const s = item.sales[idx];
  if (item.stock && item.stock[s.size] !== undefined) {
    item.stock[s.size] = (Number(item.stock[s.size]) || 0) + (Number(s.qty) || 1);
  }
  item.sales.splice(idx, 1);
  saveData();
  renderList();
  renderDashboard();
  renderInventory();
  showToast('Sale undone, stock restored.');
}

function openEditSale(itemId, soldAt) {
  const item = items.find(i => i.id === itemId);
  if (!item) return;
  const s = (item.sales || []).find(x => x.soldAt === soldAt);
  if (!s) return;
  editingSale = { itemId, soldAt };
  document.getElementById('editSaleTitle').textContent = `Edit sale: ${item.name}`;
  document.getElementById('editSaleSize').value = s.size || '';
  document.getElementById('editSaleQty').value = s.qty || 1;
  document.getElementById('editSalePrice').value = (s.salePrice != null ? s.salePrice : item.price) || 0;
  document.getElementById('editBuyerName').value = s.buyerName || '';
  document.getElementById('editBuyerPhone').value = s.buyerPhone || '';
  document.getElementById('editBuyerNotes').value = s.notes || '';
  document.getElementById('editSaleModal').style.display = 'flex';
}

function closeEditSale() { document.getElementById('editSaleModal').style.display = 'none'; editingSale = null; }

document.getElementById('editSaleSaveBtn').addEventListener('click', () => {
  if (!editingSale) return;
  const item = items.find(i => i.id === editingSale.itemId);
  if (!item) return;
  const s = (item.sales || []).find(x => x.soldAt === editingSale.soldAt);
  if (!s) return;
  const newSize = document.getElementById('editSaleSize').value.trim() || s.size;
  const newQty = parseInt(document.getElementById('editSaleQty').value, 10) || 1;
  const newPrice = parseInt(document.getElementById('editSalePrice').value, 10) || item.price;
  // Correct stock: put the old quantity back, then take the new quantity out
  if (item.stock) {
    if (item.stock[s.size] !== undefined) item.stock[s.size] = (Number(item.stock[s.size]) || 0) + (Number(s.qty) || 1);
    if (item.stock[newSize] !== undefined) item.stock[newSize] = Math.max(0, (Number(item.stock[newSize]) || 0) - newQty);
  }
  s.size = newSize;
  s.qty = newQty;
  s.salePrice = newPrice;
  s.buyerName = document.getElementById('editBuyerName').value.trim();
  s.buyerPhone = document.getElementById('editBuyerPhone').value.trim();
  s.notes = document.getElementById('editBuyerNotes').value.trim();
  closeEditSale();
  saveData();
  renderList();
  renderDashboard();
  renderInventory();
  showToast('Sale updated.');
});
document.getElementById('editSaleCancelBtn').addEventListener('click', closeEditSale);

// ====== BULK SELL TO ONE CUSTOMER (new-stock: each selected item → its own sale, qty 1) ======
// Sells every selected in-stock item to the same buyer in one go. Per item the
// owner picks a size only when the item has more than one in-stock size; qty is
// 1 each (a multi-item bundle). An optional part-payment for the whole lot is
// allocated across items oldest-first so the Owed ledger works. Buyer details
// (and the existing-customer picker) are entered once. Panache persists via
// saveData() (localStorage + /api/bulk), same path as the single-sale flow.
function bsEffPrice(b) { return (b.salePrice > 0 && b.salePrice < b.price) ? b.salePrice : (Number(b.price) || 0); }
function bsInStockSizes(b) {
  const stock = b.stock || {};
  const keys = Object.keys(stock);
  if (!keys.length) return ['One size'];
  return keys.filter(k => Number(stock[k]) > 0);
}
function bulkSellableSelected() { return items.filter(b => bulkSelected.has(b.id) && bsInStockSizes(b).length > 0); }
let bulkSellTotalAmt = 0;
window.bulkSell = () => {
  const list = bulkSellableSelected();
  if (!list.length) { showToast('Select at least one in-stock item to sell.'); return; }
  bulkSellTotalAmt = list.reduce((s, b) => s + bsEffPrice(b), 0);
  document.getElementById('bulkSellTitle').textContent = `Sell ${list.length} item${list.length === 1 ? '' : 's'} to one customer`;
  document.getElementById('bulkSellRows').innerHTML = list.map(b => {
    const sizes = bsInStockSizes(b);
    const ctl = sizes.length > 1
      ? `<select class="bsr-size" data-id="${b.id}">${sizes.map(s => `<option value="${escapeHtml(s)}">EU ${escapeHtml(s)}</option>`).join('')}</select>`
      : `<span class="bsr-onesize" data-id="${b.id}" data-size="${escapeHtml(sizes[0])}">${sizes[0] === 'One size' ? 'One size' : 'EU ' + escapeHtml(sizes[0])}</span>`;
    return `<div class="bulksell-row"><span class="bulksell-row-name">${escapeHtml(b.name)} · ${fmtKsh(bsEffPrice(b))}</span>${ctl}</div>`;
  }).join('');
  document.getElementById('bulkSellTotal').textContent = `Total: ${fmtKsh(bulkSellTotalAmt)} · ${list.length} item${list.length === 1 ? '' : 's'}`;
  ['bulkSellName', 'bulkSellPhone', 'bulkSellNotes', 'bulkSellPaid', 'bulkSellCustSearch'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('bulkSellPaid').placeholder = 'Paid in full';
  document.getElementById('bulkSellPaidHint').style.display = 'none';
  document.getElementById('bulkSellPaidNone').classList.remove('active');
  const cr = document.getElementById('bulkSellCustResults'); if (cr) { cr.style.display = 'none'; cr.innerHTML = ''; }
  document.querySelectorAll('#bulkSellPay .pos-pay-btn').forEach(b => b.classList.toggle('active', b.dataset.pay === 'mpesa'));
  document.getElementById('bulkSellModal').style.display = 'flex';
};
function closeBulkSell() { document.getElementById('bulkSellModal').style.display = 'none'; }
function updateBulkSellHint() {
  const raw = (document.getElementById('bulkSellPaid').value || '').trim();
  document.getElementById('bulkSellPaidNone').classList.toggle('active', raw === '0');
  const hint = document.getElementById('bulkSellPaidHint');
  if (raw === '') { hint.style.display = 'none'; return; }
  const bal = bulkSellTotalAmt - Math.min(bulkSellTotalAmt, Math.max(0, parseInt(raw, 10) || 0));
  hint.style.display = bal > 0 ? '' : 'none';
  if (bal > 0) hint.textContent = `Balance owing: ${fmtKsh(bal)}`;
}
function commitBulkSold(withBuyer) {
  const initial = bulkSellableSelected();
  if (!initial.length) { closeBulkSell(); return; }
  // Read the chosen size per item from the DOM before we close the modal.
  const chosen = initial.map(b => {
    const sel = document.querySelector(`.bsr-size[data-id="${b.id}"]`);
    const one = document.querySelector(`.bsr-onesize[data-id="${b.id}"]`);
    return { id: b.id, size: sel ? sel.value : (one ? one.dataset.size : 'One size'), price: bsEffPrice(b) };
  });
  const payMethod = document.querySelector('#bulkSellPay .pos-pay-btn.active')?.dataset.pay || 'mpesa';
  const buyer = { name: '', phone: '', notes: '' };
  if (withBuyer) {
    buyer.name = document.getElementById('bulkSellName').value.trim();
    buyer.phone = document.getElementById('bulkSellPhone').value.trim().replace(/[^0-9+]/g, '');
    buyer.notes = document.getElementById('bulkSellNotes').value.trim();
    if (!buyer.name && !buyer.phone) { showToast('Add a name or phone, or hit Skip.'); return; }
  }
  const paidRaw = (document.getElementById('bulkSellPaid').value || '').trim();
  const hasPartial = withBuyer && paidRaw !== '';
  closeBulkSell();
  const soldAt = new Date().toISOString();
  let remaining = hasPartial ? Math.max(0, parseInt(paidRaw, 10) || 0) : Infinity;
  const soldList = [];
  for (const ch of chosen) {
    const item = items.find(b => b.id === ch.id);
    if (!item) continue;
    const stock = item.stock || {};
    const hasStockObj = Object.keys(stock).length > 0;
    if (hasStockObj && !(Number(stock[ch.size]) > 0)) continue; // size sold out since the modal opened
    const total = ch.price; // qty 1
    const amountPaid = hasPartial ? Math.min(remaining, total) : total;
    if (hasPartial) remaining = Math.max(0, remaining - amountPaid);
    const sale = {
      size: ch.size, qty: 1, salePrice: ch.price,
      paymentMethod: payMethod, channel: 'shop',
      buyerName: withBuyer ? buyer.name : '', buyerPhone: withBuyer ? buyer.phone : '',
      notes: withBuyer ? buyer.notes : '', soldAt,
    };
    if (hasPartial) sale.amountPaid = amountPaid;
    if (hasStockObj && stock[ch.size] !== undefined) stock[ch.size] = Math.max(0, Number(stock[ch.size]) - 1);
    if (!item.sales) item.sales = [];
    item.sales.push(sale);
    soldList.push({ item, sale });
  }
  if (!soldList.length) { showToast('Nothing left to sell — sizes sold out.'); return; }
  bulkSelected.clear();
  saveData();
  renderList(); renderDashboard(); renderInventory();
  if (typeof renderClients === 'function') renderClients();
  const total = soldList.reduce((s, x) => s + (Number(x.sale.salePrice) || 0), 0);
  const owed = hasPartial ? Math.max(0, total - Math.max(0, parseInt(paidRaw, 10) || 0)) : 0;
  showToast(`Sold ${soldList.length} item${soldList.length === 1 ? '' : 's'}${withBuyer && buyer.name ? ' to ' + buyer.name : ''} · ${fmtKsh(total)}${owed > 0 ? ` · ${fmtKsh(owed)} owed` : ''}`);
}
// Existing-customer picker.
function wireCustomerPicker({ searchId, resultsId, nameId, phoneId }) {
  const search = document.getElementById(searchId);
  const box = document.getElementById(resultsId);
  if (!search || !box) return;
  search.addEventListener('input', () => {
    const term = search.value.trim().toLowerCase();
    if (!term) { box.style.display = 'none'; box.innerHTML = ''; return; }
    const digits = term.replace(/[^0-9+]/g, '');
    const matches = clientsLedger()
      .filter(c => (c.name || '').toLowerCase().includes(term) || (digits && (c.phone || '').includes(digits)))
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, 8);
    box.innerHTML = matches.length
      ? matches.map(c => {
          const meta = `${escapeHtml(c.phone || '')}${c.purchases.length ? ` · ${c.purchases.length} bought` : ''}`;
          return `<button type="button" class="client-item-opt" data-name="${escapeHtml(c.name || '')}" data-phone="${escapeHtml(c.phone || '')}">${escapeHtml(c.name || '(no name)')}<span>${meta}</span></button>`;
        }).join('')
      : '<div class="client-item-empty">No saved customer matches. Type the details below to add a new one.</div>';
    box.style.display = '';
  });
  box.addEventListener('click', e => {
    const opt = e.target.closest('.client-item-opt');
    if (!opt) return;
    document.getElementById(nameId).value = opt.dataset.name || '';
    document.getElementById(phoneId).value = opt.dataset.phone || '';
    search.value = opt.dataset.name || opt.dataset.phone || '';
    box.style.display = 'none';
    showToast('Customer selected — edit if needed.');
  });
}
wireCustomerPicker({ searchId: 'bulkSellCustSearch', resultsId: 'bulkSellCustResults', nameId: 'bulkSellName', phoneId: 'bulkSellPhone' });
document.getElementById('bulkSellSaveBtn')?.addEventListener('click', () => commitBulkSold(true));
document.getElementById('bulkSellSkipBtn')?.addEventListener('click', () => commitBulkSold(false));
document.getElementById('bulkSellCancelBtn')?.addEventListener('click', closeBulkSell);
document.getElementById('bulkSellModal')?.addEventListener('click', e => { if (e.target.id === 'bulkSellModal') closeBulkSell(); });
document.querySelectorAll('#bulkSellPay .pos-pay-btn').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('#bulkSellPay .pos-pay-btn').forEach(b => b.classList.toggle('active', b === btn));
}));
document.getElementById('bulkSellPaid')?.addEventListener('input', updateBulkSellHint);
document.getElementById('bulkSellPaidNone')?.addEventListener('click', () => {
  document.getElementById('bulkSellPaid').value = '0';
  updateBulkSellHint();
});

// ====== RESTOCK MODAL ======
const restockModal = document.getElementById('restockModal');

function openRestockModal(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
  pendingRestockId = id;
  document.getElementById('restockModalTitle').textContent = `Restock: ${item.name}`;
  const restockSizeInput = document.getElementById('restockSizeInput');
  restockSizeInput.innerHTML = '';
  ALL_EU_SIZES.forEach(sz => {
    const opt = document.createElement('option'); opt.value = sz;
    const cur = item.stock?.[sz] || 0;
    opt.textContent = `EU ${sz} (currently ${cur})`;
    restockSizeInput.appendChild(opt);
  });
  document.getElementById('restockQtyInput').value = 3;
  restockModal.style.display = 'flex';
}

function closeRestockModal() { restockModal.style.display = 'none'; pendingRestockId = null; }

document.getElementById('restockSaveBtn').addEventListener('click', () => {
  const item = items.find(i => i.id === pendingRestockId);
  if (!item) return;
  const size = document.getElementById('restockSizeInput').value;
  const qty = parseInt(document.getElementById('restockQtyInput').value, 10) || 0;
  if (qty <= 0) { showToast('Enter a quantity to add.'); return; }
  if (!item.stock) item.stock = {};
  item.stock[size] = (item.stock[size] || 0) + qty;
  closeRestockModal();
  saveData();
  renderList();
  renderInventory();
  showToast(`+${qty} × EU ${size} added to stock.`);
});

document.getElementById('restockCancelBtn').addEventListener('click', closeRestockModal);
restockModal.addEventListener('click', e => { if (e.target === restockModal) closeRestockModal(); });

// ====== SALES DASHBOARD ======
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function startOfWeek(d) { const x = startOfDay(d); const dow = (x.getDay() + 6) % 7; x.setDate(x.getDate() - dow); return x; }
function startOfMonth(d) { const x = new Date(d.getFullYear(), d.getMonth(), 1); x.setHours(0,0,0,0); return x; }

function renderDashboard() {
  if (typeof renderOwed === 'function') renderOwed();
  _renderDashboardInner();
}
function _renderDashboardInner() {
  const now = new Date();
  const buckets = [
    { label: 'Today', since: startOfDay(now) },
    { label: 'This week', since: startOfWeek(now) },
    { label: 'This month', since: startOfMonth(now) },
    { label: 'All time', since: null },
  ].map(b => {
    let count = 0, revenue = 0;
    items.forEach(item => {
      (item.sales || []).forEach(s => {
        if (!b.since || new Date(s.soldAt) >= b.since) {
          count += Number(s.qty) || 1;
          revenue += (Number(s.salePrice || item.price)) * (Number(s.qty) || 1);
        }
      });
    });
    return { ...b, count, revenue };
  });

  // All-time profit (admin-only) — sums realised − cost over ONLY the sold items
  // that have a buying price recorded. costKnown = how many of the sold items
  // carry a cost; soldItemsCount = all items with at least one sale (for the
  // coverage note, so a partial figure isn't mistaken for total profit).
  let profitAll = 0, costKnown = 0, soldItemsCount = 0;
  items.forEach(item => {
    const sold = totalUnitsSold(item);
    if (sold <= 0) return;
    soldItemsCount++;
    if (item.cost) {
      profitAll += totalRevenue(item) - item.cost * sold;
      costKnown++;
    }
  });

  document.getElementById('kpiGrid').innerHTML = buckets.map(b => {
    let profitSub = '';
    if (b.label === 'All time' && costKnown > 0) {
      const note = costKnown < soldItemsCount
        ? `<span id="statAllProfitNote" style="color:#999;font-weight:400;"> · from ${costKnown}/${soldItemsCount} with cost</span>`
        : '';
      profitSub = `<div id="statAllProfitSub" class="kpi-profit" style="font-size:12px;color:#2e7d32;font-weight:600;margin-top:2px;">Profit <span id="statAllProfit">${fmtKsh(profitAll)}</span>${note}</div>`;
    }
    return `
    <div class="kpi-card">
      <div class="kpi-label">${b.label}</div>
      <div class="kpi-count">${b.count} <span class="kpi-unit">pairs</span></div>
      <div class="kpi-revenue">${fmtKsh(b.revenue)}</div>${profitSub}
    </div>`;
  }).join('');

  const splitEl = document.getElementById('posTodaySplit');
  if (splitEl) {
    const todayStart = startOfDay(now);
    let cashT = 0, mpesaT = 0, soldToday = 0;
    items.forEach(it => (it.sales || []).forEach(s => {
      if (new Date(s.soldAt) >= todayStart) {
        const amt = (Number(s.salePrice || it.price)) * (Number(s.qty) || 1);
        soldToday += Number(s.qty) || 1;
        if (s.paymentMethod === 'mpesa') mpesaT += amt; else cashT += amt;
      }
    }));
    splitEl.innerHTML = `<span class="pos-today-label">Today's takings</span>`
      + `<span class="pos-chip cash">💵 Cash ${fmtKsh(cashT)}</span>`
      + `<span class="pos-chip mpesa">📱 M-Pesa ${fmtKsh(mpesaT)}</span>`
      + `<span class="pos-chip total">${soldToday} sold</span>`;
  }

  // Top categories
  const catUnits = {}, catRev = {};
  items.forEach(item => {
    const cat = item.category || 'Other';
    (item.sales || []).forEach(s => {
      catUnits[cat] = (catUnits[cat] || 0) + (Number(s.qty) || 1);
      catRev[cat] = (catRev[cat] || 0) + (Number(s.salePrice || item.price)) * (Number(s.qty) || 1);
    });
  });
  const cats = Object.entries(catUnits).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxU = cats[0]?.[1] || 1;
  document.getElementById('topCats').innerHTML = cats.length
    ? cats.map(([cat, n]) => `
        <div class="cat-bar-item">
          <div class="cat-bar-row"><span class="cat-bar-name">${escapeHtml(cat)}</span><span class="cat-bar-meta">${n} sold · ${fmtKsh(catRev[cat])}</span></div>
          <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${(n/maxU)*100}%"></div></div>
        </div>`).join('')
    : '<p style="color:#999;font-size:13px;">No sales yet — record your first sale to populate.</p>';

  // Recent sales
  const allSaleRecords = [];
  items.forEach(item => (item.sales || []).forEach(s => allSaleRecords.push({ item, s })));
  const recent = allSaleRecords.sort((a, b) => new Date(b.s.soldAt) - new Date(a.s.soldAt)).slice(0, 20);
  document.getElementById('recentSales').innerHTML = recent.length
    ? recent.map(({ item, s }) => `
        <div class="recent-row">
          <div class="recent-main">
            <img src="${item.image}" alt="${escapeHtml(item.name)}">
            <div>
              <div class="recent-name">${escapeHtml(item.name)} · EU ${escapeHtml(s.size || '')} × ${s.qty || 1}${saleBalance(item, s) > 0 ? ` <span class="owed-tag">owes ${fmtKsh(saleBalance(item, s))}</span>` : ''}</div>
              <div class="recent-meta">${fmtKsh(s.salePrice || item.price)} · ${s.buyerName ? escapeHtml(s.buyerName) : 'No buyer saved'} · ${relTime(s.soldAt)}</div>
            </div>
          </div>
          <div class="recent-actions">
            <button onclick="openEditSale('${item.id}','${s.soldAt}')">Edit</button>
            <button class="danger" onclick="undoSale('${item.id}','${s.soldAt}')">Undo</button>
          </div>
        </div>`).join('')
    : '<p style="color:#999;font-size:13px;">No sales recorded yet.</p>';
}

// ====== INVENTORY ======
let invFilter = 'attention';
let invShowAll = false;
const INV_PAGE_SIZE = 15;

function renderInventory() {
  let totalItems = items.length;
  let totalUnits = 0, totalValue = 0, lowStock = 0, outOfStock = 0;

  items.forEach(item => {
    const units = totalStock(item);
    totalUnits += units;
    totalValue += units * (item.price || 0);
    if (units === 0) outOfStock++;
    else if (units <= 5) lowStock++;
  });

  document.getElementById('invKpiGrid').innerHTML = [
    { label: 'Total items', val: totalItems, sub: 'SKUs listed', cls: '' },
    { label: 'Units in stock', val: totalUnits.toLocaleString(), sub: 'across all sizes', cls: 'success' },
    { label: 'Inventory value', val: fmtKsh(totalValue), sub: 'at listed prices', cls: '' },
    { label: 'Low stock', val: lowStock, sub: '5 or fewer units', cls: lowStock > 0 ? 'warn' : '' },
    { label: 'Out of stock', val: outOfStock, sub: 'need restocking', cls: outOfStock > 0 ? 'danger' : '' },
  ].map(k => `
    <div class="inv-kpi ${k.cls}">
      <div class="inv-kpi-label">${k.label}</div>
      <div class="inv-kpi-val">${k.val}</div>
      <div class="inv-kpi-sub">${k.sub}</div>
    </div>`).join('');

  const attentionItems = items.filter(b => totalStock(b) <= 5);
  const filterBar = document.getElementById('invFilterBar');
  if (filterBar) {
    filterBar.innerHTML = `
      <button class="pill ${invFilter==='attention'?'active':''}" data-inv-filter="attention">
        Needs attention <span class="admin-nav-count">${attentionItems.length}</span>
      </button>
      <button class="pill ${invFilter==='all'?'active':''}" data-inv-filter="all">
        All items <span class="admin-nav-count">${items.length}</span>
      </button>`;
    filterBar.querySelectorAll('[data-inv-filter]').forEach(b => {
      b.addEventListener('click', () => { invFilter = b.dataset.invFilter; invShowAll = false; renderInventory(); });
    });
  }

  const filtered = (invFilter === 'attention' ? attentionItems : items)
    .slice().sort((a, b) => totalStock(a) - totalStock(b));
  const cap = invShowAll ? filtered.length : Math.min(INV_PAGE_SIZE, filtered.length);
  const sorted = filtered.slice(0, cap);

  const lbl = document.getElementById('invSortLabel');
  if (lbl) lbl.textContent = `showing ${sorted.length} of ${filtered.length} · sorted low → high`;

  document.getElementById('invTableBody').innerHTML = sorted.map(item => {
    const units = totalStock(item);
    const soldUnits = totalUnitsSold(item);
    const stockEntries = Object.entries(item.stock || {});
    const stockCells = stockEntries.length
      ? stockEntries.map(([sz, q]) => {
          const cls = q === 0 ? 'zero' : q <= 3 ? 'low' : 'ok';
          return `<span class="stock-cell ${cls}">EU${sz}: ${q}</span>`;
        }).join('')
      : '<span style="color:#999;font-size:12px;">No sizes set</span>';

    const statusCls = units === 0 ? 'zero' : units <= 5 ? 'low' : 'ok';
    const statusLabel = units === 0 ? 'Out of stock' : units <= 5 ? 'Low stock' : 'In stock';

    // Admin-only cost/profit subline — shown only when a buying price is recorded.
    let costLine = '';
    if (item.cost) {
      if (soldUnits > 0) {
        const profit = totalRevenue(item) - item.cost * soldUnits;
        costLine = `<div style="font-size:11px;color:#2e7d32;">cost ${fmtKsh(item.cost)} · profit ${fmtKsh(profit)}</div>`;
      } else {
        const margin = item.price - item.cost;
        costLine = `<div style="font-size:11px;color:#2e7d32;">cost ${fmtKsh(item.cost)} · margin ${fmtKsh(margin)}</div>`;
      }
    }

    return `
    <tr>
      <td><img class="item-img" src="${item.image}" alt="${escapeHtml(item.name)}"></td>
      <td>
        <div style="font-weight:600;font-size:13px;">${escapeHtml(item.name)}</div>
        <div style="font-size:11px;color:#999;margin-top:2px;">${soldUnits} sold · ${fmtKsh(totalRevenue(item))} revenue</div>
      </td>
      <td style="font-size:13px;">${escapeHtml(item.category || '—')}</td>
      <td style="font-size:13px;font-weight:600;">${fmtKsh(item.price)}${costLine}</td>
      <td><div class="stock-cells">${stockCells}</div></td>
      <td style="font-weight:700;font-size:14px;">${units}</td>
      <td><span class="stock-pill ${statusCls}">${statusLabel}</span></td>
      <td><button class="restock-btn" onclick="openRestockModal('${item.id}')">+ Restock</button></td>
    </tr>`;
  }).join('') || `<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--ink-faint);">${invFilter === 'attention' ? 'Nothing needs attention — all items have healthy stock.' : 'No items yet.'}</td></tr>`;

  const toggle = document.getElementById('invShowMore');
  if (toggle) {
    if (filtered.length <= INV_PAGE_SIZE) {
      toggle.style.display = 'none';
    } else {
      toggle.style.display = 'block';
      toggle.textContent = invShowAll ? `Show fewer (top ${INV_PAGE_SIZE})` : `Show all ${filtered.length} items ↓`;
      toggle.onclick = () => { invShowAll = !invShowAll; renderInventory(); };
    }
  }
}

// ====== ITEM LIST ======
let bulkSelected = new Set();
let adminItemSearch = '';

function renderList() {
  syncCustomCategories();
  const list = document.getElementById('adminList');
  document.getElementById('itemCount').textContent = items.length;
  const navCount = document.getElementById('navItemCount');
  if (navCount) navCount.textContent = items.length;
  renderBulkBar();

  const q = adminItemSearch.trim().toLowerCase();
  const filtered = q
    ? items.filter(i => `${i.name} ${i.category || ''}`.toLowerCase().includes(q))
    : items;
  const countEl = document.getElementById('adminItemSearchCount');
  if (countEl) countEl.textContent = q ? `${filtered.length} match${filtered.length === 1 ? '' : 'es'}` : '';

  list.innerHTML = filtered.map(item => {
    const units = totalStock(item);
    const sold = totalUnitsSold(item);
    const stockSummary = Object.entries(item.stock || {}).map(([sz, q]) => `EU${sz}:${q}`).join(' · ') || 'No stock set';
    const checked = bulkSelected.has(item.id);
    const addedIso = itemAddedAt(item);
    return `
    <div class="admin-card ${checked ? 'bulk-selected' : ''}">
      <label class="bulk-check" title="Select for bulk actions">
        <input type="checkbox" data-bulk="${escapeHtml(item.id)}" ${checked ? 'checked' : ''}>
      </label>
      <img src="${item.image}" alt="${escapeHtml(item.name)}" loading="lazy">
      <div class="admin-card-body">
        <div class="admin-card-name">${escapeHtml(item.name)}</div>
        ${item.category ? `<div class="admin-card-cat-row"><span class="admin-card-cat">${escapeHtml(item.category)}</span></div>` : ''}
        <div class="admin-card-price">${fmtKsh(item.price)}<span class="admin-card-mobile-stock"> · ${units} in stock</span></div>
        <div class="admin-card-stock">${units} in stock · ${sold} sold | ${stockSummary}</div>
        ${addedIso ? `<div class="admin-card-added" title="Added ${new Date(addedIso).toLocaleString('en-KE')}">Added ${relTime(addedIso)}</div>` : ''}
        <div class="admin-card-actions">
          <button onclick="editItem('${item.id}')">Edit</button>
          <button onclick="openSaleModal('${item.id}')" style="background:#f0faf4;border-color:#b0d8c0;color:#1a7a40;">Sell</button>
          <button onclick="openRestockModal('${item.id}')">Restock</button>
          <button class="danger" onclick="deleteItem('${item.id}')">Delete</button>
        </div>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('input[data-bulk]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) bulkSelected.add(cb.dataset.bulk);
      else bulkSelected.delete(cb.dataset.bulk);
      cb.closest('.admin-card').classList.toggle('bulk-selected', cb.checked);
      renderBulkBar();
    });
  });
}

function renderBulkBar() {
  const bar = document.getElementById('bulkActions');
  if (!bar) return;
  if (bulkSelected.size === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  document.getElementById('bulkCount').textContent = bulkSelected.size;
}

function bulkClear() { bulkSelected.clear(); renderList(); }

function bulkSelectAll() { items.forEach(i => bulkSelected.add(i.id)); renderList(); }

async function bulkDelete() {
  if (!await confirmAction(`Delete ${bulkSelected.size} item(s)? This cannot be undone.`, 'Delete')) return;
  items = items.filter(i => !bulkSelected.has(i.id));
  bulkSelected.clear();
  saveData();
  renderList();
  renderInventory();
  renderDashboard();
  showToast('Deleted.');
}

async function bulkSetCategory() {
  const cat = await chooseCategory();
  if (!cat) return;
  items.forEach(i => { if (bulkSelected.has(i.id)) i.category = cat; });
  saveData();
  bulkSelected.clear();
  renderList();
  renderInventory();
  showToast(`Set ${bulkSelected.size || 'selected'} item(s) to "${cat}".`);
}

// ====== WHATSAPP BROADCAST ======
let broadcastSelectedIds = [];
let broadcastRecipientsState = {};

function pastBuyers() {
  // Unique past buyers, carrying the (category, size) pairs each bought so the
  // broadcast can be segmented (everyone who bought a category, or an EU size).
  const map = new Map();
  for (const item of items) {
    for (const s of (item.sales || [])) {
      if (!s.buyerPhone) continue;
      const phone = String(s.buyerPhone).replace(/[^0-9]/g, '');
      if (phone.length < 9) continue;
      const soldAt = new Date(s.soldAt || 0).getTime();
      let e = map.get(phone);
      if (!e) { e = { phone, name: '', soldAt: -1, lastBought: '', buys: [] }; map.set(phone, e); }
      e.buys.push({ cat: item.category || '', size: s.size || '' });
      if (soldAt >= e.soldAt) { e.soldAt = soldAt; e.lastBought = item.name; if (s.buyerName) e.name = s.buyerName; }
      else if (!e.name && s.buyerName) e.name = s.buyerName;
    }
  }
  // Manually-added clients with a phone are broadcast recipients too. They have no
  // purchase to segment by, so they only match an unsegmented (Any/Any) blast.
  for (const c of (Array.isArray(clients) ? clients : [])) {
    const phone = String(c.phone || '').replace(/[^0-9]/g, '');
    if (phone.length < 9) continue;
    const e = map.get(phone);
    if (e) { if (!e.name && c.name) e.name = c.name; continue; }
    map.set(phone, { phone, name: c.name || '', soldAt: new Date(c.createdAt || 0).getTime(), lastBought: '', buys: [] });
  }
  return [...map.values()].sort((a, b) => b.soldAt - a.soldAt);
}

// ===== Broadcast segmentation: filter recipients by category + EU size =====
let broadcastFilterCat = 'all';
let broadcastFilterSize = 'all';
function broadcastSortSizes(arr) {
  return arr.sort((a, b) => {
    const na = parseFloat(a), nb = parseFloat(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    if (!isNaN(na)) return -1;
    if (!isNaN(nb)) return 1;
    return String(a).localeCompare(String(b));
  });
}
function buyerMatchesFilter(b) {
  const buys = b.buys || [];
  // No purchase history (a manually-added contact) → only reachable in an
  // unsegmented broadcast; we can't claim they bought a given category/size.
  if (!buys.length) return broadcastFilterCat === 'all' && broadcastFilterSize === 'all';
  return buys.some(x =>
    (broadcastFilterCat === 'all' || x.cat === broadcastFilterCat) &&
    (broadcastFilterSize === 'all' || x.size === broadcastFilterSize));
}
function soldCategories() {
  const set = new Set();
  items.forEach(b => { if (b.category && (b.sales || []).length) set.add(b.category); });
  return [...set].sort();
}
function soldSizes(cat) {
  const set = new Set();
  items.forEach(b => { if (cat !== 'all' && b.category !== cat) return; (b.sales || []).forEach(s => { if (s.size) set.add(s.size); }); });
  return broadcastSortSizes([...set]);
}
function populateBroadcastFilters() {
  const catSel = document.getElementById('broadcastFilterCat');
  const sizeSel = document.getElementById('broadcastFilterSize');
  if (!catSel || !sizeSel) return;
  const cats = soldCategories();
  if (broadcastFilterCat !== 'all' && !cats.includes(broadcastFilterCat)) broadcastFilterCat = 'all';
  catSel.innerHTML = `<option value="all">Any category</option>` + cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  catSel.value = broadcastFilterCat;
  const sizes = soldSizes(broadcastFilterCat);
  if (broadcastFilterSize !== 'all' && !sizes.includes(broadcastFilterSize)) broadcastFilterSize = 'all';
  sizeSel.innerHTML = `<option value="all">Any size</option>` + sizes.map(s => `<option value="${escapeHtml(s)}">EU ${escapeHtml(s)}</option>`).join('');
  sizeSel.value = broadcastFilterSize;
}
document.getElementById('broadcastFilterCat')?.addEventListener('change', e => {
  broadcastFilterCat = e.target.value;
  broadcastFilterSize = 'all'; // sizes are category-specific — reset when category changes
  populateBroadcastFilters();
  renderBroadcastRecipients();
});
document.getElementById('broadcastFilterSize')?.addEventListener('change', e => {
  broadcastFilterSize = e.target.value;
  renderBroadcastRecipients();
});

function renderBroadcastSelected() {
  const wrap = document.getElementById('broadcastSelectedItems');
  if (!wrap) return;
  if (!broadcastSelectedIds.length) { wrap.innerHTML = '<p style="color:var(--ink-faint);font-size:13px;margin:6px 0;">No items selected — message will be text-only.</p>'; return; }
  wrap.innerHTML = broadcastSelectedIds.map(id => {
    const b = items.find(x => x.id === id);
    if (!b) return '';
    return `<div class="set-chip"><img src="${b.image}" alt=""><span>${escapeHtml(b.name)}</span><button data-bc-remove="${escapeHtml(id)}" aria-label="Remove">×</button></div>`;
  }).join('');
  wrap.querySelectorAll('[data-bc-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      broadcastSelectedIds = broadcastSelectedIds.filter(id => id !== btn.dataset.bcRemove);
      renderBroadcastSelected(); renderBroadcastPicker(); renderBroadcastPreview();
    });
  });
}

function renderBroadcastPicker() {
  const picker = document.getElementById('broadcastItemPicker');
  if (!picker) return;
  const q = (document.getElementById('broadcastItemSearch')?.value || '').toLowerCase().trim();
  const matches = items
    .filter(b => !broadcastSelectedIds.includes(b.id))
    .filter(b => !q || `${b.name} ${b.category || ''}`.toLowerCase().includes(q))
    .slice(0, 40);
  picker.innerHTML = matches.length
    ? matches.map(b => `
        <button class="set-pick" data-bc-add="${escapeHtml(b.id)}" type="button">
          <img src="${b.image}" alt="">
          <div class="set-pick-body">
            <div class="set-pick-name">${escapeHtml(b.name)}</div>
            <div class="set-pick-meta">${escapeHtml(b.category || '')}${b.price > 0 ? ' · ' + fmtKsh(b.price) : ''}</div>
          </div>
        </button>`).join('')
    : '<p style="color:var(--ink-faint);font-size:13px;padding:8px 0;">No matches.</p>';
  picker.querySelectorAll('[data-bc-add]').forEach(b => {
    b.addEventListener('click', () => {
      broadcastSelectedIds.push(b.dataset.bcAdd);
      renderBroadcastSelected(); renderBroadcastPicker(); renderBroadcastPreview();
    });
  });
}

function renderBroadcastRecipients() {
  const wrap = document.getElementById('broadcastRecipients');
  if (!wrap) return;
  populateBroadcastFilters();
  const all = pastBuyers();
  for (const b of all) {
    if (!(b.phone in broadcastRecipientsState)) {
      broadcastRecipientsState[b.phone] = { name: b.name, included: true };
    }
  }
  const buyers = all.filter(buyerMatchesFilter);
  const matchEl = document.getElementById('broadcastFilterMatch');
  if (matchEl) {
    const seg = (broadcastFilterCat === 'all' && broadcastFilterSize === 'all')
      ? 'all buyers'
      : [broadcastFilterCat === 'all' ? null : broadcastFilterCat, broadcastFilterSize === 'all' ? null : 'EU ' + broadcastFilterSize].filter(Boolean).join(' · ');
    matchEl.textContent = `${buyers.length} ${buyers.length === 1 ? 'buyer' : 'buyers'}${seg === 'all buyers' ? '' : ' · ' + seg}`;
  }
  if (!all.length) {
    wrap.innerHTML = '<p style="color:var(--ink-faint);font-size:13px;padding:8px 0;">No one to message yet. Record a sale with a buyer phone, or add a client with a phone in Clients below, and they\'ll appear here.</p>';
    return;
  }
  if (!buyers.length) {
    wrap.innerHTML = '<p style="color:var(--ink-faint);font-size:13px;padding:8px 0;">No buyers match this segment. Widen the category or size above.</p>';
    return;
  }
  wrap.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:8px;">
      <button class="btn-admin" type="button" data-bc-recip="all" style="padding:4px 10px;font-size:11px;">Select all</button>
      <button class="btn-admin" type="button" data-bc-recip="none" style="padding:4px 10px;font-size:11px;">Deselect all</button>
      <span style="font-size:12px;color:var(--ink-faint);margin-left:auto;align-self:center;" id="broadcastSelectedCount"></span>
    </div>
    ${buyers.map(b => {
      const st = broadcastRecipientsState[b.phone];
      return `
        <label class="broadcast-recipient${st.included ? ' on' : ''}">
          <input type="checkbox" data-bc-toggle="${b.phone}" ${st.included ? 'checked' : ''}>
          <span class="broadcast-recipient-name">${escapeHtml(b.name || 'Unknown buyer')}</span>
          <span class="broadcast-recipient-phone">+${b.phone}</span>
          <span class="broadcast-recipient-meta">${b.lastBought ? 'last: ' + escapeHtml(b.lastBought) : 'added as a contact'}</span>
        </label>`;
    }).join('')}`;
  wrap.querySelectorAll('[data-bc-toggle]').forEach(cb => {
    cb.addEventListener('change', () => {
      broadcastRecipientsState[cb.dataset.bcToggle].included = cb.checked;
      cb.closest('.broadcast-recipient').classList.toggle('on', cb.checked);
      updateBroadcastCount();
    });
  });
  wrap.querySelectorAll('[data-bc-recip]').forEach(btn => {
    btn.addEventListener('click', () => {
      const on = btn.dataset.bcRecip === 'all';
      buyers.forEach(b => { broadcastRecipientsState[b.phone].included = on; });
      renderBroadcastRecipients();
    });
  });
  updateBroadcastCount();
}

function updateBroadcastCount() {
  const el = document.getElementById('broadcastSelectedCount');
  if (!el) return;
  const n = Object.values(broadcastRecipientsState).filter(s => s.included).length;
  el.textContent = `${n} selected`;
}

function buildBroadcastMessage(recipientName) {
  const subject = (document.getElementById('broadcastSubject')?.value || '').trim();
  const selectedItems = broadcastSelectedIds.map(id => items.find(b => b.id === id)).filter(Boolean);
  const itemsBlock = selectedItems.length
    ? '\n\n' + selectedItems.map((b, i) => `${i + 1}. *${b.name}*${b.price > 0 ? ' · ' + fmtKsh(b.price) : ''}`).join('\n')
    : '';
  const greet = recipientName ? `Hi ${recipientName.split(' ')[0]}! ` : 'Hi! ';
  return `${greet}It's The Panache Store. ${subject || 'New ALDO styles just landed'}.${itemsBlock}\n\nBrowse the full collection: ${SHOP_URL}\n\nThe Panache Store 💜`;
}

function renderBroadcastPreview() {
  const preview = document.getElementById('broadcastPreview');
  if (!preview) return;
  preview.value = buildBroadcastMessage('{First name}');
}

document.getElementById('broadcastSubject')?.addEventListener('input', renderBroadcastPreview);
document.getElementById('broadcastItemSearch')?.addEventListener('input', renderBroadcastPicker);

document.getElementById('broadcastCopyBtn')?.addEventListener('click', () => {
  navigator.clipboard.writeText(buildBroadcastMessage(''));
  showToast('Message copied — paste into your WhatsApp broadcast.');
});

document.getElementById('broadcastStartBtn')?.addEventListener('click', async () => {
  const recipients = pastBuyers().filter(b => broadcastRecipientsState[b.phone]?.included);
  if (!recipients.length) { showToast('Pick at least one recipient.'); return; }
  if (!await confirmAction(`Open ${recipients.length} WhatsApp window${recipients.length === 1 ? '' : 's'}, one per buyer. Send each one manually. OK?`)) return;
  let i = 0;
  function next() {
    if (i >= recipients.length) {
      document.getElementById('broadcastStatus').textContent = `✓ Opened ${recipients.length} WhatsApp window${recipients.length === 1 ? '' : 's'}.`;
      return;
    }
    const r = recipients[i++];
    const msg = buildBroadcastMessage(r.name);
    window.open(`https://wa.me/${clientWaPhone(r.phone)}?text=${encodeURIComponent(msg)}`, '_blank');
    document.getElementById('broadcastStatus').textContent = `Opening ${i} of ${recipients.length}...`;
    setTimeout(next, 700);
  }
  next();
});

// ====== EXPOSE TO ONCLICK ======
window.editItem = editItem;
window.deleteItem = deleteItem;
window.openSaleModal = openSaleModal;
window.openRestockModal = openRestockModal;
window.undoSale = undoSale;
window.openEditSale = openEditSale;
window.bulkClear = bulkClear;
window.bulkSelectAll = bulkSelectAll;
window.bulkDelete = bulkDelete;
window.bulkSetCategory = bulkSetCategory;

// ====== INSIGHTS ======
function loadInsights() {
  try { return JSON.parse(localStorage.getItem(INSIGHTS_KEY) || '{}'); } catch { return {}; }
}

// Pull the shop-wide aggregate from the worker. Falls back to this device's
// localStorage only if the worker is unreachable (offline / down).
async function fetchInsights() {
  try {
    if (!settings.apiBase) return null;
    const res = await fetch(`${settings.apiBase}/api/insights`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    if (res.ok) return await res.json();
  } catch {}
  return null;
}
async function renderInsights() {
  const stats = (await fetchInsights()) || loadInsights();
  const grid = document.getElementById('insightsKpiGrid');
  if (!grid) return;

  const total = (map = {}) => Object.values(map).reduce((a, b) => a + b, 0);
  grid.innerHTML = [
    { label: 'Item views',    val: total(stats.itemViews),     sub: 'lightbox opens' },
    { label: 'Enquiries',     val: total(stats.itemEnquiries), sub: 'WhatsApp clicks', cls: 'success' },
    { label: 'Saved (heart)', val: total(stats.itemWishlist),  sub: 'wishlist adds' },
    { label: 'IG clicks',     val: total(stats.itemIgClicks),  sub: 'View on IG taps' },
  ].map(k => `
    <div class="inv-kpi ${k.cls || ''}">
      <div class="inv-kpi-label">${k.label}</div>
      <div class="inv-kpi-val">${(k.val || 0).toLocaleString()}</div>
      <div class="inv-kpi-sub">${k.sub}</div>
    </div>`).join('');

  function topItems(map = {}, n = 6) {
    return Object.entries(map)
      .map(([id, count]) => ({ id, count, item: items.find(i => i.id === id) }))
      .filter(x => x.item)
      .sort((a, b) => b.count - a.count).slice(0, n);
  }
  function renderTopList(list, emptyMsg) {
    if (!list.length) return `<p style="color:#999;font-size:13px;">${emptyMsg}</p>`;
    return list.map(x => `
      <div class="recent-row">
        <img src="${x.item.image}" alt="${escapeHtml(x.item.name)}">
        <div class="recent-body">
          <div class="recent-name">${escapeHtml(x.item.name)}</div>
          <div class="recent-meta">${x.count} ${x.count === 1 ? 'time' : 'times'} · ${escapeHtml(x.item.category || '')}</div>
        </div>
      </div>`).join('');
  }
  document.getElementById('insightsTopViews').innerHTML = renderTopList(topItems(stats.itemViews), 'No views yet.');
  document.getElementById('insightsTopEnquiries').innerHTML = renderTopList(topItems(stats.itemEnquiries), 'No enquiries yet.');

  const gapsEl = document.getElementById('insightsSearchGaps');
  const gaps = Object.entries(stats.searchNoResults || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  gapsEl.innerHTML = gaps.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:8px;">${gaps.map(([q, n]) => `<span class="search-gap-pill"><strong>"${escapeHtml(q)}"</strong> · ${n}×</span>`).join('')}</div>`
    : '<p style="color:#999;font-size:13px;">No empty searches yet — shoppers find what they look for.</p>';
}

document.getElementById('insightsResetBtn')?.addEventListener('click', async () => {
  if (accountSuspended) { showToast(SUSPENDED_MSG); return; }
  if (!await confirmAction('Reset Insights for the whole shop? This clears the site-wide totals from every device and cannot be undone.', 'Reset')) return;
  try {
    if (settings.apiBase) await fetch(`${settings.apiBase}/api/insights-reset`, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
  } catch {}
  localStorage.removeItem(INSIGHTS_KEY);
  await renderInsights();
  showToast('Insights reset for the whole shop.');
});

// ====== ADMIN ITEM SEARCH ======
const adminItemSearchInput = document.getElementById('adminItemSearch');
let adminSearchTimer;
adminItemSearchInput?.addEventListener('input', () => {
  clearTimeout(adminSearchTimer);
  adminSearchTimer = setTimeout(() => {
    adminItemSearch = adminItemSearchInput.value;
    renderList();
  }, 160);
});

// ====== INSTAGRAM BULK SYNC ======
// Pulls latest @thepanachekenya posts, runs them through the Worker's hybrid
// vision+text classifier, lets the owner review + tick, then commits to
// localStorage CLIENT-SIDE (Panache's items[] lives in localStorage, not KV,
// so the worker only suggests — admin writes).
//
// Architecture difference vs silvarkicks: silvarkicks POSTs the picks to
// /api/ig-sync which downloads images + writes to KV in one shot. Panache
// fetches images via /api/ig-proxy in the browser, base64-encodes them as
// data URLs (matching the existing IG quick-add and admin upload flow), and
// pushes the new item objects onto items[] directly.

const IG_USER_ID = '5474622302';  // @thepanachekenya — resolved once and hard-coded
const PANACHE_CATEGORIES = ['Heels', 'Flats', 'Sandals', 'Boots', 'Sneakers', 'Loafers', "Men's Shoes"];
// Worker token. Base64'd so it doesn't sit raw in the repo. Decode at runtime.
// Worker has the matching ADMIN_TOKEN secret set via `wrangler secret put`.
const ADMIN_TOKEN = atob('YjMwMzQzMzdmYzA3NjUwMGEwMWM2YzAyMzczMTA0M2MwZDAzN2JmMmYxYjNlYWI4NWM4ZDMwZmNiOWViZDAyMw==');
const SHOP_URL = 'https://thepanache.essenceautomations.com'; // public storefront — used in WhatsApp messages to clients

let igSyncCandidates = [];

const igSyncCheckBtn = document.getElementById('igSyncCheckBtn');
const igSyncCommitBtn = document.getElementById('igSyncCommitBtn');
const igSyncCancelBtn = document.getElementById('igSyncCancelBtn');
const igSyncStatus = document.getElementById('igSyncStatus');
const igSyncListEl = document.getElementById('igSyncList');
const igSyncCommitRow = document.getElementById('igSyncCommitRow');

igSyncCheckBtn?.addEventListener('click', checkForNewIgPosts);
igSyncCancelBtn?.addEventListener('click', resetIgSync);
igSyncCommitBtn?.addEventListener('click', commitIgSync);

async function checkForNewIgPosts() {
  if (accountSuspended) { igSyncStatus.textContent = SUSPENDED_MSG; return; }
  const apiBase = settings.apiBase || '';
  if (!apiBase) {
    igSyncStatus.textContent = '✗ settings.apiBase is not set in data.json — add it before using sync.';
    return;
  }
  igSyncCheckBtn.disabled = true;
  igSyncStatus.textContent = 'Checking Instagram…';
  igSyncListEl.innerHTML = '';
  igSyncCommitRow.style.display = 'none';
  try {
    const res = await fetch(`${apiBase}/api/ig-discover?user_id=${IG_USER_ID}&limit=20`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);

    // Dedup against current localStorage items[] — the worker doesn't dedup
    // because admin's items[] is the source of truth (often ahead of KV).
    const existingIds = new Set(items.map(i => i.id));
    const fresh = (data.items || []).filter(it => !existingIds.has(`ig_${it.shortcode}`));
    igSyncCandidates = fresh;

    if (!fresh.length) {
      igSyncStatus.textContent = '✓ Catalog is up to date. No new posts on Instagram.';
      igSyncCheckBtn.disabled = false;
      return;
    }
    igSyncStatus.textContent = `Found ${fresh.length} new post${fresh.length === 1 ? '' : 's'}. Review below, then add.`;
    renderIgSyncList();
    igSyncCommitRow.style.display = 'flex';
  } catch (err) {
    igSyncStatus.textContent = '✗ ' + err.message;
  } finally {
    igSyncCheckBtn.disabled = false;
  }
}

function renderIgSyncList() {
  igSyncListEl.innerHTML = igSyncCandidates.map((it, i) => {
    const s = it.suggested || {};
    // Stock object → "EU 36 · 37 · 38" pill text. Skip "One Size" placeholder
    // when there's nothing else, otherwise it reads as junk.
    const sizes = Object.keys(s.stock || {}).filter(k => k !== 'One Size');
    const stockText = sizes.length
      ? 'EU ' + sizes.join(' · ')
      : 'Pick size after adding';
    const captionShort = (it.caption || '').replace(/\s+/g, ' ').slice(0, 120);
    const catOpts = PANACHE_CATEGORIES.map(c => `<option value="${c}" ${c === s.category ? 'selected' : ''}>${c}</option>`).join('');
    return `
      <div class="ig-sync-row" data-idx="${i}">
        <label class="ig-sync-check">
          <input type="checkbox" data-ig-pick="${i}" checked>
        </label>
        <img src="${escapeHtml(it.imageUrl)}" alt="" referrerpolicy="no-referrer">
        <div class="ig-sync-body">
          <div class="ig-sync-row-1">
            <input type="text" class="ig-sync-name" data-ig-name="${i}" value="${escapeHtml(s.name || '')}" placeholder="Name">
            <select class="ig-sync-cat" data-ig-cat="${i}">${catOpts}</select>
          </div>
          <div class="ig-sync-row-2">
            <span class="ig-sync-size">${escapeHtml(stockText)}</span>
            <a href="${escapeHtml(it.postUrl)}" target="_blank" rel="noopener" class="ig-sync-postlink">view on IG ↗</a>
          </div>
          <div class="ig-sync-caption">${escapeHtml(captionShort)}</div>
        </div>
      </div>`;
  }).join('');
}

function resetIgSync() {
  igSyncCandidates = [];
  igSyncListEl.innerHTML = '';
  igSyncCommitRow.style.display = 'none';
  igSyncStatus.textContent = '';
}

// Reuse the same data-URL-from-IG pattern as the per-post quick-add (search
// downloadAndStage above): proxy through worker → blob → FileReader → data URL.
async function igStageImage(apiBase, imgUrl) {
  const proxied = `${apiBase}/api/ig-proxy?url=${encodeURIComponent(imgUrl)}`;
  const res = await fetch(proxied);
  if (!res.ok) throw new Error(`Image download failed (${res.status})`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);  // already "data:image/...;base64,..."
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function commitIgSync() {
  if (accountSuspended) { showToast(SUSPENDED_MSG); return; }
  const apiBase = settings.apiBase || '';
  if (!apiBase) { showToast('settings.apiBase missing.'); return; }
  const picks = [];
  igSyncCandidates.forEach((it, i) => {
    const cb = igSyncListEl.querySelector(`[data-ig-pick="${i}"]`);
    if (!cb || !cb.checked) return;
    const nameEl = igSyncListEl.querySelector(`[data-ig-name="${i}"]`);
    const catEl = igSyncListEl.querySelector(`[data-ig-cat="${i}"]`);
    picks.push({
      shortcode: it.shortcode,
      name: (nameEl?.value || it.suggested?.name || '').trim() || 'New Pair',
      category: catEl?.value || it.suggested?.category || 'Heels',
      stock: it.suggested?.stock || {},
      description: it.suggested?.description || '',
      imageUrls: it.imageUrls && it.imageUrls.length ? it.imageUrls : [it.imageUrl],
      postUrl: it.postUrl,
      takenAt: it.takenAt,
    });
  });
  if (!picks.length) { showToast('Tick at least one pair to add.'); return; }

  igSyncCommitBtn.disabled = true;
  igSyncCommitBtn.textContent = `Adding ${picks.length}…`;

  let added = 0;
  const errors = [];
  for (const p of picks) {
    try {
      // Skip if this shortcode somehow landed in items[] between Check and Add.
      const id = `ig_${p.shortcode}`;
      if (items.some(it => it.id === id)) {
        errors.push({ shortcode: p.shortcode, reason: 'already in catalog' });
        continue;
      }
      // Fetch up to 4 images and stage them as data URLs.
      const urls = (p.imageUrls || []).slice(0, 4);
      const dataUrls = [];
      for (const u of urls) {
        try {
          const d = await igStageImage(apiBase, u);
          dataUrls.push(d);
        } catch (e) {
          // Skip this image; carry on with whatever we got.
          console.warn('ig-proxy image failed', u, e);
        }
      }
      if (!dataUrls.length) {
        errors.push({ shortcode: p.shortcode, reason: 'all images failed to download' });
        continue;
      }
      const newItem = {
        id,
        name: p.name.slice(0, 80),
        category: p.category,
        description: p.description,
        price: 0,  // owner fills in via Edit
        stock: p.stock && typeof p.stock === 'object' ? { ...p.stock } : {},
        sales: [],
        image: dataUrls[0],
        postUrl: p.postUrl || `https://www.instagram.com/p/${p.shortcode}/`,
        createdAt: p.takenAt || new Date().toISOString(),
      };
      if (dataUrls.length > 1) newItem.images = dataUrls;
      items.unshift(newItem);
      added++;
      igSyncStatus.textContent = `Adding ${added}/${picks.length}…`;
    } catch (err) {
      errors.push({ shortcode: p.shortcode, reason: err.message });
    }
  }

  saveData();
  resetIgSync();
  renderList();
  renderDashboard();
  renderInventory();

  showToast(`Added ${added} pair${added === 1 ? '' : 's'} from Instagram.`);
  igSyncStatus.textContent = `✓ Added ${added}. ${errors.length ? `(${errors.length} failure${errors.length === 1 ? '' : 's'})` : 'Set the price and save to data.json.'}`;
  igSyncCommitBtn.disabled = false;
  igSyncCommitBtn.textContent = 'Add selected pairs';
}

// ====== INIT ======
// ====== CLIENTS (free CRM roster) ======
// Buyers from items[].sales[] + manually-added clients[], deduped by phone.
// Writes go through saveData() (panache's publish-on-save), not a fetch-merge.
let clientsQuery = '';
let clientsSort = 'recent';
function clientsLedger() {
  const map = new Map();
  for (const it of items) {
    for (const s of (it.sales || [])) {
      if (!s || !s.buyerPhone) continue;
      const phone = String(s.buyerPhone).replace(/[^0-9]/g, '');
      if (phone.length < 9) continue;
      const at = new Date(s.soldAt || 0).getTime();
      const amount = Number(s.salePrice || it.price || 0) * (Number(s.qty) || 1);
      let c = map.get(phone);
      if (!c) { c = { phone, name: '', purchases: [], spend: 0, lastAt: 0 }; map.set(phone, c); }
      c.purchases.push({ bagName: it.name, size: s.size || '', qty: Number(s.qty) || 1, amount, at: s.soldAt });
      c.spend += amount;
      if (at >= c.lastAt) { c.lastAt = at; if (s.buyerName) c.name = s.buyerName; }
      else if (!c.name && s.buyerName) c.name = s.buyerName;
    }
  }
  for (const mc of (clients || [])) {
    if (!mc || !mc.phone) continue;
    const phone = String(mc.phone).replace(/[^0-9]/g, '');
    if (phone.length < 9) continue;
    let c = map.get(phone);
    if (!c) { c = { phone, name: '', purchases: [], spend: 0, lastAt: 0 }; map.set(phone, c); }
    c.manualId = mc.id;
    if (mc.note) c.note = mc.note;
    if (!c.name && mc.name) c.name = mc.name;
    if (mc.createdAt) c.addedAt = mc.createdAt;
  }
  return [...map.values()];
}
function clientWaPhone(p) {
  let d = String(p).replace(/[^0-9]/g, '');
  if (d.startsWith('0')) d = '254' + d.slice(1);
  else if (d.length === 9) d = '254' + d;
  return d;
}
function renderClients() {
  const listEl = document.getElementById('clientsList');
  if (!listEl) return;
  const ledger = clientsLedger();
  const owedMap = owedByPhone();
  const totalSpend = ledger.reduce((s, c) => s + c.spend, 0);
  const repeat = ledger.filter(c => c.purchases.length >= 2).length;
  const avg = ledger.length ? Math.round(totalSpend / ledger.length) : 0;
  const nav = document.getElementById('navClientsCount'); if (nav) nav.textContent = ledger.length || '';
  const kpi = document.getElementById('clientsKpiGrid');
  if (kpi) kpi.innerHTML = `
    <div class="inv-kpi"><div class="inv-kpi-label">Clients</div><div class="inv-kpi-val">${ledger.length}</div><div class="inv-kpi-sub">${repeat} repeat buyer${repeat === 1 ? '' : 's'}</div></div>
    <div class="inv-kpi success"><div class="inv-kpi-label">Total spent</div><div class="inv-kpi-val">${fmtKsh(totalSpend)}</div><div class="inv-kpi-sub">across all clients</div></div>
    <div class="inv-kpi"><div class="inv-kpi-label">Avg per client</div><div class="inv-kpi-val">${fmtKsh(avg)}</div><div class="inv-kpi-sub">lifetime value</div></div>
    <div class="inv-kpi"><div class="inv-kpi-label">Repeat rate</div><div class="inv-kpi-val">${ledger.length ? Math.round(repeat / ledger.length * 100) : 0}%</div><div class="inv-kpi-sub">bought 2+ times</div></div>
  `;
  if (!ledger.length) {
    listEl.innerHTML = '<p style="font-size:13px;color:#999;padding:14px;">No clients yet. Record a sale with a buyer, or use + Add client.</p>';
    return;
  }
  const q = clientsQuery.toLowerCase();
  const rows = ledger
    .filter(c => !q || (c.name || '').toLowerCase().includes(q) || c.phone.includes(q))
    .sort((a, b) =>
      clientsSort === 'spend' ? b.spend - a.spend :
      clientsSort === 'purchases' ? b.purchases.length - a.purchases.length :
      b.lastAt - a.lastAt);
  if (!rows.length) { listEl.innerHTML = '<p style="font-size:13px;color:#999;padding:14px;">No clients match your search.</p>'; return; }
  listEl.innerHTML = rows.map(c => {
    const its = c.purchases.slice()
      .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))
      .map(p => `<span class="client-item">${escapeHtml(p.bagName)}${p.size ? ' · EU ' + escapeHtml(p.size) : ''} × ${p.qty} · ${fmtKsh(p.amount)}</span>`).join('');
    const has = c.purchases.length;
    const when = has ? `last ${relTime(new Date(c.lastAt).toISOString())}`
                     : (c.addedAt ? `added ${relTime(c.addedAt)}` : 'no purchases yet');
    const manualTag = c.manualId ? '<span class="client-tag">Added manually</span>' : '';
    const noteLine = c.note ? `<div class="client-note">${escapeHtml(c.note)}</div>` : '';
    // Remove only for a manual contact with NO purchases (added by mistake). A
    // client who has bought is real sales history — no one-tap remove.
    const removeBtn = (c.manualId && !has) ? `<button class="btn-admin danger" onclick="removeClient('${c.manualId}')">Remove</button>` : '';
    return `
      <div class="client-row">
        <div class="client-row-main">
          <div class="client-row-name">${escapeHtml(c.name || 'Unnamed buyer')}${manualTag}</div>
          <div class="client-row-sub">${escapeHtml(c.phone)} · ${has} purchase${has === 1 ? '' : 's'} · ${fmtKsh(c.spend)} spent · ${when}${owedMap[c.phone] > 0 ? ` · <span class="owed-amount">owes ${fmtKsh(owedMap[c.phone])}</span>` : ''}</div>
          ${noteLine}
          <div class="client-items">${its}</div>
        </div>
        <div class="client-row-actions">
          <button class="btn-admin gold" onclick="clientMessage('${c.phone}')">WhatsApp</button>
          ${removeBtn}
        </div>
      </div>`;
  }).join('');
}
window.clientMessage = phone => {
  const c = clientsLedger().find(x => x.phone === phone);
  const first = (c && c.name ? c.name : 'there').split(' ')[0];
  const msg = `Hi ${first}! Thanks for shopping with The Panache. Fresh pieces just landed. Browse what's new here: ${SHOP_URL}\n\nThe Panache Store 💜`;
  window.open(`https://wa.me/${clientWaPhone(phone)}?text=${encodeURIComponent(msg)}`, '_blank');
};
// "Item bought" autocomplete: type → tappable in-stock items → pick to record a sale.
let acItemId = '';
function acRenderResults(q) {
  const box = document.getElementById('addClientItemResults');
  const query = (q || '').toLowerCase();
  if (!query) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const matches = items.filter(it => (it.name || '').toLowerCase().includes(query)).slice(0, 12);
  box.innerHTML = matches.length
    ? matches.map(it => {
        const units = Object.values(it.stock || {}).reduce((s, n) => s + (Number(n) || 0), 0);
        return `<button type="button" class="client-item-opt" data-id="${it.id}">${escapeHtml(it.name)}<span>${units} in stock</span></button>`;
      }).join('')
    : '<div class="client-item-empty">No items match.</div>';
  box.style.display = '';
}
function acSelectItem(id) {
  const it = items.find(x => x.id === id);
  if (!it) return;
  acItemId = id;
  document.getElementById('addClientItemSearch').value = it.name;
  document.getElementById('addClientItemResults').style.display = 'none';
  const sizeSel = document.getElementById('addClientSize');
  sizeSel.innerHTML = '';
  const inStock = Object.entries(it.stock || {}).filter(([, q]) => q > 0);
  if (inStock.length) {
    inStock.forEach(([sz, q]) => { const o = document.createElement('option'); o.value = sz; o.textContent = `EU ${sz} (${q} in stock)`; sizeSel.appendChild(o); });
  } else {
    const o = document.createElement('option'); o.value = 'One size'; o.textContent = 'One size'; sizeSel.appendChild(o);
  }
  document.getElementById('addClientQty').value = 1;
  document.getElementById('addClientPrice').value = it.price || 0;
  document.getElementById('addClientChosen').innerHTML = `Recording a sale for <strong>${escapeHtml(it.name)}</strong> · <button type="button" id="addClientClearItem">clear</button>`;
  document.getElementById('addClientChosen').style.display = '';
  document.getElementById('addClientSaleFields').style.display = '';
}
function acClearItem() {
  acItemId = '';
  document.getElementById('addClientItemSearch').value = '';
  document.getElementById('addClientItemResults').style.display = 'none';
  document.getElementById('addClientChosen').style.display = 'none';
  document.getElementById('addClientSaleFields').style.display = 'none';
}
function openAddClient() {
  document.getElementById('addClientName').value = '';
  document.getElementById('addClientPhone').value = '';
  document.getElementById('addClientNote').value = '';
  acClearItem();
  document.getElementById('addClientModal').style.display = 'flex';
  document.getElementById('addClientName').focus();
}
function closeAddClient() { document.getElementById('addClientModal').style.display = 'none'; }
document.getElementById('clientsAddBtn')?.addEventListener('click', openAddClient);
document.getElementById('addClientCancelBtn')?.addEventListener('click', closeAddClient);
document.getElementById('addClientModal')?.addEventListener('click', e => { if (e.target.id === 'addClientModal') closeAddClient(); });
document.getElementById('addClientItemSearch')?.addEventListener('input', e => {
  acItemId = '';
  document.getElementById('addClientChosen').style.display = 'none';
  document.getElementById('addClientSaleFields').style.display = 'none';
  acRenderResults(e.target.value.trim());
});
document.getElementById('addClientItemResults')?.addEventListener('click', e => {
  const opt = e.target.closest('.client-item-opt');
  if (opt) acSelectItem(opt.dataset.id);
});
document.getElementById('addClientChosen')?.addEventListener('click', e => {
  if (e.target.id === 'addClientClearItem') acClearItem();
});
document.getElementById('addClientSaveBtn')?.addEventListener('click', () => {
  const name = document.getElementById('addClientName').value.trim();
  const phone = document.getElementById('addClientPhone').value.trim().replace(/[^0-9+]/g, '');
  const note = document.getElementById('addClientNote').value.trim();
  if (!name) { showToast('Enter a name.'); return; }
  if (phone.replace(/[^0-9]/g, '').length < 9) { showToast('Enter a valid phone number.'); return; }
  const itemId = acItemId;
  if (!Array.isArray(clients)) clients = [];
  const norm = phone.replace(/[^0-9]/g, '');
  const existing = clients.find(c => String(c.phone).replace(/[^0-9]/g, '') === norm);
  if (existing) { existing.name = name; existing.note = note; }
  else clients.push({ id: 'c_' + Date.now(), name, phone, note, createdAt: new Date().toISOString() });
  if (itemId) {
    const it = items.find(x => x.id === itemId);
    if (it) {
      const size = document.getElementById('addClientSize').value;
      const qty = parseInt(document.getElementById('addClientQty').value, 10) || 1;
      const salePrice = parseInt(document.getElementById('addClientPrice').value, 10) || it.price;
      if (it.stock && it.stock[size] !== undefined) it.stock[size] = Math.max(0, it.stock[size] - qty);
      if (!it.sales) it.sales = [];
      it.sales.push({ size, qty, salePrice, buyerName: name, buyerPhone: phone, notes: note, soldAt: new Date().toISOString() });
    }
  }
  saveData();
  closeAddClient();
  renderList(); renderDashboard(); renderInventory(); renderClients();
  showToast(itemId ? 'Client saved + sale recorded.' : 'Client saved.');
});
window.removeClient = async (id) => {
  if (!await confirmAction('Remove this client from your list? Their past sales (if any) stay in your records.', 'Remove')) return;
  clients = (clients || []).filter(c => c.id !== id);
  saveData();
  renderClients();
  showToast('Client removed.');
};
document.getElementById('clientsSearch')?.addEventListener('input', e => { clientsQuery = e.target.value.trim(); renderClients(); });
document.getElementById('clientsSort')?.addEventListener('change', e => { clientsSort = e.target.value; renderClients(); });
// "NEW" badge on the Clients nav link — kept permanently visible (no auto-dismiss).

async function init() {
  const catSel = document.getElementById('catInput');
  if (catSel) catSel.addEventListener('change', toggleNewCategoryInput);
  await loadData();
  await loadSuspendedFlag();
  renderSuspendedBanner();
  renderList();
  renderDashboard();
  renderInventory();
  renderBroadcastSelected();
  renderBroadcastPicker();
  renderBroadcastRecipients();
  renderBroadcastPreview();
  renderInsights();
  renderClients();
  initNavScrollSpy();
}

/* ===== Nav scrollspy — highlight the section currently in view ===== */
function initNavScrollSpy() {
  const nav = document.getElementById('adminNav');
  if (!nav) return;
  const items = Array.from(nav.querySelectorAll('a[href^="#"]'))
    .map(a => ({ a, section: document.getElementById(a.getAttribute('href').slice(1)) }))
    .filter(x => x.section);
  if (!items.length) return;

  let ticking = false;
  function update() {
    ticking = false;
    const probe = nav.offsetHeight + 24; // line just below the sticky nav
    let current = items[0];
    for (const item of items) {
      if (item.section.getBoundingClientRect().top - probe <= 0) current = item;
    }
    // near the bottom of the page → activate the last section
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) {
      current = items[items.length - 1];
    }
    items.forEach(({ a }) => a.classList.toggle('active', a === current.a));
  }
  function onScroll() {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  update();
}

// ====== POS — SELL IN STORE (counter checkout) + RECEIPTS ======
// Panache persists via saveData() (localStorage + /api/bulk), uses items[].
let posItemId = '';
let posPayMethod = 'mpesa';
let lastPosSale = null;
function posWaPhone(p) { let d = String(p || '').replace(/[^0-9]/g, ''); if (d.startsWith('0')) d = '254' + d.slice(1); else if (d.startsWith('7') || d.startsWith('1')) d = '254' + d; return d; }
function posRenderResults(q) {
  const box = document.getElementById('posItemResults');
  const query = (q || '').toLowerCase();
  if (!query) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const matches = items.filter(b => (b.name || '').toLowerCase().includes(query)).slice(0, 12);
  box.innerHTML = matches.length
    ? matches.map(b => { const units = Object.values(b.stock || {}).reduce((s, n) => s + (Number(n) || 0), 0); const meta = Object.keys(b.stock || {}).length ? `${units} in stock` : fmtKsh(b.price); return `<button type="button" class="client-item-opt" data-id="${b.id}">${escapeHtml(b.name)}<span>${meta}</span></button>`; }).join('')
    : '<div class="client-item-empty">No items match.</div>';
  box.style.display = '';
}
function posSelectItem(id) {
  const it = items.find(b => b.id === id); if (!it) return;
  posItemId = id;
  document.getElementById('posItemSearch').value = it.name;
  document.getElementById('posItemResults').style.display = 'none';
  const sizeSel = document.getElementById('posSize'); sizeSel.innerHTML = '';
  const inStock = Object.entries(it.stock || {}).filter(([, q]) => q > 0);
  if (inStock.length) inStock.forEach(([sz, q]) => { const o = document.createElement('option'); o.value = sz; o.textContent = `EU ${sz} (${q} in stock)`; sizeSel.appendChild(o); });
  else { const o = document.createElement('option'); o.value = 'One size'; o.textContent = 'One size'; sizeSel.appendChild(o); }
  document.getElementById('posQty').value = 1;
  document.getElementById('posPrice').value = (it.salePrice > 0 && it.salePrice < it.price) ? it.salePrice : (it.price || '');
  document.getElementById('posChosen').innerHTML = `Selling <strong>${escapeHtml(it.name)}</strong> · <button type="button" id="posClearItem">change</button>`;
  document.getElementById('posChosen').style.display = '';
  document.getElementById('posSaleFields').style.display = '';
  document.getElementById('posReceiptPanel').style.display = 'none';
}
function posReset() {
  posItemId = ''; posPayMethod = 'mpesa';
  ['posItemSearch', 'posBuyerName', 'posBuyerPhone'].forEach(i => { const el = document.getElementById(i); if (el) el.value = ''; });
  document.getElementById('posItemResults').style.display = 'none';
  document.getElementById('posChosen').style.display = 'none';
  document.getElementById('posSaleFields').style.display = 'none';
  document.getElementById('posReceiptPanel').style.display = 'none';
  document.getElementById('posCustomerFields').style.display = '';
  document.querySelectorAll('#posPay .pos-pay-btn').forEach(b => b.classList.toggle('active', b.dataset.pay === 'mpesa'));
}
function posReceiptText(s) {
  const total = s.amount * s.qty;
  return [`*The Panache Store* receipt`, `${s.name} (EU ${s.size}) x${s.qty}`, `Total: ${fmtKsh(total)}. Paid by ${s.paymentMethod === 'mpesa' ? 'M-Pesa' : 'Cash'}.`, `Thank you for shopping with us!`].join('\n');
}
function showPosReceipt(s) {
  document.getElementById('posSaleFields').style.display = 'none';
  document.getElementById('posChosen').style.display = 'none';
  document.getElementById('posItemSearch').value = '';
  const total = s.amount * s.qty; const pay = s.paymentMethod === 'mpesa' ? 'M-Pesa' : 'Cash';
  document.getElementById('posReceiptSummary').innerHTML = `<strong>${escapeHtml(s.name)}</strong> · EU ${escapeHtml(String(s.size))} · ${s.qty} pair(s)<br>${fmtKsh(total)} · paid by ${pay}`;
  const wa = document.getElementById('posWaReceiptBtn');
  if (s.buyerPhone && s.buyerPhone.replace(/[^0-9]/g, '').length >= 9) { wa.href = `https://wa.me/${posWaPhone(s.buyerPhone)}?text=${encodeURIComponent(posReceiptText(s))}`; wa.style.display = ''; }
  else { wa.style.display = 'none'; }
  const imgBtn = document.getElementById('posImgReceiptBtn'); // Shop Manager (5k)+ only
  if (imgBtn) imgBtn.style.display = RECEIPT_IMAGE_ENABLED ? '' : 'none';
  document.getElementById('posReceiptPanel').style.display = '';
}
function posPrintReceipt() {
  if (!lastPosSale) return;
  const s = lastPosSale, total = s.amount * s.qty, d = new Date(s.soldAt);
  document.getElementById('posReceiptPrint').innerHTML = `
    <div class="rcpt">
      <div class="rcpt-head">The Panache Store</div>
      <div class="rcpt-sub">0734 737 373</div>
      <hr>
      <div class="rcpt-row"><span>${escapeHtml(s.name)}</span></div>
      <div class="rcpt-row"><span>EU ${escapeHtml(String(s.size))} · ${s.qty} × ${fmtKsh(s.amount)}</span><span>${fmtKsh(total)}</span></div>
      <hr>
      <div class="rcpt-row rcpt-total"><span>TOTAL</span><span>${fmtKsh(total)}</span></div>
      <div class="rcpt-row"><span>Paid by</span><span>${s.paymentMethod === 'mpesa' ? 'M-Pesa' : 'Cash'}</span></div>
      <div class="rcpt-date">${d.toLocaleString('en-GB')}</div>
      <div class="rcpt-foot">Thank you for shopping with us!</div>
    </div>`;
  window.print();
}

// --- Image receipt (canvas PNG) — Shop Manager (5k)+ feature ---------------
// Pure canvas (no library) so it works inside the WhatsApp / IG in-app browser.
// Logo is same-origin (images/logo.jpg) so the canvas never taints on export.
const RECEIPT_IMAGE_ENABLED = true;
const RCPT_BRAND = { name: 'The Panache Store', gold: '#f5a820', goldDeep: '#d48c10', ink: '#1a0a2e', inkSoft: '#4a3060', faint: '#8a7a99', line: '#ede8f0', addr: ['0734 737 373'], url: 'thepanache.essenceautomations.com', sizePrefix: 'EU ' };
let _receiptLogo = null;
function loadReceiptLogo() {
  if (_receiptLogo !== null) return Promise.resolve(_receiptLogo || null);
  return new Promise(res => {
    const img = new Image();
    img.onload = () => { _receiptLogo = img; res(img); };
    img.onerror = () => { _receiptLogo = false; res(null); };
    img.src = 'images/logo.jpg';
  });
}
function buildReceiptCanvas(s, logoImg, B) {
  const SCALE = 3, W = 620, M = 44;
  const qty = Number(s.qty) || 1;
  const total = (Number(s.amount) || 0) * qty;
  const hasBal = s.balance > 0;
  const detail = [];
  if (s.size) detail.push((B.sizePrefix || '') + s.size);
  if (s.size || qty > 1) detail.push(`${qty} × ${fmtKsh(s.amount)}`);
  const subLine = detail.join(' · ');
  const seg = { top: 34, logo: logoImg ? 132 : 88, caption: 30, addr: B.addr.length > 1 ? 46 : 30, div1: 26,
    item: subLine ? 64 : 44, div2: 26, total: 52, cust: s.buyerName ? 34 : 0, paid: 34, bal: hasBal ? 70 : 0, date: 38, foot: 60, bottom: 30 };
  const H = Object.values(seg).reduce((a, b) => a + b, 0);
  const c = document.createElement('canvas');
  c.width = W * SCALE; c.height = H * SCALE;
  const x = c.getContext('2d'); x.scale(SCALE, SCALE);
  const trunc = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  x.fillStyle = '#fffdf8'; x.fillRect(0, 0, W, H);
  x.fillStyle = B.gold; x.fillRect(0, 0, W, 6);
  let y = seg.top;
  x.textAlign = 'center';
  if (logoImg) {
    const lw = 150, lh = Math.min(lw * (logoImg.height / logoImg.width || 1), 118);
    x.drawImage(logoImg, (W - lw) / 2, y, lw, lh);
  } else { x.fillStyle = B.ink; x.font = '600 32px Georgia, serif'; x.fillText(B.name, W / 2, y + 38); }
  y += seg.logo;
  x.fillStyle = B.goldDeep; x.font = '600 15px Arial'; x.fillText('S A L E   R E C E I P T', W / 2, y); y += seg.caption;
  x.fillStyle = B.faint; x.font = '13px Arial'; B.addr.forEach((line, i) => x.fillText(line, W / 2, y + i * 18)); y += seg.addr;
  const div = () => { x.strokeStyle = B.line; x.lineWidth = 1; x.beginPath(); x.moveTo(M, y); x.lineTo(W - M, y); x.stroke(); };
  div(); y += seg.div1;
  x.textAlign = 'left'; x.fillStyle = B.ink; x.font = '600 18px Arial'; x.fillText(trunc(s.name, 32), M, y + 6);
  if (subLine) {
    x.fillStyle = B.faint; x.font = '14px Arial'; x.fillText(subLine, M, y + 30);
    x.textAlign = 'right'; x.fillStyle = B.ink; x.font = '600 18px Arial'; x.fillText(fmtKsh(total), W - M, y + 30);
  } else { x.textAlign = 'right'; x.fillStyle = B.ink; x.font = '600 18px Arial'; x.fillText(fmtKsh(total), W - M, y + 6); }
  y += seg.item;
  x.textAlign = 'left'; div(); y += seg.div2;
  x.fillStyle = B.ink; x.font = '700 22px Arial'; x.fillText('TOTAL', M, y + 8);
  x.textAlign = 'right'; x.fillStyle = B.goldDeep; x.font = '700 24px Arial'; x.fillText(fmtKsh(total), W - M, y + 8); y += seg.total;
  if (s.buyerName) {
    x.textAlign = 'left'; x.fillStyle = B.inkSoft; x.font = '15px Arial'; x.fillText('Customer', M, y);
    x.textAlign = 'right'; x.fillStyle = B.ink; x.font = '600 15px Arial'; x.fillText(trunc(s.buyerName, 26), W - M, y); y += seg.cust;
  }
  x.textAlign = 'left'; x.fillStyle = B.inkSoft; x.font = '15px Arial'; x.fillText('Paid by', M, y);
  x.textAlign = 'right'; x.fillStyle = B.ink; x.font = '600 15px Arial'; x.fillText(s.paymentMethod === 'mpesa' ? 'M-Pesa' : 'Cash', W - M, y); y += seg.paid;
  if (hasBal) {
    x.textAlign = 'left'; x.fillStyle = B.inkSoft; x.font = '15px Arial'; x.fillText('Paid now', M, y);
    x.textAlign = 'right'; x.fillStyle = B.ink; x.font = '600 15px Arial'; x.fillText(fmtKsh(s.paid), W - M, y); y += 34;
    x.textAlign = 'left'; x.fillStyle = '#b00020'; x.font = '700 16px Arial'; x.fillText('BALANCE OWING', M, y);
    x.textAlign = 'right'; x.fillText(fmtKsh(s.balance), W - M, y); y += 36;
  }
  x.textAlign = 'center'; x.fillStyle = B.faint; x.font = '13px Arial';
  x.fillText(new Date(s.soldAt || Date.now()).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }), W / 2, y); y += seg.date;
  x.fillStyle = B.goldDeep; x.font = 'italic 16px Georgia, serif'; x.fillText('Thank you for shopping with us', W / 2, y);
  x.fillStyle = B.gold; x.font = '600 13px Arial'; x.fillText(B.url, W / 2, y + 24);
  return c;
}
async function posShareReceiptImage() {
  if (!lastPosSale) return;
  const btn = document.getElementById('posImgReceiptBtn');
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  try {
    const logo = await loadReceiptLogo();
    const canvas = buildReceiptCanvas(lastPosSale, logo, RCPT_BRAND);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('render failed');
    const fname = `panache-receipt-${(lastPosSale.name || 'sale').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 28)}.png`;
    const file = new File([blob], fname, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: RCPT_BRAND.name + ' receipt', text: posReceiptText(lastPosSale) });
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      showToast('Receipt image saved to your phone — attach it in WhatsApp.');
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    showToast('Could not make the receipt image: ' + (e.message || e));
  } finally { if (btn) { btn.disabled = false; btn.textContent = orig; } }
}
function recordPosSale() {
  const targetId = posItemId;
  if (!targetId) { showToast('Pick an item first.'); return; }
  const it = items.find(x => x.id === targetId);
  if (!it) { showToast('Item not found — refresh.'); return; }
  const size = document.getElementById('posSize').value;
  const qty = parseInt(document.getElementById('posQty').value, 10) || 1;
  const priceRaw = parseInt(document.getElementById('posPrice').value, 10);
  const amount = isNaN(priceRaw) ? (Number(it.price) || 0) : priceRaw;
  const name = document.getElementById('posBuyerName').value.trim();
  const phone = document.getElementById('posBuyerPhone').value.trim().replace(/[^0-9+]/g, '');
  const soldAt = new Date().toISOString();
  if (it.stock && it.stock[size] !== undefined) it.stock[size] = Math.max(0, it.stock[size] - qty);
  if (!it.sales) it.sales = [];
  // Owed feature: capture cash now (blank = paid in full)
  const _posSaleRec = { size, qty, salePrice: amount, paymentMethod: posPayMethod, channel: 'shop', buyerName: name, buyerPhone: phone, notes: '', soldAt };
  const _posPaidRaw = (document.getElementById('posPaid')?.value || '').trim();
  if (_posPaidRaw !== '') {
    const _posTotalNow = (Number(amount) || 0) * (Number(qty) || 1);
    _posSaleRec.amountPaid = Math.min(_posTotalNow, Math.max(0, parseInt(_posPaidRaw, 10) || 0));
  }
  it.sales.push(_posSaleRec);
  if (phone.replace(/[^0-9]/g, '').length >= 9) {
    if (!Array.isArray(clients)) clients = [];
    const norm = phone.replace(/[^0-9]/g, '');
    const existing = clients.find(c => String(c.phone).replace(/[^0-9]/g, '') === norm);
    if (existing) { if (name) existing.name = name; }
    else clients.push({ id: 'c_' + Date.now(), name: name || '', phone, note: '', createdAt: soldAt });
  }
  saveData();
  renderList(); renderDashboard(); renderInventory(); if (typeof renderClients === 'function') renderClients();
  lastPosSale = { name: it.name, size, qty, amount, paymentMethod: posPayMethod, buyerName: name, buyerPhone: phone, soldAt };
  showPosReceipt(lastPosSale);
  showToast(`Sold ${qty}× EU ${size} · ${fmtKsh(amount * qty)}`);
}
document.getElementById('posItemSearch')?.addEventListener('input', e => { posItemId = ''; document.getElementById('posSaleFields').style.display = 'none'; document.getElementById('posChosen').style.display = 'none'; posRenderResults(e.target.value.trim()); });
document.getElementById('posItemResults')?.addEventListener('click', e => { const opt = e.target.closest('.client-item-opt'); if (opt) posSelectItem(opt.dataset.id); });
document.getElementById('posChosen')?.addEventListener('click', e => { if (e.target.id === 'posClearItem') posReset(); });
document.getElementById('posPay')?.addEventListener('click', e => { const b = e.target.closest('.pos-pay-btn'); if (!b) return; posPayMethod = b.dataset.pay; document.querySelectorAll('#posPay .pos-pay-btn').forEach(x => x.classList.toggle('active', x === b)); });
document.getElementById('posAddCustomerToggle')?.addEventListener('click', () => { const f = document.getElementById('posCustomerFields'); f.style.display = f.style.display === 'none' ? '' : 'none'; });
document.getElementById('posRecordBtn')?.addEventListener('click', recordPosSale);
document.getElementById('posCancelBtn')?.addEventListener('click', posReset);
document.getElementById('posNewSaleBtn')?.addEventListener('click', posReset);
document.getElementById('posPrintReceiptBtn')?.addEventListener('click', posPrintReceipt);
document.getElementById('posImgReceiptBtn')?.addEventListener('click', posShareReceiptImage);

// ===== Mobile-safe collapsible toggles (fleet rollout 2026-06-11) =====
// JS-driven (preventDefault + flip .open) — a <summary> with display:flex breaks
// native <details> toggling in mobile WebKit. See CATALOG-STANDARDS.md.
(function () {
  var manualEntry = document.getElementById('manualEntry');
  var manualSummary = document.getElementById('manualEntryDivider');
  if (manualSummary) manualSummary.addEventListener('click', function (e) { e.preventDefault(); if (manualEntry) manualEntry.open = !manualEntry.open; });
  var addLink = document.querySelector('.admin-nav a[href="#addForm"]');
  if (addLink) addLink.addEventListener('click', function () { if (manualEntry) manualEntry.open = true; });

  var broadcastCollapse = document.getElementById('broadcastCollapse');
  var broadcastSummary = broadcastCollapse ? broadcastCollapse.querySelector('summary.dash-summary') : null;
  if (broadcastSummary) broadcastSummary.addEventListener('click', function (e) { e.preventDefault(); broadcastCollapse.open = !broadcastCollapse.open; });
  var bcLink = document.querySelector('.admin-nav a[href="#broadcastDash"]');
  if (bcLink) bcLink.addEventListener('click', function () { if (broadcastCollapse) broadcastCollapse.open = true; });
})();

checkAuth();


// ====== MONEY OWED — customer balances (buying on credit / pay later) ======
// Each sale carries an optional amountPaid (cash taken at the moment of sale)
// and a payments[] array (subsequent part-payments). Absent amountPaid is
// treated as paid in full so historical sales never appear as owing.
function saleTotal(item, s) { return (Number(s.salePrice != null ? s.salePrice : item.price) || 0) * (Number(s.qty) || 1); }
function salePaid(item, s) {
  const total = saleTotal(item, s);
  const initial = (s.amountPaid != null) ? Math.max(0, Number(s.amountPaid) || 0) : total;
  const extra = (s.payments || []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  return Math.min(total, initial + extra);
}
function saleBalance(item, s) { return Math.max(0, saleTotal(item, s) - salePaid(item, s)); }

function owedByPhone() {
  const m = {};
  for (const it of items) for (const s of (it.sales || [])) {
    const bal = saleBalance(it, s);
    if (bal <= 0) continue;
    const phone = String(s.buyerPhone || '').replace(/[^0-9]/g, '');
    if (phone.length < 9) continue;
    m[phone] = (m[phone] || 0) + bal;
  }
  return m;
}
function owedLedger() {
  const map = new Map();
  for (const it of items) for (const s of (it.sales || [])) {
    const bal = saleBalance(it, s);
    if (bal <= 0) continue;
    const phone = String(s.buyerPhone || '').replace(/[^0-9]/g, '');
    const hasPhone = phone.length >= 9;
    const key = hasPhone ? phone : ('__nophone__' + it.id + (s.soldAt || ''));
    let c = map.get(key);
    if (!c) { c = { phone: hasPhone ? phone : '', name: s.buyerName || '', owed: 0, lines: [], _lastAt: 0 }; map.set(key, c); }
    c.owed += bal;
    c.lines.push({ itemId: it.id, soldAt: s.soldAt, itemName: it.name, size: s.size || '', total: saleTotal(it, s), balance: bal, at: s.soldAt, notes: s.notes || '' });
    const at = new Date(s.soldAt || 0).getTime();
    if (s.buyerName && at >= c._lastAt) { c.name = s.buyerName; c._lastAt = at; }
    else if (!c.name && s.buyerName) c.name = s.buyerName;
  }
  return [...map.values()];
}

function _fmtOwedDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch (e) { return ''; }
}

let owedQuery = '';
function renderOwed() {
  const listEl = document.getElementById('owedList');
  if (!listEl) return;
  const ledger = owedLedger();
  const totalOwed = ledger.reduce((s, c) => s + c.owed, 0);
  const withPhone = ledger.filter(c => c.phone);
  let oldest = null;
  ledger.forEach(c => c.lines.forEach(l => { const t = new Date(l.at || 0).getTime(); if (t && (oldest === null || t < oldest)) oldest = t; }));

  const nav = document.getElementById('navOwedCount'); if (nav) nav.textContent = ledger.length || '';
  const navLink = document.getElementById('owedNavLink'); if (navLink) navLink.classList.toggle('admin-nav-owed-on', totalOwed > 0);

  const kpi = document.getElementById('owedKpiGrid');
  if (kpi) kpi.innerHTML = `
    <div class="inv-kpi danger"><div class="inv-kpi-label">Total owed to you</div><div class="inv-kpi-val">${fmtKsh(totalOwed)}</div><div class="inv-kpi-sub">across ${ledger.length} customer${ledger.length === 1 ? '' : 's'}</div></div>
    <div class="inv-kpi"><div class="inv-kpi-label">Customers owing</div><div class="inv-kpi-val">${ledger.length}</div><div class="inv-kpi-sub">${withPhone.length} with a phone saved</div></div>
    <div class="inv-kpi"><div class="inv-kpi-label">Oldest balance</div><div class="inv-kpi-val">${oldest ? relTime(new Date(oldest).toISOString()) : '—'}</div><div class="inv-kpi-sub">${oldest ? 'taken ' + _fmtOwedDate(new Date(oldest).toISOString()) : 'since the item was taken'}</div></div>
  `;

  if (!ledger.length) {
    listEl.innerHTML = '<p style="font-size:13px;color:#999;padding:14px;">No one owes you right now. When you record a sale and the customer pays less than the price, the balance shows up here so you can chase it.</p>';
    return;
  }
  const q = owedQuery.toLowerCase();
  const rows = ledger
    .filter(c => !q || (c.name || '').toLowerCase().includes(q) || c.phone.includes(q))
    .sort((a, b) => b.owed - a.owed);
  if (!rows.length) { listEl.innerHTML = '<p style="font-size:13px;color:#999;padding:14px;">No customers match your search.</p>'; return; }
  listEl.innerHTML = rows.map(c => {
    const items_ = c.lines.slice().sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))
      .map(l => `<span class="owed-line">${escapeHtml(l.itemName)}${l.size ? ' · EU ' + escapeHtml(l.size) : ''} · owes ${fmtKsh(l.balance)} of ${fmtKsh(l.total)} · taken ${_fmtOwedDate(l.at)} (${relTime(l.at)})${l.notes ? ` · <em>${escapeHtml(l.notes)}</em>` : ''}</span>`).join('');
    const noPhone = !c.phone;
    const title = noPhone ? 'Buyer not saved' : (c.name || 'Unnamed customer');
    const sub = noPhone
      ? `${c.lines.length} item${c.lines.length === 1 ? '' : 's'} on credit · no phone saved`
      : `${escapeHtml(c.phone)} · ${c.lines.length} item${c.lines.length === 1 ? '' : 's'} on credit`;
    const noteLine = noPhone ? '<div class="client-note">Add this customer\'s phone (Edit the sale in Recent sales) so you can track and collect it.</div>' : '';
    const actions = noPhone ? '' : `
          <button class="btn-admin gold" onclick="openPayDebt('${c.phone}')">Record payment</button>
          <button class="btn-admin" onclick="remindDebt('${c.phone}')">Remind</button>`;
    return `
      <div class="client-row owed-row">
        <div class="client-row-main">
          <div class="client-row-name">${escapeHtml(title)} <span class="owed-amount">owes ${fmtKsh(c.owed)}</span></div>
          <div class="client-row-sub">${sub}</div>
          ${noteLine}
          <div class="owed-lines">${items_}</div>
          <div class="owed-total">Total owing: <span class="owed-amount">${fmtKsh(c.owed)}</span></div>
        </div>
        <div class="client-row-actions">${actions}</div>
      </div>`;
  }).join('');
}
document.getElementById('owedSearch')?.addEventListener('input', e => { owedQuery = e.target.value.trim(); renderOwed(); });

let payingPhone = '';
function openPayDebt(phone) {
  const c = owedLedger().find(x => x.phone === phone);
  if (!c) return;
  payingPhone = phone;
  document.getElementById('payDebtName').textContent = c.name || c.phone;
  document.getElementById('payDebtOwed').textContent = fmtKsh(c.owed);
  document.getElementById('payDebtAmount').value = c.owed;
  document.querySelectorAll('#payDebtPay .pos-pay-btn').forEach(b => b.classList.toggle('active', b.dataset.pay === 'mpesa'));
  document.getElementById('payDebtModal').style.display = 'flex';
  document.getElementById('payDebtAmount').focus();
}
window.openPayDebt = openPayDebt;
function closePayDebt() { document.getElementById('payDebtModal').style.display = 'none'; payingPhone = ''; }
document.getElementById('payDebtCancelBtn')?.addEventListener('click', closePayDebt);
document.getElementById('payDebtModal')?.addEventListener('click', e => { if (e.target.id === 'payDebtModal') closePayDebt(); });
document.getElementById('payDebtPay')?.addEventListener('click', e => {
  const b = e.target.closest('.pos-pay-btn'); if (!b) return;
  document.querySelectorAll('#payDebtPay .pos-pay-btn').forEach(x => x.classList.toggle('active', x === b));
});
document.getElementById('payDebtSaveBtn')?.addEventListener('click', async () => {
  const phone = payingPhone;
  const amount = parseInt(document.getElementById('payDebtAmount').value, 10);
  const method = document.querySelector('#payDebtPay .pos-pay-btn.active')?.dataset.pay || 'mpesa';
  if (!phone) return;
  if (isNaN(amount) || amount <= 0) { showToast('Enter how much they paid.'); return; }
  closePayDebt();
  const at = new Date().toISOString();
  try {
    let applied = 0;
    const lines = [];
    for (const it of items) for (const s of (it.sales || [])) {
      if (String(s.buyerPhone || '').replace(/[^0-9]/g, '') !== phone) continue;
      if (saleBalance(it, s) > 0) lines.push({ it, s });
    }
    lines.sort((a, b) => new Date(a.s.soldAt || 0) - new Date(b.s.soldAt || 0));
    let remaining = amount;
    for (const { it, s } of lines) {
      if (remaining <= 0) break;
      const pay = Math.min(saleBalance(it, s), remaining);
      if (pay <= 0) continue;
      if (!s.payments) s.payments = [];
      s.payments.push({ amount: pay, at, method });
      remaining -= pay; applied += pay;
    }
    saveData();
    renderOwed(); renderClients(); _renderDashboardInner();
    showToast(applied > 0 ? `Payment of ${fmtKsh(applied)} recorded.` : 'That balance is already cleared.');
  } catch (e) { showToast('Error: ' + e.message); }
});

window.remindDebt = phone => {
  const c = owedLedger().find(x => x.phone === phone);
  if (!c) return;
  const first = (c.name || 'there').split(' ')[0];
  const n = c.lines.length;
  const list = c.lines.map((l, i) => `${i + 1}. *${l.itemName}*${l.size ? ' (EU ' + l.size + ')' : ''}\n    Taken ${_fmtOwedDate(l.at)} · balance ${fmtKsh(l.balance)}`).join('\n');
  const intro = n === 1
    ? `A friendly reminder about your balance on the pair you took from Panache:`
    : `A friendly reminder about the ${n} pairs you took from Panache that still have a balance:`;
  const msg = `Hi ${first}, hope you’re doing well.\n\n${intro}\n\n${list}\n\n*Total still owing: ${fmtKsh(c.owed)}*\nYou can pay via M-Pesa whenever you’re ready. Thank you!`;
  window.open(`https://wa.me/${clientWaPhone(phone)}?text=${encodeURIComponent(msg)}`, '_blank');
};

function paidHint(priceEl, qtyEl, paidEl, hintEl) {
  if (!hintEl) return;
  const total = (parseInt(priceEl?.value, 10) || 0) * (parseInt(qtyEl?.value, 10) || 1);
  const raw = (paidEl?.value || '').trim();
  if (raw === '') { hintEl.style.display = 'none'; return; }
  const bal = total - Math.min(total, Math.max(0, parseInt(raw, 10) || 0));
  hintEl.style.display = bal > 0 ? '' : 'none';
  if (bal > 0) hintEl.textContent = `Balance owing: ${fmtKsh(bal)}`;
}
function syncPaid(priceId, qtyId, paidId, hintId, btnId) {
  const paidEl = document.getElementById(paidId);
  paidHint(document.getElementById(priceId), document.getElementById(qtyId), paidEl, document.getElementById(hintId));
  const btn = document.getElementById(btnId);
  if (btn && paidEl) btn.classList.toggle('active', (paidEl.value || '').trim() === '0');
}
['salePaidInput', 'salePriceInput', 'saleQtyInput'].forEach(id => document.getElementById(id)?.addEventListener('input',
  () => syncPaid('salePriceInput', 'saleQtyInput', 'salePaidInput', 'salePaidHint', 'salePaidNone')));
['posPaid', 'posPrice', 'posQty'].forEach(id => document.getElementById(id)?.addEventListener('input',
  () => syncPaid('posPrice', 'posQty', 'posPaid', 'posPaidHint', 'posPaidNone')));
document.getElementById('salePaidNone')?.addEventListener('click', () => {
  document.getElementById('salePaidInput').value = '0';
  syncPaid('salePriceInput', 'saleQtyInput', 'salePaidInput', 'salePaidHint', 'salePaidNone');
});
document.getElementById('posPaidNone')?.addEventListener('click', () => {
  document.getElementById('posPaid').value = '0';
  syncPaid('posPrice', 'posQty', 'posPaid', 'posPaidHint', 'posPaidNone');
});
