/**
 * dsh-plugin-repo-snapshot — Client half.
 *
 * Registers a "仓库快照备份" section in the DSH settings page. The section lets
 * the user switch the plugin on/off, point it at a destination (local folder or
 * their own Aliyun OSS bucket), test the destination, and take a backup on
 * demand.
 *
 * Loaded by the DSH client module system; the bundle format is the
 * `window.__ModuleLoader__.load({ id, factory })` contract, and React is
 * obtained through the injected `require`.
 */

window.__ModuleLoader__.load({
	id: 'dsh-plugin-repo-snapshot',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const { createElement: h, useState, useEffect } = require('react');

		const name = 'dsh-plugin-repo-snapshot-client';
		const inject = ['slots'];

		const win = globalThis;
		const base = win.location?.origin ?? '';
		const API = `${base}/plugins/repo-snapshot`;

		// ── Host calls ──────────────────────────────────────────────────────────

		async function call(path, body) {
			const init = body === undefined
				? { method: 'GET' }
				: {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(body),
					};
			const res = await win.fetch?.(API + path, init);
			if (!res) return { ok: false, error: '无法连接宿主：fetch 不可用' };
			try {
				return await res.json();
			} catch {
				return { ok: false, error: `宿主返回了非 JSON 响应（HTTP ${res.status}）` };
			}
		}

		// ── Styles ──────────────────────────────────────────────────────────────

		const S = {
			wrap: { display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '720px' },
			card: {
				border: '1px solid rgba(127,127,127,0.28)',
				borderRadius: '10px',
				padding: '16px',
				display: 'flex',
				flexDirection: 'column',
				gap: '12px',
			},
			title: { fontSize: '14px', fontWeight: 600, margin: 0 },
			desc: { fontSize: '12px', opacity: 0.7, lineHeight: 1.6, margin: 0 },
			row: { display: 'grid', gridTemplateColumns: '150px 1fr', gap: '10px', alignItems: 'center' },
			label: { fontSize: '13px', opacity: 0.8 },
			input: {
				width: '100%',
				boxSizing: 'border-box',
				padding: '7px 9px',
				fontSize: '13px',
				fontFamily: 'inherit',
				color: 'inherit',
				background: 'rgba(127,127,127,0.12)',
				border: '1px solid rgba(127,127,127,0.32)',
				borderRadius: '7px',
				outline: 'none',
			},
			select: {
				padding: '7px 9px',
				fontSize: '13px',
				fontFamily: 'inherit',
				color: 'inherit',
				background: 'rgba(127,127,127,0.12)',
				border: '1px solid rgba(127,127,127,0.32)',
				borderRadius: '7px',
			},
			actions: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' },
			primary: {
				padding: '7px 14px',
				fontSize: '13px',
				fontFamily: 'inherit',
				fontWeight: 500,
				color: '#fff',
				background: '#3b82f6',
				border: 'none',
				borderRadius: '7px',
				cursor: 'pointer',
			},
			secondary: {
				padding: '7px 14px',
				fontSize: '13px',
				fontFamily: 'inherit',
				color: 'inherit',
				background: 'rgba(127,127,127,0.18)',
				border: '1px solid rgba(127,127,127,0.32)',
				borderRadius: '7px',
				cursor: 'pointer',
			},
			mono: {
				fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
				fontSize: '12px',
				wordBreak: 'break-all',
				opacity: 0.85,
			},
			note: {
				fontSize: '12px',
				lineHeight: 1.6,
				padding: '9px 11px',
				borderRadius: '7px',
				background: 'rgba(127,127,127,0.12)',
			},
			good: { fontSize: '12px', color: '#16a34a', lineHeight: 1.6 },
			bad: { fontSize: '12px', color: '#dc2626', lineHeight: 1.6 },
			warn: { fontSize: '12px', color: '#d97706', lineHeight: 1.6 },
		};

		// ── Small building blocks ───────────────────────────────────────────────

		function Field({ label, hint, children }) {
			return h(
				'label',
				{ style: S.row },
				h('span', { style: S.label }, label),
				h('span', null, children, hint ? h('div', { style: S.desc }, hint) : null)
			);
		}

		function Toggle({ label, checked, onChange }) {
			return h(
				'label',
				{ style: { ...S.row, cursor: 'pointer' } },
				h('span', { style: S.label }, label),
				h('input', {
					type: 'checkbox',
					checked: Boolean(checked),
					onChange: (event) => onChange(event.target.checked),
					style: { width: '15px', height: '15px', cursor: 'pointer' },
				})
			);
		}

		// ── The settings section ────────────────────────────────────────────────

		function RepoSnapshotSection() {
			const [status, setStatus] = useState(null);
			const [form, setForm] = useState(null);
			const [secret, setSecret] = useState('');
			const [manualPath, setManualPath] = useState('');
			const [busy, setBusy] = useState('');
			const [msg, setMsg] = useState(null);
			const [error, setError] = useState(null);

			async function refresh() {
				const res = await call('/status');
				if (!res?.ok) {
					setError(res?.error ?? '读取状态失败');
					return;
				}
				setError(null);
				setStatus(res);
				setForm((prev) => prev ?? { ...res.settings });
				setManualPath((prev) => prev || res.lastWorkspacePath || '');
			}

			useEffect(() => {
				refresh();
			}, []);

			function set(key, value) {
				setForm((prev) => ({ ...(prev ?? {}), [key]: value }));
			}

			function payload() {
				const body = { ...(form ?? {}) };
				// Only send a secret when the user actually typed a new one.
				if (secret.trim() !== '') body.accessKeySecret = secret.trim();
				else delete body.accessKeySecret;
				// UI-only fields the host must not persist.
				delete body.effectiveLocalDir;
				delete body.hasAccessKeySecret;
				return body;
			}

			async function save() {
				setBusy('save');
				setMsg(null);
				const res = await call('/settings', { settings: payload() });
				setBusy('');
				if (!res?.ok) {
					setMsg({ kind: 'bad', text: res?.error ?? '保存失败' });
					return null;
				}
				setForm({ ...res.settings });
				setSecret('');
				setStatus((prev) => (prev ? { ...prev, settings: res.settings } : prev));
				setMsg({ kind: 'good', text: '设置已保存' });
				return res;
			}

			async function saveAndTest() {
				const saved = await save();
				if (!saved) return;
				setBusy('test');
				const res = await call('/test', {});
				setBusy('');
				setMsg(
					res?.ok
						? { kind: 'good', text: res.message }
						: { kind: 'bad', text: res?.error ?? '连接测试失败' }
				);
			}

			async function backupNow() {
				setBusy('backup');
				setMsg(null);
				const res = await call('/backup-now', { workspacePath: manualPath.trim() });
				setBusy('');
				if (res?.ok && res.result) {
					setMsg({
						kind: 'good',
						text: `备份完成：${res.result.fileCount} 个文件 → ${res.result.location}`,
					});
				} else {
					setMsg({ kind: 'bad', text: res?.error ?? '备份失败' });
				}
				await refresh();
			}

			if (error) {
				return h('div', { style: S.wrap }, h('div', { style: S.bad }, error));
			}
			if (!form || !status) {
				return h('div', { style: S.wrap }, h('div', { style: S.desc }, '加载中…'));
			}

			const isAliyun = form.provider === 'aliyun';
			const aliyunIncomplete =
				isAliyun && (!form.bucket || !form.region || (!form.accessKeyId && !status.settings.hasAccessKeySecret));

			const message = msg
				? h('div', { style: msg.kind === 'good' ? S.good : S.bad }, msg.text)
				: null;

			// ── Enable / disable ─────────────────────────────────────────────────
			const enableCard = h(
				'div',
				{ style: S.card },
				h('h3', { style: S.title }, '仓库快照备份'),
				h(
					'p',
					{ style: S.desc },
					'把当前工作区（含 .git）打包加密后，存到你自己的目录或阿里云 OSS。' +
						'加密私钥只保存在本机，永远不会上传。'
				),
				h(Toggle, {
					label: '启用',
					checked: form.enabled,
					onChange: (value) => set('enabled', value),
				}),
				!form.enabled
					? h('div', { style: S.warn }, '已关闭：不会再创建或上传任何快照。')
					: null
			);

			// ── Destination ─────────────────────────────────────────────────────
			const destCard = h(
				'div',
				{ style: S.card },
				h('h3', { style: S.title }, '存储位置'),
				h(
					Field,
					{ label: '类型' },
					h(
						'select',
						{
							style: S.select,
							value: form.provider,
							onChange: (event) => set('provider', event.target.value),
						},
						h('option', { value: 'local' }, '本机目录'),
						h('option', { value: 'aliyun' }, '阿里云 OSS')
					)
				),

				isAliyun
					? h(
							'div',
							{ style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
							h(
								Field,
								{ label: 'Region', hint: '例如 oss-cn-hangzhou / oss-cn-beijing' },
								h('input', {
									style: S.input,
									value: form.region ?? '',
									placeholder: 'oss-cn-hangzhou',
									onChange: (event) => set('region', event.target.value),
								})
							),
							h(
								Field,
								{ label: 'Bucket' },
								h('input', {
									style: S.input,
									value: form.bucket ?? '',
									placeholder: 'my-backup-bucket',
									onChange: (event) => set('bucket', event.target.value),
								})
							),
							h(
								Field,
								{ label: 'AccessKey ID' },
								h('input', {
									style: S.input,
									value: form.accessKeyId ?? '',
									placeholder: 'LTAI...',
									onChange: (event) => set('accessKeyId', event.target.value),
								})
							),
							h(
								Field,
								{
									label: 'AccessKey Secret',
									hint: status.settings.hasAccessKeySecret
										? '已保存。留空表示不修改。'
										: '建议使用只有该 bucket 写权限的 RAM 子账号。',
								},
								h('input', {
									type: 'password',
									style: S.input,
									value: secret,
									placeholder: status.settings.hasAccessKeySecret ? '••••••••（留空不修改）' : '',
									onChange: (event) => setSecret(event.target.value),
								})
							)
						)
					: h(
							Field,
							{ label: '目录', hint: `当前生效：${status.settings.effectiveLocalDir}` },
							h('input', {
								style: S.input,
								value: form.localDir ?? '',
								placeholder: status.settings.effectiveLocalDir,
								onChange: (event) => set('localDir', event.target.value),
							})
						),

				h(
					Field,
					{ label: '路径前缀', hint: '快照最终路径 = 前缀 + 日期/会话/快照ID' },
					h('input', {
						style: S.input,
						value: form.prefix ?? '',
						onChange: (event) => set('prefix', event.target.value),
					})
				),

				aliyunIncomplete
					? h('div', { style: S.warn }, '阿里云 OSS 还缺少 Region / Bucket / AccessKey，保存后仍无法上传。')
					: null,
				message
			);

			// ── Advanced ────────────────────────────────────────────────────────
			const advancedCard = h(
				'div',
				{ style: S.card },
				h('h3', { style: S.title }, '备份范围与时机'),
				h(Toggle, {
					label: '包含 .git',
					checked: form.includeGit,
					onChange: (value) => set('includeGit', value),
				}),
				h(Toggle, {
					label: '排除敏感文件',
					checked: form.excludeSensitiveFiles,
					onChange: (value) => set('excludeSensitiveFiles', value),
				}),
				h(Toggle, {
					label: '内容未变时跳过',
					checked: form.dedupe,
					onChange: (value) => set('dedupe', value),
				}),
				h(Toggle, {
					label: '在对话中提示',
					checked: form.injectStatusMessage,
					onChange: (value) => set('injectStatusMessage', value),
				}),
				h(
					Field,
					{ label: '触发时机' },
					h(
						'select',
						{
							style: S.select,
							value: form.trigger,
							onChange: (event) => set('trigger', event.target.value),
						},
						h('option', { value: 'session-start' }, '每次会话开始'),
						h('option', { value: 'pre-step' }, '每轮对话开始'),
						h('option', { value: 'both' }, '两者都要'),
						h('option', { value: 'manual' }, '仅手动')
					)
				),
				h(
					Field,
					{ label: '单文件上限 (MB)', hint: '超过该大小的文件会被跳过，并在结果中计数。' },
					h('input', {
						type: 'number',
						min: '1',
						style: S.input,
						value: form.maxFileSizeMB ?? 5,
						onChange: (event) => set('maxFileSizeMB', Number(event.target.value) || 1),
					})
				),
				h(
					Field,
					{ label: '每会话上限' },
					h('input', {
						type: 'number',
						min: '1',
						style: S.input,
						value: form.maxSnapshotsPerSession ?? 5,
						onChange: (event) =>
							set('maxSnapshotsPerSession', Number(event.target.value) || 1),
					})
				)
			);

			// ── Actions ─────────────────────────────────────────────────────────
			const actionCard = h(
				'div',
				{ style: S.card },
				h(
					'div',
					{ style: S.actions },
					h(
						'button',
						{ style: S.primary, disabled: busy !== '', onClick: save },
						busy === 'save' ? '保存中…' : '保存设置'
					),
					h(
						'button',
						{ style: S.secondary, disabled: busy !== '', onClick: saveAndTest },
						busy === 'test' ? '测试中…' : '保存并测试连接'
					)
				),
				h(
					Field,
					{ label: '工作区路径', hint: '留空则使用最近一次会话的工作区。' },
					h('input', {
						style: S.input,
						value: manualPath,
						placeholder: status.lastWorkspacePath ?? 'D:\\path\\to\\project',
						onChange: (event) => setManualPath(event.target.value),
					})
				),
				h(
					'div',
					{ style: S.actions },
					h(
						'button',
						{ style: S.secondary, disabled: busy !== '', onClick: backupNow },
						busy === 'backup' ? '备份中…' : '立即备份一次'
					),
					h(
						'button',
						{ style: S.secondary, disabled: busy !== '', onClick: refresh },
						'刷新状态'
					)
				)
			);

			// ── Status / recovery ───────────────────────────────────────────────
			const last = status.lastSnapshot;
			const statusCard = h(
				'div',
				{ style: S.card },
				h('h3', { style: S.title }, '状态与恢复'),
				h(
					'div',
					{ style: S.note },
					h('div', null, `快照总数：${status.snapshotCount}`),
					h('div', null, `最近工作区：${status.lastWorkspacePath ?? '—'}`),
					last
						? h(
								'div',
								null,
								`最近快照：${last.snapshotId} · ${last.fileCount} 个文件 · ${last.location}`
							)
						: h('div', null, '最近快照：—'),
					h('div', null, `公钥指纹：${status.keyFingerprint ?? '—'}`),
					h('div', { style: S.mono }, `设置文件：${status.settingsFile}`),
					h('div', { style: S.mono }, `私钥：${status.privateKeyPath}`)
				),
				status.lastError ? h('div', { style: S.bad }, `最近错误：${status.lastError}`) : null,
				h(
					'p',
					{ style: S.desc },
					'恢复方式：下载某次快照的 snapshot.tar.gz.enc 与 snapshot.key.enc，然后用本机私钥解密：'
				),
				h(
					'div',
					{ style: S.mono },
					`node scripts/decrypt.mjs --input snapshot.tar.gz.enc --key snapshot.key.enc --private-key "${status.privateKeyPath}" --output ./restored`
				)
			);

			return h(
				'div',
				{ style: S.wrap },
				enableCard,
				destCard,
				advancedCard,
				actionCard,
				statusCard
			);
		}

		// ── Plugin body ─────────────────────────────────────────────────────────

		function apply(ctx) {
			ctx.slots.inject('settings.section', () => {
				return ctx.slots.register(
					{
						name: 'settings.section',
						id: 'repo-snapshot',
						order: 30,
						label: '仓库快照备份',
					},
					RepoSnapshotSection
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	},
});
