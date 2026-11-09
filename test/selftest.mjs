/**
 * dsh-intelligent-ui — offline self-test.
 *
 * Runs the host half without DSH: a fake cordis context captures the tool
 * definition and the HTTP route, then a real loopback server exercises the
 * whole round trip (panel fetch -> user submit -> blocked tool call resolves).
 *
 *   node test/selftest.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* Hermetic: point the plugin's on-disk state (uploads, history) at a temp home,
 * so a self-test run never writes into the real ~/.dsh. This has to happen
 * before the module is evaluated, which is why the import is dynamic. */
const TEST_HOME = path.join(os.tmpdir(), 'dsh-intelligent-ui-selftest')
process.env.DSH_HOME = TEST_HOME

const { apply, name, inject } = await import('../lib/index.js')

const ROUTE_PREFIX = '/api/dsh-intelligent-ui'

/* ------------------------------------------------------------------ *
 * harness-schema subset check (mirrors dsh-tools json-schema.ts rules)
 * ------------------------------------------------------------------ */

const CONSTRAINT_KEYS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION_KEYS = new Set(['description', 'title', 'default', 'examples'])
const SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'null', 'array', 'object']
const ALLOWED_FOR = {
	properties: ['object'],
	required: ['object'],
	additionalProperties: ['object'],
	items: ['array'],
	enum: ['string', 'number', 'integer', 'boolean', 'null'],
	const: ['string', 'number', 'integer', 'boolean', 'null'],
}

function checkSchema(node, path, violations) {
	if (node === null || typeof node !== 'object' || Array.isArray(node)) {
		violations.push(`${path} must be a schema object`)
		return
	}
	for (const key of Object.keys(node)) {
		if (CONSTRAINT_KEYS.has(key) || ANNOTATION_KEYS.has(key)) continue
		violations.push(`${path}.${key} is not a supported keyword`)
	}
	const hasType = Object.hasOwn(node, 'type')
	const hasOneOf = Object.hasOwn(node, 'oneOf')
	if (hasType && hasOneOf) {
		violations.push(`${path} cannot declare both type and oneOf`)
		return
	}
	if (!hasType && !hasOneOf) return
	if (hasOneOf) {
		if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) violations.push(`${path}.oneOf must have at least two schemas`)
		else node.oneOf.forEach((branch, index) => checkSchema(branch, `${path}.oneOf[${index}]`, violations))
		return
	}
	const type = node.type
	if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
		violations.push(`${path}.type must be one of ${SCHEMA_TYPES.join('/')}`)
		return
	}
	for (const [key, types] of Object.entries(ALLOWED_FOR)) {
		if (Object.hasOwn(node, key) && !types.includes(type)) violations.push(`${path}.${key} is not supported on type "${type}"`)
	}
	if (type === 'object') {
		if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean')
			violations.push(`${path}.additionalProperties must be a boolean`)
		if (Object.hasOwn(node, 'required') && !Array.isArray(node.required))
			violations.push(`${path}.required must be an array`)
		if (Object.hasOwn(node, 'properties')) {
			if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
				violations.push(`${path}.properties must be an object of schemas`)
			} else {
				for (const [key, child] of Object.entries(node.properties)) checkSchema(child, `${path}.properties.${key}`, violations)
			}
		}
	} else if (type === 'array') {
		if (Object.hasOwn(node, 'items')) checkSchema(node.items, `${path}.items`, violations)
	} else if (Object.hasOwn(node, 'enum')) {
		if (!Array.isArray(node.enum) || node.enum.length === 0) violations.push(`${path}.enum must be a non-empty array`)
	}
}

/* ------------------------------------------------------------------ *
 * fake cordis context
 * ------------------------------------------------------------------ */

const captured = {}

const ctx = {
	effect: (factory) => {
		const dispose = factory()
		return typeof dispose === 'function' ? dispose : () => {}
	},
	get: (key) => (key === 'webServer'
		? {
			register: (route) => {
				captured.route = route
				return () => {}
			},
		}
		: key === 'clientModules'
			? {
				graph: () => ({
					rev: 'rev-1',
					entries: [
						{ id: 'dsh-intelligent-ui', url: '/plugins/dsh-intelligent-ui/rev-1/client.js', rev: 'rev-1' },
						{ id: 'other-plugin', url: '/plugins/other-plugin/rev-0/client.js', rev: 'rev-0' },
					],
				}),
				rebuilt: (id) => {
					captured.rebuilt = captured.rebuilt ?? []
					captured.rebuilt.push(id)
					return id === 'dsh-intelligent-ui' ? 'rev-2' : undefined
				},
			}
			: key === 'skills'
				? {
					register: (registration) => {
						captured.skill = registration
						return () => {}
					},
				}
				: key === 'systemPrompt'
					? {
						section: (section) => {
							captured.section = section
							return () => {}
						},
					}
					: key === 'tools'
						? ctx.tools
						: undefined),
	tools: {
		register: (definition) => {
			captured.tools = captured.tools ?? []
			captured.tools.push(definition)
			if (definition.name === 'interactive_ui') captured.tool = definition
			return () => {}
		},
		get: (toolName) => (toolName === 'visualize' && captured.visualize === true ? { name: 'visualize' } : undefined),
	},
}

/* ------------------------------------------------------------------ *
 * http helpers
 * ------------------------------------------------------------------ */

function request(port, method, path, body, headers) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? undefined : JSON.stringify(body)
		const req = http.request({
			host: '127.0.0.1',
			port,
			method,
			path,
			headers: {
				...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
				...(headers ?? {}),
			},
		}, (res) => {
			const chunks = []
			res.on('data', (chunk) => chunks.push(chunk))
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf8')
				let parsed
				try {
					parsed = JSON.parse(text)
				} catch {
					parsed = text
				}
				resolve({ status: res.statusCode, body: parsed })
			})
		})
		req.on('error', reject)
		if (payload !== undefined) req.write(payload)
		req.end()
	})
}

