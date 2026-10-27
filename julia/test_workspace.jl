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
