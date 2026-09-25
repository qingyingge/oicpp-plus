'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const fs = require('fs');
const {
    parseGDBWatchValue,
    tokenizeGDBLocals
} = require('./gdb-utils');
const { GdbMiStream, miQuote } = require('./gdb-mi');
const { t } = require('./lang');
const { terminateProcessTree } = require('./utils/process-supervisor');

const MI_COMMAND_TIMEOUT_MS = 10000;
const MI_INTERRUPT_TIMEOUT_MS = 2000;
const MI_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function numberValue(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function frameData(frame = {}) {
    return {
        file: frame.fullname || frame.file || '',
        line: numberValue(frame.line, -1),
        function: frame.func || frame.function || '??',
        address: frame.addr || frame.address || ''
    };
}

class GDBDebugger extends EventEmitter {
    constructor() {
        super();
        this.isRunning = false;
        this.programExited = false;
        this.protocol = 'mi2';
        this.gdbProcess = null;
        this._variables = { local: {}, global: {}, watches: {} };
        this._callStack = [];
        this._breakpoints = [];
        this._watchExpressions = new Set();
        this._inferiorRunning = false;
        this._programStopped = true;
        this._isStarted = false;
        this._manualBreakOnEntry = false;
        this._miStream = new GdbMiStream((record) => this._handleMiRecord(record));
        this._miBufferLimit = MI_MAX_OUTPUT_BYTES;
        this._miPending = new Map();
        this._nextMiToken = 1;
        this._linuxTTYOptions = {};
        this._ttyProcess = null;
        this._ttyProcessPid = 0;
        this._ttyPath = null;
        this._ttyShellPid = 0;
        this._lastExitEmitted = false;
    }

    _writeMi(line) {
        if (!this.gdbProcess || !this.gdbProcess.stdin || this.gdbProcess.exitCode !== null) {
            throw new Error(t('debug.gdbProcessNotRunning'));
        }
        this.gdbProcess.stdin.write(`${line}\n`);
    }

    _settleMi(entry, error, value) {
        if (!entry || entry.settled) return;
        entry.settled = true;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        if (error) entry.reject(error);
        else entry.resolve(value);
    }

    _rejectMi(error) {
        const pending = Array.from(this._miPending.values());
        this._miPending.clear();
        for (const entry of pending) this._settleMi(entry, error);
    }

    _miRequest(command, options = {}) {
        if (!this.gdbProcess) return Promise.reject(new Error('GDB process is not running'));
        const token = String(this._nextMiToken++);
        const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : MI_COMMAND_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            const entry = { token, command, resolve, reject, timer: null, settled: false };
            if (timeoutMs > 0) {
                entry.timer = setTimeout(() => {
                    if (entry.settled || !this._miPending.has(token)) return;
                    this._miPending.delete(token);
                    if (/^-exec-/.test(command) && this._inferiorRunning) {
                        try { this._writeMi('0-exec-interrupt --all'); } catch (_) { }
                    }
                    this._settleMi(entry, new Error(`GDB command timed out: ${command}`));
                }, timeoutMs);
            }
            this._miPending.set(token, entry);
            try {
                this._writeMi(`${token}${command}`);
            } catch (error) {
                this._miPending.delete(token);
                this._settleMi(entry, error);
            }
        });
    }

    _onMiData(chunk) {
        this._miStream.maxBufferBytes = this._miBufferLimit;
        this._miStream.push(chunk);
    }

    _handleMiRecord(record) {
        if (!record) return;
        if (record.type === 'warning') {
            this.emit('warning', record.message || 'GDB MI warning');
            return;
        }
        if (record.type === 'parse-error') {
            this.emit('warning', `GDB MI parse error: ${record.message || 'unknown'}`);
            return;
        }
        if (record.type === 'stream') {
            if (record.stream === 'target') {
                this._emitTargetOutput(record.text);
            } else if (record.text.trim()) {
                try { global.logInfo?.('[GDB-MI]', record.text); } catch (_) { }
            }
            return;
        }
        if (record.type === 'result') {
            const entry = this._miPending.get(String(record.token || ''));
            if (!entry) {
                if (record.status === 'error') this.emit('error', new Error(record.fields?.msg || 'GDB MI error'));
                return;
            }
            this._miPending.delete(entry.token);
            if (record.status === 'error') {
                this._settleMi(entry, new Error(record.fields?.msg || 'GDB MI error'));
            } else {
                this._settleMi(entry, null, record.fields || {});
            }
            return;
        }
        if (record.type === 'exec') {
            this._handleExecRecord(record);
            return;
        }
        if (record.type === 'notify') {
            this._handleNotifyRecord(record);
            return;
        }
        if (record.type === 'log') {
            const message = record.fields?.msg || `${record.level} log record`;
            if (record.level === 'error' || record.level === 'warning') this.emit('warning', message);
        }
    }

    _handleExecRecord(record) {
        if (record.name === 'running') {
            this._programStopped = false;
            this._inferiorRunning = true;
            this.emit('running');
            return;
        }
        if (record.name === 'stopped') {
            this._handleStopped(record.fields || {});
            return;
        }
        if (record.name === 'thread-group-exited') {
            this._handleInferiorExited(record.fields || {});
        }
    }

    _handleNotifyRecord(record) {
        if (record.name === 'thread-group-started') {
            this._inferiorRunning = true;
            this._programStopped = false;
            this.emit('inferior-started', { pid: 0, ttyPath: this._ttyPath || '' });
            return;
        }
        if (record.name === 'thread-group-exited') {
            this._handleInferiorExited(record.fields || {});
            return;
        }
        if (record.name === 'breakpoint-modified' || record.name === 'breakpoint-created') {
            const bp = record.fields?.bkpt || record.fields;
            if (bp?.number) this._updateBreakpointFromMi(bp);
        }
        if (record.name === 'thread-exited') {
            return;
        }
    }

    _handleStopped(fields) {
        const reason = String(fields.reason || '').toLowerCase();
        if (reason.includes('exited')) {
            this._handleInferiorExited(fields);
            return;
        }
        const frame = frameData(fields.frame || {});
        this._programStopped = true;
        this._inferiorRunning = false;
        this._isStarted = true;
        const data = {
            reason: reason || 'stopped',
            frame: { ...frame, fullname: frame.file },
            file: frame.file,
            line: frame.line,
            function: frame.function,
            address: frame.address,
            threadId: fields['thread-id'] || null
        };
        this.emit('stopped', data);
        if (reason.includes('breakpoint') || reason.includes('watchpoint') || reason.includes('catchpoint')) {
            this.emit('breakpoint-hit', data);
        }
    }

    _handleInferiorExited(fields = {}) {
        if (this._lastExitEmitted) return;
        this._lastExitEmitted = true;
        this._programStopped = true;
        this._inferiorRunning = false;
        this._isStarted = false;
        this.programExited = true;
        const rawExitCode = fields.exitCode !== undefined ? fields.exitCode : fields['exit-code'];
        const exitCode = rawExitCode !== undefined ? numberValue(rawExitCode) : undefined;
        this.emit('program-exited', { exitCode });
    }

    _updateBreakpointFromMi(bp) {
        const number = numberValue(bp.number, 0);
        if (!number) return null;
        const existing = this._breakpoints.find((item) => item.number === number);
        const normalized = {
            ...(existing || {}),
            number,
            file: this._normalizePath(bp.fullname || bp.file || existing?.file || ''),
            line: numberValue(bp.line, existing?.line || 0),
            address: bp.addr || existing?.address || '',
            pending: bp.pending === '1' || bp.pending === true || !!existing?.pending
        };
        if (existing) Object.assign(existing, normalized);
        else this._breakpoints.push(normalized);
        if (normalized.pending && existing?.pending === false) this.emit('breakpoint-resolved', normalized);
        return normalized;
    }

    async start(executablePath, sourcePath, options = {}) {
        if (this.gdbProcess) await this.stop();
        this.programExited = false;
        this._lastExitEmitted = false;
        this._inferiorRunning = false;
        this._programStopped = true;
        this._isStarted = false;
        this._breakpoints = [];
        this._miPending.clear();
        this._nextMiToken = 1;
        this._miStream = new GdbMiStream((record) => this._handleMiRecord(record));
        const env = options.env ? { ...process.env, ...options.env } : { ...process.env };
        const gdbExe = options.gdbPath || 'gdb';
        const args = ['--interpreter=mi2', '-q', '-nx'];
        this.gdbProcess = spawn(gdbExe, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
            windowsHide: false,
            detached: process.platform !== 'win32'
        });
        this.gdbProcess.stdout.on('data', (data) => this._onMiData(data.toString()));
        this.gdbProcess.stderr.on('data', (data) => {
            const text = data.toString();
            if (text.includes('Failed to set controlling terminal')) return;
            try { global.logWarn?.('[GDB-MI-STDERR]', text); } catch (_) { }
        });
        this.gdbProcess.on('error', (error) => {
            this._rejectMi(error);
            this.isRunning = false;
            if (this.listenerCount('error') > 0) this.emit('error', error);
            else this.emit('warning', error?.message || String(error));
        });
        this.gdbProcess.on('exit', (code, signal) => {
            this._rejectMi(new Error('GDB process exited'));
            this.isRunning = false;
            this.programExited = true;
            this._programStopped = true;
            this._inferiorRunning = false;
            this.emit('exited', { code, signal });
        });

        const run = async (command, optional = false) => {
            try {
                return await this._miRequest(command);
            } catch (error) {
                if (!optional) throw error;
                return null;
            }
        };

        await run('-gdb-set confirm off');
        await run('-gdb-set pagination off', true);
        await run('-gdb-set width 0', true);
        await run('-gdb-set height 0', true);
        await run('-gdb-set breakpoint pending on');
        await run('-gdb-set print asm-demangle on', true);
        await run('-gdb-set unwindonsignal on', true);
        await run(`-gdb-set print elements ${Math.max(0, numberValue(options.printElements, 200))}`, true);
        await run('-gdb-set filename-display absolute', true);
        await run('-gdb-set style enabled off', true);
        await run('-gdb-set print pretty on', true);
        await run('-gdb-set print array-indexes on', true);
        if (process.platform === 'win32') {
            await run(`-gdb-set new-console ${options.noNewConsole ? 'off' : 'on'}`, true);
        } else if (process.platform === 'linux') {
            this._linuxTTYOptions = {
                inferiorTTY: typeof options.inferiorTTY === 'string' ? options.inferiorTTY : undefined,
                noNewConsole: !!options.noNewConsole,
                consoleTerminalTemplate: typeof options.consoleTerminalTemplate === 'string' ? options.consoleTerminalTemplate : ''
            };
            await this._cleanupLinuxTTY();
        }
        await run(`-file-exec-and-symbols ${miQuote(executablePath)}`);
        if (this._ttyPath || this._linuxTTYOptions.inferiorTTY) {
            const tty = this._ttyPath || this._linuxTTYOptions.inferiorTTY;
            if (tty) await run(`-inferior-tty-set ${miQuote(tty)}`, true);
        }
        this.isRunning = true;
        this.emit('started', { executable: executablePath, sourceFile: sourcePath, protocol: 'mi2' });
    }

    async stop() {
        if (!this.gdbProcess) return;
        const processRef = this.gdbProcess;
        try {
            if (this._inferiorRunning) {
                await this._miRequest('-exec-interrupt --all', { timeoutMs: MI_INTERRUPT_TIMEOUT_MS }).catch(() => { });
            }
            await this._miRequest('-gdb-exit', { timeoutMs: MI_INTERRUPT_TIMEOUT_MS }).catch(() => { });
        } finally {
            await new Promise((resolve) => {
                if (processRef.exitCode !== null || processRef.signalCode !== null) return resolve();
                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    processRef.removeListener('exit', onExit);
                    resolve();
                };
                const onExit = () => finish();
                const timer = setTimeout(finish, MI_INTERRUPT_TIMEOUT_MS);
                processRef.once('exit', onExit);
            });
            terminateProcessTree(processRef);
            this.gdbProcess = null;
            this.isRunning = false;
            this._programStopped = true;
            this._inferiorRunning = false;
            this._isStarted = false;
            this._rejectMi(new Error(t('debug.gdbSessionStopped')));
            await this._cleanupLinuxTTY();
        }
    }

    async _execute(command) {
        try {
            return await this._miRequest(command, { timeoutMs: 30000 });
        } catch (error) {
            this._inferiorRunning = false;
            this._programStopped = true;
            this._isStarted = false;
            throw error;
        }
    }

    async run() {
        if (this.programExited) throw new Error(t('debug.programHasExited'));
        if (this._inferiorRunning) throw new Error(t('debug.programAlreadyRunning'));
        if (this._isStarted && !this.programExited) return this.continue();
        if (process.platform === 'linux') {
            try {
                const tty = await this._ensureLinuxTTY();
                if (tty?.ttyPath) {
                    this._ttyPath = tty.ttyPath;
                    await this._miRequest(`-inferior-tty-set ${miQuote(tty.ttyPath)}`, { timeoutMs: 2000 }).catch(() => { });
                }
            } catch (error) {
                try { global.logWarn?.('[GDB] TTY 失败', error); } catch (_) { }
            }
        }
        this._isStarted = true;
        this._inferiorRunning = true;
        this._programStopped = false;
        await this._execute('-exec-run');
    }

    async continue() {
        if (this.programExited) throw new Error(t('debug.programHasExited'));
        if (this._inferiorRunning) throw new Error(t('debug.programAlreadyRunning'));
        if (!this._isStarted) return this.run();
        this._manualBreakOnEntry = false;
        this._inferiorRunning = true;
        this._programStopped = false;
        await this._execute('-exec-continue');
    }

    async stepOver() {
        return this._execStep('-exec-next');
    }

    async stepInto() {
        return this._execStep('-exec-step');
    }

    async stepOut() {
        return this._execStep('-exec-finish');
    }

    async _execStep(command) {
        if (this.programExited) throw new Error(t('debug.programHasExited'));
        if (this._inferiorRunning) throw new Error(t('debug.programAlreadyRunning'));
        this._manualBreakOnEntry = false;
        this._inferiorRunning = true;
        this._programStopped = false;
        await this._execute(command);
    }

    async setBreakpoint(file, line) {
        const location = `${file}:${line}`;
        const fields = await this._miRequest(`-break-insert ${miQuote(location)}`);
        const breakpoint = fields.bkpt || fields;
        const number = numberValue(breakpoint.number, 0);
        if (!number) throw new Error(t('debug.breakpointSetFailed'));
        const bp = {
            number,
            file: this._normalizePath(breakpoint.fullname || breakpoint.file || file),
            line: numberValue(breakpoint.line, line),
            address: breakpoint.addr || '',
            pending: breakpoint.pending === '1' || breakpoint.pending === true
        };
        this._breakpoints.push(bp);
        this.emit('breakpoint-set', bp);
        return bp;
    }

    async removeBreakpoint(number) {
        await this._miRequest(`-break-delete ${numberValue(number)}`);
        this._breakpoints = this._breakpoints.filter((bp) => bp.number !== numberValue(number));
        this.emit('breakpoint-removed', { number: numberValue(number) });
    }

    async addWatchVariable(expr) {
        this._watchExpressions.add(String(expr));
        await this.updateVariables();
    }

    async removeWatchVariable(expr) {
        this._watchExpressions.delete(String(expr));
        delete this._variables.watches[String(expr)];
        this.emit('variables-updated', this._variables);
    }

    async updateVariables() {
        if (!this.isRunning || this._inferiorRunning || this.programExited) return;
        this._variables.local = {};
        this._variables.watches = {};
        try {
            const fields = await this._miRequest('-stack-list-variables --all-values');
            for (const variable of asArray(fields.variables)) {
                this._setVariable('local', variable);
            }
        } catch (error) {
            try { global.logWarn?.('[GDB] 局部变量失败', error); } catch (_) { }
        }
        if (!this.isRunning || this._inferiorRunning || this.programExited) return;
        try {
            const fields = await this._miRequest('-stack-list-arguments --all-values');
            for (const variable of asArray(fields.arguments || fields.variables)) {
                this._setVariable('local', variable);
            }
        } catch (error) {
            try { global.logWarn?.('[GDB] 参数失败', error); } catch (_) { }
        }
        for (const expression of this._watchExpressions) {
            try {
                const fields = await this._miRequest(`-data-evaluate-expression ${miQuote(expression)}`);
                const value = typeof fields.value === 'string' ? fields.value : String(fields.value || '');
                const item = { name: expression, value, type: fields.type || '', children: [] };
                parseGDBWatchValue(item, value);
                this._variables.watches[expression] = item;
            } catch (_) {
                this._variables.watches[expression] = { name: expression, value: t('debug.variableValueError'), children: [] };
            }
        }
        this.emit('variables-updated', this._variables);
    }

    _setVariable(scope, variable) {
        if (!variable || !variable.name) return;
        const value = typeof variable.value === 'string' ? variable.value : String(variable.value || '');
        const item = { name: variable.name, value, type: variable.type || '', children: [] };
        parseGDBWatchValue(item, value);
        this._variables[scope][variable.name] = item;
    }

    async updateCallStack() {
        if (!this.isRunning || this._inferiorRunning || this.programExited) return;
        try {
            const fields = await this._miRequest('-stack-list-frames');
            this._callStack = asArray(fields.stack).map((frame, index) => {
                const data = frameData(frame);
                return {
                    function: data.function,
                    file: this._normalizePath(data.file),
                    line: data.line,
                    level: numberValue(frame.level, index),
                    address: data.address
                };
            });
            this.emit('callstack-updated', this._callStack);
        } catch (error) {
            try { global.logWarn?.('[GDB] 堆栈失败', error); } catch (_) { }
        }
    }

    getVariables() { return this._variables; }
    getBreakpoints() { return this._breakpoints.map((breakpoint) => ({ ...breakpoint })); }
    getCallStack() { return this._callStack; }

    async expandVariable(name, options = {}) {
        const scope = options.scope || 'local';
        let root = this._variables[scope]?.[name];
        if (!root) {
            for (const key of ['local', 'global', 'watches']) {
                if (this._variables[key]?.[name]) {
                    root = this._variables[key][name];
                    break;
                }
            }
        }
        if (!root) throw new Error(t('debug.variableNotFound', { name }));
        if ((!options.path || options.path.length === 0) && (!root.children || root.children.length === 0)) {
            try {
                const fields = await this._miRequest(`-data-evaluate-expression ${miQuote(name)}`);
                parseGDBWatchValue(root, typeof fields.value === 'string' ? fields.value : String(fields.value || ''));
            } catch (error) {
                try { global.logWarn?.(`[GDB] 无法获取 ${name} 子项`, error); } catch (_) { }
            }
        }
        let current = root;
        const pathParts = Array.isArray(options.path) ? options.path : [];
        for (const part of pathParts) {
            const index = numberValue(part, -1);
            if (Number.isInteger(index) && current.children?.[index]) current = current.children[index];
            else {
                const child = current.children?.find((item) => item.name === String(part));
                if (child) current = child;
            }
        }
        return { name, scope, path: pathParts, data: current };
    }

    async collapseVariable() { return {}; }

    async sendInput(input) {
        if (!this.gdbProcess || !this.gdbProcess.stdin || !this._inferiorRunning) return false;
        const value = String(input ?? '').replace(/\r/g, '\n');
        if (!value) return true;
        try {
            this.gdbProcess.stdin.write(value);
            return true;
        } catch (_) {
            return false;
        }
    }

    _emitTargetOutput(text) {
        const content = String(text || '');
        if (content.trim()) this.emit('target-output', content);
    }

    _normalizePath(filePath) {
        if (!filePath) return '';
        if (process.platform !== 'win32') return filePath;
        try {
            return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
        } catch (_) {
            return path.normalize(filePath);
        }
    }

    async _cleanupLinuxTTY() {
        if (this._ttyProcessPid) {
            try { process.kill(-this._ttyProcessPid, 'SIGTERM'); } catch (_) { }
        }
        if (this._ttyProcess) {
            try { terminateProcessTree(this._ttyProcess); } catch (_) { }
        }
        if (this._ttyShellPid) {
            try { process.kill(this._ttyShellPid, 'SIGTERM'); } catch (_) { }
        }
        this._ttyProcess = null;
        this._ttyProcessPid = 0;
        this._ttyPath = null;
        this._ttyShellPid = 0;
    }

    async _ensureLinuxTTY() {
        if (this._ttyPath) return { ttyPath: this._ttyPath };
        if (this._linuxTTYOptions.noNewConsole) return null;
        if (this._linuxTTYOptions.inferiorTTY) return { ttyPath: this._linuxTTYOptions.inferiorTTY };
        if (!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.MIR_SOCKET)) return null;
        const template = String(this._linuxTTYOptions.consoleTerminalTemplate || "xterm -T '$TITLE' -e").trim();
        const token = 80000000 + Math.floor(Math.random() * 100000);
        const sleepCommand = `sleep ${token}`;
        const title = String(t('debug.programConsoleTitle')).replace(/'/g, "'\\''");
        let command = template.replace(/\$TITLE/g, `'${title}'`);
        command = command.includes('$SCRIPT') ? command.replace(/\$SCRIPT/g, sleepCommand) : `${command} ${sleepCommand}`;
        try {
            this._ttyProcess = spawn('/bin/sh', ['-c', command], {
                detached: true,
                stdio: 'ignore',
                env: { ...process.env }
            });
            this._ttyProcessPid = this._ttyProcess.pid || 0;
            this._ttyProcess.unref();
        } catch (_) {
            return null;
        }
        for (let attempt = 0; attempt < 100; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            let output = '';
            try {
                const result = spawnSync('ps', ['x', '-o', 'tty,pid,command'], { encoding: 'utf8' });
                if (result.status === 0) output = String(result.stdout || '');
            } catch (_) { }
            for (const line of output.split(/\r?\n/)) {
                if (!line || !line.includes(sleepCommand)) continue;
                const match = line.trim().match(/^(\S+)\s+(\d+)\s+(.+)$/);
                if (!match) continue;
                const ttyName = match[1];
                const pid = parseInt(match[2], 10);
                if (!ttyName || ttyName === '?' || ttyName === '-' || !Number.isInteger(pid) || pid <= 0) continue;
                this._ttyPath = ttyName.startsWith('/dev/') ? ttyName : `/dev/${ttyName}`;
                this._ttyShellPid = pid;
                return { ttyPath: this._ttyPath };
            }
        }
        await this._cleanupLinuxTTY();
        return null;
    }
}

module.exports = GDBDebugger;
