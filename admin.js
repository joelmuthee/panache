// The Panache Store — Admin
const ADMIN_PASSWORD = 'panache123';
const STORAGE_KEY = 'panache_data';

let items = [];
let settings = {};
let editingId = null;
let stagedImage = null;

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
async function loadData() {
  const local = localStorage.getItem(STORAGE_KEY);
  if (local) {
    try {
      const parsed = JSON.parse(local);
      items = parsed.items || [];
      settings = parsed.settings || {};
      return;
    } catch (e) {}
  }
  const res = await fetch('data.json');
  const json = await res.json();
  items = json.items || [];
  settings = json.settings || {};
  saveData();
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ items, settings }));
}

// ====== TOAST ======
const toast = document.getElementById('toast');
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// ====== SALES DASHBOARD ======
function fmtKsh(n) {
  return 'Ksh ' + Number(n || 0).toLocaleString('en-KE');
}

function buildDashboard() {
  const sold = items.filter(i => i.sold && i.soldAt);
  const now = new Date();

  function startOf(unit) {
    const d = new Date(now);
    if (unit === 'day') { d.setHours(0,0,0,0); }
    else if (unit === 'week') { d.setDate(d.getDate() - d.getDay()); d.setHours(0,0,0,0); }
    else if (unit === 'month') { d.setDate(1); d.setHours(0,0,0,0); }
    return d.getTime();
  }

  function kpis(from) {
    const filtered = from === 0 ? sold : sold.filter(i => new Date(i.soldAt).getTime() >= from);
    return {
      count: filtered.length,
      revenue: filtered.reduce((s, i) => s + (i.price || 0), 0)
    };
  }

  const today = kpis(startOf('day'));
  const week  = kpis(startOf('week'));
  const month = kpis(startOf('month'));
  const all   = kpis(0);

  document.getElementById('kpiToday').textContent = today.count;
  document.getElementById('kpiTodayRev').textContent = fmtKsh(today.revenue);
  document.getElementById('kpiWeek').textContent = week.count;
  document.getElementById('kpiWeekRev').textContent = fmtKsh(week.revenue);
  document.getElementById('kpiMonth').textContent = month.count;
  document.getElementById('kpiMonthRev').textContent = fmtKsh(month.revenue);
  document.getElementById('kpiAll').textContent = all.count;
  document.getElementById('kpiAllRev').textContent = fmtKsh(all.revenue);

  // Top categories
  const catEl = document.getElementById('topCats');
  const catCounts = {};
  sold.forEach(i => { catCounts[i.category] = (catCounts[i.category] || 0) + 1; });
  const sortedCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
  const maxCat = sortedCats[0]?.[1] || 1;
  if (sortedCats.length) {
    catEl.innerHTML = sortedCats.map(([cat, n]) => `
      <div class="cat-row">
        <span class="cat-row-label">${escapeHtml(cat)}</span>
        <div class="cat-bar-wrap"><div class="cat-bar" style="width:${Math.round(n/maxCat*100)}%"></div></div>
        <span class="cat-count">${n}</span>
      </div>
    `).join('');
  } else {
    catEl.innerHTML = '<p class="no-data">No sales recorded yet.</p>';
  }

  // Recent sales (last 10)
  const recentEl = document.getElementById('recentSales');
  const recent = [...sold].sort((a, b) => new Date(b.soldAt) - new Date(a.soldAt)).slice(0, 10);
  if (recent.length) {
    recentEl.innerHTML = recent.map(i => {
      const d = new Date(i.soldAt);
      const dateStr = d.toLocaleDateString('en-KE', { day:'numeric', month:'short' });
      return `
        <div class="sale-row">
          <div>
            <div class="sale-item">${escapeHtml(i.name)}</div>
            <div class="sale-buyer">${i.soldTo ? escapeHtml(i.soldTo) : 'No buyer recorded'} · ${dateStr}</div>
          </div>
          <div class="sale-price">${fmtKsh(i.price)}</div>
        </div>
      `;
    }).join('');
  } else {
    recentEl.innerHTML = '<p class="no-data">No sales recorded yet.</p>';
  }
}

// ====== FORM ======
const imageInput  = document.getElementById('imageInput');
const imagePreview = document.getElementById('imagePreview');
const nameInput   = document.getElementById('nameInput');
const catInput    = document.getElementById('catInput');
const sizesInput  = document.getElementById('sizesInput');
const descInput   = document.getElementById('descInput');
const priceInput  = document.getElementById('priceInput');
const postUrlInput = document.getElementById('postUrlInput');
const soldInput   = document.getElementById('soldInput');
const buyerFields = document.getElementById('buyerFields');
const buyerName   = document.getElementById('buyerName');
const buyerPhone  = document.getElementById('buyerPhone');
const buyerNotes  = document.getElementById('buyerNotes');
const editingIdField = document.getElementById('editingId');
const formTitle   = document.getElementById('formTitle');
const cancelBtn   = document.getElementById('cancelBtn');

soldInput.addEventListener('change', () => {
  buyerFields.style.display = soldInput.checked ? 'block' : 'none';
});

imageInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    stagedImage = reader.result;
    imagePreview.innerHTML = `<img src="${stagedImage}" style="max-width:200px;border-radius:8px;margin-top:6px;">`;
  };
  reader.readAsDataURL(file);
});

document.getElementById('saveBtn').addEventListener('click', saveItem);
cancelBtn.addEventListener('click', resetForm);

