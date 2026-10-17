#!/usr/bin/env node
// Terminal setup helper for Rice Accounts: node account-setup.mjs --config-dir <folder> <saved name>
//
// This entry is deliberately written in ES5 syntax with no static imports, so
// that an old Node.js (12 to 21) reaches the version check below and prints a
// clear message instead of a SyntaxError or ERR_UNKNOWN_BUILTIN_MODULE. Only
// a supported Node.js loads the implementation in account-setup-main.mjs.
var REQUIRED_MAJOR = 22
var found = String(process && process.versions && process.versions.node || 'unknown')
var major = parseInt(found.split('.')[0], 10)

function fail(text) {
  process.stderr.write('rice-session-accounts: ' + text + '\n')
  process.exitCode = 1
}

if (!(major >= REQUIRED_MAJOR)) {
  fail('Node.js ' + REQUIRED_MAJOR + ' or newer is required (found ' + found + '). Install a current Node.js LTS release, open a new terminal, then rerun this command.')
} else {
  import('./account-setup-main.mjs').then(function (implementation) {
    return implementation.main(process.argv.slice(2))
  }, function (error) {
    fail('The setup helper could not load account-setup-main.mjs (' + (error && error.code || 'load error') + '). Update or reinstall the plugin, then rerun this command.')
  })
}
