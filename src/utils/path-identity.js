'use strict';

// Path identity / containment / portability.
//
// Three questions that used to be answered by one hand-rolled `norm()`
// helper, and must not share an implementation:
//
//   1. identity      "are these two strings the same file?"   -> samePath()
//   2. containment   "may I touch this path?"                  -> isInside()
//   3. portability   "how do I spell this for a remote?"       -> toPosixRel()
//
// The only trustworthy source of truth is the filesystem itself.
// path.resolve() normalises separators, "..", trailing slashes and
// redundant "///" -- but it knows nothing about symlinks, about whether
// the volume is case sensitive, about UNC, about 8.3 short names, or
// about the trailing dots/spaces win32 silently strips. So the canonical
// form is obtained by asking the OS (realpath), never by string rules.
//
// A hand-rolled normaliser is what produced the two bugs this module
// replaces:
//   - src/main.js isPathInsideDir() lower-cased unconditionally, so on
//     case-sensitive volumes "/root/Project" was judged to be inside
//     "/root/project" -- an over-permissive security boundary.
//   - src/renderer/js/sidebar/cloudSync.js getRelativeLocalPath()
//     never lower-cased, so on win32 a walk result differing from the
//     user-typed root only in case failed startsWith() and the file was
//     silently dropped from the upload.
//
// Note the asymmetry, and why it is resolved the way it is:
//   - string folding: cheap, but wrong on some volume (over-permissive)
//   - no folding at all: correct on posix, and on win32 both sides of a
//     containment check come back from realpath in the volume's own case,
//     so folding is unnecessary there either.
// Containment therefore folds nothing and fails closed. Folding is only
// allowed for identity keys, on win32, where a missing fold duplicates
// tabs/compilations while a spurious fold needs a deliberately
// case-sensitive NTFS directory to misbehave.

const fs = require('fs');
const path = require('path');

const realpathNative = typeof fs.realpathSync.native === 'function'
    ? fs.realpathSync.native
    : fs.realpathSync;

// Errors that mean "this component is not on disk yet", which is expected
// for paths we are about to create and must be tolerated while walking up
// to the deepest existing ancestor. Everything else (EACCES, ELOOP,
// ENAMETOOLONG, ...) is a real failure and must not be swallowed.
const MISSING = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

function realpath(p) {
    const fn = realpathNative;
    try {
        return fn(p);
    } catch (err) {
        if (err && err.code === 'EINVAL') return fs.realpathSync(p);
        throw err;
    }
}

// Canonical absolute path, symlinks resolved.
//
// The target usually does not exist yet (a temp file that was already
// cleaned up, a file about to be created), so on ENOENT we resolve the
// deepest ancestor that does exist and re-attach the remaining segments
// literally. That keeps the result absolute and normalised, and keeps a
// traversal-free prefix relationship for the segments we could not ask
// the filesystem about.
function canon(target) {
    if (typeof target !== 'string' || !target) {
        throw new TypeError('path must be a non-empty string');
    }
    const absolute = path.resolve(target);
    try {
        return realpath(absolute);
    } catch (err) {
        if (!err || !MISSING.has(err.code)) throw err;
    }
    const tail = [];
    let current = absolute;
    for (;;) {
        const parent = path.dirname(current);
        if (parent === current) return absolute; // reached the root, still missing
        tail.unshift(path.basename(current));
        current = parent;
        try {
            return path.join(realpath(current), ...tail);
        } catch (err) {
            if (!err || !MISSING.has(err.code)) throw err;
        }
    }
}

// Same file? Folds case on win32 only, where the volume is normally
// case-insensitive and the cost of a false negative (two tabs for one
// file) is much higher than the cost of a false positive.
function samePath(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    let ca, cb;
    try {
        ca = canon(a);
        cb = canon(b);
    } catch (_) {
        return false;
    }
    return process.platform === 'win32'
        ? ca.toLowerCase() === cb.toLowerCase()
        : ca === cb;
}

// May `target` be touched, given that it must live inside `root`?
//
// Both sides go through canon(), which resolves symlinks -- that is the
// only thing that stops `codeTemp/link -> /etc` from passing a prefix
// check. No case folding is needed (canon returns the volume's own case)
// and none is done, so a case-differing path is reported as "outside":
// on a case-sensitive volume that is the truth, and on a case-insensitive
// one the only inputs affected are paths that do not exist yet, where
// denying is the safe direction.
//
// path.relative() rather than string prefix, so the separator and the
// boundary case (root vs rootEvil) come from the platform implementation.
function isInside(target, root) {
    if (typeof target !== 'string' || typeof root !== 'string' || !target || !root) return false;
    let t, r;
    try {
        t = canon(target);
        r = canon(root);
    } catch (_) {
        return false; // EACCES / ELOOP / ENAMETOOLONG / bad input: deny
    }
    if (t === r) return true;
    const rel = path.relative(r, t);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Relative POSIX path for a remote key (cloud sync, manifests, ...).
//
// Substitution happens on the canonical form of both sides, so the two
// are guaranteed to come from the same resolution pass. Case is never
// touched: folding here loses information and is what made win32 drop
// files whose walker path differed in case from the typed root.
// Returns '' when the file is not inside the root.
function toPosixRel(file, root) {
    if (typeof file !== 'string' || typeof root !== 'string' || !file || !root) return '';
    let rel;
    try {
        rel = path.relative(canon(root), canon(file));
    } catch (_) {
        return '';
    }
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
    return rel.split(path.sep).join('/');
}

module.exports = { canon, samePath, isInside, toPosixRel };