/**
 * Screenshot baseline for the "answered" panel state.
 *
 * There is no puppeteer in this profile, so this drives Chrome directly:
 *
 *   1. build one static page per theme with harness.mjs + cases.mjs,
 *   2. let headless Chrome write a PNG of it,
 *   3. diff that PNG against docs/preview-baseline/ with pixelmatch.
 *
 * Any visual change to `.iui-answered` — the collapsed summary, the verdict
 * chip, the fold marker, the row layout — now fails a command instead of
 * silently aging in a JPEG nobody looks at.
 *
 *   node test/screenshot.mjs           compare against the baselines
 *   node test/screenshot.mjs --update  rewrite the baselines
 *
 * Nothing here talks to DSH, so it runs in a second and is safe in a loop.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { loadClient, makeReact, render, TOKENS, tokenBlock } from './harness.mjs'
import { ANSWERED, HISTORY_SAMPLE, HISTORY_TOTAL } from './cases.mjs'

const ROOT = join(import.meta.dirname, '..')
const OUT_DIR = join(ROOT, 'docs', 'preview-baseline')
const TMP_DIR = join(ROOT, '_tmp')
const UPDATE = process.argv.includes('--update')

/* Fixed geometry: every number below is part of the baseline contract.
 * Chrome screenshots the viewport, so CAPTURE_HEIGHT is deliberately generous
 * and the image is then cropped to its content — that way a panel that grows
 * changes the PNG size, which is a louder failure than a few shifted pixels. */
const PAGE_WIDTH = 720
const CAPTURE_HEIGHT = 3600
const PADDING = 24
/* Measured drift between repeated runs is 0 px, so the budget only has to
 * absorb font-rasterisation jitter. Anything above this is a real change:
 * renaming the fold label moved ~750 px and must fail. */
const THRESHOLD = 0.1
const MAX_DIFF_PX = 40

/* Chrome wipes any of these from the command line; keep the list explicit so
 * a future flag addition is a deliberate edit rather than a typo. */
const THEMES = ['light', 'dark']

/* ------------------------------------------------------------------ *
 * chrome
 * ------------------------------------------------------------------ */

function findChrome() {
	const candidates = [
		process.env.CHROME_PATH,
		'C:/Program Files/Google/Chrome/Application/chrome.exe',
		'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
		'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
		'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
	]
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate)) return candidate
	}
	throw new Error('no Chrome/Edge found — set CHROME_PATH to a chromium executable')
}

/* ------------------------------------------------------------------ *
 * pixelmatch / pngjs live in the profile, not in this plugin
 * ------------------------------------------------------------------ */

function profileNodeModules() {
	const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
	return join(home, 'profiles', 'desktop', 'node_modules')
}

async function importFrom(name, relative) {
	const local = join(profileNodeModules(), relative)
	if (!existsSync(local)) throw new Error(`${name} not found at ${local}`)
	return import(pathToFileURL(local).href)
}

/* ------------------------------------------------------------------ *
 * page
 * ------------------------------------------------------------------ */

const PAGE_CSS = `
	* { box-sizing: border-box; }
	html, body { margin: 0; padding: 0; }
	body {
		width: ${PAGE_WIDTH}px;
		padding: ${PADDING}px;
		background: var(--dsw-alias-bg-layer-2);
		font-family: var(--dsw-font-family);
		-webkit-font-smoothing: antialiased;
		font-synthesis: none;
	}
	/* Determinism: no easing, no blinking caret, no scrollbar gutter. */
	*, *::before, *::after {
		animation: none !important;
		transition: none !important;
		caret-color: transparent !important;
	}
	.sb-case { margin: 0 0 14px; }
	.sb-label {
		font-size: 11px;
		letter-spacing: 0.02em;
		color: var(--dsw-alias-label-tertiary);
		margin: 0 0 6px 2px;
	}
	.sb-panel { background: var(--dsw-alias-bg-layer-1); border-radius: var(--dsw-radius-lg); padding: 10px 12px; }
`

