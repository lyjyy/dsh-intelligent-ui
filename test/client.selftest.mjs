/**
 * dsh-intelligent-ui — offline browser-half self-test.
 *
 * Loads lib/client.js through a fake `window.__ModuleLoader__` with a tiny React
 * stub, then checks the module contract (id/exports/apply), the slot
 * registration shape, the value helpers, and every render branch of every
 * widget kind — including table, wizard, chart, path, multiselect and textarea.
 *
 *   node test/client.selftest.mjs
 */
import assert from 'node:assert/strict'

/* ------------------------------------------------------------------ *
 * minimal React stub
 * ------------------------------------------------------------------ */

const stateQueue = []

const React = {
	createElement(type, props, ...children) {
		const merged = { ...(props ?? {}) }
		const kids = children.filter((child) => child !== undefined && child !== null)
		if (kids.length === 1) merged.children = kids[0]
		else if (kids.length > 1) merged.children = kids
		return { __vnode: true, type, props: merged }
	},
	useState(initial) {
		const next = stateQueue.length > 0 ? stateQueue.shift() : typeof initial === 'function' ? initial() : initial
		return [next, () => {}]
	},
	useEffect() {},
}

/* ------------------------------------------------------------------ *
 * fake module loader
 * ------------------------------------------------------------------ */

let loaded = null
globalThis.window = {
	__ModuleLoader__: {
		load(spec) {
			loaded = spec
		},
	},
}
globalThis.fetch = () => Promise.reject(new Error('network disabled in self-test'))

await import('../lib/client.js')

