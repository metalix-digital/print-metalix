// Cookie consent banner for every public page. The dataLayer/gtag stub and
// the Consent Mode v2 default (all signals denied) are set up server-side —
// see gtmSnippets() in server.js — synchronously in <head>, before this
// script (deferred) even runs, so window.gtag always exists here already.
// This file only owns the visible Accept/Decline banner and updating the
// consent signals via gtag('consent','update', ...) once the visitor
// chooses, persisting that choice in localStorage.
(function () {
  var CONSENT_KEY = 'metalix_cookie_consent'; // 'granted' | 'denied'
  if (localStorage.getItem(CONSENT_KEY)) return; // already decided, nothing to show

  function consentSignals(state) {
    return { ad_storage: state, ad_user_data: state, ad_personalization: state, analytics_storage: state };
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
      if (window.gtag) window.gtag('consent', 'update', consentSignals(choice));
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showConsentBanner);
  } else {
    showConsentBanner();
  }
})();
