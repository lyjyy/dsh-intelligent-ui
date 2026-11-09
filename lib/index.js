/**
 * dsh-intelligent-ui — host half.
 *
 * Registers the model-facing tools (`interactive_ui`, `interactive_ui_history`,
 * `ui_gallery`) plus a loopback-only HTTP bridge. `interactive_ui` blocks until
 * the user answers the panel that the browser half renders inside the
 * conversation; the answer comes back as the tool result. `ui_gallery` is the
 * read-only component-library page.
 *
 * Imports are Node builtins only (no `@deepseek-ai/*`), so the package resolves
 * from any profile: every harness service arrives through the cordis context.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Wire name of the main tool. Must not collide with a shipped tool name. */
const TOOL_NAME = 'interactive_ui'
/** Package name: also the client-module id in the web boot graph. */
const PACKAGE_NAME = 'dsh-intelligent-ui'
/** Wire name of the read-only component-library tool. */
const GALLERY_TOOL_NAME = 'interactive_ui_gallery'
/** Wire name of the "what did I already ask?" tool. */
const HISTORY_TOOL_NAME = 'interactive_ui_history'
const TEMPLATE_TOOL_NAME = 'interactive_ui_template'
/** Prefix of the HTTP bridge used by the browser half. */
const ROUTE_PREFIX = '/api/dsh-intelligent-ui'
/** Hard cap on one panel document. */
const MAX_SPEC_BYTES = 200_000
/** Hard cap on one submitted answer body. */
const MAX_BODY_BYTES = 256 * 1024
/** Hard cap on one uploaded file. */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024
/** Kept records, so a remounted/restored view can still replay its answer. */
const MAX_RECORDS = 200
/** History lines read back by the history tool (newest kept). */
const MAX_HISTORY_READ = 500

/**
 * Harness home, resolved the same way `@deepseek-ai/dsh-home-paths` does for the
 * default case (an explicit configured home is the only case we cannot see).
 */
const HOME =
	typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0
		? process.env.DSH_HOME.trim()
		: join(homedir(), '.dsh')
/** Where uploaded files land. */
const UPLOAD_DIR = join(HOME, 'cache', 'dsh-intelligent-ui', 'uploads')
/** Durable log of answered panels, so an answer outlives the process. */
const HISTORY_FILE = join(HOME, 'plugin-data', 'dsh-intelligent-ui', 'history.jsonl')

/** Element kinds the browser half knows how to draw. */
const KINDS = [
	'text', 'link', 'button', 'markdown',
	'select', 'radio', 'multiselect',
	'checkbox', 'switch', 'slider', 'number',
	'input', 'date', 'time', 'textarea', 'path', 'form',
	'table', 'wizard', 'chart', 'upload',
	'diff', 'timeline', 'tree', 'progress', 'tabs',
]

/**
 * The always-on note box. It is appended to every answer-collecting panel so
 * the user can always say "none of these options is right" instead of picking
 * the least bad one. The id must NOT start with `__`: the browser half strips
 * `__`-prefixed keys before the answer travels back, which would turn the note
 * into a silent, always-empty field.
 */
const NOTE_ID = 'user_note'
/* Two characters on purpose: the fixed line right under the box already says
 * what the box is for, so a long label restates it and reads as two competing
 * explanations stacked on top of each other. */
const NOTE_LABEL = '备注'
const NOTE_HINT = '选项不合意？不用勉强选——可以在这里提意见、补充新需求，或直接说清你真正想要的是什么。'

/**
 * Runtime options, seeded with the defaults and overwritten by apply() from the
 * `config:` block of cordis.patch.yml. Kept as a plain object so the package
 * keeps its zero-dependency footprint (no schemastery import).
 */
const options = {
	note: true,
	noteLabel: NOTE_LABEL,
	noteHint: NOTE_HINT,
}

function applyOptions(config) {
	const raw = config !== null && typeof config === 'object' ? config : {}
	options.note = raw.note !== false
	options.noteLabel = textOption(raw.note_label, NOTE_LABEL)
	options.noteHint = textOption(raw.note_hint, NOTE_HINT)
}

/** Whether the forced note box is currently switched on. */
function noteOn() {
	return options.note !== false
}

const NESTED_DEPTH = 3

/**
 * Whether this element list already carries a note box (template or caller
 * supplied). Nested containers are scanned only where they share the panel's
 * value namespace: `tabs` children keep the parent path (see client seedValues
 * and collectMissing), so a `user_note` inside a tab IS the same field as a
 * top-level one — appending another would bind two widgets to one key and one
 * of them would silently overwrite the other.
 *
 * Wizard steps and form fields are deliberately NOT scanned: they nest under
 * their own id (`<wizard>.<step>.<child>`, `<form>.<field>`), so a note box in
 * there is a different field at a different path. Suppressing the panel-level
 * box for them would leave a panel whose visible note box depends on which
 * step or tab the user happens to be looking at.
 */
function hasNoteBox(elements, depth = 0) {
	if (!Array.isArray(elements) || depth > NESTED_DEPTH) return false
	return elements.some((element) => {
		if (element === null || typeof element !== 'object') return false
		if (element.id === NOTE_ID) return true
		if (element.kind !== 'tabs' || !Array.isArray(element.tabs)) return false
		return element.tabs.some((tab) => hasNoteBox(tab !== null && typeof tab === 'object' ? tab.elements : null, depth + 1))
	})
}

/** The note box element itself. The wording travels on the spec (`spec.note`),
 * so the browser half never hard-codes a second copy of it. */
function noteBox() {
	return { kind: 'textarea', id: NOTE_ID, label: options.noteLabel, rows: 2 }
}

/** callId -> { spec, status, action, values, settle } */
const records = new Map()

/**
 * Host service that owns the web boot graph. Captured in apply() so the dev
 * routes can re-publish this package's browser bundle without restarting DSH.
 */
let clientModules

function remember(callId, record) {
	records.set(callId, record)
	while (records.size > MAX_RECORDS) {
		const oldest = records.keys().next().value
		if (oldest === undefined) break
		records.delete(oldest)
	}
}

/* ------------------------------------------------------------------ *
 * spec
 * ------------------------------------------------------------------ */

function buildSpec(args) {
	const raw = args !== null && typeof args === 'object' ? args : {}
	/* Copy, never alias: the harness hands us frozen args (its own tool-call
	 * payloads are deep-frozen), so pushing the note box into raw.elements
	 * throws "Cannot add property N, object is not extensible". The caller's
	 * array also stays untouched, which is what a pure-ish builder should do. */
	const elements = Array.isArray(raw.elements) ? raw.elements.slice() : []
	elements.forEach((element, index) => {
		if (element === null || typeof element !== 'object' || Array.isArray(element))
			throw new Error(`${TOOL_NAME}: elements[${index}] must be an object`)
		const kind = element.kind
		if (typeof kind !== 'string' || !KINDS.includes(kind))
			throw new Error(`${TOOL_NAME}: elements[${index}].kind must be one of ${KINDS.join(', ')}`)
	})
	const readonly = raw.readonly === true
	/* The forced note box: every panel that collects an answer gets one, so the
	 * user is never cornered into picking an option they do not want. Read-only
	 * panels collect nothing, and a caller who already placed a `user_note`
	 * element keeps ownership of it. Appended (never prepended) so index-based
	 * templates and "the first radio is the main choice" stay intact. */
	if (noteOn() && !readonly && !hasNoteBox(elements)) elements.push(noteBox())
	/* The fixed line above the buttons. It rides on the spec (not on the merged
	 * client bundle) so the wording can be retuned from config without a rebuild,
	 * and so it disappears together with the box it explains. */
	const noteHint = noteOn() && !readonly && hasNoteBox(elements) ? options.noteHint : ''
	const spec = {
		title: typeof raw.title === 'string' ? raw.title : '',
		subtitle: typeof raw.subtitle === 'string' ? raw.subtitle : '',
		elements,
		submit_label: typeof raw.submit_label === 'string' ? raw.submit_label : '',
		cancel_label: typeof raw.cancel_label === 'string' ? raw.cancel_label : '',
		allow_cancel: raw.allow_cancel !== false,
		readonly,
	}
	if (noteHint.length > 0) spec.note_hint = noteHint
	const size = JSON.stringify(spec).length
	if (size > MAX_SPEC_BYTES)
		throw new Error(`${TOOL_NAME}: panel is too large (${size} bytes, limit ${MAX_SPEC_BYTES})`)
	return spec
}

/* ------------------------------------------------------------------ *
 * http helpers (loopback fence + bounded JSON, same shape as the harness)
 * ------------------------------------------------------------------ */

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '::1', '[::1]']

function isLoopbackHost(value) {
	try {
		return LOOPBACK_NAMES.includes(new URL(`http://${value}`).hostname)
	} catch {
		return false
	}
}

/** Refuse anything that did not come from the local GUI itself. */
function isTrustedRequest(req) {
	const headers = req.headers ?? {}
	if (headers['x-forwarded-for'] !== undefined || headers.forwarded !== undefined) return false
	const address = req.socket?.remoteAddress
	if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
	const host = headers.host
	if (typeof host === 'string' && host.length > 0 && !isLoopbackHost(host)) return false
	const origin = headers.origin
	if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
		try {
			if (!LOOPBACK_NAMES.includes(new URL(origin).hostname)) return false
		} catch {
			return false
		}
	}
	return true
}

