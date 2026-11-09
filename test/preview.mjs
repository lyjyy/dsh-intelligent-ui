/**
 * dsh-intelligent-ui — static component preview generator.
 *
 * Renders every widget of GALLERY_SPEC into a standalone HTML page
 * (docs/preview.html) so the visual design can be reviewed — and themed —
 * without a running DSH.
 *
 *   node test/preview.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadClient, makeReact, render, escape, TOKENS, tokenBlock } from './harness.mjs'
import { ANSWERED, HISTORY_SAMPLE, HISTORY_TOTAL } from './cases.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OUT = join(ROOT, 'docs', 'preview.html')
/** Same number the panel badge shows, so the preview cannot drift from it. */
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

const mod = await loadClient(ROOT, makeReact())
const { GALLERY_SPEC, historySpec } = (await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)).__selftest


const pluginCss = (Array.isArray(mod.__selftest.css) ? mod.__selftest.css.join('\n') : String(mod.__selftest.css))

const previewState = (element) => {
	const values = mod.__selftest.initialValues({ elements: [element] })
	return { values, busy: false, set() {}, submit() {}, callId: 'preview', setBusy() {}, setNote() {} }
}

const cards = []
for (const element of GALLERY_SPEC.elements) {
	let body = ''
	let failed = ''
	try {
		body = render(mod.__selftest.widget(element, 0, previewState(element), []))
	} catch (error) {
		failed = `<p class="iui-text iui-text--error">render failed: ${escape(error.message)}</p>`
	}
	if (body === '' && failed === '') body = '<p class="iui-muted">（该控件在给定数据下为空）</p>'
	cards.push(
		`\t\t<section class="pv-cell">\n` +
			`\t\t\t<div class="pv-kind">${escape(element.kind)}</div>\n` +
			`\t\t\t<div class="iui-panel">${failed || body}</div>\n` +
			`\t\t</section>`,
	)
}

/* ------------------------------------------------------------------ *
 * the answered state — what the panel becomes once the user replied
 * ------------------------------------------------------------------ */

const answerCards = []
for (const testCase of ANSWERED) {
	let body = ''
	try {
		body = render(mod.__selftest.answerSummary(testCase.spec, testCase.action, testCase.values, testCase.button ?? ''))
		// production renders every summary collapsed; the preview opens the cases that
		// have rows, so the page shows both the folded head and what sits one click down
		if (testCase.open === true) body = body.replace('<details class="iui-ans-details">', '<details class="iui-ans-details" open>')
	} catch (error) {
		body = `<p class="iui-text iui-text--error">render failed: ${escape(error.message)}</p>`
	}
	answerCards.push(
		`\t\t<section class="pv-cell">\n` +
			`\t\t\t<div class="pv-kind">${escape(testCase.name)}</div>\n` +
			`\t\t\t<div class="iui-panel">${body}</div>\n` +
			`\t\t</section>`,
	)
}

/* ------------------------------------------------------------------ *
 * the history panel — what `interactive_ui_history` draws
 * ------------------------------------------------------------------ */


const historyCards = []
try {
	const spec = historySpec(HISTORY_SAMPLE, { total: HISTORY_TOTAL, all_sessions: false })
	const head =
		`<div class="iui-head"><div class="iui-eyebrow"><span class="iui-dot"></span>` +
		`<span>Interactive panel</span><span class="iui-ver">v${escape(VERSION)}</span></div>` +
		`<div class="iui-title">${escape(spec.title ?? '')}</div>` +
		`<div class="iui-subtitle">${escape(spec.subtitle ?? '')}</div></div>`
	const state = {
		values: mod.__selftest.initialValues(spec),
		busy: false,
		set() {},
		submit() {},
		callId: 'preview-history',
		setBusy() {},
		setNote() {},
	}
	const body = spec.elements
		.map((element, index) => {
			try {
				return render(mod.__selftest.widget(element, index, state, [])) ?? ''
			} catch (error) {
				return `<p class="iui-text iui-text--error">render failed: ${escape(error.message)}</p>`
			}
		})
		.join('')
	historyCards.push(
		`\t\t<section class="pv-cell pv-cell--wide">\n` +
			`\t\t\t<div class="pv-kind">interactive_ui_history · 只读分页快照</div>\n` +
			`\t\t\t<div class="iui-panel">${head}<div class="iui-body">${body}</div>` +
			`<div class="iui-hint">只读面板 · 无需作答</div></div>\n` +
			`\t\t</section>`,
	)
} catch (error) {
	historyCards.push(
		`\t\t<section class="pv-cell"><div class="pv-kind">interactive_ui_history · 渲染失败</div>` +
			`<div class="iui-panel"><p class="iui-text iui-text--error">${escape(error.message)}</p></div></section>`,
	)
}