/** Static history sample — the same one docs/preview.html draws. */
const { historySpec } = (await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)).__selftest

/**
 * The read-only panel `interactive_ui_history` leaves behind, as markup.
 *
 * It is not an `answerSummary` case: it goes through the ordinary widget path
 * inside a real panel shell, which is exactly what the browser half does with
 * the record the host remembered. Baselining it keeps the history view honest
 * too, not just the answered summary.
 */
function historyMarkup(mod) {
	const spec = historySpec(HISTORY_SAMPLE, { total: HISTORY_TOTAL, all_sessions: false })
	const state = {
		values: mod.__selftest.initialValues(spec),
		busy: false,
		set() {},
		submit() {},
		callId: 'screenshot-history',
		setBusy() {},
		setNote() {},
	}
	const body = spec.elements
		.map((element, index) => render(mod.__selftest.widget(element, index, state, [])) ?? '')
		.join('')
	const head =
		`<div class="iui-head"><div class="iui-eyebrow"><span class="iui-dot"></span>` +
		`<span>Interactive panel</span><span class="iui-ver">v${mod.__selftest.VERSION}</span></div>` +
		`<div class="iui-title">${spec.title ?? ''}</div>` +
		`<div class="iui-subtitle">${spec.subtitle ?? ''}</div></div>`
	return `<div class="iui-panel">${head}<div class="iui-body">${body}</div><div class="iui-hint">只读面板 · 无需作答</div></div>`
}

function buildHtml(theme, css, historyBody) {
	const body = ANSWERED.map((testCase) => {
		let markup = render(css.answerSummary(testCase.spec, testCase.action, testCase.values, testCase.button ?? ''))
		// The folded state is the default; `open` replays what a click reveals.
		if (testCase.open === true) markup = markup.replace('<details class="iui-ans-details">', '<details class="iui-ans-details" open>')
		return `\t<section class="sb-case"><p class="sb-label">${testCase.name}</p><div class="sb-panel">${markup}</div></section>`
	}).join('\n')

	return `<!doctype html>
<html lang="zh-CN" data-theme="${theme}">
<head>
	<meta charset="utf-8">
	<title>answered · ${theme}</title>
	<style>
${tokenBlock('', TOKENS.light)}
${tokenBlock('[data-theme="dark"]', TOKENS.dark)}
${css.plugin}
${PAGE_CSS}
	</style>
</head>
<body>
	<main>
${body}
	<section class="sb-case"><p class="sb-label">history · 只读分页快照</p><div class="sb-panel">${historyBody}</div></section>
	</main>
</body>
</html>
`
}

function shoot(chrome, htmlPath, pngPath) {
	if (existsSync(pngPath)) writeFileSync(pngPath, Buffer.alloc(0))
	execFileSync(chrome, [
		'--headless=new',
		'--disable-gpu',
		'--hide-scrollbars',
		'--disable-lcd-text',
		'--force-device-scale-factor=1',
		'--force-color-profile=srgb',
		'--font-render-hinting=none',
		'--run-all-compositor-stages-before-draw',
		'--virtual-time-budget=2000',
		`--window-size=${PAGE_WIDTH},${CAPTURE_HEIGHT}`,
		`--screenshot=${pngPath}`,
		pathToFileURL(htmlPath).href,
	], { stdio: 'pipe' })
	if (!existsSync(pngPath) || readFileSync(pngPath).length === 0) {
		throw new Error(`chrome wrote no PNG for ${htmlPath}`)
	}
}

/**
 * Chrome screenshots the whole viewport, which is mostly empty below the last
 * panel. Trim that away so the baseline is sized by the content: a panel that
 * grows or shrinks then shows up as a size mismatch, which is a much clearer
 * signal than a handful of shifted pixels.
 */