const results = []
function step(label, fn) {
	try {
		fn()
		results.push(`  ok   ${label}`)
	} catch (error) {
		results.push(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
		process.exitCode = 1
	}
}

const mod = loaded.factory((id) => {
	if (id === 'react' || id === 'react-dom') return React
	throw new Error(`unexpected require("${id}")`)
})

step('module wrapper', () => {
	assert.equal(loaded.id, 'dsh-intelligent-ui')
	assert.equal(mod.NS, 'dsh-intelligent-ui')
	assert.deepEqual(mod.inject, [])
	assert.equal(typeof mod.apply, 'function')
})

/* ------------------------------------------------------------------ *
 * apply()
 * ------------------------------------------------------------------ */

let injection = null
	const injections = []
	const registrations = []

const slots = {
	inject(name, factory) {
		injection = name
		injections.push(name)
		factory()
	},
	register(definition, component) {
		registrations.push({ definition, component })
		return () => {}
	},
}

const ctx = {
	inject(deps, callback) {
		assert.deepEqual(deps, ['slots'])
		callback({ slots })
	},
}

step('apply() registers the panel view for every panel-producing tool', () => {
	mod.apply(ctx)
	assert.ok(injections.includes('tool.call.toolview'))
	const views = registrations.filter((entry) => entry.definition.name === 'tool.call.toolview')
	// The template tool blocks on a panel exactly like the raw tool; if it is
	// missing here its panel never renders and the host-side await never settles.
	// The history tool leaves a read-only snapshot behind, and it is wired last
	// so that registrations[0] stays the blocking panel the renderers assume.
	assert.deepEqual(
		views.map((entry) => entry.definition.key),
		['interactive_ui', 'interactive_ui_template', 'interactive_ui_gallery', 'interactive_ui_history'],
	)
	for (const entry of views) {
		assert.equal(entry.definition.name, 'tool.call.toolview')
		assert.equal(typeof entry.component, 'function')
	}
	assert.equal(typeof views[0].component, typeof views[1].component)
	assert.equal(typeof views[0].component, typeof views[2].component)
	assert.equal(typeof views[0].component, typeof views[3].component)
})

step('apply() puts an always-available reload button next to the composer', () => {
	const composer = registrations.filter((entry) => entry.definition.name === 'conversation.input.right')
	assert.equal(composer.length, 1, 'exactly one composer registration')
	assert.equal(composer[0].definition.id, 'intelligent-ui-reload')
	assert.equal(typeof composer[0].component, 'function')
	const label = textOf(composer[0].component({}))
	assert.ok(label.includes('⟳'), 'the composer control is the reload glyph')
})

/* ------------------------------------------------------------------ *
 * tree helpers
 * ------------------------------------------------------------------ */

function flatten(node, out = []) {
	if (node === null || node === undefined || typeof node !== 'object') return out
	if (Array.isArray(node)) {
		for (const child of node) flatten(child, out)
		return out
	}
	if (node.__vnode === true) {
		out.push(node)
		flatten(node.props?.children, out)
	}
	return out
}

/** Every CSS class token used anywhere in the tree. */
function classNames(tree) {
	const tokens = new Set()
	for (const node of flatten(tree)) {
		const value = node.props?.className
		if (typeof value !== 'string') continue
		for (const token of value.split(/\s+/)) if (token.length > 0) tokens.add(token)
	}
	return [...tokens]
}

/** Every string leaf in the tree, joined — "does this text show up anywhere?". */
function textOf(tree) {
	const parts = []
	const walk = (node) => {
		if (typeof node === 'string') {
			parts.push(node)
			return
		}
		if (node === null || node === undefined || typeof node !== 'object') return
		if (Array.isArray(node)) {
			for (const child of node) walk(child)
			return
		}
		if (node.__vnode === true) walk(node.props?.children)
	}
	walk(tree)
	return parts.join('|')
}

function renderWith(panelState) {
	stateQueue.length = 0
	const values = mod.__selftest.initialValues(panelState !== null && panelState?.spec ? panelState.spec : {})
	stateQueue.push(panelState, values, { current: values }, false, '')
	return registrations[0].component({ callId: 'call-1', toolName: 'interactive_ui', phase: 'start' })
}

/** Render one element through the pure widget() entry point. */
function renderWidget(element, values = {}) {
	return mod.__selftest.widget(element, 0, { values, busy: false, set() {}, submit() {} }, [])
}

/* ------------------------------------------------------------------ *
 * the original spec (regression coverage)
 * ------------------------------------------------------------------ */

const spec = {
	title: 'Deploy where?',
	subtitle: 'Pick a target.',
	submit_label: 'Deploy',
	cancel_label: 'Nope',
	allow_cancel: true,
	elements: [
		{ kind: 'text', text: 'Staging is safe.' },
		{ kind: 'radio', id: 'env', label: 'Target', options: [{ value: 'staging', label: 'Staging' }, { value: 'prod', label: 'Production', description: 'live' }], default: 'staging' },
		{ kind: 'select', id: 'region', label: 'Region', options: ['eu', 'us'], default: 'us' },
		{ kind: 'checkbox', id: 'confirm', label: 'I understand', default: true },
		{ kind: 'slider', id: 'replicas', label: 'Replicas', min: 1, max: 10, step: 1, default: 3, unit: ' pods' },
		{ kind: 'form', id: 'cred', label: 'Credentials', fields: [{ id: 'token', label: 'Token', type: 'password', required: true }] },
		{ kind: 'button', id: 'retry', label: 'Retry', style: 'danger' },
		{ kind: 'link', label: 'Docs', href: 'https://example.com' },
		{ kind: 'bogus' },
	],
}

step('loading branch renders before the spec arrives', () => {
	const tree = renderWith(null)
	assert.ok(classNames(tree).includes('iui-muted'))
})

step('error branch renders the message', () => {
	const tree = renderWith({ status: 'error', message: 'The panel could not be found.' })
	assert.ok(flatten(tree).some((node) => node.props?.children === 'The panel could not be found.'))
})

step('initialValues derives per-kind defaults', () => {
	const values = mod.__selftest.initialValues(spec)
	assert.equal(values.env, 'staging')
	assert.equal(values.region, 'us')
	assert.equal(values.confirm, true)
	assert.equal(values.replicas, 3)
	assert.deepEqual(values.cred, { token: '' })
	assert.equal(Object.hasOwn(values, 'retry'), false)
})

step('pending branch renders every widget kind', () => {
	const tree = renderWith({ status: 'pending', spec })
	const classes = classNames(tree)
	for (const expected of ['iui-panel', 'iui-title', 'iui-subtitle', 'iui-body', 'iui-text', 'iui-cards', 'iui-select', 'iui-check', 'iui-range', 'iui-input', 'iui-foot', 'iui-btn--primary', 'iui-btn--danger', 'iui-link']) {
		assert.ok(classes.includes(expected), `missing ${expected}`)
	}
	const cards = flatten(tree).filter((node) => typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes('iui-card'))
	assert.equal(cards.length, 2)
	assert.ok(cards.some((node) => String(node.props.className).includes('is-on')))
	const button = flatten(tree).find((node) => node.props?.className === 'iui-btn iui-btn--danger')
	assert.equal(button.props.disabled, false)
	const submits = flatten(tree).find((node) => node.props?.className === 'iui-btn iui-btn--primary')
	assert.equal(submits.props.children, 'Deploy')
})

step('the fixed note line renders above the buttons, never in a read-only panel', () => {
	const withHint = { ...spec, note_hint: '选项不合意？可以在下面写一句。' }
	const tree = renderWith({ status: 'pending', spec: withHint })
	const hint = flatten(tree).find((node) => node.props?.className === 'iui-foot-hint')
	assert.ok(hint, 'the note line is rendered')
	assert.equal(hint.props.children, withHint.note_hint, 'the wording comes from the host spec')
	assert.ok(classNames(tree).includes('iui-foot'), 'it lives inside the footer')
	// the wording is host-owned: no hint, no line
	assert.ok(!classNames(renderWith({ status: 'pending', spec })).includes('iui-foot-hint'), 'no note_hint, no line')
	// read-only panels replace the whole footer with a hint, so no note line either
	const readonlySpec = { title: 'Gallery', readonly: true, note_hint: withHint.note_hint, elements: [{ kind: 'text', text: 'nothing to answer' }] }
	const readonlyClasses = classNames(renderWith({ status: 'display', spec: readonlySpec }))
	assert.ok(!readonlyClasses.includes('iui-foot'), 'no footer in a read-only panel')
	assert.ok(!readonlyClasses.includes('iui-foot-hint'), 'and therefore no note line')
})

step('the note box answers under user_note and is never stripped on the way back', () => {
	const noteSpec = {
		title: 'Pick one',
		elements: [{ kind: 'radio', id: 'env', options: ['a', 'b'] }, { kind: 'textarea', id: 'user_note', label: '备注（可选）' }],
	}
	const values = mod.__selftest.initialValues(noteSpec)
	assert.equal(Object.hasOwn(values, 'user_note'), true, 'the note box is seeded like any textarea')
	assert.equal(values.user_note, '')
	const payload = mod.__selftest.publicValues({ ...values, user_note: 'b 才对', __missing: ['env'] })
	assert.equal(payload.user_note, 'b 才对', 'user_note survives: only __-prefixed keys are dropped')
	assert.equal(Object.hasOwn(payload, '__missing'), false, 'client-only state is still dropped')
})

step('cancel button appears only when allow_cancel is set', () => {
	const labels = (panelSpec) => flatten(renderWith({ status: 'pending', spec: panelSpec }))
		.filter((node) => node.type === 'button')
		.map((node) => textOf(node))
	assert.ok(labels(spec).includes('Nope'), 'the cancel button is there when allow_cancel is set')
	assert.ok(!labels({ ...spec, allow_cancel: false }).includes('Nope'), 'and gone when it is not')
	assert.ok(labels({ ...spec, allow_cancel: false }).includes('Deploy'), 'the submit button stays')
})

step('answered branch replays action and values', () => {
	const tree = renderWith({ status: 'answered', spec, action: 'button', button: 'retry', values: { env: 'prod', confirm: true, replicas: 7 } })
	const text = textOf(tree)
	assert.ok(text.includes('按了按钮'), 'the verdict names what happened')
	assert.ok(text.includes('Retry'), 'the clicked button is named from the spec')
	assert.ok(!classNames(tree).includes('iui-foot'), 'the submit bar is gone')
	assert.ok(!text.includes('"env"'), 'the raw JSON is not the display')
})

step('an answered choice shows the option label, not the stored value', () => {
	const tree = renderWith({ status: 'answered', spec, action: 'submit', values: { env: 'prod' } })
	const text = textOf(tree)
	assert.ok(text.includes('Production'), 'the chosen option label is shown')
	assert.ok(text.includes('Target'), 'the question label is the row key')
	assert.ok(!text.split('|').includes('prod'), 'the raw option value is not the display')
})

step('an empty note box leaves no row in the summary, a filled one does', () => {
	const noteSpec = {
		elements: [
			{ kind: 'radio', id: 'env', label: 'Target', options: [{ value: 'prod', label: 'Production' }] },
			{ kind: 'textarea', id: 'user_note', label: '备注' },
		],
	}
	const empty = textOf(renderWith({ status: 'answered', spec: noteSpec, action: 'submit', values: { env: 'prod', user_note: '' } }))
	assert.ok(!empty.includes('备注'), 'an empty note gets no row at all')
	assert.ok(!empty.includes('空'), 'and no "空" placeholder either')
	assert.ok(!empty.includes('其他'), 'the hidden note is not resurfaced as leftover')
	assert.ok(empty.includes('Production'), 'the real answer is still shown')

	const filled = textOf(renderWith({ status: 'answered', spec: noteSpec, action: 'submit', values: { env: 'prod', user_note: '其实我要 eu' } }))
	assert.ok(filled.includes('备注'), 'a filled note keeps its row')
	assert.ok(filled.includes('其实我要 eu'), 'and shows what the user wrote')
})

step('a switch answer renders as a state chip', () => {
	const on = renderWith({ status: 'answered', spec, action: 'submit', values: { confirm: true } })
	const off = renderWith({ status: 'answered', spec, action: 'submit', values: { confirm: false } })
	assert.ok(textOf(on).includes('✓ 开启'))
	assert.ok(textOf(off).includes('✗ 关闭'))
	assert.ok(classNames(on).includes('is-ok'), 'on is a success chip')
	assert.ok(classNames(off).includes('is-off'), 'off is a quiet chip')
})

step('a slider answer renders a level bar and the number', () => {
	const tree = renderWith({ status: 'answered', spec, action: 'submit', values: { replicas: 7 } })
	const bar = flatten(tree).find((node) => node.props?.className === 'iui-ans-bar')
	assert.ok(bar !== undefined, 'the level bar is there')
	assert.equal(bar.props.children.props.style.width, '67%', 'min 1 / max 10 puts 7 at 67%')
	assert.ok(textOf(tree).includes('7 pods'), 'the number keeps its unit')
})

step('a form answer nests field labels under the form label', () => {
	const tree = renderWith({ status: 'answered', spec, action: 'submit', values: { cred: { token: 'hunter2' } } })
	const text = textOf(tree)
	assert.ok(text.includes('Credentials'), 'the form row keeps its label')
	assert.ok(text.includes('Token'), 'the field label is restored from the spec')
	assert.ok(text.includes('hunter2'), 'the field value is shown')
	assert.ok(classNames(tree).includes('iui-ans-group'), 'nested answers sit in a group')
})

step('multiselect and tree answers list the chosen labels', () => {
	const elements = [
		{ kind: 'multiselect', id: 'tags', label: 'Tags', options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] },
		{ kind: 'tree', id: 'scope', label: 'Scope', nodes: [{ id: 'src', label: 'src', children: [{ id: 'src/x', label: 'src/x.js' }] }] },
	]
	const tree = renderWith({ status: 'answered', spec: { elements }, action: 'submit', values: { tags: ['b'], scope: ['src/x'] } })
	const text = textOf(tree)
	assert.ok(text.includes('Beta'), 'a multiselect entry shows its label')
	assert.ok(!text.split('|').includes('b'), 'not the raw value')
	assert.ok(text.includes('src/x.js'), 'a tree node shows its label')
})

