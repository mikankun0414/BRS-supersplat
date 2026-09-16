import {
    Entity,
    GraphNode,
    Mat4,
    Mesh,
    Plane,
    PRIMITIVE_TRIANGLES,
    Ray,
    TranslateGizmo,
    Vec3
} from 'playcanvas';

import { MeshEditOp } from '../edit-ops';
import { Events } from '../events';
import { GltfModel } from '../model';
import { Scene } from '../scene';
import { OverlayWriter, ToolOverlay } from '../tool-overlay';

type MeshEditMode = 'vertex' | 'edge' | 'face';

type Triangle = {
    a: number;
    b: number;
    c: number;
};

type MeshEdge = {
    a: number;
    b: number;
};

type MeshEditRecord = {
    id: number;
    mesh: Mesh;
    node: GraphNode;
    positions: Float32Array;
    hasNormals: boolean;
    triangles: Triangle[];
    edges: MeshEdge[];
};

type ComponentHit = {
    record: MeshEditRecord;
    index: number;
};

type MeshTarget = {
    mesh: Mesh;
    node: GraphNode;
    record: MeshEditRecord;
    indices: Set<number>;
};

type DragTarget = MeshTarget & {
    before: Float32Array;
    beforeNormals?: Float32Array;
    after: Float32Array;
    afterNormals?: Float32Array;
};

const VERTEX_HIT_RADIUS = 11;
const EDGE_HIT_RADIUS = 9;

// Building camera-facing ribbons for every edge of a very dense model is
// expensive. Picking still examines the full topology; this limit only keeps
// the editor overlay responsive while the user works on large assets.
const MAX_DISPLAY_VERTICES = 100000;
const MAX_DISPLAY_EDGES = 120000;

const worldPoint = new Vec3();
const worldA = new Vec3();
const worldB = new Vec3();
const worldC = new Vec3();
const localPoint = new Vec3();
const cameraOffset = new Vec3();
const rayEdgeA = new Vec3();
const rayEdgeB = new Vec3();
const rayCross = new Vec3();
const rayToOrigin = new Vec3();
const rayDirectionCross = new Vec3();
const inverseNodeTransform = new Mat4();
const dragDelta = new Vec3();
const dragWorldPoint = new Vec3();
const dragLocalPoint = new Vec3();
const directDragPlane = new Plane();
const directDragAnchor = new Vec3();
const directDragStartWorld = new Vec3();
const directDragPoint = new Vec3();
const directDragPosition = new Vec3();
const screen = new Vec3();
const screenA = new Vec3();
const screenB = new Vec3();
const ray = new Ray();

const DIRECT_DRAG_THRESHOLD = 2;

const setLocalPoint = (positions: Float32Array, index: number, result: Vec3) => {
    const offset = index * 3;
    result.set(positions[offset], positions[offset + 1], positions[offset + 2]);
};

const getWorldPoint = (record: MeshEditRecord, index: number, result: Vec3) => {
    setLocalPoint(record.positions, index, localPoint);
    record.node.getWorldTransform().transformPoint(localPoint, result);
    return result;
};

const calculateNormals = (positions: Float32Array, triangles: Triangle[]) => {
    const normals = new Float32Array(positions.length);
    const a = new Vec3();
    const b = new Vec3();
    const c = new Vec3();
    const ab = new Vec3();
    const ac = new Vec3();
    const faceNormal = new Vec3();

    triangles.forEach(({ a: ia, b: ib, c: ic }) => {
        setLocalPoint(positions, ia, a);
        setLocalPoint(positions, ib, b);
        setLocalPoint(positions, ic, c);

        ab.sub2(b, a);
        ac.sub2(c, a);
        faceNormal.cross(ab, ac);

        normals[ia * 3] += faceNormal.x;
        normals[ia * 3 + 1] += faceNormal.y;
        normals[ia * 3 + 2] += faceNormal.z;
        normals[ib * 3] += faceNormal.x;
        normals[ib * 3 + 1] += faceNormal.y;
        normals[ib * 3 + 2] += faceNormal.z;
        normals[ic * 3] += faceNormal.x;
        normals[ic * 3 + 1] += faceNormal.y;
        normals[ic * 3 + 2] += faceNormal.z;
    });

    for (let i = 0; i < normals.length; i += 3) {
        const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
        if (length > 1e-12) {
            normals[i] /= length;
            normals[i + 1] /= length;
            normals[i + 2] /= length;
        } else {
            // Keep a valid normal for isolated vertices and degenerate faces.
            normals[i + 1] = 1;
        }
    }

    return normals;
};