function writeJson(res, status, body) {
	const payload = JSON.stringify(body ?? null)
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(payload),
		'cache-control': 'no-store',
		'referrer-policy': 'no-referrer',
	})
	res.end(payload)
}

function readBoundedJson(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let size = 0
		req.on('data', (chunk) => {
			size += chunk.length
			if (size > limit) {
				reject(new Error('body too large'))
				return
			}
			chunks.push(chunk)
		})
		req.on('error', reject)
		req.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8')
			if (text.trim().length === 0) {
				resolve({})
				return
			}
			try {
				resolve(JSON.parse(text))
			} catch {
				reject(new Error('body must be JSON'))
			}
		})
	})
}

/** Read a raw body into a Buffer, refusing anything over `limit` (never hangs the socket). */
function readBoundedBuffer(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let size = 0
		req.on('data', (chunk) => {
			size += chunk.length
			if (size > limit) {
				reject(new Error('body too large'))
				return
			}
			chunks.push(chunk)
		})
		req.on('error', reject)
		req.on('end', () => resolve(Buffer.concat(chunks)))
	})
}

/* ------------------------------------------------------------------ *
 * uploads + history (the two things that touch the file system)
 * ------------------------------------------------------------------ */

/** Directory holding the durable history log. */
const HISTORY_DIR = join(HOME, 'plugin-data', 'dsh-intelligent-ui')

/** Keep a user-supplied file name usable as a single path segment. */
function safeName(value) {
	const raw = typeof value === 'string' ? value : ''
	const base = raw.split(/[\\/]/).pop() ?? ''
	const cleaned = base
		// eslint-disable-next-line no-control-regex -- control characters are exactly what must go
		.replace(/[\u0000-\u001f<>:"|?*]/g, '_')
		.replace(/^\.+/, '')
		.trim()
	if (cleaned.length === 0) return 'upload.bin'
	return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned
}

/** Keep a harness id usable as a single path segment. */
function safeId(value) {
	const cleaned = String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '')
	return cleaned.length > 0 ? cleaned.slice(0, 64) : 'unknown'
}

/** Persist one uploaded file and return where it landed. */
async function writeUpload(callId, name, buffer) {
	const directory = join(UPLOAD_DIR, safeId(callId))
	await mkdir(directory, { recursive: true })
	const path = join(directory, `${Date.now()}-${safeName(name)}`)
	await writeFile(path, buffer)
	return path
}

/** Append one answered panel to the durable log. Never throws. */
async function appendHistory(entry) {
	try {
		await mkdir(HISTORY_DIR, { recursive: true })
		await appendFile(HISTORY_FILE, `${JSON.stringify(entry)}\n`, 'utf8')
	} catch {
		/* best effort: a read-only home must not break the panel */
	}
}

/**
 * Read back the newest history entries, optionally only for one session.
 *
 * Returns `{ entries, total }`. `entries` is capped by `limit`; `total` counts
 * every matching line in the log, so a caller can say "you are looking at the
 * newest 20 of 128" instead of implying the log ends where `limit` does.
 */
async function readHistory(limit, sessionId) {
	const wanted = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_HISTORY_READ) : 20
	let text
	try {
		text = await readFile(HISTORY_FILE, 'utf8')
	} catch (error) {
		if (error?.code === 'ENOENT') return { entries: [], total: 0 }
		throw error
	}
	const lines = text.split('\n')
	const found = []
	let total = 0
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index]
		if (line === undefined || line.trim().length === 0) continue
		let entry
		try {
			entry = JSON.parse(line)
		} catch {
			continue
		}
		if (sessionId !== undefined && sessionId !== '' && entry.sessionId !== sessionId) continue
		total += 1
		if (found.length < wanted) found.push(entry)
	}
	return { entries: found, total }
}

/** Close a pending panel: record the answer, log it, wake the tool call. */
function settleRecord(callId, record, action, button, values) {
	record.status = 'answered'
	record.action = action
	record.button = button
	record.values = values
	const settle = record.settle
	record.settle = undefined
	void appendHistory({
		at: new Date().toISOString(),
		callId,
		sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
		title: typeof record.spec?.title === 'string' ? record.spec.title : '',
		action,
		button,
		values,
	})
	if (typeof settle === 'function') settle({ action, button, values })
}

/* ------------------------------------------------------------------ *
 * routes
 * ------------------------------------------------------------------ */

function panelView(record) {
	if (record === undefined)
		return { status: 'unknown' }
	if (record.status === 'pending')
		return { status: 'pending', spec: record.spec }
	if (record.status === 'display')
		return { status: 'display', spec: record.spec }
	return {
		status: 'answered',
		spec: record.spec,
		action: record.action,
		button: record.button,
		values: record.values,
	}
}

/**
 * The web boot graph as the browser will see it: which client-bundle
 * generations are currently published. Dev aid for iterating on the UI.
 */
function clientModulesView() {
	if (clientModules === undefined || typeof clientModules.graph !== 'function') {
		return { ok: false, error: 'clientModules service unavailable' }
	}
	try {
		const graph = clientModules.graph()
		const entries = Array.isArray(graph?.entries) ? graph.entries : []
		return {
			ok: true,
			rev: typeof graph?.rev === 'string' ? graph.rev : null,
			entries: entries.map((entry) => ({
				id: String(entry?.id ?? ''),
				url: String(entry?.url ?? ''),
				rev: entry?.rev === undefined || entry?.rev === null ? null : String(entry.rev),
			})),
		}
	} catch (error) {
		return { ok: false, error: String(error?.message ?? error) }
	}
}

/**
 * Publish a fresh client-bundle generation for this package. `rebuilt` is the
 * client-module service's own HMR hook and the only entry point through which
 * edited client bytes reach the boot graph; reload the page afterwards.
 */
function refreshClientBundle() {
	if (clientModules === undefined || typeof clientModules.rebuilt !== 'function') {
		return { ok: false, error: 'clientModules service unavailable' }
	}
	const ids = [PACKAGE_NAME]
	const view = clientModulesView()
	if (view.ok === true) {
		for (const entry of view.entries) {
			if (entry.id.includes(PACKAGE_NAME) === true && ids.includes(entry.id) === false) ids.push(entry.id)
		}
	}
	const results = []
	for (const id of ids) {
		try {
			const rev = clientModules.rebuilt(id)
			results.push({ id, rev: rev === undefined || rev === null ? null : String(rev) })
		} catch (error) {
			results.push({ id, error: String(error?.message ?? error) })
		}
	}
	return { ok: true, results }
}

async function serve(req, res) {
	if (!isTrustedRequest(req)) {
		writeJson(res, 403, { error: 'forbidden' })
		return
	}
	let pathname = '/'
	let query = new URLSearchParams()
	try {
		const url = new URL(req.url ?? '/', 'http://localhost')
		pathname = url.pathname.slice(ROUTE_PREFIX.length) || '/'
		query = url.searchParams
	} catch {
		writeJson(res, 400, { error: 'bad url' })
		return
	}

	if (req.method === 'GET' && pathname === '/panel') {
		const callId = query.get('callId') ?? ''
		writeJson(res, 200, panelView(records.get(callId)))
		return
	}

	if (req.method === 'POST' && pathname === '/submit') {
		let body
		try {
			body = await readBoundedJson(req, MAX_BODY_BYTES)
		} catch (error) {
			writeJson(res, 400, { error: String(error?.message ?? error) })
			return
		}
		const callId = typeof body.callId === 'string' ? body.callId : ''
		const record = records.get(callId)
		if (record === undefined) {
			writeJson(res, 404, { error: 'unknown panel' })
			return
		}
		if (record.status !== 'pending') {
			writeJson(res, 409, { error: 'panel already answered', ...panelView(record) })
			return
		}
		const action = typeof body.action === 'string' && body.action.length > 0 ? body.action : 'submit'
		const button = typeof body.button === 'string' ? body.button : ''
		const values = body.values !== null && typeof body.values === 'object' ? body.values : {}
		settleRecord(callId, record, action, button, values)
		writeJson(res, 200, { ok: true, action, button, values })
		return
	}

	if (req.method === 'POST' && pathname === '/upload') {
		const callId = query.get('callId') ?? ''
		const record = records.get(callId)
		if (record === undefined) {
			writeJson(res, 404, { error: 'unknown panel' })
			return
		}
		if (record.status !== 'pending') {
			writeJson(res, 409, { error: 'panel already answered' })
			return
		}
		let buffer
		try {
			buffer = await readBoundedBuffer(req, MAX_UPLOAD_BYTES)
		} catch (error) {
			writeJson(res, 413, { error: String(error?.message ?? error) })
			return
		}
		try {
			const name = safeName(query.get('name'))
			const path = await writeUpload(callId, name, buffer)
			const type = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : ''
			writeJson(res, 200, { ok: true, file: { name, size: buffer.length, path, type } })
		} catch (error) {
			writeJson(res, 500, { error: String(error?.message ?? error) })
		}
		return
	}

	if (req.method === 'GET' && pathname === '/modules') {
		writeJson(res, 200, clientModulesView())
		return
	}

	if (req.method === 'POST' && pathname === '/refresh') {
		writeJson(res, 200, refreshClientBundle())
		return
	}

	writeJson(res, 404, { error: 'not found' })
}

/* ------------------------------------------------------------------ *
 * panel templates
 * ------------------------------------------------------------------ */

const TEMPLATES = ['approval', 'picker', 'plan', 'survey', 'form']

