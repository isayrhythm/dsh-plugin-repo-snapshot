# dsh-plugin-repo-snapshot

[English](README.en.md) | 简体中文

给 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（DSH）用的**工作区加密快照备份**插件。

把当前项目（含 `.git`）打包、加密，然后存到**你自己的**目录或**你自己的**阿里云 OSS 里。解密私钥只留在本机，任何时候都不上传。设置页里可视化配置，可随时开关。

---

## 为什么需要它

AI 编程工具把工作区内容传到云端，这件事本身可以是有价值的（对话级回退、跨设备恢复）。问题在于**怎么做**：

| | 静默上传 | 本插件 |
|---|---|---|
| 是否告知 | 不告知 | 设置页明确展示目标位置 |
| 是否可关闭 | 无法关闭 | 一键开关 |
| 加密密钥归属 | 服务端持有，用户无法解密 | **本机私钥**，服务端拿不到 |
| 敏感文件 | 照样打包（甚至给 `.git` 开绿灯放行） | 默认拦截，并**报告拦截数量** |
| 数据去向 | 厂商服务器 | 你的目录 / 你的 bucket |
| 上传了什么 | 看不到 | 每次快照都提示文件数与跳过数 |

核心区别不是"传不传"，而是**数据最终归谁控制**。

---

## 功能

- **加密快照**：AES-256-GCM 加密归档，AES 密钥用本机 RSA-4096 公钥封装（RSA-OAEP-SHA256）
- **两种目的地**：本机目录 / 阿里云 OSS（零 SDK 依赖，用官方 V1 签名直接 PUT）
- **设置界面**：DSH 设置页内置「仓库快照备份」分区，可开关、填 OSS 参数、测试连接、立即备份
- **敏感文件拦截**：`*.pem` / `*.key` / `id_rsa` / `*_rsa` / `.env` / `.npmrc` / `.git-credentials` / `.ssh` 等
- **跳过即报告**：敏感、超大、被排除的文件都会计数并在对话里说明
- **内容未变则跳过**：避免重复上传相同内容
- **包含 `.git`**：可保留完整提交历史，也可关掉

---

## 安装

### 从 npm / GitHub

```bash
dsh plugin --profile web add dsh-plugin-repo-snapshot
```

包内声明了 `dsh.bundle.patch`，安装时会自动把插件行插入 composition，无需手工改配置。

### 从本地目录（开发）

```bash
cd <你的 DSH profile 目录>          # 例如 ~/.dsh/profiles/web
pnpm add link:/path/to/dsh-plugin-repo-snapshot
```

然后在 profile 的 `cordis.patch.yml` 里挂载：

```yaml
- insert:
    - id: repo-snapshot
      name: dsh-plugin-repo-snapshot
```

> **改完必须重启 `dsh web`**：插件本体是 ESM 模块、客户端 bundle 也只在启动时加载，热重载不会重新导入它们。

### 依赖

只需 `archiver`（打包）；OSS 上传用 Node 内置 `fetch` + `node:crypto` 自行签名，不依赖 `ali-oss`。

```bash
npm install
```

---

## 使用

重启后打开 **设置 → 仓库快照备份**。

1. **启用** 开关决定是否创建快照
2. **存储位置** 选「本机目录」或「阿里云 OSS」
   - 选 OSS 时填 `Region`（如 `oss-cn-hangzhou`）、`Bucket`、`AccessKey ID`、`AccessKey Secret`
   - 建议用**只有该 bucket 写权限的 RAM 子账号**
3. 点 **保存并测试连接** 验证配置（会在目标位置写入并删除一个探针文件）
4. 点 **立即备份一次** 立即生成一份快照；也可等会话开始自动触发

### 阿里云 OSS 建议

- 权限策略最小化：只给目标 bucket 的 `PutObject` / `DeleteObject`
- 想让密钥不落盘？把设置页的 AK/SK 留空，改用环境变量：

  ```bash
  export ALIYUN_OSS_ACCESS_KEY_ID=LTAI...
  export ALIYUN_OSS_ACCESS_KEY_SECRET=...
  ```

---

## 快照长什么样

```
<目的地>/<prefix>/<日期>/<会话ID>/<snap_...>/
├── snapshot.tar.gz.enc    # 加密后的归档
└── snapshot.key.enc       # 被本机公钥封装过的 AES 密钥
```

归档内部：

```
manifest.json              # 时间、工作区、文件清单、跳过统计
files/<原始相对路径>        # 真实文件内容
```

### 加密格式

```
"RSNAP2" | 算法(1B) | IV长度(1B) | IV | 认证标签长度(2B, BE) | 标签 | 密文
```

- 算法 `1` = AES-256-GCM（默认，带完整性校验），`2` = AES-256-CTR
- AES 密钥随机生成，用 `<DSH_HOME>/repo-snapshot/keys/public.pem` 封装
- **私钥只在本机**：`<DSH_HOME>/repo-snapshot/keys/private.pem`

---

## 恢复

从目的地取回某次快照的 `snapshot.tar.gz.enc` 和 `snapshot.key.enc`，然后：

