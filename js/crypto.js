/* Sankyo Chat — crypto: keys, encryption, signatures.
 * Web Crypto only (built into Edge/Chrome, works offline):
 *   ECDSA P-256 (signatures), ECDH P-256 + HKDF-SHA256 (shared keys),
 *   AES-GCM 256 (encryption), PBKDF2-SHA256 600,000 rounds (password → key). */
(function (root) {
  'use strict';
  const SC = root.SC = root.SC || {};
  const U = SC.util;
  /** @namespace SC.crypto */
  const C = {};
  const subtle = () => root.crypto.subtle;
  const rnd = n => root.crypto.getRandomValues(new Uint8Array(n));

  C.ITERATIONS = 600000;
  const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
  const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
  const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

  /** @typedef {{kty:string,crv:string,x:string,y:string}} PubJwk */

  /** @returns {Promise<PubJwk>} */
  C.pubJwk = async function (key) {
    const j = await subtle().exportKey('jwk', key);
    return { kty: j.kty, crv: j.crv, x: j.x, y: j.y };
  };

  /** Short fingerprint (16 hex) of a public key. */
  C.fp = async function (jwk) {
    const h = await subtle().digest('SHA-256', U.utf8(`${jwk.crv}|${jwk.x}|${jwk.y}`));
    return U.hex(h).slice(0, 16);
  };

  C.sha256Hex = async buf => U.hex(await subtle().digest('SHA-256', buf));

  /** New signing + ECDH key pairs. Private halves come back as JWK for wrapping. */
  C.generateUserKeys = async function () {
    const sign = await subtle().generateKey(ECDSA, true, ['sign', 'verify']);
    const ecdh = await subtle().generateKey(ECDH, true, ['deriveBits']);
    return {
      pub: { sign: await C.pubJwk(sign.publicKey), ecdh: await C.pubJwk(ecdh.publicKey) },
      privJwk: { sign: await subtle().exportKey('jwk', sign.privateKey), ecdh: await subtle().exportKey('jwk', ecdh.privateKey) },
    };
  };

  const stripJwk = j => ({ kty: j.kty, crv: j.crv, x: j.x, y: j.y, d: j.d });
  /** Import private keys as NON-extractable CryptoKeys (safe to keep in IndexedDB). */
  C.importPrivate = async function (privJwk) {
    return {
      sign: await subtle().importKey('jwk', stripJwk(privJwk.sign), ECDSA, false, ['sign']),
      ecdh: await subtle().importKey('jwk', stripJwk(privJwk.ecdh), ECDH, false, ['deriveBits']),
    };
  };

  async function passwordKey(password, salt, iterations) {
    const base = await subtle().importKey('raw', U.utf8(String(password).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  /** Encrypt private keys with the password → contents of users/<id>.keys.json */
  C.wrapKeys = async function (privJwk, password, userId, extra) {
    const salt = rnd(16), iv = rnd(12);
    const k = await passwordKey(password, salt, C.ITERATIONS);
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: U.utf8('sankyo-keys|' + userId) }, k,
      U.utf8(JSON.stringify({ sign: stripJwk(privJwk.sign), ecdh: stripJwk(privJwk.ecdh) })));
    return Object.assign({ v: 1, kdf: 'PBKDF2-SHA256', iterations: C.ITERATIONS, salt: U.b64(salt), iv: U.b64(iv), wrapped: U.b64(ct) }, extra || {});
  };

  /** Decrypt a key file. Throws {code:'BAD_PASSWORD'} on a wrong password. */
  C.unwrapKeysJwk = async function (file, password, userId) {
    const iterations = Math.max(100000, Number(file.iterations) || C.ITERATIONS);
    const k = await passwordKey(password, U.unb64(file.salt), iterations);
    let pt;
    try {
      pt = await subtle().decrypt({ name: 'AES-GCM', iv: U.unb64(file.iv), additionalData: U.utf8('sankyo-keys|' + userId) }, k, U.unb64(file.wrapped));
    } catch {
      throw Object.assign(new Error('Wrong password'), { code: 'BAD_PASSWORD' });
    }
    return JSON.parse(U.unutf8(pt));
  };

  /* ---- public key import cache ---- */
  const pubCache = new Map();
  function importPub(jwk, kind) {
    const k = kind + '|' + jwk.x + '|' + jwk.y;
    let p = pubCache.get(k);
    if (!p) {
      p = subtle().importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
        kind === 'sign' ? ECDSA : ECDH, false, kind === 'sign' ? ['verify'] : []);
      pubCache.set(k, p);
      p.catch(() => pubCache.delete(k));
    }
    return p;
  }

  /* ---- signatures (over canonical JSON without `sig`) ---- */
  C.sign = async function (privSign, obj) {
    const body = Object.assign({}, obj); delete body.sig;
    return U.b64(await subtle().sign(SIGN, privSign, U.utf8(U.canonical(body))));
  };
  C.verify = async function (pubJwk, obj) {
    if (!pubJwk || !obj || typeof obj.sig !== 'string') return false;
    try {
      const body = Object.assign({}, obj); delete body.sig;
      return await subtle().verify(SIGN, await importPub(pubJwk, 'sign'), U.unb64(obj.sig), U.utf8(U.canonical(body)));
    } catch { return false; }
  };

  /* ---- shared keys ---- */
  async function deriveAes(myEcdhPriv, theirJwk, info) {
    const bits = await subtle().deriveBits({ name: 'ECDH', public: await importPub(theirJwk, 'ecdh') }, myEcdhPriv, 256);
    const hk = await subtle().importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: U.utf8(info) },
      hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  const pairCache = new Map();
  /** AES key shared by me and `theirJwk`, bound to `info` (e.g. the DM id). */
  C.pairKey = function (myEcdhPriv, theirJwk, info) {
    const k = theirJwk.x + '|' + theirJwk.y + '|' + info;
    let p = pairCache.get(k);
    if (!p) {
      p = deriveAes(myEcdhPriv, theirJwk, info);
      pairCache.set(k, p);
      p.catch(() => pairCache.delete(k));
    }
    return p;
  };
  C.clearCaches = () => pairCache.clear();

  C.randomRaw = () => rnd(32);
  C.importAes = raw => subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

  /* ---- AES-GCM helpers ---- */
  C.encryptJSON = async function (key, obj, aad) {
    const iv = rnd(12);
    const p = { name: 'AES-GCM', iv };
    if (aad) p.additionalData = U.utf8(aad);
    const ct = await subtle().encrypt(p, key, U.utf8(JSON.stringify(obj)));
    return { iv: U.b64(iv), ct: U.b64(ct) };
  };
  C.decryptJSON = async function (key, enc, aad) {
    const p = { name: 'AES-GCM', iv: U.unb64(enc.iv) };
    if (aad) p.additionalData = U.utf8(aad);
    return JSON.parse(U.unutf8(await subtle().decrypt(p, key, U.unb64(enc.ct))));
  };
  C.encryptBytes = async function (key, buf, aad) {
    const iv = rnd(12);
    const data = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: U.utf8(aad) }, key, buf);
    return { iv: U.b64(iv), data };
  };
  C.decryptBytes = (key, iv, data, aad) =>
    subtle().decrypt({ name: 'AES-GCM', iv: U.unb64(iv), additionalData: U.utf8(aad) }, key, data);

  /* ---- sealed box: encrypt for a public key with a one-time key ---- */
  C.seal = async function (recipientJwk, obj, info) {
    const eph = await subtle().generateKey(ECDH, true, ['deriveBits']);
    const key = await deriveAes(eph.privateKey, recipientJwk, info);
    const enc = await C.encryptJSON(key, obj, info);
    return { epk: await C.pubJwk(eph.publicKey), iv: enc.iv, ct: enc.ct };
  };
  C.unseal = async function (myEcdhPriv, sealed, info) {
    const key = await deriveAes(myEcdhPriv, sealed.epk, info);
    return C.decryptJSON(key, sealed, info);
  };

  SC.crypto = C;
})(typeof window !== 'undefined' ? window : globalThis);
