/**
 * Decrypt and extract a snapshot produced by dsh-plugin-repo-snapshot.
 *
 *   node scripts/decrypt.mjs \
 *     --input <snapshot.tar.gz.enc> \
 *     --key <snapshot.key.enc> \
 *     --private-key <DSH_HOME>/repo-snapshot/keys/private.pem \
 *     --output ./restored
 *
 * The private key never leaves your machine, so this is the only way a snapshot
 * can be read back. Supports both the current v2 container format
 * (AES-256-GCM or AES-256-CTR) and the legacy v1 format.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import * as tar from 'tar';

const MAGIC = Buffer.from('RSNAP2', 'ascii');
const ALG_GCM = 1;
const ALG_CTR = 2;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

/** Unwrap the AES key with the local RSA private key. */
function unwrapKey(wrapped, privateKey) {
  return crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    wrapped
  );
}

/** Parse the container header and decrypt the body. */
function decryptArchive(encBuffer, aesKey) {
  if (encBuffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    let offset = MAGIC.length;

    const algorithm = encBuffer.readUInt8(offset);
    offset += 1;

    const ivLength = encBuffer.readUInt8(offset);
    offset += 1;

    const iv = encBuffer.subarray(offset, offset + ivLength);
    offset += ivLength;

    const tagLength = encBuffer.readUInt16BE(offset);
    offset += 2;

    const tag = encBuffer.subarray(offset, offset + tagLength);
    offset += tagLength;

    const body = encBuffer.subarray(offset);

    if (algorithm === ALG_GCM) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]);
    }
    if (algorithm === ALG_CTR) {
      const decipher = crypto.createDecipheriv('aes-256-ctr', aesKey, iv);
      return Buffer.concat([decipher.update(body), decipher.final()]);
    }
    throw new Error(`Unknown algorithm id in snapshot header: ${algorithm}`);
  }

  // Legacy v1: 16-byte IV prefix, then AES-256-CTR.
  const iv = encBuffer.subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-ctr', aesKey, iv);
  return Buffer.concat([decipher.update(encBuffer.subarray(16)), decipher.final()]);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input;
  const keyFile = args.key;
  const privateKeyPath = args['private-key'];
  const output = args.output;

  if (!input || !keyFile || !privateKeyPath || !output) {
    console.error(
      'Usage: node decrypt.mjs --input <snapshot.tar.gz.enc> --key <snapshot.key.enc> ' +
        '--private-key <private.pem> --output <dir>'
    );
    process.exit(1);
  }

  for (const [label, file] of [
    ['input', input],
    ['key', keyFile],
    ['private key', privateKeyPath],
  ]) {
    if (!fs.existsSync(file)) {
      console.error(`${label} not found: ${file}`);
      process.exit(1);
    }
  }

  const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
  const aesKey = unwrapKey(fs.readFileSync(keyFile), privateKey);
  const tarGz = decryptArchive(fs.readFileSync(input), aesKey);

  fs.mkdirSync(output, { recursive: true });
  const tarPath = path.join(output, 'snapshot.tar');
  fs.writeFileSync(tarPath, zlib.gunzipSync(tarGz));
  tar.x({ file: tarPath, cwd: output, sync: true });
  fs.rmSync(tarPath, { force: true });

  const manifestPath = path.join(output, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    console.log('Snapshot restored');
    console.log(`  id        : ${manifest.snapshotId}`);
    console.log(`  time      : ${manifest.timestamp}`);
    console.log(`  workspace : ${manifest.workspacePath}`);
    console.log(`  files     : ${manifest.fileCount}`);
  } else {
    console.log('Snapshot restored (no manifest.json found)');
  }
  console.log(`  output    : ${output}`);
}

try {
  main();
} catch (error) {
  console.error('Decryption failed:', error?.message ?? error);
  process.exit(1);
}
