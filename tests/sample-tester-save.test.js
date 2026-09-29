'use strict';

// 样例测试器落盘契约回归：P4（样例配置目录只 ensure 一次）与
// P5（同一路径的整份落盘合并，运行期不再重复写回）。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'sidebar', 'sampleTester.js'), 'utf8');
const classStart = source.indexOf('class SampleTester');
const classEnd = source.indexOf('\nif (typeof window', classStart);
if (classStart < 0 || classEnd < 0) {
    console.log('[FAIL] sampleTester.js class not found');
    process.exit(1);
}
const classSource = source.slice(classStart, classEnd);

const saves = [];
let ensureCalls = 0;
const electronAPI = {
    saveFile: (filePath, content) => {
        saves.push({ filePath, content });
        return new Promise((resolve) => setTimeout(() => resolve(true), 5));
    },
    pathJoin: (...parts) => Promise.resolve(parts.join('/')),
    ensureDirectory: () => {
        ensureCalls++;
        return Promise.resolve(true);
    }
};

const context = {
    window: { electronAPI, i18n: { t: (key) => key } },
    document: { getElementById: () => null },
    logInfo: () => { },
    logWarn: () => { },
    logError: () => { },
    setTimeout,
    clearTimeout
};
vm.runInNewContext(`${classSource}\nthis.__SampleTester = SampleTester;`, context);

const makeTester = () => {
    const tester = Object.create(context.__SampleTester.prototype);
    tester.samples = [];
    tester.samplesFilePath = null;
    tester.currentFile = null;
    tester.globalSettings = { useTestlib: false };
    tester.samplesDirCache = new Map();
    tester.pendingSampleSaves = new Map();
    tester.sampleSaveInFlight = null;
    return tester;
};

(async () => {
    // P4: 同一工作区只 ensure 一次目录
    const dirTester = makeTester();
    const dirA = await dirTester.ensureSampleTesterDir('/ws');
    const dirB = await dirTester.ensureSampleTesterDir('/ws');
    const dirC = await dirTester.ensureSampleTesterDir('/ws2');
    check('P4 sample tester dir is ensured once per workspace',
        ensureCalls === 4 && dirA === dirB && dirA.endsWith('/.oicpp-plus/sampleTester') && dirC !== dirA,
        `ensureCalls=${ensureCalls} dirA=${dirA} dirC=${dirC}`);

    // P5: 同一路径的连续请求合并为一次落盘，且落盘内容是最新状态
    const tester = makeTester();
    const samplesV1 = [{ id: 1, input: 'a' }];
    const samplesV2 = [{ id: 1, input: 'b' }];
    const first = tester.saveSamplesToPath('/ws/a.json', samplesV1, { v: 1 });
    const second = tester.saveSamplesToPath('/ws/a.json', samplesV2, { v: 2 });
    const third = tester.saveSamplesToPath('/ws/a.json', samplesV2, { v: 2 });
    await Promise.all([first, second, third]);
    check('P5 concurrent writes to the same path collapse into one flush',
        saves.length === 2, `saves=${saves.length}`);
    const latest = JSON.parse(saves[saves.length - 1].content);
    check('P5 the last flush persists the newest payload',
        latest.samples[0].input === 'b' && latest.globalSettings.v === 2,
        JSON.stringify(latest.samples[0]));
    check('P5 no write stays queued after the drain finishes',
        tester.pendingSampleSaves.size === 0 && tester.sampleSaveInFlight === null);

    // P5: 不同路径各自落盘，互不吞掉
    saves.length = 0;
    const multi = makeTester();
    await Promise.all([
        multi.saveSamplesToPath('/ws/a.json', samplesV1, { v: 1 }),
        multi.saveSamplesToPath('/ws/b.json', samplesV1, { v: 1 })
    ]);
    check('P5 different paths are each persisted',
        saves.length === 2 && saves.map((s) => s.filePath).sort().join(',') === '/ws/a.json,/ws/b.json',
        saves.map((s) => s.filePath).join(','));

    // P5: 落盘失败不抛出，仍继续排空队列
    saves.length = 0;
    const failing = makeTester();
    failing.samplesDirCache.set('/ws', '/ws/.oicpp-plus/sampleTester');
    const originalSave = electronAPI.saveFile;
    electronAPI.saveFile = (filePath) => {
        saves.push({ filePath });
        return Promise.reject(new Error('disk full'));
    };
    let threw = false;
    try {
        await failing.saveSamplesToPath('/ws/a.json', samplesV1, { v: 1 });
    } catch (_) {
        threw = true;
    }
    electronAPI.saveFile = originalSave;
    check('P5 save failures are swallowed and do not break callers',
        !threw && saves.length === 1 && failing.sampleSaveInFlight === null);

    // P5: 运行结果落盘统一走 persistRunResults
    const runTester = makeTester();
    let persistedArgs = null;
    runTester.isCurrentSamplesContext = (pathArg, fileArg) => pathArg === runTester.samplesFilePath && fileArg === runTester.currentFile;
    runTester.saveSamplesToPath = (...args) => { persistedArgs = args; return Promise.resolve(); };
    runTester.samplesFilePath = '/ws/a.json';
    runTester.currentFile = '/ws/main.cpp';
    runTester.samples = [{ id: 1 }];
    const runSamples = [{ id: 2 }];
    await runTester.persistRunResults('/ws/a.json', '/ws/main.cpp', runSamples);
    check('P5 run results persist the live sample list for the current file',
        persistedArgs && persistedArgs[1] === runTester.samples && persistedArgs[2] === runTester.globalSettings);
    await runTester.persistRunResults('/ws/other.json', '/ws/other.cpp', runSamples);
    check('P5 run results fall back to the snapshot for foreign contexts',
        persistedArgs && persistedArgs[1] === runSamples);

    console.log(`sample-tester-save regression tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
    process.exit(failures ? 1 : 0);
})().catch((error) => {
    console.log(`[FAIL] sample-tester-save unexpected error | ${error?.stack || error?.message || error}`);
    process.exit(1);
});