function saveItem() {
  const name  = nameInput.value.trim();
  const price = parseInt(priceInput.value, 10);
  const desc  = descInput.value.trim();
  const cat   = catInput.value;
  const sizes = sizesInput.value.trim();
  const postUrl = postUrlInput.value.trim();
  const sold  = soldInput.checked;

  if (!name) { showToast('Item name is required.'); return; }
  if (!price || price < 0) { showToast('Enter a valid price.'); return; }

  const soldAt = sold ? (editingId ? (items.find(i => i.id === editingId)?.soldAt || new Date().toISOString()) : new Date().toISOString()) : null;
  const soldTo = sold && buyerName.value.trim() ? buyerName.value.trim() : null;

  if (editingId) {
    const item = items.find(i => i.id === editingId);
    if (!item) return;
    Object.assign(item, { name, description: desc, price, category: cat, sizes, postUrl, sold, soldAt, soldTo });
    if (stagedImage) item.image = stagedImage;
    showToast('Item updated.');
  } else {
    if (!stagedImage) { showToast('Add an item image.'); return; }
    items.unshift({
      id: 'item_' + Date.now(),
      name, description: desc, price, category: cat, sizes,
      postUrl, sold, soldAt, soldTo,
      image: stagedImage
    });
    showToast('Item added.');
  }

  saveData();
  resetForm();
  renderList();
  buildDashboard();
}

function resetForm() {
  editingId = null;
  editingIdField.value = '';
  nameInput.value = '';
  catInput.value = 'Heels';
  sizesInput.value = '';
  descInput.value = '';
  priceInput.value = '';
  postUrlInput.value = '';
  soldInput.checked = false;
  buyerFields.style.display = 'none';
  buyerName.value = '';
  buyerPhone.value = '';
  buyerNotes.value = '';
  imageInput.value = '';
  imagePreview.innerHTML = '';
  stagedImage = null;
  formTitle.textContent = 'Add a new item';
  cancelBtn.style.display = 'none';
}

function editItem(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
  editingId = id;
  editingIdField.value = id;
  nameInput.value = item.name;
  catInput.value = item.category || 'Shoes';
  sizesInput.value = item.sizes || '';
  descInput.value = item.description || '';
  priceInput.value = item.price;
  postUrlInput.value = item.postUrl || '';
  soldInput.checked = !!item.sold;
  buyerFields.style.display = item.sold ? 'block' : 'none';
  buyerName.value = item.soldTo || '';
  buyerPhone.value = '';
  buyerNotes.value = '';
  stagedImage = null;
  imagePreview.innerHTML = `<img src="${item.image}" style="max-width:200px;border-radius:8px;margin-top:6px;">`;
  formTitle.textContent = 'Edit item';
  cancelBtn.style.display = 'inline-block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function deleteItem(id) {
  if (!confirm('Delete this item? This cannot be undone.')) return;
  items = items.filter(i => i.id !== id);
  saveData();
  renderList();
  buildDashboard();
  showToast('Item deleted.');
}

function toggleSold(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
  if (!item.sold) {
    const buyer = prompt('Buyer name (or leave blank):');
    item.sold = true;
    item.soldAt = new Date().toISOString();
    item.soldTo = buyer?.trim() || null;
    showToast('Marked as SOLD.');
  } else {
    item.sold = false;
    item.soldAt = null;
    item.soldTo = null;
    showToast('Marked as available.');
  }
  saveData();
  renderList();
  buildDashboard();
}

// ====== LIST ======
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderList() {
  const list = document.getElementById('adminList');
  document.getElementById('itemCount').textContent = items.length;
  list.innerHTML = items.map(item => `
    <div class="admin-card">
      <img src="${item.image}" alt="${escapeHtml(item.name)}" loading="lazy">
      <div class="admin-card-body">
        <div class="admin-card-name">${escapeHtml(item.name)}</div>
        <div class="admin-card-price">Ksh ${Number(item.price).toLocaleString('en-KE')}${item.sold ? ' · <span style="color:#b00020">SOLD</span>' : ''}</div>
        <span class="admin-card-cat">${escapeHtml(item.category)}</span>
        <div class="admin-card-actions">
          <button onclick="editItem('${item.id}')">Edit</button>
          <button class="sold-toggle ${item.sold ? 'on' : ''}" onclick="toggleSold('${item.id}')">${item.sold ? 'Unmark' : 'Mark sold'}</button>
          <button class="danger" onclick="deleteItem('${item.id}')">Delete</button>
        </div>
      </div>
    </div>
  `).join('');
}

// ====== EXPORT / IMPORT / RESET ======
document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ items, settings }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'data.json';
  a.click(); URL.revokeObjectURL(url);
  showToast('Backup downloaded.');
});

document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const json = JSON.parse(reader.result);
      items = json.items || []; settings = json.settings || {};
      saveData(); renderList(); buildDashboard(); showToast('Imported.');
    } catch (e) { showToast('Invalid JSON file.'); }
  };
  reader.readAsText(file);
});

document.getElementById('resetBtn').addEventListener('click', async () => {
  if (!confirm('Reload catalog? Any unsaved changes will be lost.')) return;
  localStorage.removeItem(STORAGE_KEY);
  await loadData(); renderList(); buildDashboard(); showToast('Catalog reloaded.');
});

// ====== EXPOSE TO ONCLICK ======
window.editItem = editItem;
window.deleteItem = deleteItem;
window.toggleSold = toggleSold;

// ====== INIT ======
async function init() {
  await loadData();
  renderList();
  buildDashboard();
}

checkAuth();
