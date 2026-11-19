/* Sankyo Chat — shared helpers (no DOM access except where noted).
 * Classic script: everything hangs off the global SC namespace, because
 * Chrome/Edge refuse to load ES modules from file:// pages. */
(function (root) {
  'use strict';
  const SC = root.SC = root.SC || {};
  /** @namespace SC.util */
  const U = {};

  const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const DAY_MS = 86400000;
  U.DAY_MS = DAY_MS;
  U.DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  /** message / event file names: <ts>_<userId>_<rand>[.ev].json */
  U.MSG_RE = /^(\d{13})_([a-z0-9]{4})_([a-z0-9]{4})(\.ev)?\.json$/;

  /** Random id from a 36-char alphabet. @param {number} n */
  U.rand = function (n, alphabet = ALPHA) {
    const buf = new Uint8Array(n);
    root.crypto.getRandomValues(buf);
    let s = '';
    for (let i = 0; i < n; i++) s += alphabet[buf[i] % alphabet.length];
    return s;
  };

  /** @param {ArrayBuffer|Uint8Array} buf */
  U.b64 = function (buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  };
  /** @param {string} str @returns {Uint8Array} */
  U.unb64 = function (str) {
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  };
  U.hex = function (buf) {
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  };
  U.utf8 = s => new TextEncoder().encode(s);
  U.unutf8 = b => new TextDecoder().decode(b);

  /** Deterministic JSON (sorted keys, undefined dropped) — what signatures cover. */
  U.canonical = function canon(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  };

  /** UTC day key used for folder names. */
  U.dayKey = ts => new Date(ts).toISOString().slice(0, 10);
  U.dayStart = day => Date.parse(day + 'T00:00:00Z');
  /** Day keys from..to inclusive (max 400). */
  U.daysBetween = function (fromTs, toTs) {
    const out = [];
    let t = U.dayStart(U.dayKey(Math.min(fromTs, toTs)));
    const end = U.dayStart(U.dayKey(Math.max(fromTs, toTs)));
    while (t <= end && out.length < 400) { out.push(U.dayKey(t)); t += DAY_MS; }
    return out;
  };

  /** @returns {{ts:number,userId:string,id:string,event:boolean}|null} */
  U.parseMsgName = function (name) {
    const m = U.MSG_RE.exec(name);
    if (!m) return null;
    return { ts: Number(m[1]), userId: m[2], id: `${m[1]}_${m[2]}_${m[3]}`, event: !!m[4] };
  };

  U.dmId = (a, b) => 'dm_' + [a, b].sort().join('_');

  U.escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  U.formatSize = function (n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  };
  U.formatTime = ts => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  U.localDay = ts => { const d = new Date(ts); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  U.formatDayLabel = function (ts) {
    const now = Date.now();
    if (U.localDay(ts) === U.localDay(now)) return 'Today';
    if (U.localDay(ts) === U.localDay(now - DAY_MS)) return 'Yesterday';
    const d = new Date(ts);
    const opts = { weekday: 'long', month: 'long', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString([], opts);
  };
  /** Facebook style: "Today at 3:45 PM", "Yesterday at…", "Tomorrow at…", "Monday at…" (past week),
   *  "November 12 at 3:45 PM" (this year), "November 12, 2025 at 3:45 PM" (older). */
  U.formatDateTime = function (ts) {
    const now = Date.now(), d = new Date(ts), t = U.formatTime(ts);
    const day = U.localDay(ts);
    if (day === U.localDay(now)) return 'Today at ' + t;
    if (day === U.localDay(now - DAY_MS)) return 'Yesterday at ' + t;
    if (day === U.localDay(now + DAY_MS)) return 'Tomorrow at ' + t;
    if (ts < now && now - ts < 6 * DAY_MS) return d.toLocaleDateString([], { weekday: 'long' }) + ' at ' + t;
    const opts = { month: 'long', day: 'numeric' };
    if (d.getFullYear() !== new Date(now).getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString([], opts) + ' at ' + t;
  };
  /** Full date for tooltips: "Wednesday, November 19, 2026 at 3:45 PM". */
  U.formatFull = ts => new Date(ts).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + ' at ' + U.formatTime(ts);
  /** Facebook style relative time: "just now", "5m ago", "3h ago" (today), then "Yesterday at 3:45 PM", etc. */
  U.relTime = function (ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400 && U.localDay(ts) === U.localDay(Date.now())) return Math.floor(s / 3600) + 'h ago';
    return U.formatDateTime(ts);
  };

  U.safeFileName = function (name) {
    const clean = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').trim();
    return (clean || 'file').slice(-120);
  };

  U.sleep = ms => new Promise(r => setTimeout(r, ms));
  U.debounce = function (fn, ms) {
    let t = 0;
    return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
  };
  U.uniq = arr => Array.from(new Set(arr));

  /** Run fn over items with at most `limit` in flight. */
  U.mapLimit = async function (items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const worker = async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  };

  /** Tiny event emitter. */
  U.emitter = function () {
    const map = new Map();
    return {
      on(type, fn) { if (!map.has(type)) map.set(type, new Set()); map.get(type).add(fn); return () => map.get(type).delete(fn); },
      emit(type, data) { (map.get(type) || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); },
    };
  };

  /** Work out the data folder path from where index.html was opened. */
  U.dataPathFromLocation = function (href) {
    try {
      const u = new URL(href);
      if (u.protocol !== 'file:') return '';
      let p = decodeURIComponent(u.pathname).replace(/\/[^/]*$/, '');
      if (u.host) return '\\\\' + u.host + p.replace(/\//g, '\\') + '\\data';
      p = p.replace(/^\/([A-Za-z]:)/, '$1');
      return p.replace(/\//g, '\\') + '\\data';
    } catch { return ''; }
  };

  /* ---- localStorage (per-browser conveniences) ---- */
  U.ls = {
    get(key, def) {
      try { const v = root.localStorage.getItem('sc.' + key); return v == null ? def : JSON.parse(v); } catch { return def; }
    },
    set(key, val) { try { root.localStorage.setItem('sc.' + key, JSON.stringify(val)); } catch { /* ignore */ } },
    del(key) { try { root.localStorage.removeItem('sc.' + key); } catch { /* ignore */ } },
  };

  /* ---- IndexedDB: folder handle, unlocked keys, immutable message cache ---- */
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') return reject(new Error('No IndexedDB'));
        const r = indexedDB.open('sankyo-chat', 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('cache'); };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      dbp.catch(() => { dbp = null; });
    }
    return dbp;
  }
  function tx(store, mode, fn) {
    return db().then(d => new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      const res = fn(s);
      t.oncomplete = () => resolve(res && 'result' in res ? res.result : res);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }
  U.idb = {
    async get(store, key) { try { return await tx(store, 'readonly', s => s.get(key)); } catch { return undefined; } },
    async set(store, key, val) { try { await tx(store, 'readwrite', s => { s.put(val, key); }); return true; } catch { return false; } },
    async del(store, key) { try { await tx(store, 'readwrite', s => { s.delete(key); }); } catch { /* ignore */ } },
    /** @returns {Promise<Object<string,any>>} */
    async getMany(store, keys) {
      const out = {};
      if (!keys.length) return out;
      try {
        await tx(store, 'readonly', s => { keys.forEach(k => { const r = s.get(k); r.onsuccess = () => { if (r.result !== undefined) out[k] = r.result; }; }); });
      } catch { /* ignore */ }
      return out;
    },
    async setMany(store, entries) {
      if (!entries.length) return;
      try { await tx(store, 'readwrite', s => { entries.forEach(([k, v]) => s.put(v, k)); }); } catch { /* cache is optional */ }
    },
  };

  SC.util = U;
})(typeof window !== 'undefined' ? window : globalThis);
