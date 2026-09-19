/**
 * dsh-plugin-repo-snapshot — Host half.
 *
 * Takes an encrypted snapshot of the current workspace (including `.git`) and
 * stores it in a destination the user controls: a local directory or their own
 * Aliyun OSS bucket.
 *
 * Privacy model — the opposite of a silent uploader:
 *   - Nothing leaves the machine until the user configures a destination.
 *   - Encryption is always on, and the private key never leaves the machine.
 *   - Sensitive-looking files are skipped, and the number skipped is reported.
 *   - The whole thing can be switched off from the settings page.
 */

import {
  createWriteStream,
  readFileSync,
  existsSync,
  statSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  renameSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import {
  randomBytes,
  createCipheriv,
  createHash,
  createHmac,
  publicEncrypt,
  generateKeyPairSync,
  constants as cryptoConstants,
} from 'node:crypto';
import { execSync } from 'node:child_process';
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

// ── Identity ────────────────────────────────────────────────────────────────────

export const name = 'repo-snapshot';

// ── Paths ───────────────────────────────────────────────────────────────────────

/** DSH home; honours DSH_HOME the same way the harness itself does. */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function storeDir() {
  return join(dshHome(), 'repo-snapshot');
}

function settingsFilePath() {
  return join(storeDir(), 'settings.json');
}

function keysDir() {
  return join(storeDir(), 'keys');
}

function publicKeyPath() {
  return join(keysDir(), 'public.pem');
}

function privateKeyPath() {
  return join(keysDir(), 'private.pem');
}

// ── Config schema (the Cordis layer; settings.json overrides it) ────────────────

export const Config = z.object({
  /** Master switch. */
  enabled: z.boolean().default(true),

  oss: z.object({
    provider: z.union([z.const('local'), z.const('aliyun')]).default('local'),
    /** Aliyun OSS region, e.g. oss-cn-hangzhou. */
    region: z.string().default(''),
    bucket: z.string().default(''),
    /** Leave empty to read ALIYUN_OSS_ACCESS_KEY_ID from the environment. */
    accessKeyId: z.string().default(''),
    /** Leave empty to read ALIYUN_OSS_ACCESS_KEY_SECRET from the environment. */
    accessKeySecret: z.string().default(''),
    /** Key prefix inside the bucket / local root. */
    prefix: z.string().default('repo-snapshots/'),
    /**
     * OSS signing scheme. 'auto' tries V4 and falls back to V1; pin it with
     * 'v4' or 'v1' if a bucket rejects one of them.
     */
    signatureVersion: z.union([z.const('auto'), z.const('v4'), z.const('v1')]).default('auto'),
    /** For provider=local. Defaults to <DSH_HOME>/repo-snapshots. */
    localDir: z.string().default(''),
  }),

  encryption: z.object({
    enabled: z.boolean().default(true),
    algorithm: z
      .union([z.const('aes-256-gcm'), z.const('aes-256-ctr')])
      .default('aes-256-gcm'),
  }),

  scan: z.object({
    includeGit: z.boolean().default(true),
    excludePatterns: z
      .array(z.string())
      .default([
        'node_modules',
        '.next',
        'dist',
        'build',
        'out',
        '.cache',
        '.venv',
        'venv',
        '__pycache__',
        'target',
        '.DS_Store',
        '*.log',
      ]),
    maxFileSizeMB: z.number().default(5),
    excludeSensitiveFiles: z.boolean().default(true),
    sensitivePatterns: z
      .array(z.string())
      .default([
        '*token*',
        '*secret*',
        '*password*',
        '*passwd*',
        '*credential*',
        '*.pem',
        '*.key',
        '*.p12',
        '*.pfx',
        '*.jks',
        '*.keystore',
        '*.ppk',
        '*.kdbx',
        'id_rsa',
        'id_dsa',
        'id_ecdsa',
        'id_ed25519',
        '*_rsa',
        '*_dsa',
        '*_ecdsa',
        '*_ed25519',
        '.env',
        '.env.*',
        '.npmrc',
        '.netrc',
        '.git-credentials',
        'known_hosts',
        '.ssh',
      ]),
  }),

  trigger: z
    .union([z.const('session-start'), z.const('pre-step'), z.const('both'), z.const('manual')])
    .default('session-start'),

  maxSnapshotsPerSession: z.number().default(5),

  /** Skip a snapshot when the workspace signature is unchanged. */
  dedupe: z.boolean().default(true),

  injectStatusMessage: z.boolean().default(true),

  timeoutMs: z.number().default(180000),
});

// ── Settings persistence ────────────────────────────────────────────────────────

/**
 * Settings the UI is allowed to write.
 *
 * The client sends flat UI field names (matching what `/status` returns); the
 * config itself is nested, so each field maps to an explicit config path.
 * Dotted config paths are accepted too, for scripted use.
 */
const UI_FIELD_PATHS = {
  enabled: 'enabled',
  provider: 'oss.provider',
  region: 'oss.region',
  bucket: 'oss.bucket',
  accessKeyId: 'oss.accessKeyId',
  accessKeySecret: 'oss.accessKeySecret',
  prefix: 'oss.prefix',
  signatureVersion: 'oss.signatureVersion',
  localDir: 'oss.localDir',
  encryptionEnabled: 'encryption.enabled',
  algorithm: 'encryption.algorithm',
  includeGit: 'scan.includeGit',
  maxFileSizeMB: 'scan.maxFileSizeMB',
  excludeSensitiveFiles: 'scan.excludeSensitiveFiles',
  trigger: 'trigger',
  dedupe: 'dedupe',
  maxSnapshotsPerSession: 'maxSnapshotsPerSession',
  injectStatusMessage: 'injectStatusMessage',
};

const SETTABLE_PATHS = Object.values(UI_FIELD_PATHS);
const SETTABLE_PATH_SET = new Set(SETTABLE_PATHS);

function readSettings() {
  try {
    const raw = readFileSync(settingsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Atomic-ish write: temp file then rename. */
function writeSettings(next) {
  mkdirSync(storeDir(), { recursive: true });
  const target = settingsFilePath();
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
}

/** Deep-merge the saved settings over the Cordis config. */
function effectiveConfig(cordisConfig) {
  const base = JSON.parse(JSON.stringify(cordisConfig ?? {}));
  const saved = flatten(readSettings());

  for (const key of SETTABLE_PATHS) {
    if (!(key in saved)) continue;
    const parts = key.split('.');
    let cursor = base;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (typeof cursor[parts[i]] !== 'object' || cursor[parts[i]] === null) {
        cursor[parts[i]] = {};
      }
      cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = saved[key];
  }
  return base;
}

/** Flatten `{a:{b:1}}` to `{'a.b':1}` so keyed merge stays simple. */
function flatten(value, prefix = '', out = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (prefix !== '') out[prefix] = value;
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    flatten(child, prefix === '' ? key : `${prefix}.${key}`, out);
  }
  return out;
}

// ── Key management ──────────────────────────────────────────────────────────────

/**
 * Ensure an RSA keypair exists. Generated on first use so a fresh install needs
 * no manual step; the private key stays on this machine and is never uploaded.
 */
function ensureKeyPair() {
  const pub = publicKeyPath();
  const priv = privateKeyPath();
  if (existsSync(pub) && existsSync(priv)) return { created: false, publicKey: pub, privateKey: priv };

  mkdirSync(keysDir(), { recursive: true });
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(pub, pair.publicKey, 'utf8');
  writeFileSync(priv, pair.privateKey, { encoding: 'utf8', mode: 0o600 });
  return { created: true, publicKey: pub, privateKey: priv };
}

function publicKeyFingerprint() {
  try {
    const pem = readFileSync(publicKeyPath(), 'utf8');
    const der = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    return createHash('sha256').update(Buffer.from(der, 'base64')).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

// ── Scanning ────────────────────────────────────────────────────────────────────

/**
 * Match a workspace-relative path against glob-ish patterns.
 *
 * A pattern containing "/" is matched against the whole path. A bare pattern
 * (e.g. "node_modules", "*.log") is matched against the basename AND against
 * every individual path segment, so directory names match at any depth.
 */
function matchPattern(filePath, patterns) {
  const normalized = String(filePath).replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const base = segments[segments.length - 1] || normalized;

  return patterns.some((pattern) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp(`^${escaped}$`, 'i');

    if (pattern.includes('/')) return regex.test(normalized);
    return regex.test(base) || segments.some((segment) => regex.test(segment));
  });
}

function walkDir(dir, rootDir, out) {
  let list;
  try {
    list = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // permission denied or unreadable — skip
  }
  for (const entry of list) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, rootDir, out);
    } else if (entry.isFile()) {
      out.push(relative(rootDir, full).replace(/\\/g, '/'));
    }
  }
  return out;
}

/**
 * Collect candidate paths: git-tracked/untracked files when the workspace is a
 * repo, everything otherwise, plus `.git` when enabled.
 */
function collectCandidates(workspacePath, scanConfig) {
  let files = [];
  try {
    const output = execSync('git ls-files --cached --others --exclude-standard -z', {
      cwd: workspacePath,
      maxBuffer: 1024 * 1024 * 64,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    files = output.toString('utf8').split('\0').filter(Boolean);
  } catch {
    files = walkDir(workspacePath, workspacePath, []);
  }

  if (scanConfig.includeGit) {
    const gitDir = join(workspacePath, '.git');
    if (existsSync(gitDir)) {
      // A file (worktree/submodule pointer) or a directory — handle both.
      if (statSync(gitDir).isDirectory()) {
        walkDir(gitDir, workspacePath, files);
      } else {
        files.push('.git');
      }
    }
  }

  return files;
}

/** Filter candidates, counting WHY each one was skipped. */
function scanFiles(workspacePath, scanConfig) {
  const files = collectCandidates(workspacePath, scanConfig);
  const maxBytes = (scanConfig.maxFileSizeMB ?? 5) * 1024 * 1024;

  const kept = [];
  const stats = [];
  const skipped = { excluded: 0, sensitive: 0, tooLarge: 0, unreadable: 0 };
  const seen = new Set();
  let totalBytes = 0;

  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);

    const full = join(workspacePath, file);

    if (matchPattern(file, scanConfig.excludePatterns ?? [])) {
      skipped.excluded += 1;
      continue;
    }
    if (
      scanConfig.excludeSensitiveFiles &&
      matchPattern(file, scanConfig.sensitivePatterns ?? [])
    ) {
      skipped.sensitive += 1;
      continue;
    }

    let stat;
    try {
      stat = statSync(full);
    } catch {
      skipped.unreadable += 1;
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > maxBytes) {
      skipped.tooLarge += 1;
      continue;
    }

    kept.push(file);
    stats.push({ path: file, size: stat.size });
    totalBytes += stat.size;
  }

  return { files: kept, stats, skipped, totalBytes };
}

/** Cheap content signature so an unchanged workspace is not re-uploaded. */
function workspaceSignature(stats) {
  const hash = createHash('sha256');
  hash.update(String(stats.length));
  for (const item of [...stats].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(item.path);
    hash.update(String(item.size));
  }
  return hash.digest('hex');
}

// ── Archive ─────────────────────────────────────────────────────────────────────

async function createArchive(workspacePath, files, manifest) {
  const archiver = (await import('archiver')).default;

  const tmpDir = mkdtempSync(join(tmpdir(), 'repo-snapshot-'));
  const tarPath = join(tmpDir, `${manifest.snapshotId}.tar.gz`);

  await new Promise((resolvePromise, rejectPromise) => {
    const output = createWriteStream(tarPath);
    const archive = archiver('tar', { gzip: true });

    output.on('close', resolvePromise);
    output.on('error', rejectPromise);
    archive.on('error', rejectPromise);
    archive.on('warning', () => {}); // missing-file races are not fatal
    archive.pipe(output);

    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    for (const file of files) {
      archive.file(join(workspacePath, file), { name: `files/${file}` });
    }
    archive.finalize();
  });

  return { tarPath, tmpDir };
}

// ── Encryption ──────────────────────────────────────────────────────────────────

const MAGIC = Buffer.from('RSNAP2', 'ascii');
const ALG_GCM = 1;
const ALG_CTR = 2;

/**
 * Hybrid encryption, format v2:
 *   "RSNAP2" | alg(1) | ivLen(1) | iv | tagLen(2, BE) | tag | ciphertext
 *
 * The AES key is wrapped with the local RSA public key, so only the holder of
 * `private.pem` (i.e. the user) can read the archive.
 */
function encryptArchive(tarPath, tmpDir, snapshotId, encryptionConfig) {
  const encPath = join(tmpDir, `${snapshotId}.tar.gz.enc`);
  const keyPath = join(tmpDir, `${snapshotId}.key.enc`);
  const plain = readFileSync(tarPath);

  if (!encryptionConfig.enabled) {
    copyFileSync(tarPath, encPath);
    return { encPath, keyPath: null, algorithm: 'none' };
  }

  const algorithm = encryptionConfig.algorithm === 'aes-256-ctr' ? 'aes-256-ctr' : 'aes-256-gcm';
  const isGcm = algorithm === 'aes-256-gcm';
  const iv = randomBytes(isGcm ? 12 : 16);
  const aesKey = randomBytes(32);

  const cipher = createCipheriv(algorithm, aesKey, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = isGcm ? cipher.getAuthTag() : Buffer.alloc(0);

  const header = Buffer.alloc(6 + 1 + 1 + iv.length + 2 + tag.length);
  let offset = 0;
  MAGIC.copy(header, offset);
  offset += MAGIC.length;
  header.writeUInt8(isGcm ? ALG_GCM : ALG_CTR, offset);
  offset += 1;
  header.writeUInt8(iv.length, offset);
  offset += 1;
  iv.copy(header, offset);
  offset += iv.length;
  header.writeUInt16BE(tag.length, offset);
  offset += 2;
  tag.copy(header, offset);

  writeFileSync(encPath, Buffer.concat([header, body]));

  const wrappedKey = publicEncrypt(
    {
      key: readFileSync(publicKeyPath(), 'utf8'),
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey
  );
  writeFileSync(keyPath, wrappedKey);

  return { encPath, keyPath, algorithm };
}

// ── Destination ─────────────────────────────────────────────────────────────────

// ── Aliyun OSS ──────────────────────────────────────────────────────────────────
//
// Deliberately SDK-free: OSS object PUT/DELETE is signed here, which keeps this
// plugin free of a heavy dependency and of a network install step.
//
// Two schemes are implemented:
//   V4 (OSS4-HMAC-SHA256) — the current standard, ported from the official SDK.
//   V1 (OSS <ak>:<hmac-sha1>) — the long-standing scheme, still accepted by most
//   buckets, but Aliyun has begun disabling it, so V4 comes first.
//
// `signatureVersion: 'auto'` tries V4 and falls back to V1, reporting both
// failures when neither works.

function ossEndpoint(ossConfig) {
  const region = String(ossConfig.region ?? '').trim();
  const bucket = String(ossConfig.bucket ?? '').trim();
  if (!region) throw new Error('阿里云 OSS：缺少 region，例如 oss-cn-hangzhou');
  if (!bucket) throw new Error('阿里云 OSS：缺少 bucket');
  return {
    bucket,
    host: `${bucket}.${region}.aliyuncs.com`,
    // The V4 credential scope uses the region WITHOUT the "oss-" prefix.
    scope: region.replace(/^oss-/, ''),
  };
}

function ossCredentials(ossConfig) {
  const accessKeyId = ossConfig.accessKeyId || process.env.ALIYUN_OSS_ACCESS_KEY_ID;
  const accessKeySecret = ossConfig.accessKeySecret || process.env.ALIYUN_OSS_ACCESS_KEY_SECRET;
  if (!accessKeyId || !accessKeySecret) {
    throw new Error(
      '阿里云 OSS：缺少 AccessKey —— 请在设置页填写，或设置环境变量 ' +
        'ALIYUN_OSS_ACCESS_KEY_ID / ALIYUN_OSS_ACCESS_KEY_SECRET'
    );
  }
  return { accessKeyId, accessKeySecret };
}

/**
 * Percent-encode an object key, preserving "/" separators.
 *
 * Matches the official SDK's `encodeString`: `encodeURIComponent` plus the
 * `!'()*` set, which `encodeURIComponent` leaves alone.
 */
function encodeKey(key) {
  return key
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
      )
    )
    .join('/');
}

/** UTC "yyyymmddTHHMMSSZ", the timestamp format OSS V4 expects. */
function ossV4Date(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}/, '').replace(/[-:]/g, '');
}

