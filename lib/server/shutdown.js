// Quitting Pulsar (or closing a window) keeps the window on screen until every package has deactivated. By then the
// grammar packages are gone, so open Julia files show as plain text, and the language client would still be waiting
// for JETLS to answer its `shutdown` request. The whole process is going away, so the servers are stopped at once
// instead (they are still sent `exit`, then their processes are killed).
//
// `serverManager` is the fork's ServerManager (AutoLanguageClient#_serverManager), whose `shutdownGracefully` field
// stopServer() reads when it runs. `environment` is `atom`: Pulsar sets `atom.unloading` before it deactivates the
// packages of a closing window. Disabling the package or restarting the server still shuts down gracefully.
function stopQuicklyIfClosing(serverManager, environment) {
  if (!serverManager || !environment || !environment.unloading) return false;
  serverManager.shutdownGracefully = false;
  return true;
}

module.exports = { stopQuicklyIfClosing };
