const Path = require('path');
const {
  AutoLanguageClient,
  CommandExecutionAdapter
} = require('@savetheclocktower/atom-languageclient');

const ROOT = Path.normalize(Path.join(__dirname, '..'));

//TODO fix CODE_ACTION_KINDS and DIAGNOSTIC_CODES_IGNORED_IN_JULIA to reflect
// Julia LSP capabilities...
// The Julia server won't suggest any of these kinds of code actions
// unless you specifically ask for them.
const CODE_ACTION_KINDS = [
  'quickfix',
  'refactor',
  'refactor.extract',
  'refactor.inline',
  'refactor.rewrite',
  'source',
  'source.organizeImports',
  'source.fixAll'
];

const DIAGNOSTIC_CODES_IGNORED_IN_JULIA = [
  // Warns about usage of `require`.
  "80001",

  // Warns about lack of type files in imports.
  "7016",

  // Warns about "any" type.
  "7006"
];



class JuliaLanguageClient extends AutoLanguageClient {
  activate (...args) {
    super.activate(...args);
    let packageName = this.getPackageName();

    this.commandDisposable = atom.commands.add(
      'atom-workspace',
      {
        [`${packageName}:start-language-server`]: () => {
          // This command doesn't do anything on its own. Its purpose is to
          // start the language server manually when the user wants to use it
          // for non-Julia files.
          //
          // It'd be rude to start the language server 100% of the time, and
          // there's no way to programmatically add to the list of
          // `activationHooks` present in `package.json`, so the compromise
          // option is to provide automatic startup for Julia files and
          // ask the user to invoke startup for everything else.
          console.debug(`Starting language server...`);
        },
        [`${packageName}:organize-imports`]: async (event) => {
          let editor = atom.workspace.getActiveTextEditor();
          let connection = await this.getConnectionForEditor(editor);
          if (!connection) {
            event.abortKeyBinding();
            return;
          }

          let path = editor.getPath();
          return await CommandExecutionAdapter.executeCommand(
            connection,
            '_julia.organizeImports',
            [path]
          );
        }
      }
    );
  }

  destroy (...args) {
    super.destroy(...args);
    this.commandDisposable.dispose();
  }


  getGrammarScopes () {
    return ['source.julia']
  }

  getLanguageName () {
    return 'Julia'
  }

  getServerName () {
    return 'Juno'
  }

  getPackageName () {
    return Path.basename(ROOT) ?? 'pulsar-ide-julia';
  }

  getKindsForCodeActionRequest (_editor, _range, diagnostics) {
    // If there are any diagnostic messages associated with this position in
    // the editor, don't add any kinds. The only things that should appear in
    // the menu are actions associated with fixing that diagnostic.
    if (diagnostics.length > 0) return [];

    // Otherwise the user has asked for code actions in some other section of
    // the editor that has no diagnostic message. We should present them with
    // all the possible actions they can do on this file.
    return CODE_ACTION_KINDS;
  }

  constructor () {
    super();
  }

  async startServerProcess () {
    return super.spawn(atom.config.get('pulsar-ide-julia.jlpath'), [path.resolve(__dirname, '..', 'script', 'boot.jl')])
  }

  // INTENTIONS
  // ==========

  // This is annoying because it should be almost entirely a package-specific
  // concern. But `atom-languageclient` must be aware of this because there's
  // no concept of a “code” or “message type” in the `linter` service contract.
  // So we can't pull this off just by inspecting the linter messages; we have
  // to look at the original `Diagnostic` objects from the language server.
  getIntentionsForLinterMessage ({ code, callback }, editor) {
    let packageName = this.getPackageName();
    const IGNORED_CODES_NAME = `${packageName}.linter.ignoredCodes`;
    const IGNORED_UNTIL_SAVE_NAME = `${packageName}.linter.ignoredCodesWhenBufferIsModified`;
    let intentions = [];
    let settings = this.getLinterSettings(editor);
    let {
      ignoredCodes = [],
      ignoredCodesWhenBufferIsModified = []
    } = settings;

    // What are the existing ignore settings for this kind of message?
    let isAlwaysIgnored = ignoredCodes.includes(code);
    let isIgnoredUntilSave = ignoredCodesWhenBufferIsModified.includes(code);

    if (!isAlwaysIgnored) {
      intentions.push({
        priority: 1,
        icon: 'mute',
        title: `Always ignore this type of message (${code})`,
        selected: () => {
          let ignoredCodes = atom.config.get(IGNORED_CODES_NAME);
          let ignoredUntilSave = atom.config.get(IGNORED_UNTIL_SAVE_NAME);
          if (ignoredUntilSave.includes(code)) {
            let index = ignoredUntilSave.indexOf(code);
            ignoredUntilSave.splice(index, 1);
          }
          atom.config.set(IGNORED_CODES_NAME, [...ignoredCodes, code]);
          callback();
        }
      });
    }

    if (!isIgnoredUntilSave) {
      intentions.push({
        priority: 1,
        icon: 'mute',
        title: `Always ignore this type of message until save (${code})`,
        selected: () => {
          let ignoredUntilSave = atom.config.get(IGNORED_UNTIL_SAVE_NAME);
          let ignoredCodes = atom.config.get(IGNORED_CODES_NAME);
          if (ignoredCodes.includes(code)) {
            let index = ignoredCodes.indexOf(code);
            ignoredCodes.splice(index, 1);
          }
          atom.config.set(IGNORED_UNTIL_SAVE_NAME, [...ignoredUntilSave, code]);
          callback();
        }
      });
    }

    return intentions;
  }

}


module.exports = new JuliaLanguageClient();