/** Normalize a choice given as a bare string or as { value, label, description }. */
function asChoice(choice, index) {
	if (choice !== null && typeof choice === 'object' && !Array.isArray(choice)) {
		const label =
			typeof choice.label === 'string' && choice.label.length > 0 ? choice.label : String(choice.value ?? `Choice ${index + 1}`)
		const option = { value: choice.value === undefined || choice.value === null ? label : choice.value, label }
		if (typeof choice.description === 'string' && choice.description.length > 0) option.description = choice.description
		return option
	}
	const text = String(choice ?? `Choice ${index + 1}`)
	return { value: text, label: text }
}

function asChoices(list, fallback) {
	const source = Array.isArray(list) && list.length > 0 ? list : Array.isArray(fallback) ? fallback : []
	return source.map(asChoice)
}

function itemLabel(item, index) {
	if (item !== null && typeof item === 'object' && !Array.isArray(item))
		return String(item.title ?? item.label ?? item.value ?? `Item ${index + 1}`)
	return String(item ?? `Item ${index + 1}`)
}

function itemText(item) {
	if (item !== null && typeof item === 'object' && !Array.isArray(item) && typeof item.text === 'string' && item.text.length > 0)
		return item.text
	return undefined
}

function textOption(value, fallback) {
	return typeof value === 'string' && value.trim().length > 0 ? value : fallback
}

const INPUT_TYPE_KINDS = ['text', 'input', 'number', 'date', 'time', 'datetime-local', 'email', 'url', 'password', 'search', 'tel', 'color']

/** Map one `form` template field onto a widget. */
function fieldElement(field, index) {
	if (field === null || typeof field !== 'object' || Array.isArray(field))
		throw new Error(`${TEMPLATE_TOOL_NAME}: fields[${index}] must be an object`)
	const element = { id: textOption(field.id, `field${index + 1}`), label: textOption(field.label, `字段 ${index + 1}`) }
	if (typeof field.description === 'string' && field.description.length > 0) element.description = field.description
	if (field.required === true) element.required = true
	if (field.default !== undefined) element.default = field.default
	if (typeof field.placeholder === 'string') element.placeholder = field.placeholder
	if (typeof field.maxlength === 'number') element.maxlength = field.maxlength
	if (typeof field.rows === 'number') element.rows = field.rows
	const hasOptions = Array.isArray(field.options) && field.options.length > 0
	if (hasOptions) element.options = asChoices(field.options)
	const type = textOption(field.type, hasOptions ? 'radio' : 'text')
	if (type === 'textarea') {
		element.kind = 'textarea'
		element.rows = typeof field.rows === 'number' ? field.rows : 2
		return element
	}
	if (type === 'select' || type === 'radio' || type === 'multiselect' || type === 'checkbox') {
		if (!hasOptions) throw new Error(`${TEMPLATE_TOOL_NAME}: fields[${index}] of type ${type} needs options`)
		// a checkbox with options is a multi-select group, without options a boolean
		element.kind = type === 'checkbox' ? 'checkbox' : type
		return element
	}
	if (type === 'switch') {
		element.kind = 'switch'
		if (element.default === undefined) element.default = false
		return element
	}
	if (type === 'slider') {
		element.kind = 'slider'
		element.min = typeof field.min === 'number' ? field.min : 0
		element.max = typeof field.max === 'number' ? field.max : 10
		element.step = typeof field.step === 'number' ? field.step : 1
		return element
	}
	if (type === 'path') {
		element.kind = 'path'
		if (field.mode === 'file' || field.mode === 'directory') element.mode = field.mode
		return element
	}
	if (type === 'number') element.kind = 'number'
	else if (type === 'date' || type === 'time') element.kind = type
	else if (INPUT_TYPE_KINDS.includes(type)) element.kind = 'input'
	else throw new Error(`${TEMPLATE_TOOL_NAME}: fields[${index}].type "${type}" is not supported`)
	if (element.kind === 'input' && type !== 'text' && type !== 'input') element.input_type = type
	if (element.kind === 'number') {
		if (typeof field.min === 'number') element.min = field.min
		if (typeof field.max === 'number') element.max = field.max
	}
	return element
}

/**
 * Expand a ready-made panel template into a validated spec.
 * @param args - the tool arguments: { template, ... }.
 * @returns the same shape buildSpec() produces.
 */
function expandTemplate(args) {
	const raw = args !== null && typeof args === 'object' ? args : {}
	const template = textOption(raw.template, '').toLowerCase()
	if (!TEMPLATES.includes(template)) throw new Error(`${TEMPLATE_TOOL_NAME}: template must be one of ${TEMPLATES.join(', ')}`)

	const elements = []
	if (typeof raw.intro === 'string' && raw.intro.trim().length > 0) elements.push({ kind: 'markdown', text: raw.intro })
	const items = Array.isArray(raw.items) ? raw.items : []
	const answerId = textOption(raw.answer_id, template === 'approval' ? 'decision' : template === 'plan' ? 'go' : 'choice')
	const wantsComment = raw.comment === true || (raw.comment === undefined && (template === 'approval' || template === 'plan'))
	/* The forced note box owns the note slot: a template that asks for a comment
	 * box gets that same box (id `user_note`), never a second one beside it. With
	 * the note switched off, the historical `comment` id comes back untouched. */
	const noteBoxed = noteOn()
	const commentId = noteBoxed ? NOTE_ID : textOption(raw.comment_id, 'comment')
	const commentLabel = textOption(raw.comment_label, noteBoxed ? options.noteLabel : '备注（可选）')
	const pushComment = () => {
		if (!wantsComment) return
		/* Same shape as noteBox(): the fixed line rides on `spec.note_hint` so a
		 * template panel and a raw panel explain the box with one wording. */
		elements.push({ kind: 'textarea', id: commentId, label: commentLabel, rows: 2 })
	}

	if (template === 'approval') {
		if (items.length > 0)
			elements.push({ kind: 'markdown', text: items.map((item, index) => `- ${itemLabel(item, index)}`).join('\n') })
		elements.push({
			kind: 'radio',
			id: answerId,
			label: textOption(raw.question, '这个动作可以执行吗？'),
			required: true,
			options: asChoices(raw.options, ['批准', '驳回']),
		})
		pushComment()
	} else if (template === 'picker') {
		const options = asChoices(raw.options !== undefined ? raw.options : items)
		if (options.length === 0) throw new Error(`${TEMPLATE_TOOL_NAME}: picker needs items: ["…", "…"]`)
		const label = textOption(raw.question, '选一个')
		if (options.length > 6)
			elements.push({
				kind: 'table',
				id: answerId,
				label,
				required: true,
				select: 'single',
				row_key: 'key',
				columns: [
					{ key: 'key', label: '选项' },
					{ key: 'note', label: '说明' },
				],
				rows: options.map((option) => ({ key: option.label, note: option.description ?? '' })),
			})
		else elements.push({ kind: 'radio', id: answerId, label, required: true, options })
	} else if (template === 'plan') {
		const steps = items.length > 0 ? items : Array.isArray(raw.steps) ? raw.steps : []
		if (steps.length > 0)
			elements.push({
				kind: 'timeline',
				id: textOption(raw.steps_id, 'steps'),
				label: textOption(raw.steps_label, '步骤'),
				items: steps.map((step, index) => {
					const item = { title: itemLabel(step, index) }
					const text = itemText(step)
					if (text !== undefined) item.text = text
					return item
				}),
			})
		elements.push({
			kind: 'radio',
			id: answerId,
			label: textOption(raw.question, '这个计划可以开始吗？'),
			required: true,
			options: asChoices(raw.options, ['开始执行', '调整后再说']),
		})
		pushComment()
	} else if (template === 'survey') {
		const questions = Array.isArray(raw.questions) ? raw.questions : []
		if (questions.length === 0) throw new Error(`${TEMPLATE_TOOL_NAME}: survey needs questions: [{ id, label, options? }]`)
		questions.forEach((question, index) => {
			if (question === null || typeof question !== 'object' || Array.isArray(question))
				throw new Error(`${TEMPLATE_TOOL_NAME}: questions[${index}] must be an object`)
			const element = { id: textOption(question.id, `q${index + 1}`), label: textOption(question.label, `问题 ${index + 1}`) }
			if (typeof question.description === 'string' && question.description.length > 0) element.description = question.description
			if (question.required !== false) element.required = true
			if (question.default !== undefined) element.default = question.default
			if (typeof question.placeholder === 'string') element.placeholder = question.placeholder
			const type = textOption(question.type, '')
			if (Array.isArray(question.options) && question.options.length > 0) {
				const options = asChoices(question.options)
				if (type === 'select') {
					element.kind = 'select'
					element.options = options
				} else if (type === 'multiselect' || question.multiple === true) {
					element.kind = 'multiselect'
					element.options = options
				} else {
					element.kind = 'radio'
					element.options = options
				}
			} else if (type === 'textarea' || typeof question.rows === 'number') {
				element.kind = 'textarea'
				element.rows = typeof question.rows === 'number' ? question.rows : 2
			} else if (type === 'slider') {
				element.kind = 'slider'
				element.min = typeof question.min === 'number' ? question.min : 0
				element.max = typeof question.max === 'number' ? question.max : 10
			} else if (INPUT_TYPE_KINDS.includes(type)) {
				element.kind = type === 'number' ? 'number' : 'input'
				if (element.kind === 'input' && type !== 'text') element.input_type = type
			} else {
				element.kind = 'input'
			}
			elements.push(element)
		})
	} else if (template === 'form') {
		const fields = Array.isArray(raw.fields) ? raw.fields : []
		if (fields.length === 0) throw new Error(`${TEMPLATE_TOOL_NAME}: form needs fields: [{ id, label, type?, required? }]`)
		fields.forEach((field, index) => elements.push(fieldElement(field, index)))
		pushComment()
	}

	return buildSpec({
		title: textOption(raw.title, ''),
		subtitle: textOption(raw.subtitle, ''),
		elements,
		submit_label: textOption(raw.submit_label, '提交'),
		cancel_label: textOption(raw.cancel_label, '取消'),
		allow_cancel: raw.allow_cancel !== false,
	})
}

