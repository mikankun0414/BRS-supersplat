import assert from 'node:assert/strict';
import * as transform from '@playcanvas/splat-transform';
import * as viewerSettings from '@playcanvas/splat-transform/viewer-settings';
import * as pc from 'playcanvas';
import { readFileSync } from 'node:fs';
import { loader, sink, source } from './test-large-save-helpers.mjs';

let failure = '', captures = [], unwound = 0;
let importedSog = false;
const text = bytes => new TextDecoder().decode(bytes);
const encoder = new TextEncoder();
const lib = {
    ...transform,
    logger: { setRenderer() {}, unwindAll() { unwound++; } },
    async readFile({ filename, inputFormat, fileSystem }) {
        assert.equal(filename, 'meta.json');
        assert.equal(inputFormat, 'sog');
        const entry = await fileSystem.createSource(filename);
        assert.equal(JSON.parse(text(await entry.read().readAll())).version, 2);
        importedSog = true;
        return [{ meta: { numLods: 1, numGaussians: 3, transform: transform.Transform.PLY, availableLayers: new Set(['position', 'geometric', 'color']) }, close: async () => {} }];
    },
    async writeSource({ filename, outputFormat, source: input, pool, options }, fs) {
        const layers = {};
        for (const layer of ['position', 'geometric', 'color']) layers[layer] = pool.acquire(layer, input.meta.layouts[layer], input.meta.numGaussians);
        await input.read({ chunkIndex: 0, ...layers });
        const capture = Object.fromEntries(Object.entries(layers).map(([name, layer]) => [name, Array.from(new Float32Array(layer.data, 0, layer.stride * layer.count / 4))]));
        captures.push({ outputFormat, filename, options, capture });
        Object.values(layers).forEach(layer => layer.release());
        if (failure === 'encode') throw new Error('encode failed');
        const write = async (name, value) => { const writer = await fs.createWriter(name); await writer.write(encoder.encode(value)); await writer.close(); };
        if (outputFormat === 'sog') {
            await write('/absolute/output/means_l.webp', 'synthetic encoded texture');
            if (failure === 'texture') throw new Error('texture failed');
            await write(filename, JSON.stringify({ version: 2, means: { files: ['means_l.webp'] } }));
        } else if (outputFormat === 'html') {
            await write('index.sog', 'synthetic nested SOG');
            await write('index.css', 'css');
            await write('index.js', 'js');
            await write('settings.json', JSON.stringify(options.viewerSettingsJson));
            await write('index.html', '<html>same public library viewer</html>');
        } else await write(filename, 'synthetic format bytes');
    }
};
const load = loader({
    '@playcanvas/splat-transform': lib,
    '@playcanvas/splat-transform/viewer-settings': viewerSettings,
    '../package.json': JSON.parse(readFileSync('package.json')),
    './gaussian-instances': {},
    './io': { PermutedChunkSource: class {} }
});
const { writeSplatFile, serializeSog, serializeViewer } = load('src/splat-serialize.ts');
const { ZipReadFileSystem } = load('src/io/read/zip-file-system.ts');
const { createGradeTerms } = load('src/color-grade.ts');
const layouts = {
    position: { stride: 12, fields: {} }, geometric: { stride: 32, fields: {} }, color: { stride: 48, fields: {} }
};
const input = {
    meta: { numGaussians: 2, numLods: 1, chunkSize: 2, numChunks: [1], shBands: 1, layouts },
    async read(request) {
        const pos = new Float32Array(request.position.data), geo = new Float32Array(request.geometric.data), color = new Float32Array(request.color.data);
        for (let i = 0; i < request.count; i++) {
            const row = request.indices[request.indexOffset + i];
            pos.set([1 + row, 2 + row, 3 + row], i * 3);
            geo.set([1, 0, 0, 0, Math.log(2), Math.log(3), Math.log(4), 0.5], i * 8);
            color.set(Array.from({ length: 12 }, (_, c) => c * 0.125 + row), i * 12);
        }
    }
};
const splat = {
    instances: { count: 3, sourceRow: new Uint32Array([1, 0, 1]), flags: new Uint8Array([0, 1, 0]), transformIndex: i => i % 2, colorIndex: i => i % 2 },
    resource: { source: input, shBands: 1 },
    entity: { getWorldTransform: () => new pc.Mat4().setTranslate(10, 20, 30) },
    transformPalette: { getTransform: (index, mat) => mat.setTRS(new pc.Vec3(4, 5, 6), new pc.Quat().setFromEulerAngles(10, 20, 30), new pc.Vec3(2, 3, 4)) },
    colorPalette: { getEntry(index, terms) {
        Object.assign(terms, createGradeTerms());
        if (index) { terms.m[0] = 1.5; terms.offset.g = 0.25; terms.transparency = 0.5; }
    } }
};
const output = () => { const writer = sink(); return { writer, fs: { createWriter: () => writer } }; };
const baseline = output();
await writeSplatFile([splat], { maxSHBands: 1 }, 'ply', 'test.ply', {}, baseline.fs);
const sog = output();
await serializeSog([splat], { maxSHBands: 1, iterations: 7 }, sog.fs);
assert.equal(captures[1].outputFormat, 'sog', 'public unbundled writer bypasses library ZIP32');
assert.equal(captures[1].options.iterations, 7);
assert.deepEqual(captures[1].capture, captures[0].capture, 'identical transformed position/geometry/DC/SH source');
assert.equal(captures[1].capture.position.length, 9, 'duplicate instances preserved');
assert.equal(captures[1].capture.color.length, 36, 'all SH retained');
const sogFs = new ZipReadFileSystem(source(sog.writer.data()));
assert.deepEqual(Array.from(await sogFs.list()).sort(), ['means_l.webp', 'meta.json']);
assert.equal(text(await (await sogFs.createSource('means_l.webp')).read().readAll()), 'synthetic encoded texture');
assert.equal(JSON.parse(text(await (await sogFs.createSource('meta.json')).read().readAll())).version, 2);
const { loadSplatSource } = load('src/io/read/loader.ts');
const loadedSog = await loadSplatSource('output.sog', { createSource: async () => source(sog.writer.data()) });
assert.ok(importedSog, 'SOG reopens through local archive adapter and public unbundled reader');
assert.equal(loadedSog.reorder, false);
await loadedSog.source.close();

