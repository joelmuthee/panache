// The Panache Store — Admin
const ADMIN_PASSWORD = 'panache123';
const STORAGE_KEY = 'panache_data';
const INSIGHTS_KEY = 'panache_insights';
const ALL_EU_SIZES = ['35','36','37','38','39','40','41','42','43','44','45'];

let items = [];
let settings = {};
let accountSuspended = false;
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
  const local = localStorage.getItem(STORAGE_KEY);
  if (local) {
    try {
      const parsed = JSON.parse(local);
      items = (parsed.items || []).map(migrateItem);
      settings = parsed.settings || {};
      return;
    } catch (e) {}
  }
  try {
    const res = await fetch('data.json');
    const json = await res.json();
    items = (json.items || []).map(migrateItem);
    settings = json.settings || {};
    saveData();
  } catch (e) {
    console.error('Failed to load data.json', e);
  }
}

function saveData() {
  items.forEach(syncLegacyFields);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ items, settings }));
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
  b.innerHTML = 'Your store is currently offline because payment is overdue. Please contact Essence Automations to restore it. <a href="https://wa.me/254720615606" style="color:#fff;text-decoration:underline;">Message us</a>';
}

// ====== TOAST ======
const toast = document.getElementById('toast');
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// ====== TRASH (device-local restore bin) ======
// Deleted items are stashed in localStorage so they can be restored. Kept off the
// server so the public catalog never sees them. Stored per device only.
const TRASH_KEY = 'panache_trash';
const TRASH_CAP = 50;

function getTrash() {
  try { return JSON.parse(localStorage.getItem(TRASH_KEY) || '[]'); } catch { return []; }
}
function setTrash(arr) { localStorage.setItem(TRASH_KEY, JSON.stringify(arr.slice(0, TRASH_CAP))); }
function trashPush(removed) {
  // removed: [{ item, index }] — index = position in items at delete time, for in-place restore
  const now = new Date().toISOString();
  const entries = removed.filter(x => x && x.item).map(({ item, index }) => ({ item, index, deletedAt: now }));
  setTrash([...entries, ...getTrash()]);
}

function trashTimeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24); return `${d} day${d === 1 ? '' : 's'} ago`;
}

function renderTrash() {
  const list = document.getElementById('trashList');
  if (!list) return;
  const trash = getTrash();
  const countEl = document.getElementById('trashCount');
  const navCount = document.getElementById('navTrashCount');
  if (countEl) countEl.textContent = trash.length;
  if (navCount) navCount.textContent = trash.length;
  const emptyBtn = document.getElementById('emptyTrashBtn');
  if (emptyBtn) emptyBtn.style.display = trash.length ? '' : 'none';
  if (!trash.length) {
    list.innerHTML = '<p style="color:var(--ink-faint);font-size:13px;padding:10px 2px;">Trash is empty. Deleted items land here so you can restore them. Stored on this device only.</p>';
    return;
  }
  list.innerHTML = trash.map(({ item, deletedAt }) => `
    <div class="admin-card">
      <img src="${item.image}" alt="${escapeHtml(item.name)}" loading="lazy">
      <div class="admin-card-body">
        <div class="admin-card-name">${escapeHtml(item.name)}</div>
        <div class="admin-card-stock">${escapeHtml(item.category || 'Uncategorised')} · deleted ${trashTimeAgo(deletedAt)}</div>
        <div class="admin-card-actions">
          <button class="primary" onclick="restoreItem('${item.id}')">Restore</button>
          <button class="danger" onclick="deleteForever('${item.id}')">Delete forever</button>
        </div>
      </div>
    </div>`).join('');
}