const readTriangles = (mesh: Mesh, vertexCount: number) => {
    const primitive = mesh.primitive[0];
    if (!primitive || primitive.type !== PRIMITIVE_TRIANGLES) {
        return null;
    }

    const triangles: Triangle[] = [];
    const count = primitive.count ?? 0;
    const base = primitive.base ?? 0;
    const baseVertex = primitive.baseVertex ?? 0;
    const indexed = primitive.indexed !== false && mesh.indexBuffer.length > 0;

    if (indexed) {
        const indexBuffer = mesh.indexBuffer[0];
        const indices = new Uint32Array(indexBuffer.numIndices);
        mesh.getIndices(indices);

        for (let i = 0; i + 2 < count; i += 3) {
            triangles.push({
                a: indices[base + i] + baseVertex,
                b: indices[base + i + 1] + baseVertex,
                c: indices[base + i + 2] + baseVertex
            });
        }
    } else {
        for (let i = 0; i + 2 < count; i += 3) {
            triangles.push({
                a: base + i + baseVertex,
                b: base + i + 1 + baseVertex,
                c: base + i + 2 + baseVertex
            });
        }
    }

    return triangles.filter(({ a, b, c }) => {
        return a >= 0 && b >= 0 && c >= 0 && a < vertexCount && b < vertexCount && c < vertexCount;
    });
};

const buildEdges = (triangles: Triangle[]) => {
    const edges: MeshEdge[] = [];
    const edgeSet = new Set<string>();

    triangles.forEach(({ a, b, c }) => {
        [[a, b], [b, c], [c, a]].forEach(([from, to]) => {
            const first = Math.min(from, to);
            const second = Math.max(from, to);
            const key = `${first}:${second}`;
            if (!edgeSet.has(key)) {
                edgeSet.add(key);
                edges.push({ a: first, b: second });
            }
        });
    });

    return edges;
};

const readRecord = (mesh: Mesh, node: GraphNode, id: number): MeshEditRecord | null => {
    if (!mesh?.vertexBuffer || !node) {
        return null;
    }

    const positions = new Float32Array(mesh.vertexBuffer.numVertices * 3);
    const vertexCount = mesh.getPositions(positions);
    if (vertexCount === 0) {
        return null;
    }

    const triangles = readTriangles(mesh, vertexCount);
    if (!triangles?.length) {
        return null;
    }

    const normals = new Float32Array(positions.length);

    return {
        id,
        mesh,
        node,
        positions,
        hasNormals: mesh.getNormals(normals) > 0,
        triangles,
        edges: buildEdges(triangles)
    };
};

const distanceToSegmentSquared = (x: number, y: number, a: Vec3, b: Vec3) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq > 1e-12 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSq)) : 0;
    const closestX = a.x + dx * t;
    const closestY = a.y + dy * t;
    return {
        distanceSq: (x - closestX) ** 2 + (y - closestY) ** 2,
        t
    };
};

