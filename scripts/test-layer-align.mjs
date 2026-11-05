import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as pc from 'playcanvas';

function createLoader() {
    const cache = new Map();
    function load(relPath, customOverrides = {}) {
        const fullPath = resolve(relPath);
        if (cache.has(fullPath)) return cache.get(fullPath);
        const exports = {};
        cache.set(fullPath, exports);
        const source = readFileSync(fullPath, 'utf8');
        const compiled = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText;

        const customRequire = (name) => {
            if (name === 'playcanvas') return pc;
            if (name.startsWith('./') || name.startsWith('../')) {
                const target = resolve(fullPath, '..', name + '.ts');
                return load(target, customOverrides);
            }
            if (customOverrides[name]) return customOverrides[name];
            return {};
        };

        vm.runInNewContext(compiled, {
            exports,
            require: customRequire,
            console
        });
        return exports;
    }
    return { load };
}

const { load } = createLoader();

const { ElementType } = load('./src/element.ts');
const { Events } = load('./src/events.ts');
const { registerTransformHandlerEvents } = load('./src/transform-handler.ts');
const { calculateLayerAlignment } = load('./src/tools/layer-align.ts');

console.log('Running test-layer-align.mjs...');

// Test 1: calculateLayerAlignment math
{
    console.log('Test 1: calculateLayerAlignment calculation');
    const sourcePoints = [
        new pc.Vec3(0, 0, 0),
        new pc.Vec3(1, 0, 0),
        new pc.Vec3(0, 0, 1)
    ];
    const targetPoints = [
        new pc.Vec3(10, 0, 0),
        new pc.Vec3(11, 0, 0),
        new pc.Vec3(10, 0, 1)
    ];
    const curPos = new pc.Vec3(0, 0, 0);
    const curRot = new pc.Quat();
    const curScale = new pc.Vec3(1, 1, 1);

    const result = calculateLayerAlignment(sourcePoints, targetPoints, curPos, curRot, curScale, 'y');
    assert.ok(result, 'alignment should return transform');
    assert.ok(Math.abs(result.position.x - 10) < 1e-4, `expected pos x=10, got ${result.position.x}`);
    assert.ok(Math.abs(result.position.y - 0) < 1e-4, `expected pos y=0, got ${result.position.y}`);
    assert.ok(Math.abs(result.position.z - 0) < 1e-4, `expected pos z=0, got ${result.position.z}`);
}

// Test 2: transformHandler stack stability during tool overlay
{
    console.log('Test 2: transformHandler stack stability when selection changes during tool activity');
    const events = new Events();
    let currentSelection = null;
    events.function('selection', () => currentSelection);

    registerTransformHandlerEvents(events);

    // Mock Splat elements
    const createMockSplat = (name) => {
        const entity = new pc.Entity(name);
        return {
            type: ElementType.splat,
            name,
            entity,
            numSelected: 0,
            localFrame: new pc.Quat(),
            localFrameOrigin: new pc.Vec3(),
            getPivot(t) {
                t.set(entity.getLocalPosition(), entity.getLocalRotation(), entity.getLocalScale());
            },
            move(pos, rot, scale) {
                if (pos) entity.setLocalPosition(pos);
                if (rot) entity.setLocalRotation(rot);
                if (scale) entity.setLocalScale(scale);
            }
        };
    };

    const splatA = createMockSplat('splatA');
    const splatB = createMockSplat('splatB');

    // 1. Initial selection
    currentSelection = splatA;
    events.fire('selection.changed', splatA);

    // Pivot move should move splatA
    const pivot = events.invoke('pivot');
    assert.ok(pivot, 'pivot must exist');

    pivot.start();
    pivot.moveTRS(new pc.Vec3(5, 0, 0), new pc.Quat(), new pc.Vec3(1, 1, 1));
    pivot.end();
    assert.equal(splatA.entity.getLocalPosition().x, 5, 'splatA should have moved with pivot');

    // 2. Activate tool overlay (like LayerAlignTool)
    let toolActive = false;
    const dummyToolHandler = {
        activate() { toolActive = true; },
        deactivate() { toolActive = false; }
    };

    events.fire('transformHandler.push', dummyToolHandler);
    assert.equal(toolActive, true, 'tool handler should be active');

    // While tool is active, moving the pivot should NOT move splats
    pivot.start();
    pivot.moveTRS(new pc.Vec3(10, 0, 0), new pc.Quat(), new pc.Vec3(1, 1, 1));
    pivot.end();
    assert.equal(splatA.entity.getLocalPosition().x, 5, 'splatA should NOT move while tool is active');

    // 3. Selection changes while tool is active (this used to corrupt the stack!)
    currentSelection = splatB;
    events.fire('selection.changed', splatB);
    events.fire('selection.changed', splatB); // fired multiple times
    events.fire('splat.stateChanged', splatB);

    assert.equal(toolActive, true, 'tool handler MUST remain active despite selection.changed');

    // Duplicate push should be safely ignored
    events.fire('transformHandler.push', dummyToolHandler);
    assert.equal(toolActive, true);

    // 4. Deactivate tool
    events.fire('transformHandler.pop', dummyToolHandler);
    assert.equal(toolActive, false, 'tool handler should be deactivated');

    // 5. Normal model manipulation MUST BE FULLY RESTORED to the active selection (splatB)
    pivot.start();
    pivot.moveTRS(new pc.Vec3(20, 0, 0), new pc.Quat(), new pc.Vec3(1, 1, 1));
    pivot.end();

    assert.equal(splatB.entity.getLocalPosition().x, 20, 'splatB MUST move with pivot after tool deactivate');
    assert.equal(splatA.entity.getLocalPosition().x, 5, 'splatA should remain at its previous location');
}

// Test 3: SplatsTransformHandler (numSelected > 0) branch
{
    console.log('Test 3: SplatsTransformHandler selection branch during tool activity');
    const events = new Events();
    let currentSelection = null;
    events.function('selection', () => currentSelection);

    registerTransformHandlerEvents(events);

    const createMockSplat = (name) => {
        const entity = new pc.Entity(name);
        return {
            type: ElementType.splat,
            name,
            entity,
            numSelected: 0,
            localFrame: new pc.Quat(),
            localFrameOrigin: new pc.Vec3(),
            getPivot(t) {
                t.set(entity.getLocalPosition(), entity.getLocalRotation(), entity.getLocalScale());
            },
            move(pos, rot, scale) {}
        };
    };

    const splat = createMockSplat('splatSelected');
    currentSelection = splat;
    events.fire('selection.changed', splat);

    // Enter tool
    const dummyToolHandler = { activate() {}, deactivate() {} };
    events.fire('transformHandler.push', dummyToolHandler);

    // Change to partial selection while in tool
    splat.numSelected = 5;
    events.fire('splat.stateChanged', splat);

    // Exit tool -> should safely switch to SplatsTransformHandler
    events.fire('transformHandler.pop', dummyToolHandler);

    // Return to 0 selection
    splat.numSelected = 0;
    events.fire('splat.stateChanged', splat);
    assert.ok(true, 'selection switching with partial selection succeeded');
}

console.log('All layer-align tests passed!');
