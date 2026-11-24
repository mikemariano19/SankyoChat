/* Sankyo Chat — main chat view: sidebar, conversation, composer and in-chat dialogs. */
(function (root) {
  'use strict';
  const SC = root.SC;
  const U = SC.util, A = SC.account, Y = SC.sync, UI = SC.ui, C = SC.crypto, S = SC.store, N = SC.notify, B = SC.board, BV = SC.boardView, K = SC.calendar, KV = SC.calendarView;
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

  /* ---- roles (1.12): what my role lets me do ---- */
  /** I can post or manage announcements (sees read counts and the announcement tools). */
  const canAnnounce = () => A.canAny('ann.post', 'ann.private', 'ann.withdraw');
  const article = w => (/^[aeiou]/i.test(w || '') ? 'an' : 'a');
  /** Admin settings tabs I may open. */
  const adminTabs = () => {
    if (A.isOwner()) return ['people', 'roles', 'channels', 'activity', 'settings', 'backup', 'files'];
    if (A.isAdmin()) return ['people', 'channels', 'activity'];
    return [A.can('grp.accept') ? 'people' : null, A.can('ch.manage') ? 'channels' : null, A.can('log.view') ? 'activity' : null].filter(Boolean);
  };
  /** Tell me when the super admin changes my role. */
  function noteRoleChange() {
    const now = A.roleLabel(meId());
    if (st.myRole === undefined || now === st.myRole) { st.myRole = now; return; }
    st.myRole = now;
    U.ls.del(`adminGuideSeen.${A.ws.id}.${meId()}`);
    const guide = now === 'Admin' || now === 'Super admin' ? 'Admin guide' : 'Role guide';
    UI.toast(now ? `You’re now ${article(now)} ${now}. See what you can do: ⚙ (bottom left) → ${guide}.` : 'Your role was removed. You’re regular staff now.', 'ok');
    schedule('side', 'head', 'composer', 'msgs', 'banners');
  }

  /** The Announcements channel isn't a real conversation; it has this reserved id. */
  const ANN = '@announcements';
  /* Announcements are split into feeds: the main one (everyone, and private ones to mixed people) and one per
   * group (private announcements sent to people in that group). Ids: ANN and ANN + ':' + groupId. */
  const isAnnKey = id => typeof id === 'string' && (id === ANN || id.startsWith(ANN + ':'));
  const isAnn = () => isAnnKey(st.openId);
  const annKey = f => (f ? ANN + ':' + f : ANN);
  const annFeed = () => (isAnn() && st.openId.length > ANN.length ? st.openId.slice(ANN.length + 1) : '');
  /** Feeds I can see: the main one, plus my own group's (the super admin sees every group's). */
  const annFeeds = () => [''].concat(A.teamList().map(t => t.id).filter(t => A.isOwner() || A.teamOf(meId()) === t));
  /** The feed an announcement shows in for me (falls back to the main one if I can't see that group's feed). */
  const feedOf = a => { const f = Y.annFeedOf(a); return f && annFeeds().includes(f) ? f : ''; };
  const shortTeam = f => (A.teamName(f) || f).replace(/\s+group$/i, '');
  const feedName = f => (f ? `Announcements (${shortTeam(f)})` : 'Announcements');
  const feedPending = f => Y.pendingAnnouncements().filter(a => feedOf(a) === f);
  /** PICKUP GROUP / INPUT GROUP member lists (sidebar → Groups) use '@team:<groupId>'. They aren't conversations. */
  const TEAM = '@team:';
  const isTeam = () => typeof st.openId === 'string' && st.openId.startsWith(TEAM);
  /** Each group's project board (js/board.js, js/board-ui.js) shows in the main pane as '@board:<groupId>'. */
  const BOARD = '@board:';
  const isBoard = () => typeof st.openId === 'string' && st.openId.startsWith(BOARD);
  const openBoardId = () => (isBoard() ? st.openId.slice(BOARD.length) : '');
  const openTeamId = () => (isTeam() ? st.openId.slice(TEAM.length) : '');
  const cur = () => Y.chans.get(st.openId);
  /** How many of these people are online right now. */
  const onlineCount = ids => ids.filter(id => Y.presenceOf(id).state === 'online').length;
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
    el.side.addEventListener('contextmenu', onSideContext);
    setupDrop();

    unsub = [
      Y.events.on('messages', ch => { if (ch.id === st.openId) schedule('msgs'); schedule('side'); }),
      Y.events.on('channels', () => schedule('side')),
      Y.events.on('group', ch => { if (ch.id === st.openId) schedule('head', 'composer'); }),
      Y.events.on('groupGone', ch => {
        UI.toast(`You were removed from ${Y.info(ch).name}.`);
        if (ch.id === st.openId) { UI.closeAll(); Chat.open(Y.chans.has('general') ? 'general' : Array.from(Y.chans.keys())[0]); }
      }),
      Y.events.on('presence', changed => { schedule('side', 'head'); if (seenSig(cur()) !== st.seenSig || (isAnn() && changed && canAnnounce()) || (isTeam() && changed)) schedule('msgs'); }),
      N.events.on('change', () => { schedule('side'); if (st.inbox) st.inbox.draw(); }),
      N.events.on('open', () => notificationsDialog()),
      Y.events.on('connection', () => schedule('side', 'banners')),
      B.events.on('change', () => { schedule('side'); if (isBoard()) { if (leaveHiddenBoard()) return; schedule('msgs', 'head'); } }),
      B.events.on('open', it => BV.notificationsDialog(it && it.type === 'completed' ? { tab: 'history', pid: it.pid } : {})),
      Y.events.on('incoming', onIncoming),
      Y.events.on('prefs', () => schedule('side', 'head', 'composer', 'msgs')),
      K.events.on('change', () => schedule('side')),
      Y.events.on('inbox', () => schedule('side')),
      Y.events.on('announcements', () => { schedule('side'); if (isAnn()) schedule('msgs'); showPendingAnnouncement(); }),
      A.events.on('workspace', () => { noteRoleChange(); leaveHiddenBoard(); schedule('side', 'head', 'composer', 'msgs', 'banners'); if (A.isRemoved(meId())) SC.app.lock('Your account was removed by the admin.'); else askTeamIfNeeded(); }),
      A.events.on('users', () => { schedule('side', 'head', 'msgs', 'banners'); askTeamIfNeeded(); }),
      A.events.on('wsTampered', () => { st.banners.wsTampered = true; schedule('banners'); }),
      SC.backup.onChange(() => schedule('banners')),
    ];
    const last = U.ls.get('lastOpen.' + A.ws.id);
    const teamOk = typeof last === 'string' && last.startsWith(TEAM) && A.teamList().some(t => TEAM + t.id === last);
    const annOk = isAnnKey(last) && annFeeds().includes(last.slice(ANN.length + 1));
    BV.init({ profile: id => profileDialog(id), openBoard: team => Chat.open(BOARD + team) });
    const boardOk = typeof last === 'string' && last.startsWith(BOARD) && B.canSee(last.slice(BOARD.length));
    Chat.open(Y.chans.has(last) || annOk || teamOk || boardOk ? last : (Y.chans.has('general') ? 'general' : Array.from(Y.chans.keys())[0]));
    if (A.isOwner()) A.loadInbox().then(ch => { if (ch) schedule('side'); }).catch(() => {});
    showPendingAnnouncement();
    renderBanners();
    if (!askTeamIfNeeded()) askSetupIfNeeded().then(shown => { if (!shown && el.root) showWhatsNew(); });
    st.myRole = A.roleLabel(meId());
    if (A.isAdmin() && !U.ls.get(`adminGuideSeen.${A.ws.id}.${meId()}`)) {
      setTimeout(() => { if (el.root) UI.toast('You’re an admin. See what you can do: ⚙ (bottom left) → Admin guide.'); }, 3000);
    } else if (A.hasCustomRole() && !U.ls.get(`adminGuideSeen.${A.ws.id}.${meId()}`)) {
      setTimeout(() => { if (el.root) UI.toast(`You’re ${article(st.myRole)} ${st.myRole}. See what you can do: ⚙ (bottom left) → Role guide.`); }, 3000);
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
    KV.close();
    st.unmounting = true; // closing an announcement pop-up here (sign-out) shouldn't count as reading it
    try { UI.closeAll(); } finally { st.unmounting = false; }
    el = {};
    st.openId = null;
    st.annFresh = null;
    st.inbox = null;
    st.teamAsk = false;
    st.setupAsk = false;
    BV.reset();
  };
  Chat.mounted = () => !!el.root;
  Chat.showBanner = function (name, on) { st.banners[name] = on; schedule('banners'); };

  /** Open a channel or conversation. */
  Chat.open = async function (id, opts = {}) {
    if (isAnnKey(id)) return openAnnouncements(id.length > ANN.length ? id.slice(ANN.length + 1) : '');
    if (typeof id === 'string' && id.startsWith(TEAM)) return openTeam(id.slice(TEAM.length));
    if (typeof id === 'string' && id.startsWith(BOARD)) return openBoard(id.slice(BOARD.length));
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
    // direct messages (and unnamed group messages): pinned first, archived ones in their own fold, deleted ones gone until a new message
    const byName = (a, b) => Y.info(a).name.localeCompare(Y.info(b).name);
    const dmAll = all.filter(c => (c.kind === 'dm' || (c.kind === 'group' && !c.groupName && !Y.isPrivateChannel(c))) && (!Y.isChatDeleted(c) || c.id === st.openId));
    const dms = dmAll.filter(c => !Y.isArchived(c.id)).sort((a, b) => (Y.isChatPinned(b.id) ? 1 : 0) - (Y.isChatPinned(a.id) ? 1 : 0) || byName(a, b));
    const archived = dmAll.filter(c => Y.isArchived(c.id)).sort(byName);
    const archUnread = archived.reduce((n, c) => n + (c.id === st.openId ? 0 : c.unread), 0);
    const me = A.users.get(meId());
    const myP = Y.presenceOf(meId());

    const item = (ch, dmList) => {
      const info = Y.info(ch);
      const active = ch.id === st.openId;
      const muted = Y.isMuted(ch.id);
      const blocked = ch.kind === 'dm' && Y.isBlocked(Y.dmOther(ch));
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
      }, lead, h('span', { class: 'lbl' }, info.name), blocked ? icon('block', 'side-flag') : null, dmList && Y.isChatPinned(ch.id) ? icon('pin', 'side-flag') : null, muted ? icon('bellOff') : null, badge);
    };
    // a direct message row also has a ⋯ menu: pin, mute, archive, delete, block
    const dmRow = ch => h('div', { class: 'side-row' }, item(ch, true),
      h('button', { class: 'icon-btn side-more', 'data-act': 'chat-menu', 'data-chat': ch.id, 'data-key': 'more:' + ch.id, 'aria-label': 'More options for ' + Y.info(ch).name, title: 'Pin, mute, archive, delete or block' }, icon('more')));
    const calCount = K.unreadCount(), calToday = K.todayCount();
    const inboxCount = A.isOwner() ? A.inboxUnread() : 0;
    const notifCount = N.unreadCount();
    const boardCount = B.unreadCount();
    const quiet = N.isQuiet();
    // Groups (PICKUP / INPUT): a member list each, not a conversation
    const teamRows = A.teamList().map(t => {
      const tid = TEAM + t.id;
      const active = st.openId === tid;
      const members = A.teamMembers(t.id);
      const waiting = A.teamPendingForMe().filter(u => A.teamRequest(u.id) === t.id).length;
      const mine = A.teamOf(meId()) === t.id;
      return h('button', { class: 'side-item team-item' + (active ? ' active' : ''), 'data-open': tid, 'data-key': 'ch:' + tid, 'aria-current': active ? 'page' : null,
        'aria-label': `${t.name}, ${members.length} ${members.length === 1 ? 'member' : 'members'}` + (mine ? ', your group' : '') + (waiting ? `, ${waiting} waiting for acceptance` : '') },
      icon('users'), h('span', { class: 'lbl' }, t.name), mine ? h('span', { class: 'you-tag' }, 'You') : null,
      waiting ? h('span', { class: 'wait-dot', title: `${waiting} waiting for acceptance` }) : null,
      h('span', { class: 'cnt' }, String(members.length)));
    });
    // Project boards: one per group (PICKUP / INPUT); the super admin sees every group's
    const boardRows = B.boards().map(t => {
      const bid = BOARD + t.id;
      const active = st.openId === bid;
      const open = B.openCount(t.id), mineN = B.mineCount(t.id);
      const mine = A.teamOf(meId()) === t.id;
      return h('button', { class: 'side-item team-item board-item' + (active ? ' active' : ''), 'data-open': bid, 'data-key': 'ch:' + bid, 'aria-current': active ? 'page' : null,
        'aria-label': `${t.name} project board, ${open} open ${open === 1 ? 'project' : 'projects'}` + (mineN ? `, ${mineN} assigned to you` : '') },
      icon('board'), h('span', { class: 'lbl' }, t.name), mine ? h('span', { class: 'you-tag' }, 'You') : null,
      mineN ? h('span', { class: 'wait-dot board-mine-dot', title: `${mineN} open ${mineN === 1 ? 'project' : 'projects'} assigned to you` }) : null,
      h('span', { class: 'cnt', title: `${open} open ${open === 1 ? 'project' : 'projects'}` }, String(open)));
    });
    UI.set(el.side,
      h('div', { class: 'side-head' },
        h('div', { class: 'side-title' },
          h('h1', null, A.ws.name),
          h('button', { class: 'icon-btn bell-btn' + (notifCount ? ' has' : ''), 'data-act': 'notifications', 'data-key': 'bell',
            'aria-label': 'Notifications' + (notifCount ? `, ${notifCount} unread` : '') + (quiet ? ', do not disturb is on' : ''), title: quiet ? 'Notifications (do not disturb is on)' : 'Notifications' },
          icon(quiet ? 'bellOff' : 'bell'), notifCount ? h('span', { class: 'badge red bell-badge' }, notifCount > 99 ? '99+' : String(notifCount)) : null),
          h('button', { class: 'icon-btn bell-btn board-bell' + (boardCount ? ' has' : ''), 'data-act': 'board-notifications', 'data-key': 'boardbell',
            'aria-label': 'Board notifications' + (boardCount ? `, ${boardCount} unread` : ''), title: 'Board notifications (projects)' },
          icon('boardBell'), boardCount ? h('span', { class: 'badge red bell-badge' }, boardCount > 99 ? '99+' : String(boardCount)) : null),
          h('button', { class: 'icon-btn bell-btn cal-btn' + (calCount ? ' has' : ''), 'data-act': 'calendar', 'data-key': 'cal',
            'aria-label': 'Calendar' + (calCount ? `, ${calCount} new ${calCount === 1 ? 'event' : 'events'}` : '') + (calToday ? `, ${calToday} today` : ''),
            title: 'Calendar' + (calToday ? ` · ${calToday} ${calToday === 1 ? 'event' : 'events'} today` : '') },
          icon('calendar'), calCount ? h('span', { class: 'badge red bell-badge' }, calCount > 99 ? '99+' : String(calCount)) : calToday ? h('span', { class: 'cal-today-dot', 'aria-hidden': 'true' }) : null)),
        h('div', { class: 'conn' }, UI.dot(Y.connected ? 'online' : 'offline'), Y.connected ? 'Shared drive connected' : 'Not connected to the shared drive')),
      h('button', { class: 'jump', 'data-act': 'jump', 'data-key': 'jump' }, icon('search'), 'Search or jump to…', h('kbd', null, 'Ctrl K')),
      h('nav', { class: 'side-scroll' },
        annFeeds().map(f => {
          const n = feedPending(f).length;
          const active = isAnn() && annFeed() === f;
          return h('button', { class: 'side-item ann-side' + (active ? ' active' : '') + (n && !active ? ' unread' : ''), 'data-open': annKey(f), 'data-key': 'ch:' + annKey(f),
            'aria-current': active ? 'page' : null, 'aria-label': feedName(f) + (n ? `, ${n} new` : '') },
          icon('megaphone'), h('span', { class: 'lbl' }, feedName(f)), n && !active ? h('span', { class: 'badge red' }, String(n)) : null);
        }),
        h('div', { class: 'side-sec' }, h('span', null, 'Groups')),
        teamRows,
        h('div', { class: 'side-sec' }, h('span', null, 'Project boards')),
        boardRows.length ? boardRows : h('div', { class: 'side-empty' }, 'Your board appears once an admin accepts your group'),
        h('div', { class: 'side-sec' }, h('span', null, 'Channels'), A.canAny('ch.create', 'ch.createPrivate') ? h('button', { class: 'icon-btn', 'data-act': 'new-channel', 'data-key': 'newch', 'aria-label': 'Create a channel', title: 'Create a channel' }, icon('plus')) : null),
        pub.map(c => item(c)),
        h('div', { class: 'side-sec' }, h('span', null, 'Group chats'), h('span', { class: 'row', style: { gap: '0' } },
          h('button', { class: 'icon-btn', 'data-act': 'browse-groups', 'data-key': 'browse', 'aria-label': 'Browse groups you can ask to join', title: 'Browse groups' }, icon('search')),
          h('button', { class: 'icon-btn', 'data-act': 'new-group', 'data-key': 'newgrp', 'aria-label': 'Create a group chat', title: 'Create a group chat' }, icon('plus')))),
        groups.length ? groups.map(c => item(c)) : h('div', { class: 'side-empty' }, 'No group chats yet'),
        h('div', { class: 'side-sec' }, h('span', null, 'Direct messages'), h('button', { class: 'icon-btn', 'data-act': 'new-dm', 'data-key': 'newdm', 'aria-label': 'New direct message', title: 'New direct message' }, icon('plus'))),
        dms.length ? dms.map(dmRow) : h('div', { class: 'side-empty' }, archived.length ? 'No other conversations' : 'No conversations yet'),
        archived.length ? h('button', { class: 'side-item side-arch' + (archUnread ? ' unread' : ''), 'data-act': 'toggle-archived', 'data-key': 'arch', 'aria-expanded': String(!!st.showArchived),
          'aria-label': `Archived conversations, ${archived.length}` + (archUnread ? `, ${archUnread} unread` : '') },
        icon('archive'), h('span', { class: 'lbl' }, `Archived (${archived.length})`), archUnread ? h('span', { class: 'badge' }, String(archUnread)) : null,
        h('span', { class: 'side-caret' + (st.showArchived ? ' open' : '') }, '›')) : null,
        archived.length && st.showArchived ? archived.map(dmRow) : null),
      h('div', { class: 'side-tools' },
        A.isOwner() ? null : h('button', { class: 'side-item', 'data-act': 'feedback', 'data-key': 'fb' }, icon('megaphone'), h('span', { class: 'lbl' }, 'Send feedback')),
        A.isOwner() ? h('button', { class: 'side-item' + (inboxCount ? ' unread' : ''), 'data-act': 'inbox', 'data-key': 'inbox' }, icon('inbox'), h('span', { class: 'lbl' }, 'Feedback inbox'), inboxCount ? h('span', { class: 'badge red' }, String(inboxCount)) : null) : null),
      h('div', { class: 'side-me' },
        UI.avatar(me, 34),
        h('div', { class: 'who' }, h('div', { class: 'nm' }, me ? me.name : ''),
          h('div', { class: 'st' }, UI.dot(myP.state), myP.statusText || UI.stateLabel(myP.state))),
        h('button', { class: 'icon-btn', 'data-act': 'me-menu', 'data-key': 'me', 'aria-label': 'Profile and settings', title: 'Profile and settings' }, icon('settings'))));
    if (focusKey) { const f = el.side.querySelector(`[data-key="${CSS.escape(focusKey)}"]`); if (f) f.focus(); }
    const n = Y.totalUnread() + notifCount + boardCount + calCount;
    document.title = (n ? `(${n}) ` : '') + A.ws.name;
  }

  function onSideClick(e) {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.open) return Chat.open(t.dataset.open);
    switch (t.dataset.act) {
      case 'jump': return quickSwitcher();
      case 'new-channel': return A.canAny('ch.create', 'ch.createPrivate') ? newChannelDialog() : null;
      case 'new-dm': return newMessageDialog();
      case 'new-group': return newGroupDialog();
      case 'browse-groups': return browseGroupsDialog();
      case 'notifications': return notificationsDialog();
      case 'board-notifications': return BV.notificationsDialog();
      case 'calendar': return KV.open();
      case 'chat-menu': { const ch = Y.chans.get(t.dataset.chat); return ch ? chatMenu(ch, t) : null; }
      case 'toggle-archived': st.showArchived = !st.showArchived; return renderSidebar();
      case 'feedback': return feedbackDialog();
      case 'inbox': return A.isOwner() ? inboxDialog() : null;
      case 'me-menu': return profileMenu(t);
    }
  }

  /** Right-click a direct message in the sidebar: the same menu as its ⋯ button. */
  function onSideContext(e) {
    const t = e.target.closest('[data-open]');
    const ch = t && Y.chans.get(t.dataset.open);
    if (!ch || !t.closest('.side-row')) return;
    e.preventDefault();
    chatMenu(ch, t);
  }

  /* ---- direct message options (1.15): pin, mute, archive, delete, block ----
   * Kept in my own encrypted settings file (js/sync.js), so they follow me to other PCs and only I know. */
  const keep = (p, msg) => Promise.resolve(p).then(() => { if (msg) UI.toast(msg, 'ok'); }).catch(e => UI.toast(e.message, 'error'));
  function chatMenu(ch, anchor) {
    const name = Y.info(ch).name;
    const other = ch.kind === 'dm' ? Y.dmOther(ch) : null;
    const pinned = Y.isChatPinned(ch.id), muted = Y.isMuted(ch.id), arch = Y.isArchived(ch.id), blocked = !!other && Y.isBlocked(other);
    const row = (ic, label, fn, danger) => h('button', { class: 'menu-item' + (danger ? ' danger' : ''), onclick: () => { UI.closePopover(); fn(); } }, icon(ic), label);
    UI.popover(anchor, [
      h('div', { class: 'menu-label' }, name),
      row('pin', pinned ? 'Unpin' : 'Pin to the top', () => keep(Y.setChatPinned(ch.id, !pinned), pinned ? 'Unpinned' : 'Pinned to the top')),
      row(muted ? 'bell' : 'bellOff', muted ? 'Unmute' : 'Mute notifications', () => keep(Y.setMuted(ch.id, !muted), muted ? 'Notifications on' : 'Muted. Unread counts still show.')),
      row('archive', arch ? 'Unarchive' : 'Archive', () => keep(Y.setArchived(ch.id, !arch), arch ? 'Moved back to Direct messages' : 'Archived. Find it under Archived at the bottom of Direct messages.')),
      h('div', { class: 'menu-sep', role: 'separator' }),
      row('trash', 'Delete chat', () => deleteChat(ch), true),
      other && A.users.get(other) ? row('block', blocked ? `Unblock ${A.name(other)}` : `Block ${A.name(other)}`, () => blockUser(other, !blocked), !blocked) : null,
    ], { label: 'Options for ' + name, placement: 'right-up' });
  }
  async function deleteChat(ch) {
    const other = ch.kind === 'dm' ? A.name(Y.dmOther(ch)) : 'The others';
    if (!(await UI.confirm({ title: `Delete your chat with ${Y.info(ch).name}?`, ok: 'Delete chat', danger: true,
      text: `The messages disappear for you only, on every PC you use. ${other} still ${ch.kind === 'dm' ? 'has' : 'have'} them until they’re deleted from the shared drive after 7 days. If a new message comes, the chat comes back with just that.` }))) return;
    await keep(Y.deleteChat(ch), 'Chat deleted');
    if (st.openId === ch.id) { UI.closeAll(); Chat.open(Y.chans.has('general') ? 'general' : Array.from(Y.chans.keys()).find(id => id !== ch.id)); }
  }
  async function blockUser(uid, on) {
    const nm = A.name(uid);
    if (on && !(await UI.confirm({ title: `Block ${nm}?`, ok: 'Block', danger: true,
      text: `${nm} isn’t told. Their direct messages to you are hidden and don’t notify you, and you can’t message them until you unblock. Messages they send while blocked stay hidden even after you unblock. You still see what they write in channels and groups.` }))) return;
    await keep(Y.setBlocked(uid, on), on ? `${nm} is blocked` : `${nm} is unblocked`);
  }

  /* ================= header & banners ================= */

  function renderHeader() {
    const menuBtn = h('button', { class: 'icon-btn menu-toggle', 'aria-label': 'Show sidebar', onclick: () => el.root.classList.toggle('side-open') }, icon('menu'));
    if (isAnn()) {
      const f = annFeed();
      UI.set(el.head, menuBtn, h('span', { class: 'avatar ann-avatar', style: { width: '34px', height: '34px' } }, icon('megaphone')),
        h('div', { class: 'two' }, h('div', { class: 'title' }, h('span', { class: 'nm' }, feedName(f)), f ? h('span', { class: 'pill' }, icon('lock'), 'Private') : null),
          h('div', { class: 'sub' }, f ? `From the admins · only for ${A.teamName(f)}, encrypted` : 'From the admins · to everyone, or privately to chosen people')),
        h('div', { class: 'tools' }, h('button', { class: 'icon-btn', 'aria-label': 'Who can read announcements', title: 'Who can read this?', onclick: () => privacyDialog('announcements') }, icon('shield'))));
      return;
    }
    if (isBoard()) {
      UI.set(el.head, menuBtn, h('span', { class: 'avatar ann-avatar', style: { width: '34px', height: '34px' } }, icon('board')),
        h('div', { class: 'two' }, h('div', { class: 'title' }, h('span', { class: 'nm' }, A.teamName(openBoardId()) || 'Project board'), h('span', { class: 'pill grey' }, 'Project board')),
          h('div', { class: 'sub' }, BV.headerSub(openBoardId()))),
        h('div', { class: 'tools' }, h('button', { class: 'icon-btn', 'aria-label': 'Board notifications', title: 'Board notifications', onclick: () => BV.notificationsDialog() }, icon('boardBell'))));
      return;
    }
    if (isTeam()) {
      const t = A.teamList().find(x => x.id === openTeamId());
      const ids = A.teamMembers(openTeamId()).map(u => u.id);
      UI.set(el.head, menuBtn, h('span', { class: 'avatar ann-avatar', style: { width: '34px', height: '34px' } }, icon('users')),
        h('div', { class: 'two' }, h('div', { class: 'title' }, h('span', { class: 'nm' }, t ? t.name : 'Group')),
          h('div', { class: 'sub' }, `${ids.length} ${ids.length === 1 ? 'member' : 'members'} · `, h('span', { class: 'online-n' }, `${onlineCount(ids)} online`))));
      return;
    }
    const ch = cur();
    if (!ch) { UI.set(el.head); return; }
    const info = Y.info(ch);
    const searchBtn = h('button', { class: 'icon-btn', 'aria-label': 'Search messages', title: 'Search', onclick: () => searchDialog(ch.id) }, icon('search'));
    const infoBtn = h('button', { class: 'icon-btn', 'aria-label': 'Details', title: 'Details', onclick: () => channelInfoDialog(ch) }, icon('info'));
    if (ch.kind === 'public') {
      const count = Y.members(ch).length;
      const on = onlineCount(Y.members(ch));
      UI.set(el.head, menuBtn,
        h('div', { class: 'title' }, h('span', { class: 'hash', 'aria-hidden': 'true' }, '#'), h('span', { class: 'nm' }, info.name),
          info.archived ? h('span', { class: 'pill grey' }, 'Archived') : null, Y.isMuted(ch.id) ? icon('bellOff') : null),
        info.description ? h('div', { class: 'topic', title: info.description }, info.description) : null,
        h('div', { class: 'tools' },
          h('span', { class: 'online-n', title: `${on} of ${count} online now` }, UI.dot('online'), `${on} online`),
          h('button', { class: 'members-btn', 'aria-label': `${count} members, ${on} online`, title: 'Members', onclick: () => membersDialog(ch) }, icon('users'), String(count)),
          searchBtn, infoBtn));
      return;
    }
    if (Y.isPrivateChannel(ch)) {
      const count = Y.members(ch).length;
      const on = onlineCount(Y.members(ch));
      UI.set(el.head, menuBtn,
        h('div', { class: 'title' }, icon('lock', 'title-lock'), h('span', { class: 'nm' }, info.name), Y.isMuted(ch.id) ? icon('bellOff') : null),
        info.description ? h('div', { class: 'topic', title: info.description }, info.description) : null,
        h('div', { class: 'tools' },
          h('button', { class: 'e2e', title: 'Only the people invited can read it. Click to learn more.', onclick: () => privacyDialog('private') }, icon('lock'), 'Private · encrypted'),
          h('span', { class: 'online-n', title: `${on} of ${count} online now` }, UI.dot('online'), `${on} online`),
          h('button', { class: 'members-btn', 'aria-label': `${count} members, ${on} online`, title: 'Members', onclick: () => channelInfoDialog(ch) }, icon('users'), String(count)),
          searchBtn, infoBtn));
      return;
    }
    const badges = [h('button', { class: 'e2e', title: 'Only the people in this conversation can read it. Click to learn more.', onclick: () => privacyDialog(ch.kind === 'dm' ? 'dm' : 'group') }, icon('lock'), 'End-to-end encrypted'),
      h('span', { class: 'retention' }, 'Messages delete after 7 days')];
    if (ch.kind === 'dm') {
      const other = A.users.get(Y.dmOther(ch));
      const p = Y.presenceOf(Y.dmOther(ch));
      UI.set(el.head, menuBtn, UI.avatar(other, 34),
        h('div', { class: 'two' }, h('div', { class: 'title' }, h('span', { class: 'nm' }, info.name),
          Y.isBlocked(Y.dmOther(ch)) ? h('span', { class: 'pill grey' }, icon('block'), 'Blocked') : null, Y.isMuted(ch.id) ? icon('bellOff') : null),
          h('div', { class: 'sub' }, UI.dot(p.state), UI.stateLabel(p.state) + (p.statusText ? ' · ' + p.statusText : ''))),
        h('div', { class: 'tools' }, badges, searchBtn, infoBtn));
    } else {
      UI.set(el.head, menuBtn, h('span', { class: 'avatar', style: { width: '34px', height: '34px', background: 'var(--surface-2)', color: 'var(--muted)' } }, icon('users')),
        h('div', { class: 'two' }, h('div', { class: 'title' }, h('span', { class: 'nm' }, info.name)),
          h('div', { class: 'sub' }, `${Y.members(ch).length} people · ${onlineCount(Y.members(ch))} online`)),
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
    if (A.isOwner() && A.maintenance()) {
      list.push(h('div', { class: 'banner danger', role: 'status' }, icon('refresh'),
        h('span', null, h('b', null, 'Update mode is on. '), 'Everyone else is disconnected and waiting. Open the updater and install the new version, then click Finish update.'),
        h('span', { style: { marginLeft: 'auto', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          updaterLink('btn btn-sm btn-primary'),
          h('button', { class: 'btn btn-sm', onclick: () => finishUpdate() }, 'Finish update'))));
    }
    if (A.isOwner()) {
      const bk = SC.backup.state();
      if (bk.status === 'needsPermission' || bk.status === 'error') {
        const btn = h('button', { class: 'btn btn-sm btn-primary' }, bk.status === 'needsPermission' ? 'Allow' : 'Try again');
        btn.addEventListener('click', () => UI.busy(btn, null, async () => { const r = await SC.backup.runNow({ ask: true }); if (r) UI.toast(`Backed up ${r.files} files`, 'ok'); }));
        list.push(h('div', { class: 'banner', role: 'alert' }, icon('alert'), h('span', null,
          h('b', null, bk.status === 'needsPermission' ? 'Backups are paused. ' : 'The last backup failed. '),
          bk.status === 'needsPermission' ? `The browser needs your OK to open the backup folder “${bk.folder}”. Choose “Allow on every visit”.` : bk.error), btn));
      } else if (bk.status === 'off' && !(U.ls.get('backupNagUntil', 0) > Date.now())) {
        list.push(h('div', { class: 'banner info', role: 'status' }, icon('shield'),
          h('span', null, h('b', null, 'Backups aren’t set up. '), 'If the data folder is deleted, every account and message is lost. Choose a backup folder on the shared storage.'),
          h('button', { class: 'btn btn-sm btn-primary', onclick: () => adminDialog('backup') }, 'Set up'),
          h('button', { class: 'btn btn-sm', onclick: () => { U.ls.set('backupNagUntil', Date.now() + 7 * 86400000); schedule('banners'); } }, 'Later')));
      }
    }
    const waiting = A.teamPendingForMe();
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

  /** Show a new centered time stamp when a conversation has been quiet this long. */
  const TIME_GAP = 15 * 60000;

  /** Poll card: the question is the message text; options show live results. */
  function renderPoll(ch, m) {
    const res = Y.pollResults(m);
    const mineV = Y.myVote(m);
    const total = Array.from(res.byOption.values()).reduce((n, l) => n + l.length, 0);
    const archived = Y.info(ch).archived;
    return h('div', { class: 'poll' },
      h('div', { class: 'poll-head' }, icon('poll'), h('span', null, 'Poll'), h('span', { class: 'muted' }, ' · one vote each')),
      h('div', { class: 'poll-q', html: UI.formatText(m.text, m.mentions) }),
      h('div', { class: 'poll-opts', role: 'radiogroup', 'aria-label': 'Poll options' }, m.poll.options.map(o => {
        const voters = res.byOption.get(o.id) || [];
        const pct = total ? Math.round(voters.length * 100 / total) : 0;
        const picked = mineV.includes(o.id);
        return h('button', {
          class: 'poll-opt' + (picked ? ' picked' : ''), 'data-action': 'vote', 'data-opt': o.id, disabled: archived,
          role: 'radio', 'aria-checked': String(picked),
          title: voters.length ? voters.map(A.name).sort().join(', ') : 'No votes yet',
        },
        h('span', { class: 'poll-fill', style: { width: pct + '%' } }),
        h('span', { class: 'poll-check' }, picked ? icon('check') : null),
        h('span', { class: 'poll-txt' }, o.text),
        h('span', { class: 'poll-n' }, voters.length ? `${voters.length} · ${pct}%` : '0'));
      })),
      h('div', { class: 'poll-foot' }, `${res.voters} ${res.voters === 1 ? 'person' : 'people'} voted` + (mineV.length ? ' · pick another option to change your vote' : '')));
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
        grouped ? null : h('span', { class: 'msg-time', title: U.formatFull(m.ts) }, time),
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
        if (m.edited) t.appendChild(h('span', { class: 'edited', title: m.editTs ? 'Edited ' + U.formatFull(m.editTs) : null }, '(edited)'));
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
      h('div', { class: 'msg-gutter' }, grouped ? h('span', { class: 'hover-time', title: U.formatFull(m.ts) }, time)
        : h('button', { class: 'avatar-btn', 'data-action': 'profile', 'aria-label': `${u ? u.name : 'Unknown user'}: view profile`, title: 'View profile' }, UI.avatar(u, 40))), main);
    if (!m.local && shown && body && !Y.info(ch).archived) {
      const tools = h('div', { class: 'msg-tools', role: 'toolbar', 'aria-label': 'Message actions' },
        SC.emoji.quick.slice(0, 3).map(e => h('button', { class: 'icon-btn quick', 'data-action': 'react', 'data-emoji': e, 'aria-label': 'React with ' + e, title: 'React ' + e }, e)),
        h('button', { class: 'icon-btn', 'data-action': 'react-pick', 'aria-label': 'Add reaction', title: 'Add reaction' }, icon('smile')),
        h('button', { class: 'icon-btn', 'data-action': 'reply', 'aria-label': 'Reply', title: 'Reply' }, icon('reply')),
        Y.canPin(ch) ? h('button', { class: 'icon-btn' + (pinned ? ' active' : ''), 'data-action': 'pin', 'aria-label': pinned ? 'Unpin' : 'Pin', title: pinned ? 'Unpin' : 'Pin to the top' }, icon('pin')) : null,
        mine && !m.poll ? h('button', { class: 'icon-btn', 'data-action': 'edit', 'aria-label': 'Edit', title: 'Edit' }, icon('edit')) : null,
        mine ? h('button', { class: 'icon-btn', 'data-action': 'delete', 'aria-label': 'Delete', title: 'Delete' }, icon('trash')) : null,
        A.can('msg.hide') && ch.kind === 'public' && !mine ? h('button', { class: 'icon-btn', 'data-action': 'hide', 'aria-label': 'Hide message', title: 'Hide message for everyone' }, icon('eyeOff')) : null);
      body.appendChild(tools);
    }
    return row;
  }

  /** The action bar sits beside the message, lined up with the bubble itself (not the reactions or files
   *  under it); when there isn't room there (a wide message), it goes above it. */
  function placeTools(e) {
    const row = e.target.closest && e.target.closest('.msg');
    const w = el.msgs.clientWidth;
    if (!row || (row === placeTools.last && w === placeTools.w)) return;
    placeTools.last = row; placeTools.w = w;
    const body = row.querySelector(':scope > .msg-main > .msg-body');
    const tools = body && body.querySelector(':scope > .msg-tools');
    if (!tools) return;
    const box = el.msgs.getBoundingClientRect(), b = body.getBoundingClientRect();
    const need = tools.offsetWidth || tools.children.length * 32 + 10; // hidden until hover, so estimate
    const room = row.classList.contains('mine') ? b.left - box.left - 8 : box.right - b.right - 8;
    const above = room < need + 6;
    body.classList.toggle('tools-above', above);
    tools.style.top = '';
    if (above) return;
    const first = body.firstElementChild;
    if (!first || first === tools) return;
    const BAR = 38; // toolbar height
    // short bubble: centre the bar on it; tall content (poll, album, long text): line it up with the top
    const top = first.offsetHeight <= BAR * 1.6 ? first.offsetTop + first.offsetHeight / 2 - BAR / 2 : first.offsetTop;
    tools.style.top = Math.round(top) + 'px';
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
    if (el.msgs) el.msgs.classList.toggle('board-mode', isBoard());
    if (isBoard()) return BV.render(el.msgs, openBoardId());
    if (isAnn()) return renderAnnouncements();
    if (isTeam()) return renderTeam();
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
    let prev = null, lastDay = '', lastTs = 0, divDone = false;
    for (const m of list) {
      // like Messenger: a centered time stamp at the start of each day and after a quiet gap
      const day = U.localDay(m.ts);
      if (day !== lastDay || m.ts - lastTs >= TIME_GAP) {
        frag.appendChild(h('div', { class: 'day-div', role: 'separator', title: U.formatFull(m.ts) }, U.formatDateTime(m.ts)));
        prev = null;
      }
      lastDay = day; lastTs = m.ts;
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
    if (isTeam()) return;
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

  /** Load the pictures still showing a placeholder inside `box`. find(node) → {a, read()} for the picture. */
  async function loadPics(box, find) {
    const nodes = Array.from(box.querySelectorAll('[data-thumb]')).filter(n => !thumbLoading.has(n.dataset.thumb));
    await U.mapLimit(nodes, 3, async node => {
      const fileId = node.dataset.thumb;
      const it = find(node);
      if (!it || !it.a) return;
      thumbLoading.add(fileId);
      try {
        const url = URL.createObjectURL(await it.read());
        blobUrls.set(fileId, url);
        document.querySelectorAll(`[data-thumb="${fileId}"]`).forEach(n => { n.removeAttribute('data-thumb'); n.classList.remove('loading'); if (n.parentElement) n.parentElement.classList.remove('loading'); UI.set(n, thumbImg(url, it.a)); });
      } catch (e) {
        imageFailed(node, it.a);
      }
    });
  }
  function loadThumbs(ch) {
    return loadPics(el.msgs, node => {
      const row = node.closest('.msg');
      const m = row && ch.msgs.get(row.dataset.id);
      const a = m && m.attachments[Number(node.dataset.i)];
      return a ? { a, read: () => Y.readAttachment(ch, m, a) } : null;
    });
  }
  /** Pictures in announcements (1.15): in the feed and in the pop-up. */
  function annPic(node) {
    const row = node.closest('[data-ann]');
    const a = row && Y.announcements.get(row.dataset.ann);
    const att = a && (a.attachments || [])[Number(node.dataset.i)];
    return att ? { a: att, read: () => Y.readAnnouncementFile(a, att) } : null;
  }
  const loadAnnPics = box => loadPics(box, annPic);

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
    if (isTeam()) return onTeamClick(t);
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
        return openPictures(pics, pics.indexOf(a), p => Y.readAttachment(ch, m, p));
      }
      if (isPdf(a) && !saveOnly) {
        const blob = await Y.readAttachment(ch, m, a);
        return pdfViewer(new Blob([blob], { type: 'application/pdf' }), a, () => Y.readAttachment(ch, m, a));
      }
      await saveAs(a.name, () => Y.readAttachment(ch, m, a));
    } catch (e) { UI.toast(e.message, 'error'); }
  }

  /** Open pictures in the viewer, starting at `start`. read(p) → Blob. */
  async function openPictures(pics, start, read) {
    const items = pics.map(p => {
      let pending = null; // one read per picture, shared by the pre-load and the click
      return {
        a: p,
        load: () => {
          const have = blobUrls.get(p.fileId);
          if (have) return Promise.resolve(have);
          if (!pending) {
            pending = read(p).then(blob => {
              const url = URL.createObjectURL(blob);
              blobUrls.set(p.fileId, url);
              return url;
            }).catch(e => { pending = null; throw e; });
          }
          return pending;
        },
        getBlob: () => read(p),
      };
    });
    await items[start].load();
    return lightbox(items, start);
  }
  function openAnnPicture(a, i, saveOnly) {
    const att = a && (a.attachments || [])[i];
    if (!att) return;
    const read = p => Y.readAnnouncementFile(a, p);
    (saveOnly ? saveAs(att.name, () => read(att)) : openPictures(a.attachments, i, read)).catch(e => UI.toast(e.message, 'error'));
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
    if (isBoard()) { el.ta = null; UI.set(el.composerWrap); return; }
    if (isTeam()) {
      el.ta = null;
      const tid = openTeamId();
      const ids = A.teamMembers(tid).map(u => u.id).filter(id => id !== meId());
      UI.set(el.composerWrap, h('div', { class: 'ann-compose' },
        h('span', { class: 'muted' }, 'Everyone accepted into this group by an admin.'),
        h('span', { class: 'row', style: { gap: '8px' } },
          h('button', { class: 'btn', disabled: !ids.length || ids.length + 1 > Y.MAX_GROUP, title: ids.length + 1 > Y.MAX_GROUP ? `Group chats can have up to ${Y.MAX_GROUP} people` : null,
            onclick: () => newGroupDialog({ name: A.teamName(tid), userIds: ids }) }, icon('message'), 'Start group chat with everyone'),
          A.can('ann.private') && (Y.announceTeam() === null || Y.announceTeam() === tid) ? h('button', { class: 'btn btn-primary', disabled: !ids.length, onclick: () => newAnnouncementDialog({ team: tid }) }, icon('megaphone'), 'Send announcement to this group') : null)));
      return;
    }
    if (isAnn()) {
      el.ta = null;
      const f = annFeed();
      const canPost = (f ? A.can('ann.private') : A.canAny('ann.post', 'ann.private')) && (!f || Y.announceTeam() === null || Y.announceTeam() === f);
      UI.set(el.composerWrap, canPost
        ? h('div', { class: 'ann-compose' }, h('span', { class: 'muted' }, f ? `Only people in ${A.teamName(f)} get these. They pop up and stay here for a year.` : 'Announcements pop up for everyone and stay here for a year.'),
          h('button', { class: 'btn btn-primary', onclick: () => newAnnouncementDialog(f ? { team: f } : {}) }, icon('megaphone'), f ? `New announcement to ${shortTeam(f)}` : 'New announcement'))
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
    if (ch.kind === 'dm' && Y.isBlocked(Y.dmOther(ch))) {
      el.ta = null;
      const other = Y.dmOther(ch);
      UI.set(el.composerWrap, h('div', { class: 'archived-note' }, `You blocked ${A.name(other)}. They can’t reach you here and you can’t send them messages. `,
        h('button', { class: 'link-btn', onclick: () => blockUser(other, false) }, 'Unblock')));
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
    const emojiBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Insert emoji', title: 'Emoji' }, icon('smile'));
    emojiBtn.addEventListener('click', () => UI.emojiPicker(emojiBtn, e => insertText(ta, e)));
    el.sendBtn = h('button', { class: 'send-btn', type: 'button', 'aria-label': 'Send', title: 'Send (Enter)', onclick: send }, icon('send'));
    UI.set(el.composerWrap, 
      h('div', { class: 'composer' },
        el.replyBar,
        el.chips,
        h('div', { class: 'comp-row' }, ta, emojiBtn,
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Attach files (max 5 MB each)', title: 'Attach files', onclick: () => fileInput.click() }, icon('clip')),
          A.can('msg.poll') ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Create a poll', title: 'Create a poll', onclick: () => pollDialog(ch) }, icon('poll')) : null,
          el.sendBtn, fileInput)),
      h('div', { class: 'comp-hint' }, el.hintLeft, el.count));
    ta.addEventListener('input', () => { st.drafts[ch.id] = ta.value; autosize(ta); updateCount(); mentionCheck(); });
    ta.addEventListener('keydown', onComposerKey);
    ta.addEventListener('click', () => mentionCheck());
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
    if (e.key === 'ArrowUp' && !ta.value) {
      const ch = cur();
      const last = ch && Y.sorted(ch).slice().reverse().find(m => m.userId === meId() && !m.deleted && !m.hidden && m.verified && !m.decryptError && !m.poll);
      if (last) { e.preventDefault(); startEdit(last); }
      return;
    }
    if (e.key === 'Escape' && st.replies[st.openId]) { e.preventDefault(); e.stopPropagation(); st.replies[st.openId] = null; renderReplyBar(); }
  }

  /* ---- @mention picker ----
   * Works on any textarea: the message box, and the announcement dialogs (1.15).
   * ctx = {ta, users() → who can be mentioned, channel: offer @channel, place(el) → put the list on screen} */
  let mention = null; // {ctx, start, items, sel, el}
  function composerCtx() {
    const ch = cur();
    if (!el.ta || !ch) return null;
    const mem = ch.kind !== 'public' ? Y.members(ch) : null;
    return { ta: el.ta, channel: ch.kind === 'public', users: () => A.activeUsers().filter(u => !mem || mem.includes(u.id)),
      place: box => { Object.assign(box.style, { position: 'absolute', bottom: 'calc(100% - 4px)', left: '20px' }); el.composerWrap.appendChild(box); } };
  }
  function mentionCheck(ctx) {
    ctx = ctx || composerCtx();
    if (!ctx) return;
    const ta = ctx.ta;
    const before = ta.value.slice(0, ta.selectionStart);
    const m = /(^|\s)@([\p{L}\p{N}._'\- ]{0,32})$/u.exec(before);
    if (!m) return closeMention();
    const q = m[2].toLowerCase();
    const pool = ctx.users().filter(u => u.id !== meId());
    let items = pool.filter(u => u.name.toLowerCase().startsWith(q))
      .concat(q.length > 1 ? pool.filter(u => !u.name.toLowerCase().startsWith(q) && u.name.toLowerCase().includes(q)) : []);
    items = items.slice(0, 8).map(u => ({ id: u.id, name: u.name, user: u }));
    if (ctx.channel && 'channel'.startsWith(q)) items.push({ id: 'channel', name: 'channel' });
    if (!items.length || (q.includes(' ') && !items.some(i => i.name.toLowerCase().startsWith(q)))) return closeMention();
    const start = before.length - m[2].length - 1;
    if (mention && mention.ctx.ta !== ta) closeMention();
    const sel = mention ? Math.min(mention.sel, items.length - 1) : 0;
    if (!mention) {
      mention = { ctx, el: h('div', { class: 'popover mention-pop', role: 'listbox', 'aria-label': 'Mention someone' }) };
      ctx.place(mention.el);
    }
    Object.assign(mention, { start, items, sel });
    drawMention();
  }
  /** @mentions in a dialog's textarea: the list opens just under it. */
  function mentionField(ta, users) {
    const ctx = { ta, users, channel: false, place: box => {
      document.body.appendChild(box);
      const r = ta.getBoundingClientRect();
      const below = r.bottom + 4 + 280 < window.innerHeight;
      Object.assign(box.style, { position: 'fixed', left: Math.max(8, Math.min(r.left, window.innerWidth - 310)) + 'px', top: below ? (r.bottom + 4) + 'px' : 'auto', bottom: below ? 'auto' : (window.innerHeight - r.top + 4) + 'px' });
    } };
    ta.addEventListener('input', () => mentionCheck(ctx));
    ta.addEventListener('click', () => mentionCheck(ctx));
    ta.addEventListener('keydown', e => { if (mention && mention.ctx === ctx && mentionKey(e)) e.stopPropagation(); });
    ta.addEventListener('blur', () => setTimeout(() => { if (mention && mention.ctx === ctx) closeMention(); }, 150));
    return ctx;
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
    const ta = mention.ctx.ta;
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
    // Notification settings (1.15): direct messages, group chats (and private channels), public channels; mentions have their own switch
    const kind = ch.kind === 'dm' ? 'dms' : ch.kind === 'group' ? 'groupMsgs' : 'channels';
    for (const m of msgs) {
      if (m.deleted || !m.verified) continue;
      const mentioned = m.mentions.includes(meId()) || m.mentions.includes('channel');
      if (viewing) continue;
      if (mentioned ? !N.allow('mentions') : !N.allow(kind)) continue;
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
    const canPubCh = A.can('ch.create'), canPrivCh = A.can('ch.createPrivate') || !!preset.replaces;
    let priv = !!preset.private || !canPubCh;
    const count = h('div', { class: 'hint' });
    const ok = h('button', { class: 'btn btn-primary', type: 'submit' });
    const update = () => {
      ok.textContent = priv ? (pp.picked.size ? `Create private channel (${pp.picked.size + 1} people)` : 'Create private channel') : 'Create channel';
      count.textContent = pp.picked.size ? `${pp.picked.size + 1} people including you (up to ${Y.MAX_GROUP}).` : `Pick up to ${Y.MAX_GROUP - 1} people.`;
    };
    const pp = peoplePicker({ multi: true, max: Y.MAX_GROUP - 1, onChange: update });
    pp.el[0].removeAttribute('autofocus');
    const listed = listedCheck('nc-listed', false);
    const invite = h('div', { class: 'field' + (priv ? '' : ' hidden') }, h('span', { class: 'label' }, 'Invite people'), count, pp.el, listed.el);
    const note = h('p', { class: 'muted', style: { fontSize: '14px' } });
    const seg = h('div', { class: 'vis-seg', role: 'radiogroup', 'aria-label': 'Who can see it' });
    const drawSeg = () => {
      UI.set(seg, [['public', 'hash', 'Public', 'Everyone in the workspace'], ['private', 'lock', 'Private', 'Only people you invite']].filter(([v]) => (v === 'public' ? canPubCh : canPrivCh)).map(([v, ic, t, sub]) =>
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
        ? await Y.createPrivateChannel({ name: name.value, description: desc.value, userIds: Array.from(pp.picked), replaces: preset.replaces, listed: listed.cb.checked })
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

  function peoplePicker({ multi, max, onChange, exclude = [], only = null }) {
    const picked = new Set();
    const q = h('input', { class: 'input', placeholder: 'Find people', 'aria-label': 'Find people', autofocus: true });
    const list = h('div', { class: 'people-list' });
    function draw() {
      const s = q.value.trim().toLowerCase();
      UI.set(list, ...A.activeUsers().filter(u => u.id !== meId() && !exclude.includes(u.id) && (!only || only(u.id)) && (!s || u.name.toLowerCase().includes(s))).map(u => {
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
          if (id === meId() || exclude.includes(id) || (only && !only(id)) || picked.has(id) || !A.users.get(id) || A.isRemoved(id)) continue;
          if (picked.size >= max) { skipped++; continue; }
          picked.add(id);
        }
        if (skipped) UI.toast(`Up to ${max} people. ${skipped} weren’t added.`);
        onChange(picked); draw();
      },
      remove(ids) { ids.forEach(id => picked.delete(id)); onChange(picked); draw(); },
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

  /** Checkbox: list this group in Browse groups so people can ask to join. */
  function listedCheck(id, checked) {
    const cb = h('input', { type: 'checkbox', id, checked: !!checked });
    return { cb, el: h('label', { class: 'check', for: id }, cb, h('span', null, h('b', null, 'Let people find it and ask to join. '),
      h('span', { class: 'muted' }, 'Its name, description and member count show in Browse groups. Messages stay encrypted. You or a group admin approve each request.'))) };
  }

  function newGroupDialog(preset = {}) {
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const name = h('input', { class: 'input', id: 'ng-name', maxlength: 60, placeholder: 'e.g. Warehouse team', value: preset.name || '' });
    const listed = listedCheck('ng-listed', false);
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
      const ch = await Y.createGroup({ name: name.value, userIds: Array.from(pp.picked), listed: listed.cb.checked });
      m.close(); Chat.open(ch.id);
    }, err));
    const m = UI.modal({ title: 'Create a group chat', cls: 'mid', body: [err,
      h('div', { class: 'field' }, h('label', { for: 'ng-name' }, 'Group name'), name),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Members'), count), pp.el,
      listed.el,
      h('div', { class: 'note note-ok', style: { marginTop: '6px' } }, icon('lock'), h('div', null, 'End-to-end encrypted, including the group name. Only members can read it. Messages and files delete after 7 days. ',
        h('button', { class: 'link-btn', type: 'button', onclick: () => privacyDialog('group') }, 'How is this protected?')))],
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok] });
    if (preset.userIds) pp.add(preset.userIds);
    name.focus();
  }

  function membersDialog(ch) {
    const ids = Y.members(ch);
    const users = ids.map(id => A.users.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    UI.modal({ title: `Members of ${chName(ch)} (${users.length})`, body: h('div', { class: 'people-list' }, users.map(u => {
      const p = Y.presenceOf(u.id);
      return h('div', { class: 'person', onclick: () => profileDialog(u.id) }, UI.avatar(u, 32),
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
        p.statusText ? h('div', { style: { fontSize: '13px' } }, p.statusText) : null,
        u.title ? h('div', { class: 'muted', style: { fontSize: '13px' } }, u.title) : null)),
      h('button', { class: 'menu-item', onclick: () => { UI.closePopover(); profileDialog(userId); } }, icon('info'), 'View full profile'),
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
    const muteBtn = h('button', { class: 'btn', onclick: () => { keep(Y.setMuted(ch.id, !muted)); m.close(); renderHeader(); } }, icon(muted ? 'bell' : 'bellOff'), muted ? 'Unmute notifications' : 'Mute notifications');
    if (ch.kind === 'public') {
      body.push(h('dl', { class: 'kv' },
        h('dt', null, 'Name'), h('dd', null, '#' + info.name),
        h('dt', null, 'Description'), h('dd', null, info.description || '—'),
        h('dt', null, 'Created by'), h('dd', null, A.name(ch.meta.createdBy) + ' · ' + new Date(ch.meta.ts).toLocaleDateString()),
        h('dt', null, 'Members'), h('dd', null, 'Everyone in the workspace'),
        h('dt', null, 'Privacy'), h('dd', null, 'Public. Stored unencrypted on the shared drive.')));
      const actions = [muteBtn];
      if (A.can('ch.manage')) {
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
      if (A.can('ch.makePrivate') && ch.id !== 'general' && !info.archived) {
        actions.push(h('button', { class: 'btn', onclick: () => { m.close(); makePrivateDialog(ch); } }, icon('lock'), 'Make private'));
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
          onclick: () => { m.close(); addMembersDialog(ch); } }, icon('plus'), 'Add people'),
        ch.groupName ? h('button', { class: 'btn', title: 'Show it in Browse groups so people can ask to join', onclick: async () => {
          const on = !ch.meta.listed;
          if (on && !(await UI.confirm({ title: 'List it in Browse groups?', ok: 'List it',
            text: 'Everyone in the workspace will see its name, description and member count, and can ask to join. You or a group admin approve each request. Messages stay encrypted.' }))) return;
          try { await Y.updateGroup(ch, { listed: on }); m.close(); UI.toast(on ? 'Listed in Browse groups' : 'Removed from Browse groups', 'ok'); } catch (e) { UI.toast(e.message, 'error'); }
        } }, icon('search'), ch.meta.listed ? 'Unlist from Browse groups' : 'List in Browse groups') : null));
      else if (ch.kind === 'group' && Y.members(ch).length < Y.MAX_GROUP) body.push(h('div', { class: 'row', style: { flexWrap: 'wrap', marginBottom: '14px' } },
        h('button', { class: 'btn', title: 'Ask a group admin to add someone', onclick: () => { m.close(); suggestMemberDialog(ch); } }, icon('plus'), 'Suggest someone')));
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
      // direct messages (and unnamed group messages): the same options as the ⋯ menu in the sidebar
      if (ch.kind === 'dm' || (ch.kind === 'group' && !ch.groupName && !pc)) {
        const pinned = Y.isChatPinned(ch.id), arch = Y.isArchived(ch.id);
        const other = ch.kind === 'dm' ? others[0] : null, blocked = !!other && Y.isBlocked(other);
        body.push(h('div', { class: 'row', style: { flexWrap: 'wrap', marginBottom: '10px' } },
          h('button', { class: 'btn', onclick: () => { keep(Y.setChatPinned(ch.id, !pinned), pinned ? 'Unpinned' : 'Pinned to the top'); m.close(); } }, icon('pin'), pinned ? 'Unpin' : 'Pin to the top'),
          h('button', { class: 'btn', onclick: () => { keep(Y.setArchived(ch.id, !arch), arch ? 'Moved back to Direct messages' : 'Archived'); m.close(); } }, icon('archive'), arch ? 'Unarchive' : 'Archive'),
          h('button', { class: 'btn', onclick: () => { m.close(); deleteChat(ch); } }, icon('trash'), 'Delete chat'),
          other && A.users.get(other) ? h('button', { class: 'btn' + (blocked ? '' : ' btn-danger'), onclick: () => { m.close(); blockUser(other, !blocked); } }, icon('block'), blocked ? 'Unblock' : 'Block') : null));
      }
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
      item('info', 'View my profile', () => profileDialog(meId())),
      item('edit', 'Edit profile', editProfileDialog),
      h('div', { class: 'menu-sep' }),
      h('div', { class: 'menu-label' }, 'Theme'),
      h('div', { class: 'seg' }, seg('system', 'System', 'monitor'), seg('light', 'Light', 'sun'), seg('dark', 'Dark', 'moon')),
      notif === 'granted' ? null : item('bell', notif === 'denied' ? 'Desktop notifications are blocked' : 'Turn on desktop notifications', () => SC.app.requestNotifications()),
      item(N.isQuiet() ? 'bellOff' : 'bell', N.isQuiet() ? `Do not disturb until ${U.formatDateTime(N.dndUntil())}` : 'Notification settings', notifSettingsDialog),
      item('volume', SC.app.soundOn() ? 'Sound: on' : 'Sound: off', () => { SC.app.setSound(!SC.app.soundOn()); UI.toast(SC.app.soundOn() ? 'Sound on' : 'Sound off'); }),
      item('check', Y.receiptsOn() ? 'Read receipts: on' : 'Read receipts: off', () => {
        Y.setReceipts(!Y.receiptsOn());
        UI.toast(Y.receiptsOn() ? 'Read receipts on' : 'Read receipts off. Others won’t see when you’ve read their messages, and you won’t see theirs.');
      }),
      h('div', { class: 'menu-sep' }),
      item('key', 'Change password', changePasswordDialog),
      item('key', 'Security question', recoveryDialog),
      item('shield', 'Privacy and security: who can read what', () => privacyDialog()),
      item('megaphone', 'What’s new', () => whatsNewDialog()),
      A.isAdmin() ? item('info', 'Admin guide: what you can do', adminGuide) : A.hasCustomRole() ? item('info', 'Role guide: what you can do', adminGuide) : null,
      adminTabs().length ? item('shield', 'Admin settings', adminDialog) : null,
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
    const realName = h('input', { class: 'input', id: 'ep-real', maxlength: 60, placeholder: 'e.g. Maria Santos', autocomplete: 'name' });
    let realLoaded = '';
    A.realNameOf(meId()).then(n => { realLoaded = n; if (!realName.value) realName.value = n; });
    const jobTitle = h('input', { class: 'input', id: 'ep-title', value: me.title || '', maxlength: 60, placeholder: 'e.g. Pickup coordinator' });
    const about = h('textarea', { class: 'input', id: 'ep-about', rows: 3, maxlength: 300, placeholder: 'A line about you, your shift or how to reach you' });
    about.value = me.about || '';
    const pv = h('span');
    const draw = () => UI.set(pv, UI.avatar(state, 56));
    const animals = h('div', { class: 'animal-grid', role: 'radiogroup', 'aria-label': 'Avatar' }, A.ANIMALS.map(([e, n]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(e === state.animal), 'aria-label': n, title: n,
      onclick: ev => { state.animal = e; animals.querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', String(x === ev.currentTarget))); draw(); } }, e)));
    const colors = h('div', { class: 'color-row', role: 'radiogroup', 'aria-label': 'Background colour' }, A.COLORS.map((c, i) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(c === state.color), 'aria-label': 'Colour ' + (i + 1), style: { background: c },
      onclick: ev => { state.color = c; colors.querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', String(x === ev.currentTarget))); draw(); } })));
    draw();
    const ok = h('button', { class: 'btn btn-primary' }, 'Save');
    ok.addEventListener('click', () => UI.busy(ok, null, async () => {
      const rn = A.cleanRealName(realName.value);
      // re-seal only when it changed (or was never readable here), so an unchanged name doesn't rewrite every seal
      await A.updateProfile({ name: name.value, animal: state.animal, color: state.color, title: jobTitle.value, about: about.value,
        realName: rn !== realLoaded || !realLoaded ? rn : undefined });
      m.close(); UI.toast('Profile updated', 'ok');
    }, err));
    const m = UI.modal({ title: 'Edit profile', cls: 'mid', body: [err, h('div', { class: 'preview' }, pv, h('div', { class: 'name' }, 'Preview')),
      h('div', { class: 'field' }, h('label', { for: 'ep-name' }, 'Display name'), name),
      h('div', { class: 'field' }, h('label', { for: 'ep-real' }, 'Real name (required)'), realName,
        h('div', { class: 'hint row', style: { gap: '6px' } }, icon('lock'), 'Only admins and the super admin can see it. It’s encrypted for them; everyone else sees your display name.')),
      h('div', { class: 'field' }, h('label', { for: 'ep-title' }, 'Job title (optional)'), jobTitle),
      h('div', { class: 'field' }, h('label', { for: 'ep-about' }, 'About (optional)'), about, h('div', { class: 'hint' }, 'Shown on your profile. Everyone in the workspace can see it.')),
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
      h('p', { class: 'muted', style: { fontSize: '13px' } }, current
        ? 'If you forget your password, click “Forgot password?” on the sign-in screen and answer this to choose a new one. You keep all your messages.'
        : A.isOwner() ? 'No security question is set. Without one, a forgotten super admin password can’t be recovered.'
          : 'No security question is set. If you forget your password, an admin can only reset it, and your direct messages from before the reset can’t be opened.'),
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
  function openAnnouncements(feed = '') {
    if (!annFeeds().includes(feed)) feed = '';
    if (el.ta && st.openId) st.drafts[st.openId] = el.ta.value;
    st.openId = annKey(feed);
    Y.openId = null;
    U.ls.set('lastOpen.' + A.ws.id, st.openId);
    st.editingId = null;
    st.firstRender = true;
    st.annFresh = new Set(feedPending(feed).map(a => a.id));
    el.root.classList.remove('side-open');
    UI.closePopover();
    renderSidebar(); renderHeader(); renderKeyNotice(); buildComposer(); renderMessages(); renderPins();
  }

  function renderAnnouncements() {
    const box = el.msgs;
    if (!box) return;
    const admin = canAnnounce();
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const keepTop = box.scrollTop;
    if (!st.annFresh) st.annFresh = new Set();
    feedPending(annFeed()).forEach(a => st.annFresh.add(a.id)); // keep "new" highlighted after it's marked seen
    const feed = annFeed();
    const items = Y.announcementList().filter(a => feedOf(a) === feed).reverse(); // oldest first, like a chat
    const frag = document.createDocumentFragment();
    frag.appendChild(h('div', { class: 'intro' }, h('h3', null, feedName(feed)),
      h('p', null, feed ? `Private announcements for ${A.teamName(feed)}. Only people in the group can read them: they’re encrypted for each of them. Each one stays here for a year.`
        : `Messages from the admins to everyone in ${A.ws.name}. Each one stays here for a year.`)));
    if (!items.length) frag.appendChild(h('div', { class: 'ann-empty' }, 'No announcements yet.'));
    let lastDay = '', divDone = false;
    for (const a of items) {
      const day = U.localDay(a.ts);
      if (day !== lastDay) { frag.appendChild(h('div', { class: 'day-div', role: 'separator', title: U.formatFull(a.ts) }, U.formatDayLabel(a.ts))); lastDay = day; }
      const fresh = st.annFresh.has(a.id);
      if (fresh && !divDone) { frag.appendChild(h('div', { class: 'new-div', role: 'separator' }, 'New')); divDone = true; }
      const u = A.users.get(a.userId);
      const role = A.roleLabel(a.userId);
      const reach = admin ? seenRow(a) : null;
      const forMe = (a.mentions || []).includes(meId());
      frag.appendChild(h('div', { class: 'msg theirs ann-msg' + (fresh ? ' ann-new' : '') + (forMe ? ' ann-mentioned' : ''), 'data-ann': a.id, tabindex: admin ? '0' : null },
        h('div', { class: 'msg-gutter' }, h('button', { class: 'avatar-btn', 'data-action': 'profile', 'aria-label': `${A.name(a.userId)}: view profile`, title: 'View profile' }, UI.avatar(u, 40))),
        h('div', { class: 'msg-main' },
          h('div', { class: 'msg-head' }, h('button', { class: 'msg-name', 'data-action': 'profile' }, A.name(a.userId)),
            role ? h('span', { class: 'pill grey' }, role) : null,
            a.to ? h('span', { class: 'pill', title: a.to.filter(x => x !== a.userId).map(A.name).sort().join(', ') }, icon('lock'), `Private · ${a.to.filter(x => x !== a.userId).length} people`) : null,
            h('span', { class: 'msg-time', title: U.formatFull(a.ts) }, U.formatTime(a.ts)),
            a.editTs ? h('span', { class: 'msg-time', title: 'Edited ' + U.formatFull(a.editTs) }, '(edited)') : null),
          h('div', { class: 'ann-card' },
            a.title ? h('div', { class: 'ann-title' }, a.title) : null,
            a.text ? h('div', { class: 'msg-text ann-text', html: UI.formatText(a.text, a.mentions || []) }) : null,
            a.attachments && a.attachments.length ? h('div', { class: 'ann-pics' }, renderAttachments({ attachments: a.attachments })) : null,
            reach,
            // shown on hover (and keyboard focus) at the card's corner, like the tools on chat messages
            admin ? h('div', { class: 'msg-tools ann-tools', role: 'toolbar', 'aria-label': 'Announcement actions' },
              Y.canEditAnnouncement(a) ? h('button', { class: 'icon-btn', 'data-action': 'ann-edit', 'aria-label': 'Edit announcement', title: 'Edit (fix a mistake; it doesn’t pop up again)' }, icon('edit')) : null,
              A.can('ann.withdraw') || Y.canEditAnnouncement(a) ? h('button', { class: 'icon-btn', 'data-action': 'ann-withdraw', 'aria-label': 'Delete announcement', title: 'Delete for everyone' }, icon('trash')) : null) : null))));
    }
    UI.set(box, frag);
    if (st.firstRender || atBottom) {
      const d = st.firstRender && box.querySelector('.new-div');
      if (d) d.scrollIntoView({ block: 'start' }); else box.scrollTop = box.scrollHeight;
      st.firstRender = false;
    } else box.scrollTop = keepTop;
    loadAnnPics(box);
    ackVisibleAnnouncements();
  }

  /* ---- who has seen an announcement (admins) ----
   * The faces of the last five people who saw it; "See more" opens the whole list, with who hasn't seen it yet. */
  const SEEN_FACES = 5;
  function seenRow(a) {
    const r = Y.announcementReach(a);
    const faces = r.seen.slice(0, SEEN_FACES);
    const missing = r.audience.length - r.seen.length;
    return h('div', { class: 'ann-seen' },
      h('span', { class: 'ann-seen-n' }, icon('check'), r.audience.length && !missing ? `Seen by everyone (${r.seen.length})` : `Seen by ${r.seen.length} of ${r.audience.length}`),
      faces.length ? h('span', { class: 'ann-faces', role: 'img', 'aria-label': 'Seen by ' + faces.map(u => u.name).join(', ') + (r.seen.length > faces.length ? ` and ${r.seen.length - faces.length} more` : '') },
        faces.map(u => h('span', { class: 'ann-face', title: `${u.name} · seen ${U.formatDateTime(r.ackAt(u))}` }, UI.avatar(u, 24)))) : null,
      r.seen.length > SEEN_FACES ? h('button', { class: 'link-btn ann-seen-more', 'data-action': 'ann-seen' }, `See more (+${r.seen.length - SEEN_FACES})`)
        : missing ? h('button', { class: 'link-btn ann-seen-more', 'data-action': 'ann-seen' }, `${missing} not yet`) : null);
  }
  function seenDialog(a) {
    if (!a) return;
    let tab = 'seen';
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const list = h('div', { class: 'people-list seen-list' });
    function draw() {
      const r = Y.announcementReach(a);
      const notYet = r.audience.filter(u => !r.seen.includes(u)).sort((x, y) => x.name.localeCompare(y.name));
      UI.set(tabs, [['seen', `Seen (${r.seen.length})`], ['not', `Not seen yet (${notYet.length})`]].map(([id, label]) =>
        h('button', { role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = id; draw(); } }, label)));
      const people = tab === 'seen' ? r.seen : notYet;
      UI.set(list, people.length ? people.map(u => h('div', { class: 'person', onclick: () => profileDialog(u.id) }, UI.avatar(u, 32),
        h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { class: 'nm' }, u.name), h('div', { class: 'sub' }, tab === 'seen' ? 'Seen ' + U.formatDateTime(r.ackAt(u)) : (A.teamOf(u.id) ? A.teamName(A.teamOf(u.id)) : 'No group yet')))))
        : h('div', { class: 'muted', style: { padding: '10px' } }, tab === 'seen' ? 'Nobody has seen it yet.' : 'Everyone has seen it.'));
    }
    const unsub = Y.events.on('presence', changed => { if (changed) draw(); });
    UI.modal({ title: a.title ? `Seen: ${a.title}` : 'Who has seen it', cls: 'mid', body: [tabs, list], onClose: unsub });
    draw();
  }

  /** Viewing the channel counts as having seen everything in it. */
  function ackVisibleAnnouncements() {
    if (!isAnn() || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    for (const a of feedPending(annFeed())) Y.ackAnnouncement(a.id);
  }

  async function onAnnClick(t) {
    const row = t.closest('[data-ann]');
    if (!row) return;
    if (t.dataset.action === 'profile') { const a = Y.announcements.get(row.dataset.ann); if (a) profileCard(a.userId, t); return; }
    if (t.dataset.action === 'open-att') return openAnnPicture(Y.announcements.get(row.dataset.ann), Number(t.dataset.i), t.dataset.save === '1');
    if (t.dataset.action === 'ann-seen') return seenDialog(Y.announcements.get(row.dataset.ann));
    if (!canAnnounce()) return;
    if (t.dataset.action === 'ann-edit') return editAnnouncementDialog(Y.announcements.get(row.dataset.ann));
    if (t.dataset.action !== 'ann-withdraw') return;
    if (!(await UI.confirm({ title: 'Delete this announcement?', text: 'It disappears for everyone, including people who haven’t seen it yet. This can’t be undone.', ok: 'Delete', danger: true }))) return;
    try { await Y.withdrawAnnouncement(row.dataset.ann); UI.toast('Announcement deleted', 'ok'); } catch (e) { UI.toast(e.message, 'error'); }
  }

  /** Pop up the oldest announcement I haven't seen yet, one at a time, over whatever is open.
   *  Closing it (Close, ×, Esc or clicking outside) marks it as seen; it stays in the Announcements channel. */
  function showPendingAnnouncement() {
    if (st.annOpen || !el.root) return;
    // the feed I'm looking at marks its own as seen; the others still pop up
    const viewing = isAnn() && document.visibilityState === 'visible' && document.hasFocus();
    if (viewing) schedule('msgs');
    const pending = Y.pendingAnnouncements().filter(a => !(viewing && feedOf(a) === annFeed()));
    const a = pending[0];
    if (!a) return;
    st.annOpen = true;
    let goView = false;
    const u = A.users.get(a.userId);
    const more = pending.length - 1;
    const m = UI.modal({ title: a.title || 'Announcement', cls: 'mid ann-pop', body: [
      h('div', { class: 'row', style: { gap: '10px', marginBottom: '12px' } }, UI.avatar(u, 32),
        h('div', null, h('div', { style: { fontWeight: '600' } }, A.name(a.userId)), h('div', { class: 'muted', style: { fontSize: '13px' } }, (A.roleLabel(a.userId) || 'Admin') + ' · ' + U.formatDateTime(a.ts) + (a.to ? ' · sent privately to you' + (a.to.length > 2 ? ` and ${a.to.length - 2} others` : '') : '')))),
      a.text ? h('div', { class: 'msg-text ann-text', html: UI.formatText(a.text, a.mentions || []) }) : null,
      a.attachments && a.attachments.length ? h('div', { class: 'ann-pics', 'data-ann': a.id, onclick: e => {
        const t = e.target.closest('[data-action="open-att"]');
        if (t) openAnnPicture(a, Number(t.dataset.i), t.dataset.save === '1');
      } }, renderAttachments({ attachments: a.attachments })) : null,
      (a.mentions || []).includes(meId()) ? h('p', { class: 'ann-later' }, icon('at'), 'You were mentioned in this announcement.') : null,
      h('p', { class: 'ann-later' }, icon('megaphone'), `You can read this again any time in ${feedName(feedOf(a))}, at the top of the sidebar.` + (more ? ` ${more} more after this one.` : ''))],
    foot: [
      h('button', { class: 'btn', onclick: () => { goView = true; m.close(); } }, feedOf(a) ? `Open ${feedName(feedOf(a))}` : 'View all announcements'),
      h('button', { class: 'btn btn-primary', onclick: () => m.close() }, icon('x'), 'Close')],
    onClose: () => {
      if (!st.unmounting) Y.ackAnnouncement(a.id);
      st.annOpen = false;
      if (st.unmounting) return;
      if (goView) Chat.open(annKey(feedOf(a))); else setTimeout(showPendingAnnouncement, 300);
    } });
    loadAnnPics(m.el);
    SC.app.notify({ title: 'Announcement: ' + (a.title || A.name(a.userId)), body: a.text ? a.text.slice(0, 140) : `📷 ${a.attachments.length} ${a.attachments.length === 1 ? 'picture' : 'pictures'}`, tag: 'ann-' + a.id });
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
    const ok = h('button', { class: 'btn btn-primary' }, icon('poll'), 'Post poll');
    ok.addEventListener('click', () => UI.busy(ok, null, async () => {
      await Y.sendPoll(ch, { question: q.value, options: opts });
      m.close();
      st.stick = true;
      schedule('msgs');
    }, err));
    const m = UI.modal({ title: `Create a poll in ${chName(ch)}`, cls: 'mid', body: [err,
      h('div', { class: 'field' }, h('label', { for: 'pl-q' }, 'Question'), q),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Options'), box, h('div', null, addBtn)),
      h('p', { class: 'muted', style: { fontSize: '13px', marginTop: '10px' } }, 'Everyone in this conversation gets one vote and can change it. Hover an option to see who picked it.')],
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok] });
  }

  /** Everyone, or privately to chosen people. "Add everyone in…" fills the list from a private channel or group,
   *  so an existing team can be the audience without keeping separate lists. */
  function newAnnouncementDialog(preset = {}) {
    let label = ''; // which group the list came from, for the super admin's activity feed
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const title = h('input', { class: 'input', id: 'an-title', maxlength: 120, placeholder: 'e.g. Office closed on Friday' });
    const text = h('textarea', { class: 'input', id: 'an-text', rows: 6, maxlength: String(Y.MAX_TEXT), placeholder: 'What do people need to know? Type @ to mention someone.' });
    const canPub = A.can('ann.post'), canPriv = A.can('ann.private');
    let priv = !canPub;
    // @mentions: anyone for an announcement to everyone; only the chosen people for a private one
    mentionField(text, () => (priv ? A.activeUsers().filter(u => pp.picked.has(u.id)) : A.activeUsers()));
    // pictures (1.15): shown under the text, encrypted with the announcement when it's private
    const pics = [];
    const picBox = h('div', { class: 'chips ann-pick hidden' });
    const picInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/bmp', multiple: true, class: 'hidden', onchange: () => { addPics(picInput.files); picInput.value = ''; } });
    const picBtn = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => picInput.click() }, icon('image'), 'Add pictures');
    function drawPics() {
      UI.set(picBox, pics.map((f, i) => h('span', { class: 'chip-img', title: `${f.name} · ${U.formatSize(f.size)}` },
        h('img', { src: localUrl(f), alt: f.name }),
        h('button', { class: 'chip-img-x', type: 'button', 'aria-label': 'Remove ' + f.name, onclick: () => { forgetLocalUrl(f); pics.splice(i, 1); drawPics(); } }, icon('x')))));
      picBox.classList.toggle('hidden', !pics.length);
      picBtn.disabled = pics.length >= Y.MAX_ANN_FILES;
    }
    function addPics(list) {
      for (const f of Array.from(list)) {
        if (!isLocalImage(f)) { UI.toast(`“${f.name}” isn’t a picture. Announcements can have PNG, JPG, GIF, WebP or BMP pictures.`, 'error'); continue; }
        if (f.size > Y.MAX_FILE) { UI.toast(`“${f.name}” is ${U.formatSize(f.size)}. The limit is 5 MB.`, 'error'); continue; }
        if (pics.length >= Y.MAX_ANN_FILES) { UI.toast(`You can add up to ${Y.MAX_ANN_FILES} pictures.`, 'error'); break; }
        if (pics.some(x => x.name === f.name && x.size === f.size)) continue;
        pics.push(f);
      }
      drawPics();
    }
    text.addEventListener('paste', e => {
      const files = Array.from(e.clipboardData ? e.clipboardData.files : []);
      if (files.length) { e.preventDefault(); addPics(files); }
    });
    const ok = h('button', { class: 'btn btn-primary' }, icon('megaphone'));
    // admins can only send private announcements inside their own group; the super admin to anyone
    const scope = Y.announceTeam();
    const allowed = id => Y.canAnnounceTo(id);
    const all = A.activeUsers().filter(u => u.id !== meId() && allowed(u.id)).length;
    const count = h('div', { class: 'hint' });
    // "Send to": group chips stay selected (and show who they add); people can also be ticked one by one below
    const teams = A.teamList().filter(t => scope === null || t.id === scope);
    const sources = teams.map(t => ({ key: 'team:' + t.id, name: t.name, team: true,
      ids: () => A.teamMembers(t.id).map(u => u.id).filter(id => id !== meId()),
      waiting: () => A.teamPending().filter(u => A.teamRequest(u.id) === t.id && u.id !== meId()).length }))
      .concat(Array.from(Y.chans.values()).filter(c => c.kind === 'group' && c.groupName && Y.members(c).some(id => id !== meId() && allowed(id)))
        .sort((a, b) => chName(a).localeCompare(chName(b)))
        .map(c => ({ key: c.id, name: chName(c), ids: () => Y.members(c).filter(id => id !== meId() && allowed(id)), waiting: () => 0 })));
    const scopeNote = scope === null ? null : h('div', { class: 'note note-info', style: { marginBottom: '10px' } }, icon('lock'), h('div', null, scope
      ? [h('b', null, `Only ${A.teamName(scope)}. `), `As an admin of ${A.teamName(scope)}, you can send private announcements to people in your group only. Ask the super admin to reach the other group.`]
      : [h('b', null, 'You don’t have a group yet. '), 'Private announcements go to people in your own group, so you can only post to everyone for now.']));
    const chosen = new Set();
    const chips = h('div', { class: 'sendto-chips', role: 'group', 'aria-label': 'Send to everyone in a group' });
    const sendto = h('div', { class: 'hint sendto' });
    const drawChips = () => {
      UI.set(chips, sources.map((s, i) => {
        const n = s.ids().length, on = chosen.has(s.key);
        return [i === teams.length && i > 0 ? h('span', { class: 'chip-sep', 'aria-hidden': 'true' }) : null, h('button', { type: 'button', class: 'chip' + (on ? ' on' : ''), 'aria-pressed': String(on), disabled: !n && !on,
          title: n ? (on ? 'Click to remove these people' : `Add everyone in ${s.name}`) : (s.waiting() ? `Nobody is accepted into ${s.name} yet (${s.waiting()} waiting)` : `Nobody else is in ${s.name}`),
          onclick: () => toggleSource(s) }, s.team ? icon('users') : null, `${s.name} · ${n}`, on ? icon('check') : null)];
      }));
      const parts = sources.filter(s => chosen.has(s.key));
      const waiting = parts.reduce((t, s) => t + s.waiting(), 0);
      UI.set(sendto, parts.length ? `Includes everyone in ${parts.map(s => s.name).join(', ')}.` : 'Pick a group, or tick people below.',
        waiting ? h('span', { class: 'sendto-warn' }, ` ${waiting} ${waiting === 1 ? 'person is' : 'people are'} still waiting for an admin to accept their group and won’t get it.`) : null);
    };
    function toggleSource(s) {
      if (chosen.has(s.key)) {
        chosen.delete(s.key);
        const keep = new Set(sources.filter(x => chosen.has(x.key)).flatMap(x => x.ids()));
        pp.remove(s.ids().filter(id => !keep.has(id)));
      } else {
        chosen.add(s.key);
        const ids = s.ids();
        if (!ids.length) UI.toast(`Nobody else is in ${s.name} yet.`);
        pp.add(ids);
      }
      label = sources.filter(x => chosen.has(x.key)).map(x => x.name).join(', ').slice(0, 80);
      drawChips();
    }
    const update = () => {
      ok.lastChild && ok.lastChild.nodeType === 3 ? ok.lastChild.remove() : null;
      ok.appendChild(document.createTextNode(priv ? `Send to ${pp.picked.size} ${pp.picked.size === 1 ? 'person' : 'people'}` : 'Post to everyone'));
      ok.disabled = priv && !pp.picked.size;
      count.textContent = pp.picked.size ? `${pp.picked.size} ${pp.picked.size === 1 ? 'person' : 'people'} chosen` : 'Nobody chosen yet.';
    };
    const pp = peoplePicker({ multi: true, max: Math.max(all, 1), onChange: update, only: allowed });
    pp.el[0].removeAttribute('autofocus');
    drawChips();
    const people = h('div', { class: 'field hidden' }, scopeNote, h('span', { class: 'label' }, 'Send to'), chips, sendto,
      h('div', { class: 'row', style: { justifyContent: 'space-between', margin: '10px 0 2px' } }, h('span', { class: 'label', style: { margin: 0 } }, 'People'), count), pp.el);
    const hint = h('div', { class: 'hint' });
    const seg = h('div', { class: 'vis-seg', role: 'radiogroup', 'aria-label': 'Who gets it' });
    const drawSeg = () => {
      UI.set(seg, [['all', 'users', 'Everyone', 'All staff in the workspace'], ['private', 'lock', 'Chosen people', 'Only them, encrypted']].filter(([v]) => (v === 'all' ? canPub : canPriv)).map(([v, ic, t, sub]) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(priv === (v === 'private')), onclick: () => { priv = v === 'private'; drawSeg(); } },
          icon(ic), h('span', null, h('b', null, t), h('span', { class: 'sub' }, sub)))));
      people.classList.toggle('hidden', !priv);
      UI.set(hint, priv
        ? 'Only the people chosen get the pop-up and can read it; it’s encrypted for them, so nobody else can read it, not even other admins. It stays in their Announcements for a year. '
        : 'Everyone sees it in a pop-up within a few seconds, and it stays in Announcements for a year. It isn’t encrypted: anyone with access to the shared drive can read it. ',
      h('button', { class: 'link-btn', type: 'button', onclick: () => privacyDialog('announcements') }, 'Who can read it?'));
      update();
    };
    drawSeg();
    if (preset.team) { priv = true; drawSeg(); const s = sources.find(x => x.key === 'team:' + preset.team); if (s) toggleSource(s); }
    ok.addEventListener('click', () => UI.busy(ok, null, async () => {
      const n = pp.picked.size;
      const id = await Y.postAnnouncement({ title: title.value, text: text.value, to: priv ? Array.from(pp.picked) : undefined, label, files: pics });
      const f = feedOf(Y.announcements.get(id));
      m.close(); UI.toast(priv ? `Announcement sent to ${n} ${n === 1 ? 'person' : 'people'}` + (f ? ` · in ${feedName(f)}` : '') : 'Announcement posted', 'ok');
      if (isAnn() && annFeed() !== f) Chat.open(annKey(f));
    }, err));
    const m = UI.modal({ title: 'New announcement', cls: 'mid', body: [err,
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Who gets it'), seg),
      people,
      h('div', { class: 'field' }, h('label', { for: 'an-title' }, 'Title (optional)'), title),
      h('div', { class: 'field' }, h('label', { for: 'an-text' }, 'Message'), text, picBox,
        h('div', { class: 'row', style: { gap: '8px', margin: '6px 0 2px' } }, picBtn, h('span', { class: 'hint', style: { margin: 0 } }, `Up to ${Y.MAX_ANN_FILES} pictures, 5 MB each. You can also paste them.`), picInput),
        hint)],
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok],
    onClose: () => { pics.forEach(forgetLocalUrl); closeMention(); } });
    title.focus();
  }

  /* ---- my group ---- */
  /** Pick or type my group. Mandatory once for profiles made before groups existed (can't be dismissed). */
  /** Anyone without a group (accepted or waiting) must pick one before using the app. Checked at start-up and
   *  whenever profiles or the workspace change, so people who were already signed in are asked too. */
  function askTeamIfNeeded() {
    if (!el.root || !A.me || !A.needsTeam() || st.teamAsk) return false;
    chooseTeamDialog({ mandatory: true });
    return true;
  }

  function chooseTeamDialog({ mandatory }) {
    if (mandatory) st.teamAsk = true;
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
    onClose: () => {
      if (mandatory && !saved && A.needsTeam() && el.root && !st.unmounting) { setTimeout(() => chooseTeamDialog({ mandatory: true }), 0); return; }
      if (mandatory) { st.teamAsk = false; if (saved && el.root) askSetupIfNeeded().then(shown => { if (!shown && el.root) showWhatsNew(); }); }
    } });
  }

  /* ---- mandatory: real name + security question ----
   * Every profile needs both. Profiles made before this (or after an admin reset, which clears the question and
   * leaves the real name sealed to the old keys) are asked once after sign-in; the dialog can't be dismissed. */
  async function askSetupIfNeeded() {
    if (!el.root || !A.me || st.setupAsk || st.teamAsk) return false;
    st.setupAsk = true; // reserve while checking, so two callers can't open it twice
    let needQ = false, needName = false;
    try {
      [needQ, needName] = await Promise.all([A.hasRecovery(meId()).then(x => !x), A.hasRealName().then(x => !x)]);
    } catch { /* can't read the share right now: ask next time */ }
    if (!el.root || (!needQ && !needName)) { st.setupAsk = false; return false; }
    setupDialog(needQ, needName);
    return true;
  }

  function setupDialog(needQ, needName) {
    st.setupAsk = true;
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const real = h('input', { class: 'input', id: 'su-real', maxlength: 60, autocomplete: 'name', placeholder: 'e.g. Maria Santos' });
    const cur = h('input', { class: 'input', type: 'password', id: 'su-cur', autocomplete: 'current-password' });
    const q = h('input', { class: 'input', id: 'su-q', maxlength: 120, autocomplete: 'off', placeholder: 'e.g. What was the name of my first manager?' });
    const a = h('input', { class: 'input', type: 'password', id: 'su-a', autocomplete: 'off' });
    let saved = false;
    const ok = h('button', { class: 'btn btn-primary' }, 'Save and continue');
    ok.addEventListener('click', () => UI.busy(ok, 'Saving…', async () => {
      // check everything first, so nothing is half-saved
      const rn = needName ? A.validateRealName(real.value) : null;
      if (needQ) {
        A.validateRecovery(q.value, a.value);
        try { await A.setRecovery(cur.value, q.value, a.value); } catch (e) { if (e.code === 'BAD_PASSWORD') throw new Error('Your password isn’t right.'); throw e; }
        needQ = false;
      }
      if (rn) { const me = A.users.get(meId()); await A.updateProfile({ name: me.name, animal: me.animal, color: me.color, realName: rn }); needName = false; }
      saved = true; m.close(); UI.toast('Profile complete. Thanks!', 'ok');
    }, err));
    const m = UI.modal({ title: 'Finish your profile', cls: 'mid must', body: [err,
      h('p', { class: 'muted', style: { fontSize: '14px', marginTop: 0 } }, 'Every profile now needs ' +
        (needQ && needName ? 'a real name and a security question' : needName ? 'a real name' : 'a security question') + '. This takes a minute and you only do it once.'),
      needName ? h('div', { class: 'field' }, h('label', { for: 'su-real' }, 'Real name'), real,
        h('div', { class: 'hint row', style: { gap: '6px' } }, icon('lock'), 'Only admins and the super admin can see it. Everyone else sees your display name.')) : null,
      needQ ? [
        h('div', { class: 'note note-info', style: { marginBottom: '14px' } }, icon('key'), h('div', null, h('b', null, 'Your security question is a second password. '),
          'If you forget your password, “Forgot password?” on the sign-in screen and this answer get you back in with all your messages and work. Admins can’t use it.')),
        h('div', { class: 'field' }, h('label', { for: 'su-cur' }, 'Your password'), cur),
        h('div', { class: 'field' }, h('label', { for: 'su-q' }, 'Security question'), q),
        h('div', { class: 'field' }, h('label', { for: 'su-a' }, 'Answer'), a,
          h('div', { class: 'hint' }, `At least ${A.MIN_ANSWER} characters. Capitals and extra spaces don’t matter. Pick something coworkers couldn’t guess or look up.`)),
      ] : null],
    foot: [h('button', { class: 'btn', onclick: () => SC.app.lock() }, 'Sign out'), ok],
    onClose: () => {
      if (!saved && el.root && !st.unmounting && A.me) { setTimeout(() => setupDialog(needQ, needName), 0); return; }
      st.setupAsk = false;
      if (saved && el.root) showWhatsNew();
    } });
    setTimeout(() => (needName ? real : cur).focus(), 0);
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
        ['Post to everyone', 'A pop-up for all staff, kept in Announcements for a year. Add pictures and @mention people (they get a notification). You can see who has read it.', openIn('New announcement', newAnnouncementDialog), 'ann.post'],
        ['Announce privately', 'Send it only to chosen people (encrypted for them). Use “Add everyone in…” to send to a whole private channel or group at once.', openIn('New announcement', newAnnouncementDialog), 'ann.private'],
        ['Withdraw an announcement', 'It disappears for everyone.', where('Announcements → hover it → 🗑'), 'ann.withdraw'],
      ]],
      ['Channels', 'hash', [
        ['Create a public channel', 'Everyone can read and post.', openIn('Create a channel', () => newChannelDialog()), 'ch.create'],
        ['Create a private channel', `Invite-only and encrypted, up to ${Y.MAX_GROUP} people. History is kept. Not even other admins can read it unless invited.`, openIn('Create a private channel', () => newChannelDialog({ private: true })), 'ch.createPrivate'],
        ['Make a channel private', 'Creates a private copy for the people you choose and archives the public one.', where('Channel → ⓘ Details → Make private'), 'ch.makePrivate'],
        ['Invite or remove people in a private channel', 'The creator and channel admins manage members; the creator picks channel admins.', where('Private channel → ⓘ Details → Add people / Remove'), 'ch.createPrivate'],
        ['Rename, describe, archive, export', 'Archived channels stay readable from Admin settings → Channels.', where('Channel → ⓘ Details'), 'ch.manage'],
      ]],
      ['In conversations', 'message', [
        ['Create a poll', 'In any conversation you’re in. Everyone gets one vote and can change it.', where('Chart button next to 📎 in the message box'), 'msg.poll'],
        ['Pin messages', 'Shown in a bar at the top of the channel. Group creators and group admins can pin in their groups too.', where('Hover a message → 📌'), 'msg.pin'],
        ['Hide a message in a channel', 'Everyone sees “Message hidden”.', where('Hover a message → eye icon'), 'msg.hide'],
      ]],
      ['Groups and project boards', 'users', [
        ['Accept someone’s group', A.ownGroupOnly('grp.accept') ? `Only for ${A.teamName(A.teamOf(meId())) || 'your own group'}. A group only counts once it’s accepted, so a wrong pick never shows someone another group’s messages.` : 'Everyone picks a group when they make their profile. It only counts once it’s accepted, so a wrong pick never shows them another group’s messages.', openIn('Review groups', () => adminDialog('people')), 'grp.accept'],
        ['Move someone to another group', 'If they picked the wrong one, put them in the right group.', where('Admin settings → People → Change'), 'grp.accept'],
        ['Manage the project board', A.ownGroupOnly('board.manage') ? 'Create, assign, move, approve and receive projects on your group’s board.' : 'Create, assign, move, approve and receive projects on every group’s board.', where('Sidebar → Project boards'), 'board.manage'],
        ['Announce to one group', 'New announcement → Chosen people → Group name.', openIn('New announcement', newAnnouncementDialog), 'ann.private'],
        ['Add events to the calendar', A.isOwner() ? 'For everyone or for one group. Everyone sees them under the calendar button next to the bell.' : 'For everyone or for your own group. Everyone sees them under the calendar button next to the bell.', openIn('Open the calendar', () => KV.open()), 'cal.manage'],
      ]],
      ['People', 'users', [
        ['Reset a password', 'Gives them a temporary password. Their direct messages from before the reset can’t be opened any more.', openIn('Admin settings', adminDialog), 'ppl.reset'],
        ['Remove someone', 'They can’t sign in any more and disappear from the sign-in list. Their channel messages stay.', openIn('Admin settings', adminDialog), 'ppl.remove'],
        ['See what admins did', 'Every rename, archive, reset and removal, with who did it.', where('Admin settings → Activity'), 'log.view'],
      ]],
    ].map(([title, ic, rows]) => [title, ic, rows.filter(r => A.can(r[3]))]).filter(([, , rows]) => rows.length);
    const custom = !A.isAdmin() && A.customRoleOf(meId());
    if (owner) sections.push(['Only you, the super admin', 'shield', [
      ['Roles and permissions', 'See what every role can do, create roles like Moderator, and give them to people. Only you can.', openIn('Roles', () => adminDialog('roles'))],
      ['Appoint or remove admins', 'Admins can do everything above. They can’t manage other admins.', openIn('Admin settings', adminDialog)],
      ['Workspace settings', 'Workspace name and auto-lock time.', where('Admin settings → Settings')],
      ['Feedback inbox', 'Staff feedback, encrypted so only you can read it.', where('Sidebar → Feedback inbox')],
      ['Check the app files', 'Detects if anyone changed the app’s code on the shared drive.', where('Admin settings → App files')],
      ['Security question', 'Lets you recover your own password. Nobody else can reset yours.', openIn('Set it', recoveryDialog)],
    ]]);
    const m = UI.modal({ title: owner ? 'Super admin guide' : custom ? 'Role guide' : 'Admin guide', cls: 'mid guide', body: [
      h('p', { class: 'muted', style: { marginTop: 0 } }, 'What you can do as ' + (owner ? 'the super admin' : custom ? `${article(custom.name)} ${custom.name}` : 'an admin') + '. Click a button to try it, or follow the hint.'),
      custom ? h('div', { class: 'note note-info' }, icon('shield'), h('div', null, h('b', null, `${custom.name}${custom.desc ? ': ' + custom.desc : ''}`),
        h('div', null, 'The super admin chose these rights for your role. Password resets, removing people and real names stay with admins.'))) : null,
      sections.length ? null : h('p', null, 'Your role has no permissions right now.'),
      sections.map(([title, ic, rows]) => h('section', { class: 'guide-sec' },
        h('h3', null, icon(ic), title),
        rows.map(([t, d, action]) => h('div', { class: 'guide-row' }, h('div', null, h('div', { class: 'guide-t' }, t), h('div', { class: 'guide-d' }, d)), action)))),
      h('p', { class: 'muted', style: { fontSize: '13px' } }, 'Nobody, including admins, can read direct messages, group chats or private channels they aren’t in.')],
    foot: [h('button', { class: 'btn btn-primary', onclick: () => m.close() }, 'Got it')] });
  }
  Chat.adminGuide = adminGuide;

  /* ---- admin ---- */
  function adminDialog(start) {
    const allowed = adminTabs();
    if (!allowed.length) return;
    let tab = typeof start === 'string' && allowed.includes(start) ? start : allowed[0];
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const panel = h('div', { role: 'tabpanel' });
    const tabBtn = (id, label) => h('button', { role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = id; draw(); } }, label);
    const owner = A.isOwner();
    const LABELS = { people: 'People', roles: 'Roles', channels: 'Channels', activity: 'Activity', settings: 'Settings', backup: 'Backups', files: 'App files' };
    function draw() {
      UI.set(tabs, allowed.map(id => tabBtn(id, LABELS[id])));
      UI.set(panel, ({ people, roles, channels, activity, settings, backup, files })[tab]());
    }
    function backup() {
      const BK = SC.backup;
      const s = BK.state();
      const err = h('div', { class: 'form-error hidden', role: 'alert' });
      const when = ts => new Date(ts).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
      const statusText = {
        off: 'Off: no backup folder chosen on this PC',
        ok: 'On: checks every hour while you’re signed in, and saves only what changed',
        running: 'Backing up now…' + (s.progress ? ' ' + s.progress : ''),
        needsPermission: 'Paused: the browser needs your OK to open the backup folder',
        error: 'Last backup failed',
      }[s.status] || 'Checking…';
      const choose = h('button', { class: 'btn' + (s.folder ? '' : ' btn-primary') }, icon('folder'), s.folder ? 'Change backup folder' : 'Choose backup folder');
      choose.addEventListener('click', () => UI.busy(choose, null, async () => { if (await BK.choose()) UI.toast('Backup folder saved. Today’s backup is done.', 'ok'); draw(); }, err));
      const now = s.folder ? h('button', { class: 'btn btn-primary' }, icon(s.status === 'needsPermission' ? 'key' : 'download'), s.status === 'needsPermission' ? 'Allow and back up now' : 'Back up now') : null;
      if (now) now.addEventListener('click', () => UI.busy(now, 'Backing up…', async () => { const r = await BK.runNow({ ask: true }); if (r) UI.toast(r.changed ? `Backed up ${r.changed} changed file${r.changed === 1 ? '' : 's'} into ${r.name}` : 'Nothing changed since the last backup', 'ok'); draw(); }, err));
      const off = s.folder ? h('button', { class: 'btn btn-danger' }, 'Turn off') : null;
      if (off) off.addEventListener('click', async () => {
        if (!(await UI.confirm({ title: 'Turn off backups?', ok: 'Turn off', danger: true, text: 'This PC stops checking for changes. Backups already in the folder are kept. (The Windows task, if you set one up, keeps running.)' }))) return;
        await BK.turnOff(); draw();
      });
      return h('div', null, err,
        h('p', { class: 'muted', style: { fontSize: '14px' } }, 'Every hour the app compares the data folder with today’s backup. If nothing changed, nothing is written. If something changed, the new and changed files are copied into today’s folder (data-YYYY-MM-DD), and each new day gets a new folder. Files are never deleted from a day’s backup. If the data folder is ever emptied or deleted, the app asks for a backup when it opens and copies it back into data, so it keeps working on its own copy and the backup stays as it is.'),
        h('dl', { class: 'kv' },
          h('dt', null, 'Backup folder'), h('dd', null, s.folder || 'Not chosen'),
          h('dt', null, 'Status'), h('dd', null, statusText),
          s.error && s.status === 'error' ? [h('dt', null, 'Error'), h('dd', null, s.error)] : null,
          h('dt', null, 'Last checked'), h('dd', null, s.lastCheck ? when(s.lastCheck) : 'Not yet'),
          h('dt', null, 'Last change saved'), h('dd', null, s.last ? `${when(s.last.ts)} · ${s.last.name}${s.last.changed ? ` · ${s.last.changed} file${s.last.changed === 1 ? '' : 's'} updated` : ''}${s.last.bytes != null ? ` · ${BK.formatSize(s.last.bytes)} in all` : ''}` : 'None yet'),
          h('dt', null, 'Kept'), h('dd', null, `One folder per day, for ${BK.KEEP_DAYS} days`)),
        h('div', { class: 'note note-info' }, icon('alert'), h('div', null,
          h('b', null, 'Pick a folder outside the SankyoChat folder, '), 'e.g. make “SankyoChat-Backups” next to it on the shared storage. Then deleting the app folder or the data folder can’t delete the backups. ',
          h('b', null, 'When your app is closed, '), 'the browser can’t back up. To keep backing up then, set up the Windows task once on the file server or a PC that’s always on: double-click ', h('code', null, 'backup\\1 Set up hourly backup.bat'), ' in the SankyoChat folder and give it the same backup folder. It writes the same daily folders, and also runs when nobody is signed in to Windows.')),
        h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', marginTop: '12px' } }, choose, now, off));
    }
    function roles() { return SC.rolesUI.render(draw); }
    function people() {
      const RU = SC.rolesUI;
      // people waiting for their group first, then by name
      const users = Array.from(A.users.values()).sort((a, b) => (!!A.teamRequest(b.id) - !!A.teamRequest(a.id)) || a.name.localeCompare(b.name));
      const mine = A.teamName(A.teamOf(meId()));
      const intro = h('p', { class: 'muted', style: { fontSize: '14px' } }, owner
        ? 'You are the super admin. Give each person a role here: Staff, Admin, or a role you made in the Roles tab. There’s always exactly one super admin; Admin and custom roles have no limit.'
        : A.isAdmin() ? 'As an admin you can reset passwords and remove regular staff. Only the super admin can change roles.'
          : A.ownGroupOnly('grp.accept') ? `Your role lets you accept and move people for ${mine || 'your own group'}.` : 'Your role lets you accept people’s groups and move them between groups.');
      return h('div', null, intro, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'Person'), h('th', null, 'Role'), h('th', null, 'Group'), h('th', null, 'Status'), h('th', null, 'Joined'), h('th', null, ''))),
        h('tbody', null, users.map(u => {
          const removed = A.isRemoved(u.id);
          const p = Y.presenceOf(u.id);
          const role = A.roleLabel(u.id);
          const isAdm = A.isUserAdmin(u.id);
          const canManage = u.id !== meId() && !removed && u.id !== A.ws.adminId && (owner || !isAdm);
          const canTeam = !removed && A.canAcceptTeam(u.id);
          return h('tr', { class: owner && RU.rowDirty(u.id) ? 'rl-dirty' : null },
            h('td', null, h('span', { class: 'row' }, UI.avatar(u, 28), u.name)),
            h('td', null, removed ? '—' : owner ? RU.roleSelect(u, draw) : role ? h('span', { class: 'rl-pill', style: { '--rc': A.roleColorOf(u.id) || 'var(--muted)' } }, role) : h('span', { class: 'muted' }, 'Staff')),
            h('td', { class: 'team-cell' }, removed ? '—' : [
              h('div', null, A.teamName(A.teamOf(u.id)) || h('span', { class: 'muted' }, 'None')),
              A.teamRequest(u.id) ? h('div', { class: 'team-req' }, 'Requested: ', h('b', null, A.teamName(A.teamRequest(u.id)))) : null,
              canTeam ? h('div', { class: 'row', style: { gap: '4px', marginTop: '4px' } },
                A.teamRequest(u.id) ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => setTeam(u, A.teamRequest(u.id)) }, icon('check'), 'Accept') : null,
                h('button', { class: 'btn btn-sm', onclick: () => changeTeam(u) }, 'Change')) : null]),
            h('td', null, removed ? h('span', { class: 'pill grey' }, 'Removed') : h('span', { class: 'row', style: { gap: '6px' } }, UI.dot(p.state), UI.stateLabel(p.state))),
            h('td', null, new Date(u.created).toLocaleDateString()),
            h('td', { class: 'act' }, canManage ? [
              A.can('ppl.reset') ? h('button', { class: 'btn btn-sm', onclick: () => resetPw(u) }, icon('key'), 'Reset password') : null, ' ',
              A.can('ppl.remove') ? h('button', { class: 'btn btn-sm btn-danger', onclick: () => removeUser(u) }, icon('userX'), 'Remove') : null] : null));
        }))), owner ? RU.saveBar(draw) : null);
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
      // the super admin also sees admins' private channels, group chats and private announcements (audit records)
      const audits = owner ? Array.from(A.auditLog.values()).map(a => ({ ts: a.ts, userId: a.userId, valid: true,
        text: N.describe({ type: 'aud', kind: a.kind, actor: a.userId, count: a.count, name: a.name, title: a.title, label: a.label }).title.replace(A.name(a.userId) + ' ', '') })) : [];
      const list = Array.from(A.adminLog.values()).map(a => Object.assign({ text: describe(a) }, a)).concat(audits).sort((a, b) => b.ts - a.ts).slice(0, 200);
      if (!list.length) return h('p', { class: 'muted' }, 'No admin actions yet. Renames, archives, password resets and removals show up here.');
      return h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Who'), h('th', null, 'What'))),
        h('tbody', null, list.map(a => h('tr', null,
          h('td', { class: 'muted' }, U.formatDateTime(a.ts)),
          h('td', null, A.name(a.userId), (r => (r ? h('span', { class: 'muted' }, ` (${r})`) : null))(a.kid ? A.roleNameAt(a.userId, a.kid, a.ts) : A.roleLabel(a.userId))),
          h('td', null, a.text, a.valid ? null : [' ', h('span', { class: 'pill grey', title: 'Not allowed for this person, so every app ignores it' }, 'Ignored')])))));
    }
    async function resetPw(u) {
      const temp = U.rand(4, 'abcdefghjkmnpqrstuvwxyz') + '-' + U.rand(4, '23456789') + '-' + U.rand(4, 'abcdefghjkmnpqrstuvwxyz');
      const hasQ = await A.hasRecovery(u.id).catch(() => false);
      const ok = await new Promise(resolve => {
        let result = false;
        const typed = h('input', { class: 'input', id: 'rp-confirm', autocomplete: 'off', placeholder: u.name });
        const go = h('button', { class: 'btn btn-danger', disabled: true, onclick: () => { result = true; m.close(); } }, hasQ ? 'Reset anyway' : 'Reset password');
        typed.addEventListener('input', () => { go.disabled = typed.value.trim().toLowerCase() !== u.name.toLowerCase(); });
        const m = UI.modal({ title: `Reset ${u.name}’s password?`, cls: 'mid', onClose: () => resolve(result), body: [
          hasQ ? h('div', { class: 'note note-info' }, icon('key'), h('div', null, h('b', null, `${u.name} has a security question. `),
            'Ask them to click “Forgot password?” on the sign-in screen instead. That keeps all their messages. Only reset if they’ve forgotten the answer too.')) : null,
          h('div', { class: 'note note-warn', style: { marginBottom: '14px' } }, icon('alert'), h('div', null, h('b', null, 'This can’t be undone. '), `${u.name} gets new security keys, so:`,
            h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } },
              h('li', null, 'their direct messages from before the reset can’t be opened any more (by them or anyone else)'),
              h('li', null, 'their security question is deleted, and they must set a new one'),
              h('li', null, 'they must enter their real name again'),
              h('li', null, 'they must choose a new password with the temporary one you give them')))),
          h('div', { class: 'field' }, h('label', { for: 'rp-confirm' }, `Type ${u.name} to confirm`), typed)],
          foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), go] });
        setTimeout(() => typed.focus(), 0);
      });
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
        ok, groupNames(), updateSection());
    }
    function updateSection() {
      const on = !!A.maintenance();
      const msg = h('input', { class: 'input', id: 'ad-maint', maxlength: 200, placeholder: 'Optional message, e.g. “Back in 10 minutes.”' });
      const btn = h('button', { class: on ? 'btn' : 'btn btn-danger' }, icon('refresh'), on ? 'Finish update' : 'Start update');
      btn.addEventListener('click', async () => {
        if (on) { m.close(); return finishUpdate(); }
        if (!(await UI.confirm({ title: 'Start update mode?', ok: 'Disconnect everyone', danger: true,
          text: 'Within a few seconds everyone else sees “Sankyo Chat is being updated” and stops reading or writing the shared drive. Messages they were typing stay on their PC. When you click Finish update, their app reloads with the new files.' }))) return;
        try { await A.setMaintenance(true, msg.value); m.close(); UI.toast('Update mode is on. Now click Open the updater.', 'ok'); schedule('banners'); } catch (e) { UI.toast(e.message, 'error'); }
      });
      return h('div', { class: 'group-names' }, h('h3', null, 'Update the app'),
        h('p', { class: 'muted', style: { fontSize: '13px' } }, on
          ? 'Update mode is on: everyone else is disconnected. Click Open the updater, choose the update package and install it. When the updater says it’s installed, click Finish update.'
          : 'Updating takes three steps: Start update (everyone is told and disconnected, so nobody writes to the share while files change), Open the updater to install the new version, then Finish update. Apps older than 1.9 don’t know update mode: the first time, ask people to reload.'),
        on ? null : h('div', { class: 'field' }, h('label', { for: 'ad-maint' }, 'Message to show'), msg),
        h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, btn, on ? updaterLink('btn btn-primary') : null),
        h('p', { class: 'hint', style: { marginTop: '10px' } }, 'Open the updater does nothing? On this PC, open the SankyoChat folder → update and double-click “Set up updater button” once. When the browser asks to open Windows PowerShell, tick “Always allow” and click Open. The updater is also in that folder: “Update Sankyo Chat”.'));
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
    // unsaved role changes: offer to save them when the dialog closes
    const m = UI.modal({ title: 'Admin settings', cls: 'wide', body: [tabs, panel], onClose: async () => {
      if (!owner || !SC.rolesUI.dirty()) { SC.rolesUI.reset(); return; }
      const n = SC.rolesUI.changes().length;
      const save = await UI.confirm({ title: `Save ${n} role change${n === 1 ? '' : 's'}?`, ok: 'Review and save', text: 'You changed roles but didn’t save. If you don’t, the changes are discarded and nobody sees them.' });
      if (save) await SC.rolesUI.review(() => {});
      SC.rolesUI.reset();
    } });
    draw();
  }

  /* ================= Groups (PICKUP / INPUT) member panel ================= */

  /** My group changed (or I'm no longer the super admin): don't keep showing another group's board. */
  function leaveHiddenBoard() {
    if (!isBoard() || B.canSee(openBoardId())) return false;
    UI.closeAll();
    UI.toast('That project board is only for its own group.');
    Chat.open(Y.chans.has('general') ? 'general' : Array.from(Y.chans.keys())[0]);
    return true;
  }

  function openBoard(team) {
    // an old '@board' link, or a board I can no longer see: fall back to the first one I can
    if (!B.canSee(team)) { const first = B.boards()[0]; if (!first) { UI.toast('Your project board appears once an admin accepts your group.'); return; } team = first.id; }
    if (el.ta && st.openId) st.drafts[st.openId] = el.ta.value;
    st.openId = BOARD + team;
    Y.openId = null;
    U.ls.set('lastOpen.' + A.ws.id, st.openId);
    st.editingId = null;
    el.root.classList.remove('side-open');
    UI.closePopover();
    renderSidebar(); renderHeader(); renderKeyNotice(); buildComposer(); renderMessages(); renderPins();
  }

  function openTeam(tid) {
    if (!A.teamList().some(t => t.id === tid)) return;
    if (el.ta && st.openId) st.drafts[st.openId] = el.ta.value;
    st.openId = TEAM + tid;
    Y.openId = null;
    U.ls.set('lastOpen.' + A.ws.id, st.openId);
    st.editingId = null;
    st.teamBuilt = null;
    el.root.classList.remove('side-open');
    UI.closePopover();
    renderSidebar(); renderHeader(); renderKeyNotice(); buildComposer(); renderMessages(); renderPins();
  }

  function renderTeam() {
    const box = el.msgs;
    if (!box) return;
    const tid = openTeamId();
    if (st.teamBuilt !== tid || !box.querySelector('.team-view')) {
      const q = h('input', { class: 'input', type: 'search', placeholder: 'Search members', 'aria-label': 'Search members' });
      const list = h('div', { class: 'team-list', role: 'list' });
      q.addEventListener('input', () => drawTeamList());
      UI.set(box, h('div', { class: 'team-view' }, h('div', { class: 'team-search' }, q), list));
      st.teamEls = { q, list };
      st.teamBuilt = tid;
      box.scrollTop = 0;
    }
    drawTeamList();
  }

  function drawTeamList() {
    const { q, list } = st.teamEls || {};
    if (!list) return;
    const tid = openTeamId();
    const s = q.value.trim().toLowerCase();
    const rank = { online: 0, away: 1, offline: 2 };
    const members = A.teamMembers(tid).filter(u => !s || u.name.toLowerCase().includes(s))
      .sort((a, b) => rank[Y.presenceOf(a.id).state] - rank[Y.presenceOf(b.id).state] || a.name.localeCompare(b.name));
    const row = (u, extra) => {
      const p = Y.presenceOf(u.id);
      const role = A.roleLabel(u.id);
      return h('div', { class: 'team-row', role: 'listitem', 'data-user': u.id },
        h('button', { class: 'team-who', 'data-action': 'profile', 'aria-label': `${u.name}, ${UI.stateLabel(p.state)}. Open profile` },
          h('span', { class: 'av-wrap' }, UI.avatar(u, 38), UI.dot(p.state)),
          h('span', { class: 'who' },
            h('span', { class: 'nm' }, u.name + (u.id === meId() ? ' (you)' : ''), role ? h('span', { class: 'pill' + (role === 'Super admin' ? '' : ' grey') }, role) : null),
            h('span', { class: 'sub' }, [u.title, p.statusText || UI.stateLabel(p.state)].filter(Boolean).join(' · ')))),
        extra || (u.id !== meId() ? h('button', { class: 'btn btn-sm', 'data-action': 'dm' }, icon('message'), 'Message') : null));
    };
    const kids = [];
    if (!members.length) kids.push(h('div', { class: 'ann-empty' }, s ? 'No one matches.' : 'Nobody has been accepted into this group yet.'));
    kids.push(...members.map(u => row(u)));
    const waiting = A.teamPendingForMe().filter(u => A.teamRequest(u.id) === tid);
    if (waiting.length) {
      kids.push(h('div', { class: 'team-wait-head' }, h('span', { class: 'wait-dot' }), `Waiting for acceptance (${waiting.length}) · only people who can accept see this`));
      kids.push(...waiting.map(u => row(u, h('span', { class: 'row', style: { gap: '6px' } },
        h('button', { class: 'btn btn-sm btn-primary', 'data-action': 'accept' }, 'Accept'),
        h('button', { class: 'btn btn-sm', 'data-action': 'change' }, 'Change')))));
    }
    UI.set(list, ...kids);
  }

  async function onTeamClick(t) {
    const rowEl = t.closest('[data-user]');
    if (!rowEl) return;
    const id = rowEl.dataset.user;
    switch (t.dataset.action) {
      case 'profile': return profileDialog(id);
      case 'dm': return Chat.openUser(id);
      case 'accept':
        try { await A.assignTeam(id, A.teamRequest(id)); UI.toast(`${A.name(id)} is now in ${A.teamName(A.teamOf(id))}`, 'ok'); schedule('msgs', 'side', 'head'); } catch (e) { UI.toast(e.message, 'error'); }
        return;
      case 'change': return adminDialog('people');
    }
  }

  /* ================= notifications inbox ================= */

  function notificationsDialog() {
    if (st.inbox) return;
    let tab = 'all';
    const wasUnread = new Set(N.list().filter(N.isUnread).map(it => it.id));
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const list = h('div', { class: 'notif-list', role: 'list' });
    const canRequests = () => A.can('grp.accept') || Array.from(Y.chans.values()).some(c => c.kind === 'group' && Y.canManageGroup(c)) || N.list('requests').length > 0;
    const tabBtn = (id, label, n) => h('button', { role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = id; draw(); } }, label, n ? h('span', { class: 'tab-n' }, String(n)) : null);
    function row(it) {
      const d = N.describe(it);
      const unread = wasUnread.has(it.id) || N.isUnread(it);
      const u = it.actor ? A.users.get(it.actor) : null;
      const lead = u ? UI.avatar(u, 36) : h('span', { class: 'avatar ann-avatar', style: { width: '36px', height: '36px' } }, icon(it.type === 'removed' ? 'userX' : it.type === 'aud' || it.type === 'adm' ? 'shield' : 'bell'));
      const actions = [];
      if (it.type === 'request' && !it.done) {
        const yes = h('button', { class: 'btn btn-sm btn-primary' }, 'Approve');
        const no = h('button', { class: 'btn btn-sm' }, 'Decline');
        yes.addEventListener('click', e => { e.stopPropagation(); UI.busy(yes, null, async () => { await N.decide(it, true); UI.toast(`${A.name(it.who)} was added`, 'ok'); }).catch(ex => UI.toast(ex.message, 'error')); });
        no.addEventListener('click', e => { e.stopPropagation(); UI.busy(no, null, async () => { await N.decide(it, false); UI.toast('Request declined', 'ok'); }).catch(ex => UI.toast(ex.message, 'error')); });
        actions.push(yes, no);
      }
      if (it.type === 'team' && A.teamRequest(it.actor)) {
        const yes = h('button', { class: 'btn btn-sm btn-primary' }, 'Accept');
        yes.addEventListener('click', e => { e.stopPropagation(); UI.busy(yes, null, async () => { await A.assignTeam(it.actor, A.teamRequest(it.actor)); UI.toast('Group accepted', 'ok'); N.refresh(); }).catch(ex => UI.toast(ex.message, 'error')); });
        actions.push(yes, h('button', { class: 'btn btn-sm', onclick: e => { e.stopPropagation(); close(); adminDialog('people'); } }, 'Change'));
      }
      return h('div', { class: 'notif-row' + (unread ? ' unread' : '') + (it.done ? ' done' : ''), role: 'listitem', tabindex: '0',
        onclick: () => openNotification(it), onkeydown: e => { if (e.key === 'Enter' && e.target === e.currentTarget) openNotification(it); } },
      lead,
      h('div', { class: 'notif-main' },
        h('div', { class: 'notif-title' }, d.title),
        d.sub ? h('div', { class: 'notif-sub' }, d.sub) : null,
        actions.length ? h('div', { class: 'row notif-actions', style: { gap: '6px' } }, actions) : null),
      h('div', { class: 'notif-side' },
        h('div', { class: 'notif-time', title: 'Arrived ' + U.formatFull(it.at || it.ts) }, U.formatDateTime(it.at || it.ts)),
        unread ? h('span', { class: 'notif-dot', 'aria-label': 'Unread' }) : null));
    }
    function draw() {
      const reqN = N.pendingRequests();
      UI.set(tabs, tabBtn('all', 'All'), tabBtn('mentions', 'Mentions'), canRequests() ? tabBtn('requests', 'Requests', reqN) : null, A.isOwner() ? tabBtn('admin', 'Admin activity') : null);
      const items = N.list(tab);
      UI.set(list, items.length ? items.map(row) : h('div', { class: 'notif-empty' }, icon('check'), h('div', null, h('b', null, 'You’re all caught up.'),
        h('div', { class: 'muted' }, tab === 'admin' ? 'What admins do shows up here.' : tab === 'requests' ? 'Requests to join your groups show up here.' : 'Mentions, replies and group changes show up here.'))));
    }
    function openNotification(it) {
      N.markRead(it);
      const go = fn => { close(); fn(); };
      switch (it.type) {
        case 'mention': case 'reply': case 'here':
          if (!Y.chans.has(it.conv)) return UI.toast('That conversation is no longer available.');
          return go(() => Chat.open(it.conv, { scrollTo: it.msg, ts: it.ts }));
        case 'removed': return UI.toast('You’re no longer in it, so it can’t be opened.');
        case 'team': return go(() => adminDialog('people'));
        case 'newUser': return profileDialog(it.actor);
        case 'adm': case 'aud': return go(() => adminDialog('activity'));
        case 'ann': return go(() => Chat.open(ANN));
        case 'annMention': {
          const a = Y.announcements.get(it.ann);
          if (!a) return UI.toast('That announcement was deleted.');
          return go(() => Chat.open(annKey(feedOf(a))));
        }
        default:
          if (it.conv && Y.chans.has(it.conv)) return go(() => Chat.open(it.conv));
      }
    }
    const markAll = h('button', { class: 'btn btn-sm', onclick: () => { N.markAllRead(); wasUnread.clear(); draw(); } }, icon('check'), 'Mark all as read');
    const setBtn = h('button', { class: 'btn btn-sm', onclick: () => notifSettingsDialog() }, icon('settings'), 'Settings');
    const m = UI.modal({ title: 'Notifications', cls: 'mid notif-dlg', body: [h('div', { class: 'row notif-tools' }, N.isQuiet() ? h('span', { class: 'pill grey' }, icon('bellOff'), `Do not disturb until ${U.formatDateTime(N.dndUntil())}`) : null, h('span', { style: { flex: 1 } }), markAll, setBtn), tabs, list],
      onClose: () => { st.inbox = null; N.markAllRead(); } });
    const close = () => m.close();
    st.inbox = { draw };
    draw();
    N.markAllRead(); // opening the inbox counts as reading what's in it (the dots stay until it's closed)
    N.refresh();
  }

  function notifSettingsDialog() {
    const prefs = N.prefs();
    const cats = ['mentions', 'groups', 'requests', 'board', 'calendar'].concat(A.isOwner() ? ['admin'] : []);
    const box = k => {
      const cb = h('input', { type: 'checkbox', id: 'np-' + k, checked: prefs[k] !== false });
      cb.addEventListener('change', () => N.setPref(k, cb.checked));
      return h('label', { class: 'check', for: 'np-' + k }, cb, h('span', null, N.PREF_LABELS[k]));
    };
    const boxes = cats.map(box);
    const msgBoxes = ['dms', 'groupMsgs', 'channels'].map(box);
    const until = N.dndUntil();
    const tomorrow8 = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d.getTime(); };
    const dnd = h('select', { class: 'select', id: 'np-dnd', 'aria-label': 'Do not disturb' },
      h('option', { value: '0' }, until ? `On until ${U.formatDateTime(until)} (choose Off to end it)` : 'Off'),
      until ? h('option', { value: 'off' }, 'Off') : null,
      h('option', { value: String(60 * 60000) }, 'For 1 hour'),
      h('option', { value: String(2 * 60 * 60000) }, 'For 2 hours'),
      h('option', { value: 'tomorrow' }, 'Until tomorrow 8:00'));
    dnd.addEventListener('change', () => {
      const v = dnd.value;
      if (v === '0') return;
      N.setDnd(v === 'off' ? 0 : v === 'tomorrow' ? tomorrow8() : Date.now() + Number(v));
      UI.toast(v === 'off' ? 'Do not disturb is off' : `Do not disturb until ${U.formatDateTime(N.dndUntil())}`, 'ok');
      schedule('side');
      m.close();
    });
    const perm = SC.app.notificationState();
    const m = UI.modal({ title: 'Notification settings', cls: 'mid', body: [
      h('p', { class: 'muted', style: { fontSize: '14px', marginTop: 0 } }, 'The bell (top left) always keeps everything. These choose what also pops up on your desktop.'),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'New messages'), msgBoxes,
        h('div', { class: 'hint' }, 'Mentions and replies pop up anywhere if “Mentions and replies” is on. To silence one conversation, mute it: ⋯ next to it in the sidebar, or its Details.')),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Also pop up for'), boxes),
      h('div', { class: 'field' }, h('label', { for: 'np-dnd' }, 'Do not disturb'), dnd, h('div', { class: 'hint' }, 'Silences pop-ups and sounds. Unread counts and the bell still update.')),
      perm === 'granted' ? null : h('div', { class: 'note note-info' }, icon('bell'), h('div', null, perm === 'denied'
        ? 'Desktop notifications are blocked for this page. Allow them in the browser’s site settings (the lock icon next to the address).'
        : h('span', null, 'Desktop notifications are off. ', h('button', { class: 'link-btn', onclick: () => SC.app.requestNotifications() }, 'Turn them on'))))],
    foot: [h('button', { class: 'btn btn-primary', onclick: () => m.close() }, 'Done')] });
  }

  /* ================= Browse groups / suggest someone ================= */

  async function browseGroupsDialog() {
    const list = h('div', { class: 'people-list browse-list' }, h('div', { class: 'muted', style: { padding: '10px' } }, 'Looking for groups…'));
    const m = UI.modal({ title: 'Browse groups', cls: 'mid', body: [
      h('p', { class: 'muted', style: { fontSize: '14px', marginTop: 0 } }, 'Group chats and private channels whose admins let people ask to join. A group admin approves each request; you’ll get a notification.'), list] });
    let entries = [];
    try { entries = await N.browse(); } catch (e) { UI.set(list, h('div', { class: 'form-error' }, e.message)); return; }
    const draw = () => UI.set(list, entries.length ? entries.map(e => {
      const action = e.member ? h('button', { class: 'btn btn-sm', onclick: () => { m.close(); Chat.open(e.id); } }, 'Open')
        : e.pending || N.hasPendingRequest(e.id) ? h('span', { class: 'pill grey' }, 'Requested')
          : h('button', { class: 'btn btn-sm btn-primary', onclick: async () => {
            const note = await UI.prompt({ title: `Ask to join ${e.channel ? '#' : ''}${e.name}`, label: 'Note for the group admins (optional)', ok: 'Send request', maxlength: N.MAX_NOTE,
              hint: 'They see your name and this note.', onOk: v => N.requestJoin(e, v) });
            if (note != null) { UI.toast('Request sent. You’ll get a notification when a group admin decides.', 'ok'); e.pending = true; draw(); }
          } }, 'Ask to join');
      return h('div', { class: 'person', style: { cursor: 'default' } },
        h('span', { class: 'avatar ann-avatar', style: { width: '36px', height: '36px' } }, icon(e.channel ? 'lock' : 'users')),
        h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { class: 'nm' }, (e.channel ? '#' : '') + e.name),
          h('div', { class: 'sub' }, [`${e.channel ? 'Private channel' : 'Group chat'} · ${e.count} ${e.count === 1 ? 'member' : 'members'}`, e.description].filter(Boolean).join(' · '))),
        action);
    }) : h('div', { class: 'muted', style: { padding: '10px' } }, 'No groups are listed yet. Group admins can list one from its Details.'));
    draw();
  }

  function suggestMemberDialog(ch) {
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const ok = h('button', { class: 'btn btn-primary', disabled: true }, 'Send suggestion');
    const note = h('input', { class: 'input', id: 'sg-note', maxlength: N.MAX_NOTE, placeholder: 'Why should they join? (optional)' });
    const pp = peoplePicker({ multi: false, max: 1, exclude: Y.members(ch), onChange: set => { ok.disabled = !set.size; } });
    ok.addEventListener('click', () => UI.busy(ok, null, async () => {
      const who = Array.from(pp.picked)[0];
      await N.suggest(ch, who, note.value);
      m.close(); UI.toast(`Suggestion sent. A group admin decides whether to add ${A.name(who)}.`, 'ok');
    }, err));
    const m = UI.modal({ title: `Suggest someone for ${chName(ch)}`, cls: 'mid', body: [err,
      h('p', { class: 'muted', style: { fontSize: '14px', marginTop: 0 } }, 'Only the group’s creator and group admins can add people. They get your suggestion, encrypted so only members of this group can read it.'),
      pp.el, h('div', { class: 'field' }, h('label', { for: 'sg-note' }, 'Note'), note)],
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok] });
  }

  /* ================= profile ================= */

  function profileDialog(userId) {
    const u = A.users.get(userId);
    if (!u) return;
    const p = Y.presenceOf(userId);
    const role = A.roleLabel(userId);
    const team = A.teamOf(userId) ? A.teamName(A.teamOf(userId)) : A.teamRequest(userId) ? `${A.teamName(A.teamRequest(userId))} (waiting for an admin)` : 'None yet';
    const common = userId === meId() ? [] : Array.from(Y.chans.values())
      .filter(c => c.kind === 'group' && c.groupName && Y.members(c).includes(userId)).sort((a, b) => chName(a).localeCompare(chName(b)));
    // real name: only admins (and the person themselves) see this row
    let realRow = null;
    if (A.isAdmin() || userId === meId()) {
      realRow = h('dd', { class: 'real-name' }, '…');
      A.realNameOf(userId).then(n => {
        UI.set(realRow, n || (A.realNamePending(userId) ? 'Not shared with you yet (it appears after they next open the app)' : 'Not given'),
          ' ', h('span', { class: 'pill grey', title: 'Encrypted; only admins can read it' }, icon('lock'), userId === meId() ? 'Only admins see this' : 'Admins only'));
      });
    }
    const seen = p.state === 'online' ? 'Online now' : p.state === 'away' ? 'Away' : p.lastSeen ? `Last seen ${U.relTime(p.lastSeen)}` : 'Offline';
    const foot = [];
    if (userId !== meId()) foot.push(h('button', { class: 'btn btn-primary', onclick: () => { UI.closeAll(); Chat.openUser(userId); } }, icon('message'), 'Message'));
    else foot.push(h('button', { class: 'btn btn-primary', onclick: () => { m.close(); editProfileDialog(); } }, icon('edit'), 'Edit profile'));
    if (A.isAdmin() && userId !== meId()) foot.unshift(h('button', { class: 'btn', onclick: () => { UI.closeAll(); adminDialog('people'); } }, icon('shield'), 'Manage'));
    const m = UI.modal({ title: 'Profile', cls: 'mid', body: h('div', { class: 'profile' },
      h('div', { class: 'profile-top' },
        h('span', { class: 'av-wrap' }, UI.avatar(u, 84), UI.dot(p.state)),
        h('div', null,
          h('div', { class: 'profile-name' }, u.name, role ? h('span', { class: 'pill' + (role === 'Super admin' ? '' : ' grey') }, role) : null),
          u.title ? h('div', { class: 'profile-title' }, u.title) : null,
          h('div', { class: 'muted row', style: { gap: '6px', fontSize: '14px' } }, UI.dot(p.state), seen),
          p.statusText ? h('div', { class: 'profile-status' }, icon('status'), p.statusText) : null)),
      u.about ? h('p', { class: 'profile-about' }, u.about) : null,
      h('dl', { class: 'kv' },
        realRow ? [h('dt', null, 'Real name'), realRow] : null,
        h('dt', null, 'Group'), h('dd', null, team),
        h('dt', null, 'Member since'), h('dd', null, new Date(u.created).toLocaleDateString()),
        userId !== meId() ? [h('dt', null, 'Groups in common'), h('dd', null, common.length ? common.map(chName).join(', ') : 'None')] : null)),
    foot });
  }

  /* ================= announcements: edit ================= */

  function editAnnouncementDialog(a) {
    if (!a || !Y.canEditAnnouncement(a)) return UI.toast('Only the admin who posted it can edit it.');
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const title = h('input', { class: 'input', id: 'ea-title', maxlength: 120, value: a.title || '' });
    const text = h('textarea', { class: 'input', id: 'ea-text', rows: 6, maxlength: String(Y.MAX_TEXT) });
    text.value = a.text;
    mentionField(text, () => A.activeUsers().filter(u => !a.to || a.to.includes(u.id)));
    const ok = h('button', { class: 'btn btn-primary' }, 'Save changes');
    ok.addEventListener('click', () => UI.busy(ok, null, async () => { await Y.editAnnouncement(a.id, { title: title.value, text: text.value }); m.close(); UI.toast('Announcement updated', 'ok'); }, err));
    const m = UI.modal({ title: 'Edit announcement', cls: 'mid', body: [err,
      h('div', { class: 'field' }, h('label', { for: 'ea-title' }, 'Title (optional)'), title),
      h('div', { class: 'field' }, h('label', { for: 'ea-text' }, 'Message'), text,
        h('div', { class: 'hint' }, 'Everyone it was sent to sees the new text, marked “edited”. It doesn’t pop up again for people who already read it. Pictures can’t be changed.'))],
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok], onClose: () => closeMention() });
    text.focus();
  }

  /* ================= privacy and security ================= */

  function privacyDialog(focus) {
    const sec = (id, ic, title, lines) => h('section', { class: 'privacy-sec' + (focus === id ? ' focus' : ''), 'data-sec': id },
      h('h3', null, icon(ic), title), h('ul', null, lines.map(l => h('li', null, l))));
    const body = h('div', { class: 'privacy' },
      h('p', { class: 'muted', style: { marginTop: 0 } }, 'What Sankyo Chat protects, and who can read what. Encryption happens on your PC before anything reaches the shared drive.'),
      sec('dm', 'lock', 'Direct messages', ['End-to-end encrypted: only you and the other person can read them, including file names and attachments.',
        'Admins and the super admin can’t read them.', 'Deleted automatically 7 days after they’re sent.']),
      sec('group', 'users', 'Group chats', ['End-to-end encrypted, including the group name: only current members can read them.',
        'Someone removed from a group can’t read anything sent after they were removed (the group gets a new key).', 'Deleted automatically after 7 days.']),
      sec('private', 'lock', 'Private channels', ['End-to-end encrypted, including the name and description: only invited people can see or read them, not even other admins.',
        'History is kept. People invited later can read earlier messages.']),
      sec('announcements', 'megaphone', 'Announcements', ['“Everyone” announcements are not encrypted: anyone with access to the shared drive can read them.',
        'Private announcements are encrypted for the chosen people only. Sent to PICKUP GROUP or INPUT GROUP, they reach only people an admin has accepted into that group, so nobody in the other group can read them.',
        'The list of who received a private announcement is visible on the shared drive; the title, text, pictures and mentions aren’t.',
        'The super admin is told when an admin sends a private announcement, with its title and how many people got it, never the text.']),
      sec('public', 'hash', 'Public channels', ['Not encrypted: anyone in the workspace can read them, and they’re stored as plain files on the shared drive.',
        'Don’t post passwords or personal information there.']),
      sec('admins', 'shield', 'What admins can and can’t do', ['Admins can create channels, hide public messages, reset passwords and accept people into groups. Every action is signed and logged.',
        'Nobody, including the super admin, can read your direct messages, group chats or private channels unless they’re in them.',
        'Your real name (Edit profile) is encrypted so only admins and the super admin can read it. Everyone else sees your display name.',
        'Anyone with access to the shared drive can see who talks to whom and when (not what was said).']),
      sec('you', 'key', 'What you can do', ['Use a password nobody else knows, and lock the PC (⚙ → Lock) when you step away.',
        'Every profile has a security question (change it in ⚙ → Security question). If you forget your password, “Forgot password?” on the sign-in screen gets you back in with all your messages. Admins can’t use it, so your messages stay private.',
        'In a direct message, compare the security code (Details) with the other person to be sure nobody swapped keys.',
        'Pinned, muted, archived, deleted and blocked chats are saved encrypted so only you can read them. Blocking is silent: the other person isn’t told.']),
      sec('calendar', 'calendar', 'Calendar', ['Events aren’t encrypted: anyone with access to the shared drive can read them. Don’t put private details in them.',
        'An event for one group only shows in that group’s calendar (and the super admin’s).']));
    UI.modal({ title: 'Privacy and security', cls: 'mid', body });
    if (focus) setTimeout(() => { const f = body.querySelector('.privacy-sec.focus'); if (f) f.scrollIntoView({ block: 'start' }); }, 50);
  }

  /* ================= what's new ================= */

  /** Shown once after each update (newest first). Add an entry here whenever APP_VERSION goes up. */
  const NEWS = [
    { version: '1.15.0', items: [
      ['image', 'Pictures and @mentions in announcements', 'Admins can add up to 10 pictures to an announcement, and type @ to mention someone. The people mentioned get a notification in the bell.'],
      ['check', 'See who has seen an announcement', 'Admins see the faces of the last five people who saw it. “See more” lists everyone who has seen it, and who hasn’t yet.'],
      ['message', 'Pin, mute, archive, delete or block a chat', 'Hover a direct message in the sidebar and click ⋯ (or right-click it). Delete chat only clears it for you. Blocking is silent. These follow you to every PC you use.'],
      ['bell', 'Choose which messages pop up', '⚙ → Notification settings: direct messages, group chats and public channels each have their own switch.'],
      ['calendar', 'Calendar', 'The calendar button next to the bell shows events for everyone and for your group. Admins add them; a red number means new or changed events.'],
    ] },
    { version: '1.14.0', items: [
      ['refresh', 'Startup no longer gets stuck', 'If the browser’s saved data or the shared drive doesn’t answer when the app starts, you now see the Connect or Reconnect screen after a few seconds instead of an endless “Starting Sankyo Chat…”.'],
    ] },
    { version: '1.13.0', items: [
      ['download', 'The updater', 'Super admin: Admin settings → Settings → Update the app. Click Start update, then Open the updater, and choose the update package. It replaces only the app files, never the data folder, and keeps the old version so you can undo. Set up the button once on your PC: in the SankyoChat folder, open update and double-click “Set up updater button”.'],
    ] },
    { version: '1.12.0', items: [
      ['shield', 'Roles and permissions', 'Super admin: Admin settings → Roles shows what the super admin, admins and every custom role can do. Create roles like Moderator or Group leader and tick what they may do: announcements, channels, pins, hiding, polls, groups and project boards. Password resets, removing people and real names stay with admins.'],
      ['users', 'Give people a role', 'Admin settings → People has a Role dropdown for each person: Staff, a custom role, or Admin. There’s always exactly one super admin; Admin and custom roles have no limit.'],
      ['info', 'Role guide', 'If you have a role, ⚙ → Role guide shows what you can do. You’re told when your role changes.'],
    ] },
    { version: '1.11.0', items: [
      ['shield', 'Hourly backups', 'Super admin: Admin settings → Backups. Choose a folder on the shared storage, outside the SankyoChat folder. Every hour the app saves what changed into one folder per day. To keep backing up while your app is closed, also run “1 Set up hourly backup” from the backup folder once on the file server.'],
      ['refresh', 'Restore when data is lost', 'If the data folder is emptied or deleted, the app asks for a backup before anyone can start a new workspace, and copies it back into data. The backup itself stays untouched.'],
    ] },
    { version: '1.10.0', items: [
      ['board', 'Project boards for each group', 'Sidebar → Project boards: PICKUP GROUP and INPUT GROUP each have their own board with four columns: Review, In progress, Checking and Done. Each card has the project number and name, priority, label (Input or Correction), members, progress, deadline and the superior who assigned it. Admins manage their group’s board; you see your own group’s.'],
      ['check', 'Approve PICKUP projects', 'PICKUP admins approve a project in Done. It turns grey and goes to the INPUT GROUP board in Review. When an INPUT admin clicks Receive, it leaves the PICKUP board and PICKUP is told who received it.'],
      ['archive', 'Confirm complete and History', 'On the INPUT board, Done is the last step: an admin clicks Confirm complete and the project leaves the board. Both groups find it under the second bell → History, with who approved, received and confirmed it.'],
      ['boardBell', 'Board notifications, separate from chat', 'The second bell at the top left is only for projects: a new project assigned to you, and when yours moves to Checking or Done. The first bell stays for chat.'],
      ['poll', 'One vote per poll', 'Everyone gets one vote in each poll. Pick another option to change it.'],
      ['clock', 'Clearer times', 'Messages show “Today at 3:45 PM”, “Yesterday at…” and the weekday, like Facebook. Hover any time for the full date.'],
    ] },
    { version: '1.9.0', items: [
      ['bell', 'Notifications', 'The bell at the top left collects mentions, replies, group changes and requests. Choose what pops up in ⚙ → Notification settings, or turn on Do not disturb.'],
      ['users', 'Groups in the sidebar', 'PICKUP GROUP and INPUT GROUP have their own section. Click one to see who’s in it and who’s online.'],
      ['search', 'Browse groups and ask to join', 'Group admins can list a group. Others find it with the search button next to Group chats and ask to join. Members can suggest someone from Details.'],
      ['edit', 'Edit or delete announcements', 'Admins: hover over an announcement to edit or delete it. Edits show as “edited” and don’t pop up again.'],
      ['info', 'Profiles', 'Click anyone’s name for their profile: job title, about, group, status and groups you share. Add yours in ⚙ → Edit profile, and your real name, which only admins can see.'],
      ['key', 'Real name and security question for everyone', 'Every profile now needs both; you’re asked once after signing in. Your real name is only visible to admins. If you forget your password, “Forgot password?” on the sign-in screen gets you back in with all your messages and work.'],
      ['megaphone', 'Announcements for each group', 'Private announcements for PICKUP or INPUT now have their own feed in the sidebar: Announcements (PICKUP) and Announcements (INPUT). You see your own group’s; the main Announcements keeps the ones for everyone.'],
      ['shield', 'Privacy and security', 'See who can read what in ⚙ → Privacy and security, or click the lock badge in any private conversation.'],
    ] },
  ];
  function showWhatsNew() {
    const k = `newsSeen.${A.ws.id}.${meId()}`;
    if (U.ls.get(k) === SC.VERSION) return;
    U.ls.set(k, SC.VERSION);
    if (!NEWS.some(n => n.version === SC.VERSION)) return;
    setTimeout(() => { if (el.root && !UI.dialogOpen()) whatsNewDialog(); }, 800);
  }
  function whatsNewDialog() {
    const m = UI.modal({ title: 'What’s new in Sankyo Chat', cls: 'mid', body: NEWS.map(n => h('div', { class: 'news' },
      h('div', { class: 'news-ver' }, `Version ${n.version}` + (n.version === SC.VERSION ? ' · this version' : '')),
      n.items.map(([ic, t, d]) => h('div', { class: 'news-item' }, h('span', { class: 'news-ic' }, icon(ic)), h('div', null, h('b', null, t), h('div', { class: 'muted' }, d)))))),
    foot: [h('button', { class: 'btn btn-primary', onclick: () => m.close() }, 'Got it')] });
  }

  /* ================= update mode (super admin) ================= */

  /* The updater is a Windows program (update\Update Sankyo Chat.bat): a web page can't start programs or
   * replace its own files. This link uses the sankyo-update: link type that update\Set up updater button.bat
   * registers for the super admin's Windows account. The link carries no data; the updater ignores it. */
  function updaterLink(cls) {
    return h('a', { class: cls, href: 'sankyo-update:open', title: 'Opens the Sankyo Chat Updater on this PC' }, icon('download'), 'Open the updater');
  }

  async function finishUpdate() {
    if (!(await UI.confirm({ title: 'Finish the update?', ok: 'Finish and reload',
      text: 'Make sure the updater says the new version is installed. Everyone’s app reloads with the new version within a few seconds, and so does yours.' }))) return;
    try { await A.setMaintenance(false); location.reload(); } catch (e) { UI.toast(e.message, 'error'); }
  }

  SC.chat = Chat;
})(window);