step('an empty answer is stated rather than faked', () => {
	const elements = [{ kind: 'multiselect', id: 'tags', label: 'Tags', options: ['a'] }, { kind: 'input', id: 'note', label: 'Note' }]
	const tree = renderWith({ status: 'answered', spec: { elements }, action: 'submit', values: { tags: [], note: '' } })
	assert.equal(textOf(tree).split('|').filter((part) => part === '未选择').length, 1, 'one empty pick is reported once')
	assert.ok(textOf(tree).includes('未填写'), 'an empty text field says so')
})

step('uploaded files answer with a name, a size, and the path on hover', () => {
	const elements = [{ kind: 'upload', id: 'files', label: 'Files', multiple: true }]
	const tree = renderWith({ status: 'answered', spec: { elements }, action: 'submit', values: { files: [{ name: 'a.txt', size: 1536, path: 'C:/tmp/a.txt' }] } })
	assert.ok(textOf(tree).includes('a.txt · 1.5 KB'), 'name and size are shown')
	assert.ok(flatten(tree).some((node) => node.props?.title === 'C:/tmp/a.txt'), 'the real path is the tooltip')
})

step('a wizard answer is grouped per step', () => {
	const elements = [{ kind: 'wizard', id: 'proj', label: '新建项目', steps: [
		{ id: 'one', title: '名字', elements: [{ kind: 'input', id: 'name', label: '项目名' }] },
		{ id: 'two', title: '范围', elements: [{ kind: 'radio', id: 'size', label: '规模', options: ['小', '大'] }] },
	] }]
	const values = { proj: { one: { name: 'dsh' }, two: { size: '大' } }, __step: { proj: 1 } }
	const tree = renderWith({ status: 'answered', spec: { elements }, action: 'submit', values })
	const text = textOf(tree)
	assert.ok(text.includes('名字'), 'the first step keeps its title')
	assert.ok(text.includes('项目名'), 'its field is labelled')
	assert.ok(text.includes('范围'), 'the second step keeps its title')
	assert.ok(text.includes('dsh'), 'the first answer is shown')
	assert.ok(text.includes('大'), 'the second answer is shown')
	assert.equal(flatten(tree).filter((node) => node.props?.className === 'iui-ans-gtitle').map((node) => textOf(node)).join(','), '名字,范围', 'one titled group per answered step, in order')
	assert.ok(text.includes('新建项目'), 'the wizard keeps its own label')
	assert.ok(!text.includes('其他'), 'nothing spills into the catch-all row')
})

step('a cancelled panel states the verdict and replays no answer', () => {
	const tree = renderWith({ status: 'answered', spec, action: 'cancel', values: { env: 'prod' } })
	assert.ok(textOf(tree).includes('已取消'))
	assert.ok(!classNames(tree).includes('iui-ans-rows'), 'a cancellation is not dressed up as an answer')
})

step('answers the spec never asked for still surface', () => {
	const tree = renderWith({ status: 'answered', spec: { elements: [] }, action: 'submit', values: { extra: 1 } })
	assert.ok(textOf(tree).includes('extra = 1'))
})

step('the raw JSON stays reachable through the copy button', () => {
	const tree = renderWith({ status: 'answered', spec, action: 'submit', values: { env: 'prod' } })
	const button = flatten(tree).find((node) => node.type === 'button' && classNames([node]).includes('iui-ans-copy'))
	assert.ok(button !== undefined, 'the copy affordance is there')
	assert.equal(button.props.title, '复制答案 JSON')
})

step('unknown widget kinds render nothing instead of throwing', () => {
	const tree = renderWith({ status: 'pending', spec: { elements: [{ kind: 'bogus' }, 'nope', null] } })
	assert.ok(classNames(tree).includes('iui-panel'))
})

/* ------------------------------------------------------------------ *
 * value helpers
 * ------------------------------------------------------------------ */

step('withPath/atPath round-trip a nested path immutably', () => {
	const base = { a: { b: { c: 1 } }, keep: true }
	const next = mod.__selftest.withPath(base, ['a', 'b', 'c'], 2)
	assert.equal(mod.__selftest.atPath(next, ['a', 'b', 'c']), 2)
	assert.equal(mod.__selftest.atPath(base, ['a', 'b', 'c']), 1, 'original must stay untouched')
	assert.equal(base.keep, true)
	assert.equal(next.keep, true)
})

step('publicValues strips client-only keys', () => {
	const values = { env: 'prod', __step: { flow: 2 } }
	assert.deepEqual(mod.__selftest.publicValues(values), { env: 'prod' })
})

/* ------------------------------------------------------------------ *
 * new widget kinds
 * ------------------------------------------------------------------ */

const richSpec = {
	title: 'Release checklist',
	elements: [
		{ kind: 'text', text: 'Careful.', tone: 'warn' },
		{ kind: 'multiselect', id: 'targets', label: 'Targets', options: [{ value: 'web', label: 'Web' }, { value: 'desktop', label: 'Desktop' }], default: ['web'], columns: 2 },
		{ kind: 'number', id: 'batch', label: 'Batch size', min: 1, max: 500, default: 50, unit: ' jobs' },
		{ kind: 'input', id: 'tag', label: 'Tag', input_type: 'text', placeholder: 'v1.2.3' },
		{ kind: 'date', id: 'when', label: 'Window start' },
		{ kind: 'time', id: 'at', label: 'Window time' },
		{ kind: 'textarea', id: 'notes', label: 'Notes', rows: 4, default: 'none' },
		{ kind: 'path', id: 'out', label: 'Output folder', mode: 'directory' },
		{ kind: 'table', id: 'rows', label: 'Services', select: 'multi', row_key: 'name', columns: [{ key: 'name', label: 'Service' }, { key: 'lag', label: 'Lag', align: 'right' }], rows: [{ name: 'api', lag: 12 }, { name: 'worker', lag: 340 }], default: ['api'] },
		{ kind: 'chart', id: 'load', label: 'Load', chart: 'bar', unit: 'ms', series: [{ label: 'api', value: 12 }, { label: 'worker', value: 340 }] },
		{ kind: 'switch', id: 'dry', label: 'Dry run', default: true },
		{
			kind: 'wizard', id: 'flow', label: 'Rollout',
			steps: [
				{ id: 'scope', title: 'Scope', elements: [{ kind: 'radio', id: 'size', label: 'Size', options: ['canary', 'full'], default: 'canary' }] },
				{ id: 'gate', title: 'Gate', elements: [{ kind: 'checkbox', id: 'approve', label: 'Approved' }] },
			],
		},
	],
}

step('initialValues seeds new kinds (arrays, wizard steps, nested defaults)', () => {
	const values = mod.__selftest.initialValues(richSpec)
	assert.deepEqual(values.targets, ['web'])
	assert.equal(values.batch, 50)
	assert.equal(values.when, '')
	assert.equal(values.notes, 'none')
	assert.equal(values.out, '')
	assert.deepEqual(values.rows, ['api'], 'table multi-select default')
	assert.equal(values.dry, true)
	assert.deepEqual(values.flow, { scope: { size: 'canary' }, gate: { approve: false } })
	assert.equal(values.__step.flow, 0)
})

step('table with select "none" contributes no value', () => {
	const values = mod.__selftest.initialValues({ elements: [{ kind: 'table', id: 'plain', columns: [{ key: 'a' }], rows: [{ a: 1 }] }] })
	assert.equal(Object.hasOwn(values, 'plain'), false)
})

step('new widgets render their classes', () => {
	const values = mod.__selftest.initialValues(richSpec)
	const classes = classNames(renderWith({ status: 'pending', spec: richSpec }))
	for (const expected of ['iui-table', 'iui-table-wrap', 'iui-wizard', 'iui-steps', 'iui-step', 'iui-step-body', 'iui-nav', 'iui-chart', 'iui-legend', 'iui-grid', 'iui-area', 'iui-inline', 'iui-text--warn', 'iui-tr--pick', 'iui-pick']) {
		assert.ok(classes.includes(expected), `missing ${expected}`)
	}
	assert.equal(values.batch, 50)
})

