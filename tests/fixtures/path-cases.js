'use strict';

// Path identity / containment test corpus.
//
// Data only -- no assertions, no filesystem writes. tests/path-identity.test.js
// builds a sandbox, walks this list and evaluates each case against
// src/utils/path-identity.js.
//
// Every case declares its platform scope explicitly, because the whole
// point of the module is that "the same string" means different things on
// different volumes:
//
//   platforms: ['win32'] | ['posix']   -- case is only meaningful there
//   expect: 'in' | 'out' | 'same' | 'diff' | 'bool'
//            or { win32: ..., posix: ... } when the volume decides
//   needs: 'symlink'                     -- skipped when the sandbox cannot
//                                          create one (win32 without
//                                          developer mode / junction rights)
//
// ctx provided by the runner:
//   c.root     -- the boundary root, <sandbox>/root
//   c.sandbox  -- <sandbox>, parent of root and of every sibling dir
//   c.outside  -- <sandbox>/outside, used as a symlink escape target
//   c.rootLink -- <sandbox>/root-link, a symlink pointing at root
//   c.exists(p) / c.canSymlink

const path = require('path');

const j = (...parts) => path.join(...parts);

const CASES = [

    // ---- 1. basics: equal, nested, ".." -------------------------------------
    { id: 'base/self', desc: 'root 自身', expect: 'in', target: (c) => c.root },
    { id: 'base/child', desc: '直接子级', expect: 'in', target: (c) => j(c.root, 'a') },
    { id: 'base/deep', desc: '深层嵌套', expect: 'in', target: (c) => j(c.root, 'a', 'b', 'c.txt') },
    { id: 'base/dot', desc: '含 . 分量', expect: 'in', target: (c) => j(c.root, '.', 'a') },
    { id: 'base/dotdot-mid', desc: '中途 ..', expect: 'in', target: (c) => j(c.root, 'a', '..', 'b') },
    { id: 'base/dotdot-roundtrip', desc: '绕出去再绕回来，仍在 root 内', expect: 'in', target: (c) => j(c.root, 'a', '..', '..', 'root', 'b') },
    { id: 'base/dotdot-escape', desc: '出去后没回来', expect: 'out', target: (c) => j(c.root, '..', 'root2', 'b') },
    { id: 'base/empty', desc: '空字符串', expect: 'bool', target: () => '' },
    { id: 'base/null', desc: 'null', expect: 'bool', target: () => null },
    { id: 'base/undefined', desc: 'undefined', expect: 'bool', target: () => undefined },
    { id: 'base/number', desc: '非字符串（数字）', expect: 'bool', target: () => 123 },
    { id: 'base/object', desc: '非字符串（对象）', expect: 'bool', target: () => ({}) },
    { id: 'base/array', desc: '非字符串（数组）', expect: 'bool', target: () => [] },

    // ---- 2. sibling dirs sharing the prefix (string-prefix bugs) -----------
    { id: 'sibling/evil', desc: 'codeTemp -> codeTempEvil', expect: 'out', target: (c) => j(c.sandbox, 'rootEvil', 'x') },
    { id: 'sibling/underscore', desc: '下划线后缀', expect: 'out', target: (c) => j(c.sandbox, 'root_old', 'x') },
    { id: 'sibling/digit', desc: '数字后缀', expect: 'out', target: (c) => j(c.sandbox, 'root2', 'x') },
    { id: 'sibling/dot-suffix', desc: '点后缀 root.bak', expect: 'out', target: (c) => j(c.sandbox, 'root.bak', 'x') },
    { id: 'sibling/space-suffix', desc: '空格后缀 root backup', expect: 'out', target: (c) => j(c.sandbox, 'root backup', 'x') },
    { id: 'sibling/trailing-slash-sibling', desc: '同前缀且带尾部斜杠的兄弟', expect: 'out', target: (c) => j(c.sandbox, 'rootEvil') + path.sep },

    // ---- 3. case: the volume decides --------------------------------------
    { id: 'case/upper-root', desc: 'root 被换成全大写（边界判定不看大小写 => posix 判外部）', expect: { win32: 'in', posix: 'out' }, target: (c) => c.root.toUpperCase() },
    { id: 'case/upper-root-with-child', desc: '全大写 root + 子路径', expect: { win32: 'in', posix: 'out' }, target: (c) => j(c.root.toUpperCase(), 'a') },
    { id: 'case/child-case-ok', desc: '子分量大小写不同不影响「在 root 内」的判定', expect: 'in', target: (c) => j(c.root, 'A') },
    { id: 'case/drive-letter', desc: '盘符大小写', platforms: ['win32'], expect: 'in', target: (c) => c.root[0].toLowerCase() + c.root.slice(1) },
    { id: 'case/sibling-case', desc: '兄弟目录仅大小写不同', platforms: ['posix'], expect: 'out', target: (c) => j(c.sandbox, 'ROOT') },

    // ---- 4. separator shapes ------------------------------------------------
    { id: 'sep/backslash-win', desc: 'win32 下的正斜杠', platforms: ['win32'], expect: 'in', target: (c) => c.root.replace(/\\/g, '/') + '/a' },
    { id: 'sep/backslash-is-filename', desc: 'posix 下 \\ 是合法文件名字符，仍在 root 内', platforms: ['posix'], expect: 'in', target: (c) => j(c.root, 'a\\b') },
    { id: 'sep/double', desc: '重复斜杠', expect: 'in', target: (c) => c.root + '//a///b' },
    { id: 'sep/trailing', desc: '尾部斜杠', expect: 'in', target: (c) => j(c.root, 'a') + path.sep },
    { id: 'sep/unc', desc: 'UNC 路径', platforms: ['win32'], expect: 'out', target: () => '\\\\server\\share\\a' },
    { id: 'sep/extended-length', desc: '扩展长度前缀不得崩（返回形态由 Node 决定，不做形态断言）', platforms: ['win32'], expect: 'bool', target: (c) => '\\\\?\\' + j(c.root, 'a') },
    { id: 'sep/extended-unc', desc: '扩展长度 UNC', platforms: ['win32'], expect: 'out', target: () => '\\\\?\\UNC\\server\\share\\a' },
    { id: 'sep/rooted-no-drive', desc: '无盘符 rooted 路径（按当前盘解析）', platforms: ['win32'], expect: 'out', target: () => '\\root\\a' },
    { id: 'sep/drive-relative', desc: '盘符相对路径（按 cwd 解析）', platforms: ['win32'], expect: 'out', target: () => 'C:\\root\\a' },
    { id: 'sep/posix-double-slash', desc: 'posix 的 // 前缀语义未定义，按普通绝对路径处理', platforms: ['posix'], expect: 'out', target: () => '//root/a' },

    // ---- 5. symlinks: string normalisation cannot help here ---------------
    { id: 'link/inside', desc: '软链指向 root 内部', needs: 'symlink', expect: 'in', target: (c) => j(c.root, 'link', 'f.txt') },
    { id: 'link/escape', desc: '软链逃逸到 sandbox 外', needs: 'symlink', expect: 'out', target: (c) => j(c.root, 'escape', 'passwd') },
    { id: 'link/escape-dir', desc: '软链指向 sandbox 外目录', needs: 'symlink', expect: 'out', target: (c) => j(c.root, 'escapeOut') },
    { id: 'link/deep-escape', desc: '嵌套软链逃逸', needs: 'symlink', expect: 'out', target: (c) => j(c.root, 'a', 'escapeOut') },
    { id: 'link/root-itself', desc: 'root 本身是软链，两侧都解析后应相等', needs: 'symlink', expect: 'in', target: (c) => j(c.rootLink, 'a') },
    { id: 'link/dangling', desc: '断链不得抛', needs: 'symlink', expect: 'bool', target: (c) => j(c.root, 'dangling', 'nope.txt') },
    { id: 'link/loop', desc: '环形软链（ELOOP）fail-closed', needs: 'symlink', expect: 'bool', target: (c) => j(c.root, 'loopA', 'x') },
    { id: 'link/through-existing-sibling', desc: '经软链指向同前缀兄弟目录仍判为外部', needs: 'symlink', expect: 'out', target: (c) => j(c.root, 'toEvil', 'x') },

    // ---- 6. win32-only path quirks -----------------------------------------
    { id: 'win32/trailing-dot', desc: '尾部点被系统剥离', platforms: ['win32'], expect: 'in', target: (c) => j(c.root, 'a.') },
    { id: 'win32/trailing-space', desc: '尾部空格被系统剥离', platforms: ['win32'], expect: 'in', target: (c) => j(c.root, 'a ') },
    { id: 'win32/short-name', desc: '8.3 短名（PROGRA~1）需在两侧都还原为长名', platforms: ['win32'], skipIf: (c) => !c.hasShortNames, skip: '该卷未启用 8.3 短名', expect: 'in', target: () => 'C:\\PROGRA~1\\oicpp-path-probe', root: () => 'C:\\PROGRA~1' },
    { id: 'win32/device-con', desc: '设备名 CON 不是文件', platforms: ['win32'], expect: 'out', target: (c) => j(c.root, 'CON') },
    { id: 'win32/device-nul', desc: '设备名 NUL 不是文件', platforms: ['win32'], expect: 'out', target: (c) => j(c.root, 'NUL') },
    { id: 'win32/device-aux', desc: '设备名 AUX 不是文件', platforms: ['win32'], expect: 'out', target: (c) => j(c.root, 'AUX') },
    { id: 'win32/device-com1', desc: '设备名 COM1 不是文件', platforms: ['win32'], expect: 'out', target: (c) => j(c.root, 'COM1') },
    { id: 'win32/ads', desc: '备用数据流 a.txt:stream（命名合法性由别处把关，这里只要求不崩）', platforms: ['win32'], expect: 'bool', target: (c) => j(c.root, 'a.txt:stream') },

    // ---- 7. macOS-only symlinked system dirs -------------------------------
    { id: 'mac/tmp-vs-private-tmp', desc: '/tmp 与 /private/tmp 是同一目录', platforms: ['darwin'], skipIf: (c) => !c.tmpIsSymlink, skip: '/tmp 不是符号链接', expect: 'in', target: () => '/tmp/oicpp-path-probe' },
    { id: 'mac/var-vs-private-var', desc: '/var 与 /private/var 是同一目录', platforms: ['darwin'], skipIf: (c) => !c.varIsSymlink, skip: '/var 不是符号链接', expect: 'in', target: () => '/var/oicpp-path-probe' },

    // ---- 8. non-existent targets (ancestor fallback) -----------------------
    { id: 'missing/deep-new-file', desc: 'root 下的新文件', expect: 'in', target: (c) => j(c.root, 'notexist', 'deep', 'x.cpp') },
    { id: 'missing/already-deleted', desc: '已删除的临时文件重放', expect: 'in', target: (c) => j(c.root, 'codeTemp', 'std_1.exe') },
    { id: 'missing/whole-tree', desc: '整条路径都不存在', expect: 'out', target: () => path.join(path.parse(process.cwd()).root, 'no', 'such', 'dir', 'x') },
    { id: 'missing/through-file', desc: '父分量其实是文件（ENOTDIR）', expect: 'bool', target: (c) => j(c.root, 'a', 'b', 'c.txt', 'child') },
    { id: 'missing/root-missing', desc: 'root 本身不存在时不得抛', expect: 'bool', target: (c) => j(c.root, 'x'), root: (c) => j(c.sandbox, 'no-such-root') },
    { id: 'missing/inside-sibling-new', desc: '兄弟目录下的新文件', expect: 'out', target: (c) => j(c.sandbox, 'rootEvil', 'new', 'x.cpp') },

    // ---- 9. odd / hostile inputs (must not throw) --------------------------
    { id: 'odd/space', desc: '空格', expect: 'in', target: (c) => j(c.root, 'a b', 'c d.txt') },
    { id: 'odd/cjk', desc: '中文路径', expect: 'in', target: (c) => j(c.root, '中文', '文件.cpp') },
    { id: 'odd/quotes', desc: '单双引号', expect: 'in', target: (c) => j(c.root, 'a\'b"c.txt') },
    { id: 'odd/shell-meta', desc: 'shell 元字符', expect: 'in', target: (c) => j(c.root, 'a&b|c;d$.txt') },
    { id: 'odd/encoded-dotdot', desc: '编码的 .. 未解码前只是普通文件名', expect: 'in', target: (c) => j(c.root, 'a%2e%2e', 'b') },
    { id: 'odd/percent', desc: '路径里的百分号', expect: 'in', target: (c) => j(c.root, '100%', 'a') },
    { id: 'odd/emoji', desc: 'emoji 目录名', expect: 'in', target: (c) => j(c.root, '\uD83D\uDE00', 'a.cpp') },
    { id: 'odd/nul-byte', desc: '含 NUL 字节必须 fail-closed', expect: 'bool', target: (c) => j(c.root, 'a\0b') },
    { id: 'odd/too-long', desc: '超长路径必须 fail-closed', expect: 'bool', target: (c) => j(c.root, ...Array(600).fill('x'.repeat(60))) },
    { id: 'odd/lone-surrogate', desc: '孤立代理项不得抛', expect: 'bool', target: (c) => j(c.root, 'a\uD800b') },
    { id: 'odd/newline', desc: '路径里含换行', expect: 'in', target: (c) => j(c.root, 'a\nb') },
    { id: 'odd/relative', desc: '相对路径按 cwd 解析，不应误判为在 root 内', expect: 'out', target: () => 'a/b/c.cpp' },

    // ---- 10. URIs must be decoded before they reach this module -----------
    { id: 'uri/raw-encoded-drive', desc: '未解码的 file:///c%3A/...', expect: 'out', target: () => 'file:///c%3A/Users/a.cpp' },
    { id: 'uri/raw-space', desc: '未解码的 %20', expect: 'out', target: () => 'file:///D:/my%20dir/a.cpp' },
    { id: 'uri/raw-percent', desc: '未解码的 %25 不得被当转义吃掉', expect: 'out', target: () => 'file:///D:/100%/a.cpp' },
    { id: 'uri/raw-dotdot', desc: '未解码的 .. 不得被当穿越', expect: 'out', target: () => 'file:///a/../b' },
    { id: 'uri/raw-authority', desc: '带 authority 的 file://', expect: 'out', target: () => 'file://host/share/a' },

    // ---- 11. samePath: identity keys ---------------------------------------
    { id: 'same/dotdot-spelling', desc: '同一文件的多种拼写', expect: 'same', target: (c) => j(c.root, 'a', 'b', 'c.txt'), other: (c) => j(c.root, '.', 'a', 'x', '..', 'b', 'c.txt') },
    { id: 'same/trailing-slash', desc: '目录尾部斜杠', expect: 'same', target: (c) => j(c.root, 'a'), other: (c) => j(c.root, 'a') + path.sep },
    { id: 'same/via-symlink', desc: '经软链指向同一文件', needs: 'symlink', expect: 'same', target: (c) => j(c.root, 'a', 'b', 'c.txt'), other: (c) => j(c.root, 'link', 'c.txt') },
    { id: 'same/case-insensitive', desc: '仅大小写不同', expect: { win32: 'same', posix: 'diff' }, target: (c) => j(c.root, 'a'), other: (c) => j(c.root, 'A') },
    { id: 'same/different-files', desc: '两个不同文件', expect: 'diff', target: (c) => j(c.root, 'a'), other: (c) => j(c.root, 'a', 'b') },
    { id: 'same/empty', desc: '空值不成同', expect: 'diff', target: () => '', other: (c) => c.root },

    // ---- 12. toPosixRel: remote keys (cloud sync) --------------------------
    { id: 'rel/nested', desc: '嵌套相对路径', expect: 'rel:a/b/c.txt', target: (c) => j(c.root, 'a', 'b', 'c.txt'), root: (c) => c.root },
    { id: 'rel/direct-child', desc: '直接子级', expect: 'rel:a/b', target: (c) => j(c.root, 'a', 'b'), root: (c) => c.root },
    { id: 'rel/posix-separators', desc: '结果只用 / 分隔', expect: 'rel:a/b/c.txt', target: (c) => j(c.root, 'a', 'b', 'c.txt'), root: (c) => c.root },
    { id: 'rel/outside', desc: 'root 外返回空串', expect: 'rel:', target: (c) => j(c.sandbox, 'rootEvil', 'x'), root: (c) => c.root },
    { id: 'rel/sibling-prefix', desc: '同前缀兄弟不得被算成相对路径', expect: 'rel:', target: (c) => j(c.sandbox, 'rootEvil', 'x'), root: (c) => c.root },
    
    //大小写必须原样保留：toPosixRel 是远端 key，折叠会丢信息。
    //win32 上也不折叠 —— 「路径不存在」不是拒绝的理由，它只是还没被创建。
    { id: 'rel/case-preserved', desc: '文件名大小写原样出现在远端 key 里', expect: 'rel:a/B', target: (c) => j(c.root, 'a', 'B'), root: (c) => c.root },
    { id: 'rel/case-root-upper', desc: 'root 全大写但真实目录小写（win32 上仍应命中）', expect: { win32: 'rel:a/b', posix: 'rel:' }, target: (c) => j(c.root, 'a', 'b'), root: (c) => c.root.toUpperCase() },
    { id: 'rel/root-itself', desc: 'file 就是 root', expect: 'rel:', target: (c) => c.root, root: (c) => c.root },
    { id: 'rel/deep-new-file', desc: '尚不存在的新文件', expect: 'rel:new/deep/x.cpp', target: (c) => j(c.root, 'new', 'deep', 'x.cpp'), root: (c) => c.root },
    { id: 'rel/empty', desc: '空值', expect: 'rel:', target: () => '', root: (c) => c.root }
];

module.exports = { CASES };