const eyebrow =
	`<div class="iui-panel pv-panel"><div class="iui-eyebrow"><span class="iui-dot"></span>` +
	`<span class="iui-eyebrow-label">${escape(GALLERY_SPEC.title ?? '组件预览')}</span>` +
	`<span class="iui-ver">v${escape(VERSION)}</span></div>` +
	`<p class="iui-sub">${escape(GALLERY_SPEC.subtitle ?? '')}</p>`

const html = `<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-intelligent-ui · 组件预览</title>
<style>
${tokenBlock('light', TOKENS.light)}
${tokenBlock('[data-theme="dark"]', TOKENS.dark)}
* { box-sizing: border-box; }
body {
	margin: 0;
	padding: 28px 32px 64px;
	background: var(--dsw-alias-bg-layer-2);
	color: var(--dsw-alias-label-primary);
	font-family: var(--dsw-font-family);
	font-size: 13px;
	line-height: 1.5;
}
header.pv-head { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
header.pv-head h1 { font-size: 16px; margin: 0; font-weight: 600; }
button.pv-toggle {
	margin-left: auto; font: inherit; font-size: 12px; cursor: pointer;
	color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
	border: 1px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm);
	padding: 5px 10px;
}
p.pv-note { color: var(--dsw-alias-label-tertiary); margin: 0 0 20px; font-size: 12px; }
.pv-panel { margin-bottom: 18px; }
.pv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 18px 16px; align-items: start; }
.pv-cell { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.pv-cell--wide { grid-column: 1 / -1; }
.pv-cell > .iui-panel { margin: 0; }
.pv-kind {
	font: 500 10.5px/1.4 var(--dsw-font-markdown-code-font-family);
	letter-spacing: 0.06em;
	color: var(--dsw-alias-label-tertiary);
}
.pv-h2 { font-size: 13px; font-weight: 600; margin: 26px 0 0; color: var(--dsw-alias-label-secondary); }
</style>
<style>
/* plugin stylesheet, verbatim */
${pluginCss}
</style>
</head>
<body>
<header class="pv-head">
	<h1>dsh-intelligent-ui · 组件预览</h1>
	<button class="pv-toggle" onclick="var r=document.documentElement;r.dataset.theme=r.dataset.theme==='dark'?'light':'dark';stamp()">切换明/暗</button>
</header>
<p class="pv-note">静态预览：由 <code>node test/preview.mjs</code> 从 lib/index.js 的 GALLERY_SPEC 生成，使用插件自己的样式表。DSH 令牌在此处填的是近似值，实际界面里由 DSH 主题提供。</p>
${eyebrow}
</div>
<main class="pv-grid">
${cards.join('\n')}
</main>
<h2 class="pv-h2">回答之后</h2>
<p class="pv-note">面板提交 / 取消之后的样子：逐项把答案还原成标签、勾选、数值和文件，而不是一段 JSON。</p>
<main class="pv-grid">
${answerCards.join('\n')}
</main>
<h2 class="pv-h2">历史作答</h2>
<p class="pv-note">interactive_ui_history 现在会顺手留下一块只读快照：最近的作答按页签分页，每页是一条时间线。</p>
<main class="pv-grid">
${historyCards.join('\n')}
</main>
<script>
// mirror production: stamp the active scheme onto every panel so native controls
// (select/checkbox/date/slider) follow the page instead of the OS
function stamp() {
	var dark = document.documentElement.dataset.theme === 'dark'
	var list = document.querySelectorAll('.iui-panel')
	for (var i = 0; i < list.length; i += 1) {
		list[i].classList.toggle('is-dark', dark)
		list[i].classList.toggle('is-light', !dark)
	}
}
stamp()
</script>
</body>
</html>
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, html, 'utf8')
console.log(`preview written: ${OUT}`)
console.log(`widgets: ${GALLERY_SPEC.elements.length}, kinds: ${new Set(GALLERY_SPEC.elements.map((e) => e.kind)).size}`)