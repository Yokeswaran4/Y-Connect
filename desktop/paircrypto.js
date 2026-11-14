// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
/**
 * Crypto helpers for Y Connect.
 *
 * Data encryption is unchanged: AES-256-GCM with a key = PBKDF2-SHA256(pairing code, 100,000 rounds).
 * Wire format: base64(iv[12] + ciphertext + tag[16]).
 *
 * What is new is how a pairing code comes to exist. Every pair of devices gets its own random code (nothing is typed):
 *   1. both devices make a throw-away ECDH (P-256) key pair and swap the public halves in the clear,
 *   2. both show a short check number derived from the shared secret, so the user can see that no one sits in between,
 *   3. when the other user taps Accept, the requester sends the new random code, encrypted with a key from that secret.
 * The code is then stored per device and used exactly like the old shared code was.
 */
const crypto = require('crypto');

const SALT = 'y-connect-v1';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const norm = (p) => (String(p).toUpperCase().replace(/[^A-Z0-9]/g, '') || '-');
const deriveKey = (code) => crypto.pbkdf2Sync(norm(code), SALT, 100000, 32, 'sha256');

/** 16 random characters (80 bits), shown as XXXX-XXXX-XXXX-XXXX. */
function randomCode() {
  let s = '';
  for (let i = 0; i < 16; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s.match(/.{4}/g).join('-');
}
const validCode = (c) => typeof c === 'string' && norm(c).length >= 12 && norm(c).length <= 64;

function seal(key, text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, enc, c.getAuthTag()]).toString('base64');
}
function open(key, b64) {
  const b = Buffer.from(b64, 'base64');
  if (b.length < 29) throw new Error('short');
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8');
}
function sealBytes(key, buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = c.update(buf);
  c.final(); // GCM is a stream mode: final() adds nothing
  const out = Buffer.allocUnsafe(12 + enc.length + 16); // iv + ciphertext + tag, assembled with a single copy
  iv.copy(out, 0);
  enc.copy(out, 12);
  c.getAuthTag().copy(out, 12 + enc.length);
  return out;
}
function openBytes(key, b) {
  if (b.length < 29) throw new Error('short');
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]);
}

/** Throw-away key pair; the public half is X.509 / SPKI DER in base64 (the same bytes Android produces). */
function newKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { priv: privateKey, pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}
/** Shared secret from our private key and the other side's public half. Throws on anything that is not a P-256 key. */
function agree(priv, peerPubB64) {
  if (typeof peerPubB64 !== 'string' || peerPubB64.length > 400) throw new Error('bad key');
  const publicKey = crypto.createPublicKey({ key: Buffer.from(peerPubB64, 'base64'), format: 'der', type: 'spki' });
  return crypto.diffieHellman({ privateKey: priv, publicKey });
}
/** Key that protects the new pairing code while it travels. */
const transportKey = (secret) => crypto.createHash('sha256').update('y-connect-pair-v1').update(secret).digest();
/** The 6-digit number both screens show. pubA = the device that asked, pubB = the device that was asked. */
function checkNumber(secret, pubA, pubB) {
  const h = crypto.createHash('sha256').update('y-connect-sas-v1').update(secret)
    .update(Buffer.from(pubA, 'base64')).update(Buffer.from(pubB, 'base64')).digest();
  const n = h.readUInt32BE(0) % 1000000;
  const s = String(n).padStart(6, '0');
  return s.slice(0, 3) + ' ' + s.slice(3);
}

module.exports = { norm, deriveKey, randomCode, validCode, seal, open, sealBytes, openBytes, newKeyPair, agree, transportKey, checkNumber };
