/* Sankyo Chat — backups of the data folder, run by the super admin's app.
 *
 * The super admin picks a backup folder once (Admin settings → Backups). This browser remembers it
 * (IndexedDB, like the data folder). While the super admin is signed in, the app checks every hour
 * whether anything in data changed since the last backup, and if so copies just the changed files
 * into TODAY's folder, data-YYYY-MM-DD. Nothing changed → nothing is written. A new day → a new folder.
 *
 *  - Files are added and overwritten in the day's folder, never deleted from it: if part of data is
 *    deleted by accident, the day's backup still has it.
 *  - If data suddenly holds a different workspace (someone started a new one over a deleted folder),
 *    today's folder is left alone and the copy goes to data-YYYY-MM-DD_2.
 *  - A brand-new day folder gets workspace.json last, so a copy that stopped half-way (no
 *    workspace.json) is never offered for restore.
 *  - Day folders older than KEEP_DAYS are deleted. Never while data is empty.
 *
 * What's in each day folder is tracked in .sankyo-backup.json (a dot-file the app's listings skip):
 * the size and modified time of every data file at the last backup, which is how changes are found.
 *
 * A browser page only runs while it is open. To keep backing up while the super admin's app is
 * closed, backup\SankyoBackup.ps1 (Windows Task Scheduler) writes the same day folders.
 *
 * Restore runs before anyone signs in: when the connected data folder is empty, the app offers to
 * COPY a backup into it. The app then works on that copy; the backup itself is never changed. */