const viewer = output();
await serializeViewer([splat], { maxSHBands: 1 }, { type: 'zip', experienceSettings: { camera: { fov: 61 } } }, viewer.fs);
assert.deepEqual(captures[2].capture, captures[0].capture);
const viewerFs = new ZipReadFileSystem(source(viewer.writer.data()));
assert.deepEqual(Array.from(await viewerFs.list()).sort(), ['index.css', 'index.html', 'index.js', 'index.sog', 'settings.json']);
assert.equal(JSON.parse(text(await (await viewerFs.createSource('settings.json')).read().readAll())).camera.fov, 61);
for (const phase of ['encode', 'texture']) {
    failure = phase;
    const failed = output();
    await assert.rejects(() => serializeSog([splat], { iterations: 10 }, failed.fs), /failed/);
    assert.equal(failed.writer.closed, false);
    assert.equal(failed.writer.aborted, true);
}
failure = 'encode';
const failedViewer = output();
await assert.rejects(() => serializeViewer([splat], {}, { type: 'zip', experienceSettings: {} }, failedViewer.fs), /failed/);
assert.equal(failedViewer.writer.bytesWritten, 0, 'outer output unopened when encoding fails');
assert.ok(unwound >= 3);
console.log('PASS export routing: same transformed/SH/graded source, public unbundled SOG to ZIP64, staged viewer package, failure abort (codec/GPU mocked; no visual acceptance)');
