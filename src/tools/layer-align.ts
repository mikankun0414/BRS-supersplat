import { Button, Container, Label, SelectInput } from '@playcanvas/pcui';
import { Mat4, Quat, Vec3 } from 'playcanvas';

import { EntityTransformOp, MultiOp, PlacePivotOp } from '../edit-ops';
import { ElementType } from '../element';
import { Events } from '../events';
import { Pivot } from '../pivot';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { ToolOverlay, OverlayWriter } from '../tool-overlay';
import { Transform } from '../transform';
import { i18n } from '../ui/localization';

const worldToLocal = new Mat4();

const pickSplatSurfacePoint = async (
    scene: Scene,
    splat: Splat,
    offsetX: number,
    offsetY: number,
    result: Vec3
): Promise<boolean> => {
    const width = Math.max(1, scene.canvas.clientWidth);
    const height = Math.max(1, scene.canvas.clientHeight);
    const hits = await scene.camera.intersectMany([{ x: offsetX / width, y: offsetY / height }], [splat]);
    const hit = hits[0];
    if (!hit) {
        return false;
    }
    worldToLocal.invert(splat.worldTransform);
    worldToLocal.transformPoint(hit.position, result);
    return true;
};

type LayerAlignmentMode = 'y' | 'xyz';
type PointSet = 'base' | 'moving';

const CLICK_TOLERANCE = 4;
const POINT_COUNT = 3;
const DEGENERATE_EPSILON = 1e-6;

const buildFrame = (points: readonly Vec3[], result: Mat4) => {
    const edge01 = new Vec3().sub2(points[1], points[0]);
    const edge02 = new Vec3().sub2(points[2], points[0]);
    const edgeLength = edge01.length() * edge02.length();

    if (!(edgeLength > 0)) {
        return false;
    }

    const x = edge01.normalize();
    const z = new Vec3().cross(x, edge02);
    if (z.length() < DEGENERATE_EPSILON * edge02.length()) {
        return false;
    }
    z.normalize();

    // Keep a right-handed frame. The frame columns are x, y, z.
    const y = new Vec3().cross(z, x).normalize();
    result.set([
        x.x, x.y, x.z, 0,
        y.x, y.y, y.z, 0,
        z.x, z.y, z.z, 0,
        0, 0, 0, 1
    ]);

    return true;
};

const centroid = (points: readonly Vec3[], result: Vec3) => {
    result.set(0, 0, 0);
    points.forEach(point => result.add(point));
    result.mulScalar(1 / points.length);
};

// Calculate the rigid rotation that maps the source correspondence frame to
// the target frame. Y-only mode is the least-squares yaw over all three
// correspondences, with the translation later matching the two centroids.
const calculateAlignmentRotation = (
    source: readonly Vec3[],
    target: readonly Vec3[],
    mode: LayerAlignmentMode,
    result: Quat
) => {
    if (source.length !== POINT_COUNT || target.length !== POINT_COUNT) {
        return false;
    }

    if (mode === 'y') {
        const sourceCenter = new Vec3();
        const targetCenter = new Vec3();
        centroid(source, sourceCenter);
        centroid(target, targetCenter);

        let dot = 0;
        let cross = 0;
        let sourceLength = 0;
        let targetLength = 0;
        for (let i = 0; i < POINT_COUNT; i++) {
            const sourceX = source[i].x - sourceCenter.x;
            const sourceZ = source[i].z - sourceCenter.z;
            const targetX = target[i].x - targetCenter.x;
            const targetZ = target[i].z - targetCenter.z;
            dot += sourceX * targetX + sourceZ * targetZ;
            sourceLength += sourceX * sourceX + sourceZ * sourceZ;
            targetLength += targetX * targetX + targetZ * targetZ;
            // This is the Y component of cross(source, target).
            cross += sourceZ * targetX - sourceX * targetZ;
        }

        const planarLength = Math.sqrt(sourceLength * targetLength);
        if (!(planarLength > 0) || Math.hypot(dot, cross) < DEGENERATE_EPSILON * planarLength) {
            return false;
        }

        result.setFromAxisAngle(Vec3.UP, Math.atan2(cross, dot) * 180 / Math.PI);
        return true;
    }

    const sourceFrame = new Mat4();
    const targetFrame = new Mat4();
    if (!buildFrame(source, sourceFrame) || !buildFrame(target, targetFrame)) {
        return false;
    }

    const sourceInverse = new Mat4().invert(sourceFrame);
    const delta = new Mat4().mul2(targetFrame, sourceInverse);
    result.setFromMat4(delta);
    return true;
};

