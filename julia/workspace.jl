# Workspace helper for the Julia REPL that pulsar-ide-julia starts in Pulsar's terminal.
#
# It is loaded with `julia -L <bootstrap>`, connects to a local socket that Pulsar listens on, and answers
# read-only requests about the variables in a module. Pulsar's terminal cannot be read from, so this is how the
# Julia Workspace pane learns what the REPL contains.
#
# Needs Julia 1.9 or newer and only the Sockets standard library (no JSON package: the answers are written by hand).
#
# Protocol: one request per line, tab separated: `<id>\t<op>\t<argument>`
#   ls <module path>    the variables of a module ("" or "Main" for Main); also makes it the watched module
#   modules             the paths of the loaded modules reachable from Main: {"id":N,"ok":true,"names":["Main","Main.Foo",...]}
#   children <ref>      the fields / elements / entries of a value listed earlier (refs die at the next `ls`)
#   ping
#   interrupt           interrupt what the REPL is running (code sent from Pulsar, or typed); an error if nothing is running
#
# While the REPL is running something, `ls`, `children` and `modules` are answered with {"ok":false,"busy":true,...}
# instead: the values may be changing under the user's code, and reading them from another thread at the same time is
# not safe. Otherwise they are read on the main thread, between the REPL's own work, never alongside it. The helper also
# says so by itself, with {"event":"busy"}, when it notices that the REPL started running something, and sends
# {"event":"changed"} when the REPL is free again, so Pulsar reads the module again.
#
#   eval <id>           evaluate the request in `<evaldir>/<id>.jl`; answered at once, the code runs when the REPL is free
#   eval <id> result    the same, and report the result when it has run (inline results in the editor):
#                       {"event":"result","id":<id>,"ms":<milliseconds>,"kind":...} where kind is
#                         "value"   "text" (one line) and, when there is more to see, "full" (as the REPL shows it)
#                         "image"   also "mime" and "file": the value drawn as PNG or SVG, in <evaldir>
#                         "nothing" `nothing`, or a result hidden with a trailing `;`
#                         "error"   "text" (the first line of the message), "full" (with the stack trace) and "line"
#                                   (where it happened in the source file, when it did; 0 otherwise)
#
# Evaluating code (module-aware "send"): Pulsar writes the code to `<evaldir>/<id>.jl` (module path, source file, first
# line number, package as `<uuid> <name>` or an empty line, one per line, then the code) and sends `eval <id>`. A worker
# task started on the main thread evaluates it in the module that code belongs to (see `eval_module`), with the file name
# and line numbers of the editor, after letting Revise pick up changed files if it is loaded. When the REPL is waiting at
# its prompt, the result is shown like the REPL shows it (nothing for `;`) and the prompt is drawn again.

module var"#PulsarIDEWorkspace"

using Sockets
using REPL

const MAX_SUMMARY = 200   # characters of a value's text
const MAX_TYPE = 120
const MAX_CHILDREN = 100  # entries returned for one expansion
const MAX_MODULE_ITEMS = 500
const MAX_MODULES = 500

# --- values that cannot be read ------------------------------------------------------------------
struct Undefined end
const UNDEF = Undefined()

# --- bounded text ---------------------------------------------------------------------------------
# `show` on a big or custom type can print without end, so writing is cut off after `limit` bytes.
struct LimitReached <: Exception end

mutable struct LimitedIO <: IO
    buf::IOBuffer
    limit::Int
    n::Int
end
LimitedIO(limit::Integer) = LimitedIO(IOBuffer(), Int(limit), 0)

function Base.unsafe_write(io::LimitedIO, p::Ptr{UInt8}, n::UInt)
    count = Int(n)
    room = io.limit - io.n
    if count > room
        room > 0 && unsafe_write(io.buf, p, UInt(room))
        io.n = io.limit
        throw(LimitReached())
    end
    io.n += count
    return unsafe_write(io.buf, p, n)
end

function Base.write(io::LimitedIO, b::UInt8)
    io.n >= io.limit && throw(LimitReached())
    io.n += 1
    return write(io.buf, b)
end