// Moller-Trumbore intersection. Back faces remain selectable because glTF
// meshes can be viewed from either side while editing.
const intersectTriangle = (hitRay: Ray, a: Vec3, b: Vec3, c: Vec3) => {
    rayEdgeA.sub2(b, a);
    rayEdgeB.sub2(c, a);
    rayDirectionCross.cross(hitRay.direction, rayEdgeB);
    const determinant = rayEdgeA.dot(rayDirectionCross);
    if (Math.abs(determinant) < 1e-8) {
        return null;
    }

    const inverseDeterminant = 1 / determinant;
    rayToOrigin.sub2(hitRay.origin, a);
    const u = rayToOrigin.dot(rayDirectionCross) * inverseDeterminant;
    if (u < 0 || u > 1) {
        return null;
    }

    rayCross.cross(rayToOrigin, rayEdgeA);
    const v = hitRay.direction.dot(rayCross) * inverseDeterminant;
    if (v < 0 || u + v > 1) {
        return null;
    }

    const distance = rayEdgeB.dot(rayCross) * inverseDeterminant;
    return distance > 1e-6 ? distance : null;
};

class MeshEditTool {
    private events: Events;
    private scene: Scene;
    private canvas: HTMLElement;
    private gizmo: TranslateGizmo;
    private pivot: Entity;
    private baseOverlay: ToolOverlay;
    private selectionOverlay: ToolOverlay;
    private model: GltfModel = null;
    private records: MeshEditRecord[] = [];
    private selected = new Map<MeshEditRecord, Set<number>>();
    private active = false;
    private dragging = false;
    private dragStartPosition = new Vec3();
    private dragTargets: DragTarget[] = [];
    private directDragPointerId: number | null = null;
    private directDragStartX = 0;
    private directDragStartY = 0;
    private directDragMoved = false;
    private mode: MeshEditMode = 'vertex';

    constructor(events: Events, scene: Scene, canvas: HTMLElement) {
        this.events = events;
        this.scene = scene;
        this.canvas = canvas;

        this.pivot = new Entity('meshEditPivot');
        scene.app.root.addChild(this.pivot);

        this.gizmo = new TranslateGizmo(scene.camera.camera, scene.gizmoLayer);
        this.gizmo.coordSpace = events.invoke('tool.coordSpace');
        this.updateGizmoSize();

        this.baseOverlay = new ToolOverlay({
            dotColor: [1, 1, 1, 1],
            lineColor: [0.7, 0.7, 0.7, 1],
            dotSize: 9,
            lineWidth: 1
        });
        this.selectionOverlay = new ToolOverlay({
            dotColor: [1, 0.35, 0.05, 1],
            lineColor: [1, 0.35, 0.05, 1],
            fillColor: [1, 0.35, 0.05, 0.55],
            ghostFills: true,
            dotSize: 15,
            lineWidth: 3
        });

        this.baseOverlay.provider = writer => this.writeBaseOverlay(writer);
        this.selectionOverlay.provider = writer => this.writeSelectionOverlay(writer);

        this.gizmo.on('render:update', () => {
            this.scene.forceRender = true;
        });
        this.gizmo.on('transform:start', () => this.startTransform());
        this.gizmo.on('transform:move', () => this.moveTransform());
        this.gizmo.on('transform:end', () => this.endTransform());

        events.on('tool.coordSpace', (space: 'local' | 'world') => {
            this.gizmo.coordSpace = space;
            this.scene.forceRender = true;
        });
        events.on('meshEdit.setMode', (mode: MeshEditMode) => {
            if (mode === 'vertex' || mode === 'edge' || mode === 'face') {
                this.setMode(mode);
            }
        });
        events.on('camera.resize', () => this.updateGizmoSize());
        events.on('camera.ortho', () => this.updateGizmoSize());

        events.on('selection.changed', (selection: unknown) => {
            const model = selection instanceof GltfModel ? selection : null;
            if (model !== this.model) {
                if (this.directDragPointerId !== null) {
                    this.cancelDirectDrag();
                }
                this.model = model;
                this.rebuildRecords();
            }
            if (this.active && !model) {
                // A mesh-edit gizmo must never remain active while a splat or
                // an empty scene is selected.
                this.events.fire('tool.deactivate');
            }
        });
        events.on('model.geometryChanged', (model: GltfModel) => {
            if (model === this.model && !this.dragging) {
                this.refreshRecords();
                this.updatePivot();
            }
        });

        // The gizmo listens on the canvas too. This handler is registered after
        // it, so a gizmo hit has already set dragging=true and is left alone;
        // component hits stop the camera controller from orbiting on selection.
        this.canvas.addEventListener('pointerdown', event => this.onPointerDown(event as PointerEvent));
        this.canvas.addEventListener('pointermove', event => this.onPointerMove(event as PointerEvent));
        this.canvas.addEventListener('pointerup', event => this.onPointerUp(event as PointerEvent));
        this.canvas.addEventListener('pointercancel', event => this.onPointerCancel(event as PointerEvent));

        events.fire('meshEdit.mode', this.mode);
        events.fire('meshEdit.selectionChanged', { mode: this.mode, count: 0 });
    }

