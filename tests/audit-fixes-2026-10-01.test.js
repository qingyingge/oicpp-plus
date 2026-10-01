'use strict';

// 2026-10-01 理论走查发现的问题的回归测试。
// 背景：60 个提交走查时发现 CompareEngineV2._runCounter 从未初始化，
// 导致 ++undefined === NaN、NaN !== NaN，isCurrentRun() 恒为 false，
// 新引擎对拍会在每条 worker 消息上走「上一轮迟到消息」分支并 settle，
// 表现为秒结束且完成数恒为 0。这里锁住三个不变量。

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
let failures = 0;
let total = 0;

const check = (name, fn) => {
    total++;
    try {
        fn();
        console.log(`[PASS] ${name}`);
    } catch (error) {
        failures++;
        console.log(`[FAIL] ${name} | ${error.message}`);
    }
};

// ---------------------------------------------------------------------------
// 1. _runCounter 必须初始化，且轮次严格递增
// ---------------------------------------------------------------------------
{
    const { CompareEngineV2 } = require(path.join(root, 'src/main-process/compare-engine-v2.js'));
    const engine = new CompareEngineV2();

    check('CompareEngineV2._runCounter 已初始化（非 undefined）', () => {
        assert.notStrictEqual(CompareEngineV2._runCounter, undefined,
            '_runCounter 是 undefined，++undefined === NaN');
        assert.strictEqual(typeof CompareEngineV2._runCounter, 'number');
    });

    check('连续 start() 得到严格递增且可比较的 runId', () => {
        // 只走 start() 的开头：轮次分配在第一个 await 之前
        const before = CompareEngineV2._runCounter;
        engine._state = 'idle';
        engine.start({ totalTests: 0 }).catch(() => { });
        const first = engine._runId;
        engine._state = 'idle';
        engine.start({ totalTests: 0 }).catch(() => { });
        const second = engine._runId;
        assert.ok(first > before, `runId ${first} 应大于 ${before}`);
        assert.ok(second > first, `runId ${second} 应大于 ${first}`);
    });

    check('runId 相同则 isCurrentRun() 为 true（NaN !== NaN 已排除）', () => {
        engine._runId = 42;
        const runId = engine._runId;
        assert.strictEqual(engine._runId === runId, true);
        assert.ok(Number.isNaN(runId) === false, 'runId 不应是 NaN');
    });

    check('_runCounter 递增不会被并发 start 复用', () => {
        const before = CompareEngineV2._runCounter;
        engine._state = 'idle';
        engine.start({ totalTests: 0 }).catch(() => { });
        assert.strictEqual(CompareEngineV2._runCounter, before + 1);
    });
}

// ---------------------------------------------------------------------------
// 2. 归属校验必须真的能区分轮次
// ---------------------------------------------------------------------------
{
    const engineSrc = fs.readFileSync(path.join(root, 'src/main-process/compare-engine-v2.js'), 'utf8');

    check('isCurrentRun 在 worker 消息处理前被检查', () => {
        assert.ok(/const isCurrentRun = \(\) => this\._runId === runId;/.test(engineSrc));
        assert.ok(/if \(!isCurrentRun\(\)\) \{ settle\(\); return; \}/.test(engineSrc),
            '迟到消息必须先 settle 再 return，否则本轮进度会被丢弃');
    });

    check('迟到消息分支不会被误当成当前轮的 progress/error', () => {
        // settle 之后直接 return：若误落到 progress 分支，本轮 _completed 会被污染
        const branch = /if \(!isCurrentRun\(\)\) \{ settle\(\); return; \}\s*\n\s*if \(msg\.type === 'progress'\)/.test(engineSrc);
        assert.ok(branch, 'settle 必须在 progress 分支之前');
    });
}