# The text `f(io)` prints: one line, at most `limit` bytes, "…" appended when it was cut. With `oneline = false` the
# lines are kept, and the text is printed as the REPL prints it (not compact).
function limited(f, limit::Integer = MAX_SUMMARY; oneline::Bool = true)
    io = LimitedIO(limit)
    cut = false
    try
        f(oneline ? IOContext(io, :limit => true, :compact => true) :
                    IOContext(io, :limit => true, :displaysize => (30, 100)))
    catch e
        e isa LimitReached || rethrow()
        cut = true
    end
    s = filter(isvalid, String(take!(io.buf)))
    oneline && (s = replace(s, r"\s*\n\s*" => " "))
    return cut ? s * "…" : s
end

summarize(x) = try
    x isa Undefined ? "<undefined>" : limited(io -> show(io, x))
catch
    "#= could not show this value =#"
end

typestr(x) = try
    x isa Union{AbstractArray,AbstractDict} ? limited(io -> summary(io, x), MAX_TYPE) :
    limited(io -> print(io, typeof(x)), MAX_TYPE)
catch
    ""
end

# --- what is in a module --------------------------------------------------------------------------
# `imported`: also names brought in with `import`/`using` (a package loaded into Main is one of those).
function visible_names(mod::Module; imported::Bool = false)
    out = Symbol[]
    for n in names(mod; all = true, imported)
        startswith(String(n), "#") && continue
        (n === :eval || n === :include || n === nameof(mod)) && continue
        Base.isdeprecated(mod, n) && continue
        isdefined(mod, n) || continue
        push!(out, n)
    end
    return out
end

getvalue(mod::Module, n::Symbol) = try
    getfield(mod, n)
catch
    UNDEF
end

function kind(mod::Module, n::Symbol, x)
    x isa Undefined && return "undefined"
    x isa Module && return "module"
    x isa Type && return "type"
    x isa Function && return startswith(String(n), "@") ? "macro" : "function"
    return isconst(mod, n) ? "constant" : "variable"
end

valuekind(x) = x isa Module ? "module" : x isa Type ? "type" : x isa Function ? "function" : "value"

# Can the value be opened up in the tree?
expandable(x) = try
    if x isa Module
        true
    elseif x isa Union{Type,Function,AbstractString,Number,Symbol,Char,Ptr,Undefined,Nothing,Missing}
        false
    elseif x isa Union{AbstractArray,AbstractDict,AbstractSet,Tuple}
        !isempty(x)
    else
        isstructtype(typeof(x)) && fieldcount(typeof(x)) > 0
    end
catch
    false
end

# Values listed to the client are remembered here so that `children` can find them again.
const refs = Dict{Int,Any}()
const counter = Ref(0)

function register(x)
    counter[] += 1
    refs[counter[]] = x
    return counter[]
end

item(name::AbstractString, x; kind::AbstractString = valuekind(x)) =
    (name = String(name), value = summarize(x), type = typestr(x), kind = String(kind),
     ref = expandable(x) ? register(x) : 0, truncated = false)

kind_rank(k) = (k == "variable" || k == "constant") ? 0 : k == "type" ? 1 : (k == "function" || k == "macro") ? 2 : k == "module" ? 3 : 4

function module_items(mod::Module)
    items = []
    for n in visible_names(mod)
        x = getvalue(mod, n)
        push!(items, item(String(n), x; kind = kind(mod, n, x)))
    end
    sort!(items; by = it -> (kind_rank(it.kind), it.name))
    return items
end

index_label(I) = I isa CartesianIndex ? string("[", join(Tuple(I), ", "), "]") : string("[", I, "]")
element(x, I) = try
    x[I]
catch
    UNDEF
end

# The variables of a module, at most MAX_MODULE_ITEMS of them (a package can define thousands): (items, more).
function capped_module_items(mod::Module)
    items = module_items(mod)
    length(items) > MAX_MODULE_ITEMS || return items, false
    items = items[1:MAX_MODULE_ITEMS]
    items[end] = merge(items[end], (truncated = true,))
    return items, true
end

