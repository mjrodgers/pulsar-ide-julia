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
#
#   eval <id>           evaluate the request in `<evaldir>/<id>.jl`; answered at once, the code runs when the REPL is free
#
# Evaluating code (module-aware "send"): Pulsar writes the code to `<evaldir>/<id>.jl` (module path, source file, first
# line number, one per line, then the code) and sends `eval <id>`. A worker task started on the main thread evaluates it
# in the deepest module of that path that exists, with the file name and line numbers of the editor. When the REPL is
# waiting at its prompt, the result is shown like the REPL shows it (nothing for `;`) and the prompt is drawn again.

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

# The text `f(io)` prints: one line, at most `limit` bytes, "…" appended when it was cut.
function limited(f, limit::Integer = MAX_SUMMARY)
    io = LimitedIO(limit)
    cut = false
    try
        f(IOContext(io, :limit => true, :compact => true))
    catch e
        e isa LimitReached || rethrow()
        cut = true
    end
    s = filter(isvalid, String(take!(io.buf)))
    s = replace(s, r"\s*\n\s*" => " ")
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
function visible_names(mod::Module)
    out = Symbol[]
    for n in names(mod; all = true)
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

# The parts of a value: (items, more) where `more` says the list was cut at MAX_CHILDREN.
function child_items(x)
    if x isa Module
        items = module_items(x)
        if length(items) > MAX_MODULE_ITEMS
            items = items[1:MAX_MODULE_ITEMS]
            items[end] = merge(items[end], (truncated = true,))
            return items, true
        end
        return items, false
    end

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

function resolve_module(path::AbstractString)
    mod = Main
    parts = split(strip(path), '.'; keepempty = false)
    isempty(parts) && return mod
    for p in parts[(parts[1] == "Main" ? 2 : 1):end]
        mod = getfield(mod, Symbol(p))
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
        for n in visible_names(mod)
            length(found) >= MAX_MODULES && return
            val = getvalue(mod, n)
            if val isa Module && nameof(val) === n && !(val in seen) && parentmodule(val) === mod
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

function handle(sock, line::AbstractString)
    parts = split(line, '\t')
    id = tryparse(Int, parts[1])
    id === nothing && return
    op = length(parts) >= 2 ? parts[2] : ""
    arg = length(parts) >= 3 ? join(parts[3:end], '\t') : ""
    try
        if op == "ls"
            mod = resolve_module(arg)
            empty!(refs)
            watched[] = mod
            send(sock, reply(id, module_items(mod); module_name = string(mod)))
        elseif op == "children"
            ref = parse(Int, arg)
            haskey(refs, ref) || error("this value is out of date; refresh the workspace")
            items, _ = child_items(refs[ref])
            send(sock, reply(id, items))
        elseif op == "modules"
            send(sock, reply_names(id, all_modules()))
        elseif op == "eval"
            queue = eval_queue[]
            n = tryparse(Int, strip(arg))
            (queue === nothing || n === nothing) && error("cannot evaluate this request")
            put!(queue, n)
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

function watch(sock)
    last = Base.invokelatest(fingerprint, watched[])
    while isopen(sock)
        sleep(1.0)
        try
            fp = Base.invokelatest(fingerprint, watched[])
            if fp != last
                last = fp
                send(sock, "{\"event\":\"changed\"}")
            end
        catch
        end
    end
end

# --- evaluating code for Pulsar ------------------------------------------------------------------
const EVAL_DIR = Ref("")

# The deepest module of a path like "Main.Foo.Bar" that exists (Main if none does).
function existing_module(path::AbstractString)
    mod = Main
    parts = split(strip(path), '.'; keepempty = false)
    isempty(parts) && return mod
    for p in parts[(parts[1] == "Main" ? 2 : 1):end]
        s = Symbol(p)
        isdefined(mod, s) || break
        next = getfield(mod, s)
        next isa Module || break
        mod = next
    end
    return mod
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

# Evaluates request `id` (see the header). Returns the value, or nothing for a failure or a trailing `;`.
function eval_request(id::Integer; err_io::IO = stderr)
    file = joinpath(EVAL_DIR[], string(id, ".jl"))
    text = try
        read(file, String)
    catch
        println(err_io, "Pulsar: could not read the code to evaluate ($file).")
        return nothing
    end
    rm(file; force = true)
    parts = split(text, '\n'; limit = 4)
    if length(parts) != 4
        println(err_io, "Pulsar: unreadable code to evaluate.")
        return nothing
    end
    mod = existing_module(parts[1])
    line = something(tryparse(Int, strip(parts[3])), 1)
    code = string("\n"^max(line - 1, 0), parts[4])   # the padding makes line numbers match the editor
    value = try
        eval_in(mod, code, String(strip(parts[2])))
    catch err
        report_error(err_io, err, catch_backtrace())
        return nothing
    end
    return suppressed(parts[4]) ? nothing : value
end

# --- the worker that evaluates ---------------------------------------------------------------------
const eval_queue = Ref{Union{Channel{Int},Nothing}}(nothing)

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

# Evaluates one request. At an idle prompt: wipe the prompt line, run, show the result and draw the prompt again.
function run_eval(id::Integer)
    idle = repl_idle()
    idle && print(stdout, "\r\e[2K")
    try
        value = eval_request(id)
        if idle && value !== nothing
            try
                Base.invokelatest(display, value)
            catch err
                report_error(stderr, err, catch_backtrace())
            end
        end
    finally
        flush(stdout)
        idle && redraw_prompt()
    end
    return nothing
end

function stop()
    queue = eval_queue[]
    eval_queue[] = nothing
    queue === nothing || close(queue)
    sock = connection[]
    connection[] = nothing
    sock !== nothing && isopen(sock) && close(sock)
    return nothing
end

"""
    start(pipe)

Connect to the socket Pulsar listens on and serve requests in the background. Uses an interactive thread when
Julia has one (so the workspace stays responsive while the REPL is busy), otherwise the REPL's own thread.
"""
function start(pipe::AbstractString; evaldir::AbstractString = "")
    stop()
    EVAL_DIR[] = String(evaldir)
    # The worker is created here, on the main thread, so the user's code runs there as it does at the REPL
    # (the socket tasks below may run on an interactive thread).
    queue = Channel{Int}(256)
    eval_queue[] = queue
    @async for id in queue
        try
            run_eval(id)
        catch err
            @warn "Pulsar: could not evaluate the code" exception = (err, catch_backtrace())
        end
    end
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