/* ------------------------------------------------------------------ *
 * tool
 * ------------------------------------------------------------------ */

const DESCRIPTION = [
	'Render an interactive panel inside the conversation and WAIT for the user\'s answer.',
	'Use it whenever the next step depends on a human decision or a few values you cannot infer:',
	'pick one of several options, multi-choose, confirm or reject a plan, choose a destructive-action',
	'scope, collect a small form, review rows before acting, or visualize numbers.',
	'',
	'This call BLOCKS until the user submits (or the turn is cancelled), then returns',
	'{ action, values, cancelled }.',
	'- action: "submit" (primary button) | "cancel" (cancel button) | "button" (a `button` element was clicked).',
	'- values: one entry per element carrying an `id`, keyed by that id; a `form` element maps field id -> value;',
	'  a `wizard` maps step id -> { field id -> value }; `table`/`multiselect` answer with the selected keys/values.',
	'- cancelled: true when the turn was cancelled before an answer arrived.',
	'',
	'If the turn is interrupted while the panel is open, this call FAILS with a message',
	'explaining that the panel was closed unanswered. That is neither an approval nor a',
	'rejection: never read a vague follow-up ("continue") as consent for what the panel was',
	'asking, and never run a destructive action on the strength of it. Call',
	`${HISTORY_TOOL_NAME} with the callId to read the final \`action\` instead:`,
	'"cancelled" (interrupted — ask again), "cancel" (explicit no), "submit" (answered).',
	'- readonly: true disables every widget, hides the submit bar, and returns action "display" immediately.',
	'  Use it to SHOW something (a chart, a table, the component gallery) instead of asking something.',
	'',
	'Top level: { title, subtitle, elements, submit_label, cancel_label, allow_cancel, readonly }.',
	'`allow_cancel` defaults to true, so the panel always offers an explicit "no" — pass',
	'false only when a cancel would be meaningless. A cancel answers with action "cancel",',
	'which is a real decision the user made (unlike an interrupted turn).',
	'Every panel that collects an answer also carries a fixed note line plus a free-text note box at the',
	'bottom (read-only panels and `_gallery` excepted). The note returns as `values.user_note` (string,',
	'may be empty) — read it BEFORE acting on the choice: a note can mean "none of these options is right",',
	'and then the note wins over the clicked option. Never ask the user to "pick one of the options',
	'instead" when the note is non-empty, and never add your own note box in `elements`.',
	'Every element is { kind, ... }; shared optional keys: id, label, description, default, disabled, unit.',
	'',
	'Kinds:',
	'- text: { text, tone?: "warn"|"error"|"ok"|"quote", format?: "markdown" } — a paragraph explaining the ask.',
	'- markdown: { text } — a block of Markdown (headings, lists, quotes, fences, **bold**, `code`, [links](url)).',
	'- select: { id, label, options: [value | { value, label }], default }',
	'- radio: { id, label, options: [{ value, label, description? }], default } — options become cards.',
	'- multiselect: { id, label, options: [...], default: [], columns? } — answers with an array.',
	'- checkbox / switch: { id, label, default: boolean } — one boolean toggle.',
	'- checkbox / switch with options: [{ value|label, description? }] — a checkbox GROUP;',
	'    the answer is the array of chosen values (same shape as multiselect).',
	'- slider: { id, label, min, max, step, default, unit }',
	'- number: { id, label, min, max, step, default, unit, placeholder }',
	'- input / date / time: { id, label, input_type?: text|number|date|time|datetime-local|url|email|password|search|tel|color, min?, max?, placeholder?, maxlength?, required? }',
	'- textarea: { id, label, rows?, maxlength?, placeholder?, required? }',
	'Required fields:',
	'- Any field (input, textarea, number, date, time, select, radio, checkbox, slider, path, upload) may set',
	'  required: true; a form field sets it inside the form spec. While such a field is empty the panel refuses to',
	'  submit, marks the field, and lists the missing labels next to the button. `maxlength` shows a counter.',
	'- path: { id, label, mode?: "directory"|"file", placeholder } — a host path; "directory" gets a native picker button.',
	'- upload: { id, label, multiple?, accept? } — the user picks file(s) in the browser; the answer is',
	'    { name, size, path, type } (an array when multiple). `path` is a real file the host just wrote, so `read` it.',
	'- form: { id, label, fields: [{ id, label, type?, placeholder?, default?, required?, rows? }] } — type adds textarea and every input type.',
	'- table: { id, label, columns: [{ key, label, align?: left|right|center }], rows: [ { key: cell } | [cell] ],',
	'    select?: "none"|"single"|"multi", row_key?, default?, max_height? } — cells may be { text, href }.',
	'    With select, the answer is the chosen row index (or that row\'s row_key column value); multi answers with an array.',
	'- wizard: { id, label, steps: [{ id, title, description?, elements: [...] }], finish_label? } — one step at a time.',
	'- chart: { id, label, chart: "bar"|"line"|"pie"|"donut", series: [{ label, value }], height?, unit? } — read-only SVG.',
	'- diff: { id, label, before_text, after_text, before_name?, after_name?, context? } — a unified line diff with +/-',
	'    markers and collapsed unchanged runs; prefer it over pasting two versions of a file back to back.',
	'- timeline: { id, label, items: [{ at?, title?, text?, tone?: "ok"|"warn"|"error" }] } — an ordered event list.',
	'- tree: { id, label, nodes: [{ id, label, checked?, children? }], default?: [ids], expand_depth? } — a checkbox',
	'    tree; the answer is the array of checked node ids (use stable string ids).',
	'- progress: { id, label, items: [{ label, value, max?, unit?, tone? }] } — read-only bars for partial completion.',
	'- tabs: { id, label, tabs: [{ id, label, elements: [...] }] } — one tab visible at a time; inner elements report',
	'    exactly like top-level ones (their ids become keys of `values`).',
	'- button: { id, label, style?: "primary"|"danger"|"ghost" } — a quick action; answers with action "button" and that id.',
	'- link: { label, href } — a reference link, not an answer.',
	'',
	'Keep a panel focused: at most ~6 elements, short option labels, no free text where a select/radio will do.',
	'Put every question in one panel instead of calling the tool repeatedly.',
].join('\n')

/**
 * The error thrown when the turn is interrupted while a panel is still open.
 *
 * The harness rewrites a *successful* tool result into `Error: tool call aborted`
 * the moment the caller signal is aborted (see `dispatchToolBody`/`finishScheduledExecution`
 * in `@deepseek-ai/dsh-tools`), which would erase the decision entirely. An *error*
 * result is passed through untouched, so throwing is the only way to hand the model
 * a readable account of what happened. The answer itself is still durable in
 * `history.jsonl`; this message is what tells the model to go and read it.
 * @param callId - the execution's call id, echoed so the model can look it up.
 * @param spec - the panel spec, used only to name the panel in the message.
 * @param toolName - which tool opened the panel, so the message names itself right.
 */
function interruptedMessage(callId, spec, toolName) {
	const title = typeof spec?.title === 'string' && spec.title.length > 0 ? spec.title : '(untitled panel)'
	return [
		`${typeof toolName === 'string' && toolName.length > 0 ? toolName : TOOL_NAME}: the turn was interrupted while the panel "${title}" was still open.`,
		'',
		'The user did NOT answer it. This is neither an approval nor a rejection:',
		'do not treat it as consent, and do not carry out any destructive or',
		'irreversible action that the panel was asking about.',
		'',
		`The panel was closed and logged. Call ${HISTORY_TOOL_NAME} to read its final`,
		`entry (callId ${callId}) and check the \`action\` field:`,
		'- "cancelled" — the turn was interrupted; neither yes nor no. Ask again before acting.',
		'- "cancel" — the user pressed the panel\'s own cancel button: an explicit no.',
		'- "submit" — the user did answer; `values` holds the answer.',
		'- "display" — the panel was read-only and never waited for anything.',
		'',
		'If the user sends a vague follow-up like "continue" after this error, do not read it',
		'as permission for whatever the panel was asking — re-ask with a new panel first.',
	].join('\n')
}

/**
 * Render one panel and block until the user answers it. Shared by the raw tool
 * and the template tool.
 * @param spec - a validated spec from buildSpec().
 * @param exec - the harness tool run context.
 */