    setComponentMode(mode: MeshEditMode) {
        this.setMode(mode);
        return true;
    }

    activate() {
        this.active = true;
        this.directDragPointerId = null;
        const selection = this.events.invoke('selection');
        this.model = selection instanceof GltfModel ? selection : null;
        this.rebuildRecords();
        this.scene.add(this.baseOverlay);
        this.scene.add(this.selectionOverlay);
        this.updatePivot();
        this.scene.forceRender = true;
    }

    deactivate() {
        if (this.directDragPointerId !== null) {
            this.cancelDirectDrag();
        }
        this.active = false;
        this.dragging = false;
        this.dragTargets = [];
        this.gizmo.detach();
        this.scene.remove(this.baseOverlay);
        this.scene.remove(this.selectionOverlay);
        this.scene.forceRender = true;
    }

    private setMode(mode: MeshEditMode) {
        if (mode === this.mode) {
            return;
        }

        this.mode = mode;
        this.selected.clear();
        this.events.fire('meshEdit.mode', mode);
        this.events.fire('meshEdit.selectionChanged', { mode, count: 0 });
        this.updatePivot();
        this.scene.forceRender = true;
    }

    private updateGizmoSize() {
        const { camera, canvas } = this.scene;
        this.gizmo.size = camera.ortho ?
            1125 / Math.max(1, canvas.clientHeight) :
            1200 / Math.max(1, Math.max(canvas.clientWidth, canvas.clientHeight));
    }

    private rebuildRecords() {
        this.records = [];
        this.selected.clear();

        if (this.model) {
            this.model.meshInstances.forEach((meshInstance) => {
                if (!meshInstance.visible) {
                    return;
                }

                const record = readRecord(meshInstance.mesh, meshInstance.node, this.records.length);
                if (record) {
                    this.records.push(record);
                }
            });
        }

        this.events.fire('meshEdit.geometryChanged', {
            meshes: this.records.length,
            vertices: this.records.reduce((sum, record) => sum + record.positions.length / 3, 0),
            edges: this.records.reduce((sum, record) => sum + record.edges.length, 0),
            faces: this.records.reduce((sum, record) => sum + record.triangles.length, 0)
        });
        this.events.fire('meshEdit.selectionChanged', { mode: this.mode, count: 0 });
        this.updatePivot();
    }

    private refreshRecords() {
        this.records.forEach((record) => {
            const positions = new Float32Array(record.mesh.vertexBuffer.numVertices * 3);
            const count = record.mesh.getPositions(positions);
            if (count === positions.length / 3) {
                record.positions = positions;
            }
        });
    }

    private selectedVertexIndices(record: MeshEditRecord, components: Set<number>) {
        const indices = new Set<number>();

        components.forEach((component) => {
            if (this.mode === 'vertex') {
                if (component >= 0 && component < record.positions.length / 3) {
                    indices.add(component);
                }
            } else if (this.mode === 'edge') {
                const edge = record.edges[component];
                if (edge) {
                    indices.add(edge.a);
                    indices.add(edge.b);
                }
            } else {
                const triangle = record.triangles[component];
                if (triangle) {
                    indices.add(triangle.a);
                    indices.add(triangle.b);
                    indices.add(triangle.c);
                }
            }
        });

        return indices;
    }