(function (root) {
  'use strict';
  const SC = root.SC;
  const U = SC.util, S = SC.store, UI = SC.ui;
  const h = (...a) => UI.h(...a);
  /** @namespace SC.backup */
  const B = {};

  const HANDLE_KEY = 'backupHandle';
  const MARK = '.sankyo-backup.json';
  // data-2026-11-21 (daily), data-2026-11-21_2 (second workspace that day), data-2026-11-21_14-00-00 (older hourly copies)
  const NAME_RE = /^data-(\d{4})-(\d{2})-(\d{2})(?:_(\d{2})-(\d{2})-(\d{2})|_(\d{1,2}))?$/;
  const SKIP_TOP = new Set(['presence']); // who's online right now: meaningless in a backup
  const EVERY_MS = 60 * 60000;
  const CHECK_MS = 5 * 60000;
  const KEEP_DAYS = 30;
  B.KEEP_DAYS = KEEP_DAYS;

  /** @type {FileSystemDirectoryHandle|null} */
  let handle = null;
  let timer = 0, firstTimer = 0, running = false, started = false;
  const st = { status: 'unknown', error: '', last: U.ls.get('backup.last', null), lastCheck: U.ls.get('backup.lastCheck', 0), progress: '' };
  const listeners = new Set();
  B.onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  const changed = () => listeners.forEach(fn => { try { fn(); } catch (e) { console.warn(e); } });
  /** @returns {{status:'unknown'|'off'|'ok'|'running'|'needsPermission'|'error', error:string, last:any, lastCheck:number, progress:string, folder:string}} */
  B.state = () => Object.assign({}, st, { folder: handle ? handle.name : '' });

  const pad = n => String(n).padStart(2, '0');
  const dayName = d => `data-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  /** Start of the folder's day (or the exact time for old hourly copies). */
  const nameTime = n => {
    const m = NAME_RE.exec(n);
    if (!m) return 0;
    return m[4] ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  };
  B.formatSize = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';

  async function perm(hd, ask) {
    if (!hd.queryPermission) return 'granted';
    let p = await hd.queryPermission({ mode: 'readwrite' });
    if (p !== 'granted' && ask) p = await hd.requestPermission({ mode: 'readwrite' });
    return p;
  }
  async function hasFile(dir, name) {
    try { await dir.getFileHandle(name); return true; } catch { return false; }
  }
  async function readJSONIn(dir, name) {
    try { return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text()); } catch { return null; }
  }
  async function writeIn(dir, name, data) {
    const out = await (await dir.getFileHandle(name, { create: true })).createWritable();
    try { await out.write(data); await out.close(); } catch (e) { try { await out.abort(); } catch { /* ignore */ } throw e; }
  }
  async function dirAt(base, parts) {
    let d = base;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
    return d;
  }

  /** Every file under the data folder: path → File (lazy, nothing is read yet). */
  async function scan(dir) {
    const out = new Map();
    async function walk(d, prefix, top) {
      for await (const [name, hd] of d.entries()) {
        if (S.isIgnored(name) || (top && SKIP_TOP.has(name))) continue;
        try {
          if (hd.kind === 'directory') await walk(hd, prefix + name + '/', false);
          else { const f = await hd.getFile(); f.handle = hd; out.set(prefix + name, f); }
        } catch (e) {
          if (e && e.name === 'NotFoundError') continue; // deleted while we looked (7-day clean-up)
          throw e;
        }
      }
    }
    await walk(dir, '', true);
    return out;
  }

  /**
   * Copy a whole tree (restore). Top-level workspace.json goes last, so a copy cut off half-way
   * never looks complete. @returns {Promise<{files:number, bytes:number}>}
   */
  async function copyTree(src, dst, { onFile } = {}) {
    const stats = { files: 0, bytes: 0 };
    const files = await scanAll(src);
    const order = files.filter(([p]) => p !== 'workspace.json').concat(files.filter(([p]) => p === 'workspace.json'));
    for (const [p, f] of order) {
      const parts = p.split('/'); const name = parts.pop();
      await writeIn(await dirAt(dst, parts), name, f);
      stats.files++; stats.bytes += f.size;
      if (onFile) onFile(stats);
    }
    return stats;
  }
  async function scanAll(dir) {
    const out = [];
    async function walk(d, prefix) {
      for await (const [name, hd] of d.entries()) {
        if (S.isIgnored(name)) continue; // includes the .sankyo-backup.json record
        if (hd.kind === 'directory') await walk(hd, prefix + name + '/');
        else out.push([prefix + name, await hd.getFile()]);
      }
    }
    await walk(dir, '');
    return out;
  }

  /**
   * Backups inside a folder, newest first. Accepts the backup folder itself or one backup in it.
   * @returns {Promise<Array<{name:string, ts:number, day:number, dir:FileSystemDirectoryHandle, done:boolean, files?:number, bytes?:number, wsName?:string}>>}
   */
  async function listBackups(folder, { includeUnfinished = false } = {}) {
    const one = async (name, dir) => {
      const done = await hasFile(dir, 'workspace.json');
      const info = (done && await readJSONIn(dir, MARK)) || {};
      const day = nameTime(name);
      return { name, dir, done, day, ts: info.ts || day || 0, files: info.count, bytes: info.bytes, wsName: info.wsName };
    };
    if (NAME_RE.test(folder.name) || await hasFile(folder, 'workspace.json')) {
      const b = await one(folder.name, folder);
      return b.done ? [b] : [];
    }
    const out = [];
    for await (const [name, hd] of folder.entries()) {
      if (hd.kind !== 'directory' || !NAME_RE.test(name)) continue;
      const b = await one(name, hd);
      if (b.done || includeUnfinished) out.push(b);
    }
    return out.sort((a, b) => b.ts - a.ts || b.name.localeCompare(a.name));
  }
  B.listBackups = listBackups;

  async function prune() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const cutoff = today.getTime() - KEEP_DAYS * 86400000;
    for (const b of await listBackups(handle, { includeUnfinished: true })) {
      if (!b.day || b.day >= today.getTime()) continue;           // never today's
      if (b.day >= cutoff && b.done) continue;
      try { await handle.removeEntry(b.name, { recursive: true }); } catch (e) { console.warn('Could not prune backup', b.name, e); }
    }
  }

  /** Today's folder for this workspace: data-YYYY-MM-DD, or _2, _3… if another workspace already has it. */
  async function todaysFolder(wsId) {
    const base = dayName(new Date());
    for (let i = 1; i < 20; i++) {
      const name = i === 1 ? base : `${base}_${i}`;
      let dir = null;
      try { dir = await handle.getDirectoryHandle(name); } catch { /* not there yet */ }
      if (!dir) return { name, dir: await handle.getDirectoryHandle(name, { create: true }), mark: null };
      const mark = await readJSONIn(dir, MARK);
      const id = (mark && mark.wsId) || ((await readJSONIn(dir, 'workspace.json')) || {}).id;
      if (!id || id === wsId) return { name, dir, mark };
    }
    throw new Error('Too many different workspaces were backed up today.');
  }

  async function withLock(fn) {
    if (!navigator.locks) return fn();
    return navigator.locks.request('sankyo-backup', { ifAvailable: true }, lock => (lock ? fn() : null));
  }

  /**
   * Check data against today's backup and copy whatever changed.
   * @param {{ask?:boolean}} [o] ask: we're inside a click, so the browser may show its permission prompt
   * @returns {Promise<null|{name:string, ts:number, changed:number, files:number, bytes:number}>}
   */
  B.runNow = async function ({ ask = false } = {}) {
    if (!handle) handle = await U.idb.get('kv', HANDLE_KEY) || null;
    if (!handle) throw new Error('Choose a backup folder first.');
    if (running) return null;
    const p = await perm(handle, ask);
    if (p !== 'granted') {
      st.status = 'needsPermission'; changed();
      if (ask) throw new Error('The browser didn’t allow access to the backup folder. Click Allow and choose “Allow on every visit”.');
      return null;
    }
    const data = S.getRoot();
    // Never back up an empty or missing data folder: that's exactly when the existing backups matter.
    const ws = data && await readJSONIn(data, 'workspace.json');
    if (!ws || !ws.id) throw new Error('The data folder has no workspace in it, so there is nothing to back up. Your existing backups were left alone.');
    return withLock(async () => {
      running = true; st.status = 'running'; st.progress = ''; changed();
      try {
        const files = await scan(data);
        const day = await todaysFolder(ws.id);
        const prev = (day.mark && day.mark.manifest) || {};
        const fresh = !(await hasFile(day.dir, 'workspace.json'));
        const todo = [];
        const manifest = {};
        let bytes = 0;
        for (const [path, f] of files) {
          manifest[path] = [f.size, f.lastModified];
          bytes += f.size;
          const was = prev[path];
          if (fresh || !was || was[0] !== f.size || was[1] !== f.lastModified) todo.push(path);
        }
        const now = Date.now();
        st.lastCheck = now; U.ls.set('backup.lastCheck', now);
        if (!todo.length) { st.status = 'ok'; st.error = ''; return { name: day.name, ts: now, changed: 0, files: files.size, bytes }; }
        todo.sort((a, b) => (a === 'workspace.json') - (b === 'workspace.json')); // workspace.json last
        let n = 0;
        for (const path of todo) {
          const parts = path.split('/'); const name = parts.pop();
          const dst = await dirAt(day.dir, parts);
          try {
            try { await writeIn(dst, name, files.get(path)); } catch (e) {
              if (!e || e.name !== 'NotReadableError') throw e;
              const f = await files.get(path).handle.getFile(); // changed since the scan: copy the newer version
              await writeIn(dst, name, f);
              manifest[path] = [f.size, f.lastModified];
            }
          } catch (e) {
            if (e && e.name === 'NotFoundError') { delete manifest[path]; continue; } // source vanished meanwhile
            throw e;
          }
          if (++n % 25 === 0) { st.progress = `${n} of ${todo.length} files`; changed(); }
        }
        await writeIn(day.dir, MARK, JSON.stringify({
          app: 'Sankyo Chat', version: SC.VERSION, wsId: ws.id, wsName: ws.name,
          created: (day.mark && day.mark.created) || now, ts: now, count: files.size, bytes, manifest,
        }));
        st.last = { name: day.name, ts: now, changed: todo.length, files: files.size, bytes };
        U.ls.set('backup.last', st.last);
        st.status = 'ok'; st.error = '';
        try { await prune(); } catch (e) { console.warn('prune', e); }
        return st.last;
      } catch (e) {
        st.status = e && e.name === 'NotAllowedError' ? 'needsPermission' : 'error';
        st.error = (e && e.message) || String(e);
        throw e;
      } finally { running = false; st.progress = ''; changed(); }
    });
  };

  async function tick() {
    if (!handle || running) return;
    if (st.lastCheck && Date.now() - st.lastCheck < EVERY_MS) return;
    try { await B.runNow(); } catch (e) { console.warn('Backup failed', e); }
  }

  /** Start the hourly check (super admin only, while signed in). */
  B.start = async function () {
    if (started || !SC.account.isOwner()) return;
    started = true;
    handle = await U.idb.get('kv', HANDLE_KEY) || null;
    if (!handle) { st.status = 'off'; changed(); return; }
    st.status = (await perm(handle, false)) === 'granted' ? 'ok' : 'needsPermission';
    // a newer update in the folder counts too (the Windows task, or another PC)
    try {
      if (st.status === 'ok') {
        const newest = (await listBackups(handle))[0];
        if (newest && (!st.last || newest.ts > st.last.ts)) st.last = { name: newest.name, ts: newest.ts, files: newest.files, bytes: newest.bytes };
      }
    } catch (e) { console.warn(e); }
    changed();
    firstTimer = setTimeout(tick, 30000);
    timer = setInterval(tick, CHECK_MS);
  };
  B.stop = function () { clearInterval(timer); clearTimeout(firstTimer); started = false; };

  /** Pick (or change) the backup folder, then back up straight away. Must run inside a click. */
  B.choose = async function () {
    let hd;
    try { hd = await root.showDirectoryPicker({ id: 'sankyo-backup', mode: 'readwrite' }); } catch (e) {
      if (e.name === 'AbortError') return false;
      throw new Error('The folder window couldn’t open: ' + e.message);
    }
    const data = S.getRoot();
    if (data && (await data.isSameEntry(hd) || await data.resolve(hd))) throw new Error('That is the data folder (or inside it). Deleting the data folder would delete the backups too. Pick a separate folder.');
    if (await hasFile(hd, 'workspace.json')) throw new Error('That folder holds Sankyo Chat data or a single backup. Pick the folder that should contain the backups, e.g. SankyoChat-Backups.');
    if (await hasFile(hd, 'index.html') && await hasFile(hd, 'check.html')) throw new Error('That is the SankyoChat app folder. Pick a folder outside it, so deleting the app folder can’t delete the backups.');
    if (NAME_RE.test(hd.name)) throw new Error('That is one backup copy. Pick the folder that contains the backups.');
    if (await perm(hd, true) !== 'granted') throw new Error('The app needs permission to save files in that folder.');
    handle = hd;
    await U.idb.set('kv', HANDLE_KEY, hd);
    st.last = null; U.ls.del('backup.last');
    st.lastCheck = 0; U.ls.del('backup.lastCheck');
    st.status = 'ok'; st.error = ''; changed();
    if (!started) await B.start();
    await B.runNow({ ask: true });
    return true;
  };

  B.turnOff = async function () {
    B.stop();
    handle = null;
    await U.idb.del('kv', HANDLE_KEY);
    st.status = 'off'; st.error = ''; changed();
  };

  /* ================= restore (before sign-in) ================= */

  /** Is the connected data folder gone (deleted or moved after this browser remembered it)? */
  B.dataFolderGone = async function () {
    const r = S.getRoot();
    if (!r) return true;
    try { for await (const _ of r.keys()) break; return false; } catch (e) { return !!e && e.name === 'NotFoundError'; }
  };
  /** Did someone connect a backup copy as if it were the data folder? */
  B.isBackupCopy = async function () {
    const r = S.getRoot();
    return !!r && (NAME_RE.test(r.name) || await hasFile(r, MARK));
  };

  const fmtDay = ts => new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const fmtTime = ts => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  /**
   * Screen shown when the connected data folder is empty.
   * @param {{onRestored:Function, onNewWorkspace:Function, onBack:Function, knownWorkspace?:string}} o
   */
  B.screenEmpty = async function ({ onRestored, onNewWorkspace, onBack, knownWorkspace }) {
    const saved = await U.idb.get('kv', HANDLE_KEY) || null;
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const pick = async folder => {
      if (await perm(folder, true) !== 'granted') throw new Error('The app needs permission to open the backup folder.');
      const list = await listBackups(folder);
      if (!list.length) throw new Error(`No finished backups were found in “${folder.name}”. Pick the folder that contains the data-YYYY-MM-DD backups.`);
      chooseBackup(folder, list);
    };
    const fromSaved = saved ? h('button', { class: 'btn btn-primary btn-lg' }, UI.icon('refresh'), `Restore from “${saved.name}”`) : null;
    if (fromSaved) fromSaved.addEventListener('click', () => UI.busy(fromSaved, 'Looking for backups…', () => pick(saved), err));
    const browse = h('button', { class: 'btn' + (saved ? '' : ' btn-primary btn-lg') }, UI.icon('folder'), saved ? 'Choose another backup folder' : 'Restore from a backup');
    browse.addEventListener('click', () => UI.busy(browse, null, async () => {
      let hd;
      try { hd = await root.showDirectoryPicker({ id: 'sankyo-backup', mode: 'read' }); } catch (e) { if (e.name === 'AbortError') return; throw e; }
      await pick(hd);
    }, err));
    const fresh = h('button', { class: 'link-btn', type: 'button' }, 'Start a brand-new workspace instead');
    fresh.addEventListener('click', async () => {
      if (knownWorkspace && !(await UI.confirm({ title: 'Start a new workspace?', danger: true, ok: 'Start new workspace',
        text: `This PC was using the workspace “${knownWorkspace}”. A new workspace has none of its accounts or messages, and whoever creates it becomes the super admin. If “${knownWorkspace}” was deleted by accident, restore a backup instead.` }))) return;
      onNewWorkspace();
    });
    UI.mount(h('div', { class: 'screen-center' }, h('div', { class: 'card' },
      h('div', { class: 'brand' }, h('div', { class: 'brand-logo' }, UI.icon('message')),
        h('div', null, h('h1', null, 'Sankyo Chat'), h('p', null, 'Team chat over the office shared drive.'))),
      h('div', { class: 'note note-warn', style: { marginTop: 0 } }, UI.icon('alert'), h('div', null,
        h('b', null, knownWorkspace ? `The data for “${knownWorkspace}” is gone. ` : 'This data folder is empty. '),
        knownWorkspace ? 'The data folder was emptied or deleted. ' : 'If Sankyo Chat was already in use here, its data was deleted or moved. ',
        h('b', null, 'Super admin: '), 'restore a backup. It is copied into this data folder, the app keeps working on that copy, and the backup itself stays as it is. ',
        h('b', null, 'Everyone else: '), 'don’t start a new workspace. Tell the super admin and wait.')),
      err,
      h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap', marginTop: '16px' } }, fromSaved, browse),
      h('div', { class: 'card-foot' }, fresh, h('button', { class: 'link-btn', type: 'button', onclick: onBack }, 'Choose a different data folder')))));

    function chooseBackup(folder, list) {
      let sel = list[0].name;
      const box = h('div', { class: 'backup-list', role: 'radiogroup', 'aria-label': 'Backups' });
      const draw = () => UI.set(box, list.slice(0, 60).map((b, i) => h('button', {
        type: 'button', role: 'radio', class: 'backup-item', 'aria-checked': String(b.name === sel), onclick: () => { sel = b.name; draw(); },
      }, h('span', { class: 'team-radio' }),
      h('span', { class: 'backup-when' }, fmtDay(b.ts), i === 0 ? h('span', { class: 'pill' }, 'Newest') : null),
      h('span', { class: 'muted backup-meta' }, [b.ts ? 'as of ' + fmtTime(b.ts) : null, b.wsName, b.files != null ? b.files + ' files' : null, b.bytes != null ? B.formatSize(b.bytes) : null].filter(Boolean).join(' · ')))));
      draw();
      const e2 = h('div', { class: 'form-error hidden', role: 'alert' });
      const go = h('button', { class: 'btn btn-primary' }, 'Copy this backup into the data folder');
      const m = UI.modal({ title: 'Choose a backup', cls: 'wide',
        body: [h('p', { class: 'muted', style: { fontSize: '14px' } }, `Backups in “${folder.name}”, one per day, each as it was at its last update. The newest has the most messages. Anything sent after it is not in it, and people sign in with the password they had at that time.`), e2, box],
        foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), go] });
      go.addEventListener('click', () => UI.busy(go, 'Copying…', async () => {
        const b = list.find(x => x.name === sel);
        const data = S.getRoot();
        // a half-finished earlier attempt may have left files, but never a workspace.json (it is copied last)
        if (await hasFile(data, 'workspace.json')) throw new Error('The data folder isn’t empty any more (someone may have started a workspace in it). Nothing was copied.');
        const stats = await copyTree(b.dir, data, { onFile: s => { UI.set(go, h('span', { class: 'spinner', style: { width: '16px', height: '16px', borderWidth: '2px' } }), `Copying… ${s.files} files`); } });
        if (!(await hasFile(data, 'workspace.json'))) throw new Error('The copy didn’t finish. Try again, or pick another backup.');
        m.close();
        UI.toast(`Restored ${stats.files} files from the backup of ${fmtDay(b.ts)}, ${fmtTime(b.ts)}`, 'ok');
        await onRestored();
      }, e2));
    }
  };

  SC.backup = B;
})(window);
