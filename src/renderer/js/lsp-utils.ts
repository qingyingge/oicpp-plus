
type FileOperationOptions = {
    overwrite?: boolean;
    ignoreIfExists?: boolean;
    recursive?: boolean;
    ignoreIfNotExists?: boolean;
};

type DocumentChangeOptions = {
    overwrite?: boolean;
    ignoreIfExists?: boolean;
    recursive?: boolean;
    ignoreIfNotExists?: boolean;
};

interface MonacoRange {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
}

interface MonacoUri {
    parse(uri: string): unknown;
}

interface Monaco {
    Range: new (startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) => MonacoRange;
    Uri: MonacoUri;
}

interface LspRange {
    start: { line: number; character: number };
    end: { line: number; character: number };
}

interface LspLocation {
    uri?: string;
    targetUri?: string;
    range?: LspRange;
    targetSelectionRange?: LspRange;
    targetRange?: LspRange;
    originSelectionRange?: LspRange;
}

interface LspWorkspaceEdit {
    changes?: Record<string, Array<{ range: LspRange; newText: string }>>;
    documentChanges?: ReadonlyArray<DocumentChange>;
}

// create/delete 用 resource，rename 用 oldResource+newResource —— 两种形状互斥，
// 合成一个接口会让 rename 分支被迫带上它没有的 resource。
type FileOperationEdit =
    | { fileOperation: 'create' | 'delete'; resource: unknown; options?: FileOperationOptions }
    | { fileOperation: 'rename'; oldResource: unknown; newResource: unknown; options?: FileOperationOptions };

interface TextEditEdit {
    resource: unknown;
    textEdit: { range: MonacoRange; text: string };
    versionId?: number;
}

type WorkspaceEdit = FileOperationEdit | TextEditEdit;

function toMonacoRange(range: LspRange | undefined, monaco: Monaco | undefined): MonacoRange | null {
    if (!range || !monaco || typeof monaco.Range !== 'function') {
        return null;
    }
    const start = range.start || {};
    const end = range.end || start;
    return new monaco.Range(
        (Number(start.line) || 0) + 1,
        (Number(start.character) || 0) + 1,
        (Number(end.line) || 0) + 1,
        (Number(end.character) || 0) + 1
    );
}

function toMonacoLocation(location: LspLocation | undefined, monaco: Monaco | undefined): { uri: unknown; range: MonacoRange; originSelectionRange?: MonacoRange } | null {
    if (!location || !monaco || !monaco.Uri) {
        return null;
    }
    const uri = location.uri || location.targetUri;
    const range = location.range || location.targetSelectionRange || location.targetRange;
    const convertedRange = toMonacoRange(range, monaco);
    if (!uri || !convertedRange) {
        return null;
    }
    try {
        const result: { uri: unknown; range: MonacoRange; originSelectionRange?: MonacoRange } = {
            uri: monaco.Uri.parse(uri),
            range: convertedRange
        };
        const originRange = toMonacoRange(location.originSelectionRange, monaco);
        if (originRange) {
            result.originSelectionRange = originRange;
        }
        return result;
    } catch (_) {
        return null;
    }
}

interface DocumentChange {
    kind?: 'create' | 'rename' | 'delete';
    uri?: string;
    oldUri?: string;
    newUri?: string;
    textDocument?: { uri: string; version: number };
    edits?: Array<{ range: LspRange; newText: string }>;
    options?: DocumentChangeOptions;
}

function toMonacoWorkspaceEdit(workspaceEdit: LspWorkspaceEdit | undefined, monaco: Monaco | undefined): { edits: WorkspaceEdit[] } | undefined {
    if (!workspaceEdit || !monaco || !monaco.Uri) {
        return undefined;
    }
    const edits: WorkspaceEdit[] = [];
    const appendFileOperation = (operation: DocumentChange | undefined) => {
        if (!operation || typeof operation !== 'object' || !monaco.Uri) return;
        try {
            if (operation.kind === 'create' && operation.uri) {
                edits.push({
                    fileOperation: 'create',
                    resource: monaco.Uri.parse(operation.uri),
                    options: {
                        overwrite: operation.options?.overwrite === true,
                        ignoreIfExists: operation.options?.ignoreIfExists === true
                    }
                });
            } else if (operation.kind === 'rename' && operation.oldUri && operation.newUri) {
                edits.push({
                    fileOperation: 'rename',
                    oldResource: monaco.Uri.parse(operation.oldUri),
                    newResource: monaco.Uri.parse(operation.newUri),
                    options: {
                        overwrite: operation.options?.overwrite === true,
                        ignoreIfExists: operation.options?.ignoreIfExists === true
                    }
                });
            } else if (operation.kind === 'delete' && operation.uri) {
                edits.push({
                    fileOperation: 'delete',
                    resource: monaco.Uri.parse(operation.uri),
                    options: {
                        recursive: operation.options?.recursive === true,
                        ignoreIfNotExists: operation.options?.ignoreIfNotExists === true
                    }
                });
            }
        } catch (_) {
        }
    };
    const append = (uri: string, edit: { range: LspRange; newText: string }, versionId?: number) => {
        if (!uri || !edit || !edit.range) {
            return;
        }
        const range = toMonacoRange(edit.range, monaco);
        if (!range) {
            return;
        }
        try {
            edits.push({
                resource: monaco.Uri.parse(uri),
                textEdit: {
                    range,
                    text: typeof edit.newText === 'string' ? edit.newText : ''
                },
                versionId: Number.isInteger(versionId) ? versionId : undefined
            });
        } catch (_) {
        }
    };

    if (workspaceEdit.changes && typeof workspaceEdit.changes === 'object') {
        for (const [uri, documentEdits] of Object.entries(workspaceEdit.changes)) {
            if (!Array.isArray(documentEdits)) {
                continue;
            }
            for (const edit of documentEdits) {
                append(uri, edit);
            }
        }
    }

    if (Array.isArray(workspaceEdit.documentChanges)) {
        for (const documentChange of workspaceEdit.documentChanges) {
            if (documentChange?.kind === 'create' || documentChange?.kind === 'rename' || documentChange?.kind === 'delete') {
                appendFileOperation(documentChange);
                continue;
            }
            const uri = documentChange?.textDocument?.uri;
            if (!uri || !Array.isArray(documentChange.edits) || !documentChange.textDocument) {
                continue;
            }
            for (const edit of documentChange.edits) {
                append(uri, edit, documentChange.textDocument.version);
            }
        }
    }

    return edits.length ? { edits } : undefined;
}

function applySemanticTokenEdits(previousData: Uint32Array | number[] | undefined, edits: Array<{ start: number; deleteCount: number; data: number[] }> | undefined): Uint32Array {
    const result = Array.from(previousData || []);
    if (!Array.isArray(edits)) {
        return new Uint32Array(result);
    }
    const normalized = edits
        .map((edit) => ({
            start: Math.max(0, Number(edit?.start) || 0),
            deleteCount: Math.max(0, Number(edit?.deleteCount) || 0),
            data: Array.isArray(edit?.data) ? edit.data : []
        }))
        .sort((a, b) => b.start - a.start);
    for (const edit of normalized) {
        result.splice(edit.start, edit.deleteCount, ...edit.data);
    }
    return new Uint32Array(result);
}

const OicppLspUtils = {
    toMonacoRange,
    toMonacoLocation,
    toMonacoWorkspaceEdit,
    applySemanticTokenEdits
};

interface Window {
    OicppLspUtils: typeof OicppLspUtils;
}

if (typeof window !== 'undefined') {
    window.OicppLspUtils = OicppLspUtils;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = OicppLspUtils;
}