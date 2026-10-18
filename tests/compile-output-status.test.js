'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// M57：编译输出的状态灯原来是用「已翻译的文案」反推语义状态决定的
// （getStatusIndicator 里 status.includes(compilingHint / successHint / failHint)，
// 还并列三个硬编码中文兜底）。整条判定建立在「展示给用户的字」与「语义状态是同一个字符串」
// 这个前提上：润色一次翻译就静默失配一次，不报错、CI 也全绿，只有换语言才看得见。
//
// 修法是把档位显式传下去：setStatus(status, type, command)。这里就按这个方向锁：
// 断言只看「灯跟着 type 走、跟着文案无关」，不比源码字面量 —— 把 t() 的结果换成
// 「全部搞定」这种老写法认不出的词，灯必须还是绿的；反过来塞一句中文「成功」进去，
// 灯也不许自己变绿。谁要退回子串匹配，这两条立刻红。

setTimeout(() => {
    console.log('[FAIL] 主流程没有跑到结尾：某个同步断言卡住了');
    process.exit(1);
}, 60000);

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const ROOT = path.resolve(__dirname, '..');
const { classMethod } = require('./fixtures/source-extract');
const panelSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'compile-output.js'), 'utf8');

// 语言包按最小形状模拟：只有这几个键，插值按 i18next 的规矩「给了 params 才做」。
// lookups 记次数 —— 判定灯该不该看一眼字典，是可数的。
function makePanel(dict) {
    const state = { lookups: 0 };
    const t = (key, params) => {
        state.lookups++;
        const raw = dict[key] || key;
        return params ? String(raw).replace(/\{(\w+)\}/g, (_, name) => String(params[name])) : String(raw);
    };
    const ctx = vm.createContext({
        window: { i18n: { t } },
        Date,
        JSON, Math, Number, String, Boolean, Array, Object, Error, RegExp
    });
    const parts = ['setStatus', 'getStatusIndicator', 'startCompile', 'onCompileSuccess', 'onCompileError']
        .map((name) => ({ name, src: classMethod(panelSource, name) }));
    const missing = parts.filter((p) => !p.src).map((p) => p.name);
    // 邻居方法（show/clearMessages/addMessage）留成记账桩：本文件要验的是灯，不是消息列表。
    vm.runInContext(`class Panel {
${parts.map((p) => p.src).join('\n')}
        show() { this.calls.push('show'); }
        clearMessages() { this.messages.length = 0; }
        addMessage(message, type) { this.messages.push([message, type]); }
    }
    this.__Panel = Panel;`, ctx);

    const inst = new ctx.__Panel();
    inst.calls = [];
    inst.messages = [];
    inst.statusText = { innerHTML: '' };
    inst.commandText = { textContent: '' };
    inst.messagesContainer = null;
    inst.isVisible = true;
    inst.startTime = null;
    inst.currentCommand = '';
    const kind = () => {
        const m = /^<span class="compile-status-indicator ([^"]+)"><\/span>/.exec(inst.statusText.innerHTML);
        return m ? m[1] : null;
    };
    return { inst, kind, state, missing };
}

const ZH = {
    'compileOutput.compiling': '正在编译...',
    'compileOutput.success': '编译成功 ({time}s)',
    'compileOutput.successSimple': '编译成功',
    'compileOutput.fail': '编译失败 ({time}s)',
    'compileOutput.failSimple': '编译失败',
    'compileOutput.successDone': '完成，耗时 {time}s',
    'compileOutput.failDone': '失败，耗时 {time}s'
};

{
    const p = makePanel(ZH);
    check('五个方法体抽取成功（抽不到就别再往下断言）',
        p.missing.length === 0, JSON.stringify({ missing: p.missing }));

    p.inst.startCompile('g++ -O2 main.cpp');
    check('startCompile 亮 compiling，命令同时落到 commandText',
        p.kind() === 'compiling' && p.inst.commandText.textContent === 'g++ -O2 main.cpp'
        && p.inst.currentCommand === 'g++ -O2 main.cpp',
        JSON.stringify({ kind: p.kind(), cmd: p.inst.commandText.textContent }));

    p.inst.startTime = 0;
    p.inst.onCompileSuccess('');
    check('onCompileSuccess 亮 success', p.kind() === 'success', JSON.stringify({ kind: p.kind(), html: p.inst.statusText.innerHTML }));

    p.inst.onCompileError('boom');
    check('onCompileError 亮 error', p.kind() === 'error', JSON.stringify({ kind: p.kind() }));

    const html = p.inst.statusText.innerHTML;
    check('灯的 span 写在文案之前（视觉上圆点在句子左边）',
        html.startsWith('<span class="compile-status-indicator') && html.endsWith(ZH['compileOutput.fail'].replace('{time}', '0.00')),
        JSON.stringify(html));
}

// ---- 核心：灯跟着档位走，跟文案无关 ----
{
    // 把译文换成老写法认不出来的词：老代码靠 includes(hint) 判定，这里会从 success 掉回 ready。
    const reworded = makePanel({
        ...ZH,
        'compileOutput.compiling': '构建进行中…',
        'compileOutput.success': '全部搞定 ({time}s)',
        'compileOutput.fail': '没通过 ({time}s)'
    });
    reworded.inst.startCompile('x');
    const afterCompile = reworded.kind();
    reworded.inst.onCompileSuccess('');
    const afterSuccess = reworded.kind();
    reworded.inst.onCompileError('e');
    check('润色译文不影响指示灯（老写法在这三条上全都会掉回 ready）',
        afterCompile === 'compiling' && afterSuccess === 'success' && reworded.kind() === 'error',
        JSON.stringify({ afterCompile, afterSuccess, afterError: reworded.kind() }));

    const plain = makePanel(ZH);
    plain.state.lookups = 0;
    plain.inst.setStatus('随便一句话', 'success');
    check('setStatus 判灯不再查字典（老写法每判一次要取三个词）',
        plain.kind() === 'success' && plain.state.lookups === 0,
        JSON.stringify({ kind: plain.kind(), lookups: plain.state.lookups }));

    // 文案与档位相反时以档位为准：老写法会被文案带走。
    const liar = makePanel(ZH);
    liar.inst.setStatus(ZH['compileOutput.fail'].replace('{time}', '0.10'), 'success');
    const liarSuccess = liar.kind();
    liar.inst.setStatus(ZH['compileOutput.success'].replace('{time}', '0.10'), 'error');
    check('文案与档位相反时以档位为准（灯不会被一句话带跑）',
        liarSuccess === 'success' && liar.kind() === 'error',
        JSON.stringify({ liarSuccess, liarError: liar.kind() }));

    // 三个中文兜底同样不许回来：字面写着「成功」而档位没点名，就还是 ready。
    const cjk = makePanel(ZH);
    cjk.inst.setStatus('编译成功');
    const byDefault = cjk.kind();
    cjk.inst.setStatus('成功');
    check('不点名档位时保持 ready，中文「成功」二字不再自己点亮灯（第三个参数也不再是命令）',
        byDefault === 'ready' && cjk.kind() === 'ready' && cjk.inst.commandText.textContent === '',
        JSON.stringify({ byDefault, kind: cjk.kind(), cmd: cjk.inst.commandText.textContent }));
}

process.exit(failures > 0 ? 1 : 0);
