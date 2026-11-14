/* Sankyo Chat — compatibility check (check.html). Standalone: no other app scripts needed. */
(function () {
  'use strict';
  const list = document.getElementById('checks');
  const summary = document.getElementById('summary');
  const results = [];

  function add(title, state, detail) {
    const li = document.createElement('li');
    li.className = state;
    const st = document.createElement('span');
    st.className = 'st';
    st.textContent = state === 'ok' ? '✓' : state === 'bad' ? '✗' : state === 'warn' ? '!' : '…';
    const box = document.createElement('div');
    const t = document.createElement('div'); t.className = 't'; t.textContent = title;
    const d = document.createElement('div'); d.className = 'd'; d.textContent = detail || '';
    box.append(t, d);
    li.append(st, box);
    list.appendChild(li);
    results.push(state);
    const bad = results.filter(s => s === 'bad').length;
    const warn = results.filter(s => s === 'warn').length;
    summary.textContent = bad ? `${bad} problem${bad > 1 ? 's' : ''} found: Sankyo Chat won’t work properly on this PC.`
      : warn ? `Mostly fine, with ${warn} warning${warn > 1 ? 's' : ''}.` : 'Everything checked so far works.';
    return li;
  }

  function browser() {
    const ua = navigator.userAgent;
    let m = /Edg\/(\d+)/.exec(ua);
    if (m) return { name: 'Microsoft Edge', v: +m[1] };
    m = /Chrome\/(\d+)/.exec(ua);
    if (m) return { name: 'Google Chrome', v: +m[1] };
    if (/Firefox\//.test(ua)) return { name: 'Firefox', v: 0 };
    return { name: 'Unknown browser', v: 0 };
  }

  async function run() {
    const b = browser();
    add('Browser', b.v >= 110 ? 'ok' : 'bad', b.v ? `${b.name} ${b.v}${b.v < 110 ? ' (version 110 or newer needed)' : ''}` : `${b.name}: use Edge or Chrome`);
    add('Opened from', location.protocol === 'file:' ? 'ok' : 'warn', location.protocol === 'file:' ? decodeURIComponent(location.pathname) : location.href + ' (expected a file on the shared drive)');
    add('Secure context', window.isSecureContext ? 'ok' : 'bad', window.isSecureContext ? 'Allowed to use folders and encryption' : 'The browser blocks secure features here');
    add('Folder access (File System Access API)', typeof window.showDirectoryPicker === 'function' ? 'ok' : 'bad',
      typeof window.showDirectoryPicker === 'function' ? 'Available' : 'Not available. IT policy may block it, or the browser is too old.');
    add('App version', 'ok', (window.SC && SC.VERSION) || 'unknown');

    try {
      localStorage.setItem('sc.check', '1'); localStorage.removeItem('sc.check');
      await new Promise((res, rej) => { const r = indexedDB.open('sankyo-check', 1); r.onsuccess = () => { r.result.close(); indexedDB.deleteDatabase('sankyo-check'); res(); }; r.onerror = () => rej(r.error); });
      add('Browser storage', 'ok', 'localStorage and IndexedDB work');
    } catch (e) { add('Browser storage', 'bad', 'Blocked: ' + e.message + '. The app can’t remember the folder or your sign-in.'); }

    try {
      const s = crypto.subtle;
      const t0 = performance.now();
      const sign = await s.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const sig = await s.sign({ name: 'ECDSA', hash: 'SHA-256' }, sign.privateKey, new TextEncoder().encode('hi'));
      const ok = await s.verify({ name: 'ECDSA', hash: 'SHA-256' }, sign.publicKey, sig, new TextEncoder().encode('hi'));
      const a = await s.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      const bk = await s.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      const bits = await s.deriveBits({ name: 'ECDH', public: bk.publicKey }, a.privateKey, 256);
      const key = await s.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await s.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('secret'));
      const pt = new TextDecoder().decode(await s.decrypt({ name: 'AES-GCM', iv }, key, ct));
      const base = await s.importKey('raw', new TextEncoder().encode('password'), 'PBKDF2', false, ['deriveBits']);
      const t1 = performance.now();
      await s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(16), iterations: 600000 }, base, 256);
      const t2 = performance.now();
      if (!ok || pt !== 'secret') throw new Error('round-trip failed');
      add('Encryption (Web Crypto)', 'ok', `ECDSA, ECDH, AES-GCM work · password unlock takes ${Math.round(t2 - t1)} ms · keys ${Math.round(t1 - t0)} ms`);
    } catch (e) { add('Encryption (Web Crypto)', 'bad', 'Not working: ' + e.message); }

    if ('Notification' in window) add('Desktop notifications', Notification.permission === 'denied' ? 'warn' : 'ok', 'Permission: ' + Notification.permission + (Notification.permission === 'denied' ? ' (unread counts and sound still work)' : ''));
    else add('Desktop notifications', 'warn', 'Not supported here (unread counts and sound still work)');

    try {
      const prev = await idbGet('dataHandle');
      if (prev) {
        const p = await prev.queryPermission({ mode: 'readwrite' });
        add('Remembered folder', p === 'granted' ? 'ok' : 'warn', `“${prev.name}”: ${p === 'granted' ? 'access remembered (no prompt next time)' : 'the browser will ask again; choose “Allow on every visit”'}`);
      }
    } catch { /* first run */ }
  }

  function idbGet(key) {
    return new Promise(resolve => {
      const r = indexedDB.open('sankyo-chat', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('cache'); };
      r.onsuccess = () => {
        try { const g = r.result.transaction('kv').objectStore('kv').get(key); g.onsuccess = () => resolve(g.result); g.onerror = () => resolve(null); } catch { resolve(null); }
      };
      r.onerror = () => resolve(null);
    });
  }

  document.getElementById('folder-test').addEventListener('click', async () => {
    if (typeof window.showDirectoryPicker !== 'function') { add('Shared folder test', 'bad', 'Folder access isn’t available in this browser.'); return; }
    let dir;
    try { dir = await window.showDirectoryPicker({ id: 'sankyo-data', mode: 'readwrite' }); } catch (e) { if (e.name !== 'AbortError') add('Shared folder test', 'bad', e.message); return; }
    const name = '_sankyo_check_' + Math.random().toString(36).slice(2, 8) + '.txt';
    try {
      const t0 = performance.now();
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write('Sankyo Chat check ' + new Date().toISOString());
      await w.close();
      const t1 = performance.now();
      const text = await (await fh.getFile()).text();
      const t2 = performance.now();
      if (!text.startsWith('Sankyo Chat check')) throw new Error('read back the wrong content');
      await dir.removeEntry(name);
      const t3 = performance.now();
      let n = 0;
      for await (const _ of dir.keys()) { n++; if (n > 500) break; }
      const t4 = performance.now();
      const hasWs = await dir.getFileHandle('workspace.json').then(() => true, () => false);
      add('Shared folder test', 'ok', `“${dir.name}”: write ${Math.round(t1 - t0)} ms, read ${Math.round(t2 - t1)} ms, delete ${Math.round(t3 - t2)} ms, list ${Math.round(t4 - t3)} ms`);
      add('Workspace in this folder', hasWs ? 'ok' : (dir.name === 'data' ? 'warn' : 'bad'), hasWs ? 'workspace.json found' : dir.name === 'data' ? 'No workspace yet: the first person to connect will be asked to create it' : 'This doesn’t look like the data folder');
    } catch (e) {
      add('Shared folder test', 'bad', `Failed: ${e.name}: ${e.message}. Check that you have Modify access to this folder.`);
      try { await dir.removeEntry(name); } catch { /* ignore */ }
    }
  });

  document.getElementById('notify-test').addEventListener('click', async () => {
    if (!('Notification' in window)) return add('Notification test', 'warn', 'Not supported');
    const p = await Notification.requestPermission();
    if (p !== 'granted') return add('Notification test', 'warn', 'Permission: ' + p);
    new Notification('Sankyo Chat', { body: 'Notifications work on this PC.', icon: 'assets/icon.svg' });
    add('Notification test', 'ok', 'A test notification was shown');
  });

  run().catch(e => add('Check', 'bad', e.message));
})();