async function restoreItem(id) {
  const trash = getTrash();
  const idx = trash.findIndex(t => t.item && t.item.id === id);
  if (idx === -1) return;
  if (items.some(i => i.id === id)) {
    trash.splice(idx, 1); setTrash(trash); renderTrash();
    showToast('Already in the catalog — cleared from Trash.');
    return;
  }
  const entry = trash[idx];
  const at = Math.min(typeof entry.index === 'number' ? entry.index : items.length, items.length);
  items.splice(at, 0, entry.item);
  saveData();
  trash.splice(idx, 1); setTrash(trash);
  renderList(); renderDashboard(); renderInventory(); renderTrash();
  showToast('Item restored to the catalog.');
}

async function deleteForever(id) {
  if (!await confirmAction('Permanently remove this from Trash? It cannot be restored after this.', 'Delete forever')) return;
  setTrash(getTrash().filter(t => !(t.item && t.item.id === id)));
  renderTrash();
  showToast('Removed from Trash.');
}

async function emptyTrash() {
  const n = getTrash().length;
  if (!n) return;
  if (!await confirmAction(`Empty Trash? ${n} item${n === 1 ? '' : 's'} will be gone for good.`, 'Empty trash')) return;
  setTrash([]);
  renderTrash();
  showToast('Trash emptied.');
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

    const cap = (data.caption || '').replace(/^[a-z0-9._]+\s+/i, '').trim();
    document.getElementById('descInput').value = cap;
    if (!document.getElementById('nameInput').value && cap) {
      const firstLine = cap.split(/[.!?\n]/)[0].trim().slice(0, 60);
      document.getElementById('nameInput').value = firstLine.charAt(0).toUpperCase() + firstLine.slice(1);
    }
    document.getElementById('postUrlInput').value = data.postUrl || url;

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
  const cat = document.getElementById('catInput').value;
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
    `Pick up in Nairobi or we deliver. Tap Enquire to order.`,
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
  const cat = document.getElementById('catInput').value;
  const postUrl = document.getElementById('postUrlInput').value.trim();
  const stock = getStockFromForm();

  if (!name) { showToast('Item name is required.'); return; }
  if (!price || price < 0) { showToast('Enter a valid price.'); return; }

  if (editingId) {
    const item = items.find(i => i.id === editingId);
    if (!item) return;
    item.name = name;
    item.description = desc;
    item.price = price;
    item.category = cat;
    item.postUrl = postUrl;
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

function resetForm() {
  editingId = null;
  document.getElementById('editingId').value = '';
  document.getElementById('nameInput').value = '';
  document.getElementById('catInput').value = '';
  document.getElementById('descInput').value = '';
  document.getElementById('priceInput').value = '';
  document.getElementById('postUrlInput').value = '';
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
}

function editItem(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
  editingId = id;
  document.getElementById('editingId').value = id;
  document.getElementById('nameInput').value = item.name;
  document.getElementById('catInput').value = item.category || '';
  document.getElementById('descInput').value = item.description || '';
  document.getElementById('priceInput').value = item.price;
  document.getElementById('postUrlInput').value = item.postUrl || '';
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
  document.getElementById('formTitle').scrollIntoView({ behavior: 'auto', block: 'start' });
}

async function deleteItem(id) {
  if (!await confirmAction('Delete this item? This cannot be undone.', 'Delete')) return;
  const _idx = items.findIndex(i => i.id === id);
  const _removed = _idx === -1 ? null : items[_idx];
  items = items.filter(i => i.id !== id);
  saveData();
  if (_removed) trashPush([{ item: _removed, index: _idx }]);
  renderList();
  renderDashboard();
  renderInventory();
  renderTrash();
  showToast('Item deleted. Restore it from Trash if needed.');
}

// ====== SALE MODAL ======
const saleModal = document.getElementById('saleModal');

function openSaleModal(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
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

  if (item.stock && item.stock[size] !== undefined) {
    item.stock[size] = Math.max(0, item.stock[size] - qty);
  }
  if (!item.sales) item.sales = [];
  item.sales.push({
    size, qty, salePrice,
    buyerName: document.getElementById('buyerName').value.trim(),
    buyerPhone: document.getElementById('buyerPhone').value.trim(),
    notes: document.getElementById('buyerNotes').value.trim(),
    soldAt: new Date().toISOString(),
  });

  closeSaleModal();
  saveData();
  renderList();
  renderDashboard();
  renderInventory();
  showToast(`Sale recorded — ${qty}× EU ${size} sold.`);
});

document.getElementById('saleCancelBtn').addEventListener('click', closeSaleModal);
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

  document.getElementById('kpiGrid').innerHTML = buckets.map(b => `
    <div class="kpi-card">
      <div class="kpi-label">${b.label}</div>
      <div class="kpi-count">${b.count} <span class="kpi-unit">pairs</span></div>
      <div class="kpi-revenue">${fmtKsh(b.revenue)}</div>
    </div>`).join('');

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
              <div class="recent-name">${escapeHtml(item.name)} · EU ${escapeHtml(s.size || '')} × ${s.qty || 1}</div>
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

    return `
    <tr>
      <td><img class="item-img" src="${item.image}" alt="${escapeHtml(item.name)}"></td>
      <td>
        <div style="font-weight:600;font-size:13px;">${escapeHtml(item.name)}</div>
        <div style="font-size:11px;color:#999;margin-top:2px;">${soldUnits} sold · ${fmtKsh(totalRevenue(item))} revenue</div>
      </td>
      <td style="font-size:13px;">${escapeHtml(item.category || '—')}</td>
      <td style="font-size:13px;font-weight:600;">${fmtKsh(item.price)}</td>
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
  const _removed = [];
  items.forEach((it, i) => { if (bulkSelected.has(it.id)) _removed.push({ item: it, index: i }); });
  items = items.filter(i => !bulkSelected.has(i.id));
  bulkSelected.clear();
  saveData();
  trashPush(_removed);
  renderList();
  renderInventory();
  renderDashboard();
  renderTrash();
  showToast('Deleted. Restore from Trash if needed.');
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
  const map = new Map();
  for (const item of items) {
    for (const s of (item.sales || [])) {
      if (!s.buyerPhone) continue;
      const phone = String(s.buyerPhone).replace(/[^0-9]/g, '');
      if (phone.length < 9) continue;
      const existing = map.get(phone);
      const soldAt = new Date(s.soldAt || 0).getTime();
      if (!existing || soldAt > existing.soldAt) {
        map.set(phone, { phone, name: s.buyerName || '', soldAt, lastBought: item.name });
      }
    }
  }
  return [...map.values()].sort((a, b) => b.soldAt - a.soldAt);
}

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
  const buyers = pastBuyers();
  for (const b of buyers) {
    if (!(b.phone in broadcastRecipientsState)) {
      broadcastRecipientsState[b.phone] = { name: b.name, included: true };
    }
  }
  if (!buyers.length) {
    wrap.innerHTML = '<p style="color:var(--ink-faint);font-size:13px;padding:8px 0;">No past buyers yet — once you record sales with buyer phone numbers, they\'ll appear here.</p>';
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
          <span class="broadcast-recipient-meta">last: ${escapeHtml(b.lastBought)}</span>
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
    ? '\n\n' + selectedItems.map((b, i) => `${i + 1}. *${b.name}*${b.price > 0 ? ' — ' + fmtKsh(b.price) : ''}`).join('\n')
    : '';
  const storeUrl = 'https://thepanache.essenceautomations.com';
  const greet = recipientName ? `Hi ${recipientName.split(' ')[0]}! ` : 'Hi! ';
  return `${greet}It's The Panache Store — ${subject || 'new ALDO styles just landed'}.${itemsBlock}\n\nBrowse the full collection: ${storeUrl}\n\nReply here to enquire or place an order. 💜`;
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
    window.open(`https://wa.me/${r.phone}?text=${encodeURIComponent(msg)}`, '_blank');
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
window.restoreItem = restoreItem;
window.deleteForever = deleteForever;
window.emptyTrash = emptyTrash;

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
async function init() {
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
  renderTrash();
}

checkAuth();
