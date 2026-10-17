# Contributing

Thanks for helping. This plugin runs inside ordinary Claude Code and handles OAuth credentials, so
changes are held to the checks and rules below. Usage and behavior are documented in the
[README](README.md).

## Requirements

- Node.js 22 or newer (`engines` in `package.json`). The repository has no runtime dependencies and
  no lockfile.
- Claude Code on `PATH` for the plugin tests and strict validation. CI covers 2.1.296, 2.1.299,
  2.1.301 and 2.1.302.
- Git, for the diff and dash checks.
- Optional: `actionlint` to lint `.github/workflows/`.

The auth proofs bind to Claude Code 2.1.301 exactly. Point them at that executable with
`RICE_ACCOUNTS_PROOF_CLAUDE` when your `PATH` has a different version. Install a pinned copy
outside the repository, for example:

```sh
npm install --prefix "${TMPDIR:-/tmp}/claude-2.1.301" --no-audit --no-fund @anthropic-ai/claude-code@2.1.301
export RICE_ACCOUNTS_PROOF_CLAUDE="${TMPDIR:-/tmp}/claude-2.1.301/node_modules/.bin/claude"
```

## Running the checks

Run everything from the repository root.

| Command | What it covers |
| --- | --- |
| `npm test` | Every `tests/**/*.test.mjs` unit test with Node's built-in runner (terminal setup helper, credential files). |
| `npm run test:plugin` | `claude plugin test .`: the `*.test.ts` and `*.test.tsx` suites against the real mod runtime. |
| `npm run typecheck` | TypeScript 6.0.3 over `hooks/`, `types/` and `tests/` against the declarations of the installed Claude Code (fetched from its own authoring skill; no account or inference). |
| `npm run check:dashes` | Fails on an en dash or em dash in any tracked text file and lists file, line and column. |
| `npm run check:compat` | `test`, `test:plugin`, `claude plugin validate --strict .`, `check:dashes`, `git diff --check` and `git diff --cached --check`. Works on any supported Claude Code version. |
| `npm run test:auth` | The ordinary-Claude proofs: `scripts/proof-public-auth.mjs` (environment token and native storage baselines) and `npm run test:bash`. Needs Claude Code 2.1.301 or 2.1.302. |
| `npm run test:bash` | `scripts/proof-public-bash.mjs`: the real-binary proof for the Bash path. |
| `npm run test:keychain` | `scripts/proof-macos-keychain.mjs`: the macOS keychain adapter. It skips unless it runs on darwin with `GITHUB_ACTIONS=true` and `RICE_ACCOUNTS_PROOF_KEYCHAIN=1`, so it never touches a developer keychain; CI runs it. |
| `npm run check` | `check:compat`, then `typecheck`, then `test:auth`. This is the full local gate and needs Claude Code 2.1.301 or 2.1.302. |

`typecheck` loads the `plugin-authoring` skill in a throwaway session pointed at a local refusal
server (so a model request would fail loudly), reads the declaration file the skill names, and
runs TypeScript 6.0.3 over the repository. TypeScript is deliberately not a dependency; `npm exec`
downloads the pinned version on demand. Set `RICE_ACCOUNTS_PROOF_CLAUDE` to check against a specific
Claude Code binary. Older engines (2.1.296 and 2.1.299) are covered by `check:compat` only, because
their declarations predate APIs the code uses.

Native Windows storage is checked by `node scripts/proof-windows-storage.mjs` on a Windows machine.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests, pushes to `main` and manual dispatch with a
read-only token and no secrets. It runs `check:compat` on Linux for each supported Claude Code
version, the full `check` on 2.1.301, a macOS job with the keychain proof, and a native Windows job
including the Windows storage proof. Pull requests from forks run on GitHub-hosted runners only.
Lint workflow changes with `actionlint`; `.github/actionlint.yaml` declares the shared runner label.

## Rules

- No launcher, preload, wrapper binary or gateway. The plugin works in ordinary `claude` through
  its hooks and public APIs only, and must not install files outside the plugin and Claude's own
  configuration. The earlier launcher design was withdrawn and its code removed; do not add a
  replacement.
- No Python anywhere in the repository, including one-line helpers and test fixtures. Use Node.js,
  shell or a supported CLI.
- No em dash or en dash in any tracked file. Use a hyphen, comma, semicolon, colon or parentheses.
  `npm run check:dashes` enforces this locally and in CI.
- Credentials in tests are synthetic fixtures. Never use, copy or commit a real token, refresh
  token, keychain item or account. Proofs run in a temporary home directory against a local HTTP
  server, and tests must not read the developer's real Claude configuration. Do not print
  credential values in logs or failure messages.
- Keep personal data out of the repository: no real names, emails, hostnames, IP addresses,
  absolute home paths or session identifiers. Use `example.test` addresses and made-up paths.
- Add no runtime dependencies.
- Code adapted from another project keeps a header naming the upstream path and pinned commit and
  stating that it was modified. Add the project and its license text to
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `LICENSES/`.
- Anything under the plugin directory ships to every user, because the marketplace installs from
  a clone of this repository. Keep development-only material out of the tree rather than relying
  on `.gitattributes` export rules, which do not affect a clone.

## Pull requests

Describe the behavior change and the checks you ran. `npm run check:compat` should pass locally;
run the full `npm run check` when you touch authentication, credential storage or session switching.
Keep commits focused and do not mix unrelated formatting changes into a fix.

## Releases

1. Update the version in `.claude-plugin/plugin.json`, the changelog and the verification note for
   the release under `docs/verification/`.
2. Open a pull request and wait for CI to pass on every job. Run `npm run check` locally against
   Claude Code 2.1.301 as well.
3. Merge to `main` and confirm CI is green on the release commit before tagging.
4. Tag that commit `rice-session-accounts--vX.Y.Z` (for example `rice-session-accounts--v0.5.0`)
   and push the tag. The tag version must equal the version in `plugin.json`.