    private selectedMeshTargets(includeConnected = false) {
        const targets = new Map<Mesh, MeshTarget>();

        this.selected.forEach((components, record) => {
            const indices = this.selectedVertexIndices(record, components);
            if (indices.size === 0) {
                return;
            }

            let target = targets.get(record.mesh);
            if (!target) {
                target = {
                    mesh: record.mesh,
                    node: record.node,
                    record,
                    indices: new Set<number>()
                };
                targets.set(record.mesh, target);
            }

            indices.forEach(index => target.indices.add(index));
        });

        if (includeConnected && targets.size > 0) {
            // glTF can split a geometric vertex at UV, normal and material
            // seams. Keep its render vertices separate, but move every copy
            // at the same world position, including copies in other primitives.
            // Snapshot membership before dragging so passing through another
            // vertex does not attach it to the selection.
            const positionKey = (record: MeshEditRecord, index: number) => {
                getWorldPoint(record, index, worldPoint);
                return `${worldPoint.x},${worldPoint.y},${worldPoint.z}`;
            };
            const selectedPositions = new Set<string>();
            targets.forEach((target) => {
                target.indices.forEach(index => selectedPositions.add(positionKey(target.record, index)));
            });
            this.records.forEach((record) => {
                for (let index = 0; index < record.positions.length / 3; index++) {
                    if (!selectedPositions.has(positionKey(record, index))) {
                        continue;
                    }
                    let target = targets.get(record.mesh);
                    if (!target) {
                        target = { mesh: record.mesh, node: record.node, record, indices: new Set<number>() };
                        targets.set(record.mesh, target);
                    }
                    target.indices.add(index);
                }
            });
        }

        return Array.from(targets.values());
    }

    private updatePivot() {
        const targets = this.selectedMeshTargets();
        if (!this.active || targets.length === 0) {
            this.gizmo.detach();
            return;
        }

        const center = new Vec3();
        let count = 0;
        targets.forEach((target) => {
            target.indices.forEach((index) => {
                getWorldPoint(target.record, index, worldPoint);
                center.add(worldPoint);
                count++;
            });
        });

        if (count === 0) {
            this.gizmo.detach();
            return;
        }

        center.mulScalar(1 / count);
        this.pivot.setPosition(center);
        this.pivot.setRotation(targets[0].node.getRotation());
        this.gizmo.attach([this.pivot]);
    }

    private selectComponent(hit: ComponentHit | null, event: PointerEvent) {
        const additive = event.shiftKey;
        const subtractive = event.ctrlKey || event.metaKey;

        if (!additive && !subtractive) {
            this.selected.clear();
        }

        if (hit) {
            let components = this.selected.get(hit.record);
            if (!components) {
                components = new Set<number>();
                this.selected.set(hit.record, components);
            }

            if (subtractive) {
                components.delete(hit.index);
            } else if (components.has(hit.index) && additive) {
                components.delete(hit.index);
            } else {
                components.add(hit.index);
            }

            if (components.size === 0) {
                this.selected.delete(hit.record);
            }
        }

        this.events.fire('meshEdit.selectionChanged', {
            mode: this.mode,
            count: Array.from(this.selected.values()).reduce((sum, components) => sum + components.size, 0)
        });
        this.updatePivot();
        this.scene.forceRender = true;
    }

    private onPointerDown(event: PointerEvent) {
        if (!this.active || !this.model || this.dragging ||
            (event.pointerType === 'mouse' && event.button !== 0) ||
            (event.pointerType !== 'mouse' && !event.isPrimary)) {
            return;
        }

        const hit = this.pick(event.offsetX, event.offsetY);
        this.selectComponent(hit, event);

        if (hit && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
            this.beginDirectDrag(event);
        }

        event.preventDefault();
        event.stopPropagation();
    }