# The parts of a value: (items, more) where `more` says the list was cut at MAX_CHILDREN.
function child_items(x)
    x isa Module && return capped_module_items(x)

    pairs = Pair{String,Any}[]
    more = false
    if x isa AbstractDict
        for (i, kv) in enumerate(x)
            i > MAX_CHILDREN && (more = true; break)
            push!(pairs, limited(io -> show(io, first(kv)), 60) => last(kv))
        end
    elseif x isa AbstractArray
        for (i, I) in enumerate(ndims(x) > 1 ? CartesianIndices(x) : eachindex(x))
            i > MAX_CHILDREN && (more = true; break)
            push!(pairs, index_label(I) => element(x, I))
        end
    elseif x isa Union{AbstractSet,Tuple}
        for (i, v) in enumerate(x)
            i > MAX_CHILDREN && (more = true; break)
            push!(pairs, string("[", i, "]") => v)
        end
    else
        for (i, f) in enumerate(fieldnames(typeof(x)))
            i > MAX_CHILDREN && (more = true; break)
            push!(pairs, String(f) => (isdefined(x, f) ? getfield(x, f) : UNDEF))
        end
    end

    items = Any[item(label, v) for (label, v) in pairs]
    more && !isempty(items) && (items[end] = merge(items[end], (truncated = true,)))
    return items, more
end

# A loaded package (a root module) by name, also one that is not bound in Main (a dependency loaded indirectly).
function loaded_package(name::AbstractString)
    sym = Symbol(name)
    for m in Base.loaded_modules_array()
        nameof(m) === sym && parentmodule(m) === m && return m
    end
    return nothing
end

function resolve_module(path::AbstractString)
    mod = Main
    parts = split(strip(path), '.'; keepempty = false)
    isempty(parts) && return mod
    rest = parts[(parts[1] == "Main" ? 2 : 1):end]
    for (i, p) in enumerate(rest)
        s = Symbol(p)
        if i == 1 && mod === Main && !isdefined(Main, s)
            pkg = loaded_package(p)
            pkg === nothing && error("$path is not a module")
            mod = pkg
            continue
        end
        mod = getfield(mod, s)
        mod isa Module || error("$path is not a module")
    end
    return mod
end

# The modules reachable from Main as submodules ("Main", "Main.Foo", "Main.Foo.Bar", packages loaded with `using`).
# Base and Core are listed but not searched.
function all_modules()
    found = String["Main"]
    seen = Set{Module}([Main])
    function walk(mod::Module, path::String)
        # Packages loaded into Main are imported names there; inside packages, imports are not submodules.
        for n in visible_names(mod; imported = mod === Main)
            length(found) >= MAX_MODULES && return
            val = getvalue(mod, n)
            # Submodules, and at the top the packages loaded into Main (a package is its own parent module).
            if val isa Module && nameof(val) === n && !(val in seen) &&
               (parentmodule(val) === mod || (mod === Main && parentmodule(val) === val))
                push!(seen, val)
                p = string(path, ".", n)
                push!(found, p)
                (val === Base || val === Core) || walk(val, p)
            end
        end
    end
    walk(Main, "Main")
    return vcat(["Main"], sort!(found[2:end]))
end

# --- JSON, written by hand ------------------------------------------------------------------------
function jstring(io::IO, s::AbstractString)
    print(io, '"')
    for c in s
        if c == '"'
            print(io, "\\\"")
        elseif c == '\\'
            print(io, "\\\\")
        elseif c == '\n'
            print(io, "\\n")
        elseif c == '\r'
            print(io, "\\r")
        elseif c == '\t'
            print(io, "\\t")
        elseif c < ' '
            print(io, "\\u", lpad(string(UInt16(c), base = 16), 4, '0'))
        else
            print(io, c)
        end
    end
    print(io, '"')
end

function jitem(io::IO, it)
    print(io, "{\"name\":");  jstring(io, it.name)
    print(io, ",\"value\":"); jstring(io, it.value)
    print(io, ",\"type\":");  jstring(io, it.type)
    print(io, ",\"kind\":");  jstring(io, it.kind)
    print(io, ",\"ref\":", it.ref, ",\"truncated\":", it.truncated, '}')
end

function reply(id::Integer, items; module_name = nothing)
    io = IOBuffer()
    print(io, "{\"id\":", id, ",\"ok\":true")
    if module_name !== nothing
        print(io, ",\"module\":"); jstring(io, String(module_name))
    end
    print(io, ",\"items\":[")
    for (i, it) in enumerate(items)
        i > 1 && print(io, ',')
        jitem(io, it)
    end
    print(io, "]}")
    return String(take!(io))
