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
