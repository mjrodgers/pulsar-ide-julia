# pulsar-ide-julia

This is 1000% vibe coded, I know enough to point in the right direction and maintain this package,
but frankly my knowledge of javascript is super limited and I just wanted to get a Julia language server up and running.
Please report issues, I'm happy to work to improve this and keep it up and running.

Julia language support for Pulsar via [JETLS](https://github.com/aviatesk/JETLS.jl),
using `@savetheclocktower/atom-languageclient`.

## Develop

    npm install            # or `ppm install`
    ppm link               # make Pulsar see the package (once)
    pulsar --test spec     # run the specs (Linux CI: wrap in xvfb-run)
                           # specs are self-contained: a stub grammar fixture stands in for language-julia
    JETLS_INTEGRATION=1 pulsar --test spec   # also test against a real jetls

## Settings and JETLS configuration

Configuration reaches JETLS three ways (highest priority first):

1. `.JETLSConfig.toml` in the project root (read by JETLS itself; per root, committable).
2. Pulsar settings: the package opts in to the fork's built-in `workspace/configuration` support
   (`supportsWorkspaceConfiguration`, `getRootConfigurationKey`, `mapConfigurationObject`),
   so JETLS's request for the `jetls` section is answered from these settings. First-class settings (auto-instantiate, debounce, formatter) are sent only
   when they differ from JETLS's defaults; **Additional JETLS settings (JSON)** is merged on top.
   These apply live.
3. JETLS defaults.

**Initialization options (JSON)** and the launch settings (path, threads, default environment,
extra Julia flags) are static: changing them offers a server restart.

## Choosing the Julia version

`jetls` is a Pkg app: it runs with the Julia that installed it. To run it with another Julia
(1.12+), set **Julia executable**; the package passes it as `JULIA_APPS_JULIA_CMD`.

## Installing JETLS

`jetls` is a Julia "app": a small launcher in `~/.julia/bin` that runs JETLS with the Julia that installed it.

    julia -e 'using Pkg; Pkg.Apps.add(; url="https://github.com/aviatesk/JETLS.jl", rev="release")'
    ~/.julia/bin/jetls --version

Needs Julia 1.12+ (1.12.2+ recommended). This package also looks in `~/.julia/bin` itself, so `PATH` need not be set.
