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

        println(conn, "1\tping")
        @test occursin("\"id\":1,\"ok\":true", readline(conn))

        println(conn, "2\tls\tMain")
        line = readline(conn)
        @test occursin("\"id\":2,\"ok\":true,\"module\":\"Main\"", line)
        @test occursin("\"name\":\"x\",\"value\":\"42\",\"type\":\"Int64\",\"kind\":\"variable\",\"ref\":0", line)
        m = match(r"\"name\":\"v\",\"value\":\"[^\"]*\",\"type\":\"[^\"]*\",\"kind\":\"variable\",\"ref\":(\d+)", line)
        @test m !== nothing

        println(conn, "3\tchildren\t", m.captures[1])
        line = readline(conn)
        @test occursin("\"id\":3,\"ok\":true", line)
        @test occursin("\"name\":\"[2]\",\"value\":\"2\"", line)

        println(conn, "30\tmodules")
        line = readline(conn)
        @test occursin("\"id\":30,\"ok\":true,\"names\":[\"Main\"", line)
        @test occursin("\"Main.TestOuter.TestInner\"", line)

        println(conn, "31\tls\tMain.TestOuter.TestInner")
        line = readline(conn)
        @test occursin("\"module\":\"Main.TestOuter.TestInner\"", line)
        @test occursin("\"name\":\"x\",\"value\":\"1\"", line)

        # watch Main again, the change announcement below is about Main
        println(conn, "32\tls\tMain")
        @test occursin("\"module\":\"Main\"", readline(conn))

        # code to evaluate: answered at once, run by the worker
        evaldir = mktempdir()
        W.EVAL_DIR[] = evaldir
        write(joinpath(evaldir, "7.jl"), "Main.TestOuter\n/w/a.jl\n5\n\npulsar_socket_probe = @__LINE__")
        println(conn, "33\teval\t7")
        @test occursin("\"id\":33,\"ok\":true", readline(conn))
        @test timedwait(() -> isdefined(Main.TestOuter, :pulsar_socket_probe), 10.0) == :ok
        @test Main.TestOuter.pulsar_socket_probe == 5
        println(conn, "34\teval\tnope")
        @test occursin("\"ok\":false", readline(conn))

        # a module defined after the helper started is still found (inside TestOuter, so Main's watcher stays quiet)
        Core.eval(Main.TestOuter, :(module PulsarLate end))
        write(joinpath(evaldir, "8.jl"), "Main.TestOuter.PulsarLate\n/w/a.jl\n1\n\nlate_probe = 1")
        println(conn, "35\teval\t8")
        @test occursin("\"id\":35,\"ok\":true", readline(conn))
        late = Base.invokelatest(getglobal, Main.TestOuter, :PulsarLate)
        @test timedwait(() -> Base.invokelatest(isdefined, late, :late_probe), 10.0) == :ok
        @test !Base.invokelatest(isdefined, Main.TestOuter, :late_probe)

        println(conn, "4\tchildren\t99999")
        @test occursin("\"ok\":false", readline(conn))
        println(conn, "5\tdance")
        @test occursin("unknown request", readline(conn))

        # a new variable should be announced
        event = Ref("")
        @async event[] = readline(conn)
        @eval Main newvar = 1
        @test timedwait(() -> !isempty(event[]), 10.0) == :ok
        @test event[] == "{\"event\":\"changed\"}"

        W.stop()
        close(server)
    end
end