async function presentPanel(spec, exec) {
	const callId = String(exec.callId)
	const sessionId = typeof exec.agent?.id === 'string' ? exec.agent.id : ''

	if (spec.readonly === true) {
		remember(callId, { spec, status: 'display', action: 'display', button: '', values: {}, sessionId })
		return { action: 'display', button: '', values: {}, cancelled: false }
	}

	let settle
	const answer = new Promise((resolve) => {
		settle = resolve
	})
	const record = { spec, status: 'pending', action: '', button: '', values: {}, settle, sessionId }
	remember(callId, record)

	const signal = exec.signal
	let onAbort
	let interrupted = false
	if (signal !== undefined && signal !== null) {
		onAbort = () => {
			if (record.status !== 'pending') return
			interrupted = true
			settleRecord(callId, record, 'cancelled', '', {})
		}
		if (signal.aborted === true) onAbort()
		else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true })
	}

	const submitted = await answer
	if (signal !== undefined && signal !== null && onAbort !== undefined && typeof signal.removeEventListener === 'function')
		signal.removeEventListener('abort', onAbort)

	if (interrupted === true) throw new Error(interruptedMessage(callId, spec, exec.name))

	return {
		action: submitted.action ?? 'submit',
		button: submitted.button ?? '',
		values: submitted.values ?? {},
		cancelled: submitted.action === 'cancelled',
	}
}

const TOOL_DEFINITION = {
	name: TOOL_NAME,
	description: DESCRIPTION,
	parameters: {
		type: 'object',
		properties: {
			title: { type: 'string', description: 'Panel heading.' },
			subtitle: { type: 'string', description: 'One-line context under the heading.' },
			elements: {
				type: 'array',
				items: {},
				description:
					'Widgets to render, in order. Each is { kind, ... } with kind one of ' +
					`${KINDS.join(', ')}; the tool description documents each kind's fields.`,
			},
			submit_label: { type: 'string', description: 'Label of the primary button (default "Submit").' },
			cancel_label: { type: 'string', description: 'Label of the cancel button (default "Cancel").' },
			allow_cancel: { type: 'boolean', description: 'Show a cancel button. Default true.' },
			readonly: {
				type: 'boolean',
				description: 'Draw every widget disabled, hide the submit bar, and return immediately (action "display").',
			},
		},
		required: ['elements'],
		additionalProperties: false,
	},
	output: {
		schema: {
			type: 'object',
			properties: {
				action: { type: 'string' },
				button: { type: 'string' },
				values: { type: 'object', additionalProperties: true },
				cancelled: { type: 'boolean' },
			},
			required: ['action'],
			additionalProperties: true,
		},
		render(args, value) {
			const result = value !== null && typeof value === 'object' ? value : {}
			return [{ type: 'text', text: JSON.stringify(result, null, 2) }]
		},
	},
	async execute(args, exec) {
		return presentPanel(buildSpec(args), exec)
	},
}

/* ------------------------------------------------------------------ *
 * template tool
 * ------------------------------------------------------------------ */

const TEMPLATE_DESCRIPTION = [
	'Render one of the ready-made panels and WAIT for the answer — the same blocking contract as',
	`${TOOL_NAME}, but you describe the content instead of the widgets. Reach for this first when it fits:`,
	'fewer tokens, and the wording and layout stay consistent across calls.',
	'',
	'- approval: { items?: [string], options?: ["批准", "驳回"], comment?, question? } -> values { decision, user_note? }',
	'  The decision is required. The comment box is the shared note box (id `user_note`), so its text',
	'  arrives as `values.user_note`; `comment` defaults to true here and for `plan`.',
	'- picker:   { items: [string | { value, label, description }], question? } -> values { choice, user_note? }',
	'  1-6 options render as cards, more as a single-select table; the choice is required.',
	'- plan:     { items: [string | { title, text }], options?: ["开始执行", "调整后再说"], comment? } -> values { go, user_note? }',
	'  The steps render as a timeline; the go/no-go choice is required.',
	'- survey:   { questions: [{ id, label, options?, type?, required?, description?, placeholder? }] }',
	'  -> values { <question id>: answer }. With options it is a radio (or select / multiselect), without options',
	'  a text box (or textarea / slider / number / date / time). Questions are required by default.',
	'- form:     { fields: [{ id, label, type?, required?, options?, default?, placeholder?, maxlength?, min?, max? }] }',
	'  -> values { <field id>: value }. type is text | number | date | time | textarea | select | radio |',
	'  multiselect | checkbox | switch | slider | path | email | url | password | color.',
	'',
	'Common keys: title, subtitle, intro (markdown above the widgets), question (label of the main choice),',
	'answer_id (key the main choice is stored under), comment (add the note box on templates that do not',
	'carry one by default), comment_id, comment_label, submit_label, cancel_label, allow_cancel (default',
	'true, same as the raw tool). With the note box on (the default), `comment_id` is ignored: the box is',
	'always the shared one and its text comes back as `values.user_note`.',
	'',
	`Use ${TOOL_NAME} instead when you need what templates do not cover: charts, diffs, tables, uploads,`,
	'wizards, tabs, trees, progress, or a read-only panel.',
	'',
	'If the turn is interrupted while the panel is open, this call FAILS with a message',
	'saying the panel was closed unanswered — that is neither an approval nor a rejection.',
	`Call ${HISTORY_TOOL_NAME} with the callId to read the final \`action\` before doing`,
	'anything the panel was asking about.',
].join('\n')

const TEMPLATE_DEFINITION = {
	name: TEMPLATE_TOOL_NAME,
	description: TEMPLATE_DESCRIPTION,
	parameters: {
		type: 'object',
		properties: {
			template: { type: 'string', enum: TEMPLATES, description: 'Which ready-made panel to render.' },
			title: { type: 'string', description: 'Panel heading.' },
			subtitle: { type: 'string', description: 'One-line context under the heading.' },
			intro: { type: 'string', description: 'Markdown shown above the widgets.' },
			question: { type: 'string', description: 'Label of the main choice (approval / picker / plan).' },
			answer_id: {
				type: 'string',
				description: 'Key the main choice is stored under (default: decision for approval, go for plan, choice for picker).',
			},
			options: {
				type: 'array',
				items: {},
				description: 'Choices of the main question: a string, or { value, label, description }.',
			},
			items: { type: 'array', items: {}, description: 'List content: approval bullets, picker choices, plan steps.' },
			steps: { type: 'array', items: {}, description: 'Plan steps (alias of items).' },
			questions: {
				type: 'array',
				items: {},
				description: 'survey questions: { id, label, options?, type?, required?, description? }.',
			},
			fields: {
				type: 'array',
				items: {},
				description: 'form fields: { id, label, type?, required?, options?, default?, placeholder?, maxlength?, min?, max? }.',
			},
			comment: { type: 'boolean', description: 'Add the note box (default true for approval and plan). The box is always the shared `user_note` one.' },
			comment_id: { type: 'string', description: 'Ignored while the note box is on; the id is always `user_note`. With it off, the key of the comment box (default "comment").' },
			comment_label: { type: 'string', description: 'Label of the note box.' },
			submit_label: { type: 'string', description: 'Label of the primary button (default "提交").' },
			cancel_label: { type: 'string', description: 'Label of the cancel button (default "取消").' },
			allow_cancel: { type: 'boolean', description: 'Show a cancel button. Default true.' },
		},
		required: ['template'],
		additionalProperties: false,
	},
	output: TOOL_DEFINITION.output,
	async execute(args, exec) {
		return presentPanel(expandTemplate(args), exec)
	},
}

/* ------------------------------------------------------------------ *
 * history tool
 * ------------------------------------------------------------------ */

/** How many entries share one page tab, and how many the panel draws at all. */
const HISTORY_PAGE_SIZE = 8
const HISTORY_VIEW_MAX = 48

const ACTION_LABEL = {
	submit: '已提交',
	button: '按了按钮',
	cancel: '已取消',
	cancelled: '会话中断',
	display: '只读展示',
}

const ACTION_TONE = { submit: 'ok', button: 'ok', cancelled: 'warn' }

/** `2026-11-06T19:32:08.123Z` → `11-06 19:32`, in the machine's own timezone. */
function historyStamp(at) {
	if (typeof at !== 'string' || at.length === 0) return ''
	const stamp = new Date(at)
	if (Number.isNaN(stamp.getTime())) return at
	const pad = (value) => String(value).padStart(2, '0')
	return `${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`
}

/** One short `key=value, …` line for an answered panel; never throws. */
function historyValueText(values) {
	if (values === null || typeof values !== 'object' || Array.isArray(values)) return ''
	const keys = Object.keys(values)
	if (keys.length === 0) return ''
	const parts = []
	for (let index = 0; index < keys.length && index < 3; index++) {
		const key = keys[index]
		const value = values[key]
		let text = ''
		if (typeof value === 'string') text = value
		else if (typeof value === 'number' || typeof value === 'boolean') text = String(value)
		else if (Array.isArray(value)) text = value.length === 0 ? '空' : `${value.length} 项`
		else if (value !== null && typeof value === 'object')
			text = Object.keys(value).length === 0 ? '空' : `${Object.keys(value).length} 字段`
		text = text.replace(/\s+/g, ' ').trim()
		if (text.length > 24) text = `${text.slice(0, 24)}…`
		parts.push(text.length === 0 ? key : `${key}=${text}`)
	}
	if (keys.length > 3) parts.push(`+${keys.length - 3}`)
	return parts.join(', ')
}

/**
 * The read-only panel that replays accepted answers. Paging is client-side
 * (the `tabs` widget keeps its own position in `__tab`), so nothing here
 * blocks and nothing is written back to the history log.
 */
