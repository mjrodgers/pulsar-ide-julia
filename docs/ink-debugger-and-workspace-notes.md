# Notes on Ink's debugger and workspace panes (for a future port)

Source read: `atom-ink` 0.12.6 (MIT) and `julia-client`'s `lib/runtime/debugger.js`. This records what the old code
needs, so a rewrite does not have to rediscover it. Status in `pulsar-ide-julia`: the workspace pane (fed by DAP
`scopes`/`variables`), breakpoints with gutter dots, the current-line marker, stepping and an output pane are
implemented in `lib/dap`, `lib/workspace` and `lib/debug` (no etch). Not done yet: the debugger pane's stack/breakpoint
list, function breakpoints, conditions UI, compiled mode, step-to-line.

## Size and dependencies

Ink is about 5,300 lines in total. The parts relevant here are small:

| Piece | Files | Lines | Uses etch? |
| --- | --- | --- | --- |
| Debugger pane (UI) | `lib/debugger/debugger-pane.js` | 385 | yes (JSX) |
| Breakpoints (gutter markers + state) | `lib/debugger/breakpoints.js` | 440 | only for the gutter dot |
| Stepper (current-line overlay) | `lib/debugger/stepper.coffee`, `stepper-view.coffee` | 220 | no, plain DOM |
| Step/continue toolbar | `lib/debugger/toolbar.js` | 58 | no, plain DOM |
| Workspace pane | `lib/workspace/workspace.js` | 117 | yes (JSX) |
| Shared helpers | `lib/util/{etch,pane-item,opener,views,basic-modal}.js` | ~700 | etch.js is the wrapper |
| Styles | `styles/debugger.less`, `workspace.less` | 346 | n/a |

19 of Ink's files import etch, but the wrapper in `util/etch.js` only provides `Etch` (a base class), `Tip`
(tooltip around a child), `Button`, `Icon`, `Toolbar`, `toView` (embed a raw DOM element) and `Progress`. All of it is
simple enough to replace with a tiny `h(tag, props, children)` helper and explicit updates, so no dependency is needed.
Other Atom API surface used: `atom.workspace` (open/observe editors, panes), `atom.views.addViewProvider`,
`atom.deserializers`, `atom.tooltips`, `atom.commands`, editor gutters, markers and decorations (`line`,
`line-number`, `overlay`, `gutter` types), and mini `TextEditor`s for input fields. `PaneItem` (209 lines) is the
pane-registration glue: `atom://ink-<name>/<id>` URIs, opener, deserializer, title, default location.

## What the debugger pane needs

`new DebuggerPane(stepper, breakpointManager, buttons, startButtons)`

* `buttons` / `startButtons`: `{icon|svg, text, tooltip, command, color}`; clicking dispatches the command.
* **stepper** (`Stepper`): emits `step` with `{file, line, text, info}` where
  `info = { moreinfo: {code, firstline, currentline}, stack: [{level, name, file, line, shortpath}], level }`.
  The pane shows `moreinfo.code` in a read-only editor with the cursor on `currentline - firstline`, lists the
  stack, and highlights `level`. `Stepper.step(file, line0, text, info)` also opens the file (a "pending" tab by
  default), moves an overlay marker to the line and decorates it with `ink-stepper-line`.
* **breakpointManager** (`BreakpointManager`):
  * state: `compiledMode`, `onException`, `onUncaught`, `getFileBreakpoints()`, `getFuncBreakpoints()`
  * calls the pane makes: `onUpdate(cb)`, `toggleCompiled()`, `toggleException()`, `toggleUncaughtException()`,
    `refresh()`, `clear()`, `toggleAllActive(state)`, `toggleActive(bp)`, `remove(bp)`, `addArgsBreakpoint(text)`,
    `addCondition(bp, text)`, `setLevel(level)`
  * a breakpoint: `{typ: 'source'|'func', file, line (1-based), shortpath, description, condition, isactive, id}`
  * **source** breakpoints live only in the editor (gutter dots; clicking the gutter toggles; markers track edits).
    Everything else (function breakpoints, exception flags, compiled mode, stack level) is a round trip: each
    callback returns `Promise<{response, error}>` and `response` is the new list of function breakpoints.

