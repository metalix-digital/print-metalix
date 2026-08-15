// Shared cross-page cart for Stationery + Custom Stamps, loaded as a plain
// script (not bundled) on every public page, same pattern as analytics.js —
// there's no SPA router in this app, every nav is a full page load, so a
// cart that needs to survive from /stationery to /stamps to /order has to
// live in localStorage rather than in-memory JS state (unlike the existing
// document/passport-photo cart inside client/index.html, which only needs
// to survive within that one page).
//
// Cart items are display-rich (name/price/image, for rendering on /cart and
// /stationery) but only productType/productId/quantity (stationery) or the
// full stamp config (stamp) actually get sent to the order API — the server
// always re-resolves price/name from the live product row (see
// buildPricedOrderFiles's stationery branch in server.js), so nothing here
// is trusted for pricing.
(function (window) {
  var KEY = 'metalix_cart';

  function readRaw() {
    try {
      var raw = localStorage.getItem(KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function writeRaw(items) {
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) { /* storage unavailable — cart just won't persist */ }
    renderAllBadges();
    // Keep an already-open drawer live (e.g. qty +/- or remove clicked
    // inside it) without needing every caller to know the drawer exists.
    if (drawerEl && drawerEl.classList.contains('show')) renderDrawerContents();
    document.dispatchEvent(new CustomEvent('metalix:cart-changed', { detail: { items: items } }));
  }

  function uid() {
    return (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : 'c' + Date.now() + Math.random().toString(16).slice(2);
  }

  function getAll() {
    return readRaw();
  }

  function count() {
    return readRaw().reduce(function (sum, it) { return sum + (it.quantity || 1); }, 0);
  }

  // Stationery items merge by productId (adding "2 more pens" bumps the
  // existing line's quantity rather than creating a second line) — friendlier
  // cart UX for the customer. Stamp items (productType 'stamp') always add as
  // a new line since each carries its own distinct configuration.
  function add(item) {
    var items = readRaw();
    if (item.productType === 'stationery') {
      var existing = items.find(function (it) { return it.productType === 'stationery' && it.productId === item.productId; });
      if (existing) {
        existing.quantity = (existing.quantity || 1) + (item.quantity || 1);
        writeRaw(items);
        openDrawer(existing.cartItemId);
        return existing;
      }
    }
    var withId = Object.assign({ cartItemId: uid(), quantity: 1 }, item);
    items.push(withId);
    writeRaw(items);
    openDrawer(withId.cartItemId);
    return withId;
  }

  function remove(cartItemId) {
    writeRaw(readRaw().filter(function (it) { return it.cartItemId !== cartItemId; }));
  }

  function setQuantity(cartItemId, quantity) {
    var items = readRaw();
    var it = items.find(function (i) { return i.cartItemId === cartItemId; });
    if (!it) return;
    it.quantity = Math.max(1, Math.min(999, Math.round(Number(quantity)) || 1));
    writeRaw(items);
  }

  function clear() {
    writeRaw([]);
  }

  // Renders a small numeric badge into every element carrying
  // [data-cart-badge] on the current page — call once on page load, and it
  // stays in sync automatically (writeRaw re-renders on every change).
  function renderAllBadges() {
    var n = count();
    document.querySelectorAll('[data-cart-badge]').forEach(function (el) {
      el.textContent = String(n);
      // Explicit 'flex' rather than '' (revert-to-stylesheet) — every badge's
      // CSS baseline is display:none so it's invisible until this runs, and
      // clearing an inline style falls back to that same none, never showing
      // the badge at all. Every [data-cart-badge] element is styled as a
      // small centered pill via flex (align-items/justify-content), so this
      // is safe to hardcode rather than reading each element's intended type.
      el.style.display = n > 0 ? 'flex' : 'none';
    });
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; });
  }

  // -- MINI CART DRAWER --------------------------------------------------
  // Opens automatically on every Cart.add() (stationery, stamps, and the
  // cross-sell strip below all funnel through add()) so a customer sees
  // what just landed in their cart without a full page navigation.
  //
  // Styled with its own hardcoded design tokens rather than each page's
  // CSS variables — this same script runs on pages that don't share one
  // naming scheme (e.g. --card vs --surface, --orange-d vs --orange-deep),
  // so borrowing var(--x) here would only work correctly on some of them.
  // Dark mode is still respected via [data-theme="dark"], which every page
  // sets on <html> consistently.
  var DRAWER_CSS = '' +
    '.mcart-overlay{position:fixed;inset:0;background:rgba(20,17,12,.45);z-index:9998;opacity:0;pointer-events:none;transition:opacity .2s ease;}' +
    '.mcart-overlay.show{opacity:1;pointer-events:auto;}' +
    '.mcart-drawer{position:fixed;top:0;right:0;height:100%;width:400px;max-width:92vw;background:#FFFFFF;box-shadow:-8px 0 32px -8px rgba(20,17,12,.35);z-index:9999;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .25s cubic-bezier(.2,.8,.3,1);font-family:"Roboto",-apple-system,sans-serif;}' +
    '[data-theme="dark"] .mcart-drawer{background:#1F1D22;}' +
    '.mcart-drawer.show{transform:translateX(0);}' +
    '.mcart-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid #E7E5E4;flex-shrink:0;}' +
    '[data-theme="dark"] .mcart-head{border-color:#3A3630;}' +
    '.mcart-head h2{margin:0;font-size:17px;font-weight:800;color:#1C1917;}' +
    '[data-theme="dark"] .mcart-head h2{color:#F7F6F1;}' +
    '.mcart-close{background:none;border:none;font-size:18px;line-height:1;cursor:pointer;color:#78716C;padding:6px;border-radius:8px;}' +
    '.mcart-close:hover{background:#F5F4F2;}' +
    '[data-theme="dark"] .mcart-close:hover{background:#2A251E;}' +
    '.mcart-body{flex:1;overflow-y:auto;padding:4px 20px;}' +
    '.mcart-empty{padding:60px 20px;text-align:center;color:#78716C;font-size:14px;}' +
    '.mcart-item{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid #F0EFED;}' +
    '[data-theme="dark"] .mcart-item{border-color:#2A251E;}' +
    '.mcart-item.mcart-item-added{background:#FFF4EB;margin:0 -12px;padding:14px 12px;border-radius:10px;border-bottom-color:transparent;}' +
    '[data-theme="dark"] .mcart-item.mcart-item-added{background:rgba(255,102,0,.14);}' +
    '.mcart-thumb{width:52px;height:52px;border-radius:10px;background:#FFF4EB;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;overflow:hidden;}' +
    '[data-theme="dark"] .mcart-thumb{background:rgba(255,102,0,.16);}' +
    '.mcart-thumb img{width:100%;height:100%;object-fit:cover;}' +
    '.mcart-item-main{flex:1;min-width:0;}' +
    '.mcart-item-name{font-weight:700;font-size:13.5px;color:#1C1917;}' +
    '[data-theme="dark"] .mcart-item-name{color:#F7F6F1;}' +
    '.mcart-item-meta{font-size:12px;color:#78716C;margin-top:2px;}' +
    '.mcart-item-row{display:flex;align-items:center;justify-content:space-between;margin-top:8px;gap:8px;}' +
    '.mcart-qty{display:flex;align-items:center;border:1.5px solid #C7C4C0;border-radius:8px;overflow:hidden;flex-shrink:0;}' +
    '[data-theme="dark"] .mcart-qty{border-color:#55504A;}' +
    '.mcart-qty button{background:none;border:none;width:24px;height:26px;cursor:pointer;font-size:13px;color:#44403C;}' +
    '[data-theme="dark"] .mcart-qty button{color:#D9D4CC;}' +
    '.mcart-qty span{min-width:22px;text-align:center;font-size:12.5px;font-weight:700;color:#1C1917;}' +
    '[data-theme="dark"] .mcart-qty span{color:#F7F6F1;}' +
    '.mcart-item-price{font-weight:800;font-size:13.5px;color:#1C1917;white-space:nowrap;}' +
    '[data-theme="dark"] .mcart-item-price{color:#F7F6F1;}' +
    '.mcart-item-remove{background:none;border:none;color:#A8A29E;font-size:12px;cursor:pointer;text-decoration:underline;padding:0;margin-top:6px;}' +
    '.mcart-foot{flex-shrink:0;padding:16px 20px 20px;border-top:1px solid #E7E5E4;}' +
    '[data-theme="dark"] .mcart-foot{border-color:#3A3630;}' +
    '.mcart-subtotal{display:flex;justify-content:space-between;align-items:baseline;font-size:14.5px;font-weight:700;color:#1C1917;margin-bottom:14px;}' +
    '[data-theme="dark"] .mcart-subtotal{color:#F7F6F1;}' +
    '.mcart-subtotal b{font-size:19px;color:#E05500;}' +
    '[data-theme="dark"] .mcart-subtotal b{color:#FF8C40;}' +
    '.mcart-btn-primary{display:block;width:100%;text-align:center;text-decoration:none;background:#FF6600;color:#fff;border:none;border-radius:11px;padding:14px;font-weight:800;font-size:14.5px;cursor:pointer;box-sizing:border-box;}' +
    '.mcart-btn-primary:hover{background:#E05500;}' +
    '.mcart-btn-ghost{display:block;width:100%;text-align:center;background:none;border:none;color:#78716C;font-weight:600;font-size:13px;padding:10px;cursor:pointer;margin-top:4px;}' +
    '.mcart-btn-ghost:hover{color:#1C1917;}' +
    '[data-theme="dark"] .mcart-btn-ghost:hover{color:#F7F6F1;}' +
    '@media(max-width:420px){.mcart-drawer{width:100vw;max-width:100vw;}}';

  var drawerEl, overlayEl, bodyEl, footEl, lastAddedId;

  function injectDrawer() {
    if (drawerEl) return;
    var style = document.createElement('style');
    style.textContent = DRAWER_CSS;
    document.head.appendChild(style);

    overlayEl = document.createElement('div');
    overlayEl.className = 'mcart-overlay';

    drawerEl = document.createElement('aside');
    drawerEl.className = 'mcart-drawer';
    drawerEl.setAttribute('role', 'dialog');
    drawerEl.setAttribute('aria-label', 'Cart');
    drawerEl.innerHTML =
      '<div class="mcart-head"><h2>Your Cart</h2><button type="button" class="mcart-close" aria-label="Close">✕</button></div>' +
      '<div class="mcart-body"></div>' +
      '<div class="mcart-foot"></div>';

    document.body.appendChild(overlayEl);
    document.body.appendChild(drawerEl);
    bodyEl = drawerEl.querySelector('.mcart-body');
    footEl = drawerEl.querySelector('.mcart-foot');

    overlayEl.addEventListener('click', closeDrawer);
    drawerEl.querySelector('.mcart-close').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
  }

  function itemThumb(item) {
    if (item.image) return '<img src="' + escHtml(item.image) + '" alt="">';
    return item.productType === 'stamp' ? '🔖' : '📦';
  }
  function itemMeta(item) {
    if (item.productType === 'stamp') return (item.textLines || []).join(', ') || (item.artworkFileId ? 'Custom design' : '');
    return item.sku ? 'SKU ' + item.sku : '';
  }

  function renderDrawerContents() {
    var items = readRaw();
    if (!items.length) {
      bodyEl.innerHTML = '<div class="mcart-empty">Your cart is empty.</div>';
      footEl.innerHTML = '';
      return;
    }
    bodyEl.innerHTML = items.map(function (it) {
      var meta = itemMeta(it);
      return '<div class="mcart-item' + (it.cartItemId === lastAddedId ? ' mcart-item-added' : '') + '">' +
        '<div class="mcart-thumb">' + itemThumb(it) + '</div>' +
        '<div class="mcart-item-main">' +
          '<div class="mcart-item-name">' + escHtml(it.name || 'Item') + '</div>' +
          (meta ? '<div class="mcart-item-meta">' + escHtml(meta) + '</div>' : '') +
          '<div class="mcart-item-row">' +
            (it.productType === 'stationery'
              ? '<div class="mcart-qty"><button type="button" data-step="-1" data-id="' + it.cartItemId + '">−</button><span>' + it.quantity + '</span><button type="button" data-step="1" data-id="' + it.cartItemId + '">+</button></div>'
              : '<span class="mcart-item-meta">Qty ' + it.quantity + '</span>') +
            '<span class="mcart-item-price">₹' + ((it.unitPrice || 0) * it.quantity) + '</span>' +
          '</div>' +
          '<button type="button" class="mcart-item-remove" data-remove="' + it.cartItemId + '">Remove</button>' +
        '</div>' +
      '</div>';
    }).join('');

    var subtotal = items.reduce(function (sum, it) { return sum + (it.unitPrice || 0) * it.quantity; }, 0);
    footEl.innerHTML =
      '<div class="mcart-subtotal"><span>Subtotal</span><b>₹' + subtotal + '</b></div>' +
      '<a class="mcart-btn-primary" href="/cart">Review Cart →</a>' +
      '<button type="button" class="mcart-btn-ghost">Continue shopping</button>';

    bodyEl.querySelectorAll('[data-step]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var it = items.find(function (i) { return i.cartItemId === btn.dataset.id; });
        if (it) setQuantity(it.cartItemId, it.quantity + Number(btn.dataset.step));
      });
    });
    bodyEl.querySelectorAll('[data-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () { remove(btn.dataset.remove); });
    });
    footEl.querySelector('.mcart-btn-ghost').addEventListener('click', closeDrawer);
  }

  function openDrawer(addedCartItemId) {
    injectDrawer();
    lastAddedId = addedCartItemId || null;
    renderDrawerContents();
    overlayEl.classList.add('show');
    drawerEl.classList.add('show');
    document.body.style.overflow = 'hidden';
  }

  function closeDrawer() {
    if (!drawerEl) return;
    overlayEl.classList.remove('show');
    drawerEl.classList.remove('show');
    document.body.style.overflow = '';
  }

  // Fetches admin-configured "you may also need" products for one trigger
  // ('productType:document'|'stationery'|'stamp') and renders a "Complete
  // your order" strip into containerEl — called right after Cart.add() on
  // /stationery and /stamps. Silently renders nothing if there's no matching
  // rule, so a page with no cross-sell configured never shows an empty box.
  function renderCrossSellStrip(containerEl, trigger) {
    if (!containerEl) return;
    fetch('/api/cross-sell?trigger=' + encodeURIComponent(trigger))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var products = data.products || [];
        if (!products.length) { containerEl.innerHTML = ''; containerEl.style.display = 'none'; return; }
        containerEl.style.display = '';
        containerEl.innerHTML = '<div class="cross-sell-title">Complete your order — you may also need</div>' +
          '<div class="cross-sell-items">' + products.map(function (p) {
            var thumb = (p.images && p.images[0]) ? '<img src="' + escHtml(p.images[0]) + '" alt="">' : '📦';
            return '<div class="cross-sell-item">' +
              '<div class="cross-sell-thumb">' + thumb + '</div>' +
              '<div class="cross-sell-name">' + escHtml(p.name) + '</div>' +
              '<div class="cross-sell-price">₹' + p.price + '</div>' +
              '<button type="button" class="cross-sell-add" data-product-id="' + escHtml(p.id) + '">+ Add</button>' +
            '</div>';
          }).join('') + '</div>';
        containerEl.querySelectorAll('.cross-sell-add').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var p = products.find(function (x) { return x.id === btn.dataset.productId; });
            if (!p) return;
            add({ productType: 'stationery', productId: p.id, name: p.name, sku: p.sku, unitPrice: p.price, image: (p.images && p.images[0]) || null, quantity: 1 });
            btn.textContent = 'Added ✓';
            btn.disabled = true;
          });
        });
      })
      .catch(function () { /* cross-sell is a nice-to-have — a failed fetch just shows nothing */ });
  }

  window.Cart = { getAll: getAll, count: count, add: add, remove: remove, setQuantity: setQuantity, clear: clear, renderAllBadges: renderAllBadges, renderCrossSellStrip: renderCrossSellStrip };
  document.addEventListener('DOMContentLoaded', renderAllBadges);
})(window);