// ---------------------------------------------------------------------------
// 3. 编译链路：重入标志不得残留、换行不得丢失
// ---------------------------------------------------------------------------
{
    const cmSrc = fs.readFileSync(path.join(root, 'src/renderer/js/compile-manager.js'), 'utf8');

    check('compileCurrentFile 明确返回是否启动（false = 被重入拒绝）', () => {
        assert.ok(/if \(this\.isCompiling\) \{[\s\S]{0,600}?return false;/.test(cmSrc));
        assert.ok(/handleCompileError\(error\.message\);\s*\}\s*\n\s*return true;/.test(cmSrc));
    });

    check('compileAndRun 依据返回值复位 shouldRunAfterCompile', () => {
        // 旧写法 `if (!this.isCompiling) reset` 在重入时不成立（isCompiling 恰为 true），
        // 标志位会残留到下一次编译完成，把「编译」意外变成「编译并运行」
        assert.ok(/const started = await this\.compileCurrentFile\(\);\s*\n\s*if \(started === false\) this\.shouldRunAfterCompile = false;/.test(cmSrc));
        assert.ok(!/await this\.compileCurrentFile\(\);\s*\n\s*if \(!this\.isCompiling\)/.test(cmSrc),
            '仍有旧的复位条件，重入时不会生效');
    });

    check('编译输出换行：t() || 兜底 链整体被括号包裹', () => {
        // JS 里 + 优先级高于 ||：`t() || 'fb' + '\n'` 解析为 `t() || ('fb' + '\n')`。
        // t() 返回非空（= 有翻译，**常态**）时整个表达式取 t()，后面的 '\n' 被整个丢掉；
        // t() 返回空（= 落到兜底）时反而正常。也就是「有翻译才丢换行」。
        const vm = require('vm');
        const NL = String.fromCharCode(10);
        const run = (expr, translated) => {
            const s = vm.createContext({ window: { i18n: { t: () => (translated ? '已翻译' : '') } } });
            return vm.runInContext(expr, s);
        };
        const buggy = "window.i18n.t('k', null) || 'fb' + " + JSON.stringify(NL);
        const fixed = "(window.i18n.t('k', null) || 'fb') + " + JSON.stringify(NL);

        assert.strictEqual(run(buggy, true), '已翻译',
            '旧写法在有翻译时丢换行（这正是要修的 bug，且是常态路径）');
        assert.strictEqual(run(fixed, true), '已翻译' + NL, '括号包裹后有翻译时换行生效');
        assert.strictEqual(run(fixed, false), 'fb' + NL, '括号包裹后走兜底时换行同样生效');
        assert.strictEqual(run(buggy, false), 'fb' + NL, '走兜底时旧写法本来就正常（对照组）');
    });
}

