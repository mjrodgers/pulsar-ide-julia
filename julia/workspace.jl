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
# Every answer is one line of JSON: {"id":N,"ok":true,"module":"Main","items":[...]} or {"id":N,"ok":false,"error":"..."}.
# An item is {"name","value","type","kind","ref","truncated"}; ref > 0 means it can be expanded with `children`.
# The helper also sends {"event":"changed"} when the watched module's variables seem to have changed.

module var"#PulsarIDEWorkspace"

using Sockets

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

function stop()
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
function start(pipe::AbstractString)
    stop()
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
