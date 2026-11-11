type CompareConfig = {
    standardCodePath: string;
    testCodePath: string;
    generatorPath: string;
    useTestlib: boolean;
    spjPath: string;
    freopenInputFile: string;
    freopenOutputFile: string;
    threadCount: number;
    compareCount: number;
    timeLimit: number;
};

type CompareErrorResult = {
    compileType: string;
    errorMessage: string;
    errorType: string;
    generatorErrorType: string;
    input: string;
    inputExpanded: boolean;
    inputTruncated: boolean;
    rawErrorMessage: string;
    stdOutput: string;
    stdOutputExpanded: boolean;
    stdOutputTruncated: boolean;
    testNumber: number;
    testOutput: string;
    testOutputExpanded: boolean;
    testOutputTruncated: boolean;
    usedSpj: boolean;
    message?: string;
    genMs?: number;
    stdMs?: number;
    testMs?: number;
};

type IncompleteRunGap = {
    completed: number;
    total: number;
    missing: number;
};

// 单组实测样本：gen/std/test 三段耗时与生成器输出字节数，由引擎的 progress 事件带上来
type CompareGroupSample = {
    testIndex: number;
    genMs: number;
    stdMs: number;
    testMs: number;
    totalMs: number;
    genLen: number;
    // 该组完成时的墙钟时刻，TPS 靠它算（见 getCompareTps）
    atMs: number;
};

// 只保留固定滑动窗口 + 标量，不逐组累积：计划组数上限是 10 万，全量留样本会撑爆渲染层
type CompareStats = {
    startedAt: number;
    elapsedMs: number;
    totalGroups: number;
    window: CompareGroupSample[];
    slowest: CompareGroupSample | null;
    lastSample: CompareGroupSample | null;
};

// 引擎侧的非致命告警（看门狗超时、fastspawn 回退），跑完要在统计条上留痕
type CompareEngineWarning = {
    code: string;
    completed: number;
    total: number;
    missing: number;
    message: string;
};

type CompareState = {
    isRunning: boolean;
    // 入口到 isRunning 之间的同步占位（见 startComparison）
    starting?: boolean;
    shouldStop: boolean;
    currentTest: number;
    totalTests: number;
    statusText: string;
    mode: string;
    errorResult: CompareErrorResult | null;
    warningMessage: string | null;
    incompleteRun: IncompleteRunGap | null;
    completedTests: number;
    failedTests: number;
    stopped: boolean;
    // 本轮对拍的身份（runTask 分配，主进程原样盖回每个事件）
    runId: number;
    stats: CompareStats;
    engineWarnings: CompareEngineWarning[];
};

type CompareExecutableSet = {
    stdExe: string;
    testExe: string;
    generatorExe: string | null;
    generatorRunTarget: string | { executablePath: string; args: string[]; workingDirectory: string };
    spjExe: string | null;
};

type DialogResult = {
    canceled: boolean;
    filePaths: string[];
};

type CompareTask = {
    key: string;
    config: CompareConfig;
    state: CompareState;
    compiledExecutables: CompareExecutableSet | null;
    // 磁盘那份有没有落进内存。false 时不许写盘（否则启动瞬间会把默认值盖到用户配置上）
    configLoaded: boolean;
};

// 视图偏好：只有「块开合」这类纯显示状态，跟着设备走，不跟题目走
type CompareViewPrefs = {
    blocks: Record<string, boolean>;
};

type FreopenContext = {
    runInput: string;
    workingDirectory: string | null;
    outputFilePath: string | null;
    cleanupFiles: string[];
};

// runProgram 的返回形状，供「跑过了」与「没跑」两条路共用同一个类型，
// 免得占位对象与真结果在 strict 下各是一个匿名结构、在分支处合成 never
type ProgramRunOutput = Awaited<ReturnType<CodeComparer['runProgram']>>;

type EngineError = {
    code?: string;
    // worker 被信号杀死时 IPC 过来的就是 null，不是缺省
    exitCode?: number | null;
    message?: string;
    completed?: number;
    total?: number;
    missing?: number;
};

const MAX_COMPARE_COUNT = 100000;
// TPS 滑动窗口长度：太短抖得厉害，太长已经把整轮平均出来了、失去「当下多快」的意义
const COMPARE_STATS_WINDOW = 20;
// 统计条的重画节流：并行引擎在快程序下每秒能推几十条 progress，
// 每条都重排 DOM 会让渲染层自己变成对拍的瓶颈
const COMPARE_STATS_PAINT_MS = 250;
// 用时的独立走表间隔：它只跟墙钟有关，跟事件来不来无关
const COMPARE_STATS_TICK_MS = 200;
const COMPARE_VIEW_STORAGE_KEY = 'oicpp.compare.viewState';
// 配置写盘节流：一次改路径会连着触发 renderTask，逐次写盘等于把同一个 json 重写十几遍
const COMPARE_CONFIG_SAVE_DEBOUNCE_MS = 500;
const ccInput = (id: string) => {
    const el = document.getElementById(id);
    return el instanceof HTMLInputElement ? el : null;
};
const ccButton = (id: string) => {
    const el = document.getElementById(id);
    return el instanceof HTMLButtonElement ? el : null;
};
const ccEvt = (e: Event) => (e.target instanceof HTMLInputElement ? e.target : null);
// 文件级 i18n 别名（I5 只认这种写法；在调用点直接 `t(key) || key` 会被判成死兜底）
const ccT = (key: string, params?: Record<string, string | number>) => window.i18n?.t?.(key, params) || key;

class CodeComparer {
    declare activeTaskKey: string | null;
    declare standardCodePath: string;
    declare testCodePath: string;
    declare generatorPath: string;
    declare useTestlib: boolean;
    declare spjPath: string;
    declare freopenInputFile: string;
    declare freopenOutputFile: string;
    declare maxParallelThreads: number;
    declare tasks: Map<string, CompareTask>;
    declare eventsbound: boolean;
    declare statsPaintedAt: number;
    declare viewPrefs: CompareViewPrefs;
    declare configSaveTimers: Map<string, number> | null;
    // 每轮对拍的「摘监听」把手，按任务 key 存：重置运行中的一轮时必须能把监听摘干净，
    // 否则迟到的 complete 会在用户已经清空的面板上弹「已手动停止」
    declare runCleanups: Map<string, () => void>;
    declare statsTicker: number | null;
    declare compareRunSeq: number;

    constructor() {
        this.activeTaskKey = null;
        this.standardCodePath = '';
        this.testCodePath = '';
        this.generatorPath = '';
        this.useTestlib = false;
        this.spjPath = '';
        this.freopenInputFile = '';
        this.freopenOutputFile = '';
        this.maxParallelThreads = 1;
        this.tasks = new Map();
        this.eventsbound = false;
        this.statsPaintedAt = 0;
        this.configSaveTimers = null;
        this.runCleanups = new Map();
        this.statsTicker = null;
        this.compareRunSeq = 0;
        this.viewPrefs = this.readCompareViewPrefs();

        this.setupEventListeners();
        this.setupActiveFileListener();
    }

