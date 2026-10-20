import assert from 'node:assert/strict';
import * as pc from 'playcanvas';
import { loader, sink } from './test-large-save-helpers.mjs';

const load = loader();
const { encodeInstances, writeInstances, decodeInstances, restorePalettes } = load('src/doc-instances.ts');
const { createGradeTerms, gradeRows } = load('src/color-grade.ts');

export function fixture(count, numTransforms = 3, numColors = 4) {
    const sourceRow = Uint32Array.from({ length: count }, (_, i) => (i * 17) % Math.max(1, count));
    const palette = Uint32Array.from({ length: count }, (_, i) => ((i % numColors) << 16) | (i % numTransforms));
    const flags = Uint8Array.from({ length: count }, (_, i) => i & 7);
    const transforms = Array.from({ length: numTransforms }, (_, i) => new pc.Mat4().setTRS(
        new pc.Vec3(i, -2 * i, 0.25 * i), new pc.Quat().setFromEulerAngles(i, 3 * i, 19 * i), new pc.Vec3(1 + i, 2 + i, 3 + i)
    ));
    const grades = Array.from({ length: numColors }, (_, i) => {
        const terms = createGradeTerms();
        terms.m[0] = 1 + i * 0.25; terms.m[4] = 0.8 + i * 0.1;
        terms.offset.r = i * 0.03; terms.offset.g = -i * 0.01;
        terms.transparency = 1 / (1 + i);
        return terms;
    });
    return {
        instances: { count, sourceRow, palette, flags },
        transformPalette: { size: numTransforms, getTransform: (i, mat) => mat.copy(transforms[i]) },
        colorPalette: { size: numColors, getEntry: (i, terms) => { Object.assign(terms, grades[i]); } },
        transforms, grades
    };
}

for (const count of [0, 1, 2, 3, 4, 16383, 16384, 16385, 65537, 150001]) {
    const splat = fixture(count, count === 150001 ? 1027 : 3, count === 150001 ? 1031 : 4);
    const map = Uint32Array.from({ length: count }, (_, i) => count - 1 - i);
    const before = splat.instances.sourceRow.slice();
    const expected = new Uint8Array(encodeInstances(splat, map));
    const out = sink();
    await writeInstances(splat, map, out);
    assert.deepEqual(out.data(), Buffer.from(expected), `identical v1 bytes count=${count}`);
    assert.ok(Math.max(...out.chunks.map(chunk => chunk.length)) <= 65536);
    assert.deepEqual(splat.instances.sourceRow, before, 'live rows unchanged');
    const decoded = decodeInstances(out.data());
    assert.deepEqual(decoded.sourceRow, Uint32Array.from(before, i => map[i]));
    assert.deepEqual(decoded.palette, splat.instances.palette);
    assert.deepEqual(decoded.flags, splat.instances.flags);
    const gotTransforms = [], gotGrades = [];
    restorePalettes(decoded, { alloc() {}, setTransform: (i, mat) => { gotTransforms[i] = mat.data.slice(); } }, {
        alloc() {}, setEntry: (i, terms) => { const rows = new Float32Array(13); gradeRows(terms, rows); rows[12] = terms.transparency; gotGrades[i] = rows; }
    });
    assert.deepEqual(gotTransforms[2], splat.transforms[2].data);
    assert.deepEqual(gotGrades[3], decoded.colorEntries.slice(3 * 13, 4 * 13));
    const identity = sink();
    await writeInstances(splat, null, identity);
    assert.deepEqual(decodeInstances(identity.data()).sourceRow, before, 'compact=false identity');
}
for (const bytes of [new Uint8Array(1), new Uint8Array(20), new Uint8Array(23)]) {
    assert.throws(() => decodeInstances(bytes));
}
const out = sink();
let release;
let writes = 0;
out.write = async bytes => {
    writes++;
    if (writes === 2) await new Promise(resolve => { release = resolve; });
    out.chunks.push(bytes.slice());
};
const splat = fixture(18000);
let done = false;
const pending = writeInstances(splat, null, out).then(() => { done = true; });
while (!release) await Promise.resolve();
assert.equal(done, false);
assert.equal(writes, 2);
release(); await pending;
assert.deepEqual(decodeInstances(out.data()).sourceRow, splat.instances.sourceRow);
let attempted = 0;
await assert.rejects(() => writeInstances(splat, null, { write: () => { if (++attempted === 3) throw new Error('cancel'); } }), /cancel/);
assert.equal(attempted, 3);
console.log('PASS instances: byte-identical layout, block/padding/palette boundaries, restore, identity rows, backpressure and failure');
