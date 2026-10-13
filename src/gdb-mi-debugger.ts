// Main process: GDB Machine Interface (MI) debugger class and MI protocol implementation.
// Uses ES module imports/exports with `export =` for CommonJS compatibility.
// GDB MI debugger class, MI protocol implementation — main process module.

import { spawn, spawnSync } from 'child_process';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import fs from 'fs';
import { WriteStream } from 'fs'; // for gdbProcess.stdin type
import { parseGDBWatchValue, tokenizeGDBLocals } from './gdb-utils';
import { GdbMiStream, miQuote } from './gdb-mi';
import { t } from './lang';
import { terminateProcessTree } from './utils/process-supervisor';

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
function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

/**
 * Converts a value to a number, using a fallback if NaN.
 * @param value - The value to convert (can be string, number, or unknown).
 * @param fallback - The fallback value if Number is not finite (default 0).
 * @returns The parsed number or fallback.
 */
function numberValue(value: unknown, fallback: number = 0): number {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

/**
 * Creates a frame data object from a GDB frame record.
 * @param frame - The frame object (default: empty object).
 * @returns An object with file, line, function, and address properties.
 */
function frameData(frame: { [key: string]: unknown } = {}): {
    file: string;
    line: number;
    function: string;
    address: string;
} {
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
class GDBDebugger extends EventEmitter {
    /** Whether the debug session is currently running. */
    isRunning: boolean;
    /** Whether the program has exited. */
    programExited: boolean;
    /** The protocol version used. */
    protocol: string;
    /** The spawned GDB process. */
    gdbProcess: import('child_process').ChildProcessWithoutNullStreams | null;
    /** Cached variables: local, global, watches. */
    _variables: { local: { [key: string]: unknown }; global: { [key: string]: unknown }; watches: { [key: string]: unknown } };
    /** The call stack frames. */
    _callStack: Array<{ function: string; file: string; line: number; level: number; address: string }>;
    /** The breakpoints configured. */
    _breakpoints: Array<{ number: number; file: string; line: number; address: string; pending: boolean }>;
    /** Watch expression strings. */
    _watchExpressions: Set<string>;
    /** Whether the inferior is running. */
    _inferiorRunning: boolean;
    /** Whether the program has stopped. */
    _programStopped: boolean;
    /** Whether the debugger has been started at least once. */
    _isStarted: boolean;
    /** Manual breakpoint on entry flag. */
    _manualBreakOnEntry: boolean;
    /** The MI stream instance for reading/writing to GDB. */
    _miStream: GdbMiStream;
    /** Maximum output buffer bytes limit. */
    _miBufferLimit: number;
    /** Pending MI requests by token. */
    _miPending: Map<string, { token: string; command: string; resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout | null; settled: boolean }>;
    /** Next MI token to assign. */
    _nextMiToken: number;
    /** Linux TTY configuration options. */
    _linuxTTYOptions: { inferiorTTY?: string; noNewConsole: boolean; consoleTerminalTemplate: string };
    /** The TTY process spawned for Linux. */
    _ttyProcess: any;
    /** The TTY process PID. */
    _ttyProcessPid: number;
    /** The TTY path. */
    _ttyPath: string | null;
    /** The TTY shell process PID. */
    _ttyShellPid: number;
    /** Whether the exit event has been emitted. */
    _lastExitEmitted: boolean;

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
        this._miStream = new GdbMiStream((record: unknown) => this._handleMiRecord(record));
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
    _writeMi(line: string): void {
        if (!this.gdbProcess || !this.gdbProcess.stdin || this.gdbProcess.exitCode !== null) {
            throw new Error(t('debug.gdbProcessNotRunning'));
        }
        this.gdbProcess.stdin.write(line + '\n');
    }

    /**
     * Settles a pending MI entry: resolves or rejects based on error status.
     * @param entry - The pending entry to settle.
     * @param error - The error to reject with (optional).
     * @param value - The value to resolve with (optional).
     */
    _settleMi(entry: { settled: boolean; timer: NodeJS.Timeout | null; resolve: (value: unknown) => void; reject: (reason: Error) => void }, error: Error | null, value: unknown): void {
        if (!entry || entry.settled) return;
        entry.settled = true;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        if (error) entry.reject(error);
        else entry.resolve(value);
    }

    /**
     * Rejects all pending MI entries with a given error.
     * @param error - The error to reject all pending entries with.
     */
    _rejectMi(error: Error): void {
        const pending = Array.from(this._miPending.values());
        this._miPending.clear();
        for (const entry of pending) this._settleMi(entry, error, undefined);
    }

    /**
     * Sends a MI request command to GDB with optional timeout.
     * @param command - The MI command string to send.
     * @param options - Optional timeout in milliseconds.
     * @returns A Promise that resolves with the command result or rejects on timeout/error.
     */
    _miRequest(command: string, options: { timeoutMs?: number } = {}): Promise<unknown> {
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
                    this._settleMi(entry, new Error('GDB command timed out: ' + command), undefined);
                }, timeoutMs);
            }
            this._miPending.set(token, entry);
            try {
                this._writeMi(token + command);
            } catch (error) {
                this._miPending.delete(token);
                this._settleMi(entry, error instanceof Error ? error : new Error(String(error)), undefined);
            }
        });
    }

    /**
     * Receives and processes MI data chunks from the GDB stream.
     * @param chunk - The raw data chunk from GDB stdout.
     */
    _onMiData(chunk: unknown): void {
        this._miStream.maxBufferBytes = this._miBufferLimit;
        this._miStream.push(chunk);
    }

    /**
     * Handles a single MI record emitted from the stream.
     * Dispatches to appropriate handlers based on record type.
     * @param record - The parsed MI record object.
     */
    _handleMiRecord(record: unknown): void {
        if (!record) return;
        const rec = record as { type?: string; message?: string; stream?: string; text?: string; token?: string | number; status?: string; fields?: { msg?: string; [key: string]: unknown } };
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
            } else if (rec.text?.trim()) {
                try { global.logInfo?.('[GDB-MI]', rec.text); } catch (_) { }
            }
            return;
        }
        if (rec.type === 'result') {
            const entry = this._miPending.get(String(rec.token || ''));
            if (!entry) {
                if (rec.status === 'error') this.emit('error', new Error(rec.fields?.msg || 'GDB MI error'));
                return;
            }
            this._miPending.delete(entry.token);
            if (rec.status === 'error') {
                this._settleMi(entry, new Error(rec.fields?.msg || 'GDB MI error'), undefined);
            } else {
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
            const logRec = rec as { level?: string; fields?: { msg?: string } };
            const message = logRec.fields?.msg || `${logRec.level} log record`;
            if (logRec.level === 'error' || logRec.level === 'warning') this.emit('warning', message);
        }
    }

    /**
     * Handles an MI execution record (running/stopped/thread-exited).
     * @param record - The execution record from GDB.
     */
    _handleExecRecord(record: unknown): void {
        const rec = record as { name?: string; fields?: Record<string, unknown> };
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
    _handleNotifyRecord(record: unknown): void {
        const rec = record as { name?: string; fields?: Record<string, unknown> };
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
            const bp = (rec.fields?.bkpt || rec.fields) as { number?: unknown; [key: string]: unknown };
            if (bp?.number) this._updateBreakpointFromMi(bp);
        }
        if (rec.name === 'thread-exited') {
            return;
        }
    }

    /**
     * Handles the GDB "stopped" event, emitting appropriate events.
     * @param fields - The fields from the GDB stopped record.
     */
    _handleStopped(fields: { [key: string]: unknown } = {}): void {
        const reason = String(fields.reason || '').toLowerCase();
        if (reason.includes('exited')) {
            this._handleInferiorExited(fields);
            return;
        }
        const frame = frameData((fields.frame || {}) as { [key: string]: unknown });
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
    _handleInferiorExited(fields: { [key: string]: unknown } = {}): void {
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

    /**
     * Updates breakpoint information from a MI breakpoint record.
     * @param bp - The breakpoint record from GDB MI.
     * @returns The normalized breakpoint object, or null if invalid.
     */
    _updateBreakpointFromMi(bp: unknown): { [key: string]: unknown } | null {
        const bpRec = bp as { number?: unknown; fullname?: unknown; file?: unknown; line?: unknown; addr?: unknown; pending?: unknown; [key: string]: unknown };
        const number = numberValue(bpRec.number, 0);
        if (!number) return null;
        const existing = this._breakpoints.find((item) => item.number === number);
        const normalized = {
            ...(existing || {}),
            number,
            file: this._normalizePath(String(bpRec.fullname || bpRec.file || existing?.file || '')),
            line: numberValue(bpRec.line, existing?.line || 0),
            address: String(bpRec.addr || existing?.address || ''),
            pending: bpRec.pending === '1' || bpRec.pending === true || !!existing?.pending
        };
        if (existing) Object.assign(existing, normalized);
        else this._breakpoints.push(normalized);
        if (normalized.pending && existing?.pending === false) this.emit('breakpoint-resolved', normalized);
        return normalized;
    }

    /**
     * Starts a GDB debugging session with the given executable and source path.
     * Configures GDB settings, sets up process I/O handlers, and emits 'started'.
     * @param executablePath - Path to the executable to debug.
     * @param sourcePath - Path to the source file.
     * @param options - Optional configuration (gdbPath, env, printElements, noNewConsole, etc.).
     */
    async start(executablePath: string, sourcePath: string, options: { gdbPath?: string; printElements?: number; noNewConsole?: boolean; inferiorTTY?: string; consoleTerminalTemplate?: string; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
        if (this.gdbProcess) await this.stop();
        this.programExited = false;
        this._lastExitEmitted = false;
        this._inferiorRunning = false;
        this._programStopped = true;
        this._isStarted = false;
        this._breakpoints = [];
        this._miPending.clear();
        this._miStream = new GdbMiStream((record: unknown) => this._handleMiRecord(record));
        const env: NodeJS.ProcessEnv = options.env ? { ...process.env, ...options.env } : { ...process.env };
        const gdbExe: string = options.gdbPath || 'gdb';
        const args: string[] = ['--interpreter=mi2', '-q', '-nx'];
        this.gdbProcess = spawn(gdbExe, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
            windowsHide: false,
            detached: process.platform !== 'win32'
        });
        this.gdbProcess.stdout.on('data', (data: Buffer) => this._onMiData(data.toString()));
        this.gdbProcess.stderr.on('data', (data: string) => {
            const text = data;
            if (text.includes('Failed to set controlling terminal')) return;
            try { global.logWarn?.('[GDB-MI-STDERR]', text); } catch (_) { }
        });
        this.gdbProcess.on('error', (error: Error) => {
            this._rejectMi(error);
            this.isRunning = false;
            if (this.listenerCount('error') > 0) this.emit('error', error);
            else this.emit('warning', error?.message || String(error));
        });
        this.gdbProcess.on('exit', (code: number | null, signal: string | null) => {
            this._rejectMi(new Error('GDB process exited'));
            this.isRunning = false;
            this.programExited = true;
            this._programStopped = true;
            this._inferiorRunning = false;
            this.emit('exited', { code, signal });
        });

        const run = async (command: string, optional: boolean = false): Promise<unknown> => {
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

    /**
     * Stops the current GDB debugging session.
     * Sends exit commands, terminates the process tree, and cleans up TTY.
     */
    async stop(): Promise<void> {
        if (!this.gdbProcess) return;
        const processRef = this.gdbProcess;
        try {
            if (this._inferiorRunning) {
                await this._miRequest('-exec-interrupt --all', { timeoutMs: MI_INTERRUPT_TIMEOUT_MS }).catch(() => { });
            }
            await this._miRequest('-gdb-exit', { timeoutMs: MI_INTERRUPT_TIMEOUT_MS }).catch(() => { });
        } finally {
            await new Promise((resolve) => {
                if (processRef.exitCode !== null || processRef.signalCode !== null) return resolve(undefined);
                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    processRef.removeListener('exit', onExit);
                    resolve(undefined);
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

    /**
     * Executes a MI command with a 30-second timeout.
     * @param command - The MI command to execute.
     * @returns A Promise that resolves with the command result.
     */
    async _execute(command: string): Promise<unknown> {
        try {
            return await this._miRequest(command, { timeoutMs: 30000 });
        } catch (error) {
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
    async run(): Promise<void> {
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

    /**
     * Continues the program execution.
     * Ensures the program hasn't exited and isn't already running.
     */
    async continue(): Promise<void> {
        if (this.programExited) throw new Error(t('debug.programHasExited'));
        if (this._inferiorRunning) throw new Error(t('debug.programAlreadyRunning'));
        if (!this._isStarted) return this.run();
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
    async stepOver(): Promise<void> {
        return this._execStep('-exec-next');
    }

    /**
     * Steps into the current line.
     * Ensures the program hasn't exited and isn't already running.
     * @returns A Promise that resolves when the step-into completes.
     */
    async stepInto(): Promise<void> {
        return this._execStep('-exec-step');
    }

    /**
     * Steps out of the current function.
     * Ensures the program hasn't exited and isn't already running.
     * @returns A Promise that resolves when the step-out completes.
     */
    async stepOut(): Promise<void> {
        return this._execStep('-exec-finish');
    }

    /**
     * Executes a given MI step command.
     * @param command - The MI step command (e.g. '-exec-next', '-exec-step', '-exec-finish').
     * @internal
     */
    async _execStep(command: string): Promise<void> {
        if (this.programExited) throw new Error(t('debug.programHasExited'));
        if (this._inferiorRunning) throw new Error(t('debug.programAlreadyRunning'));
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
    async setBreakpoint(file: string, line: number): Promise<{ number: number; file: string; line: number; address: string; pending: boolean }> {
        const location = file + ':' + line;
        const fields = await this._miRequest(`-break-insert ${miQuote(location)}`);
        const bpRec = (fields.bkpt || fields) as { number?: unknown; fullname?: unknown; file?: unknown; line?: unknown; addr?: unknown; pending?: unknown; [key: string]: unknown };
        const number = numberValue(bpRec.number, 0);
        if (!number) throw new Error(t('debug.breakpointSetFailed'));
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
    async removeBreakpoint(number: number | string): Promise<void> {
        await this._miRequest(`-break-delete ${numberValue(number)}`);
        this._breakpoints = this._breakpoints.filter((bp) => bp.number !== numberValue(number));
        this.emit('breakpoint-removed', { number: numberValue(number) });
    }

    /**
     * Adds a watch variable expression to be tracked.
     * @param expr - The variable expression to watch.
     */
    async addWatchVariable(expr: string): Promise<void> {
        this._watchExpressions.add(String(expr));
        await this.updateVariables();
    }

    /**
     * Removes a watch variable expression.
     * @param expr - The variable expression to remove.
     */
    async removeWatchVariable(expr: string): Promise<void> {
        this._watchExpressions.delete(String(expr));
        delete this._variables.watches[String(expr)];
        this.emit('variables-updated', this._variables);
    }

    /**
     * Updates the variables (locals, arguments, and watch expressions) from GDB.
     * Silent mode skips the variables-updated event to avoid duplicate renders.
     * @param options - Optional silent flag to skip event emission.
     */
    async updateVariables(options: { silent: boolean } = { silent: false }): Promise<void> {
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
        if (!options.silent) {
            this.emit('variables-updated', this._variables);
        }
    }

    /**
     * Sets a variable in the given scope (local or global).
     * @param scope - The variable scope ('local' or 'global').
     * @param variable - The variable record from GDB.
     */
    _setVariable(scope: string, variable: { [key: string]: unknown }): void {
        if (!variable || !variable.name) return;
        const value = typeof variable.value === 'string' ? variable.value : String(variable.value || '');
        const item = { name: variable.name, value, type: variable.type || '', children: [] };
        parseGDBWatchValue(item, value);
        this._variables[scope][variable.name] = item;
    }

    /**
     * Updates the call stack frames from GDB.
     */
    async updateCallStack(): Promise<void> {
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

    /** Returns the current variables state. */
    getVariables(): { local: { [key: string]: unknown }; global: { [key: string]: unknown }; watches: { [key: string]: unknown } } {
        return this._variables;
    }

    /** Returns a copy of the current breakpoints. */
    getBreakpoints(): Array<{ number: number; file: string; line: number; address: string; pending: boolean }> {
        return this._breakpoints.map((breakpoint) => ({ ...breakpoint }));
    }

    /** Returns the current call stack. */
    getCallStack(): Array<{ function: string; file: string; line: number; level: number; address: string }> {
        return this._callStack;
    }

    /**
     * Expands a variable to explore its children.
     * @param name - The variable name to expand.
     * @param options - Optional scope ('local' | 'global' | 'watches') and path parts.
     * @returns An object with name, scope, path, and data properties.
     */
    async expandVariable(name: string, options: { scope?: string; path?: unknown } = { scope: 'local' }): Promise<{ name: string; scope: string; path: unknown; data: unknown }> {
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

    /** Collapses a variable (no-op by default). * @returns An empty object. */
    async collapseVariable(): Promise<{}> {
        return {};
    }

    /**
     * Sends input to the GDB process stdin.
     * @param input - The input string to send (newlines normalized).
     * @returns True if the write succeeded, false otherwise.
     */
    async sendInput(input: string | null | undefined): Promise<boolean> {
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

    /** Emits target output to the UI. */
    _emitTargetOutput(text: string): void {
        const content = String(text || '');
        if (content.trim()) this.emit('target-output', content);
    }

    /**
     * Normalizes a file path.
     * On Windows, resolves the real path using fs.realpathSync; on other platforms,
     * normalizes with path.normalize. Falls back gracefully if realpath fails.
     * @param filePath - The file path to normalize.
     * @returns The normalized path string.
     */
    _normalizePath(filePath: string): string {
        if (!filePath) return '';
        if (process.platform !== 'win32') return filePath;
        try {
            return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
        } catch (_) {
            return path.normalize(filePath);
        }
    }

    /**
     * Cleans up the Linux TTY process if one was spawned.
     */
    async _cleanupLinuxTTY(): Promise<void> {
        if (this._ttyProcessPid) {
            try { process.kill(-this._ttyProcessPid, 'SIGTERM'); } catch (_) { }
        }
        if (this._ttyProcess) {
            try { terminateProcessTree(this._ttyProcess); } catch (_) { }
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
    async _ensureLinuxTTY(): Promise<{ ttyPath: string } | null> {
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
                this._ttyPath = ttyName.startsWith('/dev/') ? ttyName : '/dev/' + ttyName;
                this._ttyShellPid = pid;
                return { ttyPath: this._ttyPath };
            }
        }
        await this._cleanupLinuxTTY();
        return null;
    }
}

// ── CommonJS compatibility: export = GDBDebugger ───────────────────────────────
// Required for modules that consume this via require() in CommonJS context
// (e.g., src/main.js:27 `const GDBDebugger = require('./gdb-debugger')`).
// The re-export file src/gdb-debugger.js just does `module.exports = GDBDebugger`;
// therefore this .ts file must provide `export =` for the same compatibility.
export = GDBDebugger;