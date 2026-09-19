# dsh-plugin-repo-snapshot

English | [简体中文](README.md)

Encrypted workspace snapshot backup for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (DSH).

Packs the current project (including `.git`), encrypts it, and stores it somewhere **you** control: a local folder or **your own** Aliyun OSS bucket. The decryption key never leaves your machine. Everything is configured from a settings page, and the whole thing can be switched off.

---

## Why this exists

Having an AI coding tool send your workspace to the cloud can be genuinely useful — conversation-level rollback, cross-device restore. The question is **how** it is done:

| | Silent uploader | This plugin |
|---|---|---|
| Tells you | No | Settings page shows the destination |
| Can be turned off | No | One toggle |
| Who holds the key | The vendor — you cannot decrypt | **Your local key**; the vendor cannot |
| Sensitive files | Packed anyway (even whitelisting `.git`) | Blocked by default, and the count is **reported** |
| Where the data goes | Vendor servers | Your folder / your bucket |
| What was sent | Invisible | Every snapshot reports file and skip counts |

The point is not *whether* data is sent, but **who ends up in control of it**.

---

## Features

- **Encrypted snapshots** — AES-256-GCM archive; the AES key is wrapped with a local RSA-4096 public key (RSA-OAEP-SHA256)
- **Two destinations** — a local folder, or Aliyun OSS with no SDK dependency (official V4/V1 header signatures over Node's built-in `fetch`)
- **Settings UI** — a "仓库快照备份" (Repo snapshot backup) section inside DSH settings: toggle, OSS fields, test connection, back up now
- **Sensitive-file blocking** — `*.pem` / `*.key` / `id_rsa` / `*_rsa` / `.env` / `.npmrc` / `.git-credentials` / `.ssh` and more
- **Skips are reported** — sensitive, oversized and excluded files are counted and surfaced in the conversation
- **Skips unchanged content** — avoids re-uploading an identical workspace
- **Optional `.git`** — keep full history, or turn it off

---

## Install

### From npm / GitHub

```bash
dsh plugin --profile web add dsh-plugin-repo-snapshot
```

The package declares `dsh.bundle.patch`, so installing it inserts the plugin row into the composition automatically — no manual config edit.

### From a local directory (development)

```bash
cd <your DSH profile dir>          # e.g. ~/.dsh/profiles/web
pnpm add link:/path/to/dsh-plugin-repo-snapshot
```

Then mount it in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: repo-snapshot
      name: dsh-plugin-repo-snapshot
```

> **You must restart `dsh web` after any change.** The host half is an ESM module and the client bundle is loaded only at startup; live patch reload does not re-import them.

### Dependencies

Only `archiver` (for packing). OSS uploads are signed with `node:crypto` and sent with Node's built-in `fetch`, so there is no `ali-oss` dependency.

```bash
npm install
```

---

## Usage

After restarting, open **Settings → 仓库快照备份**.

1. **启用 (Enabled)** decides whether snapshots are taken at all
2. **存储位置 (Destination)** — pick 本机目录 (local folder) or 阿里云 OSS
   - For OSS, fill in `Region` (e.g. `oss-cn-hangzhou`), `Bucket`, `AccessKey ID`, `AccessKey Secret`
   - Use a **RAM sub-account scoped to that bucket only**
3. Click **保存并测试连接 (Save and test connection)** — this writes and deletes a probe object at the destination
4. Click **立即备份一次 (Back up now)**, or let it run automatically when a session starts

### Aliyun OSS notes

- Keep permissions minimal: only `PutObject` / `DeleteObject` on the target bucket
- Want the secret off disk? Leave AK/SK blank in the settings page and use environment variables instead:

  ```bash
  export ALIYUN_OSS_ACCESS_KEY_ID=LTAI...
  export ALIYUN_OSS_ACCESS_KEY_SECRET=...
  ```

---

## What a snapshot looks like

```
<destination>/<prefix>/<date>/<sessionId>/<snap_...>/
├── snapshot.tar.gz.enc    # the encrypted archive
└── snapshot.key.enc       # the AES key, wrapped with your public key
```

Inside the archive:

```
manifest.json              # timestamp, workspace, file list, skip counts
files/<original relative path>
```

### Encryption format

```
"RSNAP2" | alg(1B) | ivLen(1B) | IV | tagLen(2B, BE) | tag | ciphertext
```

- Algorithm `1` = AES-256-GCM (default, authenticated), `2` = AES-256-CTR
- The AES key is random, wrapped with `<DSH_HOME>/repo-snapshot/keys/public.pem`
- **The private key stays local**: `<DSH_HOME>/repo-snapshot/keys/private.pem`

---

## Restore

Fetch `snapshot.tar.gz.enc` and `snapshot.key.enc` for the snapshot you want, then:

```bash
node scripts/decrypt.mjs \
  --input  snapshot.tar.gz.enc \
  --key    snapshot.key.enc \
  --private-key ~/.dsh/repo-snapshot/keys/private.pem \
  --output ./restored
```

On Windows the private key defaults to `C:\Users\<you>\.dsh\repo-snapshot\keys\private.pem`.

The script also reads the legacy v1 layout (AES-256-CTR, 16-byte IV prefix).

> ⚠️ Lose `private.pem` and the snapshots are **gone**. That is by design — there is no backdoor.

---

## Configuration reference

The settings page writes `<DSH_HOME>/repo-snapshot/settings.json`, which **takes precedence over** `cordis.patch.yml`.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `oss.provider` | `local` | `local` / `aliyun` |
| `oss.region` | — | e.g. `oss-cn-hangzhou` |
| `oss.bucket` | — | bucket name |
| `oss.prefix` | `repo-snapshots/` | object key prefix |
| `oss.signatureVersion` | `auto` | OSS signing scheme: `auto` (V4, then V1) / `v4` / `v1` |
| `oss.localDir` | `<DSH_HOME>` | root folder in local mode; the prefix is appended to it |
| `encryption.enabled` | `true` | encrypt at all |
| `encryption.algorithm` | `aes-256-gcm` | `aes-256-gcm` / `aes-256-ctr` |
| `scan.includeGit` | `true` | include `.git` |
| `scan.excludePatterns` | `node_modules`, `dist`, `.venv`, … | a bare directory name matches at any depth |
| `scan.maxFileSizeMB` | `5` | per-file cap; larger files are skipped and counted |
| `scan.excludeSensitiveFiles` | `true` | sensitive-file blocking |
| `trigger` | `session-start` | `session-start` / `pre-step` / `both` / `manual` |
| `dedupe` | `true` | skip when content is unchanged |
| `maxSnapshotsPerSession` | `5` | runaway guard |
| `injectStatusMessage` | `true` | report snapshot results in the conversation |

### HTTP routes

The host registers four routes, used by the settings page and scriptable:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/plugins/repo-snapshot/status` | current config (secret redacted), key fingerprint, last snapshot |
| `POST` | `/plugins/repo-snapshot/settings` | save settings; accepts flat UI names or dotted paths |
| `POST` | `/plugins/repo-snapshot/test` | probe the destination |
| `POST` | `/plugins/repo-snapshot/backup-now` | take a snapshot now; optional `workspacePath` |

---

## Development

```bash
npm install
node --check lib/index.js     # host half
node --check lib/client.js    # client half
npm run keygen                # optional: pre-generate the keypair
```

Layout:

```
lib/index.js      # host: scan / archive / encrypt / upload / HTTP routes
lib/client.js     # browser: the settings.section UI
cordis.patch.yml  # bundle patch declaring the plugin row
scripts/          # keygen / decrypt
```

The client bundle follows DSH's `window.__ModuleLoader__.load({ id, factory })` contract, so it is plain JavaScript — **no bundler required**.

---

## Troubleshooting

**OSS returns a signature error / 403**

The default is `signatureVersion: auto`: sign with **V4 (OSS4-HMAC-SHA256)** first, fall back to **V1**. When both fail, the error lists each attempt's HTTP status and the server response so you can tell them apart.

- To pin a scheme, set it in `settings.json`:
  ```json
  { "oss": { "signatureVersion": "v4" } }
  ```
- The V4 credential scope uses the region **without** the `oss-` prefix (`oss-cn-hangzhou` → `cn-hangzhou`); the plugin converts it for you
- A 403 can also mean the RAM policy is too narrow: you need `PutObject` and `DeleteObject` on the target bucket

**The "仓库快照备份" section is missing from Settings**

The client bundle is loaded only when `dsh web` starts, so restart after changing the plugin. Also confirm the plugin row is mounted in the profile's `cordis.patch.yml`.

**Snapshots still go to the old destination after a restart**

Precedence is `settings.json` > `cordis.patch.yml`. Check `<DSH_HOME>/repo-snapshot/settings.json` for a stale value.

## Known limitations

- Files above `maxFileSizeMB` are skipped (with a count); large Git pack files can be missed — raise the limit if needed
- There is no "download from OSS and restore in one step" script yet; fetch the two files via the console or `ossutil`, then run `decrypt.mjs`
- The UI depends on DSH's `settings.section` slot and may need adapting across major DSH versions
- Snapshots are **full**, not incremental — each one repacks the whole workspace

## License

MIT
