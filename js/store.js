/* Sankyo Chat — store: the ONLY module that touches the shared folder.
 * Wraps a FileSystemDirectoryHandle (the picked `data` folder) with
 * path-based helpers. Writes go through createWritable(), which Edge/Chrome
 * stage in a .crswap file and swap in on close, so readers never see half a
 * file; listings skip those temp files. */
(function (root) {
  'use strict';
  const SC = root.SC = root.SC || {};
  const U = SC.util;
  /** @namespace SC.store */
  const S = {};

  /** @type {FileSystemDirectoryHandle|null} */
  let rootHandle = null;
  /** @type {Map<string, FileSystemDirectoryHandle>} */
  const dirCache = new Map();

  S.setRoot = h => { rootHandle = h; dirCache.clear(); };
  S.getRoot = () => rootHandle;

  const parts = p => String(p).split('/').filter(Boolean);
  const ignored = n => n.endsWith('.crswap') || n.startsWith('.') || n.startsWith('~$') || n === 'desktop.ini' || n === 'Thumbs.db';
  S.isIgnored = ignored;

  function invalidate(ps) {
    const key = '/' + ps.join('/');
    for (const k of Array.from(dirCache.keys())) if (k === key || k.startsWith(key + '/')) dirCache.delete(k);
  }

  async function getDir(ps, create) {
    if (!rootHandle) throw Object.assign(new Error('No folder connected'), { name: 'NotAllowedError' });
    let h = rootHandle;
    let key = '';
    for (const p of ps) {
      key += '/' + p;
      const c = dirCache.get(key);
      if (c) { h = c; continue; }
      h = await h.getDirectoryHandle(p, { create: !!create });
      dirCache.set(key, h);
    }
    return h;
  }

  /** Retry once with fresh directory handles if a cached one went stale. */
  async function fresh(ps, fn) {
    try { return await fn(); } catch (e) {
      if (e && e.name === 'NotFoundError' && ps.length && dirCache.has('/' + ps[0])) {
        invalidate(ps.slice(0, 1));
        return await fn();
      }
      throw e;
    }
  }

  async function fileHandle(path, create) {
    const ps = parts(path);
    const name = ps.pop();
    return fresh(ps, async () => (await getDir(ps, create)).getFileHandle(name, { create: !!create }));
  }

  /** @returns {Promise<File|null>} null when missing */
  S.readFile = async function (path) {
    try { return await (await fileHandle(path, false)).getFile(); } catch (e) {
      if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return null;
      throw e;
    }
  };
  S.readText = async function (path) {
    const f = await S.readFile(path);
    return f ? f.text() : null;
  };
  /** Missing or unreadable JSON → null (corrupt files are logged, never thrown). */
  S.readJSON = async function (path) {
    const t = await S.readText(path);
    if (t == null) return null;
    try { return JSON.parse(t); } catch { console.warn('Skipping unreadable file', path); return null; }
  };
  /** Read JSON only when the file changed since `prevModified`. */
  S.readJSONIfChanged = async function (path, prevModified) {
    const f = await S.readFile(path);
    if (!f) return { missing: true };
    if (prevModified && f.lastModified === prevModified) return { unchanged: true, lastModified: f.lastModified };
    try { return { data: JSON.parse(await f.text()), lastModified: f.lastModified }; } catch { return { data: null, lastModified: f.lastModified }; }
  };

  /** @param {string|Blob|ArrayBuffer|Uint8Array} data */
  S.write = async function (path, data) {
    const fh = await fileHandle(path, true);
    const w = await fh.createWritable();
    try { await w.write(data); await w.close(); } catch (e) {
      try { await w.abort(); } catch { /* ignore */ }
      throw e;
    }
  };
  S.writeJSON = (path, obj) => S.write(path, JSON.stringify(obj));

  /** List entry names in a folder (missing folder → []). @param {'file'|'directory'} [kind] */
  S.list = async function (path, kind) {
    const ps = parts(path || '');
    try {
      return await fresh(ps, async () => {
        const dir = await getDir(ps, false);
        const out = [];
        for await (const [name, h] of dir.entries()) {
          if (ignored(name)) continue;
          if (kind && h.kind !== kind) continue;
          out.push(name);
        }
        return out;
      });
    } catch (e) {
      if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return [];
      throw e;
    }
  };

  S.remove = async function (path, recursive = false) {
    const ps = parts(path);
    const name = ps.pop();
    try {
      await fresh(ps, async () => (await getDir(ps, false)).removeEntry(name, { recursive }));
      invalidate(ps.concat(name));
      return true;
    } catch (e) {
      if (e && e.name === 'NotFoundError') return false;
      throw e;
    }
  };

  S.exists = async path => (await S.readFile(path)) !== null;

  /* ---- permissions & handle persistence ---- */
  S.queryPermission = async function (h = rootHandle) {
    if (!h) return 'denied';
    if (!h.queryPermission) return 'granted';
    try { return await h.queryPermission({ mode: 'readwrite' }); } catch { return 'denied'; }
  };
  S.requestPermission = async function (h = rootHandle) {
    if (!h || !h.requestPermission) return 'granted';
    return h.requestPermission({ mode: 'readwrite' });
  };
  S.saveHandle = h => U.idb.set('kv', 'dataHandle', h);
  S.loadHandle = () => U.idb.get('kv', 'dataHandle');
  S.forgetHandle = () => U.idb.del('kv', 'dataHandle');

  /** True for errors that mean "we can't reach the folder any more". */
  S.isAccessError = e => !!e && ['NotAllowedError', 'SecurityError', 'NotReadableError', 'InvalidStateError', 'AbortError', 'NetworkError'].includes(e.name);

  SC.store = S;
})(typeof window !== 'undefined' ? window : globalThis);
