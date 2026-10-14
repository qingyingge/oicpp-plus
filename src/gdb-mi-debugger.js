"use strict";
// Main process: GDB Machine Interface (MI) debugger class and MI protocol implementation.
// Uses ES module imports/exports with `export =` for CommonJS compatibility.
// GDB MI debugger class, MI protocol implementation — main process module.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const events_1 = require("events");
const fs_1 = __importDefault(require("fs"));
const gdb_utils_1 = require("./gdb-utils");
const gdb_mi_1 = require("./gdb-mi");
const lang_1 = require("./lang");
const process_supervisor_1 = require("./utils/process-supervisor");
/** Timeout for GDB MI commands in milliseconds. */
const MI_COMMAND_TIMEOUT_MS = 10000;
/** Timeout for GDB MI interrupt in milliseconds. */
const MI_INTERRUPT_TIMEOUT_MS = 2000;
/** Maximum output bytes before truncation. */
const MI_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/**
 * Ensures the value is an array. If not, returns an empty array.
 * @param value - The value to check.
 * @returns The original value if it's an array, otherwise an empty array.
 */
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
/**
 * Converts a value to a number, using a fallback if NaN.
 * @param value - The value to convert (can be string, number, or unknown).
 * @param fallback - The fallback value if Number is not finite (default 0).
 * @returns The parsed number or fallback.
 */
function numberValue(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}
/**
 * Creates a frame data object from a GDB frame record.
 * @param frame - The frame object (default: empty object).
 * @returns An object with file, line, function, and address properties.
 */
function frameData(frame = {}) {
    return {
        file: String(frame.fullname || frame.file || ''),
        line: numberValue(frame.line, -1),
        function: String(frame.func || frame.function || '??'),
        address: String(frame.addr || frame.address || '')
    };
}
/**
 * GDB MI Debugger class extending EventEmitter.
 * Handles GDB Machine Interface protocol for debugging sessions.
 */
