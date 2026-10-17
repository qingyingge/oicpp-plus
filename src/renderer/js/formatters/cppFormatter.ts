/**
 * 渲染层 C++ 代码格式化工具。
 *
 * 以「脚本」形式参与构建（无 import/export，无 `export {}`）——在渲染层经 script 标签加载，
 * 整个实现包在 IIFE 内，只向 window 挂 cppFormatter（与 HEAD 的 cppFormatter.js 一致：
 * 文件里不出现任何 exports 引用，否则浏览器脚本形态下 `exports` 未定义会整文件抛错）。
 *
 * clang-format 样式配置与 normalize/format 函数完全对应原 JS 实现，
 * 类型使用 unknown + 类型收窄，禁止 any。
 */
(function () {
    type ClangFormatStyle = {
        BasedOnStyle: string;
        IndentWidth: number;
        TabWidth: number;
        UseTab: 'Never' | 'ForIndentation' | 'ForContinuationAndIndentation' | 'Always';
        ColumnLimit: number;
        BreakBeforeBraces: string;
        AllowShortIfStatementsOnASingleLine: string;
        AllowShortFunctionsOnASingleLine: string;
        IndentCaseLabels: boolean;
        PointerAlignment: string;
        SpaceBeforeParens: string;
        SortIncludes: boolean;
        AlignConsecutiveAssignments: boolean;
        AlignConsecutiveDeclarations: boolean;
    };

    type FormatCppOptions = {
        clangFormatStyle?: unknown;
        clangFormat?: unknown;
        tabSize?: unknown;
    };

    /**
     * 获取 clang-format 的默认样式配置。
     * @returns 默认样式对象
     */
    function getDefaultClangFormatStyle(): ClangFormatStyle {
        return {
            BasedOnStyle: 'LLVM',
            IndentWidth: 4,
            TabWidth: 4,
            UseTab: 'Never',
            ColumnLimit: 0,
            BreakBeforeBraces: 'Attach',
            AllowShortIfStatementsOnASingleLine: 'Never',
            AllowShortFunctionsOnASingleLine: 'Empty',
            IndentCaseLabels: false,
            PointerAlignment: 'Left',
            SpaceBeforeParens: 'ControlStatements',
            SortIncludes: true,
            AlignConsecutiveAssignments: false,
            AlignConsecutiveDeclarations: false
        };
    }

    /**
     * 规范化 clang-format 原始样式配置。
     * @param raw 用户提供的原始样式对象（可选）
     * @returns 规范化后的样式对象，不合法值将回退到默认值
     */
    function normalizeClangFormatStyle(raw: unknown): ClangFormatStyle {
        const defaults = getDefaultClangFormatStyle();
        const normalized: ClangFormatStyle = { ...defaults };
        if (!raw || typeof raw !== 'object') {
            return normalized;
        }

        const toInt = (value: unknown, fallback: number): number => {
            const parsed = parseInt(value as string, 10);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
        };
        const toBool = (value: unknown, fallback: boolean): boolean => {
            if (typeof value === 'boolean') return value;
            if (typeof value === 'string') {
                const lowered = value.trim().toLowerCase();
                if (['true', 'yes', 'on'].includes(lowered)) return true;
                if (['false', 'no', 'off'].includes(lowered)) return false;
            }
            return fallback;
        };
        const toEnum = <T extends string>(value: unknown, allowed: ReadonlyArray<T>, fallback: T): T => {
            const rawValue = String((value as string) || '').trim();
            if (!rawValue) return fallback;
            const matched = allowed.find((item) => item.toLowerCase() === rawValue.toLowerCase());
            return matched || fallback;
        };

        // 基于 style
        normalized.BasedOnStyle = toEnum((raw as { BasedOnStyle?: unknown }).BasedOnStyle, ['LLVM', 'Google', 'Mozilla', 'Chromium', 'Microsoft', 'WebKit'], defaults.BasedOnStyle);
        // 数值类型
        normalized.IndentWidth = toInt((raw as { IndentWidth?: unknown }).IndentWidth, defaults.IndentWidth);
        normalized.TabWidth = toInt((raw as { TabWidth?: unknown }).TabWidth, normalized.IndentWidth);
        // UseTab 使用 enum
        normalized.UseTab = toEnum((raw as { UseTab?: unknown }).UseTab, ['Never', 'ForIndentation', 'ForContinuationAndIndentation', 'Always'], defaults.UseTab);
        normalized.ColumnLimit = toInt((raw as { ColumnLimit?: unknown }).ColumnLimit, defaults.ColumnLimit);
        normalized.BreakBeforeBraces = toEnum((raw as { BreakBeforeBraces?: unknown }).BreakBeforeBraces, ['Attach', 'LLVM', 'Stroustrup', 'Allman', 'GNU', 'Mozilla', 'WebKit', 'Custom'], defaults.BreakBeforeBraces);
        // 布尔/枚举类型 AllowShortIfStatementsOnASingleLine
        normalized.AllowShortIfStatementsOnASingleLine = toEnum((raw as { AllowShortIfStatementsOnASingleLine?: unknown }).AllowShortIfStatementsOnASingleLine, ['Never', 'WithoutElse', 'OnlyFirstIf', 'AllIfsAndElse', 'Always'], defaults.AllowShortIfStatementsOnASingleLine);
        normalized.AllowShortFunctionsOnASingleLine = toEnum((raw as { AllowShortFunctionsOnASingleLine?: unknown }).AllowShortFunctionsOnASingleLine, ['None', 'Empty', 'Inline', 'All'], defaults.AllowShortFunctionsOnASingleLine);
        // IndentCaseLabels: boolean
        normalized.IndentCaseLabels = toBool((raw as { IndentCaseLabels?: unknown }).IndentCaseLabels, defaults.IndentCaseLabels);
        normalized.PointerAlignment = toEnum((raw as { PointerAlignment?: unknown }).PointerAlignment, ['Left', 'Right', 'Middle'], defaults.PointerAlignment);
        normalized.SpaceBeforeParens = toEnum((raw as { SpaceBeforeParens?: unknown }).SpaceBeforeParens, ['Never', 'ControlStatements', 'Always', 'Custom'], defaults.SpaceBeforeParens);
        // SortIncludes: boolean
        normalized.SortIncludes = toBool((raw as { SortIncludes?: unknown }).SortIncludes, defaults.SortIncludes);
        // AlignConsecutiveAssignments: boolean
        normalized.AlignConsecutiveAssignments = toBool((raw as { AlignConsecutiveAssignments?: unknown }).AlignConsecutiveAssignments, defaults.AlignConsecutiveAssignments);
        // AlignConsecutiveDeclarations: boolean
        normalized.AlignConsecutiveDeclarations = toBool((raw as { AlignConsecutiveDeclarations?: unknown }).AlignConsecutiveDeclarations, defaults.AlignConsecutiveDeclarations);

        // 兼容旧版 formatterIndentStyle
        if (Object.prototype.hasOwnProperty.call(raw, 'formatterIndentStyle') && !Object.prototype.hasOwnProperty.call(raw, 'UseTab')) {
            const legacyStyle = String((raw as { formatterIndentStyle?: unknown }).formatterIndentStyle || '').trim().toLowerCase();
            if (legacyStyle === 'tabs') {
                normalized.UseTab = 'Always';
            } else if (legacyStyle === 'spaces') {
                normalized.UseTab = 'Never';
            }
        }

        return normalized;
    }

    /**
     * 格式化 C++ 代码。
     *
     * @param code 待格式化的 C++ 源码
     * @param options 可选的格式化选项，包含 clangFormatStyle 或 clangFormat
     * @returns 格式化后的代码字符串，输入无效时返回原码或空字符串
     *
     * @example
     * ```typescript
     * const formatted = formatCpp('int main() { return 0; }', {
     *     clangFormatStyle: { BasedOnStyle: 'LLVM', IndentWidth: 4 }
     * });
     * ```
     */
    function formatCpp(code: string, options: FormatCppOptions = {}): string {
        if (!code || typeof code !== 'string') return code || '';

        const clangFormatStyle = normalizeClangFormatStyle(options.clangFormatStyle || options.clangFormat || {});
        const indentWidth: number = Number.isFinite(clangFormatStyle.IndentWidth) && clangFormatStyle.IndentWidth > 0
            ? clangFormatStyle.IndentWidth
            : (Number.isFinite(options.tabSize) && (options.tabSize as number) > 0 ? (options.tabSize as number) : 4);
        const insertSpaces: boolean = clangFormatStyle.UseTab === 'Never';
        const breakBeforeBraces: string = String(clangFormatStyle.BreakBeforeBraces || 'Attach');
        const indentCaseLabels: boolean = clangFormatStyle.IndentCaseLabels !== false;

        const EOL: string = '\n';
        const src: string = code.replace(/\r\n?|\u2028|\u2029/g, '\n');

        const rawLines: string[] = src.split('\n');

        let inBlockComment: boolean = false;
        let indentLevel: number = 0;
        let blankCount: number = 0;
        let inPreprocessorContinuation: boolean = false;

        const mkIndent = (level: number): string => insertSpaces ? ' '.repeat(level * indentWidth) : '\t'.repeat(level);

        const out: string[] = [];

        function processLine(line: string, nextLine: string): { segments: string[]; open: number; close: number; noIndent: boolean } {
            const trimmedLeft = line.replace(/^[\t ]+/, '');
            if (trimmedLeft.startsWith('#')) {
                const keep = line.replace(/[ \t]+$/g, '');
                return { segments: [keep], open: 0, close: 0, noIndent: true };
            }

            let open = 0, close = 0;
            let i = 0, s = line;
            let out = '';
            let segments: string[] = [];

            let inStrS = false, inStrD = false, inStrRaw = false;
            let templateDepth = 0;
            let inlineBraceDepth = 0;
            let parenDepth = 0; // 括号深度，用于判定是否允许在分号处换行

            const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t';

            let pendingSpace = false; // 记录遇到的空白，按需输出
            const emitPendingSpaceIfNeeded = (nextCharCategory: string): void => {
                if (!pendingSpace) return;
                const prev = out.replace(/\s+$/g, '').slice(-1);
                const noSpaceBefore = new Set([')', ']', '}', ',', ';', ':']);
                const noSpaceAfterPrev = new Set(['(', '[', '{']);
                if (prev && !noSpaceAfterPrev.has(prev) && nextCharCategory !== 'rb') {
                    if (!/\s$/.test(out)) out += ' ';
                }
                pendingSpace = false;
            };

            while (i < s.length) {
                const ch = s[i] as string;
                const next = i + 1 < s.length ? s[i + 1] as string : '';
                const three = i + 2 < s.length ? s.substring(i, i + 3) : '';

                if (inBlockComment) {
                    if (pendingSpace) { out += ' '; pendingSpace = false; }
                    out += ch;
                    if (ch === '*' && next === '/') { out += '/'; i += 2; inBlockComment = false; continue; }
                    i++; continue;
                }
                if (!inStrS && !inStrD && !inStrRaw) {
                    if (ch === '/' && next === '*') { if (pendingSpace) { out += ' '; pendingSpace = false; } out += '/*'; inBlockComment = true; i += 2; continue; }
                    if (ch === '/' && next === '/') { if (pendingSpace) { out += ' '; pendingSpace = false; } out += s.substring(i); i = s.length; break; }
                }

                if (inStrS) {
                    if (pendingSpace) { out += ' '; pendingSpace = false; }
                    out += ch;
                    if (ch === '\\' && i + 1 < s.length) { out += s[i + 1]; i += 2; continue; }
                    if (ch === '\'') inStrS = false;
                    i++; continue;
                }
                if (inStrD) {
                    if (pendingSpace) { out += ' '; pendingSpace = false; }
                    out += ch;
                    if (ch === '\\' && i + 1 < s.length) { out += s[i + 1]; i += 2; continue; }
                    if (ch === '"') inStrD = false;
                    i++; continue;
                }
                if (inStrRaw) {
                    if (pendingSpace) { out += ' '; pendingSpace = false; }
                    out += ch;
                    if (ch === '"') inStrRaw = false;
                    i++; continue;
                }

                if (ch === '\'') { if (pendingSpace) { out += ' '; pendingSpace = false; } inStrS = true; out += ch; i++; continue; }
                if (ch === '"') {
                    const prev = s[i - 1] || '';
                    const look = s.substring(i, i + 2);
                    if (prev === 'R' && look === '"(') { if (pendingSpace) { out += ' '; pendingSpace = false; } inStrRaw = true; out += ch; i++; continue; }
                    if (pendingSpace) { out += ' '; pendingSpace = false; } inStrD = true; out += ch; i++; continue;
                }

                if (ch === '{') open++;
                if (ch === '}') close++;

                if (isSpace(ch)) { pendingSpace = true; i++; continue; }

                const two = ch + next;
                const spacedThree = ['>>=', '<<='];
                if (spacedThree.includes(three)) {
                    emitPendingSpaceIfNeeded('op');
                    out = out.replace(/[ ]+$/g, '');
                    if (out && out[out.length - 1] !== ' ') out += ' ';
                    out += three + ' ';
                    i += 3; continue;
                }
                if (two === '++' || two === '--') {
                    emitPendingSpaceIfNeeded('op');
                    const prevNonSpace = out.replace(/\s+$/g, '').slice(-1);
                    const shouldStripSpace = /[A-Za-z0-9_\)\]\}]/.test(prevNonSpace || ''); // i++、x)++ 等去掉前空格
                    if (shouldStripSpace) {
                        out = out.replace(/[ ]+$/g, '');
                    }
                    out += two;
                    i += 2; continue;
                }
                if (two === '->' || two === '::') {
                    out = out.replace(/[ ]+$/g, '');
                    out += two;
                    i += 2; continue;
                }
                if (two === '>>' && templateDepth > 0) {
                    out = out.replace(/[ ]+$/g, '');
                    out += '>>';
                    templateDepth = Math.max(0, templateDepth - 2);
                    i += 2; continue;
                }
                const spacedTwo = ['==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>'];
                if (spacedTwo.includes(two)) {
                    emitPendingSpaceIfNeeded('op');
                    out = out.replace(/[ ]+$/g, '');
                    if (out && out[out.length - 1] !== ' ') out += ' ';
                    out += two + ' ';
                    i += 2; continue;
                }

                if (ch === ',') {
                    pendingSpace = false;
                    out = out.replace(/[ ]+$/g, '');
                    out += ',';
                    const after = s.substring(i + 1).trimStart();
                    if (after && !after.startsWith(')') && !after.startsWith(';')) out += ' ';
                    i++; continue;
                }

                if (ch === ';') {
                    pendingSpace = false;
                    out = out.replace(/[ ]+$/g, '');
                    out += ';';
                    const afterRaw = s.substring(i + 1);
                    const after = afterRaw.trimStart();
                    if (parenDepth === 0 && after.length > 0) {
                        segments.push(out);
                        out = '';
                        i++;
                        while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
                        continue;
                    } else {
                        if (after && !after.startsWith(')') && !after.startsWith('}') && !after.startsWith(';')) {
                            out += ' ';
                        }
                        i++; continue;
                    }
                }

                if (ch === '?') {
                    emitPendingSpaceIfNeeded('op');
                    out = out.replace(/[ ]+$/g, '');
                    if (out && out[out.length - 1] !== ' ') out += ' ';
                    out += '? ';
                    i++; continue;
                }
                if (ch === ':') {
                    emitPendingSpaceIfNeeded('op');
                    out = out.replace(/[ ]+$/g, '');
                    if (out && out[out.length - 1] !== ' ') out += ' ';
                    out += ': ';
                    i++; continue;
                }

                if ((ch === '-' || ch === '+') && /[0-9.]?[eE]$/.test(out.replace(/\s+$/g, ''))) {
                    pendingSpace = false;
                    out = out.replace(/[ ]+$/g, '');
                    out += ch;
                    i++;
                    continue;
                }

                if ('=+-*/%<>&|^'.includes(ch)) {
                    const prev = out.replace(/\s+$/g, '').slice(-1);
                    const unary = (ch === '*' || ch === '&' || ch === '+' || ch === '-') && (!prev || '([,{;=+-*/%&|^!~?:<>'.includes(prev));
                    const isTemplateStart = (): boolean => {
                        if (ch !== '<') return false;
                        const prevNonSpace = out.replace(/\s+$/g, '').slice(-1);
                        const prevLooksLikeName = /[A-Za-z0-9_>]/.test(prevNonSpace || '');
                        if (!prevLooksLikeName) return false;
                        let depth = 1;
                        let k = i + 1;
                        while (k < s.length) {
                            const c = s[k] as string;
                            if (c === '<') depth++;
                            else if (c === '>') { depth--; if (depth === 0) break; }
                            else if (c === '"' || c === '\'') break; // 字符串/字符开始则放弃
                            else if (/[^\sA-Za-z0-9_,:<>&*]/.test(c)) { // 出现不被允许的字符
                                return false;
                            }
                            k++;
                        }
                        return k < s.length && depth === 0;
                    };
                    if (isTemplateStart()) {
                        emitPendingSpaceIfNeeded('op');
                        out = out.replace(/[ ]+$/g, '');
                        out += '<';
                        templateDepth++;
                        i++;
                        continue;
                    }
                    if (ch === '>' && templateDepth > 0) {
                        emitPendingSpaceIfNeeded('op');
                        out = out.replace(/[ ]+$/g, '');
                        out += '>';
                        templateDepth = Math.max(0, templateDepth - 1);
                        i++; continue;
                    }
                    if (unary) {
                        emitPendingSpaceIfNeeded('op');
                        out = out.replace(/[ ]+$/g, '');
                        out += ch; i++; continue;
                    }
                    emitPendingSpaceIfNeeded('op');
                    out = out.replace(/[ ]+$/g, '');
                    if (out && out[out.length - 1] !== ' ') out += ' ';
                    out += ch + ' ';
                    i++; continue;
                }

                if (ch === '(') {
                    const prevNonSpace = out.replace(/\s+$/g, '').slice(-1);
                    const keepTrailingSpace = prevNonSpace && /[=+\-*/%<>&|^!?~,:]/.test(prevNonSpace);
                    if (!keepTrailingSpace) {
                        out = out.replace(/[ ]+$/g, '');
                    }
                    out += '(';
                    parenDepth++;
                    i++;
                    while (i < s.length && isSpace(s[i] as string)) i++;
                    continue;
                }
                if (ch === '{') {
                    emitPendingSpaceIfNeeded('op');
                    const prevNonSpace = out.replace(/\s+$/g, '').slice(-1);
                    const trimmedOut = out.replace(/\s+$/g, '');
                    const blockKeywordRegex = /\b(if|for|while|switch|else|do|try|catch|class|struct|namespace|union|enum|case|default)\b[^{}]*$/;
                    const endsWithControl = /[\)\]]$/.test(trimmedOut);
                    const isInitializerBrace = parenDepth > 0 || (!endsWithControl && !blockKeywordRegex.test(trimmedOut));
                    const shouldBreakBeforeBrace = breakBeforeBraces === 'Allman' || breakBeforeBraces === 'GNU';
                    let shouldAddSpace = prevNonSpace && !/[\s{[(]/.test(prevNonSpace);
                    if (isInitializerBrace) {
                        const lastWordMatch = trimmedOut.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
                        const lastWord = lastWordMatch ? lastWordMatch[1] as string : '';
                        const keywordsNeedingSpace = new Set(['return', 'co_return', 'throw', 'new']);
                        const prevRequiresSpace = prevNonSpace && /[=,:]/.test(prevNonSpace);
                        shouldAddSpace = keywordsNeedingSpace.has(lastWord) || prevRequiresSpace;
                    }
                    if (shouldAddSpace) {
                        out = out.replace(/[ ]+$/g, '');
                        out += ' ';
                    } else {
                        out = out.replace(/[ ]+$/g, '');
                    }
                    if (shouldBreakBeforeBrace && !isInitializerBrace && out.trim()) {
                        segments.push(out.replace(/[ ]+$/g, ''));
                        out = '';
                    }
                    out += ch;
                    if (isInitializerBrace) {
                        inlineBraceDepth++;
                        i++;
                        continue;
                    }
                    const afterBrace = s.substring(i + 1).trim();
                    if (afterBrace && !afterBrace.startsWith('}')) {
                        segments.push(out);
                        out = '';
                        i++;
                        while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
                        continue;
                    }
                    i++; continue;
                }

                if (ch === '}') {
                    if (inlineBraceDepth > 0) {
                        inlineBraceDepth--;
                        emitPendingSpaceIfNeeded('op');
                        out = out.replace(/[ ]+$/g, '');
                        out += ch;
                        i++;
                        continue;
                    }
                    if (out.trim()) {
                        segments.push(out);
                        out = '';
                    }
                    emitPendingSpaceIfNeeded('op');
                    out += ch;
                    let j = i + 1;
                    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
                    if (s[j] === ';') {
                        out += ';';
                        j++;
                        while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
                        if (j < s.length) {
                            segments.push(out);
                            out = '';
                            i = j;
                            continue;
                        } else {
                            i = j;
                            continue; // 行结束
                        }
                    }
                    const afterBrace = s.substring(i + 1).trim();
                    if (afterBrace) {
                        const varDeclPattern = /^[A-Za-z_\*\&\:\<\>\[\]\,\s0-9]+;\s*$/;
                        if (varDeclPattern.test(afterBrace) && !/\{/.test(afterBrace) && !/\}/.test(afterBrace) && !/\s/.test(afterBrace.replace(/;\s*$/, ''))) {
                            out += ' ' + afterBrace.replace(/\s+$/, '');
                            segments.push(out);
                            out = '';
                            i = s.length; // 跳到行尾
                            continue;
                        }
                        segments.push(out);
                        out = '';
                        i++;
                        while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
                        continue;
                    }
                    i++;
                    continue;
                }

                if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(ch)) {
                    emitPendingSpaceIfNeeded('id');
                    out += ch; i++; continue;
                }

                emitPendingSpaceIfNeeded('op');
                out += ch; i++;
            }

            out = out.replace(/\b(if|for|while|switch|catch)\s*\(/g, '$1 (');

            out = out.replace(/\bcase\s+([^:]+?)\s*:\s*/g, 'case $1: ');
            out = out.replace(/\bdefault\s*:\s*/g, 'default: ');
            {
                const kw = new Set(['if', 'for', 'while', 'switch', 'catch']);
                out = out.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\s+\(/g, (m, name) => {
                    return kw.has(name) ? `${name} (` : `${name}(`;
                });
                out = out.replace(/([\]\>])\s+\(/g, '$1(');
            }
            out = out.replace(/([A-Za-z_][A-Za-z0-9_]*)\s*<\s*([^>]+?)\s*>/g, (m, name, inner) => {
                if (/[;(){}]/.test(inner)) return m;
                const cleaned = inner
                    .replace(/\s*,\s*/g, ', ')
                    .replace(/\s+/g, ' ')
                    .trim();
                return `${name}<${cleaned}>`;
            });

            out = out.replace(/[ \t]+$/g, '');

            out = out.replace(/}\n\s*;/g, '};');

            out = out.replace(/^(\s*case [^:]+:\s*)([^\n][^]*)/gm, (m, head, rest) => {
                if (/^break;/.test(rest.trim())) return head + '\n' + rest.trim();
                return head + '\n' + rest.trim();
            });

            if (out.length > 0) segments.push(out);

            return { segments, open, close, noIndent: false };
        }

        for (let idx = 0; idx < rawLines.length; idx++) {
            let line = rawLines[idx] as string;
            line = line.replace(/[ \t]+$/g, '');

            const trimmedLeft = line.replace(/^[\t ]+/, '');
            if (inPreprocessorContinuation || trimmedLeft.startsWith('#')) {
                out.push(line);
                inPreprocessorContinuation = /\\$/.test(line);
                blankCount = 0;
                continue;
            }

            if (line.trim() === '') {
                if (blankCount < 1) out.push('');
                blankCount++;
                continue;
            }
            blankCount = 0;

            const res = processLine(line, rawLines[idx + 1] || '');

            if (!res.noIndent && res.segments && res.segments.length > 0) {
                const lastSeg = res.segments[res.segments.length - 1];
                if (lastSeg && lastSeg.trim() === '}' && rawLines[idx + 1]) {
                    const nextRaw = (rawLines[idx + 1] as string).trim();
                    const nextBody = nextRaw.replace(/;\s*$/, '');
                    if (/^[A-Za-z_\*\&\<\[]/.test(nextRaw) && /;\s*$/.test(nextRaw) && !/=/.test(nextRaw) && !/\s/.test(nextBody)) {
                        res.segments[res.segments.length - 1] = lastSeg + ' ' + nextRaw;
                        idx++;
                        blankCount = 0;
                    }
                }
            }

            if (res.noIndent) {
                res.segments.forEach((seg: string, sidx: number) => {
                    out.push(seg);
                });
            } else {
                let tempLevel = indentLevel;
                res.segments.forEach((seg: string, idxInLine: number) => {
                    let text = seg.trimStart();
                    const startsClose = text.startsWith('}');
                    const isCaseLine = /^case\s+[^:]+:\s*$/.test(text) || /^default:\s*$/.test(text);
                    let segLevel = Math.max(0, tempLevel - (startsClose ? 1 : 0));
                    if (isCaseLine) {
                        if (!indentCaseLabels && segLevel > 0) segLevel -= 1;
                        text = text.trimEnd();
                    }
                    out.push(mkIndent(segLevel) + text);

                    const opens = (seg.match(/\{/g) || []).length;
                    const closes = (seg.match(/\}/g) || []).length;
                    tempLevel = Math.max(0, tempLevel + opens - closes);
                    if (isCaseLine) {
                        const nextSeg = res.segments[idxInLine + 1];
                        if (nextSeg && !/^\s*(case\s+|default:|})/.test(nextSeg)) {
                            tempLevel = tempLevel + 1; // 暂时加一层
                        }
                    }
                });
                indentLevel = tempLevel;
            }

        }

        return out.join(EOL);
    }

    // 导出 API
    if (!window.cppFormatter) {
        window.cppFormatter = { format: formatCpp };
    }
})();