/** Header signature V1. */
function signV1({ method, bucket, canonicalKey, contentType, accessKeyId, accessKeySecret }) {
  const date = new Date().toUTCString();
  const stringToSign = [method, '', contentType, date, `/${bucket}/${canonicalKey}`].join('\n');
  const signature = createHmac('sha1', accessKeySecret)
    .update(stringToSign, 'utf8')
    .digest('base64');

  const headers = { Date: date, Authorization: `OSS ${accessKeyId}:${signature}` };
  if (contentType) headers['Content-Type'] = contentType;
  return { headers, stringToSign };
}

/** Header signature V4 (OSS4-HMAC-SHA256). */
function signV4({ method, bucket, canonicalKey, contentType, scope, accessKeyId, accessKeySecret }) {
  const date = ossV4Date();
  const onlyDate = date.slice(0, 8);

  const signed = {
    'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
    'x-oss-date': date,
  };
  if (contentType) signed['content-type'] = contentType;

  const canonicalHeaders = Object.keys(signed)
    .sort()
    .map((headerName) => `${headerName}:${signed[headerName]}\n`)
    .join('');

  const canonicalRequest = [
    method,
    `/${bucket}/${canonicalKey}`,
    '', // canonical query string — none
    canonicalHeaders,
    '', // additional headers — none
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'OSS4-HMAC-SHA256',
    date,
    `${onlyDate}/${scope}/oss/aliyun_v4_request`,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');

  const keyDate = createHmac('sha256', `aliyun_v4${accessKeySecret}`).update(onlyDate).digest();
  const keyRegion = createHmac('sha256', keyDate).update(scope).digest();
  const keyService = createHmac('sha256', keyRegion).update('oss').digest();
  const keySigning = createHmac('sha256', keyService).update('aliyun_v4_request').digest();
  const signature = createHmac('sha256', keySigning).update(stringToSign, 'utf8').digest('hex');

  return {
    headers: {
      ...signed,
      Authorization:
        `OSS4-HMAC-SHA256 Credential=${accessKeyId}/${onlyDate}/${scope}/oss/aliyun_v4_request,` +
        `Signature=${signature}`,
    },
    stringToSign,
  };
}

async function ossRequest(ossConfig, method, key, body) {
  if (typeof fetch !== 'function') {
    throw new Error('当前 Node 运行时没有全局 fetch，无法上传 OSS');
  }

  const { bucket, host, scope } = ossEndpoint(ossConfig);
  const { accessKeyId, accessKeySecret } = ossCredentials(ossConfig);
  const canonicalKey = encodeKey(key);
  const contentType = body ? 'application/octet-stream' : '';

  const configured = String(ossConfig.signatureVersion ?? 'auto');
  const schemes = configured === 'v1' ? ['v1'] : configured === 'v4' ? ['v4'] : ['v4', 'v1'];

  const failures = [];
  for (const scheme of schemes) {
    const credentials = { accessKeyId, accessKeySecret };
    const { headers } =
      scheme === 'v4'
        ? signV4({ method, bucket, canonicalKey, contentType, scope, ...credentials })
        : signV1({ method, bucket, canonicalKey, contentType, ...credentials });

    const response = await fetch(`https://${host}/${canonicalKey}`, { method, headers, body });
    if (response.ok) return response;

    const detail = await response.text().catch(() => '');
    failures.push(
      `${scheme.toUpperCase()} → HTTP ${response.status}` +
        (detail ? ` ${detail.replace(/\s+/g, ' ').slice(0, 200)}` : '')
    );
  }

  throw new Error(`OSS ${method} 失败：${failures.join('  |  ')}`);
}

/**
 * Local destination root. The configured prefix is appended to it, so the
 * default resolves to `<DSH_HOME>/repo-snapshots/<date>/...` instead of
 * repeating "repo-snapshots" twice.
 */
function localRoot(ossConfig) {
  return ossConfig.localDir?.trim() ? ossConfig.localDir.trim() : dshHome();
}

/** Upload one snapshot; returns a human-readable location string. */
async function uploadSnapshot(encPath, keyPath, basePath, ossConfig) {
  if (ossConfig.provider === 'aliyun') {
    await ossRequest(ossConfig, 'PUT', `${basePath}/snapshot.tar.gz.enc`, readFileSync(encPath));
    if (keyPath) {
      await ossRequest(ossConfig, 'PUT', `${basePath}/snapshot.key.enc`, readFileSync(keyPath));
    }
    return `oss://${ossConfig.bucket}/${basePath}/`;
  }

  const targetDir = join(localRoot(ossConfig), basePath);
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(encPath, join(targetDir, 'snapshot.tar.gz.enc'));
  if (keyPath) copyFileSync(keyPath, join(targetDir, 'snapshot.key.enc'));
  return targetDir;
}

/** Probe the configured destination so the UI can say "works" or "broken". */
async function testDestination(ossConfig) {
  if (ossConfig.provider === 'aliyun') {
    const prefix = String(ossConfig.prefix ?? '').replace(/\/?$/, '/');
    const probe = `${prefix}.probe-${Date.now()}`;
    await ossRequest(ossConfig, 'PUT', probe, Buffer.from('ok'));
    await ossRequest(ossConfig, 'DELETE', probe);
    return `连接成功：oss://${ossConfig.bucket}/${prefix}`;
  }
  const root = localRoot(ossConfig);
  mkdirSync(root, { recursive: true });
  const probe = join(root, `.probe-${Date.now()}`);
  writeFileSync(probe, 'ok');
  rmSync(probe, { force: true });
  return `本地目录可写：${root}`;
}

// ── Snapshot pipeline ───────────────────────────────────────────────────────────

async function runSnapshot(workspacePath, sessionId, config, logger) {
  const snapshotId = `snap_${Date.now()}`;
  const scanConfig = config.scan ?? {};
  const encryptionConfig = config.encryption ?? { enabled: true };
  const ossConfig = config.oss ?? { provider: 'local' };

  const { files, stats, skipped, totalBytes } = scanFiles(workspacePath, scanConfig);
  if (files.length === 0) {
    logger.info('repo-snapshot: nothing to back up');
    return null;
  }

  const manifest = {
    format: 'repo-snapshot/v1',
    timestamp: new Date().toISOString(),
    workspacePath,
    sessionId,
    snapshotId,
    fileCount: files.length,
    totalBytes,
    skipped,
    files: stats,
  };

  const { tarPath, tmpDir } = await createArchive(workspacePath, files, manifest);
  try {
    const { encPath, keyPath, algorithm } = encryptArchive(
      tarPath,
      tmpDir,
      snapshotId,
      encryptionConfig
    );
    const dateStr = new Date().toISOString().slice(0, 10);
    const prefix = (ossConfig.prefix || '').replace(/\/?$/, '/');
    const basePath = `${prefix}${dateStr}/${sessionId}/${snapshotId}`;

    const location = await uploadSnapshot(encPath, keyPath, basePath, ossConfig);

    logger.info(
      `repo-snapshot: ${snapshotId} → ${location} (${files.length} files, ${algorithm})`
    );
    return { snapshotId, fileCount: files.length, skipped, location, totalBytes, algorithm };
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

// ── HTTP routes (consumed by the client half) ───────────────────────────────────

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolvePromise) => {
    const chunks = [];
    req.on?.('data', (chunk) => chunks.push(chunk));
    req.on?.('end', () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolvePromise(value && typeof value === 'object' ? value : {});
      } catch {
        resolvePromise({});
      }
    });
    req.on?.('error', () => resolvePromise({}));
  });
}

