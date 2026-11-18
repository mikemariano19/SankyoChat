/* Sankyo Chat — notifications: the Activity inbox (bell) and group join/suggest requests.
 * There is no server, so nobody can "send" anyone a notification. Each app works out its own from files it can
 * already read: messages (mentions, replies, @here), group meta.json (added, removed, made group admin), leave
 * files, request files, the admin action log and, for the super admin, audit records (js/account.js).
 * Read-state lives in my presence file (js/sync.js: notifRead / notifSeen), so it follows me to other PCs.
 * No DOM access; the UI listens to SC.notify.events 'change'. */
(function (root) {
  'use strict';
  const SC = root.SC = root.SC || {};
  const U = SC.util, S = SC.store, C = SC.crypto, A = SC.account, Y = SC.sync;
  /** @namespace SC.notify */
  const N = {};
  N.events = U.emitter();
  N.KEEP_DAYS = 30;
  N.REQUEST_DAYS = 14;
  N.MAX_NOTE = 200;

  /** Which tab each type belongs to. */
  const CAT = {
    mention: 'mentions', reply: 'mentions', here: 'mentions',
    added: 'groups', removed: 'groups', gadmin: 'groups', gadminOff: 'groups', reqResult: 'groups',
    request: 'requests', leave: 'requests', team: 'requests', newUser: 'requests',
    adm: 'admin', aud: 'admin', chan: 'admin', ann: 'admin',
  };
  N.category = it => CAT[it.type] || 'groups';
  /** Types rebuilt from their source on every refresh (not saved on this PC). */
  const DERIVED = new Set(['request', 'team', 'newUser', 'adm', 'aud', 'chan', 'ann']);

  /** @type {Map<string, any>} */
  const items = new Map();
  let known = {};          // groupId → {name, pc, admin} — groups I was in last time I looked
  let myReqs = [];         // requests I sent: [{id, gid, name, kind, who, ts, done}]
  const reqFiles = new Map(); // `${gid}/${file}` → parsed request or status (files never change once written)
  const hints = {};        // presence hint key → newest ts handled
  const checking = new Map(); // groupId → last disappearance check
  const shown = new Set(); // ids already in the feed this session (pop up only once)
  let arrived = {};        // id → when this PC first got the notification (shown in the inbox instead of the event's own date)
  let started = false, ready = false, startTs = 0, timer = 0, unsub = [];

  const me = () => A.me.id;
  const err = msg => new Error(msg);
  const key = name => `${name}.${A.ws.id}.${me()}`;
  const floor = () => Date.now() - N.KEEP_DAYS * U.DAY_MS;
  const baseline = () => { const u = A.users.get(me()); return u ? u.created : 0; };
  const GID_RE = /^g_[a-z0-9]{8}$/;
  const STATUS_RE = /^(\d{13}_[a-z0-9]{4}_[a-z0-9]{4})\.status\.json$/;

  /* ================= preferences ================= */

  N.PREF_LABELS = { mentions: 'Mentions and replies', groups: 'Added to or removed from groups', requests: 'Requests and approvals', admin: 'Admin activity (super admin)' };
  N.prefs = () => Object.assign({ mentions: true, groups: true, requests: true, admin: true }, U.ls.get(key('notifPrefs'), {}));
  N.setPref = (k, on) => { const p = N.prefs(); p[k] = !!on; U.ls.set(key('notifPrefs'), p); };
  N.dndUntil = () => { const t = A.me ? U.ls.get(key('dnd'), 0) : 0; return t > Date.now() ? t : 0; };
  N.setDnd = until => { U.ls.set(key('dnd'), until || 0); N.events.emit('change'); };
  N.isQuiet = () => !!(A.me && A.ws && N.dndUntil());
  /** May this category pop up on the desktop? (The inbox always records everything.) */
  N.allow = cat => !N.isQuiet() && N.prefs()[cat] !== false;

  /* ================= the feed ================= */

  function save() {
    if (!A.me) return;
    const keep = Array.from(items.values()).filter(it => !DERIVED.has(it.type) && it.ts > floor())
      .sort((a, b) => b.ts - a.ts).slice(0, 300)
      // previews from encrypted conversations are never written to this PC's storage
      .map(it => { const o = Object.assign({}, it); delete o.live; if (!o.publicText) delete o.text; return o; });
    U.ls.set(key('notifs'), keep);
    U.ls.set(key('notifGroups'), known);
    U.ls.set(key('notifReqs'), myReqs);
    const lo = floor();
    for (const id of Object.keys(arrived)) if (arrived[id] < lo) delete arrived[id];
    U.ls.set(key('notifAt'), arrived);
  }
  const saveSoon = U.debounce(save, 1500);
  const changed = U.debounce(() => N.events.emit('change'), 150);

  function add(it) {
    if (!it || !it.id || !(it.ts > floor()) || it.ts < baseline() - 60000) return;
    if (!arrived[it.id]) { arrived[it.id] = Math.max(it.ts, Date.now()); saveSoon(); }
    it.at = arrived[it.id];
    const prev = items.get(it.id);
    items.set(it.id, prev ? Object.assign(prev, it) : it);
    if (!shown.has(it.id)) {
      shown.add(it.id);
      if (ready && it.ts > startTs - 60000 && !it.done) popup(it);
    }
    changed(); saveSoon();
  }
  function drop(pred) {
    let n = 0;
    for (const [id, it] of items) if (pred(it)) { items.delete(id); n++; }
    if (n) changed();
  }

  function popup(it, tries = 0) {
    const cat = N.category(it);
    if (cat === 'mentions') return; // js/chat.js already pops up new messages (and checks the 'mentions' preference)
    if (!N.allow(cat === 'admin' ? 'admin' : cat)) return;
    // wait a moment for a group's name to be decrypted, so the pop-up doesn't say "a group"
    if (tries < 6 && it.conv && nameLoading(Y.chans.get(it.conv))) { setTimeout(() => popup(it, tries + 1), 500); return; }
    const d = N.describe(it);
    SC.app.notify({ title: d.title, body: d.sub || '', tag: 'n-' + it.id, onClick: () => N.events.emit('open', it) });
  }

  /** Newest first, optionally one tab. */
  N.list = function (tab) {
    return Array.from(items.values()).filter(it => !tab || tab === 'all' || N.category(it) === tab).sort((a, b) => (b.at || b.ts) - (a.at || a.ts)).slice(0, 200);
  };
  N.isUnread = it => it.ts > Y.notifRead() && !Y.notifSeen(it.id) && !it.done;
  N.unreadCount = () => { let n = 0; for (const it of items.values()) if (N.isUnread(it)) n++; return n; };
  N.pendingRequests = () => N.list('requests').filter(it => it.type === 'request' && !it.done).length;
  N.markAllRead = function () {
    let max = 0;
    for (const it of items.values()) if (it.ts > max) max = it.ts;
    if (Y.markNotifs(Math.min(Date.now(), max))) changed();
  };
  N.markRead = it => { if (Y.markNotifs(0, [it.id])) changed(); };

  /** Plain-text title and sub-line for a row (and for desktop pop-ups). */
  N.describe = function (it) {
    const who = it.actor ? A.name(it.actor) : '';
    const conv = convName(it);
    const quote = it.text ? it.text.replace(/\s+/g, ' ').slice(0, 140) : '';
    switch (it.type) {
      case 'mention': return { title: `${who} mentioned you in ${conv}`, sub: quote };
      case 'reply': return { title: `${who} replied to you in ${conv}`, sub: quote };
      case 'here': return { title: `${who} notified everyone in ${conv}`, sub: quote };
      case 'added': return { title: who ? `${who} added you to ${conv}` : `You were added to ${conv}`, sub: it.pc ? 'Private channel' : 'Group chat' };
      case 'removed': return { title: `You were removed from ${conv}`, sub: 'You won’t get new messages from it.' };
      case 'gadmin': return { title: `You’re now ${it.pc ? 'a channel' : 'a group'} admin of ${conv}`, sub: 'You can rename it, add people and remove regular members.' };
      case 'gadminOff': return { title: `You’re no longer ${it.pc ? 'a channel' : 'a group'} admin of ${conv}`, sub: '' };
      case 'reqResult': {
        const ok = it.status === 'approved';
        const what = it.kind === 'suggest' ? `Your suggestion to add ${A.name(it.who)} to ${conv}` : `Your request to join ${conv}`;
        return { title: `${what} was ${ok ? 'approved' : 'declined'}`, sub: it.actor ? `By ${who}` : '' };
      }
      case 'request': {
        const title = it.kind === 'suggest' ? `${who} suggests adding ${A.name(it.who)} to ${conv}` : `${who} asks to join ${conv}`;
        const sub = it.done ? (it.status === 'approved' ? 'Approved' : it.status === 'declined' ? 'Declined' : it.status === 'member' ? 'Already a member' : 'Expired')
          + (it.statusBy ? ` by ${it.statusBy === me() ? 'you' : A.name(it.statusBy)}` : '') : (it.note ? `“${it.note}”` : 'Waiting for a group admin');
        return { title, sub };
      }
      case 'leave': return { title: `${who} left ${conv}`, sub: '' };
      case 'team': return { title: `${who} is waiting for a group`, sub: `Picked ${A.teamName(A.teamRequest(it.actor)) || 'a group'}. Accept it or choose another.` };
      case 'newUser': return { title: `${who} joined the workspace`, sub: A.teamOf(it.actor) ? A.teamName(A.teamOf(it.actor)) : 'No group yet' };
      case 'chan': return { title: `${who} created #${conv}`, sub: 'Public channel' };
      case 'ann': return { title: `${who} posted an announcement`, sub: it.text || '' };
      case 'adm': return { title: `${who} ${it.verb}`, sub: '' };
      case 'aud': {
        const name = it.name ? (it.kind === 'group.create' ? it.name : '#' + it.name) : '';
        const people = `${it.count} ${it.count === 1 ? 'person' : 'people'}`;
        if (it.kind === 'announcement.private') return { title: `${who} sent a private announcement${it.label ? ' to ' + it.label : ''} (${people})`, sub: it.title ? `“${it.title}”` : 'No title' };
        if (it.kind === 'private-channel.make-private') return { title: `${who} made ${name || 'a channel'} private (${people})`, sub: 'The old public channel was archived.' };
        if (it.kind === 'private-channel.create') return { title: `${who} created private channel ${name || ''} (${people})`.replace('  ', ' '), sub: 'Encrypted. You can’t read it unless you’re invited.' };
        return { title: `${who} created group chat ${name} (${people})`, sub: 'Encrypted. You can’t read it unless you’re a member.' };
      }
    }
    return { title: 'Notification', sub: '' };
  };
  /** A named group whose encrypted name hasn't been decrypted yet would show as a list of members. */
  const nameLoading = ch => !!ch && ch.kind === 'group' && !!ch.meta && !!ch.meta.nameEnc && !ch.groupName;
  function convName(it) {
    const ch = it.conv && Y.chans.get(it.conv);
    if (ch && !nameLoading(ch)) return (ch.kind === 'public' || Y.isPrivateChannel(ch) ? '#' : '') + Y.info(ch).name;
    return (it.convName && !(ch && nameLoading(ch) && it.convName === chanLabel(ch))) ? it.convName : 'a group';
  }
  const chanLabel = ch => (ch.kind === 'public' || Y.isPrivateChannel(ch) ? '#' : '') + Y.info(ch).name;

  /* ================= messages: mentions, replies, @here ================= */

  function onLoaded({ ch, msgs }) {
    if (!A.me) return;
    const lo = Math.max(floor(), baseline());
    for (const m of msgs) {
      if (m.type !== 'message' || m.userId === me() || !m.verified || m.deleted || m.ts < lo) continue;
      let type = null;
      if (m.mentions.includes(me())) type = 'mention';
      else if (m.replyTo && m.replyTo.userId === me()) type = 'reply';
      else if (m.mentions.includes('channel') && !Y.isMuted(ch.id)) type = 'here';
      if (!type) continue;
      add({ id: `m:${ch.id}:${m.id}`, type, ts: m.ts, actor: m.userId, conv: ch.id, convName: chanLabel(ch), msg: m.id,
        text: m.decryptError ? '' : (m.text || (m.attachments.length ? '📎 Attachment' : '')), publicText: ch.kind === 'public' });
    }
  }

  /* ================= groups: added, removed, admin rights ================= */

  function scanGroups() {
    if (!A.me) return;
    let dirty = false;
    const present = new Set();
    for (const ch of Y.chans.values()) {
      if (ch.kind !== 'group' || !ch.meta) continue;
      present.add(ch.id);
      const named = !!ch.groupName;
      const k = known[ch.id];
      const isAdm = Y.groupAdmins(ch).includes(me());
      const pc = Y.isPrivateChannel(ch);
      if (!k) {
        const meta = ch.meta;
        if (meta.createdBy !== me()) {
          const joinTs = (meta.joined && meta.joined[me()]) || meta.ts;
          // who added me is only certain if that was the newest change to the group
          const by = meta.joined && meta.joined[me()] ? (meta.updated === joinTs ? meta.by : '') : meta.createdBy;
          add({ id: `add:${ch.id}:${joinTs}`, type: 'added', ts: joinTs, actor: by, conv: ch.id, convName: chanLabel(ch), pc });
        }
        known[ch.id] = { name: chanLabel(ch), pc, admin: isAdm, named };
        dirty = true;
        continue;
      }
      if (!nameLoading(ch) && k.name !== chanLabel(ch)) {
        k.name = chanLabel(ch); dirty = true;
        for (const it of items.values()) if (it.conv === ch.id) it.convName = k.name; // saved for after I'm no longer in it
      }
      if (k.admin !== isAdm) {
        const arev = (ch.meta.admins && ch.meta.admins.arev) || 0;
        add({ id: `ga:${ch.id}:${arev}`, type: isAdm ? 'gadmin' : 'gadminOff', ts: ch.meta.updated || Date.now(), actor: ch.meta.createdBy, conv: ch.id, convName: k.name, pc });
        k.admin = isAdm; dirty = true;
      }
    }
    // groups that disappeared: removed (tell me) or left (don't). Only once sync has looked at every folder.
    if (started) for (const gid of Object.keys(known)) if (!present.has(gid)) checkGone(gid);
    if (dirty) saveSoon();
  }
  const scanSoon = U.debounce(scanGroups, 300);

  async function checkGone(gid) {
    const last = checking.get(gid) || 0;
    if (Date.now() - last < 60000) return;
    checking.set(gid, Date.now());
    try {
      const meta = await S.readJSON(`channels/${gid}/meta.json`);
      if (!meta || !(await Y.verifyMeta(meta, gid))) return; // unreadable right now: check again later
      if (Array.isArray(meta.members) && meta.members.includes(me()) && meta.keys && meta.keys[me()]) return; // still in it
      const k = known[gid];
      delete known[gid];
      saveSoon();
      const removedTs = meta.removed && meta.removed[me()];
      if (!k || !removedTs) return;
      const leave = await S.readJSON(`channels/${gid}/leave/${me()}.json`);
      const joined = (meta.joined && meta.joined[me()]) || 0;
      if (leave && leave.userId === me() && typeof leave.ts === 'number' && leave.ts > joined && leave.ts <= removedTs + 60000) return; // I left
      add({ id: `rm:${gid}:${removedTs}`, type: 'removed', ts: removedTs, conv: gid, convName: k.name, pc: k.pc });
    } catch (e) { console.warn('group check', gid, e); }
  }

  function onLeave({ ch, uid, ts }) {
    if (!A.me || uid === me() || !Y.canManageGroup(ch)) return;
    add({ id: `lv:${ch.id}:${uid}:${ts}`, type: 'leave', ts, actor: uid, conv: ch.id, convName: chanLabel(ch) });
  }

  /* ================= requests: "Request to join" and "Suggest someone" =================
   * requests/<groupId>/<ts>_<userId>_<rand>.json, signed by whoever asks:
   *   {kind:'join', who: their own id, note}  — for groups listed in Browse groups
   *   {kind:'suggest', gen, enc:{who, note}}  — a member suggests someone; encrypted with the group key, so only members can read it
   * requests/<groupId>/<requestId>.status.json, signed by the group's creator or a group admin who decided:
   *   {status:'approved'|'declined'}. Approving first adds the person (the usual Add people). */

  async function managers(gid) {
    const ch = Y.chans.get(gid);
    let meta = ch && ch.meta;
    if (!meta) {
      meta = await S.readJSON(`channels/${gid}/meta.json`);
      if (!meta || !(await Y.verifyMeta(meta, gid))) return null;
    }
    return { meta, list: [meta.createdBy].concat((meta.admins && Array.isArray(meta.admins.list)) ? meta.admins.list : []) };
  }
  async function signedBy(raw, signer = raw.userId) {
    const u = A.users.get(signer) || await A.loadUser(signer);
    const k = u && A.findKey(u, raw.kid, 'sign');
    return !!k && await C.verify(k, raw);
  }

  async function readStatus(gid, reqId) {
    const cacheKey = `${gid}/${reqId}.status.json`;
    if (reqFiles.has(cacheKey)) return reqFiles.get(cacheKey);
    const raw = await S.readJSON(`requests/${gid}/${reqId}.status.json`);
    if (!raw) return null;
    const mg = await managers(gid);
    const ok = mg && raw.id === reqId && raw.group === gid && ['approved', 'declined'].includes(raw.status) &&
      mg.list.includes(raw.userId) && await signedBy(raw);
    const st = ok ? { status: raw.status, by: raw.userId, ts: raw.ts } : null;
    if (ok) reqFiles.set(cacheKey, st);
    return st;
  }

  /** Group admin: read the requests for one group I manage. */
  async function refreshGroupRequests(ch) {
    const gid = ch.id;
    const names = await S.list(`requests/${gid}`, 'file');
    const statuses = new Set(names.map(n => (n.match(STATUS_RE) || [])[1]).filter(Boolean));
    const lo = Date.now() - N.REQUEST_DAYS * U.DAY_MS;
    for (const n of names) {
      if (!U.MSG_RE.test(n) || n.includes('.ev.')) continue;
      const p = U.parseMsgName(n);
      const cacheKey = `${gid}/${n}`;
      let rq = reqFiles.get(cacheKey);
      if (rq === undefined) {
        if (p.ts < floor()) { reqFiles.set(cacheKey, null); continue; }
        const raw = await S.readJSON(`requests/${gid}/${n}`);
        if (!raw) continue;
        rq = null;
        if (raw.id === p.id && raw.userId === p.userId && raw.ts === p.ts && raw.group === gid && await signedBy(raw)) {
          if (raw.kind === 'join' && raw.who === raw.userId) rq = { kind: 'join', who: raw.who, note: String(raw.note || '').slice(0, N.MAX_NOTE) };
          else if (raw.kind === 'suggest' && raw.enc) {
            try {
              const o = await C.decryptJSON(await Y.groupKey(ch, Number.isInteger(raw.gen) ? raw.gen : 0), raw.enc, 'req|' + raw.id);
              if (typeof o.who === 'string') rq = { kind: 'suggest', who: o.who, note: String(o.note || '').slice(0, N.MAX_NOTE) };
            } catch { /* a key generation I can't open */ }
          }
          if (rq) Object.assign(rq, { id: raw.id, userId: raw.userId, ts: raw.ts });
        }
        reqFiles.set(cacheKey, rq);
      }
      if (!rq) continue;
      const st = statuses.has(rq.id) ? await readStatus(gid, rq.id) : null;
      const member = Y.members(ch).includes(rq.who);
      const it = { id: `rq:${rq.id}`, type: 'request', kind: rq.kind, ts: rq.ts, actor: rq.userId, who: rq.who, note: rq.note, conv: gid, convName: chanLabel(ch), req: rq.id };
      if (st) Object.assign(it, { done: true, status: st.status, statusBy: st.by });
      else if (member) Object.assign(it, { done: true, status: 'member' });
      else if (rq.ts < lo) Object.assign(it, { done: true, status: 'expired' });
      else it.done = false;
      add(it);
    }
  }

  /** Requests I sent: did someone decide? */
  async function refreshMyRequests() {
    let dirty = false;
    const lo = Date.now() - N.REQUEST_DAYS * U.DAY_MS;
    for (const r of myReqs) {
      if (r.done) continue;
      if (r.ts < lo) { r.done = true; dirty = true; continue; }
      const st = await readStatus(r.gid, r.id);
      if (!st) continue;
      r.done = true; dirty = true;
      add({ id: `rs:${r.id}`, type: 'reqResult', kind: r.kind, who: r.who, status: st.status, ts: st.ts, actor: st.by, conv: r.gid, convName: r.name });
    }
    myReqs = myReqs.filter(r => r.ts > floor());
    if (dirty) saveSoon();
  }
  N.hasPendingRequest = (gid, who) => myReqs.some(r => !r.done && r.gid === gid && r.who === (who || me()));

  async function writeRequest(gid, raw, entry) {
    if (!Y.connected) throw err('Lost access to the shared folder');
    raw.sig = await C.sign(A.me.priv.sign, raw);
    await S.writeJSON(`requests/${gid}/${raw.id}.json`, raw);
    myReqs.push(entry);
    save();
    Y.noteMyPost('req:' + gid, raw.ts);
  }

  /** Ask to join a group from Browse groups. */
  N.requestJoin = async function (entry, note) {
    if (Y.chans.has(entry.id)) throw err('You’re already in this group.');
    if (N.hasPendingRequest(entry.id)) throw err('You already asked. A group admin will decide.');
    const ts = Date.now();
    const id = `${ts}_${me()}_${U.rand(4)}`;
    const raw = { v: 1, id, kind: 'join', group: entry.id, userId: me(), who: me(), note: String(note || '').trim().slice(0, N.MAX_NOTE), ts, kid: A.me.signFp };
    await writeRequest(entry.id, raw, { id, gid: entry.id, name: (entry.channel ? '#' : '') + entry.name, kind: 'join', who: me(), ts });
  };

  /** A member suggests adding someone. Group admins add people directly instead. */
  N.suggest = async function (ch, who, note) {
    if (!Y.chans.has(ch.id) || ch.kind !== 'group') throw err('You’re not in this group.');
    if (Y.members(ch).includes(who)) throw err(`${A.name(who)} is already in it.`);
    if (N.hasPendingRequest(ch.id, who)) throw err(`You already suggested ${A.name(who)}.`);
    const ts = Date.now();
    const id = `${ts}_${me()}_${U.rand(4)}`;
    const gen = Y.curGen(ch);
    const enc = await C.encryptJSON(await Y.groupKey(ch, gen), { who, note: String(note || '').trim().slice(0, N.MAX_NOTE) }, 'req|' + id);
    const raw = { v: 1, id, kind: 'suggest', group: ch.id, userId: me(), gen, enc, ts, kid: A.me.signFp };
    await writeRequest(ch.id, raw, { id, gid: ch.id, name: chanLabel(ch), kind: 'suggest', who, ts });
  };

  /** Group admin: approve (adds the person first) or decline. */
  N.decide = async function (it, approve) {
    const ch = Y.chans.get(it.conv);
    if (!ch || !Y.canManageGroup(ch)) throw err('Only the group’s creator and group admins can decide.');
    const prev = await readStatus(ch.id, it.req);
    if (prev) { Object.assign(it, { done: true, status: prev.status, statusBy: prev.by }); changed(); throw err(`Already ${prev.status} by ${prev.by === me() ? 'you' : A.name(prev.by)}.`); }
    if (approve && !Y.members(ch).includes(it.who)) {
      const u = A.users.get(it.who);
      if (!u || A.isRemoved(it.who)) throw err('That person is no longer in the workspace.');
      await Y.updateGroup(ch, { addIds: [it.who] });
    }
    const ts = Date.now();
    const raw = { v: 1, id: it.req, group: ch.id, status: approve ? 'approved' : 'declined', userId: me(), ts, kid: A.me.signFp };
    raw.sig = await C.sign(A.me.priv.sign, raw);
    await S.writeJSON(`requests/${ch.id}/${it.req}.status.json`, raw);
    reqFiles.set(`${ch.id}/${it.req}.status.json`, { status: raw.status, by: me(), ts });
    Object.assign(it, { done: true, status: raw.status, statusBy: me() });
    Y.markNotifs(0, [it.id]);
    Y.noteMyPost('req:' + ch.id, ts);
    changed();
  };

  /** Browse groups: listed group chats and private channels, newest first. */
  N.browse = async function () {
    const names = (await S.list('directory', 'file')).filter(n => GID_RE.test(n.slice(0, -5)) && n.endsWith('.json'));
    const out = [];
    await U.mapLimit(names, 8, async n => {
      const gid = n.slice(0, -5);
      try {
        const e = await S.readJSON(`directory/${n}`);
        if (!e || e.id !== gid || typeof e.name !== 'string') return;
        const mg = await managers(gid);
        if (!mg || !mg.meta.listed || !mg.list.includes(e.by) || !(await signedBy(e, e.by))) return;
        out.push({ id: gid, name: e.name.slice(0, 60), description: String(e.description || '').slice(0, 250), count: Number(e.count) || mg.meta.members.length,
          channel: !!mg.meta.channel, createdBy: mg.meta.createdBy, member: Y.chans.has(gid), pending: N.hasPendingRequest(gid), ts: e.ts || 0 });
      } catch (ex) { console.warn('directory', gid, ex); }
    });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };

  /* ================= workspace admins and the super admin ================= */

  function derive() {
    if (!A.me || !A.ws) return;
    drop(it => ['team', 'newUser', 'adm', 'aud', 'chan', 'ann'].includes(it.type));
    const lo = floor();
    if (A.isAdmin()) {
      for (const u of A.teamPending()) if (u.id !== me()) add({ id: `tm:${u.id}`, type: 'team', ts: u.updated || u.created || Date.now(), actor: u.id });
      for (const u of A.activeUsers()) if (u.id !== me() && u.created > lo) add({ id: `nu:${u.id}`, type: 'newUser', ts: u.created, actor: u.id });
    }
    if (!A.isOwner()) return;
    for (const a of A.adminLog.values()) {
      if (!a.valid || a.userId === me() || !(a.ts > lo)) continue;
      const verb = adminVerb(a);
      if (verb) add({ id: `ad:${a.id}`, type: 'adm', ts: a.ts, actor: a.userId, verb });
    }
    for (const a of A.auditLog.values()) {
      add({ id: `au:${a.id}`, type: 'aud', kind: a.kind, ts: a.ts, actor: a.userId, count: a.count, name: a.name, title: a.title, label: a.label, conv: a.kind.startsWith('announcement') ? '' : a.ref });
    }
    for (const ch of Y.chans.values()) {
      if (ch.kind !== 'public' || ch.id === 'general' || !ch.meta || ch.meta.createdBy === me() || !(ch.meta.ts > lo)) continue;
      add({ id: `ch:${ch.id}`, type: 'chan', ts: ch.meta.ts, actor: ch.meta.createdBy, conv: ch.id, convName: Y.info(ch).name });
    }
    for (const a of Y.announcementList()) {
      if (a.to || a.userId === me() || !(a.ts > lo)) continue;
      add({ id: `an:${a.id}`, type: 'ann', ts: a.ts, actor: a.userId, text: a.title || a.text.replace(/\s+/g, ' ').slice(0, 120), ann: a.id });
    }
  }
  const deriveSoon = U.debounce(derive, 400);

  function adminVerb(a) {
    const target = a.target ? A.name(a.target) : '';
    const ch = a.type === 'channel' ? Y.chans.get(a.target) : null;
    const cname = ch ? '#' + Y.info(ch).name : 'a channel';
    switch (a.type) {
      case 'channel': {
        const p = a.patch || {};
        if (p.archived === true) return `archived ${cname}`;
        if (p.archived === false) return `unarchived ${cname}`;
        if (typeof p.name === 'string') return `renamed a channel to #${p.name}`;
        if (typeof p.description === 'string') return `edited the description of ${cname}`;
        return '';
      }
      case 'remove': return `removed ${target} from the workspace`;
      case 'reset': return `reset ${target}’s password`;
      case 'team': return `put ${target} in ${A.teamName(A.normalizeTeam(a.team)) || 'a group'}`;
    }
    return '';
  }

  /* ================= polling ================= */

  let busy = false;
  async function refresh(onlyGroups) {
    if (busy || !A.me || !Y.connected) return;
    busy = true;
    try {
      for (const ch of Array.from(Y.chans.values())) {
        if (ch.kind !== 'group' || !Y.canManageGroup(ch)) continue;
        if (onlyGroups && !onlyGroups.has(ch.id)) continue;
        try { await refreshGroupRequests(ch); } catch (e) { console.warn('requests', ch.id, e); }
      }
      await refreshMyRequests();
      if (!onlyGroups && A.isOwner()) { try { if (await A.refreshAudit()) deriveSoon(); } catch (e) { console.warn('audit', e); } }
      if (!onlyGroups) derive();
    } catch (e) { console.warn('notifications', e); } finally { busy = false; }
  }
  N.refresh = () => refresh();

  /** Presence files carry hints (lastPost['req:<groupId>'], lastPost['audit:all']) so changes show within seconds. */
  function onPresence() {
    const groups = new Set();
    let audit = false;
    for (const p of Y.presence.values()) {
      const lp = p.data && p.data.lastPost;
      if (!lp || typeof lp !== 'object') continue;
      for (const [k, ts] of Object.entries(lp)) {
        if (typeof ts !== 'number' || !k.includes(':') || !(ts > (hints[k] || 0))) continue;
        const first = hints[k] === undefined;
        hints[k] = ts;
        if (first && !ready) continue;
        if (k.startsWith('req:')) groups.add(k.slice(4));
        else if (k === 'audit:all') audit = true;
        else if (k === 'maint:all') A.refreshWorkspace().catch(e => console.warn('workspace', e)); // update mode: react within seconds
      }
    }
    if (groups.size) {
      const mine = new Set(myReqs.filter(r => !r.done).map(r => r.gid));
      const relevant = new Set(Array.from(groups).filter(g => mine.has(g) || (Y.chans.get(g) && Y.canManageGroup(Y.chans.get(g)))));
      if (relevant.size) refresh(relevant);
    }
    if (audit && A.isOwner()) A.refreshAudit().then(c => { if (c) derive(); }).catch(e => console.warn('audit', e));
  }

  /* ================= lifecycle ================= */

  /** Call before SC.sync.start(), so messages loaded during start-up are seen. */
  N.start = function () {
    N.stop();
    started = false; ready = false; startTs = Date.now();
    known = U.ls.get(key('notifGroups'), {}) || {};
    myReqs = (U.ls.get(key('notifReqs'), []) || []).filter(r => r && r.id && GID_RE.test(r.gid));
    arrived = U.ls.get(key('notifAt'), {}) || {};
    for (const it of U.ls.get(key('notifs'), []) || []) if (it && it.id && it.ts > floor()) { it.at = arrived[it.id] = arrived[it.id] || it.at || it.ts; items.set(it.id, it); shown.add(it.id); }
    unsub = [
      Y.events.on('loaded', onLoaded),
      Y.events.on('channels', scanSoon),
      Y.events.on('group', scanSoon),
      Y.events.on('groupGone', ch => { checking.delete(ch.id); scanSoon(); }),
      Y.events.on('groupLeave', onLeave),
      Y.events.on('presence', onPresence),
      Y.events.on('announcements', () => { if (A.isOwner()) deriveSoon(); }),
      Y.events.on('started', () => {
        started = true;
        // first run of this version: everything that happened before counts as read
        if (!U.ls.get(key('notifInit')) ) { U.ls.set(key('notifInit'), Date.now()); if (!Y.notifRead()) Y.markNotifs(Date.now()); }
        scanGroups();
        refresh().finally(() => { ready = true; changed(); });
      }),
      A.events.on('workspace', deriveSoon),
      A.events.on('users', deriveSoon),
    ];
    timer = setInterval(() => { if (started && !(Y.hiddenSince && Date.now() - Y.hiddenSince > 5 * 60000)) refresh(); }, 30000);
  };
  N.stop = function () {
    if (A.me && A.ws && (items.size || myReqs.length)) save();
    unsub.forEach(f => f()); unsub = [];
    clearInterval(timer);
    items.clear(); reqFiles.clear(); shown.clear(); checking.clear();
    for (const k of Object.keys(hints)) delete hints[k];
    known = {}; myReqs = []; arrived = {}; started = false; ready = false;
  };

  SC.notify = N;
})(typeof window !== 'undefined' ? window : globalThis);