function historySpec(entries, options) {
	const settings = options !== null && typeof options === 'object' ? options : {}
	const total = Number.isFinite(settings.total) ? settings.total : 0
	const all = Array.isArray(entries) ? entries.slice(0, HISTORY_VIEW_MAX) : []
	const scope = settings.all_sessions === true ? '全部会话' : '本会话'
	const elements = []
	let pageCount = 0
	if (all.length === 0) {
		elements.push({ kind: 'text', text: '还没有任何作答记录。等面板被答过一次之后再来看。' })
	} else {
		const pages = []
		for (let start = 0; start < all.length; start += HISTORY_PAGE_SIZE) {
			const slice = all.slice(start, start + HISTORY_PAGE_SIZE)
			const items = []
			for (let offset = 0; offset < slice.length; offset++) {
				const entry = slice[offset] !== null && typeof slice[offset] === 'object' ? slice[offset] : {}
				const action = typeof entry.action === 'string' ? entry.action : ''
				const label = ACTION_LABEL[action] === undefined ? action || '—' : ACTION_LABEL[action]
				const button = typeof entry.button === 'string' && entry.button.length > 0 ? ` · ${entry.button}` : ''
				const values = historyValueText(entry.values)
				const stamp = historyStamp(entry.at)
				const item = {
					title:
						typeof entry.title === 'string' && entry.title.trim().length > 0
							? entry.title.trim()
							: '(无标题)',
					text: `${label}${button}${values.length === 0 ? '' : ` · ${values}`}`,
				}
				if (stamp.length > 0) item.at = stamp
				if (ACTION_TONE[action] !== undefined) item.tone = ACTION_TONE[action]
				items.push(item)
			}
			pages.push({
				id: `page_${pages.length + 1}`,
				label: `第 ${pages.length + 1} 页`,
				elements: [{ kind: 'timeline', items }],
			})
		}
		elements.push({ kind: 'tabs', id: 'hist_pages', tabs: pages })
		pageCount = pages.length
		if (total > all.length) {
			elements.push({
				kind: 'text',
				tone: 'warn',
				text: `只画了最近 ${all.length} 条（日志里共有 ${total} 条）。要更早的记录，把 limit 调大或加 all_sessions。`,
			})
		}
	}
	const pagesHint = pageCount > 1 ? `${pageCount} 页 · 点页签翻 · ` : ''
	return {
		title: 'Intelligent UI · 历史作答',
		subtitle: `${pagesHint}${scope}最近 ${all.length} 条记录 · 只读`,
		readonly: true,
		elements,
	}
}

const HISTORY_DEFINITION = {
	name: HISTORY_TOOL_NAME,
	description: [
		'Look up the panels you already showed the user in this session: what you asked and what they answered.',
		'Use it when you need an earlier decision again (after a context compaction, or many turns later), or when',
		'the user refers back to "the panel from before". Answers are logged durably, so they survive a restart.',
		'Returns the newest entries first: { at, callId, title, action, button, values }.',
		'By default it also draws them as a read-only paged panel, so the user can page through what',
		'they answered earlier; pass view: false when you only want the JSON.',
		'',
		'Read this whenever a panel call failed because the turn was interrupted, or whenever',
		'you are unsure whether an earlier panel was answered. The `action` field says which:',
		'- "cancelled" — the turn was interrupted before an answer. Neither an approval nor a',
		'  rejection: do not act on the panel\'s question, re-ask it.',
		'- "cancel" — the user pressed the panel\'s own cancel button: an explicit no.',
		'- "submit" — the user answered; `values` holds what they chose.',
		'- "display" — the panel was read-only and never waited for an answer.',
		'A "cancelled" entry is never authorisation for a destructive action.',
	].join('\n'),
	parameters: {
		type: 'object',
		properties: {
			limit: { type: 'number', description: 'How many entries to return, newest first. Default 20.' },
			all_sessions: {
				type: 'boolean',
				description: 'Search every session in the log instead of only the current one. Default false.',
			},
			view: {
				type: 'boolean',
				description:
					'Draw the entries as a read-only paged panel. Default true; set false to keep the tool card as plain JSON.',
			},
		},
		additionalProperties: false,
	},
	output: {
		schema: {
			type: 'object',
			properties: {
				count: { type: 'integer' },
				entries: { type: 'array', items: {} },
				history_file: { type: 'string' },
				log_total: { type: 'integer' },
				shown: { type: 'integer' },
			},
			required: ['count', 'entries'],
			additionalProperties: true,
		},
		render(args, value) {
			const result = value !== null && typeof value === 'object' ? value : {}
			const head =
				typeof result.shown === 'number' && result.shown > 0
					? `History replayed as a read-only panel (${result.shown} entries).`
					: 'History (no panel).'
			return [{ type: 'text', text: `${head}\n${JSON.stringify(result, null, 2)}` }]
		},
	},
	async execute(args, exec) {
		const raw = args !== null && typeof args === 'object' ? args : {}
		const limit = typeof raw.limit === 'number' && Number.isFinite(raw.limit) ? raw.limit : 20
		const sessionId =
			raw.all_sessions === true || typeof exec.agent?.id !== 'string' ? '' : exec.agent.id
		const snapshot = await readHistory(limit, sessionId)
		const entries = snapshot.entries
		const result = {
			count: entries.length,
			entries,
			history_file: HISTORY_FILE,
			log_total: snapshot.total,
		}
		if (raw.view === false) return result
		// The panel is a read-only snapshot of the same list: it gets its own record
		// so the browser half can draw it, and drawing it never appends a new entry.
		try {
			const spec = historySpec(entries, {
				total: snapshot.total,
				all_sessions: raw.all_sessions === true,
			})
			const callId = String(exec.callId)
			remember(callId, {
				spec,
				status: 'display',
				action: 'display',
				button: '',
				values: {},
				sessionId,
			})
			result.shown = Math.min(entries.length, HISTORY_VIEW_MAX)
		} catch (error) {
			console.warn(`[${PACKAGE_NAME}] history view skipped: ${String(error?.message ?? error)}`)
		}
		return result
	},
}

/* ------------------------------------------------------------------ *
 * component gallery tool
 * ------------------------------------------------------------------ */

/** One demo of every widget the browser half can draw. */
const GALLERY_SPEC = {
	title: 'Intelligent UI · 组件库',
	subtitle: 'interactive_ui 能画出的每一种控件；这块面板是只读的（readonly: true），不需要作答。',
	readonly: true,
	elements: [
		{
			kind: 'markdown',
			text: [
				'**markdown** 元素支持常用 Markdown：标题、列表、引用、`行内代码`、代码围栏（带语言标签与复制按钮）、',
				'[链接](https://github.com/deepseek-ai/deepseek-harness) 和表格。',
				'',
				'## 二级标题',
				'',
				'- 无序列表项',
				'- 另一个列表项',
				'',
				'> 引用块，用来放上下文或警告。',
				'',
				'```js',
				'const answer = await interactive_ui({ elements: [{ kind: "radio", id: "pick", options: ["A", "B"] }] })',
				'```',
			].join('\n'),
		},
		{ kind: 'text', tone: 'ok', text: 'text 元素：tone 可为 ok / warn / error / quote，也可写 format:"markdown"。' },
		{ kind: 'text', tone: 'quote', text: '面板会出现在对话里，答案作为这次工具调用的返回值回灌给模型。' },
		{ kind: 'radio', id: 'g_radio', label: 'radio · 选项卡片', default: 'a', options: [
			{ value: 'a', label: '卡片一', description: '带一行说明' },
			{ value: 'b', label: '卡片二' },
		] },
		{ kind: 'select', id: 'g_select', label: 'select · 下拉选择', default: 'A', options: ['A', 'B'] },
		{ kind: 'multiselect', id: 'g_multiselect', label: 'multiselect · 多选（答案是数组）', columns: 2, default: ['一'], options: ['一', '二', '三', '四'] },
		{ kind: 'checkbox', id: 'g_checkbox', label: 'checkbox · 复选', default: true },
		{ kind: 'checkbox', id: 'g_checkgroup', label: 'checkbox + options · 多选组（答案是数组）', options: ['一', '二', '三'], default: ['二'] },
		{ kind: 'switch', id: 'g_switch', label: 'switch · 开关（值仍是布尔）', default: false },
		{ kind: 'slider', id: 'g_slider', label: 'slider · 滑杆', min: 0, max: 10, step: 1, default: 4, unit: ' 秒' },
		{ kind: 'number', id: 'g_number', label: 'number · 数字', min: 1, max: 99, default: 3 },
		{ kind: 'input', id: 'g_input', label: 'input · 单行文本（带必填标记与字数）', placeholder: '随便写点什么', maxlength: 24, required: true },
		{ kind: 'date', id: 'g_date', label: 'date · 日期' },
		{ kind: 'time', id: 'g_time', label: 'time · 时间' },
		{ kind: 'textarea', id: 'g_textarea', label: 'textarea · 多行文本', rows: 2, placeholder: '多行输入' },
		{ kind: 'path', id: 'g_path', label: 'path · 宿主路径（「浏览…」调系统对话框）', mode: 'directory', browse_label: '浏览…' },
		{ kind: 'upload', id: 'g_upload', label: 'upload · 文件上传（答案里带回真实路径）', multiple: true },
		{ kind: 'form', id: 'g_form', label: 'form · 表单（字段 id 变成答案的键）', fields: [
			{ id: 'name', label: '名称（必填）', placeholder: '一个字段', required: true, maxlength: 12 },
			{ id: 'qty', label: '数量', type: 'number', default: '1' },
		] },
		{ kind: 'table', id: 'g_table', label: 'table · 表格（点行选中）', select: 'single', row_key: 'key', columns: [
			{ key: 'key', label: '键' },
			{ key: 'value', label: '值', align: 'right' },
		], rows: [{ key: 'alpha', value: '1' }, { key: 'beta', value: '2' }] },
		{ kind: 'wizard', id: 'g_wizard', label: 'wizard · 多步向导', finish_label: '完成', steps: [
			{ id: 'step1', title: '第 1 步', elements: [{ kind: 'radio', id: 'w1', label: '选一个', default: 'a', options: ['a', 'b'] }] },
			{ id: 'step2', title: '第 2 步', elements: [{ kind: 'input', id: 'w2', label: '填一句' }] },
		] },
		{ kind: 'chart', id: 'g_chart', label: 'chart · 图表（内联 SVG）', chart: 'bar', unit: ' 项', series: [
			{ label: '一', value: 3 },
			{ label: '二', value: 7 },
			{ label: '三', value: 5 },
		] },
		{ kind: 'diff', id: 'g_diff', label: 'diff · 行级差异（未变行会被折叠）', before_name: 'a.txt', after_name: 'b.txt', context: 1,
			before_text: 'alpha\nbeta\ngamma\ndelta\nepsilon\n', after_text: 'alpha\nBETA\ngamma\ndelta\nepsilon\nzeta\n' },
		{ kind: 'timeline', id: 'g_timeline', label: 'timeline · 时间线', items: [
			{ at: '10:02', title: '安装', text: 'plugin_manager install_bundle', tone: 'ok' },
			{ at: '10:05', title: '重启', text: 'host 模块被重新 import', tone: 'warn' },
			{ at: '10:06', title: '验收', text: '面板把答案交回工具', tone: 'ok' },
		] },
		{ kind: 'tree', id: 'g_tree', label: 'tree · 复选框树（答案 = 勾选的 id 数组）', expand_depth: 1, nodes: [
			{ id: 'lib', label: 'lib/', children: [
				{ id: 'lib/index.js', label: 'index.js (host)', checked: true },
				{ id: 'lib/client.js', label: 'client.js (browser)' },
			] },
			{ id: 'test', label: 'test/', children: [{ id: 'test/selftest.mjs', label: 'selftest.mjs' }] },
		] },
		{ kind: 'progress', id: 'g_progress', label: 'progress · 进度条（只读）', items: [
			{ label: 'host 自测', value: 20, max: 20, tone: 'ok' },
			{ label: 'client 自测', value: 26, max: 26, tone: 'ok' },
			{ label: '文档', value: 6, max: 10, tone: 'warn' },
		] },
		{ kind: 'tabs', id: 'g_tabs', label: 'tabs · 标签页（内层 id 直接进 values）', tabs: [
			{ id: 'tab1', label: '第一页', elements: [{ kind: 'input', id: 'g_tab_input', label: '标签页里的输入框' }] },
			{ id: 'tab2', label: '第二页', elements: [{ kind: 'checkbox', id: 'g_tab_check', label: '标签页里的勾选框' }] },
		] },
		{ kind: 'button', id: 'g_button', label: 'button · 点一下即以该 id 作答', style: 'primary' },
		{ kind: 'link', label: 'link · 外链（纯展示）', href: 'https://github.com/deepseek-ai/deepseek-harness' },
	],
}