function cropToContent(PNG, pngPath) {
	const image = PNG.sync.read(readFileSync(pngPath))
	const background = [image.data[0], image.data[1], image.data[2], image.data[3]]
	const rowIsBlank = (y) => {
		for (let x = 0; x < image.width; x += 1) {
			const at = (image.width * y + x) << 2
			if (Math.abs(image.data[at] - background[0]) > 2) return false
			if (Math.abs(image.data[at + 1] - background[1]) > 2) return false
			if (Math.abs(image.data[at + 2] - background[2]) > 2) return false
		}
		return true
	}
	let last = image.height - 1
	while (last > 0 && rowIsBlank(last)) last -= 1
	const height = Math.min(image.height, last + 1 + PADDING)
	if (height === image.height) return
	const rowBytes = image.width << 2
	const data = Buffer.from(image.data.subarray(0, rowBytes * height))
	writeFileSync(pngPath, PNG.sync.write({ width: image.width, height, data }))
}

/* ------------------------------------------------------------------ *
 * compare
 * ------------------------------------------------------------------ */

async function compare(PNG, pixelmatch, actualPath, baselinePath, diffPath) {
	const actual = PNG.sync.read(readFileSync(actualPath))
	const baseline = PNG.sync.read(readFileSync(baselinePath))

	if (actual.width !== baseline.width || actual.height !== baseline.height) {
		return { ok: false, reason: `size ${actual.width}x${actual.height} ≠ baseline ${baseline.width}x${baseline.height}` }
	}

	const diff = new PNG({ width: actual.width, height: actual.height })
	const changed = pixelmatch(actual.data, baseline.data, diff.data, actual.width, actual.height, { threshold: THRESHOLD })
	if (changed > MAX_DIFF_PX) {
		writeFileSync(diffPath, PNG.sync.write(diff))
		const ratio = ((changed / (actual.width * actual.height)) * 100).toFixed(3)
		return { ok: false, reason: `${changed} px differ (${ratio}%), budget ${MAX_DIFF_PX} — diff at ${diffPath}`, changed }
	}
	return { ok: true, changed }
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

const mod = await loadClient(ROOT, makeReact())
const answerSummary = mod.__selftest.answerSummary
if (typeof answerSummary !== 'function') throw new Error('client bundle does not export answerSummary')

const rawCss = mod.__selftest.css
const css = { answerSummary, plugin: Array.isArray(rawCss) ? rawCss.join('\n') : String(rawCss) }
const historyBody = historyMarkup(mod)
const { PNG } = await importFrom('pngjs', join('pngjs', 'lib', 'png.js'))
const { default: pixelmatch } = await importFrom('pixelmatch', join('pixelmatch', 'index.js'))

const chrome = findChrome()
mkdirSync(OUT_DIR, { recursive: true })
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true })

let failed = 0
const rows = []

for (const theme of THEMES) {
	const htmlPath = join(TMP_DIR, `screenshot-${theme}.html`)
	const actualPath = join(TMP_DIR, `screenshot-${theme}.png`)
	const baselinePath = join(OUT_DIR, `panels-${theme}.png`)
	const diffPath = join(OUT_DIR, `panels-${theme}.diff.png`)

	writeFileSync(htmlPath, buildHtml(theme, css, historyBody), 'utf8')
	shoot(chrome, htmlPath, actualPath)
	cropToContent(PNG, actualPath)

	if (UPDATE === true || !existsSync(baselinePath)) {
		writeFileSync(baselinePath, readFileSync(actualPath))
		rows.push(`  ${UPDATE === true ? 'wrote' : 'init '}  panels-${theme}.png`)
		continue
	}

	const result = await compare(PNG, pixelmatch, actualPath, baselinePath, diffPath)
	if (result.ok === true) {
		rows.push(`  ok     panels-${theme}.png  (${result.changed} px drifted, budget ${MAX_DIFF_PX})`)
	} else {
		failed += 1
		rows.push(`  FAIL   panels-${theme}.png  ${result.reason}`)
	}
}

console.log('screenshot baseline')
for (const row of rows) console.log(row)
if (UPDATE === true) console.log('\nbaselines rewritten — review the images before committing them')
console.log(`\nRESULT: ${failed === 0 ? 'PASSED' : 'FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