class GDBDebugger extends events_1.EventEmitter {
    /** Whether the debug session is currently running. */
    isRunning;
    /** Whether the program has exited. */
    programExited;
    /** The protocol version used. */
    protocol;
    /** The spawned GDB process. */
    gdbProcess;
    /** Cached variables: local, global, watches. */
    _variables;
    /** The call stack frames. */
    _callStack;
    /** The breakpoints configured. */
    _breakpoints;
    /** Watch expression strings. */
    _watchExpressions;
    /** Whether the inferior is running. */
    _inferiorRunning;
    /** Whether the program has stopped. */
    _programStopped;
    /** Whether the debugger has been started at least once. */
    _isStarted;
    /** Manual breakpoint on entry flag. */
    _manualBreakOnEntry;
    /** The MI stream instance for reading/writing to GDB. */
    _miStream;
    /** Maximum output buffer bytes limit. */
    _miBufferLimit;
    /** Pending MI requests by token. */
    _miPending;
    /** Next MI token to assign. */
    _nextMiToken;
    /** Linux TTY configuration options. */
    _linuxTTYOptions;
    /** The TTY process spawned for Linux. */
    _ttyProcess;
    /** The TTY process PID. */
    _ttyProcessPid;
    /** The TTY path. */
    _ttyPath;
    /** The TTY shell process PID. */
    _ttyShellPid;
    /** Whether the exit event has been emitted. */
    _lastExitEmitted;
    /**
     * Constructs a new GDBDebugger instance.
     * Initializes all internal state and prepares for a debugging session.
     */
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
        this._miStream = new gdb_mi_1.GdbMiStream((record) => this._handleMiRecord(record));
        this._miBufferLimit = MI_MAX_OUTPUT_BYTES;
        this._miPending = new Map();
        this._nextMiToken = 1;
        this._linuxTTYOptions = { inferiorTTY: undefined, noNewConsole: true, consoleTerminalTemplate: '' };
        this._ttyProcess = null;
        this._ttyProcessPid = 0;
        this._ttyPath = null;
        this._ttyShellPid = 0;
        this._lastExitEmitted = false;
    }
    /**
     * Writes a Machine Interface line to the GDB process stdin.
     * Throws if the process is not running or has exited.
     * @param line - The MI command line to write.
     */
    _writeMi(line) {
        if (!this.gdbProcess || !this.gdbProcess.stdin || this.gdbProcess.exitCode !== null) {
            throw new Error((0, lang_1.t)('debug.gdbProcessNotRunning'));
        }
        this.gdbProcess.stdin.write(line + '\n');
    }
    /**
     * Settles a pending MI entry: resolves or rejects based on error status.
     * @param entry - The pending entry to settle.
     * @param error - The error to reject with (optional).
     * @param value - The value to resolve with (optional).
     */
    _settleMi(entry, error, value) {
        if (!entry || entry.settled)
            return;
        entry.settled = true;
        if (entry.timer)
            clearTimeout(entry.timer);
        entry.timer = null;
        if (error)
            entry.reject(error);
        else
            entry.resolve(value);
    }
    /**
     * Rejects all pending MI entries with a given error.
     * @param error - The error to reject all pending entries with.
     */
    _rejectMi(error) {
        const pending = Array.from(this._miPending.values());
        this._miPending.clear();
        for (const entry of pending)
            this._settleMi(entry, error, undefined);
    }
    /**
     * Sends a MI request command to GDB with optional timeout.
     * @param command - The MI command string to send.
     * @param options - Optional timeout in milliseconds.
     * @returns A Promise that resolves with the command result or rejects on timeout/error.
     */
    _miRequest(command, options = {}) {
        if (!this.gdbProcess)
            return Promise.reject(new Error('GDB process is not running'));
        const token = String(this._nextMiToken++);
        const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : MI_COMMAND_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            const entry = { token, command, resolve, reject, timer: null, settled: false };
            if (timeoutMs > 0) {
                entry.timer = setTimeout(() => {
                    if (entry.settled || !this._miPending.has(token))
                        return;
                    this._miPending.delete(token);
                    if (/^-exec-/.test(command) && this._inferiorRunning) {
                        try {
                            this._writeMi('0-exec-interrupt --all');
                        }
                        catch (_) { }
                    }
                    this._settleMi(entry, new Error('GDB command timed out: ' + command), undefined);
                }, timeoutMs);
            }
            this._miPending.set(token, entry);
            try {
                this._writeMi(token + command);
            }
            catch (error) {
                this._miPending.delete(token);
                this._settleMi(entry, error instanceof Error ? error : new Error(String(error)), undefined);
            }
        });
    }
    /**
     * Receives and processes MI data chunks from the GDB stream.
     * @param chunk - The raw data chunk from GDB stdout.
     */
    _onMiData(chunk) {
        this._miStream.maxBufferBytes = this._miBufferLimit;
        this._miStream.push(chunk);
    }
    /**
     * Handles a single MI record emitted from the stream.
     * Dispatches to appropriate handlers based on record type.
     * @param record - The parsed MI record object.
     */
    _handleMiRecord(record) {
        if (!record)
            return;
        const rec = record;
        if (rec.type === 'warning') {
            this.emit('warning', rec.message || 'GDB MI warning');
            return;
        }
        if (rec.type === 'parse-error') {
            this.emit('warning', 'GDB MI parse error: ' + (rec.message || 'unknown'));
            return;
        }
        if (rec.type === 'stream') {
            if (rec.stream === 'target') {
                this._emitTargetOutput(rec.text);
            }
            else if (rec.text?.trim()) {
                try {
                    global.logInfo?.('[GDB-MI]', rec.text);
                }
                catch (_) { }
            }
            return;
        }
        if (rec.type === 'result') {
            const entry = this._miPending.get(String(rec.token || ''));
            if (!entry) {
                if (rec.status === 'error')
                    this.emit('error', new Error(rec.fields?.msg || 'GDB MI error'));
                return;
            }
            this._miPending.delete(entry.token);
            if (rec.status === 'error') {
                this._settleMi(entry, new Error(rec.fields?.msg || 'GDB MI error'), undefined);
            }
            else {
                this._settleMi(entry, null, rec.fields || {});
            }
            return;
        }
        if (rec.type === 'exec') {
            this._handleExecRecord(rec);
            return;
        }
        if (rec.type === 'notify') {
            this._handleNotifyRecord(rec);
            return;
        }
        if (rec.type === 'log') {
            const logRec = rec;
            const message = logRec.fields?.msg || `${logRec.level} log record`;
            if (logRec.level === 'error' || logRec.level === 'warning')
                this.emit('warning', message);
        }
    }
    /**
     * Handles an MI execution record (running/stopped/thread-exited).
     * @param record - The execution record from GDB.
     */
    _handleExecRecord(record) {
        const rec = record;
        if (rec.name === 'running') {
            this._programStopped = false;
            this._inferiorRunning = true;
            this.emit('running');
            return;
        }
        if (rec.name === 'stopped') {
            this._handleStopped(rec.fields || {});
            return;
        }
        if (rec.name === 'thread-group-exited') {
            this._handleInferiorExited(rec.fields || {});
        }
    }
    /**
     * Handles an MI notify record (inferior started/thread-exited, etc.).
     * @param record - The notify record from GDB.
     */
    _handleNotifyRecord(record) {
        const rec = record;
        if (rec.name === 'thread-group-started') {
            this._inferiorRunning = true;
            this._programStopped = false;
            this.emit('inferior-started', { pid: 0, ttyPath: this._ttyPath || '' });
            return;
        }
        if (rec.name === 'thread-group-exited') {
            this._handleInferiorExited(rec.fields || {});
            return;
        }
        if (rec.name === 'breakpoint-modified' || rec.name === 'breakpoint-created') {
            const bp = (rec.fields?.bkpt || rec.fields);
            if (bp?.number)
                this._updateBreakpointFromMi(bp);
        }
        if (rec.name === 'thread-exited') {
            return;
        }
    }
    /**
     * Handles the GDB "stopped" event, emitting appropriate events.
     * @param fields - The fields from the GDB stopped record.
     */
    _handleStopped(fields = {}) {
        const reason = String(fields.reason || '').toLowerCase();
        if (reason.includes('exited')) {
            this._handleInferiorExited(fields);
            return;
        }
        const frame = frameData((fields.frame || {}));
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
    /**
     * Handles the GDB inferior exit event.
     * @param fields - The exit fields from GDB.
     */
    _handleInferiorExited(fields = {}) {
        if (this._lastExitEmitted)
            return;
        this._lastExitEmitted = true;
        this._programStopped = true;
        this._inferiorRunning = false;
        this._isStarted = false;
        this.programExited = true;
        const rawExitCode = fields.exitCode !== undefined ? fields.exitCode : fields['exit-code'];
        const exitCode = rawExitCode !== undefined ? numberValue(rawExitCode) : undefined;
        this.emit('program-exited', { exitCode });
    }
    /**
     * Updates breakpoint information from a MI breakpoint record.
     * @param bp - The breakpoint record from GDB MI.
     * @returns The normalized breakpoint object, or null if invalid.
     */
    _updateBreakpointFromMi(bp) {
        const bpRec = bp;
        const number = numberValue(bpRec.number, 0);
        if (!number)
            return null;
        const existing = this._breakpoints.find((item) => item.number === number);
        const normalized = {
            ...(existing || {}),
            number,
            file: this._normalizePath(String(bpRec.fullname || bpRec.file || existing?.file || '')),
            line: numberValue(bpRec.line, existing?.line || 0),
            address: String(bpRec.addr || existing?.address || ''),
            pending: bpRec.pending === '1' || bpRec.pending === true || !!existing?.pending
        };
        if (existing)
            Object.assign(existing, normalized);
        else
            this._breakpoints.push(normalized);
        if (normalized.pending && existing?.pending === false)
            this.emit('breakpoint-resolved', normalized);
        return normalized;
    }
    /**
     * Starts a GDB debugging session with the given executable and source path.
     * Configures GDB settings, sets up process I/O handlers, and emits 'started'.
     * @param executablePath - Path to the executable to debug.
     * @param sourcePath - Path to the source file.
     * @param options - Optional configuration (gdbPath, env, printElements, noNewConsole, etc.).
     */
    async start(executablePath, sourcePath, options = {}) {
        if (this.gdbProcess)
            await this.stop();
        this.programExited = false;
        this._lastExitEmitted = false;
        this._inferiorRunning = false;
        this._programStopped = true;
        this._isStarted = false;
        this._breakpoints = [];
        this._miPending.clear();
        this._miStream = new gdb_mi_1.GdbMiStream((record) => this._handleMiRecord(record));
        const env = options.env ? { ...process.env, ...options.env } : { ...process.env };
        const gdbExe = options.gdbPath || 'gdb';
        const args = ['--interpreter=mi2', '-q', '-nx'];
        this.gdbProcess = (0, child_process_1.spawn)(gdbExe, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
            windowsHide: false,
            detached: process.platform !== 'win32'
        });
        this.gdbProcess.stdout.on('data', (data) => this._onMiData(data.toString()));
        this.gdbProcess.stderr.on('data', (data) => {
            const text = data;
            if (text.includes('Failed to set controlling terminal'))
                return;
            try {
                global.logWarn?.('[GDB-MI-STDERR]', text);
            }
            catch (_) { }
        });
        this.gdbProcess.on('error', (error) => {
            this._rejectMi(error);
            this.isRunning = false;
            if (this.listenerCount('error') > 0)
                this.emit('error', error);
            else
                this.emit('warning', error?.message || String(error));
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
            }
            catch (error) {
                if (!optional)
                    throw error;
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
        }
        else if (process.platform === 'linux') {
            this._linuxTTYOptions = {
                inferiorTTY: typeof options.inferiorTTY === 'string' ? options.inferiorTTY : undefined,
                noNewConsole: !!options.noNewConsole,
                consoleTerminalTemplate: typeof options.consoleTerminalTemplate === 'string' ? options.consoleTerminalTemplate : ''
            };
            await this._cleanupLinuxTTY();
        }
        await run(`-file-exec-and-symbols ${(0, gdb_mi_1.miQuote)(executablePath)}`);
        if (this._ttyPath || this._linuxTTYOptions.inferiorTTY) {
            const tty = this._ttyPath || this._linuxTTYOptions.inferiorTTY;
            if (tty)
                await run(`-inferior-tty-set ${(0, gdb_mi_1.miQuote)(tty)}`, true);
        }
        this.isRunning = true;
        this.emit('started', { executable: executablePath, sourceFile: sourcePath, protocol: 'mi2' });
    }
    /**
     * Stops the current GDB debugging session.
     * Sends exit commands, terminates the process tree, and cleans up TTY.
     */
    async stop() {
        if (!this.gdbProcess)
            return;
        const processRef = this.gdbProcess;
        try {
            if (this._inferiorRunning) {
                await this._miRequest('-exec-interrupt --all', { timeoutMs: MI_INTERRUPT_TIMEOUT_MS }).catch(() => { });
            }
            await this._miRequest('-gdb-exit', { timeoutMs: MI_INTERRUPT_TIMEOUT_MS }).catch(() => { });
        }
        finally {
            await new Promise((resolve) => {
                if (processRef.exitCode !== null || processRef.signalCode !== null)
                    return resolve(undefined);
                let settled = false;
                const finish = () => {
                    if (settled)
                        return;
                    settled = true;
                    clearTimeout(timer);
                    processRef.removeListener('exit', onExit);
                    resolve(undefined);
                };
                const onExit = () => finish();
                const timer = setTimeout(finish, MI_INTERRUPT_TIMEOUT_MS);
                processRef.once('exit', onExit);
            });
            (0, process_supervisor_1.terminateProcessTree)(processRef);
            this.gdbProcess = null;
            this.isRunning = false;
            this._programStopped = true;
            this._inferiorRunning = false;
            this._isStarted = false;
            this._rejectMi(new Error((0, lang_1.t)('debug.gdbSessionStopped')));
            await this._cleanupLinuxTTY();
        }
    }
    /**
     * Executes a MI command with a 30-second timeout.
     * @param command - The MI command to execute.
     * @returns A Promise that resolves with the command result.
     */
    async _execute(command) {
        try {
            return await this._miRequest(command, { timeoutMs: 30000 });
        }
        catch (error) {
            this._inferiorRunning = false;
            this._programStopped = true;
            this._isStarted = false;
            throw error;
        }
    }
    /**
     * Runs the program (starts or continues execution).
     * Ensures the program hasn't exited and isn't already running.
     * On Linux, ensures TTY is set up before running.
     */
    async run() {
        if (this.programExited)
            throw new Error((0, lang_1.t)('debug.programHasExited'));
        if (this._inferiorRunning)
            throw new Error((0, lang_1.t)('debug.programAlreadyRunning'));
        if (this._isStarted && !this.programExited)
            return this.continue();
        if (process.platform === 'linux') {
            try {
                const tty = await this._ensureLinuxTTY();
                if (tty?.ttyPath) {
                    this._ttyPath = tty.ttyPath;
                    await this._miRequest(`-inferior-tty-set ${(0, gdb_mi_1.miQuote)(tty.ttyPath)}`, { timeoutMs: 2000 }).catch(() => { });
                }
            }
            catch (error) {
                try {
                    global.logWarn?.('[GDB] TTY 失败', error);
                }
                catch (_) { }
            }
        }
        this._isStarted = true;
        this._inferiorRunning = true;
        this._programStopped = false;
        await this._execute('-exec-run');
    }
    /**
     * Continues the program execution.
     * Ensures the program hasn't exited and isn't already running.
     */
    async continue() {
        if (this.programExited)
            throw new Error((0, lang_1.t)('debug.programHasExited'));
        if (this._inferiorRunning)
            throw new Error((0, lang_1.t)('debug.programAlreadyRunning'));
        if (!this._isStarted)
            return this.run();
        this._manualBreakOnEntry = false;
        this._inferiorRunning = true;
        this._programStopped = false;
        await this._execute('-exec-continue');
    }
    /**
     * Steps over the current line.
     * Ensures the program hasn't exited and isn't already running.
     * @returns A Promise that resolves when the step-over completes.
     */
    async stepOver() {
        return this._execStep('-exec-next');
    }
    /**
     * Steps into the current line.
     * Ensures the program hasn't exited and isn't already running.
     * @returns A Promise that resolves when the step-into completes.
     */
    async stepInto() {
        return this._execStep('-exec-step');
    }
    /**
     * Steps out of the current function.
     * Ensures the program hasn't exited and isn't already running.
     * @returns A Promise that resolves when the step-out completes.
     */
    async stepOut() {
        return this._execStep('-exec-finish');
    }
    /**
     * Executes a given MI step command.
     * @param command - The MI step command (e.g. '-exec-next', '-exec-step', '-exec-finish').
     * @internal
     */
    async _execStep(command) {
        if (this.programExited)
            throw new Error((0, lang_1.t)('debug.programHasExited'));
        if (this._inferiorRunning)
            throw new Error((0, lang_1.t)('debug.programAlreadyRunning'));
        this._manualBreakOnEntry = false;
        this._inferiorRunning = true;
        this._programStopped = false;
        await this._execute(command);
    }
    /**
     * Sets a breakpoint at the given file and line.
     * Sends a `-break-insert` command to GDB and processes the result.
     * @param file - The source file path.
     * @param line - The line number (1-based).
     * @returns A Promise that resolves with the breakpoint object.
     */
    async setBreakpoint(file, line) {
        const location = file + ':' + line;
        const fields = await this._miRequest(`-break-insert ${(0, gdb_mi_1.miQuote)(location)}`);
        const bpRec = (fields.bkpt || fields);
        const number = numberValue(bpRec.number, 0);
        if (!number)
            throw new Error((0, lang_1.t)('debug.breakpointSetFailed'));
        const bp = {
            number,
            file: this._normalizePath(String(bpRec.fullname || bpRec.file || file)),
            line: numberValue(bpRec.line, line),
            address: String(bpRec.addr || ''),
            pending: bpRec.pending === '1' || bpRec.pending === true
        };
        this._breakpoints.push(bp);
        this.emit('breakpoint-set', bp);
        return bp;
    }
    /**
     * Removes a breakpoint by number.
     * Sends a `-break-delete` command to GDB.
     * @param number - The breakpoint number to remove.
     */
    async removeBreakpoint(number) {
        await this._miRequest(`-break-delete ${numberValue(number)}`);
        this._breakpoints = this._breakpoints.filter((bp) => bp.number !== numberValue(number));
        this.emit('breakpoint-removed', { number: numberValue(number) });
    }
    /**
     * Adds a watch variable expression to be tracked.
     * @param expr - The variable expression to watch.
     */
    async addWatchVariable(expr) {
        this._watchExpressions.add(String(expr));
        await this.updateVariables();
    }
    /**
     * Removes a watch variable expression.
     * @param expr - The variable expression to remove.
     */
    async removeWatchVariable(expr) {
        this._watchExpressions.delete(String(expr));
        delete this._variables.watches[String(expr)];
        this.emit('variables-updated', this._variables);
    }
    /**
     * Updates the variables (locals, arguments, and watch expressions) from GDB.
     * Silent mode skips the variables-updated event to avoid duplicate renders.
     * @param options - Optional silent flag to skip event emission.
     */
    async updateVariables(options = { silent: false }) {
        if (!this.isRunning || this._inferiorRunning || this.programExited)
            return;
        this._variables.local = {};
        this._variables.watches = {};
        try {
            const fields = await this._miRequest('-stack-list-variables --all-values');
            for (const variable of asArray(fields.variables)) {
                this._setVariable('local', variable);
            }
        }
        catch (error) {
            try {
                global.logWarn?.('[GDB] 局部变量失败', error);
            }
            catch (_) { }
        }
        if (!this.isRunning || this._inferiorRunning || this.programExited)
            return;
        try {
            const fields = await this._miRequest('-stack-list-arguments --all-values');
            for (const variable of asArray(fields.arguments || fields.variables)) {
                this._setVariable('local', variable);
            }
        }
        catch (error) {
            try {
                global.logWarn?.('[GDB] 参数失败', error);
            }
            catch (_) { }
        }
        for (const expression of this._watchExpressions) {
            try {
                const fields = await this._miRequest(`-data-evaluate-expression ${(0, gdb_mi_1.miQuote)(expression)}`);
                const value = typeof fields.value === 'string' ? fields.value : String(fields.value || '');
                const item = { name: expression, value, type: fields.type || '', children: [] };
                (0, gdb_utils_1.parseGDBWatchValue)(item, value);
                this._variables.watches[expression] = item;
            }
            catch (_) {
                this._variables.watches[expression] = { name: expression, value: (0, lang_1.t)('debug.variableValueError'), children: [] };
            }
        }
        if (!options.silent) {
            this.emit('variables-updated', this._variables);
        }
    }
    /**
     * Sets a variable in the given scope (local or global).
     * @param scope - The variable scope ('local' or 'global').
     * @param variable - The variable record from GDB.
     */
    _setVariable(scope, variable) {
        if (!variable || !variable.name)
            return;
        const value = typeof variable.value === 'string' ? variable.value : String(variable.value || '');
        const item = { name: variable.name, value, type: variable.type || '', children: [] };
        (0, gdb_utils_1.parseGDBWatchValue)(item, value);
        this._variables[scope][variable.name] = item;
    }
    /**
     * Updates the call stack frames from GDB.
     */
    async updateCallStack() {
        if (!this.isRunning || this._inferiorRunning || this.programExited)
            return;
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
        }
        catch (error) {
            try {
                global.logWarn?.('[GDB] 堆栈失败', error);
            }
            catch (_) { }
        }
    }
    /** Returns the current variables state. */
    getVariables() {
        return this._variables;
    }
    /** Returns a copy of the current breakpoints. */
    getBreakpoints() {
        return this._breakpoints.map((breakpoint) => ({ ...breakpoint }));
    }
    /** Returns the current call stack. */
    getCallStack() {
        return this._callStack;
    }
    /**
     * Expands a variable to explore its children.
     * @param name - The variable name to expand.
     * @param options - Optional scope ('local' | 'global' | 'watches') and path parts.
     * @returns An object with name, scope, path, and data properties.
     */
    async expandVariable(name, options = { scope: 'local' }) {
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
        if (!root)
            throw new Error((0, lang_1.t)('debug.variableNotFound', { name }));
        if ((!options.path || options.path.length === 0) && (!root.children || root.children.length === 0)) {
            try {
                const fields = await this._miRequest(`-data-evaluate-expression ${(0, gdb_mi_1.miQuote)(name)}`);
                (0, gdb_utils_1.parseGDBWatchValue)(root, typeof fields.value === 'string' ? fields.value : String(fields.value || ''));
            }
            catch (error) {
                try {
                    global.logWarn?.(`[GDB] 无法获取 ${name} 子项`, error);
                }
                catch (_) { }
            }
        }
        let current = root;
        const pathParts = Array.isArray(options.path) ? options.path : [];
        for (const part of pathParts) {
            const index = numberValue(part, -1);
            if (Number.isInteger(index) && current.children?.[index])
                current = current.children[index];
            else {
                const child = current.children?.find((item) => item.name === String(part));
                if (child)
                    current = child;
            }
        }
        return { name, scope, path: pathParts, data: current };
    }
    /** Collapses a variable (no-op by default). * @returns An empty object. */
    async collapseVariable() {
        return {};
    }
    /**
     * Sends input to the GDB process stdin.
     * @param input - The input string to send (newlines normalized).
     * @returns True if the write succeeded, false otherwise.
     */
    async sendInput(input) {
        if (!this.gdbProcess || !this.gdbProcess.stdin || !this._inferiorRunning)
            return false;
        const value = String(input ?? '').replace(/\r/g, '\n');
        if (!value)
            return true;
        try {
            this.gdbProcess.stdin.write(value);
            return true;
        }
        catch (_) {
            return false;
        }
    }
    /** Emits target output to the UI. */
    _emitTargetOutput(text) {
        const content = String(text || '');
        if (content.trim())
            this.emit('target-output', content);
    }
    /**
     * Normalizes a file path.
     * On Windows, resolves the real path using fs.realpathSync; on other platforms,
     * normalizes with path.normalize. Falls back gracefully if realpath fails.
     * @param filePath - The file path to normalize.
     * @returns The normalized path string.
     */
    _normalizePath(filePath) {
        if (!filePath)
            return '';
        if (process.platform !== 'win32')
            return filePath;
        try {
            return fs_1.default.realpathSync.native ? fs_1.default.realpathSync.native(filePath) : fs_1.default.realpathSync(filePath);
        }
        catch (_) {
            return path_1.default.normalize(filePath);
        }
    }
    /**
     * Cleans up the Linux TTY process if one was spawned.
     */
    async _cleanupLinuxTTY() {
        if (this._ttyProcessPid) {
            try {
                process.kill(-this._ttyProcessPid, 'SIGTERM');
            }
            catch (_) { }
        }
        if (this._ttyProcess) {
            try {
                (0, process_supervisor_1.terminateProcessTree)(this._ttyProcess);
            }
            catch (_) { }
        }
        this._ttyProcess = null;
        this._ttyProcessPid = 0;
        this._ttyPath = null;
        this._ttyShellPid = 0;
    }
    /**
     * Ensures a Linux TTY is available for the inferior process.
     * Uses the configured template or shell to spawn a terminal.
     * @returns An object with ttyPath, or null if unavailable.
     */
    async _ensureLinuxTTY() {
        if (this._ttyPath)
            return { ttyPath: this._ttyPath };
        if (this._linuxTTYOptions.noNewConsole)
            return null;
        if (this._linuxTTYOptions.inferiorTTY)
            return { ttyPath: this._linuxTTYOptions.inferiorTTY };
        if (!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.MIR_SOCKET))
            return null;
        const template = String(this._linuxTTYOptions.consoleTerminalTemplate || "xterm -T '$TITLE' -e").trim();
        const token = 80000000 + Math.floor(Math.random() * 100000);
        const sleepCommand = `sleep ${token}`;
        const title = String((0, lang_1.t)('debug.programConsoleTitle')).replace(/'/g, "'\\''");
        let command = template.replace(/\$TITLE/g, `'${title}'`);
        command = command.includes('$SCRIPT') ? command.replace(/\$SCRIPT/g, sleepCommand) : `${command} ${sleepCommand}`;
        try {
            this._ttyProcess = (0, child_process_1.spawn)('/bin/sh', ['-c', command], {
                detached: true,
                stdio: 'ignore',
                env: { ...process.env }
            });
            this._ttyProcessPid = this._ttyProcess.pid || 0;
            this._ttyProcess.unref();
        }
        catch (_) {
            return null;
        }
        for (let attempt = 0; attempt < 100; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            let output = '';
            try {
                const result = (0, child_process_1.spawnSync)('ps', ['x', '-o', 'tty,pid,command'], { encoding: 'utf8' });
                if (result.status === 0)
                    output = String(result.stdout || '');
            }
            catch (_) { }
            for (const line of output.split(/\r?\n/)) {
                if (!line || !line.includes(sleepCommand))
                    continue;
                const match = line.trim().match(/^(\S+)\s+(\d+)\s+(.+)$/);
                if (!match)
                    continue;
                const ttyName = match[1];
                const pid = parseInt(match[2], 10);
                if (!ttyName || ttyName === '?' || ttyName === '-' || !Number.isInteger(pid) || pid <= 0)
                    continue;
                this._ttyPath = ttyName.startsWith('/dev/') ? ttyName : '/dev/' + ttyName;
                this._ttyShellPid = pid;
                return { ttyPath: this._ttyPath };
            }
        }
        await this._cleanupLinuxTTY();
        return null;
    }
}
module.exports = GDBDebugger;
