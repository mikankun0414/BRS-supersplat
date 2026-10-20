import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as pc from 'playcanvas';
import * as transform from '@playcanvas/splat-transform';

// Execute actual source without adding a build config/dependency or touching dist.
export function loader(overrides = {}, globals = {}) {
    const cache = new Map();
    function load(path) {
        path = resolve(path);
        if (cache.has(path)) return cache.get(path);
        const exports = {};
        cache.set(path, exports);
        const compiled = ts.transpileModule(readFileSync(path, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText;
        vm.runInNewContext(compiled, {
            exports, console, Uint8Array, Uint32Array, Float32Array, ArrayBuffer, DataView,
            TextEncoder, TextDecoder, Blob, ReadableStream, DecompressionStream,
            setTimeout, crypto: globalThis.crypto, ...globals,
            require: name => overrides[name] ?? (name.endsWith('/ui/localization') ? { i18n: { t: key => key, onChange: fn => { fn(); return () => {}; } } } : name === 'playcanvas' ? pc : name === '@playcanvas/splat-transform' ? transform : load(resolve(dirname(path), `${name}.ts`)))
        }, { filename: path });
        return exports;
    }
    return load;
}

export function sink() {
    const chunks = [];
    let closed = false;
    let aborted = false;
    return {
        chunks,
        get bytesWritten() { return chunks.reduce((sum, bytes) => sum + bytes.length, 0); },
        get closed() { return closed; },
        get aborted() { return aborted; },
        async write(bytes) { await Promise.resolve(); chunks.push(bytes.slice()); },
        async close() { closed = true; },
        async abort() { aborted = true; },
        data() { return Buffer.concat(chunks); }
    };
}

export function source(bytes, track = {}) {
    return {
        size: bytes.length,
        seekable: true,
        read(start = 0, end = bytes.length) {
            track.max = Math.max(track.max ?? 0, end - start);
            let at = start;
            return new class extends transform.ReadStream {
                constructor() { super(end - start); }
                async pull(target) {
                    const n = Math.min(target.length, end - at, 701); // exercise short reads
                    target.set(bytes.subarray(at, at + n));
                    at += n;
                    this.bytesRead += n;
                    return n;
                }
            }();
        },
        close() {}
    };
}