// Exported separately so the alignment math can be checked without constructing
// the browser UI. The returned transform is in the same (content-root) space
// as the current entity transform used by EntityTransformOp.
const calculateLayerAlignment = (
    source: readonly Vec3[],
    target: readonly Vec3[],
    currentPosition: Vec3,
    currentRotation: Quat,
    currentScale: Vec3,
    mode: LayerAlignmentMode
) => {
    const rotationDelta = new Quat();
    if (!calculateAlignmentRotation(source, target, mode, rotationDelta)) {
        return null;
    }

    const sourceCenter = new Vec3();
    const targetCenter = new Vec3();
    centroid(source, sourceCenter);
    centroid(target, targetCenter);

    const position = new Vec3().sub2(currentPosition, sourceCenter);
    rotationDelta.transformVector(position, position).add(targetCenter);

    return new Transform(
        position,
        new Quat().mul2(rotationDelta, currentRotation),
        currentScale
    );
};

class LayerAlignTransformHandler {
    activate() {}
    deactivate() {}
}

class LayerAlignTool {
    activate: () => void;
    deactivate: () => void;
    getFocus: () => { position: Vec3, radius: number } | null;

    constructor(events: Events, scene: Scene, parent: HTMLElement, canvasContainer: Container) {
        const hintLabel = new Label({ class: 'select-toolbar-label' });
        const baseLabel = new Label({ class: 'select-toolbar-label' });
        const movingLabel = new Label({ class: 'select-toolbar-label' });
        const rotationLabel = new Label({ class: 'select-toolbar-label' });
        i18n.bindText(baseLabel, 'layer-align.base-layer');
        i18n.bindText(movingLabel, 'layer-align.moving-layer');
        i18n.bindText(rotationLabel, 'layer-align.rotation');

        const baseLayer = new SelectInput({
            class: 'layer-align-select',
            type: 'number'
        });
        const movingLayer = new SelectInput({
            class: 'layer-align-select',
            type: 'number'
        });
        const modeSelect = new SelectInput({
            class: 'layer-align-mode',
            defaultValue: 'y'
        });
        i18n.bindOptions(modeSelect, () => [
            { v: 'y', t: i18n.t('layer-align.rotation-y') },
            { v: 'xyz', t: i18n.t('layer-align.rotation-xyz') }
        ]);

        const basePick = new Button({ class: ['select-toolbar-button', 'layer-align-pick'] });
        const movingPick = new Button({ class: ['select-toolbar-button', 'layer-align-pick'] });
        const applyButton = new Button({ class: 'select-toolbar-button', enabled: false });
        const clearButton = new Button({ class: 'select-toolbar-button', enabled: false });
        i18n.bindText(applyButton, 'layer-align.apply');
        i18n.bindText(clearButton, 'layer-align.clear');

        const selectToolbar = new Container({
            class: ['select-toolbar', 'select-toolbar-tool', 'layer-align-toolbar'],
            hidden: true
        });
        selectToolbar.dom.addEventListener('pointerdown', e => e.stopPropagation());

        const layerRow = new Container({ class: 'layer-align-row' });
        layerRow.append(baseLabel);
        layerRow.append(baseLayer);
        layerRow.append(basePick);
        layerRow.append(movingLabel);
        layerRow.append(movingLayer);
        layerRow.append(movingPick);

        const optionsRow = new Container({ class: 'layer-align-row' });
        optionsRow.append(rotationLabel);
        optionsRow.append(modeSelect);
        optionsRow.append(applyButton);
        optionsRow.append(clearButton);

        selectToolbar.append(hintLabel);
        selectToolbar.append(layerRow);
        selectToolbar.append(optionsRow);
        canvasContainer.append(selectToolbar);

        const overlay = new ToolOverlay();
        const transformHandler = new LayerAlignTransformHandler();
        const overlayPoints = Array.from({ length: POINT_COUNT * 2 }, () => new Vec3());

        let active = false;
        let phase: PointSet = 'base';
        let basePoints: Vec3[] = [];
        let movingPoints: Vec3[] = [];
        let baseUid: number | null = null;
        let movingUid: number | null = null;
        let picking = false;
        let clicked = false;
        let clickX = 0;
        let clickY = 0;
        let suppressLayerChange = false;

        const getSplats = () => scene.getElementsByType(ElementType.splat) as Splat[];
        const getSplat = (select: SelectInput) => {
            const uid = Number(select.value);
            return Number.isFinite(uid) ? getSplats().find(splat => splat.uid === uid) ?? null : null;
        };

        const buildLayerOptions = () => getSplats().map((splat, index) => ({
            v: splat.uid,
            t: `${index + 1}: ${splat.name}`
        }));

        const resetPoints = () => {
            basePoints = [];
            movingPoints = [];
        };

        const getWorldPoint = (splat: Splat, point: Vec3, result: Vec3) => {
            splat.worldTransform.transformPoint(point, result);
            return result;
        };

        const getAlignmentPoints = () => {
            const base = getSplat(baseLayer);
            const moving = getSplat(movingLayer);
            if (!base || !moving || base === moving ||
                basePoints.length !== POINT_COUNT || movingPoints.length !== POINT_COUNT) {
                return null;
            }

            const source = movingPoints.map(point => getWorldPoint(moving, point, new Vec3()));
            const target = basePoints.map(point => getWorldPoint(base, point, new Vec3()));
            return { base, moving, source, target };
        };

        overlay.provider = (writer: OverlayWriter) => {
            if (!active) {
                return;
            }

            const base = getSplat(baseLayer);
            const moving = getSplat(movingLayer);
            const baseCount = Math.min(basePoints.length, POINT_COUNT);
            const movingCount = Math.min(movingPoints.length, POINT_COUNT);

            if (base) {
                for (let i = 0; i < baseCount; i++) {
                    getWorldPoint(base, basePoints[i], overlayPoints[i]);
                    writer.dot(overlayPoints[i]);
                }
                for (let i = 1; i < baseCount; i++) {
                    writer.segment(overlayPoints[i - 1], overlayPoints[i]);
                }
                if (baseCount === POINT_COUNT) {
                    writer.segment(overlayPoints[POINT_COUNT - 1], overlayPoints[0]);
                }
            }

            if (moving) {
                for (let i = 0; i < movingCount; i++) {
                    getWorldPoint(moving, movingPoints[i], overlayPoints[POINT_COUNT + i]);
                    writer.dot(overlayPoints[POINT_COUNT + i]);
                }
                for (let i = 1; i < movingCount; i++) {
                    writer.segment(overlayPoints[POINT_COUNT + i - 1], overlayPoints[POINT_COUNT + i]);
                }
                if (movingCount === POINT_COUNT) {
                    writer.segment(overlayPoints[POINT_COUNT * 2 - 1], overlayPoints[POINT_COUNT]);
                }
            }

            // Correspondence lines make it obvious which click order is paired.
            for (let i = 0; i < Math.min(baseCount, movingCount); i++) {
                writer.segment(overlayPoints[i], overlayPoints[POINT_COUNT + i]);
            }
        };

        const updateControls = () => {
            const splats = getSplats();
            const base = getSplat(baseLayer);
            const moving = getSplat(movingLayer);
            const points = phase === 'base' ? basePoints : movingPoints;
            const ready = base && moving && base !== moving &&
                basePoints.length === POINT_COUNT && movingPoints.length === POINT_COUNT;
            const alignmentPoints = ready ? getAlignmentPoints() : null;
            const alignment = alignmentPoints ? calculateLayerAlignment(
                alignmentPoints.source,
                alignmentPoints.target,
                moving.entity.getLocalPosition(),
                moving.entity.getLocalRotation(),
                moving.entity.getLocalScale(),
                modeSelect.value as LayerAlignmentMode
            ) : null;

            basePick.text = `${i18n.t('layer-align.pick-base')} (${basePoints.length}/${POINT_COUNT})`;
            movingPick.text = `${i18n.t('layer-align.pick-moving')} (${movingPoints.length}/${POINT_COUNT})`;
            basePick.class[phase === 'base' ? 'add' : 'remove']('active');
            movingPick.class[phase === 'moving' ? 'add' : 'remove']('active');
            basePick.enabled = !!base;
            movingPick.enabled = !!moving;
            applyButton.enabled = !!alignment;
            clearButton.enabled = basePoints.length > 0 || movingPoints.length > 0;

            if (splats.length < 2) {
                hintLabel.text = i18n.t('layer-align.need-two');
            } else if (!base || !moving || base === moving) {
                hintLabel.text = i18n.t('layer-align.choose-layers');
            } else if (points.length < POINT_COUNT) {
                hintLabel.text = i18n.t(phase === 'base' ? 'layer-align.place-base' : 'layer-align.place-moving');
            } else if (ready && !alignment) {
                hintLabel.text = i18n.t('layer-align.invalid');
            } else if (!ready) {
                hintLabel.text = i18n.t('layer-align.place-other');
            } else {
                hintLabel.text = i18n.t('layer-align.ready');
            }
        };

        const updateLayerOptions = () => {
            const splats = getSplats();
            const options = buildLayerOptions();
            const oldBaseUid = baseUid ?? Number(baseLayer.value);
            const oldMovingUid = movingUid ?? Number(movingLayer.value);

            suppressLayerChange = true;
            baseLayer.options = options;
            movingLayer.options = options;

            const has = (uid: number) => Number.isFinite(uid) && splats.some(splat => splat.uid === uid);
            const nextBaseUid = has(oldBaseUid) ? oldBaseUid : (splats[0]?.uid ?? null);
            const nextMovingUid = has(oldMovingUid) && oldMovingUid !== nextBaseUid ? oldMovingUid :
                (splats.find(splat => splat.uid !== nextBaseUid)?.uid ?? null);

            baseUid = nextBaseUid;
            movingUid = nextMovingUid;
            if (nextBaseUid !== null) {
                baseLayer.value = nextBaseUid;
            }
            if (nextMovingUid !== null) {
                movingLayer.value = nextMovingUid;
            }
            suppressLayerChange = false;
            updateControls();
        };

        const setPhase = (next: PointSet) => {
            phase = next;
            updateControls();
            scene.forceRender = true;
        };

        const onLayerChange = (which: PointSet, value: number) => {
            if (suppressLayerChange) {
                return;
            }

            const uid = Number(value);
            if (which === 'base') {
                baseUid = Number.isFinite(uid) ? uid : null;
                if (baseUid !== null && baseUid === movingUid) {
                    const alternative = getSplats().find(splat => splat.uid !== baseUid);
                    movingUid = alternative?.uid ?? null;
                    if (movingUid !== null) {
                        suppressLayerChange = true;
                        movingLayer.value = movingUid;
                        suppressLayerChange = false;
                    }
                }
            } else {
                movingUid = Number.isFinite(uid) ? uid : null;
                if (movingUid !== null && movingUid === baseUid) {
                    const alternative = getSplats().find(splat => splat.uid !== movingUid);
                    baseUid = alternative?.uid ?? null;
                    if (baseUid !== null) {
                        suppressLayerChange = true;
                        baseLayer.value = baseUid;
                        suppressLayerChange = false;
                    }
                }
            }

            resetPoints();
            phase = 'base';
            updateControls();
            scene.forceRender = true;
        };

        baseLayer.on('change', (value: number) => onLayerChange('base', value));
        movingLayer.on('change', (value: number) => onLayerChange('moving', value));
        basePick.on('click', () => setPhase('base'));
        movingPick.on('click', () => setPhase('moving'));

        const clear = () => {
            resetPoints();
            phase = 'base';
            updateControls();
            scene.forceRender = true;
        };
        clearButton.on('click', clear);

        const pivotTransformFor = (splat: Splat, transform: Transform) => {
            const pivot = new Transform();
            const matrix = new Mat4().setTRS(transform.position, transform.rotation, transform.scale);
            const position = matrix.transformPoint(splat.localFrameOrigin, new Vec3());
            const rotation = new Quat().mul2(transform.rotation, splat.localFrame);
            pivot.set(position, rotation, transform.scale);
            return pivot;
        };

        const align = () => {
            const base = getSplat(baseLayer);
            const moving = getSplat(movingLayer);
            if (!base || !moving || base === moving || basePoints.length !== POINT_COUNT || movingPoints.length !== POINT_COUNT) {
                return;
            }

            const alignmentPoints = getAlignmentPoints();
            if (!alignmentPoints) {
                return;
            }
            const { source, target } = alignmentPoints;

            const oldt = new Transform(
                moving.entity.getLocalPosition(),
                moving.entity.getLocalRotation(),
                moving.entity.getLocalScale()
            );
            const newt = calculateLayerAlignment(
                source,
                target,
                oldt.position,
                oldt.rotation,
                oldt.scale,
                modeSelect.value as LayerAlignmentMode
            );

            if (!newt || oldt.equalsApprox(newt)) {
                return;
            }

            const transformOp = new EntityTransformOp({ splat: moving, oldt, newt });
            const ops: (EntityTransformOp | PlacePivotOp)[] = [transformOp];

            // Keep the regular transform panel/gizmo in sync when the moving
            // layer is also the current selection. Other selected layers keep
            // their existing pivot unchanged.
            if (events.invoke('selection') === moving) {
                const pivot = events.invoke('pivot') as Pivot;
                ops.push(new PlacePivotOp({
                    pivot,
                    oldt: pivot.transform.clone(),
                    newt: pivotTransformFor(moving, newt)
                }));
            }

            events.fire('edit.add', ops.length === 1 ? ops[0] : new MultiOp(ops));
            scene.forceRender = true;
        };
        applyButton.on('click', align);
        modeSelect.on('change', () => {
            updateControls();
        });

        const isPrimary = (e: PointerEvent) => {
            return e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary;
        };
        const isToolbarEvent = (e: PointerEvent) => selectToolbar.dom.contains(e.target as Node);

        const pointerdown = (e: PointerEvent) => {
            if (!active || !isPrimary(e) || isToolbarEvent(e) || clicked) {
                return;
            }
            clicked = true;
            clickX = e.offsetX;
            clickY = e.offsetY;
        };

        const pointermove = (e: PointerEvent) => {
            if (clicked && Math.hypot(e.offsetX - clickX, e.offsetY - clickY) > CLICK_TOLERANCE) {
                clicked = false;
            }
        };

        const pointerup = async (e: PointerEvent) => {
            if (!active || !clicked || !isPrimary(e) || isToolbarEvent(e)) {
                return;
            }
            clicked = false;
            e.preventDefault();
            e.stopPropagation();

            const pickPhase = phase;
            const pickLayer = pickPhase === 'base' ? baseLayer : movingLayer;
            const splat = getSplat(pickLayer);
            const points = pickPhase === 'base' ? basePoints : movingPoints;
            if (!splat || points.length >= POINT_COUNT || picking) {
                return;
            }

            picking = true;
            const point = new Vec3();
            try {
                const picked = await pickSplatSurfacePoint(scene, splat, clickX, clickY, point);
                const pointSetStillCurrent = points === (pickPhase === 'base' ? basePoints : movingPoints);
                if (picked && active && phase === pickPhase && getSplat(pickLayer) === splat && pointSetStillCurrent) {
                    points.push(point.clone());
                    if (pickPhase === 'base' && basePoints.length === POINT_COUNT) {
                        phase = 'moving';
                    }
                    updateControls();
                    scene.forceRender = true;
                }
            } finally {
                picking = false;
            }
        };

        events.on('scene.elementAdded', (element) => {
            if (element.type === ElementType.splat) {
                updateLayerOptions();
            }
        });
        events.on('scene.elementRemoved', (element) => {
            if (element.type === ElementType.splat) {
                resetPoints();
                updateLayerOptions();
            }
        });
        events.on('splat.name', updateLayerOptions);
        const restoreTransformHandler = () => {
            if (active) {
                events.fire('transformHandler.push', transformHandler);
            }
        };
        events.on('selection.changed', restoreTransformHandler);
        events.on('splat.stateChanged', restoreTransformHandler);

        i18n.onChange(updateControls, selectToolbar);
        updateLayerOptions();

        this.getFocus = () => {
            const points: Vec3[] = [];
            const base = getSplat(baseLayer);
            const moving = getSplat(movingLayer);
            if (base) {
                basePoints.forEach(point => points.push(getWorldPoint(base, point, new Vec3())));
            }
            if (moving) {
                movingPoints.forEach(point => points.push(getWorldPoint(moving, point, new Vec3())));
            }
            if (points.length === 0) {
                return null;
            }

            const position = new Vec3();
            points.forEach(point => position.add(point));
            position.mulScalar(1 / points.length);

            let radius = 0;
            points.forEach((point) => {
                radius = Math.max(radius, point.distance(position));
            });
            const bounds = [base, moving].filter((splat, index, all) => splat && all.indexOf(splat) === index);
            const boundRadius = bounds.reduce((max, splat) => {
                return Math.max(max, splat.localBound.halfExtents.length() * Math.max(
                    Math.abs(splat.entity.getLocalScale().x),
                    Math.abs(splat.entity.getLocalScale().y),
                    Math.abs(splat.entity.getLocalScale().z)
                ));
            }, 0);
            return { position, radius: Math.max(radius * 1.5, boundRadius * 0.05) };
        };

        this.activate = () => {
            active = true;
            updateControls();
            parent.style.display = 'block';
            parent.classList.add('noevents');
            canvasContainer.dom.addEventListener('pointerdown', pointerdown);
            canvasContainer.dom.addEventListener('pointermove', pointermove);
            canvasContainer.dom.addEventListener('pointerup', pointerup, true);
            selectToolbar.hidden = false;
            events.fire('transformHandler.push', transformHandler);
            scene.add(overlay);
            scene.forceRender = true;
        };

        this.deactivate = () => {
            active = false;
            clicked = false;
            scene.remove(overlay);
            canvasContainer.dom.removeEventListener('pointerdown', pointerdown);
            canvasContainer.dom.removeEventListener('pointermove', pointermove);
            canvasContainer.dom.removeEventListener('pointerup', pointerup, true);
            selectToolbar.hidden = true;
            parent.style.display = 'none';
            parent.classList.remove('noevents');
            events.fire('transformHandler.pop');
            scene.forceRender = true;
        };
    }
}

export { LayerAlignTool, LayerAlignmentMode, calculateLayerAlignment };
