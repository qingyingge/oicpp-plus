# 第三方组件声明（THIRD PARTY NOTICES）

OICPP-Plus 使用了下列第三方开源软件。本文件是**清单与来源说明**，许可正文见同目录（`llvm-apache-2.0-with-llvm-exception.txt`）或各项目自身的分发包。

版本列为 `package.json` 中声明的版本范围，随依赖升级自动跟随；许可正文请以上游仓库为准。

## 1. 随安装包分发的独立二进制

这两项是**以二进制形式重新分发**的第三方组件，许可要求随附正文副本，因此正文收录在本目录。

| 组件 | 版本 | 协议 | 正文 | 上游 |
|------|------|------|------|------|
| LLVM `clangd` | 23.1.0 | Apache-2.0 WITH LLVM-exception | [`llvm-apache-2.0-with-llvm-exception.txt`](./llvm-apache-2.0-with-llvm-exception.txt) | <https://clangd.llvm.org/> |
| LLVM `clang-format` | 23.1.2 | Apache-2.0 WITH LLVM-exception | [`llvm-apache-2.0-with-llvm-exception.txt`](./llvm-apache-2.0-with-llvm-exception.txt) | <https://clang.llvm.org/docs/ClangFormat.html> |
| `electron` | `>=37.0.0 <45.0.0` | MIT | `node_modules/electron/LICENSE` | <https://github.com/electron/electron> |

## 2. 运行时依赖（进入 `node_modules/**/*` 并打进安装包）

| 组件 | 版本 | 协议 | 上游 |
|------|------|------|------|
| `7zip-bin` | `^5.2.0` | MIT | <https://github.com/develar/7zip-bin> |
| `@iktakahiro/markdown-it-katex` | `^4.0.1` | MIT | <https://github.com/iktakahiro/markdown-it-katex> |
| `@xterm/addon-fit` | `^0.11.0` | MIT | <https://github.com/xtermjs/xterm.js> |
| `@xterm/addon-unicode11` | `^0.9.0` | MIT | <https://github.com/xtermjs/xterm.js> |
| `@xterm/xterm` | `^6.0.0` | MIT | <https://github.com/xtermjs/xterm.js> |
| `axios` | `^1.20.0` | MIT | <https://github.com/axios/axios> |
| `extract-zip` | `^2.0.1` | BSD-2-Clause | <https://github.com/maxogden/extract-zip> |
| `highlight.js` | `^11.12.0` | BSD-3-Clause | <https://github.com/highlightjs/highlight.js> |
| `i18next` | `^26.4.4` | MIT | <https://github.com/i18next/i18next> |
| `iconv-lite` | `^0.7.3` | MIT | <https://github.com/ashtuchkin/iconv-lite> |
| `katex` | `^0.19.0` | MIT | <https://github.com/KaTeX/KaTeX> |
| `markdown-it` | `^15.0.2` | MIT | <https://github.com/markdown-it/markdown-it> |
| `markdown-it-image-figures` | `^2.1.1` | MIT | <https://github.com/Antonio-Laguna/markdown-it-image-figures> |
| `markdown-it-task-lists` | `^2.1.1` | ISC | <https://github.com/revin/markdown-it-task-lists> |
| `monaco-editor` | `>=0.30.0 <1.0.0` | MIT | <https://github.com/microsoft/monaco-editor> |
| `node-pty` | `>=1.0.0 <2.0.0` | MIT | <https://github.com/nicely-bot/node-pty> |
| `node-stream-zip` | `^1.16.0` | MIT | <https://github.com/antelle/node-stream-zip> |
| `pdfjs-dist` | `6.4.299` | Apache-2.0 | <https://github.com/mozilla/pdf.js> |
| `turndown` | `^7.2.4` | MIT | <https://github.com/mixmark-io/turndown> |
| `winreg` | `^1.2.5` | BSD-2-Clause | <https://github.com/fresc81/node-winreg> |

## 3. 构建期依赖（`package.json` 的 `devDependencies`）

`package.json` 的 `build.files` 已通过 `!node_modules/...` 排除以下各项，**不进入安装包**，列出仅为供应链审计完整。

| 组件 | 版本 | 协议 | 上游 |
|------|------|------|------|
| `@types/node` | `^26.6.5` | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped> |
| `electron-builder` | `^26.15.3` | MIT | <https://github.com/electron-userland/electron-builder> |
| `html-webpack-plugin` | `^5.6.8` | MIT | <https://github.com/jantimon/html-webpack-plugin> |
| `icojs` | `^1.0.1` | MIT | <https://github.com/nicely-bot/icojs> |
| `monaco-editor-webpack-plugin` | `^7.1.1` | MIT | <https://github.com/microsoft/monaco-editor> |
| `sharp` | `^0.35.5` | Apache-2.0 | <https://github.com/lovell/sharp> |
| `typescript` | `7.0.2` | Apache-2.0 | <https://github.com/microsoft/TypeScript> |
| `webpack` | `^5.111.1` | MIT | <https://github.com/webpack/webpack> |
| `webpack-cli` | `^7.2.3` | MIT | <https://github.com/webpack/webpack-cli> |

## 4. 一致性要求

第 2、3 节的组件集合必须与 `package.json` 的 `dependencies` / `devDependencies` 一致；
第 1 节的 `clangd` / `clang-format` 必须在 `src/renderer/js/main.js` 的 `showOpenSourceLicenses()` 列表中同样出现。
两者由 `tests/third-party-licenses.test.js` 强制校验，改依赖时改这里也要改那里。