function methodOf(req) {
  return typeof req.method === 'string' ? req.method.toUpperCase() : 'GET';
}

/** Never echo secrets back to the browser. */
function publicSettings(config) {
  const oss = config.oss ?? {};
  return {
    enabled: config.enabled !== false,
    provider: oss.provider ?? 'local',
    region: oss.region ?? '',
    bucket: oss.bucket ?? '',
    accessKeyId: oss.accessKeyId ?? '',
    hasAccessKeySecret: Boolean(
      oss.accessKeySecret || process.env.ALIYUN_OSS_ACCESS_KEY_SECRET
    ),
    prefix: oss.prefix ?? 'repo-snapshots/',
    localDir: oss.localDir ?? '',
    effectiveLocalDir: localRoot(oss),
    encryptionEnabled: config.encryption?.enabled !== false,
    algorithm: config.encryption?.algorithm ?? 'aes-256-gcm',
    includeGit: config.scan?.includeGit !== false,
    maxFileSizeMB: config.scan?.maxFileSizeMB ?? 5,
    excludeSensitiveFiles: config.scan?.excludeSensitiveFiles !== false,
    trigger: config.trigger ?? 'session-start',
    dedupe: config.dedupe !== false,
    maxSnapshotsPerSession: config.maxSnapshotsPerSession ?? 5,
    injectStatusMessage: config.injectStatusMessage !== false,
  };
}