step('a long multiselect scrolls', () => {
	const options = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((value) => ({ value, label: value }))
	const short = classNames(renderWidget({ kind: 'multiselect', id: 'x', label: 'X', options: options.slice(0, 3) }, { x: [] }))
	assert.ok(!short.includes('iui-scroll'))
	const tall = classNames(renderWidget({ kind: 'multiselect', id: 'x', label: 'X', options }, { x: [] }))
	assert.ok(tall.includes('iui-scroll'))
})

step('table marks the preselected row and reports it', () => {
	const element = richSpec.elements.find((entry) => entry.kind === 'table')
	const tree = renderWith({ status: 'pending', spec: { elements: [element] } })
	const rows = flatten(tree).filter((node) => node.type === 'tr' && String(node.props?.className ?? '').includes('iui-tr--pick'))
	assert.equal(rows.length, 2)
	assert.equal(rows.filter((node) => String(node.props.className).includes('is-on')).length, 1)
	const text = flatten(tree).map((node) => (typeof node.props?.children === 'string' ? node.props.children : '')).join('|')
	assert.ok(text.includes('Selected: api'), 'row_key identity is used for the summary')
})

step('wizard renders only the current step body, and can move on', () => {
	const element = richSpec.elements.find((entry) => entry.kind === 'wizard')
	const textsOf = (tree) => flatten(tree).map((node) => (typeof node.props?.children === 'string' ? node.props.children : '')).join('|')

	const stepOne = renderWith({ status: 'pending', spec: { elements: [element] } })
	const one = textsOf(stepOne)
	assert.ok(one.includes('Scope') && one.includes('Gate'), 'both step titles show in the crumb strip')
	assert.ok(one.includes('Size'), 'the first step body is rendered')
	assert.ok(!one.includes('Approved'), 'the second step body stays hidden')
	assert.equal(flatten(stepOne).filter((node) => String(node.props?.className ?? '') === 'iui-step-body').length, 1)

	const values = { __step: { flow: 1 }, flow: {} }
	const stepTwo = mod.__selftest.wizardWidget(element, 0, { values, busy: false, set() {}, submit() {} }, ['flow'])
	const two = textsOf(stepTwo)
	assert.ok(two.includes('Approved'), 'the second step body is rendered')
	assert.ok(!two.includes('Size'), 'the first step body is hidden')
	assert.ok(two.includes('Finish'), 'the last step offers Finish instead of Next')
	assert.ok(flatten(stepTwo).some((node) => String(node.props?.className ?? '').includes('iui-step') && String(node.props.className).includes('is-on')))
})

step('wizard with no steps renders nothing', () => {
	assert.equal(mod.__selftest.wizardWidget({ kind: 'wizard', id: 'w', steps: [] }, 0, { values: {}, busy: false, set() {}, submit() {} }, ['w']), null)
})

step('charts render all four shapes', () => {
	for (const chart of ['bar', 'line', 'pie', 'donut']) {
		const tree = mod.__selftest.chartWidget({ kind: 'chart', chart, label: chart, series: [{ label: 'a', value: 3 }, { label: 'b', value: 7 }] }, 0)
		const svg = flatten(tree).find((node) => node.type === 'svg')
		assert.ok(svg, `${chart} should render an svg`)
		assert.ok(flatten(svg).length > 0, `${chart} should draw something`)
	}
	const single = mod.__selftest.chartWidget({ kind: 'chart', chart: 'donut', series: [{ label: 'all', value: 9 }] }, 0)
	assert.ok(classNames(single).includes('iui-swatch'), 'legend still renders for a single slice')
})

step('chart/multiselect/table survive malformed input', () => {
	assert.equal(mod.__selftest.chartWidget({ kind: 'chart', series: [] }, 0), null)
	assert.ok(mod.__selftest.tableWidget({ kind: 'table', columns: [], rows: [], select: 'single' }, 0, { values: {}, busy: false, set() {}, submit() {} }, ['t']) !== null)
})

/* ------------------------------------------------------------------ *
 * markdown
 * ------------------------------------------------------------------ */

const markdownSource = [
	'# Title',
	'',
	'Some **bold**, `code` and a [link](https://example.com).',
	'',
	'- one',
	'- two',
	'',
	'> quoted',
	'',
	'```js',
	'const x = 1 < 2',
	'```',
	'',
	'| a | b |',
	'| --- | --- |',
	'| 1 | 2 |',
].join('\n')

step('markdown renders headings, lists, quotes, fences and tables', () => {
	const blocks = mod.__selftest.markdownBlocks(markdownSource)
	assert.deepEqual(blocks.map((node) => node.type), ['h1', 'p', 'ul', 'blockquote', 'div', 'table'])
	const classes = classNames(blocks)
	for (const expected of ['iui-code', 'iui-code-lang', 'iui-copy']) assert.ok(classes.includes(expected), `missing ${expected}`)
	const text = textOf(blocks)
	assert.ok(text.includes('const x = 1 < 2'), 'fenced code keeps its text verbatim')
	assert.ok(text.includes('two'), 'list items render')
	assert.ok(text.includes('Title'), 'heading text renders')
	assert.ok(flatten(blocks).some((node) => node.type === 'a' && node.props.href === 'https://example.com'), 'links render as anchors')
	assert.ok(flatten(blocks).some((node) => node.type === 'th'), 'table headers render')
})

step('the copy button sits in its own header bar, never on top of the code', () => {
	const blocks = mod.__selftest.markdownBlocks(markdownSource)
	const nodes = flatten(blocks)
	const container = nodes.find((node) => node.props.className === 'iui-code')
	assert.ok(container !== undefined, 'the code block is a .iui-code container')
	const parts = Array.isArray(container.props.children) ? container.props.children : [container.props.children]
	const head = parts.find((child) => child !== null && typeof child === 'object' && child.props.className === 'iui-code-head')
	assert.ok(head !== undefined, 'the code block renders a header bar')
	assert.ok(parts.some((child) => child !== null && typeof child === 'object' && child.type === 'pre'), 'the code body is a sibling of the header, not a container of the button')
	const children = Array.isArray(head.props.children) ? head.props.children : [head.props.children]
	const button = children.find((child) => child !== null && typeof child === 'object' && child.props.className === 'iui-copy')
	assert.ok(button !== undefined, 'the copy button is inside the header bar')
	const css = mod.__selftest.css
	const copyRule = /\.iui-copy\{[^}]*\}/.exec(css)
	assert.ok(copyRule !== null, '.iui-copy has a rule')
	assert.ok(copyRule[0].includes('position:absolute') === false, 'the copy button is no longer absolutely positioned')
	assert.ok(/\.iui-code-head\{[^}]*display:flex/.test(css), 'the header bar lays out in normal flow')
	const target = { textContent: 'copy' }
	button.props.onClick({ currentTarget: target })
	assert.equal(target.textContent, 'copied', 'clicking acknowledges the copy')
})

step('markdown never interprets raw HTML', () => {
	const blocks = mod.__selftest.markdownBlocks('<script>alert(1)</script>')
	assert.deepEqual(blocks.map((node) => node.type), ['p'])
	const paragraph = flatten(blocks)[0]
	const children = Array.isArray(paragraph.props.children) ? paragraph.props.children : [paragraph.props.children]
	assert.ok(children.some((child) => typeof child === 'string' && child.includes('<script>')), 'the tag stays visible text')
})

step('markdown handles empty and malformed input', () => {
	assert.deepEqual(mod.__selftest.markdownBlocks(''), [])
	assert.deepEqual(mod.__selftest.markdownBlocks(undefined), [])
	assert.deepEqual(mod.__selftest.markdownBlocks('```').map((node) => node.type), ['div'])
	assert.deepEqual(mod.__selftest.markdownBlocks('| a | b |').map((node) => node.type), ['p'], 'a lone pipe row is a paragraph')
})

/* ------------------------------------------------------------------ *
 * upload + read-only panels
 * ------------------------------------------------------------------ */

