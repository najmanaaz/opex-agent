/*
 * T4Tangerine single sign-in, shared by www, stack, opex and aeo.t4tangerine.com.
 * Source of truth: t4tangerine/t4t-auth.js (copied into each app by scripts/sync-auth.sh).
 *
 * - One Cognito app client for every site; sign-in is the authorization code flow with PKCE.
 * - The session is the refresh token, kept in a cookie on .t4tangerine.com so every
 *   site sees it. Each site turns it into a 1-hour ID token, kept in sessionStorage.
 * - The cookie is the source of truth: no cookie means signed out, everywhere.
 * - Sign-out revokes the refresh token at Cognito, clears the cookie, then ends the
 *   managed-login session.
 * - T4T.auth.mountBar() draws the account bar at the top of the page.
 */
(function () {
  'use strict';
  var CLIENT_ID = '1ttnb9dnrgj4lll1g0sfg4np71';
  var LOGIN_URL = 'https://t4tangerine-stack-optimizer.auth.eu-central-1.amazoncognito.com';
  var ACCOUNT_URL = 'https://www.t4tangerine.com/account';
  var COOKIE_RT = 't4t_rt', COOKIE_USER = 't4t_user';
  var SESSION_DAYS = 30;
  var ID_KEY = 't4t.idToken', PKCE_KEY = 't4t.pkce';
  var onLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  var COOKIE_ATTRS = (onLocal ? '' : '; Domain=.t4tangerine.com; Secure') + '; Path=/; SameSite=Lax';

  // ── cookies and storage ──
  function readCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function writeCookie(name, value, days) {
    document.cookie = name + '=' + encodeURIComponent(value) + '; Max-Age=' + Math.round(days * 86400) + COOKIE_ATTRS;
  }
  function deleteCookie(name) { document.cookie = name + '=; Max-Age=0' + COOKIE_ATTRS; }
  function sGet(k) { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function sSet(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function sDel(k) { try { sessionStorage.removeItem(k); } catch (e) {} }

  function b64url(bytes) {
    var s = '';
    bytes.forEach(function (b) { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function randomString() { var b = new Uint8Array(32); crypto.getRandomValues(b); return b64url(b); }
  function decodeJwt(token) {
    var part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part), function (c) { return c.charCodeAt(0); })));
  }

  // Where Cognito sends the user back on this site
  function redirectUri() { return /^www\./.test(location.hostname) || location.pathname.indexOf('/account') === 0 ? location.origin + '/account' : location.origin + '/'; }

  function tokenRequest(params) {
    return fetch(LOGIN_URL + '/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) { var err = new Error('Sign-in failed (' + res.status + ')'); err.code = body.error; throw err; }
        return body;
      });
    });
  }

  function storeTokens(tokens) {
    if (tokens.refresh_token) writeCookie(COOKIE_RT, tokens.refresh_token, SESSION_DAYS);
    var claims = decodeJwt(tokens.id_token);
    var expiresAt = Date.now() + (tokens.expires_in || 3600) * 1000;
    sSet(ID_KEY, { token: tokens.id_token, expiresAt: expiresAt, sub: claims.sub });
    // Who is signed in, for the account bar on every site (not a credential)
    writeCookie(COOKIE_USER, JSON.stringify({ email: claims.email || '', sub: claims.sub }), SESSION_DAYS);
    return tokens.id_token;
  }

  function clearLocal() { deleteCookie(COOKIE_RT); deleteCookie(COOKIE_USER); sDel(ID_KEY); }

  var refreshing = null;
  /** A valid ID token for API calls, or null when signed out. */
  function getIdToken(forceRefresh) {
    var rt = readCookie(COOKIE_RT);
    if (!rt) { sDel(ID_KEY); return Promise.resolve(null); }
    var cached = sGet(ID_KEY), user = currentUser();
    // Reuse the cached token only if it belongs to the account in the shared cookie
    if (!forceRefresh && cached && cached.expiresAt - 60000 > Date.now() && user && cached.sub === user.sub) return Promise.resolve(cached.token);
    refreshing = refreshing || tokenRequest({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: rt })
      .then(function (t) { return storeTokens(t); })
      .catch(function (e) {
        // The session was revoked or expired: signed out everywhere
        if (e.code === 'invalid_grant') clearLocal();
        return null;
      })
      .finally(function () { refreshing = null; });
    return refreshing;
  }

  function currentUser() {
    if (!readCookie(COOKIE_RT)) return null;
    try { return JSON.parse(readCookie(COOKIE_USER) || 'null'); } catch (e) { return null; }
  }

  /** Sends the user to the managed login page, then back to `returnTo` (default: this page). */
  function signIn(signUp, returnTo) {
    var verifier = randomString(), state = randomString();
    sSet(PKCE_KEY, { verifier: verifier, state: state, returnTo: returnTo || (location.pathname + location.search + location.hash) });
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)).then(function (hash) {
      var query = new URLSearchParams({
        response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri(),
        scope: 'openid email profile', state: state,
        code_challenge: b64url(new Uint8Array(hash)), code_challenge_method: 'S256'
      });
      location.assign(LOGIN_URL + (signUp ? '/signup' : '/oauth2/authorize') + '?' + query);
    });
  }

  /** Completes a sign-in when Cognito has just sent the user back with ?code=. */
  function handleRedirect() {
    var q = new URLSearchParams(location.search);
    if (!q.get('code')) return Promise.resolve(false);
    var pkce = sGet(PKCE_KEY); sDel(PKCE_KEY);
    var back = (pkce && pkce.returnTo) || location.pathname;
    if (back.indexOf('code=') >= 0 || back.charAt(0) !== '/') back = location.pathname; // same-site paths only
    var samePage = back.split(/[?#]/)[0] === location.pathname;
    history.replaceState(null, '', samePage ? back : location.pathname);
    if (!pkce || q.get('state') !== pkce.state) return Promise.resolve(false);
    return tokenRequest({ grant_type: 'authorization_code', client_id: CLIENT_ID, code: q.get('code'), redirect_uri: redirectUri(), code_verifier: pkce.verifier })
      .then(function (t) {
        storeTokens(t);
        // Signed in from another page of this site (e.g. www/book via /account): go back there
        if (!samePage) location.replace(back);
        return true;
      });
  }

  function signOut() {
    var rt = readCookie(COOKIE_RT);
    clearLocal();
    var done = function () { location.assign(LOGIN_URL + '/logout?' + new URLSearchParams({ client_id: CLIENT_ID, logout_uri: location.origin + '/' })); };
    if (!rt) return done();
    fetch(LOGIN_URL + '/oauth2/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: rt, client_id: CLIENT_ID }) })
      .catch(function () {}).finally(done);
  }

  /** Runs once per page: finishes a pending sign-in, then resolves with the user (or null). */
  var ready = null;
  function init() {
    ready = ready || handleRedirect().catch(function () { return false; }).then(function () {
      return getIdToken().then(function (token) { renderBar(); return token ? currentUser() : null; });
    });
    return ready;
  }

  // ── the account bar ──
  var CSS = '.t4t-acct{background:#0F0A04;color:rgba(255,255,255,.72);font:13px/1.2 "DM Sans",system-ui,sans-serif;position:relative;z-index:101}' +
    '.t4t-acct-in{max-width:1120px;margin:0 auto;padding:0 16px;height:32px;display:flex;align-items:center;justify-content:flex-end;gap:14px;min-width:0}' +
    '.t4t-acct a,.t4t-acct button{color:rgba(255,255,255,.85);background:none;border:0;font:inherit;cursor:pointer;padding:0;text-decoration:none;white-space:nowrap}' +
    '.t4t-acct a:hover,.t4t-acct button:hover{color:#FF9500}' +
    '.t4t-acct-who{display:flex;align-items:center;gap:7px;min-width:0}' +
    '.t4t-acct-dot{width:20px;height:20px;border-radius:50%;background:#FF9500;color:#1A1208;font-weight:700;font-size:11px;display:inline-flex;align-items:center;justify-content:center;flex:none}' +
    '.t4t-acct-email{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px}' +
    '.t4t-acct-sep{opacity:.35}' +
    '@media (max-width:520px){.t4t-acct-email{max-width:130px}.t4t-acct-in{gap:10px}}' +
    '@media print{.t4t-acct{display:none}}';

  function esc(s) { var d = document.createElement('div'); d.appendChild(document.createTextNode(String(s || ''))); return d.innerHTML; }

  function renderBar() {
    var bar = document.getElementById('t4t-acct');
    if (!bar) return;
    var user = currentUser();
    if (user) {
      var email = user.email || 'your account';
      bar.innerHTML = '<div class="t4t-acct-in"><span class="t4t-acct-who" title="Signed in as ' + esc(email) + '"><span class="t4t-acct-dot" aria-hidden="true">' + esc(email.charAt(0).toUpperCase()) + '</span>' +
        '<span class="t4t-acct-email">' + esc(email) + '</span></span><span class="t4t-acct-sep">·</span>' +
        '<a href="' + ACCOUNT_URL + '">My account</a><span class="t4t-acct-sep">·</span><button type="button" data-t4t="signout">Sign out</button></div>';
    } else {
      bar.innerHTML = '<div class="t4t-acct-in"><button type="button" data-t4t="signin">Sign in</button><span class="t4t-acct-sep">·</span><button type="button" data-t4t="signup">Create account</button></div>';
    }
  }

  function mountBar() {
    if (document.getElementById('t4t-acct')) return;
    var style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    var bar = document.createElement('div'); bar.id = 't4t-acct'; bar.className = 't4t-acct'; bar.setAttribute('role', 'navigation'); bar.setAttribute('aria-label', 'Account');
    document.body.insertBefore(bar, document.body.firstChild);
    // A fixed menu (www) would cover the bar: pin the bar above it and move the menu,
    // the mobile menu and the page down by the bar's height. Sticky menus need nothing.
    var nav = document.querySelector('.navbar');
    if (nav && getComputedStyle(nav).position === 'fixed') {
      var h = 32;
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;';
      nav.style.top = h + 'px';
      document.body.style.paddingTop = ((parseFloat(getComputedStyle(document.body).paddingTop) || 0) + h) + 'px';
      var menu = document.querySelector('.mobile-menu');
      if (menu && getComputedStyle(menu).position === 'fixed') menu.style.top = ((parseFloat(getComputedStyle(menu).top) || 0) + h) + 'px';
    }
    bar.addEventListener('click', function (e) {
      var t = e.target.closest('[data-t4t]'); if (!t) return;
      var a = t.getAttribute('data-t4t');
      if (a === 'signout') signOut(); else signIn(a === 'signup');
    });
    renderBar();
  }

  // Another tab or site signed in or out: refresh the bar when this tab comes back
  document.addEventListener('visibilitychange', function () { if (!document.hidden) renderBar(); });

  window.T4T = window.T4T || {};
  window.T4T.auth = { init: init, getIdToken: getIdToken, user: currentUser, signIn: signIn, signOut: signOut, mountBar: mountBar, decodeJwt: decodeJwt, clientId: CLIENT_ID, loginUrl: LOGIN_URL };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountBar); else mountBar();
})();
