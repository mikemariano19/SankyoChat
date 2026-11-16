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
    if (d.has('msgs')) renderMessages();
  }
  const chName = ch => (ch.kind === 'public' ? '#' : '') + Y.info(ch).name;

  /* ================= mount ================= */

  Chat.mount = function () {
    el = {};
    el.side = h('aside', { class: 'sidebar', 'aria-label': 'Channels and direct messages' });
    el.banners = h('div', { class: 'banners' });
    el.head = h('header', { class: 'conv-head' });
    el.keyNotice = h('div');
    el.msgs = h('div', { class: 'msgs', role: 'region', 'aria-label': 'Messages', tabindex: '-1' });
    el.composerWrap = h('div', { class: 'composer-wrap' });
    el.conv = h('main', { class: 'conv' }, el.banners, el.head, el.keyNotice, el.msgs, el.composerWrap);
    el.root = h('div', { class: 'chat' }, el.side, el.conv);
    UI.mount(el.root);

    el.msgs.addEventListener('click', onMsgClick);
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
      Y.events.on('presence', () => { schedule('side', 'head'); if (seenSig(cur()) !== st.seenSig) schedule('msgs'); }),
      Y.events.on('connection', () => schedule('side', 'banners')),
      Y.events.on('incoming', onIncoming),
      Y.events.on('inbox', () => schedule('side')),
      Y.events.on('announcements', () => { schedule('side'); showPendingAnnouncement(); }),
      A.events.on('workspace', () => { schedule('side', 'head', 'composer', 'msgs'); if (A.isRemoved(meId())) SC.app.lock('Your account was removed by the admin.'); }),
      A.events.on('users', () => schedule('side', 'head', 'msgs')),
      A.events.on('wsTampered', () => { st.banners.wsTampered = true; schedule('banners'); }),
    ];
    const last = U.ls.get('lastOpen.' + A.ws.id);
    Chat.open(Y.chans.has(last) ? last : (Y.chans.has('general') ? 'general' : Array.from(Y.chans.keys())[0]));
    if (A.isOwner()) A.loadInbox().then(ch => { if (ch) schedule('side'); }).catch(() => {});
    showPendingAnnouncement();
    renderBanners();
  };

  Chat.unmount = function () {
    unsub.forEach(f => f());
    unsub = [];
    blobUrls.forEach(u => URL.revokeObjectURL(u));
    blobUrls.clear();
    thumbLoading.clear();
    UI.closeAll();
    el = {};
    st.openId = null;
  };
  Chat.mounted = () => !!el.root;
  Chat.showBanner = function (name, on) { st.banners[name] = on; schedule('banners'); };

  /** Open a channel or conversation. */
  Chat.open = async function (id, opts = {}) {
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
    renderSidebar(); renderHeader(); renderKeyNotice(); buildComposer(); renderMessages();
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
    const pub = all.filter(c => c.kind === 'public' && !Y.info(c).archived).sort((a, b) => Y.info(a).name.localeCompare(Y.info(b).name));
    const groups = all.filter(c => c.kind === 'group' && c.groupName).sort((a, b) => Y.info(a).name.localeCompare(Y.info(b).name));
    const dms = all.filter(c => c.kind === 'dm' || (c.kind === 'group' && !c.groupName)).sort((a, b) => Y.info(a).name.localeCompare(Y.info(b).name));
    const me = A.users.get(meId());
    const myP = Y.presenceOf(meId());

    const item = ch => {
      const info = Y.info(ch);
      const active = ch.id === st.openId;
      const muted = Y.isMuted(ch.id);
      let lead;
      if (ch.kind === 'public') lead = h('span', { class: 'hash', 'aria-hidden': 'true' }, '#');
      else if (ch.kind === 'dm') lead = UI.dot(Y.presenceOf(Y.dmOther(ch)).state);
      else lead = icon('users');
      const badge = ch.unread && !active
        ? h('span', { class: 'badge' + (ch.mentions ? ' red' : '') }, String(ch.mentions || ch.unread))
        : null;
      const label = (ch.kind === 'public' ? 'Channel ' : ch.groupName ? 'Group chat ' : 'Conversation with ') + info.name + (ch.unread ? `, ${ch.unread} unread` : '');
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
        h('div', { class: 'side-sec' }, h('span', null, 'Channels'), A.isAdmin() ? h('button', { class: 'icon-btn', 'data-act': 'new-channel', 'data-key': 'newch', 'aria-label': 'Create a channel', title: 'Create a channel' }, icon('plus')) : null),
        pub.map(item),
        h('div', { class: 'side-sec' }, h('span', null, 'Group chats'), h('button', { class: 'icon-btn', 'data-act': 'new-group', 'data-key': 'newgrp', 'aria-label': 'Create a group chat', title: 'Create a group chat' }, icon('plus'))),
        groups.length ? groups.map(item) : h('div', { class: 'side-empty' }, 'No group chats yet'),
        h('div', { class: 'side-sec' }, h('span', null, 'Direct messages'), h('button', { class: 'icon-btn', 'data-act': 'new-dm', 'data-key': 'newdm', 'aria-label': 'New direct message', title: 'New direct message' }, icon('plus'))),
        dms.length ? dms.map(item) : h('div', { class: 'side-empty' }, 'No conversations yet')),
      h('div', { class: 'side-tools' },
        (() => {
          const n = Y.pendingAnnouncements().length;
          return h('button', { class: 'side-item' + (n ? ' unread' : ''), 'data-act': 'announcements', 'data-key': 'ann' }, icon('megaphone'), h('span', { class: 'lbl' }, 'Announcements'),
            n ? h('span', { class: 'badge red' }, String(n)) : null);
        })(),
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
      case 'announcements': return announcementsDialog();
      case 'me-menu': return profileMenu(t);
    }
  }

  /* ================= header & banners ================= */

  function renderHeader() {
    const ch = cur();
    if (!ch) { UI.set(el.head); return; }
    const info = Y.info(ch);
    const menuBtn = h('button', { class: 'icon-btn menu-toggle', 'aria-label': 'Show sidebar', onclick: () => el.root.classList.toggle('side-open') }, icon('menu'));
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

  function renderBanners() {
    if (!el.banners) return;
    const list = [];
    if (!Y.connected) {
      const btn = h('button', { class: 'btn btn-sm btn-reconnect' }, 'Reconnect');
      btn.addEventListener('click', () => UI.busy(btn, null, async () => { await Y.reconnect(); UI.toast('Reconnected', 'ok'); }));
      list.push(h('div', { class: 'banner', role: 'alert' }, icon('alert'), h('span', null, h('b', null, 'Lost access to the shared folder. '), 'Messages you type will wait here until you reconnect.'), btn));
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
    return h('button', { class: 'att-file', 'data-action': 'open-att', 'data-i': String(i), title: 'Save ' + a.name },
      h('span', { class: 'ficon ' + fileKind(a) }, icon('file')),
      h('span', null, h('span', { class: 'fname' }, a.name), h('span', { class: 'fmeta' }, `${U.formatSize(a.size)} · Click to save`)));
  }

  function renderMsg(ch, m, grouped) {
    const u = A.users.get(m.userId);
    const mine = m.userId === meId();
    const shown = !m.deleted && !m.hidden && !m.decryptError && (m.verified || st.revealed.has(m.id));
    const mention = !mine && shown && (m.mentions.includes(meId()) || m.mentions.includes('channel'));
    const cls = 'msg' + (mine ? ' mine' : ' theirs') + (grouped ? ' grouped' : '') + (mention ? ' mention' : '') + (m.local ? ' ' + m.status : '');
    const time = U.formatTime(m.ts);
    const main = h('div', { class: 'msg-main' });
    if (!grouped) {
      main.appendChild(h('div', { class: 'msg-head' },
        h('button', { class: 'msg-name', 'data-action': 'profile' }, u ? u.name : 'Unknown user'),
        h('span', { class: 'msg-time', title: new Date(m.ts).toLocaleString() }, time)));
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
      } else if (m.text) {
        const t = h('div', { class: 'msg-text' + (UI.isBigEmoji(m.text.trim()) ? ' big-emoji' : ''), html: UI.formatText(m.text, m.mentions) });
        if (m.edited) t.appendChild(h('span', { class: 'edited', title: m.editTs ? 'Edited ' + new Date(m.editTs).toLocaleString() : null }, '(edited)'));
        if (m.local && m.status === 'sending') t.appendChild(h('span', { class: 'msg-status' }, icon('clock'), 'Sending…'));
        main.appendChild(t);
      } else if (m.local && m.status === 'sending') main.appendChild(h('span', { class: 'msg-status' }, icon('clock'), 'Sending…'));
      if (m.attachments && m.attachments.length) main.appendChild(h('div', { class: 'msg-atts' }, m.attachments.map((a, i) => renderAttachment(m, a, i))));
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
    const row = h('div', { class: cls, 'data-id': m.id },
      h('div', { class: 'msg-gutter' }, grouped ? h('span', { class: 'hover-time' }, time) : UI.avatar(u, 40)), main);
    if (!m.local && shown && st.editingId !== m.id && !Y.info(ch).archived) {
      const tools = h('div', { class: 'msg-tools', role: 'toolbar', 'aria-label': 'Message actions' },
        SC.emoji.quick.slice(0, 3).map(e => h('button', { class: 'icon-btn quick', 'data-action': 'react', 'data-emoji': e, 'aria-label': 'React with ' + e, title: 'React ' + e }, e)),
        h('button', { class: 'icon-btn', 'data-action': 'react-pick', 'aria-label': 'Add reaction', title: 'Add reaction' }, icon('smile')),
        h('button', { class: 'icon-btn', 'data-action': 'reply', 'aria-label': 'Reply', title: 'Reply' }, icon('reply')),
        mine ? h('button', { class: 'icon-btn', 'data-action': 'edit', 'aria-label': 'Edit', title: 'Edit' }, icon('edit')) : null,
        mine ? h('button', { class: 'icon-btn', 'data-action': 'delete', 'aria-label': 'Delete', title: 'Delete' }, icon('trash')) : null,
        A.isAdmin() && ch.kind === 'public' && !mine ? h('button', { class: 'icon-btn', 'data-action': 'hide', 'aria-label': 'Hide message (admin)', title: 'Hide message (admin)' }, icon('eyeOff')) : null);
      row.appendChild(tools);
    }
    return row;
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
        document.querySelectorAll(`[data-thumb="${fileId}"]`).forEach(n => { n.removeAttribute('data-thumb'); n.classList.remove('loading'); UI.set(n, thumbImg(url, a)); });
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
    img.addEventListener('error', () => { const b = img.closest('.att-img'); if (b) imageFailed(b, a); }, { once: true });
    return img;
  }
  function imageFailed(node, a) {
    node.removeAttribute('data-thumb');
    node.className = 'att-file';
    node.style.width = ''; node.style.aspectRatio = '';
    node.title = 'Save ' + a.name;
    UI.set(node, h('span', { class: 'ficon' }, icon('image')),
      h('span', null, h('span', { class: 'fname' }, a.name), h('span', { class: 'fmeta' }, `${U.formatSize(a.size)} · Can’t preview · Click to save`)));
  }

  async function onMsgClick(e) {
    const t = e.target.closest('[data-action]');
    if (!t) return;
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
      case 'open-att': return openAttachment(ch, m, m.attachments[Number(t.dataset.i)], t.classList.contains('att-file'));
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
        let url = blobUrls.get(a.fileId);
        if (!url) { url = URL.createObjectURL(await Y.readAttachment(ch, m, a)); blobUrls.set(a.fileId, url); }
        return lightbox(url, a, () => Y.readAttachment(ch, m, a));
      }
      await saveAs(a.name, () => Y.readAttachment(ch, m, a));
    } catch (e) { UI.toast(e.message, 'error'); }
  }

  function lightbox(url, a, getBlob) {
    const close = () => { lb.remove(); document.removeEventListener('keydown', esc, true); };
    const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const lb = h('div', { class: 'lightbox', role: 'dialog', 'aria-label': a.name, onclick: e => { if (e.target === lb) close(); } },
      h('img', { src: url, alt: a.name }),
      h('div', { class: 'bar' }, h('span', null, `${a.name} · ${U.formatSize(a.size)}`),
        h('button', { class: 'btn btn-sm', onclick: () => saveAs(a.name, getBlob).catch(e => UI.toast(e.message, 'error')) }, icon('download'), 'Save'),
        h('button', { class: 'btn btn-sm', onclick: close, autofocus: true }, icon('x'), 'Close')));
    document.body.appendChild(lb);
    document.addEventListener('keydown', esc, true);
    lb.querySelector('[autofocus]').focus();
  }

  /* ================= composer ================= */

  function buildComposer() {
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
    UI.set(el.chips, files.length ? h('div', { class: 'chips' }, files.map((f, i) => h('span', { class: 'chip' }, icon(f.type && f.type.startsWith('image/') ? 'image' : 'file'),
      h('b', null, f.name), h('span', { class: 'muted' }, U.formatSize(f.size)),
      h('button', { class: 'icon-btn', 'aria-label': 'Remove ' + f.name, onclick: () => { files.splice(i, 1); renderChips(); updateCount(); } }, icon('x'))))) : '');
  }
  function addFiles(list) {
    const ch = cur();
    if (!ch || Y.info(ch).archived) return;
    const files = st.files[ch.id] = st.files[ch.id] || [];
    for (const f of Array.from(list)) {
      if (f.size > Y.MAX_FILE) { UI.toast(`“${f.name}” is ${U.formatSize(f.size)}. The limit is 5 MB.`, 'error'); continue; }
      if (files.length >= Y.MAX_ATTACH) { UI.toast(`You can attach up to ${Y.MAX_ATTACH} files at a time.`, 'error'); break; }
      files.push(f);
    }
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
      const last = Y.sorted(ch).slice().reverse().find(m => m.userId === meId() && !m.deleted && !m.hidden && m.verified && !m.decryptError);
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
      const body = m.decryptError ? 'New message' : (m.text ? m.text.replace(/\s+/g, ' ').slice(0, 140) : '📎 Sent an attachment');
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
        : [h('span', { class: 'hash-big' }, it.c.kind === 'public' ? '#' : icon('users')), h('div', null, h('div', null, Y.info(it.c).name), h('div', { class: 'sub' }, it.c.unread ? `${it.c.unread} unread` : (Y.info(it.c).archived ? 'Archived' : (it.c.kind === 'group' ? (it.c.groupName ? 'Group chat' : 'Group message') : 'Channel'))))];
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

  function newChannelDialog() {
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const name = h('input', { class: 'input', id: 'nc-name', maxlength: 40, autofocus: true, placeholder: 'e.g. it-help' });
    const desc = h('input', { class: 'input', id: 'nc-desc', maxlength: 250, placeholder: 'What’s it for? (optional)' });
    const preview = h('div', { class: 'hint' });
    name.addEventListener('input', () => { const n = Y.normalizeChannelName(name.value); preview.textContent = n ? `Will be created as #${n}` : 'Lowercase letters, numbers and dashes.'; });
    name.dispatchEvent(new Event('input'));
    const ok = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create channel');
    const form = h('form', { onsubmit: e => { e.preventDefault(); UI.busy(ok, null, async () => { const ch = await Y.createChannel({ name: name.value, description: desc.value }); m.close(); Chat.open(ch.id); }, err); } },
      err,
      h('div', { class: 'field' }, h('label', { for: 'nc-name' }, 'Name'), name, preview),
      h('div', { class: 'field' }, h('label', { for: 'nc-desc' }, 'Description'), desc),
      h('p', { class: 'muted', style: { fontSize: '14px' } }, 'Channels are public: everyone in the workspace can read and post. For private talks, use a direct message.'));
    const m = UI.modal({ title: 'Create a channel', body: form, foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok] });
    ok.addEventListener('click', () => form.requestSubmit());
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
          h('div', { class: 'sub row', style: { gap: '6px' } }, UI.dot(p.state), UI.stateLabel(p.state) + (p.statusText ? ' · ' + p.statusText : ''))));
      }));
      if (!list.children.length) list.appendChild(h('div', { class: 'muted', style: { padding: '10px' } }, 'No one found.'));
    }
    q.addEventListener('input', draw);
    draw();
    return { el: [q, list], picked };
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
          h('button', { class: 'btn', onclick: () => exportChannel(ch) }, icon('download'), 'Export history'));
      }
      body.push(h('div', { class: 'row', style: { flexWrap: 'wrap' } }, actions));
    } else {
      const others = Y.members(ch).filter(id => id !== meId());
      if (ch.kind === 'group') body.push(h('dl', { class: 'kv' },
        ch.groupName ? [h('dt', null, 'Group name'), h('dd', null, ch.groupName)] : null,
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
        h('div', null, h('b', null, 'End-to-end encrypted. '), 'Messages and files are encrypted on this PC before they reach the shared drive. Only the people here can read them, not even the admin. Everything is deleted 7 days after it was sent.')));
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
      if (creator) body.push(h('div', { class: 'hint muted', style: { fontSize: '13px', marginBottom: '10px' } }, 'Group admins can rename the group, add people and remove regular members. Only you can choose group admins.'));
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
      } }, icon('userX'), 'Leave group') : null;
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
      h('div', { class: 'note note-info', style: { marginTop: '6px' } }, icon('lock'), h('div', null, 'People you add can read the messages still in this group (up to the last 7 days).'))],
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

  /* ---- announcements ---- */
  /** Pop up the oldest announcement I haven't acknowledged yet, one at a time. */
  function showPendingAnnouncement() {
    if (st.annOpen) return;
    const a = Y.pendingAnnouncements()[0];
    if (!a) return;
    st.annOpen = true;
    const u = A.users.get(a.userId);
    const ok = h('button', { class: 'btn btn-primary', onclick: () => { Y.ackAnnouncement(a.id); m.close(); } }, icon('check'), 'Got it');
    const m = UI.modal({ title: a.title || 'Announcement', cls: 'mid', body: [
      h('div', { class: 'row', style: { gap: '10px', marginBottom: '12px' } }, UI.avatar(u, 32),
        h('div', null, h('div', { style: { fontWeight: '600' } }, A.name(a.userId)), h('div', { class: 'muted', style: { fontSize: '13px' } }, (A.roleLabel(a.userId) || 'Admin') + ' · ' + U.formatDateTime(a.ts)))),
      h('div', { class: 'msg-text ann-text', html: UI.formatText(a.text, []) })],
    foot: [ok], onClose: () => { st.annOpen = false; setTimeout(showPendingAnnouncement, 300); } });
    SC.app.notify({ title: 'Announcement: ' + (a.title || A.name(a.userId)), body: a.text.slice(0, 140), tag: 'ann-' + a.id });
  }

  function announcementsDialog() {
    const admin = A.isAdmin();
    const listEl = h('div', { class: 'ann-list' });
    function draw() {
      const items = Y.announcementList();
      if (!items.length) { UI.set(listEl, h('div', { class: 'muted', style: { padding: '14px 2px' } }, 'No announcements in the last 30 days.')); return; }
      UI.set(listEl, items.map(a => {
        const reach = admin ? Y.announcementReach(a) : null;
        const missing = reach ? reach.audience.filter(u => !reach.seen.includes(u)) : [];
        const mineAck = a.userId === meId() || Y.hasAcked(a.id);
        return h('div', { class: 'ann-item' + (mineAck ? '' : ' new') },
          h('div', { class: 'ann-top' },
            h('div', null, h('div', { class: 'ann-title' }, a.title || 'Announcement'),
              h('div', { class: 'muted', style: { fontSize: '13px' } }, A.name(a.userId) + ' · ' + U.formatDateTime(a.ts))),
            mineAck ? null : h('button', { class: 'btn btn-sm btn-primary', onclick: () => { Y.ackAnnouncement(a.id); draw(); } }, icon('check'), 'Got it')),
          h('div', { class: 'msg-text ann-text', html: UI.formatText(a.text, []) }),
          reach ? h('details', { class: 'ann-reach' },
            h('summary', null, `Seen by ${reach.seen.length} of ${reach.audience.length}`),
            missing.length ? h('div', { class: 'muted', style: { fontSize: '13px', marginTop: '4px' } }, 'Not seen yet: ' + missing.map(u => u.name).sort().join(', '))
              : h('div', { class: 'muted', style: { fontSize: '13px', marginTop: '4px' } }, 'Everyone has seen it.'),
            h('button', { class: 'btn btn-sm', style: { marginTop: '8px' }, onclick: async () => {
              if (!(await UI.confirm({ title: 'Withdraw this announcement?', text: 'It disappears for everyone, including people who haven’t seen it yet.', ok: 'Withdraw', danger: true }))) return;
              try { await Y.withdrawAnnouncement(a.id); draw(); UI.toast('Announcement withdrawn', 'ok'); } catch (e) { UI.toast(e.message, 'error'); }
            } }, icon('trash'), 'Withdraw')) : null);
      }));
    }
    const off = [Y.events.on('announcements', draw), Y.events.on('presence', () => { if (admin) draw(); })];
    draw();
    const foot = [h('button', { class: 'btn', onclick: () => m.close() }, 'Close')];
    if (admin) foot.unshift(h('button', { class: 'btn btn-primary', onclick: newAnnouncementDialog }, icon('plus'), 'New announcement'));
    const m = UI.modal({ title: 'Announcements', cls: 'mid', body: [
      h('p', { class: 'muted', style: { fontSize: '14px', marginTop: 0 } }, admin
        ? 'Announcements pop up for everyone until they click “Got it”. You can see who has read each one.'
        : 'Messages from the admins to everyone. Shown for 30 days.'), listEl],
    foot, onClose: () => off.forEach(f => f()) });
  }

  function newAnnouncementDialog() {
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const title = h('input', { class: 'input', id: 'an-title', maxlength: 120, placeholder: 'e.g. Office closed on Friday' });
    const text = h('textarea', { class: 'input', id: 'an-text', rows: 6, maxlength: String(Y.MAX_TEXT), placeholder: 'What does everyone need to know?' });
    const ok = h('button', { class: 'btn btn-primary' }, icon('megaphone'), 'Post to everyone');
    ok.addEventListener('click', () => UI.busy(ok, null, async () => {
      await Y.postAnnouncement({ title: title.value, text: text.value });
      m.close(); UI.toast('Announcement posted', 'ok');
    }, err));
    const m = UI.modal({ title: 'New announcement', cls: 'mid', body: [err,
      h('div', { class: 'field' }, h('label', { for: 'an-title' }, 'Title (optional)'), title),
      h('div', { class: 'field' }, h('label', { for: 'an-text' }, 'Message'), text,
        h('div', { class: 'hint' }, 'Everyone sees it in a pop-up the next time their app checks (within 30 seconds). It isn’t encrypted: anyone with access to the shared drive can read it.'))],
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok] });
    title.focus();
  }

  /* ---- admin ---- */
  function adminDialog() {
    let tab = 'people';
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
      const users = Array.from(A.users.values()).sort((a, b) => a.name.localeCompare(b.name));
      const intro = h('p', { class: 'muted', style: { fontSize: '14px' } }, owner
        ? 'You are the super admin. Admins you appoint can create, rename and archive channels, hide messages, and reset passwords or remove regular staff. Only you can appoint admins, change workspace settings and read feedback.'
        : 'As an admin you can reset passwords and remove regular staff. Only the super admin can manage admins.');
      return h('div', null, intro, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'Person'), h('th', null, 'Status'), h('th', null, 'Joined'), h('th', null, ''))),
        h('tbody', null, users.map(u => {
          const removed = A.isRemoved(u.id);
          const p = Y.presenceOf(u.id);
          const role = A.roleLabel(u.id);
          const isAdm = A.isUserAdmin(u.id);
          const canManage = u.id !== meId() && !removed && u.id !== A.ws.adminId && (owner || !isAdm);
          return h('tr', null,
            h('td', null, h('span', { class: 'row' }, UI.avatar(u, 28), u.name, role ? h('span', { class: 'pill' + (u.id === A.ws.adminId ? '' : ' grey') }, role) : null)),
            h('td', null, removed ? h('span', { class: 'pill grey' }, 'Removed') : h('span', { class: 'row', style: { gap: '6px' } }, UI.dot(p.state), UI.stateLabel(p.state))),
            h('td', null, new Date(u.created).toLocaleDateString()),
            h('td', { class: 'act' }, canManage ? [
              owner ? h('button', { class: 'btn btn-sm', onclick: () => toggleAdmin(u) }, icon('shield'), isAdm ? 'Remove admin' : 'Make admin') : null, ' ',
              h('button', { class: 'btn btn-sm', onclick: () => resetPw(u) }, icon('key'), 'Reset password'), ' ',
              h('button', { class: 'btn btn-sm btn-danger', onclick: () => removeUser(u) }, icon('userX'), 'Remove')] : null));
        }))));
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
        ok);
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