/**
 * Register the plugin's HTTP surface.
 * Returns a disposer list so the routes die with the plugin fiber.
 */
function registerRoutes(webServer, state, cordisConfig, logger) {
  const disposers = [];

  const reg = (route) => {
    const dispose = webServer.register(route);
    if (typeof dispose === 'function') disposers.push(dispose);
  };

  const config = () => effectiveConfig(cordisConfig);

  reg({
    kind: 'exact',
    path: '/plugins/repo-snapshot/status',
    handler: (_req, res) => {
      try {
        const cfg = config();
        const keys = ensureKeyPair();
        sendJson(res, 200, {
          ok: true,
          plugin: 'dsh-plugin-repo-snapshot',
          home: dshHome(),
          storeDir: storeDir(),
          settingsFile: settingsFilePath(),
          publicKeyPath: publicKeyPath(),
          privateKeyPath: privateKeyPath(),
          keyFingerprint: publicKeyFingerprint(),
          keyCreatedNow: keys.created,
          settings: publicSettings(cfg),
          lastSnapshot: state.lastSnapshot,
          snapshotCount: state.snapshotCount,
          lastWorkspacePath: state.lastWorkspacePath,
          lastError: state.lastError,
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  reg({
    kind: 'exact',
    path: '/plugins/repo-snapshot/settings',
    handler: (req, res) => {
      (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'POST only' });
          return;
        }
        try {
          const body = await readBody(req);
          const patch = body.settings && typeof body.settings === 'object' ? body.settings : body;
          const next = readSettings();
          const flat = flatten(next);

          const blocked = [];
          for (const [key, value] of Object.entries(flatten(patch))) {
            // Accept either a flat UI field name or a dotted config path.
            const path = UI_FIELD_PATHS[key] ?? (SETTABLE_PATH_SET.has(key) ? key : null);
            if (path === null) {
              blocked.push(key);
              continue;
            }
            // An empty secret means "keep the stored one".
            if (path === 'oss.accessKeySecret' && (value === '' || value === null)) continue;
            flat[path] = value;
          }

          // Rebuild the nested object from the flat map.
          const rebuilt = {};
          for (const [key, value] of Object.entries(flat)) {
            const parts = key.split('.');
            let cursor = rebuilt;
            for (let i = 0; i < parts.length - 1; i += 1) {
              cursor[parts[i]] = cursor[parts[i]] ?? {};
              cursor = cursor[parts[i]];
            }
            cursor[parts[parts.length - 1]] = value;
          }

          writeSettings(rebuilt);
          logger.info('repo-snapshot: settings saved');
          sendJson(res, 200, {
            ok: true,
            ignored: blocked,
            settings: publicSettings(config()),
          });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      })();
    },
  });

  reg({
    kind: 'exact',
    path: '/plugins/repo-snapshot/test',
    handler: (req, res) => {
      (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'POST only' });
          return;
        }
        try {
          const cfg = config();
          const message = await testDestination(cfg.oss ?? {});
          sendJson(res, 200, { ok: true, message });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      })();
    },
  });

  reg({
    kind: 'exact',
    path: '/plugins/repo-snapshot/backup-now',
    handler: (req, res) => {
      (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'POST only' });
          return;
        }
        try {
          const body = await readBody(req);
          const cfg = config();
          const workspacePath =
            (typeof body.workspacePath === 'string' && body.workspacePath.trim()) ||
            state.lastWorkspacePath;
          if (!workspacePath) {
            sendJson(res, 200, {
              ok: false,
              error: '还没有已知的工作区路径：先在一个会话里发一条消息，或在下方填写工作区路径',
            });
            return;
          }
          if (!existsSync(workspacePath)) {
            sendJson(res, 200, { ok: false, error: `工作区不存在：${workspacePath}` });
            return;
          }
          const result = await runSnapshot(
            workspacePath,
            'manual',
            cfg,
            logger
          );
          if (result) {
            state.lastSnapshot = { ...result, at: new Date().toISOString() };
            state.snapshotCount += 1;
            state.lastWorkspacePath = workspacePath;
            state.lastError = null;
          }
          sendJson(res, 200, { ok: Boolean(result), result });
        } catch (error) {
          state.lastError = String(error?.message ?? error);
          sendJson(res, 200, { ok: false, error: state.lastError });
        }
      })();
    },
  });

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
  };
}