end

function reply_names(id::Integer, names)
    io = IOBuffer()
    print(io, "{\"id\":", id, ",\"ok\":true,\"names\":[")
    for (i, n) in enumerate(names)
        i > 1 && print(io, ',')
        jstring(io, String(n))
    end
    print(io, "]}")
    return String(take!(io))
end

function reply_busy(id::Integer)
    return string("{\"id\":", id, ",\"ok\":false,\"busy\":true,\"error\":\"The REPL is busy; the workspace is read again when it is free.\"}")
end

function reply_error(id::Integer, message::AbstractString)
    io = IOBuffer()
    print(io, "{\"id\":", id, ",\"ok\":false,\"error\":"); jstring(io, message); print(io, '}')
    return String(take!(io))
end

# --- serving --------------------------------------------------------------------------------------
const watched = Ref{Module}(Main)
const connection = Ref{Any}(nothing)
const write_lock = ReentrantLock()

function send(sock, line::AbstractString)
    lock(write_lock) do
        println(sock, line)
    end
end

# --- is the REPL running something? ---------------------------------------------------------------
# `evaluating`: code from Pulsar is running (see `run_eval`). Code typed at the prompt: the REPL backend's `in_eval`.
const evaluating = Threads.Atomic{Bool}(false)

function repl_in_eval()
    try
        backend = Base.active_repl_backend
        return backend !== nothing && backend.in_eval
    catch
        return false
    end
end

busy() = evaluating[] || repl_in_eval()

# Interrupts the main thread as Ctrl-C in the terminal would: Julia turns SIGINT into an InterruptException in the code
# running there. Code sent from Pulsar runs while the REPL's prompt reads the keyboard, so Ctrl-C in the terminal does
# not reach it; this does. (On Windows, `raise` is the closest there is; it may not reach running code.)
function interrupt_main()
    if Sys.iswindows()
        ccall(:raise, Cint, (Cint,), 2)
    else
        ccall(:kill, Cint, (Cint, Cint), getpid(), 2)
    end
    return nothing
end

# --- requests ----------------------------------------------------------------------------------------
# Reading values: on the main thread (see `inspect_queue`), and only while the REPL is free.
const INSPECT_OPS = ("ls", "children", "modules")

function inspect(sock, id::Integer, op::AbstractString, arg::AbstractString)
    busy() && return send(sock, reply_busy(id))   # it may have started while this waited its turn
    try
        if op == "ls"
            mod = resolve_module(arg)
            empty!(refs)
            watched[] = mod
            items, _ = capped_module_items(mod)
            send(sock, reply(id, items; module_name = string(mod)))
        elseif op == "children"
            ref = parse(Int, arg)
            haskey(refs, ref) || error("this value is out of date; refresh the workspace")
            items, _ = child_items(refs[ref])
            send(sock, reply(id, items))
        elseif op == "modules"
            send(sock, reply_names(id, all_modules()))
        end
    catch e
        send(sock, reply_error(id, sprint(showerror, e)))
    end
    return nothing
end

function handle(sock, line::AbstractString)
    parts = split(line, '\t')
    id = tryparse(Int, parts[1])
    id === nothing && return
    op = length(parts) >= 2 ? parts[2] : ""
    arg = length(parts) >= 3 ? join(parts[3:end], '\t') : ""
    try
        if op in INSPECT_OPS
            busy() && return send(sock, reply_busy(id))
            queue = inspect_queue[]
            if queue === nothing
                inspect(sock, id, op, arg)
            else
                put!(queue, (sock, id, String(op), String(arg)))
            end
        elseif op == "eval"
            queue = eval_queue[]
            words = split(arg)
            n = isempty(words) ? nothing : tryparse(Int, words[1])
            (queue === nothing || n === nothing) && error("cannot evaluate this request")
            put!(queue, (n, "result" in words[2:end]))
            send(sock, reply(id, []))
        elseif op == "interrupt"
            busy() || error("nothing is running")
            interrupt_main()
            send(sock, reply(id, []))
        elseif op == "ping"
            send(sock, reply(id, []))
        else
            error("unknown request '$op'")
        end
    catch e
        send(sock, reply_error(id, sprint(showerror, e)))
    end
end

