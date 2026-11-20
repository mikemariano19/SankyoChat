/* Sankyo Chat — start-up and routing between screens. */
(function (root) {
  'use strict';
  const SC = root.SC;
  const U = SC.util, S = SC.store, A = SC.account, Y = SC.sync, UI = SC.ui, Chat = SC.chat;
  /** @namespace SC.app */
  const App = {};

  SC.APP_FILES = ['index.html', 'check.html', 'css/app.css', 'js/version.js', 'js/util.js', 'js/store.js', 'js/crypto.js',
    'js/account.js', 'js/sync.js', 'js/notify.js', 'js/board.js', 'js/emoji.js', 'js/ui.js', 'js/board-ui.js', 'js/backup.js', 'js/roles-ui.js', 'js/chat.js', 'js/app.js', 'js/check.js'];

  const dataPath = () => U.dataPathFromLocation(location.href);
  const connectedLabel = () => {
    const h = S.getRoot();
    const p = dataPath();
    return h && h.name === 'data' && p ? p : (h ? h.name : '');
  };

  /* ================= theme ================= */
  App.theme = () => U.ls.get('theme', 'system');
  App.setTheme = function (t) {
    U.ls.set('theme', t);
    applyTheme();
  };
  function applyTheme() {
    const t = App.theme();
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }

  /* ================= notifications & sound ================= */
  App.notificationState = () => ('Notification' in root ? Notification.permission : 'denied');
  App.requestNotifications = async function () {
    if (!('Notification' in root)) return UI.toast('This browser can’t show desktop notifications.', 'error');
    try {
      const p = await Notification.requestPermission();
      UI.toast(p === 'granted' ? 'Desktop notifications are on' : 'Notifications were not allowed. You can still see unread counts and hear the sound.', p === 'granted' ? 'ok' : '');
    } catch { UI.toast('Notifications aren’t available here.', 'error'); }
  };
  App.soundOn = () => U.ls.get('sound', true);
  App.setSound = v => U.ls.set('sound', !!v);
  let audioCtx = null;
  function chime() {
    if (!App.soundOn()) return;
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return; // browsers block audio before a click
    try {
      audioCtx = audioCtx || new (root.AudioContext || root.webkitAudioContext)();
      const t = audioCtx.currentTime;
      [[880, 0], [1320, 0.12]].forEach(([f, d]) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + d);
        g.gain.exponentialRampToValueAtTime(0.18, t + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.35);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t + d); o.stop(t + d + 0.4);
      });
    } catch { /* no audio */ }
  }
  let lastChime = 0;
  App.notify = function ({ title, body, tag, onClick }) {
    if (SC.notify && SC.notify.isQuiet()) return; // Do Not Disturb
    if (Date.now() - lastChime > 1500) { chime(); lastChime = Date.now(); }
    if (App.notificationState() !== 'granted') return;
    try {
      const n = new Notification(title, { body, tag, renotify: true, silent: true, icon: 'assets/icon.svg' });
      n.onclick = () => { root.focus(); if (onClick) onClick(); n.close(); };
    } catch { /* ignore */ }
  };

  /* ================= idle, auto-lock, visibility ================= */
  let lastInput = Date.now();
  let idleTimer = 0;
  const bump = () => { lastInput = Date.now(); if (Y.idle) { Y.idle = false; Y.heartbeat(); } };
  ['mousemove', 'keydown', 'mousedown', 'wheel', 'touchstart'].forEach(ev => document.addEventListener(ev, bump, { passive: true, capture: true }));
  function watchIdle() {
    clearInterval(idleTimer);
    idleTimer = setInterval(() => {
      if (!A.me) return;
      const idleMs = Date.now() - lastInput;
      const wasIdle = Y.idle;
      Y.idle = idleMs > 10 * 60000;
      if (Y.idle !== wasIdle) Y.heartbeat();
      const lockMin = A.autoLockMinutes();
      if (!A.keepSignedIn() && lockMin > 0 && idleMs > lockMin * 60000) App.lock('Locked after ' + lockMin + ' minutes without activity.');
    }, 15000);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') Y.hiddenSince = Date.now();
    else {
      const wasPaused = Y.hiddenSince && Date.now() - Y.hiddenSince > 5 * 60000;
      Y.hiddenSince = 0;
      if (A.me && Chat.mounted()) { Y.pokeNow(); if (wasPaused) Y.heartbeat(); Chat.maybeMarkRead(); }
    }
  });
  root.addEventListener('focus', () => { if (A.me && Chat.mounted()) Chat.maybeMarkRead(); });
  root.addEventListener('pagehide', () => { if (A.me && Chat.mounted()) Y.heartbeat('offline'); });

  /* ================= version check ================= */
  let versionTimer = 0;
  function watchVersion() {
    clearInterval(versionTimer);
    versionTimer = setInterval(() => {
      const s = document.createElement('script');
      s.src = 'js/version.js?t=' + Date.now();
      s.onload = s.onerror = () => {
        s.remove();
        if (SC.LATEST_VERSION && SC.LATEST_VERSION !== SC.VERSION && Chat.mounted()) Chat.showBanner('update', true);
      };
      document.head.appendChild(s);
    }, 5 * 60000);
  }

  /** SHA-256 fingerprint of the app files in a picked SankyoChat folder. */
  App.fingerprint = async function (dir) {
    const lines = [];
    const missing = [];
    for (const p of SC.APP_FILES) {
      try {
        let hnd = dir;
        const parts = p.split('/');
        const name = parts.pop();
        for (const d of parts) hnd = await hnd.getDirectoryHandle(d);
        const f = await (await hnd.getFileHandle(name)).getFile();
        lines.push(p + ' ' + await SC.crypto.sha256Hex(await f.arrayBuffer()));
      } catch { missing.push(p); lines.push(p + ' missing'); }
    }
    const hash = await SC.crypto.sha256Hex(U.utf8(lines.join('\n')));
    return { hash, pretty: hash.match(/.{4}/g).slice(0, 8).join(' '), count: SC.APP_FILES.length - missing.length, missing };
  };

  /* ================= keyboard ================= */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (UI.closeTop()) e.preventDefault(); return; }
    if (!A.me || !Chat.mounted()) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); UI.closeAll(); Chat.quickSwitcher(); }
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); UI.closeAll(); Chat.search(); }
  });

  /* ================= routing ================= */

  function supported() {
    if (!root.isSecureContext) return 'This page isn’t allowed to use secure features here. Open it from the desktop shortcut.';
    if (typeof root.showDirectoryPicker !== 'function') return 'This browser can’t open folders on the shared drive. Use Microsoft Edge or Google Chrome, version 110 or newer.';
    if (!root.crypto || !root.crypto.subtle) return 'This browser doesn’t have the built-in encryption the app needs.';
    if (typeof indexedDB === 'undefined') return 'This browser is blocking local storage (IndexedDB), which the app needs to remember the folder.';
    return '';
  }

  App.boot = async function () {
    applyTheme();
    const why = supported();
    if (why) return UI.screenUnsupported(why);
    UI.screenLoading('Starting Sankyo Chat…');
    const h = await S.loadHandle();
    if (!h) return showConnect();
    S.setRoot(h);
    const perm = await S.queryPermission(h);
    if (perm === 'granted') return afterConnect();
    UI.screenReconnect({
      name: h.name,
      onReconnect: async () => {
        const p = await S.requestPermission(h);
        if (p !== 'granted') throw new Error('Access wasn’t allowed. Click Reconnect and choose “Allow on every visit”.');
        await afterConnect();
      },
      onChoose: () => showConnect(),
    });
  };

  function showConnect(error) {
    UI.screenConnect({
      path: dataPath(), error,
      onConnect: async () => {
        let h;
        try { h = await root.showDirectoryPicker({ id: 'sankyo-data', mode: 'readwrite' }); } catch (e) {
          if (e.name === 'AbortError') return;
          throw new Error('The folder window couldn’t open: ' + e.message);
        }
        if (await S.queryPermission(h) !== 'granted' && await S.requestPermission(h) !== 'granted') {
          throw new Error('The app needs permission to view and edit files in that folder.');
        }
        S.setRoot(h);
        await S.saveHandle(h);
        await afterConnect();
      },
    });
  }

  async function afterConnect() {
    UI.screenLoading('Opening the workspace…');
    let r;
    try { r = await A.loadWorkspace(); } catch (e) {
      console.warn(e);
      return showConnect('The shared folder couldn’t be read (' + (e.message || e.name) + '). Check you’re connected to the office network, then try again.');
    }
    if (r.status === 'missing') {
      if (await SC.backup.dataFolderGone()) {
        await S.forgetHandle();
        return showConnect('The data folder was deleted or moved. In the folder window, go to the SankyoChat folder, make a new empty folder named “data” (New folder button), open it and click Select folder. You can then restore it from a backup.');
      }
      // empty, or the workspace file is gone but other data folders are left (e.g. a half-finished restore)
      const leftovers = (await S.list('', 'directory')).some(n => ['users', 'channels', 'admin'].includes(n));
      if (await A.folderIsEmpty() || leftovers) return showEmptyData();
      return showConnect(`“${S.getRoot().name}” isn’t the Sankyo Chat data folder. Pick the “data” folder inside the SankyoChat folder.`);
    }
    if (await SC.backup.isBackupCopy()) {
      await S.forgetHandle();
      return showConnect(`“${S.getRoot().name}” is a backup copy, not the data folder. Connect the real “data” folder. If it’s empty or was deleted, the app offers to copy a backup into it, so the backup itself is never used directly.`);
    }
    if (r.status === 'different') {
      return UI.screenProblem({
        title: 'This is a different workspace',
        text: r.raw
          ? `This browser was set up for another Sankyo Chat workspace. The folder you picked contains “${r.raw.name}”. Only continue if you meant to switch.`
          : 'The workspace file in this folder doesn’t have a valid admin signature, so it can’t be trusted.',
        actions: [h2btn('Choose a different folder', () => showConnect()), r.raw ? h2btn('Switch to this workspace', () => { A.trustWorkspace(r.raw); afterConnect(); }, true) : null],
      });
    }
    if (r.status === 'invalid') {
      return UI.screenProblem({ title: 'The workspace file can’t be trusted',
        text: 'workspace.json in this folder failed its signature check. Ask your admin to restore it from a backup.',
        actions: [h2btn('Choose a different folder', () => showConnect())] });
    }
    if (r.status === 'tampered') console.warn('workspace.json changed without a valid admin signature; using the last trusted copy');
    try { await A.refreshUsers(); await A.refreshAdminLog(); } catch (e) { console.warn(e); }
    if (await A.restoreSession()) return enterChat();
    showSignIn();
  }
  /** The data folder is empty: offer the super admin a restore before anyone can start a new workspace over it. */
  function showEmptyData() {
    const pin = U.ls.get('wsPin');
    const known = pin && U.ls.get('ws.' + pin.id);
    return SC.backup.screenEmpty({
      knownWorkspace: known && known.name,
      onRestored: () => afterConnect(),
      onBack: async () => { await S.forgetHandle(); showConnect(); },
      onNewWorkspace: () => UI.screenCreateWorkspace({ connected: connectedLabel(), onBack: () => showEmptyData(),
        onSubmit: async vals => { await A.createWorkspace(vals); await enterChat(); } }),
    });
  }
  const h2btn = (label, fn, primary) => UI.h('button', { class: 'btn' + (primary ? ' btn-primary' : ''), onclick: fn }, label);

  /** People who can still sign in: not removed, and their key file is still on the share
   *  (removing someone deletes it, even if this PC hasn't picked up the removal itself yet). */
  async function signInUsers() {
    let withKeys = null;
    try { withKeys = new Set((await S.list('users', 'file')).filter(n => /^[a-z0-9]{4}\.keys\.json$/.test(n)).map(n => n.slice(0, 4))); } catch (e) { console.warn(e); }
    return A.activeUsers().filter(u => !withKeys || withKeys.has(u.id));
  }
  async function refreshForSignIn() {
    for (const step of [A.refreshWorkspace, A.refreshUsers, A.refreshAdminLog]) { try { await step(); } catch (e) { console.warn(e); } }
    return signInUsers();
  }
  let signInTimer = 0;

  async function showSignIn(preselect, notice) {
    clearInterval(signInTimer);
    UI.screenLoading('Loading…');
    const users = await refreshForSignIn();
    if (!users.length) return showCreateProfile();
    const screen = UI.screenSignIn({
      wsName: A.ws.name, users, preselect: preselect || U.ls.get('lastUser'),
      onSubmit: async ({ userId, password, keep }) => { await A.signIn(userId, password, keep); await enterChat(); },
      onCreate: () => showCreateProfile(),
      onChangeFolder: async () => { await S.forgetHandle(); showConnect(); },
      onRecover: async userId => {
        const question = await A.recoveryQuestion(userId);
        if (!question) throw new Error('This account has no security question, so the password can’t be recovered here. Ask an admin to reset it (direct messages from before the reset can’t be opened afterwards).');
        const u = A.users.get(userId);
        UI.screenRecover({
          name: u ? u.name : '', question,
          onSubmit: async ({ answer, pw, pw2 }) => { await A.recoverAccount(userId, answer, pw, pw2); UI.toast('Password changed', 'ok'); await enterChat(); },
          onCancel: () => showSignIn(userId),
        });
      },
    });
    if (notice) UI.toast(notice);
    // keep the list current while the screen is open (people removed or added on other PCs)
    signInTimer = setInterval(async () => {
      if (!screen.alive() || A.me) { clearInterval(signInTimer); return; }
      const next = await refreshForSignIn();
      if (screen.alive()) screen.setUsers(next);
    }, 20000);
  }

  function showCreateProfile() {
    UI.screenCreateProfile({
      connected: connectedLabel(),
      onSubmit: async vals => { await A.createProfile(vals); await enterChat(); },
      onHaveProfile: A.activeUsers().length ? () => showSignIn() : null,
    });
  }

  async function enterChat() {
    if (A.me.mustChange) {
      return UI.screenForceChange({
        onSubmit: async ({ old, pw, pw2 }) => {
          try { await A.changePassword(old, pw, pw2); } catch (e) { if (e.code === 'BAD_PASSWORD') throw new Error('The temporary password isn’t right.'); throw e; }
          await enterChat();
        },
        onCancel: () => App.lock(),
      });
    }
    if (A.maintenance() && !A.isOwner()) return showMaintenance();
    UI.screenLoading('Loading your messages…');
    SC.notify.start(); SC.board.start();
    try { await Y.start(); } catch (e) {
      console.warn(e);
      SC.notify.stop(); SC.board.stop();
      await Y.stop();
      return showConnect('Couldn’t load messages from the shared folder (' + (e.message || e.name) + ').');
    }
    Chat.mount();
    SC.backup.start().catch(e => console.warn('backup', e));
    resealSoon();
    lastInput = Date.now();
    watchIdle();
    watchVersion();
    if (App.notificationState() === 'default' && !U.ls.get('askedNotify')) {
      U.ls.set('askedNotify', true);
      setTimeout(() => UI.toast('Tip: turn on desktop notifications from the ⚙ menu at the bottom left.'), 2500);
    }
  }

  /** Sign out of this browser and go back to the sign-in screen. */
  App.lock = async function (notice) {
    clearInterval(idleTimer);
    clearInterval(versionTimer);
    const id = A.me && A.me.id;
    if (Chat.mounted()) Chat.unmount();
    SC.notify.stop(); SC.board.stop(); SC.backup.stop();
    await Y.stop(true);
    await A.lock();
    showSignIn(id, notice);
  };

  /* ================= update mode =================
   * The super admin turned on update mode (Admin settings → Settings → Update the app): stop syncing so nothing
   * writes to the share while files are copied, and reload by itself once it's turned off. */
  let maintTimer = 0;
  async function showMaintenance() {
    clearInterval(maintTimer);
    clearInterval(idleTimer);
    if (Chat.mounted()) Chat.unmount();
    SC.notify.stop(); SC.board.stop();
    try { await Y.stop(true); } catch { /* already stopped */ }
    const m = A.maintenance() || {};
    const check = async () => {
      try { await A.refreshWorkspace(); } catch { /* the share may be busy while files are copied */ }
      if (!A.maintenance()) { clearInterval(maintTimer); location.reload(); }
    };
    UI.screenProblem({
      title: 'Sankyo Chat is being updated',
      text: (m.message ? m.message + ' ' : '') + 'The super admin is installing a new version. This page reloads by itself when the update is done, usually within a few minutes. You don’t need to do anything.',
      actions: [h2btn('Check again', check, true)],
    });
    maintTimer = setInterval(check, 10000);
  }
  const resealSoon = U.debounce(() => { if (A.me && Chat.mounted()) A.refreshRealNameSeals().catch(e => console.warn('real name', e)); }, 2000);
  A.events.on('workspace', () => {
    if (A.me && Chat.mounted() && A.maintenance() && !A.isOwner()) return showMaintenance();
    resealSoon(); // the admin list may have changed: share my real name with the current admins only
  });

  SC.app = App;
  root.addEventListener('error', e => console.error('Unhandled error', e.error || e.message));
  root.addEventListener('unhandledrejection', e => console.error('Unhandled rejection', e.reason));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', App.boot); else App.boot();
})(window);
