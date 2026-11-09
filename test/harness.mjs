/**
 * Shared plumbing for the two offline renderers:
 *
 *   test/preview.mjs     — writes docs/preview.html
 *   test/screenshot.mjs  — renders the same markup in Chrome and diffs it
 *                          against docs/preview-baseline/*.png
 *
 * Both build a page straight from the client bundle, with no DSH and no
 * browser framework: a minimal React stub, the bundle loader, and a vnode ->
 * HTML serializer. Keeping them here means the preview page and the screenshot
 * baseline can never disagree about how a panel becomes markup.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/* ------------------------------------------------------------------ *
 * minimal React stub — enough for the components under test
 * ------------------------------------------------------------------ */

export function makeReact() {
	return {
		createElement(type, props, ...children) {
			const merged = { ...(props ?? {}) }
			const kids = children.filter((child) => child !== undefined && child !== null)
			if (kids.length === 1) merged.children = kids[0]
			else if (kids.length > 1) merged.children = kids
			return { __vnode: true, type, props: merged }
		},
		useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
		useEffect() {},
	}
}

/**
 * Import the browser half of the plugin and hand back its exports.
 * @param root - the plugin root (the directory holding `lib/`).
 * @param React - the stub from `makeReact()`.
 */
export async function loadClient(root, React) {
	let loaded = null
	globalThis.window = { __ModuleLoader__: { load(spec) { loaded = spec } } }
	globalThis.fetch = () => Promise.reject(new Error('offline preview'))
	await import(pathToFileURL(join(root, 'lib', 'client.js')).href)
	return loaded.factory((id) => {
		if (id === 'react' || id === 'react-dom') return React
		throw new Error(`unexpected require("${id}")`)
	})
}

/* ------------------------------------------------------------------ *
 * vnode -> html
 * ------------------------------------------------------------------ */

