// Shared GA4 loader + cookie consent banner for every public page. The
// Measurement ID is admin-managed (Settings → Analytics & SEO), not
// hardcoded, so this fetches it at runtime and no-ops entirely until an
// admin sets one. Dispatches 'metalix-ga4-ready' once gtag is wired up, for
// pages (e.g. order-success.html) that need to wait on it before firing an
// event.
//
// Implements Google Consent Mode v2: all signals start denied, gtag.js loads
// regardless (so Google can send privacy-safe modeled pings), and the
// visitor's Accept/Decline choice — persisted in localStorage — updates the
// signals via gtag('consent','update', ...). This is the "Basic" Consent
// Mode implementation Google's setup wizard asks a site to have.
(function () {
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };

  var CONSENT_KEY = 'metalix_cookie_consent'; // 'granted' | 'denied'

  function consentSignals(state) {
    return { ad_storage: state, ad_user_data: state, ad_personalization: state, analytics_storage: state };
  }

  // Must run before gtag.js configures anything — denied is the safe default
  // until the visitor actually chooses. wait_for_update gives the banner a
  // moment to resolve before the first ping goes out unmodeled.
  window.gtag('consent', 'default', Object.assign({ wait_for_update: 500 }, consentSignals('denied')));

  var storedChoice = localStorage.getItem(CONSENT_KEY);
  if (storedChoice === 'granted' || storedChoice === 'denied') {
    window.gtag('consent', 'update', consentSignals(storedChoice));
  }

  function showConsentBanner() {
    var bar = document.createElement('div');
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Cookie consent');
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;' +
      'background:#14161C;color:#EDEEF2;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;' +
      'padding:16px 18px;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:14px 22px;' +
      'box-shadow:0 -8px 24px -12px rgba(0,0,0,.4);';

    var text = document.createElement('p');
    text.style.cssText = 'margin:0;font-size:13px;line-height:1.55;max-width:520px;flex:1 1 260px;min-width:200px;color:#C9CBD4;';
    text.innerHTML = 'We use cookies to understand how visitors use this site. ' +
      '<a href="/policies#privacy" style="color:#FF8A3D;text-decoration:underline;">Privacy policy</a>';

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:10px;flex-shrink:0;';

    function makeButton(label, primary) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.style.cssText = 'font-family:inherit;font-size:13px;font-weight:700;border-radius:8px;padding:9px 18px;cursor:pointer;border:1.5px solid ' +
        (primary ? 'transparent' : '#454A57') + ';background:' + (primary ? '#FF6600' : 'transparent') + ';color:' + (primary ? '#fff' : '#EDEEF2') + ';';
      btn.addEventListener('focus', function () { btn.style.outline = '2px solid #FF6600'; btn.style.outlineOffset = '2px'; });
      btn.addEventListener('blur', function () { btn.style.outline = 'none'; });
      return btn;
    }

    var acceptBtn = makeButton('Accept', true);
    var declineBtn = makeButton('Decline', false);

    function resolve(choice) {
      localStorage.setItem(CONSENT_KEY, choice);
      window.gtag('consent', 'update', consentSignals(choice));
      bar.remove();
    }
    acceptBtn.addEventListener('click', function () { resolve('granted'); });
    declineBtn.addEventListener('click', function () { resolve('denied'); });

    actions.appendChild(declineBtn);
    actions.appendChild(acceptBtn);
    bar.appendChild(text);
    bar.appendChild(actions);
    document.body.appendChild(bar);
  }

  if (!storedChoice) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', showConsentBanner);
    } else {
      showConsentBanner();
    }
  }

  fetch('/api/settings')
    .then(function (r) { return r.json(); })
    .then(function (s) {
      var id = s && s.analytics && s.analytics.ga4MeasurementId;
      if (!id) return;
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
