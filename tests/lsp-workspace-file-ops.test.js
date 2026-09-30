'use strict';

const path = require('path');
const utils = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'lsp-utils.js'));

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

class FakeRange {
    constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
        this.startLineNumber = startLineNumber;
        this.startColumn = startColumn;
        this.endLineNumber = endLineNumber;
        this.endColumn = endColumn;
    }
}

const monaco = {
    Range: FakeRange,
    Uri: {
        parse: (value) => ({ value, toString: () => value })
    }
};

const textRange = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 }
};

const fileOperationEdit = utils.toMonacoWorkspaceEdit({
    documentChanges: [
        { kind: 'create', uri: 'file:///workspace/new.hpp', options: { overwrite: true, ignoreIfExists: false } },
        { kind: 'rename', oldUri: 'file:///workspace/old.hpp', newUri: 'file:///workspace/moved.hpp', options: { overwrite: false, ignoreIfExists: true } },
        { kind: 'delete', uri: 'file:///workspace/gone.hpp', options: { recursive: true, ignoreIfNotExists: true } }
    ]
}, monaco);

const operations = fileOperationEdit?.edits || [];
check('utils: CreateFile/RenameFile/DeleteFile all convert', operations.length === 3,
    `count=${operations.length}`);

const create = operations.find((item) => item.fileOperation === 'create');
check('utils: CreateFile keeps target uri and flags',
    create?.resource?.value === 'file:///workspace/new.hpp'
    && create?.options?.overwrite === true
    && create?.options?.ignoreIfExists === false);

const rename = operations.find((item) => item.fileOperation === 'rename');
check('utils: RenameFile keeps both endpoints and flags',
    rename?.oldResource?.value === 'file:///workspace/old.hpp'
    && rename?.newResource?.value === 'file:///workspace/moved.hpp'
    && rename?.options?.overwrite === false
    && rename?.options?.ignoreIfExists === true);

const remove = operations.find((item) => item.fileOperation === 'delete');
check('utils: DeleteFile keeps target uri and recursive flag',
    remove?.resource?.value === 'file:///workspace/gone.hpp'
    && remove?.options?.recursive === true
    && remove?.options?.ignoreIfNotExists === true);

// Text edits and file operations may be interleaved in one documentChanges list;
// both must survive the conversion.
const mixed = utils.toMonacoWorkspaceEdit({
    documentChanges: [
        { kind: 'rename', oldUri: 'file:///workspace/a.cpp', newUri: 'file:///workspace/b.cpp' },
        {
            textDocument: { uri: 'file:///workspace/b.cpp', version: 4 },
            edits: [{ range: textRange, newText: 'z' }]
        }
    ]
}, monaco);
const mixedEdits = mixed?.edits || [];
check('utils: mixed file operation and text edit are both preserved', mixedEdits.length === 2,
    `count=${mixedEdits.length}`);
const mixedText = mixedEdits.find((item) => item.textEdit);
check('utils: interleaved text edit keeps its document version', mixedText?.versionId === 4);
check('utils: interleaved text edit is converted to a Monaco range',
    mixedText?.textEdit?.range?.startLineNumber === 1 && mixedText?.textEdit?.text === 'z');

// Unknown operation kinds must be ignored rather than crash the conversion.
const unknown = utils.toMonacoWorkspaceEdit({
    documentChanges: [
        { kind: 'not-a-real-op', uri: 'file:///workspace/x.cpp' },
        { kind: 'create' },
        { kind: 'rename', oldUri: 'file:///workspace/only-old.cpp' }
    ]
}, monaco);
check('utils: incomplete file operations are skipped', !unknown || (unknown.edits?.length || 0) === 0,
    `edits=${JSON.stringify(unknown?.edits?.length ?? 0)}`);

// A rename missing either endpoint cannot be applied and must not be emitted.
const partialRename = utils.toMonacoWorkspaceEdit({
    documentChanges: [{ kind: 'rename', oldUri: 'file:///workspace/only-old.cpp' }]
}, monaco);
check('utils: RenameFile without newUri is dropped', !partialRename || (partialRename.edits?.length || 0) === 0);

// Legacy `changes` form must keep working alongside the new documentChanges path.
const legacy = utils.toMonacoWorkspaceEdit({
    changes: {
        'file:///workspace/main.cpp': [{ range: textRange, newText: 'legacy' }]
    }
}, monaco);
check('utils: legacy changes form still converts',
    legacy?.edits?.length === 1 && legacy.edits[0].textEdit?.text === 'legacy');

const empty = utils.toMonacoWorkspaceEdit({ documentChanges: [] }, monaco);
check('utils: empty documentChanges yields undefined', empty === undefined);

process.exitCode = failures ? 1 : 0;