step('upload seeds an empty list and renders the drop zone', () => {
	const values = mod.__selftest.initialValues({ elements: [{ kind: 'upload', id: 'files', label: 'Attachments', multiple: true }] })
	assert.deepEqual(values.files, [])
	const tree = renderWidget({ kind: 'upload', id: 'files', label: 'Attachments' }, values)
	for (const expected of ['iui-drop', 'iui-drop-hint', 'iui-btn--ghost']) {
		assert.ok(classNames(tree).includes(expected), `missing ${expected}`)
	}
	const input = flatten(tree).find((node) => node.type === 'input' && node.props.type === 'file')
	assert.ok(input, 'a file input is present')
	assert.equal(input.props.multiple, true)
	assert.equal(input.props.style.display, 'none', 'the input itself is hidden')
})

step('upload lists stored files with sizes and a remove button', () => {
	const tree = renderWidget({ kind: 'upload', id: 'files', label: 'Attachments' }, { files: [{ path: '/tmp/a.txt', size: 2048 }, { path: '/tmp/b.bin', size: 5 }] })
	const text = textOf(tree)
	assert.ok(text.includes('a.txt') && text.includes('b.bin'), 'names come from the stored paths')
	assert.ok(text.includes('2.0 KB') && text.includes('5 B'), 'sizes are human readable')
	assert.equal(flatten(tree).filter((node) => node.type === 'button').length, 2, 'one remove button per file')
	assert.equal(flatten(tree).filter((node) => String(node.props?.className ?? '').split(/\s+/).includes('iui-file')).length, 2)
})

step('read-only panels render without a submit bar', () => {
	const classes = classNames(renderWith({ status: 'display', spec: { title: 'Gallery', readonly: true, elements: [{ kind: 'text', text: 'nothing to answer' }] } }))
	assert.ok(!classes.includes('iui-foot'), 'no footer')
	assert.ok(!classes.includes('iui-btn--primary'), 'no submit button')
	assert.ok(classes.includes('iui-hint'), 'a read-only note replaces the footer')
})

step('the history snapshot renders as paged timelines inside a read-only panel', () => {
	// Mirrors what `historySpec()` on the host side hands the browser: one
	// `tabs` page per screenful, each holding a `timeline`, plus a warning line.
	const historySpec = {
		title: 'Intelligent UI · 历史作答',
		subtitle: '2 页 · 点页签翻 · 本会话最近 9 条记录 · 只读',
		readonly: true,
		elements: [
			{
				kind: 'tabs',
				id: 'hist_pages',
				tabs: [
					{ id: 'page_1', label: '第 1 页', elements: [{ kind: 'timeline', items: [{ at: '11-06 19:32', title: 'Where should I deploy?', text: '已提交 · env=prod', tone: 'ok' }] }] },
					{ id: 'page_2', label: '第 2 页', elements: [{ kind: 'timeline', items: [{ at: '11-06 18:04', title: '重跑这个任务？', text: '按了按钮 · retry', tone: 'ok' }] }] },
				],
			},
			{ kind: 'text', tone: 'warn', text: '只画了最近 9 条（日志里共有 128 条）。要更早的记录，把 limit 调大或加 all_sessions。' },
		],
	}
	const tree = renderWith({ status: 'display', spec: historySpec })
	const classes = classNames(tree)
	const text = textOf(tree)

	assert.ok(classes.includes('iui-tabbar'), 'the pages are tabs')
	assert.equal(flatten(tree).filter((node) => node.type === 'button' && String(node.props?.className ?? '').includes('iui-tab')).length, 2)
	assert.ok(text.includes('第 1 页') && text.includes('第 2 页'), 'every page tab is labelled')
	assert.ok(classes.includes('iui-tl-item'), 'each page is a timeline')
	assert.ok(classes.includes('is-ok'), 'the tone rides through to the timeline row')
	assert.ok(text.includes('Where should I deploy?'), 'the first page is the one on screen')
	assert.ok(!text.includes('重跑这个任务？'), 'the other pages stay hidden until clicked')
	assert.ok(text.includes('只画了最近 9 条'), 'a clipped snapshot says how much log there is')
	assert.ok(classes.includes('iui-text--warn'), 'and says it in the warning tone, not the error one')
	assert.ok(!classes.includes('iui-foot'), 'the snapshot never asks anything')
	assert.ok(!classes.includes('iui-btn--primary'), 'no submit button on a replay')

	// Switching pages must move the panel state, not the spec: the host owns the
	// record, so a page flip is a `__tab` write like any other tabs widget.
	const tabsValue = mod.__selftest.initialValues(historySpec)
	assert.equal(tabsValue.__tab?.hist_pages, 0, 'the first page is selected for free')
})

/* ------------------------------------------------------------------ *
 * v0.4 — diff, timeline, tree, progress, tabs
 * ------------------------------------------------------------------ */

step('diffRows produces a line-level diff with stable numbering', () => {
	const rows = mod.__selftest.diffRows('a\nb\nc\n', 'a\nB\nc\n')
	assert.deepEqual(rows.map((row) => row.type), ['same', 'del', 'add', 'same'])
	assert.deepEqual(rows[1], { type: 'del', text: 'b', before: 2, after: null })
	assert.deepEqual(rows[2], { type: 'add', text: 'B', before: null, after: 2 })
	assert.equal(rows[0].before, 1)
	assert.equal(rows[3].before, 3)
	assert.equal(rows[0].after, 1)
	assert.equal(rows[3].after, 3)
})

step('trimContext collapses long unchanged runs', () => {
	const before = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n')
	const after = before.replace('line 20', 'line TWENTY')
	const trimmed = mod.__selftest.trimContext(mod.__selftest.diffRows(before, after), 2)
	assert.equal(trimmed.filter((row) => row.type === 'skip').length, 2, 'one collapsed run on each side of the change')
	assert.ok(trimmed[0].text.includes('unchanged lines'))
	assert.equal(trimmed.filter((row) => row.type !== 'same' && row.type !== 'skip').length, 2)
})

step('diffWidget renders +/- rows, a count and a fallback note', () => {
	const tree = mod.__selftest.diffWidget({ before_name: 'a.txt', after_name: 'b.txt', before_text: 'x\n', after_text: 'y\n' }, 0, '', '')
	const classes = classNames(tree)
	for (const expected of ['iui-diff', 'iui-diff-head', 'iui-diff-stat', 'iui-dl', 'is-add', 'is-del']) assert.ok(classes.includes(expected), `missing ${expected}`)
	const text = textOf(tree)
	assert.ok(text.includes('+1') && text.includes('−1'), 'the head counts additions and removals')
	assert.ok(text.includes('a.txt') && text.includes('b.txt'), 'the head names both sides')
	const identical = mod.__selftest.diffWidget({ before_text: 'same\n', after_text: 'same\n' }, 0, '', '')
	assert.ok(textOf(identical).includes('identical'), 'identical sides are called out instead of an empty box')
})

step('timeline renders every event with its tone', () => {
	const tree = mod.__selftest.timelineWidget({ id: 't', label: 'History', items: [{ at: '10:00', title: 'start', text: 'began', tone: 'ok' }, { title: 'boom', tone: 'error' }, 'junk'] }, 0, 'History', '')
	const classes = classNames(tree)
	for (const expected of ['iui-tl', 'iui-tl-item', 'iui-tl-dot', 'iui-tl-at', 'iui-tl-title', 'iui-tl-text', 'is-ok', 'is-error']) assert.ok(classes.includes(expected), `missing ${expected}`)
	const text = textOf(tree)
	assert.ok(text.includes('start') && text.includes('10:00') && text.includes('began'))
	assert.equal(flatten(tree).filter((node) => String(node.props?.className ?? '').includes('iui-tl-item')).length, 2, 'non-object items are skipped')
})

