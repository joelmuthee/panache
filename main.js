// The Panache Store — public catalog
const PAGE_SIZE = 15;

(async function () {
  const gallery = document.getElementById('gallery');
  const pagination = document.getElementById('pagination');
  const filterMeta = document.getElementById('filterMeta');

  let items = [];
  let settings = {};
  let suspended = false;
  let currentCat = 'all';
  let currentSize = 'all';
  let currentAvail = 'all';
  let currentSort = 'default';
  let currentPage = 1;
  const selectedSizes = new Map(); // itemId → selected EU size string

  // ── DATA ──
  async function loadData() {
    try {
      const res = await fetch('data.json');
      const json = await res.json();
      items = json.items || [];
      settings = json.settings || {};
    } catch (e) {
      console.error('Failed to load data.json', e);
    }
    // The server (KV) is the source of truth — the owner's admin publishes there.
    // data.json above is just the bootstrap/offline fallback. Pull the LIVE
    // catalog + settings + suspend flag from /api/items (buyer PII is stripped
    // from this public response by the worker).
    if (settings.apiBase) {
      try {
        const res = await fetch(`${settings.apiBase}/api/items?_=${Date.now()}`);
        const json = await res.json();
        if (Array.isArray(json.items)) items = json.items;
        if (json.settings) settings = json.settings;
        suspended = !!json.suspended;
      } catch (e) {}
    }
  }

  // ── LIKES (per-item deterministic base + per-visitor +1 stored locally) ──
  const LIKES_KEY = 'panache_likes';
  function itemBaseLikes(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    return 7 + Math.abs(h) % 14; // 7..20 inclusive
  }
  function getLikedSet() {
    try { return new Set(JSON.parse(localStorage.getItem(LIKES_KEY) || '[]')); }
    catch { return new Set(); }
  }
  function saveLikedSet(set) {
    try { localStorage.setItem(LIKES_KEY, JSON.stringify(Array.from(set))); } catch {}
  }
  function itemLikeCount(id) {
    return itemBaseLikes(id) + (getLikedSet().has(id) ? 1 : 0);
  }

  // ── HELPERS ──
  function fmtPrice(n) {
    return 'Ksh ' + Number(n).toLocaleString('en-KE');
  }

  // Message body WITHOUT the trailing "\n\n📸 postUrl" tail.
  function enquireBody(item, chosenSize) {
    const sizeHint = chosenSize ? ` (EU ${chosenSize})` : (item.sizes ? ` (sizes: ${item.sizes})` : '');
    return item.sold
      ? `Hi! I'm interested in the *${item.name}*${sizeHint} from The Panache Store. Is it coming back in stock? 🙏`
      : `Hi! I'd like to check availability of the *${item.name}* (${fmtPrice(item.price)})${sizeHint} from The Panache Store.`;
  }

  // Worker share page — when this URL is shared into WhatsApp, the crawler
  // fetches the og:image and renders a rich preview card with the shoe photo,
  // name and price. Served from the worker domain (not the Pages zone) so the
  // FB/WA crawler isn't blocked by bot protection. Item-aware: /share/<id>.
  const SHARE_BASE = 'https://panachekenya.stawisystems.workers.dev/share/';

  function whatsappLink(item, chosenSize) {
    const phone = settings.whatsappNumber || '2540734737373';
    // Append the share-page URL so WhatsApp renders a preview card with the
    // shoe image — replaces the old `📸 instagram.com/p/...` tail which only
    // gave a generic IG preview (and sometimes none at all if IG rate-limits).
    const msg = item.sold
      ? enquireBody(item, chosenSize)
      : `${enquireBody(item, chosenSize)}\n\n${SHARE_BASE}${encodeURIComponent(item.id)}`;
    return `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
  }

  // Enquire opens WhatsApp directly via the wa.me link (which appends the Instagram
  // post URL so WhatsApp still shows a preview). Do NOT reintroduce navigator.share
  // here — it forces the OS "select an app" picker, which buyers found confusing.

  function waIcon() {
    return `<svg class="wa-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
    </svg>`;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function sizeChips(item) {
    const sizes = item.sizes || '';
    const list = sizes.split(',').map(s => s.trim()).filter(Boolean);
    if (!list.length) return '';
    const sel = selectedSizes.get(item.id);
    const chips = list.map(s =>
      `<button class="size-chip${s === sel ? ' active' : ''}" data-action="select-size" data-id="${item.id}" data-size="${s}" type="button">${s}</button>`
    ).join('');
    return `<div class="card-sizes" id="sizes-${item.id}">${chips}<span class="size-hint" id="size-hint-${item.id}"></span></div>`;
  }

  // ── FILTER ──
  function applyFilters() {
    return items.filter(item => {
      // Category
      if (currentCat !== 'all' && item.category !== currentCat) return false;
      // Size
      if (currentSize !== 'all') {
        const sizeNum = parseInt(currentSize, 10);
        const itemSizes = (item.sizes || '').split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
        if (currentSize === '43+') {
          if (!itemSizes.some(s => s >= 43)) return false;
        } else {
          if (!itemSizes.includes(sizeNum)) return false;
        }
      }
      // Availability
      if (currentAvail === 'available' && item.sold) return false;
      if (currentAvail === 'sold' && !item.sold) return false;
      return true;
    });
  }

  // Per-item activity tracking. localStorage echo + worker beacon so the admin
  // sees site-wide totals across all visitors/devices. Beacon target is the
  // worker (settings.apiBase); skips silently if not configured.
  const INSIGHTS_KEY = 'panache_insights';
  function track(metric, key) {
    if (!key && key !== 0) return;
    try {
      const data = JSON.parse(localStorage.getItem(INSIGHTS_KEY) || '{}');
      data[metric] = data[metric] || {};
      data[metric][key] = (data[metric][key] || 0) + 1;
      localStorage.setItem(INSIGHTS_KEY, JSON.stringify(data));
    } catch {}
    try {
      if (!settings.apiBase) return;
      const payload = JSON.stringify({ metric, key });
      const blob = new Blob([payload], { type: 'text/plain' });
      if (navigator.sendBeacon) navigator.sendBeacon(`${settings.apiBase}/api/track`, blob);
      else fetch(`${settings.apiBase}/api/track`, { method: 'POST', body: payload, keepalive: true }).catch(() => {});
    } catch {}
  }

  // ── RENDER ──
  function render() {
    buildCatDropdown();
    buildSizeDropdown();
    const filtered = applyFilters();
    // Apply sort on top of filters. 'default' keeps the source feed order.
    if (currentSort === 'priceAsc') filtered.sort((a, b) => (a.price || 0) - (b.price || 0));
    else if (currentSort === 'priceDesc') filtered.sort((a, b) => (b.price || 0) - (a.price || 0));
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;

    const start = (currentPage - 1) * PAGE_SIZE;
    const page = filtered.slice(start, start + PAGE_SIZE);

    const avail = items.filter(i => !i.sold).length;
    filterMeta.textContent = `${filtered.length} ${filtered.length === 1 ? 'pair' : 'pairs'} · ${avail} available`;

    if (page.length === 0) {
      gallery.innerHTML = `<p style="grid-column:1/-1;text-align:center;padding:60px 0;color:#8a7a99;font-size:16px;">No items match your filters.</p>`;
      pagination.innerHTML = '';
      return;
    }

    gallery.innerHTML = page.map(item => `
      <article class="card ${item.sold ? 'sold' : ''}">
        <div class="card-img-wrap" data-action="zoom" data-id="${item.id}">
          <img class="card-img" src="${item.image}" alt="${escapeHtml(item.name)}" loading="lazy">
          ${item.sold ? '<span class="badge-sold">Sold out</span>' : ''}
          <button type="button" class="like-pill ${getLikedSet().has(item.id) ? 'liked' : ''}" data-action="like" data-id="${item.id}" aria-label="Like this item">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 21s-7.5-4.5-9.5-9.5C1 7.5 4 4 7.5 4c2 0 3.5 1.2 4.5 3 1-1.8 2.5-3 4.5-3C20 4 23 7.5 21.5 11.5 19.5 16.5 12 21 12 21z"/></svg>
            <span class="like-count">${itemLikeCount(item.id)}</span>
          </button>
        </div>
        <div class="card-body">
          <h3 class="card-title">${escapeHtml(item.name)}</h3>
          ${sizeChips(item)}
          <div class="card-price-row">
            <span class="card-price">${fmtPrice(item.price)}</span>
            <span class="card-category">${escapeHtml(item.category)}</span>
          </div>
          <div class="card-actions">
            <button class="btn-card primary ${item.sold ? 'sold-out' : ''}" data-action="enquire" data-id="${item.id}" type="button">
              ${waIcon()}${item.sold ? 'Sold out · notify me' : 'Check availability'}
            </button>
          </div>
        </div>
      </article>
    `).join('');

    renderPagination(totalPages);
  }

  function renderPagination(totalPages) {
    if (totalPages <= 1) { pagination.innerHTML = ''; return; }

    let html = '';
    html += `<button class="page-btn wide" ${currentPage === 1 ? 'disabled' : ''} data-page="${currentPage - 1}">‹ Prev</button>`;

    // Show at most 7 numbered buttons; ellipsis for large ranges
    const pages = pageRange(currentPage, totalPages);
    for (const p of pages) {
      if (p === '…') {
        html += `<span class="page-btn" style="cursor:default;border:none;">…</span>`;
      } else {
        html += `<button class="page-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
      }
    }

    html += `<button class="page-btn wide" ${currentPage === totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">Next ›</button>`;
    pagination.innerHTML = html;

    pagination.querySelectorAll('[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        currentPage = parseInt(btn.dataset.page, 10);
        render();
        document.getElementById('shop').scrollIntoView({ behavior: 'smooth' });
      });
    });
  }

  function pageRange(cur, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages = [];
    if (cur <= 4) {
      pages.push(1, 2, 3, 4, 5, '…', total);
    } else if (cur >= total - 3) {
      pages.push(1, '…', total - 4, total - 3, total - 2, total - 1, total);
    } else {
      pages.push(1, '…', cur - 1, cur, cur + 1, '…', total);
    }
    return pages;
  }

  // ── FILTER PILL WIRING ──
  function wirePills(containerId, attr, onSelect) {
    document.getElementById(containerId).querySelectorAll('.pill').forEach(p => {
      p.addEventListener('click', () => {
        document.getElementById(containerId).querySelectorAll('.pill').forEach(x => x.classList.remove('active'));
        p.classList.add('active');
        onSelect(p.dataset[attr]);
        currentPage = 1; // reset to page 1 on filter change
        render();
      });
    });
  }

  // ── CATEGORY + SIZE FILTER DROPDOWNS ──
  // Curated static lists (preserved from the original pill rows incl. the "43+"
  // bucket and the "Men's"->"Men's Shoes" label/value split).
  const CAT_OPTIONS = [
    { val: 'all', text: 'All' }, { val: 'Heels', text: 'Heels' }, { val: 'Flats', text: 'Flats' },
    { val: 'Sandals', text: 'Sandals' }, { val: 'Boots', text: 'Boots' }, { val: 'Sneakers', text: 'Sneakers' },
    { val: 'Loafers', text: 'Loafers' }, { val: "Men's Shoes", text: "Men's" }
  ];
  const SIZE_OPTIONS = [{ val: 'all', text: 'All' }].concat(
    ['35', '36', '37', '38', '39', '40', '41', '42', '43+'].map(s => ({ val: s, text: s }))
  );
  function buildCatDropdown() {
    initDropdowns();
    document.getElementById('catPills').innerHTML = dropdownHTML({ kind: 'cat', value: currentCat, ariaLabel: 'Filter by category', groups: [{ label: null, options: CAT_OPTIONS }] });
  }
  function buildSizeDropdown() {
    document.getElementById('sizePills').innerHTML = dropdownHTML({ kind: 'size', value: currentSize, ariaLabel: 'Filter by size', groups: [{ label: null, options: SIZE_OPTIONS }] });
  }

  // Custom filter dropdown — replaces the native <select>/pill row so the open
  // list can show a "scroll for more" cue and an active-filter tint.
  function dropdownHTML({ kind, value, ariaLabel, groups }) {
    let cur = null;
    groups.forEach(g => g.options.forEach(o => { if (o.val === value) cur = o; }));
    if (!cur) cur = groups[0].options[0];
    const body = groups.map(g =>
      (g.label ? `<div class="cdrop-group">${escapeHtml(g.label)}</div>` : '') +
      g.options.map(o => `<button type="button" role="option" class="cdrop-opt${o.val === value ? ' selected' : ''}" data-val="${escapeHtml(o.val)}"${o.val === value ? ' aria-selected="true"' : ''}>${escapeHtml(o.text)}</button>`).join('')
    ).join('');
    const active = value && value !== 'all';
    return `<div class="cdrop filter-select${active ? ' cdrop--active' : ''}" data-kind="${kind}" aria-label="${escapeHtml(ariaLabel)}">`
      + `<button type="button" class="cdrop-trigger sort-select" aria-haspopup="listbox" aria-expanded="false"><span class="cdrop-current">${escapeHtml(cur.text)}</span></button>`
      + `<div class="cdrop-panel" role="listbox" hidden><div class="cdrop-scroll">${body}</div><div class="cdrop-morehint" aria-hidden="true"></div></div>`
      + `</div>`;
  }
  function updateDropHint(sc) {
    const hint = sc.parentElement && sc.parentElement.querySelector('.cdrop-morehint');
    if (hint) hint.classList.toggle('show', sc.scrollHeight - sc.scrollTop - sc.clientHeight > 4);
  }
  function closeAllDropdowns() {
    document.querySelectorAll('.cdrop.open').forEach(d => {
      d.classList.remove('open');
      const p = d.querySelector('.cdrop-panel'); if (p) p.hidden = true;
      const t = d.querySelector('.cdrop-trigger'); if (t) t.setAttribute('aria-expanded', 'false');
    });
  }
  function openDropdown(drop) {
    drop.classList.add('open');
    drop.querySelector('.cdrop-panel').hidden = false;
    drop.querySelector('.cdrop-trigger').setAttribute('aria-expanded', 'true');
    const sc = drop.querySelector('.cdrop-scroll');
    const sel = sc.querySelector('.cdrop-opt.selected');
    if (sel) sc.scrollTop = Math.max(0, sel.offsetTop - 8);
    updateDropHint(sc);
  }
  let dropdownsBound = false;
  function initDropdowns() {
    if (dropdownsBound) return;
    dropdownsBound = true;
    document.addEventListener('click', (e) => {
      const trigger = e.target.closest('.cdrop-trigger');
      if (trigger) {
        e.stopPropagation();
        const drop = trigger.closest('.cdrop');
        const wasOpen = drop.classList.contains('open');
        closeAllDropdowns();
        if (!wasOpen) openDropdown(drop);
        return;
      }
      const opt = e.target.closest('.cdrop-opt');
      if (opt) {
        const drop = opt.closest('.cdrop');
        const val = opt.dataset.val, kind = drop.dataset.kind;
        closeAllDropdowns();
        if (kind === 'cat') currentCat = val;
        else if (kind === 'size') currentSize = val;
        currentPage = 1;
        render();
        return;
      }
      if (!e.target.closest('.cdrop-panel')) closeAllDropdowns();
    });
    document.addEventListener('scroll', (e) => {
      if (e.target.classList && e.target.classList.contains('cdrop-scroll')) updateDropHint(e.target);
    }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllDropdowns(); });
  }

  wirePills('availPills', 'avail', v => currentAvail = v);
  document.getElementById('sortSelect')?.addEventListener('change', e => {
    currentSort = e.target.value;
    currentPage = 1;
    render();
  });

  // ── LIGHTBOX ──
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const lightboxCap = document.getElementById('lightboxCaption');
  const lightboxClose = document.getElementById('lightboxClose');

  gallery.addEventListener('click', async e => {
    // Like-pill — toggle a heart, persist in localStorage. Stop propagation so
    // the click doesn't also fire the card's data-action="zoom" handler.
    const likeBtn = e.target.closest('[data-action="like"]');
    if (likeBtn) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const id = likeBtn.dataset.id;
      const liked = getLikedSet();
      if (liked.has(id)) {
        liked.delete(id);
        likeBtn.classList.remove('liked');
      } else {
        liked.add(id);
        track('itemWishlist', id);
        likeBtn.classList.add('liked', 'pop');
        setTimeout(() => likeBtn.classList.remove('pop'), 350);
      }
      saveLikedSet(liked);
      const countEl = likeBtn.querySelector('.like-count');
      if (countEl) countEl.textContent = itemLikeCount(id);
      return;
    }

    // Size chip selection
    const chip = e.target.closest('[data-action="select-size"]');
    if (chip) {
      const { id, size } = chip.dataset;
      if (selectedSizes.get(id) === size) {
        selectedSizes.delete(id); // toggle off
      } else {
        selectedSizes.set(id, size);
      }
      // Update chip active states without full re-render
      const sizesRow = document.getElementById(`sizes-${id}`);
      if (sizesRow) {
        const sel = selectedSizes.get(id);
        sizesRow.querySelectorAll('.size-chip').forEach(c => c.classList.toggle('active', c.dataset.size === sel));
        const hint = document.getElementById(`size-hint-${id}`);
        if (hint) hint.textContent = '';
        sizesRow.classList.remove('shake');
      }
      return;
    }

    // Enquire button
    const enquireBtn = e.target.closest('[data-action="enquire"]');
    if (enquireBtn) {
      const id = enquireBtn.dataset.id;
      const item = items.find(i => i.id === id);
      if (!item) return;
      const hasSizes = item.sizes && item.sizes.trim().length > 0;
      const chosen = selectedSizes.get(id);
      // Require size selection only for available items that have sizes
      if (!item.sold && hasSizes && !chosen) {
        const sizesRow = document.getElementById(`sizes-${id}`);
        const hint = document.getElementById(`size-hint-${id}`);
        if (sizesRow) {
          sizesRow.classList.remove('shake');
          void sizesRow.offsetWidth; // reflow to restart animation
          sizesRow.classList.add('shake');
        }
        if (hint) hint.textContent = 'Pick a size first';
        return;
      }
      // Open WhatsApp directly. whatsappLink appends the Instagram post URL so
      // WhatsApp still renders a preview card — no OS app-picker.
      track('itemEnquiries', id);
      window.open(whatsappLink(item, chosen || null), '_blank', 'noopener');
      return;
    }

    // Lightbox zoom
    const wrap = e.target.closest('[data-action="zoom"]');
    if (!wrap) return;
    const id = wrap.dataset.id;
    const item = items.find(i => i.id === id);
    if (!item) return;
    track('itemViews', id);
    lightboxImg.src = item.image;
    lightboxImg.alt = item.name;
    lightboxCap.textContent = `${item.name} · ${fmtPrice(item.price)}${item.sold ? ' · SOLD OUT' : ''}`;
    lightbox.classList.add('open');
    lightbox.setAttribute('aria-hidden', 'false');
  });

  function closeLightbox() { lightbox.classList.remove('open'); lightbox.setAttribute('aria-hidden', 'true'); }
  lightboxClose.addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', e => { if (e.target === lightbox) closeLightbox(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

  // ── MOBILE NAV ──
  const navToggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');
  navToggle?.addEventListener('click', () => navLinks.classList.toggle('open'));
  navLinks?.querySelectorAll('a').forEach(a => a.addEventListener('click', () => navLinks.classList.remove('open')));

  // ── YEAR ──
  document.getElementById('year').textContent = new Date().getFullYear();

  // ── BILLING KILL-SWITCH ──
  // When suspended, replace the whole page with a neutral "offline" notice.
  function showSuspended() {
    document.documentElement.style.overflow = 'hidden';
    const shopName = settings.businessName || 'The Panache Store';
    document.title = shopName + ' · Paused';

    const tagline = settings.tagline || 'Step into style.';
    const igHandle = (settings.instagram || 'thepanachekenya').replace(/^@/, '');
    const igLink = igHandle ? ('https://www.instagram.com/' + igHandle + '/') : '';
    const waLink = 'https://wa.me/254720615606?text=' + encodeURIComponent('Hi Essence, I\'d like to bring ' + shopName + ' back online. Tell me about the one-off option.');
    const WA_SVG = '<svg viewBox="0 0 32 32" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M16.003 3C9.38 3 4 8.38 4 15.003c0 2.117.553 4.184 1.604 6.005L4 29l8.184-1.57a11.94 11.94 0 0 0 3.819.626h.003C22.626 28.056 28 22.676 28 16.053 28 9.43 22.626 3 16.003 3zm0 21.94h-.002a9.93 9.93 0 0 1-3.4-.62l-.244-.088-4.857.932.94-4.735-.16-.244a9.91 9.91 0 0 1-1.52-5.27c0-5.49 4.47-9.96 9.96-9.96 2.66 0 5.16 1.04 7.04 2.92a9.9 9.9 0 0 1 2.92 7.04c0 5.49-4.47 9.96-9.96 9.96zm5.46-7.46c-.3-.15-1.77-.873-2.044-.973-.274-.1-.474-.15-.673.15-.2.3-.773.973-.948 1.173-.174.2-.349.224-.648.075-.3-.15-1.265-.466-2.41-1.487-.89-.794-1.49-1.774-1.665-2.074-.174-.3-.018-.462.13-.611.134-.133.3-.349.449-.523.15-.174.2-.3.3-.498.1-.2.05-.374-.025-.524-.075-.15-.673-1.622-.922-2.222-.243-.583-.49-.504-.673-.513l-.573-.01c-.2 0-.524.075-.798.374-.274.3-1.047 1.023-1.047 2.495 0 1.472 1.072 2.894 1.222 3.094.15.2 2.11 3.222 5.11 4.516.714.308 1.272.492 1.706.63.717.228 1.37.196 1.886.119.575-.086 1.77-.724 2.02-1.423.25-.7.25-1.298.175-1.423-.074-.124-.274-.199-.573-.349z"></path></svg>';
    const logoUrl = 'images/logo.jpg';

    const IG_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"></rect><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"></path><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"></line></svg>';

    const css = ('@keyframes pnSusFade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}'
      + '#suspendedOverlay{position:fixed;inset:0;z-index:99999;background:radial-gradient(ellipse at top,#2e0a4a 0%,#0d0118 65%);color:#f0e8ff;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 24px;font-family:Inter,system-ui,-apple-system,sans-serif;animation:pnSusFade 0.65s ease both;}'
      + '#suspendedOverlay .pn-logo{width:140px;height:140px;border-radius:50%;object-fit:cover;background:#fff;border:2px solid #f5a820;box-shadow:0 0 36px rgba(245,168,32,0.4),inset 0 0 0 1px rgba(255,255,255,0.04);margin-bottom:26px;}'
      + '#suspendedOverlay .pn-name{font-family:\'Cormorant Garamond\',Georgia,serif;font-size:34px;color:#ffedb0;letter-spacing:2.5px;font-weight:500;line-height:1;margin-bottom:8px;}'
      + '#suspendedOverlay .pn-tag{font-size:12px;color:#f5a820;letter-spacing:2px;text-transform:uppercase;margin-bottom:30px;opacity:0.9;}'
      + '#suspendedOverlay .pn-rule{width:54px;height:1px;background:linear-gradient(90deg,transparent,#f5a820,transparent);margin-bottom:30px;}'
      + '#suspendedOverlay .pn-head{font-family:\'Cormorant Garamond\',Georgia,serif;font-weight:500;font-size:clamp(30px,5vw,44px);margin:0 0 16px;color:#f0e8ff;line-height:1.15;}'
      + '#suspendedOverlay .pn-body{font-size:16px;max-width:460px;line-height:1.65;opacity:0.82;margin:0 0 14px;}'
      + '#suspendedOverlay .pn-offer{font-size:16px;max-width:460px;line-height:1.6;margin:0 0 30px;color:#ffedb0;}'
      + '#suspendedOverlay .pn-offer b{color:#fff;font-weight:700;}'
      + '#suspendedOverlay .pn-ig{display:inline-flex;align-items:center;gap:10px;background:#f5a820;color:#3a0e58;padding:14px 30px;border-radius:999px;text-decoration:none;font-weight:600;font-size:15px;letter-spacing:0.3px;box-shadow:0 6px 24px rgba(245,168,32,0.3);transition:transform 0.2s ease,box-shadow 0.2s ease,background 0.2s ease;}'
      + '#suspendedOverlay .pn-ig:hover{background:#ffedb0;transform:translateY(-1px);box-shadow:0 8px 28px rgba(245,168,32,0.42);}'
      + '@media (max-width:480px){#suspendedOverlay .pn-logo{width:118px;height:118px;margin-bottom:22px;}#suspendedOverlay .pn-name{font-size:28px;letter-spacing:2px;}#suspendedOverlay .pn-tag{font-size:11px;margin-bottom:24px;}}'
    );
    const styleTag = document.createElement('style');
    styleTag.textContent = css;
    document.head.appendChild(styleTag);

    const o = document.createElement('div');
    o.id = 'suspendedOverlay';
    o.innerHTML = (
      '<img class="pn-logo" src="' + logoUrl + '" alt="' + shopName + '">'
      + '<div class="pn-name">' + shopName + '</div>'
      + (tagline ? '<div class="pn-tag">' + tagline + '</div>' : '<div style="height:30px"></div>')
      + '<div class="pn-rule"></div>'
      + '<h1 class="pn-head">This shop is paused</h1>'
      + '<p class="pn-body">Not ready for a monthly plan? You don\'t need one.</p>'
      + '<p class="pn-offer">Now you can <b>own this shop outright for a one-time Ksh 20,000</b>, no monthly fees. New stock you post on Instagram pulls straight into your shop. Buyers can filter by category and size to find what they want fast, then order on WhatsApp.</p>'
      + '<a class="pn-ig" href="' + waLink + '" target="_blank" rel="noopener">' + WA_SVG + ' Bring my shop back</a>'
    );
    document.body.appendChild(o);
  }

  await loadData();
  if (suspended) { showSuspended(); return; }
  render();
})();
