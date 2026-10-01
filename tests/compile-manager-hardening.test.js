'use strict';

// 覆盖编译链路批次：换行优先级、重入保护、面板定时器互斥、存在性检查口径。
// 重点是这些都属于「静默失效」类：界面照常显示，只是输出/行为不对。

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'compile-manager.js'), 'utf8');
const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lang', 'zh-cn.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lang', 'en.json'), 'utf8'));

// ---------------------------------------------------------------------------
// 换行优先级：|| 与 + 的结合顺序
// ---------------------------------------------------------------------------

{
    // 行为验证：把两种写法放进 vm 跑一遍，看换行是否真的落到输出上
    const vm = require('vm');
    const evaluate = (expr) => {
        const sandbox = { window: { i18n: { t: () => '已翻译' } }, __out: null };
        vm.createContext(sandbox);
        vm.runInContext(`__out = ${expr}`, sandbox);
        return sandbox.__out;
    };

    const buggy = evaluate("window.i18n.t('k') || 'fallback' + '\\n'");
    const fixed = evaluate("(window.i18n.t('k') || 'fallback') + '\\n'");

    check('原写法在 i18n 就绪时丢失换行（这正是要修的 bug）', buggy === '已翻译', JSON.stringify(buggy));
    check('括号包裹后换行无条件生效', fixed === '已翻译\n', JSON.stringify(fixed));

    // 源码扫描：提取每个 appendOutput 的第一个实参，若结尾是 `+ '\n'`，
    // 则该 + 必须在括号内（括号在 + 之前闭合）
    const calls = [...src.matchAll(/this\.appendOutput\(/g)];
    const bad = [];
    for (const m of calls) {
        let i = m.index + 'this.appendOutput('.length;
        let depth = 1;
        let arg = '';
        while (i < src.length && depth > 0) {
            const ch = src[i];
            if (ch === '(') depth++;
            else if (ch === ')') { depth--; if (depth === 0) break; }
            else if (ch === "'" || ch === '"' || ch === '`') {
                const q = ch;
                arg += ch; i++;
                while (i < src.length && src[i] !== q) {
                    if (src[i] === '\\') { arg += src[i]; i++; }
                    arg += src[i]; i++;
                }
                arg += src[i];
            } else arg += ch;
            i++;
        }
        const trimmed = arg.trim();
        // 结尾形态有两种：+ '\n' 与 + '!\n'（成功/失败结论行）。
        // 只匹配前者会漏掉后者，'\n' 照样丢失。
        const tailRe = /\+\s*'(?:\\n|!\\n)'\s*$/;
        if (!tailRe.test(trimmed)) continue;
        // 去掉结尾的 `+ '...'`，剩下的表达式必须是「整体被括号包住」
        const expr = trimmed.replace(tailRe, '').trim();
        // 用字符串感知的括号配平扫描：只数引号外的括号，
        // 否则 fallback 文案里的括号（如 'Debug (debug info)'）会误配平
        const balanced = expr.startsWith('(') &&
            expr.endsWith(')') &&
            (() => {
                let d = 0;
                let i = 0;
                while (i < expr.length) {
                    const c = expr[i];
                    if (c === "'" || c === '"' || c === '`') {
                        const q = c;
                        i++;
                        while (i < expr.length && expr[i] !== q) {
                            if (expr[i] === '\\') i++;
                            i++;
                        }
                    } else if (c === '(') d++;
                    else if (c === ')') {
                        d--;
                        if (d === 0 && i !== expr.length - 1) return false;
                    }
                    i++;
                }
                return d === 0;
            })();
        if (!balanced) bad.push(trimmed.slice(0, 80));
        // 括号配平通过还不够：`t(...) || 'fb' + '\n'` 的括号同样是平的，
        // 但 + 落在 || 之外（JS 里 + 优先级高于 ||），fallback 非空时照样丢换行。
        // 追加一条：剥掉尾部 `+ '...'` 后，|| 之前的部分必须以 '(' 结尾，
        // 即整个 || 链被同一对括号包住。
        const stripTail = trimmed.replace(tailRe, '').trim();
        const orIndex = stripTail.indexOf('||');
        if (orIndex > 0 && !stripTail.slice(0, orIndex).trim().endsWith('(')) {
            bad.push(`${trimmed.slice(0, 80)} [|| 链未被括号包裹，+ 仍在 || 之外]`);
        }
    }
    check('所有带换行的 appendOutput 实参都括号包裹', bad.length === 0, bad.join(' ||| '));

    // 同类退化：t(...) 的返回值被直接当 key 字面量赋值。
    // I5 只拦 `= ('key')`，`key: ('k')` 这种对象属性形态会漏掉，
    // 结果是裸 key 直接上屏（原标题栏就是靠这个洞漏了 3 处）。
    const nakedKey = [];
    for (const m of src.matchAll(/(?:^|[,{]\s*)([A-Za-z_$][\w$]*)\s*:\s*\(\s*'([a-z][\w]*(?:\.[\w]+)+)'\s*\)/g)) {
        nakedKey.push(`${m[1]}: ('${m[2]}')`);
    }
    check('没有把裸 key 字面量当作文案上屏', nakedKey.length === 0, nakedKey.join(' ||| '));
}

// ---------------------------------------------------------------------------
// 重入保护
// ---------------------------------------------------------------------------

{
    check('compileCurrentFile 入口有 isCompiling 重入守卫',
        /if \(this\.isCompiling\) \{[\s\S]{0,200}?A compilation is already in progress[\s\S]{0,600}?return false;/.test(src));
    check('重入时不覆盖 isCompiling 状态',
        /if \(this\.isCompiling\) \{[\s\S]{0,600}?return false;[\s\S]{0,200}?\}\s*\n\s*this\.isCompiling = true;/.test(src));
    check('编译成功路径返回 true，供调用方区分「启动」与「被重入拒绝」',
        /handleCompileError\(error\.message\);\s*\}\s*\n\s*return true;/.test(src));
    check('compileAndRun 依据返回值复位 shouldRunAfterCompile',
        /const started = await this\.compileCurrentFile\(\);\s*\n\s*if \(started === false\) this\.shouldRunAfterCompile = false;/.test(src));
    check('重入提示复用 i18n 键',
        /window\.i18n\?\.\?\.t\?\.\('compileOutput\.alreadyRunning'/.test(src) ||
        /window\.i18n\?\.t\?\.\('compileOutput\.alreadyRunning'/.test(src));
    check('zh-cn 存在 compileOutput.alreadyRunning', typeof zh.compileOutput?.alreadyRunning === 'string');
    check('en 存在 compileOutput.alreadyRunning', typeof en.compileOutput?.alreadyRunning === 'string');
}

// ---------------------------------------------------------------------------
// 面板 show/hide 定时器互斥
// ---------------------------------------------------------------------------

{
    check('存在 _cancelOutputHideTimer', /_cancelOutputHideTimer\(\)\s*\{/.test(src));
    check('构造函数初始化 _outputHideTimer',
        /this\._outputHideTimer = null;/.test(src.slice(0, 3000)));
    check('showOutput 先取消 hide 定时器',
        /showOutput\(\)[\s\S]{0,400}?this\._cancelOutputHideTimer\(\);/.test(src));
    check('hideOutput 先取消旧定时器再起新的',
        /hideOutput\(\)[\s\S]{0,400}?this\._cancelOutputHideTimer\(\);[\s\S]{0,300}?this\._outputHideTimer = setTimeout/.test(src));
    check('hide 定时器回调里清空句柄',
        /this\._outputHideTimer = setTimeout\(\(\) => \{\s*\n\s*this\._outputHideTimer = null;/.test(src));
    check('showOutput 不再靠独立的 10ms 定时器加 show 类',
        !/showOutput\(\)[\s\S]{0,500}?setTimeout\(\(\) => \{[\s\S]{0,200}?classList\.add\('show'\)/.test(src),
        '仍存在未受互斥保护的 show 定时器');
}

// ---------------------------------------------------------------------------
// 存在性检查：不能把「未知」当「存在」
// ---------------------------------------------------------------------------

{
    const body = src.slice(src.indexOf('async checkFileExists('));
    const seg = body.slice(0, body.indexOf('\n    }'));
    check('checkFileExists 的异常路径不再 return true',
        !/catch \(error\)[\s\S]{0,200}?return true;/.test(seg),
        seg.replace(/\s+/g, ' ').slice(0, 160));
    check('无 electronAPI 时返回 false 并说明原因',
        /按不存在处理[\s\S]{0,80}?return false;/.test(seg));
    check('catch 分支返回 false',
        /检查文件存在性失败[\s\S]{0,80}?return false;/.test(seg));
}

// ---------------------------------------------------------------------------
// 未使用的 getValue() 已移除
// ---------------------------------------------------------------------------

{
    // compileCurrentFile 里那处 content 是取而不用（报告 §六末条），
    // 但自动保存路径（:1411）那处 content 确实被使用，不能一并删
    const compileFn = src.slice(src.indexOf('async compileCurrentFile(') || 0);
    const compileSeg = compileFn.slice(0, 20000);
    check('compileCurrentFile 不再取未使用的 content = currentEditor.getValue()',
        !/const content = currentEditor\.getValue\(\);/.test(compileSeg.slice(0, 4000)));
    check('自动保存路径的 getValue 仍在（那里 content 确实被使用）',
        /\[自动保存\]/.test(src) && /const content = currentEditor\.getValue\(\);/.test(src));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);