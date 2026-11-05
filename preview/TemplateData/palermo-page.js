// Palermo Noir's browser page around Unity (the WebGL design, docs/superpowers/specs/2026-10-31-palermo-webgl-design.md,
// sections 2 and 6.9), on window.PalermoPage. The page is the build's own index.html, served at vgraphics.gr's
// /vg--palermo-play/ and its preview, and framed full screen, from the same origin, by the site's four Palermo pages
// (/palermo/play/, /join/, /tv/ and /demo/), which tell it its route with ?route=. So "the page" players see is the top
// window: its address, title, language and reloads are the top window's (the page itself on the preview, which runs
// unframed). Unity reaches this file through Plugins/WebGL/PalermoPage.jslib, each call guarded, so a page one release
// older than the build only loses that call.
// ES5 throughout: a TV too old for Unity still reads it, and shows the "too old" card. The pure parts take what they read
// as arguments; unity/tools/web/palermo-page.test.mjs runs them in node against pretend windows.
(function (window) {
  "use strict";

  var ROUTES = { play: true, join: true, tv: true, demo: true };
  // The longest the loader waits for Unity's word that its first screen is drawn, should it never come (Exitwise's 8 s;
  // Unity's own cap is the same).
  var READY_MS = 8000;
  // A TV reloads itself once after a fatal error; a second one within 10 minutes shows the problem card (6.3).
  var CRASH_MS = 10 * 60 * 1000;
  // An "under 13" age answer lapses after a day (the kit's UNDER_AGE_HOLD_MS).
  var UNDER_AGE_HOLD_MS = 24 * 60 * 60 * 1000;
  // Unity's errors that end the visit (6.3): out of memory, and a WebAssembly trap, as Chrome, Firefox and Safari word
  // them ("RuntimeError: unreachable", "unreachable executed", "Unreachable code should not be executed"; "memory access
  // out of bounds", "Out of bounds memory access"). Unity's loader hands the page every error the window hears, so a
  // trap is matched by its own words, never by "unreachable" alone ("Server unreachable" is no trap). Anything else is
  // reported and the visit goes on.
  var FATAL = /Cannot enlarge memory arrays|Out of memory|could not allocate memory|Invalid array buffer length|Invalid typed array length|RuntimeError: unreachable|unreachable executed|Unreachable code should not be executed|memory access out of bounds|Out of bounds memory access/i;
  // A development build's forced errors (6.3), from ?probe=.
  var PROBES = { context: true, "throw": true, oom: true, halt: true };
  // ?metrics: how often its corner is redrawn, and how many picture files it names.
  var METRICS_MS = 1000;
  var METRICS_FILES = 6;
  // VHub's SDK for the browser (6.1), from the site: every route but the TV's, which never signs in.
  var HUB_SDK = "/hub/sdk/vhub-unity-1.js";
  // A host name for the emulators, as RoomsConfig and palermo-web take it.
  var HOST = /^[A-Za-z0-9.-]+$/;
  // A room's code (c, or code as a join link may carry it), a TV's display key, the demo's TV pairing code (tv) and how a
  // phone came: never in what goes to Google Analytics.
  var KEYS = /([?&#](?:k|c|code|tv|via)=)[^&#,\s"'<>]*/g;

  // The page's own words, before Unity draws any of its own: English, and Greek for a player who picked it.
  var WORDS = {
    en: {
      label: "Loading",
      loading: "Loading {n}%",
      starting: "Starting",
      problemTitle: "Something went wrong",
      problemText: "Palermo Noir stopped. Reload the page to carry on.",
      reload: "Reload",
      ok: "OK",
      upright: "Turn your phone upright",
      tooOldTitle: "Update your browser",
      tooOld: "This browser is too old for Palermo Noir. Update it, or open the game in Chrome, Safari or Firefox.",
      tooOldTvTitle: "This TV's browser is too old for Palermo Noir",
      tooOldTv: "Use a laptop on HDMI, an Android TV, or a newer TV."
    },
    el: {
      label: "Φόρτωση",
      loading: "Φόρτωση {n}%",
      starting: "Ξεκινάει",
      problemTitle: "Κάτι πήγε στραβά",
      problemText: "Το Palermo Noir σταμάτησε. Ανανέωσε τη σελίδα για να συνεχίσεις.",
      reload: "Ανανέωση",
      ok: "Εντάξει",
      upright: "Γύρισε το κινητό όρθιο",
      tooOldTitle: "Ενημέρωσε το πρόγραμμα περιήγησης",
      tooOld: "Αυτό το πρόγραμμα περιήγησης είναι πολύ παλιό για το Palermo Noir. Ενημέρωσέ το ή άνοιξε το παιχνίδι σε Chrome, Safari ή Firefox.",
      tooOldTvTitle: "Το πρόγραμμα περιήγησης αυτής της τηλεόρασης είναι πολύ παλιό για το Palermo Noir",
      tooOldTv: "Χρησιμοποίησε φορητό υπολογιστή με HDMI, Android TV ή νεότερη τηλεόραση."
    }
  };

  // This visit: its route, its clock (7.5), the splash handshake (2.2), the listeners it put on the top window, and what
  // the page's own words show (the loader's line, the card that's up), to say again in another language.
  var s = {
    route: "play", begun: null, downloaded: null, started: null,
    bar: null, ready: false, revealing: false, shown: null, watchers: [],
    fatal: false, hooks: [], hooked: false, percent: null, card: null,
    unity: null, files: [], peak: 0,
    address: null, backKey: -1e9, wake: null, waking: false, awake: false, wakeHooked: false, inRoom: false,
    zones: {}, zoneHeard: null, editing: null, editHooked: false
  };

  // The flags on the history entry Back's guard pushes and on the entry under it (watchBack), and how long a TV remote's
  // Back key holds off the popstate its browser may also send.
  var GUARD = "palermoGuard";
  var BASE = "palermoBase";
  var BACK_KEY_MS = 600;
  // A TV remote's Back: Samsung's 10009, LG's 461.
  var BACK_KEYS = { 10009: true, 461: true };

  function now() {
    return window.performance && window.performance.now ? window.performance.now() : new Date().getTime();
  }

  function decode(text) {
    try {
      return decodeURIComponent(text.replace(/\+/g, " "));
    } catch (e) {
      return text;
    }
  }

  // A query's names and values in order, read as URLSearchParams reads them, each with its own text kept.
  function pairs(search) {
    var out = [];
    var parts = String(search || "").replace(/^\?/, "").split("&");
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      var eq = parts[i].indexOf("=");
      out.push({
        text: parts[i],
        name: decode(eq < 0 ? parts[i] : parts[i].slice(0, eq)),
        value: decode(eq < 0 ? "" : parts[i].slice(eq + 1))
      });
    }
    return out;
  }

  // The first value of `name` in a query, or null.
  function get(search, name) {
    var all = pairs(search);
    for (var i = 0; i < all.length; i++) if (all[i].name === name) return all[i].value;
    return null;
  }

  // A value the kit keeps in localStorage, as JSON (its readStored), or null. Every access is guarded: private modes and
  // some TV browsers throw.
  function stored(key) {
    try {
      var text = window.localStorage.getItem(key);
      return text === null ? null : JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  // The tab's sessionStorage, or null where even reading the property throws.
  function session() {
    try {
      return window.sessionStorage || null;
    } catch (e) {
      return null;
    }
  }

  // The storage a scope names ("local": localStorage, "session": sessionStorage), or null where it can't be had.
  function storeOf(scope, win) {
    try {
      if (scope === "local") return win.localStorage || null;
      return scope === "session" ? win.sessionStorage || null : null;
    } catch (e) {
      return null;
    }
  }

  // A development switch from the address, kept for the tab under palermo-web's own key (web/src/config.ts), or the
  // tab's kept one when the address has none (F2): once Unity has rewritten the top window's address and the player
  // reloads, frame.js gives the frame a query without it.
  function kept(search, name, key) {
    var value = get(search, name);
    var store = session();
    if (!store) return value;
    try {
      if (value !== null) store.setItem(key, value);
      else value = store.getItem(key);
    } catch (e) {
      // no storage: the address alone decides
    }
    return value;
  }

  // Whether a media query holds in `win`, false where it can't be asked.
  function matches(win, query) {
    try {
      return !!(win.matchMedia && win.matchMedia(query).matches);
    } catch (e) {
      return false;
    }
  }

  // Whether the page is in a frame (the site's frame pages), read in a try.
  function framed(win) {
    try {
      return win.top !== win;
    } catch (e) {
      return true;
    }
  }

  // The window players see: the site's frame page on the four Palermo pages, the page itself on the preview. null when
  // another origin frames the page, since its window can't be reached.
  // A history entry's state with one of watchBack's marks (GUARD or BASE) and none of the other, the rest as it was.
  function marked(state, mark) {
    var copy = {};
    if (state && typeof state === "object") {
      for (var name in state) if (state.hasOwnProperty(name) && name !== GUARD && name !== BASE) copy[name] = state[name];
    }
    copy[mark] = true;
    return copy;
  }

  function topOf(win) {
    try {
      var top = win.top;
      if (top === win) return win;
      return top.location.href ? top : null;
    } catch (e) {
      return null;
    }
  }

  // An address without its query and hash.
  function bare(url) {
    return String(url || "").split(/[?#]/)[0];
  }

  function language(value) {
    if (typeof value !== "string") return null;
    if (value.indexOf("el") === 0) return "el";
    return value.indexOf("en") === 0 ? "en" : null;
  }

  function say(key, n) {
    var words = WORDS[window.document.documentElement.lang === "el" ? "el" : "en"];
    var text = words[key] || WORDS.en[key];
    return n === undefined ? text : text.replace("{n}", n);
  }

  function byId(id) {
    return window.document.getElementById(id);
  }

  function setText(id, text) {
    var element = byId(id);
    if (element) element.textContent = text;
  }

  // A card in: it rises from the foot and fades in (the page's <style>, .sheet).
  function show(element) {
    if (element) element.classList.add("open");
  }

  // While the edit sheet is up (6.7), #stage keeps the pixel height it had before: an Android in-app browser (a WebView)
  // still shrinks the frame for the keyboard, and Unity's canvas would re-fit behind the sheet. Let go, it follows the
  // frame again (100dvh).
  function holdStage(doc, held) {
    var stage = doc.getElementById("stage");
    if (!stage || !stage.style) return;
    if (!held) {
      stage.style.height = "";
      return;
    }
    if (stage.style.height) return;
    var height = stage.getBoundingClientRect ? stage.getBoundingClientRect().height : 0;
    if (height > 0) stage.style.height = Math.round(height) + "px";
  }

  // The cards' words, in the page's language as it is now.
  function problemWords() {
    setText("problem-title", say("problemTitle"));
    setText("problem-text", say("problemText"));
    var button = byId("problem-reload");
    if (button) button.textContent = say("reload");
  }

  function tooOldWords() {
    var tv = s.route === "tv";
    setText("too-old-title", say(tv ? "tooOldTvTitle" : "tooOldTitle"));
    setText("too-old-text", say(tv ? "tooOldTv" : "tooOld"));
  }

  // The page's own words again once its language changes: the upright line, the edit sheet's OK, the loader's line and
  // the name screen readers give its bar (the shared bar's aria-label), and the card that's up.
  function redraw() {
    setText("upright-text", say("upright"));
    setText("edit-ok", say("ok"));
    if (s.percent !== null) P.showPercent(s.percent);
    var bar = byId("loader-bar");
    if (bar && bar.getAttribute("aria-label")) bar.setAttribute("aria-label", say("label"));
    if (s.card === "problem") problemWords();
    else if (s.card === "too-old") tooOldWords();
  }

  // Tells Google Analytics (the page's analytics loader, window.palermoAnalytics) of an error.
  function report(text, fatal) {
    var analytics = window.palermoAnalytics;
    if (analytics && analytics.error) analytics.error(String(text), "", fatal);
  }

  // An error's text as Unity's loader writes it for the window's errors (error.toString(): "RangeError: …"), so the same
  // error reads the same whichever way it came: a text as it is, an Error by its name and message, anything else as it
  // turns into a text.
  function textOf(m) {
    if (typeof m === "string") return m;
    if (m && typeof m.message === "string" && m.message) return (m.name ? m.name + ": " : "") + m.message;
    if (m && typeof m.name === "string" && m.name) return m.name;
    return String(m);
  }

  // A TV's first fatal error reloads the top window; a second within 10 minutes doesn't, so it never loops (6.3).
  function reloadOnce() {
    var store = session();
    if (!store) return false;
    var t = new Date().getTime();
    try {
      var last = Number(store.getItem("pal:crashAt"));
      store.setItem("pal:crashAt", String(t));
      if (last && t - last < CRASH_MS) return false;
    } catch (e) {
      return false;
    }
    P.reloadWhenSafe();
    return true;
  }

  // The loader goes once the bar has settled, and Unity hears how long the key art was on screen (2.2, steps 3 and 4).
  function reveal() {
    if (s.revealing) return;
    s.revealing = true;
    var go = function () {
      s.bar.whenSettled(function () {
        var loader = byId("loader");
        if (loader) {
          loader.classList.add("done");
          setTimeout(function () {
            if (loader.parentNode) loader.parentNode.removeChild(loader);
          }, 400);
        }
        var ms = window.VGIntro && window.VGIntro.welcomeMs ? window.VGIntro.welcomeMs() : -1;
        s.shown = ms;
        var watchers = s.watchers.splice(0);
        for (var i = 0; i < watchers.length; i++) watchers[i](ms);
        // A development build's forced error, once the game is on screen (6.3).
        var kind = P.probeOf(window.location.search, window.palermoDevelopment === true);
        if (kind) setTimeout(function () { P.probe(kind, s.unity); }, 3000);
      });
    };
    // The VGraphics intro gives way first, if it's still on, and the key art gets its 2 s (the site's shared
    // /assets/startup/brand-intro.js).
    if (window.VGIntro && window.VGIntro.gameReady) window.VGIntro.gameReady(go);
    else go();
  }

  // A listener on the top window or its document, which comes off when this frame goes for good: on the frame's
  // pagehide when persisted is false. A page kept in the back-forward cache keeps them and comes back whole (6.9, W4).
  function onTop(target, type, listener) {
    target.addEventListener(type, listener, false);
    s.hooks.push([target, type, listener]);
    if (s.hooked) return;
    s.hooked = true;
    window.addEventListener("pagehide", function (event) {
      if (event && event.persisted) return;
      var hooks = s.hooks.splice(0);
      for (var i = 0; i < hooks.length; i++) {
        try {
          hooks[i][0].removeEventListener(hooks[i][1], hooks[i][2], false);
        } catch (e) {
          // a top window already gone
        }
      }
    }, false);
  }

  var P = {
    // The route from ?route=: play, join, tv or demo; missing or anything else is play. No path is read.
    route: function (search) {
      var route = get(search, "route");
      return route !== null && ROUTES.hasOwnProperty(route) ? route : "play";
    },

    // The rest of the query, less route, as its own text.
    query: function (search) {
      var all = pairs(search), out = [];
      for (var i = 0; i < all.length; i++) if (all[i].name !== "route") out.push(all[i].text);
      return out.join("&");
    },

    get: get,
    stored: stored,

    // PalermoPage_StoreGet/Set/Remove (6.8): where Prefs keeps in the browser build, the scope's storage by name ("local"
    // or "session"), each text as Prefs hands it (the kit's JSON for the kit's keys). Every access is guarded: a private
    // mode, a TV browser or a full store throws, and Prefs then keeps the value for the run. Get gives null for none.
    storeGet: function (scope, key, win) {
      var store = storeOf(scope, win || window);
      if (!store) return null;
      try {
        var text = store.getItem(String(key));
        return typeof text === "string" ? text : null;
      } catch (e) {
        return null;
      }
    },

    // True once kept.
    storeSet: function (scope, key, value, win) {
      var store = storeOf(scope, win || window);
      if (!store) return false;
      try {
        store.setItem(String(key), String(value));
        return true;
      } catch (e) {
        return false;
      }
    },

    storeRemove: function (scope, key, win) {
      var store = storeOf(scope, win || window);
      if (!store) return false;
      try {
        store.removeItem(String(key));
        return true;
      } catch (e) {
        return false;
      }
    },

    // The player's language: the one picked for Palermo (vg.party.palermo.language, which palermo-web and Unity's web
    // build both write), else the kit-wide one (vg.party.lang), else the browser's.
    pageLanguage: function (win) {
      return language(stored("vg.party.palermo.language")) || language(stored("vg.party.lang")) ||
        language(win.navigator && win.navigator.language) || "en";
    },

    // Whether vgraphics.gr/tv sent this TV here, having played the VGraphics film already (Hosting, "The TV's intro"):
    // the frame's own referrer is the frame page, so the top window's is read.
    sentByTvDoor: function (win) {
      try {
        return win.top.document.referrer.indexOf(win.location.origin + "/tv/") === 0;
      } catch (e) {
        return false;
      }
    },

    // The route script, before the first paint (2.2, head item 5): html gets route-<route>, no-intro on a join link
    // (Decision 1, "players first"), no-film on a TV vgraphics.gr/tv sent, framed in a frame, and the player's language.
    mark: function (html, win) {
      var search = win.location.search, route = P.route(search);
      var classes = ["route-" + route];
      if (route === "join" || (route === "play" && (get(search, "c") || get(search, "code")))) classes.push("no-intro");
      if (route === "tv" && P.sentByTvDoor(win)) classes.push("no-film");
      if (framed(win)) classes.push("framed");
      for (var i = 0; i < classes.length; i++) html.classList.add(classes[i]);
      html.lang = P.pageLanguage(win);
      return classes;
    },

    // What the page knows of this visit: the route, the rest of the query and the hash (the frame's own, which frame.js
    // copied from the top window), whether it's framed, the top window's path and query, whether this is a development
    // build, the TV's route (6.9: Device.IsTv), a touch screen by its pointer or its touch points, never by the user
    // agent (6.7: the edit sheet), and reduced motion.
    profile: function (route, win) {
      win = win || window;
      var top = topOf(win) || win;
      var nav = win.navigator || {};
      return {
        route: route,
        query: P.query(win.location.search),
        hash: win.location.hash || "",
        framed: framed(win),
        topPath: top.location.pathname,
        topSearch: top.location.search,
        development: win.palermoDevelopment === true,
        tv: route === "tv",
        touch: matches(win, "(pointer: coarse)") || nav.maxTouchPoints > 0,
        reducedMotion: matches(win, "(prefers-reduced-motion: reduce)"),
        inApp: P.inAppOf(nav.userAgent),
        dpr: win.devicePixelRatio || 1
      };
    },

    // An in-app browser (6.1, 6.5): Facebook's or Instagram's, an Android WebView, or an iPhone's without Safari, where
    // share, links and sign-in may be missing or act otherwise. Only the user agent tells.
    inAppOf: function (ua) {
      ua = String(ua || "");
      if (/FBAN|FBAV|Instagram/.test(ua)) return true;
      if (/Android/.test(ua) && /; wv\)/.test(ua)) return true;
      return /iPhone|iPad|iPod/.test(ua) && /AppleWebKit/.test(ua) && !/Safari\//.test(ua);
    },

    // PalermoPage_Profile: the profile as Unity reads it (WebRoute, WebPage).
    profileJson: function () {
      var p = P.profile(P.route(window.location.search), window);
      return JSON.stringify({
        route: p.route, query: p.query, hash: p.hash, framed: p.framed,
        topPath: p.topPath, topSearch: p.topSearch, development: p.development,
        tv: p.tv, touch: p.touch, reducedMotion: p.reducedMotion, inApp: p.inApp
      });
    },

    // VHub's SDK (2.2, body item 6): the route script adds it on every route but the TV's (a TV never signs in), loaded
    // beside the build, never ahead of it. Only where the browser parses it (ES2022's class fields, 7.3): elsewhere it
    // would fail while Unity loads, and Unity's loader takes any error then as its own start failing. True when added.
    hubSdk: function (doc, win) {
      win = win || window;
      if (P.route(win.location.search) === "tv" || !P.modern("play", win)) return false;
      var tag = doc.createElement("script");
      tag.src = HUB_SDK;
      tag.async = true;
      (doc.head || doc.documentElement).appendChild(tag);
      return true;
    },

    // A development build's command line from the address (2.2): ?emulator=<host> or off, ?vhub=on or off (both kept
    // for the tab), and ?phone. Never the route.
    devArguments: function (search) {
      var args = [];
      var emulator = kept(search, "emulator", "pal:emulator");
      var vhub = kept(search, "vhub", "pal:vhub");
      if (emulator !== null && HOST.test(emulator)) args.push("-emulator", emulator);
      if (vhub === "on" || vhub === "off") args.push("-vhub", vhub);
      if (get(search, "phone") !== null) args.push("-phone");
      return args;
    },

    // Unity's cache rule for every build file and every UnityWebRequest (2.4), resolved against the page's own folder, so
    // it holds at /vg--palermo-play/ and its preview alike: media named by their content never ask again, the build's
    // own files ask once a load, the rest never stay.
    cacheControl: function (url) {
      var here = window.location.href;
      var base = new URL(".", here).pathname;
      var path = new URL(url, here).pathname;
      var rest = path.indexOf(base) === 0 ? path.slice(base.length) : "";
      if (/^StreamingAssets\/media\/.+\.[0-9a-f]{8}\.\w+$/.test(rest)) return "immutable";
      if (/^Build\/PalermoNoir\./.test(rest)) return "must-revalidate";
      return "no-store";
    },

    // Whether Google Analytics may load (2.2, head item 8): "off" on our own test visits (a page served from this PC, a
    // file, or a browser a script drives), "debug" for a development build's ?ga=debug (GA4 DebugView), else "on".
    analytics: function (loc, nav, development) {
      if (development && get(loc.search, "ga") === "debug") return "debug";
      var host = String(loc.hostname || "").toLowerCase();
      if (loc.protocol === "file:" || host === "localhost" || host === "127.0.0.1" || host === "[::1]" ||
        /\.localhost$/.test(host) || (nav && nav.webdriver)) return "off";
      return "on";
    },

    // The consent mode at start (6.2), the kit's rule: the TV and the demo denied at once; a phone under 16 denied; a
    // phone of 16 and over with an answer, that answer; one that has answered without an age yet, denied; else null, to
    // wait for the app's palermo-analytics-consent.
    consentMode: function (route, age, answer, at) {
      if (route === "tv" || route === "demo") return "denied";
      var band = age && typeof age.at === "number" && (age.band === "under" || age.band === "13-15" || age.band === "16+") &&
        !(age.band === "under" && at - age.at >= UNDER_AGE_HOLD_MS) ? age.band : null;
      var said = answer && answer.v === 1 && typeof answer.at === "number" &&
        (answer.analytics === "granted" || answer.analytics === "denied") ? answer.analytics : null;
      if (band === "under" || band === "13-15") return "denied";
      if (said) return band === "16+" && said === "granted" ? "granted" : "denied";
      return null;
    },

    // What Google Analytics reads of the page (2.2, head item 8): the top window's address and referrer without their
    // queries, and its title, so the four pages stay apart and no room code or TV key goes with them. Unframed (the
    // preview), the page's own address with ?route= alone.
    pageInfo: function (win) {
      win = win || window;
      var top = topOf(win);
      if (top && top !== win) {
        return { location: bare(top.location.href), referrer: bare(top.document.referrer), title: top.document.title };
      }
      return {
        location: bare(win.location.href) + "?route=" + P.route(win.location.search),
        referrer: bare(win.document.referrer),
        title: win.document.title
      };
    },

    // An error's text without a room's code, a TV's key or how a phone came.
    cutKeys: function (text) {
      return String(text).replace(KEYS, "$1");
    },

    // Whether this browser runs Palermo Noir (7.3, 7.4): ES2020 (the rooms' Firebase SDK) and Web Audio (else Unity's
    // own alert()), and on a phone's routes the class fields of VHub's SDK. No: the "too old" card.
    modern: function (route, win) {
      win = win || window;
      var Fn = win.Function || Function;
      try {
        new Fn("return a?.b ?? 1");
        if (route === "play" || route === "join") new Fn("class A { static s = 1; f = 2 }");
      } catch (e) {
        return false;
      }
      return !!(win.AudioContext || win.webkitAudioContext);
    },

    // The start script's first step: the route, the clock, and the words the page shows before Unity.
    begin: function (route) {
      s.route = route;
      s.begun = now();
      setText("upright-text", say("upright"));
      setText("edit-ok", say("ok"));
      P.showPercent(0);
    },

    // The "too old" card, never the fallback, which couldn't run there either (7.4).
    tooOld: function () {
      s.card = "too-old";
      tooOldWords();
      show(byId("too-old"));
    },

    // The route's first pictures, fetched while Build/ downloads, so Unity's first requests find them in the HTTP cache
    // (2.4). The build writes each route's items in (WebGLOutput.FirstMediaJson): a picture's JPG or PNG, then its ASTC
    // copy where it has one, which the page takes where the device's WebGL has ASTC, as the loader does (ArtPick).
    prefetch: function (first, route, win) {
      win = win || window;
      var items = first && first[route];
      if (!items || !win.fetch) return [];
      var astc = null, fetched = [];
      for (var i = 0; i < items.length; i++) {
        var item = typeof items[i] === "string" ? [items[i]] : items[i];
        if (!item.length) continue;
        if (item.length > 1 && astc === null) astc = P.astc(win.document);
        var url = item.length > 1 && astc ? item[item.length - 1] : item[0];
        fetched.push(url);
        win.fetch(url)["catch"](function () {});
      }
      return fetched;
    },

    // Whether this device's WebGL takes ASTC (WEBGL_compressed_texture_astc), as SystemInfo.SupportsTextureFormat tells
    // Unity: asked of a throwaway context, let go at once, and only for a route whose first media has an ASTC copy.
    astc: function (doc) {
      try {
        var canvas = doc.createElement("canvas");
        var gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
        if (!gl) return false;
        var yes = !!gl.getExtension("WEBGL_compressed_texture_astc");
        var lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
        return yes;
      } catch (e) {
        return false;
      }
    },

    // The key art takes the loader once its picture can be drawn (the intro waits for with-art); a join link has none
    // (no-intro).
    watchArt: function (loader) {
      var art = byId("loader-art");
      var img = art && art.getElementsByTagName("img")[0];
      if (!img || window.document.documentElement.classList.contains("no-intro")) return;
      var ready = function () {
        var draw = function () { loader.classList.add("with-art"); };
        if (img.decode) img.decode().then(draw, function () {});
        else draw();
      };
      if (img.complete && img.naturalWidth) ready();
      else img.addEventListener("load", ready, false);
    },

    // The line under the bar: "Loading 42%", then "Starting" once full.
    showPercent: function (shown) {
      s.percent = shown;
      setText("loader-status", shown < 1 ? say("loading", Math.floor(shown * 100)) : say("starting"));
    },

    // A bar that does nothing, should the site's shared one not load.
    stubBar: function () {
      var none = function () {};
      return { show: none, pace: none, stop: none, whenSettled: function (then) { then(); } };
    },

    // On the TV the keys stay with the game (6.9): frame.js focuses the frame once, and a key or a tap on the top page
    // gives the focus back to it.
    relayFocus: function (route) {
      var top = topOf(window);
      if (route !== "tv" || !top || top === window) return;
      var back = function () {
        try {
          window.focus();
          var canvas = byId("unity-canvas");
          if (canvas) canvas.focus({ preventScroll: true });
        } catch (e) {
          // nothing to focus yet
        }
      };
      onTop(top.document, "keydown", back);
      onTop(top.document, "pointerdown", back);
    },

    onTop: onTop,

    // Unity's download (its progress to 0.9) and its start, on the page's own clock (7.5).
    progress: function (p) {
      if (p >= 0.9 && s.downloaded === null) s.downloaded = now();
    },

    started: function (unity, bar) {
      s.started = now();
      if (s.downloaded === null) s.downloaded = s.started;
      s.bar = bar;
      s.unity = unity;
      // ?metrics, kept for the tab, so a TV on the matrix keeps its corner after it pairs and reloads (2.6).
      if (kept(window.location.search, "metrics", "pal:metrics") !== null) P.metrics(unity);
      try {
        window.focus();
        var canvas = byId("unity-canvas");
        if (canvas) canvas.focus({ preventScroll: true });
      } catch (e) {
        // the focus is a nicety
      }
      setTimeout(P.ready, READY_MS);
      if (s.ready) reveal();
    },

    // The download and the start, in ms (null until known), for splash_shown.
    times: function () {
      return {
        download: s.begun === null || s.downloaded === null ? null : Math.round(s.downloaded - s.begun),
        start: s.downloaded === null || s.started === null ? null : Math.round(s.started - s.downloaded)
      };
    },

    // PalermoPage_Ready: Unity's first screen and its first pictures are drawn. The legal line fades out, since Unity's
    // screens draw their own, and the splash handshake runs once Unity has started.
    ready: function () {
      if (s.ready) return;
      s.ready = true;
      window.document.documentElement.classList.add("started");
      if (s.bar) reveal();
    },

    // PalermoPage_WatchSplash: cb(ms) once the loader fades, ms the key art's time on screen (-1 when it never showed,
    // as on a join link). Asked late, it answers at once.
    watchSplash: function (cb) {
      if (s.shown === null) s.watchers.push(cb);
      else setTimeout(function () { cb(s.shown); }, 0);
    },

    // PalermoPage_Address: the address players see and reload, {"route":"play|tv|demo","query":"k=…"|"","hash":null|"…"}.
    // Framed, the top window's, /palermo/<route>/ with the query, and the hash when one is given (null keeps the one
    // there); the frame's own address never changes (W3). Unframed (the preview), the page's own, with ?route=.
    address: function (json) {
      var a = json;
      if (typeof json === "string") {
        try {
          a = JSON.parse(json);
        } catch (e) {
          return;
        }
      }
      if (!a) return;
      var top = topOf(window);
      if (!top) return;
      var route = a.route === "tv" || a.route === "demo" ? a.route : "play";
      var query = a.query ? String(a.query).replace(/^\?/, "") : "";
      var hash = a.hash === null || a.hash === undefined ? top.location.hash : (a.hash ? "#" + String(a.hash).replace(/^#/, "") : "");
      var to = top !== window ?
        "/palermo/" + route + "/" + (query ? "?" + query : "") + hash :
        window.location.pathname + "?route=" + route + (query ? "&" + query : "") + hash;
      try {
        top.history.replaceState(top.history.state, "", to);
        // The address a Back that leaves the guard keeps (watchBack).
        s.address = to;
      } catch (e) {
        // an address the browser refuses stays as it was
      }
    },

    // PalermoPage_Language: the top window's lang and title in the player's language (a TV: its room's), and the page's
    // own words with them, which read the frame's own lang: one language per screen, framed too.
    language: function (lang, title) {
      var own = language(lang);
      if (own) {
        window.document.documentElement.lang = own;
        redraw();
      }
      var top = topOf(window) || window;
      try {
        top.document.documentElement.lang = lang;
        if (title) top.document.title = title;
      } catch (e) {
        // a page that can't be reached keeps its own
      }
    },

    // PalermoPage_ReloadWhenSafe: reload the top window, so the frame page and its address come back with the build.
    reloadWhenSafe: function () {
      (topOf(window) || window).location.reload();
    },

    // Errors (6.3). Fatal: out of memory, a WebAssembly trap, or the main loop's halt, which hands the page the
    // exception itself instead of a text.
    isFatal: function (m) {
      return typeof m !== "string" || FATAL.test(m);
    },

    // An error's text, the same whichever way it came (the window's hooks, Unity's errorHandler, the main loop's halt).
    errorText: textOf,

    // What makes two reports one error: the text's first line, without the "Uncaught " some engines put before the
    // window's errors. Unity's loader hands the page every error the window hears, which the analytics loader's own
    // hooks hear too, so each error is sent once (the analytics loader's exception()).
    errorKey: function (text) {
      return String(text).split("\n")[0].replace(/^Uncaught (?:\(in promise\) )?/, "").replace(/\s+$/, "");
    },

    // Unity's errorHandler: always true, so Unity never shows its alert(). A fatal error ends the visit calmly; any other
    // is reported and the visit goes on.
    pageError: function (m) {
      if (P.isFatal(m)) P.fatal(textOf(m));
      else report(textOf(m), false);
      return true;
    },

    // A fatal error, or a lost WebGL context (Unity never restores one): reported, then a phone gets the problem card
    // and a TV reloads once. (A TV's forward to the frozen page waits for that page's address.)
    fatal: function (what) {
      if (s.fatal) return;
      s.fatal = true;
      report(what, true);
      if (s.route === "tv" && reloadOnce()) return;
      P.problem();
    },

    // Unity couldn't start (createUnityInstance refused).
    failed: function (m) {
      report(textOf(m), true);
      P.problem();
    },

    // The calm card when something fails, with Reload, which reloads the top window.
    problem: function () {
      s.card = "problem";
      problemWords();
      var button = byId("problem-reload");
      if (button) button.onclick = function () { P.reloadWhenSafe(); };
      show(byId("problem"));
      if (button) {
        try {
          button.focus({ preventScroll: true });
        } catch (e) {
          // a remote can still reach it
        }
      }
    },

    // PalermoPage_Say: the site's slim bar in the player's language (the master, 3 Nov 2026, Q19). Each element of the
    // top document marked data-say="<key>" gets the text {"<key>": "<text>", …} names for it; keys it doesn't name stay
    // as they are, English while nothing fills them. Framed only (the preview has no bar), and never a throw: a top
    // window of another origin, or a text that isn't JSON, leaves the bar as it is.
    say: function (json) {
      try {
        var words = typeof json === "string" ? JSON.parse(json) : json;
        var top = topOf(window);
        if (!words || !top || top === window) return;
        var marked = top.document.querySelectorAll("[data-say]");
        for (var i = 0; i < marked.length; i++) {
          var key = marked[i].getAttribute("data-say");
          if (Object.prototype.hasOwnProperty.call(words, key) && typeof words[key] === "string") marked[i].textContent = words[key];
        }
      } catch (e) {
        // the bar stays as it is
      }
    },

    // A development build's forced error from ?probe= (6.3): context, throw, oom or halt; null in a release, or for
    // anything else.
    probeOf: function (search, development) {
      var kind = development ? get(search, "probe") : null;
      return kind !== null && PROBES.hasOwnProperty(kind) ? kind : null;
    },

    // Forces one kind of error, so the coordinator sees each one's way through the page (6.3), each by the road Unity's
    // own would take: "context" loses the game's WebGL context, as iOS backgrounding or a TV's GPU can; "throw" throws
    // an ordinary error on the window, reported while the visit goes on; "oom" throws the words Unity's heap gives when
    // it can't grow, on the window, whose errors Unity's loader hands to the page's errorHandler; "halt" calls the
    // errorHandler with an exception, not a text, as Unity's main loop does when it halts (W\lib\MainLoop.js:36-47).
    // False for a kind it can't force here.
    probe: function (kind, unity, win) {
      win = win || window;
      if (kind === "context") {
        var canvas = win.document.getElementById("unity-canvas");
        var gl = canvas && canvas.getContext && (canvas.getContext("webgl2") || canvas.getContext("webgl"));
        var lose = gl && gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
        return !!lose;
      }
      if (kind === "throw" || kind === "oom") {
        win.setTimeout(function () {
          throw kind === "oom" ? new RangeError("Cannot enlarge memory arrays (probe=oom)") : new Error("An ordinary error (probe=throw)");
        }, 0);
        return true;
      }
      if (kind === "halt") {
        var handler = unity && unity.Module && unity.Module.errorHandler;
        if (typeof handler === "function") handler(new Error("Halting program (probe=halt)"));
        else P.pageError(new Error("Halting program (probe=halt)"));
        return true;
      }
      return false;
    },

    // ?metrics (2.6): a corner with Unity's numbers (GetMetricsInfo: the WASM and JS heaps and their peak, the frame
    // rate), the page's own start times (7.5) and the last picture files the game named (metricsNote), redrawn each
    // second, in every build, since phones and TVs have no developer tools. It takes no taps.
    metrics: function (unity, win) {
      win = win || window;
      var doc = win.document;
      var corner = doc.getElementById("metrics");
      if (!corner) {
        corner = doc.createElement("pre");
        corner.id = "metrics";
        doc.body.appendChild(corner);
      }
      var draw = function () {
        corner.textContent = P.metricsText(unity);
      };
      draw();
      win.setInterval(draw, METRICS_MS);
      return corner;
    },

    // The corner's lines.
    metricsText: function (unity) {
      var mb = function (bytes) { return (bytes / 1048576).toFixed(1); };
      var lines = [];
      var info = null;
      try {
        info = unity && unity.GetMetricsInfo ? unity.GetMetricsInfo() : null;
      } catch (e) {
        info = null;
      }
      if (info) {
        var heaps = (info.totalWASMHeapSize || 0) + (info.totalJSHeapSize || 0);
        s.peak = Math.max(s.peak, heaps);
        lines.push("heaps " + mb(heaps) + " MB, peak " + mb(s.peak));
        lines.push("wasm " + mb(info.usedWASMHeapSize || 0) + "/" + mb(info.totalWASMHeapSize || 0) +
          " js " + mb(info.usedJSHeapSize || 0) + "/" + mb(info.totalJSHeapSize || 0));
        lines.push("fps " + (info.movingAverageFps || 0).toFixed(1));
      } else {
        lines.push("no metrics from Unity");
      }
      var t = P.times();
      lines.push("download " + (t.download === null ? "-" : t.download + " ms") + ", start " + (t.start === null ? "-" : t.start + " ms"));
      for (var i = 0; i < s.files.length; i++) lines.push(s.files[i]);
      return lines.join("\n");
    },

    // A picture file the game took (4.3: its JPG, PNG, ASTC copy or @half), for the ?metrics corner; the last few kept.
    metricsNote: function (text) {
      s.files.push(String(text));
      if (s.files.length > METRICS_FILES) s.files.shift();
    },

    // ---------- WP7's hooks (6.6, 6.9): Back, the page going and coming back, the hash, the wake lock, vibration, the
    // cursor and the room ----------

    // PalermoPage_WatchBack (6.9): the browser's Back as Android's. After the player's tap or key in the game, the top
    // window gets one guard entry on its history, over its own entry marked as the guard's base; Back leaves the guard
    // for the base, the address stays as it was, and back() runs Nav.Back (a sheet closes, a screen goes back). The guard
    // comes again with the next tap or key, since Chrome skips an entry pushed without one. A popstate onto an entry with
    // neither mark isn't Back: a new hash opened in the same tab (a second #n=), which watchHash hears. A TV remote's Back
    // (Samsung's 10009, LG's 461) runs back() at once, its default stopped. False where the top window can't be reached.
    watchBack: function (back, win) {
      win = win || window;
      var top = topOf(win);
      if (!top || !top.history || typeof top.history.pushState !== "function") return false;
      var arm = function () {
        if (P.guarded(top)) return;
        try {
          var href = top.location.href;
          top.history.replaceState(marked(top.history.state, BASE), "", href);
          top.history.pushState(marked(top.history.state, GUARD), "", href);
          s.address = href;
        } catch (e) {
          // no guard: Back leaves the page, as on any page
        }
      };
      var popped = function (event) {
        var state = event ? event.state : null;
        if (state && state[GUARD]) return;
        if (!(state && state[BASE])) {
          // Not Back: the page's own navigation, its address kept.
          s.address = top.location.href;
          return;
        }
        if (s.address !== null) {
          try {
            top.history.replaceState(state, "", s.address);
          } catch (e) {
            // the address Back left stays
          }
        }
        // Back with the edit sheet up closes the sheet, as Android's closes the keyboard first.
        if (s.editing !== null) {
          P.editClose("cancelled", win);
          return;
        }
        // A remote's Back key has run it already, if its browser went back as well.
        if (now() - s.backKey >= BACK_KEY_MS) back();
      };
      var key = function (event) {
        if (!event || !BACK_KEYS[event.keyCode || event.which]) return;
        if (event.preventDefault) event.preventDefault();
        s.backKey = now();
        back();
      };
      win.addEventListener("pointerdown", arm, true);
      win.addEventListener("keydown", arm, true);
      win.addEventListener("keydown", key, true);
      onTop(top, "popstate", popped);
      if (top !== win) onTop(top.document, "keydown", key);
      return true;
    },

    // Whether the top window stands on Back's guard.
    guarded: function (top) {
      try {
        var state = top.history.state;
        return !!(state && state[GUARD]);
      } catch (e) {
        return false;
      }
    },

    // PalermoPage_GoBehind: the browser's Back at home with nothing open leaves the page, as the browser would (Android's
    // moveTaskToBack); never on a TV, which stays on its game. Past the guard, if it's there.
    goBehind: function (win) {
      win = win || window;
      if (P.route(win.location.search) === "tv") return false;
      var top = topOf(win);
      if (!top || !top.history) return false;
      try {
        if (P.guarded(top)) top.history.go(-2);
        else top.history.back();
        return true;
      } catch (e) {
        return false;
      }
    },

    // PalermoPage_WatchVisibility: away(true) when the page goes out of sight (another tab, the phone locked, the page
    // leaving or frozen), away(false) when it shows again, as the kit's own page signals (client/page.js: a resume while
    // still hidden waits for the show). The frame's document shares the top window's visibility. Each change once.
    watchVisibility: function (away, win) {
      win = win || window;
      var doc = win.document;
      var hidden = doc.visibilityState === "hidden";
      var tell = function (gone) {
        if (gone === hidden) return;
        hidden = gone;
        away(gone);
      };
      var shown = function () { tell(doc.visibilityState === "hidden"); };
      doc.addEventListener("visibilitychange", shown, false);
      doc.addEventListener("freeze", function () { tell(true); }, false);
      doc.addEventListener("resume", shown, false);
      win.addEventListener("pagehide", function () { tell(true); }, false);
      win.addEventListener("pageshow", function (event) { if (event && event.persisted) shown(); }, false);
      if (hidden) away(true);
    },

    // PalermoPage_WatchHash: heard(hash) when the top window's hash changes, so a second #n= opened in the same tab
    // reaches Unity (frame.js reads it once).
    watchHash: function (heard, win) {
      win = win || window;
      var top = topOf(win) || win;
      onTop(top, "hashchange", function () {
        heard(top.location.hash || "");
      });
    },

    // PalermoPage_KeepAwake: the screen stays on while the page shows (the Screen Wake Lock; Screen.sleepTimeout does
    // nothing on the web), taken again each time the page comes back, since the browser lets it go when it hides. Off
    // lets it go. False where the browser has none.
    keepAwake: function (on, win) {
      win = win || window;
      var nav = win.navigator;
      if (!nav || !nav.wakeLock || typeof nav.wakeLock.request !== "function") return false;
      var doc = win.document;
      s.awake = !!on;
      if (!s.awake) {
        var lock = s.wake;
        s.wake = null;
        try {
          if (lock && !lock.released) lock.release();
        } catch (e) {
          // already gone
        }
        return true;
      }
      var take = function () {
        if (!s.awake || s.waking || doc.visibilityState === "hidden" || (s.wake && !s.wake.released)) return;
        s.waking = true;
        try {
          nav.wakeLock.request("screen").then(function (lock) {
            s.waking = false;
            // Switched off while it was coming: let it go at once.
            if (!s.awake) {
              lock.release();
              return;
            }
            s.wake = lock;
          }, function () {
            // refused (a low battery, a policy): the screen sleeps as it would
            s.waking = false;
          });
        } catch (e) {
          // the same
          s.waking = false;
        }
      };
      if (!s.wakeHooked) {
        s.wakeHooked = true;
        doc.addEventListener("visibilitychange", take, false);
      }
      take();
      return true;
    },

    // PalermoPage_Vibrate (6.6): a pattern in ms, [on, off, on, ...], or one buzz, as JSON or as it is, where the browser
    // vibrates (Android's; never an iPhone). True when it did.
    vibrate: function (pattern, win) {
      win = win || window;
      var buzz = pattern;
      if (typeof pattern === "string") {
        try {
          buzz = JSON.parse(pattern);
        } catch (e) {
          return false;
        }
      }
      var nav = win.navigator;
      if (!nav || typeof nav.vibrate !== "function") return false;
      try {
        return !!nav.vibrate(buzz);
      } catch (e) {
        return false;
      }
    },

    // PalermoPage_Cursor: the pointer over the game, as Unity's screens ask: "link" over something to press (the site's
    // link cursor, Palermo's on vgraphics.gr), "text" over a field, anything else the page's own.
    cursor: function (kind, win) {
      var canvas = (win || window).document.getElementById("unity-canvas");
      if (!canvas || !canvas.style) return;
      canvas.style.cursor = kind === "link" ? "var(--cursor-link, pointer)" : kind === "text" ? "var(--cursor-text, text)" : "";
    },

    // PalermoPage_InRoom: whether this screen is in a room (7.5: the TV's frame-rate watch reads it), with html.in-room.
    inRoom: function (on, win) {
      s.inRoom = !!on;
      var html = (win || window).document.documentElement;
      if (s.inRoom) html.classList.add("in-room");
      else html.classList.remove("in-room");
    },

    isInRoom: function () {
      return s.inRoom;
    },

    // ---------- WP7's gesture zones (6.5) and the edit sheet (6.7) ----------

    // PalermoZones_Watch: heard(id, outcome, text) for each zone's tap and the edit sheet's end (WebZones.cs).
    watchZones: function (heard) {
      s.zoneHeard = heard;
    },

    // PalermoZones_Set: a see-through button in #zones over a Unity button, placed in shares of the stage (#zones is the
    // stage's box), which does the zone's work inside the tap. Hidden while a Unity sheet covers its button.
    zoneSet: function (id, json, win) {
      win = win || window;
      var z = json;
      if (typeof json === "string") {
        try {
          z = JSON.parse(json);
        } catch (e) {
          return false;
        }
      }
      var box = win.document.getElementById("zones");
      if (!z || !box) return false;
      var zone = s.zones[id];
      if (!zone) {
        var button = win.document.createElement("button");
        button.type = "button";
        button.addEventListener("click", function (event) {
          if (event && event.preventDefault) event.preventDefault();
          P.zoneTap(id, win);
        }, false);
        box.appendChild(button);
        zone = s.zones[id] = { button: button, data: null };
      }
      zone.data = z;
      var b = zone.button;
      var share = function (n) {
        return Math.round(Math.max(0, Math.min(1, Number(n) || 0)) * 100000) / 1000 + "%";
      };
      b.setAttribute("aria-label", String(z.label || ""));
      b.style.left = share(z.left);
      b.style.top = share(z.top);
      b.style.width = share(z.width);
      b.style.height = share(z.height);
      b.style.display = z.shown === false ? "none" : "";
      return true;
    },

    // PalermoZones_Remove: the zone's button goes (its Unity button went).
    zoneRemove: function (id, win) {
      var zone = s.zones[id];
      if (!zone) return false;
      delete s.zones[id];
      var box = (win || window).document.getElementById("zones");
      try {
        if (box) box.removeChild(zone.button);
      } catch (e) {
        // already gone
      }
      return true;
    },

    // A zone's tap, inside the gesture: share (else copy), copy, a link, full screen, or the edit sheet.
    zoneTap: function (id, win) {
      win = win || window;
      var zone = s.zones[id];
      if (!zone || !zone.data) return false;
      var z = zone.data;
      var tell = function (outcome, text) {
        if (!s.zoneHeard) return;
        try {
          s.zoneHeard(id, outcome, text || "");
        } catch (e) {
          // nothing the game throws reaches the page
        }
      };
      var copied = function (ok) { tell(ok ? "copied" : "failed"); };
      if (z.kind === "share") {
        if (!P.share(z.title, z.text, win, tell)) P.copy(z.text, win, copied);
      } else if (z.kind === "copy") P.copy(z.text, win, copied);
      else if (z.kind === "link") tell(P.openLink(z.url, win) ? "opened" : "failed");
      else if (z.kind === "full") P.fullScreen(win, tell);
      else if (z.kind === "google" || z.kind === "apple") P.vhubPopup(z.kind, win, tell);
      else if (z.kind === "edit") {
        if (P.editOpen(id, z, win)) tell("editing");
      } else return false;
      return true;
    },

    // The sign-in card's Google (or Apple) button (6.1, 6.5): VHub's window opens from the tap itself, as browsers allow a
    // popup only there (VHubUnity.googlePopup, or applePopup once VHub has it). Tells "opening", then "answered" with the
    // bridge's answer as JSON (linked, conflict, cancelled, or an error such as popup-blocked) for WebVHubAccount's
    // PopupAnswer, or "failed" when the page's VHub has no such call or it threw.
    vhubPopup: function (kind, win, tell) {
      win = win || window;
      var bridge = win.VHubUnity, method = kind + "Popup";
      if (!bridge || typeof bridge[method] !== "function") {
        tell("failed", "VHubUnity." + method + " isn't on this page");
        return;
      }
      tell("opening");
      var call;
      try {
        call = Promise.resolve(bridge[method]());
      } catch (e) {
        call = Promise.reject(e);
      }
      call.then(function (answer) {
        tell("answered", JSON.stringify(answer === undefined ? null : answer));
      }, function (error) {
        tell("failed", error && error.message ? error.message : String(error));
      });
    },

    // Whether this screen shares through the browser: a touch screen with navigator.share (Share.CanShare). A computer's
    // share, where there is one, isn't the phone's way to send a room on.
    canShare: function (win) {
      win = win || window;
      var nav = win.navigator || {};
      return typeof nav.share === "function" && (matches(win, "(pointer: coarse)") || nav.maxTouchPoints > 0);
    },

    // The browser's share with the words (Invite's message and link), true when it opened; done(outcome) once it ends:
    // "shared", "cancelled", or, when the browser says the tap was too long ago (NotAllowedError) or it fails, the words
    // copied instead ("copied" or "failed").
    share: function (title, text, win, done) {
      win = win || window;
      done = done || function () {};
      if (!P.canShare(win)) return false;
      var asked;
      try {
        asked = win.navigator.share({ title: String(title || ""), text: String(text || "") });
      } catch (e) {
        return false;
      }
      if (asked && typeof asked.then === "function") {
        asked.then(function () {
          done("shared");
        }, function (error) {
          if (error && error.name === "AbortError") done("cancelled");
          else P.copy(text, win, function (ok) { done(ok ? "copied" : "failed"); });
        });
      } else done("shared");
      return true;
    },

    // The clipboard (the frame allows clipboard-write), else a hidden field's copy; done(true) once it holds the words.
    copy: function (text, win, done) {
      win = win || window;
      done = done || function () {};
      text = String(text || "");
      var byHand = function () {
        var doc = win.document, area = null, ok = false;
        try {
          area = doc.createElement("textarea");
          area.value = text;
          area.setAttribute("readonly", "");
          area.style.position = "fixed";
          area.style.top = "0";
          area.style.opacity = "0";
          doc.body.appendChild(area);
          if (area.select) area.select();
          ok = !!(doc.execCommand && doc.execCommand("copy"));
        } catch (e) {
          ok = false;
        }
        try {
          if (area) doc.body.removeChild(area);
        } catch (e) {
          // never put in
        }
        done(ok);
      };
      var clipboard = win.navigator && win.navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== "function") return byHand();
      try {
        clipboard.writeText(text).then(function () { done(true); }, byHand);
      } catch (e) {
        byHand();
      }
    },

    // A link (About, privacy, the hub) in a new tab, inside the tap, which popup blockers allow; true when it opened.
    openLink: function (url, win) {
      win = win || window;
      try {
        var opened = win.open(String(url || ""), "_blank");
        if (opened) {
          try {
            opened.opener = null;
          } catch (e) {
            // another origin's window
          }
        }
        return !!opened;
      } catch (e) {
        return false;
      }
    },

    // Full screen, or back out of it: the frame's element on the site's page (it covers the slim bar too; the frame
    // allows it), the page itself on the preview. done("full"), done("windowed") or done("failed"); never an iPhone's.
    fullScreen: function (win, done) {
      win = win || window;
      done = done || function () {};
      var top = topOf(win) || win;
      var doc = top.document;
      try {
        if (doc.fullscreenElement || doc.webkitFullscreenElement) {
          (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
          done("windowed");
          return true;
        }
        var target = top !== win && win.frameElement ? win.frameElement : win.document.documentElement;
        var ask = target.requestFullscreen || target.webkitRequestFullscreen;
        if (typeof ask !== "function") {
          done("failed");
          return false;
        }
        var asked = ask.call(target);
        if (asked && typeof asked.then === "function") asked.then(function () { done("full"); }, function () { done("failed"); });
        else done("full");
        return true;
      } catch (e) {
        done("failed");
        return false;
      }
    },

    // The edit sheet (6.7): the field's words in the page's own field, focused inside the tap so the keyboard comes up, a
    // number keyboard for codes, and the field's length. OK or Enter sends the words to the game; a tap beside the card,
    // Escape or Back leaves the field as it was.
    editOpen: function (id, z, win) {
      win = win || window;
      var doc = win.document;
      var sheet = doc.getElementById("edit-sheet"), input = doc.getElementById("edit-input");
      if (!sheet || !input) return false;
      P.hookEdit(win);
      s.editing = id;
      var label = doc.getElementById("edit-label");
      if (label) label.textContent = String(z.label || "");
      input.value = String(z.text || "");
      input.setAttribute("inputmode", z.numeric ? "numeric" : "text");
      if (z.max > 0) input.setAttribute("maxlength", String(z.max));
      else input.removeAttribute("maxlength");
      holdStage(doc, true);
      doc.documentElement.classList.add("editing");
      show(sheet);
      P.editLift(win);
      try {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      } catch (e) {
        // a field that can't place its caret still takes the keys
      }
      return true;
    },

    // The sheet goes (out a little faster, the page's <style>); "ok" sends its words.
    editClose: function (outcome, win) {
      win = win || window;
      var id = s.editing;
      if (id === null) return false;
      s.editing = null;
      var doc = win.document;
      var sheet = doc.getElementById("edit-sheet"), input = doc.getElementById("edit-input");
      var text = outcome === "ok" && input ? String(input.value || "") : "";
      if (sheet) sheet.classList.remove("open");
      doc.documentElement.classList.remove("editing");
      holdStage(doc, false);
      try {
        if (input) input.blur();
      } catch (e) {
        // already let go
      }
      if (s.zoneHeard) {
        try {
          s.zoneHeard(id, outcome === "ok" ? "ok" : "cancelled", text);
        } catch (e) {
          // nothing the game throws reaches the page
        }
      }
      return true;
    },

    // How far the keyboard covers the frame's foot, as --edit-lift on the sheet: the top window's visualViewport (the
    // keyboard shrinks the top window's, not the frame's), less the frame's place in the top page; the page's own on the
    // preview.
    editLift: function (win) {
      win = win || window;
      var sheet = win.document.getElementById("edit-sheet");
      var top = topOf(win) || win;
      var view = top.visualViewport;
      var lift = 0;
      if (view) {
        var frameTop = 0;
        try {
          if (top !== win && win.frameElement) frameTop = win.frameElement.getBoundingClientRect().top;
        } catch (e) {
          frameTop = 0;
        }
        lift = Math.max(0, Math.round(frameTop + (win.innerHeight || 0) - (view.offsetTop + view.height)));
      }
      if (sheet && sheet.style && sheet.style.setProperty) sheet.style.setProperty("--edit-lift", lift + "px");
      return lift;
    },

    // The sheet's own listeners, once: OK, Enter and Escape, a tap beside the card, and the keyboard moving.
    hookEdit: function (win) {
      if (s.editHooked) return;
      s.editHooked = true;
      var doc = win.document;
      var sheet = doc.getElementById("edit-sheet"), input = doc.getElementById("edit-input"), ok = doc.getElementById("edit-ok");
      if (ok) ok.addEventListener("click", function () { P.editClose("ok", win); }, false);
      input.addEventListener("keydown", function (event) {
        var key = event && (event.keyCode || event.which);
        if (key !== 13 && key !== 27) return;
        if (event.preventDefault) event.preventDefault();
        P.editClose(key === 13 ? "ok" : "cancelled", win);
      }, false);
      sheet.addEventListener("click", function (event) {
        if (event && event.target === sheet) P.editClose("cancelled", win);
      }, false);
      var top = topOf(win) || win;
      var view = top.visualViewport;
      var lift = function () { if (s.editing !== null) P.editLift(win); };
      if (view && view.addEventListener) {
        onTop(view, "resize", lift);
        onTop(view, "scroll", lift);
      }
    },

    // Whether the edit sheet is up.
    isEditing: function () {
      return s.editing !== null;
    },

    // The page's own words in the page's language.
    word: say
  };

  window.PalermoPage = P;
})(window);
