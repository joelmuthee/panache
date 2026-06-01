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
    // Billing kill-switch lives on the worker, not in data.json. Read it from
    // /api/items so a billing suspend takes the public site offline even though
    // the catalog itself is served from the static data.json.
    if (settings.apiBase) {
      try {
        const res = await fetch(`${settings.apiBase}/api/items?_=${Date.now()}`);
        const json = await res.json();
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
      : `Hi! I'd like to enquire about the *${item.name}* (${fmtPrice(item.price)})${sizeHint} from The Panache Store.`;
  }

  function whatsappLink(item, chosenSize) {
    const phone = settings.whatsappNumber || '2540734737373';
    // wa.me fallback keeps the Instagram post link tail so WhatsApp shows a preview.
    const msg = item.sold
      ? enquireBody(item, chosenSize)
      : `${enquireBody(item, chosenSize)}\n\n📸 ${item.postUrl}`;
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
    const filtered = applyFilters();
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
            <a class="btn-card" href="${item.postUrl}" target="_blank" rel="noopener">View post</a>
            <button class="btn-card primary ${item.sold ? 'sold-out' : ''}" data-action="enquire" data-id="${item.id}" type="button">
              ${waIcon()}${item.sold ? 'Enquire (sold)' : 'Enquire'}
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

  wirePills('catPills', 'cat', v => currentCat = v);
  wirePills('sizePills', 'size', v => currentSize = v);
  wirePills('availPills', 'avail', v => currentAvail = v);

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
    const o = document.createElement('div');
    o.id = 'suspendedOverlay';
    o.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#16110c;color:#eee;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:32px;font-family:system-ui,-apple-system,sans-serif;';
    o.innerHTML = '<h1 style="font-weight:600;font-size:clamp(26px,5vw,40px);margin:0 0 14px;">This page is temporarily unavailable</h1>'
      + '<p style="font-size:16px;max-width:440px;line-height:1.6;opacity:0.8;margin:0;">Please check back soon.</p>';
    document.body.appendChild(o);
  }

  await loadData();
  if (suspended) { showSuspended(); return; }
  render();
})();