function serve(sock)
    try
        while isopen(sock) && !eof(sock)
            line = readline(sock)
            isempty(line) && continue
            # invokelatest: methods the user defines later (for example `show`) must be visible here.
            Base.invokelatest(handle, sock, line)
        end
    catch e
        (e isa InterruptException || e isa EOFError || e isa Base.IOError) || @warn "Pulsar workspace helper stopped" exception = e
    finally
        isopen(sock) && close(sock)
    end
end

# A cheap summary of "what is bound to what" in a module, to notice changes without being told.
# Changes inside a value (a[1] = 5) are not seen, only new/removed/rebound names and length changes.
function fingerprint(mod::Module)
    h = UInt(0)
    for n in visible_names(mod)
        x = getvalue(mod, n)
        h = hash(n, h)
        h = hash(objectid(x), h)
        if x isa Union{AbstractArray,AbstractDict,AbstractSet,Tuple}
            h = hash(length(x), h)
        elseif x isa AbstractString
            h = hash(sizeof(x), h)
        end
    end
    return h
end

# Looks for changes once a second, but not while the REPL is running something (it says when that starts); when it is
# free again the module is announced as changed in any case, so that a "busy" answer is followed by a fresh reading.
function watch(sock)
    last = Base.invokelatest(fingerprint, watched[])
    was_busy = false
    while isopen(sock)
        sleep(1.0)
        try
            if busy()
                was_busy || send(sock, "{\"event\":\"busy\"}")
                was_busy = true
                continue
            end
            fp = Base.invokelatest(fingerprint, watched[])
            if fp != last || was_busy
                last = fp
                was_busy = false
                send(sock, "{\"event\":\"changed\"}")
            end
        catch
        end
    end
end

# --- evaluating code for Pulsar ------------------------------------------------------------------
const EVAL_DIR = Ref("")

# The names of a module path like "Main.Foo.Bar", without the leading Main.
function module_parts(path::AbstractString)
    parts = String.(split(strip(path), '.'; keepempty = false))
    return isempty(parts) || parts[1] != "Main" ? parts : parts[2:end]
end

# The deepest module reached from `mod` by following `parts` while they name modules.
function descend(mod::Module, parts)
    for p in parts
        s = Symbol(p)
        isdefined(mod, s) || break
        next = getfield(mod, s)
        next isa Module || break
        mod = next
    end
    return mod
end

# The deepest module of a path like "Main.Foo.Bar" that exists (Main if none does). A first name that is not bound
# in Main may still be a loaded package.
function existing_module(path::AbstractString)
    parts = module_parts(path)
    isempty(parts) && return Main
    if !isdefined(Main, Symbol(parts[1]))
        pkg = loaded_package(parts[1])
        pkg === nothing || return descend(pkg, parts[2:end])
    end
    return descend(Main, parts)
end

# --- which module a package file belongs to ---------------------------------------------------------------------------
# A file of a package that has no `module` line of its own is `include`d into the package module, or a submodule of it.
# Pulsar sends the package (`<uuid> <name>` from the nearest Project.toml, when the file is under its src/); the
# package must be loaded in this process, under that exact identity.
function package_root(spec::AbstractString)
    parts = split(strip(spec), ' '; limit = 2)
    length(parts) == 2 || return nothing
    uuid = tryparse(Base.UUID, parts[1])
    uuid === nothing && return nothing
    id = Base.PkgId(uuid, String(strip(parts[2])))
    return Base.root_module_exists(id) ? Base.root_module(id) : nothing
end

same_file(a::AbstractString, b::AbstractString) = try
    a == b || (isfile(a) && isfile(b) && samefile(a, b))
catch
    false
end

# The module path each source file of a precompiled package was included into, from its cache file's header (the
# record Revise uses too). Cached per cache file, which changes whenever the package is recompiled.
const include_paths_cache = Dict{String,Vector{Tuple{String,Vector{String}}}}()

function include_paths(root::Module)
    id = Base.PkgId(root)
    origin = Base.@lock Base.require_lock get(Base.pkgorigins, id, nothing)
    cachepath = origin === nothing ? nothing : origin.cachepath
    cachepath isa String && isfile(cachepath) || return nothing
    return get!(include_paths_cache, cachepath) do
        # The second element starts with every include of the package on all supported Julia versions (1.12 adds the
        # source files alone after it, with `@depot` paths resolved in place in both lists).
        includes = Base.parse_cache_header(cachepath)[2][1]
        Tuple{String,Vector{String}}[(String(inc.filename), String.(inc.modpath)) for inc in includes if inc.id == id]
    end