/** Same as request(), but the body is raw bytes (the upload route takes those). */
function rawRequest(port, method, urlPath, payload, headers) {
	return new Promise((resolve, reject) => {
		const req = http.request({
			host: '127.0.0.1',
			port,
			method,
			path: urlPath,
			headers: { 'content-length': payload === undefined ? 0 : payload.length, ...(headers ?? {}) },
		}, (res) => {
			const chunks = []
			res.on('data', (chunk) => chunks.push(chunk))
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf8')
				let parsed
				try {
					parsed = JSON.parse(text)
				} catch {
					parsed = text
				}
				resolve({ status: res.statusCode, body: parsed })
			})
		})
		req.on('error', reject)
		if (payload !== undefined) req.write(payload)
		req.end()
	})
}

/* ------------------------------------------------------------------ *
 * tests
 * ------------------------------------------------------------------ */

const results = []
function step(label, fn) {
	return Promise.resolve()
		.then(fn)
		.then(() => {
			results.push(`  ok   ${label}`)
		})
		.catch((error) => {
			results.push(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
			process.exitCode = 1
		})
}

async function main() {
	// 1. activation
	apply(ctx)

	await step('plugin exports', () => {
		assert.equal(name, 'intelligent-ui')
		assert.deepEqual(inject, ['tools', 'webServer'])
	})

	await step('tool definition schema is inside the harness subset', () => {
		assert.ok(captured.tool, 'tool was not registered')
		assert.equal(captured.tool.name, 'interactive_ui')
		assert.equal(typeof captured.tool.execute, 'function')
		const violations = []
		checkSchema(captured.tool.parameters, 'parameters', violations)
		checkSchema(captured.tool.output.schema, 'output.schema', violations)
		assert.deepEqual(violations, [])
		assert.equal(captured.tool.parameters.type, 'object')
		assert.deepEqual(captured.tool.parameters.required, ['elements'])
		assert.equal(captured.tool.parameters.additionalProperties, false)
	})

	await step('the whole tool family registers inside the harness schema subset', () => {
		assert.deepEqual(
			(captured.tools ?? []).map((entry) => entry.name),
			['interactive_ui', 'interactive_ui_template', 'interactive_ui_history', 'interactive_ui_gallery'],
		)
		for (const entry of captured.tools) {
			const violations = []
			checkSchema(entry.parameters, `${entry.name}.parameters`, violations)
			checkSchema(entry.output.schema, `${entry.name}.output.schema`, violations)
			assert.deepEqual(violations, [], `${entry.name} must stay inside the subset`)
			assert.equal(typeof entry.execute, 'function', `${entry.name} needs an execute`)
			assert.equal(entry.parameters.type, 'object')
			assert.equal(typeof entry.output.render, 'function')
		}
	})

	await step('route registered', () => {
		assert.ok(captured.route, 'route was not registered')
		assert.equal(captured.route.kind, 'prefix')
		assert.equal(captured.route.path, ROUTE_PREFIX)
	})

	const server = http.createServer((req, res) => captured.route.handler(req, res))
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	const port = server.address().port

	const args = {
		title: 'Where should I deploy?',
		subtitle: 'Pick a target and a replica count.',
		allow_cancel: true,
		submit_label: 'Deploy',
		elements: [
			{ kind: 'text', text: 'Staging is safe; production is not.' },
			{ kind: 'radio', id: 'env', label: 'Target', options: [{ value: 'staging', label: 'Staging' }, { value: 'prod', label: 'Production' }], default: 'staging' },
			{ kind: 'slider', id: 'replicas', label: 'Replicas', min: 1, max: 10, step: 1, default: 3 },
			{ kind: 'checkbox', id: 'confirm', label: 'I understand' },
			{ kind: 'form', id: 'cred', label: 'Credentials', fields: [{ id: 'token', label: 'Token', type: 'password' }] },
		],
	}

	const execution = captured.tool.execute(args, {
		callId: 'call-selftest-1',
		name: 'interactive_ui',
		arguments: args,
		signal: new AbortController().signal,
	})

	await step('GET /panel while blocked reports pending with the spec', async () => {
		const response = await request(port, 'GET', `${ROUTE_PREFIX}/panel?callId=call-selftest-1`)
		assert.equal(response.status, 200)
		assert.equal(response.body.status, 'pending')
		assert.equal(response.body.spec.elements.length, 6)
		assert.equal(response.body.spec.elements[5].id, 'user_note')
		assert.equal(response.body.spec.elements[5].kind, 'textarea')
		assert.equal(response.body.spec.submit_label, 'Deploy')
	})

	await step('GET /panel for an unknown callId reports unknown', async () => {
		const response = await request(port, 'GET', `${ROUTE_PREFIX}/panel?callId=nope`)
		assert.equal(response.status, 200)
		assert.deepEqual(response.body, { status: 'unknown' })
	})

	await step('POST /submit resolves the blocked tool call', async () => {
		const response = await request(port, 'POST', `${ROUTE_PREFIX}/submit`, {
			callId: 'call-selftest-1',
			action: 'submit',
			values: { env: 'prod', replicas: 5, confirm: true, cred: { token: 's3cret' } },
		})
		assert.equal(response.status, 200)
		assert.equal(response.body.ok, true)
		const result = await execution
		assert.equal(result.action, 'submit')
		assert.equal(result.cancelled, false)
		assert.equal(result.values.env, 'prod')
		assert.equal(result.values.replicas, 5)
		assert.equal(result.values.cred.token, 's3cret')
	})

	await step('GET /panel afterwards replays the answer', async () => {
		const response = await request(port, 'GET', `${ROUTE_PREFIX}/panel?callId=call-selftest-1`)
		assert.equal(response.body.status, 'answered')
		assert.equal(response.body.action, 'submit')
		assert.equal(response.body.values.env, 'prod')
	})

	await step('double submit is rejected with 409', async () => {
		const response = await request(port, 'POST', `${ROUTE_PREFIX}/submit`, { callId: 'call-selftest-1', action: 'submit', values: {} })
		assert.equal(response.status, 409)
	})

	await step('button elements travel back as (action, button)', async () => {
		const clickArgs = { title: 'Retry?', elements: [{ kind: 'text', text: 'x' }, { kind: 'button', id: 'retry', label: 'Retry' }] }
		const pending = captured.tool.execute(clickArgs, { callId: 'call-selftest-2', name: 'interactive_ui', arguments: clickArgs, signal: new AbortController().signal })
		const posted = await request(port, 'POST', `${ROUTE_PREFIX}/submit`, { callId: 'call-selftest-2', action: 'button', button: 'retry', values: {} })
		assert.equal(posted.status, 200)
		const result = await pending
		assert.equal(result.action, 'button')
		assert.equal(result.button, 'retry')
	})

	await step('every answer-collecting panel carries the forced note box', async () => {
		const api = (await import('../lib/index.js')).__selftest
		const spec = api.buildSpec({ elements: [{ kind: 'text', text: 'x' }] })
		assert.equal(spec.elements.length, 2)
		const note = spec.elements[1]
		assert.equal(note.kind, 'textarea')
		assert.equal(note.id, 'user_note', 'the id must be user_note, never __note')
		assert.equal(note.id.startsWith('__'), false, 'a __-prefixed key would be stripped silently')
		assert.ok(note.label.length > 0)
		assert.ok(spec.note_hint.length > 0, 'the fixed note line rides on the spec')
		assert.equal(note.required, undefined, 'the note is optional')
	})

	await step('the note box is appended last, so index-based templates stay intact', async () => {
		const api = (await import('../lib/index.js')).__selftest
		const spec = api.buildSpec({ elements: [{ kind: 'radio', id: 'pick', options: ['a', 'b'] }] })
		assert.equal(spec.elements[0].id, 'pick', 'the caller element keeps index 0')
		assert.equal(spec.elements[spec.elements.length - 1].id, 'user_note')
	})

	await step('the builder never mutates the caller, even when the args are frozen', async () => {
		const api = (await import('../lib/index.js')).__selftest
		/* The harness deep-freezes its tool arguments. Pushing the note box
		 * straight into raw.elements threw "Cannot add property 1, object is
		 * not extensible" on the very first live panel after 0.9.0 shipped:
		 * every unit test passed because none of them handed in frozen args. */
		const inner = Object.freeze({ kind: 'radio', id: 'pick', label: 'Pick', options: Object.freeze([Object.freeze({ value: 'a', label: 'A' })]) })
		const args = Object.freeze({ elements: Object.freeze([inner]) })
		const spec = api.buildSpec(args)
		assert.equal(spec.elements.length, 2, 'the note box is still appended')
		assert.equal(spec.elements[1].id, 'user_note')
		assert.equal(args.elements.length, 1, 'the caller array is left alone')
	})

	await step('a caller who brings their own user_note keeps ownership of it', async () => {
		const api = (await import('../lib/index.js')).__selftest
		const own = { kind: 'textarea', id: 'user_note', label: 'mine', rows: 5 }
		const spec = api.buildSpec({ elements: [own] })
		assert.equal(spec.elements.length, 1, 'no second box is appended')
		assert.equal(spec.elements[0], own, 'the caller element is not replaced')
	})

	await step('a note box tucked inside a tab counts as the panel note box', async () => {
		const api = (await import('../lib/index.js')).__selftest
		/* Tab children keep the panel's value path (client seedValues and
		 * collectMissing both pass the parent base straight through), so a
		 * user_note inside a tab is the same field as a top-level one. */
		const nested = { kind: 'textarea', id: 'user_note', label: 'tab note' }
		const spec = api.buildSpec({
			elements: [{ kind: 'tabs', id: 'tabs1', tabs: [{ label: 'A', elements: [nested] }, { label: 'B', elements: [] }] }],
		})
		assert.equal(spec.elements.length, 1, 'no second top-level box is appended')
		assert.equal(spec.elements[0].tabs[0].elements[0], nested, 'the nested box is left alone')
		assert.equal(api.hasNoteBox(spec.elements), true)
		assert.equal(typeof spec.note_hint, 'string', 'the fixed line still explains that box')
	})

	await step('a note box inside a wizard step is a different field, so the panel keeps its own', async () => {
		const api = (await import('../lib/index.js')).__selftest
		/* Wizard children live at <wizardId>.<stepId>.<childId>, so they do NOT
		 * share the panel namespace: suppressing the panel-level box would make
		 * the note box appear and disappear as the user walks the steps. */
		const spec = api.buildSpec({
			elements: [{ kind: 'wizard', id: 'wiz', steps: [{ title: 'S1', elements: [{ kind: 'input', id: 'name', label: 'n' }] }] }],
		})
		assert.equal(spec.elements.length, 2, 'the panel-level box is still appended')
		assert.equal(spec.elements[1].id, 'user_note')
	})

	await step('a read-only panel collects nothing, so it gets no note box', async () => {
		const api = (await import('../lib/index.js')).__selftest
		const spec = api.buildSpec({ readonly: true, elements: [{ kind: 'text', text: 'x' }] })
		assert.equal(spec.elements.length, 1)
		assert.equal(api.hasNoteBox(spec.elements), false)
	})

	await step('every template expands with exactly one note box, whatever its comment setting', async () => {
		const api = (await import('../lib/index.js')).__selftest
		const cases = {
			approval: { template: 'approval', items: ['a'] },
			picker: { template: 'picker', items: [{ value: 'A', label: '方案 A' }, 'B'] },
			plan: { template: 'plan', items: [{ title: '第一步', text: '做这个' }] },
			survey: { template: 'survey', questions: [{ id: 'q1', label: '喜欢吗', options: ['喜欢', '不喜欢'] }] },
			form: { template: 'form', fields: [{ id: 'name', label: '名字' }] },
		}
		for (const template of api.TEMPLATES) {
			const spec = api.expandTemplate(cases[template])
			const notes = spec.elements.filter((element) => element.id === 'user_note')
			assert.equal(notes.length, 1, `${template} must carry exactly one note box`)
			assert.equal(spec.elements[spec.elements.length - 1].id, 'user_note', `${template} note goes last`)
			const ids = spec.elements.map((element) => element.id).filter((id) => typeof id === 'string')
			assert.equal(new Set(ids).size, ids.length, `${template} ids stay unique`)
		}
	})

	await step('a template comment box IS the note box, so its text comes back as user_note', async () => {
		const api = (await import('../lib/index.js')).__selftest
		const approval = api.expandTemplate({ template: 'approval' })
		assert.equal(approval.elements.some((element) => element.id === 'comment'), false, 'no legacy comment id')
		assert.equal(approval.elements.filter((element) => element.id === 'user_note').length, 1)
		const explicit = api.expandTemplate({ template: 'approval', comment: false })
		assert.equal(explicit.elements.filter((element) => element.id === 'user_note').length, 1, 'the note is not optional')
	})

	await step('the note box can be switched off from config, restoring the old comment id', async () => {
		const api = (await import('../lib/index.js')).__selftest
		api.applyOptions({ note: false })
		try {
			assert.equal(api.buildSpec({ elements: [{ kind: 'text', text: 'x' }] }).elements.length, 1)
			const approval = api.expandTemplate({ template: 'approval' })
			assert.equal(approval.elements.some((element) => element.id === 'user_note'), false)
			assert.equal(approval.elements.some((element) => element.id === 'comment'), true)
			assert.equal(api.expandTemplate({ template: 'approval', comment_id: 'memo' }).elements.some((element) => element.id === 'memo'), true)
		} finally {
			api.applyOptions(undefined)
		}
	})

	await step('the note wording can be overridden from config', async () => {
		const api = (await import('../lib/index.js')).__selftest
		api.applyOptions({ note_label: '别的想法', note_hint: '写一句' })
		try {
			const spec = api.buildSpec({ elements: [{ kind: 'text', text: 'x' }] })
			assert.equal(spec.elements[1].label, '别的想法')
			assert.equal(spec.note_hint, '写一句')
		} finally {
			api.applyOptions(undefined)
			assert.equal(api.buildSpec({ elements: [{ kind: 'text', text: 'x' }] }).elements[1].label, api.NOTE_LABEL)
		}
	})

	await step('allow_cancel defaults to true, so every panel offers an explicit no', async () => {
		const { buildSpec: build } = (await import('../lib/index.js')).__selftest
		assert.equal(build({ elements: [{ kind: 'text', text: 'x' }] }).allow_cancel, true)
		assert.equal(build({ elements: [{ kind: 'text', text: 'x' }], allow_cancel: false }).allow_cancel, false)
		assert.equal(build({ elements: [{ kind: 'text', text: 'x' }], allow_cancel: true }).allow_cancel, true)
	})

	await step('aborting the turn throws a readable error instead of a silent cancel', async () => {
		const controller = new AbortController()
		const pending = captured.tool.execute({ title: '删掉 X？', elements: [{ kind: 'text', text: 'x' }] }, { callId: 'call-selftest-3', name: 'interactive_ui', arguments: {}, signal: controller.signal })
		controller.abort()
		// The harness replaces a *successful* result with `Error: tool call aborted`
		// once the signal fires; only an error result survives. So the panel must throw,
		// and the message must carry the guidance the model needs.
		const error = await pending.then(
			() => undefined,
			(caught) => caught,
		)
		assert.ok(error instanceof Error, 'an interrupted panel must throw')
		assert.match(error.message, /turn was interrupted/)
		assert.match(error.message, /neither an approval nor a rejection/)
		assert.match(error.message, /interactive_ui_history/)
		assert.match(error.message, /call-selftest-3/)
		assert.match(error.message, /删掉 X？/)
	})

	await step('the interrupted panel is still logged durably as cancelled', async () => {
		const response = await request(port, 'GET', `${ROUTE_PREFIX}/panel?callId=call-selftest-3`)
		assert.equal(response.body.status, 'answered')
		assert.equal(response.body.action, 'cancelled')
	})

	await step('an unsupported element kind is rejected', async () => {
		await assert.rejects(
			() => captured.tool.execute({ elements: [{ kind: 'nope' }] }, { callId: 'call-selftest-4', name: 'interactive_ui', arguments: {}, signal: new AbortController().signal }),
			/kind must be one of/,
		)
	})

	await step('a non-loopback request is refused', async () => {
		const response = await request(port, 'GET', `${ROUTE_PREFIX}/panel?callId=call-selftest-1`, undefined, { 'x-forwarded-for': '10.0.0.1' })
		assert.equal(response.status, 403)
	})

	await step('an unknown route is 404', async () => {
		const response = await request(port, 'GET', `${ROUTE_PREFIX}/nope`)
		assert.equal(response.status, 404)
	})

	await step('a malformed body is 400', async () => {
		const response = await request(port, 'POST', `${ROUTE_PREFIX}/submit`, undefined, { 'content-type': 'application/json' })
		assert.equal(response.status, 404) // empty body -> {} -> unknown panel
	})

	await step('read-only panels answer "display" at once and keep their record', async () => {
		const readonlyArgs = { title: 'Look at this', readonly: true, elements: [{ kind: 'text', text: 'no question' }] }
		const result = await captured.tool.execute(readonlyArgs, {
			callId: 'call-selftest-ro',
			name: 'interactive_ui',
			arguments: readonlyArgs,
			signal: new AbortController().signal,
		})
		assert.equal(result.action, 'display')
		assert.equal(result.cancelled, false)
		const response = await request(port, 'GET', `${ROUTE_PREFIX}/panel?callId=call-selftest-ro`)
		assert.equal(response.body.status, 'display')
		assert.equal(response.body.spec.readonly, true)
	})

	await step('the gallery tool renders every widget without blocking', async () => {
		const gallery = captured.tools.find((entry) => entry.name === 'interactive_ui_gallery')
		const result = await gallery.execute({}, { callId: 'call-gallery', name: 'interactive_ui_gallery', arguments: {}, signal: new AbortController().signal })
		assert.equal(result.action, 'display')
		assert.ok(result.shown >= 15, `gallery should show the whole component set, got ${result.shown}`)
		const response = await request(port, 'GET', `${ROUTE_PREFIX}/panel?callId=call-gallery`)
		assert.equal(response.body.status, 'display')
		assert.equal(response.body.spec.readonly, true)
		assert.equal(response.body.spec.elements.length, result.shown)
		const compact = await gallery.execute({ compact: true }, { callId: 'call-gallery-compact', name: 'interactive_ui_gallery', arguments: {}, signal: new AbortController().signal })
		assert.ok(compact.shown < result.shown, 'compact drops the tall demos')
	})

	await step('POST /upload stores bytes on disk and hands back a real path', async () => {
		const uploadArgs = { title: 'Attach a file', elements: [{ kind: 'upload', id: 'files', label: 'Files' }] }
		const pending = captured.tool.execute(uploadArgs, {
			callId: 'call-selftest-up',
			name: 'interactive_ui',
			arguments: uploadArgs,
			signal: new AbortController().signal,
			agent: { id: 'session-selftest' },
		})
		const bytes = Buffer.from('hello from the upload self-test\n', 'utf8')
		const uploaded = await rawRequest(port, 'POST', `${ROUTE_PREFIX}/upload?callId=call-selftest-up&name=hello.txt`, bytes, { 'content-type': 'text/plain' })
		assert.equal(uploaded.status, 200)
		assert.equal(uploaded.body.ok, true)
		const file = uploaded.body.file
		assert.ok(path.isAbsolute(file.path), 'the answer carries an absolute path')
		assert.ok(file.path.startsWith(TEST_HOME), 'uploads land under DSH_HOME')
		assert.equal(file.size, bytes.length)
		assert.equal(fs.readFileSync(file.path, 'utf8'), bytes.toString('utf8'))

		await request(port, 'POST', `${ROUTE_PREFIX}/submit`, { callId: 'call-selftest-up', action: 'submit', values: { files: [file] } })
		const result = await pending
		assert.equal(result.values.files[0].path, file.path)
	})

	await step('uploads are refused for unknown and already-answered panels', async () => {
		assert.equal((await rawRequest(port, 'POST', `${ROUTE_PREFIX}/upload?callId=nope&name=x.bin`, Buffer.from('x'))).status, 404)
		assert.equal((await rawRequest(port, 'POST', `${ROUTE_PREFIX}/upload?callId=call-selftest-up&name=x.bin`, Buffer.from('x'))).status, 409)
	})

		await step('the history tool replays answered panels and filters by session', async () => {
		const history = captured.tools.find((entry) => entry.name === 'interactive_ui_history')
		const signal = new AbortController().signal
		const result = await history.execute({ limit: 10 }, { callId: 'call-history', name: 'interactive_ui_history', arguments: {}, signal })
		assert.ok(Array.isArray(result.entries))
		assert.ok(result.entries.length >= 1, 'the submitted panels were logged')
		assert.ok(result.entries.some((entry) => entry.title === 'Where should I deploy?'), 'titles are searchable')
		assert.equal(result.history_file, path.join(TEST_HOME, 'plugin-data', 'dsh-intelligent-ui', 'history.jsonl'))
		const filtered = await history.execute({}, { callId: 'call-history-2', name: 'interactive_ui_history', arguments: {}, signal, agent: { id: 'session-selftest' } })
		assert.ok(filtered.entries.length >= 1, 'session filtering finds that session')
		const other = await history.execute({ all_sessions: true }, { callId: 'call-history-3', name: 'interactive_ui_history', arguments: {}, signal, agent: { id: 'session-other' } })
		assert.ok(other.entries.length >= filtered.entries.length)

		// The list still comes back as data, but the call also leaves a read-only
		// snapshot panel behind so the user can page through what they answered.
		const view = await history.execute({ limit: 10 }, { callId: 'call-history-view', name: 'interactive_ui_history', arguments: {}, signal })
		assert.ok(typeof view.shown === 'number' && view.shown >= 1, 'the view reports how many entries it drew')
		const panel = await request(port, 'GET', `${ROUTE_PREFIX}/panel?callId=call-history-view`)
		assert.equal(panel.status, 200)
		assert.equal(panel.body.status, 'display', 'the history panel is read-only, never pending')
		assert.equal(panel.body.spec.readonly, true)
		const kinds = panel.body.spec.elements.map((element) => element.kind)
		assert.deepEqual(kinds.includes('tabs') || kinds.includes('text'), true, 'the snapshot uses real widgets')
		assert.equal(kinds.includes('tabs') || false, true, 'a non-empty history pages through tabs')
		const pages = panel.body.spec.elements.find((element) => element.kind === 'tabs')
		assert.ok(Array.isArray(pages.tabs) && pages.tabs.length >= 1)
		assert.ok(pages.tabs.every((tab) => Array.isArray(tab.elements) && tab.elements[0].kind === 'timeline'))
		const timeline = pages.tabs[0].elements[0]
		assert.ok(Array.isArray(timeline.items) && timeline.items.length >= 1)
		assert.ok(timeline.items.every((item) => typeof item.title === 'string' && item.title.length > 0))

		// view:false keeps the tool card as plain JSON and draws no panel.
		const plain = await history.execute({ view: false }, { callId: 'call-history-plain', name: 'interactive_ui_history', arguments: {}, signal })
		assert.equal(plain.shown, undefined, 'view:false must not claim a panel')
		const missing = await request(port, 'GET', `${ROUTE_PREFIX}/panel?callId=call-history-plain`)
		assert.equal(missing.body.status, 'unknown', 'view:false leaves no record behind')

		// `limit` truncates the list, but the snapshot must still know how much
		// log there is — otherwise "you are seeing the newest N" can never be said.
		const clipped = await history.execute({ limit: 1 }, { callId: 'call-history-clip', name: 'interactive_ui_history', arguments: {}, signal })
		assert.equal(clipped.entries.length, 1, 'limit caps the entries')
		assert.ok(clipped.log_total > clipped.entries.length, 'log_total counts past the limit')
		assert.equal(clipped.count, clipped.entries.length, 'count still describes what came back')
		const clippedWarn = (await request(port, 'GET', `${ROUTE_PREFIX}/panel?callId=call-history-clip`)).body.spec.elements
			.filter((element) => element.kind === 'text' && element.tone === 'warn')
		assert.equal(clippedWarn.length, 1, 'a clipped snapshot says so in one warning line')
		assert.match(clippedWarn[0].text, /只画了最近 1 条（日志里共有 \d+ 条）/)
	})

	await step('the history snapshot pages the log without ever writing to it', async () => {
		const { historySpec, historyStamp, historyValueText, HISTORY_PAGE_SIZE, HISTORY_VIEW_MAX } = (await import('../lib/index.js')).__selftest
		const entry = (index) => ({
			at: `2026-11-06T0${index % 10}:32:08.000Z`,
			callId: `c-${index}`,
			title: `panel ${index}`,
			action: index % 3 === 0 ? 'cancelled' : 'submit',
			button: '',
			values: { env: index === 0 ? 'prod' : '', tags: ['a', 'b'] },
		})
		const many = Array.from({ length: HISTORY_PAGE_SIZE * 2 + 3 }, (_, index) => entry(index))
		const spec = historySpec(many, { total: 100, all_sessions: false })
		assert.equal(spec.readonly, true)
		const tabs = spec.elements.find((element) => element.kind === 'tabs')
		assert.equal(tabs.tabs.length, 3, 'paging splits the list')
		assert.equal(tabs.tabs[0].elements[0].items.length, HISTORY_PAGE_SIZE)
		assert.ok(spec.elements.some((element) => element.kind === 'text' && element.tone === 'warn'), 'a truncated list says so')
		assert.match(spec.subtitle, /3 页/)
		assert.match(spec.subtitle, /本会话/)

		const capped = historySpec(Array.from({ length: HISTORY_VIEW_MAX + 20 }, (_, index) => entry(index)), { total: 400 })
		const cappedTabs = capped.elements.find((element) => element.kind === 'tabs')
		assert.equal(cappedTabs.tabs.length, Math.ceil(HISTORY_VIEW_MAX / HISTORY_PAGE_SIZE), 'the view caps how much it draws')

		const unreadable = historySpec([], { total: 0 })
		assert.equal(unreadable.readonly, true)
		assert.equal(unreadable.elements.length, 1)
		assert.equal(unreadable.elements[0].kind, 'text')

		const junk = historySpec([null, 'nope', { title: '  ' }], { total: 3 })
		assert.equal(junk.elements[0].kind, 'tabs', 'junk entries still page')

		assert.equal(historyStamp('2026-11-06T19:32:08.123Z').length, 11, 'MM-DD HH:mm')
		assert.equal(historyStamp('not a date'), 'not a date', 'an unparsable stamp is passed through')
		assert.equal(historyStamp(undefined), '')
		assert.equal(historyValueText({ env: 'prod' }), 'env=prod')
		assert.equal(historyValueText({ tags: [] }), 'tags=空')
		assert.equal(historyValueText({ form: { a: 1, b: 2 } }), 'form=2 字段')
		assert.equal(historyValueText({ a: 1, b: 2, c: 3, d: 4 }), 'a=1, b=2, c=3, +1')
		assert.equal(historyValueText({}), '')
		assert.equal(historyValueText(null), '')
		assert.match(historyValueText({ note: 'x'.repeat(80) }), /…$/, 'long values are clipped')

		// Reading history must never append to it.
		const historyTool = captured.tools.find((entry) => entry.name === 'interactive_ui_history')
		const signal = new AbortController().signal
		await historyTool.execute({ limit: 5 }, { callId: 'call-history-nolog', name: 'interactive_ui_history', arguments: {}, signal })
		await historyTool.execute({ limit: 5 }, { callId: 'call-history-nolog-2', name: 'interactive_ui_history', arguments: {}, signal })
		const after = await historyTool.execute({ limit: 500, view: false }, { callId: 'call-history-nolog-3', name: 'interactive_ui_history', arguments: {}, signal })
		const viewed = after.entries.filter((item) => typeof item.callId === 'string' && item.callId.startsWith('call-history-nolog'))
		assert.equal(viewed.length, 0, 'replaying history must not record itself')
	})

	await step('GET /modules reports the published client bundle generations', async () => {
		const response = await request(port, 'GET', `${ROUTE_PREFIX}/modules`)
		assert.equal(response.status, 200)
		assert.equal(response.body.ok, true)
		assert.equal(response.body.rev, 'rev-1')
		assert.deepEqual(response.body.entries.map((entry) => entry.id), ['dsh-intelligent-ui', 'other-plugin'])
		assert.equal(response.body.entries[0].rev, 'rev-1')
	})

	await step('POST /refresh republishes this package and leaves others alone', async () => {
		captured.rebuilt = []
		const response = await request(port, 'POST', `${ROUTE_PREFIX}/refresh`)
		assert.equal(response.status, 200)
		assert.equal(response.body.ok, true)
		const own = response.body.results.find((entry) => entry.id === 'dsh-intelligent-ui')
		assert.equal(own.rev, 'rev-2', 'the new generation is reported')
		assert.deepEqual(captured.rebuilt, ['dsh-intelligent-ui'], 'only this package is rebuilt')
	})

	await step('the dev routes keep the loopback fence', async () => {
		assert.equal((await request(port, 'GET', `${ROUTE_PREFIX}/modules`, undefined, { origin: 'http://evil.example' })).status, 403)
		assert.equal((await request(port, 'POST', `${ROUTE_PREFIX}/refresh`, undefined, { 'x-forwarded-for': '10.0.0.1' })).status, 403)
	})

	await step('every supported kind is documented and demonstrated', async () => {
		const { KINDS: kinds, GALLERY_SPEC: gallery, DESCRIPTION: description } = (await import('../lib/index.js')).__selftest
		const shown = []
		const walk = (elements) => {
			for (const element of elements ?? []) {
				if (element === null || typeof element !== 'object' || Array.isArray(element)) continue
				if (typeof element.kind === 'string') shown.push(element.kind)
				walk(element.elements)
				for (const tab of element.tabs ?? []) walk(tab.elements)
				for (const wizardStep of element.steps ?? []) walk(wizardStep.elements)
			}
		}
		walk(gallery.elements)
		for (const kind of kinds) {
			assert.ok(shown.includes(kind), `the gallery has no ${kind} demo`)
			assert.ok(new RegExp(`(^|\\n)- [^\\n]*\\b${kind}\\b`).test(description), `${kind} is undocumented in the tool description`)
		}
		for (const kind of shown) assert.ok(kinds.includes(kind), `the gallery demos the unsupported kind ${kind}`)
	})

	await step('every panel template is documented and expands into a valid spec', async () => {
		const api = (await import('../lib/index.js')).__selftest
		const cases = {
			approval: { template: 'approval', title: '删除 3 个分支', items: ['a', 'b'], intro: '**不可撤销**' },
			picker: { template: 'picker', title: '选一个方案', items: [{ value: 'A', label: '方案 A', description: '快' }, 'B'] },
			plan: { template: 'plan', title: '计划', items: [{ title: '第一步', text: '做这个' }, '第二步'] },
			survey: {
				template: 'survey',
				title: '问卷',
				questions: [{ id: 'q1', label: '喜欢吗', options: ['喜欢', '不喜欢'] }, { id: 'q2', label: '为什么', rows: 2 }],
			},
			form: {
				template: 'form',
				title: '表单',
				fields: [{ id: 'name', label: '名字', required: true }, { id: 'when', label: '日期', type: 'date' }],
			},
		}
		for (const template of api.TEMPLATES) {
			assert.ok(new RegExp(`(^|\\n)- ${template}\\b`).test(api.TEMPLATE_DESCRIPTION), `${template} is undocumented in the template tool`)
			const spec = api.expandTemplate(cases[template])
			assert.ok(Array.isArray(spec.elements) && spec.elements.length > 0, `${template} expanded to nothing`)
			assert.equal(spec.allow_cancel, true, `${template} templates are cancellable by default`)
			const ids = []
			const walk = (elements) => {
				for (const element of elements ?? []) {
					assert.ok(api.KINDS.includes(element.kind), `${template} produced the unsupported kind ${element.kind}`)
					if (typeof element.id === 'string') ids.push(element.id)
					walk(element.elements)
					for (const tab of element.tabs ?? []) walk(tab.elements)
					for (const wizardStep of element.steps ?? []) walk(wizardStep.elements)
				}
			}
			walk(spec.elements)
			assert.equal(new Set(ids).size, ids.length, `${template} produced duplicate element ids`)
			assert.ok(JSON.stringify(spec).length < 200_000)
		}
		// the main choice of every choice-driven template is required, so an
		// untouched panel can never submit an empty decision
		for (const template of ['approval', 'picker', 'plan']) {
			const spec = api.expandTemplate(cases[template])
			const main = spec.elements.find((element) => element.kind === 'radio' || element.kind === 'table')
			assert.equal(main.required, true, `${template} must require its main choice`)
		}
		// a long picker switches to a table, a short one stays cards
		assert.equal(api.expandTemplate({ template: 'picker', items: ['a', 'b'] }).elements[0].kind, 'radio')
		assert.equal(api.expandTemplate({ template: 'picker', items: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }).elements[0].kind, 'table')
		// tall/empty/malformed input is rejected with a readable message
		assert.throws(() => api.expandTemplate({ template: 'nope' }), /template must be one of/)
		assert.throws(() => api.expandTemplate({ template: 'survey' }), /needs questions/)
		assert.throws(() => api.expandTemplate({ template: 'form', fields: [] }), /needs fields/)
		assert.throws(() => api.expandTemplate({ template: 'form', fields: [{ id: 'a', label: 'A', type: 'weird' }] }), /is not supported/)
		assert.throws(() => api.expandTemplate({ template: 'picker' }), /needs items/)
	})

	await step('the template tool is registered and inside the schema subset', async () => {
		const template = captured.tools.find((entry) => entry.name === 'interactive_ui_template')
		assert.ok(template, 'interactive_ui_template is registered')
		const violations = []
		checkSchema(template.parameters, 'parameters', violations)
		checkSchema(template.output.schema, 'output.schema', violations)
		assert.deepEqual(violations, [])
		assert.deepEqual(template.parameters.required, ['template'])
		assert.ok(template.parameters.properties.template.enum.includes('approval'))
		assert.equal(typeof template.execute, 'function')
	})

	const api = (await import('../lib/index.js')).__selftest

	await step('the runtime skill is registered with everything the catalog needs', () => {
		assert.ok(captured.skill, 'no skill was registered')
		assert.equal(captured.skill.name, 'interactive-ui')
		assert.equal(captured.skill.source, 'runtime', 'the harness renders source, so it must not be undefined')
		assert.ok(captured.skill.description.length > 80, 'the description must stand on its own')
		assert.match(captured.skill.description, /interactive_ui/)
		assert.match(captured.skill.whenToUse, /decide|approve/)
		assert.match(captured.skill.content, /interactive_ui_template/)
		assert.match(captured.skill.content, /interactive_ui_history/)
		assert.match(captured.skill.content, /\{ action, button, values, cancelled \}/)
		assert.match(captured.skill.content, /__/)
		// an interrupted turn must never read as consent — the skill has to say so
		assert.match(captured.skill.content, /When the turn is interrupted/)
		assert.match(captured.skill.content, /neither an approval nor a rejection/)
		assert.match(captured.skill.content, /cancelled.*interrupted/)
		// the routing test lives in the skill too: one question separates the two surfaces
		assert.match(captured.skill.content, /## Panel or card/)
		assert.match(captured.skill.content, /do you need their answer before you can continue\?/)
		assert.match(captured.skill.content, /can \*show\* but can never \*ask\*/)
	})

	await step('the prompt section is short, always present, and points at the skill', () => {
		assert.ok(captured.section, 'no prompt section was registered')
		assert.equal(captured.section.name, 'plugin:intelligent-ui')
		assert.equal(captured.section.order, 4000)
		assert.equal(typeof captured.section.text, 'function')
		const text = captured.section.text()
		assert.match(text, /interactive_ui/)
		assert.match(text, /interactive_ui_template/)
		assert.ok(text.length < 640, `the section must stay small, got ${text.length} chars`)
		// the always-on section must not carry the widget reference or a schema dump
		assert.doesNotMatch(text, /wizard|slider|multiselect/)
		assert.doesNotMatch(text, /parameters|schema/i)
		// the always-on note must warn that an interrupted panel is not consent
		assert.match(text, /interrupted/)
		assert.match(text, /not consent/)
	})

	await step('a late-mounted skill service is waited for instead of skipped', () => {
		const calls = []
		const registered = []
		const services = {}
		const lateCtx = {
			effect: (factory) => { const dispose = factory(); return typeof dispose === 'function' ? dispose : () => {} },
			get: (key) => (services[key] !== undefined ? services[key] : (key === 'tools' ? { register: () => () => {}, get: () => undefined } : undefined)),
			tools: { register: () => () => {} },
			inject: (names, callback) => {
				calls.push(names)
				if (names[0] === 'skills') services.skills = { register: (skill) => { registered.push(skill); return () => {} } }
				queueMicrotask(() => callback({ get: (key) => services[key] }))
				return () => {}
			},
		}
		apply(lateCtx)
		assert.deepEqual(calls, [['skills'], ['systemPrompt']], 'both optional services are waited for')
		return new Promise((resolve) => setTimeout(() => {
			assert.equal(registered.length, 1)
			assert.equal(registered[0].name, 'interactive-ui')
			resolve()
		}, 0))
	})

	await step('a missing service without inject is a warning, not a broken plugin', () => {
		const warnings = []
		const bare = {
			effect: (factory) => { const dispose = factory(); return typeof dispose === 'function' ? dispose : () => {} },
			get: (key) => (key === 'logger' ? { warn: (message) => warnings.push(message) } : undefined),
			tools: { register: () => () => {} },
		}
		apply(bare)
		const optional = warnings.filter((message) => /no (skills|systemPrompt) service/.test(message))
		assert.equal(optional.length, 2, 'one warning per unavailable optional service')
		assert.match(optional[0], /no skills service/)
		assert.match(optional[1], /no systemPrompt service/)
	})

	await step('a throwing service cannot take the plugin (and the web boot) down', () => {
		const warnings = []
		const angry = {
			effect: (factory) => { const dispose = factory(); return typeof dispose === 'function' ? dispose : () => {} },
			get: (key) => (key === 'logger' ? { warn: (message) => warnings.push(message) }
				: key === 'skills' ? { register: () => { throw new Error('duplicate skill') } }
					: key === 'systemPrompt' ? { section: () => { throw new Error('duplicate section') } }
						: undefined),
			tools: { register: () => { throw new Error('duplicate tool') } },
		}
		apply(angry)
		assert.ok(warnings.some((message) => /failed to register interactive_ui/.test(message)), 'a failed tool is reported')
		assert.ok(warnings.some((message) => /skills wiring failed/.test(message)), 'a failed skill is reported')
		assert.ok(warnings.some((message) => /systemPrompt wiring failed/.test(message)), 'a failed section is reported')
	})

	await step('the visualize mention appears only when that plugin is mounted', () => {
		const withVisualize = {
			get: (key) => (key === 'tools' ? { get: (toolName) => (toolName === 'visualize' ? { name: 'visualize' } : undefined) } : undefined),
		}
		const withoutVisualize = { get: () => undefined }
		const both = api.capabilityText(withVisualize)
		const panel = api.capabilityText(withoutVisualize)
		assert.match(both, /visualize renders a card the user explores on their own/)
		assert.match(both, /not interchangeable/)
		assert.doesNotMatch(panel, /visualize/)
		assert.match(panel, /the interactive_ui tool family/)
		assert.match(panel, /instead of asking in prose/)
		// both variants must state the one routing question — it is the whole point
		// of naming two surfaces in the first place
		assert.match(both, /do you need their answer before you can continue\?/)
		assert.match(panel, /do you need their answer before you can continue\?/)
		// the routing tail may only name the surfaces that are actually mounted
		assert.match(both, /the value is in seeing it: a card/)
		assert.doesNotMatch(panel, /a card/)
		assert.match(panel, /No: do not ask at all/)
		// the registered section is the same function, re-evaluated per turn
		captured.visualize = true
		assert.match(captured.section.text(), /visualize/)
		captured.visualize = false
		assert.doesNotMatch(captured.section.text(), /visualize/)
		// a broken tools service must not take the section down with it
		assert.match(api.capabilityText({ get: () => { throw new Error('nope') } }), /interactive_ui/)
	})

	await new Promise((resolve) => server.close(resolve))

	console.log('dsh-intelligent-ui self-test')
	console.log(results.join('\n'))
	console.log(process.exitCode === 1 ? '\nRESULT: FAILED' : '\nRESULT: PASSED')
}

await main()