    private beginDirectDrag(event: PointerEvent) {
        if (!this.active || !this.model || this.dragging) {
            return;
        }

        directDragAnchor.copy(this.pivot.getPosition());
        directDragPlane.set(
            this.scene.camera.mainCamera.forward.x,
            this.scene.camera.mainCamera.forward.y,
            this.scene.camera.mainCamera.forward.z,
            -this.scene.camera.mainCamera.forward.dot(directDragAnchor)
        );
        this.scene.camera.getRay(event.offsetX, event.offsetY, ray);
        if (!directDragPlane.intersectsRay(ray, directDragStartWorld)) {
            return;
        }

        this.startTransform();
        if (!this.dragging || this.dragTargets.length === 0) {
            return;
        }

        this.directDragPointerId = event.pointerId;
        this.directDragStartX = event.offsetX;
        this.directDragStartY = event.offsetY;
        this.directDragMoved = false;
        this.canvas.setPointerCapture(event.pointerId);
    }

    private onPointerMove(event: PointerEvent) {
        if (this.directDragPointerId !== event.pointerId) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        if (!this.dragging) {
            return;
        }

        if (!this.directDragMoved &&
            Math.hypot(event.offsetX - this.directDragStartX, event.offsetY - this.directDragStartY) < DIRECT_DRAG_THRESHOLD) {
            return;
        }

        this.scene.camera.getRay(event.offsetX, event.offsetY, ray);
        if (!directDragPlane.intersectsRay(ray, directDragPoint)) {
            return;
        }

        this.directDragMoved = true;
        directDragPosition.sub2(directDragPoint, directDragStartWorld).add(directDragAnchor);
        this.pivot.setPosition(directDragPosition);
        this.moveTransform();
    }

    private onPointerUp(event: PointerEvent) {
        if (this.directDragPointerId !== event.pointerId) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        this.releaseDirectDragPointer(event.pointerId);
        this.endTransform();
    }

    private onPointerCancel(event: PointerEvent) {
        if (this.directDragPointerId !== event.pointerId) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        this.releaseDirectDragPointer(event.pointerId);
        this.cancelDirectDrag();
    }

    private releaseDirectDragPointer(pointerId: number) {
        if (this.canvas.hasPointerCapture(pointerId)) {
            this.canvas.releasePointerCapture(pointerId);
        }
        this.directDragPointerId = null;
        this.directDragMoved = false;
    }

    private cancelDirectDrag() {
        if (this.directDragPointerId !== null) {
            this.releaseDirectDragPointer(this.directDragPointerId);
        }

        if (!this.dragging) {
            return;
        }

        this.dragTargets.forEach((target) => {
            this.applyTarget(target, target.before, target.beforeNormals);
        });
        if (this.model) {
            this.model.refreshWorldBound();
        }

        this.dragging = false;
        this.dragTargets = [];
        this.refreshRecords();
        this.updatePivot();
        this.scene.forceRender = true;
    }

    private pick(x: number, y: number): ComponentHit | null {
        switch (this.mode) {
            case 'vertex': return this.pickVertex(x, y);
            case 'edge': return this.pickEdge(x, y);
            case 'face': return this.pickFace(x, y);
        }
    }

