import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as pc from 'playcanvas';

// Exercise the production tool without creating a WebGL canvas.
const source = readFileSync(new URL('../src/tools/mesh-edit-tool.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const exports = {};
vm.runInNewContext(compiled, {
    exports,
    require: name => name === 'playcanvas' ? pc : {}
});
const { MeshEditTool } = exports;
const record = (positions, node = new pc.GraphNode()) => {
    const mesh = {
        getNormals: () => 0,
        setPositions: values => { mesh.positions = values; },
        update: () => {}
    };
    return { mesh, node, positions: new Float32Array(positions),
        edges: [{ a: 0, b: 1 }], triangles: [{ a: 0, b: 1, c: 2 }] };
};
for (const mode of ['vertex', 'edge', 'face']) {
    const a = record([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0]);
    const node = new pc.GraphNode();
    node.setPosition(2, 0, 0);
    const b = record([-2, 0, 0, 3, 0, 0, -2, 1, 0], node);
    const unrelated = record([0.00001, 0, 0, 5, 0, 0, 5, 1, 0]);
    const tool = Object.create(MeshEditTool.prototype);
    Object.assign(tool, {
        mode, records: [a, b, unrelated], selected: new Map([[a, new Set([0])]]),
        active: true, model: { refreshWorldBound: () => {} }, scene: {},
        pivot: new pc.Entity(), dragStartPosition: new pc.Vec3()
    });
    tool.startTransform();
    assert.equal(tool.dragTargets.length, 2, `${mode}: material seam included`);
    assert.ok(tool.dragTargets[0].indices.has(3), `${mode}: duplicate vertex included`);
    tool.pivot.setPosition(0, 0, 2);
    tool.moveTransform();
    assert.equal(a.mesh.positions[2], 2);
    assert.equal(a.mesh.positions[11], 2);
    assert.equal(b.mesh.positions[2], 2);
    assert.equal(unrelated.mesh.positions, undefined);
    // A second movement must use the original positions rather than accumulate.
    tool.pivot.setPosition(0, 0, 3);
    tool.moveTransform();
    assert.equal(a.mesh.positions[2], 3);
    assert.equal(b.mesh.positions[2], 3);
    for (const target of tool.dragTargets) {
        tool.applyTarget(target, target.before, target.beforeNormals);
    }
    assert.equal(a.mesh.positions[2], 0);
    assert.equal(b.mesh.positions[2], 0);
}
console.log('PASS: vertex/edge/face seams, transformed primitives, nearby exclusion, repeated movement and restoration');
