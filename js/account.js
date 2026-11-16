/* Sankyo Chat — accounts: workspace, profiles, sign-in, admin actions, feedback inbox. */
(function (root) {
  'use strict';
  const SC = root.SC = root.SC || {};
  const U = SC.util, S = SC.store, C = SC.crypto;
  /** @namespace SC.account */
  const A = {};

  A.ANIMALS = [
    ['🐶', 'Dog'], ['🐱', 'Cat'], ['🐭', 'Mouse'], ['🐹', 'Hamster'], ['🐰', 'Rabbit'], ['🦊', 'Fox'],
    ['🐻', 'Bear'], ['🐼', 'Panda'], ['🐨', 'Koala'], ['🐯', 'Tiger'], ['🦁', 'Lion'], ['🐮', 'Cow'],
    ['🐷', 'Pig'], ['🐸', 'Frog'], ['🐵', 'Monkey'], ['🐔', 'Chicken'], ['🐧', 'Penguin'], ['🐦', 'Bird'],
    ['🦆', 'Duck'], ['🦉', 'Owl'], ['🐴', 'Horse'], ['🦄', 'Unicorn'], ['🐝', 'Bee'], ['🦋', 'Butterfly'],
    ['🐢', 'Turtle'], ['🐙', 'Octopus'], ['🦀', 'Crab'], ['🐬', 'Dolphin'], ['🐳', 'Whale'], ['🦒', 'Giraffe'],
  ];
  /** Pastel avatar backgrounds (light, so the animal emoji stands out). */
  A.COLORS = ['#C7D2FE', '#FBCFE8', '#FDE68A', '#BBF7D0', '#A5F3FC', '#DDD6FE',
    '#FECACA', '#E2E8F0', '#BAE6FD', '#FEF08A', '#A7F3D0', '#FED7AA'];
  /** Earlier dark colours → their pastel equivalents (profiles made before the change). */
  const LEGACY_COLORS = ['#4F46E5', '#BE185D', '#B45309', '#15803D', '#0E7490', '#7C3AED',
    '#B91C1C', '#334155', '#0369A1', '#A16207', '#047857', '#C2410C'];
  A.avatarColor = function (c) {
    const i = LEGACY_COLORS.indexOf(String(c || '').toUpperCase());
    return i >= 0 ? A.COLORS[i] : (c || '#E2E8F0');
  };
  A.FEEDBACK_TYPES = ['Suggestion', 'Comment', 'Problem', 'Other'];
  A.MIN_PASSWORD = 8;

  /** @type {any} verified workspace.json */
  A.ws = null;
  /** @type {Map<string, any>} verified user records */
  A.users = new Map();
  const userMtime = new Map();
  /** @type {{id:string, priv:{sign:CryptoKey, ecdh:CryptoKey}, signFp:string, ecdhFp:string, mustChange:boolean}|null} */
  A.me = null;
  /** userId → {byAdmin:boolean} for keys that changed since this browser last saw them */
  A.keyChanges = new Map();
  A.events = U.emitter();
  let wsMtime = 0;
  /** Workspace state after applying the signed admin action log (see recompute()). */
  A.eff = { channels: {}, removed: new Set(), resets: {} };

  const err = (msg, code) => Object.assign(new Error(msg), { code });

  /* ================= workspace ================= */

  async function wsValid(raw) {
    if (!raw || !raw.admin || !raw.admin.sign || !raw.id) return false;
    return raw.kid === await C.fp(raw.admin.sign) && await C.verify(raw.admin.sign, raw);
  }
  const cacheWs = ws => U.ls.set('ws.' + ws.id, ws);

  /**
   * Load and check workspace.json against the admin key this browser pinned on first run.
   * @returns {Promise<{status:'ok'|'missing'|'invalid'|'tampered'|'different', raw?:any}>}
   */
  A.loadWorkspace = async function () {
    const r = await S.readJSONIfChanged('workspace.json');
    if (r.missing) return { status: 'missing' };
    const raw = r.data;
    const ok = await wsValid(raw);
    const pin = U.ls.get('wsPin');
    if (!pin) {
      if (!ok) return { status: 'invalid' };
      U.ls.set('wsPin', { id: raw.id, kid: raw.kid });
      A.ws = raw; cacheWs(raw); wsMtime = r.lastModified; recompute();
      return { status: 'ok' };
    }
    if (raw && pin.id !== raw.id) return { status: 'different', raw: ok ? raw : null };
    const cached = U.ls.get('ws.' + pin.id);
    if (!ok || raw.kid !== pin.kid) {
      A.ws = cached || null;
      if (A.ws) recompute();
      return { status: cached ? 'tampered' : 'invalid' };
    }
    // ignore replays of an older signed copy
    A.ws = cached && cached.updated > raw.updated ? cached : raw;
    cacheWs(A.ws); wsMtime = r.lastModified; recompute();
    return { status: 'ok' };
  };

  /** Trust a different workspace (user moved to another share on purpose). */
  A.trustWorkspace = function (raw) {
    U.ls.set('wsPin', { id: raw.id, kid: raw.kid });
    A.ws = raw; cacheWs(raw); recompute();
  };

  /** Re-read workspace.json if it changed. @returns {Promise<boolean>} changed */
  A.refreshWorkspace = async function () {
    const r = await S.readJSONIfChanged('workspace.json', wsMtime);
    if (r.unchanged || r.missing || !r.data) return false;
    wsMtime = r.lastModified;
    const raw = r.data;
    if (!A.ws || raw.id !== A.ws.id || raw.kid !== A.ws.kid || !(await wsValid(raw))) {
      A.events.emit('wsTampered');
      return false;
    }
    if (raw.updated <= A.ws.updated) return false;
    A.ws = raw; cacheWs(raw); recompute();
    A.events.emit('workspace');
    return true;
  };

  /* ---- roles ----
   * Super admin: the workspace creator (ws.adminId), whose key signs workspace.json.
   * Admins: appointed by the super admin, listed in workspace.json as ws.admins[userId] = {kid, since}.
   * Past stints are kept in ws.formerAdmins[userId] = [{kid, since, until}] so actions taken while
   * someone was an admin stay valid after they step down. */
  A.isOwner = () => !!(A.me && A.ws && A.me.id === A.ws.adminId && A.me.signFp === A.ws.kid);
  A.adminEntry = id => (A.ws && A.ws.admins && A.ws.admins[id]) || null;
  A.isAdmin = () => A.isOwner() || !!(A.me && A.adminEntry(A.me.id) && A.adminEntry(A.me.id).kid === A.me.signFp);
  A.isUserAdmin = id => !!A.ws && (id === A.ws.adminId || !!A.adminEntry(id));
  /** 'Super admin' | 'Admin' | '' */
  A.roleLabel = id => (!A.ws ? '' : id === A.ws.adminId ? 'Super admin' : A.adminEntry(id) ? 'Admin' : '');
  /** Was (userId, signing key) allowed to act as an admin at time ts? */
  A.canActAt = function (userId, kid, ts) {
    if (!A.ws || !kid) return false;
    if (userId === A.ws.adminId) return kid === A.ws.kid;
    const skew = 5 * 60000;
    const cur = A.adminEntry(userId);
    if (cur && cur.kid === kid && ts >= cur.since - skew) return true;
    const past = (A.ws.formerAdmins && A.ws.formerAdmins[userId]) || [];
    return past.some(p => p && p.kid === kid && ts >= p.since - skew && ts <= p.until);
  };
  A.isRemoved = id => !!(A.ws && ((A.ws.removed || []).includes(id) || A.eff.removed.has(id)));
  A.channelOverride = id => A.eff.channels[id] || {};
  A.autoLockMinutes = () => (A.ws && Number.isFinite(A.ws.autoLockMin) ? A.ws.autoLockMin : 30);

  /** Admin only: change workspace.json and re-sign it. */
  A.saveWorkspace = async function (patch) {
    if (!A.isOwner()) throw err('Only the super admin can do that');
    const next = Object.assign({}, A.ws, patch, { updated: Math.max(Date.now(), (A.ws.updated || 0) + 1), kid: A.me.signFp });
    delete next.sig;
    next.sig = await C.sign(A.me.priv.sign, next);
    await S.writeJSON('workspace.json', next);
    A.ws = next; cacheWs(next); recompute();
    A.events.emit('workspace');
  };

  /** Is this folder brand new (nothing but a readme)? */
  A.folderIsEmpty = async function () {
    const names = await S.list('');
    return names.every(n => /^readme/i.test(n));
  };

  /* ================= users ================= */

  async function prepareUser(rec, id) {
    if (!rec || rec.id !== id || !rec.keys || !rec.keys.sign || !rec.keys.ecdh || typeof rec.name !== 'string') return null;
    const kid = await C.fp(rec.keys.sign);
    if (rec.kid !== kid || !(await C.verify(rec.keys.sign, rec))) { console.warn('User record failed its signature check', id); return null; }
    const sets = [rec.keys].concat(Array.isArray(rec.prev) ? rec.prev.filter(p => p && p.sign && p.ecdh) : []);
    const u = Object.assign({}, rec);
    u._sign = await Promise.all(sets.map(async k => ({ fp: await C.fp(k.sign), jwk: k.sign })));
    u._ecdh = await Promise.all(sets.map(async k => ({ fp: await C.fp(k.ecdh), jwk: k.ecdh })));
    u.ecdhFp = u._ecdh[0].fp;
    return u;
  }

  function checkPin(u) {
    if (!A.ws) return;
    const key = 'pins.' + A.ws.id;
    const pins = U.ls.get(key, {});
    if (!pins[u.id] || (A.me && u.id === A.me.id)) { pins[u.id] = u.kid; U.ls.set(key, pins); return; }
    if (pins[u.id] !== u.kid) {
      const reset = A.eff.resets[u.id];
      A.keyChanges.set(u.id, { byAdmin: !!(reset && reset.kid === u.kid) });
    } else A.keyChanges.delete(u.id);
  }
  /** User saw the "security key changed" notice: remember the new key. */
  A.ackKeyChange = function (id) {
    const u = A.users.get(id);
    if (!u || !A.ws) return;
    const key = 'pins.' + A.ws.id;
    const pins = U.ls.get(key, {});
    pins[id] = u.kid; U.ls.set(key, pins);
    A.keyChanges.delete(id);
  };

  /** Load (or refresh) one user record. */
  A.loadUser = async function (id) {
    if (!/^[a-z0-9]{4}$/.test(id)) return null;
    const r = await S.readJSONIfChanged(`users/${id}.json`, userMtime.get(id));
    if (r.unchanged || r.missing || !r.data) return A.users.get(id) || null;
    const u = await prepareUser(r.data, id);
    if (!u) return A.users.get(id) || null;
    const prev = A.users.get(id);
    if (prev && prev.updated > u.updated) return prev; // ignore replays
    userMtime.set(id, r.lastModified);
    A.users.set(id, u);
    checkPin(u);
    return u;
  };

  /** Re-read all user records. @returns {Promise<boolean>} anything changed */
  A.refreshUsers = async function () {
    const names = await S.list('users', 'file');
    const before = new Map(Array.from(A.users, ([k, v]) => [k, v.sig]));
    await U.mapLimit(names.filter(n => /^[a-z0-9]{4}\.json$/.test(n)), 8, n => A.loadUser(n.slice(0, 4)));
    let changed = before.size !== A.users.size;
    A.users.forEach((v, k) => { if (before.get(k) !== v.sig) changed = true; });
    if (changed) A.events.emit('users');
    return changed;
  };

  /** Non-removed users sorted by name. */
  A.activeUsers = () => Array.from(A.users.values()).filter(u => !A.isRemoved(u.id)).sort((a, b) => a.name.localeCompare(b.name));
  A.findKey = function (u, fp, kind) {
    const list = u && (kind === 'sign' ? u._sign : u._ecdh);
    const hit = list && list.find(k => k.fp === fp);
    return hit ? hit.jwk : null;
  };
  A.name = id => { const u = A.users.get(id); return u ? u.name : 'Unknown user'; };

  function validateProfile({ name, animal, color }, selfId) {
    name = String(name || '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 32) throw err('Display name must be 2–32 characters.');
    if (/[@#<>]/.test(name)) throw err('Display name can’t contain @, #, < or >.');
    const clash = A.activeUsers().find(u => u.id !== selfId && u.name.toLowerCase() === name.toLowerCase());
    if (clash || name.toLowerCase() === 'channel') throw err('That name is taken. Try adding an initial.');
    if (!A.ANIMALS.some(a => a[0] === animal)) throw err('Pick an avatar.');
    if (!A.COLORS.includes(color)) throw err('Pick a background colour.');
    return { name, animal, color };
  }
  A.validatePassword = function (pw, pw2) {
    if (String(pw).length < A.MIN_PASSWORD) throw err(`Password must be at least ${A.MIN_PASSWORD} characters.`);
    if (pw2 !== undefined && pw !== pw2) throw err('The two passwords don’t match.');
  };
  /** 0–4 rough strength score for the hint under the password box. */
  A.passwordStrength = function (pw) {
    let s = 0;
    if (pw.length >= 8) s++;
    if (pw.length >= 12) s++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
    if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
    if (/^(.)\1+$/.test(pw) || /^(password|12345678|qwerty)/i.test(pw)) s = 0;
    return Math.min(s, 4);
  };

  async function signedUser(rec, privSign) {
    const body = Object.assign({}, rec, { kid: await C.fp(rec.keys.sign) });
    delete body.sig;
    body.sig = await C.sign(privSign, body);
    return body;
  }

  async function newUserId() {
    for (let i = 0; i < 20; i++) {
      const id = U.rand(4);
      if (!A.users.has(id) && !(await S.exists(`users/${id}.json`))) return id;
    }
    throw err('Could not pick a user id');
  }

  async function setMe(id, privJwk, mustChange) {
    const priv = await C.importPrivate(privJwk);
    const u = A.users.get(id);
    A.me = { id, priv, signFp: u.kid, ecdhFp: u.ecdhFp, mustChange: !!mustChange };
  }

  /* ---- security question (super admin only) ----
   * The key file holds a second copy of the private keys, encrypted with the normalised answer.
   * Anyone who can read the data folder can try guesses offline, so the answer must be hard to guess. */
  A.MIN_ANSWER = 4;
  const normAnswer = a => 'answer|' + String(a || '').normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
  A.validateRecovery = function (question, answer) {
    const q = String(question || '').trim();
    if (q.length < 5 || q.length > 120) throw err('Write a security question (5–120 characters).');
    if (normAnswer(answer).length - 7 < A.MIN_ANSWER) throw err(`The answer must be at least ${A.MIN_ANSWER} characters.`);
    return q;
  };
  async function makeRecovery(privJwk, question, answer, id) {
    return Object.assign({ question }, await C.wrapKeys(privJwk, normAnswer(answer), id));
  }

  async function writeNewUser(id, profile, password, keys, created, extra) {
    const privSign = (await C.importPrivate(keys.privJwk)).sign;
    const rec = await signedUser({ v: 1, id, name: profile.name, animal: profile.animal, color: profile.color, created, updated: created, keys: keys.pub, prev: [] }, privSign);
    await S.writeJSON(`users/${id}.keys.json`, await C.wrapKeys(keys.privJwk, password, id, extra));
    await S.writeJSON(`users/${id}.json`, rec);
    const u = await prepareUser(rec, id);
    A.users.set(id, u);
    checkPin(u);
    return u;
  }

  /** Brand-new share: create workspace.json, the admin profile and #general. */
  A.createWorkspace = async function ({ wsName, name, animal, color, password, password2, question, answer, keep }) {
    wsName = String(wsName || '').trim() || 'Sankyo Chat';
    const profile = validateProfile({ name, animal, color });
    A.validatePassword(password, password2);
    question = A.validateRecovery(question, answer);
    const keys = await C.generateUserKeys();
    const id = await newUserId();
    const now = Date.now();
    await writeNewUser(id, profile, password, keys, now, { recovery: await makeRecovery(keys.privJwk, question, answer, id) });
    const priv = await C.importPrivate(keys.privJwk);
    const kid = await C.fp(keys.pub.sign);
    const general = { v: 1, id: 'general', type: 'public', name: 'general', description: 'Company-wide news and questions', createdBy: id, ts: now, kid };
    general.sig = await C.sign(priv.sign, general);
    await S.writeJSON('channels/general/meta.json', general);
    const ws = { v: 1, id: 'w' + U.rand(10), name: wsName, created: now, updated: now, adminId: id, admin: keys.pub,
      removed: [], resets: {}, admins: {}, formerAdmins: {}, autoLockMin: 30, channels: {}, appFingerprint: null, kid };
    ws.sig = await C.sign(priv.sign, ws);
    await S.writeJSON('workspace.json', ws);
    U.ls.set('wsPin', { id: ws.id, kid });
    A.ws = ws; cacheWs(ws); recompute();
    await setMe(id, keys.privJwk, false);
    await persistSession(!!keep);
  };

  /** Join an existing workspace. */
  A.createProfile = async function ({ name, animal, color, password, password2, keep }) {
    await A.refreshUsers();
    const profile = validateProfile({ name, animal, color });
    A.validatePassword(password, password2);
    const keys = await C.generateUserKeys();
    const id = await newUserId();
    await writeNewUser(id, profile, password, keys, Date.now());
    await setMe(id, keys.privJwk, false);
    await persistSession(!!keep);
  };

  /** Unlock the user's private keys with their password. */
  A.signIn = async function (id, password, keep) {
    const u = await A.loadUser(id);
    if (!u) throw err('That profile could not be loaded.');
    if (A.isRemoved(id)) throw err('This account was removed by the admin.');
    const kf = await S.readJSON(`users/${id}.keys.json`);
    if (!kf) throw err('The key file for this profile is missing. Ask your admin to reset your password.');
    const privJwk = await C.unwrapKeysJwk(kf, password, id);
    if (privJwk.sign.x !== u.keys.sign.x || privJwk.ecdh.x !== u.keys.ecdh.x) {
      throw err('Your key file doesn’t match your profile. Ask your admin to reset your password.');
    }
    await setMe(id, privJwk, kf.mustChange);
    await persistSession(!!keep);
  };

  async function persistSession(keep) {
    const s = { wsId: A.ws.id, userId: A.me.id, kid: A.me.signFp, priv: A.me.priv, keep, mustChange: A.me.mustChange };
    if (!keep) {
      s.token = U.rand(24);
      try { root.sessionStorage.setItem('sc.session', s.token); } catch { /* ignore */ }
    }
    U.ls.set('lastUser', A.me.id);
    U.ls.set('keepSignedIn', keep);
    await U.idb.set('kv', 'session', s);
  }
  A.keepSignedIn = () => !!U.ls.get('keepSignedIn', false);

  /** Resume a session kept in this browser (non-extractable keys in IndexedDB). */
  A.restoreSession = async function () {
    const s = await U.idb.get('kv', 'session');
    if (!s || !A.ws || s.wsId !== A.ws.id) return false;
    let token = null;
    try { token = root.sessionStorage.getItem('sc.session'); } catch { /* ignore */ }
    if (!s.keep && token !== s.token) { await U.idb.del('kv', 'session'); return false; }
    const u = await A.loadUser(s.userId);
    if (!u || A.isRemoved(u.id) || u.kid !== s.kid) { await U.idb.del('kv', 'session'); return false; }
    A.me = { id: u.id, priv: s.priv, signFp: u.kid, ecdhFp: u.ecdhFp, mustChange: !!s.mustChange };
    return true;
  };

  /** Sign out of this browser. */
  A.lock = async function () {
    A.me = null;
    C.clearCaches();
    try { root.sessionStorage.removeItem('sc.session'); } catch { /* ignore */ }
    await U.idb.del('kv', 'session');
  };

  A.changePassword = async function (oldPw, newPw, newPw2) {
    A.validatePassword(newPw, newPw2);
    const id = A.me.id;
    const kf = await S.readJSON(`users/${id}.keys.json`);
    if (!kf) throw err('Key file missing.');
    const privJwk = await C.unwrapKeysJwk(kf, oldPw, id);
    await S.writeJSON(`users/${id}.keys.json`, await C.wrapKeys(privJwk, newPw, id, kf.recovery ? { recovery: kf.recovery } : null));
    A.me.mustChange = false;
    const s = await U.idb.get('kv', 'session');
    if (s) { s.mustChange = false; await U.idb.set('kv', 'session', s); }
  };

  /** The security question for this profile, or null if it has none. */
  A.recoveryQuestion = async function (id) {
    const kf = await S.readJSON(`users/${id}.keys.json`);
    return (kf && kf.recovery && kf.recovery.question) || null;
  };

  /** Forgot password: unlock the keys with the security answer and set a new password. Keeps all messages. */
  A.recoverAccount = async function (id, answer, newPw, newPw2) {
    A.validatePassword(newPw, newPw2);
    const u = await A.loadUser(id);
    if (!u) throw err('That profile could not be loaded.');
    if (A.isRemoved(id)) throw err('This account was removed by the admin.');
    const kf = await S.readJSON(`users/${id}.keys.json`);
    if (!kf || !kf.recovery) throw err('This profile has no security question.');
    let privJwk;
    try { privJwk = await C.unwrapKeysJwk(kf.recovery, normAnswer(answer), id); } catch (e) {
      if (e.code === 'BAD_PASSWORD') throw err('That answer isn’t right.');
      throw e;
    }
    if (privJwk.sign.x !== u.keys.sign.x || privJwk.ecdh.x !== u.keys.ecdh.x) throw err('The security question belongs to old keys and can’t be used.');
    await S.writeJSON(`users/${id}.keys.json`, await C.wrapKeys(privJwk, newPw, id, { recovery: kf.recovery }));
    await setMe(id, privJwk, false);
    await persistSession(false);
  };

  /** Super admin: set or change the security question. Needs the current password. */
  A.setRecovery = async function (password, question, answer) {
    if (!A.isOwner()) throw err('Only the super admin can set a security question.');
    question = A.validateRecovery(question, answer);
    const id = A.me.id;
    const kf = await S.readJSON(`users/${id}.keys.json`);
    if (!kf) throw err('Key file missing.');
    const privJwk = await C.unwrapKeysJwk(kf, password, id);
    kf.recovery = await makeRecovery(privJwk, question, answer, id);
    await S.writeJSON(`users/${id}.keys.json`, kf);
  };

  A.updateProfile = async function ({ name, animal, color }) {
    const u = A.users.get(A.me.id);
    const p = validateProfile({ name, animal, color }, u.id);
    const rec = Object.assign({}, u, p, { updated: Date.now() });
    ['_sign', '_ecdh', 'ecdhFp', 'sig'].forEach(k => delete rec[k]);
    const signed = await signedUser(rec, A.me.priv.sign);
    await S.writeJSON(`users/${u.id}.json`, signed);
    A.users.set(u.id, await prepareUser(signed, u.id));
    A.events.emit('users');
  };

  /* ================= admin ================= */

  /* Moderation actions (channel changes, removals, password resets) are separate files in
   * admin/<ts>_<userId>_<rand>.json, each signed by the admin who took it. Every app checks the
   * signer against the super admin's signed list (A.canActAt) and ignores anything else. */
  /** @type {Map<string, any>} verified action files */
  A.adminLog = new Map();
  const badLog = new Set();

  async function actorKey(userId, kid) {
    if (A.ws && userId === A.ws.adminId && kid === A.ws.kid) return A.ws.admin.sign;
    const u = A.users.get(userId) || await A.loadUser(userId);
    return A.findKey(u, kid, 'sign');
  }

  function recompute() {
    const ws = A.ws || {};
    const eff = { channels: JSON.parse(JSON.stringify(ws.channels || {})), removed: new Set(ws.removed || []), resets: Object.assign({}, ws.resets) };
    const actions = Array.from(A.adminLog.values()).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    for (const a of actions) {
      a.valid = A.canActAt(a.userId, a.kid, a.ts);
      if (!a.valid) continue;
      if (a.type === 'channel') {
        const p = a.patch || {};
        const cur = Object.assign({}, eff.channels[a.target]);
        if (typeof p.name === 'string') cur.name = p.name.slice(0, 40);
        if (typeof p.description === 'string') cur.description = p.description.slice(0, 250);
        if (typeof p.archived === 'boolean') cur.archived = p.archived;
        eff.channels[a.target] = cur;
      } else if (a.type === 'remove' || a.type === 'reset') {
        const byOwner = a.userId === ws.adminId;
        if (a.target === ws.adminId || (!byOwner && A.isUserAdmin(a.target))) { a.valid = false; continue; }
        if (a.type === 'remove') eff.removed.add(a.target);
        else eff.resets[a.target] = { ts: a.ts, kid: a.resetKid };
      }
    }
    A.eff = eff;
    // a reset we learn about later turns "key changed" warnings into "reset by an admin" notices
    A.keyChanges.forEach((kc, id) => {
      const u = A.users.get(id);
      const r = eff.resets[id];
      kc.byAdmin = !!(u && r && r.kid === u.kid);
    });
  }

  /** Pick up new admin action files. @returns {Promise<boolean>} changed */
  A.refreshAdminLog = async function () {
    const names = (await S.list('admin', 'file')).filter(n => U.MSG_RE.test(n) && !A.adminLog.has(n) && !badLog.has(n));
    if (!names.length) return false;
    let changed = false;
    await U.mapLimit(names, 8, async n => {
      const p = U.parseMsgName(n);
      const raw = await S.readJSON('admin/' + n);
      if (!raw || raw.id !== p.id || raw.userId !== p.userId || raw.ts !== p.ts || !['channel', 'remove', 'reset'].includes(raw.type)) { badLog.add(n); return; }
      const key = await actorKey(raw.userId, raw.kid);
      if (!key || !(await C.verify(key, raw))) { badLog.add(n); return; }
      A.adminLog.set(n, raw);
      changed = true;
    });
    if (changed) { recompute(); A.events.emit('workspace'); }
    return changed;
  };

  async function adminAction(type, target, extra) {
    if (!A.isAdmin()) throw err('Only admins can do that');
    const ts = Date.now();
    const id = `${ts}_${A.me.id}_${U.rand(4)}`;
    const raw = Object.assign({ v: 1, id, type, target, ts, userId: A.me.id, kid: A.me.signFp }, extra || {});
    raw.sig = await C.sign(A.me.priv.sign, raw);
    await S.writeJSON(`admin/${id}.json`, raw);
    A.adminLog.set(id + '.json', raw);
    recompute();
    A.events.emit('workspace');
  }

  /** Admins may manage regular staff; only the super admin may manage admins. */
  function checkTarget(id, verb) {
    if (id === A.me.id) throw err(`Use your own settings to ${verb} your account.`);
    if (A.ws && id === A.ws.adminId) throw err('Nobody can do that to the super admin.');
    if (!A.isOwner() && A.isUserAdmin(id)) throw err('Only the super admin can manage other admins.');
  }

  /** New keys protected by a temporary password; the user must change it on next sign-in. */
  A.resetPassword = async function (id, tempPw) {
    if (!A.isAdmin()) throw err('Only admins can do that');
    checkTarget(id, 'change');
    A.validatePassword(tempPw);
    const old = await A.loadUser(id);
    if (!old) throw err('User not found');
    const keys = await C.generateUserKeys();
    const priv = await C.importPrivate(keys.privJwk);
    const now = Date.now();
    const rec = Object.assign({}, old, {
      keys: keys.pub, updated: now,
      prev: (old.prev || []).concat([{ sign: old.keys.sign, ecdh: old.keys.ecdh, until: now }]).slice(-5),
    });
    ['_sign', '_ecdh', 'ecdhFp', 'sig'].forEach(k => delete rec[k]);
    const signed = await signedUser(rec, priv.sign);
    await S.writeJSON(`users/${id}.keys.json`, await C.wrapKeys(keys.privJwk, tempPw, id, { mustChange: true }));
    await S.writeJSON(`users/${id}.json`, signed);
    if (A.isOwner()) {
      const patch = { resets: Object.assign({}, A.ws.resets, { [id]: { ts: now, kid: signed.kid } }) };
      if (A.adminEntry(id)) Object.assign(patch, stintChange(id, { kid: signed.kid, since: now }));
      await A.saveWorkspace(patch);
    } else {
      await adminAction('reset', id, { resetKid: signed.kid });
    }
    await A.loadUser(id);
    A.ackKeyChange(id);
  };

  A.removeUser = async function (id) {
    if (!A.isAdmin()) throw err('Only admins can do that');
    checkTarget(id, 'remove');
    if (A.isOwner()) {
      const patch = { removed: U.uniq((A.ws.removed || []).concat(id)) };
      if (A.adminEntry(id)) Object.assign(patch, stintChange(id, null));
      await A.saveWorkspace(patch);
    } else {
      await adminAction('remove', id);
    }
    await S.remove(`users/${id}.keys.json`);
  };

  /** Rename / describe / archive a channel. */
  A.setChannelOverride = async function (channelId, patch) {
    await adminAction('channel', channelId, { patch });
  };

  /** Workspace patch that ends someone's current admin stint and optionally starts a new one. */
  function stintChange(id, next) {
    const admins = Object.assign({}, A.ws.admins);
    const former = Object.assign({}, A.ws.formerAdmins);
    const cur = admins[id];
    if (cur) former[id] = (former[id] || []).concat([{ kid: cur.kid, since: cur.since, until: Date.now() }]).slice(-10);
    if (next) admins[id] = next; else delete admins[id];
    return { admins, formerAdmins: former };
  }

  /** Super admin: make someone an admin. */
  A.appointAdmin = async function (id) {
    if (!A.isOwner()) throw err('Only the super admin can appoint admins.');
    const u = await A.loadUser(id);
    if (!u || A.isRemoved(id)) throw err('User not found');
    if (A.isUserAdmin(id)) throw err(`${u.name} is already an admin.`);
    await A.saveWorkspace(stintChange(id, { kid: u.kid, since: Date.now() }));
  };
  /** Super admin: take admin rights away. Actions they took while admin stay in effect. */
  A.revokeAdmin = async function (id) {
    if (!A.isOwner()) throw err('Only the super admin can remove admins.');
    if (!A.adminEntry(id)) return;
    await A.saveWorkspace(stintChange(id, null));
  };

  /* ================= feedback inbox ================= */

  const INBOX_RE = /^\d{13}_[a-z0-9]{6}\.json$/;
  /** @type {Map<string, any>} file name → decrypted item (admin only) */
  A.inbox = new Map();
  A.inboxState = { done: [], read: [] };

  A.sendFeedback = async function ({ type, text, anonymous }) {
    text = String(text || '').trim();
    if (!A.FEEDBACK_TYPES.includes(type)) throw err('Pick a type.');
    if (!text) throw err('Write a message first.');
    if (text.length > 2000) throw err('Keep it under 2,000 characters.');
    const ts = Date.now();
    let inner = { kind: 'feedback', type, text, ts };
    if (!anonymous) {
      inner = Object.assign(inner, { userId: A.me.id, kid: A.me.signFp });
      inner.sig = await C.sign(A.me.priv.sign, inner);
    }
    const sealed = await C.seal(A.ws.admin.ecdh, inner, 'sankyo-inbox');
    await S.writeJSON(`inbox/${ts}_${U.rand(6)}.json`, Object.assign({ v: 1 }, sealed));
  };

  async function stateKey() { return C.pairKey(A.me.priv.ecdh, A.ws.admin.ecdh, 'sankyo-admin-state'); }

  /** Admin: pick up new feedback. @returns {Promise<boolean>} changed */
  A.loadInbox = async function () {
    if (!A.isOwner()) return false;
    let changed = false;
    const names = (await S.list('inbox', 'file')).filter(n => INBOX_RE.test(n));
    for (const k of Array.from(A.inbox.keys())) if (!names.includes(k)) { A.inbox.delete(k); changed = true; }
    const fresh = names.filter(n => !A.inbox.has(n));
    await U.mapLimit(fresh, 6, async n => {
      const raw = await S.readJSON('inbox/' + n);
      const item = { name: n, ts: Number(n.slice(0, 13)) };
      try {
        const inner = await C.unseal(A.me.priv.ecdh, raw, 'sankyo-inbox');
        item.type = A.FEEDBACK_TYPES.includes(inner.type) ? inner.type : 'Other';
        item.text = String(inner.text || '').slice(0, 2000);
        item.ts = Number(inner.ts) || item.ts;
        if (inner.userId) {
          const u = await A.loadUser(inner.userId);
          const key = A.findKey(u, inner.kid, 'sign');
          item.userId = inner.userId;
          item.verified = !!key && await C.verify(key, inner);
        }
      } catch { item.error = true; item.type = 'Other'; item.text = ''; }
      A.inbox.set(n, item);
      changed = true;
    });
    if (fresh.length || !A._stateLoaded) {
      A._stateLoaded = true;
      try {
        const enc = await S.readJSON('inbox/state.json');
        if (enc) A.inboxState = await C.decryptJSON(await stateKey(), enc, 'inbox-state');
      } catch { /* keep in-memory state */ }
    }
    return changed;
  };
  async function saveInboxState() {
    const names = new Set(A.inbox.keys());
    A.inboxState.done = A.inboxState.done.filter(n => names.has(n));
    A.inboxState.read = A.inboxState.read.filter(n => names.has(n));
    await S.writeJSON('inbox/state.json', await C.encryptJSON(await stateKey(), A.inboxState, 'inbox-state'));
  }
  A.inboxUnread = () => Array.from(A.inbox.keys()).filter(n => !A.inboxState.read.includes(n)).length;
  A.markFeedback = async function (name, { read, done }) {
    const st = A.inboxState;
    if (read !== undefined) st.read = read ? U.uniq(st.read.concat(name)) : st.read.filter(n => n !== name);
    if (done !== undefined) st.done = done ? U.uniq(st.done.concat(name)) : st.done.filter(n => n !== name);
    await saveInboxState();
  };
  A.deleteFeedback = async function (name) {
    if (!INBOX_RE.test(name)) return;
    await S.remove('inbox/' + name);
    A.inbox.delete(name);
    await saveInboxState();
  };

  SC.account = A;
})(typeof window !== 'undefined' ? window : globalThis);
