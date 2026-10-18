'use strict';

// Monaco 编辑回放工具，供「格式化产出 ISingleEditOperation」的回归测试把编辑真的
// 套回原文再比对结果。
//
// 为什么不在测试里直接断言 range 的数字：一条最小编辑的正确性在于「回放后正文等于
// 目标」，而区间数字写得「看着对」和写错只差一个换行符归谁 —— 增删整行时少带一个
// '\n'，界面表现为插入的行和下一行粘成一行、删完留个空行，可 startLineNumber /
// endLineNumber / text 三个数字单看全都合理。
//
// replayEdit 照 Monaco applyEdits 的做法替换：先用 validateRange 把坐标夹回合法
// 位置，再把 [起点, 终点) 换成文本。夹坐标会掩盖越界，所以越界另用
// editOutOfBounds 在夹之前查。

const clampPosition = (lines, lineNumber, column) => {
    const line = Math.max(1, Math.min(Number(lineNumber), lines.length));
    const lineMax = (lines[line - 1] || '').length + 1;
    return { line, column: Math.max(1, Math.min(Number(column), lineMax)) };
};

const positionOffset = (lines, pos) => {
    let off = 0;
    for (let i = 0; i < pos.line - 1; i++) off += lines[i].length + 1;
    return off + pos.column - 1;
};

// 返回 { doc, covered }：doc 是回放后的正文，covered 是这条区间在原文里吃掉的字符
function replayEdit(source, edit) {
    const lines = String(source).split('\n');
    const start = positionOffset(lines,
        clampPosition(lines, edit.range.startLineNumber, edit.range.startColumn));
    const end = positionOffset(lines,
        clampPosition(lines, edit.range.endLineNumber, edit.range.endColumn));
    return {
        doc: source.slice(0, start) + edit.text + source.slice(end),
        covered: source.slice(start, end)
    };
}

// 越界检查走「夹之前」的原始坐标：行号超出行数、列超出该行最大列、区间反向，
// 都算这条编辑本身算错了。没问题时返回 ''。
function editOutOfBounds(source, edit) {
    const lines = String(source).split('\n');
    const bad = [];
    for (const [tag, ln, col] of [
        ['起点', edit.range.startLineNumber, edit.range.startColumn],
        ['终点', edit.range.endLineNumber, edit.range.endColumn]
    ]) {
        if (!(ln >= 1 && ln <= lines.length)) {
            bad.push(`${tag}行 ${ln} 越界（文档只有 ${lines.length} 行）`);
        } else if (!(col >= 1 && col <= (lines[ln - 1] || '').length + 1)) {
            bad.push(`${tag}列 ${col} 越界（第 ${ln} 行最大列 ${(lines[ln - 1] || '').length + 1}）`);
        }
    }
    if (bad.length === 0) {
        const s = positionOffset(lines,
            { line: edit.range.startLineNumber, column: edit.range.startColumn });
        const e = positionOffset(lines,
            { line: edit.range.endLineNumber, column: edit.range.endColumn });
        if (s > e) bad.push(`区间反向 ${s}>${e}`);
    }
    return bad.join('，');
}

module.exports = { clampPosition, editOutOfBounds, positionOffset, replayEdit };
