/* Sankyo Chat — sync: channels, messages, polling, presence, retention, search.
 * No DOM access. The UI listens to SC.sync.events:
 *   'messages' (chan)  'channels'  'presence'  'connection' (bool)  'incoming' ({ch, msgs}) */
(function (root) {
  'use strict';
  const SC = root.SC = root.SC || {};
  const U = SC.util, S = SC.store, C = SC.crypto, A = SC.account;
  /** @namespace SC.sync */
  const Y = {};
  Y.events = U.emitter();
  Y.RETENTION = 7 * U.DAY_MS;
  Y.MAX_FILE = 5 * 1024 * 1024;
  Y.MAX_TEXT = 4000;
  Y.MAX_GROUP = 50;
  Y.MAX_ATTACH = 10;

  /**
   * @typedef {Object} Chan
   * @property {string} id
   * @property {'public'|'dm'|'group'} kind
   * @property {any} meta
   * @property {Map<string, any>} msgs
   */
  /** @type {Map<string, Chan>} */
  const chans = new Map();
  Y.chans = chans;
  /** @type {Map<string, {data:any, mtime:number}>} */
  Y.presence = new Map();
  Y.openId = null;
  Y.connected = true;
  Y.startedAt = Date.now();
  Y.idle = false;
  Y.hiddenSince = 0;

  const notMine = new Set();   // channel ids verified as not ours
  const failed = new Set();    // channel ids whose meta couldn't be read (retried on rescan)
  const groupMiss = new Map(); // group id → newest activity ts when we last found we weren't a member (re-checked on newer activity)
  const discovering = new Map();
  let readMap = {};
  let mine = { lastPost: {}, statusText: '', statusTs: 0, acks: {}, notifRead: 0, notifSeen: {}, boardRead: 0 };
  let running = false;
  let timer = 0;

  const err = (msg, code) => Object.assign(new Error(msg), { code });
  const me = () => A.me.id;
  const ID_RE = /^(general|c_[a-z0-9]{6}|g_[a-z0-9]{8}|dm_[a-z0-9]{4}_[a-z0-9]{4})$/;
  const kindOf = id => id.startsWith('dm_') ? 'dm' : id.startsWith('g_') ? 'group' : 'public';
  /** A private channel is an encrypted, invite-only group (meta.channel = true, signed) that an admin created.
   *  Unlike group chats and DMs it keeps its history (no 7-day deletion). */
  Y.isPrivateChannel = ch => !!ch && ch.kind === 'group' && !!(ch.meta && ch.meta.channel);
  const keepsHistory = ch => ch.kind === 'public' || Y.isPrivateChannel(ch);
  const PAYLOAD = ['text', 'mentions', 'replyTo', 'attachments', 'targetId', 'emoji', 'on', 'poll', 'choices'];
  const EVENT_TYPES = ['edit', 'delete', 'hide', 'react', 'pin', 'vote'];
  Y.MAX_POLL_OPTIONS = 10;

  function newChan(id, meta) {
    return {
      id, kind: kindOf(id), meta: meta || null, msgs: new Map(), pendingEvents: new Map(), reactState: new Map(), pins: new Map(),
      seen: new Set(), loadedDays: new Set(), days: null, lastKnown: 0, dirtyTo: 0, unread: 0, mentions: 0,
      outbox: [], keyPs: null, allLoaded: false, version: 0, lastActivity: 0,
    };
  }
  function addChan(ch) {
    if (chans.has(ch.id)) return chans.get(ch.id);
    chans.set(ch.id, ch);
    Y.events.emit('channels');
    return ch;
  }
  function bump(ch, quiet) {
    ch.version++;
    if (quiet) return;
    recount(ch);
    Y.events.emit('messages', ch);
  }

  /* ================= channel info ================= */

  Y.dmOther = ch => ch.id.slice(3).split('_').find(x => x !== me()) || me();
  Y.members = function (ch) {
    if (ch.kind === 'public') return A.activeUsers().map(u => u.id);
    if (ch.kind === 'dm') return ch.id.slice(3).split('_');
    return ((ch.meta && ch.meta.members) || []).filter(id => !hasLeft(ch, id));
  };
  /** Display info, with the admin's renames/archive flags applied. */
  Y.info = function (ch) {
    if (ch.kind === 'public') {
      const o = A.channelOverride(ch.id);
      return { name: o.name || ch.meta.name, description: o.description !== undefined ? o.description : (ch.meta.description || ''), archived: !!o.archived };
    }
    if (ch.kind === 'dm') return { name: A.name(Y.dmOther(ch)), description: '', archived: false };
    const names = Y.members(ch).filter(id => id !== me()).map(A.name).sort();
    if (Y.isPrivateChannel(ch)) return { name: ch.groupName || 'private-channel', description: ch.groupDesc || '', archived: false, private: true };
    return { name: ch.groupName || names.join(', '), description: ch.groupName ? names.join(', ') : '', archived: false };
  };
  Y.isMuted = id => !!U.ls.get(`muted.${A.ws.id}.${me()}`, {})[id];
  Y.setMuted = function (id, on) {
    const k = `muted.${A.ws.id}.${me()}`;
    const m = U.ls.get(k, {});
    if (on) m[id] = true; else delete m[id];
    U.ls.set(k, m);
    Y.events.emit('channels');
  };

  /* ================= keys ================= */

  async function dmKey(ch, enc) {
    const otherId = Y.dmOther(ch);
    const other = A.users.get(otherId) || await A.loadUser(otherId);
    if (!other) throw err('Unknown user');
    let theirJwk = other.keys.ecdh;
    if (enc) {
      const side = enc.s === A.me.ecdhFp ? 's' : enc.r === A.me.ecdhFp ? 'r' : null;
      if (!side) throw err('Encrypted for an older key', 'OLD_KEY');
      theirJwk = A.findKey(other, side === 's' ? enc.r : enc.s, 'ecdh');
      if (!theirJwk) throw err('Unknown key', 'OLD_KEY');
    }
    return C.pairKey(A.me.priv.ecdh, theirJwk, 'sankyo-dm|' + ch.id);
  }
  /* Group keys have generations. Removing someone starts a new generation (meta.gen) with a fresh key
   * wrapped only for the people who stay. Earlier generations live on in meta.past = [{gen, keys, until}]
   * (minus the removed people's wraps) so members can still read older messages. */
  const curGen = ch => (ch.meta && ch.meta.gen) || 0;
  function genWraps(m, gen) {
    if (gen === (m.gen || 0)) return m.keys;
    const p = Array.isArray(m.past) && m.past.find(x => x && x.gen === gen);
    return p ? p.keys : null;
  }
  /** The group's raw AES key for a generation, unwrapped from my entry. */
  async function groupRaw(ch, gen) {
    const m = ch.meta;
    const wraps = genWraps(m, gen);
    const entry = wraps && wraps[me()];
    if (!entry || entry.fp !== A.me.ecdhFp) throw err('No key for you in this group', 'OLD_KEY');
    // whoever wrapped my entry (the creator or a group admin) and the ECDH key they used
    const by = entry.by || m.createdBy;
    const wrapper = A.users.get(by) || await A.loadUser(by);
    const cj = A.findKey(wrapper, entry.from || m.keyFrom, 'ecdh');
    if (!cj) throw err('Unknown creator key', 'OLD_KEY');
    const wk = await C.pairKey(A.me.priv.ecdh, cj, 'sankyo-wrap|' + ch.id);
    const aad = 'wrap|' + ch.id + '|' + me() + (gen ? '|' + gen : '');
    const { k } = await C.decryptJSON(wk, entry, aad);
    return U.unb64(k);
  }
  function groupKey(ch, gen) {
    if (gen === undefined) gen = curGen(ch);
    if (!ch.keyPs) ch.keyPs = new Map();
    let p = ch.keyPs.get(gen);
    if (!p) {
      p = groupRaw(ch, gen).then(raw => C.importAes(raw));
      ch.keyPs.set(gen, p);
      p.catch(() => { setTimeout(() => { if (ch.keyPs.get(gen) === p) ch.keyPs.delete(gen); }, 30000); });
    }
    return p;
  }
  const encGen = enc => (enc && Number.isInteger(enc.g) && enc.g > 0 ? enc.g : 0);
  const readKey = (ch, enc) => ch.kind === 'dm' ? dmKey(ch, enc) : groupKey(ch, encGen(enc));

  /* ================= reading ================= */

  async function verifyRaw(raw) {
    const u = A.users.get(raw.userId) || await A.loadUser(raw.userId);
    const key = A.findKey(u, raw.kid, 'sign');
    return !!key && await C.verify(key, raw);
  }

  Y.verifyRaw = verifyRaw;

  function cleanAttachments(list, kind) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, Y.MAX_ATTACH).filter(a => a && /^[a-z0-9]{8}$/.test(a.fileId) && typeof a.name === 'string').map(a => {
      const o = { fileId: a.fileId, name: a.name.slice(0, 200), size: Number(a.size) || 0, type: String(a.type || '').slice(0, 100) };
      const w = Math.round(Number(a.w)), hgt = Math.round(Number(a.h));
      if (w > 0 && hgt > 0 && w <= 20000 && hgt <= 20000) { o.w = w; o.h = hgt; }
      if (kind === 'public') o.path = String(a.path || ''); else { o.iv = String(a.iv || ''); if (Number.isInteger(a.g) && a.g > 0) o.g = a.g; }
      return o;
    });
  }

  /* ---- leaving a group ----
   * Members can't sign meta.json, so someone who leaves writes channels/<id>/leave/<userId>.json, signed
   * by them (one writer per file). Every app hides them straight away; the creator's app then removes
   * them for real, which rotates the key. A leave only counts if it's newer than the creator's last
   * add of that person (meta.joined), so they can be added back. */
  function hasLeft(ch, uid) {
    const t = ch.leaves && ch.leaves[uid];
    return !!t && t > ((ch.meta && ch.meta.joined && ch.meta.joined[uid]) || 0);
  }
  async function parseLeave(id, uid, raw) {
    if (!raw || raw.type !== 'leave' || raw.channelId !== id || raw.userId !== uid || typeof raw.ts !== 'number') return 0;
    return (await verifyRaw(raw)) ? raw.ts : 0;
  }

  /** Removed members still hold old group keys. Accept their files only from before they were removed,
   *  and accept an old key generation only for files written before (or just after) it was replaced. */
  const SKEW = 10 * 60000;
  function groupSenderOk(ch, raw) {
    const m = ch.meta;
    if (hasLeft(ch, raw.userId) && raw.ts > ch.leaves[raw.userId] + SKEW) return false;
    if (!m.members.includes(raw.userId)) {
      const r = m.removed && m.removed[raw.userId];
      return !!r && raw.ts <= r + SKEW;
    }
    const g = encGen(raw.enc);
    if (g >= curGen(ch)) return true;
    const later = (Array.isArray(m.past) ? m.past : []).find(p => p && p.gen === g);
    return !later || raw.ts <= later.until + SKEW;
  }

  /** Turn a raw file into a plain message/event object (decrypting DMs). */
  async function decode(ch, raw, ok) {
    const out = { id: raw.id, type: raw.type, userId: raw.userId, ts: raw.ts, verified: !!ok, kid: raw.kid };
    let body = raw;
    if (ch.kind !== 'public') {
      if (typeof raw.expires !== 'number') return null;
      if (Y.isPrivateChannel(ch)) out.expires = 0; // kept, like a channel
      else {
        out.expires = Math.min(raw.expires, raw.ts + Y.RETENTION);
        if (out.expires < Date.now()) return null;
      }
      out.enc = raw.enc;
      try { body = await C.decryptJSON(await readKey(ch, raw.enc), raw.enc, ch.id + '|' + raw.id); } catch (e) {
        out.decryptError = true; body = {};
      }
    }
    if (ch.kind === 'group' && out.verified && !groupSenderOk(ch, raw)) out.verified = false;
    PAYLOAD.forEach(k => { if (body[k] !== undefined) out[k] = body[k]; });
    out.text = typeof out.text === 'string' ? out.text.slice(0, Y.MAX_TEXT + 100) : '';
    out.mentions = Array.isArray(out.mentions) ? out.mentions.filter(x => typeof x === 'string').slice(0, 60) : [];
    out.attachments = cleanAttachments(out.attachments, ch.kind);
    if (out.replyTo && typeof out.replyTo === 'object') {
      out.replyTo = { id: String(out.replyTo.id || ''), userId: String(out.replyTo.userId || ''), snippet: String(out.replyTo.snippet || '').slice(0, 160) };
    } else out.replyTo = null;
    out.poll = out.type === 'message' ? cleanPoll(out.poll) : null;
    if (out.choices !== undefined) out.choices = Array.isArray(out.choices) ? out.choices.filter(x => typeof x === 'string').slice(0, Y.MAX_POLL_OPTIONS) : [];
    return out;
  }

  /** A poll is {options: [{id, text}]}; its question is the message text. Everyone gets one vote per poll
   *  (older multiple-choice polls are treated as single choice too). */
  function cleanPoll(p) {
    if (!p || typeof p !== 'object' || !Array.isArray(p.options)) return null;
    const seen = new Set();
    const options = p.options.filter(o => o && typeof o.id === 'string' && /^[a-z0-9]{1,8}$/.test(o.id) && typeof o.text === 'string' && !seen.has(o.id) && seen.add(o.id))
      .slice(0, Y.MAX_POLL_OPTIONS).map(o => ({ id: o.id, text: o.text.slice(0, 100) }));
    return options.length >= 2 ? { options, multi: false } : null;
  }

  /** Who may pin: admins in channels; the group's creator and group admins in groups. */
  function pinAllowed(ch, uid, kid, ts) {
    if (ch.kind === 'public') return A.canActAt(uid, kid, ts);
    if (ch.kind === 'group') return Y.isGroupAdmin(ch, uid);
    return false;
  }

  function applyEvent(ch, msg, ev) {
    if (ev.type === 'edit') {
      if (ev.userId === msg.userId && ev.ts >= msg.editTs) { msg.text = ev.text; msg.mentions = ev.mentions; msg.edited = true; msg.editTs = ev.ts; }
    } else if (ev.type === 'delete') {
      if (ev.userId === msg.userId) msg.deleted = true;
    } else if (ev.type === 'hide') {
      if (ch.kind === 'public' && A.canActAt(ev.userId, ev.kid, ev.ts)) msg.hidden = true;
    } else if (ev.type === 'react') {
      // One reaction per person per message: it's whatever their newest reaction event says ("on" = that
      // emoji, "off" = none), so picking another emoji replaces the old one. Newest by time (then id),
      // so the result doesn't depend on the order the files arrive in.
      if (typeof ev.emoji !== 'string' || !ev.emoji || ev.emoji.length > 16) return;
      const k = msg.id + '|' + ev.userId;
      const prev = ch.reactState.get(k);
      if (prev && (prev.ts > ev.ts || (prev.ts === ev.ts && prev.id > ev.id))) return;
      ch.reactState.set(k, { ts: ev.ts, id: ev.id });
      const now = ev.on ? ev.emoji : null;
      for (const [e, set] of msg.reactions) if (e !== now && set.delete(ev.userId) && !set.size) msg.reactions.delete(e);
      if (now) { let set = msg.reactions.get(now); if (!set) msg.reactions.set(now, set = new Set()); set.add(ev.userId); }
    } else if (ev.type === 'vote') {
      if (!msg.poll || !Array.isArray(ev.choices)) return;
      // one vote per person: only their newest vote event counts (by time, then id, so every device agrees)
      const prev = msg.votes.get(ev.userId);
      if (prev && (prev.ts > ev.ts || (prev.ts === ev.ts && prev.id > ev.id))) return;
      const valid = new Set(msg.poll.options.map(o => o.id));
      const choices = U.uniq(ev.choices.filter(c => valid.has(c))).slice(0, 1);
      msg.votes.set(ev.userId, { ts: ev.ts, id: ev.id, choices });
    }
  }

  /** Merge one decoded item into a channel. @returns {boolean} new message added */
  function apply(ch, m) {
    if (m.type === 'message') {
      if (ch.msgs.has(m.id)) return false;
      // only polls created by an admin (at the time) count; anything else shows as a plain message
      if (m.poll && !(m.verified && A.canActAt(m.userId, m.kid, m.ts))) m.poll = null;
      Object.assign(m, { edited: false, editTs: 0, deleted: false, hidden: false, reactions: new Map(), votes: new Map() });
      ch.msgs.set(m.id, m);
      if (m.ts > ch.lastActivity) ch.lastActivity = m.ts;
      const pend = ch.pendingEvents.get(m.id);
      if (pend) { ch.pendingEvents.delete(m.id); pend.sort((a, b) => a.ts - b.ts).forEach(ev => applyEvent(ch, m, ev)); }
      return true;
    }
    if (!m.verified || !m.targetId || !EVENT_TYPES.includes(m.type)) return false;
    if (m.type === 'pin') {
      // pins are tracked per channel, so the pinned bar works even before the message itself is loaded
      if (!pinAllowed(ch, m.userId, m.kid, m.ts)) return false;
      const prev = ch.pins.get(m.targetId);
      if (!prev || prev.ts <= m.ts) ch.pins.set(m.targetId, { on: !!m.on, ts: m.ts, by: m.userId });
      return false;
    }
    const target = ch.msgs.get(m.targetId);
    if (target) applyEvent(ch, target, m);
    else {
      if (!ch.pendingEvents.has(m.targetId)) ch.pendingEvents.set(m.targetId, []);
      ch.pendingEvents.get(m.targetId).push(m);
    }
    return false;
  }

  const readFailures = new Map();

  /** Read every not-yet-seen file in one day folder. */
  async function loadDay(ch, day, opts = {}) {
    const dir = `channels/${ch.id}/${day}`;
    const listKey = `L|${ch.id}|${day}`;
    let names = null;
    const oldDay = day < U.dayKey(Date.now() - 2 * U.DAY_MS);
    if (opts.cacheListing && oldDay && ch.kind === 'public') names = await U.idb.get('cache', listKey);
    if (!names) {
      names = await S.list(dir, 'file');
      if (opts.cacheListing && oldDay && ch.kind === 'public') U.idb.set('cache', listKey, names);
    }
    if (names.length && ch.days && !ch.days.includes(day)) { ch.days.push(day); ch.days.sort(); }
    const fresh = names.filter(n => !ch.seen.has(n) && U.MSG_RE.test(n));
    ch.loadedDays.add(day);
    if (!fresh.length) return [];
    fresh.forEach(n => ch.seen.add(n));
    const cacheKeys = fresh.map(n => `${ch.id}/${day}/${n}`);
    const cached = ch.kind === 'public' ? await U.idb.getMany('cache', cacheKeys) : {};
    const toCache = [];
    const prepared = await U.mapLimit(fresh, 12, async (n, i) => {
      const parsed = U.parseMsgName(n);
      let raw, ok;
      const c = cached[cacheKeys[i]];
      if (c) { raw = c.raw; ok = c.ok; }
      if (!raw) {
        raw = await S.readJSON(`${dir}/${n}`);
        if (!raw) {
          const f = (readFailures.get(n) || 0) + 1;
          readFailures.set(n, f);
          if (f < 3) ch.seen.delete(n);
          return null;
        }
      }
      if (raw.id !== parsed.id || raw.userId !== parsed.userId || raw.ts !== parsed.ts || raw.channelId !== ch.id ||
          (raw.type === 'message') === parsed.event) return null;
      if (ok === undefined) {
        ok = await verifyRaw(raw);
        if (ok && ch.kind === 'public') toCache.push([cacheKeys[i], { raw, ok }]);
      }
      return decode(ch, raw, ok);
    });
    if (toCache.length) U.idb.setMany('cache', toCache);
    const items = prepared.filter(Boolean).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    const added = [];
    for (const m of items) if (apply(ch, m)) added.push(m);
    bump(ch, opts.quiet);
    if (added.length && chans.get(ch.id) === ch) Y.events.emit('loaded', { ch, msgs: added });
    if (!opts.quiet) {
      const incoming = added.filter(m => m.ts > Y.startedAt && m.userId !== me());
      if (incoming.length && chans.get(ch.id) === ch) Y.events.emit('incoming', { ch, msgs: incoming });
    }
    return added;
  }

  async function listDays(ch) {
    let days = (await S.list(`channels/${ch.id}`, 'directory')).filter(d => U.DAY_RE.test(d));
    if (!keepsHistory(ch)) { const min = U.dayKey(Date.now() - Y.RETENTION - U.DAY_MS); days = days.filter(d => d >= min); }
    ch.days = U.uniq(days.concat(ch.days || [])).sort();
    return ch.days;
  }
  const countMsgs = ch => ch.msgs.size;

  /** Make sure at least `want` messages (newest first) are in memory. */
  Y.ensureLoaded = async function (ch, want = 50) {
    if (!ch.days) await listDays(ch);
    for (const d of ch.days.slice().reverse()) {
      if (countMsgs(ch) >= want) break;
      if (!ch.loadedDays.has(d)) await loadDay(ch, d);
    }
    ch.allLoaded = ch.days.every(d => ch.loadedDays.has(d));
    bump(ch);
  };
  Y.loadOlder = ch => Y.ensureLoaded(ch, countMsgs(ch) + 50);
  /** Load every day from now back to the day of `ts`. */
  Y.loadUntil = async function (ch, ts) {
    if (!ch.days) await listDays(ch);
    const target = U.dayKey(ts);
    for (const d of ch.days.slice().reverse()) {
      if (d < target) break;
      if (!ch.loadedDays.has(d)) await loadDay(ch, d);
    }
    ch.allLoaded = ch.days.every(d => ch.loadedDays.has(d));
    bump(ch);
  };

  /** Messages sorted for display (expired DMs left out). */
  Y.sorted = function (ch) {
    if (ch._sortedV !== ch.version) {
      const now = Date.now();
      ch._sorted = Array.from(ch.msgs.values()).filter(m => !m.expires || m.expires > now)
        .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
      ch._sortedV = ch.version;
    }
    return ch._sorted;
  };

  /* ================= unread ================= */

  const readKeyName = () => `read.${A.ws.id}.${me()}`;
  const baseline = () => { const u = A.users.get(me()); return u ? u.created : 0; };
  Y.lastRead = id => Math.max(readMap[id] || 0, baseline());
  function recount(ch) {
    const lr = Y.lastRead(ch.id);
    const now = Date.now();
    let unread = 0, mentions = 0;
    for (const m of ch.msgs.values()) {
      if (m.ts <= lr || m.userId === me() || m.deleted || m.hidden) continue;
      if (m.expires && m.expires < now) continue;
      unread++;
      if (ch.kind !== 'public' || m.mentions.includes(me()) || m.mentions.includes('channel')) mentions++;
    }
    const changed = ch.unread !== unread || ch.mentions !== mentions;
    ch.unread = unread; ch.mentions = mentions;
    if (changed) Y.events.emit('channels');
  }
  Y.markRead = function (ch) {
    let last = 0;
    for (const m of ch.msgs.values()) if (m.ts > last) last = m.ts;
    if (last > (readMap[ch.id] || 0)) {
      readMap[ch.id] = last;
      U.ls.set(readKeyName(), readMap);
      recount(ch);
      if (ch.kind !== 'public' && Y.receiptsOn()) heartbeat(); // tell the others promptly
    }
  };

  /* ---- read receipts ("Seen by") ----
   * Each person's presence file carries seen = {conversationId: ts of the newest message they've read},
   * for DMs and groups only, and only while "Read receipts" is on. Like WhatsApp, it works both ways:
   * turn it off and you stop seeing other people's receipts too. */
  const receiptsKey = () => `receipts.${A.ws.id}.${me()}`;
  Y.receiptsOn = () => U.ls.get(receiptsKey(), true) !== false;
  Y.setReceipts = function (on) { U.ls.set(receiptsKey(), !!on); heartbeat(); Y.events.emit('presence', true); };
  function mySeen() {
    if (!Y.receiptsOn()) return undefined;
    const out = {}, floor = Date.now() - 8 * U.DAY_MS;
    for (const ch of chans.values()) {
      if (ch.kind === 'public') continue;
      const t = readMap[ch.id] || 0;
      if (t > floor) out[ch.id] = t;
    }
    return out;
  }
  /** Other members who have read up to (at least) ts in this conversation. */
  Y.seenBy = function (ch, ts) {
    if (!ch || ch.kind === 'public' || !Y.receiptsOn()) return [];
    return Y.members(ch).filter(id => {
      if (id === me()) return false;
      const p = Y.presence.get(id);
      const t = p && p.data && p.data.seen && p.data.seen[ch.id];
      return typeof t === 'number' && t >= ts;
    });
  };
  Y.totalUnread = () => Array.from(chans.values()).reduce((n, ch) => n + (Y.info(ch).archived ? 0 : ch.unread), 0);

  /* ================= writing ================= */

  async function buildRaw(ch, type, id, ts, payload) {
    const raw = { v: 1, id, type, channelId: ch.id, userId: me(), ts, kid: A.me.signFp };
    const clean = {};
    PAYLOAD.forEach(k => { if (payload[k] !== undefined) clean[k] = payload[k]; });
    if (ch.kind === 'public') Object.assign(raw, clean);
    else {
      raw.expires = Y.isPrivateChannel(ch) ? 0 : ts + Y.RETENTION;
      raw.files = (clean.attachments || []).map(a => a.fileId);
      const aad = ch.id + '|' + id;
      if (ch.kind === 'dm') {
        const other = A.users.get(Y.dmOther(ch));
        if (!other) throw err('Unknown user');
        raw.enc = await C.encryptJSON(await dmKey(ch), clean, aad);
        raw.enc.s = A.me.ecdhFp; raw.enc.r = other.ecdhFp;
      } else {
        const gen = curGen(ch);
        raw.enc = await C.encryptJSON(await groupKey(ch, gen), clean, aad);
        if (gen) raw.enc.g = gen;
      }
    }
    raw.sig = await C.sign(A.me.priv.sign, raw);
    return raw;
  }

  function noteMyPost(id, ts) {
    mine.lastPost[id] = Math.max(mine.lastPost[id] || 0, ts);
    heartbeat();
  }
  Y.noteMyPost = noteMyPost;

  let lastWriteTs = 0;
  async function writeItem(ch, type, payload) {
    if (!Y.connected) throw err('Lost access to the shared folder', 'OFFLINE');
    // strictly increasing per PC, so two quick clicks (react, then un-react) never share a timestamp
    const ts = lastWriteTs = Math.max(Date.now(), lastWriteTs + 1);
    const id = `${ts}_${me()}_${U.rand(4)}`;
    const raw = await buildRaw(ch, type, id, ts, payload);
    const name = id + (type === 'message' ? '.json' : '.ev.json');
    const day = U.dayKey(ts);
    await S.writeJSON(`channels/${ch.id}/${day}/${name}`, raw);
    ch.seen.add(name);
    if (ch.days && !ch.days.includes(day)) { ch.days.push(day); ch.days.sort(); }
    const m = await decode(ch, raw, true);
    if (m) apply(ch, m);
    noteMyPost(ch.id, ts);
    return m;
  }

  async function uploadFiles(ch, files) {
    const out = [];
    for (const f of files) {
      if (f.size > Y.MAX_FILE) throw err(`“${f.name}” is over 5 MB.`);
      const fileId = U.rand(8);
      const base = { fileId, name: String(f.name).slice(0, 200), size: f.size, type: String(f.type || '').slice(0, 100) };
      // remember image dimensions so readers can reserve the right space before it loads
      if (/^image\//.test(base.type) && typeof root.createImageBitmap === 'function') {
        try { const bmp = await root.createImageBitmap(f); base.w = bmp.width; base.h = bmp.height; bmp.close(); } catch { /* not decodable here */ }
      }
      if (ch.kind === 'public') {
        const path = `files/${fileId}_${U.safeFileName(f.name)}`;
        await S.write(path, f);
        out.push(Object.assign(base, { path }));
      } else {
        const gen = ch.kind === 'group' ? curGen(ch) : 0;
        const key = ch.kind === 'dm' ? await dmKey(ch) : await groupKey(ch, gen);
        const enc = await C.encryptBytes(key, await f.arrayBuffer(), 'file|' + fileId);
        await S.write(`files/${fileId}.bin`, enc.data);
        out.push(Object.assign(base, { iv: enc.iv }, gen ? { g: gen } : null));
      }
    }
    return out;
  }

  function friendly(e) {
    if (!e) return 'Unknown error';
    if (S.isAccessError(e)) return 'Lost access to the shared folder';
    if (e.name === 'NoModificationAllowedError') return 'Shared folder busy';
    return e.message || String(e);
  }
  function handleErr(e) {
    if (S.isAccessError(e)) setConnected(false);
    else if (!e || e.code !== 'OFFLINE') console.warn(e);
  }

  /** Mention ids found in text: user ids, plus 'channel' for @channel. */
  Y.findMentions = function (ch, text) {
    const out = [];
    const lower = String(text).toLowerCase();
    if (ch.kind === 'public' && /(^|\s)@channel(?![\p{L}\p{N}])/u.test(lower)) out.push('channel');
    const users = A.activeUsers().slice().sort((a, b) => b.name.length - a.name.length);
    for (const u of users) {
      const needle = '@' + u.name.toLowerCase();
      let i = lower.indexOf(needle);
      while (i >= 0) {
        const after = lower[i + needle.length];
        if (!after || !/[\p{L}\p{N}]/u.test(after)) { out.push(u.id); break; }
        i = lower.indexOf(needle, i + 1);
      }
    }
    return U.uniq(out);
  };

  /** Send a message. It shows at once (grey clock) and stays as "Retry" if writing fails. */
  Y.send = async function (ch, { text, replyTo, files }) {
    text = String(text || '').replace(/\s+$/, '');
    files = files || [];
    if (text.length > Y.MAX_TEXT) throw err(`Messages can be at most ${Y.MAX_TEXT.toLocaleString()} characters.`);
    if (!text.trim() && !files.length) return;
    if (files.length > Y.MAX_ATTACH) throw err(`Attach at most ${Y.MAX_ATTACH} files at a time.`);
    const big = files.find(f => f.size > Y.MAX_FILE);
    if (big) throw err(`“${big.name}” is over the 5 MB limit.`);
    const local = {
      local: true, id: 'local_' + U.rand(8), userId: me(), ts: Date.now(), text, replyTo: replyTo || null,
      mentions: Y.findMentions(ch, text), files, uploaded: false, verified: true, reactions: new Map(),
      attachments: files.map(f => ({ name: f.name, size: f.size, type: f.type })), status: 'sending', error: '',
    };
    ch.outbox.push(local);
    bump(ch);
    await Y.retry(ch, local);
  };
  Y.retry = async function (ch, local) {
    local.status = 'sending'; local.error = '';
    bump(ch);
    try {
      if (!Y.connected) throw err('Lost access to the shared folder', 'OFFLINE');
      if (!local.uploaded) { local.attachments = await uploadFiles(ch, local.files); local.uploaded = true; }
      await writeItem(ch, 'message', { text: local.text, mentions: local.mentions, replyTo: local.replyTo, attachments: local.attachments });
      ch.outbox = ch.outbox.filter(x => x !== local);
      Y.markRead(ch);
    } catch (e) {
      local.status = 'failed'; local.error = friendly(e);
      handleErr(e);
    }
    bump(ch);
  };
  Y.discard = function (ch, local) { ch.outbox = ch.outbox.filter(x => x !== local); bump(ch); };

  async function event(ch, type, payload) {
    try { await writeItem(ch, type, payload); } catch (e) { handleErr(e); throw err(friendly(e)); } finally { bump(ch); }
  }
  Y.edit = (ch, msg, text) => {
    text = String(text).replace(/\s+$/, '');
    if (!text.trim()) throw err('A message can’t be empty. Delete it instead.');
    if (text.length > Y.MAX_TEXT) throw err(`Messages can be at most ${Y.MAX_TEXT.toLocaleString()} characters.`);
    return event(ch, 'edit', { targetId: msg.id, text, mentions: Y.findMentions(ch, text) });
  };
  Y.deleteMessage = async function (ch, msg) {
    await event(ch, 'delete', { targetId: msg.id });
    for (const a of msg.attachments || []) {
      S.remove(ch.kind === 'public' ? a.path : `files/${a.fileId}.bin`).catch(() => {});
    }
  };
  Y.hide = (ch, msg) => event(ch, 'hide', { targetId: msg.id });
  /** Clicking your own reaction removes it; clicking another emoji replaces it (one reaction per person). */
  Y.react = (ch, msg, emoji) => {
    const set = msg.reactions.get(emoji);
    return event(ch, 'react', { targetId: msg.id, emoji, on: !(set && set.has(me())) });
  };

  /* ---- pins ---- */
  Y.canPin = ch => !!ch && (ch.kind === 'public' ? A.isAdmin() : ch.kind === 'group' ? Y.isGroupAdmin(ch) : false);
  Y.isPinned = (ch, id) => { const p = ch.pins.get(id); return !!(p && p.on); };
  Y.pin = (ch, msg, on) => {
    if (!Y.canPin(ch)) return Promise.reject(err(ch.kind === 'group' ? 'Only the group’s creator and group admins can pin messages.' : 'Only admins can pin messages.'));
    return event(ch, 'pin', { targetId: msg.id, on: !!on });
  };
  /** Pinned messages, newest pin first. `msg` is null while the message isn't loaded yet. */
  Y.pinnedList = function (ch) {
    if (!ch || !ch.pins) return [];
    const out = [];
    for (const [id, p] of ch.pins) {
      if (!p.on) continue;
      const msg = ch.msgs.get(id) || null;
      if (msg && (msg.deleted || msg.hidden || (msg.expires && msg.expires < Date.now()))) continue;
      const pn = U.parseMsgName(id + '.json');
      if (!pn) continue;
      if (!msg && ch.kind !== 'public' && pn.ts + Y.RETENTION < Date.now()) continue;
      out.push({ id, ts: pn.ts, pinTs: p.ts, by: p.by, msg });
    }
    return out.sort((a, b) => b.pinTs - a.pinTs);
  };

  /* ---- polls ---- */
  Y.myVote = msg => { const v = msg.votes && msg.votes.get(me()); return v ? v.choices : []; };
  /** One vote per person: picking another option moves it, picking mine again takes it back. */
  Y.vote = (ch, msg, optionId) => {
    if (!msg.poll) return Promise.resolve();
    const mineNow = Y.myVote(msg);
    let choices;
    if (mineNow.includes(optionId)) choices = mineNow.filter(x => x !== optionId);
    else choices = [optionId];
    return event(ch, 'vote', { targetId: msg.id, choices });
  };
  /** Per option: the people who voted for it. */
  Y.pollResults = function (msg) {
    const out = new Map(msg.poll.options.map(o => [o.id, []]));
    for (const [uid, v] of msg.votes) for (const c of v.choices) if (out.has(c)) out.get(c).push(uid);
    let voters = 0;
    for (const v of msg.votes.values()) if (v.choices.length) voters++;
    return { byOption: out, voters };
  };
  Y.sendPoll = async function (ch, { question, options }) {
    if (!A.isAdmin()) throw err('Only admins can create polls.');
    question = String(question || '').replace(/\s+$/, '').trim();
    if (!question) throw err('Write the question first.');
    if (question.length > 300) throw err('Questions can be at most 300 characters.');
    const texts = (options || []).map(o => String(o || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (texts.length < 2) throw err('Add at least two options.');
    if (texts.length > Y.MAX_POLL_OPTIONS) throw err(`Polls can have up to ${Y.MAX_POLL_OPTIONS} options.`);
    if (new Set(texts.map(t => t.toLowerCase())).size !== texts.length) throw err('Two options are the same.');
    if (texts.some(t => t.length > 100)) throw err('Options can be at most 100 characters.');
    const poll = { options: texts.map((text, i) => ({ id: 'o' + (i + 1), text })), multi: false };
    await event(ch, 'message', { text: question, mentions: Y.findMentions(ch, question), poll });
    Y.markRead(ch);
  };

  /** Attachment contents as a Blob (DM files are decrypted in memory). */
  Y.readAttachment = async function (ch, msg, att) {
    if (ch.kind === 'public') {
      if (!/^files\/[a-z0-9]{8}_[^/\\]+$/.test(att.path || '')) throw err('Invalid attachment path');
      const f = await S.readFile(att.path);
      if (!f) throw err('This file is no longer on the shared drive.');
      return f;
    }
    const f = await S.readFile(`files/${att.fileId}.bin`);
    if (!f) throw err('This file has been deleted.');
    const pt = await C.decryptBytes(await readKey(ch, ch.kind === 'group' ? { g: att.g || 0 } : msg.enc), att.iv, await f.arrayBuffer(), 'file|' + att.fileId);
    return new Blob([pt], { type: att.type || 'application/octet-stream' });
  };

  /* ================= creating conversations ================= */

  Y.normalizeChannelName = n => String(n || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, '').replace(/-+/g, '-').slice(0, 40);

  Y.createChannel = async function ({ name, description }) {
    if (!A.isAdmin()) throw err('Only admins can create channels.');
    name = Y.normalizeChannelName(name);
    if (name.length < 2) throw err('Channel names need at least 2 letters or numbers.');
    const taken = Array.from(chans.values()).some(c => c.kind === 'public' && Y.info(c).name === name);
    if (taken) throw err(`#${name} already exists.`);
    const id = 'c_' + U.rand(6);
    const meta = { v: 1, id, type: 'public', name, description: String(description || '').trim().slice(0, 250), createdBy: me(), ts: Date.now(), kid: A.me.signFp };
    meta.sig = await C.sign(A.me.priv.sign, meta);
    await S.writeJSON(`channels/${id}/meta.json`, meta);
    const ch = addChan(newChan(id, meta));
    ch.days = []; ch.allLoaded = true;
    noteMyPost(id, meta.ts);
    return ch;
  };

  /** Open (or create) a 1:1 DM or a group DM with these people. */
  Y.openConversation = async function (userIds) {
    const others = U.uniq(userIds.filter(id => id !== me()));
    if (!others.length) throw err('Pick at least one person.');
    if (others.length === 1) {
      const id = U.dmId(me(), others[0]);
      return chans.get(id) || addChan(newChan(id, null));
    }
    if (others.length + 1 > Y.MAX_GROUP) throw err(`Group messages can have up to ${Y.MAX_GROUP} people.`);
    const members = [me()].concat(others).sort();
    const existing = Array.from(chans.values()).find(c => c.kind === 'group' && !c.meta.nameEnc && c.meta.members.slice().sort().join() === members.join());
    if (existing) return existing;
    return makeGroup(members, '');
  };

  Y.normalizeGroupName = n => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 60);

  /** Anyone can create a named group chat. The name is encrypted with the group key, like the messages. */
  Y.createGroup = async function ({ name, userIds, listed }) {
    name = Y.normalizeGroupName(name);
    if (name.length < 2) throw err('Group names need at least 2 characters.');
    const others = U.uniq(userIds.filter(id => id !== me()));
    if (!others.length) throw err('Pick at least one person.');
    if (others.length + 1 > Y.MAX_GROUP) throw err(`Group chats can have up to ${Y.MAX_GROUP} people.`);
    return makeGroup([me()].concat(others).sort(), name, { listed: !!listed });
  };

  /** Admins: an encrypted, invite-only channel. `replaces` = id of a public channel being made private (its name may be reused). */
  Y.createPrivateChannel = async function ({ name, description, userIds, replaces, listed }) {
    if (!A.isAdmin()) throw err('Only admins can create private channels.');
    name = Y.normalizeChannelName(name);
    if (name.length < 2) throw err('Channel names need at least 2 letters or numbers.');
    const taken = Array.from(chans.values()).some(c => c.id !== replaces && (c.kind === 'public' ? !Y.info(c).archived : Y.isPrivateChannel(c)) && Y.info(c).name === name);
    if (taken) throw err(`#${name} already exists.`);
    const others = U.uniq((userIds || []).filter(id => id !== me()));
    if (!others.length) throw err('Invite at least one person.');
    if (others.length + 1 > Y.MAX_GROUP) throw err(`Private channels can have up to ${Y.MAX_GROUP} people.`);
    return makeGroup([me()].concat(others).sort(), name, { channel: true, description: String(description || '').trim().slice(0, 250), listed: !!listed, replaces });
  };

  /** Wrap the group key for each of these people (from my ECDH key to theirs; `by`/`from` say whose). */
  async function wrapFor(id, rawKey, uids, keys, gen) {
    for (const uid of uids) {
      const u = A.users.get(uid) || await A.loadUser(uid);
      if (!u || A.isRemoved(uid)) throw err('One of the people you picked is no longer in the workspace.');
      const wk = await C.pairKey(A.me.priv.ecdh, u.keys.ecdh, 'sankyo-wrap|' + id);
      const enc = await C.encryptJSON(wk, { k: U.b64(rawKey) }, 'wrap|' + id + '|' + uid + (gen ? '|' + gen : ''));
      keys[uid] = { fp: u.ecdhFp, iv: enc.iv, ct: enc.ct, by: me(), from: A.me.ecdhFp };
    }
    return keys;
  }

  async function makeGroup(members, name, opts = {}) {
    const id = 'g_' + U.rand(8);
    const rawKey = C.randomRaw();
    const keys = await wrapFor(id, rawKey, members, {});
    const meta = { v: 1, id, type: 'group', members, createdBy: me(), by: me(), ts: Date.now(), rev: 0, keyFrom: A.me.ecdhFp, keys, kid: A.me.signFp };
    if (opts.channel) meta.channel = true;
    if (opts.listed && name) meta.listed = true;
    const aes = await C.importAes(rawKey);
    if (name) meta.nameEnc = await C.encryptJSON(aes, opts.description ? { name, description: opts.description } : { name }, 'name|' + id);
    meta.sig = await C.sign(A.me.priv.sign, meta);
    await S.writeJSON(`channels/${id}/meta.json`, meta);
    const fresh = newChan(id, meta);
    fresh.keyPs = new Map([[0, Promise.resolve(aes)]]);
    if (name) fresh.groupName = name;
    if (opts.description) fresh.groupDesc = opts.description;
    const ch = addChan(fresh);
    ch.days = []; ch.allLoaded = true;
    noteMyPost(id, meta.ts);
    if (meta.listed) await syncDirectory(ch).catch(e => console.warn('directory', e));
    // admins' named groups and private channels are reported to the super admin (the name is sealed for them only)
    if (name && A.isAdmin() && !A.isOwner()) {
      const kind = opts.replaces ? 'private-channel.make-private' : opts.channel ? 'private-channel.create' : 'group.create';
      await A.audit(kind, id, members.length, { name }).catch(e => console.warn('audit', e));
    }
    return ch;
  }

  /* ---- group directory ("Browse groups") ----
   * A group chat or private channel whose creator ticks "Let people find and request to join" gets meta.listed = true
   * and a plain, signed directory/<groupId>.json holding only its name, description and member count. Its messages
   * stay encrypted. Turning it off deletes the file. */
  async function syncDirectory(ch) {
    if (!Y.canManageGroup(ch)) return;
    const path = `directory/${ch.id}.json`;
    if (!ch.meta.listed || !ch.groupName) { await S.remove(path); return; }
    const entry = { v: 1, id: ch.id, name: ch.groupName, description: ch.groupDesc || '', count: Y.members(ch).length,
      channel: !!ch.meta.channel, createdBy: ch.meta.createdBy, by: me(), ts: Date.now(), kid: A.me.signFp };
    entry.sig = await C.sign(A.me.priv.sign, entry);
    await S.writeJSON(path, entry);
  }
  Y.syncDirectory = syncDirectory;

  /** Decrypt a named group's name in the background, then refresh the sidebar. */
  function loadGroupName(ch) {
    if (!ch || ch.kind !== 'group' || !ch.meta.nameEnc) return;
    const meta = ch.meta;
    groupKey(ch).then(k => C.decryptJSON(k, meta.nameEnc, 'name|' + ch.id)).then(o => {
      const n = Y.normalizeGroupName(o && o.name);
      const d = typeof (o && o.description) === 'string' ? o.description.slice(0, 250) : '';
      if (n && ch.meta === meta && (n !== ch.groupName || d !== (ch.groupDesc || ''))) { ch.groupName = n; ch.groupDesc = d; Y.events.emit('channels'); Y.events.emit('group', ch); }
    }).catch(e => console.warn('group name', ch.id, e));
  }

  /* ---- group roles ----
   * The creator can appoint group admins. The admin list is its own block, meta.admins = {id, list, arev, kid, sig},
   * signed by the creator alone, so an admin can carry it into a meta.json they sign but can't change it.
   * meta.json may be signed by the creator or by anyone on that list (meta.by says who). */
  Y.isGroupCreator = (ch, uid = me()) => !!ch && ch.kind === 'group' && !!ch.meta && ch.meta.createdBy === uid;
  Y.groupAdmins = ch => {
    const a = ch && ch.kind === 'group' && ch.meta && ch.meta.admins;
    return a && Array.isArray(a.list) ? a.list.filter(id => ch.meta.members.includes(id) && !hasLeft(ch, id)) : [];
  };
  Y.isGroupAdmin = (ch, uid = me()) => Y.isGroupCreator(ch, uid) || Y.groupAdmins(ch).includes(uid);
  Y.canManageGroup = ch => Y.isGroupAdmin(ch, me());

  async function verifyAdmins(meta) {
    const a = meta.admins;
    if (!a) return true;
    if (a.id !== meta.id || !Array.isArray(a.list) || typeof a.arev !== 'number') return false;
    const creator = A.users.get(meta.createdBy) || await A.loadUser(meta.createdBy);
    return C.verify(A.findKey(creator, a.kid, 'sign'), a);
  }
  async function signAdmins(id, list, arev) {
    const a = { id, list: U.uniq(list).sort(), arev, kid: A.me.signFp };
    a.sig = await C.sign(A.me.priv.sign, a);
    return a;
  }

  /**
   * Group creator or group admin: rename, add, remove; only the creator sets `admins`.
   * meta.json is rewritten with a higher `rev` and re-signed by whoever made the change.
   * People added get the current key, so they can read what is still in the group (7 days at most).
   * Removing anyone rotates the key: a new generation is wrapped only for the people who stay.
   */
  Y.updateGroup = async function (ch, { name, addIds, removeIds, admins, listed }) {
    if (!Y.connected) throw err('Lost access to the shared folder', 'OFFLINE');
    await refreshGroupMeta(ch, 0, true); // build on the newest version another admin may have written
    if (!chans.has(ch.id)) throw err('You’re no longer in this group.');
    if (!Y.canManageGroup(ch)) throw err('Only the group’s creator and group admins can change it.');
    const old = ch.meta;
    const creator = Y.isGroupCreator(ch);
    const oldAdmins = (old.admins && old.admins.list) || [];
    const drop = U.uniq((removeIds || []).filter(id => old.members.includes(id) && id !== me()));
    if (drop.includes(old.createdBy)) throw err('Nobody can remove the group’s creator.');
    if (!creator && drop.some(id => oldAdmins.includes(id) && !hasLeft(ch, id))) throw err('Only the group’s creator can remove a group admin.');
    if (!creator && admins !== undefined) throw err('Only the group’s creator can choose group admins.');
    const add = U.uniq((addIds || []).filter(id => !old.members.includes(id)));
    const members = old.members.filter(id => !drop.includes(id)).concat(add).sort();
    if (members.length > Y.MAX_GROUP) throw err(`Group chats can have up to ${Y.MAX_GROUP} people.`);
    if (members.length < 2) throw err('A group needs at least one other person.');
    const now = Date.now();
    const gen = curGen(ch);
    let oldRaw;
    try { oldRaw = await groupRaw(ch, gen); } catch {
      throw err('Your security key changed (for example after a password reset), so you can’t change this group yet. Ask another group admin to change something in the group (for example add or rename); that restores your access.');
    }
    let nameText = null, descText = '';
    if (old.nameEnc) {
      const o = await C.decryptJSON(await C.importAes(oldRaw), old.nameEnc, 'name|' + ch.id);
      nameText = o.name; descText = typeof o.description === 'string' ? o.description : '';
    }
    if (name !== undefined) {
      nameText = Y.isPrivateChannel(ch) ? Y.normalizeChannelName(name) : Y.normalizeGroupName(name);
      if (nameText.length < 2) throw err(Y.isPrivateChannel(ch) ? 'Channel names need at least 2 letters or numbers.' : 'Group names need at least 2 characters.');
    }
    const meta = Object.assign({}, old, { members, rev: (old.rev || 0) + 1, updated: now, by: me(), kid: A.me.signFp });
    delete meta.sig;
    if (listed !== undefined) { if (listed && nameText) meta.listed = true; else delete meta.listed; }
    const removed = Object.assign({}, old.removed);
    drop.forEach(id => { removed[id] = now; });
    add.forEach(id => { delete removed[id]; });
    meta.removed = removed;
    const joined = Object.assign({}, old.joined);
    add.forEach(id => { joined[id] = now; });
    drop.forEach(id => { delete joined[id]; });
    meta.joined = joined;
    // the admin list: only the creator re-signs it (dropping people who left or were removed)
    if (creator) {
      const want = U.uniq((admins !== undefined ? admins : oldAdmins).filter(id => members.includes(id) && id !== me() && (add.includes(id) || !hasLeft(ch, id))));
      if (want.slice().sort().join() !== oldAdmins.slice().sort().join()) {
        meta.admins = await signAdmins(ch.id, want, ((old.admins && old.admins.arev) || 0) + 1);
      }
    }
    let rawKey = oldRaw;
    if (drop.length) {
      // new key generation; keep the old one (minus the removed people) so the rest can read history
      const keep = (keys) => { const o = {}; for (const id of members) if (keys && keys[id]) o[id] = keys[id]; return o; };
      const floor = Y.isPrivateChannel(ch) ? -Infinity : now - Y.RETENTION - U.DAY_MS; // private channels keep every generation
      meta.past = (Array.isArray(old.past) ? old.past : []).filter(p => p && p.until > floor).map(p => Object.assign({}, p, { keys: keep(p.keys) }))
        .concat([{ gen, keys: keep(old.keys), until: now }]);
      meta.gen = gen + 1;
      rawKey = C.randomRaw();
      meta.keys = await wrapFor(ch.id, rawKey, members, {}, meta.gen);
    } else {
      // also re-wrap for existing members whose key changed (password reset), so they can read the group again
      const stale = old.members.filter(id => { const u = A.users.get(id); return u && !A.isRemoved(id) && (!old.keys[id] || old.keys[id].fp !== u.ecdhFp); });
      meta.keys = await wrapFor(ch.id, rawKey, add.concat(stale), Object.assign({}, old.keys), gen);
    }
    if (nameText) meta.nameEnc = await C.encryptJSON(await C.importAes(rawKey), descText ? { name: nameText, description: descText } : { name: nameText }, 'name|' + ch.id);
    // private channels: people added can read the whole history, so also give them the older key generations
    if (Y.isPrivateChannel(ch) && add.length && Array.isArray(meta.past)) {
      meta.past = await Promise.all(meta.past.map(async pg => {
        let raw;
        try { raw = pg.gen === gen ? oldRaw : await groupRaw(ch, pg.gen); } catch { return pg; } // a generation I can't open myself
        return Object.assign({}, pg, { keys: await wrapFor(ch.id, raw, add, Object.assign({}, pg.keys), pg.gen) });
      }));
    }
    meta.sig = await C.sign(A.me.priv.sign, meta);
    await S.writeJSON(`channels/${ch.id}/meta.json`, meta);
    applyGroupMeta(ch, meta);
    noteMyPost(ch.id, now);
    if (meta.listed || old.listed) {
      if (nameText) { ch.groupName = nameText; ch.groupDesc = descText; }
      await syncDirectory(ch).catch(e => console.warn('directory', e));
    }
    return ch;
  };

  function applyGroupMeta(ch, meta) {
    const was = (ch.meta.keys && ch.meta.keys[me()]) || {}, now = meta.keys[me()] || {};
    if (was.fp !== now.fp || was.ct !== now.ct || curGen(ch) !== (meta.gen || 0)) ch.keyPs = null; // my key entry changed
    ch.meta = meta;
    if (!meta.nameEnc) ch.groupName = '';
    loadGroupName(ch);
    Y.events.emit('channels');
    Y.events.emit('group', ch);
  }

  /** Pick up leave files. The creator's app turns them into a real removal; a group admin's app does it
   *  if the creator hasn't within 10 minutes (and never for another group admin). */
  async function refreshLeaves(ch) {
    if (ch.leaveBusy || !chans.has(ch.id)) return;
    ch.leaveBusy = true;
    try {
      const dir = `channels/${ch.id}/leave`;
      const names = (await S.list(dir, 'file')).filter(n => /^[a-z0-9]{4}\.json$/.test(n));
      if (!ch.leaveMtimes) ch.leaveMtimes = {};
      const leaves = Object.assign({}, ch.leaves);
      let changed = false;
      for (const n of names) {
        const uid = n.slice(0, 4);
        const f = await S.readFile(`${dir}/${n}`);
        if (!f || ch.leaveMtimes[uid] === f.lastModified) continue;
        ch.leaveMtimes[uid] = f.lastModified;
        let raw = null;
        try { raw = JSON.parse(await f.text()); } catch { /* ignore */ }
        const ts = await parseLeave(ch.id, uid, raw);
        if (ts && ts !== leaves[uid]) { leaves[uid] = ts; changed = true; Y.events.emit('groupLeave', { ch, uid, ts }); }
      }
      if (changed) { ch.leaves = leaves; Y.events.emit('channels'); Y.events.emit('group', ch); }
      if (Y.canManageGroup(ch) && Y.connected) {
        const creator = Y.isGroupCreator(ch);
        const adminList = (ch.meta.admins && ch.meta.admins.list) || [];
        const gone = ch.meta.members.filter(id => id !== me() && hasLeft(ch, id) &&
          (creator || (!adminList.includes(id) && Date.now() - ch.leaves[id] > SKEW)));
        // the last other person leaving can't be a removal (a group needs two people); they stay hidden instead
        if (gone.length && ch.meta.members.length - gone.length >= 2) await Y.updateGroup(ch, { removeIds: gone });
      }
    } catch (e) { handleErr(e); } finally { ch.leaveBusy = false; }
  }

  /** Anyone but the creator can leave a group. */
  Y.leaveGroup = async function (ch) {
    if (!ch || ch.kind !== 'group') return;
    if (Y.isGroupCreator(ch)) throw err('You created this group, so you can’t leave it. You can remove the other people instead.');
    if (!Y.connected) throw err('Lost access to the shared folder', 'OFFLINE');
    const ts = Date.now();
    const raw = { v: 1, type: 'leave', channelId: ch.id, userId: me(), ts, kid: A.me.signFp };
    raw.sig = await C.sign(A.me.priv.sign, raw);
    await S.writeJSON(`channels/${ch.id}/leave/${me()}.json`, raw);
    chans.delete(ch.id);
    groupMiss.set(ch.id, ts);
    noteMyPost(ch.id, ts);
    Y.events.emit('channels');
  };

  /** I was removed: drop the group from this PC (I may be added back later). */
  function leftGroup(ch, ts, newMeta) {
    ch.goneMeta = newMeta || null;
    chans.delete(ch.id);
    groupMiss.set(ch.id, ts || Date.now());
    Y.events.emit('channels');
    Y.events.emit('groupGone', ch);
  }

  /** Re-read a group's meta.json when it changed on disk. Accept it only if it's a newer rev of the same
   *  group, signed by its creator or a group admin, that doesn't roll the admin list back. */
  async function refreshGroupMeta(ch, ts, wait) {
    if (ch.metaBusy) { if (wait) await ch.metaBusy; return; }
    let done;
    ch.metaBusy = new Promise(r => { done = r; });
    try {
      const r = await S.readJSONIfChanged(`channels/${ch.id}/meta.json`, ch.metaMtime);
      if (r.unchanged || r.missing || !r.data) return;
      ch.metaMtime = r.lastModified;
      const m = r.data, old = ch.meta;
      if (m.type !== 'group' || m.createdBy !== old.createdBy || !((m.rev || 0) > (old.rev || 0))) return;
      if (((m.admins && m.admins.arev) || 0) < ((old.admins && old.admins.arev) || 0)) return;
      if (!Array.isArray(m.members) || !m.keys) return;
      if (!(await verifyMeta(m, ch.id))) return;
      if (!m.members.includes(me()) || !m.keys[me()]) return leftGroup(ch, ts, m);
      applyGroupMeta(ch, m);
    } catch (e) { console.warn('group meta', ch.id, e); } finally { ch.metaBusy = null; done(); }
  }

  /* ================= discovery ================= */

  Y.verifyMeta = (meta, id) => verifyMeta(meta, id);
  Y.groupKey = (ch, gen) => groupKey(ch, gen);
  Y.curGen = ch => curGen(ch);
  async function verifyMeta(meta, id) {
    if (!meta || meta.id !== id) return false;
    let signer = meta.createdBy;
    if (meta.type === 'group') {
      if (!(await verifyAdmins(meta))) return false;
      signer = meta.by || meta.createdBy;
      if (signer !== meta.createdBy && !(meta.admins && meta.admins.list.includes(signer))) return false;
    }
    const u = A.users.get(signer) || await A.loadUser(signer);
    const key = A.findKey(u, meta.kid, 'sign');
    return !!key && await C.verify(key, meta);
  }

  async function discover(id) {
    if (chans.has(id)) return chans.get(id);
    if (notMine.has(id)) return null;
    if (!ID_RE.test(id)) { notMine.add(id); return null; }
    if (discovering.has(id)) return discovering.get(id);
    const p = (async () => {
      const kind = kindOf(id);
      if (kind === 'dm') {
        const ids = id.slice(3).split('_');
        if (!ids.includes(me()) || ids[0] >= ids[1]) { notMine.add(id); return null; }
        return addChan(newChan(id, null));
      }
      const meta = await S.readJSON(`channels/${id}/meta.json`);
      if (!meta || !(await verifyMeta(meta, id))) { failed.add(id); return null; }
      if (meta.type !== (kind === 'group' ? 'group' : 'public')) { notMine.add(id); return null; }
      // Only channels created (and signed) by an admin count; anything else on the share is ignored.
      if (kind === 'public' && !A.canActAt(meta.createdBy, meta.kid, meta.ts)) { notMine.add(id); return null; }
      // Not a member (yet): the creator may add us later, so re-check when the group shows newer activity.
      if (kind === 'group' && !(Array.isArray(meta.members) && meta.members.includes(me()) && meta.keys && meta.keys[me()])) { if (!groupMiss.has(id)) groupMiss.set(id, 0); return null; }
      if (kind === 'group') {
        const left = await parseLeave(id, me(), await S.readJSON(`channels/${id}/leave/${me()}.json`));
        if (left && left > ((meta.joined && meta.joined[me()]) || 0)) { groupMiss.set(id, Math.max(groupMiss.get(id) || 0, left)); return null; }
      }
      groupMiss.delete(id);
      failed.delete(id);
      const ch = addChan(newChan(id, meta));
      loadGroupName(ch);
      if (kind === 'group') refreshLeaves(ch);
      return ch;
    })();
    discovering.set(id, p);
    try { return await p; } finally { discovering.delete(id); }
  }

  async function rescanChannels() {
    failed.clear();
    const names = await S.list('channels', 'directory');
    await U.mapLimit(names.filter(n => !chans.has(n) && !notMine.has(n) && !groupMiss.has(n)), 8, discover);
  }

  /* ================= presence & polling ================= */

  Y.myStatus = () => (Y.idle || (Y.hiddenSince && Date.now() - Y.hiddenSince > 5 * 60000) ? 'away' : 'online');
  Y.statusText = () => mine.statusText || '';
  Y.setStatusText = function (t) {
    mine.statusText = String(t || '').trim().slice(0, 80);
    mine.statusTs = Date.now();
    heartbeat();
    Y.events.emit('presence');
  };

  let hbRunning = false, hbAgain = false;
  async function heartbeat(status) {
    if (!A.me) return;
    if (hbRunning) { hbAgain = true; return; }
    hbRunning = true;
    const uid = me(), who = A.me; // the person this heartbeat is for, even if someone else signs in meanwhile
    try {
      const cur = await S.readJSON(`presence/${uid}.json`);
      if (A.me !== who) return;
      if (cur && cur.userId === uid) {
        for (const [k, v] of Object.entries(cur.lastPost || {})) if (typeof v === 'number' && !(mine.lastPost[k] >= v)) mine.lastPost[k] = v;
        for (const [k, v] of Object.entries(cur.acks || {})) if (typeof v === 'number' && !(mine.acks[k] >= v)) mine.acks[k] = v;
        mergeNotif(cur);
        if ((cur.statusTs || 0) > mine.statusTs) { mine.statusText = cur.statusText || ''; mine.statusTs = cur.statusTs; }
      }
      const cutoff = Date.now() - 14 * U.DAY_MS;
      for (const k of Object.keys(mine.lastPost)) if (mine.lastPost[k] < cutoff) delete mine.lastPost[k];
      for (const k of Object.keys(mine.notifSeen)) if (!(mine.notifSeen[k] >= Date.now() - 30 * U.DAY_MS)) delete mine.notifSeen[k];
      for (const k of Object.keys(mine.acks)) { const pn = U.parseMsgName(k + '.json'); if (!pn || pn.ts < Date.now() - Y.ANN_DAYS * U.DAY_MS) delete mine.acks[k]; }
      const data = { v: 1, userId: uid, lastSeen: Date.now(), status: status || Y.myStatus(), statusText: mine.statusText, statusTs: mine.statusTs, lastPost: mine.lastPost, seen: mySeen(), acks: mine.acks, notifRead: mine.notifRead, notifSeen: mine.notifSeen, boardRead: mine.boardRead };
      await S.writeJSON(`presence/${uid}.json`, data);
      Y.presence.set(uid, { data, mtime: 0 });
    } catch (e) { handleErr(e); } finally {
      hbRunning = false;
      if (hbAgain && status !== 'offline') { hbAgain = false; heartbeat(); }
    }
  }
  Y.heartbeat = heartbeat;

  /* ---- notification read-state ----
   * Kept in my presence file so it follows me to other PCs: notifRead = everything up to this time is read,
   * notifSeen = {notificationId: ts} for single items opened before that. */
  function mergeNotif(cur) {
    if (typeof cur.notifRead === 'number' && cur.notifRead > mine.notifRead) mine.notifRead = cur.notifRead;
    if (typeof cur.boardRead === 'number' && cur.boardRead > mine.boardRead) mine.boardRead = cur.boardRead;
    if (cur.notifSeen && typeof cur.notifSeen === 'object') {
      for (const [k, v] of Object.entries(cur.notifSeen)) if (typeof v === 'number' && !(mine.notifSeen[k] >= v)) mine.notifSeen[k] = v;
    }
  }
  Y.notifRead = () => mine.notifRead;
  /** Project board notifications have their own read-state (js/board.js), separate from chat's. */
  Y.boardRead = () => mine.boardRead;
  Y.markBoardRead = function (upTo) {
    if (!(upTo > mine.boardRead)) return false;
    mine.boardRead = upTo; heartbeat();
    return true;
  };
  Y.notifSeen = id => !!mine.notifSeen[id];
  Y.markNotifs = function (upTo, ids) {
    let changed = false;
    if (upTo && upTo > mine.notifRead) { mine.notifRead = upTo; changed = true; }
    for (const id of ids || []) if (!mine.notifSeen[id]) { mine.notifSeen[id] = Date.now(); changed = true; }
    if (changed) heartbeat();
    return changed;
  };

  /** @returns {{state:'online'|'away'|'offline', statusText:string, lastSeen?:number}} */
  Y.presenceOf = function (uid) {
    if (A.me && uid === me()) return { state: Y.connected ? Y.myStatus() : 'offline', statusText: mine.statusText };
    const p = Y.presence.get(uid);
    if (!p) return { state: 'offline', statusText: '' };
    const d = p.data, age = Date.now() - d.lastSeen;
    let state = 'offline';
    if (d.status === 'online' && age < 60000) state = 'online';
    else if ((d.status === 'away' || d.status === 'online') && age < 3 * 60000) state = 'away';
    return { state, statusText: String(d.statusText || '').slice(0, 80), lastSeen: d.lastSeen };
  };

  /** Record an activity hint; returns a promise when the channel is new to us. */
  function noteActivity(id, ts) {
    const ch = chans.get(id);
    if (!ch) {
      if (notMine.has(id) || failed.has(id)) return null;
      if (groupMiss.has(id)) {
        if (ts <= groupMiss.get(id)) return null;
        groupMiss.set(id, ts);
      }
      return discover(id).then(c => { if (c) noteActivity(id, ts); }).catch(handleErr);
    }
    if (ch.kind === 'group' && ts > (ch.metaSeen || 0)) { ch.metaSeen = ts; refreshGroupMeta(ch, ts).then(() => refreshLeaves(ch)); }
    if (ts > ch.lastKnown && ts > ch.dirtyTo) ch.dirtyTo = ts;
    return null;
  }

  async function pollPresence() {
    const names = (await S.list('presence', 'file')).filter(n => /^[a-z0-9]{4}\.json$/.test(n));
    let changed = false;
    await U.mapLimit(names, 10, async n => {
      const uid = n.slice(0, 4);
      if (uid === me()) return;
      const prev = Y.presence.get(uid);
      const r = await S.readJSONIfChanged('presence/' + n, prev && prev.mtime);
      if (r.unchanged || r.missing || !r.data || r.data.userId !== uid || typeof r.data.lastSeen !== 'number') return;
      Y.presence.set(uid, { data: r.data, mtime: r.lastModified });
      changed = true;
      if (!A.users.has(uid)) { await A.loadUser(uid); A.events.emit('users'); }
    });
    const found = [];
    for (const p of Y.presence.values()) {
      const lp = p.data.lastPost;
      if (lp && typeof lp === 'object') for (const [cid, ts] of Object.entries(lp)) {
        if (typeof ts !== 'number') continue;
        // an admin posted or withdrew an announcement: pick it up now instead of on the 30-second check
        if (cid === ANN_KEY) { if (ts > annHint) { annHint = ts; found.push(Y.refreshAnnouncements().catch(handleErr)); } continue; }
        if (cid.includes(':')) continue; // request and audit hints, read by js/notify.js
        found.push(noteActivity(cid, ts));
      }
    }
    await Promise.all(found.filter(Boolean));
    Y.events.emit('presence', changed);
  }

  async function processDirty() {
    for (const ch of chans.values()) {
      if (!ch.dirtyTo) continue;
      const to = ch.dirtyTo;
      ch.dirtyTo = 0;
      const floor = Date.now() - (keepsHistory(ch) ? 30 : 8) * U.DAY_MS;
      const from = Math.max(ch.lastKnown ? ch.lastKnown - 10 * 60000 : Y.lastRead(ch.id) - 10 * 60000, floor);
      if (!ch.days || !ch.days.includes(U.dayKey(to))) await listDays(ch);
      const lo = U.dayKey(Math.min(from, to)), hi = U.dayKey(to + 15 * 60000);
      for (const d of ch.days.slice()) if (d >= lo && d <= hi) await loadDay(ch, d);
      ch.lastKnown = Math.max(ch.lastKnown, to);
    }
  }

  async function pollOpen() {
    const ch = chans.get(Y.openId);
    if (!ch) return;
    const now = Date.now();
    const days = U.uniq([U.dayKey(now - 15 * 60000), U.dayKey(now), U.dayKey(now + 15 * 60000)]);
    for (const d of days) await loadDay(ch, d);
  }

  /** Delete expired DM files (and their attachments). Admin sweeps every DM. */
  async function sweep() {
    const now = Date.now();
    const cutoff = now - Y.RETENTION;
    const ids = A.isAdmin()
      ? (await S.list('channels', 'directory')).filter(n => /^(dm_|g_)/.test(n))
      : Array.from(chans.values()).filter(c => c.kind !== 'public' && !Y.isPrivateChannel(c)).map(c => c.id);
    for (const cid of ids) {
      // private channels keep their history (the flag is in the signed, unencrypted meta.json)
      if (cid.startsWith('g_')) {
        const known = chans.get(cid);
        const meta = known ? known.meta : await S.readJSON(`channels/${cid}/meta.json`);
        if (meta && meta.channel) continue;
      }
      const days = (await S.list(`channels/${cid}`, 'directory')).filter(d => U.DAY_RE.test(d) && U.dayStart(d) < cutoff);
      for (const d of days) {
        const whole = U.dayStart(d) + U.DAY_MS < cutoff;
        const files = (await S.list(`channels/${cid}/${d}`, 'file')).filter(n => U.MSG_RE.test(n));
        for (const n of files) {
          const p = U.parseMsgName(n);
          if (!whole && p.ts + Y.RETENTION > now) continue;
          const raw = await S.readJSON(`channels/${cid}/${d}/${n}`);
          for (const f of (raw && Array.isArray(raw.files) ? raw.files : [])) if (/^[a-z0-9]{8}$/.test(f)) await S.remove(`files/${f}.bin`);
          if (!whole) await S.remove(`channels/${cid}/${d}/${n}`);
        }
        if (whole) await S.remove(`channels/${cid}/${d}`, true);
      }
    }
  }

  function purgeExpired() {
    const now = Date.now();
    for (const ch of chans.values()) {
      if (ch.kind === 'public') continue;
      let n = 0;
      for (const [id, m] of ch.msgs) if (m.expires && m.expires < now) { ch.msgs.delete(id); n++; }
      if (n) bump(ch);
    }
  }

  function setConnected(v) {
    if (Y.connected === v) return;
    Y.connected = v;
    Y.events.emit('connection', v);
    if (v) {
      heartbeat();
      for (const ch of chans.values()) for (const l of ch.outbox.slice()) if (l.status === 'failed') Y.retry(ch, l);
    }
  }
  Y.setConnected = setConnected;

  /** Reconnect button: ask the browser for folder access again (needs a click). */
  Y.reconnect = async function () {
    const p = await S.requestPermission();
    if (p !== 'granted') throw err('Access to the folder was not allowed.');
    await S.list('presence');
    setConnected(true);
  };

  /* ---- scheduler ---- */
  const tasks = [
    { every: 2000, fn: pollOpen },
    { every: 5000, fn: async () => { await pollPresence(); await processDirty(); } },
    { every: 10000, fn: () => heartbeat(), always: true },
    { every: 30000, fn: async () => {
      // each step on its own, so one failing (e.g. a busy file) doesn't hold up the others
      for (const step of [A.refreshWorkspace, A.refreshAdminLog, Y.refreshAnnouncements]) { try { await step(); } catch (e) { handleErr(e); } }
      if (await A.loadInbox()) Y.events.emit('inbox');
    } },
    { every: 60000, fn: async () => { await A.refreshUsers(); await rescanChannels(); purgeExpired(); } },
    { every: 3600000, fn: sweep, first: 15000 },
  ];
  async function runTask(t) {
    t.busy = true;
    try { await t.fn(); } catch (e) { handleErr(e); } finally { t.busy = false; t.last = Date.now(); }
  }
  async function probe() {
    try {
      if (await S.queryPermission() !== 'granted') return;
      await S.list('presence');
      setConnected(true);
    } catch { /* still offline */ }
  }
  let lastProbe = 0;
  function tick() {
    if (!running) return;
    const now = Date.now();
    const paused = Y.hiddenSince && now - Y.hiddenSince > 5 * 60000;
    if (!Y.connected) {
      if (now - lastProbe > 5000) { lastProbe = now; probe(); }
    } else {
      for (const t of tasks) {
        if (t.busy || (paused && !t.always)) continue;
        if (now - t.last >= t.every) runTask(t);
      }
    }
    timer = setTimeout(tick, 500);
  }
  /** Run the polls right away (e.g. when the window becomes visible). */
  Y.pokeNow = function () { tasks.slice(0, 2).forEach(t => { if (!t.busy) t.last = 0; }); };

  Y.start = async function () {
    running = true;
    Y.startedAt = Date.now();
    Y.connected = true;
    readMap = U.ls.get(readKeyName(), {});
    mine = { lastPost: {}, statusText: '', statusTs: 0, acks: {}, notifRead: 0, notifSeen: {}, boardRead: 0 };
    Y.announcements.clear(); badAnn.clear(); annHint = 0;
    const cur = await S.readJSON(`presence/${me()}.json`);
    if (cur && cur.userId === me()) {
      mine.lastPost = Object.assign({}, cur.lastPost);
      mine.statusText = cur.statusText || '';
      mine.statusTs = cur.statusTs || 0;
      for (const [k, v] of Object.entries(cur.acks || {})) if (typeof v === 'number') mine.acks[k] = v;
      mergeNotif(cur);
    }
    try { await A.refreshAdminLog(); } catch (e) { console.warn(e); }
    try { await Y.refreshAnnouncements(); } catch (e) { console.warn(e); }
    await rescanChannels();
    await heartbeat();
    await pollPresence();
    await processDirty();
    Y.events.emit('started');
    const now = Date.now();
    tasks.forEach(t => { t.last = t.first ? now - t.every + t.first : now; t.busy = false; });
    tick();
  };
  Y.stop = async function (writeOffline) {
    running = false;
    clearTimeout(timer);
    if (writeOffline && A.me) { try { await heartbeat('offline'); } catch { /* ignore */ } }
    chans.clear(); Y.presence.clear(); notMine.clear(); failed.clear(); groupMiss.clear();
    Y.openId = null;
  };

  /* ================= announcements =================
   * An admin posts announcements/<ts>_<userId>_<rand>.json, signed by them; every app checks the signer
   * was an admin at that time (A.canActAt) and ignores anything else. Each person's app pops it up until
   * they close it, and records that in their presence file as acks = {announcementId: ts}, which is
   * how admins see who has read it. Announcements stay in the Announcements channel for a year.
   * Withdrawing one deletes its file, so it simply disappears (no "deleted" marker).
   * Posting or withdrawing also sets lastPost.announcements in the admin's presence file, so every app
   * re-reads the folder within a few seconds. */
  Y.ANN_DAYS = 365;
  const ANN_KEY = 'announcements';
  let annHint = 0;
  /** @type {Map<string, {id, userId, ts, title, text}>} */
  Y.announcements = new Map();
  const badAnn = new Set(); // files that can never be valid (bad shape or signature)

  let annBusy = null;
  /** Re-read the announcements folder (one read at a time; overlapping calls share it). */
  Y.refreshAnnouncements = function () {
    if (!annBusy) annBusy = readAnnouncements().finally(() => { annBusy = null; });
    return annBusy;
  };
  async function readAnnouncements() {
    const floor = Date.now() - Y.ANN_DAYS * U.DAY_MS;
    const names = (await S.list('announcements', 'file')).filter(n => U.MSG_RE.test(n) && !n.includes('.ev.'));
    const present = new Set(names.map(n => n.slice(0, -5)));
    let changed = false;
    for (const id of Array.from(Y.announcements.keys())) if (!present.has(id)) { Y.announcements.delete(id); changed = true; }
    for (const n of names) {
      const id = n.slice(0, -5);
      if (Y.announcements.has(id) || badAnn.has(id)) continue;
      const pn = U.parseMsgName(n);
      if (!pn || pn.ts < floor) continue;
      const raw = await S.readJSON('announcements/' + n);
      if (!raw) continue; // unreadable right now: try again next time
      const ok = raw.type === 'announcement' && raw.id === id && raw.userId === pn.userId && raw.ts === pn.ts &&
        typeof raw.text === 'string' && await verifyRaw(raw);
      if (!ok) { badAnn.add(id); continue; }
      // not (yet) known as an admin here, e.g. this PC hasn't seen the new workspace.json: re-check later
      if (!A.canActAt(raw.userId, raw.kid, raw.ts)) continue;
      let title = raw.title, text = raw.text, to = null;
      if (Array.isArray(raw.to)) {
        if (!raw.to.includes(me())) { badAnn.add(id); continue; } // private, and not for me
        try { ({ title, text } = await openPrivateAnnouncement(raw)); } catch (e) { console.warn('announcement', id, e); badAnn.add(id); continue; }
        to = raw.to.filter(x => typeof x === 'string');
      }
      const team = to && typeof raw.team === 'string' && /^td$/.test(raw.team) ? raw.team : null;
      Y.announcements.set(id, { id, userId: raw.userId, ts: raw.ts, title: String(title || '').slice(0, 120), text: String(text || '').slice(0, Y.MAX_TEXT), to, team, kid: raw.kid });
      changed = true;
    }
    for (const [id, a] of Y.announcements) if (a.ts < floor) { Y.announcements.delete(id); changed = true; }
    if (await readAnnouncementEdits()) changed = true;
    if (changed) Y.events.emit('announcements');
    return changed;
  }

  /* ---- editing announcements ----
   * The author can fix a mistake: announcements/edits/<announcementId>.json holds the newest {title, text},
   * signed by the author (only they write it). For a private announcement it's encrypted with the same key
   * as the announcement, so the same people can read it. Acknowledgements stay, so it doesn't pop up again. */
  const annKeys = new Map();     // private announcement id → its AES key
  const editMtimes = new Map();  // announcement id → lastModified of its edit file
  async function readAnnouncementEdits() {
    const names = (await S.list('announcements/edits', 'file')).filter(n => U.MSG_RE.test(n) && !n.includes('.ev.'));
    let changed = false;
    for (const n of names) {
      const id = n.slice(0, -5);
      const a = Y.announcements.get(id);
      if (!a) continue;
      const r = await S.readJSONIfChanged('announcements/edits/' + n, editMtimes.get(id));
      if (r.unchanged || r.missing || !r.data) continue;
      editMtimes.set(id, r.lastModified);
      const raw = r.data;
      if (raw.type !== 'ann-edit' || raw.target !== id || raw.userId !== a.userId || typeof raw.ts !== 'number' || raw.ts <= (a.editTs || 0)) continue;
      if (!(await verifyRaw(raw)) || !A.canActAt(raw.userId, raw.kid, raw.ts)) continue;
      let title = raw.title, text = raw.text;
      if (a.to) {
        const k = annKeys.get(id);
        if (!k) continue;
        try { ({ title, text } = await C.decryptJSON(k, raw.enc, 'annedit|' + id + '|' + raw.ts)); } catch { continue; }
      }
      if (typeof text !== 'string' || !text.trim()) continue;
      Object.assign(a, { title: String(title || '').slice(0, 120), text: text.slice(0, Y.MAX_TEXT), editTs: raw.ts });
      changed = true;
    }
    return changed;
  }

  Y.canEditAnnouncement = a => !!a && !!A.me && a.userId === me() && A.isAdmin();
  Y.editAnnouncement = async function (id, { title, text }) {
    const a = Y.announcements.get(id);
    if (!Y.canEditAnnouncement(a)) throw err('Only the admin who posted it can edit it.');
    if (!Y.connected) throw err('Lost access to the shared folder', 'OFFLINE');
    title = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    text = String(text || '').trim();
    if (!text) throw err('Write the announcement first.');
    if (text.length > Y.MAX_TEXT) throw err(`Announcements can be up to ${Y.MAX_TEXT} characters.`);
    const ts = Math.max(Date.now(), (a.editTs || 0) + 1);
    const raw = { v: 1, type: 'ann-edit', target: id, userId: me(), ts, kid: A.me.signFp, title: '', text: '' };
    if (a.to) {
      const k = annKeys.get(id);
      if (!k) throw err('This announcement can’t be edited from this PC.');
      raw.enc = await C.encryptJSON(k, { title, text }, 'annedit|' + id + '|' + ts);
    } else { raw.title = title; raw.text = text; }
    raw.sig = await C.sign(A.me.priv.sign, raw);
    await S.writeJSON(`announcements/edits/${id}.json`, raw);
    Object.assign(a, { title, text, editTs: ts });
    annHint = Math.max(annHint, ts);
    noteMyPost(ANN_KEY, ts);
    Y.events.emit('announcements');
  };

  /* Private announcements: {title, text} are encrypted with a random key, wrapped for each recipient
   * (ECDH from the author's key to theirs). raw.to lists the recipients (user ids, readable on the share). */
  const annWrapInfo = id => 'sankyo-ann|' + id;
  async function openPrivateAnnouncement(raw) {
    const entry = raw.keys && raw.keys[me()];
    if (!entry || entry.fp !== A.me.ecdhFp) throw err('Encrypted for an older key', 'OLD_KEY');
    const author = A.users.get(raw.userId) || await A.loadUser(raw.userId);
    const theirs = A.findKey(author, raw.from, 'ecdh');
    if (!theirs) throw err('Unknown author key', 'OLD_KEY');
    const wk = await C.pairKey(A.me.priv.ecdh, theirs, annWrapInfo(raw.id));
    const { k } = await C.decryptJSON(wk, entry, 'annwrap|' + raw.id + '|' + me());
    const aes = await C.importAes(U.unb64(k));
    annKeys.set(raw.id, aes);
    return C.decryptJSON(aes, raw.enc, 'ann|' + raw.id);
  }

  /** The one group every recipient (except the author) is in, or null. */
  function recipientTeam(to, author) {
    const teams = U.uniq(to.filter(x => x !== author).map(x => A.teamOf(x) || ''));
    return teams.length === 1 && teams[0] ? teams[0] : null;
  }
  /** Which Announcements feed it belongs in: a group id for a private one sent to one group, '' for the main feed.
   *  Older private ones (before the tag) are placed by their recipients' current group. */
  Y.annFeedOf = function (a) {
    if (!a || !a.to) return '';
    return a.team || recipientTeam(a.to, a.userId) || '';
  };

  /** Newest first. */
  Y.announcementList = () => Array.from(Y.announcements.values()).sort((a, b) => b.ts - a.ts);
  Y.hasAcked = id => !!mine.acks[id];
  /** Announcements I still need to see (not my own), oldest first. */
  Y.pendingAnnouncements = () => Y.announcementList().filter(a => a.userId !== me() && !mine.acks[a.id]).reverse();

  Y.ackAnnouncement = function (id) {
    if (mine.acks[id]) return;
    mine.acks[id] = Date.now();
    heartbeat();
    Y.events.emit('announcements');
  };

  /** Who should see it (everyone active who existed when it was posted, except the author), and who has. */
  Y.announcementReach = function (a) {
    const audience = A.activeUsers().filter(u => u.id !== a.userId && (a.to ? a.to.includes(u.id) : !(u.created > a.ts)));
    const seen = audience.filter(u => {
      if (u.id === me()) return !!mine.acks[a.id];
      const pr = Y.presence.get(u.id);
      return !!(pr && pr.data && pr.data.acks && pr.data.acks[a.id]);
    });
    return { audience, seen };
  };

  /** `to`: user ids for a private announcement (only they can read it); omit for everyone. */
  /** Private announcements: an admin may only send them to people in their own group (the super admin to anyone).
   *  @returns {string|null} the group id they're limited to, '' if they have no group yet, null for no limit */
  Y.announceTeam = () => (A.isOwner() ? null : (A.teamOf(me()) || ''));
  Y.canAnnounceTo = id => { const t = Y.announceTeam(); return t === null || (!!t && A.teamOf(id) === t); };

  Y.postAnnouncement = async function ({ title, text, to, label }) {
    if (!A.isAdmin()) throw err('Only admins can post announcements.');
    if (Array.isArray(to)) {
      const t = Y.announceTeam();
      if (t === '') throw err('You need an accepted group before you can send private announcements.');
      const outside = to.filter(x => x !== me() && !Y.canAnnounceTo(x));
      if (outside.length) throw err(`You can only send private announcements to people in ${A.teamName(t)}. Remove ${outside.map(A.name).join(', ')}.`);
    }
    if (!Y.connected) throw err('Lost access to the shared folder', 'OFFLINE');
    title = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    text = String(text || '').trim();
    if (!text) throw err('Write the announcement first.');
    if (text.length > Y.MAX_TEXT) throw err(`Announcements can be up to ${Y.MAX_TEXT} characters.`);
    const ts = Date.now();
    const id = `${ts}_${me()}_${U.rand(4)}`;
    const raw = { v: 1, id, type: 'announcement', title, text, userId: me(), ts, kid: A.me.signFp };
    let recipients = null;
    if (Array.isArray(to)) {
      recipients = U.uniq(to.filter(x => x !== me() && !A.isRemoved(x)));
      if (!recipients.length) throw err('Pick at least one person to send it to.');
      recipients.push(me()); // so I can read it back
      const key = C.randomRaw();
      raw.title = ''; raw.text = '';
      raw.to = recipients; raw.from = A.me.ecdhFp; raw.keys = {};
      const team = recipientTeam(recipients, me());
      if (team) raw.team = team; // shown in that group's Announcements feed
      for (const uid of recipients) {
        const u = A.users.get(uid) || await A.loadUser(uid);
        if (!u) continue;
        const wk = await C.pairKey(A.me.priv.ecdh, u.keys.ecdh, annWrapInfo(id));
        const e = await C.encryptJSON(wk, { k: U.b64(key) }, 'annwrap|' + id + '|' + uid);
        raw.keys[uid] = { fp: u.ecdhFp, iv: e.iv, ct: e.ct };
      }
      const aes = await C.importAes(key);
      annKeys.set(id, aes);
      raw.enc = await C.encryptJSON(aes, { title, text }, 'ann|' + id);
    }
    raw.sig = await C.sign(A.me.priv.sign, raw);
    await S.writeJSON(`announcements/${id}.json`, raw);
    Y.announcements.set(id, { id, userId: me(), ts, title, text, to: recipients, team: raw.team || null });
    annHint = Math.max(annHint, ts);
    noteMyPost(ANN_KEY, ts);
    Y.events.emit('announcements');
    // a private announcement by an admin is reported to the super admin: title and recipient count only
    if (recipients && !A.isOwner()) await A.audit('announcement.private', id, recipients.length - 1, { title, label: String(label || '').slice(0, 80) }).catch(e => console.warn('audit', e));
    return id;
  };

  Y.withdrawAnnouncement = async function (id) {
    const a = Y.announcements.get(id);
    if (!a) return;
    if (!A.isAdmin()) throw err('Only admins can withdraw announcements.');
    await S.remove(`announcements/${id}.json`);
    await S.remove(`announcements/edits/${id}.json`).catch(() => {});
    Y.announcements.delete(id);
    const ts = Date.now();
    annHint = Math.max(annHint, ts);
    noteMyPost(ANN_KEY, ts);
    Y.events.emit('announcements');
  };

  /* ================= search & export ================= */

  const searchChans = new Map();
  /** Load a public channel's history since `sinceDay` into a separate copy (cached across searches). */
  async function collect(ch, sinceDay, signal) {
    let tmp = searchChans.get(ch.id);
    if (!tmp) { tmp = newChan(ch.id, ch.meta); searchChans.set(ch.id, tmp); }
    const days = (await S.list(`channels/${ch.id}`, 'directory')).filter(d => U.DAY_RE.test(d) && d >= sinceDay).sort().reverse();
    const recent = U.dayKey(Date.now() - 2 * U.DAY_MS);
    for (const d of days) {
      if (signal && signal.aborted) break;
      if (tmp.loadedDays.has(d) && d < recent) continue;
      await loadDay(tmp, d, { quiet: true, cacheListing: true });
    }
    return tmp;
  }

  /** Search text in channels (last 90 days) and DMs still kept. DM search runs in memory only. */
  Y.search = async function ({ text, userId, channelId }, onProgress, signal) {
    const tokens = String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
    const since = U.dayKey(Date.now() - 90 * U.DAY_MS);
    const targets = Array.from(chans.values()).filter(ch => !channelId || ch.id === channelId);
    const results = [];
    let done = 0;
    for (const ch of targets) {
      if (signal && signal.aborted) break;
      let pool = ch;
      if (ch.kind === 'public') pool = await collect(ch, since, signal);
      else await Y.ensureLoaded(ch, Infinity);
      for (const m of pool.msgs.values()) {
        if (m.deleted || m.hidden || !m.verified || m.decryptError) continue;
        if (userId && m.userId !== userId) continue;
        if (m.expires && m.expires < Date.now()) continue;
        const hay = (m.text + ' ' + m.attachments.map(a => a.name).join(' ')).toLowerCase();
        if (tokens.every(t => hay.includes(t))) results.push({ ch, msg: m });
      }
      if (onProgress) onProgress(++done, targets.length);
    }
    return results.sort((a, b) => b.msg.ts - a.msg.ts).slice(0, 200);
  };

  /** Admin: full channel history as text or HTML. */
  Y.exportChannel = async function (ch, format, onProgress) {
    const tmp = await collect(ch, '0000-00-00');
    const msgs = Y.sorted(tmp).filter(m => m.verified && !m.deleted && !m.hidden);
    const info = Y.info(ch);
    if (onProgress) onProgress(msgs.length);
    if (format === 'html') {
      const rows = msgs.map(m => `<div class="m"><b>${U.escapeHtml(A.name(m.userId))}</b> <small>${U.escapeHtml(new Date(m.ts).toLocaleString())}${m.edited ? ' (edited)' : ''}</small><div>${U.escapeHtml(m.text).replace(/\n/g, '<br>')}</div>${m.attachments.map(a => `<div><i>📎 ${U.escapeHtml(a.name)} (${U.formatSize(a.size)})</i></div>`).join('')}</div>`).join('\n');
      return `<!doctype html><meta charset="utf-8"><title>#${U.escapeHtml(info.name)}</title><style>body{font-family:Segoe UI,sans-serif;max-width:800px;margin:2em auto;color:#111}.m{padding:.5em 0;border-bottom:1px solid #eee}small{color:#666}</style><h1>#${U.escapeHtml(info.name)}</h1><p>Exported ${U.escapeHtml(new Date().toLocaleString())} · ${msgs.length} messages</p>\n${rows}`;
    }
    return `#${info.name} — exported ${new Date().toLocaleString()}\r\n\r\n` + msgs.map(m =>
      `[${new Date(m.ts).toLocaleString()}] ${A.name(m.userId)}${m.edited ? ' (edited)' : ''}: ${m.poll ? '[Poll] ' : ''}${m.text}` +
      (m.poll ? m.poll.options.map(o => `\r\n    ☐ ${o.text}`).join('') : '') +
      m.attachments.map(a => `\r\n    📎 ${a.name} (${U.formatSize(a.size)})`).join('')).join('\r\n');
  };

  SC.sync = Y;
})(typeof window !== 'undefined' ? window : globalThis);