    normalizeTaskKey(taskKey: string) {
        if (!taskKey || typeof taskKey !== 'string') return '';
        const isWin = typeof window !== 'undefined' && window.process?.platform === 'win32';
        const normalized = String(taskKey).trim();
        if (!isWin) return normalized;
        return normalized.replace(/\//g, '\\').toLowerCase();
    }

    setupActiveFileListener() {
        try {
            window.addEventListener('oicpp:active-file-changed', (e) => {
                const filePath = e instanceof CustomEvent ? e.detail?.filePath : undefined;
                if (!filePath || typeof filePath !== 'string') return;
                if (!this.isSupportedCodeFile(filePath)) return;
                this.setActiveTaskKey(filePath, { syncTestCodePath: true });
            });
        } catch (error) {
            logWarn('[对拍器] 注册活动文件监听失败:', error);
        }
    }

    isSupportedCodeFile(filePath: string) {
        const lower = String(filePath || '').toLowerCase();
        return lower.endsWith('.cpp') || lower.endsWith('.cc') || lower.endsWith('.cxx') || lower.endsWith('.c');
    }

    isPythonGenerator(filePath: string) {
        const lower = String(filePath || '').trim().toLowerCase();
        return lower.endsWith('.py');
    }

    async promptMissingPythonInterpreter(task: CompareTask) {
        this.showTaskCompileError(task, 'settings', window.i18n.t('compare.setPythonFirst'));
        try {
            await window.electronAPI?.openCompilerSettings?.();
        } catch (error) {
            logWarn('打开编译器设置失败:', error);
        }
    }

    getOrCreateTask(taskKey: string) {
        const normalizedKey = this.normalizeTaskKey(taskKey);
        if (!normalizedKey) return null;
        let task = this.tasks.get(normalizedKey);
        if (!task) {
            task = {
                key: normalizedKey,
                config: {
                    standardCodePath: '',
                    testCodePath: taskKey,
                    generatorPath: '',
                    useTestlib: false,
                    spjPath: '',
                    freopenInputFile: '',
                    freopenOutputFile: '',
                    threadCount: NaN,
                    compareCount: 100,
                    timeLimit: 1000
                },
                state: {
                    isRunning: false,
                    shouldStop: false,
                    currentTest: 0,
                    totalTests: 0,
                    statusText: (window.i18n.t('compare.ready')),
                    mode: 'idle', // idle | running | stopping | error | complete | stopped
                    errorResult: null,
                    warningMessage: null,
                    incompleteRun: null,
                    completedTests: 0,
                    failedTests: 0,
                    stopped: false,
                    runId: 0,
                    stats: this.createCompareStats(0),
                    engineWarnings: []
                },
                compiledExecutables: null,
                configLoaded: false
            };
            this.tasks.set(normalizedKey, task);
            // 首次遇到这个被测文件时去读它那份配置；读盘是异步的，不阻塞面板渲染
            this.loadTaskConfig(task);
        }
        return task;
    }

    getActiveTask() {
        const key = this.activeTaskKey || this.testCodePath || null;
        if (!key) return null;
        return this.getOrCreateTask(key);
    }

    setActiveTaskKey(taskKey: string, options: { syncTestCodePath?: boolean } = {}) {
        if (!taskKey || typeof taskKey !== 'string') return;
        const normalizedKey = this.normalizeTaskKey(taskKey);
        if (!normalizedKey) return;

        const task = this.getOrCreateTask(taskKey);
        if (!task) return;

        this.activeTaskKey = normalizedKey;

        if (options.syncTestCodePath) {
            task.config.testCodePath = taskKey;
            this.testCodePath = task.config.testCodePath;
        }

        this.applyTaskConfigToInstance(task);
        this.renderTask(task);
    }

    applyTaskConfigToInstance(task: CompareTask) {
        const cfg = task?.config;
        if (!cfg) return;
        this.standardCodePath = cfg.standardCodePath || '';
        this.testCodePath = cfg.testCodePath || '';
        this.generatorPath = cfg.generatorPath || '';
        this.useTestlib = !!cfg.useTestlib;
        this.spjPath = cfg.spjPath || '';
        this.freopenInputFile = cfg.freopenInputFile || '';
        this.freopenOutputFile = cfg.freopenOutputFile || '';
    }

    syncInstanceConfigToTask(task: CompareTask) {
        if (!task?.config) return;
        task.config.standardCodePath = this.standardCodePath || '';
        task.config.testCodePath = this.testCodePath || task.config.testCodePath || '';
        task.config.generatorPath = this.generatorPath || '';
        task.config.useTestlib = !!this.useTestlib;
        task.config.spjPath = this.spjPath || '';
        const freopenInputEl = ccInput('compare-freopen-input-file');
        const freopenOutputEl = ccInput('compare-freopen-output-file');
        task.config.freopenInputFile = this.normalizeFreopenFileName(freopenInputEl?.value || this.freopenInputFile || '');
        task.config.freopenOutputFile = this.normalizeFreopenFileName(freopenOutputEl?.value || this.freopenOutputFile || '');

        const compareCountEl = ccInput('compare-count');
        const timeLimitEl = ccInput('time-limit');
        const threadCountEl = ccInput('compare-threads');
        const compareCount = parseInt(compareCountEl?.value as string);
        const timeLimit = parseInt(timeLimitEl?.value as string);
        const threadCount = parseInt(threadCountEl?.value as string);
        if (Number.isFinite(compareCount)) {
            const cappedCount = Math.max(1, Math.min(compareCount, MAX_COMPARE_COUNT));
            task.config.compareCount = cappedCount;
            if (compareCountEl && cappedCount !== compareCount) compareCountEl.value = String(cappedCount);
        }
        if (Number.isFinite(timeLimit)) task.config.timeLimit = timeLimit;
        if (Number.isFinite(threadCount)) {
            const capped = Math.max(1, Math.min(threadCount, this.maxParallelThreads || threadCount));
            task.config.threadCount = capped;
            if (threadCountEl && capped !== threadCount) threadCountEl.value = String(capped);
        }
        this.scheduleTaskConfigSave(task);
    }

    mergeTaskConfigIfEmpty(targetTask: CompareTask, sourceConfig?: CompareConfig | null) {
        if (!targetTask?.config || !sourceConfig) return;

        const targetCfg = targetTask.config;
        const s = sourceConfig;
        if (!targetCfg.standardCodePath && s.standardCodePath) targetCfg.standardCodePath = s.standardCodePath;
        if (!targetCfg.generatorPath && s.generatorPath) targetCfg.generatorPath = s.generatorPath;
        if (!targetCfg.spjPath && s.spjPath) targetCfg.spjPath = s.spjPath;
        if (!targetCfg.freopenInputFile && s.freopenInputFile) targetCfg.freopenInputFile = s.freopenInputFile;
        if (!targetCfg.freopenOutputFile && s.freopenOutputFile) targetCfg.freopenOutputFile = s.freopenOutputFile;

        if (!targetCfg.useTestlib && s.useTestlib) targetCfg.useTestlib = !!s.useTestlib;

        if (!Number.isFinite(targetCfg.compareCount) && Number.isFinite(s.compareCount)) targetCfg.compareCount = s.compareCount;
        if (!Number.isFinite(targetCfg.timeLimit) && Number.isFinite(s.timeLimit)) targetCfg.timeLimit = s.timeLimit;
        if (!Number.isFinite(targetCfg.threadCount) && Number.isFinite(s.threadCount)) targetCfg.threadCount = s.threadCount;

        if (!targetCfg.testCodePath && s.testCodePath) targetCfg.testCodePath = s.testCodePath;
    }

    // ─── 配置持久化 ──────────────────────────────────────────
    // 视图偏好进 localStorage（与 compile-manager / sampleTester 同一套做法）；
    // 任务配置进 <workspace>/.oicpp-plus/codeComparer/<safe-rel>.json，按被测文件记，
    // 与 tasks Map 的 key 同构。settings.json 这条路走不通：utils/settings-schema.ts
    // 的 SETTINGS_KEYS 白名单会把未知键静默丢掉。
    readCompareViewPrefs(): CompareViewPrefs {
        try {
            const raw = window.localStorage?.getItem(COMPARE_VIEW_STORAGE_KEY);
            if (!raw) return { blocks: {} };
            const parsed = JSON.parse(raw) as Partial<CompareViewPrefs>;
            return { blocks: (parsed && typeof parsed.blocks === 'object' && parsed.blocks) || {} };
        } catch (_) {
            return { blocks: {} };
        }
    }

    writeCompareViewPrefs() {
        try {
            window.localStorage?.setItem(COMPARE_VIEW_STORAGE_KEY, JSON.stringify(this.viewPrefs));
        } catch (_) { /* 隐私模式或配额满：偏好丢了不影响对拍本身 */ }
    }

    applyCompareViewPrefs() {
        for (const blockId of Object.keys(this.viewPrefs.blocks)) {
            const collapsed = this.viewPrefs.blocks[blockId];
            if (typeof collapsed === 'boolean') this.setBlockCollapsed(blockId, collapsed, false);
        }
    }

    getWorkspaceRoot(): string {
        return window.sidebarManager?.panels?.files?.workspacePath || '';
    }

    // safe-rel 命名与 sampleTester.computeSamplesFilePathForFile 一致：
    // 相对工作区的路径压成文件名，同一工作区下的不同题目互不覆盖。
    async computeCompareConfigPath(taskKey: string): Promise<string | null> {
        const workspaceRoot = this.getWorkspaceRoot();
        if (!taskKey || !workspaceRoot) return null;
        try {
            let relative = taskKey;
            if (taskKey.toLowerCase().startsWith(workspaceRoot.toLowerCase())) {
                relative = taskKey.slice(workspaceRoot.length);
            } else {
                relative = taskKey.replace(/[:\\]/g, '_');
            }
            const safe = relative.replace(/^[\\/]+/, '').replace(/[\\\/]/g, '_').replace(/[<>:"|?*]/g, '_');
            const oicppDir = await window.electronAPI.pathJoin(workspaceRoot, '.oicpp-plus');
            const dir = await window.electronAPI.pathJoin(oicppDir, 'codeComparer');
            await window.electronAPI.ensureDirectory(oicppDir);
            await window.electronAPI.ensureDirectory(dir);
            return await window.electronAPI.pathJoin(dir, `${safe}.json`);
        } catch (error) {
            logWarn('[对拍器] 计算配置文件路径失败:', error);
            return null;
        }
    }

    serializeTaskConfig(task: CompareTask) {
        const cfg = task.config;
        return {
            v: 1,
            standardCodePath: cfg.standardCodePath || '',
            generatorPath: cfg.generatorPath || '',
            spjPath: cfg.spjPath || '',
            useTestlib: !!cfg.useTestlib,
            freopenInputFile: cfg.freopenInputFile || '',
            freopenOutputFile: cfg.freopenOutputFile || '',
            // NaN 进 JSON 会变成 null，回读时按 null→NaN 还原「留空=自动」的语义，
            // 落成 0 就等于把自动并行悄悄改成 1 路。
            compareCount: Number.isFinite(cfg.compareCount) ? cfg.compareCount : null,
            timeLimit: Number.isFinite(cfg.timeLimit) ? cfg.timeLimit : null,
            threadCount: Number.isFinite(cfg.threadCount) ? cfg.threadCount : null
        };
    }

    async loadTaskConfig(task: CompareTask) {
        if (!task || task.configLoaded) return;
        const baseline = JSON.stringify(task.config);
        const filePath = await this.computeCompareConfigPath(task.key);
        if (!filePath) { task.configLoaded = true; return; }
        let raw = '';
        try {
            raw = await window.electronAPI.readFileContent(filePath);
        } catch (_) {
            task.configLoaded = true;
            return;
        }
        // 读盘在途时用户可能已经改过这一项（切文件后立刻手填路径是常见操作）。
        // 内存与创建时不一致就说明磁盘那份过期了，直接放弃回写，别把用户刚填的冲掉。
        if (JSON.stringify(task.config) !== baseline) { task.configLoaded = true; return; }
        let saved: Partial<CompareConfig> | null = null;
        try {
            saved = raw ? JSON.parse(String(raw)) as Partial<CompareConfig> : null;
        } catch (error) {
            logWarn('[对拍器] 配置文件解析失败，按默认值继续:', error);
            task.configLoaded = true;
            return;
        }
        if (saved) {
            // 逐字段 typeof 收窄：CompareConfig 是混合类型，用 keyof 索引赋值会被
            // 收成 never（写不出类型，也读不出错），摊开写反而最省事。
            if (typeof saved.standardCodePath === 'string') task.config.standardCodePath = saved.standardCodePath;
            if (typeof saved.generatorPath === 'string') task.config.generatorPath = saved.generatorPath;
            if (typeof saved.spjPath === 'string') task.config.spjPath = saved.spjPath;
            if (typeof saved.freopenInputFile === 'string') task.config.freopenInputFile = saved.freopenInputFile;
            if (typeof saved.freopenOutputFile === 'string') task.config.freopenOutputFile = saved.freopenOutputFile;
            if (typeof saved.useTestlib === 'boolean') task.config.useTestlib = saved.useTestlib;
            if (Number.isFinite(saved.compareCount)) task.config.compareCount = saved.compareCount as number;
            if (Number.isFinite(saved.timeLimit)) task.config.timeLimit = saved.timeLimit as number;
            // null / 缺失都回到 NaN（自动），不能落成 0
            task.config.threadCount = Number.isFinite(saved.threadCount) ? saved.threadCount as number : NaN;
            this.applyTaskConfigToInstance(task);
            this.renderIfActive(task);
        }
        task.configLoaded = true;
    }

    scheduleTaskConfigSave(task: CompareTask) {
        if (!task || !task.configLoaded) return;
        if (!this.configSaveTimers) this.configSaveTimers = new Map();
        const pending = this.configSaveTimers.get(task.key);
        if (pending) clearTimeout(pending);
        this.configSaveTimers.set(task.key, setTimeout(() => {
            this.configSaveTimers?.delete(task.key);
            this.writeTaskConfig(task).catch((error) => logWarn('[对拍器] 配置保存失败:', error));
        }, COMPARE_CONFIG_SAVE_DEBOUNCE_MS) as unknown as number);
    }

    async writeTaskConfig(task: CompareTask) {
        const filePath = await this.computeCompareConfigPath(task.key);
        if (!filePath) return;
        await window.electronAPI.writeFile(filePath, JSON.stringify(this.serializeTaskConfig(task), null, 2));
    }

    // 侧栏切走时 sidebar.showPanel 会回调这里（js/sidebar.ts 里离开面板那段）。
    // 对拍本身继续跑（引擎在主进程），但面板看不见还每 200ms 重排一次 DOM 是白烧 CPU；
    // 切回来由 renderTask 重新走表。
    deactivate() {
        this.stopStatsTicker();
    }

    activate() {
        logInfo('激活代码对拍器面板');
        setTimeout(() => {
            this.checkCompilerAndUpdate();
        }, 100);

        try {
            const currentEditor = window.editorManager?.getCurrentEditor?.();
            const filePath = currentEditor?.filePath || (currentEditor?.getFilePath && currentEditor.getFilePath());
            if (filePath && this.isSupportedCodeFile(filePath)) {
                this.setActiveTaskKey(filePath, { syncTestCodePath: true });
            } else {
                const task = this.getActiveTask();
                if (task) this.renderTask(task);
            }
        } catch (_) { }
    }

    async checkCompilerAndUpdate() {
        try {
            if (window.electronAPI && window.electronAPI.getAllSettings) {
                const settings = await window.electronAPI.getAllSettings();
                const hasCompiler = settings && settings.compilerPath;

                const noCompilerMessage = (document.getElementById('no-compiler-message'));
                const compareFileSection = (document.getElementById('compare-file-section'));

                if (hasCompiler) {
                    noCompilerMessage!.style.display = 'none';
                    // 不要写死 display:block：.compare-file-section 在 CSS 里是 flex 列布局，
                    // 内联的 block 会覆盖它并让 gap 失效，导致各区块紧紧贴在一起。
                    compareFileSection!.style.display = '';
                } else {
                    noCompilerMessage!.style.display = 'flex';
                    compareFileSection!.style.display = 'none';
                }
            }
        } catch (error) {
            logError('检查编译器设置失败:', error);
        }
    }

    setupEventListeners() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                this.bindEvents();
            });
        } else {
            setTimeout(() => this.bindEvents(), 100);
        }
    }

    bindEvents() {
        if (this.eventsbound) {
            return;
        }
        this.eventsbound = true;

        this.ensureThreadLimitUI();
        this.applyCompareViewPrefs();
        this.bindBlockToggles();
        // 初始就把第二个槽位收成空：没有活动任务时 renderTask 会直接 return，
        // 不补这一刀，「停止」「清空」会在刚打开面板时一起露出来
        this.updateUIForTask(this.getActiveTask());
        // 初始态也走一次，避免进度标签在首次对拍前残留 HTML 里的英文字面量
        setTimeout(() => this.updateProgress(0, 0), 0);

        const stdCodeBrowse = (document.getElementById('std-code-browse'));
        const testCodeBrowse = (document.getElementById('test-code-browse'));
        const generatorBrowse = (document.getElementById('generator-browse'));

        if (stdCodeBrowse) {
            stdCodeBrowse.addEventListener('click', () => this.browseStandardCode());
        }
        if (testCodeBrowse) {
            testCodeBrowse.addEventListener('click', () => this.browseTestCode());
        }
        if (generatorBrowse) {
            generatorBrowse.addEventListener('click', () => this.browseGenerator());
        }

        const actionBtn = ccButton('compare-run-btn');
        const exportBtn = (document.getElementById('export-btn'));
        const inputExpandBtn = (document.getElementById('input-expand-btn'));
        const stdOutputExpandBtn = (document.getElementById('std-output-expand-btn'));
        const testOutputExpandBtn = (document.getElementById('test-output-expand-btn'));

        if (actionBtn) {
            actionBtn.addEventListener('click', () => this.onCompareActionClick());
        }
        if (exportBtn) {
            exportBtn.addEventListener('click', () => this.exportResults());
        }
        if (inputExpandBtn) {
            inputExpandBtn.addEventListener('click', () => this.toggleErrorOutputExpand('input'));
        }
        if (stdOutputExpandBtn) {
            stdOutputExpandBtn.addEventListener('click', () => this.toggleErrorOutputExpand('std'));
        }
        if (testOutputExpandBtn) {
            testOutputExpandBtn.addEventListener('click', () => this.toggleErrorOutputExpand('test'));
        }

        const useTestlibCheckbox = ccInput('compare-use-testlib');
        const spjBrowseBtn = (document.getElementById('compare-spj-browse'));
        const compareCountInput = ccInput('compare-count');
        const threadCountInput = ccInput('compare-threads');
        const timeLimitInput = ccInput('time-limit');
        const freopenInputInput = ccInput('compare-freopen-input-file');
        const freopenOutputInput = ccInput('compare-freopen-output-file');

        if (useTestlibCheckbox) {
            useTestlibCheckbox.addEventListener('change', (e) => {
                this.useTestlib = ccEvt(e)?.checked ?? false;
                const task = this.getActiveTask();
                if (task) {
                    task.config.useTestlib = !!this.useTestlib;
                    this.renderTask(task);
                }
            });
        }

        if (spjBrowseBtn) {
            spjBrowseBtn.addEventListener('click', () => this.browseSpjFile());
        }

        if (compareCountInput) {
            compareCountInput.addEventListener('change', () => {
                const task = this.getActiveTask();
                if (!task) return;
                this.syncInstanceConfigToTask(task);
            });
        }
        if (threadCountInput) {
            threadCountInput.addEventListener('change', () => {
                const task = this.getActiveTask();
                if (!task) return;
                this.syncInstanceConfigToTask(task);
            });
        }
        if (timeLimitInput) {
            timeLimitInput.addEventListener('change', () => {
                const task = this.getActiveTask();
                if (!task) return;
                this.syncInstanceConfigToTask(task);
            });
        }

        if (freopenInputInput) {
            freopenInputInput.addEventListener('change', (e) => {
                const target = ccEvt(e);
                const normalized = this.normalizeFreopenFileName(target?.value ?? '');
                if (target) target.value = normalized;
                this.freopenInputFile = normalized;
                const task = this.getActiveTask();
                if (!task) return;
                task.config.freopenInputFile = normalized;
                this.scheduleTaskConfigSave(task);
            });
        }

        if (freopenOutputInput) {
            freopenOutputInput.addEventListener('change', (e) => {
                const target = ccEvt(e);
                const normalized = this.normalizeFreopenFileName(target?.value ?? '');
                if (target) target.value = normalized;
                this.freopenOutputFile = normalized;
                const task = this.getActiveTask();
                if (!task) return;
                task.config.freopenOutputFile = normalized;
                this.scheduleTaskConfigSave(task);
            });
        }
    }

    async browseStandardCode() {
        try {
            const result = await window.electronAPI.showOpenDialog({
                title: window.i18n.t('compare.selectStdCode'),
                filters: [
                    { name: window.i18n.t('compare.cppFilter'), extensions: ['cpp', 'cc', 'cxx', 'c'] },
                    { name: window.i18n.t('compare.allFilter'), extensions: ['*'] }
                ],
                properties: ['openFile']
            }) as DialogResult;

            if (!result.canceled && result.filePaths.length > 0) {
                this.standardCodePath = result.filePaths[0] as string;
                this.updateFilePath('std-code-path', this.standardCodePath);

                const task = this.getActiveTask();
                if (task) {
                    task.config.standardCodePath = this.standardCodePath;
                }
            }
        } catch (error) {
            logError('选择标准代码文件失败:', error);
        }
    }

    async browseTestCode() {
        try {
            const prevTask = this.getActiveTask();
            if (prevTask) {
                this.syncInstanceConfigToTask(prevTask);
            }

            const result = await window.electronAPI.showOpenDialog({
                title: window.i18n.t('compare.selectTestCode'),
                filters: [
                    { name: window.i18n.t('compare.cppFilter'), extensions: ['cpp', 'cc', 'cxx', 'c'] },
                    { name: window.i18n.t('compare.allFilter'), extensions: ['*'] }
                ],
                properties: ['openFile']
            }) as DialogResult;

            if (!result.canceled && result.filePaths.length > 0) {
                this.testCodePath = result.filePaths[0] as string;
                this.updateFilePath('test-code-path', this.testCodePath);

                const prevConfig = prevTask?.config ? { ...prevTask.config } : {
                    standardCodePath: this.standardCodePath,
                    generatorPath: this.generatorPath,
                    useTestlib: this.useTestlib,
                    spjPath: this.spjPath,
                    freopenInputFile: this.freopenInputFile,
                    freopenOutputFile: this.freopenOutputFile,
                    compareCount: parseInt(ccInput('compare-count')?.value ?? '') || 100,
                    timeLimit: parseInt(ccInput('time-limit')?.value ?? '') || 1000
                };

                this.setActiveTaskKey(this.testCodePath, { syncTestCodePath: true });
                const newTask = this.getActiveTask();
                this.mergeTaskConfigIfEmpty(newTask as CompareTask, prevConfig as CompareConfig);

                if (newTask) {
                    this.applyTaskConfigToInstance(newTask);
                    this.renderTask(newTask);
                }
            }
        } catch (error) {
            logError('选择测试代码文件失败:', error);
        }
    }

    async browseGenerator() {
        try {
            const result = await window.electronAPI.showOpenDialog({
                title: window.i18n.t('compare.selectGenerator'),
                filters: [
                    { name: window.i18n.t('compare.genFilter'), extensions: ['cpp', 'cc', 'cxx', 'c', 'py'] },
                    { name: window.i18n.t('compare.allFilter'), extensions: ['*'] }
                ],
                properties: ['openFile']
            }) as DialogResult;

            if (!result.canceled && result.filePaths.length > 0) {
                this.generatorPath = result.filePaths[0] as string;
                this.updateFilePath('generator-path', this.generatorPath);

                const task = this.getActiveTask();
                if (task) {
                    task.config.generatorPath = this.generatorPath;
                }
            }
        } catch (error) {
            logError('选择数据生成器文件失败:', error);
        }
    }

    async browseSpjFile() {
        try {
            const result = await window.electronAPI.showOpenDialog({
                title: window.i18n.t('compare.selectSpjFile'),
                filters: [
                    { name: window.i18n.t('compare.cppFilter'), extensions: ['cpp', 'cc', 'cxx', 'c'] },
                    { name: window.i18n.t('compare.allFilter'), extensions: ['*'] }
                ],
                properties: ['openFile']
            }) as DialogResult;

            if (!result.canceled && result.filePaths.length > 0) {
                this.spjPath = result.filePaths[0] as string;
                const spjPathInput = ccInput('compare-spj-path');
                if (spjPathInput) {
                    spjPathInput.value = this.spjPath;
                }

                const task = this.getActiveTask();
                if (task) {
                    task.config.spjPath = this.spjPath;
                }
            }
        } catch (error) {
            logError('选择SPJ文件失败:', error);
        }
    }

    updateFilePath(elementId: string, filePath: string) {
        const element = (document.getElementById(elementId));
        if (element) {
            const value = (filePath && String(filePath).trim()) ? String(filePath) : (window.i18n.t('compare.noFileSelected'));
            element.textContent = value;
            // 路径显示被限成两行，完整路径只能靠悬浮；title 不参与 i18n（值是路径，不是文案）
            element.title = value;
            if (value === 'No file selected' || value === window.i18n.t('compare.noFileSelected')) {
                element.classList.remove('selected');
            } else {
                element.classList.add('selected');
            }
        }
    }

    setBlockCollapsed(blockId: string, collapsed: boolean, persist = true) {
        const block = (document.getElementById(blockId));
        if (!block) return;
        block.classList.toggle('collapsed', collapsed);
        const head = block.querySelector('.cmp-block-head');
        if (head) head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        if (persist && this.viewPrefs) {
            this.viewPrefs.blocks[blockId] = collapsed;
            this.writeCompareViewPrefs();
        }
    }

    bindBlockToggles() {
        document.querySelectorAll('.cmp-block-head').forEach((head) => {
            head.addEventListener('click', () => {
                const block = head.closest('.cmp-block');
                if (!block) return;
                this.setBlockCollapsed(block.id, !block.classList.contains('collapsed'));
            });
        });
    }

    renderTask(task: CompareTask) {
        if (!task) return;

        this.updateFilePath('std-code-path', task.config.standardCodePath || '');
        this.updateFilePath('test-code-path', task.config.testCodePath || '');
        this.updateFilePath('generator-path', task.config.generatorPath || '');

        const compareCountInput = ccInput('compare-count');
        if (compareCountInput && Number.isFinite(task.config.compareCount)) {
            compareCountInput.value = String(task.config.compareCount);
        }
        const threadCountInput = ccInput('compare-threads');
        if (threadCountInput && Number.isFinite(task.config.threadCount)) {
            threadCountInput.value = String(task.config.threadCount);
        }
        const timeLimitInput = ccInput('time-limit');
        if (timeLimitInput && Number.isFinite(task.config.timeLimit)) {
            timeLimitInput.value = String(task.config.timeLimit);
        }
        const useTestlibCheckbox = ccInput('compare-use-testlib');
        if (useTestlibCheckbox) {
            useTestlibCheckbox.checked = !!task.config.useTestlib;
        }
        const spjPathInput = ccInput('compare-spj-path');
        if (spjPathInput) {
            spjPathInput.value = task.config.spjPath || '';
        }
        const freopenInputInput = ccInput('compare-freopen-input-file');
        if (freopenInputInput) {
            freopenInputInput.value = task.config.freopenInputFile || '';
        }
        const freopenOutputInput = ccInput('compare-freopen-output-file');
        if (freopenOutputInput) {
            freopenOutputInput.value = task.config.freopenOutputFile || '';
        }

        // SPJ / freopen 一旦配上就改变判定口径（回退旧引擎、走文件读写），藏在折叠块里等于没说；
        // 只在确实配了、且用户没自己动过这个块的时候自动展开，别跟用户的选择抢。
        const ioConfigured = !!task.config.useTestlib || !!(task.config.spjPath || '').trim()
            || !!(task.config.freopenInputFile || '').trim() || !!(task.config.freopenOutputFile || '').trim();
        if (ioConfigured && this.viewPrefs?.blocks?.['cmp-block-io'] === undefined) {
            this.setBlockCollapsed('cmp-block-io', false, false);
        }

        // 统计条跟着任务走：切回一个正在跑的文件时，画面必须立刻是它自己的数字
        this.renderCompareStats(task, true);
        // 走表定时器跟着重建：面板切走时 deactivate 会停表，切回来得重新走起来
        if (task.state.mode === 'running' || task.state.mode === 'stopping') this.startStatsTicker(task);
        this.scheduleTaskConfigSave(task);

        this.updateUIForTask(task);

        if (task.state.mode === 'running' || task.state.mode === 'stopping') {
            this.showStatus();
            this.updateStatusText(task.state.statusText || (window.i18n.t('compare.running')));
            this.updateProgress(task.state.currentTest, task.state.totalTests);
        } else if (task.state.mode === 'error') {
            this.showError(task.state.errorResult as CompareErrorResult);
        } else if (task.state.mode === 'complete' || task.state.mode === 'stopped') {
            this.showComplete(this.getCompletedCount(task), task.state.warningMessage);
        } else {
            this.hideStatus();
            this.hideError();
            this.hideComplete();
        }
    }

    async startComparison() {
        if (!this.testCodePath) {
            const task = this.getActiveTask();
            this.showTaskCompileError(task as CompareTask, 'general', window.i18n.t('compare.selectTestCodeFirst'));
            return;
        }

        const task = this.getOrCreateTask(this.testCodePath);
        if (!task) return;

        // 入口同步占位：原先第一件事是 await autoSaveCurrentFile()，isRunning 要等一整段
        // await 之后才置 true，双击「开始」或「停止后立刻开始」会并发跑两轮同一任务。
        // fork 用 mode='stopping' 路由完成事件（不改 isRunning 的生命周期），所以守卫看 mode。
        if (task.state.starting || task.state.isRunning
            || task.state.mode === 'running' || task.state.mode === 'stopping') {
            this.showTaskCompileError(task, 'general', window.i18n.t('compare.taskRunning'));
            return;
        }

        task.state.starting = true;
        try {
            await this.startComparisonBody(task);
        } finally {
            task.state.starting = false;
        }
    }

    /**
     * startComparison 的正文：调用前入口已经占好 starting 位，这里只管往下走。
     */
    // SPJ 下正解可选，而不是无用：checker 分两类 —— 只验性质（「这是不是合法的最优解」）
    // 不需要基准，最优化/计分那类要拿正解输出当 answer。填了正解就跑它并当基准，
    // 没填就整个跳过（answer 传空文件，状态与文案由 checker 自己定）。
    isSpjActive(task: CompareTask) {
        return !!(task.config.useTestlib && task.config.spjPath);
    }

    // 正解「必须填」的唯一情形是没有 checker 可依赖（文本判等要两份输出相比）。
    // SPJ 下不要求正解：新引擎跳过它的运行，checker 的 answer 用空文件顶上。
    requiresStandardProgram(task: CompareTask) {
        return !this.isSpjActive(task);
    }

    private async startComparisonBody(task: CompareTask): Promise<void> {
        await this.autoSaveCurrentFile();

        this.syncInstanceConfigToTask(task);

        if ((this.requiresStandardProgram(task) && !task.config.standardCodePath) || !task.config.testCodePath || !task.config.generatorPath) {
            this.showTaskCompileError(task, 'general', window.i18n.t('compare.selectAllFilesFirst'));
            return;
        }

        logInfo('对拍器文件检查:');
        logInfo('标准代码:', task.config.standardCodePath);
        logInfo('测试代码:', task.config.testCodePath);
        logInfo('数据生成器:', task.config.generatorPath);

        try {
            const settings = await window.electronAPI.getAllSettings();
            if (!settings || !settings.compilerPath) {
                this.showTaskCompileError(task, 'general', window.i18n.t('compare.setCompilerFirst'));
                return;
            }
            if (this.isPythonGenerator(task.config.generatorPath) && !String(settings.pythonInterpreterPath || '').trim()) {
                await this.promptMissingPythonInterpreter(task);
                return;
            }
        } catch (error) {
            logError('获取编译器设置失败:', error);
            this.showTaskCompileError(task, 'general', window.i18n.t('compare.noCompilerSettings'));
            return;
        }

        const compareCountEl = ccInput('compare-count');
        let compareCount = parseInt(compareCountEl?.value as string) || task.config.compareCount || 100;
        compareCount = Math.max(1, Math.min(compareCount, MAX_COMPARE_COUNT));
        if (compareCountEl && Number(compareCountEl.value) !== compareCount) {
            compareCountEl.value = String(compareCount);
        }
        const timeLimit = parseInt(ccInput('time-limit')?.value ?? '');
        const effectiveTimeLimit = Number.isFinite(timeLimit) ? timeLimit : (task.config.timeLimit || 1000);
        const { cpuThreads, maxParallel } = await this.getMaxParallelThreads();
        this.maxParallelThreads = maxParallel;
        const requestedThreadsRaw = parseInt(ccInput('compare-threads')?.value ?? '');
        // 留空/非法 = 自动跟随上限（与 ensureThreadLimitUI 的兜底一致），不再退回 1
        const requestedThreads = Number.isFinite(requestedThreadsRaw)
            ? Math.max(1, Math.min(requestedThreadsRaw, maxParallel))
            : maxParallel;

        task.config.compareCount = compareCount;
        task.config.timeLimit = Number.isFinite(timeLimit) ? timeLimit : task.config.timeLimit;
        task.config.threadCount = requestedThreads;

        task.state.totalTests = compareCount;
        task.state.currentTest = 0;
        task.state.completedTests = 0;
        task.state.failedTests = 0;
        task.state.stopped = false;
        task.state.isRunning = true;
        task.state.shouldStop = false;
        task.state.errorResult = null;
        task.state.warningMessage = null;
        task.state.incompleteRun = null;
        task.state.stats = this.createCompareStats(performance.now());
        task.state.engineWarnings = [];
        // 开跑就把状态栏写成「对拍中」：并行引擎不再逐组报组号（那数字没有意义），
        // 留着「准备中」会让人以为没动起来
        task.state.statusText = (window.i18n.t('compare.running'));
        task.state.mode = 'running';

        this.setActiveTaskKey(task.config.testCodePath, { syncTestCodePath: true });
        this.updateUIForTask(task);
        this.showStatus();
        this.updateStatusText(task.state.statusText);
        this.updateProgress(0, task.state.totalTests);

        const workerCount = Math.max(1, Math.min(requestedThreads, maxParallel, task.state.totalTests));
        logInfo('[对拍器] 并行配置', { cpuThreads, maxParallel, requestedThreads, workerCount, totalTests: task.state.totalTests });

        this.runTask(task, effectiveTimeLimit, workerCount, maxParallel).catch((error) => {
            logError('对拍过程出错:', error);
            this.showTaskCompileError(task, 'general', (window.i18n.t('compare.compareError')) + ((error as Error)?.message || String(error)));
        });
    }

    async runTask(task: CompareTask, effectiveTimeLimit: number, workerCount: number, maxParallel: number) {
        let cleanupProgress: (() => void) | null, cleanupError: (() => void) | null, cleanupComplete: (() => void) | null, cleanupWarning: (() => void) | null;
        const cleanupAllListeners = () => {
            try { cleanupProgress?.(); } catch(_) {}
            try { cleanupError?.(); } catch(_) {}
            try { cleanupComplete?.(); } catch(_) {}
            try { cleanupWarning?.(); } catch(_) {}
            this.runCleanups.delete(task.key);
        };
        // 把手交出去：resetComparison 在中止这一轮时要能摘监听
        try { this.runCleanups.get(task.key)?.(); } catch (_) {}
        this.runCleanups.set(task.key, cleanupAllListeners);
        // 轮次身份：上一轮引擎被 compare-start 顶掉时补发的终止事件，到达渲染层时往往本轮
        // 监听已经挂上了；不带身份就会被本轮当成自己的结果收下（实测「完成」早于「启动」）。
        // 判定写成只看 task.state，不依赖闭包局部，四个回调才测得到。
        const runId = ++this.compareRunSeq;
        task.state.runId = runId;

        try {
            logInfo(`开始对拍！计划执行 ${task.state.totalTests} 组测试，时间限制 ${task.config.timeLimit}ms`);

            const compiledPrograms = await this.compilePrograms(task);
            if (!compiledPrograms) {
                return;
            }

            // 新引擎（compare-engine/compare-worker）已实现 SPJ 与 freopen：
            //   · checker 作为第 4 个进程跑在 worker 里（gen → std∥test → checker）
            //   · freopen 靠「每 worker × 每角色」一个固定复用的工作目录隔离，
            //     输入落文件、输出从文件回收，走的是 native 的 cwd 通道
            // 到这里为止旧引擎已经没有调用方（runComparison 等暂留待后期删除，
            // 别把它们当活代码改）。
            logInfo('所有程序编译成功，启动 HPC 对拍引擎');

            const config = {
                // 主进程会把同一个 runId 盖回每个事件上，回调靠它认出自己那一轮
                runId,
                stdExe: compiledPrograms.stdExe,
                testExe: compiledPrograms.testExe,
                generator: compiledPrograms.generatorRunTarget || compiledPrograms.generatorExe,
                spjExe: compiledPrograms.spjExe,
                totalTests: task.state.totalTests,
                timeLimit: effectiveTimeLimit,
                generatorTimeout: 0,
                threadCount: workerCount,
                useTestlib: task.config.useTestlib,
                freopen: {
                    inputFile: task.config.freopenInputFile || null,
                    outputFile: task.config.freopenOutputFile || null
                }
            };

            // 非致命告警（如 fastspawn 回退），只记日志，不打断对拍
            cleanupWarning = window.electronAPI.onCompareWarning((data) => {
                if (data?.runId !== task.state.runId) return;
                // 本轮已被用户重置（mode 回到 idle）：再回写就把清空的面板填回来了
                if (task.state.mode === 'idle') { cleanupAllListeners(); return; }
                logWarn('[对拍器][引擎告警]', data?.code || 'warning', data?.message || '');
                // incomplete_run 走的是告警通道是对的（已跑完的组结果仍然有效，不该弹错误面板），
                // 但缺口本身必须留下：worker 崩了/提前退出时完成数只统计真正跑过的，
                // 不记这一笔，完成面板就把「只跑完 7/16」显示成一次成功的对拍。
                if (data?.code === 'incomplete_run') {
                    task.state.incompleteRun = {
                        completed: Number(data?.completed) || 0,
                        total: Number(data?.total) || 0,
                        missing: Number(data?.missing) || 0
                    };
                } else if (data?.code === 'engine_timeout' || data?.code === 'fastspawn_fallback') {
                    // 这两类以前只进 logWarn，界面一句话不说：看门狗砍掉的那一半跑量、
                    // 以及退化成串行的 fastspawn 缺失，用户只能靠「今天怎么这么慢」去猜。
                    this.recordEngineWarning(task, data);
                    this.renderIfActive(task);
                }
            });

            cleanupProgress = window.electronAPI.onCompareProgress((data) => {
                if (data?.runId !== task.state.runId) return;
                // 本轮已被用户重置（mode 回到 idle）：再回写就把清空的面板填回来了
                if (task.state.mode === 'idle') { cleanupAllListeners(); return; }
                const completed = Number(data.current) || 0;
                task.state.currentTest = completed;
                task.state.completedTests = completed;
                this.recordCompareSample(task, data);
                // 并行引擎下「第 N 组测试」是句废话：十几个 worker 各自跳号、完成顺序也不定，
                // 状态栏报一个随机组号只会让人以为进度是顺序推进的。组号只在差异面板上出现。
                this.updateProgress(completed, data.total);
                this.renderCompareStats(task);
            });

            cleanupError = window.electronAPI.onCompareError(async (error) => {
                if (error?.runId !== task.state.runId) return;
                if (task.state.mode === 'idle') { cleanupAllListeners(); return; }
                task.state.errorResult = {
                    testNumber: error.testNumber,
                    input: error.input || '',
                    stdOutput: error.stdOutput || '',
                    testOutput: error.testOutput || '',
                    inputTruncated: !!error.inputTruncated,
                    stdOutputTruncated: !!error.stdOutputTruncated,
                    testOutputTruncated: !!error.testOutputTruncated,
                    errorType: error.type,
                    errorCode: error.code || '',
                    // spj_* 说明这一组的结论来自 checker，双栏视图就不该再去算「第一个
                    // 不同的行列」——checker 的判等口径（分词/精度/自定义）跟文本差没关系
                    usedSpj: String(error.type || '').indexOf('spj_') === 0,
                    errorMessage: this.getEngineErrorMessage(error),
                    rawErrorMessage: error.message || '',
                    genMs: Number(error.genMs) || 0,
                    stdMs: Number(error.stdMs) || 0,
                    testMs: Number(error.testMs) || 0
                } as unknown as CompareErrorResult;
                task.state.mode = 'error';
                this.renderIfActive(task);
                cleanupAllListeners();
                try {
                    await window.electronAPI.stopCompare();
                } catch (_) { }
                await this.finishCompareTask(task);
            });

            cleanupComplete = window.electronAPI.onCompareComplete((result) => {
                if (result?.runId !== task.state.runId) return;
                if (task.state.mode === 'idle') { cleanupAllListeners(); return; }
                const completed = Number.isFinite(result.completed) ? result.completed! : task.state.completedTests;
                const failed = Number.isFinite(result.failed) ? result.failed! : 0;
                task.state.completedTests = completed;
                task.state.currentTest = completed;
                task.state.failedTests = failed;

                if (result.stopped) {
                    task.state.stopped = true;
                    task.state.mode = 'stopped';
                    task.state.warningMessage = this.getCompletionWarningMessage(task, failed);
                    this.updateTaskStatus(task, window.i18n.t('compare.compareStopped', { completed, failed, count: completed }));
                } else if (task.state.mode === 'running' || task.state.mode === 'stopping') {
                    task.state.mode = 'complete';
                    task.state.warningMessage = this.getCompletionWarningMessage(task, failed);
                } else {
                    logInfo(`对拍已提前结束（状态: ${task.state.mode}），共完成 ${completed} 组测试`);
                }
                logInfo(`对拍完成！共执行 ${completed} 组测试`);
                this.renderIfActive(task);
                cleanupAllListeners();
                this.finishCompareTask(task);
            });

            // 引擎接手的那一刻才把状态栏从「编译 xxx...」换过来：编译阶段是一条条顺序提示，
            // 换成对拍中就不再有别的文案刷它（并行阶段不报组号），不写这句会一直挂着编译文案
            this.updateTaskStatus(task, window.i18n.t('compare.running'));
            this.startStatsTicker(task);
            await window.electronAPI.startCompare(config);
        } catch (error) {
            logError('对拍过程出错:', error);
            this.showTaskCompileError(task, 'general', (window.i18n.t('compare.compareError')) + ((error as Error)?.message || String(error)));
            cleanupAllListeners();
            await this.finishCompareTask(task);
        }
    }

    async finishCompareTask(task: CompareTask) {
        task.state.isRunning = false;
        this.stopStatsTicker();
        this.settleCompareStats(task);
        await this.cleanupCompiledExecutables(task);
        if (this.activeTaskKey === task.key) {
            this.updateUIForTask(task);
        }
    }

    async compilePrograms(task: CompareTask) {
        const generatedFiles: string[] = [];
        const cleanupPartialCompiles = async () => {
            for (const filePath of generatedFiles) {
                try {
                    if (await window.electronAPI.checkFileExists(filePath)) {
                        await window.electronAPI.deleteFile(filePath);
                    }
                } catch (_) { }
            }
        };

        try {
            const settings = await window.electronAPI.getAllSettings();
            const compilerPath = settings.compilerPath;
            let compilerArgs = settings.compilerArgs || '-std=c++14 -O2';

            if (task.config.useTestlib) {
                const compilerDir = await window.electronAPI.pathDirname(compilerPath);
                const testlibIncludePath = await window.electronAPI.pathJoin(compilerDir, '..', 'include');
                compilerArgs += ` -I"${testlibIncludePath}"`;
            }

            const tempDir = await window.electronAPI.getUserDataPath(['compare']);

            await window.electronAPI.ensureDir(tempDir);

            const timestamp = Date.now();
            const isWin = (typeof window !== 'undefined' && window.process && window.process.platform === 'win32');
            const exeSuffix = isWin ? '.exe' : '';
            // 正解栏空着（SPJ 下合法）就不编它：省一次编译，也避免「正解编不过」卡死
            // 一个只需要 checker 的对拍。填了则照编，它的输出会作为 checker 的 answer。
            // 下面两条清理路径各自按「不加入 / filter(Boolean)」跳过空 stdExe。
            const compileStd = !!task.config.standardCodePath;
            const stdExe = compileStd ? await window.electronAPI.pathJoin(tempDir, `std_${timestamp}${exeSuffix}`) : '';
            const testExe = await window.electronAPI.pathJoin(tempDir, `test_${timestamp}${exeSuffix}`);
            let generatorExe = null;
            let generatorRunTarget = null;
            if (compileStd) generatedFiles.push(stdExe);
            generatedFiles.push(testExe);

            if (compileStd) {
                this.updateTaskStatus(task, window.i18n.t('compare.compileStd'));
                const stdResult = await window.electronAPI.compileFile({
                    inputFile: task.config.standardCodePath,
                    outputFile: stdExe,
                    compilerPath: compilerPath,
                    compilerArgs: compilerArgs,
                    workingDirectory: await window.electronAPI.pathDirname(task.config.standardCodePath)
                });

                if (!stdResult!.success) {
                    this.showTaskCompileError(task, 'standard', stdResult!.stderr || stdResult!.stdout || window.i18n.t('compare.compileFail'));
                    await cleanupPartialCompiles();
                    return null;
                }
            }

            this.updateTaskStatus(task, window.i18n.t('compare.compileTest'));
            const testResult = await window.electronAPI.compileFile({
                inputFile: task.config.testCodePath,
                outputFile: testExe,
                compilerPath: compilerPath,
                compilerArgs: compilerArgs,
                workingDirectory: await window.electronAPI.pathDirname(task.config.testCodePath)
            });

            if (!testResult!.success) {
                this.showTaskCompileError(task, 'test', testResult!.stderr || testResult!.stdout || window.i18n.t('compare.compileFail'));
                await cleanupPartialCompiles();
                return null;
            }

            const generatorIsPython = this.isPythonGenerator(task.config.generatorPath);
            if (generatorIsPython) {
                const interpreterPath = String(settings.pythonInterpreterPath || '').trim();
                if (!interpreterPath) {
                    await this.promptMissingPythonInterpreter(task);
                    await cleanupPartialCompiles();
                    return null;
                }
                const interpreterExists = await window.electronAPI.checkFileExists(interpreterPath);
                if (!interpreterExists) {
                    this.showTaskCompileError(task, 'settings', window.i18n.t('compare.pythonPathInvalid'));
                    try {
                        await window.electronAPI?.openCompilerSettings?.();
                    } catch (_) { }
                    await cleanupPartialCompiles();
                    return null;
                }

                this.updateTaskStatus(task, window.i18n.t('compare.preparePythonGen'));
                generatorRunTarget = {
                    executablePath: interpreterPath,
                    args: [task.config.generatorPath],
                    workingDirectory: await window.electronAPI.pathDirname(task.config.generatorPath)
                };
            } else {
                generatorExe = await window.electronAPI.pathJoin(tempDir, `generator_${timestamp}${exeSuffix}`);
                generatedFiles.push(generatorExe);
                this.updateTaskStatus(task, window.i18n.t('compare.compileGen'));
                const generatorResult = await window.electronAPI.compileFile({
                    inputFile: task.config.generatorPath,
                    outputFile: generatorExe,
                    compilerPath: compilerPath,
                    compilerArgs: compilerArgs,
                    workingDirectory: await window.electronAPI.pathDirname(task.config.generatorPath)
                });

                if (!generatorResult!.success) {
                    this.showTaskCompileError(task, 'generator', generatorResult!.stderr || generatorResult!.stdout || window.i18n.t('compare.compileFail'));
                    await cleanupPartialCompiles();
                    return null;
                }
                generatorRunTarget = generatorExe;
            }

            let spjExe = null;

            if (task.config.useTestlib && task.config.spjPath) {
                this.updateTaskStatus(task, window.i18n.t('compare.compileSpj'));
                spjExe = await window.electronAPI.pathJoin(tempDir, `spj_${timestamp}${exeSuffix}`);
                generatedFiles.push(spjExe);

                let spjCompilerArgs = compilerArgs;


                if (settings.testlibPath) {
                    const testlibPathInfo = await window.electronAPI.getPathInfo(settings.testlibPath);
                    const testlibIncludePath = testlibPathInfo!.dirname;
                    spjCompilerArgs += ` -I"${testlibIncludePath}"`;
                } else {
                    const pathInfo = await window.electronAPI.getPathInfo(compilerPath);
                    const testlibIncludePath = await window.electronAPI.pathJoin(pathInfo!.dirname as string, '..', 'include');
                    spjCompilerArgs += ` -I"${testlibIncludePath}"`;
                }



                const spjResult = await window.electronAPI.compileFile({
                    inputFile: task.config.spjPath,
                    outputFile: spjExe,
                    compilerPath: compilerPath,
                    compilerArgs: spjCompilerArgs,
                    workingDirectory: await window.electronAPI.pathDirname(task.config.spjPath)
                });

                if (!spjResult!.success) {
                    this.showTaskCompileError(task, 'spj', spjResult!.stderr || spjResult!.stdout || window.i18n.t('compare.compileFail'));
                    await cleanupPartialCompiles();
                    return null;
                }
            }

            task.compiledExecutables = {
                stdExe,
                testExe,
                generatorExe,
                spjExe
            } as CompareExecutableSet;

            return {
                stdExe,
                testExe,
                generatorExe,
                generatorRunTarget,
                spjExe
            };

        } catch (error) {
            logError('编译程序失败:', error);
            this.showTaskCompileError(task, 'general', (window.i18n.t('compare.compileFail')) + ': ' + (error as Error).message);
            await cleanupPartialCompiles();
            return null;
        }
    }

    // SPJ 没填正解时的占位结果。下面每一处「正解是否出错」的判据都必须原样放行，
    // 所以它是一条「什么都没发生」的记录，而不是 null —— 拿 null 参与判断会把
    // 「正解没跑」误报成「正解失败」。
    private notRunProgramOutput(): ProgramRunOutput {
        return {
            output: '',
            error: '',
            timeout: false,
            time: 0,
            exitCode: 0,
            outputLimitExceeded: false,
            outputLimitBytes: 0,
            capturedOutputBytes: 0,
            observedOutputBytes: 0
        } as ProgramRunOutput;
    }

    // 旧引擎（freopen 回退路径）里跑一遍正解：freopen 目录、投递输入、从文件回收输出
    private async runStandardProgram(task: CompareTask, stdExe: string, caseIndex: number, inputData: string): Promise<ProgramRunOutput> {
        const stdFreopenContext = await this.prepareFreopenContext(task, 'std', caseIndex, inputData);
        try {
            const stdRunOptions = stdFreopenContext.workingDirectory
                ? { executablePath: stdExe, workingDirectory: stdFreopenContext.workingDirectory }
                : stdExe;
            const stdOutput = await this.runProgram(stdRunOptions, stdFreopenContext.runInput, 0);
            stdOutput.output = await this.resolveProgramOutput(stdOutput.output, stdFreopenContext);
            return stdOutput;
        } finally {
            await this.cleanupFreopenContext(stdFreopenContext);
        }
    }

    async runComparison(task: CompareTask, programs: CompareExecutableSet, timeLimit: number, workerCountFromConfig = 1, maxParallelFromStart = 1) {
        const { stdExe, testExe, generatorExe, generatorRunTarget, spjExe } = programs;
        let failedGenerations = 0;

        const maxParallel = Math.max(1, maxParallelFromStart || 1);
        const workerCount = Math.max(1, Math.min(workerCountFromConfig || 1, maxParallel, task.state.totalTests));
        const totalTests = task.state.totalTests;

        let nextIndex = 1;
        let completed = 0;
        let executed = 0;
        let errorOccurred = false;

        // 「已完成 N 组」按实际跑过的组数计（生成失败也算跑过），不再拿计划数充当结果
        const markExecuted = () => {
            executed++;
            task.state.completedTests = executed;
            task.state.currentTest = executed;
        };

        const worker = async () => {
            while (true) {
                if (task.state.shouldStop || errorOccurred) return;

                const i = nextIndex++;
                if (i > totalTests) return;

                if (this.activeTaskKey === task.key) {
                    this.updateTaskStatus(task, window.i18n.t('compare.testGroup', { i }));
                    this.updateProgress(this.getCompletedCount(task), totalTests);
                }

                try {
                    const generation = await this.generateTestData(generatorRunTarget || generatorExe!, 0);
                    markExecuted();
                    if (!generation || generation.success !== true) {
                        const generatorMessage = generation?.message || (window.i18n.t('compare.generatorRunFailed'));
                        const generatedOutput = generation?.result?.output || '';
                        const generatorType = generation?.type || 'unknown';
                        try {
                            logError(`第 ${i} 组：数据生成失败 (${generatorType})`, generatorMessage);
                        } catch (_) { }

                        task.state.errorResult = {
                            testNumber: i,
                            input: generatedOutput ? this.limitOutputLines(generatedOutput, 50) : (window.i18n.t('compare.noGenInput')),
                            stdOutput: generatorMessage,
                            testOutput: window.i18n.t('compare.noRunOutput'),
                            errorType: 'generator_program_error',
                            generatorErrorType: generatorType
                        } as unknown as CompareErrorResult;
                        task.state.mode = 'error';
                        failedGenerations++;
                        errorOccurred = true;
                        this.renderIfActive(task);
                        return;
                    }

                    const inputData = generation.input;

                    // SPJ 下正解可选（answer 用空文件填）。没编正解就不建 std 的 freopen
                    // 目录、不起进程；占位结果让下面每条「正解是否出错」的判据原样放行，
                    // 它的空 output 只流向 checker 的 answer 与错误面板里该藏掉的那一节。
                    const stdOutput = stdExe
                        ? await this.runStandardProgram(task, stdExe, i, inputData!)
                        : this.notRunProgramOutput();
                    if (stdOutput.outputLimitExceeded || stdOutput.timeout || stdOutput.error || stdOutput.exitCode !== 0) {
                        const limitMbStd = Math.max(1, Math.floor((stdOutput.outputLimitBytes || 0) / (1024 * 1024)));
                        const errorMsg = stdOutput.outputLimitExceeded ? window.i18n.t('compare.stdOle', { limit: limitMbStd }) :
                            stdOutput.timeout ? window.i18n.t('compare.stdTle') :
                                stdOutput.error ? window.i18n.t('compare.stdRe', { error: stdOutput.error }) :
                                    window.i18n.t('compare.stdExit', { code: stdOutput.exitCode });
                        try {
                            if (stdOutput.outputLimitExceeded) {
                                logWarn('[对拍器][OLE][STD]', {
                                    test: i,
                                    durationMs: stdOutput.time,
                                    limitBytes: stdOutput.outputLimitBytes,
                                    capturedBytes: stdOutput.capturedOutputBytes,
                                    observedBytes: stdOutput.observedOutputBytes
                                });
                            } else if (stdOutput.timeout) {
                                logWarn('[对拍器][TLE][STD]', { test: i, durationMs: stdOutput.time, limitMs: 0 });
                            } else {
                                logWarn('[对拍器][RE][STD]', { test: i, exitCode: stdOutput.exitCode, durationMs: stdOutput.time });
                            }
                        } catch (_) { }
                        task.state.errorResult = {
                            testNumber: i,
                            input: inputData,
                            stdOutput: errorMsg,
                            testOutput: window.i18n.t('compare.programNotRun'),
                            errorType: 'standard_program_error'
                        } as unknown as CompareErrorResult;
                        task.state.mode = 'error';
                        errorOccurred = true;
                        this.renderIfActive(task);
                        return;
                    }

                    const testFreopenContext = await this.prepareFreopenContext(task, 'test', i, inputData!);
                    let testOutput;
                    try {
                        const testRunOptions = testFreopenContext.workingDirectory
                            ? { executablePath: testExe, workingDirectory: testFreopenContext.workingDirectory }
                            : testExe;
                        testOutput = await this.runProgram(testRunOptions, testFreopenContext.runInput, timeLimit);
                        testOutput.output = await this.resolveProgramOutput(testOutput.output, testFreopenContext);
                    } finally {
                        await this.cleanupFreopenContext(testFreopenContext);
                    }
                    if (testOutput.outputLimitExceeded || testOutput.timeout || testOutput.error || testOutput.exitCode !== 0) {
                        const limitMbTest = Math.max(1, Math.floor((testOutput.outputLimitBytes || 0) / (1024 * 1024)));
                        const errorMsg = testOutput.outputLimitExceeded ? window.i18n.t('compare.testOle', { limit: limitMbTest }) :
                            testOutput.timeout ? window.i18n.t('compare.testTle') :
                                testOutput.error ? window.i18n.t('compare.testRe', { error: testOutput.error }) :
                                    window.i18n.t('compare.testExit', { code: testOutput.exitCode });
                        try {
                            if (testOutput.outputLimitExceeded) {
                                logWarn('[对拍器][OLE][TEST]', {
                                    test: i,
                                    durationMs: testOutput.time,
                                    limitBytes: testOutput.outputLimitBytes,
                                    capturedBytes: testOutput.capturedOutputBytes,
                                    observedBytes: testOutput.observedOutputBytes
                                });
                            } else if (testOutput.timeout) {
                                logWarn('[对拍器][TLE][TEST]', { test: i, durationMs: testOutput.time, limitMs: timeLimit });
                            } else {
                                logWarn('[对拍器][RE][TEST]', { test: i, exitCode: testOutput.exitCode, durationMs: testOutput.time });
                            }
                        } catch (_) { }
                        task.state.errorResult = {
                            testNumber: i,
                            input: inputData,
                            stdOutput: stdOutput.output,
                            testOutput: errorMsg,
                            errorType: 'test_program_error'
                        } as unknown as CompareErrorResult;
                        task.state.mode = 'error';
                        errorOccurred = true;
                        this.renderIfActive(task);
                        return;
                    }

                    if (task.config.useTestlib && spjExe) {
                        const spjResult = await this.judgeWithSpj(spjExe!, inputData!, testOutput.output!, stdOutput.output!, timeLimit);
                        if (spjResult !== 'AC') {
                            task.state.errorResult = {
                                testNumber: i,
                                input: inputData,
                                stdOutput: stdOutput.output,
                                testOutput: testOutput.output,
                                errorType: 'spj_error',
                                errorMessage: window.i18n.t('compare.spjResult', { result: spjResult })
                            } as unknown as CompareErrorResult;
                            task.state.mode = 'error';
                            errorOccurred = true;
                            this.renderIfActive(task);
                            return;
                        }
                    } else {
                        const outputsMatch = this.compareOutputs(stdOutput.output, testOutput.output);
                        if (!outputsMatch) {
                            try {
                                const diff = this.getDifferenceInfo((testOutput.output || '').trimEnd(), (stdOutput.output || '').trimEnd());
                                const diffText = diff ? `${diff.line}:${diff.char}` : 'none';
                                logInfo(`[对拍器][WA] test=${i} actualLen=${(testOutput.output || '').length} expectedLen=${(stdOutput.output || '').length} firstDiff=${diffText}`);
                            } catch (_) { }
                            task.state.errorResult = {
                                testNumber: i,
                                input: inputData,
                                stdOutput: stdOutput.output,
                                testOutput: testOutput.output,
                                usedSpj: false
                            } as unknown as CompareErrorResult;
                            task.state.mode = 'error';
                            errorOccurred = true;
                            this.renderIfActive(task);
                            return;
                        }
                    }

                    completed++;
                    this.updateTaskProgress(task);

                } catch (error) {
                    logError(`第 ${i} 组测试出错:`, error);
                    errorOccurred = true;
                    task.state.errorResult = {
                        testNumber: i,
                        input: '',
                        stdOutput: '',
                        testOutput: '',
                        usedSpj: false,
                        message: (error as Error)?.message || String(error)
                    } as unknown as CompareErrorResult;
                    task.state.mode = 'error';
                    this.renderIfActive(task);
                    return;
                }
            }
        };

        const workers = Array.from({ length: workerCount }, worker);
        await Promise.all(workers);

        task.state.currentTest = executed;
        task.state.completedTests = executed;
        this.updateTaskProgress(task);

        task.state.failedTests = failedGenerations;

        // 出错优先于停止：出错时面板已经是差异/错误视图，不要被「已停止」覆盖
        if (errorOccurred) {
            return;
        }

        if (task.state.shouldStop) {
            logInfo(`对拍被手动停止，已执行 ${executed} 组测试，其中有 ${failedGenerations} 组生成失败`);
            task.state.mode = 'stopped';
            task.state.stopped = true;
            task.state.warningMessage = failedGenerations > 0
                ? window.i18n.t('compare.genFailedWarning', { count: failedGenerations })
                : null;
            this.updateTaskStatus(task, window.i18n.t('compare.compareStopped', {
                completed: executed,
                failed: failedGenerations,
                count: executed
            }));
            this.renderIfActive(task);
            return;
        }

        const successfulTests = executed - failedGenerations;
        if (failedGenerations === 0) {
            logInfo(`对拍完成！共执行 ${successfulTests} 组测试，未发现差异`);
            task.state.mode = 'complete';
            task.state.warningMessage = null;
            this.renderIfActive(task);
        } else {
            logInfo(`对拍完成，但有 ${failedGenerations} 组数据生成失败。共成功执行 ${successfulTests} 组测试，未在成功组中发现差异`);
            task.state.mode = 'complete';
            task.state.warningMessage = window.i18n.t('compare.genFailedWarning', { count: failedGenerations });
            this.renderIfActive(task);
        }
    }

    renderIfActive(task: CompareTask) {
        if (!task) return;
        if (this.activeTaskKey === task.key) {
            this.renderTask(task);
        }
    }

    async generateTestData(generatorProgram: string | { executablePath: string; args: string[]; workingDirectory: string }, timeLimit: number) {
        try {
            const result = await this.runProgram(generatorProgram, '', timeLimit);

            if (result.outputLimitExceeded) {
                const limitBytes = result.outputLimitBytes || (256 * 1024 * 1024);
                const limitMb = Math.max(1, Math.floor(limitBytes / (1024 * 1024)));
                try {
                    logWarn('[对拍器][OLE][GEN]', {
                        durationMs: result.time,
                        limitBytes,
                        capturedBytes: result.capturedOutputBytes,
                        observedBytes: result.observedOutputBytes
                    });
                } catch (_) { }
                return {
                    success: false,
                    type: 'ole',
                    message: window.i18n.t('compare.genOle', { limit: limitMb }),
                    result
                };
            }

            if (result.timeout) {
                try { logWarn('[对拍器][TLE][GEN]', { durationMs: result.time, limitMs: timeLimit }); } catch (_) { }
                return {
                    success: false,
                    type: 'tle',
                    message: window.i18n.t('compare.genTle'),
                    result
                };
            }

            if (result.error || result.exitCode !== 0) {
                try {
                    logWarn('[对拍器][RE][GEN]', { exitCode: result.exitCode, durationMs: result.time });
                } catch (_) { }
                return {
                    success: false,
                    type: 're',
                    message: result.error || window.i18n.t('compare.genExit', { code: result.exitCode }),
                    result
                };
            }

            return {
                success: true,
                input: result.output,
                result
            };
        } catch (error) {
            logError('生成测试数据失败:', error);
            return {
                success: false,
                type: 'exception',
                message: (error as Error)?.message || window.i18n.t('compare.genDataError'),
                result: null
            };
        }
    }

    async runProgram(executablePath: string | { executablePath: string; workingDirectory: string }, input: string, timeLimit: number) {
        const execOptions = typeof executablePath === 'object'
            ? { ...(executablePath as { executablePath: string; workingDirectory: string }), skipPreKill: true }
            : { executablePath, skipPreKill: true };
        const result = (await window.electronAPI.runProgram(execOptions, input, timeLimit))!;
        // 不能把 trim 后的串当输出：生成器写出的前导空白属于测试数据，
        // 被测程序输出的前导空白也会影响 SPJ 判定。trim 只留给错误正文。
        const rawOutput = result.output || '';
        const trimmedOutput = rawOutput.trim();
        const outputLimitExceeded = !!result.outputLimitExceeded;
        let errorMessage = '';
        if (outputLimitExceeded) {
            const limitBytes = result.outputLimitBytes || (256 * 1024 * 1024);
            const limitMb = Math.max(1, Math.floor(limitBytes / (1024 * 1024)));
            errorMessage = window.i18n.t('compare.oleLimit', { limit: limitMb });
        } else if (result.exitCode !== 0) {
            errorMessage = trimmedOutput || result.stderr || window.i18n.t('compare.exitCode', { code: result.exitCode });
        }
        return {
            output: rawOutput,
            error: errorMessage,
            timeout: !!result.timeout,
            time: result.time,
            exitCode: result.exitCode,
            outputLimitExceeded,
            outputLimitBytes: result.outputLimitBytes,
            capturedOutputBytes: result.capturedOutputBytes,
            observedOutputBytes: result.observedOutputBytes
        };
    }

    normalizeFreopenFileName(value: string) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        return raw.replace(/[\\/]/g, '').replace(/[<>:"|?*]/g, '').trim();
    }

    buildFreopenTaskDirName(taskKey: string) {
        const normalized = String(taskKey || 'task').replace(/[\\/]/g, '_');
        return normalized.replace(/[<>:"|?*]/g, '_').slice(0, 120);
    }

    async prepareFreopenContext(task: CompareTask | null, role: string, caseIndex: number, inputData: string) {
        const inputFileName = this.normalizeFreopenFileName(task?.config?.freopenInputFile || '');
        const outputFileName = this.normalizeFreopenFileName(task?.config?.freopenOutputFile || '');

        if (!inputFileName && !outputFileName) {
            return {
                runInput: inputData,
                workingDirectory: null,
                outputFilePath: null,
                cleanupFiles: []
            };
        }

        const taskDirName = this.buildFreopenTaskDirName(task?.key || 'task');
        const baseDir = await window.electronAPI.getUserDataPath(['compare', 'freopen_runs', taskDirName]);
        const runDirName = `${role || 'program'}_${caseIndex || 0}`;
        const runDir = await window.electronAPI.pathJoin(baseDir, runDirName);

        await window.electronAPI.ensureDir(baseDir);
        await window.electronAPI.ensureDir(runDir);

        const cleanupFiles = [];
        let outputFilePath = null;

        if (inputFileName) {
            const inputFilePath = await window.electronAPI.pathJoin(runDir, inputFileName);
            await window.electronAPI.writeFile(inputFilePath, inputData || '');
            cleanupFiles.push(inputFilePath);
        }

        if (outputFileName) {
            outputFilePath = await window.electronAPI.pathJoin(runDir, outputFileName);
            cleanupFiles.push(outputFilePath);
        }

        return {
            runInput: inputFileName ? '' : inputData,
            workingDirectory: runDir,
            outputFilePath,
            cleanupFiles
        };
    }

    async cleanupFreopenContext(context: FreopenContext) {
        if (!context || !Array.isArray(context.cleanupFiles)) return;
        for (const filePath of context.cleanupFiles) {
            try {
                const exists = await window.electronAPI.checkFileExists(filePath);
                if (exists) {
                    await window.electronAPI.deleteFile(filePath);
                }
            } catch (_) { }
        }
    }

    async resolveProgramOutput(stdoutOutput: string, freopenContext: FreopenContext | null) {
        if (!freopenContext?.outputFilePath) {
            return stdoutOutput || '';
        }

        try {
            const exists = await window.electronAPI.checkFileExists(freopenContext.outputFilePath);
            if (!exists) {
                return stdoutOutput || '';
            }
            const output = await window.electronAPI.readFileContent(freopenContext.outputFilePath);
            return String(output || '').trim();
        } catch (_) {
            return stdoutOutput || '';
        }
    }

    compareOutputs(output1: string, output2: string) {
        const normalize = (str: string) => {
            return str.split('\n')
                .map((line: string) => line.trimEnd())
                .join('\n')
                .replace(/\n+$/, '');
        };

        const normalized1 = normalize(output1 || '');
        const normalized2 = normalize(output2 || '');

        return normalized1 === normalized2;
    }

    async judgeWithSpj(spjExecutablePath: string, inputData: string, actualOutput: string, expectedOutput: string, timeLimit: number) {
        try {
            const timestamp = Date.now();
            const inputFile = await window.electronAPI.saveTempFile(`spj_input_${timestamp}.txt`, inputData);
            const actualFile = await window.electronAPI.saveTempFile(`spj_actual_${timestamp}.txt`, actualOutput);
            const expectedFile = await window.electronAPI.saveTempFile(`spj_expected_${timestamp}.txt`, expectedOutput);

            try {
                const workingDir = await window.electronAPI.pathDirname(spjExecutablePath);
                const spjParams = {
                    executablePath: spjExecutablePath,
                    args: [inputFile, actualFile, expectedFile],
                    timeLimit: timeLimit,
                    workingDirectory: workingDir,
                    skipPreKill: true
                };

                const spjResult = await window.electronAPI.runProgram(spjParams);

                if (spjResult!.outputLimitExceeded) {
                    return 'OLE';
                } else if (spjResult!.timeout) {
                    return 'TLE';
                } else if (spjResult!.exitCode === 0) {
                    return 'AC';
                } else {
                    return 'WA';
                }
            } finally {
                await window.electronAPI.deleteTempFile(inputFile);
                await window.electronAPI.deleteTempFile(actualFile);
                await window.electronAPI.deleteTempFile(expectedFile);
            }
        } catch (error) {
            return 'SPJ Error';
        }
    }

    async getMaxParallelThreads() {
        const fallbackThreads = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 2;
        let cpuThreads = fallbackThreads;
        try {
            const remoteCount = (await window.electronAPI?.getCpuThreads?.()) as number;
            if (Number.isFinite(remoteCount) && remoteCount > 0) {
                cpuThreads = remoteCount;
            }
        } catch (_) { }
        const maxParallel = Math.max(1, Math.round(cpuThreads * 0.6));
        return { cpuThreads, maxParallel };
    }

    async ensureThreadLimitUI() {
        try {
            const { cpuThreads, maxParallel } = await this.getMaxParallelThreads();
            this.maxParallelThreads = maxParallel;
            const input = ccInput('compare-threads');
            const hint = (document.getElementById('compare-threads-hint'));
            if (input) {
                input.max = String(maxParallel);
                const current = parseInt(input.value);
                if (Number.isFinite(current)) {
                    const capped = Math.max(1, Math.min(current, maxParallel));
                    if (capped !== current) input.value = String(capped);
                } else {
                    // 留空 = 自动：直接落到上限，避免用户默认只跑单线程
                    input.value = String(maxParallel);
                }
            }
            if (hint) {
                hint.textContent = window.i18n.t('compare.threadHint');
            }
            logInfo('[对拍器] 线程上限已更新', { cpuThreads, maxParallel });
        } catch (error) {
            logWarn('[对拍器] 获取线程上限失败', error);
        }
    }

    stopComparison() {
        const task = this.getActiveTask();
        if (!task) return;
        task.state.shouldStop = true;
        task.state.isRunning = false;
        // 保持 stopping 而非 idle：主进程随后才发 compare-complete {stopped:true}，
        // 提前置 idle 会让完成事件走 else 分支，完成数与停止文案全部丢失
        if (task.state.mode === 'running') {
            task.state.mode = 'stopping';
        }
        this.renderTask(task);
        window.electronAPI.stopCompare().catch(() => {});
    }

    resetComparison() {
        const task = this.getActiveTask();
        if (!task) return;
        const running = task.state.isRunning || task.state.mode === 'running' || task.state.mode === 'stopping';
        // 重置 = 中止 + 清空。以前运行中直接把按钮禁掉，用户点了没反应；
        // 现在允许中途清场，但必须先把引擎停掉、监听摘掉，否则迟到的 complete
        // 会在已经清空的面板上弹一个「已手动停止」。
        if (running) {
            try { this.runCleanups.get(task.key)?.(); } catch (_) {}
            this.runCleanups.delete(task.key);
            try { window.electronAPI.stopCompare().catch(() => {}); } catch (_) {}
        }
        this.stopStatsTicker();
        task.state.shouldStop = true;
        task.state.isRunning = false;
        task.state.currentTest = 0;
        task.state.totalTests = 0;
        task.state.completedTests = 0;
        task.state.failedTests = 0;
        task.state.stopped = false;
        task.state.statusText = (window.i18n.t('compare.ready'));
        task.state.errorResult = null;
        task.state.warningMessage = null;
        task.state.incompleteRun = null;
        task.state.stats = this.createCompareStats(0);
        task.state.engineWarnings = [];
        task.state.mode = 'idle';
        const progressFill = (document.getElementById('progress-fill'));
        if (progressFill) progressFill.style.width = '0%';
        this.renderTask(task);
    }

    // 一个键三种状态：空闲→开始；跑着→停止（中止，但把已跑出来的结果留着看）；
    // 跑完/出错/已停止→清空。三个键并排时「重置」在运行中是死按钮、空闲时又是空操作，
    // 而点「开始」本来就会先清场再跑 —— 三个概念其实是一个。
    getCompareActionState(task: CompareTask | null): 'start' | 'stop' | 'clear' {
        const running = !!task?.state?.isRunning && (task?.state?.mode === 'running' || task?.state?.mode === 'stopping');
        if (running) return 'stop';
        const st = task?.state;
        if (!st) return 'start';
        const hasTrace = st.mode !== 'idle' || !!st.errorResult || st.completedTests > 0
            || !!st.stats?.startedAt || (st.engineWarnings?.length || 0) > 0;
        return hasTrace ? 'clear' : 'start';
    }

    applyCompareActionState(task: CompareTask | null) {
        const btn = ccButton('compare-run-btn');
        if (!btn) return;
        const action = this.getCompareActionState(task);
        btn.dataset['cmpState'] = action;
        const key = action === 'start' ? 'compare.start' : (action === 'stop' ? 'compare.stop' : 'compare.clear');
        const text = ccT(key);
        // data-i18n 跟着改写：切语言时 _applyToDOM 会自己把这句文案换过来。
        // 不挂它就得等下次 renderTask 才更新，中途切语言界面会半中半英。
        const label = (document.getElementById('compare-run-label'));
        if (label) {
            label.setAttribute('data-i18n', key);
            label.textContent = text;
        }
        btn.title = text;
        // 按过停止到 runTask 收口之间还有一段收尾，此时再点一次是空操作
        btn.disabled = action === 'stop' && (!!task?.state?.shouldStop || !!task?.state?.starting);
    }

    onCompareActionClick() {
        const task = this.getActiveTask();
        const action = this.getCompareActionState(task);
        if (action === 'stop') {
            // 收尾期间按钮已禁用，这里再挡一道：禁用样式与状态判定分属两处，别只靠一边
            if (task?.state?.shouldStop || task?.state?.starting) return;
            this.stopComparison();
            return;
        }
        if (action === 'clear') {
            this.resetComparison();
            return;
        }
        this.startComparison();
    }

    updateUIForTask(task: CompareTask | null) {
        this.applyCompareActionState(task);
    }

    updateStatusText(text: string) {
        const statusText = (document.getElementById('status-text'));
        if (statusText) statusText.textContent = text;
    }

    updateTaskStatus(task: CompareTask, text: string) {
        if (!task) return;
        task.state.statusText = text;
        if (this.activeTaskKey === task.key) {
            this.updateStatusText(text);
        }
    }

    // 只表示「已完成 N 组 / 共 M 组」，不表示当前正在跑第几组，
    // 避免与状态栏的「第 i 组测试」（由 nextIndex 分配）语义混淆、并行时互相矛盾
    updateProgress(completedTests: number, totalTests: number) {
        const progressLabel = (document.getElementById('current-test'));
        const progressFill = (document.getElementById('progress-fill'));

        if (progressLabel) {
            progressLabel.textContent = window.i18n.t('compare.progressGroup', { current: completedTests, total: totalTests });
        }

        if (progressFill && totalTests > 0) {
            const percentage = Math.max(0, Math.min(100, (completedTests / totalTests) * 100));
            progressFill.style.width = `${percentage}%`;
        }
    }

    updateTaskProgress(task: CompareTask) {
        if (!task) return;
        if (this.activeTaskKey !== task.key) return;
        this.updateProgress(task.state.currentTest, task.state.totalTests);
    }

    // startedAt = 0 表示「本轮还没开始」，finishCompareTask 靠它决定要不要结算耗时
    createCompareStats(startedAt: number): CompareStats {
        return {
            startedAt,
            elapsedMs: 0,
            totalGroups: 0,
            window: [],
            slowest: null,
            lastSample: null
        };
    }

    recordCompareSample(task: CompareTask, data: { testIndex?: number; genMs?: number; stdMs?: number; testMs?: number; genLen?: number }) {
        const stats = task?.state?.stats;
        if (!stats) return;
        const genMs = Number(data.genMs) || 0;
        const stdMs = Number(data.stdMs) || 0;
        const testMs = Number(data.testMs) || 0;
        // std 与 test 是并发跑的（fastspawn 的 runFastPair 一次调用给两侧同一个 pair.ms，
        // js 路径也是先起两个再 Promise.all），相加会把并行度算丢，取 max 才是这组的真实时长。
        const sample: CompareGroupSample = {
            testIndex: Number(data.testIndex) || 0,
            genMs,
            stdMs,
            testMs,
            totalMs: genMs + Math.max(stdMs, testMs),
            genLen: Number(data.genLen) || 0,
            atMs: performance.now()
        };
        stats.totalGroups++;
        stats.window.push(sample);
        while (stats.window.length > COMPARE_STATS_WINDOW) stats.window.shift();
        if (!stats.slowest || sample.totalMs > stats.slowest.totalMs) stats.slowest = sample;
        stats.lastSample = sample;
    }

    recordEngineWarning(task: CompareTask, data: { code?: string; completed?: number; total?: number; missing?: number; message?: string }) {
        const list = task?.state?.engineWarnings;
        if (!list) return;
        list.push({
            code: String(data?.code || ''),
            completed: Number(data?.completed) || 0,
            total: Number(data?.total) || 0,
            missing: Number(data?.missing) || 0,
            message: data?.message || ''
        });
    }

    // TPS 只能用墙钟算：worker 是并行的，把各组耗时相加再取倒数算出来的是
    // 「单个 worker 的吞吐」，比真实吞吐低一个并行度，面板上会误导成引擎变慢。
    getCompareTps(stats: CompareStats | null | undefined): number | null {
        if (!stats || stats.window.length < 2) return null;
        const newest = stats.window[stats.window.length - 1];
        const oldest = stats.window[0];
        if (!newest || !oldest) return null;
        const spanMs = newest.atMs - oldest.atMs;
        if (!(spanMs > 0)) return null;
        return (stats.window.length - 1) * 1000 / spanMs;
    }

    settleCompareStats(task: CompareTask | null) {
        const stats = task?.state?.stats;
        if (!stats || !stats.startedAt) return;
        stats.elapsedMs = performance.now() - stats.startedAt;
    }

    // 用时按独立定时器走表。只在 progress 到达时刷的话：一组慢程序跑 2 秒期间一条事件都没有，
    // 数字先冻住、再突然跳一大截，看着就像卡死或者计时不准。
    startStatsTicker(task: CompareTask) {
        this.stopStatsTicker();
        this.statsTicker = setInterval(() => {
            if (task.state.mode === 'idle') { this.stopStatsTicker(); return; }
            this.renderCompareStats(task, true);
        }, COMPARE_STATS_TICK_MS) as unknown as number;
    }

    stopStatsTicker() {
        if (this.statsTicker === null || this.statsTicker === undefined) return;
        clearInterval(this.statsTicker);
        this.statsTicker = null;
    }

    getCompareElapsedMs(task: CompareTask | null): number {
        const stats = task?.state?.stats;
        if (!stats) return 0;
        if (!stats.startedAt) return stats.elapsedMs;
        return stats.elapsedMs || (performance.now() - stats.startedAt);
    }

    formatCompareMs(ms: number): string {
        const v = Number(ms);
        if (!Number.isFinite(v) || v < 0) return '—';
        if (v < 1000) return `${Math.round(v)}ms`;
        return `${(v / 1000).toFixed(v < 10000 ? 2 : 1)}s`;
    }

    renderCompareStats(task: CompareTask | null, force = false) {
        // 只画当前显示中的那个任务：对拍跑在后台时用户可能已经切到别的文件，
        // 拿别人的数字刷这块面板等于把两个任务的数据叠在一起显示。
        if (!task || !task.key || this.activeTaskKey !== task.key) return;
        const el = (document.getElementById('compare-stats'));
        if (!el) return;
        const stats = task.state.stats;
        if (!stats || (!stats.startedAt && !stats.totalGroups)) {
            el.style.display = 'none';
            return;
        }
        if (!force) {
            const now = performance.now();
            if (this.statsPaintedAt && now - this.statsPaintedAt < COMPARE_STATS_PAINT_MS) return;
            this.statsPaintedAt = now;
        }
        const t = (key: string, params?: Record<string, string | number>) => window.i18n?.t?.(key, params) || key;
        const tps = this.getCompareTps(stats);
        const slowest = stats.slowest;
        const cells: string[] = [
            t('compare.statsTps', { value: tps === null ? '—' : tps.toFixed(1) }),
            t('compare.statsElapsed', { value: this.formatCompareMs(this.getCompareElapsedMs(task)) }),
            slowest
                ? t('compare.statsSlowest', { number: slowest.testIndex, value: this.formatCompareMs(slowest.totalMs) })
                : t('compare.statsSlowestNone'),
            t('compare.statsDataSize', { size: stats.lastSample ? this.formatCompareBytes(stats.lastSample.genLen) : '—' })
        ];
        const grid = document.createElement('div');
        grid.className = 'cmp-stats-grid';
        cells.forEach((text, index) => {
            const cell = document.createElement('span');
            // TPS 是这一栏里唯一要盯的数，加粗；其余是次要信息
            cell.className = index === 0 ? 'cmp-stat cmp-stat-strong' : 'cmp-stat';
            cell.textContent = text;
            grid.appendChild(cell);
        });
        // 全用 createElement + textContent 拼：这里不插任何引擎回传的文本，
        // fastspawn 的英文技术细节留在日志里，界面只给一句本地化的定性提示。
        el.textContent = '';
        el.appendChild(grid);
        for (const warning of (task.state.engineWarnings || [])) {
            // Windows 上 fastspawn.node 按设计不编译（scripts/build-fastspawn.js 直接跳过并写明
            // 走 child_process），把它报成「退回较慢的路径」是每个 Windows 用户永远消不掉的一条假警告。
            // POSIX 上这个模块本该在，缺失才是真降级。日志里两条都照记。
            if (warning.code === 'fastspawn_fallback' && window.process?.platform === 'win32') continue;
            const chip = document.createElement('div');
            chip.className = 'cmp-stats-warn';
            chip.textContent = warning.code === 'engine_timeout'
                ? t('compare.statsWatchdogWarn', { completed: warning.completed, total: warning.total })
                : t('compare.statsFastspawnWarn');
            el.appendChild(chip);
        }
        el.style.display = '';
    }

    showStatus() {
        const statusSection = (document.getElementById('compare-status'));
        if (statusSection) {
            statusSection.style.display = 'block';
        }
        this.hideError();
        this.hideComplete();
    }

    hideStatus() {
        const statusSection = (document.getElementById('compare-status'));
        if (statusSection) {
            statusSection.style.display = 'none';
        }
    }

    showError(errorResult: CompareErrorResult) {
        const errorSection = (document.getElementById('compare-result'));
        const errorTitle = (document.getElementById('error-title'));
        const errorTestNum = (document.getElementById('error-test-num'));
        const inputDiff = (document.getElementById('input-diff'));
        const stdOutputDiff = (document.getElementById('std-output-diff'));
        const testOutputDiff = (document.getElementById('test-output-diff'));
        const stdOutputDiffLabel = (document.getElementById('std-output-diff-label'));
        const testOutputDiffLabel = (document.getElementById('test-output-diff-label'));
        const inputExpandBtn = (document.getElementById('input-expand-btn'));
        const stdOutputExpandBtn = (document.getElementById('std-output-expand-btn'));
        const testOutputExpandBtn = (document.getElementById('test-output-expand-btn'));

        this.updateErrorOutputExpandButton(inputExpandBtn!, errorResult, 'input');
        this.updateErrorOutputExpandButton(stdOutputExpandBtn!, errorResult, 'std');
        this.updateErrorOutputExpandButton(testOutputExpandBtn!, errorResult, 'test');

        if (errorResult && errorSection) {
            errorSection.style.display = 'block';

            if (errorTitle) {
                const errType = errorResult.errorType;
                if (errType === 'generator_program_error') {
                    const generatorType = errorResult.generatorErrorType || '';
                    let detailLabel = window.i18n.t('compare.errorRuntime');
                    if (generatorType === 'ole') {
                        detailLabel = window.i18n.t('compare.errorOutputLimit');
                    } else if (generatorType === 'tle') {
                        detailLabel = window.i18n.t('compare.errorTimeout');
                    } else if (generatorType === 're') {
                        detailLabel = window.i18n.t('compare.errorRuntime');
                    }
                    errorTitle.textContent = (window.i18n.t('compare.errorDataGeneratorPrefix')) + detailLabel;
                } else if (errType === 'standard_program_error' || errType === 'test_program_error') {
                    errorTitle.textContent = window.i18n.t('compare.errorRunTimeout');
                } else if (errType === 'compile_error') {
                    const compileTypeMap: Record<string, string> = {
                        'standard': window.i18n.t('compare.stdCompileFail'),
                        'test': window.i18n.t('compare.testCompileFail'),
                        'generator': window.i18n.t('compare.genCompileFail'),
                        'settings': window.i18n.t('compare.envNotSet'),
                        'general': window.i18n.t('compare.compileFail')};
                    errorTitle.textContent = compileTypeMap[errorResult.compileType] || (window.i18n.t('compare.compileFail'));
                } else if (errType === 'generator') {
                    errorTitle.textContent = (window.i18n.t('compare.errorDataGeneratorPrefix')) + (window.i18n.t('compare.errorRuntime'));
                } else if (errType === 'std_tle' || errType === 'test_tle') {
                    errorTitle.textContent = window.i18n.t('compare.errorRunTimeout');
                } else if (errType === 'std_re' || errType === 'test_re') {
                    errorTitle.textContent = window.i18n.t('compare.errorRuntime');
                } else if (errType === 'output_limit') {
                    errorTitle.textContent = window.i18n.t('compare.errorOutputLimit');
                } else if (errType === 'worker_crash' || errType === 'engine' || errType === 'exception' || errType === 'fastspawn_fallback' || errType === 'incomplete_run') {
                    errorTitle.textContent = window.i18n.t('compare.engineError');
                } else {
                    errorTitle.textContent = window.i18n.t('compare.foundDiff');
                }
            }

            if (errorTestNum) {
                // 编译失败 / 引擎级错误没有具体组号，不渲染「第 0 组」
                errorTestNum.textContent = Number(errorResult.testNumber) > 0
                    ? window.i18n.t('compare.errorGroup', { number: errorResult.testNumber })
                    : '';
            }

            if (inputDiff) {
                const inputFull = errorResult.input || '';
                const shown = errorResult.inputExpanded ? inputFull : this.limitOutputLines(inputFull, 100);
                inputDiff.textContent = errorResult.inputTruncated
                    ? shown + '\n' + window.i18n.t('compare.outputTruncated')
                    : shown;
            }

            // SPJ 不跑正解，没有「标准程序输出」可展示。留一个空面板比不展示更糟 ——
            // 它读起来像「正解跑了但没输出」。整节藏掉；每条错误都重设一次 display，
            // 不让上一条的隐藏状态漏到下一条。
            const stdDiffSection = stdOutputDiff ? stdOutputDiff.parentElement : null;
            if (stdDiffSection) {
                stdDiffSection.style.display = (errorResult.usedSpj && !errorResult.stdOutput) ? 'none' : '';
            }

            if (stdOutputDiff) {
                const errType = errorResult.errorType;
                if (errType === 'compile_error') {
                    stdOutputDiff.textContent = errorResult.errorMessage;
                    if (stdOutputDiffLabel) {
                        stdOutputDiffLabel.textContent = window.i18n.t('compare.errorStandardOutput');
                    }
                } else if (errType === 'generator_program_error') {
                    const stdFullOutput = errorResult.stdOutput || '';
                    stdOutputDiff.textContent = errorResult.stdOutputExpanded ? stdFullOutput : this.limitOutputLines(stdFullOutput, 100);
                    if (stdOutputDiffLabel) {
                        stdOutputDiffLabel.textContent = window.i18n.t('compare.errorGeneratorOutput');
                    }
                } else if (errType === 'standard_program_error' || errType === 'test_program_error') {
                    const stdFullOutput = errorResult.stdOutput || '';
                    stdOutputDiff.textContent = errorResult.stdOutputExpanded ? stdFullOutput : this.limitOutputLines(stdFullOutput, 100);
                    if (stdOutputDiffLabel) {
                        stdOutputDiffLabel.textContent = window.i18n.t('compare.errorStandardOutput');
                    }
                } else if (this.isEngineErrorType(errType)) {
                    const engineMessage = this.buildEngineErrorText(errorResult);
                    stdOutputDiff.textContent = errorResult.stdOutputExpanded ? engineMessage : this.limitOutputLines(engineMessage, 100);
                    if (stdOutputDiffLabel) {
                        stdOutputDiffLabel.textContent = this.getEngineErrorLabel(errType, 'std');
                    }
                } else {
                    if (errorResult.usedSpj) {
                        if (stdOutputDiffLabel) {
                            stdOutputDiffLabel.textContent = window.i18n.t('compare.errorStandardOutput');
                        }
                        const stdFullOutput = errorResult.stdOutput || '';
                        stdOutputDiff.textContent = errorResult.stdOutputExpanded ? stdFullOutput : this.limitOutputLines(stdFullOutput, 100);
                    } else {
                        // 输出被引擎截断时算出的行列对真实输出不可信，只提示不可靠
                        const truncated = !!(errorResult.stdOutputTruncated || errorResult.testOutputTruncated);
                        const diffPosition = truncated ? null : this.getDifferenceInfo(errorResult.stdOutput, errorResult.testOutput);
                        if (stdOutputDiffLabel) {
                            if (truncated) {
                                stdOutputDiffLabel.innerHTML = (window.i18n.t('compare.errorStandardOutput')) + ` <span class="diff-info">(${window.i18n.t('compare.diffPositionUnreliable')})</span>`;
                            } else if (diffPosition) {
                                const diffMsg = window.i18n.t('compare.diffPosition', { line: diffPosition.line, char: diffPosition.char });
                                stdOutputDiffLabel.innerHTML = (window.i18n.t('compare.errorStandardOutput')) + ` <span class="diff-info">(${diffMsg})</span>`;
                            } else {
                                stdOutputDiffLabel.textContent = window.i18n.t('compare.errorStandardOutput');
                            }
                        }
                        if (errorResult.stdOutputExpanded) {
                            this.renderExpandedOutput(stdOutputDiff, errorResult.stdOutput);
                        } else {
                            stdOutputDiff.innerHTML = this.formatCompareOutput(errorResult.stdOutput, errorResult.testOutput, 'standard', truncated);
                        }
                    }
                }
            }

            if (testOutputDiff) {
                const errType = errorResult.errorType;
                if (errType === 'compile_error') {
                    testOutputDiff.textContent = '';
                    if (testOutputDiffLabel) {
                        testOutputDiffLabel.textContent = window.i18n.t('compare.errorTestOutput');
                    }
                } else if (errType === 'generator_program_error') {
                    const testFullOutput = errorResult.testOutput || '';
                    testOutputDiff.textContent = errorResult.testOutputExpanded ? testFullOutput : this.limitOutputLines(testFullOutput, 100);
                    if (testOutputDiffLabel) {
                        testOutputDiffLabel.textContent = window.i18n.t('compare.errorStdTestOutput');
                    }
                } else if (errType === 'standard_program_error' || errType === 'test_program_error') {
                    const testFullOutput = errorResult.testOutput || '';
                    testOutputDiff.textContent = errorResult.testOutputExpanded ? testFullOutput : this.limitOutputLines(testFullOutput, 100);
                    if (testOutputDiffLabel) {
                        testOutputDiffLabel.textContent = window.i18n.t('compare.errorTestOutput');
                    }
                } else if (this.isEngineErrorType(errType)) {
                    const engineMessage = this.buildEngineErrorText(errorResult);
                    testOutputDiff.textContent = errorResult.testOutputExpanded ? engineMessage : this.limitOutputLines(engineMessage, 100);
                    if (testOutputDiffLabel) {
                        testOutputDiffLabel.textContent = this.getEngineErrorLabel(errType, 'test');
                    }
                } else {
                    if (errorResult.usedSpj) {
                        if (testOutputDiffLabel) {
                            testOutputDiffLabel.textContent = window.i18n.t('compare.errorTestOutput');
                        }
                        const testFullOutput = errorResult.testOutput || '';
                        testOutputDiff.textContent = errorResult.testOutputExpanded ? testFullOutput : this.limitOutputLines(testFullOutput, 100);
                    } else {
                        const truncated = !!(errorResult.stdOutputTruncated || errorResult.testOutputTruncated);
                        const diffPosition = truncated ? null : this.getDifferenceInfo(errorResult.testOutput, errorResult.stdOutput);
                        if (testOutputDiffLabel) {
                            if (truncated) {
                                testOutputDiffLabel.innerHTML = (window.i18n.t('compare.errorTestOutput')) + ` <span class="diff-info">(${window.i18n.t('compare.diffPositionUnreliable')})</span>`;
                            } else if (diffPosition) {
                                const diffMsg = window.i18n.t('compare.diffPosition', { line: diffPosition.line, char: diffPosition.char });
                                testOutputDiffLabel.innerHTML = (window.i18n.t('compare.errorTestOutput')) + ` <span class="diff-info">(${diffMsg})</span>`;
                            } else {
                                testOutputDiffLabel.textContent = window.i18n.t('compare.errorTestOutput');
                            }
                        }
                        if (errorResult.testOutputExpanded) {
                            this.renderExpandedOutput(testOutputDiff, errorResult.testOutput);
                        } else {
                            testOutputDiff.innerHTML = this.formatCompareOutput(errorResult.testOutput, errorResult.stdOutput, 'test', truncated);
                        }
                    }
                }
            }

            this.updateErrorOutputExpandButton(inputExpandBtn!, errorResult, 'input');
            this.updateErrorOutputExpandButton(stdOutputExpandBtn!, errorResult, 'std');
            this.updateErrorOutputExpandButton(testOutputExpandBtn!, errorResult, 'test');
        }

        this.hideStatus();
        this.hideComplete();
    }

    // 'output_limit' 之前不在列表里，会掉进 else 分支被当成 WA 渲染
    // spj_wa / spj_pe / spj_partial 故意不在这个列表里：它们是 checker 对**被测程序**
    // 的判定，属于「结果不同」，要走双栏输出视图；而 spj_error / spj_tle / spj_fail 是
    // 评测器自己出了问题，跟被测程序无关，必须与引擎错误同样处理。
    isEngineErrorType(errType: string) {
        return ['generator', 'std_tle', 'std_re', 'test_tle', 'test_re', 'output_limit', 'worker_crash', 'engine', 'exception', 'fastspawn_fallback', 'incomplete_run', 'spj_error', 'spj_tle'].includes(errType);
    }

    getEngineErrorLabel(errType: string, panel: string) {
        const isStd = panel === 'std';
        if (errType === 'generator') {
            return window.i18n.t('compare.errorGeneratorOutput');
        }
        if (errType === 'output_limit') {
            return window.i18n.t('compare.errorOutputLimit');
        }
        if (errType === 'std_tle' || errType === 'std_re') {
            return window.i18n.t(isStd ? 'compare.errorStandardOutput' : 'compare.errorStdTestOutput');
        }
        if (errType === 'test_tle' || errType === 'test_re') {
            return window.i18n.t(isStd ? 'compare.errorStdTestOutput' : 'compare.errorTestOutput');
        }
        if (errType === 'spj_error' || errType === 'spj_tle') {
            return window.i18n.t('compare.errorSpjOutput');
        }
        return window.i18n.t('compare.engineError');
    }

    // 本地化文案在前，原始技术细节（含可能的英文）折叠在后，仅供排查
    buildEngineErrorText(errorResult: CompareErrorResult) {
        const localized = errorResult.errorMessage || '';
        const raw = (errorResult.rawErrorMessage || '').trim();
        if (!raw || raw === localized) return localized;
        return localized ? `${localized}\n[${raw}]` : `[${raw}]`;
    }

    // 引擎/worker 只给稳定的 code，具体文案由渲染层查 i18n，避免英文直入中文界面
    // 完成/停止收尾的告警文案：跑漏的组数优先于「生成失败的组数」。后者的文案本身就说
    // 「N 组没生成」，前者却是整屏的 100% —— 缺口只有在完成面板这一行里才看得见。
    // 译文直接复用引擎码表：incomplete_run 走告警通道，不这样接一次，码表里那条
    // compare.incompleteRun 就没有任何调用方。
    getCompletionWarningMessage(task: CompareTask, failed: number): string | null {
        const gap = task.state.incompleteRun;
        if (gap) {
            return this.getEngineErrorMessage({
                code: 'incomplete_run',
                completed: gap.completed,
                total: gap.total,
                missing: gap.missing
            });
        }
        return failed > 0 ? window.i18n.t('compare.genFailedWarning', { count: failed }) : null;
    }

    getEngineErrorMessage(error: EngineError) {
        const code = error?.code || '';
        const exitCode = error?.exitCode;
        const map: Record<string, string> = {
            gen_timeout: 'compare.genTle',
            // 键名是 generatorRunFailed，语言包里没有 compare.genRunFailed
            gen_error: 'compare.generatorRunFailed',
            gen_exit: 'compare.genExit',
            std_timeout: 'compare.stdTle',
            std_exit: 'compare.stdExit',
            std_error: 'compare.stdRe',
            test_timeout: 'compare.testTle',
            test_exit: 'compare.testExit',
            test_error: 'compare.testRe',
            output_limit: 'compare.errorOutputLimitDetail',
            mismatch: 'compare.foundDiff',
            // checker 的判词（testlib quitf 的第二参数）在引擎侧就是 message，这里透传，
            // 否则用户只看到「答案错误」而拿不到「第几个 token 不对」这种关键信息
            spj_wa: 'compare.spjWa',
            spj_pe: 'compare.spjPe',
            spj_partial: 'compare.spjPartial',
            spj_timeout: 'compare.spjTimeout',
            spj_fail: 'compare.spjFail',
            spj_error: 'compare.spjError',
            exception: 'compare.engineError',
            engine_start: 'compare.engineError',
            worker_crash: 'compare.engineError',
            fastspawn_fallback: 'compare.fastspawnFallback',
            incomplete_run: 'compare.incompleteRun'
        };
        const key = map[code as string];
        if (!key) return window.i18n.t('compare.engineError');
        const count = (value: number | null | undefined) =>
            (typeof value === 'number' && Number.isFinite(value) ? value : 0);
        // i18next 只在拿到变量表时才跑插值 —— 漏传 params 不报错，是把 {code} 原样留在界面上。
        // 所以不管这条模板用不用得上，手头有的字段一律带上：多传的键被忽略，少传的那个
        // 就是屏幕上的半成品文案。
        return window.i18n.t(key, {
            // 被信号杀死时 exitCode 就是 null（POSIX：OOM / 强杀 / 栈溢出撞 SIGSEGV），不是边角
            code: (typeof exitCode === 'number' && Number.isFinite(exitCode))
                ? exitCode
                : window.i18n.t('compare.exitCodeUnknown'),
            error: error?.message || '',
            completed: count(error?.completed),
            total: count(error?.total),
            missing: count(error?.missing)
        });
    }

    hideError() {
        const errorSection = (document.getElementById('compare-result'));
        if (errorSection) {
            errorSection.style.display = 'none';
        }
    }

    // 实际完成数（成功比对 + 生成失败均计入已执行），不再回退到计划数
    getCompletedCount(task: CompareTask) {
        const completed = task?.state?.completedTests;
        if (Number.isFinite(completed)) return completed;
        const total = task?.state?.totalTests;
        return Number.isFinite(total) ? total : 0;
    }

    showComplete(completedCount: number, warningMessage: string | null = null, stopped = false) {
        const completeSection = (document.getElementById('compare-complete'));
        const completedTests = (document.getElementById('completed-tests'));
        const completeInfo = completeSection?.querySelector('.complete-info span');

        if (completeSection) {
            // 交给 CSS 控制（.compare-complete 是 block + 居中的卡片）；
            // 写成 flex 会变成横向排列，把图标/文字/信息挤在一行。
            completeSection.style.display = '';
        }

        if (completedTests) {
            completedTests.textContent = completedCount as unknown as string;
        }

        if (warningMessage && completeInfo) {
            // 这里是 innerHTML 出口。以前靠 i18next 对插值做 HTML 转义兜底，而那个转义
            // 会同时把喂给 textContent / 原生对话框的消息弄成 &#x2F; 残渣（见 #11）。
            // 关掉全局 escape 后，必须在 sink 处显式转义 —— 同文件 2430 行的 escapeHtml
            // 就是为这种位置准备的。
            completeInfo.innerHTML = (window.i18n.t('compare.completedWithWarning', { count: completedCount, warning: this.escapeHtml(warningMessage) }));
        } else if (completeInfo) {
            completeInfo.innerHTML = stopped
                ? (window.i18n.t('compare.stoppedText', { count: completedCount }))
                : (window.i18n.t('compare.completedText', { count: completedCount }));
        }

        this.hideStatus();
        this.hideError();
    }

    hideComplete() {
        const completeSection = (document.getElementById('compare-complete'));
        if (completeSection) {
            completeSection.style.display = 'none';
        }
    }

    showTaskCompileError(task: CompareTask | null, errorType: string, errorMessage: string) {
        if (!task) {
            this.showError({
                errorType: 'compile_error',
                compileType: errorType,
                errorMessage: errorMessage,
                testNumber: 0,
                input: '',
                stdOutput: '',
                testOutput: ''
            } as unknown as CompareErrorResult);
            this.hideStatus();
            this.hideComplete();
            return;
        }

        task.state.errorResult = {
            errorType: 'compile_error',
            compileType: errorType,
            errorMessage: errorMessage,
            testNumber: 0,
            input: '',
            stdOutput: '',
            testOutput: ''
        } as unknown as CompareErrorResult;
        task.state.mode = 'error';
        task.state.isRunning = false;
        task.state.shouldStop = true;

        if (this.activeTaskKey === task.key) {
            this.renderTask(task);
        }

        try {
            logError('[CompareCompileError]', {
                type: errorType,
                message: String(errorMessage || ''),
                context: {
                    standardCode: task.config.standardCodePath,
                    testCode: task.config.testCodePath,
                    generator: task.config.generatorPath,
                    useTestlib: task.config.useTestlib,
                    spjPath: task.config.spjPath,
                    freopenInputFile: task.config.freopenInputFile,
                    freopenOutputFile: task.config.freopenOutputFile
                }
            });
        } catch (_) { }
        try {
            const text = String(errorMessage || '');
            const lines = text.split(/\r?\n/).filter(l => l.trim());
            const diags = [];
            for (const line of lines) {
                const m = line.match(/^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.+)$/i);
                if (m) {
                    const [, file, lineNum, colNum, sev, msg] = m;
                    diags.push({
                        file,
                        line: parseInt(lineNum!, 10) || 1,
                        column: colNum ? parseInt(colNum, 10) : 1,
                        severity: /fatal error|error/i.test(sev!) ? 'error' : (/warning/i.test(sev!) ? 'warning' : 'note'),
                        message: msg,
                        raw: line
                    });
                }
            }
            if (diags.length && window.editorManager && window.editorManager.applyDiagnostics) {
                window.editorManager.applyDiagnostics(diags);
            }
        } catch { }
    }

    // 完成面板的数字现在是真实的完成组数，不能再被拿来当任意提示文案展示
    showSuccessMessage(message: string) {
        logInfo(String(message || ''));
    }

    renderExpandedOutput(element: HTMLElement, output: string) {
        if (!element) {
            return;
        }
        element.textContent = output == null ? '' : String(output);
    }

    getOutputSizeBytes(output: string) {
        const safeOutput = output == null ? '' : String(output);
        try {
            return new TextEncoder().encode(safeOutput).length;
        } catch (_) {
            return safeOutput.length;
        }
    }

    // 自适应 B/KB/MB：小输出不再显示成「0.00 MB」。字节数入口与字符串入口共用这一份阈值，
    // 否则统计条（拿的是 worker 报的 genLen 字节数）和差异区会各说一套单位口径。
    formatCompareBytes(bytes: number) {
        const v = Number(bytes);
        if (!Number.isFinite(v) || v <= 0) return '0 B';
        if (v < 1024) return `${v} B`;
        if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
        return `${(v / (1024 * 1024)).toFixed(2)} MB`;
    }

    getOutputSizeText(output: string) {
        return this.formatCompareBytes(this.getOutputSizeBytes(output));
    }

        isLineLimitedOutputTruncated(output: string, maxLines = 100) {
        const safeOutput = output == null ? '' : String(output);
        return safeOutput.split('\n').length > maxLines;
    }

    isCompareOutputTruncated(currentOutput: string, otherOutput: string) {
        const currentLines = (currentOutput || '').split('\n');
        const otherLines = (otherOutput || '').split('\n');
        const maxLines = 100;
        const contextLines = 10;

        let firstDiffLine = -1;
        const maxCompareLines = Math.max(currentLines.length, otherLines.length);
        for (let i = 0; i < maxCompareLines; i++) {
            const currentLine = currentLines[i] || '';
            const otherLine = otherLines[i] || '';
            if (currentLine.trimEnd() !== otherLine.trimEnd()) {
                firstDiffLine = i;
                break;
            }
        }

        if (firstDiffLine === -1) {
            return currentLines.length > maxLines;
        }

        const startLine = Math.max(0, firstDiffLine - contextLines);
        const endLine = Math.min(currentLines.length, firstDiffLine + contextLines + 1);
        const displayLines = Math.min(maxLines, endLine - startLine);
        const actualEndLine = startLine + displayLines;

        return startLine > 0 || actualEndLine < currentLines.length;
    }

    isErrorOutputTruncated(errorResult: CompareErrorResult, outputType: string) {
        if (!errorResult) return false;

        if (outputType === 'input') {
            return this.isLineLimitedOutputTruncated(errorResult.input || '', 100);
        }

        const output = outputType === 'std'
            ? (errorResult.stdOutput || '')
            : (errorResult.testOutput || '');
        const errType = errorResult.errorType;
        const isEngineErr = this.isEngineErrorType(errType);

        if (errType === 'compile_error') {
            return false;
        }

        if (isEngineErr) {
            return this.isLineLimitedOutputTruncated(errorResult.errorMessage || '', 100);
        }

        if (errType === 'generator_program_error' || errType === 'standard_program_error' || errType === 'test_program_error' || errorResult.usedSpj) {
            return this.isLineLimitedOutputTruncated(output, 100);
        }

        const otherOutput = outputType === 'std'
            ? (errorResult.testOutput || '')
            : (errorResult.stdOutput || '');
        return this.isCompareOutputTruncated(output, otherOutput);
    }

    updateErrorOutputExpandButton(button: HTMLElement, errorResult: CompareErrorResult, outputType: string) {
        if (!button) return;
        const truncated = this.isErrorOutputTruncated(errorResult, outputType);
        if (!truncated) {
            button.style.display = 'none';
            return;
        }
        let expanded = false;
        if (outputType === 'input') {
            expanded = !!errorResult?.inputExpanded;
        } else if (outputType === 'std') {
            expanded = !!errorResult?.stdOutputExpanded;
        } else {
            expanded = !!errorResult?.testOutputExpanded;
        }
        button.style.display = 'inline-flex';
        button.textContent = expanded ? (window.i18n.t('compare.collapse')) : (window.i18n.t('compare.expand'));
        button.title = expanded ? window.i18n.t('compare.collapse') : window.i18n.t('compare.expand');
    }

    async toggleErrorOutputExpand(outputType: string) {
        const task = this.getActiveTask();
        const errorResult = task?.state?.errorResult;
        if (!task || !errorResult) {
            return;
        }

        const key = outputType === 'input'
            ? 'inputExpanded'
            : (outputType === 'std' ? 'stdOutputExpanded' : 'testOutputExpanded');
        if (!this.isErrorOutputTruncated(errorResult, outputType)) {
            return;
        }

        if (errorResult[key]) {
            errorResult[key] = false;
            this.renderIfActive(task);
            return;
        }

        const output = outputType === 'input'
            ? (errorResult.input || '')
            : (outputType === 'std' ? (errorResult.stdOutput || '') : (errorResult.testOutput || ''));
        const sizeText = this.getOutputSizeText(output);
        const message = window.i18n.t('compare.expandConfirmMsg', { size: sizeText });

        let shouldExpand = false;
        try {
            if (window.dialogManager?.showActionDialog) {
                const action = await window.dialogManager.showActionDialog(window.i18n.t('compare.expandConfirmTitle'), message, [
                    { id: 'cancel', label: window.i18n.t('dialog.cancel'), className: 'dialog-btn-cancel' },
                    { id: 'expand', label: window.i18n.t('compare.expandAnyway'), className: 'dialog-btn-confirm' }
                ]);
                shouldExpand = action === 'expand';
            } else if (window.dialogManager?.showConfirmDialog) {
                shouldExpand = await window.dialogManager.showConfirmDialog(window.i18n.t('compare.expandConfirmTitle'), window.i18n.t('compare.expandConfirmMsgText', { size: sizeText })) ?? false;
            } else {
                shouldExpand = window.confirm(window.i18n.t('compare.expandConfirmMsgText', { size: sizeText }));
            }
        } catch (error) {
            logWarn('展开输出确认失败，已取消展开:', error);
            shouldExpand = false;
        }

        if (!shouldExpand) {
            return;
        }

        errorResult[key] = true;
        this.renderIfActive(task);
    }

    // 截断提示由调用方通过显式标记传递，不再拿译文反推（AGENTS.md M57 同类反模式）
    limitOutputLines(output: string, maxLines: number) {
        const safeOutput = output == null ? '' : String(output);
        const lines = safeOutput.split('\n');
        if (lines.length > maxLines) {
            return lines.slice(0, maxLines).join('\n') + '\n' + this.getTruncationText();
        }
        return safeOutput;
    }

    getTruncationText() {
        const translated = window.i18n?.t?.('compare.outputTruncated');
        return translated || '[truncated]';
    }

    formatCompareOutput(currentOutput: string, otherOutput: string, outputType: string, upstreamTruncated = false) {
        const currentLines = currentOutput.split('\n');
        const otherLines = otherOutput.split('\n');
        const maxLines = 100;

        let firstDiffLine = -1;
        const maxCompareLines = Math.max(currentLines.length, otherLines.length);

        for (let i = 0; i < maxCompareLines; i++) {
            const currentLine = currentLines[i] || '';
            const otherLine = otherLines[i] || '';
            if (currentLine.trimEnd() !== otherLine.trimEnd()) {
                firstDiffLine = i;
                break;
            }
        }

        if (firstDiffLine === -1) {
            const allLines = currentOutput.split('\n');
            const lineLimited = allLines.length > maxLines;
            const visible = lineLimited ? allLines.slice(0, maxLines) : allLines;
            return this.addLineNumbers(visible.join('\n'), lineLimited || upstreamTruncated);
        }

        const contextLines = 10;
        const startLine = Math.max(0, firstDiffLine - contextLines);
        const endLine = Math.min(currentLines.length, firstDiffLine + contextLines + 1);

        const displayLines = Math.min(maxLines, endLine - startLine);
        const actualEndLine = startLine + displayLines;

        let result = '';

        for (let i = startLine; i < actualEndLine && i < currentLines.length; i++) {
            const lineNum = i + 1;
            const line = currentLines[i] || '';
            const isDiffLine = i === firstDiffLine;

            if (isDiffLine && outputType === 'test') {
                const otherLine = otherLines[i] || '';
                const highlightedLine = this.highlightCharacterDifferences(line, otherLine);
                result += `<div class="diff-line"><span class="line-number">${lineNum.toString().padStart(4)} </span>${highlightedLine}</div>`;
            } else {
                result += `<div class="diff-line"><span class="line-number">${lineNum.toString().padStart(4)} </span>${this.escapeHtml(line)}</div>`;
            }
        }

        if (actualEndLine < currentLines.length || upstreamTruncated) {
            result += `<div class="diff-truncated">${this.getTruncationText()}</div>`;
        }

        return result;
    }

    // truncated 只表示「尾部还有内容被省略」，标记行由本函数自己追加，
// 不再逐行比对译文判断哪一行是截断标记
    addLineNumbers(output: string, truncated = false) {
        const lines = output.split('\n');
        let result = '';

        for (let i = 0; i < lines.length; i++) {
            const lineNum = i + 1;
            const line = lines[i] as string;
            result += `<div class="diff-line"><span class="line-number">${lineNum.toString().padStart(4)} </span>${this.escapeHtml(line)}</div>`;
        }

        if (truncated) {
            result += `<div class="diff-truncated">${this.getTruncationText()}</div>`;
        }

        return result;
    }

    highlightCharacterDifferences(text1: string, text2: string) {
        if (!text1 && !text2) return '';
        if (!text1) return `<span class="diff-highlight">${this.escapeHtml(text2)}</span>`;
        if (!text2) return this.escapeHtml(text1);

        const t1 = this.normalizeForCompare(text1);
        const t2 = this.normalizeForCompare(text2);

        let diffIndex = 0;
        const minLength = Math.min(t1.length, t2.length);
        while (diffIndex < minLength && t1[diffIndex] === t2[diffIndex]) diffIndex++;

        if (diffIndex < t1.length) {
            const beforeDiff = this.escapeHtml(t1.substring(0, diffIndex));
            const diffChar = this.escapeHtml(t1.substring(diffIndex, diffIndex + 1));
            const afterDiff = this.escapeHtml(t1.substring(diffIndex + 1));
            return beforeDiff + `<span class="diff-highlight">${diffChar}</span>` + afterDiff;
        }
        const result = this.escapeHtml(t1);
        if (t1.length < t2.length) {
            const icon = (window.uiIcons && typeof window.uiIcons.svg === 'function') ? window.uiIcons.svg('emptyBox') : '';
            return result + `<span class="diff-highlight">${icon}</span>`;
        }
        return result;
    }

    getDifferenceInfo(actual: string, expected: string) {
        const normActual = this.normalizeForCompare(actual);
        const normExpected = this.normalizeForCompare(expected);

        if (normActual === normExpected) return null;

        const actualLines = normActual.split('\n');
        const expectedLines = normExpected.split('\n');

        for (let i = 0; i < Math.max(actualLines.length, expectedLines.length); i++) {
            const actualLine = actualLines[i] || '';
            const expectedLine = expectedLines[i] || '';

            if (actualLine !== expectedLine) {
                for (let j = 0; j < Math.max(actualLine.length, expectedLine.length); j++) {
                    if (actualLine[j] !== expectedLine[j]) {
                        return {
                            line: i + 1,
                            char: j + 1
                        };
                    }
                }
                return {
                    line: i + 1,
                    char: Math.min(actualLine.length, expectedLine.length) + 1
                };
            }
        }

        return null;
    }

    // 与 compareOutputs 保持同一口径：逐行去行尾空白 + 去尾部空行，
    // 否则「仅行尾空格不同」会被这里判成差异并报出错误的行列
    normalizeForCompare(text: string) {
        if (text == null) return '';
        return String(text)
            .replace(/^\uFEFF/, '')
            .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
            .replace(/\uFEFF/g, '')
            .split('\n')
            .map(line => line.replace(/[ \t]+$/, ''))
            .join('\n')
            .replace(/\n+$/, '');
    }

    escapeHtml(text: string) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    highlightDifferences(text1: string, text2: string) {
        return this.highlightCharacterDifferences(text1, text2);
    }

    async exportResults() {
        const task = this.getActiveTask();
        const errorResult = task?.state?.errorResult;
        if (!errorResult) {
            this.showTaskCompileError(task, 'general', window.i18n.t('compare.noExportResults'));
            return;
        }

        try {
            const result = await window.electronAPI.showOpenDialog({
                title: window.i18n.t('compare.selectExportDir'),
                defaultPath: 'test_data',
                properties: ['openDirectory', 'createDirectory']
            }) as DialogResult;

            if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
                const exportDir = result.filePaths[0] as string;

                await window.electronAPI.ensureDir(exportDir);

                const inputFile = await window.electronAPI.pathJoin(exportDir, 'input.in');
                const stdOutputFile = await window.electronAPI.pathJoin(exportDir, 'std_or_force_output.out');
                const testOutputFile = await window.electronAPI.pathJoin(exportDir, 'code_output.out');

                // 被引擎截断过的数据必须显式标注，否则用户会拿不完整的数据去本地复现
                const withNotice = (text: string, truncated: boolean) => {
                    const body = text == null ? '' : String(text);
                    return truncated ? body + window.i18n.t('compare.exportTruncatedNotice') : body;
                };
                await window.electronAPI.createFile(inputFile, withNotice(errorResult.input, errorResult.inputTruncated));
                await window.electronAPI.createFile(stdOutputFile, withNotice(errorResult.stdOutput, errorResult.stdOutputTruncated));
                await window.electronAPI.createFile(testOutputFile, withNotice(errorResult.testOutput, errorResult.testOutputTruncated));

                this.showSuccessMessage(window.i18n.t('compare.exportedTo', { dir: exportDir }));
            }
        } catch (error) {
            logError('导出失败:', error);
            this.showTaskCompileError(null, 'general', window.i18n.t('compare.exportFailed', { error: (error as Error).message }));
        }
    }

    async cleanupCompiledExecutables(task: CompareTask) {
        if (!task?.compiledExecutables) {
            return;
        }

        const { stdExe, testExe, generatorExe, spjExe } = task.compiledExecutables;
        const executables = [stdExe, testExe, generatorExe, spjExe].filter(Boolean);

        for (const exe of executables) {
            try {
                await window.electronAPI.deleteTempFile(exe!);
                logInfo('[对拍器] 已清理编译产物:', exe);
            } catch (error) {
                logWarn('[对拍器] 清理编译产物失败:', exe, error);
            }
        }

        task.compiledExecutables = null;
    }

    async autoSaveCurrentFile() {
        try {
            const currentEditor = window.editorManager?.getCurrentEditor();
            if (!currentEditor) {
                logInfo('[对拍器-自动保存] 没有当前编辑器');
                return;
            }

            const filePath = currentEditor.filePath || (currentEditor.getFilePath && currentEditor.getFilePath());
            if (!filePath || filePath.startsWith('untitled')) {
                logInfo('[对拍器-自动保存] 文件未保存或为临时文件，跳过自动保存');
                return;
            }

            const content = currentEditor.getValue();
            if (content === null || content === undefined) {
                logInfo('[对拍器-自动保存] 无法获取文件内容');
                return;
            }

            if (window.tabManager) {
                const fileName = filePath.split(/[\\/]/).pop();
                const tab = window.tabManager.getTabByFileName && window.tabManager.getTabByFileName(fileName);
                if (tab && !tab.modified) {
                    logInfo('[对拍器-自动保存] 文件未修改，跳过保存');
                    return;
                }
            }

            logInfo('[对拍器-自动保存] 开始保存文件:', filePath);

            if (window.electronAPI && window.electronAPI.saveFile) {
                await window.electronAPI.saveFile(filePath, content);
                logInfo('[对拍器-自动保存] 文件保存成功');

                if (window.tabManager) {
                    const fileName = filePath.split(/[\\/]/).pop();
                    if (window.tabManager.markTabAsSaved) {
                        window.tabManager.markTabAsSaved(fileName);
                    }
                    if (window.tabManager.markTabAsSavedByUniqueKey) {
                        window.tabManager.markTabAsSavedByUniqueKey(filePath);
                    }
                }
            } else {
                logWarn('[对拍器-自动保存] electronAPI 不可用');
            }
        } catch (error) {
            logError('[对拍器-自动保存] 保存文件失败:', error);
        }
    }
}

if (typeof window !== 'undefined') {
    window.CodeComparer = CodeComparer;
}
