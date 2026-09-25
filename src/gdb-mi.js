'use strict';

const MAX_MI_VALUE_LENGTH = 1024 * 1024;

function decodeGdbString(value) {
    const text = String(value || '');
    if (!text.startsWith('"')) return text;
    let result = '';
    let escaped = false;
    for (let i = 1; i < text.length; i++) {
        const ch = text[i];
        if (!escaped && ch === '"') break;
        if (!escaped && ch !== '\\') {
            result += ch;
            continue;
        }
        if (!escaped) {
            escaped = true;
            continue;
        }
        escaped = false;
        switch (ch) {
            case 'a': result += '\x07'; break;
            case 'b': result += '\b'; break;
            case 'f': result += '\f'; break;
            case 'n': result += '\n'; break;
            case 'r': result += '\r'; break;
            case 't': result += '\t'; break;
            case 'v': result += '\v'; break;
            case '\\': result += '\\'; break;
            case '"': result += '"'; break;
            case 'x': {
                let hex = '';
                while (hex.length < 2 && i + 1 < text.length && /[0-9a-fA-F]/.test(text[i + 1])) {
                    i++;
                    hex += text[i];
                }
                result += String.fromCharCode(parseInt(hex, 16) || 0);
                break;
            }
            default:
                if (/[0-7]/.test(ch)) {
                    let octal = ch;
                    while (octal.length < 3 && i + 1 < text.length && /[0-7]/.test(text[i + 1])) {
                        i++;
                        octal += text[i];
                    }
                    result += String.fromCharCode(parseInt(octal, 8) || 0);
                } else {
                    result += ch;
                }
        }
    }
    return result;
}

function miQuote(value) {
    return JSON.stringify(String(value));
}

function parseMiValue(text, start) {
    let index = start;
    while (index < text.length && /[\s,]/.test(text[index])) index++;
    if (index >= text.length) return { value: '', next: index };

    if (text[index] === '"') {
        let escaped = false;
        let end = index + 1;
        while (end < text.length) {
            if (text[end] === '"' && !escaped) break;
            if (text[end] === '\\' && !escaped) {
                escaped = true;
            } else {
                escaped = false;
            }
            end++;
        }
        return {
            value: decodeGdbString(text.slice(index, end + 1)),
            next: Math.min(end + 1, text.length)
        };
    }

    if (text[index] === '{') {
        return parseMiObject(text, index + 1);
    }

    if (text[index] === '[') {
        const values = [];
        let cursor = index + 1;
        while (cursor < text.length && text[cursor] !== ']') {
            const parsed = parseMiValue(text, cursor);
            values.push(parsed.value);
            cursor = parsed.next;
            while (cursor < text.length && /[\s,]/.test(text[cursor])) cursor++;
        }
        return { value: values, next: Math.min(cursor + 1, text.length) };
    }

    if (text[index] === '(') {
        const values = [];
        let cursor = index + 1;
        while (cursor < text.length && text[cursor] !== ')') {
            const parsed = parseMiValue(text, cursor);
            values.push(parsed.value);
            cursor = parsed.next;
            while (cursor < text.length && /[\s,]/.test(text[cursor])) cursor++;
        }
        return { value: values, next: Math.min(cursor + 1, text.length) };
    }

    let end = index;
    while (end < text.length && !/[,\]}[]/.test(text[end])) end++;
    return {
        value: text.slice(index, end).trim(),
        next: end
    };
}

function parseMiObject(text, start) {
    const result = {};
    let index = start;
    while (index < text.length && text[index] !== '}') {
        while (index < text.length && /[\s,]/.test(text[index])) index++;
        if (index >= text.length || text[index] === '}') break;
        const keyStart = index;
        while (index < text.length && text[index] !== '=' && text[index] !== '}') index++;
        if (text[index] !== '=') break;
        const key = text.slice(keyStart, index).trim();
        const parsed = parseMiValue(text, index + 1);
        result[key] = parsed.value;
        index = parsed.next;
    }
    return { value: result, next: Math.min(index + 1, text.length) };
}

function parseMiFields(payload) {
    if (!payload) return {};
    return parseMiObject(payload, 0).value;
}

function parseMiRecord(line) {
    const text = String(line || '').trim();
    if (!text) return null;
    if (text.length > MAX_MI_VALUE_LENGTH) {
        throw new Error('MI record exceeds size limit');
    }
    const typeIndex = text.search(/[~@^*=&]/);
    if (typeIndex < 0) return { type: 'unknown', raw: text };
    const token = text.slice(0, typeIndex);
    const type = text[typeIndex];
    const payload = text.slice(typeIndex + 1);
    if (type === '~' || type === '@') {
        const parsed = parseMiValue(payload, 0);
        return {
            type: 'stream',
            token,
            stream: type === '~' ? 'target' : 'console',
            text: typeof parsed.value === 'string' ? parsed.value : String(parsed.value || ''),
            raw: text
        };
    }
    if (type === '^' || type === '*' || type === '=' || type === '&') {
        const separator = payload.indexOf(',');
        const name = (separator === -1 ? payload : payload.slice(0, separator)).trim();
        const fields = separator === -1 ? {} : parseMiFields(payload.slice(separator + 1));
        if (type === '^') return { type: 'result', token, status: name, fields, raw: text };
        if (type === '*') return { type: 'exec', token, name, fields, raw: text };
        if (type === '=') return { type: 'notify', token, name, fields, raw: text };
        return { type: 'log', token, level: name, fields, raw: text };
    }
    return { type: 'unknown', raw: text };
}

class GdbMiStream {
    constructor(onRecord) {
        this._buffer = '';
        this._onRecord = onRecord;
        this.maxBufferBytes = 4 * 1024 * 1024;
    }

    push(chunk) {
        this._buffer += String(chunk || '');
        if (this._buffer.length > this.maxBufferBytes) {
            this._buffer = this._buffer.slice(-this.maxBufferBytes);
            this._onRecord({ type: 'warning', message: 'MI output buffer truncated' });
        }
        let newline;
        while ((newline = this._buffer.indexOf('\n')) !== -1) {
            const line = this._buffer.slice(0, newline).replace(/\r$/, '');
            this._buffer = this._buffer.slice(newline + 1);
            if (line.trim()) {
                try {
                    const record = parseMiRecord(line);
                    if (record) this._onRecord(record);
                } catch (error) {
                    this._onRecord({ type: 'parse-error', message: error?.message || String(error), raw: line });
                }
            }
        }
    }

    flush() {
        if (this._buffer.trim()) {
            try {
                const record = parseMiRecord(this._buffer);
                if (record) this._onRecord(record);
            } catch (error) {
                this._onRecord({ type: 'parse-error', message: error?.message || String(error), raw: this._buffer });
            }
        }
        this._buffer = '';
    }
}

module.exports = {
    GdbMiStream,
    decodeGdbString,
    miQuote,
    parseMiFields,
    parseMiRecord,
    parseMiValue
};
