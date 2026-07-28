// Shared GA4 loader for every public page. The Measurement ID is admin-managed
// (Settings → Analytics & SEO), not hardcoded, so this fetches it at runtime
// and no-ops entirely until an admin sets one. Dispatches 'metalix-ga4-ready'
// once gtag is wired up, for pages (e.g. order-success.html) that need to wait
// on it before firing an event.
(function () {
  fetch('/api/settings')
    .then(function (r) { return r.json(); })
    .then(function (s) {
      var id = s && s.analytics && s.analytics.ga4MeasurementId;
      if (!id) return;
      window.dataLayer = window.dataLayer || [];
      window.gtag = function () { window.dataLayer.push(arguments); };
      var script = document.createElement('script');
      script.async = true;
      script.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
      document.head.appendChild(script);
      window.gtag('js', new Date());
      window.gtag('config', id);
      window.dispatchEvent(new Event('metalix-ga4-ready'));
    })
    .catch(function () {});
})();