step('tree seeds the checked ids and expands the first level', () => {
	const element = { kind: 'tree', id: 'files', label: 'Files', nodes: [
		{ id: 'lib', label: 'lib/', children: [{ id: 'lib/a.js', label: 'a.js' }] },
		{ id: 'readme', label: 'README', checked: true },
	] }
	const values = mod.__selftest.initialValues({ elements: [element] })
	assert.deepEqual(values.files, ['readme'], 'checked nodes seed the answer')
	const tree = mod.__selftest.treeWidget(element, 0, 'Files', '', values.files, false, { values, busy: false, set() {}, submit() {} }, [])
	const classes = classNames(tree)
	for (const expected of ['iui-tree', 'iui-tree-list', 'iui-tree-row', 'iui-tree-toggle', 'iui-tree-check', 'is-on']) assert.ok(classes.includes(expected), `missing ${expected}`)
	const boxes = flatten(tree).filter((node) => node.type === 'input' && node.props.type === 'checkbox')
	assert.equal(boxes.length, 3, 'every node gets a checkbox')
	assert.equal(boxes.filter((node) => node.props.checked === true).length, 1, 'only the seeded node starts checked')
	const text = textOf(tree)
	assert.ok(text.includes('lib/') && text.includes('a.js'), 'expand_depth 1 opens the first level')
})

step('tree honours expand_depth 0 and stays silent on malformed nodes', () => {
	const element = { kind: 'tree', id: 'f', expand_depth: 0, nodes: [{ id: 'a', label: 'A', children: [{ id: 'a1', label: 'A1' }] }, 'junk'] }
	const tree = mod.__selftest.treeWidget(element, 0, '', '', [], false, { values: {}, busy: false, set() {}, submit() {} }, [])
	assert.ok(textOf(tree).includes('A1') === false, 'children stay hidden')
	assert.equal(flatten(tree).filter((node) => node.type === 'input').length, 1)
	assert.deepEqual(mod.__selftest.treeCheckedIds([{ id: 'x', checked: true }, 'junk'], []), ['x'])
})

step('progress renders one bar per item with clamped widths', () => {
	const tree = mod.__selftest.progressWidget({ id: 'p', label: 'Progress', items: [
		{ label: 'done', value: 3, max: 4, unit: ' files', tone: 'ok' },
		{ label: 'over', value: 99, max: 10, tone: 'warn' },
		{ label: 'broken', value: 'nope' },
		'junk',
	] }, 0, 'Progress', '')
	const bars = flatten(tree).filter((node) => String(node.props?.className ?? '').includes('iui-prog-fill'))
	assert.equal(bars.length, 3, 'non-object items are skipped')
	assert.equal(bars[0].props.style.width, '75%')
	assert.equal(bars[1].props.style.width, '100%', 'widths are clamped at full')
	assert.equal(bars[2].props.style.width, '0%', 'unparseable values fall back to zero')
	assert.ok(classNames(tree).includes('is-warn'))
})

step('tabs render only the active tab but seed every tab', () => {
	const element = { kind: 'tabs', id: 'tabs', label: 'Tabs', tabs: [
		{ id: 'one', label: 'One', elements: [{ kind: 'input', id: 'inner_a', label: 'A' }] },
		{ id: 'two', label: 'Two', elements: [{ kind: 'checkbox', id: 'inner_b', label: 'B', default: true }] },
	] }
	const values = mod.__selftest.initialValues({ elements: [element] })
	assert.equal(values.inner_a, '', 'hidden tabs still seed their values')
	assert.equal(values.inner_b, true)
	assert.equal(values.__tab.tabs, 0)
	const tree = mod.__selftest.tabsWidget(element, 0, 'Tabs', '', { values, busy: false, set() {}, submit() {} }, [])
	const classes = classNames(tree)
	for (const expected of ['iui-tabs', 'iui-tabbar', 'iui-tab', 'is-on', 'iui-tab-body']) assert.ok(classes.includes(expected), `missing ${expected}`)
	assert.equal(flatten(tree).filter((node) => node.type === 'button').length, 2, 'one tab button per tab')
	assert.ok(textOf(tree).includes('A'), 'the active tab body renders')
	assert.ok(textOf(tree).includes('B') === false, 'the hidden tab body does not render')
	assert.equal(mod.__selftest.tabsWidget({ kind: 'tabs', tabs: [] }, 0, '', '', { values: {}, set() {} }, []), null, 'no tabs renders nothing')
})

step('private tab/tree/wizard state never reaches the answer', () => {
	const pub = mod.__selftest.publicValues({ keep: 1, __tab: { t: 1 }, __step: { w: 0 }, __open: { f: { x: true } } })
	assert.deepEqual(Object.keys(pub), ['keep'])
})

/* ------------------------------------------------------------------ *
 * reload affordance
 * ------------------------------------------------------------------ */

step('reloadUi republishes the bundle, and reloads even if that fails', () => {
	const calls = []
	let reloaded = 0
	const originalFetch = globalThis.fetch
	const originalWindow = globalThis.window
	// The stub stays installed: the successful republish resolves the reload on a
	// later microtask, and restoring the window first would only log a warning.
	globalThis.window = { __ModuleLoader__: originalWindow.__ModuleLoader__, location: { reload: () => { reloaded += 1 } } }
	try {
		globalThis.fetch = (url, options) => {
			calls.push({ url, options })
			return Promise.resolve({ ok: true })
		}
		mod.__selftest.reloadUi({ preventDefault: () => {} })
		assert.equal(calls.length, 1, 'one republish request')
		assert.equal(calls[0].url, '/api/dsh-intelligent-ui/refresh')
		assert.equal(calls[0].options.method, 'POST')
		assert.equal(reloaded, 0, 'the reload waits for the republish to settle')

		globalThis.fetch = () => {
			throw new Error('offline')
		}
		mod.__selftest.reloadUi()
		assert.equal(reloaded, 1, 'a failed republish still reloads the page')
	} finally {
		globalThis.fetch = originalFetch
	}
})

step('the composer control is a reload button', () => {
	const node = mod.__selftest.ReloadButton({})
	assert.equal(node.type, 'button')
	assert.ok(String(node.props.className).includes('iui-reload'))
	assert.equal(node.props.onClick, mod.__selftest.reloadUi)
	assert.equal(node.props.children, '⟳')
})

step('publishedRev picks this package out of the boot graph', () => {
	assert.equal(mod.__selftest.publishedRev({ entries: [{ id: 'other', rev: 'a' }] }), null)
	assert.equal(mod.__selftest.publishedRev({ entries: [{ id: 'dsh-intelligent-ui', rev: 'r1' }] }), 'r1')
	assert.equal(mod.__selftest.publishedRev({ entries: 'nope' }), null)
	assert.equal(mod.__selftest.publishedRev(null), null)
	assert.match(mod.__selftest.VERSION, /^\d+\.\d+\.\d+$/)
})

step('the bundle watcher reloads on a new revision, never under the user', () => {
	const reloads = []
	const originalWindow = globalThis.window
	const originalFetch = globalThis.fetch
	const originalDocument = globalThis.document
	// An immediately-resolving thenable keeps the watcher's promise chain
	// synchronous, so this step needs no awaits.
	const resolved = (value) => ({
		then(onOk, onErr) {
			if (typeof onOk !== 'function') return resolved(value)
			try {
				const next = onOk(value)
				// adopt a returned thenable, wrap a plain value
				return next !== null && typeof next === 'object' && typeof next.then === 'function' ? next : resolved(next)
			} catch (error) {
				return typeof onErr === 'function' ? onErr(error) : resolved(undefined)
			}
		},
	})
	let rev = 'r1'
	let tick = null
	globalThis.window = {
		__ModuleLoader__: originalWindow.__ModuleLoader__,
		location: { reload: () => { reloads.push(1) } },
		setInterval: (fn) => { tick = fn; return 1 },
		clearInterval: () => {},
	}
	globalThis.fetch = () => resolved({ ok: true, json: () => resolved({ entries: [{ id: 'dsh-intelligent-ui', rev }] }) })
	globalThis.document = { activeElement: null }
	try {
		const stop = mod.__selftest.watchBundle()
		assert.equal(reloads.length, 0, 'the first poll only records the boot revision')
		tick()
		assert.equal(reloads.length, 0, 'the same revision does not reload')
		rev = 'r2'
		globalThis.document = { activeElement: { tagName: 'TEXTAREA' } }
		tick()
		assert.equal(reloads.length, 0, 'a user mid-typing is not interrupted')
		globalThis.document = { activeElement: null }
		tick()
		assert.equal(reloads.length, 1, 'a new revision reloads the page')
		stop()
	} finally {
		globalThis.window = originalWindow
		globalThis.fetch = originalFetch
		if (originalDocument === undefined) delete globalThis.document
		else globalThis.document = originalDocument
	}
})