const GALLERY_DEFINITION = {
	name: GALLERY_TOOL_NAME,
	description: [
		'Show the Intelligent UI component gallery: every widget `interactive_ui` can draw, in one read-only panel.',
		'Use it when the user asks what the interactive UI can do, or before building a real panel so you pick the',
		'right widgets. It returns immediately with action "display" — there is nothing to answer.',
	].join('\n'),
	parameters: {
		type: 'object',
		properties: {
			compact: {
				type: 'boolean',
				description: 'Leave out the taller demos (wizard, upload, tree, tabs, diff, timeline, gallery markdown) for a shorter panel.',
			},
		},
		additionalProperties: false,
	},
	output: {
		schema: {
			type: 'object',
			properties: {
				action: { type: 'string' },
				shown: { type: 'integer' },
			},
			required: ['action', 'shown'],
			additionalProperties: true,
		},
		render(args, value) {
			const result = value !== null && typeof value === 'object' ? value : {}
			return [{ type: 'text', text: `Component gallery shown (${String(result.shown ?? 0)} widgets, read-only).` }]
		},
	},
	execute(args, exec) {
		const raw = args !== null && typeof args === 'object' ? args : {}
		const TALL = ['wizard', 'upload', 'tree', 'tabs', 'diff', 'timeline']
		const elements =
			raw.compact === true
				? GALLERY_SPEC.elements.filter((element) => TALL.includes(element.kind) === false)
				: GALLERY_SPEC.elements
		const spec = { ...GALLERY_SPEC, elements }
		const callId = String(exec.callId)
		const sessionId = typeof exec.agent?.id === 'string' ? exec.agent.id : ''
		remember(callId, { spec, status: 'display', action: 'display', button: '', values: {}, sessionId })
		return { action: 'display', shown: elements.length }
	},
}

/* ------------------------------------------------------------------ *
 * plugin
 * ------------------------------------------------------------------ */

export const name = 'intelligent-ui'
export const inject = ['tools', 'webServer']

/* ------------------------------------------------------------------ *
 * Runtime discoverability.
 *
 * The tool list alone does not tell a model *when* to reach for a panel, and
 * the two in-conversation surfaces (this plugin's blocking panel and
 * `visualize`'s read-only card) overlap enough that the difference has to be
 * stated where the model always sees it. Hence two surfaces:
 *   - a short prompt section: always in context, says what exists and when.
 *   - a runtime skill: the full contract, loaded only when it is needed.
 * Both facts live in exactly one of them.
 * ------------------------------------------------------------------ */

/** Skill name in the catalog (kebab-case, must match the skills registry rule). */
const SKILL_NAME = 'interactive-ui'
/** Prompt section name, scoped to this plugin. */
const SECTION_NAME = 'plugin:intelligent-ui'
/** Sorted after the built-in tool sections (<= 3100) and before the SDK's (5000). */
const SECTION_ORDER = 4000

const SKILL_DESCRIPTION =
	'Ask the user inside the conversation: render a panel (choices, forms, approvals, tables, wizards, charts, file upload) that blocks the tool call until they answer, and get the answer back as data. Use it when you need their answer before you can continue — not to show something a card would show better. Load before the first interactive_ui call in a session for the widget and template contract.'
const SKILL_WHEN_TO_USE =
	'the user must decide, approve, choose, fill something in, or hand over a file before you can continue; or a panel shows the answer better than prose — not when the content merely needs to be looked at'