```bash
node scripts/decrypt.mjs \
  --input  snapshot.tar.gz.enc \
  --key    snapshot.key.enc \
  --private-key ~/.dsh/repo-snapshot/keys/private.pem \
  --output ./restored
```

Windows 下私钥默认在 `C:\Users\<你>\.dsh\repo-snapshot\keys\private.pem`。

脚本同时兼容 v1（AES-256-CTR，16 字节 IV 前缀）旧格式。

> ⚠️ 丢了 `private.pem` 就**无法恢复**——这是设计使然，没有任何后门。

---

## 配置参考

设置页写入 `<DSH_HOME>/repo-snapshot/settings.json`，**优先于** `cordis.patch.yml` 里的配置。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `oss.provider` | `local` | `local` / `aliyun` |
| `oss.region` | — | 如 `oss-cn-hangzhou` |
| `oss.bucket` | — | bucket 名 |
| `oss.prefix` | `repo-snapshots/` | 对象键前缀 |
| `oss.signatureVersion` | `auto` | OSS 签名方案：`auto`（先试 V4，失败回退 V1）/ `v4` / `v1` |
| `oss.localDir` | `<DSH_HOME>` | 本机模式根目录；前缀会追加在其后 |
| `encryption.enabled` | `true` | 是否加密 |
| `encryption.algorithm` | `aes-256-gcm` | `aes-256-gcm` / `aes-256-ctr` |
| `scan.includeGit` | `true` | 是否包含 `.git` |
| `scan.excludePatterns` | `node_modules`, `dist`, `.venv`, … | 裸目录名匹配任意层级 |
| `scan.maxFileSizeMB` | `5` | 单文件上限，超限跳过并计数 |
| `scan.excludeSensitiveFiles` | `true` | 敏感文件拦截 |
| `trigger` | `session-start` | `session-start` / `pre-step` / `both` / `manual` |
| `dedupe` | `true` | 内容未变时跳过 |
| `maxSnapshotsPerSession` | `5` | 防止失控 |
| `injectStatusMessage` | `true` | 在对话中提示快照结果 |

### HTTP 接口

宿主注册了四个路由，供设置页调用（也可脚本化）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/plugins/repo-snapshot/status` | 当前配置（密钥已脱敏）、密钥指纹、最近快照 |
| `POST` | `/plugins/repo-snapshot/settings` | 保存设置，接受扁平字段名或点号路径 |
| `POST` | `/plugins/repo-snapshot/test` | 探测目的地是否可用 |
| `POST` | `/plugins/repo-snapshot/backup-now` | 立即备份，可传 `workspacePath` |

---

## 开发

```bash
npm install
node --check lib/index.js     # 宿主半边
node --check lib/client.js    # 客户端半边
npm run keygen                # 可选：预生成密钥对
```

结构：

```
lib/index.js      # 宿主：扫描 / 打包 / 加密 / 上传 / HTTP 路由
lib/client.js     # 浏览器：settings.section 设置界面
cordis.patch.yml  # bundle patch，声明插件行
scripts/          # keygen / decrypt
```

客户端 bundle 遵循 DSH 的 `window.__ModuleLoader__.load({ id, factory })` 约定，直接写纯 JS 即可，**不需要打包器**。

---

## 安全说明

- `private.pem` 与 `settings.json`（可能含 AK/SK）都写在 `<DSH_HOME>/repo-snapshot/`，已在 `.gitignore` 中排除
- 私钥文件权限设为 `0600`
- AK/SK 也可完全走环境变量，不落盘
- 快照**只增不减**：插件不负责删除旧快照，请自行制定保留策略

## 故障排查

**OSS 报签名错误 / 403**

插件默认 `signatureVersion: auto`：先按 **V4（OSS4-HMAC-SHA256）** 签名，失败再回退 **V1**。
两种都失败时，错误信息会同时列出两次尝试的 HTTP 状态与服务端返回，便于定位。

- 若明确知道 bucket 只接受某一种，可在 `settings.json` 里固定：
  ```json
  { "oss": { "signatureVersion": "v4" } }
  ```
- V4 的凭据作用域使用**去掉 `oss-` 前缀**的 region（`oss-cn-hangzhou` → `cn-hangzhou`），插件会自动转换
- 403 也可能是 RAM 权限不足：需要目标 bucket 的 `PutObject` 与 `DeleteObject`

**设置页看不到「仓库快照备份」**

客户端 bundle 只在 `dsh web` 启动时加载，改完插件必须重启；另外确认 profile 的 `cordis.patch.yml` 里已挂载该插件行。

**重启后快照上传到旧位置**

设置优先级是 `settings.json` > `cordis.patch.yml`。检查 `<DSH_HOME>/repo-snapshot/settings.json` 是否残留了旧值。

## 已知限制

- 超过 `maxFileSizeMB` 的文件会被跳过（有计数提示）；大仓库的 Git pack 文件可能被漏掉，必要时调大该值
- 尚未提供「从 OSS 一键下载并恢复」的脚本，目前从控制台或 `ossutil` 取回两个文件后跑 `decrypt.mjs`
- 客户端界面依赖 DSH 的 `settings.section` Slot，DSH 大版本升级后可能需要适配
- 快照是**全量**的，每次都会重新打包整个工作区；增量备份尚未实现

## License

MIT
