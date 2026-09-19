# OICPP-Plus IDE — Project Overview

## Type
Electron desktop app (JS), for competitive programming.

## Entry
`src/main.js`

## Package manager
pnpm@11.7.0

## Key scripts
| Script | Command |
|--------|---------|
| `start` | `electron .` |
| `dev` | `electron . --dev` |
| `build` | prebuild steps + electron-builder |
| `ci` | `powershell -ExecutionPolicy Bypass -File scripts/ci-local.ps1` |

## CI / Verification
No lint/typecheck/test scripts. Only CI is `pnpm run ci` — runs `scripts/ci-local.ps1` which does static analysis (JS syntax, CSS brace matching, HTML DOCTYPE, file reference resolution, IPC channels, DOM selectors, CSP, secrets/eval scanning, dependency audit, etc.) and an Electron smoke test.

## Structure
```
src/
  main.js              — Electron main process entry
  preload.js           — preload script
  main-process/        — main process modules
  renderer/            — renderer (HTML/JS/CSS)
    index.html
    css/
    js/
  lang/                — language definitions
  utils/               — utilities
scripts/
  ci-local.ps1         — CI checks
```

## Key dependencies
- electron ^37.x
- monaco-editor, xterm, node-pty
- markdown-it, katex, highlight.js
- axios, iconv-lite, winreg
- electron-builder (dev)

## Conventions
- No test framework in use.
- CI check = `pnpm run ci` only.
- CSP allows `unsafe-eval` (Monaco needs it).
- No GitHub Actions / GitLab CI / Docker.