const SKILL_CONTENT = [
	'# Interactive UI',
	'',
	'Ask the user inside the conversation and get the answer back as **data** in the tool',
	'result — not as prose you have to interpret.',
	'',
	'| tool | what it is for |',
	'| --- | --- |',
	'| `interactive_ui` | you describe the widgets yourself |',
	'| `interactive_ui_template` | one of five ready-made shapes fits |',
	'| `interactive_ui_history` | read back what the user answered earlier (and show it as a paged panel) |',
	'| `interactive_ui_gallery` | draw every widget once (read-only, returns at once) |',
	'',
	'## The contract',
	'',
	'- A panel **blocks** the tool call: it returns only once the user answers or cancels.',
	'  Open one only when you genuinely need the answer, and do not keep working as if it',
	'  had already been answered.',
	'- The result is `{ action, button, values, cancelled }`. `action` is `submit` | `cancel` |',
	'  `button` | `display`; `values` is keyed by each element\'s `id`. Shaped answers:',
	'  `form` → field ids, `wizard` → `{ stepId: { fieldId: value } }`, `table` / `multiselect` /',
	'  `tree` → the selected keys or values.',
	'- Keys starting with `__` are panel-private (current wizard step, open tree nodes, active',
	'  tab) and are stripped before the answer reaches you.',
	'- `readonly: true` — and every gallery panel — returns `display` immediately. Use it to',
	'  *show* something, not to ask.',
	'',
	'## Panel or card',
	'',
	'One test decides which surface to use: **do you need their answer before you can continue?**',
	'',
	'- **Yes** — a panel. The call blocks until they answer, and the answer comes back as data.',
	'  Asking the same question in prose costs a whole turn and arrives as text you must parse.',
	'- **No, and the value is in seeing it** — a card (`visualize`), when that plugin is mounted.',
	'  A card renders and returns at once; clicks and sliders inside it never come back to you,',
	'  so a card can *show* but can never *ask*.',
	'- **Neither** — prose, or a plain code block. A one-line conclusion does not need a card,',
	'  and a question you can answer yourself does not need a panel.',
	'',
	'Both mistakes are expensive: a card that asks a question gets you no answer, and a panel that',
	'only displays something burns a blocking turn for nothing.',
	'',
	'## Templates',
	'',
	'Reach for `interactive_ui_template` first when the shape fits: it is fewer tokens and its',
	'wording and layout stay consistent across calls.',
	'',
	'| template | use before / for | answer |',
	'| --- | --- | --- |',
	'| `approval` | anything destructive or hard to undo | `{ decision, comment? }` |',
	'| `picker` | the user picks one of a few options | `{ choice }` |',
	'| `plan` | confirming a multi-step plan | `{ go, comment? }` |',
	'| `survey` | several questions at once | `{ <question id>: answer }` |',
	'| `form` | collecting fields | `{ <field id>: value }` |',
	'',
	'## Widgets',
	'',
	'`elements: [{ kind, id, label, ... }]` — every element that carries an `id` answers.',
	'',
	'- **Show**: `text` (add `format: "markdown"` for rich text), `markdown`, `link`, `diff`,',
	'  `timeline`, `progress`, `chart` (bar / line / pie / donut), `table` (selectable rows).',
	'- **Ask**: `select`, `radio`, `multiselect`, `checkbox` or `switch` (add `options` for a',
	'  multi-select group), `slider`, `number`, `input`, `textarea`, `date`, `time`, `path`',
	'  (host directory picker), `upload`, `tabs`, `form`, `wizard`.',
	'- `button` answers at once with `action: "button"` and its `id` in `button`.',
	'- `required: true` and `maxlength` are enforced by the panel itself: an empty required',
	'  field blocks submission and is highlighted, with the missing fields listed by the button.',
	'',
	'`interactive_ui_gallery` draws every kind; the tool description documents each kind\'s fields.',
	'`interactive_ui_history` is how you recover an earlier decision — including one that has',
	'fallen out of a compacted context. It also leaves a read-only snapshot panel behind, so the',
	'user can page through their earlier answers themselves; pass `view: false` for JSON only.',
	'',
	'## When the turn is interrupted',
	'',
	'If the user interrupts the turn while a panel is open, the call **fails** instead of',
	'returning an answer. That is not a decision: it is neither an approval nor a rejection.',
	'- Never read a vague follow-up ("continue", "go on") as consent for what the panel asked.',
	'- Never run a destructive or irreversible action on the strength of an interruption.',
	'- Call `interactive_ui_history` with the callId to read the final `action`:',
	'  `cancelled` (interrupted — re-ask), `cancel` (explicit no), `submit` (answered).',
	'',
	'## 面板备注（Panel note）',
	'',
	'每块需要作答的面板，底部都会固定出现一行小字和一个备注框（只读面板与 `_gallery` 除外）。',
	'',
	'- 小字提醒用户：选项若不合意，不必勉强选择——可以提意见、补充新需求，或直接说明真正想要的东西。',
	'- 备注框是自由文本，答案随 `values.user_note` 一起返回（字符串，可能为空）。',
	'',
	'**读答案时必须先看 `user_note`，再决定怎么处理选项。**',
	'',
	'- 备注为空：按原契约处理 `action` 与 `values`。',
	'- 备注是补充说明（额外要求、偏好、约束）：把它当作本次决策的一部分，与选项一并执行。',
	'- 备注表达了选项之外的选择：**以备注为准**。不要强行套用用户点选的那一项，也不要回一句"你选了 A"。',
	'  用户写备注，往往正是因为 A/B 都不是他想要的。',
	'- 备注是提意见或指出问题（选项不对、理解有误、漏了某种可能）：先按备注修正理解再继续；',
	'  必要时重开一块面板，而不是把旧选项硬解释成备注的意思。',
	'- 备注非空时**不可**视为作答无效，也**不可**要求用户"从选项里选一个"。备注本身就是有效作答。',
	'',
	'其它规则：',
	'',
	'- 不要在 `elements` 里自己再加备注框——插件已强制添加，重复会出现两个输入区。',
	'- 不要把备注当噪音丢弃；它是用户主动表达的信号，比点选更强。',
	'- 备注只在本次面板有效，不要跨面板复用。',
	'',
	'## Habits that matter',
	'',
	'- One panel per decision. Beyond roughly eight elements the user starts skimming.',
	'- Always give a `title` (what is being decided) and, when it helps, a `subtitle`.',
	'- Write labels in the language the user is writing in.',
	'- When a panel *is* the deliverable — a choice, a confirmation, a filled form — prefer it',
	'  over asking the same question in prose and waiting for a typed reply.',
].join('\n')

/** Does another plugin currently provide this tool? */
function hasTool(ctx, toolName) {
	try {
		const viaGet = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
		const service = viaGet !== undefined ? viaGet : ctx.tools
		if (service === undefined || typeof service.get !== 'function') return false
		return service.get(toolName) !== undefined
	} catch (error) {
		return false
	}
}

/**
 * The always-present capability note. The `visualize` half appears only when that
 * plugin is actually mounted, so the text never advertises a tool that is absent.
 * @param ctx - host cordis context.
 * @returns the section text.
 */
function capabilityText(ctx) {
	const panel = [
		'- interactive_ui blocks until the user answers; that answer is the tool result.',
		'  interactive_ui_template covers approval / picker / plan / survey / form;',
		'  interactive_ui_history replays answers; interactive_ui_gallery draws all widgets.',
	]
	const card = hasTool(ctx, 'visualize')
	const lines = card
		? [
			'Two in-conversation surfaces, and they are not interchangeable:',
			...panel,
			'- visualize renders a card the user explores on their own: nothing comes back to you.',
		]
		: ['In-conversation UI — the interactive_ui tool family:', ...panel]
	lines.push(
		'One test decides: do you need their answer before you can continue?',
		card
			? 'Yes: a panel instead of asking in prose. No, and the value is in seeing it: a card.'
			: 'Yes: a panel instead of asking in prose. No: do not ask at all.',
		'An interrupted panel call is not consent — check the action via interactive_ui_history.',
	)
	return lines.join('\n')
}

/**
 * @param ctx - host cordis context.
 * @param config - optional `config:` block from cordis.patch.yml. Absent or
 *   empty means the defaults: the note box is on, with the built-in wording.
 *   `{ note: false }` restores the pre-0.9 behaviour (no forced note box).
 */
export function apply(ctx, config) {
	applyOptions(config)
	const logger = ctx.get('logger')
	const warn = (message, error) => {
		if (logger !== undefined && typeof logger.warn === 'function') logger.warn(message, error)
		else console.warn(message, error)
	}

	ctx.effect(() => {
		const disposers = []
		for (const definition of [TOOL_DEFINITION, TEMPLATE_DEFINITION, HISTORY_DEFINITION, GALLERY_DEFINITION]) {
			try {
				disposers.push(ctx.tools.register(definition))
			} catch (error) {
				warn(`[${name}] failed to register ${definition.name}`, error)
			}
		}
		return () => {
			for (const dispose of disposers) if (typeof dispose === 'function') dispose()
		}
	}, `${name}: tools`)

	/** Run `wiring` against one optional service: now if it is already up, otherwise
	 * when cordis injects it. A service that never arrives costs a warning, never a
	 * half-applied plugin. */
	const whenAvailable = (serviceName, wiring) => {
		let service
		try {
			service = ctx.get(serviceName)
		} catch (error) {
			service = undefined
		}
		if (service !== undefined) {
			try {
				wiring(ctx, service)
			} catch (error) {
				warn(`[${name}] ${serviceName} wiring failed`, error)
			}
			return
		}
		if (typeof ctx.inject !== 'function') {
			warn(`[${name}] no ${serviceName} service: that wiring is skipped`)
			return
		}
		try {
			const dispose = ctx.inject([serviceName], (scoped) => {
				try {
					wiring(scoped, scoped.get(serviceName))
				} catch (error) {
					warn(`[${name}] ${serviceName} wiring failed`, error)
				}
			})
			if (typeof dispose === 'function') disposers.push(dispose)
		} catch (error) {
			warn(`[${name}] cannot wait for the ${serviceName} service`, error)
		}
	}
	const disposers = []

	ctx.effect(() => {
		whenAvailable('skills', (_, skills) => {
			disposers.push(skills.register({
				name: SKILL_NAME,
				description: SKILL_DESCRIPTION,
				whenToUse: SKILL_WHEN_TO_USE,
				// `register()` defaults invocation and provider but NOT source, and the
				// harness prints/renders that field: without it the skill shows up sourceless.
				source: 'runtime',
				content: SKILL_CONTENT,
			}))
		})
		whenAvailable('systemPrompt', (scoped, systemPrompt) => {
			disposers.push(systemPrompt.section({
				name: SECTION_NAME,
				order: SECTION_ORDER,
				text: () => capabilityText(scoped ?? ctx),
			}))
		})
		return () => {
			for (const dispose of disposers) if (typeof dispose === 'function') dispose()
		}
	}, `${name}: capability`)

	ctx.effect(() => {
		try {
			const webServer = ctx.get('webServer')
			clientModules = ctx.get('clientModules')
			if (webServer === undefined) {
				warn(`[${name}] no webServer service: the panel UI will not work`)
				return () => {}
			}
			return webServer.register({
				kind: 'prefix',
				path: ROUTE_PREFIX,
				handler: (req, res) => serve(req, res),
			})
		} catch (error) {
			warn(`[${name}] failed to register ${ROUTE_PREFIX}`, error)
			return () => {}
		}
	}, `${name}: route`)
}

/** Test-only surface: the DSH loader reads `name` / `inject` / `apply` only, so
 * this extra export is inert. It lets test/selftest.mjs prove that every
 * supported kind is documented and demonstrated in the gallery, and that every
 * panel template expands into a valid spec. */
export const __selftest = { KINDS, TEMPLATES, GALLERY_SPEC, DESCRIPTION, TEMPLATE_DESCRIPTION, expandTemplate, buildSpec, historySpec, historyStamp, historyValueText, HISTORY_PAGE_SIZE, HISTORY_VIEW_MAX, ACTION_LABEL, SKILL_NAME, SECTION_NAME, SECTION_ORDER, SKILL_CONTENT, capabilityText, NOTE_ID, NOTE_LABEL, NOTE_HINT, options, applyOptions, noteOn, hasNoteBox, noteBox }