const VOID = new Set(['input', 'img', 'br', 'hr', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'use', 'source'])
const UNITLESS = new Set(['opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'order', 'zoom'])
// SVG/HTML attributes React writes camelCase: keep these, kebab-case every other camelCase name.
const CAMEL_ATTRS = new Set(['viewBox', 'preserveAspectRatio', 'patternUnits', 'patternContentUnits', 'gradientUnits', 'markerWidth', 'markerHeight', 'refX', 'refY', 'textLength', 'lengthAdjust', 'baseFrequency', 'numOctaves', 'stdDeviation', 'gradientTransform', 'clipPathUnits', 'maskUnits', 'maskContentUnits', 'startOffset', 'attributeName', 'repeatCount', 'spreadMethod'])
const camel = (key) => key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
// HTML attribute names are case-insensitive, so React props like maxLength land
// as `maxlength` in the DOM. Only SVG needs the kebab-case translation.
const SVG = new Set(['svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'use', 'symbol', 'marker'])
const HTML_ATTRS = { maxLength: 'maxlength', minLength: 'minlength', readOnly: 'readonly', autoComplete: 'autocomplete', autoFocus: 'autofocus', colSpan: 'colspan', rowSpan: 'rowspan', tabIndex: 'tabindex', contentEditable: 'contenteditable', inputMode: 'inputmode', enterKeyHint: 'enterkeyhint', spellCheck: 'spellcheck', srcSet: 'srcset', useMap: 'usemap', dateTime: 'datetime', accessKey: 'accesskey' }
const attrName = (key, tag) => {
	if (key === 'htmlFor') return 'for'
	if (SVG.has(tag)) {
		if (CAMEL_ATTRS.has(key)) return key
		return /[A-Z]/.test(key) ? camel(key) : key
	}
	if (Object.prototype.hasOwnProperty.call(HTML_ATTRS, key)) return HTML_ATTRS[key]
	return key
}
export const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function styleText(style) {
	const parts = []
	for (const [key, value] of Object.entries(style ?? {})) {
		if (value === undefined || value === null) continue
		const text = typeof value === 'number' && !UNITLESS.has(key) ? `${value}px` : String(value)
		parts.push(`${camel(key)}:${escape(text)}`)
	}
	return parts.join(';')
}

function attrs(props, tag) {
	const parts = []
	for (const [key, value] of Object.entries(props)) {
		if (key === 'children' || key === 'key' || key === 'ref' || key.startsWith('on')) continue
		if (key === 'style') {
			const text = styleText(value)
			if (text !== '') parts.push(`style="${text}"`)
			continue
		}
		if (key === 'className') {
			if (value) parts.push(`class="${escape(Array.isArray(value) ? value.filter(Boolean).join(' ') : value)}"`)
			continue
		}
		if (value === undefined || value === null || value === false) continue
		if (value === true) { parts.push(key); continue }
		parts.push(`${attrName(key, tag)}="${escape(value)}"`)
	}
	return parts.length > 0 ? ' ' + parts.join(' ') : ''
}

export function render(node) {
	if (node === null || node === undefined || node === false || node === true) return ''
	if (Array.isArray(node)) return node.map(render).join('')
	if (typeof node === 'string' || typeof node === 'number') return escape(node)
	if (typeof node.type === 'function') return render(node.type(node.props))
	const tag = node.type
	const body = render(node.props.children)
	return VOID.has(tag) ? `<${tag}${attrs(node.props, tag)} />` : `<${tag}${attrs(node.props, tag)}>${body}</${tag}>`
}

/* ------------------------------------------------------------------ *
 * theme tokens — approximations of the DSH theme, so a panel looks the
 * same in the generated page as it does inside the conversation
 * ------------------------------------------------------------------ */

export const TOKENS = {
	light: {
		'--dsw-alias-bg-layer-1': '#ffffff',
		'--dsw-alias-bg-layer-2': '#f6f6f7',
		'--dsw-alias-border-l3': 'rgba(0,0,0,0.10)',
		'--dsw-alias-border-l4': 'rgba(0,0,0,0.16)',
		'--dsw-alias-brand-primary': '#4d6bfe',
		'--dsw-alias-link': '#4d6bfe',
		'--dsw-alias-button-primary-fill': '#4d6bfe',
		'--dsw-alias-button-primary-hover': '#3f5ce8',
		'--dsw-alias-label-primary': 'rgba(0,0,0,0.92)',
		'--dsw-alias-label-primary-foreground': '#ffffff',
		'--dsw-alias-label-secondary': 'rgba(0,0,0,0.62)',
		'--dsw-alias-label-tertiary': 'rgba(0,0,0,0.44)',
		'--dsw-alias-label-dimmed': 'rgba(0,0,0,0.30)',
		'--dsw-alias-interactive-bg-hover': 'rgba(0,0,0,0.05)',
		'--dsw-alias-interactive-bg-active': 'rgba(0,0,0,0.09)',
		'--dsw-alias-markdown-code-block': '#f6f6f7',
		'--dsw-alias-markdown-code-block-banner': 'rgba(0,0,0,0.04)',
		'--dsw-alias-markdown-inline-code': 'rgba(0,0,0,0.06)',
		'--dsw-alias-code-diff-added': 'rgba(34,197,94,0.14)',
		'--dsw-alias-code-diff-deleted': 'rgba(239,68,68,0.14)',
		'--dsw-alias-state-success-primary': '#16a34a',
		'--dsw-alias-state-warn-primary': '#d97706',
		'--dsw-alias-state-error-primary': '#dc2626',
		'--dsw-alias-state-business-primary': '#4d6bfe',
		'--dsw-alias-state-idle-primary': 'rgba(0,0,0,0.35)',
		'--dsw-alias-scrollbar-bg-l2': 'rgba(0,0,0,0.16)',
		'--dsw-alias-scrollbar-hover-l2': 'rgba(0,0,0,0.30)',
		'--dsw-static-amber-400': '#fbbf24',
		'--dsw-static-green-500': '#22c55e',
		'--dsw-static-red-600': '#dc2626',
		'--dsw-static-deepseek-450': '#4d6bfe',
		'--dsw-elevation-soft': '0 1px 2px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.06)',
		'--dsw-focus-ring-color': 'rgba(77,107,254,0.5)',
		'--dsw-focus-ring-width': '2px',
		'color-scheme': 'light',
	},
	dark: {
		'--dsw-alias-bg-layer-1': '#26272b',
		'--dsw-alias-bg-layer-2': '#1c1d20',
		'--dsw-alias-border-l3': 'rgba(255,255,255,0.10)',
		'--dsw-alias-border-l4': 'rgba(255,255,255,0.16)',
		'--dsw-alias-brand-primary': '#7d92ff',
		'--dsw-alias-link': '#7d92ff',
		'--dsw-alias-button-primary-fill': '#4d6bfe',
		'--dsw-alias-button-primary-hover': '#5f79ff',
		'--dsw-alias-label-primary': 'rgba(255,255,255,0.92)',
		'--dsw-alias-label-primary-foreground': '#ffffff',
		'--dsw-alias-label-secondary': 'rgba(255,255,255,0.66)',
		'--dsw-alias-label-tertiary': 'rgba(255,255,255,0.46)',
		'--dsw-alias-label-dimmed': 'rgba(255,255,255,0.30)',
		'--dsw-alias-interactive-bg-hover': 'rgba(255,255,255,0.07)',
		'--dsw-alias-interactive-bg-active': 'rgba(255,255,255,0.12)',
		'--dsw-alias-markdown-code-block': 'rgba(0,0,0,0.32)',
		'--dsw-alias-markdown-code-block-banner': 'rgba(255,255,255,0.06)',
		'--dsw-alias-markdown-inline-code': 'rgba(255,255,255,0.10)',
		'--dsw-alias-code-diff-added': 'rgba(34,197,94,0.18)',
		'--dsw-alias-code-diff-deleted': 'rgba(239,68,68,0.18)',
		'--dsw-alias-state-success-primary': '#4ade80',
		'--dsw-alias-state-warn-primary': '#fbbf24',
		'--dsw-alias-state-error-primary': '#f87171',
		'--dsw-alias-state-business-primary': '#7d92ff',
		'--dsw-alias-state-idle-primary': 'rgba(255,255,255,0.40)',
		'--dsw-alias-scrollbar-bg-l2': 'rgba(255,255,255,0.18)',
		'--dsw-alias-scrollbar-hover-l2': 'rgba(255,255,255,0.32)',
		'--dsw-static-amber-400': '#fbbf24',
		'--dsw-static-green-500': '#22c55e',
		'--dsw-static-red-600': '#dc2626',
		'--dsw-static-deepseek-450': '#7d92ff',
		'--dsw-elevation-soft': '0 1px 2px rgba(0,0,0,0.4), 0 6px 18px rgba(0,0,0,0.35)',
		'--dsw-focus-ring-color': 'rgba(125,146,255,0.55)',
		'--dsw-focus-ring-width': '2px',
		'color-scheme': 'dark',
	},
	shared: {
		'--dsw-radius-xs': '4px',
		'--dsw-radius-sm': '6px',
		'--dsw-radius-md': '8px',
		'--dsw-radius-lg': '12px',
		'--dsw-corner-shape': 'round',
		'--dsw-font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
		'--dsw-font-markdown-code-font-family': 'ui-monospace, SFMono-Regular, "Cascadia Code", Consolas, monospace',
		'--ds-transition-duration': '0.16s',
		'--ds-transition-duration-fast': '0.10s',
		'--ds-ease-in-out': 'cubic-bezier(0.4, 0, 0.2, 1)',
	},
}

export const tokenBlock = (name, extra) =>
	`\t\t:root${name === 'light' ? '' : name} {\n` +
	Object.entries({ ...TOKENS.shared, ...extra })
		.map(([key, value]) => `\t\t\t${key}: ${value};`)
		.join('\n') +
	'\n\t\t}\n'