step('a checkbox with options is a group; without options it stays a boolean', () => {
	const group = { kind: 'checkbox', id: 'g', label: 'pick', options: ['一', '二', '三'], default: ['二'] }
	const solo = { kind: 'checkbox', id: 's', label: 'one', default: true }
	const values = mod.__selftest.initialValues({ elements: [group, solo] })
	assert.deepEqual(values.g, ['二'], 'the group seeds the array of defaults')
	assert.equal(values.s, true, 'the plain checkbox is still a boolean')

	const tree = renderWidget(group, { g: ['一'] })
	assert.ok(classNames(tree).includes('iui-grid'), 'the group lays out like multiselect')
	assert.equal(flatten(tree).filter((node) => node.type === 'input').length, 3, 'one box per option')
	assert.ok(textOf(tree).includes('三'))

	const bare = renderWidget({ kind: 'checkbox', id: 's', label: 'one' }, { s: false })
	assert.ok(!classNames(bare).includes('iui-grid'), 'no options, no group layout')
	assert.equal(flatten(bare).filter((node) => node.type === 'input').length, 1)
})

step('the select is wrapped so it can carry our own chevron', () => {
	const tree = renderWidget({ kind: 'select', id: 'k', label: 'pick', options: ['a', 'b'] }, { k: 'a' })
	assert.ok(classNames(tree).includes('iui-select-wrap'), 'select sits inside the wrapper')
	assert.ok(classNames(tree).includes('iui-select'), 'the control class is unchanged')
})

/* ------------------------------------------------------------------ *
 * required fields, validation and counters (v0.5.0)
 * ------------------------------------------------------------------ */

/** Render the Panel with values we control, instead of seeding them. */
function renderPanel(panelState, values) {
	stateQueue.length = 0
	stateQueue.push(panelState, values, { current: values }, false, '')
	return registrations[0].component({ callId: 'call-1', toolName: 'interactive_ui', phase: 'start' })
}

function primaryButton(tree) {
	return flatten(tree).find((node) => node.type === 'button' && String(node.props.className).includes('iui-btn--primary'))
}

step('an empty required field blocks the submit and names itself', () => {
	const values = mod.__selftest.initialValues(spec)
	const original = globalThis.fetch
	const calls = []
	globalThis.fetch = (url) => {
		calls.push(String(url))
		return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
	}
	try {
		const tree = renderPanel({ status: 'pending', spec }, values)
		const button = primaryButton(tree)
		assert.ok(button, 'the footer submit button renders')
		button.props.onClick()
		assert.equal(calls.length, 0, 'nothing is posted while a required field is empty')
		assert.deepEqual(mod.__selftest.collectMissing(spec.elements, values, [], []), [{ key: 'cred/token', label: 'Token' }])
	} finally {
		globalThis.fetch = original
	}
})

step('a filled required field submits the answer', () => {
	const values = mod.__selftest.initialValues(spec)
	values.cred = { token: 's3cret' }
	const original = globalThis.fetch
	const calls = []
	globalThis.fetch = (url, options) => {
		calls.push({ url: String(url), body: String((options && options.body) || '') })
		return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, action: 'submit', values: { cred: { token: 's3cret' } } }) })
	}
	try {
		const tree = renderPanel({ status: 'pending', spec }, values)
		primaryButton(tree).props.onClick()
		assert.equal(calls.length, 1, 'the answer is posted')
		assert.ok(calls[0].url.includes('/submit'))
		assert.ok(calls[0].body.includes('s3cret'), 'the filled value travels in the body')
	} finally {
		globalThis.fetch = original
	}
})

step('required marker, character counter and the missing mark render', () => {
	const field = { kind: 'input', id: 'name', label: 'Name', required: true, maxlength: 4 }
	const tree = renderWidget(field, { name: 'ab' })
	assert.ok(classNames(tree).includes('iui-req'), 'the required marker is a styled element')
	assert.ok(textOf(tree).includes('2/4'), 'the counter shows used/max')
	assert.ok(!classNames(tree).includes('iui-count is-over') && !classNames(tree).includes('is-over'))
	assert.ok(classNames(renderWidget(field, { name: 'abcdef' })).includes('is-over'), 'past the limit the counter turns red')
	assert.ok(classNames(renderWidget(field, { name: '', __missing: ['name'] })).includes('is-missing'), 'a field the panel marked missing gets the class')
	assert.ok(!classNames(renderWidget(field, { name: 'ab' })).includes('is-missing'))
	assert.ok(!classNames(renderWidget({ kind: 'textarea', id: 't', label: 'T' }, { t: 'x' })).includes('iui-count'), 'no maxlength, no counter')
})

step('a form field keeps its marker, counter and missing mark', () => {
	const form = {
		kind: 'form',
		id: 'cred',
		label: 'Credentials',
		fields: [{ id: 'token', label: 'Token', type: 'textarea', required: true, maxlength: 6 }],
	}
	const tree = renderWidget(form, { cred: { token: 'abc' } })
	assert.ok(classNames(tree).includes('iui-req'))
	assert.ok(textOf(tree).includes('3/6'))
	assert.ok(!classNames(tree).includes('is-missing'))
	assert.ok(classNames(renderWidget(form, { cred: { token: '' }, __missing: ['cred/token'] })).includes('is-missing'))
})

step('collectMissing walks forms and wizard steps in order', () => {
	assert.equal(mod.__selftest.isBlank(''), true)
	assert.equal(mod.__selftest.isBlank('   '), true)
	assert.equal(mod.__selftest.isBlank([]), true)
	assert.equal(mod.__selftest.isBlank(undefined), true)
	assert.equal(mod.__selftest.isBlank('x'), false)
	assert.equal(mod.__selftest.isBlank(0), false)
	const elements = [
		{ kind: 'input', id: 'top', label: 'Top', required: true },
		{ kind: 'wizard', id: 'flow', steps: [{ id: 'one', elements: [{ kind: 'textarea', id: 'why', label: 'Why', required: true }] }] },
		{ kind: 'form', id: 'f', fields: [{ id: 'a', label: 'A', required: true }, { id: 'b', label: 'B' }] },
		{ kind: 'tabs', id: 'tabs', tabs: [{ id: 'x', elements: [{ kind: 'select', id: 'pick', label: 'Pick', required: true, options: ['a'] }] }] },
	]
	const values = { flow: { one: { why: 'because' } }, f: { a: '' }, tabs: { pick: '' } }
	assert.deepEqual(mod.__selftest.collectMissing(elements, values, [], []), [
		{ key: 'top', label: 'Top' },
		{ key: 'f/a', label: 'A' },
		{ key: 'pick', label: 'Pick' },
	])
	// a non-required field never blocks, and one that is filled never blocks
	// (tabs share their parent's base, so their fields live at the top level)
	assert.deepEqual(mod.__selftest.collectMissing(elements, { top: 'x', flow: { one: { why: 'y' } }, f: { a: 'z' }, pick: 'a' }, [], []), [])
	assert.deepEqual(mod.__selftest.collectMissing(elements, { top: 'x', flow: { one: { why: 'y' } }, f: { a: 'z' }, tabs: { pick: 'a' } }, [], []), [{ key: 'pick', label: 'Pick' }])
})