// ---------------------------------------------------------------------------
// 4. 删除边界：所有删除通道都要接工作区校验
// ---------------------------------------------------------------------------
{
    const mainSrc = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');

    check('assertDeletableInWorkspace 已定义', () => {
        assert.ok(/function assertDeletableInWorkspace\(targetPath\)/.test(mainSrc));
    });

    // 上一轮只挂了 2 个 handler，文件管理器主路径（ipcMain.on）与
    // delete-file-invoke 都没接，assertSafeIoPath 只拦系统目录，用户目录照删不误
    const deletionChannels = [
        { name: "ipcMain.on('delete-file')", re: /ipcMain\.on\('delete-file',[\s\S]{0,1200}?assertDeletableInWorkspace\(/ },
        { name: "ipcMain.handle('delete-file')", re: /ipcMain\.handle\('delete-file',[\s\S]{0,1200}?assertDeletableInWorkspace\(/ },
        { name: "ipcMain.handle('delete-file-invoke')", re: /ipcMain\.handle\('delete-file-invoke',[\s\S]{0,1200}?assertDeletableInWorkspace\(/ },
        { name: "ipcMain.handle('clear-directory-contents')", re: /ipcMain\.handle\('clear-directory-contents',[\s\S]{0,1600}?assertDeletableInWorkspace\(/ },
        // 重命名的覆盖分支是 rmSync(recursive)，等价于删除
        { name: "rename 覆盖分支", re: /options\?\.overwrite\)[\s\S]{0,400}?assertDeletableInWorkspace\(/ },
    ];
    for (const ch of deletionChannels) {
        check(`${ch.name} 接了 assertDeletableInWorkspace`, () => {
            assert.ok(ch.re.test(mainSrc), `${ch.name} 未接工作区校验`);
        });
    }

    check('check-file-exists 不把权限类错误当成不存在', () => {
        const m = /ipcMain\.handle\('check-file-exists'[\s\S]{0,1200}?\n    \}\);/.exec(mainSrc);
        assert.ok(m, '未找到 check-file-exists handler');
        assert.ok(/error\?\.code !== 'ENOENT'/.test(m[0]),
            '必须按 errno 分流：EACCES/ENAMETOOLONG/EINVAL 会被吞成 false');
        // 只看代码行，注释里提到 existsSync 不算
        const code = m[0].split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        assert.ok(!/existsSync/.test(code), 'existsSync 兜底已移除');
    });
}

// ---------------------------------------------------------------------------
// 5. 裸 key 上屏：I5 必须同时拦赋值与对象属性两种形态
// ---------------------------------------------------------------------------
{
    const ciSrc = fs.readFileSync(path.join(root, 'scripts/ci-check.js'), 'utf8');
    check('I5 覆盖对象属性形态 key: (\'k\')', () => {
        // 源码里是这条（转义前的字面量）：
        //   /(^|[,{]\s*)([A-Za-z_$][\w$]*)\s*:\s*\(\s*['"]([a-z][\w]*(?:\.[a-zA-Z][\w]*)+)['"]\s*\)/gm
        assert.ok(ciSrc.includes("(^|[,{]\\s*)([A-Za-z_$][\\w$]*)\\s*:\\s*\\(\\s*['\"]"),
            'I5 需覆盖 `key: (\'i18n.key\')` 对象属性形态');
    });
    check('I5 注释说明两种形态（防止后人又删掉属性分支）', () => {
        assert.ok(/两种形态都要拦/.test(ciSrc));
    });

    // 回归：曾经真实存在的 3 处裸 key
    const files = [
        'src/renderer/js/sidebar/cloudSync.js',
        'src/renderer/js/compile-manager.js'
    ];
    const bareKeyRe = /(?:^|[,{]\s*)[A-Za-z_$][\w$]*\s*:\s*\(\s*'([a-z][\w]*(?:\.[\w]+)+)'\s*\)/gm;
    for (const rel of files) {
        check(`${rel} 没有裸 key 字面量`, () => {
            const src = fs.readFileSync(path.join(root, rel), 'utf8');
            const hits = [...src.matchAll(bareKeyRe)].map((m) => m[0].trim());
            assert.strictEqual(hits.length, 0, `仍有裸 key: ${hits.join(' | ')}`);
        });
    }
}

// ---------------------------------------------------------------------------
// 6. I8 豁免收紧：键必须真实存在
// ---------------------------------------------------------------------------
{
    const ciSrc = fs.readFileSync(path.join(root, 'scripts/ci-check.js'), 'utf8');
    check('I8 豁免要求 t() 的键存在于语言包', () => {
        assert.ok(/tKeysOnLine\(line\)\.filter\(\(k\) => !packKeys\.has\(k\)\)/.test(ciSrc));
        assert.ok(/if \(missingKeys\.length > 0\) \{\s*\n\s*fail\(/.test(ciSrc),
            '键缺失必须 fail，而不是只记日志');
    });
}

// ---------------------------------------------------------------------------
// 7. 设置缓存失效
// ---------------------------------------------------------------------------
{
    const preloadSrc = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8');
    check('settings-applied / apply-settings-preview 也让缓存失效', () => {
        const m = /for \(const ch of \[([^\]]+)\]\) \{\s*\n\s*ipcRenderer\.on\(ch, invalidateSettingsCache\)/.exec(preloadSrc);
        assert.ok(m, '未找到缓存失效的通道列表');
        for (const ch of ['settings-changed', 'settings-reset', 'settings-imported', 'settings-applied', 'apply-settings-preview']) {
            assert.ok(m[1].includes(`'${ch}'`), `${ch} 未纳入失效列表`);
        }
    });
    check('在途请求不在失效后回填旧快照', () => {
        assert.ok(/const generation = settingsCacheGeneration;/.test(preloadSrc));
        assert.ok(/if \(generation === settingsCacheGeneration\) \{/.test(preloadSrc),
            '必须比对代数后才回填，否则写入前的旧值会被重新缓存');
    });
    check('compare-warning 在事件白名单里', () => {
        const m = /const ALLOWED_EVENT_CHANNELS = new Set\(\[([\s\S]*?)\]\);/.exec(preloadSrc);
        assert.ok(m, '未找到 ALLOWED_EVENT_CHANNELS');
        for (const ch of ['compare-progress', 'compare-error', 'compare-complete', 'compare-warning']) {
            assert.ok(m[1].includes(`'${ch}'`), `${ch} 不在白名单，主进程发的消息会被静默丢弃`);
        }
    });
}

// ---------------------------------------------------------------------------
// 8. 设置窗口：软失败也必须阻断默认值回写
// ---------------------------------------------------------------------------
{
    const src = fs.readFileSync(path.join(root, 'src/renderer/settings/compiler.js'), 'utf8');
    check('getAllSettings 返回 null/空对象时按加载失败处理', () => {
        assert.ok(/if \(!allSettings \|\| typeof allSettings !== 'object'\) \{/.test(src),
            'null/undefined 必须与抛异常同等对待');
        assert.ok(/allSettings\.compilerPath === undefined && allSettings\.compilerArgs === undefined/.test(src),
            '空对象也要按加载失败处理');
        assert.ok(!/if \(allSettings\) \{/.test(src), '旧的 `if (allSettings)` 会静默跳过并置 _settingsLoaded = true');
    });
    check('setCompilerPath 不绕过阻断回写默认 compilerArgs', () => {
        const start = src.indexOf('async setCompilerPath(path)');
        assert.ok(start > 0, '未找到 setCompilerPath');
        const body = src.slice(start, start + 1600);
        assert.ok(/this\._settingsLoaded === false/.test(body),
            '加载失败时必须只更新 compilerPath，不碰 compilerArgs');
    });
}

console.log(`\n${total - failures}/${total} assertions passed`);
process.exit(failures === 0 ? 0 : 1);
