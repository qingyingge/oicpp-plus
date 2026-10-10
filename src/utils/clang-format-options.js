'use strict';

/**
 * Single source of truth for clang-format style options.
 *
 * Previously this logic was duplicated in 4 places:
 *   - renderer/js/formatters/cppFormatter.js   (deleted)
 *   - renderer/js/monaco-editor-manager.js
 *   - renderer/settings/editor.js
 *   - src/main.js
 *   - src/clang-format-service.js (serialize)
 *
 * This module is dual-environment (UMD): it exports via `module.exports`
 * when loaded as CommonJS (main process), and attaches to `window.clangFormatOptions`
 * when loaded via <script> tag (renderer pages, nodeIntegration:false).
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.clangFormatOptions = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const OPTION_DEFS = {
        BasedOnStyle: { type: 'enum', values: ['LLVM', 'Google', 'Mozilla', 'Chromium', 'Microsoft', 'WebKit'], default: 'LLVM' },
        IndentWidth: { type: 'int', default: 4 },
        TabWidth: { type: 'int', default: 4 },
        UseTab: { type: 'enum', values: ['Never', 'ForIndentation', 'ForContinuationAndIndentation', 'Always'], default: 'Never' },
        ColumnLimit: { type: 'int', default: 0 },
        BreakBeforeBraces: { type: 'enum', values: ['Attach', 'LLVM', 'Stroustrup', 'Allman', 'GNU', 'Mozilla', 'WebKit', 'Custom'], default: 'Attach' },
        AllowShortIfStatementsOnASingleLine: { type: 'enum', values: ['Never', 'WithoutElse', 'OnlyFirstIf', 'AllIfsAndElse', 'Always'], default: 'Never' },
        AllowShortFunctionsOnASingleLine: { type: 'enum', values: ['None', 'Empty', 'Inline', 'All'], default: 'Empty' },
        IndentCaseLabels: { type: 'bool', default: false },
        PointerAlignment: { type: 'enum', values: ['Left', 'Right', 'Middle'], default: 'Left' },
        SpaceBeforeParens: { type: 'enum', values: ['Never', 'ControlStatements', 'Always', 'Custom'], default: 'ControlStatements' },
        SortIncludes: { type: 'bool', default: true },
        AlignConsecutiveAssignments: { type: 'bool', default: false },
        AlignConsecutiveDeclarations: { type: 'bool', default: false }
    };

    const PRESET_STYLES = new Set(['LLVM', 'GNU', 'Google', 'Chromium', 'Microsoft', 'Mozilla', 'WebKit']);

    function getDefaultClangFormatStyle() {
        const defaults = {};
        Object.keys(OPTION_DEFS).forEach((key) => {
            defaults[key] = OPTION_DEFS[key].default;
        });
        return defaults;
    }

    function toInt(value, fallback) {
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }

    function toBool(value, fallback) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
            const lowered = value.trim().toLowerCase();
            if (['true', 'yes', 'on'].includes(lowered)) return true;
            if (['false', 'no', 'off'].includes(lowered)) return false;
        }
        return fallback;
    }

    function toEnum(value, allowed, fallback) {
        const rawValue = String(value || '').trim();
        if (!rawValue) return fallback;
        const matched = allowed.find((item) => item.toLowerCase() === rawValue.toLowerCase());
        return matched || fallback;
    }

    function normalizeClangFormatStyle(raw) {
        const defaults = getDefaultClangFormatStyle();
        const normalized = { ...defaults };
        if (!raw || typeof raw !== 'object') {
            return normalized;
        }

        Object.keys(OPTION_DEFS).forEach((key) => {
            if (!Object.prototype.hasOwnProperty.call(raw, key)) return;
            const def = OPTION_DEFS[key];
            if (def.type === 'enum') {
                normalized[key] = toEnum(raw[key], def.values, defaults[key]);
            } else if (def.type === 'bool') {
                normalized[key] = toBool(raw[key], defaults[key]);
            } else {
                normalized[key] = toInt(raw[key], defaults[key]);
            }
        });

        // TabWidth falls back to IndentWidth when unset.
        if (!Object.prototype.hasOwnProperty.call(raw, 'TabWidth')) {
            normalized.TabWidth = normalized.IndentWidth;
        }

        // Legacy migration: formatterIndentStyle (tabs/spaces) -> UseTab.
        if (Object.prototype.hasOwnProperty.call(raw, 'formatterIndentStyle') && !Object.prototype.hasOwnProperty.call(raw, 'UseTab')) {
            const legacyStyle = String(raw.formatterIndentStyle || '').trim().toLowerCase();
            if (legacyStyle === 'tabs') {
                normalized.UseTab = 'Always';
            } else if (legacyStyle === 'spaces') {
                normalized.UseTab = 'Never';
            }
        }

        return normalized;
    }

    /**
     * Serialize a style value for clang-format's --style argument.
     * Mirrors the previous clang-format-service.serializeClangFormatStyle.
     * Returns 'file' for null/undefined/'file', a preset name, or JSON.
     */
    function serializeClangFormatStyle(style) {
        if (style === null || style === undefined || style === '') {
            return 'file';
        }
        if (typeof style === 'string') {
            const value = style.trim();
            if (value.toLowerCase() === 'file') return 'file';
            const preset = Array.from(PRESET_STYLES).find((item) => item.toLowerCase() === value.toLowerCase());
            if (preset) return preset;
            if (value.startsWith('{')) {
                const parsed = JSON.parse(value);
                if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
                    throw new Error('clang-format style must be a JSON object');
                }
                return JSON.stringify(parsed);
            }
            throw new Error(`Unsupported clang-format style: ${value}`);
        }
        if (typeof style === 'object' && !Array.isArray(style)) {
            return JSON.stringify(style);
        }
        throw new Error('clang-format style must be an object, preset name, or file');
    }

    /**
     * Parse a .clang-format YAML-ish text into a style object.
     * Previously editor.js.parseClangFormatText.
     */
    function parseClangFormatText(text) {
        const parsed = {};
        String(text || '').split(/\r?\n/).forEach((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed === '---' || trimmed === '...') {
                return;
            }
            const match = trimmed.match(/^([A-Za-z][A-Za-z0-9]*)\s*:\s*(.+)$/);
            if (!match) return;
            const key = match[1];
            let value = match[2].trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (/^(true|false)$/i.test(value)) {
                value = value.toLowerCase() === 'true';
            } else if (/^-?\d+$/.test(value)) {
                value = parseInt(value, 10);
            }
            parsed[key] = value;
        });
        return parsed;
    }

    /**
     * Generate .clang-format text from a style.
     * Previously editor.js.generateClangFormatText and the raw-text block in
     * main.js normalizeSettingsRuntimeShape.
     */
    function generateClangFormatText(style) {
        const normalized = normalizeClangFormatStyle(style || null);
        const serialize = (value) => {
            if (typeof value === 'boolean') return value ? 'true' : 'false';
            if (typeof value === 'number') return String(value);
            const text = String(value || '');
            if (/\s/.test(text)) {
                return `"${text.replace(/"/g, '\\"')}"`;
            }
            return text;
        };
        return Object.keys(OPTION_DEFS).map((key) => `${key}: ${serialize(normalized[key])}`).join('\n');
    }

    /**
     * Stable fingerprint of a normalized style, used as the pool key for
     * reusable clang-format processes (P4).
     */
    function getStyleFingerprint(style) {
        const normalized = normalizeClangFormatStyle(style || null);
        return Object.keys(OPTION_DEFS).map((key) => `${key}=${String(normalized[key])}`).join('|');
    }

    return {
        OPTION_DEFS,
        PRESET_STYLES,
        getDefaultClangFormatStyle,
        normalizeClangFormatStyle,
        serializeClangFormatStyle,
        parseClangFormatText,
        generateClangFormatText,
        getStyleFingerprint
    };
});