// ── Plugin entry point ──────────────────────────────────────────────────────────

export function apply(ctx, cordisConfig) {
  const logger = ctx.logger ?? console;
  const sessionCounts = new Map();
  const sessionSignatures = new Map();

  const state = {
    lastSnapshot: null,
    snapshotCount: 0,
    lastWorkspacePath: null,
    lastError: null,
  };

  // The web server mounts later in the boot order than this plugin, so wait for
  // the service instead of probing for it now: a stale `ctx.get('webServer')`
  // returns undefined and the routes are never registered, which leaves the
  // settings page talking to a 404.
  ctx.inject(['webServer'], (sub) => {
    const webServer = sub.get('webServer');
    if (!webServer || typeof webServer.register !== 'function') return;
    logger.info('repo-snapshot: HTTP routes registered');
    return registerRoutes(webServer, state, cordisConfig, logger);
  });

  async function doSnapshot(agent, reason) {
    const session = agent?.session;
    const sessionId = session?.header?.id ?? 'unknown';
    const workspacePath = session?.header?.cwd;

    if (!workspacePath) return;

    const cfg = effectiveConfig(cordisConfig);
    if (cfg.enabled === false) return;
    if (cfg.trigger === 'manual') return;

    const count = sessionCounts.get(sessionId) ?? 0;
    if (count >= (cfg.maxSnapshotsPerSession ?? 5)) return;

    try {
      const scanConfig = cfg.scan ?? {};
      const { stats } = scanFiles(workspacePath, scanConfig);
      const signature = workspaceSignature(stats);

      if (cfg.dedupe !== false && sessionSignatures.get(sessionId) === signature) {
        logger.info(`repo-snapshot: ${reason} — workspace unchanged, skipping`);
        return;
      }

      const result = await runSnapshot(workspacePath, sessionId, cfg, logger);
      if (!result) return;

      sessionCounts.set(sessionId, count + 1);
      sessionSignatures.set(sessionId, signature);
      state.lastSnapshot = { ...result, at: new Date().toISOString() };
      state.snapshotCount += 1;
      state.lastWorkspacePath = workspacePath;
      state.lastError = null;

      if (cfg.injectStatusMessage !== false && typeof agent.inject === 'function') {
        const skipped = result.skipped ?? {};
        const skippedTotal =
          (skipped.excluded ?? 0) +
          (skipped.sensitive ?? 0) +
          (skipped.tooLarge ?? 0) +
          (skipped.unreadable ?? 0);
        agent.inject(
          createUserMessage({
            content: [
              {
                type: 'text',
                text:
                  `[repo-snapshot] 已创建加密快照 ${result.snapshotId}：` +
                  `${result.fileCount} 个文件（${(result.totalBytes / 1024).toFixed(1)} KiB），` +
                  `跳过 ${skippedTotal} 个（敏感 ${skipped.sensitive ?? 0} / 过大 ${skipped.tooLarge ?? 0} / 排除 ${skipped.excluded ?? 0}）。` +
                  `目标：${result.location}`,
              },
            ],
            source: { kind: 'plugin', plugin: 'repo-snapshot' },
          })
        );
      }
    } catch (error) {
      state.lastError = String(error?.message ?? error);
      logger.warn(`repo-snapshot: ${reason} snapshot failed: ${state.lastError}`);
    }
  }

  const trigger = cordisConfig?.trigger ?? 'session-start';

  if (trigger === 'session-start' || trigger === 'both') {
    ctx.on('agent/session-start', (payload) => {
      const agent = payload?.agent;
      if (!agent) return;
      doSnapshot(agent, 'session-start').catch(() => {});
    });
  }

  if (trigger === 'pre-step' || trigger === 'both') {
    ctx.on('agent/pre-step', (payload, next) => {
      const agent = payload?.agent;
      const step = payload?.step;
      if (agent && step === 1) {
        doSnapshot(agent, 'pre-step').catch(() => {});
      }
      return typeof next === 'function' ? next() : undefined;
    });
  }

  ctx.on('dispose', () => {
    sessionCounts.clear();
    sessionSignatures.clear();
  });
}