await step('panelClass stamps the host page scheme onto the panel element', () => {
	const originalWindow = globalThis.window
	const originalDocument = globalThis.document
	const selftest = mod.__selftest
	const fakeDocument = () => ({ createElement: () => ({ setAttribute() {} }), body: { appendChild() {}, removeChild() {} } })
	try {
		// no document at all (server-side render, exotic host): stay on the CSS default
		selftest.resetSchemeProbe()
		delete globalThis.document
		assert.equal(selftest.panelClass(), 'iui-panel')

		// a themed page with dark text is a light page
		selftest.resetSchemeProbe()
		globalThis.document = fakeDocument()
		globalThis.window = Object.assign({}, originalWindow, { getComputedStyle: () => ({ color: 'rgb(240, 240, 240)' }) })
		assert.equal(selftest.panelClass(), 'iui-panel is-light')

		// rgba() parses the same way
		selftest.resetSchemeProbe()
		globalThis.window = Object.assign({}, originalWindow, { getComputedStyle: () => ({ color: 'rgba(20, 20, 20, 0.92)' }) })
		assert.equal(selftest.panelClass(), 'iui-panel is-dark')

		// an unreadable token leaves the browser in charge, and the probe is cached
		selftest.resetSchemeProbe()
		globalThis.window = Object.assign({}, originalWindow, { getComputedStyle: () => { throw new Error('nope') } })
		assert.equal(selftest.panelClass(), 'iui-panel')
		assert.equal(selftest.panelClass(), 'iui-panel')
	} finally {
		selftest.resetSchemeProbe()
		globalThis.window = originalWindow
		if (originalDocument === undefined) delete globalThis.document
		else globalThis.document = originalDocument
	}
	// the stylesheet carries both stamps plus the narrow-host rules
	assert.ok(selftest.css.includes('.iui-panel.is-light{color-scheme:light}'))
	assert.ok(selftest.css.includes('.iui-panel.is-dark{color-scheme:dark}'))
	assert.ok(selftest.css.includes('@media (max-width:560px)'))
	assert.ok(selftest.css.includes('.iui-grid{grid-template-columns:1fr !important}'))
})

await step('draft: an answer in progress survives leaving the page', () => {
	const selftest = mod.__selftest
	const store = new Map()
	globalThis.localStorage = {
		getItem: (key) => (store.has(key) ? store.get(key) : null),
		setItem: (key, value) => { store.set(key, String(value)) },
		removeItem: (key) => { store.delete(key) },
	}
	const spec = { elements: [{ kind: 'input', id: 'name', label: '名字' }, { kind: 'switch', id: 'keep', label: '保留' }] }
	const seeded = selftest.initialValues(spec)
	try {
		// nothing stored yet: the panel opens on its defaults, and no draft exists
		assert.deepEqual(selftest.seedWithDraft(spec, 'call-1'), seeded)
		assert.equal(selftest.readDraft('call-1'), null)

		// a half-filled panel is written out and read back merged over the defaults
		selftest.writeDraft('call-1', { name: '周五发布', keep: true })
		assert.deepEqual(selftest.readDraft('call-1'), { name: '周五发布', keep: true })
		assert.deepEqual(selftest.seedWithDraft(spec, 'call-1'), { name: '周五发布', keep: true })

		// the redraw hint never becomes an answer
		selftest.writeDraft('call-1', { name: 'x', __missing: ['name'] })
		assert.equal('__missing' in selftest.readDraft('call-1'), false)

		// answering clears it, so nothing lingers after the answer is in
		selftest.clearDraft('call-1')
		assert.equal(selftest.readDraft('call-1'), null)
		assert.deepEqual(selftest.seedWithDraft(spec, 'call-1'), seeded)

		// an all-default payload is not "user work" and stores nothing
		selftest.writeDraft('call-2', {})
		assert.equal(selftest.readDraft('call-2'), null)

		// drafts are per callId: one panel never leaks into another
		selftest.writeDraft('call-3', { name: 'a' })
		assert.deepEqual(selftest.readDraft('call-4'), null)

		// only the newest DRAFT_MAX callIds keep a draft
		for (let index = 0; index < selftest.DRAFT_MAX + 3; index += 1) selftest.writeDraft('bulk-' + index, { name: String(index) })
		assert.equal(selftest.readDraft('bulk-0'), null, 'the oldest was evicted')
		assert.deepEqual(selftest.readDraft('bulk-' + (selftest.DRAFT_MAX + 2)), { name: String(selftest.DRAFT_MAX + 2) })

		// an oversized draft is skipped whole rather than fighting the quota
		selftest.writeDraft('huge', { name: 'x'.repeat(selftest.DRAFT_MAX_CHARS) })
		assert.equal(selftest.readDraft('huge'), null)

		// merging is deep, but scalars win outright
		assert.deepEqual(selftest.mergeValues({ a: { b: 1, c: 2 } }, { a: { c: 9 } }, 0), { a: { b: 1, c: 9 } })
		assert.deepEqual(selftest.mergeValues({ a: 'old' }, { a: 'new' }, 0), { a: 'new' })
		// past the cap the saved branch is dropped wholesale rather than followed forever
		const deepBase = { a: { b: { c: { d: { e: { f: 1 } } } } } }
		const deepSaved = { a: { b: { c: { d: { e: { f: 2 } } } } } }
		assert.equal(selftest.mergeValues(deepBase, deepSaved, 0).a.b.c.d.e.f, 1, 'depth is capped')

		// a corrupt entry is discarded, not thrown
		store.set('dsh-intelligent-ui:draft:broken', '{not json')
		assert.equal(selftest.readDraft('broken'), null)
	} finally {
		delete globalThis.localStorage
	}
})

await step('draft: a browser without localStorage still renders the panel', () => {
	const selftest = mod.__selftest
	const spec = { elements: [{ kind: 'input', id: 'name', label: '名字' }] }
	const seeded = selftest.initialValues(spec)
	// private mode, file://, and quota-exhausted stores can all throw on touch
	assert.deepEqual(selftest.seedWithDraft(spec, 'call-1'), seeded)
	selftest.writeDraft('call-1', { name: 'ignored' })
	assert.equal(selftest.readDraft('call-1'), null)
	selftest.clearDraft('call-1')
	assert.equal(selftest.stripMissing({ a: 1, __missing: ['a'] }).__missing, undefined)

	globalThis.localStorage = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } }
	try {
		assert.deepEqual(selftest.seedWithDraft(spec, 'call-1'), seeded)
		selftest.writeDraft('call-1', { name: 'x' })
		assert.equal(selftest.readDraft('call-1'), null)
		selftest.clearDraft('call-1')
	} finally {
		delete globalThis.localStorage
	}
})

await step('draft: a saved draft overrides only what it holds', () => {
	const selftest = mod.__selftest
	const store = new Map()
	globalThis.localStorage = {
		getItem: (key) => (store.has(key) ? store.get(key) : null),
		setItem: (key, value) => { store.set(key, String(value)) },
		removeItem: (key) => { store.delete(key) },
	}
	const spec = {
		elements: [
			{ kind: 'input', id: 'name', label: '名字', default: '默认名' },
			{ kind: 'slider', id: 'n', label: '数量', min: 1, max: 10, default: 3 },
			{ kind: 'form', id: 'box', label: '工单', fields: [{ id: 'title', label: '标题', default: 't' }, { id: 'qty', label: '数量', type: 'number', default: 1 }] },
		],
	}
	try {
		// only the slider was touched: the untouched defaults stay put
		selftest.writeDraft('call-1', { n: 8 })
		const merged = selftest.seedWithDraft(spec, 'call-1')
		assert.equal(merged.name, '默认名', 'an untouched field keeps its default')
		assert.equal(merged.n, 8, 'the touched field is restored')
		assert.equal(merged.box.title, 't', 'nested defaults survive a partial draft')
		assert.equal(merged.box.qty, 1)

		// a nested edit restores just that leaf
		selftest.writeDraft('call-1', { box: { title: '登录 500' } })
		const nested = selftest.seedWithDraft(spec, 'call-1')
		assert.equal(nested.box.title, '登录 500')
		assert.equal(nested.box.qty, 1)
		assert.equal(nested.name, '默认名')
	} finally {
		delete globalThis.localStorage
	}
})

console.log('dsh-intelligent-ui client self-test')
console.log(results.join('\n'))
console.log(process.exitCode === 1 ? '\nRESULT: FAILED' : '\nRESULT: PASSED')
