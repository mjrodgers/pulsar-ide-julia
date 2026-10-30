# Tests for workspace.jl. Needs only Julia (1.9+) and the Test/Sockets standard libraries:
#
#     julia julia/test_workspace.jl
#
using Test, Sockets
include(joinpath(@__DIR__, "workspace.jl"))
const W = Main.var"#PulsarIDEWorkspace"

# Things for the workspace to find.
x = 42
const C = 3.5
v = [1, 2, 3]
d = Dict("a" => 1, "b" => 2)
struct Foo
    a::Int
    b::String
end
foo = Foo(1, "s")
f(a) = a + 1
mat = [1 2; 3 4]
bigvec = collect(1:500)
bigdict = Dict(i => i for i in 1:300)
longstr = "x"^1000

byname(items, name) = only(filter(it -> it.name == name, items))

module TestOuter
module TestInner
x = 1
end
end

# A value that can be drawn as an image (like a plot).
struct PulsarPicture end
Base.show(io::IO, ::MIME"image/svg+xml", ::PulsarPicture) = print(io, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>")

@testset "bounded text" begin
    @test W.summarize(42) == "42"
    @test W.summarize("hi") == "\"hi\""
    @test W.summarize([1, 2, 3]) == "[1, 2, 3]"
    @test W.summarize(nothing) == "nothing"
    @test W.summarize(W.UNDEF) == "<undefined>"
    s = W.summarize(longstr)
    @test endswith(s, "…")
    @test ncodeunits(s) <= W.MAX_SUMMARY + 3
    @test !occursin('\n', W.summarize("a\n   b"))
    @test ncodeunits(W.summarize(1:100000 |> collect)) <= W.MAX_SUMMARY + 3
    @test W.typestr([1, 2, 3]) == "3-element Vector{Int64}"
    @test W.typestr(1.0) == "Float64"
    @test occursin("Dict", W.typestr(d))
end

@testset "module listing" begin
    items = W.module_items(Main)
    names = [it.name for it in items]
    @test "x" in names && "v" in names && "foo" in names
    @test !any(startswith("#"), names)
    @test !("eval" in names) && !("include" in names) && !("Main" in names)
    @test byname(items, "x").kind == "variable"
    @test byname(items, "C").kind == "constant"
    @test byname(items, "f").kind == "function"
    @test byname(items, "Foo").kind == "type"
    @test byname(items, "Base").kind == "module"
    @test byname(items, "x").value == "42"
    @test byname(items, "x").ref == 0
    @test byname(items, "v").ref > 0
    @test byname(items, "foo").ref > 0
    # variables come before types, functions and modules
    firstfn = findfirst(it -> it.kind == "function", items)
    lastvar = findlast(it -> it.kind in ("variable", "constant"), items)
    @test lastvar < firstfn
end

@testset "children" begin
    items, more = W.child_items(v)
    @test [it.name for it in items] == ["[1]", "[2]", "[3]"]
    @test [it.value for it in items] == ["1", "2", "3"]
    @test !more
    items, _ = W.child_items(d)
    @test sort([it.name for it in items]) == ["\"a\"", "\"b\""]
    items, _ = W.child_items(foo)
    @test [it.name for it in items] == ["a", "b"]
    @test [it.value for it in items] == ["1", "\"s\""]
    items, _ = W.child_items(mat)
    @test [it.name for it in items] == ["[1, 1]", "[2, 1]", "[1, 2]", "[2, 2]"]
    items, more = W.child_items(bigvec)
    @test length(items) == W.MAX_CHILDREN && more && items[end].truncated && !items[1].truncated
    items, more = W.child_items(bigdict)
    @test length(items) == W.MAX_CHILDREN && more
    items, _ = W.child_items((1, "two"))
    @test [it.name for it in items] == ["[1]", "[2]"]
    items, _ = W.child_items(Base.Iterators)
    @test any(it -> it.name == "take", items)
    @test !W.expandable(1) && !W.expandable("s") && !W.expandable(:a) && !W.expandable(sin) && !W.expandable(Int)
    @test !W.expandable(Int[]) && W.expandable([1]) && W.expandable(Base)
end

@testset "json" begin
    io = IOBuffer()
    W.jstring(io, "a\"b\\c\nd\te\u0001")
    @test String(take!(io)) == "\"a\\\"b\\\\c\\nd\\te\\u0001\""
    line = W.reply(7, [W.item("x", 42)]; module_name = "Main")
    @test startswith(line, "{\"id\":7,\"ok\":true,\"module\":\"Main\",\"items\":[{\"name\":\"x\",\"value\":\"42\"")
    @test occursin("\"kind\":\"value\",\"ref\":0,\"truncated\":false}", line)
    @test W.reply_error(3, "bad \"thing\"") == "{\"id\":3,\"ok\":false,\"error\":\"bad \\\"thing\\\"\"}"
    @test !occursin('\n', line)
end

@testset "module list" begin
    names = W.all_modules()
    @test names[1] == "Main"
    @test "Main.TestOuter" in names
    @test "Main.TestOuter.TestInner" in names
    @test "Main.Base" in names
    @test length(unique(names)) == length(names)
    @test !any(startswith("Main.#"), names)
    @test issorted(names[2:end])
    @test W.reply_names(5, ["Main", "Main.A"]) == "{\"id\":5,\"ok\":true,\"names\":[\"Main\",\"Main.A\"]}"
    @test W.resolve_module("Main.TestOuter.TestInner") === Main.TestOuter.TestInner
end

@testset "modules" begin
    @test W.resolve_module("") === Main
    @test W.resolve_module("Main") === Main
    @test W.resolve_module("Base.Iterators") === Base.Iterators
    @test_throws Exception W.resolve_module("Main.x")
    @test_throws Exception W.resolve_module("Nope")
end

@testset "evaluating code for Pulsar" begin
    dir = mktempdir()
    W.EVAL_DIR[] = dir
    request(id, mod, file, line, code; package = "") = (write(joinpath(dir, string(id, ".jl")), join([mod, file, line, package, code], '\n')); id)

    @test W.existing_module("Main.TestOuter.TestInner") === Main.TestOuter.TestInner
    @test W.existing_module("Main.TestOuter.Missing.Deeper") === Main.TestOuter
    @test W.existing_module("Nope") === Main
    @test W.existing_module("") === Main
    @test W.existing_module("Main.x") === Main   # not a module
    @test W.existing_module("Test") === Test     # a loaded package, bound in Main or not
    @test W.module_parts("Main.A.B") == ["A", "B"]
    @test W.module_parts("A") == ["A"]
    @test W.module_parts("") == String[]
    # no package: only the module path counts
    @test W.eval_module("Main.TestOuter.TestInner", "", "/w/a.jl") === Main.TestOuter.TestInner
    @test W.eval_module("Main.TestOuter", "not a package", "/w/a.jl") === Main.TestOuter

    @test W.suppressed("x = 1;")
    @test W.suppressed("x = 1;\n\n# end")
    @test !W.suppressed("x = 1")
    @test !W.suppressed("x = 1 # a; b")

    # the value comes back and the code runs in the module
    @test W.eval_request(request(1, "Main.TestOuter.TestInner", "/w/a.jl", 1, "x + 1")) == 2
    @test W.eval_request(request(2, "Main.TestOuter", "", 1, "pulsar_made = 5")) == 5
    @test Main.TestOuter.pulsar_made == 5
    @test !isfile(joinpath(dir, "1.jl"))
    # an unknown module falls back to Main
    @test W.eval_request(request(3, "Main.NotLoaded", "", 1, "@__MODULE__")) === Main
    # file and line numbers are the editor's
    @test W.eval_request(request(4, "Main", "/w/a.jl", 10, "@__LINE__")) == 10
    @test W.eval_request(request(5, "Main", "/w/a.jl", 10, "@__FILE__")) == "/w/a.jl"
    @test W.eval_request(request(6, "Main", "", 3, "string(@__FILE__, ':', @__LINE__)")) == "untitled:3"
    @test W.eval_request(request(7, "Main", "/w/a.jl", 1, "a = 1\nb = 2\na + b")) == 3
    # a semicolon hides the result
    @test W.eval_request(request(8, "Main", "", 1, "1 + 1;")) === nothing
    # errors are reported, with the editor's file and line, and nothing is thrown
    io = IOBuffer()
    @test W.eval_request(request(9, "Main", "/w/a.jl", 20, "err_probe = 1\nerror(\"boom\")"); err_io = io) === nothing
    report = String(take!(io))
    @test occursin("boom", report)
    @test occursin("/w/a.jl:21", report)
    @test !occursin("LoadError", report)
    @test !occursin("eval_request", report)
    # syntax errors too
    @test W.eval_request(request(10, "Main", "/w/a.jl", 1, "1 +* 2 ("); err_io = io) === nothing
    @test !isempty(String(take!(io)))
    # a missing or broken request
    @test W.eval_request(404; err_io = io) === nothing
    @test occursin("could not read", String(take!(io)))
    write(joinpath(dir, "11.jl"), "only\nfour\nheader\nlines")
    @test W.eval_request(11; err_io = io) === nothing
    @test occursin("unreadable", String(take!(io)))
    # a relative include is resolved from the file
    write(joinpath(dir, "inc.jl"), "included_value = 42")
    source_path = get(task_local_storage(), :SOURCE_PATH, nothing)
    @test W.eval_request(request(12, "Main", joinpath(dir, "a.jl"), 1, "include(\"inc.jl\"); included_value")) == 42
    @test get(task_local_storage(), :SOURCE_PATH, nothing) == source_path   # restored
    @test !W.repl_idle()   # no REPL here, so nothing is displayed
    # Revise is not loaded here: nothing to do, nothing printed
    @test W.revise_first(IOBuffer()) === nothing
end

@testset "busy, interrupting and robust workers" begin
    # while something runs, values are not read
    io = IOBuffer()
    W.evaluating[] = true
    try
        @test W.busy()
        W.handle(io, "1\tls\tMain")
        @test occursin("\"id\":1,\"ok\":false,\"busy\":true", String(take!(io)))
        W.handle(io, "2\tchildren\t1")
        @test occursin("\"busy\":true", String(take!(io)))
        W.inspect(io, 3, "modules", "")   # queued before it started: checked again
        @test occursin("\"busy\":true", String(take!(io)))
        W.handle(io, "4\tping")
        @test occursin("\"id\":4,\"ok\":true", String(take!(io)))   # the rest still answers
    finally
        W.evaluating[] = false
    end
    @test !W.busy()
    W.handle(io, "5\tinterrupt")   # nothing to interrupt (and no signal is sent)
    @test occursin("nothing is running", String(take!(io)))
    W.inspect(io, 6, "ls", "Main")
    @test occursin("\"id\":6,\"ok\":true,\"module\":\"Main\"", String(take!(io)))

    # sent code is marked as running while it runs, and only then
    dir = mktempdir()
    W.EVAL_DIR[] = dir
    write(joinpath(dir, "1.jl"), "Main\n\n1\n\nseen_evaluating = Main.var\"#PulsarIDEWorkspace\".evaluating[]")
    W.run_eval(1)
    @test Base.invokelatest(getglobal, Main, :seen_evaluating) === true   # (a global newer than this code: Julia 1.12)
    @test !W.evaluating[]

    # big modules are cut off
    big = Module(:PulsarBig)
    for i in 1:(W.MAX_MODULE_ITEMS + 50)
        Core.eval(big, :($(Symbol("v", i)) = $i))
    end
    items, more = Base.invokelatest(W.capped_module_items, big)   # (as the helper calls it: names newer than this code)
    @test more
    @test length(items) == W.MAX_MODULE_ITEMS
    @test items[end].truncated
    @test !W.capped_module_items(Main.TestOuter.TestInner)[2]

    # a worker survives errors in a job and interrupts while it waits, and stops when its queue is closed
    done = Int[]
    queue = Channel{Int}(10)
    # (the failing job's warning is expected: kept out of the test output)
    t = Base.CoreLogging.with_logger(Base.CoreLogging.NullLogger()) do
        @async W.worker(n -> (n == 2 && error("job 2 fails"); push!(done, n)), queue, "test")
    end
    yield()
    schedule(t, InterruptException(); error = true)   # arrives while it waits for a job
    yield()
    @test !istaskdone(t)
    put!(queue, 1); put!(queue, 2); put!(queue, 3)
    @test timedwait(() -> length(done) == 2, 10.0) == :ok
    @test done == [1, 3]
    close(queue)
    @test timedwait(() -> istaskdone(t), 10.0) == :ok
end

@testset "watch expressions" begin
    io = IOBuffer()
    W.inspect(io, 1, "ls", "Main")
    take!(io)
    W.inspect(io, 2, "watch", "x + 1")
    @test occursin("{\"id\":2,\"ok\":true,\"items\":[{\"name\":\"x + 1\",\"value\":\"43\"", String(take!(io)))
    W.inspect(io, 3, "watch", "v")
    m = match(r"\"ref\":(\d+)", String(take!(io)))
    @test m !== nothing && parse(Int, m.captures[1]) > 0   # can be expanded like a variable
    W.inspect(io, 4, "watch", "not_defined_anywhere")
    @test occursin("\"id\":4,\"ok\":false,\"error\":\"UndefVarError", String(take!(io)))
    W.inspect(io, 5, "watch", "x +")
    @test occursin("\"ok\":false", String(take!(io)))
    W.inspect(io, 6, "ls", "Main.TestOuter.TestInner")
    take!(io)
    W.inspect(io, 7, "watch", "x")   # in the module the workspace shows
    @test occursin("\"value\":\"1\"", String(take!(io)))
    W.inspect(io, 8, "ls", "Main")
    take!(io)
end

@testset "results for inline display" begin
    dir = mktempdir()
    W.EVAL_DIR[] = dir
    request(id, code; file = "/w/r.jl", line = 1) = (write(joinpath(dir, string(id, ".jl")), join(["Main", file, line, "", code], '\n')); id)
    message(id, code; kw...) = W.result_message(id, W.evaluate_request(request(id, code; kw...); err_io = IOBuffer()), 7)

    m = message(1, "[1, 2, 3]")
    @test startswith(m, "{\"event\":\"result\",\"id\":1,\"ms\":7,\"kind\":\"value\"")
    @test occursin("\"text\":\"[1, 2, 3]\"", m)
    @test occursin("\"full\":\"3-element Vector{Int64}:\\n 1\\n 2\\n 3\"", m)
    @test !occursin("\"full\"", message(2, "1 + 1"))   # nothing more to see
    @test occursin("\"kind\":\"nothing\"", message(3, "nothing"))
    @test occursin("\"kind\":\"nothing\"", message(4, "1 + 1;"))

    m = message(5, "a = 1\nerror(\"boom\")"; file = joinpath(dir, "e.jl"), line = 10)
    @test occursin("\"kind\":\"error\"", m)
    @test occursin("\"text\":\"boom\"", m)
    @test occursin("\"line\":11", m)
    @test occursin("\"full\":\"ERROR: boom", m)
    @test occursin("\"line\":0", message(6, "error(\"elsewhere\")"; file = ""))

    m = message(7, "PulsarPicture()")
    @test occursin("\"kind\":\"image\",\"mime\":\"image/svg+xml\"", m)
    file = joinpath(dir, "result-7.svg")
    @test occursin(sprint(W.jstring, file), m)
    @test read(file, String) == "<svg xmlns=\"http://www.w3.org/2000/svg\"/>"

    # how a request went
    @test W.evaluate_request(request(8, "2 + 2"); err_io = IOBuffer()).status === :ok
    @test W.evaluate_request(99; err_io = IOBuffer()).status === :unreadable
end

# A real package, precompiled into a temporary depot, to check which module its files are evaluated in.
@testset "package files" begin
    depot = mktempdir()
    pkgdir = mktempdir()
    uuid = "6c3f9b2e-1d4a-4e8b-9f0a-2b7c5d8e1a34"
    name = "PulsarProbePkg"
    mkpath(joinpath(pkgdir, "src", "sub"))
    write(joinpath(pkgdir, "Project.toml"), "name = \"$name\"\nuuid = \"$uuid\"\n")
    write(joinpath(pkgdir, "src", "$name.jl"), """
        module $name
        include("utils.jl")
        module Sub
        include("sub/inner.jl")
        end
        end
        """)
    write(joinpath(pkgdir, "src", "utils.jl"), "helper() = 1\n")
    write(joinpath(pkgdir, "src", "sub", "inner.jl"), "inner() = 2\n")
    src(f) = joinpath(pkgdir, "src", f)
    spec = "$uuid $name"
    pushfirst!(DEPOT_PATH, depot)
    push!(LOAD_PATH, pkgdir)
    try
        Base.require(Main, Symbol(name))   # loads it without binding it in Main
        root = Base.root_module(Base.PkgId(Base.UUID(uuid), name))

        @test W.package_root(spec) === root
        @test W.package_root("$uuid Other") === nothing
        @test W.package_root("nonsense $name") === nothing
        @test W.package_root("") === nothing
        @test W.loaded_package(name) === root
        @test W.existing_module("$name.Sub") === root.Sub   # not bound in Main, still found
        @test W.resolve_module("$name.Sub") === root.Sub

        @test W.eval_module("Main", spec, src("utils.jl")) === root
        @test W.eval_module("Main", spec, src("sub/inner.jl")) === root.Sub
        @test W.eval_module("Main.Deeper", spec, src("utils.jl")) === root   # unknown nesting stops at what exists
        @test W.eval_module("Main.$name", spec, src("$name.jl")) === root
        @test W.eval_module("Main.$name.Sub", spec, src("$name.jl")) === root.Sub
        @test W.eval_module("Main", spec, src("$name.jl")) === Main             # before the `module` line
        @test W.eval_module("Main", spec, src("not_included.jl")) === root      # not in the cache: the package

        dir = mktempdir()
        W.EVAL_DIR[] = dir
        write(joinpath(dir, "1.jl"), join(["Main", src("sub/inner.jl"), "1", spec, "probe_value = 7"], '\n'))
        @test W.eval_request(1) == 7
        # The binding is newer than this testset's world: read it in the latest one.
        @test Base.invokelatest(getglobal, root.Sub, :probe_value) == 7
        @test !Base.invokelatest(isdefined, Main, :probe_value)

        Core.eval(Main, :(import $(Symbol(name))))
        names = Base.invokelatest(W.all_modules)   # the helper always runs requests in the latest world
        @test "Main.$name" in names
        @test "Main.$name.Sub" in names
    finally
        popfirst!(DEPOT_PATH)
        filter!(!=(pkgdir), LOAD_PATH)
    end
end

@testset "over a socket" begin
    if Sys.iswindows()
        @info "skipping the socket test on Windows"
    else
        path = joinpath(mktempdir(), "ws.sock")
        server = Sockets.listen(path)
        accepted = @async accept(server)
        W.start(path)
        conn = fetch(accepted)
        # The answer to a request, skipping the announcements that may come in between (kept in `events`).
        events = String[]
        answer(conn) = (line = readline(conn); startswith(line, "{\"event\"") ? (push!(events, line); answer(conn)) : line)

        println(conn, "1\tping")
        @test occursin("\"id\":1,\"ok\":true", answer(conn))

        println(conn, "2\tls\tMain")
        line = answer(conn)
        @test occursin("\"id\":2,\"ok\":true,\"module\":\"Main\"", line)
        @test occursin("\"name\":\"x\",\"value\":\"42\",\"type\":\"Int64\",\"kind\":\"variable\",\"ref\":0", line)
        m = match(r"\"name\":\"v\",\"value\":\"[^\"]*\",\"type\":\"[^\"]*\",\"kind\":\"variable\",\"ref\":(\d+)", line)
        @test m !== nothing

        println(conn, "3\tchildren\t", m.captures[1])
        line = answer(conn)
        @test occursin("\"id\":3,\"ok\":true", line)
        @test occursin("\"name\":\"[2]\",\"value\":\"2\"", line)

        println(conn, "30\tmodules")
        line = answer(conn)
        @test occursin("\"id\":30,\"ok\":true,\"names\":[\"Main\"", line)
        @test occursin("\"Main.TestOuter.TestInner\"", line)

        println(conn, "31\tls\tMain.TestOuter.TestInner")
        line = answer(conn)
        @test occursin("\"module\":\"Main.TestOuter.TestInner\"", line)
        @test occursin("\"name\":\"x\",\"value\":\"1\"", line)

        # watch Main again, the change announcement below is about Main
        println(conn, "32\tls\tMain")
        @test occursin("\"module\":\"Main\"", answer(conn))

        # code to evaluate: answered at once, run by the worker
        evaldir = mktempdir()
        W.EVAL_DIR[] = evaldir
        write(joinpath(evaldir, "7.jl"), "Main.TestOuter\n/w/a.jl\n5\n\npulsar_socket_probe = @__LINE__")
        println(conn, "33\teval\t7")
        @test occursin("\"id\":33,\"ok\":true", answer(conn))
        # (invokelatest: on Julia 1.12+ this code does not see globals created after it started)
        @test timedwait(() -> Base.invokelatest(isdefined, Main.TestOuter, :pulsar_socket_probe), 10.0) == :ok
        @test Base.invokelatest(getglobal, Main.TestOuter, :pulsar_socket_probe) == 5
        println(conn, "34\teval\tnope")
        @test occursin("\"ok\":false", answer(conn))

        # with "result", the result follows when the code has run
        write(joinpath(evaldir, "9.jl"), "Main\n/w/a.jl\n1\n\n40 + 2")
        println(conn, "36\teval\t9 result")
        got = String[]
        while !any(l -> startswith(l, "{\"event\":\"result\""), got)   # (a "busy" event may come in between)
            push!(got, readline(conn))
        end
        @test any(l -> occursin("\"id\":36,\"ok\":true", l), got)
        @test any(l -> occursin("{\"event\":\"result\",\"id\":9,", l) && occursin("\"text\":\"42\"", l), got)

        # a module defined after the helper started is still found (inside TestOuter, so Main's watcher stays quiet)
        Core.eval(Main.TestOuter, :(module PulsarLate end))
        write(joinpath(evaldir, "8.jl"), "Main.TestOuter.PulsarLate\n/w/a.jl\n1\n\nlate_probe = 1")
        println(conn, "35\teval\t8")
        @test occursin("\"id\":35,\"ok\":true", answer(conn))
        late = Base.invokelatest(getglobal, Main.TestOuter, :PulsarLate)
        @test timedwait(() -> Base.invokelatest(isdefined, late, :late_probe), 10.0) == :ok
        @test !Base.invokelatest(isdefined, Main.TestOuter, :late_probe)

        println(conn, "4\tchildren\t99999")
        @test occursin("\"ok\":false", answer(conn))
        println(conn, "5\tdance")
        @test occursin("unknown request", answer(conn))

        # a new variable should be announced (after the announcements of the code run above: the ping's answer
        # comes after them)
        println(conn, "37\tping")
        @test occursin("\"id\":37,\"ok\":true", answer(conn))
        @test any(startswith("{\"event\":\"changed\",\"ms\":"), events)   # sent code is followed by one
        @test "{\"event\":\"busy\"}" in events                                # and announced when it starts
        empty!(events)
        event = Ref("")
        @async event[] = readline(conn)
        @eval Main newvar = 1
        @test timedwait(() -> !isempty(event[]), 10.0) == :ok
        @test event[] == "{\"event\":\"changed\"}"

        # while something runs: "busy", and a fresh announcement when it is free again
        # (skipping any change announcement still on its way)
        empty!(events)
        println(conn, "41\tinterrupt")
        @test occursin("nothing is running", answer(conn))
        W.evaluating[] = true
        println(conn, "40\tls\tMain")
        @test occursin("\"id\":40,\"ok\":false,\"busy\":true", answer(conn))
        sleep(1.5)   # the watcher looks once a second
        W.evaluating[] = false
        @async while true
            line = readline(conn)
            push!(events, line)
            (line == "{\"event\":\"changed\"}" || isempty(line)) && break
        end
        @test timedwait(() -> "{\"event\":\"changed\"}" in events, 10.0) == :ok
        @test "{\"event\":\"busy\"}" in events
        @test findfirst(==("{\"event\":\"busy\"}"), events) < findlast(==("{\"event\":\"changed\"}"), events)

        W.stop()
        close(server)
    end
end
