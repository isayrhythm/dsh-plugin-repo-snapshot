/**
 * Optional: pre-generate the RSA keypair used to encrypt snapshots.
 *
 * The plugin generates this pair automatically on first use, so you normally do
 * not need to run this script. It is useful when you want to provision keys
 * ahead of time, copy them to another machine, or replace an existing pair.
 *
 *   node scripts/keygen.mjs [--out <dir>] [--force]
 *
 * Default destination: <DSH_HOME>/repo-snapshot/keys
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const target =
  outIndex !== -1 && args[outIndex + 1]
    ? path.resolve(args[outIndex + 1])
    : path.join(dshHome, 'repo-snapshot', 'keys');

const pubPath = path.join(target, 'public.pem');
const privPath = path.join(target, 'private.pem');

fs.mkdirSync(target, { recursive: true });

if (fs.existsSync(privPath) && !args.includes('--force')) {
  console.log(`Private key already exists: ${privPath}`);
  console.log('Use --force to overwrite. Warning: snapshots encrypted with the');
  console.log('previous key become unreadable once it is replaced.');
  process.exit(0);
}

console.log('Generating 4096-bit RSA keypair (a few seconds)...');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 4096,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

fs.writeFileSync(pubPath, publicKey, 'utf8');
fs.writeFileSync(privPath, privateKey, { encoding: 'utf8', mode: 0o600 });

console.log('Done.');
console.log(`  public key : ${pubPath}`);
console.log(`  private key: ${privPath}`);
console.log('');
console.log('Keep private.pem on this machine only. Never commit it, never upload it.');
console.log('Without it, snapshots cannot be decrypted by anyone — including us.');
