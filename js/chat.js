/* Sankyo Chat — main chat view: sidebar, conversation, composer and in-chat dialogs. */
(function (root) {
  'use strict';
  const SC = root.SC;
  const U = SC.util, A = SC.account, Y = SC.sync, UI = SC.ui, C = SC.crypto, S = SC.store;
  const h = UI.h, icon = UI.icon;
  /** @namespace SC.chat */
  const Chat = {};

  /** @type {Object<string, HTMLElement>} */
  let el = {};
  const st = {
    openId: null, drafts: {}, replies: {}, files: {}, editingId: null, editDraft: '',
    revealed: new Set(), dividerTs: 0, scrollTo: null, firstRender: false, prepending: false, stick: false,
    loadingOlder: false, banners: { update: false, wsTampered: false },
  };
  let unsub = [];
  const dirty = new Set();
  let raf = 0;
  const blobUrls = new Map();
  const thumbLoading = new Set();
  /** close() of each open image/PDF viewer, so signing out or auto-lock never leaves one on screen */
  const viewers = new Set();

  /** The Announcements channel isn't a real conversation; it has this reserved id. */
  const ANN = '@announcements';
  const isAnn = () => st.openId === ANN;
  const cur = () => Y.chans.get(st.openId);
  const meId = () => A.me.id;
  /** Batch renders. Animation frames pause in background tabs, so fall back to a timer there
   *  (the tab title's unread count must keep updating while the window is hidden). */
  function schedule(...parts) {
    parts.forEach(p => dirty.add(p));
    if (raf) return;
    raf = document.visibilityState === 'hidden' ? setTimeout(flush, 100) : requestAnimationFrame(flush);
  }
  function flush() {
    raf = 0;
    const d = new Set(dirty); dirty.clear();
    if (!el.root || !document.contains(el.root)) return;
    if (d.has('side')) renderSidebar();
    if (d.has('head')) { renderHeader(); renderKeyNotice(); }
    if (d.has('banners')) renderBanners();
    if (d.has('composer')) buildComposer();
    if (d.has('msgs')) { renderMessages(); renderPins(); }
  }
  const chName = ch => (ch.kind === 'public' || Y.isPrivateChannel(ch) ? '#' : '') + Y.info(ch).name;

  /* ================= mount ================= */

  Chat.mount = function () {
    el = {};
    el.side = h('aside', { class: 'sidebar', 'aria-label': 'Channels and direct messages' });
    el.banners = h('div', { class: 'banners' });
    el.head = h('header', { class: 'conv-head' });
    el.keyNotice = h('div');
    el.pins = h('div');
    el.msgs = h('div', { class: 'msgs', role: 'region', 'aria-label': 'Messages', tabindex: '-1' });
    el.composerWrap = h('div', { class: 'composer-wrap' });
    el.conv = h('main', { class: 'conv' }, el.banners, el.head, el.keyNotice, el.pins, el.msgs, el.composerWrap);
    el.root = h('div', { class: 'chat' }, el.side, el.conv);
    UI.mount(el.root);

    el.msgs.addEventListener('click', onMsgClick);
    el.msgs.addEventListener('mouseover', placeTools);
    el.msgs.addEventListener('focusin', placeTools);
    el.msgs.addEventListener('scroll', onScroll, { passive: true });
    el.side.addEventListener('click', onSideClick);
    setupDrop();

    unsub = [
      Y.events.on('messages', ch => { if (ch.id === st.openId) schedule('msgs'); schedule('side'); }),
      Y.events.on('channels', () => schedule('side')),
      Y.events.on('group', ch => { if (ch.id === st.openId) schedule('head', 'composer'); }),
      Y.events.on('groupGone', ch => {
        UI.toast(`You were removed from ${Y.info(ch).name}.`);
        if (ch.id === st.openId) { UI.closeAll(); Chat.open(Y.chans.has('general') ? 'general' : Array.from(Y.chans.keys())[0]); }
      }),
      Y.events.on('presence', changed => { schedule('side', 'head'); if (seenSig(cur()) !== st.seenSig || (isAnn() && changed && A.isAdmin())) schedule('msgs'); }),
      Y.events.on('connection', () => schedule('side', 'banners')),
      Y.events.on('incoming', onIncoming),
      Y.events.on('inbox', () => schedule('side')),
      Y.events.on('announcements', () => { schedule('side'); if (isAnn()) schedule('msgs'); showPendingAnnouncement(); }),
      A.events.on('workspace', () => { schedule('side', 'head', 'composer', 'msgs', 'banners'); if (A.isRemoved(meId())) SC.app.lock('Your account was removed by the admin.'); }),
      A.events.on('users', () => schedule('side', 'head', 'msgs', 'banners')),
      A.events.on('wsTampered', () => { st.banners.wsTampered = true; schedule('banners'); }),
    ];
    const last = U.ls.get('lastOpen.' + A.ws.id);
    Chat.open(Y.chans.has(last) || last === ANN ? last : (Y.chans.has('general') ? 'general' : Array.from(Y.chans.keys())[0]));
    if (A.isOwner()) A.loadInbox().then(ch => { if (ch) schedule('side'); }).catch(() => {});
    showPendingAnnouncement();
    renderBanners();
    if (A.needsTeam()) chooseTeamDialog({ mandatory: true });
    if (A.isAdmin() && !U.ls.get(`adminGuideSeen.${A.ws.id}.${meId()}`)) {
      setTimeout(() => { if (el.root) UI.toast('You’re an admin. See what you can do: ⚙ (bottom left) → Admin guide.'); }, 3000);
    }
  };

  Chat.unmount = function () {
    unsub.forEach(f => f());
    unsub = [];
    blobUrls.forEach(u => URL.revokeObjectURL(u));
    blobUrls.clear();
    localUrls.forEach(u => URL.revokeObjectURL(u));
    localUrls.clear();
    thumbLoading.clear();
    Array.from(viewers).forEach(close => close());
    st.unmounting = true; // closing an announcement pop-up here (sign-out) shouldn't count as reading it
    try { UI.closeAll(); } finally { st.unmounting = false; }
    el = {};
    st.openId = null;
    st.annFresh = null;
  };
  Chat.mounted = () => !!el.root;
  Chat.showBanner = function (name, on) { st.banners[name] = on; schedule('banners'); };

  /** Open a channel or conversation. */
  Chat.open = async function (id, opts = {}) {
    if (id === ANN) return openAnnouncements();
    const ch = Y.chans.get(id);
    if (!ch) return;
    if (el.ta && st.openId) st.drafts[st.openId] = el.ta.value;
    st.openId = id;
    Y.openId = id;
    U.ls.set('lastOpen.' + A.ws.id, id);
    st.dividerTs = Y.lastRead(id);
    st.editingId = null;
    st.firstRender = true;
    st.revealed = new Set();
    el.root.classList.remove('side-open');
    UI.closePopover();
    renderSidebar(); renderHeader(); renderKeyNotice(); buildComposer(); renderMessages(); renderPins();
    if (!opts.noFocus && el.ta) el.ta.focus();
    try {
      await Y.ensureLoaded(ch, 50);
      if (opts.scrollTo) {
        await Y.loadUntil(ch, opts.ts || 0);
        st.scrollTo = opts.scrollTo;
        schedule('msgs');
      }
    } catch (e) { console.warn(e); }
  };
  Chat.openUser = async function (userId) {
    if (userId === meId()) return;
    try { const ch = await Y.openConversation([userId]); Chat.open(ch.id); } catch (e) { UI.toast(e.message, 'error'); }
  };

  /* ================= sidebar ================= */

  function renderSidebar() {
    const focusKey = document.activeElement && el.side.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    const all = Array.from(Y.chans.values());
    // channels: public ones plus the private channels I've been invited to
    const pub = all.filter(c => (c.kind === 'public' && !Y.info(c).archived) || (Y.isPrivateChannel(c) && c.groupName)).sort((a, b) => Y.info(a).name.localeCompare(Y.info(b).name));
    const groups = all.filter(c => c.kind === 'group' && c.groupName && !Y.isPrivateChannel(c)).sort((a, b) => Y.info(a).name.localeCompare(Y.info(b).name));
    const dms = all.filter(c => c.kind === 'dm' || (c.kind === 'group' && !c.groupName && !Y.isPrivateChannel(c))).sort((a, b) => Y.info(a).name.localeCompare(Y.info(b).name));
    const me = A.users.get(meId());
    const myP = Y.presenceOf(meId());

    const item = ch => {
      const info = Y.info(ch);
      const active = ch.id === st.openId;
      const muted = Y.isMuted(ch.id);
      let lead;
      if (ch.kind === 'public') lead = h('span', { class: 'hash', 'aria-hidden': 'true' }, '#');
      else if (ch.kind === 'dm') lead = UI.dot(Y.presenceOf(Y.dmOther(ch)).state);
      else if (Y.isPrivateChannel(ch)) lead = icon('lock', 'side-lock');
      else lead = icon('users');
      const badge = ch.unread && !active
        ? h('span', { class: 'badge' + (ch.mentions ? ' red' : '') }, String(ch.mentions || ch.unread))
        : null;
      const label = (ch.kind === 'public' ? 'Channel ' : Y.isPrivateChannel(ch) ? 'Private channel ' : ch.groupName ? 'Group chat ' : 'Conversation with ') + info.name + (ch.unread ? `, ${ch.unread} unread` : '');
      return h('button', {
        class: 'side-item' + (active ? ' active' : '') + (ch.unread && !active ? ' unread' : '') + (muted ? ' muted-ch' : ''),
        'data-open': ch.id, 'data-key': 'ch:' + ch.id, 'aria-current': active ? 'page' : null, 'aria-label': label,
      }, lead, h('span', { class: 'lbl' }, info.name), muted ? icon('bellOff') : null, badge);
    };
    const inboxCount = A.isOwner() ? A.inboxUnread() : 0;
    UI.set(el.side, 
      h('div', { class: 'side-head' },
        h('h1', null, A.ws.name),
        h('div', { class: 'conn' }, UI.dot(Y.connected ? 'online' : 'offline'), Y.connected ? 'Shared drive connected' : 'Not connected to the shared drive')),
      h('button', { class: 'jump', 'data-act': 'jump', 'data-key': 'jump' }, icon('search'), 'Search or jump to…', h('kbd', null, 'Ctrl K')),
      h('nav', { class: 'side-scroll' },
        (() => {
          const n = Y.pendingAnnouncements().length;
          const active = isAnn();
          return h('button', { class: 'side-item ann-side' + (active ? ' active' : '') + (n && !active ? ' unread' : ''), 'data-open': ANN, 'data-key': 'ch:' + ANN,
            'aria-current': active ? 'page' : null, 'aria-label': 'Announcements' + (n ? `, ${n} new` : '') },
          icon('megaphone'), h('span', { class: 'lbl' }, 'Announcements'), n && !active ? h('span', { class: 'badge red' }, String(n)) : null);
        })(),
        h('div', { class: 'side-sec' }, h('span', null, 'Channels'), A.isAdmin() ? h('button', { class: 'icon-btn', 'data-act': 'new-channel', 'data-key': 'newch', 'aria-label': 'Create a channel', title: 'Create a channel' }, icon('plus')) : null),
        pub.map(item),
        h('div', { class: 'side-sec' }, h('span', null, 'Group chats'), h('button', { class: 'icon-btn', 'data-act': 'new-group', 'data-key': 'newgrp', 'aria-label': 'Create a group chat', title: 'Create a group chat' }, icon('plus'))),
        groups.length ? groups.map(item) : h('div', { class: 'side-empty' }, 'No group chats yet'),
        h('div', { class: 'side-sec' }, h('span', null, 'Direct messages'), h('button', { class: 'icon-btn', 'data-act': 'new-dm', 'data-key': 'newdm', 'aria-label': 'New direct message', title: 'New direct message' }, icon('plus'))),
        dms.length ? dms.map(item) : h('div', { class: 'side-empty' }, 'No conversations yet')),
      h('div', { class: 'side-tools' },
        A.isOwner() ? null : h('button', { class: 'side-item', 'data-act': 'feedback', 'data-key': 'fb' }, icon('megaphone'), h('span', { class: 'lbl' }, 'Send feedback')),
        A.isOwner() ? h('button', { class: 'side-item' + (inboxCount ? ' unread' : ''), 'data-act': 'inbox', 'data-key': 'inbox' }, icon('inbox'), h('span', { class: 'lbl' }, 'Feedback inbox'), inboxCount ? h('span', { class: 'badge red' }, String(inboxCount)) : null) : null),
      h('div', { class: 'side-me' },
        UI.avatar(me, 34),
        h('div', { class: 'who' }, h('div', { class: 'nm' }, me ? me.name : ''),
          h('div', { class: 'st' }, UI.dot(myP.state), myP.statusText || UI.stateLabel(myP.state))),
        h('button', { class: 'icon-btn', 'data-act': 'me-menu', 'data-key': 'me', 'aria-label': 'Profile and settings', title: 'Profile and settings' }, icon('settings'))));
    if (focusKey) { const f = el.side.querySelector(`[data-key="${CSS.escape(focusKey)}"]`); if (f) f.focus(); }
    const n = Y.totalUnread();
    document.title = (n ? `(${n}) ` : '') + A.ws.name;
  }

  function onSideClick(e) {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.open) return Chat.open(t.dataset.open);
    switch (t.dataset.act) {
      case 'jump': return quickSwitcher();
      case 'new-channel': return A.isAdmin() ? newChannelDialog() : null;
      case 'new-dm': return newMessageDialog();
      case 'new-group': return newGroupDialog();
      case 'feedback': return feedbackDialog();
      case 'inbox': return A.isOwner() ? inboxDialog() : null;
      case 'me-menu': return profileMenu(t);
    }
  }

  /* ================= header & banners ================= */

  function renderHeader() {
    const menuBtn = h('button', { class: 'icon-btn menu-toggle', 'aria-label': 'Show sidebar', onclick: () => el.root.classList.toggle('side-open') }, icon('menu'));
    if (isAnn()) {
      UI.set(el.head, menuBtn, h('span', { class: 'avatar ann-avatar', style: { width: '34px', height: '34px' } }, icon('megaphone')),
        h('div', { class: 'two' }, h('div', { class: 'title' }, h('span', { class: 'nm' }, 'Announcements')),
          h('div', { class: 'sub' }, 'From the admins · to everyone, or privately to chosen people')));
      return;
    }
    const ch = cur();
    if (!ch) { UI.set(el.head); return; }
    const info = Y.info(ch);
    const searchBtn = h('button', { class: 'icon-btn', 'aria-label': 'Search messages', title: 'Search', onclick: () => searchDialog(ch.id) }, icon('search'));
    const infoBtn = h('button', { class: 'icon-btn', 'aria-label': 'Details', title: 'Details', onclick: () => channelInfoDialog(ch) }, icon('info'));
    if (ch.kind === 'public') {
      const count = Y.members(ch).length;
      UI.set(el.head, menuBtn,
        h('div', { class: 'title' }, h('span', { class: 'hash', 'aria-hidden': 'true' }, '#'), h('span', { class: 'nm' }, info.name),
          info.archived ? h('span', { class: 'pill grey' }, 'Archived') : null, Y.isMuted(ch.id) ? icon('bellOff') : null),
        info.description ? h('div', { class: 'topic', title: info.description }, info.description) : null,
        h('div', { class: 'tools' },
          h('button', { class: 'members-btn', 'aria-label': `${count} members`, title: 'Members', onclick: () => membersDialog(ch) }, icon('users'), String(count)),
          searchBtn, infoBtn));
      return;
    }
    if (Y.isPrivateChannel(ch)) {
      const count = Y.members(ch).length;
      UI.set(el.head, menuBtn,
        h('div', { class: 'title' }, icon('lock', 'title-lock'), h('span', { class: 'nm' }, info.name), Y.isMuted(ch.id) ? icon('bellOff') : null),
        info.description ? h('div', { class: 'topic', title: info.description }, info.description) : null,
        h('div', { class: 'tools' },
          h('span', { class: 'e2e', title: 'Only the people invited can read it' }, icon('lock'), 'Private · encrypted'),
          h('button', { class: 'members-btn', 'aria-label': `${count} members`, title: 'Members', onclick: () => channelInfoDialog(ch) }, icon('users'), String(count)),
          searchBtn, infoBtn));
      return;
    }
    const badges = [h('span', { class: 'e2e', title: 'Only the people in this conversation can read it' }, icon('lock'), 'End-to-end encrypted'),
      h('span', { class: 'retention' }, 'Messages delete after 7 days')];
    if (ch.kind === 'dm') {
      const other = A.users.get(Y.dmOther(ch));
      const p = Y.presenceOf(Y.dmOther(ch));
      UI.set(el.head, menuBtn, UI.avatar(other, 34),
        h('div', { class: 'two' }, h('div', { class: 'title' }, h('span', { class: 'nm' }, info.name)),
          h('div', { class: 'sub' }, UI.dot(p.state), UI.stateLabel(p.state) + (p.statusText ? ' · ' + p.statusText : ''))),
        h('div', { class: 'tools' }, badges, searchBtn, infoBtn));
    } else {
      UI.set(el.head, menuBtn, h('span', { class: 'avatar', style: { width: '34px', height: '34px', background: 'var(--surface-2)', color: 'var(--muted)' } }, icon('users')),
        h('div', { class: 'two' }, h('div', { class: 'title' }, h('span', { class: 'nm' }, info.name)),
          h('div', { class: 'sub' }, `${Y.members(ch).length} people`)),
        h('div', { class: 'tools' }, badges, searchBtn, infoBtn));
    }
  }

  function renderKeyNotice() {
    const ch = cur();
    if (!ch || ch.kind === 'public') { UI.set(el.keyNotice); return; }
    const changed = Y.members(ch).filter(id => id !== meId() && A.keyChanges.has(id));
    UI.set(el.keyNotice, ...changed.map(id => {
      const kc = A.keyChanges.get(id);
      return h('div', { class: 'key-notice' + (kc.byAdmin ? ' ok' : ''), role: 'status' }, icon(kc.byAdmin ? 'key' : 'alert'),
        h('span', null, kc.byAdmin
          ? `${A.name(id)}’s security key changed because the admin reset their password. Older messages may not open for them.`
          : `${A.name(id)}’s security key changed. If you didn’t expect this, check with them in person before sharing anything sensitive.`),
        h('button', { class: 'btn btn-sm', onclick: () => { A.ackKeyChange(id); renderKeyNotice(); } }, 'OK'));
    }));
  }

  /* ---- pinned messages bar (under the header) ---- */
  const snippetOf = m => (m.poll ? '📊 ' : '') + (m.text || (m.attachments && m.attachments[0] ? '📎 ' + m.attachments[0].name : '')).replace(/\s+/g, ' ').slice(0, 140);
  function renderPins() {
    if (!el.pins) return;
    const ch = cur();
    const list = ch ? Y.pinnedList(ch) : [];
    if (!list.length) { UI.set(el.pins); return; }
    const top = list[0];
    const label = top.msg ? [h('b', null, A.name(top.msg.userId) + ': '), snippetOf(top.msg)] : 'Pinned message (not loaded yet, click to load it)';
    UI.set(el.pins, h('div', { class: 'pin-bar' },
      icon('pin'),
      h('button', { class: 'pin-main', title: 'Go to the pinned message', onclick: () => jumpToPinned(ch, top) }, h('span', { class: 'pin-k' }, 'Pinned'), h('span', { class: 'pin-txt' }, label)),
      list.length > 1 ? h('button', { class: 'btn btn-sm', onclick: e => pinnedPopover(ch, e.currentTarget) }, `All ${list.length}`) : null,
      Y.canPin(ch) && list.length === 1 ? h('button', { class: 'icon-btn', 'aria-label': 'Unpin', title: 'Unpin', onclick: () => Y.pin(ch, { id: top.id }, false).catch(e => UI.toast(e.message, 'error')) }, icon('x')) : null));
  }
  function pinnedPopover(ch, anchor) {
    const list = Y.pinnedList(ch);
    UI.popover(anchor, [h('div', { class: 'menu-label' }, `Pinned messages (${list.length})`),
      h('div', { class: 'pin-list' }, list.map(p => h('div', { class: 'pin-row' },
        h('button', { class: 'menu-item', onclick: () => { UI.closePopover(); jumpToPinned(ch, p); } },
          h('span', { class: 'pin-txt' }, p.msg ? [h('b', null, A.name(p.msg.userId) + ': '), snippetOf(p.msg)] : 'Pinned message (not loaded yet)',
            h('span', { class: 'sub' }, `Pinned by ${A.name(p.by)} · ${U.formatDateTime(p.pinTs)}`))),
        Y.canPin(ch) ? h('button', { class: 'icon-btn', 'aria-label': 'Unpin', title: 'Unpin', onclick: () => { UI.closePopover(); Y.pin(ch, { id: p.id }, false).catch(e => UI.toast(e.message, 'error')); } }, icon('x')) : null)))],
    { cls: 'pin-pop', label: 'Pinned messages' });
  }
  async function jumpToPinned(ch, p) {
    if (!ch.msgs.has(p.id)) { try { await Y.loadUntil(ch, p.ts); } catch (e) { console.warn(e); } }
    if (cur() !== ch) return;
    jumpTo(ch, p.id);
  }

  function renderBanners() {
    if (!el.banners) return;
    const list = [];
    if (!Y.connected) {
      const btn = h('button', { class: 'btn btn-sm btn-reconnect' }, 'Reconnect');
      btn.addEventListener('click', () => UI.busy(btn, null, async () => { await Y.reconnect(); UI.toast('Reconnected', 'ok'); }));
      list.push(h('div', { class: 'banner', role: 'alert' }, icon('alert'), h('span', null, h('b', null, 'Lost access to the shared folder. '), 'Messages you type will wait here until you reconnect.'), btn));
    }
    const waiting = A.isAdmin() ? A.teamPending() : [];
    if (waiting.length) {
      list.push(h('div', { class: 'banner info', role: 'status' }, icon('users'),
        h('span', null, h('b', null, waiting.length === 1 ? `${waiting[0].name} is waiting for their group to be accepted. ` : `${waiting.length} people are waiting for their group to be accepted. `),
          'Until then, group-only messages don’t reach them.'),
        h('button', { class: 'btn btn-sm btn-primary', onclick: () => adminDialog('people') }, 'Review')));
    }
    if (st.banners.update) {
      list.push(h('div', { class: 'banner info', role: 'status' }, icon('refresh'), h('span', null, h('b', null, 'A new version of Sankyo Chat is available. '), 'Reload to update.'),
        h('button', { class: 'btn btn-sm btn-primary', onclick: () => location.reload() }, 'Reload')));
    }
    if (st.banners.wsTampered) {
      list.push(h('div', { class: 'banner danger', role: 'alert' }, icon('shield'), h('span', null, 'Someone other than the admin changed the workspace settings file. The change was ignored. Tell your admin.'),
        h('button', { class: 'btn btn-sm', onclick: () => Chat.showBanner('wsTampered', false) }, 'Dismiss')));
    }
    UI.set(el.banners, ...list);
  }

  /* ================= messages ================= */

  function intro(ch, info) {
    if (ch.kind === 'public') {
      return h('div', { class: 'intro' }, h('h3', null, '#' + info.name),
        h('p', null, `This is the start of #${info.name}.` + (info.description ? ' ' + info.description : '')));
    }
    if (Y.isPrivateChannel(ch)) {
      return h('div', { class: 'intro' }, h('h3', null, icon('lock', 'title-lock'), '#' + info.name),
        h('p', null, `This is the start of the private channel #${info.name}.` + (info.description ? ' ' + info.description.replace(/([^.!?])$/, '$1.') : '') +
          ' Only invited people can see it, and messages are end-to-end encrypted. History is kept, like any channel.'));
    }
    return h('div', { class: 'intro' }, h('h3', null, info.name),
      h('p', null, 'Messages here are end-to-end encrypted: only the people in this conversation can read them. Each message is deleted 7 days after it was sent.'));
  }

  function fileKind(a) {
    const n = a.name.toLowerCase();
    if (/\.pdf$/.test(n)) return 'pdf';
    if (/\.(xlsx?|csv|ods)$/.test(n)) return 'sheet';
    if (/\.(docx?|odt|rtf|txt)$/.test(n)) return 'doc';
    return '';
  }
  const isImage = a => /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(a.type || '');
  const isPdf = a => /\.pdf$/i.test(a.name || '') || a.type === 'application/pdf';

  /** Object URLs for files that are still on this PC (composer previews, messages being sent). */
  const localUrls = new Map();
  function localUrl(f) {
    if (!f) return null;
    let u = localUrls.get(f);
    if (!u) { u = URL.createObjectURL(f); localUrls.set(f, u); }
    return u;
  }
  function forgetLocalUrl(f) { const u = localUrls.get(f); if (u) { URL.revokeObjectURL(u); localUrls.delete(f); } }
  const isLocalImage = f =>!!f && /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(f.type || '');

  /** Two or more pictures in one message are shown together as an album; other files follow as cards. */
  function renderAttachments(m) {
    const all = m.attachments.map((a, i) => ({ a, i }));
    const imgs = all.filter(x => (m.local ? isLocalImage(m.files && m.files[x.i]) : isImage(x.a)));
    const album = imgs.length >= 2;
    return h('div', { class: 'msg-atts' },
      album ? renderAlbum(m, imgs) : null,
      all.filter(x => !(album && imgs.includes(x))).map(x => renderAttachment(m, x.a, x.i)));
  }

  /** Facebook-style grid: 2 side by side, 3 as one big + two small, 4 as 2×2, 5+ shows four with "+N". */
  function renderAlbum(m, imgs) {
    const shown = imgs.slice(0, 4);
    const extra = imgs.length - shown.length;
    return h('div', { class: 'album n' + shown.length, role: 'group', 'aria-label': `${imgs.length} pictures` }, shown.map((x, k) => {
      const url = m.local ? localUrl(m.files[x.i]) : blobUrls.get(x.a.fileId);
      const more = k === shown.length - 1 && extra > 0;
      return h('button', {
        class: 'album-tile' + (url ? '' : ' loading'), type: 'button', 'data-action': m.local ? null : 'open-att', 'data-i': String(x.i), disabled: m.local,
        'aria-label': more ? `Open pictures (${extra} more)` : 'Open image ' + x.a.name, title: x.a.name,
      },
      h('span', { class: 'album-img', 'data-thumb': url || m.local ? null : x.a.fileId, 'data-i': String(x.i) }, url ? thumbImg(url, x.a) : icon('image')),
      more ? h('span', { class: 'album-more' }, '+' + extra) : null);
    }));
  }

  function renderAttachment(m, a, i) {
    if (m.local) {
      return h('div', { class: 'att-file' }, h('span', { class: 'ficon ' + fileKind(a) }, icon(isImage(a) ? 'image' : 'file')),
        h('span', null, h('span', { class: 'fname' }, a.name), h('span', { class: 'fmeta' }, U.formatSize(a.size))));
    }
    if (isImage(a)) {
      const url = blobUrls.get(a.fileId);
      const size = fitImage(a);
      const btn = h('button', {
        class: 'att-img' + (size ? ' sized' : '') + (url ? '' : ' loading'), 'data-action': 'open-att', 'data-i': String(i),
        'data-thumb': url ? null : a.fileId, 'aria-label': 'Open image ' + a.name, title: a.name,
      }, url ? thumbImg(url, a) : [icon('image'), h('span', null, `${a.name} · ${U.formatSize(a.size)}`)]);
      if (size) { btn.style.width = size.w + 'px'; btn.style.aspectRatio = `${a.w} / ${a.h}`; }
      return btn;
    }
    const pdf = isPdf(a);
    return h('button', { class: 'att-file', 'data-action': 'open-att', 'data-i': String(i), 'data-save': pdf ? null : '1', title: (pdf ? 'View ' : 'Save ') + a.name },
      h('span', { class: 'ficon ' + fileKind(a) }, icon('file')),
      h('span', null, h('span', { class: 'fname' }, a.name), h('span', { class: 'fmeta' }, `${U.formatSize(a.size)} · ${pdf ? 'Click to view' : 'Click to save'}`)));
  }

  /** Poll card: the question is the message text; options show live results. */
  function renderPoll(ch, m) {
    const res = Y.pollResults(m);
    const mineV = Y.myVote(m);
    const total = Array.from(res.byOption.values()).reduce((n, l) => n + l.length, 0);
    const archived = Y.info(ch).archived;
    return h('div', { class: 'poll' },
      h('div', { class: 'poll-head' }, icon('poll'), h('span', null, 'Poll'), h('span', { class: 'muted' }, m.poll.multi ? ' · choose one or more' : ' · choose one')),
      h('div', { class: 'poll-q', html: UI.formatText(m.text, m.mentions) }),
      h('div', { class: 'poll-opts', role: m.poll.multi ? 'group' : 'radiogroup', 'aria-label': 'Poll options' }, m.poll.options.map(o => {
        const voters = res.byOption.get(o.id) || [];
        const pct = total ? Math.round(voters.length * 100 / total) : 0;
        const picked = mineV.includes(o.id);
        return h('button', {
          class: 'poll-opt' + (picked ? ' picked' : ''), 'data-action': 'vote', 'data-opt': o.id, disabled: archived,
          role: m.poll.multi ? 'checkbox' : 'radio', 'aria-checked': String(picked),
          title: voters.length ? voters.map(A.name).sort().join(', ') : 'No votes yet',
        },
        h('span', { class: 'poll-fill', style: { width: pct + '%' } }),
        h('span', { class: 'poll-check' + (m.poll.multi ? ' sq' : '') }, picked ? icon('check') : null),
        h('span', { class: 'poll-txt' }, o.text),
        h('span', { class: 'poll-n' }, voters.length ? `${voters.length} · ${pct}%` : '0'));
      })),
      h('div', { class: 'poll-foot' }, `${res.voters} ${res.voters === 1 ? 'person' : 'people'} voted` + (mineV.length ? ' · click your choice again to take it back' : '')));
  }

  function renderMsg(ch, m, grouped) {
    const u = A.users.get(m.userId);
    const mine = m.userId === meId();
    const shown = !m.deleted && !m.hidden && !m.decryptError && (m.verified || st.revealed.has(m.id));
    const mention = !mine && shown && (m.mentions.includes(meId()) || m.mentions.includes('channel'));
    const cls = 'msg' + (mine ? ' mine' : ' theirs') + (grouped ? ' grouped' : '') + (mention ? ' mention' : '') + (m.local ? ' ' + m.status : '');
    const time = U.formatTime(m.ts);
    const main = h('div', { class: 'msg-main' });
    const pinned = !m.local && shown && Y.isPinned(ch, m.id);
    if (!grouped || pinned) {
      main.appendChild(h('div', { class: 'msg-head' },
        grouped ? null : h('button', { class: 'msg-name', 'data-action': 'profile' }, u ? u.name : 'Unknown user'),
        grouped ? null : h('span', { class: 'msg-time', title: new Date(m.ts).toLocaleString() }, time),
        pinned ? h('span', { class: 'pinned-tag', title: 'Pinned by ' + A.name(ch.pins.get(m.id).by) }, icon('pin'), 'Pinned') : null));
    }
    if (m.deleted) main.appendChild(h('div', { class: 'msg-text gone' }, 'Message deleted'));
    else if (m.hidden) main.appendChild(h('div', { class: 'msg-text gone' }, 'Message hidden by the admin'));
    else if (m.decryptError) {
      main.appendChild(h('div', { class: 'msg-warn lock' }, icon('lock'), 'This message can’t be opened on this account. It was encrypted for an older security key (for example, before a password reset).'));
    } else if (!m.verified && !st.revealed.has(m.id)) {
      main.appendChild(h('div', { class: 'msg-warn', role: 'note' }, icon('alert'),
        h('span', null, h('b', null, 'Unverified sender. '), `This message’s signature didn’t check out, so it may not really be from ${u ? u.name : 'this person'}.`),
        h('button', { class: 'link-btn', 'data-action': 'reveal' }, 'Show anyway')));
    } else {
      if (!m.verified) main.appendChild(h('div', { class: 'msg-warn' }, icon('alert'), 'Unverified sender: be careful with this message.'));
      if (m.replyTo) {
        main.appendChild(h('div', { class: 'msg-reply', 'data-action': 'jump-reply', title: 'Go to the original message' },
          h('b', null, A.name(m.replyTo.userId) + ': '), m.replyTo.snippet || 'Original message'));
      }
      if (st.editingId === m.id) {
        const ta = h('textarea', { 'aria-label': 'Edit message', maxlength: String(Y.MAX_TEXT) });
        ta.value = st.editDraft;
        ta.addEventListener('input', () => { st.editDraft = ta.value; });
        ta.addEventListener('keydown', e => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); saveEdit(ch, m); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
        });
        main.appendChild(h('div', { class: 'msg-edit' }, ta, h('div', { class: 'row' }, 'Enter to save · Esc to cancel',
          h('span', { class: 'spacer' }), h('button', { class: 'btn btn-sm', onclick: cancelEdit }, 'Cancel'),
          h('button', { class: 'btn btn-sm btn-primary', onclick: () => saveEdit(ch, m) }, 'Save'))));
      } else if (m.poll) {
        main.appendChild(renderPoll(ch, m));
      } else if (m.text) {
        const t = h('div', { class: 'msg-text' + (UI.isBigEmoji(m.text.trim()) ? ' big-emoji' : ''), html: UI.formatText(m.text, m.mentions) });
        if (m.edited) t.appendChild(h('span', { class: 'edited', title: m.editTs ? 'Edited ' + new Date(m.editTs).toLocaleString() : null }, '(edited)'));
        if (m.local && m.status === 'sending') t.appendChild(h('span', { class: 'msg-status' }, icon('clock'), 'Sending…'));
        main.appendChild(t);
      } else if (m.local && m.status === 'sending') main.appendChild(h('span', { class: 'msg-status' }, icon('clock'), 'Sending…'));
      if (m.attachments && m.attachments.length) main.appendChild(renderAttachments(m));
      if (m.reactions && m.reactions.size) {
        main.appendChild(h('div', { class: 'msg-reacts' }, Array.from(m.reactions, ([e, set]) =>
          h('button', { class: 'react' + (set.has(meId()) ? ' mine' : ''), 'data-action': 'react', 'data-emoji': e,
            title: Array.from(set).map(A.name).join(', ') + ' reacted with ' + e, 'aria-pressed': String(set.has(meId())) },
          h('span', { class: 'em' }, e), String(set.size)))));
      }
    }
    if (m.local && m.status === 'failed') {
      main.appendChild(h('div', { class: 'msg-failed', role: 'alert' }, icon('alert'), `Not sent: ${m.error}.`,
        h('button', { class: 'link-btn', 'data-action': 'retry' }, 'Retry'), '·',
        h('button', { class: 'link-btn', 'data-action': 'discard' }, 'Delete')));
    }
    // the content (bubble, pictures, poll, reactions) sits in one box, so the action bar can sit right beside it
    let body = null;
    if (st.editingId !== m.id) {
      body = h('div', { class: 'msg-body' });
      Array.from(main.children).forEach(c => { if (!c.classList.contains('msg-head')) body.appendChild(c); });
      main.appendChild(body);
    }
    const row = h('div', { class: cls, 'data-id': m.id },
      h('div', { class: 'msg-gutter' }, grouped ? h('span', { class: 'hover-time' }, time) : UI.avatar(u, 40)), main);
    if (!m.local && shown && body && !Y.info(ch).archived) {
      const tools = h('div', { class: 'msg-tools', role: 'toolbar', 'aria-label': 'Message actions' },
        SC.emoji.quick.slice(0, 3).map(e => h('button', { class: 'icon-btn quick', 'data-action': 'react', 'data-emoji': e, 'aria-label': 'React with ' + e, title: 'React ' + e }, e)),
        h('button', { class: 'icon-btn', 'data-action': 'react-pick', 'aria-label': 'Add reaction', title: 'Add reaction' }, icon('smile')),
        h('button', { class: 'icon-btn', 'data-action': 'reply', 'aria-label': 'Reply', title: 'Reply' }, icon('reply')),
        Y.canPin(ch) ? h('button', { class: 'icon-btn' + (pinned ? ' active' : ''), 'data-action': 'pin', 'aria-label': pinned ? 'Unpin' : 'Pin', title: pinned ? 'Unpin' : 'Pin to the top' }, icon('pin')) : null,
        mine && !m.poll ? h('button', { class: 'icon-btn', 'data-action': 'edit', 'aria-label': 'Edit', title: 'Edit' }, icon('edit')) : null,
        mine ? h('button', { class: 'icon-btn', 'data-action': 'delete', 'aria-label': 'Delete', title: 'Delete' }, icon('trash')) : null,
        A.isAdmin() && ch.kind === 'public' && !mine ? h('button', { class: 'icon-btn', 'data-action': 'hide', 'aria-label': 'Hide message (admin)', title: 'Hide message (admin)' }, icon('eyeOff')) : null);
      body.appendChild(tools);
    }
    return row;
  }

  /** The action bar sits beside the message; when there isn't room there (a wide message), it goes above it. */
  function placeTools(e) {
    const row = e.target.closest && e.target.closest('.msg');
    if (!row || row === placeTools.last) return;
    placeTools.last = row;
    const body = row.querySelector(':scope > .msg-main > .msg-body');
    const tools = body && body.querySelector(':scope > .msg-tools');
    if (!tools) return;
    const box = el.msgs.getBoundingClientRect(), b = body.getBoundingClientRect();
    const need = tools.offsetWidth || tools.children.length * 32 + 10; // hidden until hover, so estimate
    const room = row.classList.contains('mine') ? b.left - box.left - 8 : box.right - b.right - 8;
    body.classList.toggle('tools-above', room < need + 6);
  }

  /** Who has read up to my newest message; re-render only when this changes. */
  function seenSig(ch) {
    if (!ch || ch.kind === 'public') return '';
    let last = 0;
    for (const m of ch.msgs.values()) if (m.userId === meId() && !m.deleted && m.ts > last) last = m.ts;
    return last ? last + ':' + Y.seenBy(ch, last).sort().join(',') : '';
  }
  function seenLine(ch, m) {
    const ids = Y.seenBy(ch, m.ts);
    if (!ids.length) return null;
    const others = Y.members(ch).filter(id => id !== meId());
    let text;
    if (ch.kind === 'dm') text = 'Seen';
    else if (ids.length === others.length) text = 'Seen by everyone';
    else {
      const names = ids.map(A.name).sort();
      text = 'Seen by ' + (names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`);
    }
    return h('div', { class: 'seen', title: ch.kind === 'dm' ? null : ids.map(A.name).sort().join(', ') }, icon('check'), text);
  }

  function renderMessages() {
    if (isAnn()) return renderAnnouncements();
    const ch = cur();
    if (!ch || !el.msgs) return;
    const box = el.msgs;
    const atBottom = st.stick || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const fromBottom = box.scrollHeight - box.scrollTop;
    const keepTop = box.scrollTop;
    const info = Y.info(ch);
    const frag = document.createDocumentFragment();
    frag.appendChild(ch.allLoaded ? intro(ch, info) : h('div', { class: 'load-more' }, st.loadingOlder ? 'Loading older messages…' : 'Scroll up for older messages'));
    const list = Y.sorted(ch).concat(ch.outbox);
    // "Seen by" goes under my newest sent message in DMs and groups
    let myLast = null;
    if (ch.kind !== 'public') for (const m of list) if (m.userId === meId() && !m.local && !m.deleted) myLast = m;
    st.seenSig = seenSig(ch);
    let prev = null, lastDay = '', divDone = false;
    for (const m of list) {
      const day = U.localDay(m.ts);
      if (day !== lastDay) { frag.appendChild(h('div', { class: 'day-div', role: 'separator' }, U.formatDayLabel(m.ts))); lastDay = day; prev = null; }
      if (!divDone && st.dividerTs && !m.local && m.ts > st.dividerTs && m.userId !== meId()) {
        frag.appendChild(h('div', { class: 'new-div', role: 'separator' }, 'New messages'));
        divDone = true; prev = null;
      }
      const grouped = !!prev && prev.userId === m.userId && m.ts - prev.ts < 5 * 60000 && !m.replyTo &&
        !prev.deleted && !prev.hidden && prev.verified && m.verified && !m.decryptError && !prev.decryptError;
      frag.appendChild(renderMsg(ch, m, grouped));
      if (m === myLast) { const r = seenLine(ch, m); if (r) frag.appendChild(r); }
      prev = m;
    }
    UI.set(box, frag);
    loadThumbs(ch);
    if (st.scrollTo) {
      const t = box.querySelector(`[data-id="${CSS.escape(st.scrollTo)}"]`);
      if (t) { t.scrollIntoView({ block: 'center' }); t.classList.add('flash'); st.scrollTo = null; }
    } else if (st.firstRender) {
      const d = box.querySelector('.new-div');
      if (d) d.scrollIntoView({ block: 'center' }); else box.scrollTop = box.scrollHeight;
      if (list.length) st.firstRender = false;
    } else if (st.prepending) {
      box.scrollTop = box.scrollHeight - fromBottom;
      st.prepending = false;
    } else if (atBottom) box.scrollTop = box.scrollHeight;
    else box.scrollTop = keepTop;
    st.stick = false;
    if (st.editingId) {
      const ta = box.querySelector('.msg-edit textarea');
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }
    maybeMarkRead();
  }

  function maybeMarkRead() {
    if (isAnn()) return ackVisibleAnnouncements();
    const ch = cur();
    if (!ch || !el.msgs) return;
    const box = el.msgs;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    if (document.visibilityState === 'visible' && document.hasFocus() && nearBottom && ch.unread) Y.markRead(ch);
  }
  Chat.maybeMarkRead = maybeMarkRead;

  function onScroll() {
    const ch = cur();
    if (!ch) return;
    if (el.msgs.scrollTop < 200 && !ch.allLoaded && !st.loadingOlder) {
      st.loadingOlder = true;
      st.prepending = true;
      Y.loadOlder(ch).catch(console.warn).finally(() => { st.loadingOlder = false; st.prepending = true; schedule('msgs'); });
    }
    maybeMarkRead();
  }

  async function loadThumbs(ch) {
    const nodes = Array.from(el.msgs.querySelectorAll('[data-thumb]')).filter(n => !thumbLoading.has(n.dataset.thumb));
    await U.mapLimit(nodes, 3, async node => {
      const fileId = node.dataset.thumb;
      const row = node.closest('.msg');
      const m = row && ch.msgs.get(row.dataset.id);
      const a = m && m.attachments[Number(node.dataset.i)];
      if (!a) return;
      thumbLoading.add(fileId);
      try {
        const blob = await Y.readAttachment(ch, m, a);
        const url = URL.createObjectURL(blob);
        blobUrls.set(fileId, url);
        document.querySelectorAll(`[data-thumb="${fileId}"]`).forEach(n => { n.removeAttribute('data-thumb'); n.classList.remove('loading'); if (n.parentElement) n.parentElement.classList.remove('loading'); UI.set(n, thumbImg(url, a)); });
      } catch (e) {
        imageFailed(node, a);
      }
    });
  }

  /** Display size for an image: whole picture, at most 360×280, never upscaled. */
  function fitImage(a) {
    if (!(a.w > 0 && a.h > 0)) return null;
    const s = Math.min(1, 360 / a.w, 280 / a.h);
    return { w: Math.max(48, Math.round(a.w * s)), h: Math.max(48, Math.round(a.h * s)) };
  }
  function thumbImg(url, a) {
    const img = h('img', { src: url, alt: a.name });
    img.addEventListener('load', () => {
      // images without stored dimensions change height once loaded: keep the view pinned to the bottom
      const box = el.msgs;
      if (box && box.scrollHeight - box.scrollTop - box.clientHeight < 400) box.scrollTop = box.scrollHeight;
    }, { once: true });
    img.addEventListener('error', () => { const b = img.closest('.att-img, .album-img'); if (b) imageFailed(b, a); }, { once: true });
    return img;
  }
  function imageFailed(node, a) {
    node.removeAttribute('data-thumb');
    if (node.classList.contains('album-img')) {
      // album tile: keep the grid, show a placeholder; clicking saves the file
      const tile = node.parentElement;
      UI.set(node, icon('image'));
      if (tile) { tile.classList.remove('loading'); tile.classList.add('failed'); tile.dataset.save = '1'; tile.title = a.name + ' · Can’t preview · Click to save'; }
      return;
    }
    node.dataset.save = '1';
    node.className = 'att-file';
    node.style.width = ''; node.style.aspectRatio = '';
    node.title = 'Save ' + a.name;
    UI.set(node, h('span', { class: 'ficon' }, icon('image')),
      h('span', null, h('span', { class: 'fname' }, a.name), h('span', { class: 'fmeta' }, `${U.formatSize(a.size)} · Can’t preview · Click to save`)));
  }

  async function onMsgClick(e) {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    if (isAnn()) return onAnnClick(t);
    const row = t.closest('.msg');
    const ch = cur();
    if (!row || !ch) return;
    const id = row.dataset.id;
    const m = ch.msgs.get(id) || ch.outbox.find(x => x.id === id);
    if (!m) return;
    const run = p => Promise.resolve(p).catch(err => UI.toast(err.message, 'error'));
    switch (t.dataset.action) {
      case 'react': return run(Y.react(ch, m, t.dataset.emoji));
      case 'react-pick': return UI.emojiPicker(t, em => run(Y.react(ch, m, em)), 'bottom');
      case 'vote': return run(Y.vote(ch, m, t.dataset.opt));
      case 'pin': return run(Y.pin(ch, m, !Y.isPinned(ch, m.id)).then(() => UI.toast(Y.isPinned(ch, m.id) ? 'Pinned. Everyone here sees it at the top.' : 'Unpinned', 'ok')));
      case 'reply': return setReply(ch, m);
      case 'edit': return startEdit(m);
      case 'delete':
        if (await UI.confirm({ title: 'Delete message?', text: 'Everyone will see “Message deleted” instead. Attachments are removed from the shared drive.', ok: 'Delete', danger: true })) run(Y.deleteMessage(ch, m));
        return;
      case 'hide':
        if (await UI.confirm({ title: 'Hide this message?', text: 'Everyone will see “Message hidden by the admin” instead.', ok: 'Hide', danger: true })) run(Y.hide(ch, m));
        return;
      case 'retry': return Y.retry(ch, m);
      case 'discard': return Y.discard(ch, m);
      case 'reveal': st.revealed.add(id); return schedule('msgs');
      case 'open-att': return openAttachment(ch, m, m.attachments[Number(t.dataset.i)], t.dataset.save === '1');
      case 'jump-reply': return jumpTo(ch, m.replyTo.id);
      case 'profile': return profileCard(m.userId, t);
    }
  }

  function jumpTo(ch, id) {
    if (!ch.msgs.has(id)) { UI.toast('The original message isn’t loaded or no longer exists.'); return; }
    st.scrollTo = id;
    schedule('msgs');
  }

  function startEdit(m) {
    st.editingId = m.id;
    st.editDraft = m.text;
    schedule('msgs');
  }
  function cancelEdit() {
    st.editingId = null;
    schedule('msgs');
    if (el.ta) el.ta.focus();
  }
  async function saveEdit(ch, m) {
    const text = st.editDraft;
    if (text.trim() === m.text.trim()) return cancelEdit();
    try { await Y.edit(ch, m, text); st.editingId = null; schedule('msgs'); if (el.ta) el.ta.focus(); } catch (e) { UI.toast(e.message, 'error'); }
  }

  /** Save a blob via the browser's "Save as" window (downloads may be blocked). */
  async function saveAs(name, getBlob) {
    if (window.showSaveFilePicker) {
      let fh;
      try { fh = await window.showSaveFilePicker({ suggestedName: name }); } catch (e) { if (e.name === 'AbortError') return; throw e; }
      const w = await fh.createWritable();
      await w.write(await getBlob());
      await w.close();
      UI.toast('Saved ' + name, 'ok');
      return;
    }
    const url = URL.createObjectURL(await getBlob());
    const a = h('a', { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  Chat.saveAs = saveAs;

  async function openAttachment(ch, m, a, saveOnly) {
    if (!a) return;
    try {
      if (isImage(a) && !saveOnly) {
        const pics = m.attachments.filter(isImage);
        const items = pics.map(p => {
          let pending = null; // one read per picture, shared by the pre-load and the click
          return {
            a: p,
            load: () => {
              const have = blobUrls.get(p.fileId);
              if (have) return Promise.resolve(have);
              if (!pending) {
                pending = Y.readAttachment(ch, m, p).then(blob => {
                  const url = URL.createObjectURL(blob);
                  blobUrls.set(p.fileId, url);
                  return url;
                }).catch(e => { pending = null; throw e; });
              }
              return pending;
            },
            getBlob: () => Y.readAttachment(ch, m, p),
          };
        });
        await items[pics.indexOf(a)].load();
        return lightbox(items, pics.indexOf(a));
      }
      if (isPdf(a) && !saveOnly) {
        const blob = await Y.readAttachment(ch, m, a);
        return pdfViewer(new Blob([blob], { type: 'application/pdf' }), a, () => Y.readAttachment(ch, m, a));
      }
      await saveAs(a.name, () => Y.readAttachment(ch, m, a));
    } catch (e) { UI.toast(e.message, 'error'); }
  }

  /** Full-screen image viewer: mouse wheel, +/− buttons or keys, or double-click to zoom; drag to move around.
   *  `items` = [{a, load() → url, getBlob}] (all pictures in the message); ← → or the arrows move between them. */
  function lightbox(items, start) {
    const MIN = 1, MAX = 8;
    let scale = 1, x = 0, y = 0, drag = null, moved = false, idx = start, seq = 0;
    let img = h('img', { alt: '', draggable: 'false' });
    const errEl = h('div', { class: 'lb-error hidden', role: 'alert' });
    const stage = h('div', { class: 'lb-stage' }, img, errEl);
    const nameEl = h('span', { class: 'lb-name' });
    const countEl = h('span', { class: 'lb-count' });
    const multi = items.length > 1;
    async function show(i) {
      idx = (i + items.length) % items.length;
      const it = items[idx], my = ++seq;
      nameEl.textContent = `${it.a.name} · ${U.formatSize(it.a.size)}`;
      countEl.textContent = multi ? `${idx + 1} / ${items.length}` : '';
      lb.setAttribute('aria-label', it.a.name);
      // take the previous picture off screen straight away, so a slow read never looks like "nothing happened"
      errEl.classList.add('hidden');
      stage.classList.add('lb-loading');
      // every picture gets its own <img>: swapping the source of one element could leave the old picture painted
      const fresh = h('img', { alt: it.a.name, draggable: 'false' });
      img.replaceWith(fresh);
      img = fresh;
      scale = 1; x = 0; y = 0; draw();
      try {
        const url = await it.load();
        if (my !== seq) return;
        fresh.src = url;
        await fresh.decode();
      } catch (e) {
        if (my !== seq) return;
        fresh.removeAttribute('src');
        UI.set(errEl, icon('alert'), h('span', null, `Couldn’t open ${it.a.name}: ${(e && e.message) || 'the picture can’t be shown'}. Use Save to keep the file.`));
        errEl.classList.remove('hidden');
      }
      if (my === seq) stage.classList.remove('lb-loading');
      // fetch the neighbours in the background so moving through the album is instant
      if (multi) [idx + 1, idx - 1].forEach(j => items[(j + items.length) % items.length].load().catch(() => {}));
    }
    const nav = (dir, label) => h('button', { class: 'lb-nav ' + dir, 'aria-label': label, title: label, onclick: e => { e.stopPropagation(); show(idx + (dir === 'next' ? 1 : -1)); } }, dir === 'next' ? '›' : '‹');
    if (multi) stage.append(nav('prev', 'Previous picture (←)'), nav('next', 'Next picture (→)'));
    const pct = h('span', { class: 'lb-pct', 'aria-live': 'polite' }, '100%');
    const draw = () => {
      img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
      pct.textContent = Math.round(scale * 100) + '%';
      stage.classList.toggle('zoomed', scale > 1);
    };
    /** Zoom to `s`, keeping the point under (cx, cy) in place (default: the middle of the screen). */
    function zoomTo(s, cx, cy) {
      s = Math.min(MAX, Math.max(MIN, s));
      const r = stage.getBoundingClientRect();
      const px = (cx === undefined ? r.left + r.width / 2 : cx) - (r.left + r.width / 2);
      const py = (cy === undefined ? r.top + r.height / 2 : cy) - (r.top + r.height / 2);
      x = px - (px - x) * (s / scale);
      y = py - (py - y) * (s / scale);
      scale = s;
      if (scale === 1) { x = 0; y = 0; }
      draw();
    }
    const step = 1.25;
    stage.addEventListener('wheel', e => { e.preventDefault(); zoomTo(scale * (e.deltaY < 0 ? step : 1 / step), e.clientX, e.clientY); }, { passive: false });
    stage.addEventListener('dblclick', e => { if (!e.target.closest('.lb-nav')) zoomTo(scale > 1 ? 1 : 2.5, e.clientX, e.clientY); });
    stage.addEventListener('pointerdown', e => {
      moved = false;
      if (scale <= 1 || e.button !== 0 || e.target.closest('.lb-nav')) return;
      drag = { sx: e.clientX - x, sy: e.clientY - y, ox: e.clientX, oy: e.clientY };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add('dragging');
    });
    stage.addEventListener('pointermove', e => {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.ox) + Math.abs(e.clientY - drag.oy) > 3) moved = true;
      x = e.clientX - drag.sx; y = e.clientY - drag.sy;
      draw();
    });
    const endDrag = () => { drag = null; stage.classList.remove('dragging'); };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    const close = () => { viewers.delete(close); lb.remove(); document.removeEventListener('keydown', keys, true); };
    const keys = e => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomTo(scale * step); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomTo(scale / step); }
      else if (e.key === '0') { e.preventDefault(); zoomTo(1); }
      else if (multi && e.key === 'ArrowRight') { e.preventDefault(); show(idx + 1); }
      else if (multi && e.key === 'ArrowLeft') { e.preventDefault(); show(idx - 1); }
    };
    const lb = h('div', { class: 'lightbox', role: 'dialog', onclick: e => { if ((e.target === lb || e.target === stage) && !moved && scale === 1) close(); } },
      stage,
      h('div', { class: 'bar' }, countEl, nameEl,
        h('span', { class: 'lb-zoom' },
          h('button', { class: 'btn btn-sm', 'aria-label': 'Zoom out', title: 'Zoom out (−)', onclick: () => zoomTo(scale / step) }, icon('zoomOut')),
          pct,
          h('button', { class: 'btn btn-sm', 'aria-label': 'Zoom in', title: 'Zoom in (+)', onclick: () => zoomTo(scale * step) }, icon('zoomIn')),
          h('button', { class: 'btn btn-sm', 'aria-label': 'Fit to screen', title: 'Fit to screen (0)', onclick: () => zoomTo(1) }, icon('fit'))),
        h('button', { class: 'btn btn-sm', onclick: () => { const it = items[idx]; saveAs(it.a.name, it.getBlob).catch(e => UI.toast(e.message, 'error')); } }, icon('download'), 'Save'),
        h('button', { class: 'btn btn-sm', onclick: close, autofocus: true }, icon('x'), 'Close')),
      h('div', { class: 'lb-hint' }, 'Scroll or double-click to zoom · drag to move' + (multi ? ' · ← → for the other pictures' : '')));
    document.body.appendChild(lb);
    document.addEventListener('keydown', keys, true);
    viewers.add(close);
    lb.querySelector('[autofocus]').focus();
    show(start);
  }

  /** In-app PDF viewer, using the browser's own PDF reader (Edge and Chrome both have one). */
  function pdfViewer(blob, a, getBlob) {
    const url = URL.createObjectURL(blob);
    const close = () => { viewers.delete(close); lb.remove(); document.removeEventListener('keydown', esc, true); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const frame = h('iframe', { class: 'pdf-frame', src: url, title: a.name });
    const lb = h('div', { class: 'lightbox pdf-view', role: 'dialog', 'aria-label': a.name },
      h('div', { class: 'bar' }, icon('file'), h('span', { class: 'lb-name' }, `${a.name} · ${U.formatSize(a.size)}`),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-sm', onclick: () => saveAs(a.name, getBlob).catch(e => UI.toast(e.message, 'error')) }, icon('download'), 'Save'),
        h('button', { class: 'btn btn-sm', onclick: close, autofocus: true }, icon('x'), 'Close')),
      frame,
      h('div', { class: 'lb-hint' }, 'Use the PDF toolbar to zoom, search or print. If the page stays blank, click Save and open the file instead.'));
    document.body.appendChild(lb);
    document.addEventListener('keydown', esc, true);
    viewers.add(close);
    lb.querySelector('[autofocus]').focus();
  }

  /* ================= composer ================= */

  function buildComposer() {
    if (isAnn()) {
      el.ta = null;
      UI.set(el.composerWrap, A.isAdmin()
        ? h('div', { class: 'ann-compose' }, h('span', { class: 'muted' }, 'Announcements pop up for everyone and stay here for a year.'),
          h('button', { class: 'btn btn-primary', onclick: newAnnouncementDialog }, icon('megaphone'), 'New announcement'))
        : h('div', { class: 'archived-note' }, 'Only admins can post here. New announcements also pop up on your screen.'));
      return;
    }
    const ch = cur();
    if (!ch) { UI.set(el.composerWrap); return; }
    const info = Y.info(ch);
    if (info.archived) {
      el.ta = null;
      UI.set(el.composerWrap, h('div', { class: 'archived-note' }, 'This channel is archived. You can read it, but not post.'));
      return;
    }
    const placeholder = 'Message ' + chName(ch);
    const ta = h('textarea', { rows: '1', placeholder, 'aria-label': placeholder });
    ta.value = st.drafts[ch.id] || '';
    el.ta = ta;
    el.replyBar = h('div');
    el.chips = h('div');
    el.count = h('span', { class: 'count' });
    el.hintLeft = h('span');
    const fileInput = h('input', { type: 'file', multiple: true, class: 'hidden', onchange: () => { addFiles(fileInput.files); fileInput.value = ''; } });
    const fmt = (name, label, before, after) => h('button', { class: 'icon-btn', type: 'button', 'aria-label': label, title: label, onclick: () => wrapSel(ta, before, after) }, icon(name));
    const emojiBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Insert emoji', title: 'Emoji' }, icon('smile'));
    emojiBtn.addEventListener('click', () => UI.emojiPicker(emojiBtn, e => insertText(ta, e)));
    el.sendBtn = h('button', { class: 'send-btn', type: 'button', 'aria-label': 'Send', title: 'Send (Enter)', onclick: send }, icon('send'));
    UI.set(el.composerWrap, 
      h('div', { class: 'composer' },
        el.replyBar,
        h('div', { class: 'fmt-bar' }, fmt('bold', 'Bold (Ctrl+B)', '**'), fmt('italic', 'Italic (Ctrl+I)', '*'), fmt('code', 'Code', '`')),
        el.chips,
        h('div', { class: 'comp-row' }, ta, emojiBtn,
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Attach files (max 5 MB each)', title: 'Attach files', onclick: () => fileInput.click() }, icon('clip')),
          A.isAdmin() ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Create a poll', title: 'Create a poll', onclick: () => pollDialog(ch) }, icon('poll')) : null,
          el.sendBtn, fileInput)),
      h('div', { class: 'comp-hint' }, el.hintLeft, el.count));
    ta.addEventListener('input', () => { st.drafts[ch.id] = ta.value; autosize(ta); updateCount(); mentionCheck(); });
    ta.addEventListener('keydown', onComposerKey);
    ta.addEventListener('click', mentionCheck);
    ta.addEventListener('paste', e => {
      const files = Array.from(e.clipboardData ? e.clipboardData.files : []);
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
    renderReplyBar(); renderChips(); updateCount(); autosize(ta);
  }

  function autosize(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'; }
  function updateCount() {
    if (!el.ta) return;
    const n = el.ta.value.length;
    el.count.textContent = n > Y.MAX_TEXT - 500 ? `${n.toLocaleString()} / ${Y.MAX_TEXT.toLocaleString()}` : '';
    el.count.classList.toggle('over', n > Y.MAX_TEXT);
    const files = st.files[st.openId] || [];
    el.hintLeft.textContent = files.length ? 'Drop more files to attach · max 5 MB each' : 'Enter to send · Shift+Enter for a new line · @ to mention';
  }
  function insertText(ta, text) {
    ta.focus();
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input'));
  }
  function wrapSel(ta, before, after) {
    after = after || before;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const sel = ta.value.slice(s, e);
    if (before === '`' && sel.includes('\n')) { before = '```\n'; after = '\n```'; }
    ta.focus();
    ta.setRangeText(before + sel + after, s, e, 'end');
    ta.setSelectionRange(s + before.length, s + before.length + sel.length);
    ta.dispatchEvent(new Event('input'));
  }

  function renderReplyBar() {
    const r = st.replies[st.openId];
    if (!el.replyBar) return;
    UI.set(el.replyBar, r ? h('div', { class: 'reply-bar' }, icon('reply'),
      h('span', { class: 'txt' }, 'Replying to ', h('b', null, A.name(r.userId)), ': ' + r.snippet),
      h('button', { class: 'icon-btn', 'aria-label': 'Cancel reply', onclick: () => { st.replies[st.openId] = null; renderReplyBar(); el.ta && el.ta.focus(); } }, icon('x'))) : '');
  }
  function setReply(ch, m) {
    const snippet = (m.text || (m.attachments[0] ? '📎 ' + m.attachments[0].name : '')).replace(/\s+/g, ' ').slice(0, 120);
    st.replies[ch.id] = { id: m.id, userId: m.userId, snippet };
    renderReplyBar();
    if (el.ta) el.ta.focus();
  }

  function renderChips() {
    if (!el.chips) return;
    const files = st.files[st.openId] || [];
    const remove = i => { const f = files[i]; files.splice(i, 1); forgetLocalUrl(f); renderChips(); updateCount(); };
    // pictures as a strip of small thumbnails, other files as chips
    const pics = files.map((f, i) => ({ f, i })).filter(x => isLocalImage(x.f));
    const others = files.map((f, i) => ({ f, i })).filter(x => !isLocalImage(x.f));
    UI.set(el.chips, files.length ? h('div', { class: 'chips' },
      pics.map(({ f, i }) => h('span', { class: 'chip-img', title: `${f.name} · ${U.formatSize(f.size)}` },
        h('img', { src: localUrl(f), alt: f.name }),
        h('button', { class: 'chip-img-x', type: 'button', 'aria-label': 'Remove ' + f.name, onclick: () => remove(i) }, icon('x')))),
      others.map(({ f, i }) => h('span', { class: 'chip' }, icon('file'),
        h('b', null, f.name), h('span', { class: 'muted' }, U.formatSize(f.size)),
        h('button', { class: 'icon-btn', 'aria-label': 'Remove ' + f.name, onclick: () => remove(i) }, icon('x'))))) : '');
  }
  /** Content fingerprint of a file waiting to be sent (files are ≤ 5 MB, so this is quick). */
  const fileHashes = new WeakMap();
  function fileHash(f) {
    let p = fileHashes.get(f);
    if (!p) { p = f.arrayBuffer().then(b => crypto.subtle.digest('SHA-256', b)).then(d => U.b64(new Uint8Array(d))).catch(() => Math.random().toString(36)); fileHashes.set(f, p); }
    return p;
  }

  /** Attach files to the message being written. The same file twice (e.g. one screenshot pasted twice)
   *  is skipped: it would only show the same picture twice in the album. */
  async function addFiles(list) {
    const ch = cur();
    if (!ch || Y.info(ch).archived) return;
    const files = st.files[ch.id] = st.files[ch.id] || [];
    const incoming = Array.from(list);
    let dupes = 0;
    for (const f of incoming) {
      if (f.size > Y.MAX_FILE) { UI.toast(`“${f.name}” is ${U.formatSize(f.size)}. The limit is 5 MB.`, 'error'); continue; }
      if (files.length >= Y.MAX_ATTACH) { UI.toast(`You can attach up to ${Y.MAX_ATTACH} files at a time.`, 'error'); break; }
      const same = files.filter(x => x.size === f.size);
      if (same.length) {
        const hf = await fileHash(f);
        if ((await Promise.all(same.map(fileHash))).includes(hf)) { dupes++; continue; }
      }
      if (files.length >= Y.MAX_ATTACH) break;
      files.push(f);
    }
    if (dupes) UI.toast(dupes === 1 ? 'That file is already attached.' : `${dupes} files were already attached.`);
    if (cur() !== ch) return;
    renderChips(); updateCount();
    if (el.ta) el.ta.focus();
  }
  function setupDrop() {
    let depth = 0;
    el.conv.addEventListener('dragenter', e => { if (hasFiles(e)) { depth++; el.msgs.classList.add('drag'); e.preventDefault(); } });
    el.conv.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
    el.conv.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) el.msgs.classList.remove('drag'); });
    el.conv.addEventListener('drop', e => { depth = 0; el.msgs.classList.remove('drag'); if (hasFiles(e)) { e.preventDefault(); addFiles(e.dataTransfer.files); } });
  }
  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

  function send() {
    const ch = cur();
    if (!ch || !el.ta) return;
    const text = el.ta.value;
    const files = st.files[ch.id] || [];
    if (!text.trim() && !files.length) return;
    if (text.length > Y.MAX_TEXT) { UI.toast(`Messages can be at most ${Y.MAX_TEXT.toLocaleString()} characters.`, 'error'); return; }
    const reply = st.replies[ch.id] || null;
    el.ta.value = ''; st.drafts[ch.id] = ''; st.files[ch.id] = []; st.replies[ch.id] = null;
    autosize(el.ta); renderReplyBar(); renderChips(); updateCount(); closeMention();
    st.dividerTs = 0;
    st.stick = true;
    Y.send(ch, { text, replyTo: reply, files }).catch(e => UI.toast(e.message, 'error'));
  }

  function onComposerKey(e) {
    if (mention && mentionKey(e)) return;
    const ta = el.ta;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'b' || e.key === 'i')) { e.preventDefault(); wrapSel(ta, e.key === 'b' ? '**' : '*'); return; }
    if (e.key === 'ArrowUp' && !ta.value) {
      const ch = cur();
      const last = ch && Y.sorted(ch).slice().reverse().find(m => m.userId === meId() && !m.deleted && !m.hidden && m.verified && !m.decryptError && !m.poll);
      if (last) { e.preventDefault(); startEdit(last); }
      return;
    }
    if (e.key === 'Escape' && st.replies[st.openId]) { e.preventDefault(); e.stopPropagation(); st.replies[st.openId] = null; renderReplyBar(); }
  }

  /* ---- @mention picker ---- */
  let mention = null; // {start, items, sel, el}
  function mentionCheck() {
    const ta = el.ta;
    if (!ta) return;
    const before = ta.value.slice(0, ta.selectionStart);
    const m = /(^|\s)@([\p{L}\p{N}._'\- ]{0,32})$/u.exec(before);
    if (!m) return closeMention();
    const q = m[2].toLowerCase();
    const ch = cur();
    let items = A.activeUsers().filter(u => u.id !== meId() && u.name.toLowerCase().startsWith(q))
      .concat(q.length > 1 ? A.activeUsers().filter(u => u.id !== meId() && !u.name.toLowerCase().startsWith(q) && u.name.toLowerCase().includes(q)) : []);
    if (ch.kind !== 'public') { const mem = Y.members(ch); items = items.filter(u => mem.includes(u.id)); }
    items = items.slice(0, 8).map(u => ({ id: u.id, name: u.name, user: u }));
    if (ch.kind === 'public' && 'channel'.startsWith(q)) items.push({ id: 'channel', name: 'channel' });
    if (!items.length || (q.includes(' ') && !items.some(i => i.name.toLowerCase().startsWith(q)))) return closeMention();
    const start = before.length - m[2].length - 1;
    const sel = mention ? Math.min(mention.sel, items.length - 1) : 0;
    if (!mention) {
      mention = { el: h('div', { class: 'popover mention-pop', role: 'listbox', 'aria-label': 'Mention someone', style: { position: 'absolute', bottom: 'calc(100% - 4px)', left: '20px' } }) };
      el.composerWrap.appendChild(mention.el);
    }
    Object.assign(mention, { start, items, sel });
    drawMention();
  }
  function drawMention() {
    UI.set(mention.el, ...mention.items.map((it, i) => h('button', {
      class: 'menu-item' + (i === mention.sel ? ' sel' : ''), role: 'option', 'aria-selected': String(i === mention.sel), type: 'button',
      onmousedown: e => { e.preventDefault(); pickMention(i); },
    }, it.user ? UI.avatar(it.user, 22) : icon('at'), it.id === 'channel' ? '@channel' : it.name,
      h('span', { class: 'sub' }, it.id === 'channel' ? 'Notify everyone here' : UI.stateLabel(Y.presenceOf(it.id).state)))));
  }
  function mentionKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      mention.sel = (mention.sel + (e.key === 'ArrowDown' ? 1 : -1) + mention.items.length) % mention.items.length;
      drawMention();
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mention.sel); return true; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMention(); return true; }
    return false;
  }
  function pickMention(i) {
    const it = mention.items[i];
    const ta = el.ta;
    ta.setRangeText('@' + it.name + ' ', mention.start, ta.selectionStart, 'end');
    closeMention();
    ta.focus();
    ta.dispatchEvent(new Event('input'));
  }
  function closeMention() { if (mention) { mention.el.remove(); mention = null; } }

  /* ================= notifications ================= */

  function onIncoming({ ch, msgs }) {
    if (Y.isMuted(ch.id)) return;
    const viewing = ch.id === st.openId && document.visibilityState === 'visible' && document.hasFocus();
    for (const m of msgs) {
      if (m.deleted || !m.verified) continue;
      const mentioned = m.mentions.includes(meId()) || m.mentions.includes('channel');
      if (ch.kind === 'public' && !mentioned) continue;
      if (viewing) continue;
      const who = A.name(m.userId);
      const title = ch.kind === 'dm' ? who : `${who} in ${chName(ch)}`;
      const body = m.decryptError ? 'New message' : (m.text ? (m.poll ? '📊 Poll: ' : '') + m.text.replace(/\s+/g, ' ').slice(0, 140) : '📎 Sent an attachment');
      SC.app.notify({ title, body, tag: ch.id, onClick: () => Chat.open(ch.id) });
    }
  }

  /* ================= dialogs ================= */

  function quickSwitcher() {
    const input = h('input', { placeholder: 'Jump to a channel or person', 'aria-label': 'Jump to', autofocus: true });
    const list = h('div', { class: 's-list', role: 'listbox' });
    let items = [], sel = 0;
    function compute() {
      const q = input.value.trim().toLowerCase().replace(/^[#@]/, '');
      const people = A.activeUsers().filter(u => u.id !== meId() && (!q || u.name.toLowerCase().includes(q)))
        .map(u => ({ kind: 'person', u, key: u.id, go: () => Chat.openUser(u.id) }));
      const chans = Array.from(Y.chans.values()).filter(c => c.kind !== 'dm' && (!q || Y.info(c).name.toLowerCase().includes(q)))
        .sort((a, b) => (b.unread - a.unread) || Y.info(a).name.localeCompare(Y.info(b).name))
        .map(c => ({ kind: 'chan', c, key: c.id, go: () => Chat.open(c.id) }));
      items = people.slice(0, q ? 8 : 5).concat(chans.slice(0, 8));
      sel = Math.min(sel, Math.max(0, items.length - 1));
      draw(people.slice(0, q ? 8 : 5), chans.slice(0, 8));
    }
    function row(it, i) {
      const content = it.kind === 'person'
        ? [UI.avatar(it.u, 32), h('div', null, h('div', null, it.u.name), h('div', { class: 'sub' }, UI.stateLabel(Y.presenceOf(it.u.id).state) + (Y.presenceOf(it.u.id).statusText ? ' · ' + Y.presenceOf(it.u.id).statusText : '')))]
        : [h('span', { class: 'hash-big' }, it.c.kind === 'public' ? '#' : Y.isPrivateChannel(it.c) ? icon('lock') : icon('users')), h('div', null, h('div', null, Y.info(it.c).name), h('div', { class: 'sub' }, it.c.unread ? `${it.c.unread} unread` : (Y.info(it.c).archived ? 'Archived' : (Y.isPrivateChannel(it.c) ? 'Private channel' : it.c.kind === 'group' ? (it.c.groupName ? 'Group chat' : 'Group message') : 'Channel'))))];
      return h('button', { class: 's-item' + (i === sel ? ' sel' : ''), role: 'option', 'aria-selected': String(i === sel), onclick: () => { m.close(); it.go(); }, onmousemove: () => { if (sel !== i) { sel = i; compute(); } } }, content);
    }
    function draw(people, chans) {
      const out = [];
      if (people.length) out.push(h('div', { class: 's-group' }, 'People'), people.map((it, i) => row(it, i)));
      if (chans.length) out.push(h('div', { class: 's-group' }, 'Channels & groups'), chans.map((it, i) => row(it, i + people.length)));
      if (!out.length) out.push(h('div', { class: 's-group' }, 'Nothing found'));
      UI.set(list, ...out.flat());
      const s = list.querySelector('.sel');
      if (s) s.scrollIntoView({ block: 'nearest' });
    }
    input.addEventListener('input', () => { sel = 0; compute(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); compute(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); compute(); }
      else if (e.key === 'Enter') { e.preventDefault(); const it = items[sel]; if (it) { m.close(); it.go(); } }
    });
    const m = UI.modal({ cls: 'switcher', bare: true, label: 'Jump to',
      body: [h('div', { class: 's-input' }, icon('search'), input), list,
        h('div', { class: 's-foot' }, h('span', null, '↑ ↓ to move'), h('span', null, 'Enter to open'), h('span', null, 'Esc to close'))] });
    compute();
  }
  Chat.quickSwitcher = quickSwitcher;

  /** Admins: a public channel (everyone) or a private one (only the people invited; encrypted). */
  function newChannelDialog(preset = {}) {
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const name = h('input', { class: 'input', id: 'nc-name', maxlength: 40, autofocus: true, placeholder: 'e.g. it-help', value: preset.name || '' });
    const desc = h('input', { class: 'input', id: 'nc-desc', maxlength: 250, placeholder: 'What’s it for? (optional)', value: preset.description || '' });
    const preview = h('div', { class: 'hint' });
    name.addEventListener('input', () => { const n = Y.normalizeChannelName(name.value); preview.textContent = n ? `Will be created as #${n}` : 'Lowercase letters, numbers and dashes.'; });
    name.dispatchEvent(new Event('input'));
    let priv = !!preset.private;
    const count = h('div', { class: 'hint' });
    const ok = h('button', { class: 'btn btn-primary', type: 'submit' });
    const update = () => {
      ok.textContent = priv ? (pp.picked.size ? `Create private channel (${pp.picked.size + 1} people)` : 'Create private channel') : 'Create channel';
      count.textContent = pp.picked.size ? `${pp.picked.size + 1} people including you (up to ${Y.MAX_GROUP}).` : `Pick up to ${Y.MAX_GROUP - 1} people.`;
    };
    const pp = peoplePicker({ multi: true, max: Y.MAX_GROUP - 1, onChange: update });
    pp.el[0].removeAttribute('autofocus');
    const invite = h('div', { class: 'field' + (priv ? '' : ' hidden') }, h('span', { class: 'label' }, 'Invite people'), count, pp.el);
    const note = h('p', { class: 'muted', style: { fontSize: '14px' } });
    const seg = h('div', { class: 'vis-seg', role: 'radiogroup', 'aria-label': 'Who can see it' });
    const drawSeg = () => {
      UI.set(seg, [['public', 'hash', 'Public', 'Everyone in the workspace'], ['private', 'lock', 'Private', 'Only people you invite']].map(([v, ic, t, sub]) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(priv === (v === 'private')), onclick: () => { priv = v === 'private'; drawSeg(); } },
          icon(ic), h('span', null, h('b', null, t), h('span', { class: 'sub' }, sub)))));
      invite.classList.toggle('hidden', !priv);
      note.textContent = priv
        ? 'Private channels are end-to-end encrypted and keep their history. Only the people invited can see the channel or read it, not even other admins. You can add or remove people later in Details.'
        : 'Public channels can be read by everyone in the workspace. Their messages are stored unencrypted on the shared drive.';
      update();
    };
    drawSeg();
    const form = h('form', { onsubmit: e => { e.preventDefault(); UI.busy(ok, null, async () => {
      const ch = priv
        ? await Y.createPrivateChannel({ name: name.value, description: desc.value, userIds: Array.from(pp.picked), replaces: preset.replaces })
        : await Y.createChannel({ name: name.value, description: desc.value });
      if (preset.replaces) { try { await A.setChannelOverride(preset.replaces, { archived: true }); } catch (ex) { UI.toast('The new channel was made, but the old one couldn’t be archived: ' + ex.message, 'error'); } }
      m.close(); Chat.open(ch.id);
      if (preset.replaces) UI.toast(`#${Y.info(ch).name} is now private. The old public channel was archived.`, 'ok');
    }, err); } },
      err,
      preset.replaces ? null : h('div', { class: 'field' }, h('span', { class: 'label' }, 'Who can see it'), seg),
      h('div', { class: 'field' }, h('label', { for: 'nc-name' }, 'Name'), name, preview),
      h('div', { class: 'field' }, h('label', { for: 'nc-desc' }, 'Description'), desc),
      invite, note);
    const m = UI.modal({ title: preset.replaces ? `Make #${preset.name} private` : 'Create a channel', cls: 'mid', body: form, foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok] });
    ok.addEventListener('click', () => form.requestSubmit());
  }

  /** Public channels can't be locked after the fact (their messages are plain files on the share), so
   *  "Make private" creates an encrypted private channel with the same name for the people chosen and archives the old one. */
  async function makePrivateDialog(ch) {
    const info = Y.info(ch);
    const go = await UI.confirm({ title: `Make #${info.name} private?`, ok: 'Choose people',
      text: `This creates a new private, encrypted #${info.name} for the people you choose, and archives the current public channel. Messages already posted stay in the archived channel (admins can still open it from Admin settings → Channels), because they were stored unencrypted on the shared drive.` });
    if (go) newChannelDialog({ private: true, name: info.name, description: info.description, replaces: ch.id });
  }

  function peoplePicker({ multi, max, onChange, exclude = [] }) {
    const picked = new Set();
    const q = h('input', { class: 'input', placeholder: 'Find people', 'aria-label': 'Find people', autofocus: true });
    const list = h('div', { class: 'people-list' });
    function draw() {
      const s = q.value.trim().toLowerCase();
      UI.set(list, ...A.activeUsers().filter(u => u.id !== meId() && !exclude.includes(u.id) && (!s || u.name.toLowerCase().includes(s))).map(u => {
        const p = Y.presenceOf(u.id);
        const cb = h('input', { type: multi ? 'checkbox' : 'radio', name: 'pp', checked: picked.has(u.id), 'aria-label': u.name });
        cb.addEventListener('change', () => {
          if (!multi) picked.clear();
          if (cb.checked) { if (picked.size >= max) { cb.checked = false; UI.toast(`Up to ${max} people.`); return; } picked.add(u.id); } else picked.delete(u.id);
          onChange(picked);
          if (!multi) draw();
        });
        return h('label', { class: 'person' }, cb, UI.avatar(u, 32), h('div', null, h('div', { class: 'nm' }, u.name),
          h('div', { class: 'sub row', style: { gap: '6px' } }, UI.dot(p.state), (A.teamOf(u.id) ? A.teamName(A.teamOf(u.id)) + ' · ' : '') + UI.stateLabel(p.state) + (p.statusText ? ' · ' + p.statusText : ''))));
      }));
      if (!list.children.length) list.appendChild(h('div', { class: 'muted', style: { padding: '10px' } }, 'No one found.'));
    }
    q.addEventListener('input', draw);
    draw();
    return {
      el: [q, list], picked,
      add(ids) {
        let skipped = 0;
        for (const id of ids) {
          if (id === meId() || exclude.includes(id) || picked.has(id) || !A.users.get(id) || A.isRemoved(id)) continue;
          if (picked.size >= max) { skipped++; continue; }
          picked.add(id);
        }
        if (skipped) UI.toast(`Up to ${max} people. ${skipped} weren’t added.`);
        onChange(picked); draw();
      },
    };
  }

  function newMessageDialog() {
    const ok = h('button', { class: 'btn btn-primary', disabled: true }, 'Start conversation');
    const hint = h('div', { class: 'muted', style: { fontSize: '13px' } }, `Pick one person, or up to ${Y.MAX_GROUP - 1} for a group message.`);
    const pp = peoplePicker({ multi: true, max: Y.MAX_GROUP - 1, onChange: set => {
      ok.disabled = !set.size;
      ok.textContent = set.size > 1 ? `Start group (${set.size + 1} people)` : 'Start conversation';
    } });
    ok.addEventListener('click', () => UI.busy(ok, null, async () => { const ch = await Y.openConversation(Array.from(pp.picked)); m.close(); Chat.open(ch.id); }));
    const m = UI.modal({ title: 'New direct message', cls: 'mid', body: [hint, pp.el,
      h('div', { class: 'note note-ok', style: { marginTop: '6px' } }, icon('lock'), h('div', null, 'End-to-end encrypted. Messages and files delete after 7 days.'))],
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok] });
  }

  function newGroupDialog() {
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const name = h('input', { class: 'input', id: 'ng-name', maxlength: 60, placeholder: 'e.g. Warehouse team' });
    const ok = h('button', { class: 'btn btn-primary', disabled: true }, 'Create group');
    const count = h('div', { class: 'hint' }, `Pick up to ${Y.MAX_GROUP - 1} people.`);
    let picked = new Set();
    const update = () => {
      ok.disabled = !picked.size || Y.normalizeGroupName(name.value).length < 2;
      count.textContent = picked.size ? `${picked.size + 1} people including you (up to ${Y.MAX_GROUP}).` : `Pick up to ${Y.MAX_GROUP - 1} people.`;
    };
    const pp = peoplePicker({ multi: true, max: Y.MAX_GROUP - 1, onChange: set => { picked = set; update(); } });
    name.addEventListener('input', update);
    ok.addEventListener('click', () => UI.busy(ok, null, async () => {
      const ch = await Y.createGroup({ name: name.value, userIds: Array.from(pp.picked) });
      m.close(); Chat.open(ch.id);
    }, err));
    const m = UI.modal({ title: 'Create a group chat', cls: 'mid', body: [err,
      h('div', { class: 'field' }, h('label', { for: 'ng-name' }, 'Group name'), name),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Members'), count), pp.el,
      h('div', { class: 'note note-ok', style: { marginTop: '6px' } }, icon('lock'), h('div', null, 'End-to-end encrypted, including the group name. Only members can read it. Messages and files delete after 7 days.'))],
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok] });
    name.focus();
  }

  function membersDialog(ch) {
    const ids = Y.members(ch);
    const users = ids.map(id => A.users.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    UI.modal({ title: `Members of ${chName(ch)} (${users.length})`, body: h('div', { class: 'people-list' }, users.map(u => {
      const p = Y.presenceOf(u.id);
      return h('div', { class: 'person', onclick: () => { UI.closeAll(); Chat.openUser(u.id); } }, UI.avatar(u, 32),
        h('div', null, h('div', { class: 'nm' }, u.name + (u.id === meId() ? ' (you)' : '')), h('div', { class: 'sub row', style: { gap: '6px' } }, UI.dot(p.state), UI.stateLabel(p.state) + (p.statusText ? ' · ' + p.statusText : ''))),
        A.roleLabel(u.id) ? h('span', { class: 'pill grey', style: { marginLeft: 'auto' } }, A.roleLabel(u.id)) : null);
    })) });
  }

  function profileCard(userId, anchor) {
    const u = A.users.get(userId);
    if (!u) return;
    const p = Y.presenceOf(userId);
    UI.popover(anchor, [
      h('div', { class: 'menu-head' }, UI.avatar(u, 48), h('div', null, h('div', { class: 'nm' }, u.name),
        h('div', { class: 'muted row', style: { gap: '6px', fontSize: '13px' } }, UI.dot(p.state), UI.stateLabel(p.state)),
        p.statusText ? h('div', { style: { fontSize: '13px' } }, p.statusText) : null)),
      userId !== meId() ? h('button', { class: 'menu-item', onclick: () => { UI.closePopover(); Chat.openUser(userId); } }, icon('message'), 'Send a direct message') : null,
    ], { label: u.name + ' profile' });
  }

  async function securityCode(otherId) {
    const other = A.users.get(otherId);
    const fps = [A.me.signFp + A.me.ecdhFp, other.kid + other.ecdhFp].sort().join('|');
    const hex = (await C.sha256Hex(U.utf8(fps))).slice(0, 24);
    return hex.match(/.{4}/g).join(' ');
  }

  function channelInfoDialog(ch) {
    const info = Y.info(ch);
    const muted = Y.isMuted(ch.id);
    const body = [];
    const muteBtn = h('button', { class: 'btn', onclick: () => { Y.setMuted(ch.id, !muted); m.close(); renderHeader(); } }, icon(muted ? 'bell' : 'bellOff'), muted ? 'Unmute notifications' : 'Mute notifications');
    if (ch.kind === 'public') {
      body.push(h('dl', { class: 'kv' },
        h('dt', null, 'Name'), h('dd', null, '#' + info.name),
        h('dt', null, 'Description'), h('dd', null, info.description || '—'),
        h('dt', null, 'Created by'), h('dd', null, A.name(ch.meta.createdBy) + ' · ' + new Date(ch.meta.ts).toLocaleDateString()),
        h('dt', null, 'Members'), h('dd', null, 'Everyone in the workspace'),
        h('dt', null, 'Privacy'), h('dd', null, 'Public. Stored unencrypted on the shared drive.')));
      const actions = [muteBtn];
      if (A.isAdmin()) {
        actions.push(
          h('button', { class: 'btn', onclick: async () => {
            const v = await UI.prompt({ title: 'Rename channel', label: 'New name', value: info.name, maxlength: 40, onOk: async val => {
              const n = Y.normalizeChannelName(val);
              if (n.length < 2) throw new Error('Too short.');
              if (Array.from(Y.chans.values()).some(c => c !== ch && c.kind === 'public' && Y.info(c).name === n)) throw new Error(`#${n} already exists.`);
              await A.setChannelOverride(ch.id, { name: n });
            } });
            if (v != null) { m.close(); UI.toast('Channel renamed', 'ok'); }
          } }, icon('edit'), 'Rename'),
          h('button', { class: 'btn', onclick: async () => {
            const v = await UI.prompt({ title: 'Edit description', label: 'Description', value: info.description, maxlength: 250, onOk: val => A.setChannelOverride(ch.id, { description: val.trim() }) });
            if (v != null) m.close();
          } }, icon('edit'), 'Edit description'),
          ch.id !== 'general' ? h('button', { class: 'btn', onclick: async () => {
            if (!info.archived && !(await UI.confirm({ title: `Archive #${info.name}?`, text: 'It disappears from the sidebar and nobody can post. History stays, and you can unarchive it later from Admin settings.', ok: 'Archive' }))) return;
            try { await A.setChannelOverride(ch.id, { archived: !info.archived }); m.close(); if (!info.archived) Chat.open('general'); } catch (e) { UI.toast(e.message, 'error'); }
          } }, icon('archive'), info.archived ? 'Unarchive' : 'Archive') : null,
          h('button', { class: 'btn', onclick: () => exportChannel(ch) }, icon('download'), 'Export history'),
          ch.id !== 'general' && !info.archived ? h('button', { class: 'btn', onclick: () => { m.close(); makePrivateDialog(ch); } }, icon('lock'), 'Make private') : null);
      }
      body.push(h('div', { class: 'row', style: { flexWrap: 'wrap' } }, actions));
    } else {
      const others = Y.members(ch).filter(id => id !== meId());
      const pc = Y.isPrivateChannel(ch);
      if (ch.kind === 'group') body.push(h('dl', { class: 'kv' },
        ch.groupName ? [h('dt', null, pc ? 'Channel' : 'Group name'), h('dd', null, (pc ? '#' : '') + ch.groupName)] : null,
        pc && ch.groupDesc ? [h('dt', null, 'Description'), h('dd', null, ch.groupDesc)] : null,
        pc ? [h('dt', null, 'Privacy'), h('dd', null, 'Private: only invited people can see it. End-to-end encrypted. History is kept.')] : null,
        h('dt', null, 'Created by'), h('dd', null, A.name(ch.meta.createdBy) + ' · ' + new Date(ch.meta.ts).toLocaleDateString()),
        h('dt', null, 'Members'), h('dd', null, `${Y.members(ch).length} of ${Y.MAX_GROUP}`)));
      if (Y.canManageGroup(ch)) body.push(h('div', { class: 'row', style: { flexWrap: 'wrap', marginBottom: '14px' } },
        h('button', { class: 'btn', onclick: async () => {
          const v = await UI.prompt({ title: 'Rename group', label: 'Group name', value: ch.groupName || '', maxlength: 60, onOk: val => Y.updateGroup(ch, { name: val }) });
          if (v != null) { m.close(); UI.toast('Group renamed', 'ok'); }
        } }, icon('edit'), ch.groupName ? 'Rename' : 'Give it a name'),
        h('button', { class: 'btn', disabled: Y.members(ch).length >= Y.MAX_GROUP, title: Y.members(ch).length >= Y.MAX_GROUP ? `Groups can have up to ${Y.MAX_GROUP} people` : null,
          onclick: () => { m.close(); addMembersDialog(ch); } }, icon('plus'), 'Add people')));
      body.push(h('div', { class: 'note note-ok', style: { marginTop: 0, marginBottom: '14px' } }, icon('lock'),
        h('div', null, h('b', null, 'End-to-end encrypted. '), 'Messages and files are encrypted on this PC before they reach the shared drive. Only the people here can read them, not even the admin. ' + (Y.isPrivateChannel(ch) ? 'History is kept, like any channel.' : 'Everything is deleted 7 days after it was sent.'))));
      const creator = Y.isGroupCreator(ch);
      const admins = Y.groupAdmins(ch);
      const canRemove = Y.canManageGroup(ch) && Y.members(ch).length > 2;
      const roleOf = id => id === ch.meta.createdBy ? 'Group creator' : admins.includes(id) ? 'Group admin' : '';
      const act = (fn, done) => async e => {
        e.stopPropagation();
        try { await fn(); m.close(); if (done) UI.toast(done, 'ok'); channelInfoDialog(ch); } catch (ex) { UI.toast(ex.message, 'error'); }
      };
      body.push(h('div', { class: 'people-list' }, Y.members(ch).map(id => A.users.get(id)).filter(Boolean).map(u => {
        const role = roleOf(u.id);
        const isAdm = admins.includes(u.id);
        // the creator can remove anyone; group admins can remove regular members
        const removable = canRemove && u.id !== meId() && u.id !== ch.meta.createdBy && (creator || !isAdm);
        return h('div', { class: 'person' }, UI.avatar(u, 32),
          h('div', null, h('div', { class: 'nm' }, u.name + (u.id === meId() ? ' (you)' : '')), h('div', { class: 'sub' }, UI.stateLabel(Y.presenceOf(u.id).state))),
          h('span', { class: 'row', style: { marginLeft: 'auto', gap: '6px' } },
            role ? h('span', { class: 'pill' + (u.id === ch.meta.createdBy ? '' : ' grey') }, role) : null,
            creator && u.id !== meId() ? h('button', { class: 'btn btn-sm', 'aria-label': `${isAdm ? 'Remove group admin rights from' : 'Make'} ${u.name}${isAdm ? '' : ' a group admin'}`,
              onclick: act(() => Y.updateGroup(ch, { admins: isAdm ? admins.filter(x => x !== u.id) : admins.concat(u.id) }), isAdm ? `${u.name} is no longer a group admin` : `${u.name} is now a group admin`) },
              icon('shield'), isAdm ? 'Remove admin' : 'Make admin') : null,
            removable ? h('button', { class: 'btn btn-sm', 'aria-label': `Remove ${u.name} from the group`, onclick: async e => {
              e.stopPropagation();
              if (!(await UI.confirm({ title: `Remove ${u.name}?`, text: `${u.name} won’t see new messages in ${chName(ch)}. The group gets a new security key, so they can’t read anything sent from now on. Messages they already received stay on their PC until they expire.`, ok: 'Remove', danger: true }))) return;
              await act(() => Y.updateGroup(ch, { removeIds: [u.id] }), `Removed ${u.name}`)(e);
            } }, 'Remove') : null));
      })));
      if (creator) body.push(h('div', { class: 'hint muted', style: { fontSize: '13px', marginBottom: '10px' } }, Y.isPrivateChannel(ch) ? 'Channel admins can rename the channel, invite people and remove regular members. Only you can choose channel admins.' : 'Group admins can rename the group, add people and remove regular members. Only you can choose group admins.'));
      if (ch.kind === 'dm' && A.users.get(others[0])) {
        const code = h('div', { class: 'fingerprint' }, '…');
        securityCode(others[0]).then(c => { code.textContent = c; });
        body.push(h('div', { class: 'field' }, h('span', { class: 'label' }, 'Security code'), code,
          h('div', { class: 'hint' }, `Compare this with ${A.name(others[0])}’s screen. If the codes match, nobody has swapped your security keys.`)));
      }
      const leaveBtn = ch.kind === 'group' && !Y.isGroupCreator(ch) ? h('button', { class: 'btn btn-danger', style: { marginLeft: 'auto' }, onclick: async () => {
        if (!(await UI.confirm({ title: `Leave ${chName(ch)}?`, text: 'It disappears from your sidebar and you won’t get new messages. Only the group’s creator or a group admin can add you back.', ok: 'Leave group', danger: true }))) return;
        try {
          await Y.leaveGroup(ch);
          UI.closeAll();
          Chat.open(Y.chans.has('general') ? 'general' : Array.from(Y.chans.keys())[0]);
          UI.toast(`You left ${chName(ch)}`, 'ok');
        } catch (e) { UI.toast(e.message, 'error'); }
      } }, icon('userX'), Y.isPrivateChannel(ch) ? 'Leave channel' : 'Leave group') : null;
      body.push(h('div', { class: 'row' }, muteBtn, leaveBtn));
    }
    const m = UI.modal({ title: ch.kind === 'public' ? '#' + info.name : info.name, cls: 'mid', body });
  }

  function addMembersDialog(ch) {
    const room = Y.MAX_GROUP - Y.members(ch).length;
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const ok = h('button', { class: 'btn btn-primary', disabled: true }, 'Add');
    const pp = peoplePicker({ multi: true, max: room, exclude: Y.members(ch), onChange: set => {
      ok.disabled = !set.size;
      ok.textContent = set.size ? `Add ${set.size} ${set.size === 1 ? 'person' : 'people'}` : 'Add';
    } });
    ok.addEventListener('click', () => UI.busy(ok, null, async () => {
      const n = pp.picked.size;
      await Y.updateGroup(ch, { addIds: Array.from(pp.picked) });
      m.close(); UI.toast(`Added ${n} ${n === 1 ? 'person' : 'people'}`, 'ok');
    }, err));
    const m = UI.modal({ title: `Add people to ${chName(ch)}`, cls: 'mid', body: [err,
      h('div', { class: 'muted', style: { fontSize: '13px' } }, `You can add up to ${room} more ${room === 1 ? 'person' : 'people'}.`), pp.el,
      h('div', { class: 'note note-info', style: { marginTop: '6px' } }, icon('lock'), h('div', null, Y.isPrivateChannel(ch) ? 'People you invite can read the channel’s history.' : 'People you add can read the messages still in this group (up to the last 7 days).'))],
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok] });
  }

  async function exportChannel(ch) {
    const fmt = await new Promise(resolve => {
      let r = null;
      const m = UI.modal({ title: `Export ${chName(ch)}`, body: h('p', null, 'Save the full history of this channel. Direct messages can’t be exported.'), onClose: () => resolve(r),
        foot: [h('button', { class: 'btn', onclick: () => { r = 'txt'; m.close(); } }, 'Text (.txt)'), h('button', { class: 'btn btn-primary', onclick: () => { r = 'html'; m.close(); } }, 'Web page (.html)')] });
    });
    if (!fmt) return;
    try {
      await saveAs(`${Y.info(ch).name}-${U.dayKey(Date.now())}.${fmt}`, async () => {
        UI.toast('Collecting messages…');
        const text = await Y.exportChannel(ch, fmt);
        return new Blob([text], { type: fmt === 'html' ? 'text/html' : 'text/plain' });
      });
    } catch (e) { UI.toast(e.message, 'error'); }
  }

  function searchDialog(channelId) {
    const input = h('input', { class: 'input', placeholder: 'Search messages', 'aria-label': 'Search text', autofocus: true });
    const person = h('select', { class: 'select', 'aria-label': 'From person' }, h('option', { value: '' }, 'From anyone'),
      A.activeUsers().map(u => h('option', { value: u.id }, u.name)));
    const where = h('select', { class: 'select', 'aria-label': 'In channel' }, h('option', { value: '' }, 'Everywhere'),
      Array.from(Y.chans.values()).sort((a, b) => chName(a).localeCompare(chName(b))).map(c => h('option', { value: c.id, selected: c.id === channelId }, chName(c))));
    const status = h('div', { class: 'muted', style: { fontSize: '13px', margin: '6px 0' }, role: 'status' }, 'Channels: last 90 days. Direct messages: last 7 days (searched on this PC only).');
    const results = h('div');
    let ctrl = null;
    const run = U.debounce(async () => {
      if (ctrl) ctrl.abort();
      const text = input.value.trim();
      if (!text && !person.value) { UI.set(results); return; }
      ctrl = new AbortController();
      const my = ctrl;
      status.textContent = 'Searching…';
      try {
        const res = await Y.search({ text, userId: person.value || null, channelId: where.value || null }, (d, n) => { if (!my.signal.aborted) status.textContent = `Searching… ${d} of ${n}`; }, my.signal);
        if (my.signal.aborted) return;
        status.textContent = res.length ? `${res.length === 200 ? '200+' : res.length} result${res.length === 1 ? '' : 's'}` : 'No messages found.';
        const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
        UI.set(results, ...res.map(r => {
          let html = U.escapeHtml(r.msg.text.replace(/\s+/g, ' ').slice(0, 300));
          tokens.forEach(t => { html = html.replace(new RegExp(U.escapeHtml(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), x => `<mark>${x}</mark>`); });
          return h('button', { class: 'result', onclick: () => { m.close(); Chat.open(r.ch.id, { scrollTo: r.msg.id, ts: r.msg.ts }); } },
            h('div', { class: 'where' }, `${chName(r.ch)} · ${A.name(r.msg.userId)} · ${U.formatDateTime(r.msg.ts)}`),
            h('div', { class: 'txt', html: html || '📎 ' + r.msg.attachments.map(a => U.escapeHtml(a.name)).join(', ') }));
        }));
      } catch (e) { status.textContent = 'Search failed: ' + e.message; }
    }, 300);
    [input, person, where].forEach(x => x.addEventListener(x === input ? 'input' : 'change', run));
    const m = UI.modal({ title: 'Search', cls: 'mid', body: [input, h('div', { class: 'search-filters' }, person, where), status, results], onClose: () => { if (ctrl) ctrl.abort(); } });
  }
  Chat.search = () => searchDialog(null);

  /* ---- profile menu & settings ---- */
  function profileMenu(anchor) {
    const me = A.users.get(meId());
    const p = Y.presenceOf(meId());
    const theme = SC.app.theme();
    const seg = (val, label, ic) => h('button', { 'aria-pressed': String(theme === val), onclick: () => { SC.app.setTheme(val); profileMenu(anchor); } }, icon(ic), label);
    const item = (ic, label, fn, cls) => h('button', { class: 'menu-item' + (cls ? ' ' + cls : ''), onclick: () => { UI.closePopover(); fn(); } }, icon(ic), label);
    const notif = SC.app.notificationState();
    UI.popover(anchor, [
      h('div', { class: 'menu-head' }, UI.avatar(me, 40), h('div', null, h('div', { class: 'nm' }, me.name),
        h('div', { class: 'muted row', style: { gap: '6px', fontSize: '13px' } }, UI.dot(p.state), p.statusText || UI.stateLabel(p.state)))),
      item('status', p.statusText ? 'Change status' : 'Set a status', statusDialog),
      item('edit', 'Edit profile', editProfileDialog),
      h('div', { class: 'menu-sep' }),
      h('div', { class: 'menu-label' }, 'Theme'),
      h('div', { class: 'seg' }, seg('system', 'System', 'monitor'), seg('light', 'Light', 'sun'), seg('dark', 'Dark', 'moon')),
      notif === 'granted' ? null : item('bell', notif === 'denied' ? 'Desktop notifications are blocked' : 'Turn on desktop notifications', () => SC.app.requestNotifications()),
      item('volume', SC.app.soundOn() ? 'Sound: on' : 'Sound: off', () => { SC.app.setSound(!SC.app.soundOn()); UI.toast(SC.app.soundOn() ? 'Sound on' : 'Sound off'); }),
      item('check', Y.receiptsOn() ? 'Read receipts: on' : 'Read receipts: off', () => {
        Y.setReceipts(!Y.receiptsOn());
        UI.toast(Y.receiptsOn() ? 'Read receipts on' : 'Read receipts off. Others won’t see when you’ve read their messages, and you won’t see theirs.');
      }),
      h('div', { class: 'menu-sep' }),
      item('key', 'Change password', changePasswordDialog),
      A.isOwner() ? item('key', 'Security question', recoveryDialog) : null,
      A.isAdmin() ? item('info', 'Admin guide: what you can do', adminGuide) : null,
      A.isAdmin() ? item('shield', 'Admin settings', adminDialog) : null,
      item('lock', 'Lock (sign out)', () => SC.app.lock()),
      h('div', { class: 'menu-foot' }, `Sankyo Chat ${SC.VERSION}` + (A.keepSignedIn() ? ' · kept signed in' : ` · locks after ${A.autoLockMinutes() || '—'} min idle`)),
    ], { placement: 'right-up', label: 'Profile and settings' });
  }

  function statusDialog() {
    UI.prompt({ title: 'Set a status', label: 'Status', value: Y.statusText(), maxlength: 80, hint: 'For example “In a meeting until 3” or “Working from home”. Leave empty to clear.',
      onOk: v => Y.setStatusText(v) }).then(v => { if (v != null) schedule('side'); });
  }

  function editProfileDialog() {
    const me = A.users.get(meId());
    const state = { animal: me.animal, color: A.avatarColor(me.color) };
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const name = h('input', { class: 'input', id: 'ep-name', value: me.name, maxlength: 32 });
    const pv = h('span');
    const draw = () => UI.set(pv, UI.avatar(state, 56));
    const animals = h('div', { class: 'animal-grid', role: 'radiogroup', 'aria-label': 'Avatar' }, A.ANIMALS.map(([e, n]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(e === state.animal), 'aria-label': n, title: n,
      onclick: ev => { state.animal = e; animals.querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', String(x === ev.currentTarget))); draw(); } }, e)));
    const colors = h('div', { class: 'color-row', role: 'radiogroup', 'aria-label': 'Background colour' }, A.COLORS.map((c, i) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(c === state.color), 'aria-label': 'Colour ' + (i + 1), style: { background: c },
      onclick: ev => { state.color = c; colors.querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', String(x === ev.currentTarget))); draw(); } })));
    draw();
    const ok = h('button', { class: 'btn btn-primary' }, 'Save');
    ok.addEventListener('click', () => UI.busy(ok, null, async () => { await A.updateProfile({ name: name.value, animal: state.animal, color: state.color }); m.close(); UI.toast('Profile updated', 'ok'); }, err));
    const m = UI.modal({ title: 'Edit profile', cls: 'mid', body: [err, h('div', { class: 'preview' }, pv, h('div', { class: 'name' }, 'Preview')),
      h('div', { class: 'field' }, h('label', { for: 'ep-name' }, 'Display name'), name),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Group'),
        h('div', { class: 'row', style: { gap: '10px' } },
          h('span', null, A.teamName(A.teamOf(meId())) || 'None yet'),
          A.teamRequest(meId()) ? h('span', { class: 'pill grey' }, `Waiting for an admin: ${A.teamName(A.teamRequest(meId()))}`) : null,
          A.isAdmin() ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { m.close(); chooseTeamDialog({}); } }, 'Change') : null),
        A.isAdmin() ? null : h('div', { class: 'hint' }, 'Your group is permanent. Only an admin can change it.')),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Avatar'), animals),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Background colour'), colors)],
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok] });
  }

  function changePasswordDialog() {
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const cur = h('input', { class: 'input', type: 'password', id: 'cp-cur', autocomplete: 'current-password', autofocus: true });
    const pw = h('input', { class: 'input', type: 'password', id: 'cp-pw', autocomplete: 'new-password' });
    const pw2 = h('input', { class: 'input', type: 'password', id: 'cp-pw2', autocomplete: 'new-password' });
    const ok = h('button', { class: 'btn btn-primary' }, 'Change password');
    ok.addEventListener('click', () => UI.busy(ok, 'Saving…', async () => {
      try { await A.changePassword(cur.value, pw.value, pw2.value); } catch (e) { if (e.code === 'BAD_PASSWORD') throw new Error('Your current password isn’t right.'); throw e; }
      m.close(); UI.toast('Password changed', 'ok');
    }, err));
    const m = UI.modal({ title: 'Change password', body: [err,
      h('div', { class: 'field' }, h('label', { for: 'cp-cur' }, 'Current password'), cur),
      h('div', { class: 'field' }, h('label', { for: 'cp-pw' }, 'New password'), pw, UI.strengthMeter(pw)),
      h('div', { class: 'field' }, h('label', { for: 'cp-pw2' }, 'Confirm new password'), pw2),
      h('p', { class: 'muted', style: { fontSize: '13px' } }, 'Changing your password keeps your security keys, so your direct messages stay readable.')],
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok] });
  }

  async function recoveryDialog() {
    const current = await A.recoveryQuestion(meId());
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const cur = h('input', { class: 'input', type: 'password', id: 'rq-cur', autocomplete: 'current-password', autofocus: true });
    const q = h('input', { class: 'input', id: 'rq-q', maxlength: 120, autocomplete: 'off', value: current || '' });
    const a = h('input', { class: 'input', type: 'password', id: 'rq-a', autocomplete: 'off' });
    const ok = h('button', { class: 'btn btn-primary' }, 'Save');
    ok.addEventListener('click', () => UI.busy(ok, 'Saving…', async () => {
      try { await A.setRecovery(cur.value, q.value, a.value); } catch (e) { if (e.code === 'BAD_PASSWORD') throw new Error('Your current password isn’t right.'); throw e; }
      m.close(); UI.toast('Security question saved', 'ok');
    }, err));
    const m = UI.modal({ title: 'Security question', body: [err,
      h('p', { class: 'muted', style: { fontSize: '13px' } }, current ? 'If you forget your password, answering this on the sign-in screen lets you choose a new one.' : 'No security question is set. Without one, a forgotten super admin password can’t be recovered.'),
      h('div', { class: 'field' }, h('label', { for: 'rq-cur' }, 'Current password'), cur),
      h('div', { class: 'field' }, h('label', { for: 'rq-q' }, 'Question'), q),
      h('div', { class: 'field' }, h('label', { for: 'rq-a' }, current ? 'New answer' : 'Answer'), a,
        h('div', { class: 'hint' }, `At least ${A.MIN_ANSWER} characters. Capitals and extra spaces don’t matter. Pick something staff couldn’t guess.`))],
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok] });
  }

  /* ---- feedback ---- */
  function feedbackDialog() {
    let type = 'Suggestion';
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const types = h('div', { class: 'type-btns', role: 'group', 'aria-label': 'Type' }, A.FEEDBACK_TYPES.map(t => h('button', { type: 'button', 'aria-pressed': String(t === type),
      onclick: ev => { type = t; types.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === ev.currentTarget))); } }, t)));
    const text = h('textarea', { class: 'textarea', id: 'fb-text', maxlength: '2000', autofocus: true, placeholder: 'What would make Sankyo Chat better? What went wrong?' });
    const count = h('div', { class: 'char-count' }, '0 / 2,000');
    text.addEventListener('input', () => { count.textContent = `${text.value.length.toLocaleString()} / 2,000`; });
    const anon = h('input', { type: 'checkbox' });
    const ok = h('button', { class: 'btn btn-primary' }, icon('send'), 'Send to super admin');
    ok.addEventListener('click', () => UI.busy(ok, 'Sending…', async () => {
      await A.sendFeedback({ type, text: text.value, anonymous: anon.checked });
      m.close(); UI.toast('Thanks! Your feedback was sent to the super admin.', 'ok');
    }, err));
    const m = UI.modal({ title: 'Send feedback', cls: 'mid', body: [err, types,
      h('div', { class: 'field' }, h('label', { for: 'fb-text' }, 'Message'), text), count,
      h('label', { class: 'check' }, anon, h('span', null, 'Send without my name',
        h('div', { class: 'hint muted' }, 'The app won’t show who sent it, and the super admin can’t reply. Windows still records which account created the file on the shared drive, so it isn’t fully anonymous.'))),
      h('div', { class: 'note note-info' }, icon('lock'), h('div', null, 'Encrypted so only the super admin can read it. Other admins can’t, and you won’t be able to read it back after sending.'))],
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok] });
  }

  function inboxDialog() {
    let selName = null;
    const listEl = h('div', { class: 'inbox-list', role: 'listbox', 'aria-label': 'Feedback' });
    const detail = h('div', { class: 'inbox-detail' });
    function items() { return Array.from(A.inbox.values()).sort((a, b) => b.ts - a.ts); }
    function draw() {
      const all = items();
      UI.set(listEl, ...(all.length ? all.map(it => {
        const unread = !A.inboxState.read.includes(it.name);
        const done = A.inboxState.done.includes(it.name);
        return h('button', { class: 'inbox-item' + (it.name === selName ? ' sel' : '') + (done ? ' done' : ''), role: 'option', 'aria-selected': String(it.name === selName), onclick: () => select(it.name) },
          h('div', { class: 'top' }, unread ? h('span', { class: 'unread-dot', 'aria-label': 'Unread' }) : null,
            h('span', { class: 'who' }, it.error ? 'Unreadable item' : it.userId ? A.name(it.userId) : 'Anonymous'),
            h('span', { class: 'pill' + (it.type === 'Problem' ? '' : ' grey') }, it.type), h('span', { class: 'when' }, U.relTime(it.ts))),
          h('div', { class: 'prev' }, it.text));
      }) : [h('div', { class: 'inbox-empty' }, 'No feedback yet.')]));
      const it = A.inbox.get(selName);
      if (!it) { UI.set(detail, h('div', { class: 'inbox-empty' }, all.length ? 'Select an item to read it.' : 'When people send feedback, it shows up here.')); return; }
      const done = A.inboxState.done.includes(it.name);
      UI.set(detail, 
        h('div', { class: 'row' }, it.userId ? UI.avatar(A.users.get(it.userId), 36) : h('span', { class: 'avatar', style: { width: '36px', height: '36px', background: 'var(--surface-2)', color: 'var(--muted)' } }, icon('users')),
          h('div', null, h('div', { style: { fontWeight: 700 } }, it.userId ? A.name(it.userId) : 'Anonymous'),
            h('div', { class: 'muted', style: { fontSize: '13px' } }, `${it.type} · ${new Date(it.ts).toLocaleString()}` + (it.userId && !it.verified ? ' · ⚠ sender not verified' : '')))),
        h('div', { class: 'body' }, it.error ? 'This item couldn’t be decrypted.' : it.text),
        h('div', { class: 'row', style: { flexWrap: 'wrap' } },
          it.userId && it.verified ? h('button', { class: 'btn btn-primary btn-sm', onclick: () => { m.close(); Chat.openUser(it.userId); } }, icon('reply'), 'Reply in DM') : null,
          h('button', { class: 'btn btn-sm', onclick: () => act(() => A.markFeedback(it.name, { done: !done })) }, icon('check'), done ? 'Mark as not done' : 'Mark as done'),
          h('button', { class: 'btn btn-sm', onclick: () => act(() => A.markFeedback(it.name, { read: false })) }, 'Mark unread'),
          h('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
            if (await UI.confirm({ title: 'Delete this feedback?', text: 'It will be removed from the shared drive for good.', ok: 'Delete', danger: true })) { await act(() => A.deleteFeedback(it.name)); selName = null; draw(); }
          } }, icon('trash'), 'Delete')));
    }
    async function act(fn) { try { await fn(); } catch (e) { UI.toast(e.message, 'error'); } draw(); schedule('side'); }
    async function select(name) {
      selName = name;
      draw();
      if (!A.inboxState.read.includes(name)) act(() => A.markFeedback(name, { read: true }));
    }
    const m = UI.modal({ title: 'Feedback inbox', cls: 'wide', body: h('div', { class: 'inbox' }, listEl, detail) });
    draw();
    A.loadInbox().then(changed => { if (changed) { draw(); schedule('side'); } }).catch(e => UI.toast(e.message, 'error'));
  }

  /* ---- announcements ----
   * Announcements have their own channel (sidebar → Announcements), with the reserved id ANN. New ones also
   * pop up on top of whatever is open; closing the pop-up counts as seen, and it stays in the channel. */
  function openAnnouncements() {
    if (el.ta && st.openId) st.drafts[st.openId] = el.ta.value;
    st.openId = ANN;
    Y.openId = null;
    U.ls.set('lastOpen.' + A.ws.id, ANN);
    st.editingId = null;
    st.firstRender = true;
    st.annFresh = new Set(Y.pendingAnnouncements().map(a => a.id));
    el.root.classList.remove('side-open');
    UI.closePopover();
    renderSidebar(); renderHeader(); renderKeyNotice(); buildComposer(); renderMessages(); renderPins();
  }

  function renderAnnouncements() {
    const box = el.msgs;
    if (!box) return;
    const admin = A.isAdmin();
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const keepTop = box.scrollTop;
    const openReach = new Set(Array.from(box.querySelectorAll('details[open]')).map(d => d.closest('[data-ann]')).filter(Boolean).map(r => r.dataset.ann));
    if (!st.annFresh) st.annFresh = new Set();
    Y.pendingAnnouncements().forEach(a => st.annFresh.add(a.id)); // keep "new" highlighted after it's marked seen
    const items = Y.announcementList().slice().reverse(); // oldest first, like a chat
    const frag = document.createDocumentFragment();
    frag.appendChild(h('div', { class: 'intro' }, h('h3', null, 'Announcements'),
      h('p', null, `Messages from the admins to everyone in ${A.ws.name}. Each one stays here for a year.`)));
    if (!items.length) frag.appendChild(h('div', { class: 'ann-empty' }, 'No announcements yet.'));
    let lastDay = '', divDone = false;
    for (const a of items) {
      const day = U.localDay(a.ts);
      if (day !== lastDay) { frag.appendChild(h('div', { class: 'day-div', role: 'separator' }, U.formatDayLabel(a.ts))); lastDay = day; }
      const fresh = st.annFresh.has(a.id);
      if (fresh && !divDone) { frag.appendChild(h('div', { class: 'new-div', role: 'separator' }, 'New')); divDone = true; }
      const u = A.users.get(a.userId);
      const role = A.roleLabel(a.userId);
      let reach = null;
      if (admin) {
        const r = Y.announcementReach(a);
        const missing = r.audience.filter(x => !r.seen.includes(x));
        reach = h('details', { class: 'ann-reach', open: openReach.has(a.id) },
          h('summary', null, `Seen by ${r.seen.length} of ${r.audience.length}`),
          h('div', { class: 'muted', style: { fontSize: '13px', marginTop: '4px' } }, missing.length ? 'Not seen yet: ' + missing.map(x => x.name).sort().join(', ') : 'Everyone has seen it.'));
      }
      frag.appendChild(h('div', { class: 'msg theirs ann-msg' + (fresh ? ' ann-new' : ''), 'data-ann': a.id },
        h('div', { class: 'msg-gutter' }, UI.avatar(u, 40)),
        h('div', { class: 'msg-main' },
          h('div', { class: 'msg-head' }, h('span', { class: 'msg-name' }, A.name(a.userId)),
            role ? h('span', { class: 'pill grey' }, role) : null,
            a.to ? h('span', { class: 'pill', title: a.to.filter(x => x !== a.userId).map(A.name).sort().join(', ') }, icon('lock'), `Private · ${a.to.filter(x => x !== a.userId).length} people`) : null,
            h('span', { class: 'msg-time', title: new Date(a.ts).toLocaleString() }, U.formatTime(a.ts))),
          h('div', { class: 'ann-card' },
            a.title ? h('div', { class: 'ann-title' }, a.title) : null,
            h('div', { class: 'msg-text ann-text', html: UI.formatText(a.text, []) }),
            reach)),
        admin ? h('div', { class: 'msg-tools', role: 'toolbar', 'aria-label': 'Announcement actions' },
          h('button', { class: 'icon-btn', 'data-action': 'ann-withdraw', 'aria-label': 'Withdraw announcement', title: 'Withdraw (removes it for everyone)' }, icon('trash'))) : null));
    }
    UI.set(box, frag);
    if (st.firstRender || atBottom) {
      const d = st.firstRender && box.querySelector('.new-div');
      if (d) d.scrollIntoView({ block: 'start' }); else box.scrollTop = box.scrollHeight;
      st.firstRender = false;
    } else box.scrollTop = keepTop;
    ackVisibleAnnouncements();
  }

  /** Viewing the channel counts as having seen everything in it. */
  function ackVisibleAnnouncements() {
    if (!isAnn() || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    for (const a of Y.pendingAnnouncements()) Y.ackAnnouncement(a.id);
  }

  async function onAnnClick(t) {
    const row = t.closest('[data-ann]');
    if (!row || t.dataset.action !== 'ann-withdraw' || !A.isAdmin()) return;
    if (!(await UI.confirm({ title: 'Withdraw this announcement?', text: 'It disappears for everyone, including people who haven’t seen it yet.', ok: 'Withdraw', danger: true }))) return;
    try { await Y.withdrawAnnouncement(row.dataset.ann); UI.toast('Announcement withdrawn', 'ok'); } catch (e) { UI.toast(e.message, 'error'); }
  }

  /** Pop up the oldest announcement I haven't seen yet, one at a time, over whatever is open.
   *  Closing it (Close, ×, Esc or clicking outside) marks it as seen; it stays in the Announcements channel. */
  function showPendingAnnouncement() {
    if (st.annOpen || !el.root) return;
    if (isAnn() && document.visibilityState === 'visible' && document.hasFocus()) { schedule('msgs'); return; }
    const pending = Y.pendingAnnouncements();
    const a = pending[0];
    if (!a) return;
    st.annOpen = true;
    let goView = false;
    const u = A.users.get(a.userId);
    const more = pending.length - 1;
    const m = UI.modal({ title: a.title || 'Announcement', cls: 'mid ann-pop', body: [
      h('div', { class: 'row', style: { gap: '10px', marginBottom: '12px' } }, UI.avatar(u, 32),
        h('div', null, h('div', { style: { fontWeight: '600' } }, A.name(a.userId)), h('div', { class: 'muted', style: { fontSize: '13px' } }, (A.roleLabel(a.userId) || 'Admin') + ' · ' + U.formatDateTime(a.ts) + (a.to ? ' · sent privately to you' + (a.to.length > 2 ? ` and ${a.to.length - 2} others` : '') : '')))),
      h('div', { class: 'msg-text ann-text', html: UI.formatText(a.text, []) }),
      h('p', { class: 'ann-later' }, icon('megaphone'), 'You can read this again any time in Announcements, at the top of the sidebar.' + (more ? ` ${more} more after this one.` : ''))],
    foot: [
      h('button', { class: 'btn', onclick: () => { goView = true; m.close(); } }, 'View all announcements'),
      h('button', { class: 'btn btn-primary', onclick: () => m.close() }, icon('x'), 'Close')],
    onClose: () => {
      if (!st.unmounting) Y.ackAnnouncement(a.id);
      st.annOpen = false;
      if (st.unmounting) return;
      if (goView) Chat.open(ANN); else setTimeout(showPendingAnnouncement, 300);
    } });
    SC.app.notify({ title: 'Announcement: ' + (a.title || A.name(a.userId)), body: a.text.slice(0, 140), tag: 'ann-' + a.id });
  }

  /** Admins and the super admin can create polls in any conversation they're in. */
  function pollDialog(ch) {
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const q = h('input', { class: 'input', id: 'pl-q', maxlength: 300, placeholder: 'Ask a question', autofocus: true });
    const opts = ['', ''];
    const box = h('div', { class: 'poll-edit' });
    const addBtn = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => {
      if (opts.length >= Y.MAX_POLL_OPTIONS) return;
      opts.push(''); draw();
      const inputs = box.querySelectorAll('input'); inputs[inputs.length - 1].focus();
    } }, icon('plus'), 'Add option');
    function draw() {
      UI.set(box, opts.map((v, i) => h('div', { class: 'poll-edit-row' },
        h('input', { class: 'input', value: v, maxlength: 100, placeholder: `Option ${i + 1}`, 'aria-label': `Option ${i + 1}`, oninput: e => { opts[i] = e.target.value; } }),
        opts.length > 2 ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove option ${i + 1}`, title: 'Remove', onclick: () => { opts.splice(i, 1); draw(); } }, icon('x')) : null)));
      addBtn.disabled = opts.length >= Y.MAX_POLL_OPTIONS;
    }
    draw();
    const multi = h('input', { type: 'checkbox' });
    const ok = h('button', { class: 'btn btn-primary' }, icon('poll'), 'Post poll');
    ok.addEventListener('click', () => UI.busy(ok, null, async () => {
      await Y.sendPoll(ch, { question: q.value, options: opts, multi: multi.checked });
      m.close();
      st.stick = true;
      schedule('msgs');
    }, err));
    const m = UI.modal({ title: `Create a poll in ${chName(ch)}`, cls: 'mid', body: [err,
      h('div', { class: 'field' }, h('label', { for: 'pl-q' }, 'Question'), q),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Options'), box, h('div', null, addBtn)),
      h('label', { class: 'check' }, multi, h('span', null, 'Let people choose more than one option')),
      h('p', { class: 'muted', style: { fontSize: '13px', marginTop: '10px' } }, 'Everyone in this conversation can vote and change their vote. Hover an option to see who picked it.')],
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok] });
  }

  /** Everyone, or privately to chosen people. "Add everyone in…" fills the list from a private channel or group,
   *  so an existing team can be the audience without keeping separate lists. */
  function newAnnouncementDialog() {
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const title = h('input', { class: 'input', id: 'an-title', maxlength: 120, placeholder: 'e.g. Office closed on Friday' });
    const text = h('textarea', { class: 'input', id: 'an-text', rows: 6, maxlength: String(Y.MAX_TEXT), placeholder: 'What do people need to know?' });
    let priv = false;
    const ok = h('button', { class: 'btn btn-primary' }, icon('megaphone'));
    const all = A.activeUsers().filter(u => u.id !== meId()).length;
    const count = h('div', { class: 'hint' });
    const update = () => {
      ok.lastChild && ok.lastChild.nodeType === 3 ? ok.lastChild.remove() : null;
      ok.appendChild(document.createTextNode(priv ? `Send to ${pp.picked.size} ${pp.picked.size === 1 ? 'person' : 'people'}` : 'Post to everyone'));
      ok.disabled = priv && !pp.picked.size;
      count.textContent = pp.picked.size ? `${pp.picked.size} chosen` : 'Nobody chosen yet.';
    };
    const pp = peoplePicker({ multi: true, max: all, onChange: update });
    pp.el[0].removeAttribute('autofocus');
    const teams = Array.from(Y.chans.values()).filter(c => c.kind === 'group' && c.groupName).sort((a, b) => chName(a).localeCompare(chName(b)));
    const fromTeam = h('select', { class: 'select', 'aria-label': 'Add everyone in a channel or group' },
      h('option', { value: '' }, 'Group name'),
      h('optgroup', { label: 'Groups' }, A.teamList().map(t => h('option', { value: 'team:' + t.id }, `${t.name} (${A.teamMembers(t.id).length})`))),
      teams.length ? h('optgroup', { label: 'Private channels and group chats' }, teams.map(c => h('option', { value: c.id }, `${chName(c)} (${Y.members(c).length})`))) : null);
    fromTeam.addEventListener('change', () => {
      const v = fromTeam.value;
      if (v.startsWith('team:')) pp.add(A.teamMembers(v.slice(5)).map(u => u.id));
      else { const c = Y.chans.get(v); if (c) pp.add(Y.members(c)); }
      fromTeam.value = '';
    });
    const people = h('div', { class: 'field hidden' }, h('span', { class: 'label' }, 'Send to'), h('div', { class: 'row', style: { gap: '8px', marginBottom: '6px' } }, fromTeam, count), pp.el);
    const hint = h('div', { class: 'hint' });
    const seg = h('div', { class: 'vis-seg', role: 'radiogroup', 'aria-label': 'Who gets it' });
    const drawSeg = () => {
      UI.set(seg, [['all', 'users', 'Everyone', 'All staff in the workspace'], ['private', 'lock', 'Chosen people', 'Only them, encrypted']].map(([v, ic, t, sub]) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(priv === (v === 'private')), onclick: () => { priv = v === 'private'; drawSeg(); } },
          icon(ic), h('span', null, h('b', null, t), h('span', { class: 'sub' }, sub)))));
      people.classList.toggle('hidden', !priv);
      hint.textContent = priv
        ? 'Only the people chosen get the pop-up and can read it; it’s encrypted for them. It stays in their Announcements for a year.'
        : 'Everyone sees it in a pop-up within a few seconds, and it stays in Announcements for a year. It isn’t encrypted: anyone with access to the shared drive can read it.';
      update();
    };
    drawSeg();
    ok.addEventListener('click', () => UI.busy(ok, null, async () => {
      const n = pp.picked.size;
      await Y.postAnnouncement({ title: title.value, text: text.value, to: priv ? Array.from(pp.picked) : undefined });
      m.close(); UI.toast(priv ? `Announcement sent to ${n} ${n === 1 ? 'person' : 'people'}` : 'Announcement posted', 'ok');
    }, err));
    const m = UI.modal({ title: 'New announcement', cls: 'mid', body: [err,
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Who gets it'), seg),
      people,
      h('div', { class: 'field' }, h('label', { for: 'an-title' }, 'Title (optional)'), title),
      h('div', { class: 'field' }, h('label', { for: 'an-text' }, 'Message'), text, hint)],
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok] });
    title.focus();
  }

  /* ---- my group ---- */
  /** Pick or type my group. Mandatory once for profiles made before groups existed (can't be dismissed). */
  function chooseTeamDialog({ mandatory }) {
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const tf = UI.teamInput('my-team', A.teamOf(meId()) || A.teamRequest(meId()) || '');
    let saved = false;
    const ok = h('button', { class: 'btn btn-primary' }, A.isAdmin() ? 'Save' : 'Send to an admin');
    ok.addEventListener('click', () => UI.busy(ok, null, async () => {
      await A.setMyTeam(tf.input.value);
      saved = true; m.close();
      UI.toast(A.isAdmin() ? `You’re in ${A.teamName(A.teamOf(meId()))}` : 'Thanks. An admin will check your group.', 'ok');
      schedule('banners');
    }, err));
    const m = UI.modal({ title: mandatory ? 'Which group are you in?' : 'Change my group', cls: mandatory ? 'mid must' : 'mid', body: [err,
      h('p', { class: 'muted', style: { fontSize: '14px', marginTop: 0 } }, mandatory
        ? 'Every profile now needs a group. Choose the one you work in.'
        : 'Pick the group you belong to.'),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Group'), tf.el),
      A.isAdmin() ? null : h('div', { class: 'note note-info' }, icon('shield'), h('div', null, h('b', null, 'Choose carefully: you can’t change it later. '), 'Only an admin can. An admin checks it first; until they accept it, messages meant only for that group won’t reach you.'))],
    foot: mandatory ? [ok] : [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok],
    onClose: () => { if (mandatory && !saved && A.needsTeam() && el.root && !st.unmounting) setTimeout(() => chooseTeamDialog({ mandatory: true }), 0); } });
  }

  /* ---- admin guide ---- */
  /** Everything an admin (and the super admin) can do, each with a way to try it. */
  function adminGuide() {
    U.ls.set(`adminGuideSeen.${A.ws.id}.${meId()}`, true);
    const owner = A.isOwner();
    const go = fn => () => { m.close(); fn(); };
    const openIn = (label, fn) => h('button', { class: 'btn btn-sm', onclick: go(fn) }, label);
    const where = t => h('span', { class: 'guide-where' }, t);
    const sections = [
      ['Announcements', 'megaphone', [
        ['Post to everyone', 'A pop-up for all staff, kept in Announcements for a year. You can see who has read it.', openIn('New announcement', newAnnouncementDialog)],
        ['Announce privately', 'Send it only to chosen people (encrypted for them). Use “Add everyone in…” to send to a whole private channel or group at once.', openIn('New announcement', newAnnouncementDialog)],
        ['Withdraw an announcement', 'It disappears for everyone.', where('Announcements → hover it → 🗑')],
      ]],
      ['Channels', 'hash', [
        ['Create a public channel', 'Everyone can read and post.', openIn('Create a channel', () => newChannelDialog())],
        ['Create a private channel', `Invite-only and encrypted, up to ${Y.MAX_GROUP} people. History is kept. Not even other admins can read it unless invited.`, openIn('Create a private channel', () => newChannelDialog({ private: true }))],
        ['Make a channel private', 'Creates a private copy for the people you choose and archives the public one.', where('Channel → ⓘ Details → Make private')],
        ['Invite or remove people in a private channel', 'The creator and channel admins manage members; the creator picks channel admins.', where('Private channel → ⓘ Details → Add people / Remove')],
        ['Rename, describe, archive, export', 'Archived channels stay readable from Admin settings → Channels.', where('Channel → ⓘ Details')],
      ]],
      ['In conversations', 'message', [
        ['Create a poll', 'Single or multiple choice, in any conversation you’re in. Everyone can vote and change their vote.', where('Chart button next to 📎 in the message box')],
        ['Pin messages', 'Shown in a bar at the top of the channel. Group creators and group admins can pin in their groups too.', where('Hover a message → 📌')],
        ['Hide a message in a channel', 'Everyone sees “Message hidden by the admin”.', where('Hover a message → eye icon')],
      ]],
      ['Groups', 'users', [
        ['Accept someone’s group', 'Everyone picks a group when they make their profile. It only counts once an admin accepts it, so a wrong pick never shows them another group’s messages.', openIn('Review groups', () => adminDialog('people'))],
        ['Move someone to another group', 'If they picked the wrong one, put them in the right group.', where('Admin settings → People → Change')],
        ['Announce to one group', 'New announcement → Chosen people → Group name.', openIn('New announcement', newAnnouncementDialog)],
      ]],
      ['People', 'users', [
        ['Reset a password', 'Gives them a temporary password. Their direct messages from before the reset can’t be opened any more.', openIn('Admin settings', adminDialog)],
        ['Remove someone', 'They can’t sign in any more and disappear from the sign-in list. Their channel messages stay.', openIn('Admin settings', adminDialog)],
        ['See what admins did', 'Every rename, archive, reset and removal, with who did it.', where('Admin settings → Activity')],
      ]],
    ];
    if (owner) sections.push(['Only you, the super admin', 'shield', [
      ['Appoint or remove admins', 'Admins can do everything above. They can’t manage other admins.', openIn('Admin settings', adminDialog)],
      ['Workspace settings', 'Workspace name and auto-lock time.', where('Admin settings → Settings')],
      ['Feedback inbox', 'Staff feedback, encrypted so only you can read it.', where('Sidebar → Feedback inbox')],
      ['Check the app files', 'Detects if anyone changed the app’s code on the shared drive.', where('Admin settings → App files')],
      ['Security question', 'Lets you recover your own password. Nobody else can reset yours.', openIn('Set it', recoveryDialog)],
    ]]);
    const m = UI.modal({ title: owner ? 'Super admin guide' : 'Admin guide', cls: 'mid guide', body: [
      h('p', { class: 'muted', style: { marginTop: 0 } }, 'What you can do as ' + (owner ? 'the super admin' : 'an admin') + '. Click a button to try it, or follow the hint.'),
      sections.map(([title, ic, rows]) => h('section', { class: 'guide-sec' },
        h('h3', null, icon(ic), title),
        rows.map(([t, d, action]) => h('div', { class: 'guide-row' }, h('div', null, h('div', { class: 'guide-t' }, t), h('div', { class: 'guide-d' }, d)), action)))),
      h('p', { class: 'muted', style: { fontSize: '13px' } }, 'Nobody, including admins, can read direct messages, group chats or private channels they aren’t in.')],
    foot: [h('button', { class: 'btn btn-primary', onclick: () => m.close() }, 'Got it')] });
  }
  Chat.adminGuide = adminGuide;

  /* ---- admin ---- */
  function adminDialog(start) {
    let tab = typeof start === 'string' ? start : 'people';
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const panel = h('div', { role: 'tabpanel' });
    const tabBtn = (id, label) => h('button', { role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = id; draw(); } }, label);
    const owner = A.isOwner();
    function draw() {
      UI.set(tabs, tabBtn('people', 'People'), tabBtn('channels', 'Channels'), tabBtn('activity', 'Activity'),
        owner ? tabBtn('settings', 'Settings') : null, owner ? tabBtn('files', 'App files') : null);
      UI.set(panel, ({ people, channels, activity, settings, files })[tab]());
    }
    function people() {
      // people waiting for their group first, then by name
      const users = Array.from(A.users.values()).sort((a, b) => (!!A.teamRequest(b.id) - !!A.teamRequest(a.id)) || a.name.localeCompare(b.name));
      const intro = h('p', { class: 'muted', style: { fontSize: '14px' } }, owner
        ? 'You are the super admin. Admins you appoint can create, rename and archive channels, hide messages, and reset passwords or remove regular staff. Only you can appoint admins, change workspace settings and read feedback.'
        : 'As an admin you can reset passwords and remove regular staff. Only the super admin can manage admins.');
      return h('div', null, intro, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'Person'), h('th', null, 'Group'), h('th', null, 'Status'), h('th', null, 'Joined'), h('th', null, ''))),
        h('tbody', null, users.map(u => {
          const removed = A.isRemoved(u.id);
          const p = Y.presenceOf(u.id);
          const role = A.roleLabel(u.id);
          const isAdm = A.isUserAdmin(u.id);
          const canManage = u.id !== meId() && !removed && u.id !== A.ws.adminId && (owner || !isAdm);
          return h('tr', null,
            h('td', null, h('span', { class: 'row' }, UI.avatar(u, 28), u.name, role ? h('span', { class: 'pill' + (u.id === A.ws.adminId ? '' : ' grey') }, role) : null)),
            h('td', { class: 'team-cell' }, removed ? '—' : [
              h('div', null, A.teamName(A.teamOf(u.id)) || h('span', { class: 'muted' }, 'None')),
              A.teamRequest(u.id) ? h('div', { class: 'team-req' }, 'Requested: ', h('b', null, A.teamName(A.teamRequest(u.id)))) : null,
              h('div', { class: 'row', style: { gap: '4px', marginTop: '4px' } },
                A.teamRequest(u.id) ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => setTeam(u, A.teamRequest(u.id)) }, icon('check'), 'Accept') : null,
                h('button', { class: 'btn btn-sm', onclick: () => changeTeam(u) }, 'Change'))]),
            h('td', null, removed ? h('span', { class: 'pill grey' }, 'Removed') : h('span', { class: 'row', style: { gap: '6px' } }, UI.dot(p.state), UI.stateLabel(p.state))),
            h('td', null, new Date(u.created).toLocaleDateString()),
            h('td', { class: 'act' }, canManage ? [
              owner ? h('button', { class: 'btn btn-sm', onclick: () => toggleAdmin(u) }, icon('shield'), isAdm ? 'Remove admin' : 'Make admin') : null, ' ',
              h('button', { class: 'btn btn-sm', onclick: () => resetPw(u) }, icon('key'), 'Reset password'), ' ',
              h('button', { class: 'btn btn-sm btn-danger', onclick: () => removeUser(u) }, icon('userX'), 'Remove')] : null));
        }))));
    }
    async function setTeam(u, team) {
      try { await A.assignTeam(u.id, team); UI.toast(`${u.name} is now in ${A.teamName(A.teamOf(u.id))}`, 'ok'); draw(); schedule('banners'); } catch (e) { UI.toast(e.message, 'error'); }
    }
    function changeTeam(u) {
      const err = h('div', { class: 'form-error hidden', role: 'alert' });
      const tf = UI.teamInput('ct-team', A.teamOf(u.id) || A.teamRequest(u.id));
      const ok = h('button', { class: 'btn btn-primary' }, 'Save');
      ok.addEventListener('click', () => UI.busy(ok, null, async () => { await A.assignTeam(u.id, tf.input.value); cm.close(); UI.toast(`${u.name} is now in ${A.teamName(A.teamOf(u.id))}`, 'ok'); draw(); schedule('banners'); }, err));
      const cm = UI.modal({ title: `${u.name}’s group`, body: [err,
        A.teamRequest(u.id) ? h('p', { class: 'muted', style: { fontSize: '14px' } }, `They asked for ${A.teamName(A.teamRequest(u.id))}.`) : null,
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Group'), tf.el),
        h('p', { class: 'muted', style: { fontSize: '13px' } }, 'Group-only announcements go to the people accepted in that group.')],
      foot: [h('button', { class: 'btn', onclick: () => cm.close() }, 'Cancel'), ok] });
    }
    async function toggleAdmin(u) {
      const isAdm = A.isUserAdmin(u.id);
      const ok = await UI.confirm(isAdm
        ? { title: `Remove ${u.name} as admin?`, text: `${u.name} goes back to being regular staff. Things they did while admin (channels, renames, removals) stay as they are.`, ok: 'Remove admin', danger: true }
        : { title: `Make ${u.name} an admin?`, text: `${u.name} will be able to create, rename and archive channels, hide messages, and reset passwords or remove regular staff. They can’t read direct messages or feedback, and can’t manage other admins.`, ok: 'Make admin' });
      if (!ok) return;
      try {
        if (isAdm) await A.revokeAdmin(u.id); else await A.appointAdmin(u.id);
        UI.toast(isAdm ? `${u.name} is no longer an admin` : `${u.name} is now an admin`, 'ok');
        draw(); schedule('side', 'msgs');
      } catch (e) { UI.toast(e.message, 'error'); }
    }
    function activity() {
      const describe = a => {
        const who = A.name(a.target);
        if (a.type === 'remove') return `removed ${who}`;
        if (a.type === 'reset') return `reset ${who}’s password`;
        if (a.type === 'team') return `put ${who} in ${A.teamName(a.team) || a.team}`;
        const ch = Y.chans.get(a.target);
        const label = ch ? '#' + (ch.meta && ch.meta.name) : 'a channel';
        const p = a.patch || {};
        if (typeof p.archived === 'boolean') return `${p.archived ? 'archived' : 'unarchived'} ${label}`;
        if (typeof p.name === 'string') return `renamed ${label} to #${p.name}`;
        return `edited the description of ${label}`;
      };
      const list = Array.from(A.adminLog.values()).sort((a, b) => b.ts - a.ts).slice(0, 200);
      if (!list.length) return h('p', { class: 'muted' }, 'No admin actions yet. Renames, archives, password resets and removals show up here.');
      return h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Who'), h('th', null, 'What'))),
        h('tbody', null, list.map(a => h('tr', null,
          h('td', { class: 'muted' }, U.formatDateTime(a.ts)),
          h('td', null, A.name(a.userId)),
          h('td', null, describe(a), a.valid ? null : [' ', h('span', { class: 'pill grey', title: 'Not allowed for this person, so every app ignores it' }, 'Ignored')])))));
    }
    async function resetPw(u) {
      const temp = U.rand(4, 'abcdefghjkmnpqrstuvwxyz') + '-' + U.rand(4, '23456789') + '-' + U.rand(4, 'abcdefghjkmnpqrstuvwxyz');
      const ok = await UI.confirm({ title: `Reset ${u.name}’s password?`, ok: 'Reset password', danger: true,
        text: `This creates new security keys protected by a temporary password. ${u.name} must choose a new password when they sign in. Their direct messages from before the reset (7 days at most) can’t be opened afterwards.` });
      if (!ok) return;
      try {
        await A.resetPassword(u.id, temp);
        UI.modal({ title: 'Temporary password', body: [h('p', null, `Give this temporary password to ${u.name} in person:`), h('div', { class: 'fingerprint', style: { fontSize: '20px', textAlign: 'center' } }, temp),
          h('p', { class: 'muted', style: { fontSize: '13px', marginTop: '12px' } }, 'It is shown only once. They’ll be asked to pick a new password right away.')] });
      } catch (e) { UI.toast(e.message, 'error'); }
    }
    async function removeUser(u) {
      if (!(await UI.confirm({ title: `Remove ${u.name}?`, text: `${u.name} won’t be able to sign in any more. Their messages stay in channels.`, ok: 'Remove', danger: true }))) return;
      try { await A.removeUser(u.id); draw(); schedule('side'); UI.toast(`${u.name} was removed`, 'ok'); } catch (e) { UI.toast(e.message, 'error'); }
    }
    function channels() {
      const list = Array.from(Y.chans.values()).filter(c => c.kind === 'public').sort((a, b) => Y.info(a).name.localeCompare(Y.info(b).name));
      return h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'Channel'), h('th', null, 'Description'), h('th', null, ''))),
        h('tbody', null, list.map(c => {
          const info = Y.info(c);
          return h('tr', null, h('td', null, '#' + info.name, info.archived ? [' ', h('span', { class: 'pill grey' }, 'Archived')] : null),
            h('td', { class: 'muted' }, info.description || '—'),
            h('td', { class: 'act' },
              h('button', { class: 'btn btn-sm', onclick: () => { m.close(); channelInfoDialog(c); } }, 'Manage'), ' ',
              c.id !== 'general' ? h('button', { class: 'btn btn-sm', onclick: async () => { try { await A.setChannelOverride(c.id, { archived: !info.archived }); draw(); } catch (e) { UI.toast(e.message, 'error'); } } }, info.archived ? 'Unarchive' : 'Archive') : null));
        })));
    }
    function settings() {
      const err = h('div', { class: 'form-error hidden', role: 'alert' });
      const name = h('input', { class: 'input', id: 'ad-name', value: A.ws.name, maxlength: 40 });
      const lock = h('select', { class: 'select', id: 'ad-lock' }, [0, 5, 10, 15, 30, 60, 120, 240].map(v => h('option', { value: String(v), selected: v === A.autoLockMinutes() }, v ? `${v} minutes` : 'Never')));
      const ok = h('button', { class: 'btn btn-primary' }, 'Save settings');
      ok.addEventListener('click', () => UI.busy(ok, null, async () => {
        const n = name.value.trim();
        if (!n) throw new Error('Workspace name can’t be empty.');
        await A.saveWorkspace({ name: n, autoLockMin: Number(lock.value) });
        UI.toast('Settings saved', 'ok');
      }, err));
      return h('div', null, err,
        h('div', { class: 'field' }, h('label', { for: 'ad-name' }, 'Workspace name'), name),
        h('div', { class: 'field' }, h('label', { for: 'ad-lock' }, 'Auto-lock when idle'), lock, h('div', { class: 'hint' }, 'Signs people out after this long without using the PC. Doesn’t apply where someone ticked “Keep me signed in”.')),
        ok, groupNames());
    }
    function groupNames() {
      const err = h('div', { class: 'form-error hidden', role: 'alert' });
      const inputs = A.teamList().map((t, i) => h('input', { class: 'input', id: 'ad-team' + i, value: t.name, maxlength: 40 }));
      const ok = h('button', { class: 'btn' }, 'Rename groups');
      ok.addEventListener('click', () => UI.busy(ok, null, async () => {
        await A.renameTeams(inputs.map(x => x.value));
        UI.toast('Groups renamed. Everyone stays in their group.', 'ok'); draw();
      }, err));
      return h('div', { class: 'group-names' }, h('h3', null, 'Groups'), err,
        h('p', { class: 'muted', style: { fontSize: '13px' } }, 'Everyone chooses one of these two groups. Renaming keeps everyone in their group.'),
        h('div', { class: 'row', style: { gap: '10px', alignItems: 'flex-end' } },
          inputs.map((x, i) => h('div', { class: 'field', style: { flex: 1, marginBottom: 0 } }, h('label', { for: 'ad-team' + i }, `Group ${i + 1}`), x)), ok));
    }
    function files() {
      const out = h('div');
      const saved = A.ws.appFingerprint;
      const btn = h('button', { class: 'btn' }, icon('shield'), 'Check app files');
      btn.addEventListener('click', () => UI.busy(btn, 'Reading files…', async () => {
        let dir;
        try { dir = await window.showDirectoryPicker({ id: 'sankyo-app', mode: 'read' }); } catch (e) { if (e.name === 'AbortError') return; throw e; }
        const fp = await SC.app.fingerprint(dir);
        const match = saved && saved.hash === fp.hash;
        UI.set(out, 
          h('dl', { class: 'kv' }, h('dt', null, 'Folder'), h('dd', null, dir.name), h('dt', null, 'Files checked'), h('dd', null, String(fp.count)),
            fp.missing.length ? [h('dt', null, 'Missing'), h('dd', null, fp.missing.join(', '))] : null,
            h('dt', null, 'Fingerprint'), h('dd', null, h('div', { class: 'fingerprint' }, fp.pretty))),
          saved ? h('div', { class: 'note ' + (match ? 'note-ok' : 'note-warn') }, icon(match ? 'check' : 'alert'),
            h('div', null, match ? 'The app files match the trusted fingerprint.' : `The app files are different from the trusted fingerprint saved on ${new Date(saved.ts).toLocaleString()} (version ${saved.version}). If you didn’t update the app, someone may have changed it.`)) : null,
          h('div', { style: { marginTop: '12px' } }, h('button', { class: 'btn btn-primary', onclick: async () => {
            try { await A.saveWorkspace({ appFingerprint: { hash: fp.hash, ts: Date.now(), version: SC.VERSION } }); UI.toast('Saved as the trusted fingerprint', 'ok'); draw(); } catch (e) { UI.toast(e.message, 'error'); }
          } }, 'Save as trusted fingerprint')));
      }));
      return h('div', null,
        h('dl', { class: 'kv' }, h('dt', null, 'Running version'), h('dd', null, SC.VERSION),
          h('dt', null, 'Trusted fingerprint'), h('dd', null, saved ? h('div', { class: 'fingerprint' }, saved.hash.match(/.{4}/g).slice(0, 8).join(' ')) : 'Not saved yet'),
          saved ? [h('dt', null, 'Saved'), h('dd', null, `${new Date(saved.ts).toLocaleString()} · version ${saved.version}`)] : null),
        h('p', { class: 'muted', style: { fontSize: '14px' } }, 'Anyone who can change the app’s own files could change the code to capture passwords. Keep the app folder read-only for staff. To check it, pick the SankyoChat folder (the one with index.html) and compare its fingerprint.'),
        btn, out);
    }
    const m = UI.modal({ title: 'Admin settings', cls: 'wide', body: [tabs, panel] });
    draw();
  }

  SC.chat = Chat;
})(window);
