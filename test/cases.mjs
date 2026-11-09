/**
 * The two sets of panels the offline renderers page through:
 *
 *   GALLERY   — every widget kind once, in its empty/default state
 *   ANSWERED  — what a panel becomes after the user replied
 *   HISTORY   — the read-only snapshot `interactive_ui_history` leaves behind
 *
 * Shared by `test/preview.mjs` (docs/preview.html) and `test/screenshot.mjs`
 * (docs/preview-baseline/*.png), so the preview page and the screenshot
 * baselines are guaranteed to be looking at the same panels.
 */

/** One `answered · …` card. `open` un-folds `<details>` so the rows are visible. */
export const ANSWERED = [
	{
		name: 'answered · 单选 / 开关 / 滑块 / 备注（折叠态）',
		spec: {
			title: '部署到哪里？',
			elements: [
				{ kind: 'radio', id: 'env', label: '目标环境', options: [{ value: 'staging', label: '预发' }, { value: 'prod', label: '生产', description: '真流量' }] },
				{ kind: 'switch', id: 'keep', label: '保留旧版本' },
				{ kind: 'slider', id: 'replicas', label: '副本数', min: 1, max: 10, step: 1, unit: ' 个' },
				{ kind: 'input', id: 'note', label: '备注' },
			],
		},
		action: 'submit',
		values: { env: 'prod', keep: false, replicas: 7, note: '周五晚上发' },
	},
	{
		name: 'answered · 同一块面板（点开之后）',
		open: true,
		spec: {
			title: '部署到哪里？',
			elements: [
				{ kind: 'radio', id: 'env', label: '目标环境', options: [{ value: 'staging', label: '预发' }, { value: 'prod', label: '生产', description: '真流量' }] },
				{ kind: 'switch', id: 'keep', label: '保留旧版本' },
				{ kind: 'slider', id: 'replicas', label: '副本数', min: 1, max: 10, step: 1, unit: ' 个' },
				{ kind: 'input', id: 'note', label: '备注' },
			],
		},
		action: 'submit',
		values: { env: 'prod', keep: false, replicas: 7, note: '周五晚上发' },
	},
	{
		name: 'answered · 多选 / 树 / 表格',
		open: true,
		spec: {
			title: '这次改哪些？',
			elements: [
				{ kind: 'multiselect', id: 'tags', label: '标签', options: [{ value: 'a', label: '前端' }, { value: 'b', label: '后端' }] },
				{ kind: 'tree', id: 'scope', label: '范围', nodes: [{ id: 'src', label: 'src', children: [{ id: 'src/ui', label: 'ui' }] }] },
				{ kind: 'table', id: 'rows', label: '改动行', row_key: 'k', columns: [{ key: 'k', label: '文件' }], rows: [{ k: 'src/ui/a.ts' }, { k: 'src/ui/b.ts' }], select: 'multi' },
				{ kind: 'textarea', id: 'detail', label: '说明' },
			],
		},
		action: 'submit',
		values: { tags: ['b'], scope: ['src/ui'], rows: ['src/ui/b.ts'], detail: '第一行\n第二行' },
	},
	{
		name: 'answered · 表单 + 上传',
		open: true,
		spec: {
			title: '提交工单',
			elements: [
				{ kind: 'form', id: 'card', label: '工单', fields: [{ id: 'name', label: '标题', required: true }, { id: 'qty', label: '数量', type: 'number' }] },
				{ kind: 'upload', id: 'files', label: '附件', multiple: true },
				{ kind: 'path', id: 'dir', label: '输出目录' },
			],
		},
		action: 'submit',
		values: { card: { name: '登录 500', qty: 3 }, files: [{ name: 'trace.log', size: 20480, path: 'C:/tmp/trace.log' }], dir: 'C:/logs/2026' },
	},
	{
		name: 'answered · 向导（按步分组）',
		open: true,
		spec: {
			title: '新建项目',
			elements: [
				{ kind: 'wizard', id: 'proj', label: '新建项目', steps: [
					{ id: 'one', title: '名字', elements: [{ kind: 'input', id: 'name', label: '项目名' }] },
					{ id: 'two', title: '范围', elements: [{ kind: 'radio', id: 'size', label: '规模', options: ['小', '大'] }] },
				] },
			],
		},
		action: 'submit',
		values: { proj: { one: { name: 'dsh-intelligent-ui' }, two: { size: '大' } } },
	},
	{
		name: 'answered · 点了快捷按钮（没有可折叠的行）',
		spec: { title: '继续吗？', elements: [{ kind: 'text', text: '也可以什么都不选，直接点按钮。' }, { kind: 'button', id: 'retry', label: '重试' }] },
		action: 'button',
		button: 'retry',
		values: {},
	},
	{
		name: 'answered · 取消（没有答案）',
		spec: { title: '发布确认', elements: [{ kind: 'radio', id: 'go', label: '现在发布？', options: ['发布', '再等等'] }] },
		action: 'cancel',
		values: {},
	},
]

/**
 * Material for the history snapshot. Eleven entries cover every `action` the
 * log can hold, both text shapes `historyValueText` renders (`key=value`,
 * `N 项`, `N 字段`, a long note that gets an ellipsis) and both tones.
 */
export const HISTORY_SAMPLE = [
	{ at: '2026-11-06T11:32:08.000Z', callId: 'c1', title: 'Where should I deploy?', action: 'submit', button: '', values: { env: 'prod', replicas: 7 } },
	{ at: '2026-11-06T10:04:51.000Z', callId: 'c2', title: '重跑这个任务？', action: 'button', button: 'retry', values: {} },
	{ at: '2026-11-06T08:20:03.000Z', callId: 'c3', title: '发布方案确认', action: 'cancel', button: '', values: {} },
	{ at: '2026-11-06T05:11:44.000Z', callId: 'c4', title: '这次改动要写文档吗', action: 'cancelled', button: '', values: {} },
	{ at: '2026-11-05T21:02:10.000Z', callId: 'c5', title: 'Intelligent UI · 组件库', action: 'display', button: '', values: {} },
	{ at: '2026-11-05T15:47:31.000Z', callId: 'c6', title: '表单：上线工单', action: 'submit', button: '', values: { title: '登录 500', qty: 3 } },
	{ at: '2026-11-05T09:18:07.000Z', callId: 'c7', title: '范围多选', action: 'submit', button: '', values: { tags: ['api', 'ui'], scope: ['ui'] } },
	{ at: '2026-11-04T23:40:55.000Z', callId: 'c8', title: '今晚发不发', action: 'submit', button: '', values: { note: '周五晚上发，别赶周一早上' } },
	{ at: '2026-11-04T14:06:12.000Z', callId: 'c9', title: '向导：新建项目', action: 'submit', button: '', values: { proj: { name: 'dsh-intelligent-ui', size: 'large' } } },
	{ at: '2026-11-04T09:55:29.000Z', callId: 'c10', title: '删掉旧图吗', action: 'cancel', button: '', values: {} },
	{ at: '2026-11-03T20:12:48.000Z', callId: 'c11', title: '截图基线路线', action: 'submit', button: '', values: { route: 'chrome', baseline: 'replace' } },
]

/** `total` is what the log holds; it is deliberately larger than the sample. */
export const HISTORY_TOTAL = 128