end

# The module `file` was included into, or nothing when the cache does not say (not precompiled, or a new file).
function included_module(root::Module, file::AbstractString)
    paths = try
        include_paths(root)
    catch
        nothing   # internal API; a change in it must not break sending
    end
    paths === nothing && return nothing
    for (filename, modpath) in paths
        same_file(filename, file) || continue
        isempty(modpath) && return nothing   # the package's own entry file, loaded at top level
        rest = modpath[1] == String(nameof(root)) ? modpath[2:end] : modpath
        return descend(root, rest)
    end
    return nothing
end

"""
    eval_module(path, package, file) -> Module

Where code from `file` is evaluated. `path` is the `module` nesting around the code inside the file ("Main.Foo"), as
JETLS reports it; `package` is `"<uuid> <name>"` or empty.

* No package, or the package is not loaded: the deepest existing module of `path`.
* The package's entry file (`src/<Name>.jl`): code inside `module Name … end` goes to the package itself; code outside it
  (before the `module` line) goes to Main.
* Any other file of the package: the module it was included into (from the precompile cache; the package itself when
  that is unknown), then the in-file nesting below it.
"""
function eval_module(path::AbstractString, package::AbstractString, file::AbstractString)
    root = isempty(strip(package)) ? nothing : package_root(package)
    root === nothing && return existing_module(path)
    parts = module_parts(path)
    entry = pathof(root)
    if !isempty(file) && entry !== nothing && same_file(entry, file)
        (!isempty(parts) && parts[1] == String(nameof(root))) || return existing_module(path)
        return descend(root, parts[2:end])
    end
    base = isempty(file) ? nothing : included_module(root, file)
    return descend(something(base, root), parts)
end

# Revise updates code in the REPL through the REPL's own hooks, which code evaluated here bypasses: let it catch up
# first, as it would before a line typed at the prompt.
function revise_first(err_io::IO)
    revise = loaded_package("Revise")
    revise === nothing && return nothing
    isdefined(revise, :revise) || return nothing
    try
        Base.invokelatest(getfield(revise, :revise))
    catch err
        report_error(err_io, err, catch_backtrace())
    end
    return nothing
end

# Does the last line of code end with `;` (which hides the result in the REPL)?
function suppressed(code::AbstractString)
    for line in Iterators.reverse(split(code, '\n'))
        t = strip(line)
        (isempty(t) || startswith(t, '#')) && continue
        return endswith(t, ';')
    end
    return false
end

# Frames from the helper and from `include_string` say nothing to the user. (A function with keyword arguments runs
# in a method called `#name#N`, hence the substring checks.)
function trim_frames(frames)
    fname(f) = String(f.func)
    stop = findfirst(f -> occursin("eval_request", fname(f)), frames)
    stop === nothing || (frames = frames[1:stop-1])
    internal(f) = occursin("eval_in", fname(f)) || occursin("eval_request", fname(f)) ||
                  f.func in (:include_string, :_include_string, :eval) ||
                  endswith(String(f.file), "boot.jl") || endswith(String(f.file), "loading.jl")
    while !isempty(frames) && internal(frames[end])
        frames = frames[1:end-1]
    end
    return frames
end

function report_error(io::IO, err, bt)
    err isa LoadError && (err = err.error)
    try
        Base.invokelatest(Base.display_error, io, err, trim_frames(stacktrace(bt)))
    catch
        println(io, "ERROR: ", sprint(showerror, err))
    end
    return nothing
end

function eval_in(mod::Module, code::AbstractString, file::AbstractString)
    tls = task_local_storage()
    had = haskey(tls, :SOURCE_PATH)
    old = get(tls, :SOURCE_PATH, nothing)
    isempty(file) || (tls[:SOURCE_PATH] = String(file))   # so a relative `include` finds its way from the file
    try
        return include_string(mod, String(code), isempty(file) ? "untitled" : String(file))
    finally
        if had
            tls[:SOURCE_PATH] = old
        else
            delete!(tls, :SOURCE_PATH)
        end
    end
