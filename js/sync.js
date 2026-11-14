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
  Y.MAX_GROUP = 8;
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
  const discovering = new Map();
  let readMap = {};
  let mine = { lastPost: {}, statusText: '', statusTs: 0 };
  let running = false;
  let timer = 0;

  const err = (msg, code) => Object.assign(new Error(msg), { code });
  const me = () => A.me.id;
  const ID_RE = /^(general|c_[a-z0-9]{6}|g_[a-z0-9]{8}|dm_[a-z0-9]{4}_[a-z0-9]{4})$/;
  const kindOf = id => id.startsWith('dm_') ? 'dm' : id.startsWith('g_') ? 'group' : 'public';
  const PAYLOAD = ['text', 'mentions', 'replyTo', 'attachments', 'targetId', 'emoji', 'on'];

  function newChan(id, meta) {
    return {
      id, kind: kindOf(id), meta: meta || null, msgs: new Map(), pendingEvents: new Map(), reactState: new Map(),
      seen: new Set(), loadedDays: new Set(), days: null, lastKnown: 0, dirtyTo: 0, unread: 0, mentions: 0,
      outbox: [], keyP: null, allLoaded: false, version: 0, lastActivity: 0,
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
    return (ch.meta && ch.meta.members) || [];
  };
  /** Display info, with the admin's renames/archive flags applied. */
  Y.info = function (ch) {
    if (ch.kind === 'public') {
      const o = A.channelOverride(ch.id);
      return { name: o.name || ch.meta.name, description: o.description !== undefined ? o.description : (ch.meta.description || ''), archived: !!o.archived };
    }
    if (ch.kind === 'dm') return { name: A.name(Y.dmOther(ch)), description: '', archived: false };
    const names = Y.members(ch).filter(id => id !== me()).map(A.name).sort();
    return { name: names.join(', '), description: '', archived: false };
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
  function groupKey(ch) {
    if (!ch.keyP) {
      ch.keyP = (async () => {
        const m = ch.meta;
        const entry = m.keys && m.keys[me()];
        if (!entry || entry.fp !== A.me.ecdhFp) throw err('No key for you in this group', 'OLD_KEY');
        const creator = A.users.get(m.createdBy) || await A.loadUser(m.createdBy);
        const cj = A.findKey(creator, m.keyFrom, 'ecdh');
        if (!cj) throw err('Unknown creator key', 'OLD_KEY');
        const wk = await C.pairKey(A.me.priv.ecdh, cj, 'sankyo-wrap|' + ch.id);
        const { k } = await C.decryptJSON(wk, entry, 'wrap|' + ch.id + '|' + me());
        return C.importAes(U.unb64(k));
      })();
      ch.keyP.catch(() => { setTimeout(() => { ch.keyP = null; }, 30000); });
    }
    return ch.keyP;
  }
  const readKey = (ch, enc) => ch.kind === 'dm' ? dmKey(ch, enc) : groupKey(ch);

  /* ================= reading ================= */

  async function verifyRaw(raw) {
    const u = A.users.get(raw.userId) || await A.loadUser(raw.userId);
    const key = A.findKey(u, raw.kid, 'sign');
    return !!key && await C.verify(key, raw);
  }

  function cleanAttachments(list, kind) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, Y.MAX_ATTACH).filter(a => a && /^[a-z0-9]{8}$/.test(a.fileId) && typeof a.name === 'string').map(a => {
      const o = { fileId: a.fileId, name: a.name.slice(0, 200), size: Number(a.size) || 0, type: String(a.type || '').slice(0, 100) };
      const w = Math.round(Number(a.w)), hgt = Math.round(Number(a.h));
      if (w > 0 && hgt > 0 && w <= 20000 && hgt <= 20000) { o.w = w; o.h = hgt; }
      if (kind === 'public') o.path = String(a.path || ''); else o.iv = String(a.iv || '');
      return o;
    });
  }

  /** Turn a raw file into a plain message/event object (decrypting DMs). */
  async function decode(ch, raw, ok) {
    const out = { id: raw.id, type: raw.type, userId: raw.userId, ts: raw.ts, verified: !!ok, kid: raw.kid };
    let body = raw;
    if (ch.kind !== 'public') {
      if (typeof raw.expires !== 'number') return null;
      out.expires = Math.min(raw.expires, raw.ts + Y.RETENTION);
      if (out.expires < Date.now()) return null;
      out.enc = raw.enc;
      try { body = await C.decryptJSON(await readKey(ch, raw.enc), raw.enc, ch.id + '|' + raw.id); } catch (e) {
        out.decryptError = true; body = {};
      }
    }
    PAYLOAD.forEach(k => { if (body[k] !== undefined) out[k] = body[k]; });
    out.text = typeof out.text === 'string' ? out.text.slice(0, Y.MAX_TEXT + 100) : '';
    out.mentions = Array.isArray(out.mentions) ? out.mentions.filter(x => typeof x === 'string').slice(0, 60) : [];
    out.attachments = cleanAttachments(out.attachments, ch.kind);
    if (out.replyTo && typeof out.replyTo === 'object') {
      out.replyTo = { id: String(out.replyTo.id || ''), userId: String(out.replyTo.userId || ''), snippet: String(out.replyTo.snippet || '').slice(0, 160) };
    } else out.replyTo = null;
    return out;
  }

  function applyEvent(ch, msg, ev) {
    if (ev.type === 'edit') {
      if (ev.userId === msg.userId && ev.ts >= msg.editTs) { msg.text = ev.text; msg.mentions = ev.mentions; msg.edited = true; msg.editTs = ev.ts; }
    } else if (ev.type === 'delete') {
      if (ev.userId === msg.userId) msg.deleted = true;
    } else if (ev.type === 'hide') {
      if (ch.kind === 'public' && A.canActAt(ev.userId, ev.kid, ev.ts)) msg.hidden = true;
    } else if (ev.type === 'react') {
      if (typeof ev.emoji !== 'string' || !ev.emoji || ev.emoji.length > 16) return;
      const k = msg.id + '|' + ev.emoji + '|' + ev.userId;
      const prev = ch.reactState.get(k);
      if (prev && prev.ts > ev.ts) return;
      ch.reactState.set(k, { ts: ev.ts });
      let set = msg.reactions.get(ev.emoji);
      if (ev.on) { if (!set) msg.reactions.set(ev.emoji, set = new Set()); set.add(ev.userId); }
      else if (set) { set.delete(ev.userId); if (!set.size) msg.reactions.delete(ev.emoji); }
    }
  }

  /** Merge one decoded item into a channel. @returns {boolean} new message added */
  function apply(ch, m) {
    if (m.type === 'message') {
      if (ch.msgs.has(m.id)) return false;
      Object.assign(m, { edited: false, editTs: 0, deleted: false, hidden: false, reactions: new Map() });
      ch.msgs.set(m.id, m);
      if (m.ts > ch.lastActivity) ch.lastActivity = m.ts;
      const pend = ch.pendingEvents.get(m.id);
      if (pend) { ch.pendingEvents.delete(m.id); pend.sort((a, b) => a.ts - b.ts).forEach(ev => applyEvent(ch, m, ev)); }
      return true;
    }
    if (!m.verified || !m.targetId || !['edit', 'delete', 'hide', 'react'].includes(m.type)) return false;
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
    if (!opts.quiet) {
      const incoming = added.filter(m => m.ts > Y.startedAt && m.userId !== me());
      if (incoming.length && chans.get(ch.id) === ch) Y.events.emit('incoming', { ch, msgs: incoming });
    }
    return added;
  }

  async function listDays(ch) {
    let days = (await S.list(`channels/${ch.id}`, 'directory')).filter(d => U.DAY_RE.test(d));
    if (ch.kind !== 'public') { const min = U.dayKey(Date.now() - Y.RETENTION - U.DAY_MS); days = days.filter(d => d >= min); }
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
    }
  };
  Y.totalUnread = () => Array.from(chans.values()).reduce((n, ch) => n + (Y.info(ch).archived ? 0 : ch.unread), 0);

  /* ================= writing ================= */

  async function buildRaw(ch, type, id, ts, payload) {
    const raw = { v: 1, id, type, channelId: ch.id, userId: me(), ts, kid: A.me.signFp };
    const clean = {};
    PAYLOAD.forEach(k => { if (payload[k] !== undefined) clean[k] = payload[k]; });
    if (ch.kind === 'public') Object.assign(raw, clean);
    else {
      raw.expires = ts + Y.RETENTION;
      raw.files = (clean.attachments || []).map(a => a.fileId);
      const aad = ch.id + '|' + id;
      if (ch.kind === 'dm') {
        const other = A.users.get(Y.dmOther(ch));
        if (!other) throw err('Unknown user');
        raw.enc = await C.encryptJSON(await dmKey(ch), clean, aad);
        raw.enc.s = A.me.ecdhFp; raw.enc.r = other.ecdhFp;
      } else raw.enc = await C.encryptJSON(await groupKey(ch), clean, aad);
    }
    raw.sig = await C.sign(A.me.priv.sign, raw);
    return raw;
  }

  function noteMyPost(id, ts) {
    mine.lastPost[id] = Math.max(mine.lastPost[id] || 0, ts);
    heartbeat();
  }

  async function writeItem(ch, type, payload) {
    if (!Y.connected) throw err('Lost access to the shared folder', 'OFFLINE');
    const ts = Date.now();
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
        const key = ch.kind === 'dm' ? await dmKey(ch) : await groupKey(ch);
        const enc = await C.encryptBytes(key, await f.arrayBuffer(), 'file|' + fileId);
        await S.write(`files/${fileId}.bin`, enc.data);
        out.push(Object.assign(base, { iv: enc.iv }));
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
  Y.react = (ch, msg, emoji) => {
    const set = msg.reactions.get(emoji);
    return event(ch, 'react', { targetId: msg.id, emoji, on: !(set && set.has(me())) });
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
    const pt = await C.decryptBytes(await readKey(ch, msg.enc), att.iv, await f.arrayBuffer(), 'file|' + att.fileId);
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
    const existing = Array.from(chans.values()).find(c => c.kind === 'group' && c.meta.members.slice().sort().join() === members.join());
    if (existing) return existing;
    const id = 'g_' + U.rand(8);
    const rawKey = C.randomRaw();
    const keys = {};
    for (const uid of members) {
      const u = A.users.get(uid);
      const wk = await C.pairKey(A.me.priv.ecdh, u.keys.ecdh, 'sankyo-wrap|' + id);
      const enc = await C.encryptJSON(wk, { k: U.b64(rawKey) }, 'wrap|' + id + '|' + uid);
      keys[uid] = { fp: u.ecdhFp, iv: enc.iv, ct: enc.ct };
    }
    const meta = { v: 1, id, type: 'group', members, createdBy: me(), ts: Date.now(), keyFrom: A.me.ecdhFp, keys, kid: A.me.signFp };
    meta.sig = await C.sign(A.me.priv.sign, meta);
    await S.writeJSON(`channels/${id}/meta.json`, meta);
    const ch = addChan(newChan(id, meta));
    ch.days = []; ch.allLoaded = true;
    noteMyPost(id, meta.ts);
    return ch;
  };

  /* ================= discovery ================= */

  async function verifyMeta(meta, id) {
    if (!meta || meta.id !== id) return false;
    const u = A.users.get(meta.createdBy) || await A.loadUser(meta.createdBy);
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
      if (kind === 'group' && !(Array.isArray(meta.members) && meta.members.includes(me()) && meta.keys && meta.keys[me()])) { notMine.add(id); return null; }
      failed.delete(id);
      return addChan(newChan(id, meta));
    })();
    discovering.set(id, p);
    try { return await p; } finally { discovering.delete(id); }
  }

  async function rescanChannels() {
    failed.clear();
    const names = await S.list('channels', 'directory');
    await U.mapLimit(names.filter(n => !chans.has(n) && !notMine.has(n)), 8, discover);
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
    try {
      const cur = await S.readJSON(`presence/${me()}.json`);
      if (cur && cur.userId === me()) {
        for (const [k, v] of Object.entries(cur.lastPost || {})) if (typeof v === 'number' && !(mine.lastPost[k] >= v)) mine.lastPost[k] = v;
        if ((cur.statusTs || 0) > mine.statusTs) { mine.statusText = cur.statusText || ''; mine.statusTs = cur.statusTs; }
      }
      const cutoff = Date.now() - 14 * U.DAY_MS;
      for (const k of Object.keys(mine.lastPost)) if (mine.lastPost[k] < cutoff) delete mine.lastPost[k];
      const data = { v: 1, userId: me(), lastSeen: Date.now(), status: status || Y.myStatus(), statusText: mine.statusText, statusTs: mine.statusTs, lastPost: mine.lastPost };
      await S.writeJSON(`presence/${me()}.json`, data);
      Y.presence.set(me(), { data, mtime: 0 });
    } catch (e) { handleErr(e); } finally {
      hbRunning = false;
      if (hbAgain && status !== 'offline') { hbAgain = false; heartbeat(); }
    }
  }
  Y.heartbeat = heartbeat;

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
      return discover(id).then(c => { if (c) noteActivity(id, ts); }).catch(handleErr);
    }
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
      if (lp && typeof lp === 'object') for (const [cid, ts] of Object.entries(lp)) if (typeof ts === 'number') found.push(noteActivity(cid, ts));
    }
    await Promise.all(found.filter(Boolean));
    Y.events.emit('presence', changed);
  }

  async function processDirty() {
    for (const ch of chans.values()) {
      if (!ch.dirtyTo) continue;
      const to = ch.dirtyTo;
      ch.dirtyTo = 0;
      const floor = Date.now() - (ch.kind === 'public' ? 30 : 8) * U.DAY_MS;
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
      : Array.from(chans.values()).filter(c => c.kind !== 'public').map(c => c.id);
    for (const cid of ids) {
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
    { every: 30000, fn: async () => { await A.refreshWorkspace(); await A.refreshAdminLog(); if (await A.loadInbox()) Y.events.emit('inbox'); } },
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
    mine = { lastPost: {}, statusText: '', statusTs: 0 };
    const cur = await S.readJSON(`presence/${me()}.json`);
    if (cur && cur.userId === me()) {
      mine.lastPost = Object.assign({}, cur.lastPost);
      mine.statusText = cur.statusText || '';
      mine.statusTs = cur.statusTs || 0;
    }
    try { await A.refreshAdminLog(); } catch (e) { console.warn(e); }
    await rescanChannels();
    await heartbeat();
    await pollPresence();
    await processDirty();
    const now = Date.now();
    tasks.forEach(t => { t.last = t.first ? now - t.every + t.first : now; t.busy = false; });
    tick();
  };
  Y.stop = async function (writeOffline) {
    running = false;
    clearTimeout(timer);
    if (writeOffline && A.me) { try { await heartbeat('offline'); } catch { /* ignore */ } }
    chans.clear(); Y.presence.clear(); notMine.clear(); failed.clear();
    Y.openId = null;
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
      `[${new Date(m.ts).toLocaleString()}] ${A.name(m.userId)}${m.edited ? ' (edited)' : ''}: ${m.text}` +
      m.attachments.map(a => `\r\n    📎 ${a.name} (${U.formatSize(a.size)})`).join('')).join('\r\n');
  };

  SC.sync = Y;
})(typeof window !== 'undefined' ? window : globalThis);
