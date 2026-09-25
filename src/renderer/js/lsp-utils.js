(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.OicppLspUtils = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    function toMonacoRange(range, monaco) {
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

    function toMonacoLocation(location, monaco) {
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
            const result = {
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

    function toMonacoWorkspaceEdit(workspaceEdit, monaco) {
        if (!workspaceEdit || !monaco || !monaco.Uri) {
            return undefined;
        }
        const edits = [];
        const appendFileOperation = (operation) => {
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
        const append = (uri, edit, versionId) => {
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
                if (!uri || !Array.isArray(documentChange.edits)) {
                    continue;
                }
                for (const edit of documentChange.edits) {
                    append(uri, edit, documentChange.textDocument.version);
                }
            }
        }

        return edits.length ? { edits } : undefined;
    }

    function applySemanticTokenEdits(previousData, edits) {
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

    return {
        toMonacoRange,
        toMonacoLocation,
        toMonacoWorkspaceEdit,
        applySemanticTokenEdits
    };
});
