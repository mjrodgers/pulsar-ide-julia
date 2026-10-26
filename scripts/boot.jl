using LanguageServer
using SymbolServer

conn_in = stdin
conn_out = stdout
env = ""
depot = DEPOT_PATH
err = nothing
symstore = nothing
dl = true
symupstream = nothing


server = LanguageServerInstance(
    conn_in, #pipe_in
    conn_out, #pipe_out
    env, #env_path
    depot, #depot_path
    err, #err_handler
    symstore, #symserver_store_path
    dl, #download
    symupstream #symbolcache_upstream
)

run(server)
