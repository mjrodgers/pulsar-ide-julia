# pulsar-ide-julia

This is 1000% vibe coded, I know enough to point in the right direction and maintain this package,
but frankly my knowledge of javascript is super limited and I just wanted to get a Julia language server up and running.
Please report issues, I'm happy to work to improve this and keep it up and running.

Julia language support for Pulsar via [JETLS](https://github.com/aviatesk/JETLS.jl),
using `@savetheclocktower/atom-languageclient`.

## Requirements

* **A Julia grammar.** Install [language-julia-redux](https://github.com/mjrodgers/pulsar-language-julia), the
  Tree-sitter grammar written alongside this package: highlighting, indentation, folding, docstrings as Markdown and
  snippets. This package starts for any file whose grammar is `source.julia`, so the old `language-julia` works too;
  if both are installed, disable `language-julia`.
* **JETLS**, and Julia 1.12 or later to run it: see [Installing JETLS](#installing-jetls).

## Go to Symbol

Pulsar's built-in `symbols-view` package lists the symbols in a file, and this package supplies them from JETLS:

* **Symbols View: Toggle File Symbols** (<kbd>ctrl-r</kbd>, <kbd>cmd-r</kbd> on macOS): the functions, types, macros
  and so on in the current file; type to filter, Enter to jump.
* **Symbols View: Toggle Project Symbols** (<kbd>ctrl-shift-r</kbd>, <kbd>cmd-shift-r</kbd>): the same across the
  project.
* **Symbols View: Go To Declaration** (<kbd>ctrl-alt-down</kbd>, <kbd>cmd-alt-down</kbd>) jumps to the definition of
  the name under the cursor, and **Return From Declaration** (<kbd>ctrl-alt-up</kbd>, <kbd>cmd-alt-up</kbd>) goes back.

Functions are listed with their argument list beside the name, so the methods of a function can be told apart; the
**Outline and Go to Symbol** settings control this for both the outline and this list. While JETLS is running it is
the only source of symbols. Before it has started, or if it is not running, the symbols
come from the grammar instead. **Symbols View: Show Active Providers** shows which sources are available. (The
community `symbols-view-redux` package was the prototype of today's built-in `symbols-view`; it is not needed.)

## Develop

    npm install            # or `ppm install`
    ppm link               # make Pulsar see the package (once)
    pulsar --test spec     # run the specs (Linux CI: wrap in xvfb-run)
                           # specs are self-contained: a stub grammar fixture stands in for language-julia
    JETLS_INTEGRATION=1 pulsar --test spec   # also test against a real jetls

## Settings and JETLS configuration

The settings come in five groups: **Language server (JETLS)**, **Outline and Go to Symbol**, **REPL**, **Tests** and
**Debugger**. Settings saved
by earlier versions under the old, ungrouped names are moved into their groups the first time the package starts.

Configuration reaches JETLS three ways (highest priority first):

1. `.JETLSConfig.toml` in the project root (read by JETLS itself; per root, committable).
2. The **Language server** group: the package opts in to the fork's built-in `workspace/configuration` support
   (`supportsWorkspaceConfiguration`, `getRootConfigurationKey`, `mapConfigurationObject`), so JETLS's request for
   the `jetls` section is answered from this group, and only this group: changing a REPL or debugger setting does
   not reach JETLS. The instantiate, analysis delay and formatter settings are sent only when they differ from
   JETLS's defaults; **Extra settings (JSON)** is merged on top. These apply live.
3. JETLS defaults.

**Initialization options (JSON)** and the launch settings (path, Julia, threads, environment for scripts, connection,
extra Julia flags) are static: changing them offers a server restart.

## Choosing the Julia version

`jetls` is a Pkg app: it runs with the Julia that installed it. To run it with another Julia
(1.12+), set **Language server → Julia executable**; the package passes it as `JULIA_APPS_JULIA_CMD`.

## Several project folders

The language client starts one JETLS server per project folder, when you first open a Julia file in it, and stops it
when the folder's last Julia file closes. JETLS cannot serve several folders from one process, and each server loads
its packages' dependencies itself, so a window with many package checkouts can hold several large processes.

* **Pulsar Ide Julia: Show Language Servers** opens a pane listing every project folder with its server's state, process
  id, memory (including processes the server started) and number of open Julia files, with buttons to restart, stop or
  start each server, and to restart them all. It refreshes every few seconds while open.
* **Pulsar Ide Julia: Restart Language Server For Project Folder** restarts only the server of the active file's folder.
  A server loads the packages a project depends on once, so after editing a dependency checkout (another of your
  folders, `dev`ed into this project's environment), restart the dependent project's server to analyze against the
  new code.

Each folder is analyzed in the environment of its own `Project.toml`. To have go-to-definition land in, and diagnostics
reflect, your local checkouts of dependencies, `Pkg.develop` them into that environment.

## Installing JETLS

`jetls` is a Julia "app": a small launcher in `~/.julia/bin` that runs JETLS with the Julia that installed it.

    julia -e 'using Pkg; Pkg.Apps.add(; url="https://github.com/aviatesk/JETLS.jl", rev="release")'
    ~/.julia/bin/jetls --version

Needs Julia 1.12+ (1.12.2+ recommended). This package also looks in `~/.julia/bin` itself, so `PATH` need not be set.

## Running this package's specs

`package.json` sets `"atomTestRunner": "runners/jasmine2-test-runner"`, which selects the Jasmine 2
runner that ships inside Pulsar (resolved against Pulsar's own `spec/` directory). The specs use the
Jasmine 2 API (`spyOn(...).and.callFake`, `async`/`await`, no `waitsFor`/`runs`);
`spec/aaa-runner-spec.js` fails with a clear message if an older runner is active.

Spec windows mock timers and ignore per-spec timeout arguments, so specs await promises instead of
polling, and `spec/helpers/timeout.js` raises `jasmine.DEFAULT_TIMEOUT_INTERVAL` for a whole `describe`.

Debug activation problems with `PULSAR_IDE_JULIA_SPEC_TRACE=1 pulsar --test --timeout 60 spec/fork-api-spec.js`.

## Formatting (Runic)

JETLS formats with `runic` by default and finds it on the PATH it is given. This package appends
`<julia depot>/bin` (where `Pkg.Apps` installs `jetls`, `runic`, `jlfmt`) to the PATH of the server
process, so it works even when Pulsar was started from the Dock and has no shell PATH. Install it with
`julia -e 'using Pkg; Pkg.Apps.add("Runic")'`. The package provides range, whole-file and on-save formatting to
`pulsar-code-format`; formatting on save is switched on in that package's settings (**Format On Save**). To use another formatter, set **Language server → Extra settings
(JSON)** to e.g. `{"formatter": {"custom": {"executable": "/path/to/formatter", "executable_range": "/path/to/formatter"}}}`
(the executable reads Julia on stdin and writes the result to stdout; the range one also gets `--lines=START:END`).

## Outline

JETLS puts each function's full signature in its symbol's `detail`, but Pulsar's default adapter keeps only the
name, which is not much use when Julia defines one name many times. This package builds the outline from the raw
symbols instead: functions are labelled with their signature, structs and abstract types with their header
(`FunctionTest{F} <: AbstractTestFunction`) and fields with their type (setting **Outline → Signatures**), and
arguments, local variables and loop blocks are left out unless **Outline → Arguments and locals** is on.

If the outline looks wrong, run **Pulsar Ide Julia: Dump Document Symbols** from the command palette: it opens a tab
listing exactly what JETLS reported for the active file (kinds, names, ranges, source lines).

## REPL (in Pulsar's terminal)

Start a Julia REPL in the built-in `terminal` package (or x-terminal-reloaded) and send code to it, Juno-style.
The terminal service can type into a terminal but cannot read its output, so results appear in the terminal,
not inline in the editor.

| Command | Default key | What it does |
| --- | --- | --- |
| Open REPL | – | New terminal running `julia`, in the active file's project (nearest `Project.toml`) |
| Send Selection Or Definition | `ctrl-enter` | The selection; otherwise the function/struct/const around the cursor (from JETLS's symbols); otherwise the line |
| Send Selection Or Definition And Advance | `shift-enter` | The same, then the cursor moves to the next line of code (blank lines and comments are skipped) |
| Send Cell / Send Cell And Advance | `alt-enter` / `alt-shift-enter` | The cell between `##`, `#---` or `# %%` markers |
| Send File | `ctrl-shift-enter` | `include("file")` (saves first) |
| Activate Environment | – | `Pkg.activate` on the file's project (nearest `Project.toml`) |
| Activate Environment In Current Folder / In Parent Folder | – | `Pkg.activate` on the file's folder, or the folder above it |
| Activate Default Environment | – | `Pkg.activate()` |
| Select Environment | – | A list of the shared environments in `<depot>/environments` (the first `JULIA_DEPOT_PATH` entry, else `~/.julia`); activates the one you pick |
| Work In Current Folder / Project Folder / Home Folder | – | `cd(...)` to the file's folder, Pulsar's project folder for the file, or `cd()` |
| Select Working Folder | – | Choose a folder in the system dialog and `cd` into it |
| Previous / Next Cell | `alt-up` / `alt-down` | Move between cell markers |

Settings (the **REPL** group): Julia executable, environment, threads, extra arguments (added as written, e.g.
`-e 'using Revise'`; `-i` is added for you), the workspace helper, and how code is typed when it is typed.

* **Typing code into the terminal.** Only used when code is typed rather than handed to the workspace helper (see
  Module-aware sending). `service` uses the terminal package's documented API, which may ask you to approve the
  commands. `command` selects the code and runs the terminal package's own *run selected text* command instead.
* **Multi-line code.** By default each line is typed as if you had typed it, which Julia's REPL handles for blocks.
  If a block misbehaves, turn on **Bracketed paste**.
* The REPL is started when you first send code. **Open REPL** starts another one (e.g. after closing the terminal).

## Running tests

Two ways to run a package's tests from the editor; neither has a key by default (see below).

**In the REPL** (fast: the REPL already has your package loaded):

| Command | |
| --- | --- |
| Run Testset In REPL | Runs the `@testset` around the cursor (the innermost one) in `Main` |
| Run Test File In REPL | Saves and `include`s the test file in `Main` |

Test files usually leave their setup to `test/runtests.jl`, so before the tests the package prepares `Main` the way
`runtests.jl` and `Pkg.test` would (settings in the **Tests** group):

* `using Test`;
* **Use the test environment**: when the tests have an environment of their own, such as `test/Project.toml`, it is
  added to `LOAD_PATH`, so test-only packages (Aqua, …) can be loaded. Instantiate it once
  (`julia --project=test -e 'using Pkg; Pkg.instantiate()'`). Test dependencies listed under `[extras]` in the
  package's own `Project.toml` cannot be provided this way;
* **Load the package being tested**: `using` the package the test file belongs to. Its folder is put first on
  `LOAD_PATH`, so this checkout is loaded even if another version of the package is in your shared environment;
* **Setup code**: anything else, e.g. `Random.seed!(42)`.

The setup and the tests are sent together, so if the setup fails (a package does not load) the tests do not run.
A testset can use helpers defined earlier in its file: run the whole file once, then rerun single testsets as you
edit. Results are printed in the REPL by Test.jl.

A REPL started from a test file runs in the package's environment rather than in `test/Project.toml`, as `Pkg.test`
would. If a package was already loaded from somewhere else in that REPL session (`Info: ... caches not reused ...
different source file path` is a sign), start a new REPL: Julia cannot swap a loaded package for another copy.

**With JETLS's TestRunner** (each run is a new Julia process, and failures are shown at the failing lines):

| Command | |
| --- | --- |
| Run Testset | The innermost `@testset` around the cursor |
| Run Test | The `@test` at the cursor |
| Show Macro Expansion | The macro call at the cursor, expanded one level, in a new tab |
| Expand All Macros | Every macro in the top-level form at the cursor, expanded |
| Show Inferred Types | The top-level form at the cursor, annotated with the types JETLS infers |

These are JETLS's code actions, also listed by **Intentions: Show**. TestRunner runs the test file on its own, so a
file that relies on `runtests.jl` for `using Test` and its package fails with "`@testset` not defined"; for those,
use the REPL commands. To bind keys, add for example to your `keymap.cson`:

```cson
'atom-text-editor[data-grammar~="julia"]':
  'ctrl-alt-t': 'pulsar-ide-julia:run-testset-in-repl'
  'ctrl-alt-shift-t': 'pulsar-ide-julia:run-test-file-in-repl'
  'ctrl-alt-m': 'pulsar-ide-julia:show-macro-expansion'
```

(`alt-enter`, the `intentions` package's key, is this package's **Send Cell** in Julia files.)

## Debugger and workspace pane

**Experimental, and not yet tested against a real DebugAdapter.jl or Pulsar** (see "What to check first" below).

The debugger talks the Debug Adapter Protocol to [DebugAdapter.jl](https://github.com/julia-vscode/DebugAdapter.jl).
Install it once in the default global environment (the adapter is found through Julia's normal `LOAD_PATH`; your
program still runs in its own project):

```
julia -e 'using Pkg; Pkg.add("DebugAdapter")'
```

| Command | Default key (Julia files) | |
| --- | --- | --- |
| `pulsar-ide-julia:debug-start-or-continue` | `F5` | Debug the current file, or continue when stopped |
| `pulsar-ide-julia:debug-file` | `Ctrl+F5` | Debug the current file |
| `pulsar-ide-julia:toggle-breakpoint` | `F9` | Breakpoint on the cursor line (or click the gutter dot column) |
| `pulsar-ide-julia:debug-step-over` / `-in` / `-out` | `F10` / `F11` / `Shift+F11` | Also work with the workspace pane focused |
| `pulsar-ide-julia:debug-stop` | `Shift+F5` | Stop the program and the adapter |
| `pulsar-ide-julia:clear-breakpoints` | | Remove all breakpoints |
| `pulsar-ide-julia:open-workspace` | | Open the workspace pane |
| `pulsar-ide-julia:show-debug-output` | | Open what the program and the adapter print |

On some systems `F11` is bound to full screen by default; the package's binding only applies in Julia editors and in
the workspace pane, and you can rebind it in your keymap.

The **Julia Workspace** pane shows the scopes and variables of the selected stack frame. Expand a variable to see
its fields or elements (what stays expanded survives stepping, so you can watch `v` change), filter by name with
the box at the top (matching is fuzzy, e.g. `xs` finds `xValues`), and choose another frame in the drop-down; the
current-line marker follows it. Scopes the adapter marks as expensive (usually globals) load when you click
"Load variables". Values are dimmed while the program is running.

The **Debugger** settings choose the Julia executable, environment, threads and flags, whether to stop on
entry, the script's arguments, compiled mode and which modules to run compiled, which exception filters to enable
(default `error`: stop on uncaught exceptions; `throw` stops on every exception; empty never stops),
and let you merge extra JSON into the `launch` request. The request follows DebugAdapter.jl's
`JuliaLaunchArguments` (`program`, `stopOnEntry`, `cwd`, `env`, `project`, `args`, `code`, `compiledMode`,
`compiledModulesOrFunctions`, `noDebug`); only `program` and `stopOnEntry` are always sent, the rest only when set.

### What to check first

* Nothing has run against the real adapter yet. If starting fails, the output pane shows what Julia printed.
  If the adapter rejects the launch request, **Debugger → Extra launch arguments (JSON)** can add or override fields
  (a `null` value removes one).
* The breakpoint gutter needs a width of its own to be clickable before the first breakpoint exists; the stylesheet
  gives it one, but if clicks do nothing, use `F9`.
* Breakpoints set while the program is running depend on what the adapter allows; the session is only told, not
  guaranteed.

### Module-aware sending

When the REPL was started by Pulsar with the workspace helper (see below), code you send is not typed into the
terminal. Pulsar hands it to the helper over its socket, and Julia evaluates it in the REPL's own process, so it also
does not matter which terminal tab was used last (the terminal package types into the "most recently used" one). Julia:

* evaluates the code in the module it belongs to. Inside a file, JETLS's symbols give the `module` nesting around the
  code. A file under `src/` of a package (a `Project.toml` with a `name` and `uuid`) belongs to that package: if the
  REPL has loaded it (also indirectly, as a dependency), the code goes to the package module, or to the submodule the
  file is `include`d into (read from the package's precompile cache), then down the file's own nesting. Code in the
  package's entry file before its `module` line goes to `Main`. Anything not loaded falls back to the deepest module
  that exists, in the end `Main` (also when JETLS does not answer within two seconds). Sending a whole
  `module Foo … end` evaluates it in the enclosing module, not inside itself;
* lets Revise catch up first when it is loaded, as it does before every line typed at the prompt;
* uses the editor's file name and line numbers, so `@__FILE__`, `@__LINE__`, relative `include`s and the locations in
  error messages refer to your file. Errors are shown without the helper's own frames;
* when the REPL is waiting at its prompt, shows the result like the REPL does (nothing if the code ends with `;`) and
  draws the prompt again. While the REPL is busy the code waits for its turn and the result is not shown.

The first send after opening a REPL waits until Julia has started and the helper has connected (up to 20 seconds; after
that, or if the helper cannot load, code is typed in as before). When that REPL exits, the next send starts a new one. If the REPL does not answer a send in time, you get a warning and the code runs when the REPL is free. Turn it off with **REPL → Run sent code in its module**.
This is separate from the workspace pane's module menu, which only chooses what the pane lists. "Send file" still runs
`include(file)` in `Main`.

### Variables of the REPL

The same pane also follows the Julia REPL started with `pulsar-ide-julia:open-repl`. Pulsar's terminal cannot be read
from, so the REPL is started with `julia -L <file>`: a small startup file that loads `julia/workspace.jl` from this
package, which connects back to Pulsar over a local socket (a Unix socket or Windows named pipe) and answers
read-only questions about the variables in `Main`: the names, a one-line summary of each value, its type, and the
fields, elements or entries of structs, arrays, dictionaries, sets, tuples and modules (up to 100 at a time).

* The module menu at the top of the pane chooses which module is listed: `Main`, any module or package the REPL has
  loaded into `Main` (`Main.MyPackage`), or **Follow editor**, which shows the module around the cursor in the active
  Julia file (from JETLS's symbols, with the package in front for files under a package's `src/`; modules the REPL does
  not know yet fall back to the enclosing one that it does). The choice is kept in **REPL → Workspace module**
  (`@follow` for Follow editor).
* While a debug session is active the pane shows the debugger's frame variables; afterwards it goes back to the REPL.
* It refreshes by itself shortly after variables are added, removed or rebound, or a collection changes length. Changes
  inside a value (`a[1] = 5`) are not noticed; use the Refresh button.
* It only works for a REPL started from Pulsar (the helper needs the startup file), and needs Julia 1.9 or newer and no
  packages. Turn it off with **REPL → Connect the workspace helper**.
* If the REPL is busy running something long, the pane may lag, unless Julia has an interactive thread (the helper
  uses one when there is one; check with `Threads.nthreads(:interactive)`).
* Run `julia julia/test_workspace.jl` to check the helper on your Julia.
