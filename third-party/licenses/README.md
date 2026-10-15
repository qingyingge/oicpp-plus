# 第三方许可（Third-party licenses）

本目录集中存放**随安装包一起分发**的第三方组件的许可声明全文与汇总清单。

与仓库根目录的 `LICENSE` 分工明确：

- 根目录 `LICENSE` 是 **OICPP-Plus 自身的协议**（GPL-3.0-only），不要拿它充当任何第三方组件的许可。
- 本目录只放第三方组件的许可材料，组件清单见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。

## 目录内容

| 文件 | 覆盖的组件 | 上游来源 |
|------|-----------|---------|
| `llvm-apache-2.0-with-llvm-exception.txt` | `clangd`、`clang-format`（LLVM 项目，Apache-2.0 WITH LLVM-exception） | <https://github.com/llvm/llvm-project/blob/main/llvm/LICENSE.TXT> |
| `THIRD-PARTY-NOTICES.md` | 全部第三方组件的清单、协议与获取正文的位置 | 本文件 |

## 为什么不直接把正文打进二进制包

`clangd` / `clang-format` 的许可要求以二进制形式分发时，随附一份正文副本。Windows 官方安装包（`LLVM-*-win64.exe`）不附带 license 文件，系统 `PATH` 里的那份 LLVM 目录也没有，因此从系统安装目录抽取正文是**不可靠**的。权威来源只有两个：

1. 本目录（随源码版本化，来源为上游 GitHub）。
2. `scripts/download-clangd.js` / `scripts/download-clang-format.js` 解压官方 zip/xz 时抽出的 `LICENSE.TXT`。

两者内容一致；构建脚本以本目录为兜底，避免 1 GB 级重新下载。

## 更新方式

升级 clangd / clang-format 版本后，**必须**同步替换本目录的 LLVM 正文：

```powershell
Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/llvm/llvm-project/main/llvm/LICENSE.TXT' -OutFile 'third-party\licenses\llvm-apache-2.0-with-llvm-exception.txt'
```

注意保持 LF 行尾、UTF-8 无 BOM（NSIS 打包与 `installer.nsi` 的 `/oname` 目标名都按这个约定处理）。

若新增/移除了第三方组件，记得同步更新 `THIRD-PARTY-NOTICES.md` 以及 `src/renderer/js/main.js` 里 `showOpenSourceLicenses()` 的列表 —— 两者由 `tests/third-party-licenses.test.js` 强制保持一致。
