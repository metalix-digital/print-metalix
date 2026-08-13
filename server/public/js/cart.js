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
        return existing;
      }
    }
    var withId = Object.assign({ cartItemId: uid(), quantity: 1 }, item);
    items.push(withId);
    writeRaw(items);
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