end

# Evaluates request `id` (see the header), reporting errors to `err_io`. Returns (status, value, error, backtrace, file)
# with status :ok, :suppressed (a trailing `;`), :error, or :unreadable (the request could not be read).
function evaluate_request(id::Integer; err_io::IO = stderr)
    file = joinpath(EVAL_DIR[], string(id, ".jl"))
    failed(why) = (println(err_io, "Pulsar: ", why); (status = :unreadable, value = nothing, error = nothing, backtrace = nothing, file = ""))
    text = try
        read(file, String)
    catch
        return failed("could not read the code to evaluate ($file).")
    end
    rm(file; force = true)
    parts = split(text, '\n'; limit = 5)
    length(parts) == 5 || return failed("unreadable code to evaluate.")
    srcfile = String(strip(parts[2]))
    revise_first(err_io)
    mod = eval_module(parts[1], parts[4], srcfile)
    line = something(tryparse(Int, strip(parts[3])), 1)
    code = string("\n"^max(line - 1, 0), parts[5])   # the padding makes line numbers match the editor
    value = try
        eval_in(mod, code, srcfile)
    catch err
        bt = catch_backtrace()
        report_error(err_io, err, bt)
        return (status = :error, value = nothing, error = err, backtrace = bt, file = srcfile)
    end
    status = suppressed(parts[5]) ? :suppressed : :ok
    return (status = status, value = status === :ok ? value : nothing, error = nothing, backtrace = nothing, file = srcfile)
end

# Evaluates request `id`. Returns the value, or nothing for a failure or a trailing `;`.
eval_request(id::Integer; err_io::IO = stderr) = evaluate_request(id; err_io).value

# --- reporting a result to Pulsar (inline results) --------------------------------------------------------------------
const MAX_FULL = 20_000   # characters of a result's full text

# The value drawn as an image Pulsar can show, written next to the requests: (mime, file) or nothing.
function save_image(id::Integer, value)
    isempty(EVAL_DIR[]) && return nothing
    for (mime, ext) in ((MIME"image/png"(), "png"), (MIME"image/svg+xml"(), "svg"))
        try
            showable(mime, value) || continue
            path = joinpath(EVAL_DIR[], string("result-", id, ".", ext))
            open(io -> show(io, mime, value), path, "w")
            return (string(mime), path)
        catch
        end
    end
    return nothing
end

# The line of the source file where an error happened (the innermost frame in that file), or 0.
function error_line(bt, file::AbstractString)
    (bt === nothing || isempty(file)) && return 0
    try
        for f in stacktrace(bt)
            same_file(String(f.file), file) && return f.line
        end
    catch
    end
    return 0
end

function result_message(id::Integer, r, ms::Integer)
    io = IOBuffer()
    print(io, "{\"event\":\"result\",\"id\":", id, ",\"ms\":", ms)
    field(name, s) = (print(io, ",\"", name, "\":"); jstring(io, s))
    if r.status === :error
        err = r.error isa LoadError ? r.error.error : r.error
        message = try
            limited(io -> showerror(io, err), MAX_FULL; oneline = false)
        catch
            "the error could not be shown"
        end
        print(io, ",\"kind\":\"error\"")
        field("text", first(split(strip(message), '\n'; limit = 2)))
        field("full", try
            limited(io -> report_error(io, r.error, r.backtrace), MAX_FULL; oneline = false)
        catch
            message
        end)
        print(io, ",\"line\":", error_line(r.backtrace, r.file))
    elseif r.status === :ok && r.value !== nothing
        value = r.value
        image = save_image(id, value)
        print(io, ",\"kind\":\"", image === nothing ? "value" : "image", "\"")
        image === nothing || (field("mime", image[1]); field("file", image[2]))
        text = summarize(value)
        field("text", text)
        if image === nothing
            full = try
                limited(io -> show(io, MIME"text/plain"(), value), MAX_FULL; oneline = false)
            catch
                text
            end
            full != text && field("full", full)
        end
    else
        print(io, ",\"kind\":\"nothing\"")
    end
    print(io, '}')
    return String(take!(io))
end