    private pickVertex(x: number, y: number) {
        const width = Math.max(1, this.scene.canvas.clientWidth);
        const height = Math.max(1, this.scene.canvas.clientHeight);
        const cameraPosition = this.scene.camera.mainCamera.getPosition();
        const cameraForward = this.scene.camera.mainCamera.forward;
        let best: ComponentHit = null;
        let bestDistance = VERTEX_HIT_RADIUS ** 2;
        let bestDepth = Infinity;

        this.records.forEach((record) => {
            for (let index = 0; index < record.positions.length / 3; index++) {
                getWorldPoint(record, index, worldPoint);
                cameraOffset.sub2(worldPoint, cameraPosition);
                const depth = cameraOffset.dot(cameraForward);
                if (depth <= 0) {
                    continue;
                }

                this.scene.camera.worldToScreen(worldPoint, screen);
                const px = screen.x * width;
                const py = screen.y * height;
                const distance = (px - x) ** 2 + (py - y) ** 2;
                if (distance <= bestDistance && (distance < bestDistance - 1e-6 || depth < bestDepth)) {
                    best = { record, index };
                    bestDistance = distance;
                    bestDepth = depth;
                }
            }
        });

        return best;
    }

    private pickEdge(x: number, y: number) {
        const width = Math.max(1, this.scene.canvas.clientWidth);
        const height = Math.max(1, this.scene.canvas.clientHeight);
        const cameraPosition = this.scene.camera.mainCamera.getPosition();
        const cameraForward = this.scene.camera.mainCamera.forward;
        let best: ComponentHit = null;
        let bestDistance = EDGE_HIT_RADIUS ** 2;
        let bestDepth = Infinity;

        this.records.forEach((record) => {
            record.edges.forEach((edge, index) => {
                getWorldPoint(record, edge.a, worldA);
                getWorldPoint(record, edge.b, worldB);
                cameraOffset.sub2(worldA, cameraPosition);
                const depthA = cameraOffset.dot(cameraForward);
                cameraOffset.sub2(worldB, cameraPosition);
                const depthB = cameraOffset.dot(cameraForward);
                if (depthA <= 0 || depthB <= 0) {
                    return;
                }

                this.scene.camera.worldToScreen(worldA, screenA);
                this.scene.camera.worldToScreen(worldB, screenB);
                screenA.x *= width;
                screenA.y *= height;
                screenB.x *= width;
                screenB.y *= height;

                const result = distanceToSegmentSquared(x, y, screenA, screenB);
                const depth = depthA + (depthB - depthA) * result.t;
                if (result.distanceSq <= bestDistance &&
                    (result.distanceSq < bestDistance - 1e-6 || depth < bestDepth)) {
                    best = { record, index };
                    bestDistance = result.distanceSq;
                    bestDepth = depth;
                }
            });
        });

        return best;
    }

    private pickFace(x: number, y: number) {
        this.scene.camera.getRay(x, y, ray);
        let best: ComponentHit = null;
        let bestDistance = Infinity;

        this.records.forEach((record) => {
            record.triangles.forEach((triangle, index) => {
                getWorldPoint(record, triangle.a, worldA);
                getWorldPoint(record, triangle.b, worldB);
                getWorldPoint(record, triangle.c, worldC);
                const distance = intersectTriangle(ray, worldA, worldB, worldC);
                if (distance !== null && distance < bestDistance) {
                    best = { record, index };
                    bestDistance = distance;
                }
            });
        });

        return best;
    }

    private writeBaseOverlay(writer: OverlayWriter) {
        if (!this.active || !this.model) {
            return;
        }

        this.records.forEach((record) => {
            if (this.mode === 'vertex') {
                const count = Math.min(record.positions.length / 3, MAX_DISPLAY_VERTICES);
                for (let index = 0; index < count; index++) {
                    writer.dot(getWorldPoint(record, index, worldPoint));
                }
                return;
            }

            const count = Math.min(record.edges.length, MAX_DISPLAY_EDGES);
            for (let index = 0; index < count; index++) {
                const edge = record.edges[index];
                writer.segment(
                    getWorldPoint(record, edge.a, worldA),
                    getWorldPoint(record, edge.b, worldB)
                );
            }
        });
    }

