'use strict';

// 守卫：被 <script src="…js"> 加载的渲染层文件必须是「全局脚本」形态。
//
// 背景：这批文件已经迁到 .ts，由 tsc 就地 emit 出 .js。只要源文件里出现顶层
// import / export，module: commonjs 就会 emit
// `Object.defineProperty(exports, "__esModule", { value: true })`，而浏览器脚本
// 标签下没有 exports 这个全局 —— 整文件在加载期就 ReferenceError 死掉，
// 界面上表现为对应 manager 从未初始化。上一轮实测有 19 个文件同时踩中，
// typecheck 与既有回归测试全都发现不了（它们都不执行渲染层脚本）。
//
// 做法：把 src 下所有 HTML 里引用的本地脚本逐个在「浏览器形态沙箱」里跑一遍。
// 沙箱不提供 CommonJS 全局，但任何对 exports / module 的读写都会抛带标记的错误，
// 其余未知全局一律返回万能桩（因此「跑过」只证明没有 CJS 依赖，不证明逻辑正确）。
// 另附合成正/负对照，保证这套 harness 本身认得出模块形态产物，
// 以及 .ts 源文件里不该有顶层 import / export（在 emit 之前就拦住）。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const CJS_GLOBALS = ['exports', 'module'];

// ---------- 沙箱 ----------
let any;
const makeAny = () => {
    const fn = function stub() { return any; };
    return new Proxy(fn, {
        get: (_t, prop) => {
            if (prop === Symbol.toPrimitive) return () => '';
            if (prop === Symbol.iterator) return function* () { };
            if (prop === 'then' || prop === Symbol.asyncIterator) return undefined;
            if (typeof prop === 'symbol') return undefined;
            return any;
        },
        set: () => true, has: () => true, apply: () => any, construct: () => any,
        deleteProperty: () => true, getPrototypeOf: () => Object.prototype
    });
};
any = makeAny();

const browserLikeSandbox = () => {
    const target = {};
    for (const name of CJS_GLOBALS) {
        Object.defineProperty(target, name, {
            configurable: true, enumerable: true,
            get() { throw new Error(`CJS-LEAK:${name}`); },
            set() { throw new Error(`CJS-LEAK:${name}`); }
        });
    }
    return new Proxy(target, {
        has: () => true,
        get: (t, k) => {
            if (Object.prototype.hasOwnProperty.call(t, k)) return t[k];
            if (k === Symbol.unscopables) return undefined;
            return any;
        },
        set: (t, k, v) => {
            Object.defineProperty(t, k, { value: v, configurable: true, writable: true, enumerable: true });
            return true;
        },
        defineProperty: (t, k, d) => { Object.defineProperty(t, k, d); return true; },
        deleteProperty: (t, k) => delete t[k],
        ownKeys: () => Reflect.ownKeys(target),
        getPrototypeOf: () => Object.prototype
    });
};

const leakOf = (e) => {
    // 浏览器里 `exports` 未声明 → ReferenceError: exports is not defined，整文件停止执行。
    // 沙箱里 exports / module 是带抛错 getter 的自有属性，V8 的全局属性拦截器会把
    // 这次抛出折叠成同样的「is not defined」，因此两种形态都要认。
    const text = `${e && e.name}: ${e && e.message}`;
    const m = /CJS-LEAK:(\w+)|(?:exports|module) is not defined/.exec(text);
    if (!m) return null;
    if (m[1]) return m[1];
    return /exports/.test(text) ? 'exports' : 'module';
};

// 返回 { kind: 'clean' | 'leak' | 'other', ... }
const runAsBrowserScript = (source, filename) => {
    const ctx = vm.createContext(browserLikeSandbox());
    try {
        vm.runInContext(source, ctx, { filename });
        return { kind: 'clean' };
    } catch (e) {
        const leak = leakOf(e);
        if (leak) return { kind: 'leak', leak };
        return {
            kind: 'other',
            msg: `${e && e.constructor && e.constructor.name}: ${String(e && e.message).slice(0, 80)}`
        };
    }
};

// ---------- 合成对照：harness 自己必须认得出模块形态 ----------
check('正对照：Object.defineProperty(exports, "__esModule") 被判为泄漏',
    runAsBrowserScript('Object.defineProperty(exports, "__esModule", { value: true });\nclass A { }\nexports.A = A;', 'synth-module.js').leak === 'exports');