function send_result(id::Integer, r, ms::Integer)
    sock = connection[]
    sock === nothing && return nothing
    try
        send(sock, result_message(id, r, ms))
    catch err
        @warn "Pulsar: could not report the result" exception = err
    end
    return nothing
end

# --- the worker that evaluates ---------------------------------------------------------------------
const eval_queue = Ref{Union{Channel{Tuple{Int,Bool}},Nothing}}(nothing)   # (request id, report the result)

# Is the REPL waiting at its prompt (and not running something)?
function repl_idle()
    try
        repl = Base.active_repl
        backend = Base.active_repl_backend
        return repl isa REPL.LineEditREPL && backend !== nothing && !backend.in_eval && repl.mistate !== nothing
    catch
        return false
    end
end

function redraw_prompt()
    try
        REPL.LineEdit.refresh_line(Base.active_repl.mistate)
    catch
    end
    return nothing
end

# Code typed at the prompt runs first: sent code waits for it, as if it had been typed after it.
function wait_for_repl()
    while repl_in_eval()
        sleep(0.05)
    end
end

# Evaluates one request. At an idle prompt: wipe the prompt line, run, show the result and draw the prompt again.
# With `report`, the result is also sent to Pulsar (see `result_message`).
function run_eval(id::Integer; report::Bool = false)
    wait_for_repl()
    idle = repl_idle()
    idle && print(stdout, "\r\e[2K")
    evaluating[] = true
    try
        t0 = time_ns()
        r = evaluate_request(id)
        ms = round(Int, (time_ns() - t0) / 1e6)
        report && r.status !== :unreadable && send_result(id, r, ms)
        value = r.value
        if idle && value !== nothing
            try
                Base.invokelatest(display, value)
            catch err
                report_error(stderr, err, catch_backtrace())
            end
        end
    finally
        evaluating[] = false
        flush(stdout)
        idle && redraw_prompt()
    end
    return nothing
end

# Runs `f(job)` for each job put on `queue`, on the task that calls it, until the queue is closed. An error in one job
# (an interrupt included) is reported and the next job runs; an interrupt that arrives while waiting is ignored.
function worker(f, queue::Channel, what::AbstractString)
    while true
        job = try
            take!(queue)
        catch
            isopen(queue) || break
            continue
        end
        try
            # invokelatest: this loop keeps the world it started in, and from Julia 1.12 on an older world does not
            # see globals defined after it (a package loaded or a module defined since the REPL started).
            Base.invokelatest(f, job)
        catch err
            err isa InterruptException || @warn "Pulsar: could not $what" exception = (err, catch_backtrace())
        end
    end
end

const inspect_queue = Ref{Union{Channel{Tuple{Any,Int,String,String}},Nothing}}(nothing)

function stop()
    for q in (eval_queue, inspect_queue)
        queue = q[]
        q[] = nothing
        queue === nothing || close(queue)
    end
    sock = connection[]
    connection[] = nothing
    sock !== nothing && isopen(sock) && close(sock)
    return nothing
end

"""
    start(pipe)

Connect to the socket Pulsar listens on and serve requests in the background. Requests are received on an
interactive thread when Julia has one (so they are answered, if only with "busy", while the REPL is running something),
otherwise on the REPL's own thread; values are read on the main thread.
"""
function start(pipe::AbstractString; evaldir::AbstractString = "")
    stop()
    EVAL_DIR[] = String(evaldir)
    # The workers are created here, on the main thread: the user's code runs there as it does at the REPL, and values
    # are read there between the REPL's own work, never at the same time (the socket tasks below may run on an
    # interactive thread).
    queue = Channel{Tuple{Int,Bool}}(256)
    eval_queue[] = queue
    @async worker(job -> run_eval(job[1]; report = job[2]), queue, "evaluate the code")
    inspections = Channel{Tuple{Any,Int,String,String}}(256)
    inspect_queue[] = inspections
    @async worker(job -> inspect(job...), inspections, "read the workspace")
    sock = try
        Sockets.connect(pipe)
    catch e
        @warn "Pulsar workspace: could not connect" exception = e
        return nothing
    end
    connection[] = sock
    if Threads.nthreads(:interactive) > 0
        Threads.@spawn :interactive serve(sock)
        Threads.@spawn :interactive watch(sock)
    else
        @async serve(sock)
        @async watch(sock)
    end
    return nothing
end

end # module