    private writeSelectionOverlay(writer: OverlayWriter) {
        if (!this.active || !this.model) {
            return;
        }

        this.selected.forEach((components, record) => {
            components.forEach((component) => {
                if (this.mode === 'vertex') {
                    writer.dot(getWorldPoint(record, component, worldPoint));
                } else if (this.mode === 'edge') {
                    const edge = record.edges[component];
                    if (edge) {
                        writer.segment(
                            getWorldPoint(record, edge.a, worldA),
                            getWorldPoint(record, edge.b, worldB)
                        );
                    }
                } else {
                    const triangle = record.triangles[component];
                    if (triangle) {
                        writer.fill(
                            getWorldPoint(record, triangle.a, worldA),
                            getWorldPoint(record, triangle.b, worldB),
                            getWorldPoint(record, triangle.c, worldC)
                        );
                        writer.segment(
                            getWorldPoint(record, triangle.a, worldA),
                            getWorldPoint(record, triangle.b, worldB)
                        );
                        writer.segment(
                            getWorldPoint(record, triangle.b, worldA),
                            getWorldPoint(record, triangle.c, worldB)
                        );
                        writer.segment(
                            getWorldPoint(record, triangle.c, worldA),
                            getWorldPoint(record, triangle.a, worldB)
                        );
                    }
                }
            });
        });
    }

    private startTransform() {
        if (!this.active || !this.model) {
            return;
        }

        this.dragging = true;
        this.dragStartPosition.copy(this.pivot.getPosition());
        this.dragTargets = this.selectedMeshTargets(true).map((target): DragTarget => {
            const before = target.record.positions.slice();
            const normals = new Float32Array(before.length);
            const hasNormals = target.mesh.getNormals(normals) > 0;

            return {
                ...target,
                before,
                beforeNormals: hasNormals ? normals : undefined,
                after: before.slice(),
                afterNormals: undefined
            };
        });
    }

    private moveTransform() {
        if (!this.dragging || !this.model) {
            return;
        }

        dragDelta.sub2(this.pivot.getPosition(), this.dragStartPosition);

        this.dragTargets.forEach((target) => {
            const after = target.before.slice();
            inverseNodeTransform.copy(target.node.getWorldTransform()).invert();

            target.indices.forEach((index) => {
                setLocalPoint(target.before, index, dragLocalPoint);
                target.node.getWorldTransform().transformPoint(dragLocalPoint, dragWorldPoint);
                dragWorldPoint.add(dragDelta);
                inverseNodeTransform.transformPoint(dragWorldPoint, dragLocalPoint);

                const offset = index * 3;
                after[offset] = dragLocalPoint.x;
                after[offset + 1] = dragLocalPoint.y;
                after[offset + 2] = dragLocalPoint.z;
            });

            target.after = after;
            target.afterNormals = target.beforeNormals ? calculateNormals(after, target.record.triangles) : undefined;
            this.applyTarget(target, after, target.afterNormals);
        });

        this.model.refreshWorldBound();
        this.scene.forceRender = true;
    }

    private applyTarget(target: MeshTarget, positions: Float32Array, normals?: Float32Array) {
        target.mesh.setPositions(positions);
        if (normals) {
            target.mesh.setNormals(normals);
        }
        target.mesh.update();

        this.records.forEach((record) => {
            if (record.mesh === target.mesh) {
                record.positions = positions;
            }
        });
    }

    private endTransform() {
        if (!this.dragging) {
            return;
        }

        const model = this.model;
        const changes = this.dragTargets.map(target => ({
            mesh: target.mesh,
            before: target.before,
            after: target.after,
            beforeNormals: target.beforeNormals,
            afterNormals: target.afterNormals
        }));
        const changed = changes.some(change => !change.before.every((value, index) => value === change.after[index]));

        this.dragging = false;
        this.dragTargets = [];

        if (model && changed) {
            // Geometry is already at `after`; suppressing the first redo avoids
            // rebuilding the GPU buffers a second time for the same drag.
            this.events.fire('edit.add', new MeshEditOp({ model, changes }), true);
        }

        this.refreshRecords();
        this.updatePivot();
        this.scene.forceRender = true;
    }
}

export { MeshEditMode, MeshEditTool };