### Existing bugs worth not copying

* The pane's two "Break on ..." checkboxes both bind to `breakpointManager.breakOnException`, which the manager
  never sets (it sets `onException` and `onUncaught`). They never reflect real state.
* `debugger-pane.js` imports `makeicon` (the helper is `makeIcon`); it is unused there.
* `Stepper.setViewText` etc. rely on `process.nextTick` / `requestAnimationFrame` polling loops (e.g. waiting for the
  gutter element); these are probably avoidable with the current gutter API, but I have not tried.

## What `julia-client` sent to Julia (the protocol a DAP adapter would replace)

Editor to Julia (`client.import(name)`): `debugfile(module, code, path, shouldStep[, line])`, `continue`, `nextline`,
`stepexpr`, `stepin`, `finish` (step out), `toline(line)` (step to selected line), `stop`, `toggleBP(bp)`,
`clearbps`, `getBreakpoints`, `addArgs(text)` (function breakpoint from a signature), `toggleActiveBP`,
`toggleAllActiveBP`, `addConditionById`, `toggleException`, `toggleUncaught`, `toggleCompiled`, `setStackLevel(level)`.

Julia to editor (`client.handle`): `debugmode(bool)`, `stepto(file, line, text, moreinfo)`, `working`, `doneWorking`,
`getFileBreakpoints()` (Julia asks the editor for the active file breakpoints and conditions).

### Rough mapping onto the Debug Adapter Protocol

Unverified against DebugAdapter.jl, whose documentation does not list its supported capabilities.

| Ink / Juno | DAP |
| --- | --- |
| `debugfile` | `launch`, or `attach` plus `DebugAdapter.debug_code(session, mod, code, path)` |
| `stepto`, stack, `moreinfo` | `stopped` event, then `stackTrace` (+ `source` for the code shown) |
| `setStackLevel` | select a frame id; later `scopes` / `variables` / `evaluate` use it |
| `continue`, `nextline`, `stepin`, `finish` | `continue`, `next`, `stepIn`, `stepOut` |
| `stepexpr` | `stepIn`/`next` with a finer `granularity`, if the adapter supports it |
| `toline` | no direct request; a temporary breakpoint plus `continue`, or `gotoTargets`/`goto` if supported |
| source breakpoints | `setBreakpoints` (the full list per file is sent each time; the editor owns the state) |
| function breakpoints (`addArgs`) | `setFunctionBreakpoints` |
| exception / uncaught | `setExceptionBreakpoints` with the adapter's filter ids |
| compiled mode | adapter-specific launch/attach argument |
| `stop` | `terminate` / `disconnect` |
| workspace pane while stepping | `scopes` + `variables` for the selected frame |

DAP inverts one thing: breakpoints are pushed from the editor, so `getFileBreakpoints` disappears.

## The workspace pane

`Workspace` is a filterable table. Data in: `setItems([{context, items: [{name, type, nativetype, icon, value, onClick}]}])`.
`value` is a DOM element or text; a mini editor filters with `fuzzaldrin-plus` on `name`; two buttons call
`refresh()` and `refreshModule()` (both are no-ops until a backend overrides them). Julia filled it with the names
and summarized values of a module (`workspace.update()` was also called on every debugger step). It has no etch
dependency worth keeping: one header, one table, one filter field.

## Suggested shape of a port

1. Plain DOM with a ~50-line `h()` helper; keep `PaneItem` (it is just URI/deserializer plumbing) and drop etch.
2. Keep the UI-facing interfaces above (stepper events, breakpoint-manager state) so the pane has no knowledge of
   Julia, and put a DAP-backed implementation behind them.
3. Variables for the selected frame can feed the workspace pane; that makes the two panes share one data source.
4. Decide first whether DebugAdapter.jl is healthy enough on current Julia versions; its recent crash reports on
   VS Code suggest checking before building on it.