check('正对照：裸 exports.X = X 被判为泄漏',
    runAsBrowserScript('class B { }\nexports.B = B;', 'synth-exports.js').leak === 'exports');
check('正对照：读 module.exports 被判为泄漏',
    runAsBrowserScript('const m = module.exports;\nclass C { }\nvoid m;', 'synth-module-read.js').leak === 'module');
check('负对照：guarded module.exports 尾缀在全局脚本形态下是允许的',
    runAsBrowserScript('class D { }\nif (typeof module !== "undefined" && module.exports) { module.exports = D; } else { window.D = D; }', 'synth-global.js').kind === 'clean');
check('负对照：完全没有 CommonJS 引用的脚本跑通',
    runAsBrowserScript('class E { }\nwindow.E = new E();', 'synth-clean.js').kind === 'clean');

// ---------- 收集所有 HTML 里引用的本地脚本 ----------
const htmlFiles = [];
(function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (entry.name !== 'node_modules') walk(path.join(dir, entry.name));
        } else if (entry.name.endsWith('.html')) {
            htmlFiles.push(path.join(dir, entry.name));
        }
    }
})(SRC);

const targets = new Map();
for (const html of htmlFiles) {
    const source = fs.readFileSync(html, 'utf8');
    for (const m of source.matchAll(/<script\s+src="([^"]+)"\s*><\/script>/g)) {
        const ref = m[1];
        if (/^https?:/i.test(ref) || ref.includes('node_modules')) continue;
        const abs = path.resolve(path.dirname(html), ref);
        if (!targets.has(abs)) targets.set(abs, new Set());
        targets.get(abs).add(path.relative(ROOT, html));
    }
}

// 空清单会让下面所有守卫真空通过，先钉死「确实抓到了东西」
check('从 HTML 里抓到本地脚本清单', targets.size >= 25, `${htmlFiles.length} 个 HTML，${targets.size} 个脚本目标`);

const leaks = [];
const crashed = [];
const missing = [];
for (const [abs, from] of targets) {
    const rel = path.relative(ROOT, abs);
    if (!fs.existsSync(abs)) { missing.push(rel); continue; }
    const source = fs.readFileSync(abs, 'utf8');
    // 读到空文件同样会让守卫真空通过
    if (source.trim().length < 50) { crashed.push(`${rel}（内容过短，len=${source.length}）`); continue; }
    const result = runAsBrowserScript(source, rel);
    if (result.kind === 'leak') leaks.push(`${rel} ← 读到 ${result.leak}（被 ${[...from].join(', ')} 加载）`);
    else if (result.kind === 'other') crashed.push(`${rel} → ${result.msg}`);
}

check('没有脚本标签文件依赖 CommonJS 全局（整文件会在浏览器里炸）',
    leaks.length === 0, leaks.join(' | '));
check('每个脚本标签文件都能在浏览器形态沙箱里跑完',
    crashed.length === 0, crashed.join(' | '));
check('脚本标签引用的文件都真实存在', missing.length === 0, missing.join(' | '));

// ---------- 源文件层：.ts 里不许有顶层 import / export ----------
// 只查行首语句（缩进的 import/export 不是顶层），并容忍 emit 期会被擦除的
// `import type` —— 那种写法同样会让 tsc 把文件判为模块，所以一并算违规。
const TOPLEVEL_MODULE_FORM = /^(?:import|export)\b/m;
const moduleShaped = [];
for (const [abs] of targets) {
    const tsPath = abs.replace(/\.js$/, '.ts');
    if (!fs.existsSync(tsPath)) continue;
    const tsSource = fs.readFileSync(tsPath, 'utf8');
    if (TOPLEVEL_MODULE_FORM.test(tsSource)) {
        const line = tsSource.split('\n').find((l) => /^(?:import|export)\b/.test(l));
        moduleShaped.push(`${path.relative(ROOT, tsPath)}: ${String(line).slice(0, 60)}`);
    }
}
check('脚本标签对应的 .ts 源文件没有顶层 import / export',
    moduleShaped.length === 0, moduleShaped.join(' | '));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
