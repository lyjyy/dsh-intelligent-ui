/**
 * dsh-intelligent-ui — browser half.
 *
 * Registers the conversation-inline view for the `interactive_ui` tool. The view
 * fetches the panel spec from the host bridge by callId, renders widgets, and
 * POSTs the user's answer back; the host then resolves the blocked tool call.
 *
 * Written by hand in the loader's CommonJS wrapper format, so the package needs
 * no build step. Only `react` is required; the optional `uiWorkspace` service is
 * used opportunistically for the host-native directory picker.
 */
window.__ModuleLoader__.load({
	id: 'dsh-intelligent-ui',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		var React = require('react');
		var h = React.createElement;

		var NS = 'dsh-intelligent-ui';
		var ROUTE = '/api/dsh-intelligent-ui';
		var TOOL_NAME = 'interactive_ui';
		/** The gallery tool leaves a read-only panel behind, so it shares the view. */
		var GALLERY_TOOL_NAME = 'interactive_ui_gallery';
		/** The template tool expands into a normal spec and blocks the same way, so
		 * it must share the view too — without this entry its panel never renders
		 * and the host-side `await answer` never settles. */
		var TEMPLATE_TOOL_NAME = 'interactive_ui_template';
		/** The history tool keeps its JSON answer but leaves a read-only snapshot
		 * panel behind, so it shares the view too. Appended last on purpose: the
		 * self-test renders `registrations[0]`, which must stay the main panel. */
		var HISTORY_TOOL_NAME = 'interactive_ui_history';
		var POLL_ATTEMPTS = 25;
		var POLL_DELAY = 400;
		/** Bumped by hand with package.json — shown in the panel header so it is
		 * obvious which bundle the browser is actually running. */
		var VERSION = '0.12.0';
		/** How often the bundle watcher asks the host for the published revision. */
		var WATCH_MS = 4000;
		/** Keys under this prefix are client-only UI state and never submitted. */
		var PRIVATE = '__';
		/** The note box the host forces onto every answer-collecting panel. The
		 * browser never builds that box (the host appends it to the spec), it only
		 * needs the id to hide the row again when the note is empty. */
		var NOTE_ID = 'user_note';
		/** Chart/series colours, resolved from the DSH theme where available. */
		var PALETTE = [
			'var(--iui-accent-fill, #3b82f6)',
			'var(--iui-ok-fill, #22c55e)',
			'var(--iui-warn-fill, #f59e0b)',
			'var(--dsw-static-deepseek-450, #4d6bfe)',
			'var(--iui-err-fill, #ef4444)',
			'var(--dsw-static-amber-400, #eab308)',
			'var(--dsw-static-green-500, #14b8a6)',
			'var(--dsw-static-red-600, #ec4899)',
		];

		/** The client cordis context, captured by apply() for optional services. */
		var clientCtx = null;

		/* ------------------------------------------------------------ *
		 * styles
		 * ------------------------------------------------------------ */

		var STYLE_ID = 'dsh-intelligent-ui-styles';
		var CSS = [
			/* ------------------------------------------------------------------ *
			* DSH theme bridge.
			*
			* Every colour below resolves through a DSH design token first, so the
			* panel follows the active theme (light/dark, brand colour, any theme the
			* user installs) and falls back to a self-contained palette when a token is
			* absent — the panel still renders correctly outside the DSH shell.
			* ------------------------------------------------------------------ */
			'.iui-panel{--iui-accent:var(--dsw-alias-brand-primary,#3b82f6);',
			'--iui-focus-c:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3b82f6));',
			'--iui-focus-w:var(--dsw-focus-ring-width,2px);',
			'--iui-fg:var(--dsw-alias-label-primary,inherit);',
			'--iui-fg2:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));',
			'--iui-fg3:var(--dsw-alias-label-tertiary,rgba(128,128,128,.78));',
			'--iui-dim:var(--dsw-alias-label-dimmed,rgba(128,128,128,.6));',
			/* Eye-friendly text: label colours are mixed toward the panel surface, so
			* light theme is not near-black on white and dark theme is not pure white on
			* near-black — both are glare. Body copy goes furthest, meta text barely
			* moves (it is already low contrast), titles keep a bit more punch. */
			'--iui-fg:color-mix(in srgb, var(--dsw-alias-label-primary,#141414) 74%, var(--iui-surface));',
			'--iui-fg2:color-mix(in srgb, var(--dsw-alias-label-secondary,rgba(128,128,128,.95)) 88%, var(--iui-surface));',
			'--iui-fg3:color-mix(in srgb, var(--dsw-alias-label-tertiary,rgba(128,128,128,.78)) 94%, var(--iui-surface));',
			'--iui-fg-strong:color-mix(in srgb, var(--dsw-alias-label-primary,#141414) 86%, var(--iui-surface));',
			'--iui-on-accent:var(--dsw-alias-label-primary-foreground,#fff);',
			'--iui-link:var(--dsw-alias-link,var(--dsw-alias-brand-primary,#3b82f6));',
			'--iui-ok:var(--dsw-alias-state-success-primary,#16a34a);',
			'--iui-warn:var(--dsw-alias-state-warn-primary,#d97706);',
			'--iui-err:var(--dsw-alias-state-error-primary,#dc2626);',
			'--iui-idle:var(--dsw-alias-state-idle-primary,rgba(128,128,128,.6));',
			'--iui-add:var(--dsw-alias-code-diff-added,rgba(22,163,74,.13));',
			'--iui-del:var(--dsw-alias-code-diff-deleted,rgba(220,38,38,.13));',
			'--iui-surface:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06));',
			'--iui-fill2:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12));',
			'--iui-fill:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));',
			'--iui-fill-a:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.16));',
			'--iui-line:var(--dsw-alias-border-l3,rgba(128,128,128,.34));',
			'--iui-line2:var(--dsw-alias-border-l4,rgba(128,128,128,.5));',
			'--iui-code-bg:var(--dsw-alias-markdown-code-block,rgba(128,128,128,.1));',
			'--iui-code-banner:var(--dsw-alias-markdown-code-block-banner,rgba(128,128,128,.14));',
			'--iui-code-inline:var(--dsw-alias-markdown-inline-code,rgba(128,128,128,.16));',
			'--iui-font:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",Helvetica,Arial,sans-serif);',
			'--iui-mono:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",Menlo,monospace);',
			'--iui-r-xs:var(--dsw-radius-xs,4px);--iui-r-sm:var(--dsw-radius-sm,8px);--iui-r-md:var(--dsw-radius-md,12px);--iui-r-lg:var(--dsw-radius-lg,16px);',
			'--iui-ease:var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1));',
			'--iui-t-fast:var(--ds-transition-duration-fast,.1s);--iui-t:var(--ds-transition-duration,.2s);',
			'--iui-corner:var(--dsw-corner-shape,superellipse(1.5));',
			'--iui-shadow:var(--dsw-elevation-soft,none);',
			/* Eye-friendly derived fills: large saturated areas are mixed toward the
			* panel surface so they keep the DSH hue without glaring; small marks (dot,
			* link, focus ring, timeline dots) keep the full-strength accent. Each has a
			* plain-colour declaration first so an engine without color-mix still works. */
			'--iui-accent-fill:var(--iui-accent);',
			'--iui-accent-fill:color-mix(in srgb, var(--iui-accent) 78%, var(--iui-surface));',
			/* Two tiers: big fills use --iui-accent-fill / --iui-*-fill (softened above),
			* small marks (checkbox, slider, step number, pick dot, dot, link, focus ring)
			* keep the full-strength token — a 15px control needs the crisp colour, and
			* --iui-on-accent is only legible on the unmixed fill. */
			'--iui-accent-edge:color-mix(in srgb, var(--iui-accent) 42%, var(--iui-line));',
			'--iui-accent-weak:color-mix(in srgb, var(--iui-accent) 12%, transparent);',
			'--iui-ok-fill:color-mix(in srgb, var(--iui-ok) 78%, var(--iui-surface));',
			'--iui-warn-fill:color-mix(in srgb, var(--iui-warn) 78%, var(--iui-surface));',
			'--iui-err-fill:color-mix(in srgb, var(--iui-err) 78%, var(--iui-surface));',
			'--iui-ok-text:color-mix(in srgb, var(--iui-ok) 72%, var(--iui-fg));',
			'--iui-warn-text:color-mix(in srgb, var(--iui-warn) 72%, var(--iui-fg));',
			'--iui-err-text:color-mix(in srgb, var(--iui-err) 72%, var(--iui-fg));',
			'--iui-add-fill:color-mix(in srgb, var(--iui-add) 76%, transparent);',
			'--iui-del-fill:color-mix(in srgb, var(--iui-del) 76%, transparent);',
			'box-sizing:border-box;color:var(--iui-fg);font-family:var(--iui-font);font-size:13.5px;line-height:1.5;',
			'corner-shape:var(--iui-corner);',
			'background:var(--iui-surface);background:color-mix(in srgb, var(--iui-surface) 90%, var(--iui-fill2));',
			'border:.5px solid var(--iui-line);border-radius:var(--iui-r-lg);',
			'padding:11px 13px 12px;margin:6px 0;display:flex;flex-direction:column;gap:10px;color-scheme:light dark;',
			'animation:iui-in .18s var(--iui-ease)}',
			'.iui-panel.is-light{color-scheme:light}',
			'.iui-panel.is-dark{color-scheme:dark}',
			'.iui-panel *{box-sizing:border-box}',
			/* header */
			'.iui-head{display:flex;flex-direction:column;gap:3px}',
			'.iui-eyebrow{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--iui-fg3)}',
			'.iui-dot{width:6px;height:6px;border-radius:50%;corner-shape:round;background:var(--iui-accent);box-shadow:0 0 0 3px var(--iui-fill2)}',
			/* which browser-side build is on screen — the reload affordance's twin */
			'.iui-ver{margin-left:auto;padding:1px 5px;font-size:10px;letter-spacing:0;text-transform:none;',
			'color:var(--iui-fg3);background:var(--iui-fill);border:1px solid var(--iui-line2);border-radius:var(--iui-r-xs)}',
			'.iui-title{font-size:14.5px;font-weight:600;line-height:1.35;color:var(--iui-fg-strong)}',
			'.iui-subtitle{font-size:12.5px;color:var(--iui-fg3)}',
			'.iui-body{display:flex;flex-direction:column;gap:10px}',
			/* text */
			'.iui-text{margin:0;color:var(--iui-fg2)}',
			'.iui-text--warn{color:var(--iui-warn-text)}.iui-text--error{color:var(--iui-err-text)}.iui-text--ok{color:var(--iui-ok-text)}',
			'.iui-text--quote{margin:0;padding:2px 0 2px 10px;border-left:2px solid var(--iui-line2);color:var(--iui-fg3)}',
			'.iui-label{font-size:12.5px;font-weight:600}',
			'.iui-hint{font-size:11.5px;font-weight:400;color:var(--iui-fg3)}',
			'.iui-muted{font-size:12.5px;color:var(--iui-fg3)}',
			'.iui-note{font-size:11.5px;color:var(--iui-err-text)}',
			/* the fixed line that explains the forced note box; it sits on its own
			 * row under the buttons, so it never fights them for width */
			'.iui-foot-hint{flex:1 1 100%;margin:0;font-size:11.5px;line-height:1.45;color:var(--iui-fg3)}',
			'.iui-count{font-size:10.5px;color:var(--iui-fg3);font-variant-numeric:tabular-nums}',
			'.iui-count.is-over{color:var(--iui-err-text)}',
			'.iui-req{color:var(--iui-err-text);font-weight:600;font-style:normal;margin-left:2px}',
			'.iui-field.is-missing .iui-input,.iui-field.is-missing .iui-area{border-color:var(--iui-err-text)}',
			'.iui-link{color:var(--iui-link);text-decoration:none;align-self:flex-start}',
			'.iui-link:hover{text-decoration:underline;text-underline-offset:2px}',
			/* form controls */
			'.iui-select,.iui-input,.iui-area{width:100%;height:32px;padding:0 9px;color:var(--iui-fg);background:var(--iui-surface);',
			'border:.5px solid var(--iui-line2);border-radius:var(--iui-r-md);corner-shape:var(--iui-corner);font-family:inherit;font-size:13px;line-height:30px}',
			'.iui-area{height:auto;min-height:64px;padding:7px 9px;line-height:1.5;resize:vertical}',
			'.iui-select:focus,.iui-input:focus,.iui-area:focus{border-color:var(--iui-focus-c);outline:none;box-shadow:0 0 0 3px var(--iui-accent-weak)}',
			/* select: our own chevron, so the control does not change shape per platform */
			'.iui-select{appearance:none;-webkit-appearance:none;padding-right:28px;line-height:normal;cursor:pointer}',
			'.iui-select-wrap{position:relative;display:block;width:100%}',
			'.iui-select-wrap::after{content:"";position:absolute;right:11px;top:50%;width:6px;height:6px;margin-top:-4px;' +
			'border-right:1.5px solid var(--iui-fg3);border-bottom:1.5px solid var(--iui-fg3);transform:rotate(45deg);pointer-events:none}',
			'.iui-select:disabled,.iui-input:disabled,.iui-area:disabled,.iui-range:disabled{opacity:.55;cursor:not-allowed}',
			'.iui-input[type=number]{appearance:textfield;-moz-appearance:textfield}',
			'.iui-input[type=number]::-webkit-outer-spin-button,.iui-input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}',
			/* one keyboard ring for every control */
			'.iui-btn:focus-visible,.iui-card:focus-visible,.iui-tab:focus-visible,.iui-tree-toggle:focus-visible,.iui-copy:focus-visible,.iui-reload:focus-visible,.iui-check input:focus-visible{' +
			'outline:var(--iui-focus-w) solid var(--iui-focus-c);outline-offset:1px}',
			'.iui-card:disabled{opacity:.6;cursor:default}',
			'.iui-card:disabled:hover{background:var(--iui-surface)}',
			'.iui-input::placeholder,.iui-area::placeholder{color:var(--iui-dim)}',
			'.iui-field{display:flex;flex-direction:column;gap:5px}',
			'.iui-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
			'.iui-inline{display:flex;gap:6px;align-items:stretch}',
			'.iui-inline .iui-input{flex:1 1 auto;min-width:0}',
			'.iui-form{display:flex;flex-direction:column;gap:9px}',
			'.iui-value{font-variant-numeric:tabular-nums;font-weight:600}',
			'.iui-unit{font-size:11px;font-weight:400;color:var(--iui-fg3)}',
			'.iui-range{width:100%;accent-color:var(--iui-accent)}',
			'.iui-check{display:flex;align-items:flex-start;gap:8px;cursor:pointer}',
			'.iui-check input{flex:0 0 auto;width:16px;height:16px;margin:1px 0 0;accent-color:var(--iui-accent);cursor:inherit}',
			'.iui-pick{width:15px;height:15px;accent-color:var(--iui-accent);vertical-align:-2px}',
			/* option cards */
			/* even proportions: grid instead of flex so every card is the same width */
			'.iui-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:7px}',
			'.iui-card{position:relative;min-width:0;min-height:38px;display:flex;flex-direction:column;justify-content:center;gap:3px;padding:10px 12px;',
			'color:var(--iui-fg);background:var(--iui-surface);border:.5px solid var(--iui-line2);border-radius:var(--iui-r-md);',
			'corner-shape:var(--iui-corner);box-shadow:var(--iui-shadow);font:inherit;text-align:left;cursor:pointer}',
			'.iui-card:hover:not(:disabled){background:var(--iui-fill);border-color:var(--iui-line)}',
			'.iui-card.is-on{border-color:var(--iui-accent);background:var(--iui-accent-weak);box-shadow:inset 0 0 0 .5px var(--iui-accent)}',
			'.iui-card.is-on::after{content:"\\2713";position:absolute;top:7px;right:8px;display:flex;align-items:center;justify-content:center;' +
			'width:15px;height:15px;border-radius:50%;background:var(--iui-accent);color:var(--iui-on-accent);font-size:10px;font-weight:700;line-height:1}',
			'.iui-card-title{font-size:12.5px;font-weight:600;line-height:1.35}',
			'.iui-card-desc{font-size:11.5px;line-height:1.45;color:var(--iui-fg3)}',
			/* buttons */
			'.iui-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
			'.iui-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:32px;padding:0 13px;',
			'font-family:inherit;font-size:13px;font-weight:500;color:var(--iui-fg);background:var(--iui-fill2);',
			'border:.5px solid transparent;border-radius:var(--iui-r-sm);corner-shape:var(--iui-corner);cursor:pointer}',
			'.iui-btn:hover:not(:disabled){background:var(--iui-fill-a)}',
			'.iui-btn:active:not(:disabled){transform:scale(.985)}',
			'.iui-btn:disabled{opacity:.45;cursor:default}',
			'.iui-btn--primary{background:var(--dsw-alias-button-primary-fill,var(--iui-accent));color:var(--iui-on-accent)}',
			'.iui-btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--iui-accent));filter:brightness(1.06)}',
			'.iui-btn--ghost{background:transparent;border-color:var(--iui-line2)}',
			'.iui-btn--ghost:hover:not(:disabled){background:var(--iui-fill)}',
			'.iui-btn--danger{background:var(--iui-err-fill);color:var(--iui-on-accent)}',
			'.iui-btn--danger:hover:not(:disabled){filter:brightness(1.06)}',
			'.iui-btn:focus-visible,.iui-card:focus-visible,.iui-tab:focus-visible,.iui-select:focus-visible,.iui-input:focus-visible,',
			'.iui-area:focus-visible,.iui-tree-toggle:focus-visible,.iui-copy:focus-visible{outline:var(--iui-focus-w) solid var(--iui-focus-c);outline-offset:2px}',
			/* answered summary — the answer laid out the way the question was asked */
			'.iui-answered{display:flex;flex-direction:column;gap:9px;padding:10px 12px;background:var(--iui-fill2);border-radius:var(--iui-r-md)}',
			'.iui-ans-head{display:flex;align-items:center;gap:8px}',
			'.iui-ans-verdict{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;font-size:11.5px;font-weight:600;border-radius:999px}',
			'.iui-ans-verdict.is-ok{color:var(--iui-ok-text);background:var(--iui-ok-fill)}',
			'.iui-ans-verdict.is-act{color:var(--iui-accent);background:var(--iui-accent-weak)}',
			'.iui-ans-verdict.is-off{color:var(--iui-fg3);background:var(--iui-fill)}',
			'.iui-ans-copy{margin-left:auto;width:24px;min-width:24px;height:24px;padding:0;font-size:13px}',
			'.iui-ans-rows{display:flex;flex-direction:column;gap:7px}',
			'.iui-ans-details{display:flex;flex-direction:column;gap:9px}',
			'.iui-ans-more{display:flex;align-items:center;gap:5px;width:fit-content;font-size:11.5px;color:var(--iui-fg3);',
			'cursor:pointer;list-style:none;user-select:none;border-radius:var(--iui-r-sm)}',
			'.iui-ans-more::-webkit-details-marker{display:none}',
			'.iui-ans-more::marker{content:""}',
			'.iui-ans-more::before{content:"▸";font-size:9px;line-height:1;transition:transform var(--ds-transition-duration-fast,.1s) ease}',
			'.iui-ans-details[open]>.iui-ans-more::before{transform:rotate(90deg)}',
			'.iui-ans-more:hover{color:var(--iui-fg2)}',
			'.iui-ans-row{display:flex;gap:10px;align-items:flex-start;font-size:12.5px;line-height:1.5}',
			'.iui-ans-k{flex:0 0 96px;max-width:38%;color:var(--iui-fg3)}',
			'.iui-ans-v{flex:1 1 auto;min-width:0;display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
			'.iui-chip{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:1px 9px;font-size:12px;line-height:1.6;',
			'border-radius:999px;background:var(--iui-fill);border:.5px solid var(--iui-line);overflow-wrap:anywhere}',
			'.iui-chip.is-on{color:var(--iui-accent);background:var(--iui-accent-weak);border-color:transparent}',
			'.iui-chip.is-ok{color:var(--iui-ok-text);background:var(--iui-ok-fill);border-color:transparent}',
			'.iui-chip.is-off{color:var(--iui-fg3);background:transparent}',
			'.iui-chip--mono{font-family:var(--iui-mono);font-size:11.5px}',
			'.iui-ans-muted{color:var(--iui-fg3)}',
			'.iui-ans-num{display:inline-flex;align-items:center;gap:7px;font-variant-numeric:tabular-nums}',
			'.iui-ans-bar{width:72px;height:5px;border-radius:999px;background:var(--iui-fill);overflow:hidden}',
			'.iui-ans-bar i{display:block;height:100%;border-radius:999px;background:var(--iui-accent-fill)}',
			'.iui-ans-text{white-space:pre-wrap;overflow-wrap:anywhere}',
			'.iui-ans-block{flex:1 1 100%;max-height:150px;overflow:auto;padding:7px 9px;font-family:var(--iui-mono);font-size:11.5px;',
			'line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--iui-code-bg);border-radius:var(--iui-r-sm)}',
			'.iui-ans-group{display:flex;flex-direction:column;gap:6px;width:100%;padding:8px 10px;border:.5px solid var(--iui-line);',
			'border-radius:var(--iui-r-sm)}',
			'.iui-ans-group .iui-ans-gtitle{font-size:11px;letter-spacing:.02em;color:var(--iui-fg3)}',
			'.iui-kv{display:flex;gap:8px;align-items:baseline;font-size:12.5px}',
			'.iui-kv b{min-width:88px;font-weight:600;color:var(--iui-fg3)}',
			'.iui-pre{margin:0;padding:9px 11px;max-height:220px;overflow:auto;font-family:var(--iui-mono);font-size:11.5px;line-height:1.5;',
			'white-space:pre-wrap;word-break:break-word;background:var(--iui-code-bg);border-radius:var(--iui-r-sm)}',
			/* table */
			'.iui-table-wrap{max-width:100%;overflow:auto;background:var(--iui-surface);border:.5px solid var(--iui-line);border-radius:var(--iui-r-md)}',
			'.iui-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px}',
			'.iui-table th,.iui-table td{padding:7px 10px;text-align:left;white-space:nowrap}',
			'.iui-table thead th{position:sticky;top:0;z-index:1;background:var(--iui-fill2);color:var(--iui-fg3);font-size:11px;font-weight:500;',
			'letter-spacing:.02em;text-transform:uppercase;border-bottom:.5px solid var(--iui-line);backdrop-filter:blur(6px)}',
			'.iui-table tbody td{border-bottom:.5px solid var(--iui-line)}',
			'.iui-table tbody tr:last-child td{border-bottom:0}',
			'.iui-table tbody tr.iui-tr--pick{cursor:pointer}',
			'.iui-table tbody tr.iui-tr--pick:hover td{background:var(--iui-fill)}',
			'.iui-table tbody tr.is-on td{background:var(--iui-fill2)}',
			'.iui-table tbody tr.is-on td:first-child{box-shadow:inset 2px 0 0 var(--iui-accent-edge)}',
			'.iui-td--num{text-align:right;font-variant-numeric:tabular-nums}',
			'.iui-td--mid{text-align:center}',
			/* wizard */
			'.iui-wizard{display:flex;flex-direction:column;gap:10px;padding:11px 12px;background:var(--iui-fill2);border-radius:var(--iui-r-md)}',
			'.iui-steps{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
			'.iui-step{display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--iui-fg3)}',
			'.iui-step.is-on{color:var(--iui-fg);font-weight:600}',
			'.iui-step.is-done{color:var(--iui-fg2)}',
			'.iui-step-no{display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;border-radius:50%;corner-shape:round;',
			'border:.5px solid var(--iui-line2);font-size:10px;font-variant-numeric:tabular-nums}',
			'.iui-step.is-on .iui-step-no{background:var(--iui-accent);border-color:var(--iui-accent-edge);color:var(--iui-on-accent)}',
			'.iui-step.is-done .iui-step-no{background:var(--iui-surface);border-color:var(--iui-line)}',
			'.iui-step-title{font-size:12.5px;font-weight:600}',
			'.iui-step-body{display:flex;flex-direction:column;gap:11px}',
			'.iui-nav{display:flex;align-items:center;gap:7px}',
			/* chart */
			'.iui-chart{display:block;width:100%;height:auto;overflow:visible}',
			'.iui-chart text{font-size:9.5px;fill:currentColor;opacity:.72}',
			'.iui-legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11.5px}',
			'.iui-legend-item{display:flex;align-items:center;gap:5px}',
			'.iui-swatch{flex:0 0 auto;width:9px;height:9px;border-radius:2px}',
			'.iui-legend b{font-weight:600;font-variant-numeric:tabular-nums}',
			/* multiselect */
			'.iui-grid{display:grid;gap:6px 12px}',
			'.iui-scroll{max-height:180px;overflow:auto}',
			/* markdown */
			'.iui-md{font-size:13px;line-height:1.62}',
			'.iui-md>:first-child{margin-top:0}',
			'.iui-md>:last-child{margin-bottom:0}',
			'.iui-md p{margin:0 0 8px}',
			'.iui-md h1,.iui-md h2,.iui-md h3,.iui-md h4{margin:13px 0 6px;font-weight:600;line-height:1.35}',
			'.iui-md h1{font-size:16px}.iui-md h2{font-size:14.5px}.iui-md h3{font-size:13.5px}.iui-md h4{font-size:13px}',
			'.iui-md ul,.iui-md ol{margin:0 0 8px;padding-left:20px}',
			'.iui-md li{margin:3px 0}',
			'.iui-md blockquote{margin:0 0 8px;padding:2px 0 2px 11px;border-left:2px solid var(--iui-line2);color:var(--iui-fg3)}',
			'.iui-md code{font-family:var(--iui-mono);font-size:11.5px;background:var(--iui-code-inline);border-radius:var(--iui-r-xs);padding:1px 4px}',
			'.iui-md a{color:var(--iui-link);text-decoration:none}',
			'.iui-md a:hover{text-decoration:underline;text-underline-offset:2px}',
			'.iui-md hr{border:0;border-top:.5px solid var(--iui-line);margin:11px 0}',
			'.iui-md table{border-collapse:collapse;margin:0 0 8px;font-size:12px}',
			'.iui-md th,.iui-md td{border:.5px solid var(--iui-line);padding:4px 8px;text-align:left}',
			'.iui-md th{background:var(--iui-fill2);font-weight:600}',
			/* code block */
			'.iui-code{margin:0 0 8px}',
			'.iui-code-head{display:flex;align-items:center;gap:8px;padding:4px 5px 4px 10px;font-size:10.5px;color:var(--iui-fg3);',
			'background:var(--iui-code-banner);border:.5px solid var(--iui-line);border-bottom:0;',
			'border-radius:var(--iui-r-sm) var(--iui-r-sm) 0 0}',
			'.iui-code-lang{flex:1 1 auto;text-transform:lowercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.iui-code pre{margin:0;padding:10px 11px;overflow:auto;max-height:340px;font-family:var(--iui-mono);font-size:11.5px;line-height:1.55;',
			'background:var(--iui-code-bg);border:.5px solid var(--iui-line);border-radius:0 0 var(--iui-r-sm) var(--iui-r-sm)}',
			'.iui-copy{flex:0 0 auto;height:20px;padding:0 7px;font-family:inherit;font-size:10.5px;color:var(--iui-fg2);background:transparent;',
			'border:.5px solid var(--iui-line);border-radius:var(--iui-r-xs);cursor:pointer;opacity:.8;transition:opacity var(--iui-t-fast)}',
			'.iui-copy:hover{opacity:1;background:var(--iui-fill)}',
			/* upload */
			'.iui-drop{display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer;background:var(--iui-surface);',
			'border:1px dashed var(--iui-line2);border-radius:var(--iui-r-md)}',
			'.iui-drop:hover{border-color:var(--iui-accent-edge);background:var(--iui-fill)}',
			'.iui-drop-hint{flex:1 1 auto;font-size:12px;color:var(--iui-fg3)}',
			'.iui-files{display:flex;flex-direction:column;gap:4px;margin-top:6px}',
			'.iui-file{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px}',
			'.iui-file b{font-weight:600;word-break:break-all}',
			'.iui-file-size{color:var(--iui-fg3);font-variant-numeric:tabular-nums}',
			'.iui-file .iui-btn{height:20px;padding:0 7px;font-size:10.5px}',
			/* diff */
			'.iui-diff{margin:0 0 8px;overflow:hidden;border:.5px solid var(--iui-line);border-radius:var(--iui-r-md)}',
			'.iui-diff-head{display:flex;align-items:center;gap:8px;padding:5px 10px;font-size:11px;color:var(--iui-fg3);',
			'background:var(--iui-code-banner);border-bottom:.5px solid var(--iui-line)}',
			'.iui-diff-name{font-family:var(--iui-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.iui-diff-stat{margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums}',
			'.iui-diff-stat .is-add{color:var(--iui-ok-text)}.iui-diff-stat .is-del{color:var(--iui-err-text)}',
			'.iui-diff-body{margin:0;max-height:360px;overflow:auto;font-family:var(--iui-mono);font-size:11.5px;line-height:1.55}',
			'.iui-dl{display:flex;white-space:pre}',
			'.iui-dl-n{flex:0 0 auto;min-width:32px;padding:0 6px;text-align:right;color:var(--iui-dim);user-select:none;font-variant-numeric:tabular-nums}',
			'.iui-dl-s{flex:0 0 auto;width:14px;text-align:center;color:var(--iui-fg3)}',
			'.iui-dl-t{flex:1 1 auto;padding-right:8px;overflow-wrap:anywhere}',
			'.iui-dl.is-add{background:var(--iui-add-fill)}',
			'.iui-dl.is-del{background:var(--iui-del-fill)}',
			'.iui-dl.is-skip{font-style:italic;opacity:.5}',
			/* timeline */
			'.iui-tl{margin:0 0 8px;padding-left:3px}',
			'.iui-tl-item{position:relative;padding:0 0 11px 18px;border-left:1px solid var(--iui-line)}',
			'.iui-tl-item:last-child{padding-bottom:0;border-left-color:transparent}',
			'.iui-tl-dot{position:absolute;left:-4.5px;top:5px;width:8px;height:8px;border-radius:50%;corner-shape:round;background:var(--iui-accent)}',
			'.iui-tl-item.is-ok .iui-tl-dot{background:var(--iui-ok)}',
			'.iui-tl-item.is-warn .iui-tl-dot{background:var(--iui-warn)}',
			'.iui-tl-item.is-error .iui-tl-dot{background:var(--iui-err)}',
			'.iui-tl-at{font-size:10.5px;color:var(--iui-fg3);font-variant-numeric:tabular-nums}',
			'.iui-tl-title{font-size:12.5px;font-weight:600}',
			'.iui-tl-text{font-size:12px;color:var(--iui-fg2);white-space:pre-wrap}',
			/* tree */
			'.iui-tree{margin:0 0 8px;font-size:12.5px}',
			'.iui-tree ul.iui-tree-list{margin:0;padding:0 0 0 16px;list-style:none;border-left:1px solid var(--iui-line)}',
			'.iui-tree > ul.iui-tree-list{border-left:0;padding-left:0}',
			'.iui-tree-row{display:flex;align-items:center;gap:6px;padding:2px 6px;border-radius:var(--iui-r-xs)}',
			'.iui-tree-row:hover{background:var(--iui-fill)}',
			'.iui-tree-row.is-on{background:var(--iui-fill2)}',
			'.iui-tree-check{flex:0 0 auto;width:15px;height:15px;margin:0;accent-color:var(--iui-accent)}',
			'.iui-tree-toggle{flex:0 0 auto;width:14px;padding:0;border:0;background:none;color:var(--iui-fg3);font-size:9px;line-height:1;cursor:pointer}',
			'.iui-tree-toggle:hover{color:var(--iui-fg)}',
			'.iui-tree-toggle.is-leaf{visibility:hidden}',
			/* progress */
			'.iui-prog{margin:0 0 8px;display:flex;flex-direction:column;gap:8px}',
			'.iui-prog-row{font-size:12px}',
			'.iui-prog-head{display:flex;justify-content:space-between;gap:8px;margin-bottom:3px}',
			'.iui-prog-val{color:var(--iui-fg3);font-variant-numeric:tabular-nums;white-space:nowrap}',
			'.iui-prog-bar{height:6px;border-radius:3px;background:var(--iui-fill2);overflow:hidden}',
			'.iui-prog-fill{height:100%;border-radius:3px;background:var(--iui-accent-fill);animation:iui-fade .25s var(--iui-ease)}',
			'.iui-prog-fill.is-ok{background:var(--iui-ok-fill)}',
			'.iui-prog-fill.is-warn{background:var(--iui-warn-fill)}',
			'.iui-prog-fill.is-error{background:var(--iui-err-fill)}',
			/* tabs */
			'.iui-tabs{margin:0 0 8px}',
			'.iui-tabbar{display:flex;gap:2px;flex-wrap:wrap;margin-bottom:9px;border-bottom:.5px solid var(--iui-line)}',
			'.iui-tab{padding:5px 10px;border:0;border-bottom:1.5px solid transparent;margin-bottom:-.5px;background:none;color:var(--iui-fg3);',
			'font-family:inherit;font-size:12.5px;cursor:pointer;border-radius:var(--iui-r-xs) var(--iui-r-xs) 0 0}',
			'.iui-tab:hover{color:var(--iui-fg);background:var(--iui-fill)}',
			'.iui-tab.is-on{color:var(--iui-fg);font-weight:600;border-bottom-color:var(--iui-accent)}',
			'.iui-tab-body{display:flex;flex-direction:column;gap:11px}',
			/* scrollbars */
			'.iui-scroll::-webkit-scrollbar,.iui-table-wrap::-webkit-scrollbar,.iui-pre::-webkit-scrollbar,',
			'.iui-diff-body::-webkit-scrollbar,.iui-code pre::-webkit-scrollbar{width:9px;height:9px}',
			'.iui-scroll::-webkit-scrollbar-thumb,.iui-table-wrap::-webkit-scrollbar-thumb,.iui-pre::-webkit-scrollbar-thumb,',
			'.iui-diff-body::-webkit-scrollbar-thumb,.iui-code pre::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(128,128,128,.32));border-radius:5px}',
			'.iui-scroll::-webkit-scrollbar-thumb:hover,.iui-table-wrap::-webkit-scrollbar-thumb:hover,.iui-pre::-webkit-scrollbar-thumb:hover,',
			'.iui-diff-body::-webkit-scrollbar-thumb:hover,.iui-code pre::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2,rgba(128,128,128,.5))}',
			/* motion — short, subtle, and off for prefers-reduced-motion */
			'@keyframes iui-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
			'@keyframes iui-fade{from{opacity:0}to{opacity:1}}',
			'@keyframes iui-pop{from{transform:scale(.97)}to{transform:scale(1)}}',
			'.iui-answered{animation:iui-fade var(--iui-t) var(--iui-ease)}',
			'.iui-step-body,.iui-tab-body{animation:iui-in .16s var(--iui-ease)}',
			'.iui-card,.iui-btn,.iui-tr--pick,.iui-tab,.iui-tree-row{transition:background var(--iui-t-fast) var(--iui-ease),',
			'border-color var(--iui-t-fast) var(--iui-ease),color var(--iui-t-fast) var(--iui-ease),transform 90ms var(--iui-ease)}',
			'.iui-card.is-on{animation:iui-pop .13s var(--iui-ease)}',
			/* narrow hosts: one column, tighter chrome, tappable footer */
			'@media (max-width:560px){',
			'.iui-panel{padding:10px 11px 11px;gap:9px;border-radius:var(--iui-r-md)}',
			'.iui-body{gap:9px}',
			'.iui-cards{grid-template-columns:1fr}',
			'.iui-grid{grid-template-columns:1fr !important}',
			'.iui-grid.iui-scroll{max-height:220px !important}',
			'.iui-title{font-size:14px}',
			'.iui-foot{gap:6px}',
			'.iui-foot .iui-btn{flex:1 1 auto;justify-content:center}',
			'.iui-table{font-size:12px}',
			'.iui-tab{padding:5px 8px}',
			'.iui-wizard .iui-nav .iui-btn{flex:1 1 auto;justify-content:center}',
			'}',
			'@media (prefers-reduced-motion:reduce){.iui-panel,.iui-answered,.iui-step-body,.iui-tab-body,.iui-card.is-on,.iui-prog-fill{animation:none}',
			'.iui-card,.iui-btn,.iui-tr--pick,.iui-tab,.iui-tree-row{transition:none}.iui-btn:active:not(:disabled){transform:none}}',
			/* the reload affordance — in the panel footer and next to the composer */
			'.iui-btn--icon{padding:0;min-width:30px;font-size:14px;line-height:1}',
			'.iui-reload{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;',
			'font:inherit;font-size:15px;line-height:1;color:var(--iui-dim);background:transparent;border:1px solid transparent;',
			'border-radius:var(--iui-r-sm);cursor:pointer;transition:background var(--iui-t-fast) var(--iui-ease),color var(--iui-t-fast) var(--iui-ease)}',
			'.iui-reload:hover{color:var(--iui-fg);background:var(--iui-fill)}',
			'.iui-reload:active{background:var(--iui-fill-a)}',
		].join('');

		function ensureStyles() {
			if (typeof document === 'undefined' || document === null) return;
			if (document.getElementById(STYLE_ID) !== null) return;
			var style = document.createElement('style');
			style.id = STYLE_ID;
			style.textContent = CSS;
			(document.head !== null && document.head !== undefined ? document.head : document.body).appendChild(style);
		}

		/* ------------------------------------------------------------ *
		 * host bridge
		 * ------------------------------------------------------------ */

		function fetchPanel(callId) {
			return fetch(ROUTE + '/panel?callId=' + encodeURIComponent(callId), {
				headers: { accept: 'application/json' },
				cache: 'no-store',
			}).then(function (response) {
				if (!response.ok) throw new Error('panel request failed: HTTP ' + response.status);
				return response.json();
			});
		}

		function submitPanel(callId, action, values, button) {
			return fetch(ROUTE + '/submit', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ callId: callId, action: action, values: values, button: button || '' }),
			}).then(function (response) {
				return response.json().then(function (body) {
					if (!response.ok) throw new Error(body && body.error ? body.error : 'submit failed: HTTP ' + response.status);
					return body;
				});
			});
		}

		/* ------------------------------------------------------------ *
		 * generic helpers
		 * ------------------------------------------------------------ */

		function isPlainObject(value) {
			return value !== null && typeof value === 'object' && Array.isArray(value) === false;
		}

		function optionValue(option) {
			if (isPlainObject(option)) return option.value === undefined ? option.label : option.value;
			return option;
		}

		function optionLabel(option) {
			if (isPlainObject(option)) return option.label === undefined ? String(option.value) : String(option.label);
			return String(option);
		}

		function shallowCopy(source) {
			var copy = {};
			if (isPlainObject(source)) for (var key in source) if (Object.prototype.hasOwnProperty.call(source, key)) copy[key] = source[key];
			return copy;
		}

		/** Immutably write `next` at a nested path, cloning every level. */
		function withPath(root, path, next) {
			if (path.length === 0) return next;
			var head = path[0];
			var copy = shallowCopy(root);
			copy[head] = withPath(isPlainObject(copy[head]) ? copy[head] : {}, path.slice(1), next);
			return copy;
		}

		/** Read the value stored at a nested path. */
		function atPath(root, path) {
			var node = root;
			for (var index = 0; index < path.length; index++) {
				if (!isPlainObject(node)) return undefined;
				node = node[path[index]];
			}
			return node;
		}

		/** Drop client-only keys before the answer leaves the browser. */
		function publicValues(values) {
			var out = {};
			for (var key in values) {
				if (Object.prototype.hasOwnProperty.call(values, key) === false) continue;
				if (key.indexOf(PRIVATE) === 0) continue;
				out[key] = values[key];
			}
			return out;
		}

		function formDefaults(element) {
			var fields = Array.isArray(element.fields) ? element.fields : [];
			var seed = {};
			for (var index = 0; index < fields.length; index++) {
				var field = fields[index];
				if (!isPlainObject(field)) continue;
				var fieldId = typeof field.id === 'string' && field.id.length > 0 ? field.id : 'field_' + index;
				seed[fieldId] = field.default === undefined ? '' : field.default;
			}
			return seed;
		}

		function defaultFor(element) {
			switch (element.kind) {
				case 'checkbox': case 'switch':
					/* With options it is a checkbox GROUP (an array answer); without options it
					* is the single boolean toggle. */
					if (Array.isArray(element.options) && element.options.length > 0) {
						return Array.isArray(element.default) ? element.default.slice() : [];
					}
					return element.default === true;
				case 'multiselect': return Array.isArray(element.default) ? element.default.slice() : [];
				case 'upload': return Array.isArray(element.default) ? element.default.slice() : [];
				case 'slider': return typeof element.default === 'number' ? element.default : Number(element.min || 0);
				case 'table': return element.select === 'multi' ? (Array.isArray(element.default) ? element.default.slice() : []) : (element.default === undefined ? null : element.default);
				case 'date': case 'time': case 'input': return element.default === undefined ? '' : element.default;
				case 'number': return typeof element.default === 'number' ? element.default : '';
				case 'textarea': case 'path': return element.default === undefined ? '' : element.default;
				case 'tree': return Array.isArray(element.default) ? element.default.slice() : treeCheckedIds(Array.isArray(element.nodes) ? element.nodes : [], []);
				case 'form': return formDefaults(element);
				default: return element.default;
			}
		}

		function seedsValue(element) {
			if (typeof element.id !== 'string' || element.id.length === 0) return false;
			if (element.kind === 'text' || element.kind === 'link' || element.kind === 'button' || element.kind === 'chart') return false;
			if (element.kind === 'markdown' || element.kind === 'diff' || element.kind === 'timeline' || element.kind === 'progress' || element.kind === 'tabs') return false;
			if (element.kind === 'table' && element.select !== 'single' && element.select !== 'multi') return false;
			return true;
		}

		function seedValues(values, elements, base, depth) {
			if (!Array.isArray(elements) || depth > 3) return values;
			for (var index = 0; index < elements.length; index++) {
				var element = elements[index];
				if (!isPlainObject(element) || typeof element.kind !== 'string') continue;
				if (typeof element.id !== 'string' || element.id.length === 0) continue;
				if (element.kind === 'wizard') {
					var steps = Array.isArray(element.steps) ? element.steps : [];
					values = withPath(values, ['__step', element.id], 0);
					for (var stepIndex = 0; stepIndex < steps.length; stepIndex++) {
						var step = steps[stepIndex];
						if (!isPlainObject(step)) continue;
						var stepId = typeof step.id === 'string' && step.id.length > 0 ? step.id : 'step_' + stepIndex;
						values = seedValues(values, step.elements, base.concat([element.id, stepId]), depth + 1);
					}
					continue;
				}
				if (element.kind === 'tabs') {
					values = withPath(values, ['__tab', element.id], 0);
					var tabs = Array.isArray(element.tabs) ? element.tabs : [];
					for (var tabIndex = 0; tabIndex < tabs.length; tabIndex++) {
						var tab = tabs[tabIndex];
						if (!isPlainObject(tab)) continue;
						values = seedValues(values, tab.elements, base, depth + 1);
					}
					continue;
				}
				if (seedsValue(element) === false) continue;
				var preset = defaultFor(element);
				if (preset === undefined) continue;
				values = withPath(values, base.concat([element.id]), preset);
			}
			return values;
		}

		function initialValues(spec) {
			var elements = isPlainObject(spec) && Array.isArray(spec.elements) ? spec.elements : [];
			return seedValues({}, elements, [], 0);
		}

		/* -------------------------------------------------------------- *
		 * drafts — a half-filled panel is real user work
		 *
		 * Values used to live only in React state, so switching pages (or the
		 * shell's own reload) threw them away. Now every edit is mirrored into
		 * localStorage, one entry per callId, and the poll restores it before
		 * the first render. The entry is dropped as soon as the panel is
		 * answered, so nothing lingers after the answer is in.
		 * -------------------------------------------------------------- */

		var DRAFT_PREFIX = 'dsh-intelligent-ui:draft:';
		var DRAFT_INDEX = DRAFT_PREFIX + 'index';
		/** How many callIds keep a draft; the oldest is evicted past this. */
		var DRAFT_MAX = 12;
		/** Skip absurd payloads (a giant table selection) rather than fight the quota. */
		var DRAFT_MAX_CHARS = 12000;
		/** Stale drafts are noise — a panel nobody answered in a week is gone. */
		var DRAFT_TTL = 7 * 24 * 60 * 60 * 1000;

		/** localStorage throws when disabled (private mode, file://, quota). */
		function draftStore() {
			try {
				var store = globalThis.localStorage;
				if (store === undefined || store === null) return null;
				if (typeof store.getItem !== 'function' || typeof store.setItem !== 'function') return null;
				return store;
			} catch (error) {
				return null;
			}
		}

		/** `__missing` is a redraw hint, not an answer — never persist it. */
		function stripMissing(values) {
			if (isPlainObject(values) === false) return {};
			var copy = shallowCopy(values);
			delete copy.__missing;
			return copy;
		}

		function readDraftIndex(store) {
			try {
				var listed = JSON.parse(store.getItem(DRAFT_INDEX) || '[]');
				if (Array.isArray(listed) === false) return [];
				return listed.filter(function (id) { return typeof id === 'string' && id.length > 0; });
			} catch (error) {
				return [];
			}
		}

		function writeDraftIndex(store, listed) {
			try { store.setItem(DRAFT_INDEX, JSON.stringify(listed)); } catch (error) { /* quota */ }
		}

		/** Move `callId` to the young end of the index, evicting the oldest.
		 * A keystroke usually leaves the order unchanged — skip the write then,
		 * so an ordinary panel costs one storage op per edit, not three. */
		function touchDraftIndex(store, callId) {
			var listed = readDraftIndex(store);
			if (listed[listed.length - 1] === callId) return;
			listed = listed.filter(function (id) { return id !== callId; });
			listed.push(callId);
			while (listed.length > DRAFT_MAX) {
				var stale = listed.shift();
				try { store.removeItem(DRAFT_PREFIX + stale); } catch (error) { /* ignore */ }
			}
			writeDraftIndex(store, listed);
		}

		function readDraft(callId) {
			var store = draftStore();
			if (store === null || typeof callId !== 'string' || callId.length === 0) return null;
			try {
				var raw = JSON.parse(store.getItem(DRAFT_PREFIX + callId) || 'null');
				if (isPlainObject(raw) === false || isPlainObject(raw.values) === false) return null;
				if (typeof raw.at === 'number' && Date.now() - raw.at > DRAFT_TTL) {
					store.removeItem(DRAFT_PREFIX + callId);
					return null;
				}
				return stripMissing(raw.values);
			} catch (error) {
				return null;
			}
		}

		function writeDraft(callId, values) {
			var store = draftStore();
			if (store === null || typeof callId !== 'string' || callId.length === 0) return;
			var kept = stripMissing(values);
			if (Object.keys(kept).length === 0) {
				clearDraft(callId);
				return;
			}
			var payload = JSON.stringify({ at: Date.now(), values: kept });
			if (payload.length > DRAFT_MAX_CHARS) return;
			try {
				store.setItem(DRAFT_PREFIX + callId, payload);
				touchDraftIndex(store, callId);
			} catch (error) { /* quota or private mode: the panel still works */ }
		}

		function clearDraft(callId) {
			var store = draftStore();
			if (store === null || typeof callId !== 'string' || callId.length === 0) return;
			try { store.removeItem(DRAFT_PREFIX + callId); } catch (error) { /* ignore */ }
			writeDraftIndex(store, readDraftIndex(store).filter(function (id) { return id !== callId; }));
		}

		/** Deep-merge a stored draft over the seeded defaults. Depth-capped so a
		 * corrupt entry cannot recurse forever; scalars win, objects merge. */
		function mergeValues(base, saved, depth) {
			if (isPlainObject(base) === false || isPlainObject(saved) === false || depth > 4) return base;
			var out = shallowCopy(base);
			for (var key in saved) {
				if (Object.prototype.hasOwnProperty.call(saved, key) === false) continue;
				var next = saved[key];
				out[key] = isPlainObject(out[key]) === true && isPlainObject(next) === true
					? mergeValues(out[key], next, depth + 1)
					: next;
			}
			return out;
		}

		/** What the panel should open with: defaults first, then any draft. */
		function seedWithDraft(spec, callId) {
			var seeded = initialValues(spec);
			var draft = readDraft(callId);
			return draft === null ? seeded : mergeValues(seeded, draft, 0);
		}

		function summarize(values) {
			var text = JSON.stringify(values);
			if (typeof text !== 'string') return '';
			return text.length > 4000 ? text.slice(0, 4000) + '…' : text;
		}

		function cellText(cell) {
			if (cell === null || cell === undefined || cell === '') return '—';
			if (cell === true) return '✓';
			if (cell === false) return '✗';
			if (isPlainObject(cell)) return cell.text === undefined ? JSON.stringify(cell) : String(cell.text);
			return String(cell);
		}

		/* ------------------------------------------------------------ *
		 * answer summary
		 *
		 * Once the answer is in, the panel shows what was answered rather
		 * than a JSON blob: one labelled row per answered element, a choice
		 * rendered as its own label, a switch as a state chip, a slider as a
		 * level bar, files as file chips. The raw JSON stays one click away
		 * instead of being the whole display.
		 * ------------------------------------------------------------ */

		var VERDICTS = {
			submit: { glyph: '✓', text: '已提交', className: 'is-ok' },
			button: { glyph: '⚡', text: '按了按钮', className: 'is-act' },
			cancel: { glyph: '⊘', text: '已取消', className: 'is-off' },
			cancelled: { glyph: '⊘', text: '会话中断', className: 'is-off' },
			display: { glyph: '👁', text: '只读展示', className: 'is-off' },
		};

		function hasKey(object, key) {
			return isPlainObject(object) && Object.prototype.hasOwnProperty.call(object, key);
		}

		function labelOf(element, fallback) {
			if (isPlainObject(element) && typeof element.label === 'string' && element.label.length > 0) return element.label;
			return fallback;
		}

		function elementOptions(element) {
			if (!isPlainObject(element) || Array.isArray(element.options) === false) return [];
			return element.options.map(function (option) {
				return { value: optionValue(option), label: optionLabel(option) };
			});
		}

		/** Flatten `tree` nodes into { id, label } pairs. */
		function treeNodeList(nodes, out) {
			var list = Array.isArray(nodes) ? nodes : [];
			for (var index = 0; index < list.length; index++) {
				var node = list[index];
				if (!isPlainObject(node)) continue;
				var id = node.id === undefined ? node.value : node.id;
				if (id !== undefined) out.push({ id: String(id), label: node.label === undefined ? String(id) : String(node.label) });
				treeNodeList(node.children, out);
			}
			return out;
		}

		/** The display label behind a stored answer (choice option, table row, tree node). */
		function lookupLabel(element, value) {
			if (!isPlainObject(element)) return null;
			var wanted = String(value);
			var options = elementOptions(element);
			var index;
			for (index = 0; index < options.length; index++) {
				if (String(options[index].value) === wanted) return options[index].label;
			}
			if (Array.isArray(element.rows)) {
				var rowKey = typeof element.row_key === 'string' && element.row_key.length > 0 ? element.row_key : 'key';
				for (index = 0; index < element.rows.length; index++) {
					var row = element.rows[index];
					if (!isPlainObject(row)) continue;
					var key = row[rowKey] === undefined ? String(index) : String(row[rowKey]);
					if (key !== wanted) continue;
					var columns = Array.isArray(element.columns) ? element.columns : [];
					if (columns.length > 0 && isPlainObject(columns[0]) && columns[0].key !== undefined) return cellText(row[columns[0].key]);
					return key;
				}
			}
			var nodes = treeNodeList(element.nodes, []);
			for (index = 0; index < nodes.length; index++) {
				if (nodes[index].id === wanted) return nodes[index].label;
			}
			return null;
		}

		function chip(text, className, title) {
			var props = { className: 'iui-chip' + (className === undefined ? '' : ' ' + className) };
			if (typeof title === 'string' && title.length > 0) props.title = title;
			return h('span', props, text);
		}

		function muted(text) {
			return h('span', { className: 'iui-ans-muted' }, text);
		}

		function textValue(value) {
			if (typeof value === 'string') return value;
			if (value === undefined || value === null) return '';
			if (isPlainObject(value) || Array.isArray(value)) return summarize(value);
			return String(value);
		}

		function isOn(value) {
			return value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
		}

		/** One answered value → the nodes that render it. */
		function valueNodes(element, value) {
			var kind = isPlainObject(element) && typeof element.kind === 'string' ? element.kind : '';
			var options = elementOptions(element);
			var index;

			if (kind === 'switch' || (kind === 'checkbox' && options.length === 0)) {
				var on = isOn(value);
				return [chip((on ? '✓ ' : '✗ ') + (on ? '开启' : '关闭'), on ? 'is-ok' : 'is-off')];
			}
			if (kind === 'radio' || kind === 'select') {
				if (value === undefined || value === null || value === '') return [muted('未选择')];
				var chosen = lookupLabel(element, value);
				return [chip(chosen === null ? textValue(value) : chosen, 'is-on')];
			}
			if (kind === 'checkbox' || kind === 'multiselect' || kind === 'tree' || kind === 'table') {
				var picked = Array.isArray(value) ? value : (value === undefined || value === null || value === '' ? [] : [value]);
				if (picked.length === 0) return [muted('未选择')];
				return picked.map(function (entry, position) {
					var label = lookupLabel(element, entry);
					return h('span', { className: 'iui-chip is-on', key: position }, label === null ? textValue(entry) : label);
				});
			}
			if (kind === 'slider' || kind === 'number') {
				if (value === undefined || value === null || value === '') return [muted('未填写')];
				var number = typeof value === 'number' ? value : Number(value);
				if (isFinite(number) === false) return [chip(textValue(value), 'is-on')];
				var min = typeof element.min === 'number' ? element.min : 0;
				var max = typeof element.max === 'number' ? element.max : (kind === 'slider' ? 100 : number);
				var unit = typeof element.unit === 'string' ? element.unit : '';
				var ratio = max > min ? (number - min) / (max - min) : 0;
				var percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
				return [h('span', { className: 'iui-ans-num' },
					kind === 'slider' ? h('span', { className: 'iui-ans-bar' }, h('i', { style: { width: percent + '%' } })) : null,
					h('b', null, String(number) + unit))];
			}
			if (kind === 'upload') {
				var files = Array.isArray(value) ? value : [];
				if (files.length === 0) return [muted('没有文件')];
				return files.map(function (file, position) {
					if (!isPlainObject(file)) return h('span', { className: 'iui-chip iui-chip--mono', key: position }, textValue(file));
					var name = typeof file.name === 'string' && file.name.length > 0 ? file.name : textValue(file.path);
					var size = typeof file.size === 'number' ? ' · ' + formatSize(file.size) : '';
					return h('span', { className: 'iui-chip iui-chip--mono', key: position, title: textValue(file.path) }, name + size);
				});
			}
			if (kind === 'textarea') {
				var body = textValue(value);
				if (body.length === 0) return [muted('空')];
				if (body.indexOf('\n') >= 0 || body.length > 60) return [h('div', { className: 'iui-ans-block' }, body)];
				return [h('span', { className: 'iui-ans-text' }, body)];
			}
			if (kind === 'path' || kind === 'date' || kind === 'time') {
				var literal = textValue(value);
				if (literal.length === 0) return [muted('未填写')];
				return [h('span', { className: 'iui-chip iui-chip--mono', title: literal }, literal)];
			}
			if (kind === 'form' || kind === 'wizard' || kind === 'tabs' || kind === 'button') return [muted('—')];
			var plain = textValue(value);
			if (plain.length === 0) return [muted('未填写')];
			return [h('span', { className: 'iui-ans-text' }, plain)];
		}

		/** A form/wizard field descriptor displayed like an element. */
		function fieldAsElement(field) {
			if (!isPlainObject(field)) return { kind: 'input' };
			var type = typeof field.type === 'string' && field.type.length > 0 ? field.type : 'text';
			var known = ['textarea', 'select', 'radio', 'multiselect', 'checkbox', 'switch', 'slider', 'number', 'date', 'time', 'path', 'upload', 'table'];
			return {
				kind: known.indexOf(type) >= 0 ? type : 'input',
				id: field.id,
				label: field.label,
				options: field.options,
				min: field.min,
				max: field.max,
				unit: field.unit,
				rows: field.rows,
				row_key: field.row_key,
				columns: field.columns,
				nodes: field.nodes,
			};
		}

		function fieldsToElements(fields) {
			var list = Array.isArray(fields) ? fields : [];
			return list.map(fieldAsElement);
		}

		function groupRow(label, children, key) {
			return h('div', { className: 'iui-ans-row', key: key },
				h('div', { className: 'iui-ans-k' }, label),
				h('div', { className: 'iui-ans-v' }, h('div', { className: 'iui-ans-group' }, children)));
		}

		function answerRows(elements, values, seen) {
			var rows = [];
			var list = Array.isArray(elements) ? elements : [];
			var store = isPlainObject(values) ? values : {};
			for (var index = 0; index < list.length; index++) {
				var element = list[index];
				if (!isPlainObject(element)) continue;
				var kind = typeof element.kind === 'string' ? element.kind : '';
				if (kind === 'markdown' || kind === 'text' || kind === 'link' || kind === 'diff' || kind === 'timeline' || kind === 'progress' || kind === 'chart') continue;
				if (kind === 'tabs') {
					/* Tab children answer into the panel-level keys, so they are read here. */
					var tabRows = answerRows(element.elements, store, seen);
					for (var tab = 0; tab < tabRows.length; tab++) rows.push(tabRows[tab]);
					continue;
				}
				var id = typeof element.id === 'string' && element.id.length > 0 ? element.id : '';
				if (kind === 'wizard') {
					/* A wizard writes its children under <wizardId>.<stepId>.<childId>,
					 * so the wizard id is a bucket rather than a value of its own. */
					if (hasKey(store, id) === false) continue;
					seen[id] = true;
					var stepRows = wizardRows(element, store[id]);
					if (stepRows.length === 0) continue;
					if (typeof element.label === 'string' && element.label.length > 0) {
						rows.push(groupRow(element.label, stepRows, id));
					} else {
						for (var step = 0; step < stepRows.length; step++) rows.push(stepRows[step]);
					}
					continue;
				}
				if (id.length === 0 || hasKey(store, id) === false) continue;
				seen[id] = true;
				if (kind === 'form') {
					var formRows = answerRows(fieldsToElements(element.fields), store[id], {});
					if (formRows.length > 0) rows.push(groupRow(labelOf(element, id), formRows, id));
					continue;
				}
				/* An empty note box is not an answer. Leave its row out entirely —
				 * "备注 · 空" is pure noise in the summary, and every panel now has a
				 * note box, so it would be noise in every single summary. Still mark
				 * it seen so leftoverRow() does not resurface it as "其他". */
				if (kind === 'textarea' && id === NOTE_ID && isBlank(store[id])) continue;
				rows.push(h('div', { className: 'iui-ans-row', key: id },
					h('div', { className: 'iui-ans-k' }, labelOf(element, id)),
					h('div', { className: 'iui-ans-v' }, valueNodes(element, store[id]))));
			}
			return rows;
		}

		function wizardRows(element, value) {
			var steps = Array.isArray(element.steps) ? element.steps : [];
			var answer = isPlainObject(value) ? value : {};
			var rows = [];
			for (var index = 0; index < steps.length; index++) {
				var step = steps[index];
				if (!isPlainObject(step)) continue;
				var stepId = typeof step.id === 'string' && step.id.length > 0 ? step.id : 'step_' + index;
				/* A wizard writes its children under <wizardId>.<stepId>.<childId>,
				 * so each step reads its own bucket; `fields` is the legacy alias. */
				var children = Array.isArray(step.elements) ? step.elements : fieldsToElements(step.fields);
				var body = answerRows(children, answer[stepId], {});
				if (body.length === 0) continue;
				/* Steps name themselves with `title`, not `label`. */
				var stepTitle = typeof step.title === 'string' && step.title.length > 0 ? step.title : labelOf(step, stepId);
				rows.push(h('div', { className: 'iui-ans-group', key: stepId },
					h('div', { className: 'iui-ans-gtitle' }, stepTitle),
					body));
			}
			return rows;
		}

		/** Answers the panel did not ask for (a stale or hand-made payload). */
		function leftoverRow(store, seen) {
			var parts = [];
			for (var key in store) {
				if (Object.prototype.hasOwnProperty.call(store, key) === false) continue;
				if (key.indexOf(PRIVATE) === 0 || seen[key] === true) continue;
				var text = summarize(store[key]);
				parts.push(key + ' = ' + (text.length > 72 ? text.slice(0, 72) + '…' : text));
			}
			if (parts.length === 0) return null;
			return h('div', { className: 'iui-ans-row' },
				h('div', { className: 'iui-ans-k' }, '其他'),
				h('div', { className: 'iui-ans-v' }, h('span', { className: 'iui-chip iui-chip--mono' }, parts.join(' · '))));
		}

		/** The raw payload stays reachable without being the display. */
		function copyAnswer(values) {
			return function (event) {
				if (event !== null && event !== undefined && typeof event.preventDefault === 'function') event.preventDefault();
				try {
					if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
						navigator.clipboard.writeText(JSON.stringify(values, null, 2));
					}
				} catch (error) {
					if (typeof console !== 'undefined') console.warn('[' + NS + '] copy failed', error);
				}
			};
		}

		/** Find an element (or wizard step) by id anywhere in the tree. */
		function findElement(elements, id) {
			var list = Array.isArray(elements) ? elements : [];
			for (var index = 0; index < list.length; index++) {
				var element = list[index];
				if (!isPlainObject(element)) continue;
				if (element.id === id) return element;
				var deeper = findElement(element.elements, id);
				if (deeper !== null) return deeper;
				var steps = Array.isArray(element.steps) ? element.steps : [];
				for (var step = 0; step < steps.length; step++) {
					if (isPlainObject(steps[step]) && steps[step].id === id) return steps[step];
				}
			}
			return null;
		}

		function answerSummary(spec, action, values, buttonId) {
			var store = isPlainObject(values) ? values : {};
			var elements = isPlainObject(spec) && Array.isArray(spec.elements) ? spec.elements : [];
			var verdict = VERDICTS[action] === undefined ? VERDICTS.submit : VERDICTS[action];
			var quiet = action === 'cancel' || action === 'cancelled';
			var seen = {};
			var rows = quiet ? [] : answerRows(elements, store, seen);
			if (quiet === false) {
				var extra = leftoverRow(store, seen);
				if (extra !== null) rows.push(extra);
			}
			/* Collapsed, the summary is the head row alone: verdict, the button that
			 * was pressed, and the copy affordance. The answer rows sit one click
			 * below — a wide panel used to leave a wall of text in the transcript. */
			var headRow = h('div', { className: 'iui-ans-head' },
				h('span', { className: 'iui-ans-verdict ' + verdict.className }, verdict.glyph + ' ' + verdict.text),
				action === 'button' && typeof buttonId === 'string' && buttonId.length > 0
					? chip('⚡ ' + labelOf(findElement(elements, buttonId), buttonId), 'is-on')
					: null,
				h('button', {
					type: 'button',
					className: 'iui-btn iui-btn--ghost iui-btn--icon iui-ans-copy',
					title: '复制答案 JSON',
					'aria-label': '复制答案 JSON',
					onClick: copyAnswer(store),
				}, '⧉'));
			if (rows.length === 0) return h('div', { className: 'iui-answered' }, headRow);
			return h('div', { className: 'iui-answered' },
				headRow,
				h('details', { className: 'iui-ans-details' },
					h('summary', { className: 'iui-ans-more' }, '查看答案 · ' + rows.length + ' 项'),
					h('div', { className: 'iui-ans-rows' }, rows)));
		}

		/* ------------------------------------------------------------ *
		 * optional host services
		 * ------------------------------------------------------------ */

		function canPickDirectory() {
			try {
				if (clientCtx === null || typeof clientCtx.get !== 'function') return false;
				var workspace = clientCtx.get('uiWorkspace');
				return workspace !== undefined && workspace !== null && typeof workspace.pickDirectory === 'function';
			} catch (error) {
				return false;
			}
		}

		function pickDirectory() {
			try {
				var workspace = clientCtx === null || typeof clientCtx.get !== 'function' ? undefined : clientCtx.get('uiWorkspace');
				if (workspace === undefined || workspace === null || typeof workspace.pickDirectory !== 'function') return Promise.resolve(null);
				return Promise.resolve(workspace.pickDirectory());
			} catch (error) {
				return Promise.resolve(null);
			}
		}

		/* ------------------------------------------------------------ *
		 * shared controls
		 * ------------------------------------------------------------ */

		var INPUT_TYPES = ['text', 'number', 'date', 'time', 'datetime-local', 'url', 'email', 'password', 'search', 'tel', 'color'];

		function inputTypeOf(element) {
			if (element.kind === 'date' || element.kind === 'time') return element.kind;
			var declared = typeof element.input_type === 'string' ? element.input_type : (typeof element.type === 'string' ? element.type : 'text');
			return INPUT_TYPES.indexOf(declared) === -1 ? 'text' : declared;
		}

		function textInput(options) {
			var type = options.type;
			var props = {
				className: options.className || 'iui-input',
				type: type,
				placeholder: options.placeholder || '',
				disabled: options.disabled === true,
				onChange: options.onChange,
			};
			if (type === 'number') {
				props.value = options.value === '' || options.value === null || options.value === undefined ? '' : String(options.value);
				if (typeof options.min === 'number') props.min = options.min;
				if (typeof options.max === 'number') props.max = options.max;
				if (typeof options.step === 'number') props.step = options.step;
			} else {
				props.value = options.value === null || options.value === undefined ? '' : String(options.value);
				if (typeof options.min === 'string' && (type === 'date' || type === 'time')) props.min = options.min;
				if (typeof options.max === 'string' && (type === 'date' || type === 'time')) props.max = options.max;
				if (typeof options.maxlength === 'number') props.maxLength = options.maxlength;
			}
			if (type === 'color' && (props.value === '' || typeof props.value !== 'string')) props.value = '#3b82f6';
			return h('input', props);
		}

		function readInput(element, type, event) {
			if (type === 'number') {
				var raw = event.target.value;
				return raw === '' ? '' : Number(raw);
			}
			return event.target.value;
		}

		function requiredMark(element) {
			return element.required === true ? h('i', { className: 'iui-req' }, '*') : null;
		}

		/** `used/max` for a field with a maxlength, red once it is over. */
		function fieldCounter(element, value) {
			if (typeof element.maxlength !== 'number' || element.maxlength <= 0) return null;
			var used = value === undefined || value === null ? '' : String(value);
			var over = used.length > element.maxlength;
			return h('span', { className: 'iui-count' + (over ? ' is-over' : '') }, used.length + '/' + element.maxlength);
		}

		/**
		 * Label row: label + required marker on the left, counter on the right.
		 * `extras` is optional: { counter, missing }.
		 */
		function fieldBlock(element, key, label, control, hint, extras) {
			var options = extras || {};
			var head = label !== null && label !== undefined && label !== ''
				? h('span', { className: 'iui-label' }, label, requiredMark(element))
				: null;
			var row = head === null
				? (options.counter || null)
				: (options.counter ? h('span', { className: 'iui-row' }, head, options.counter) : head);
			return h('label', { className: 'iui-field' + (options.missing === true ? ' is-missing' : ''), key: key },
				row,
				control,
				hint ? h('span', { className: 'iui-hint' }, hint) : null);
		}

		function isBlank(value) {
			if (value === undefined || value === null) return true;
			if (typeof value === 'string') return value.trim().length === 0;
			if (Array.isArray(value)) return value.length === 0;
			return false;
		}

		/**
		 * Required fields that are still empty, as { key, label }. `key` is the value
		 * path joined with '/', which is what the panel marks as missing. Tabs share
		 * their parent's base (their elements are addressed directly); wizards and
		 * forms nest.
		 */
		function collectMissing(elements, values, base, out) {
			var list = Array.isArray(elements) ? elements : [];
			for (var i = 0; i < list.length; i++) {
				var element = list[i];
				if (!isPlainObject(element)) continue;
				var kind = element.kind;
				var id = typeof element.id === 'string' ? element.id : '';
				if (kind === 'wizard') {
					var steps = Array.isArray(element.steps) ? element.steps : [];
					for (var s = 0; s < steps.length; s++) {
						if (!isPlainObject(steps[s])) continue;
						var stepId = typeof steps[s].id === 'string' ? steps[s].id : 'step_' + s;
						collectMissing(steps[s].elements, values, base.concat([id, stepId]), out);
					}
					continue;
				}
				if (kind === 'tabs') {
					var tabs = Array.isArray(element.tabs) ? element.tabs : [];
					for (var t = 0; t < tabs.length; t++) {
						if (!isPlainObject(tabs[t])) continue;
						collectMissing(tabs[t].elements, values, base, out);
					}
					continue;
				}
				if (kind === 'form') {
					var fields = Array.isArray(element.fields) ? element.fields : [];
					var bucket = atPath(values, base.concat([id]));
					for (var f = 0; f < fields.length; f++) {
						var field = fields[f];
						if (!isPlainObject(field) || field.required !== true) continue;
						var fieldId = typeof field.id === 'string' ? field.id : 'field_' + f;
						var fieldPath = base.concat([id, fieldId]);
						if (isBlank(isPlainObject(bucket) ? bucket[fieldId] : undefined)) {
							out.push({ key: fieldPath.join('/'), label: typeof field.label === 'string' && field.label.length > 0 ? field.label : fieldId });
						}
					}
					continue;
				}
				if (id.length > 0 && element.required === true && isBlank(atPath(values, base.concat([id])))) {
					out.push({ key: base.concat([id]).join('/'), label: typeof element.label === 'string' && element.label.length > 0 ? element.label : id });
				}
			}
			return out;
		}

		/**
		 * Republish this package's client bundle, then reload the page so the
		 * browser boots the new revision. The republish is best-effort: a failed
		 * POST still reloads, which is what a plain F5 would have done.
		 */
		function reloadUi(event) {
			if (event && typeof event.preventDefault === 'function') event.preventDefault();
			var reload = function () {
				try {
					window.location.reload();
				} catch (error) {
					console.warn('[' + NS + '] reload failed', error);
				}
			};
			try {
				fetch(ROUTE + '/refresh', { method: 'POST', headers: { accept: 'application/json' } })
					.then(reload, reload);
			} catch (error) {
				reload();
			}
		}

		/* ------------------------------------------------------------ *
		 * bundle watcher
		 *
		 * The host republishes this package's client bundle on POST /refresh
		 * (its own HMR hook). Nothing tells a page that is already running to
		 * pick the new bytes up, so we poll the boot graph and reload when the
		 * revision changes — unless someone is mid-answer or mid-typing.
		 * ------------------------------------------------------------ */

		/** Boot revisions of this package's client bundle, newest seen last. */
		var bootRev = null;
		/** Panels currently waiting for an answer. */
		var openPanels = 0;

		function publishedRev(body) {
			if (!isPlainObject(body) || !Array.isArray(body.entries)) return null;
			for (var index = 0; index < body.entries.length; index++) {
				var entry = body.entries[index];
				if (isPlainObject(entry) && entry.id === NS) return typeof entry.rev === 'string' ? entry.rev : null;
			}
			return null;
		}

		/** True while focus sits in something the user is typing into. */
		function typingSomewhere() {
			try {
				var active = document.activeElement;
				if (!active) return false;
				var tag = String(active.tagName || '').toLowerCase();
				return tag === 'textarea' || tag === 'input' || active.isContentEditable === true;
			} catch (error) {
				return false;
			}
		}

		/** Poll the boot graph; returns a stop function. */
		function watchBundle() {
			if (typeof window === 'undefined' || typeof fetch !== 'function') return function () {};
			var timer = null;
			var poll = function () {
				try {
					fetch(ROUTE + '/modules', { headers: { accept: 'application/json' }, cache: 'no-store' })
						.then(function (response) { return response.ok ? response.json() : null; }, function () { return null; })
						.then(function (body) {
							var rev = publishedRev(body);
							if (rev === null) return;
							if (bootRev === null) { bootRev = rev; return; }
							if (rev === bootRev) return;
							if (openPanels > 0 || typingSomewhere()) return;
							if (timer !== null) window.clearInterval(timer);
							window.location.reload();
						}, function () {});
				} catch (error) {
					/* a watcher that cannot poll is still better than one that throws */
				}
			};
			poll();
			if (typeof window.setInterval === 'function') timer = window.setInterval(poll, WATCH_MS);
			return function () {
				if (timer !== null) window.clearInterval(timer);
			};
		}

		/* ------------------------------------------------------------ *
		 * widgets
		 * ------------------------------------------------------------ */

		/* ------------------------------------------------------------ *
		 * markdown — a small, safe subset. Raw HTML is never interpreted:
		 * every character goes through React as text, so a `<script>` shows up
		 * as visible text instead of executing.
		 * ------------------------------------------------------------ */

		function inlineMd(text, keyPrefix) {
			var source = String(text === undefined || text === null ? '' : text);
			var pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g;
			var nodes = [];
			var last = 0;
			var position = 0;
			var match;
			while ((match = pattern.exec(source)) !== null) {
				if (match.index > last) nodes.push(source.slice(last, match.index));
				var token = match[0];
				var key = keyPrefix + position;
				if (token.charAt(0) === '`') {
					nodes.push(h('code', { key: key }, token.slice(1, -1)));
				} else if (token.slice(0, 2) === '**') {
					nodes.push(h('strong', { key: key }, token.slice(2, -2)));
				} else {
					var split = token.indexOf('](');
					var href = token.slice(split + 2, -1);
					var safe = /^https?:\/\//i.test(href) === true || href.charAt(0) === '/' || href.charAt(0) === '#';
					nodes.push(safe === true
						? h('a', { key: key, href: href, target: '_blank', rel: 'noreferrer noopener' }, token.slice(1, split))
						: token.slice(1, split));
				}
				last = match.index + token.length;
				position += 1;
			}
			if (last < source.length) nodes.push(source.slice(last));
			return nodes.length === 0 ? [''] : nodes;
		}

		function isTableRow(line) {
			return typeof line === 'string' && line.indexOf('|') >= 0;
		}

		function isTableDivider(line) {
			if (typeof line !== 'string' || line.indexOf('-') < 0 || line.indexOf('|') < 0) return false;
			return /^[\s|:-]+$/.test(line) === true;
		}

		function splitRow(line) {
			return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (cell) {
				return cell.trim();
			});
		}

		function codeBlock(code, language, key) {
			var copy = function (event) {
				var button = event === undefined || event === null ? null : event.currentTarget;
				try {
					if (typeof navigator !== 'undefined' && navigator !== null && navigator.clipboard !== undefined && navigator.clipboard !== null) {
						navigator.clipboard.writeText(code);
					}
				} catch (error) {
					/* clipboard access is best-effort */
				}
				if (button !== null && button !== undefined) {
					try {
						button.textContent = 'copied';
						setTimeout(function () {
							button.textContent = 'copy';
						}, 1200);
					} catch (error) {
						/* feedback is best-effort */
					}
				}
			};
			var head = h('div', { className: 'iui-code-head', key: 'head' + key },
				h('span', { className: 'iui-code-lang' }, language.length > 0 ? language : 'code'),
				h('button', { type: 'button', className: 'iui-copy', onClick: copy }, 'copy'));
			return h('div', { className: 'iui-code', key: 'code' + key }, head, h('pre', null, h('code', null, code)));
		}

		function markdownBlocks(text) {
			var lines = String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
			var blocks = [];
			var paragraph = [];
			var key = 0;
			var flush = function () {
				if (paragraph.length === 0) return;
				blocks.push(h('p', { key: 'p' + key }, inlineMd(paragraph.join(' '), 'p' + key + '-')));
				key += 1;
				paragraph = [];
			};
			for (var index = 0; index < lines.length; index++) {
				var line = lines[index];
				if (/^\s*$/.test(line) === true) {
					flush();
					continue;
				}
				var fence = /^\s*```+\s*([A-Za-z0-9_+#.-]*)\s*$/.exec(line);
				if (fence !== null) {
					flush();
					var body = [];
					index += 1;
					while (index < lines.length && /^\s*```/.test(lines[index]) === false) {
						body.push(lines[index]);
						index += 1;
					}
					blocks.push(codeBlock(body.join('\n'), fence[1] || '', key));
					key += 1;
					continue;
				}
				var heading = /^(#{1,4})\s+(.*)$/.exec(line);
				if (heading !== null) {
					flush();
					blocks.push(h('h' + heading[1].length, { key: 'h' + key }, inlineMd(heading[2], 'h' + key + '-')));
					key += 1;
					continue;
				}
				if (/^\s*(-{3,}|\*{3,})\s*$/.test(line) === true) {
					flush();
					blocks.push(h('hr', { key: 'r' + key }));
					key += 1;
					continue;
				}
				if (/^\s*>\s?/.test(line) === true) {
					flush();
					var quote = [];
					while (index < lines.length && /^\s*>\s?/.test(lines[index]) === true) {
						quote.push(lines[index].replace(/^\s*>\s?/, ''));
						index += 1;
					}
					index -= 1;
					blocks.push(h('blockquote', { key: 'q' + key }, inlineMd(quote.join(' '), 'q' + key + '-')));
					key += 1;
					continue;
				}
				var item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
				if (item !== null) {
					flush();
					var ordered = /^\d/.test(item[1]) === true;
					var entries = [];
					while (index < lines.length) {
						var next = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index]);
						if (next === null) break;
						entries.push(h('li', { key: 'i' + entries.length }, inlineMd(next[2], 'i' + entries.length + '-')));
						index += 1;
					}
					index -= 1;
					blocks.push(h(ordered === true ? 'ol' : 'ul', { key: 'l' + key }, entries));
					key += 1;
					continue;
				}
				if (isTableRow(line) === true && isTableDivider(lines[index + 1]) === true) {
					flush();
					var header = splitRow(line);
					var rows = [];
					index += 2;
					while (index < lines.length && isTableRow(lines[index]) === true) {
						rows.push(splitRow(lines[index]));
						index += 1;
					}
					index -= 1;
					blocks.push(h('table', { key: 't' + key },
						h('thead', null, h('tr', null, header.map(function (cell, position) {
							return h('th', { key: position }, inlineMd(cell, 'th' + position + '-'));
						}))),
						h('tbody', null, rows.map(function (row, rowIndex) {
							return h('tr', { key: rowIndex }, row.map(function (cell, position) {
								return h('td', { key: position }, inlineMd(cell, 'td' + rowIndex + '-' + position + '-'));
							}));
						}))));
					key += 1;
					continue;
				}
				paragraph.push(line.trim());
			}
			flush();
			return blocks;
		}

		/* ------------------------------------------------------------ *
		 * upload — the one widget that writes to disk: the browser posts the
		 * bytes, the host half stores them and returns a real path the answer
		 * (and so the model) can use.
		 * ------------------------------------------------------------ */

		function formatSize(bytes) {
			if (typeof bytes !== 'number' || bytes < 0) return '';
			if (bytes < 1024) return bytes + ' B';
			if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
			return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
		}

		function fileNameOf(entry, fallback) {
			if (entry !== null && entry !== undefined && typeof entry.path === 'string' && entry.path.length > 0) {
				return entry.path.split(/[\\/]/).pop() || entry.path;
			}
			if (typeof entry === 'string') return entry.split(/[\\/]/).pop() || entry;
			return fallback;
		}

		function uploadWidget(element, index, label, description, value, disabled, state, path) {
			var files = Array.isArray(value) ? value : [];
			var multiple = element.multiple !== false;
			var accept = typeof element.accept === 'string' ? element.accept : '';

			var sendOne = function (target) {
				var name = typeof target.name === 'string' && target.name.length > 0 ? target.name : 'upload.bin';
				return fetch(
					ROUTE + '/upload?callId=' + encodeURIComponent(state.callId) + '&name=' + encodeURIComponent(name),
					{
						method: 'POST',
						headers: { 'content-type': typeof target.type === 'string' && target.type.length > 0 ? target.type : 'application/octet-stream' },
						body: target,
					},
				).then(function (response) {
					return response.json().then(function (data) {
						if (!response.ok) {
							throw new Error(data && data.error ? data.error : 'upload failed: HTTP ' + response.status);
						}
						return data.file;
					});
				});
			};

			var send = function (list) {
				if (disabled === true || list === null || list === undefined) return;
				var chosen = [];
				for (var index2 = 0; index2 < list.length; index2++) chosen.push(list[index2]);
				if (multiple === false && chosen.length > 1) chosen = [chosen[0]];
				if (chosen.length === 0) return;
				state.setBusy(true);
				state.setNote('');
				var merged = multiple === true ? files.slice() : [];
				var chain = Promise.resolve();
				for (var position2 = 0; position2 < chosen.length; position2++) {
					chain = chain
						.then((function (target) {
							return function () {
								return sendOne(target).then(function (entry) {
									if (entry === null || entry === undefined) return;
									for (var scan = 0; scan < merged.length; scan++) {
										if (merged[scan] !== null && merged[scan] !== undefined && merged[scan].path === entry.path) return;
									}
									merged.push(entry);
								});
							};
						})(chosen[position2]));
				}
				chain.then(function () {
					state.set(path, merged);
					state.setBusy(false);
				}).catch(function (error) {
					state.set(path, merged);
					state.setNote(String((error && error.message) || error));
					state.setBusy(false);
				});
			};

			var listed = files.map(function (entry, position) {
				return h('div', { className: 'iui-file', key: position },
					h('b', null, fileNameOf(entry, 'file ' + (position + 1))),
					entry !== null && entry !== undefined && typeof entry.size === 'number'
						? h('span', { className: 'iui-file-size' }, formatSize(entry.size))
						: null,
					disabled === true ? null : h('button', {
						type: 'button',
						className: 'iui-btn iui-btn--ghost',
						onClick: function () {
							state.set(path, files.filter(function (_entry, other) { return other !== position; }));
						},
					}, '✕'));
			});

			return h('div', { className: 'iui-field', key: index },
				label.length > 0 ? h('span', { className: 'iui-label' }, label) : null,
				description ? h('span', { className: 'iui-hint' }, description) : null,
				h('label', {
					className: 'iui-drop',
					onDragOver: function (event) { event.preventDefault(); },
					onDrop: function (event) {
						event.preventDefault();
						send(event.dataTransfer && event.dataTransfer.files);
					},
				},
					h('input', {
						type: 'file',
						style: { display: 'none' },
						multiple: multiple,
						accept: accept.length > 0 ? accept : undefined,
						onChange: function (event) {
							send(event.target.files);
							event.target.value = '';
						},
					}),
					h('span', { className: 'iui-drop-hint' },
						typeof element.hint === 'string' && element.hint.length > 0
							? element.hint
							: '点击选择文件，或把它们拖到这里'),
					h('span', { className: 'iui-btn iui-btn--ghost' }, multiple === true ? '选择文件' : '选择文件')),
				listed.length > 0 ? h('div', { className: 'iui-files' }, listed) : null);
		}

		function widget(element, index, state, base) {
			var id = typeof element.id === 'string' ? element.id : '';
			var path = (base || []).concat([id]);
			var value = id.length > 0 ? atPath(state.values, path) : undefined;
			var label = typeof element.label === 'string' ? element.label : '';
			var description = typeof element.description === 'string' && element.description.length > 0 ? element.description : '';
			var busy = state.busy === true;
			var disabled = busy || element.disabled === true;
			var missingKeys = Array.isArray(state.values.__missing) ? state.values.__missing : [];
			var missing = missingKeys.indexOf(path.join('/')) !== -1;

			if (element.kind === 'text') {
				var tone = element.tone === 'warn' || element.tone === 'error' || element.tone === 'ok' || element.tone === 'quote' ? ' iui-text--' + element.tone : '';
				return h('p', { className: 'iui-text' + tone, key: index }, String(element.text === undefined ? '' : element.text));
			}

			if (element.kind === 'markdown') {
				var markdown = String(element.text === undefined || element.text === null ? '' : element.text);
				if (markdown.length === 0) return null;
				return h('div', { className: 'iui-md', key: index }, markdownBlocks(markdown));
			}

			if (element.kind === 'upload') {
				return uploadWidget(element, index, label, description, value, disabled, state, path);
			}

			if (element.kind === 'link') {
				var href = typeof element.href === 'string' ? element.href : '#';
				return h('a', { className: 'iui-link', key: index, href: href, target: '_blank', rel: 'noreferrer noopener' },
					label.length > 0 ? label : href);
			}

			if (element.kind === 'button') {
				return h('button', {
					type: 'button',
					key: index,
					className: 'iui-btn iui-btn--' + (element.style === 'primary' || element.style === 'danger' ? element.style : 'ghost'),
					disabled: disabled,
					onClick: function () { state.submit('button', id); },
				}, label.length > 0 ? label : 'OK');
			}

			if (element.kind === 'select') {
				var options = Array.isArray(element.options) ? element.options : [];
				var children = [h('option', { value: '', key: '__none' }, label.length > 0 ? '— ' + label + ' —' : '—')];
				for (var i = 0; i < options.length; i++) {
					children.push(h('option', { value: String(optionValue(options[i])), key: i }, optionLabel(options[i])));
				}
				return fieldBlock(element, index, label, h('span', { className: 'iui-select-wrap' }, h('select', {
					className: 'iui-select',
					disabled: disabled,
					value: value === undefined || value === null ? '' : String(value),
					onChange: function (event) { state.set(path, event.target.value); },
				}, children)), description);
			}

			if (element.kind === 'radio') {
				var choices = Array.isArray(element.options) ? element.options : [];
				return h('div', { className: 'iui-field', key: index },
					label.length > 0 ? h('span', { className: 'iui-label' }, label) : null,
					description ? h('span', { className: 'iui-hint' }, description) : null,
					h('div', { className: 'iui-cards' }, choices.map(function (option, position) {
						var raw = optionValue(option);
						var on = value !== undefined && String(value) === String(raw);
						return h('button', {
							type: 'button',
							key: position,
							className: 'iui-card' + (on ? ' is-on' : ''),
							disabled: disabled,
							onClick: function () { state.set(path, raw); },
						},
							h('span', { className: 'iui-card-title' }, optionLabel(option)),
							isPlainObject(option) && typeof option.description === 'string'
								? h('span', { className: 'iui-card-desc' }, option.description)
								: null);
					})));
			}

			var hasOptions = Array.isArray(element.options) && element.options.length > 0;
			if ((element.kind === 'checkbox' || element.kind === 'switch') && !hasOptions) {
				return h('label', { className: 'iui-check', key: index },
					h('input', {
						type: 'checkbox',
						checked: value === true,
						disabled: disabled,
						onChange: function (event) { state.set(path, event.target.checked); },
					}),
					h('span', null,
						h('span', { className: 'iui-label' }, label.length > 0 ? label : id),
						description ? h('div', { className: 'iui-hint' }, description) : null));
			}

			if (element.kind === 'multiselect' || ((element.kind === 'checkbox' || element.kind === 'switch') && hasOptions)) {
				var picks = Array.isArray(element.options) ? element.options : [];
				var selected = Array.isArray(value) ? value : [];
				var columns = typeof element.columns === 'number' && element.columns > 0 ? Math.min(4, Math.floor(element.columns)) : 1;
				return h('div', { className: 'iui-field', key: index },
					label.length > 0 ? h('span', { className: 'iui-label' }, label) : null,
					description ? h('span', { className: 'iui-hint' }, description) : null,
					h('div', { className: 'iui-grid' + (picks.length > 6 ? ' iui-scroll' : ''), style: { gridTemplateColumns: 'repeat(' + columns + ',minmax(0,1fr))' } },
						picks.map(function (option, position) {
							var raw = optionValue(option);
							var on = selected.some(function (entry) { return String(entry) === String(raw); });
							return h('label', { className: 'iui-check', key: position },
								h('input', {
									type: 'checkbox',
									className: 'iui-pick',
									checked: on,
									disabled: disabled,
									onChange: function (event) {
										var next = selected.filter(function (entry) { return String(entry) !== String(raw); });
										if (event.target.checked) next = selected.concat([raw]);
										state.set(path, next);
									},
								}),
								h('span', null,
									h('span', { className: 'iui-card-title' }, optionLabel(option)),
									isPlainObject(option) && typeof option.description === 'string'
										? h('div', { className: 'iui-hint' }, option.description)
										: null));
						})));
			}

			if (element.kind === 'slider') {
				var current = typeof value === 'number' ? value : (typeof element.default === 'number' ? element.default : Number(element.min || 0));
				return fieldBlock(element, index, null, h('span', { className: 'iui-field' },
					h('span', { className: 'iui-row' },
						h('span', { className: 'iui-label' }, label),
						h('span', { className: 'iui-value' }, String(current), h('span', { className: 'iui-unit' }, typeof element.unit === 'string' ? element.unit : ''))),
					h('input', {
						type: 'range',
						className: 'iui-range',
						min: element.min === undefined ? 0 : element.min,
						max: element.max === undefined ? 100 : element.max,
						step: element.step === undefined ? 1 : element.step,
						value: current,
						disabled: disabled,
						onChange: function (event) { state.set(path, Number(event.target.value)); },
					})), description);
			}

			if (element.kind === 'number') {
				var numberValue = typeof value === 'number' ? value : (value === '' || value === undefined || value === null ? '' : Number(value));
				return fieldBlock(element, index, label, h('span', { className: 'iui-inline' },
					textInput({
						type: 'number',
						value: numberValue,
						className: 'iui-input',
						placeholder: typeof element.placeholder === 'string' ? element.placeholder : '',
						min: typeof element.min === 'number' ? element.min : undefined,
						max: typeof element.max === 'number' ? element.max : undefined,
						step: typeof element.step === 'number' ? element.step : undefined,
						disabled: disabled,
						onChange: function (event) { state.set(path, readInput(element, 'number', event)); },
					}),
					typeof element.unit === 'string' && element.unit.length > 0 ? h('span', { className: 'iui-unit' }, element.unit) : null), description);
			}

			if (element.kind === 'date' || element.kind === 'time' || element.kind === 'input') {
				var type = inputTypeOf(element);
				return fieldBlock(element, index, label, textInput({
					type: type,
					value: value,
					placeholder: typeof element.placeholder === 'string' ? element.placeholder : '',
					className: 'iui-input',
					disabled: disabled,
					min: typeof element.min === 'string' ? element.min : undefined,
					max: typeof element.max === 'string' ? element.max : undefined,
					maxlength: typeof element.maxlength === 'number' ? element.maxlength : undefined,
					onChange: function (event) { state.set(path, readInput(element, type, event)); },
				}), description, { counter: fieldCounter(element, value), missing: missing });
			}

			if (element.kind === 'textarea') {
				return fieldBlock(element, index, label, h('textarea', {
					className: 'iui-area',
					rows: typeof element.rows === 'number' && element.rows > 0 ? element.rows : 3,
					placeholder: typeof element.placeholder === 'string' ? element.placeholder : '',
					maxLength: typeof element.maxlength === 'number' ? element.maxlength : undefined,
					value: value === undefined || value === null ? '' : String(value),
					disabled: disabled,
					onChange: function (event) { state.set(path, event.target.value); },
				}), description, { counter: fieldCounter(element, value), missing: missing });
			}

			if (element.kind === 'path') {
				var picker = element.mode !== 'file' && canPickDirectory();
				var browse = picker ? h('button', {
					type: 'button',
					className: 'iui-btn iui-btn--ghost',
					disabled: disabled,
					onClick: function () {
						pickDirectory().then(function (chosen) {
							if (typeof chosen === 'string' && chosen.length > 0) state.set(path, chosen);
						});
					},
				}, typeof element.browse_label === 'string' && element.browse_label.length > 0 ? element.browse_label : 'Browse…') : null;
				return fieldBlock(element, index, label, h('span', { className: 'iui-inline' },
					textInput({
						type: 'text',
						value: value,
						placeholder: typeof element.placeholder === 'string' ? element.placeholder : (element.mode === 'file' ? 'path/to/file' : 'path/to/folder'),
						className: 'iui-input',
						disabled: disabled,
						onChange: function (event) { state.set(path, event.target.value); },
					}), browse),
					description || (element.mode === 'file' ? 'Type the host path — the browser cannot read it from disk.' : ''));
			}

			if (element.kind === 'chart') {
				return chartWidget(element, index);
			}

			if (element.kind === 'diff') {
				return diffWidget(element, index, label, description);
			}

			if (element.kind === 'timeline') {
				return timelineWidget(element, index, label, description);
			}

			if (element.kind === 'tree') {
				return treeWidget(element, index, label, description, value, disabled, state, path);
			}

			if (element.kind === 'progress') {
				return progressWidget(element, index, label, description);
			}

			if (element.kind === 'tabs') {
				return tabsWidget(element, index, label, description, state, base);
			}

			if (element.kind === 'table') {
				return tableWidget(element, index, state, path);
			}

			if (element.kind === 'wizard') {
				return wizardWidget(element, index, state, (base || []).concat([id]));
			}

			if (element.kind === 'form') {
				var fields = Array.isArray(element.fields) ? element.fields : [];
				var bucket = isPlainObject(value) ? value : {};
				return h('div', { className: 'iui-field', key: index },
					label.length > 0 ? h('span', { className: 'iui-label' }, label) : null,
					description ? h('span', { className: 'iui-hint' }, description) : null,
					h('div', { className: 'iui-form' }, fields.map(function (field, position) {
						if (!isPlainObject(field)) return null;
						var fieldId = typeof field.id === 'string' ? field.id : 'field_' + position;
						var fieldType = typeof field.type === 'string' ? field.type : 'text';
						var fieldLabel = typeof field.label === 'string' ? field.label : fieldId;
						var fieldPath = path.concat([fieldId]);
						var fieldValue = bucket[fieldId];
						var onChange = function (event) { state.set(fieldPath, fieldType === 'number' ? readInput(field, 'number', event) : event.target.value); };
						var control = fieldType === 'textarea'
							? h('textarea', {
								className: 'iui-area',
								rows: typeof field.rows === 'number' && field.rows > 0 ? field.rows : 2,
								placeholder: typeof field.placeholder === 'string' ? field.placeholder : '',
								value: fieldValue === undefined || fieldValue === null ? '' : String(fieldValue),
								disabled: disabled,
								onChange: onChange,
							})
							: textInput({
								type: INPUT_TYPES.indexOf(fieldType) === -1 ? 'text' : fieldType,
								value: fieldValue,
								placeholder: typeof field.placeholder === 'string' ? field.placeholder : '',
								className: 'iui-input',
								disabled: disabled,
								onChange: onChange,
							});
						var fieldMissing = Array.isArray(state.values.__missing) && state.values.__missing.indexOf(fieldPath.join('/')) !== -1;
						var fieldCount = fieldCounter(field, fieldValue);
						var fieldLabelNode = h('span', { className: 'iui-hint' }, fieldLabel, requiredMark(field));
						return h('label', { className: 'iui-field' + (fieldMissing ? ' is-missing' : ''), key: position },
							fieldCount === null ? fieldLabelNode : h('span', { className: 'iui-row' }, fieldLabelNode, fieldCount), control);
					})));
			}

			return null;
		}

		/* ------------------------------------------------------------ *
		 * table widget
		 * ------------------------------------------------------------ */

		/* ---- diff ---- */

		function diffRows(beforeText, afterText) {
			var beforeLines = String(beforeText === undefined || beforeText === null ? '' : beforeText).replace(/\r\n?/g, '\n').split('\n');
			var afterLines = String(afterText === undefined || afterText === null ? '' : afterText).replace(/\r\n?/g, '\n').split('\n');
			if (beforeLines.length === 1 && beforeLines[0] === '') beforeLines = [];
			if (afterLines.length === 1 && afterLines[0] === '') afterLines = [];
			/* A trailing newline is a line terminator, not an extra empty line. */
			if (beforeLines.length > 1 && beforeLines[beforeLines.length - 1] === '') beforeLines.pop();
			if (afterLines.length > 1 && afterLines[afterLines.length - 1] === '') afterLines.pop();
			var limit = 2000;
			if (beforeLines.length > limit || afterLines.length > limit) return null;
			var table = [];
			for (var row = 0; row <= beforeLines.length; row++) table.push(new Uint16Array(afterLines.length + 1));
			for (var left = beforeLines.length - 1; left >= 0; left--) {
				for (var right = afterLines.length - 1; right >= 0; right--) {
					table[left][right] = beforeLines[left] === afterLines[right]
						? table[left + 1][right + 1] + 1
						: Math.max(table[left + 1][right], table[left][right + 1]);
				}
			}
			var rows = [];
			var i = 0;
			var j = 0;
			var beforeNo = 1;
			var afterNo = 1;
			while (i < beforeLines.length && j < afterLines.length) {
				if (beforeLines[i] === afterLines[j]) {
					rows.push({ type: 'same', text: beforeLines[i], before: beforeNo++, after: afterNo++ });
					i++;
					j++;
				} else if (table[i + 1][j] >= table[i][j + 1]) {
					rows.push({ type: 'del', text: beforeLines[i], before: beforeNo++, after: null });
					i++;
				} else {
					rows.push({ type: 'add', text: afterLines[j], before: null, after: afterNo++ });
					j++;
				}
			}
			while (i < beforeLines.length) rows.push({ type: 'del', text: beforeLines[i++], before: beforeNo++, after: null });
			while (j < afterLines.length) rows.push({ type: 'add', text: afterLines[j++], before: null, after: afterNo++ });
			return rows;
		}

		function trimContext(rows, context) {
			var keep = [];
			var changed = false;
			for (var index = 0; index < rows.length; index++) {
				keep.push(false);
				if (rows[index].type !== 'same') changed = true;
			}
			if (changed === false) return null;
			for (var at = 0; at < rows.length; at++) {
				if (rows[at].type === 'same') continue;
				for (var span = Math.max(0, at - context); span <= Math.min(rows.length - 1, at + context); span++) keep[span] = true;
			}
			var out = [];
			var skipped = 0;
			for (var position = 0; position < rows.length; position++) {
				if (keep[position] === true) {
					if (skipped > 0) {
						out.push({ type: 'skip', text: '⋯ ' + skipped + ' unchanged line' + (skipped === 1 ? '' : 's') });
						skipped = 0;
					}
					out.push(rows[position]);
				} else skipped++;
			}
			if (skipped > 0) out.push({ type: 'skip', text: '⋯ ' + skipped + ' unchanged line' + (skipped === 1 ? '' : 's') });
			return out;
		}

		function diffWidget(element, index, label, description) {
			var context = typeof element.context === 'number' && element.context >= 0 ? Math.floor(element.context) : 3;
			var rows = diffRows(element.before_text, element.after_text);
			var notes = [];
			if (rows === null) notes.push('Too large to diff (limit 2000 lines per side) — showing the text as-is.');
			else {
				rows = trimContext(rows, context);
				if (rows === null) {
					notes.push('The two sides are identical.');
					rows = [];
				}
			}
			var added = 0;
			var removed = 0;
			for (var count = 0; rows !== null && count < rows.length; count++) {
				if (rows[count].type === 'add') added++;
				else if (rows[count].type === 'del') removed++;
			}
			var head = label.length > 0 ? label : (String(element.before_name || 'before') + ' → ' + String(element.after_name || 'after'));
			var body = rows === null
				? [h('div', { className: 'iui-dl', key: 'raw' },
					h('span', { className: 'iui-dl-n' }, ' '),
					h('span', { className: 'iui-dl-s' }, ' '),
					h('span', { className: 'iui-dl-t' }, String(element.after_text === undefined ? element.before_text : element.after_text)))]
				: rows.map(function (row, position) {
					if (row.type === 'skip') {
						return h('div', { className: 'iui-dl is-skip', key: position },
							h('span', { className: 'iui-dl-n' }, '⋯'),
							h('span', { className: 'iui-dl-s' }, ' '),
							h('span', { className: 'iui-dl-t' }, row.text));
					}
					return h('div', { className: 'iui-dl' + (row.type === 'same' ? '' : ' is-' + row.type), key: position },
						h('span', { className: 'iui-dl-n' }, row.before === null || row.before === undefined ? '' : String(row.before)),
						h('span', { className: 'iui-dl-n' }, row.after === null || row.after === undefined ? '' : String(row.after)),
						h('span', { className: 'iui-dl-s' }, row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '),
						h('span', { className: 'iui-dl-t' }, row.text));
				});
			return h('div', { className: 'iui-field', key: index },
				description ? h('span', { className: 'iui-hint' }, description) : null,
				h('div', { className: 'iui-diff' },
					h('div', { className: 'iui-diff-head' },
						h('span', { className: 'iui-diff-name' }, head),
						h('span', { className: 'iui-diff-stat' },
							h('span', { className: 'is-add' }, '+' + added), ' ', h('span', { className: 'is-del' }, '−' + removed))),
					h('div', { className: 'iui-diff-body' }, body)),
				notes.map(function (note, position) { return h('span', { className: 'iui-hint', key: 'note_' + position }, note); }));
		}

		/* ---- timeline ---- */

		function timelineWidget(element, index, label, description) {
			var items = Array.isArray(element.items) ? element.items : [];
			var lines = [];
			for (var position = 0; position < items.length; position++) {
				var item = items[position];
				if (!isPlainObject(item)) continue;
				var tone = item.tone === 'ok' || item.tone === 'warn' || item.tone === 'error' ? ' is-' + item.tone : '';
				lines.push(h('div', { className: 'iui-tl-item' + tone, key: position },
					h('span', { className: 'iui-tl-dot' }),
					item.at === undefined ? null : h('div', { className: 'iui-tl-at' }, String(item.at)),
					item.title === undefined ? null : h('div', { className: 'iui-tl-title' }, String(item.title)),
					item.text === undefined ? null : h('div', { className: 'iui-tl-text' }, String(item.text))));
			}
			return h('div', { className: 'iui-field', key: index },
				label.length > 0 ? h('span', { className: 'iui-label' }, label) : null,
				description ? h('span', { className: 'iui-hint' }, description) : null,
				h('div', { className: 'iui-tl' }, lines));
		}

		/* ---- tree ---- */

		function treeCheckedIds(nodes, out) {
			for (var index = 0; index < nodes.length; index++) {
				var node = nodes[index];
				if (!isPlainObject(node)) continue;
				if (node.checked === true && typeof node.id === 'string' && node.id.length > 0) out.push(node.id);
				if (Array.isArray(node.children)) treeCheckedIds(node.children, out);
			}
			return out;
		}

		function treeWidget(element, index, label, description, value, disabled, state, path) {
			var nodes = Array.isArray(element.nodes) ? element.nodes : [];
			var selected = Array.isArray(value) ? value : [];
			var scope = typeof element.id === 'string' && element.id.length > 0 ? element.id : '';
			var openPath = ['__open', scope];
			var open = atPath(state.values, openPath);
			if (isPlainObject(open) === false) open = {};
			var depth = typeof element.expand_depth === 'number' ? Math.floor(element.expand_depth) : 1;

			function branch(list, level, prefix) {
				return h('ul', { className: 'iui-tree-list', key: 'ul_' + prefix }, list.map(function (node, position) {
					if (!isPlainObject(node)) return null;
					var nodeId = typeof node.id === 'string' && node.id.length > 0 ? node.id : prefix + '.' + position;
					var children = Array.isArray(node.children) ? node.children : [];
					var isOpen = open[nodeId] === undefined ? level < depth : open[nodeId] === true;
					var on = selected.indexOf(nodeId) !== -1;
					var row = [];
					row.push(children.length > 0
						? h('button', {
							type: 'button', key: 'toggle', className: 'iui-tree-toggle',
							onClick: function () { state.set(openPath.concat([nodeId]), isOpen === false); },
						}, isOpen === true ? '▾' : '▸')
						: h('span', { key: 'toggle', className: 'iui-tree-toggle is-leaf' }, '•'));
					row.push(h('input', {
						type: 'checkbox', key: 'check', className: 'iui-tree-check', checked: on, disabled: disabled,
						onChange: function () {
							var next = selected.slice();
							var at = next.indexOf(nodeId);
							if (at === -1) next.push(nodeId);
							else next.splice(at, 1);
							state.set(path, next);
						},
					}));
					row.push(h('span', { key: 'label', className: 'iui-tree-label' }, String(node.label === undefined ? nodeId : node.label)));
					return h('li', { key: nodeId },
						h('div', { className: 'iui-tree-row' + (on ? ' is-on' : '') }, row),
						children.length > 0 && isOpen === true ? branch(children, level + 1, prefix + nodeId + '/') : null);
				}));
			}

			return h('div', { className: 'iui-field', key: index },
				label.length > 0 ? h('span', { className: 'iui-label' }, label) : null,
				description ? h('span', { className: 'iui-hint' }, description) : null,
				h('div', { className: 'iui-tree' }, branch(nodes, 0, '')));
		}

		/* ---- progress ---- */

		function progressWidget(element, index, label, description) {
			var items = Array.isArray(element.items) ? element.items : [];
			var rows = [];
			for (var position = 0; position < items.length; position++) {
				var item = items[position];
				if (!isPlainObject(item)) continue;
				var max = typeof item.max === 'number' && item.max > 0 ? item.max : 100;
				var raw = typeof item.value === 'number' ? item.value : Number(item.value);
				if (isFinite(raw) === false) raw = 0;
				var percent = Math.max(0, Math.min(100, (raw / max) * 100));
				var tone = item.tone === 'ok' || item.tone === 'warn' || item.tone === 'error' ? ' is-' + item.tone : '';
				var unit = typeof item.unit === 'string' ? item.unit : '';
				rows.push(h('div', { className: 'iui-prog-row', key: position },
					h('div', { className: 'iui-prog-head' },
						h('span', {}, String(item.label === undefined ? '' : item.label)),
						h('span', { className: 'iui-prog-val' }, raw + unit + ' / ' + max + unit)),
					h('div', { className: 'iui-prog-bar' },
						h('div', { className: 'iui-prog-fill' + tone, style: { width: percent + '%' } }))));
			}
			return h('div', { className: 'iui-field', key: index },
				label.length > 0 ? h('span', { className: 'iui-label' }, label) : null,
				description ? h('span', { className: 'iui-hint' }, description) : null,
				h('div', { className: 'iui-prog' }, rows));
		}

		/* ---- tabs ---- */

		function tabsWidget(element, index, label, description, state, base) {
			var tabs = Array.isArray(element.tabs) ? element.tabs : [];
			if (tabs.length === 0) return null;
			var scope = typeof element.id === 'string' && element.id.length > 0 ? element.id : '';
			var active = atPath(state.values, ['__tab', scope]);
			var position = typeof active === 'number' && active >= 0 && active < tabs.length ? Math.floor(active) : 0;
			var bar = [];
			for (var tabIndex = 0; tabIndex < tabs.length; tabIndex++) {
				var tab = tabs[tabIndex];
				if (!isPlainObject(tab)) continue;
				var tabId = typeof tab.id === 'string' && tab.id.length > 0 ? tab.id : 'tab_' + tabIndex;
				bar.push(h('button', {
					type: 'button', key: tabId, className: 'iui-tab' + (tabIndex === position ? ' is-on' : ''),
					onClick: (function (target) {
						return function () { state.set(['__tab', scope], target); };
					})(tabIndex),
				}, String(tab.label === undefined ? tabId : tab.label)));
			}
			var current = isPlainObject(tabs[position]) ? tabs[position] : {};
			return h('div', { className: 'iui-field', key: index },
				label.length > 0 ? h('span', { className: 'iui-label' }, label) : null,
				description ? h('span', { className: 'iui-hint' }, description) : null,
				h('div', { className: 'iui-tabs' },
					h('div', { className: 'iui-tabbar' }, bar),
					h('div', { className: 'iui-tab-body' }, Array.isArray(current.elements) ? current.elements.map(function (child, childIndex) {
						return widget(child, childIndex, state, base);
					}) : null)));
		}

		function tableWidget(element, index, state, path) {
			var columns = Array.isArray(element.columns) ? element.columns.filter(isPlainObject) : [];
			var rows = Array.isArray(element.rows) ? element.rows : [];
			var mode = element.select === 'single' || element.select === 'multi' ? element.select : 'none';
			var keyName = typeof element.row_key === 'string' ? element.row_key : '';
			var chosen = mode === 'multi' ? (Array.isArray(atPath(state.values, path)) ? atPath(state.values, path) : []) : atPath(state.values, path);
			var disabled = state.busy === true || element.disabled === true;

			function rowIdentity(row, position) {
				if (keyName.length === 0) return position;
				if (isPlainObject(row)) return row[keyName] === undefined ? position : row[keyName];
				if (Array.isArray(row)) {
					for (var c = 0; c < columns.length; c++) if (columns[c].key === keyName) return row[c];
				}
				return position;
			}
			function cellAt(row, column, position) {
				if (isPlainObject(row)) return row[column.key];
				if (Array.isArray(row)) return row[position];
				return row;
			}
			function isChosen(identity) {
				if (mode === 'multi') return chosen.some(function (entry) { return String(entry) === String(identity); });
				return chosen !== null && chosen !== undefined && String(chosen) === String(identity);
			}
			function pick(identity) {
				if (disabled === true) return;
				if (mode === 'multi') {
					var next = chosen.filter(function (entry) { return String(entry) !== String(identity); });
					if (isChosen(identity) === false) next = chosen.concat([identity]);
					state.set(path, next);
					return;
				}
				state.set(path, isChosen(identity) ? null : identity);
			}

			var head = h('tr', null, mode === 'none' ? null : h('th', { key: '__pick', style: { width: '1.6em' } }, ''),
				columns.map(function (column, position) {
					var align = column.align === 'right' ? 'iui-td--num' : column.align === 'center' ? 'iui-td--mid' : '';
					return h('th', { key: position, className: align }, typeof column.label === 'string' ? column.label : String(column.key));
				}));

			var body = rows.map(function (row, position) {
				var identity = rowIdentity(row, position);
				var on = mode === 'none' ? false : isChosen(identity);
				return h('tr', {
					key: position,
					className: (mode === 'none' ? '' : 'iui-tr--pick') + (on ? ' is-on' : ''),
					onClick: mode === 'none' ? undefined : function () { pick(identity); },
				},
					mode === 'none' ? null : h('td', { key: '__pick' }, mode === 'multi'
						? h('input', { type: 'checkbox', className: 'iui-pick', checked: on, disabled: disabled, onChange: function () { pick(identity); } })
						: h('span', { className: 'iui-pick', style: { display: 'inline-block', borderRadius: '50%', border: '1px solid var(--iui-line)', background: on ? 'var(--iui-accent)' : 'transparent' } })),
					columns.map(function (column, position2) {
						var cell = cellAt(row, column, position2);
						var align = column.align === 'right' ? ' iui-td--num' : column.align === 'center' ? ' iui-td--mid' : '';
						var content = isPlainObject(cell) && typeof cell.href === 'string'
							? h('a', { className: 'iui-link', href: cell.href, target: '_blank', rel: 'noreferrer noopener' }, cellText(cell))
							: cellText(cell);
						return h('td', { key: position2, className: align.trim(), title: typeof cell === 'string' ? cell : undefined }, content);
					}));
			});

			return h('div', { className: 'iui-field', key: index },
				labelFor(element),
				element.description ? h('span', { className: 'iui-hint' }, String(element.description)) : null,
				h('div', { className: 'iui-table-wrap', style: typeof element.max_height === 'number' ? { maxHeight: element.max_height + 'px' } : undefined },
					h('table', { className: 'iui-table' }, h('thead', null, head), h('tbody', null, body))),
				mode === 'none' ? null : h('span', { className: 'iui-hint' }, mode === 'multi' ? 'Selected: ' + (chosen.length === 0 ? 'none' : chosen.join(', ')) : (isChosen(chosen) ? 'Selected: ' + String(chosen) : 'Nothing selected yet')));

			function labelFor(element2) {
				return typeof element2.label === 'string' && element2.label.length > 0 ? h('span', { className: 'iui-label' }, element2.label) : null;
			}
		}

		/* ------------------------------------------------------------ *
		 * wizard widget
		 * ------------------------------------------------------------ */

		function wizardWidget(element, index, state, base) {
			var steps = Array.isArray(element.steps) ? element.steps.filter(isPlainObject) : [];
			if (steps.length === 0) return null;
			var id = typeof element.id === 'string' ? element.id : '';
			var current = Number(atPath(state.values, ['__step', id]));
			if (isFinite(current) === false || current < 0) current = 0;
			if (current > steps.length - 1) current = steps.length - 1;
			var disabled = state.busy === true;
			var step = steps[current];
			var stepKey = typeof step.id === 'string' && step.id.length > 0 ? step.id : 'step_' + current;
			var nested = Array.isArray(step.elements) ? step.elements : [];

			var crumbs = steps.map(function (entry, position) {
				var title = typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : 'Step ' + (position + 1);
				var stateClass = position === current ? ' is-on' : position < current ? ' is-done' : '';
				return h('button', {
					type: 'button',
					key: position,
					className: 'iui-step' + stateClass,
					disabled: disabled,
					style: { background: 'transparent', border: 0, padding: '2px 4px', cursor: 'pointer', font: 'inherit' },
					onClick: function () { state.set(['__step', id], position); },
				},
					h('span', { className: 'iui-step-no' }, position < current ? '✓' : String(position + 1)),
					h('span', null, title));
			});

			var nav = h('div', { className: 'iui-nav' },
				h('button', {
					type: 'button',
					className: 'iui-btn iui-btn--ghost',
					disabled: disabled || current === 0,
					onClick: function () { state.set(['__step', id], Math.max(0, current - 1)); },
				}, 'Back'),
				current < steps.length - 1
					? h('button', {
						type: 'button',
						className: 'iui-btn',
						disabled: disabled,
						onClick: function () { state.set(['__step', id], Math.min(steps.length - 1, current + 1)); },
					}, 'Next')
					: h('button', {
						type: 'button',
						className: 'iui-btn iui-btn--primary',
						disabled: disabled,
						onClick: function () { state.submit('submit', ''); },
					}, typeof element.finish_label === 'string' && element.finish_label.length > 0 ? element.finish_label : 'Finish'),
				h('span', { className: 'iui-hint' }, (current + 1) + ' / ' + steps.length));

			return h('div', { className: 'iui-wizard', key: index },
				typeof element.label === 'string' && element.label.length > 0 ? h('span', { className: 'iui-label' }, element.label) : null,
				h('div', { className: 'iui-steps' }, crumbs),
				typeof step.description === 'string' && step.description.length > 0 ? h('span', { className: 'iui-hint' }, step.description) : null,
				h('div', { className: 'iui-step-body' }, nested.map(function (child, position) {
					if (!isPlainObject(child)) return null;
					try {
						return widget(child, position, state, base.concat([stepKey]));
					} catch (error) {
						return h('div', { className: 'iui-note', key: position }, 'widget error: ' + String((error && error.message) || error));
					}
				})),
				nav);
		}

		/* ------------------------------------------------------------ *
		 * chart widget (dependency-free inline SVG)
		 * ------------------------------------------------------------ */

		function chartPoints(element) {
			var series = Array.isArray(element.series) ? element.series : [];
			return series.map(function (entry, position) {
				if (isPlainObject(entry)) {
					return { label: String(entry.label === undefined ? position + 1 : entry.label), value: Number(entry.value) || 0, color: typeof entry.color === 'string' ? entry.color : PALETTE[position % PALETTE.length] };
				}
				return { label: String(position + 1), value: Number(entry) || 0, color: PALETTE[position % PALETTE.length] };
			});
		}

		function arcPath(cx, cy, outer, inner, start, end) {
			var large = end - start > Math.PI ? 1 : 0;
			var x1 = cx + outer * Math.cos(start), y1 = cy + outer * Math.sin(start);
			var x2 = cx + outer * Math.cos(end), y2 = cy + outer * Math.sin(end);
			var x3 = cx + inner * Math.cos(end), y3 = cy + inner * Math.sin(end);
			var x4 = cx + inner * Math.cos(start), y4 = cy + inner * Math.sin(start);
			return ['M', x1, y1, 'A', outer, outer, 0, large, 1, x2, y2, 'L', x3, y3, 'A', inner, inner, 0, large, 0, x4, y4, 'Z'].join(' ');
		}

		function chartWidget(element, index) {
			var points = chartPoints(element);
			if (points.length === 0) return null;
			var kind = element.chart === 'line' || element.chart === 'pie' || element.chart === 'donut' ? element.chart : 'bar';
			var unit = typeof element.unit === 'string' ? element.unit : '';
			var label = typeof element.label === 'string' && element.label.length > 0 ? h('span', { className: 'iui-label' }, element.label) : null;
			var legend = h('div', { className: 'iui-legend' }, points.map(function (point, position) {
				return h('span', { className: 'iui-legend-item', key: position },
					h('span', { className: 'iui-swatch', style: { background: point.color } }),
					h('span', null, point.label), ' ',
					h('b', null, String(Math.round(point.value * 100) / 100) + unit));
			}));
			var body;

			if (kind === 'pie' || kind === 'donut') {
				var total = points.reduce(function (sum, point) { return sum + Math.max(0, point.value); }, 0);
				var size = typeof element.height === 'number' && element.height > 0 ? element.height : 150;
				var cx = size / 2, cy = size / 2;
				var outer = size / 2 - 6;
				var inner = kind === 'donut' ? outer * 0.58 : 0;
				var slices = [];
				var angle = -Math.PI / 2;
				if (total <= 0) {
					slices.push(h('circle', { key: 'empty', cx: cx, cy: cy, r: outer, fill: 'none', stroke: 'var(--iui-line)', strokeWidth: 2 }));
				} else if (points.length === 1 || points[0].value / total >= 0.999) {
					slices.push(kind === 'donut'
						? h('circle', { key: 0, cx: cx, cy: cy, r: (outer + inner) / 2, fill: 'none', stroke: points[0].color, strokeWidth: outer - inner },
							h('title', null, points[0].label + ': 100%'))
						: h('circle', { key: 0, cx: cx, cy: cy, r: outer, fill: points[0].color }, h('title', null, points[0].label + ': 100%')));
				} else {
					points.forEach(function (point, position) {
						var share = Math.max(0, point.value) / total;
						var end = angle + share * Math.PI * 2;
						var path = kind === 'donut' ? arcPath(cx, cy, outer, inner, angle, end) : arcPath(cx, cy, outer, 0, angle, end);
						slices.push(h('path', { key: position, d: path, fill: point.color, stroke: 'none' },
							h('title', null, point.label + ': ' + Math.round(share * 1000) / 10 + '%')));
						angle = end;
					});
				}
				body = h('svg', { className: 'iui-chart', viewBox: '0 0 ' + size + ' ' + size, style: { maxHeight: size + 'px' }, role: 'img' }, slices);
			} else if (kind === 'line') {
				var width = 320, height = typeof element.height === 'number' && element.height > 0 ? element.height : 130;
				var max = points.reduce(function (top, point) { return Math.max(top, point.value); }, 0);
				var min = points.reduce(function (low, point) { return Math.min(low, point.value); }, 0);
				var span = max - min === 0 ? 1 : max - min;
				var series = points.length > 0 ? points[0].color : 'var(--iui-accent)';
				var stepX = points.length > 1 ? (width - 44) / (points.length - 1) : 0;
				var coords = points.map(function (point, position) {
					return { x: 30 + position * stepX, y: 14 + (1 - (point.value - min) / span) * (height - 34), point: point };
				});
				var line = coords.map(function (entry) { return entry.x + ',' + entry.y; }).join(' ');
				var area = 'M ' + coords[0].x + ' ' + (height - 18) + ' L ' + coords.map(function (entry) { return entry.x + ' ' + entry.y; }).join(' L ') + ' L ' + coords[coords.length - 1].x + ' ' + (height - 18) + ' Z';
				body = h('svg', { className: 'iui-chart', viewBox: '0 0 ' + width + ' ' + height, style: { maxHeight: height + 'px' }, role: 'img' },
					h('line', { x1: 30, y1: height - 18, x2: width - 6, y2: height - 18, stroke: 'var(--iui-line)', strokeWidth: 1 }),
					points.length > 1 ? h('path', { d: area, fill: series, opacity: 0.14 }) : null,
					h('polyline', { points: line, fill: 'none', stroke: series, strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' }),
					coords.map(function (entry, position) {
						return h('g', { key: position },
							h('circle', { cx: entry.x, cy: entry.y, r: 3, fill: series }, h('title', null, entry.point.label + ': ' + entry.point.value + unit)),
							h('text', { x: entry.x, y: height - 6, textAnchor: 'middle' }, entry.point.label));
					}),
					h('text', { x: 2, y: 14 }, String(max) + unit));
			} else {
				var barWidth = 320, barHeight = typeof element.height === 'number' && element.height > 0 ? element.height : 130;
				var top = points.reduce(function (best, point) { return Math.max(best, point.value); }, 0);
				var scale = top <= 0 ? 1 : top;
				var slot = (barWidth - 34) / points.length;
				var width = Math.min(38, Math.max(6, slot - 8));
				body = h('svg', { className: 'iui-chart', viewBox: '0 0 ' + barWidth + ' ' + barHeight, style: { maxHeight: barHeight + 'px' }, role: 'img' },
					h('line', { x1: 26, y1: barHeight - 18, x2: barWidth - 4, y2: barHeight - 18, stroke: 'var(--iui-line)', strokeWidth: 1 }),
					points.map(function (point, position) {
						var ratio = Math.max(0, point.value) / scale;
						var barHeightPx = Math.max(1, ratio * (barHeight - 34));
						var x = 26 + position * slot + (slot - width) / 2;
						return h('g', { key: position },
							h('rect', { x: x, y: barHeight - 18 - barHeightPx, width: width, height: barHeightPx, rx: 3, fill: point.color },
								h('title', null, point.label + ': ' + point.value + unit)),
							h('text', { x: x + width / 2, y: barHeight - 22 - barHeightPx, textAnchor: 'middle', style: { fontWeight: 600 } }, String(Math.round(point.value * 100) / 100)),
							h('text', { x: x + width / 2, y: barHeight - 6, textAnchor: 'middle' }, point.label.length > 8 ? point.label.slice(0, 8) + '…' : point.label));
					}));
			}

			return h('div', { className: 'iui-field', key: index },
				label,
				typeof element.description === 'string' && element.description.length > 0 ? h('span', { className: 'iui-hint' }, element.description) : null,
				body,
				legend);
		}

		/* ------------------------------------------------------------ *
		 * the view
		 * ------------------------------------------------------------ */

		// Which scheme the host page is in. The panel declares color-scheme:light dark;
		// which makes native controls follow the OS instead of DSH — wrong whenever the two
		// disagree. Probe one themed token and stamp the answer onto the panel element.
		var schemeProbe = null;
		var schemeKnown = false;
		function detectedScheme() {
			if (schemeKnown) return schemeProbe;
			schemeKnown = true;
			try {
				var probe = document.createElement('span');
				probe.setAttribute('style', 'position:absolute;left:-9999px;top:0;color:var(--dsw-alias-label-primary,#000)');
				document.body.appendChild(probe);
				var rgb = window.getComputedStyle(probe).color;
				document.body.removeChild(probe);
				var match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
				if (match !== null) {
					var luma = (0.299 * Number(match[1]) + 0.587 * Number(match[2]) + 0.114 * Number(match[3])) / 255;
					schemeProbe = luma > 0.5 ? 'light' : 'dark';
				}
			} catch (error) { /* leave it to the browser */ }
			return schemeProbe;
		}
		function panelClass() {
			var scheme = detectedScheme();
			return scheme === null ? 'iui-panel' : 'iui-panel is-' + scheme;
		}

		function Panel(props) {
			var callId = props !== null && props !== undefined && props.callId !== undefined ? String(props.callId) : '';
			var phase = props !== null && props !== undefined && typeof props.phase === 'string' ? props.phase : 'preparing';

			var panelState = React.useState(null);
			var panel = panelState[0];
			var setPanel = panelState[1];
			var valueState = React.useState({});
			var values = valueState[0];
			var setValues = valueState[1];
			var refState = React.useState({ current: values });
			var valuesRef = refState[0];
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var noteState = React.useState('');
			var note = noteState[0];
			var setNote = noteState[1];

			React.useEffect(function () {
				valuesRef.current = values;
				/* Mirror every edit into the draft, so leaving the page — switching
				 * sessions, or the shell reloading itself — does not cost the user
				 * what they already typed. Untouched panels are not persisted (the
				 * seed alone is not user work), and an answered panel clears it. */
				if (valuesRef.touched === true && panelState[0] !== null && panelState[0].status === 'pending') writeDraft(callId, values);
			}, [values]);

			// While a panel is waiting for an answer, hold off the bundle watcher:
			// a reload would throw away whatever is half-filled in.
			React.useEffect(function () {
				if (panelState[0] === null || panelState[0].status !== 'pending') return undefined;
				openPanels += 1;
				return function () { openPanels -= 1; };
			}, [panel]);

			React.useEffect(function () {
				if (callId.length === 0) return undefined;
				var stopped = false;
				var attempt = 0;
				var timer = null;
				var load = function () {
					fetchPanel(callId).then(function (data) {
						if (stopped === true) return;
						if (!isPlainObject(data) || data.status === 'unknown' || data.status === undefined) {
							attempt += 1;
							if (attempt <= POLL_ATTEMPTS) timer = window.setTimeout(load, POLL_DELAY);
							else setPanel({ status: 'error', message: 'The panel could not be found.' });
							return;
						}
						if (data.status === 'pending' && data.spec !== undefined && data.spec !== null) {
							/* Seed once. A re-poll (phase change, retry) must never
							 * overwrite what the user has already typed. */
							if (Object.keys(valuesRef.current).length === 0) {
								var seeded = seedWithDraft(data.spec, callId);
								valuesRef.current = seeded;
								setValues(seeded);
							}
						}
						/* Answered elsewhere (another tab, another window): the draft
						 * has done its job and must not come back. */
						if (data.status === 'answered' || data.status === 'display') clearDraft(callId);
						setPanel(data);
					}).catch(function (error) {
						if (stopped === true) return;
						attempt += 1;
						if (attempt <= POLL_ATTEMPTS) timer = window.setTimeout(load, POLL_DELAY);
						else setPanel({ status: 'error', message: String((error && error.message) || error) });
					});
				};
				load();
				return function () {
					stopped = true;
					if (timer !== null) window.clearTimeout(timer);
				};
			}, [callId, phase]);

			if (panel === null) {
				return h('div', { className: panelClass() },
					h('div', { className: 'iui-eyebrow' }, h('span', { className: 'iui-dot' }), 'Interactive panel'),
					h('div', { className: 'iui-muted' }, 'Opening…'));
			}

			if (panel.status === 'error') {
				return h('div', { className: panelClass() },
					h('div', { className: 'iui-eyebrow' }, h('span', { className: 'iui-dot' }), 'Interactive panel'),
					h('div', { className: 'iui-note' }, panel.message || 'Unavailable.'));
			}

			var spec = isPlainObject(panel.spec) ? panel.spec : {};
			var elements = Array.isArray(spec.elements) ? spec.elements : [];

			var submit = function (action, button) {
				if (busy === true) return;
				if (action === 'submit') {
					var missingFields = collectMissing(elements, valuesRef.current, [], []);
					if (missingFields.length > 0) {
						setValues(withPath(valuesRef.current, ['__missing'], missingFields.map(function (entry) { return entry.key; })));
						setNote('还有必填项没填：' + missingFields.map(function (entry) { return entry.label; }).join('、'));
						return;
					}
				}
				setBusy(true);
				setNote('');
				var payload = publicValues(valuesRef.current);
				submitPanel(callId, action, payload, button).then(function (data) {
					clearDraft(callId);
					if (isPlainObject(data) && data.values !== undefined) {
						setPanel({ status: 'answered', spec: spec, action: data.action, values: data.values, button: data.button });
					} else {
						setPanel({ status: 'answered', spec: spec, action: action, values: payload, button: button });
					}
					setBusy(false);
				}).catch(function (error) {
					setNote(String((error && error.message) || error));
					setBusy(false);
				});
			};

			var setPath = function (path, next) {
				valuesRef.touched = true;
				setValues(function (previous) {
					var copy = withPath(previous, path, next);
					/* Editing a field clears the "required and missing" marks. */
					if (Array.isArray(copy.__missing)) {
						copy = shallowCopy(copy);
						delete copy.__missing;
					}
					valuesRef.current = copy;
					return copy;
				});
			};

			var head = h('div', { className: 'iui-head' },
				h('div', { className: 'iui-eyebrow' },
					h('span', { className: 'iui-dot' }),
					'Interactive panel',
					h('span', { className: 'iui-ver', title: '浏览器里正在运行的前端版本' }, 'v' + VERSION)),
				typeof spec.title === 'string' && spec.title.length > 0 ? h('div', { className: 'iui-title' }, spec.title) : null,
				typeof spec.subtitle === 'string' && spec.subtitle.length > 0 ? h('div', { className: 'iui-subtitle' }, spec.subtitle) : null);

			if (panel.status === 'answered') {
				return h('div', { className: panelClass() }, head,
					answerSummary(spec, panel.action, isPlainObject(panel.values) ? panel.values : {}, panel.button));
			}

			var state = { values: values, busy: busy, set: setPath, submit: submit, callId: callId, setBusy: setBusy, setNote: setNote };

			return h('div', { className: panelClass() }, head,
				h('div', { className: 'iui-body' }, elements.map(function (element, index) {
					if (!isPlainObject(element)) return null;
					try {
						return widget(element, index, state, []);
					} catch (error) {
						return h('div', { className: 'iui-note', key: index }, 'widget error: ' + String((error && error.message) || error));
					}
				})),
				spec.readonly === true
					? h('div', { className: 'iui-hint' }, note.length > 0 ? note : '只读面板 · 无需作答')
					: h('div', { className: 'iui-foot' },
						/* The note box sits right above this line (the host always appends
						 * it last), so "here" in the wording points at something the user
						 * can actually see. Full width keeps it off the button row. */
						typeof spec.note_hint === 'string' && spec.note_hint.length > 0
							? h('p', { className: 'iui-foot-hint' }, spec.note_hint)
							: null,
						h('button', {
							type: 'button',
							className: 'iui-btn iui-btn--primary',
							disabled: busy === true,
							onClick: function () { submit('submit', ''); },
						}, typeof spec.submit_label === 'string' && spec.submit_label.length > 0 ? spec.submit_label : 'Submit'),
						spec.allow_cancel === true
							? h('button', {
								type: 'button',
								className: 'iui-btn iui-btn--ghost',
								disabled: busy === true,
								onClick: function () { submit('cancel', ''); },
							}, typeof spec.cancel_label === 'string' && spec.cancel_label.length > 0 ? spec.cancel_label : 'Cancel')
							: null,
						h('button', {
							type: 'button',
							className: 'iui-btn iui-btn--ghost iui-btn--icon',
							title: '重新发布前端并刷新界面',
							disabled: busy === true,
							onClick: reloadUi,
						}, '⟳'),
						note.length > 0 ? h('span', { className: 'iui-note' }, note) : null));
		}

		/* ------------------------------------------------------------ *
		 * plugin
		 * ------------------------------------------------------------ */

		/**
		 * The composer-side reload affordance: republish this package's client
		 * bundle, then reload the page so the new revision boots. Registered into
		 * `conversation.input.right`, so it is there whenever a panel is not.
		 */
		function ReloadButton() {
			return h('button', {
				type: 'button',
				className: 'iui-reload',
				title: '刷新界面（重新发布插件前端）',
				'aria-label': '刷新界面',
				onClick: reloadUi,
			}, '⟳');
		}

		function apply(ctx) {
			clientCtx = ctx;
			try {
				ensureStyles();
			} catch (error) {
				console.warn('[' + NS + '] styles failed', error);
			}
			ctx.inject(['slots'], function (slotsCtx) {
				// All four of these tools leave a panel record behind, so the same
				// view renders them. `interactive_ui_history` leaves a read-only
				// snapshot of the answers it found, so it is wired last: the
				// self-test renders `registrations[0]`, which stays the main panel.
				var wired = [TOOL_NAME, TEMPLATE_TOOL_NAME, GALLERY_TOOL_NAME, HISTORY_TOOL_NAME];
				for (var index = 0; index < wired.length; index++) {
					(function (toolName) {
						try {
							slotsCtx.slots.inject('tool.call.toolview', function () {
								try {
									return slotsCtx.slots.register({ name: 'tool.call.toolview', key: toolName }, Panel);
								} catch (error) {
									console.warn('[' + NS + '] toolview registration failed for ' + toolName, error);
									return function () {};
								}
							});
						} catch (error) {
							console.warn('[' + NS + '] slot injection failed for ' + toolName, error);
						}
					})(wired[index]);
				}
				// An always-available "reload the shell" affordance next to the
				// composer, so a client-side change can be picked up without
				// restarting DSH (the tool cards may not be on screen then).
				try {
					slotsCtx.slots.inject('conversation.input.right', function () {
						try {
							return slotsCtx.slots.register({ name: 'conversation.input.right', id: 'intelligent-ui-reload', order: 40 }, ReloadButton);
						} catch (error) {
							console.warn('[' + NS + '] composer button registration failed', error);
							return function () {};
						}
					});
				} catch (error) {
					console.warn('[' + NS + '] composer slot injection failed', error);
				}
			});
			// Watch for a republished bundle: the host can publish a new revision
			// (POST /refresh) but nothing tells a page that is already running.
			try {
				var stopWatch = watchBundle();
				if (typeof ctx.effect === 'function') {
					ctx.effect(function () { return stopWatch; }, NS + ': bundle watch');
				}
			} catch (error) {
				console.warn('[' + NS + '] bundle watch failed', error);
			}
		}

		module.exports.NS = NS;
		module.exports.inject = [];
		module.exports.apply = apply;
		/* Test-only surface: lets test/client.selftest.mjs exercise the pure
		 * helpers without a DOM. Never read by DSH. */
		module.exports.__selftest = {
			isBlank: isBlank,
			collectMissing: collectMissing,
			panelClass: panelClass,
			resetSchemeProbe: function () { schemeKnown = false; schemeProbe = null },
			requiredMark: requiredMark,
			fieldCounter: fieldCounter,
			initialValues: initialValues,
			seedWithDraft: seedWithDraft,
			mergeValues: mergeValues,
			readDraft: readDraft,
			writeDraft: writeDraft,
			clearDraft: clearDraft,
			stripMissing: stripMissing,
			DRAFT_MAX: DRAFT_MAX,
			DRAFT_MAX_CHARS: DRAFT_MAX_CHARS,
			widget: widget,
			withPath: withPath,
			atPath: atPath,
			publicValues: publicValues,
			reloadUi: reloadUi,
			ReloadButton: ReloadButton,
			VERSION: VERSION,
			publishedRev: publishedRev,
			watchBundle: watchBundle,
			chartWidget: chartWidget,
			tableWidget: tableWidget,
			wizardWidget: wizardWidget,
			markdownBlocks: markdownBlocks,
			uploadWidget: uploadWidget,
			inlineMd: inlineMd,
			answerSummary: answerSummary,
			answerRows: answerRows,
			valueNodes: valueNodes,
			fieldAsElement: fieldAsElement,
			lookupLabel: lookupLabel,
			findElement: findElement,
			diffRows: diffRows,
			trimContext: trimContext,
			diffWidget: diffWidget,
			timelineWidget: timelineWidget,
			treeWidget: treeWidget,
			treeCheckedIds: treeCheckedIds,
			progressWidget: progressWidget,
			tabsWidget: tabsWidget,
			css: CSS,
		};
		return module.exports;
	},
});
