import {
    type ChunkDataPool,
    type ChunkSource,
    type Options,
    type ReadFileSystem,
    createChunkDataPool,
    getInputFormat,
    readFile
} from '@playcanvas/splat-transform';
import {
    ADDRESS_CLAMP_TO_EDGE,
    FILTER_NEAREST,
    BoundingBox,
    FloatPacking,
    GSplatResourceBase,
    GSplatFormat,
    PIXELFORMAT_R8,
    PIXELFORMAT_RGBA16F,
    PIXELFORMAT_RGBA32U,
    Texture,
    type GraphicsDevice
} from 'playcanvas';
/**
 * A large PLY is kept in one GPU resource so the built-in sorter can produce
 * one globally ordered draw. All source Gaussians are uploaded; render-time
 * distance LOD controls how many are rasterized, while createSource() still
 * reopens the original PLY for lossless export.
 */
type FullResolutionPlyResource = {
    readonly kind: 'full-resolution-ply';
    readonly device: GraphicsDevice;
    readonly chunks: FullResolutionContainer[];
    /** Number of splats uploaded to the display resource. */
    readonly numSplats: number;
    /** Number of splats in the original source PLY. */
    readonly sourceNumSplats: number;
    /** Map a displayed row to its original source row. */
    readonly sourceIndexForDisplayIndex: (displayIndex: number) => number;
    /** Map an original source row to its displayed row, or -1. */
    readonly displayIndexForSourceIndex: (sourceIndex: number) => number;
    /** True when the display resource is a reduced preview of the source. */
    readonly isPreview: boolean;
    /** SH bands in the original PLY. The render resource intentionally uses DC only. */
    readonly sourceShBands: number;
    readonly shBands: number;
    readonly aabb: BoundingBox;
    readonly transform: any;
    /** Reopen the lazy PLY source for a later lossless export. */
    readonly createSource: () => Promise<ChunkSource>;
    readonly uploadState: (data: Uint8Array) => void;
    destroy: () => void;
};

type FullResolutionSelectionGroup = {
    readonly start: number;
    readonly count: number;
    readonly transformA: Texture;
};

// Keep smaller PLYs on the regular editable GSplatData path. Above this count,
// retain every source row in the streaming resource and let the renderer apply
// the near-camera/distance LOD.
const FULL_RESOLUTION_NEAR_GAUSSIANS = 5_000_000;

// Keep each GPU allocation comfortably below the driver's large-texture
// limits. Twelve 1M-row chunks fit in one ordinary 2D texture, so the
// 44M-point example uses four groups per stream and still renders in one draw.
const FULL_RESOLUTION_TEXTURE_WIDTH = 2048;
const FULL_RESOLUTION_GROUP_CHUNKS = 12;

// The unified renderer copies each placement into a shared work buffer before
// performing its single global depth sort. Apply the editor's per-placement
// color controls during that copy; the final renderer then only performs the
// view-dependent output conversion.
const fullResolutionWorkBufferModifyGLSL = /* glsl */ `
uniform vec3 clrOffset;
uniform vec4 clrScale;
uniform float saturation;
uniform vec4 selectedClr;
uniform vec4 lockedClr;

vec3 fullResolutionSaturate(vec3 value) {
    vec3 grey = vec3(dot(value, vec3(0.299, 0.587, 0.114)));
    return grey + (value - grey) * saturation;
}

void modifySplatCenter(inout vec3 center) {
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
}

void modifySplatColor(vec3 center, inout vec4 color) {
    uint state = loadFullResolutionState();
    color = color * clrScale + vec4(clrOffset, 0.0);
    color.xyz = fullResolutionSaturate(color.xyz);

    if ((state & 4u) != 0u) {
        color.a = 0.0;
    } else if ((state & 2u) != 0u) {
        color *= lockedClr;
    } else if ((state & 1u) != 0u) {
        color.xyz = mix(color.xyz, selectedClr.xyz, selectedClr.a);
    }

    color.a = clamp(color.a, 0.0, 1.0);
}
`;

const fullResolutionWorkBufferModifyWGSL = /* wgsl */ `
uniform clrOffset: vec3f;
uniform clrScale: vec4f;
uniform saturation: f32;
uniform selectedClr: vec4f;
uniform lockedClr: vec4f;

fn fullResolutionSaturate(value: vec3f) -> vec3f {
    let grey = vec3f(dot(value, vec3f(0.299, 0.587, 0.114)));
    return grey + (value - grey) * saturation;
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let state = loadFullResolutionState();
    (*color) = (*color) * clrScale + vec4f(clrOffset, 0.0);
    (*color).rgb = fullResolutionSaturate((*color).rgb);

    if ((state & 4u) != 0u) {
        (*color).a = 0.0;
    } else if ((state & 2u) != 0u) {
        (*color) = (*color) * lockedClr;
    } else if ((state & 1u) != 0u) {
        (*color).rgb = mix((*color).rgb, selectedClr.rgb, selectedClr.a);
    }

    (*color).a = clamp((*color).a, 0.0, 1.0);
}
`;

const defaultOptions: Options = {
    iterations: 10,
    lodSelect: [],
    unbundled: false,
    lodChunkCount: 512,
    lodChunkExtent: 16
};

const sigmoid = (value: number) => {
    if (value > 0) {
        return 1 / (1 + Math.exp(-value));
    }
    const t = Math.exp(value);
    return t / (1 + t);
};

/**
 * GSplatContainer normally advertises SH_BANDS=0 because its default format
 * is a simple procedural format. This subclass keeps the standard packed
 * PlayCanvas resource format while exposing the PLY's SH band count.
 */
class FullResolutionContainer extends GSplatResourceBase {
    readonly shBands: number;
    readonly sourceChunkSize: number;
    readonly maxSplats: number;
    readonly groupCount: number;
    readonly textureGroups = new Map<string, Texture[]>();
    readonly declarations: string;

    constructor(
        device: GraphicsDevice,
        maxSplats: number,
        format: GSplatFormat,
        shBands: number,
        sourceChunkSize: number,
        declarations: string
    ) {
        const aabb = new BoundingBox();
        super(device, {
            numSplats: maxSplats,
            getCenters: (): null => null,
            calcAabb: (box: BoundingBox): void => {
                box.copy(aabb);
            }
        }, { prepareCenters: false });
        this._format = format;
        this.streams.init(format, maxSplats);
        this.shBands = shBands;
        this.sourceChunkSize = sourceChunkSize;
        this.maxSplats = maxSplats;
        this.groupCount = Math.ceil(Math.ceil(maxSplats / sourceChunkSize) / FULL_RESOLUTION_GROUP_CHUNKS);
        this.declarations = declarations;
        (this.gsplatData as any).shBands = shBands;

        const rowsPerSourceChunk = Math.ceil(sourceChunkSize / FULL_RESOLUTION_TEXTURE_WIDTH);
        const textureFormats = [
            ['fullResColor', PIXELFORMAT_RGBA16F],
            ['transformA', PIXELFORMAT_RGBA32U],
            ['transformB', PIXELFORMAT_RGBA16F],
            ['fullResState', PIXELFORMAT_R8]
        ] as const;

        for (const [name, formatValue] of textureFormats) {
            const groups: Texture[] = [];
            for (let group = 0; group < this.groupCount; group++) {
                const firstLayer = group * FULL_RESOLUTION_GROUP_CHUNKS;
                const layerCount = Math.min(
                    FULL_RESOLUTION_GROUP_CHUNKS,
                    Math.ceil(maxSplats / sourceChunkSize) - firstLayer
                );
                const texture = new Texture(device, {
                    name: `${name}${group}`,
                    width: FULL_RESOLUTION_TEXTURE_WIDTH,
                    height: rowsPerSourceChunk * layerCount,
                    format: formatValue,
                    mipmaps: false,
                    minFilter: FILTER_NEAREST,
                    magFilter: FILTER_NEAREST,
                    addressU: ADDRESS_CLAMP_TO_EDGE,
                    addressV: ADDRESS_CLAMP_TO_EDGE
                });
                groups.push(texture);
            }
            this.textureGroups.set(name, groups);
        }

        // Initialize the per-Gaussian state channel explicitly. It is read by
        // the unified work-buffer modifier before the first selection update.
        this.textureGroups.get('fullResState')!.forEach((texture) => {
            const data = texture.lock() as Uint8Array;
            data.fill(0);
            texture.unlock();
        });
    }

    configureMaterialDefines(defines: Map<string, string>) {
        defines.set('SH_BANDS', String(this.shBands));
        defines.set('FULL_RESOLUTION', '');
        defines.set('FULL_RESOLUTION_STATE', '');
    }

    createGroupData(name: string, group: number): ArrayBufferView {
        const texture = this.textureGroups.get(name)![group];
        const ArrayType = name === 'transformA' ? Uint32Array :
            name === 'fullResState' ? Uint8Array : Uint16Array;
        const channels = name === 'fullResState' ? 1 : 4;
        return new ArrayType(texture.width * texture.height * channels);
    }

    uploadGroup(name: string, group: number, data: ArrayBufferView) {
        const texture = this.textureGroups.get(name)![group];
        const levels = (texture as any)._levels as Array<ArrayBufferView | null>;
        levels[0] = data;
        texture.upload();
        // WebGL texImage2D and WebGPU writeTexture both copy the source before
        // returning, so the per-group CPU staging array can be freed.
        levels[0] = null;
    }

    get selectionGroups(): FullResolutionSelectionGroup[] {
        const groupSize = this.sourceChunkSize * FULL_RESOLUTION_GROUP_CHUNKS;
        return this.textureGroups.get('transformA')!.map((transformA, group) => {
            const start = group * groupSize;
            return {
                start,
                count: Math.max(0, Math.min(this.maxSplats - start, groupSize)),
                transformA
            };
        }).filter(group => group.count > 0);
    }

    uploadState(data: Uint8Array) {
        const groupSize = this.sourceChunkSize * FULL_RESOLUTION_GROUP_CHUNKS;
        const stateTextures = this.textureGroups.get('fullResState')!;

        stateTextures.forEach((texture, group) => {
            const start = group * groupSize;
            const state = texture.lock() as Uint8Array;
            state.fill(0);
            state.set(data.subarray(start, Math.min(start + groupSize, data.length)));
            texture.unlock();
        });
    }

    configureMaterial(material: any, workBufferModifier: any, _formatDeclarations: string) {
        this.configureMaterialDefines(material.defines);
        const chunks = this.device.isWebGPU ? material.shaderChunks.wgsl : material.shaderChunks.glsl;
        chunks.set('gsplatDeclarationsVS', this.declarations);
        chunks.set('gsplatReadVS', this.format.getReadCode());
        chunks.set(
            'gsplatModifyVS',
            workBufferModifier?.code ?? (this.device.isWebGPU ? fullResolutionWorkBufferModifyWGSL : fullResolutionWorkBufferModifyGLSL)
        );
        for (const [name, textures] of this.textureGroups) {
            textures.forEach((texture, group) => material.setParameter(`${name}${group}`, texture));
        }
        if (this.textureDimensions.x > 0) {
            material.setParameter('splatTextureSize', this.textureDimensions.x);
        }
    }

    _actualDestroy() {
        for (const textures of this.textureGroups.values()) {
            textures.forEach(texture => texture.destroy());
        }
        this.textureGroups.clear();
        super._actualDestroy();
    }
}

const isFullResolutionPlyResource = (value: unknown): value is FullResolutionPlyResource => {
    return !!value && (value as FullResolutionPlyResource).kind === 'full-resolution-ply';
};

const createFullResolutionFormat = (
    device: GraphicsDevice,
    groupCount: number,
    sourceChunkSize: number,
    baseReadGLSL: string,
    baseReadWGSL: string
) => {
    const groupSize = sourceChunkSize * FULL_RESOLUTION_GROUP_CHUNKS;
    const names = (name: string) => Array.from({ length: groupCount }, (_, group) => `${name}${group}`);
    const colorNames = names('fullResColor');
    const transformANames = names('transformA');
    const transformBNames = names('transformB');
    const stateNames = names('fullResState');
    const glslUv = `
ivec2 fullResolutionUv(uint index) {
    uint groupIndex = index % ${groupSize}u;
    return ivec2(
        int(groupIndex % ${FULL_RESOLUTION_TEXTURE_WIDTH}u),
        int(groupIndex / ${FULL_RESOLUTION_TEXTURE_WIDTH}u)
    );
}`;
    const wgslUv = `
fn fullResolutionUv(index: u32) -> vec2i {
    let groupIndex = index % ${groupSize}u;
    return vec2i(
        i32(groupIndex % ${FULL_RESOLUTION_TEXTURE_WIDTH}u),
        i32(groupIndex / ${FULL_RESOLUTION_TEXTURE_WIDTH}u)
    );
}`;
    const glslStateLoader = `
uint loadFullResolutionState() {
    uint group = splat.index / ${groupSize}u;
    ivec2 uv = fullResolutionUv(splat.index);
${stateNames.map((name, group) => `    if (group == ${group}u) return uint(texelFetch(${name}, uv, 0).r * 255.0 + 0.5);`).join('\n')}
    return 0u;
}`;
    const wgslStateLoader = `
fn loadFullResolutionState() -> u32 {
    let group = splat.index / ${groupSize}u;
    let uv = fullResolutionUv(splat.index);
${stateNames.map((name, group) => `    if (group == ${group}u) { return u32(textureLoad(${name}, uv, 0).r * 255.0 + 0.5); }`).join('\n')}
    return 0u;
}`;
    const glslDeclarations = [
        ...transformANames.map(name => `uniform highp usampler2D ${name};`),
        ...transformBNames.map(name => `uniform highp sampler2D ${name};`),
        ...colorNames.map(name => `uniform highp sampler2D ${name};`),
        ...stateNames.map(name => `uniform highp sampler2D ${name};`),
        glslUv,
        glslStateLoader
    ].join('\n');
    const wgslDeclarations = [
        ...transformANames.map(name => `var ${name}: texture_2d<u32>;`),
        ...transformBNames.map(name => `var ${name}: texture_2d<f32>;`),
        ...colorNames.map(name => `var ${name}: texture_2d<f32>;`),
        ...stateNames.map(name => `var ${name}: texture_2d<f32>;`),
        wgslUv,
        wgslStateLoader
    ].join('\n');
    const glslBranches = (namesForStream: string[], zero: string) => `${namesForStream.map((name, group) => `    if (group == ${group}u) return texelFetch(${name}, uv, 0);`).join('\n')}\n    return ${zero};`;
    const wgslBranches = (namesForStream: string[], zero: string) => `${namesForStream.map((name, group) => `    if (group == ${group}u) return textureLoad(${name}, uv, 0);`).join('\n')}\n    return ${zero};`;

    const readGLSLData = `
uvec4 loadTransformA() {
    uint group = splat.index / ${groupSize}u;
    ivec2 uv = fullResolutionUv(splat.index);
${glslBranches(transformANames, 'uvec4(0u)')}
}
vec4 loadTransformB() {
    uint group = splat.index / ${groupSize}u;
    ivec2 uv = fullResolutionUv(splat.index);
${glslBranches(transformBNames, 'vec4(0.0)')}
}
vec4 loadFullResColor() {
    uint group = splat.index / ${groupSize}u;
    ivec2 uv = fullResolutionUv(splat.index);
${glslBranches(colorNames, 'vec4(0.0)')}
}
`;

    const readWGSLData = `
fn loadTransformA() -> vec4<u32> {
    let group = splat.index / ${groupSize}u;
    let uv = fullResolutionUv(splat.index);
${wgslBranches(transformANames, 'vec4<u32>(0u)')}
}
fn loadTransformB() -> vec4f {
    let group = splat.index / ${groupSize}u;
    let uv = fullResolutionUv(splat.index);
${wgslBranches(transformBNames, 'vec4f(0.0)')}
}
fn loadFullResColor() -> vec4f {
    let group = splat.index / ${groupSize}u;
    let uv = fullResolutionUv(splat.index);
${wgslBranches(colorNames, 'vec4f(0.0)')}
}
`;

    return {
        format: new GSplatFormat(device, [], {
            readGLSL: `${readGLSLData}\n${baseReadGLSL}`,
            readWGSL: `${readWGSLData}\n${baseReadWGSL}`
        }),
        declarations: device.isWebGPU ? wgslDeclarations : glslDeclarations
    };
};

const readGLSL = `
uint tAw;
vec4 tBcached;
vec4 unpackRotation(vec3 data) {
    return vec4(data.xyz, sqrt(max(0.0, 1.0 - dot(data, data))));
}
vec3 getCenter() {
    uvec4 tA = loadTransformA();
    tAw = tA.w;
    tBcached = loadTransformB();
    return uintBitsToFloat(tA.xyz);
}
vec4 getColor() {
    return loadFullResColor();
}
vec4 getRotation() {
    return unpackRotation(vec3(unpackHalf2x16(tAw), tBcached.w)).wxyz;
}
vec3 getScale() {
    return tBcached.xyz;
}
#include "gsplatUncompressedSHVS"
`;

const readWGSL = `
var<private> tAw: u32;
var<private> tBcached: vec4f;
fn unpackRotation(data: vec3f) -> vec4f {
    return vec4f(data.xyz, sqrt(max(0.0, 1.0 - dot(data, data))));
}
fn getCenter() -> vec3f {
    let tA: vec4<u32> = loadTransformA();
    tAw = tA.w;
    tBcached = loadTransformB();
    return bitcast<vec3f>(tA.xyz);
}
fn getColor() -> vec4f {
    return loadFullResColor();
}
fn getRotation() -> vec4f {
    return unpackRotation(vec3f(unpack2x16float(tAw), tBcached.w)).wxyz;
}
fn getScale() -> vec3f {
    return tBcached.xyz;
}
#include "gsplatUncompressedSHVS"
`;

type FullResolutionLayer = 'position' | 'geometric' | 'color';

const visitSourceChunks = async (
    source: ChunkSource,
    pool: ChunkDataPool,
    sourceChunkStart: number,
    sourceChunkEnd: number,
    layers: FullResolutionLayer[],
    callback: (buffers: Record<FullResolutionLayer, any>, count: number, destinationStart: number, sourceChunkIndex: number) => void
) => {
    const sourceChunkSize = source.meta.chunkSize;

    for (let sourceChunkIndex = sourceChunkStart; sourceChunkIndex < sourceChunkEnd; sourceChunkIndex++) {
        const sourceStart = sourceChunkIndex * sourceChunkSize;
        const count = Math.min(sourceChunkSize, source.meta.numGaussians - sourceStart);
        const buffers: Record<FullResolutionLayer, any> = {} as Record<FullResolutionLayer, any>;

        for (const layer of layers) {
            buffers[layer] = pool.acquire(layer, source.meta.layouts[layer]!, count);
        }

        try {
            await source.read({
                chunkIndex: sourceChunkIndex,
                lod: 0,
                ...buffers
            } as any);
            callback(buffers, count, sourceStart - sourceChunkStart * sourceChunkSize, sourceChunkIndex);
        } finally {
            for (const layer of layers) {
                buffers[layer].release();
            }
        }
    }
};

const uploadContainer = async (
    source: ChunkSource,
    pool: ChunkDataPool,
    container: FullResolutionContainer,
    sourceChunkStart: number,
    sourceChunkEnd: number,
    destinationCount: number,
    singlePass = false
) => {
    const colorLayout = source.meta.layouts.color!;
    const colorStride = colorLayout.stride >>> 2;
    const float2Half = FloatPacking.float2Half;
    const SH_C0 = 0.28209479177387814;
    // WebGPU sorts from the uploaded GPU data. Avoid allocating a duplicate
    // 12-byte-per-splat CPU center array there; WebGL still needs centers for
    // its worker-based sorter.
    const centers = container.device.isWebGPU ? null : new Float32Array(destinationCount * 3);
    if (centers) {
        container.centers = centers;
    }

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    // Upload color and collect the sorter centers. Each group is uploaded as
    // one complete group-texture update, keeping the largest CPU staging block
    // at roughly 200 MB even for an 11 GB source PLY.
    for (let group = 0; group < container.groupCount; group++) {
        const groupStart = sourceChunkStart + group * FULL_RESOLUTION_GROUP_CHUNKS;
        const groupEnd = Math.min(groupStart + FULL_RESOLUTION_GROUP_CHUNKS, sourceChunkEnd);
        const colorData = container.createGroupData('fullResColor', group) as Uint16Array;
        const transformAData = singlePass ? container.createGroupData('transformA', group) as Uint32Array : null;
        const transformBData = singlePass ? container.createGroupData('transformB', group) as Uint16Array : null;
        // The callback is synchronous and the groups are processed serially;
        // this keeps source buffers short-lived without retaining a closure
        // over the loop's mutable AABB variables.
        // eslint-disable-next-line no-loop-func
        await visitSourceChunks(source, pool, groupStart, groupEnd, ['position', 'geometric', 'color'], (buffers, count, _destinationStart, sourceChunkIndex) => {
            const positionData = new Float32Array(buffers.position.data, 0, count * 3);
            const geometricData = new Float32Array(buffers.geometric.data, 0, count * 8);
            const colorValues = new Float32Array(buffers.color.data, 0, count * colorStride);
            const layerOffset = (sourceChunkIndex - groupStart) * source.meta.chunkSize * 4;
            const transformA = transformAData;
            const transformAFloat = transformA ? new Float32Array(
                transformA.buffer,
                transformA.byteOffset,
                transformA.byteLength / 4
            ) : null;
            const transformB = transformBData;

            for (let i = 0; i < count; i++) {
                const positionIndex = i * 3;
                const geometricIndex = i * 8;
                const colorIndex = i * colorStride;
                const px = positionData[positionIndex];
                const py = positionData[positionIndex + 1];
                const pz = positionData[positionIndex + 2];
                const globalIndex = sourceChunkIndex * source.meta.chunkSize + i;
                const centerIndex = globalIndex * 3;
                if (centers) {
                    centers[centerIndex] = px;
                    centers[centerIndex + 1] = py;
                    centers[centerIndex + 2] = pz;
                }

                const rawScaleX = geometricData[geometricIndex + 4];
                const rawScaleY = geometricData[geometricIndex + 5];
                const rawScaleZ = geometricData[geometricIndex + 6];
                const scale = Math.exp(Math.max(rawScaleX, rawScaleY, rawScaleZ));
                const colorValue = layerOffset + i * 4;
                colorData[colorValue] = float2Half(colorValues[colorIndex] * SH_C0 + 0.5);
                colorData[colorValue + 1] = float2Half(colorValues[colorIndex + 1] * SH_C0 + 0.5);
                colorData[colorValue + 2] = float2Half(colorValues[colorIndex + 2] * SH_C0 + 0.5);
                colorData[colorValue + 3] = float2Half(sigmoid(geometricData[geometricIndex + 7]));

                if (isFinite(px) && isFinite(py) && isFinite(pz) && isFinite(scale)) {
                    const extent = 2 * scale;
                    minX = Math.min(minX, px - extent);
                    minY = Math.min(minY, py - extent);
                    minZ = Math.min(minZ, pz - extent);
                    maxX = Math.max(maxX, px + extent);
                    maxY = Math.max(maxY, py + extent);
                    maxZ = Math.max(maxZ, pz + extent);
                }

                if (singlePass) {
                    const qx = geometricData[geometricIndex + 1];
                    const qy = geometricData[geometricIndex + 2];
                    const qz = geometricData[geometricIndex + 3];
                    let qw = geometricData[geometricIndex];
                    const qLength = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1;
                    let normalizedQx = qx / qLength;
                    let normalizedQy = qy / qLength;
                    let normalizedQz = qz / qLength;
                    qw /= qLength;
                    if (qw < 0) {
                        normalizedQx = -normalizedQx;
                        normalizedQy = -normalizedQy;
                        normalizedQz = -normalizedQz;
                        qw = -qw;
                    }

                    const transformValueIndex = layerOffset + i * 4;
                    transformAFloat![transformValueIndex] = px;
                    transformAFloat![transformValueIndex + 1] = py;
                    transformAFloat![transformValueIndex + 2] = pz;
                    transformA![transformValueIndex + 3] = float2Half(normalizedQx) | float2Half(normalizedQy) << 16;
                    transformB![transformValueIndex] = float2Half(Math.exp(geometricData[geometricIndex + 4]));
                    transformB![transformValueIndex + 1] = float2Half(Math.exp(geometricData[geometricIndex + 5]));
                    transformB![transformValueIndex + 2] = float2Half(Math.exp(geometricData[geometricIndex + 6]));
                    transformB![transformValueIndex + 3] = float2Half(normalizedQz);
                }
            }
        });
        container.uploadGroup('fullResColor', group, colorData);
        if (singlePass) {
            container.uploadGroup('transformA', group, transformAData!);
            container.uploadGroup('transformB', group, transformBData!);
        }
        pool.trim(0);
    }

    // Upload the transform streams in the same bounded groups. Each source
    // chunk occupies a fixed row block, so the global sorter index still maps
    // to exactly the same Gaussian as the normal single-texture path.
    if (!singlePass) {
        for (let group = 0; group < container.groupCount; group++) {
            const groupStart = sourceChunkStart + group * FULL_RESOLUTION_GROUP_CHUNKS;
            const groupEnd = Math.min(groupStart + FULL_RESOLUTION_GROUP_CHUNKS, sourceChunkEnd);
            const transformAData = container.createGroupData('transformA', group) as Uint32Array;
            const transformBData = container.createGroupData('transformB', group) as Uint16Array;
            await visitSourceChunks(source, pool, groupStart, groupEnd, ['position', 'geometric'], (buffers, count, _destinationStart, sourceChunkIndex) => {
                const positionData = new Float32Array(buffers.position.data, 0, count * 3);
                const geometricData = new Float32Array(buffers.geometric.data, 0, count * 8);
                const layerOffset = (sourceChunkIndex - groupStart) * source.meta.chunkSize * 4;
                const transformA = transformAData;
                const transformAFloat = new Float32Array(transformA.buffer, transformA.byteOffset, transformA.byteLength / 4);
                const transformB = transformBData;

                for (let i = 0; i < count; i++) {
                    const positionIndex = i * 3;
                    const geometricIndex = i * 8;
                    const px = positionData[positionIndex];
                    const py = positionData[positionIndex + 1];
                    const pz = positionData[positionIndex + 2];
                    const qx = geometricData[geometricIndex + 1];
                    const qy = geometricData[geometricIndex + 2];
                    const qz = geometricData[geometricIndex + 3];
                    let qw = geometricData[geometricIndex];
                    const qLength = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1;
                    let normalizedQx = qx / qLength;
                    let normalizedQy = qy / qLength;
                    let normalizedQz = qz / qLength;
                    qw /= qLength;
                    if (qw < 0) {
                        normalizedQx = -normalizedQx;
                        normalizedQy = -normalizedQy;
                        normalizedQz = -normalizedQz;
                        qw = -qw;
                    }

                    const valueIndex = layerOffset + i * 4;
                    transformAFloat[valueIndex] = px;
                    transformAFloat[valueIndex + 1] = py;
                    transformAFloat[valueIndex + 2] = pz;
                    transformA[valueIndex + 3] = float2Half(normalizedQx) | float2Half(normalizedQy) << 16;
                    transformB[valueIndex] = float2Half(Math.exp(geometricData[geometricIndex + 4]));
                    transformB[valueIndex + 1] = float2Half(Math.exp(geometricData[geometricIndex + 5]));
                    transformB[valueIndex + 2] = float2Half(Math.exp(geometricData[geometricIndex + 6]));
                    transformB[valueIndex + 3] = float2Half(normalizedQz);
                }
            });
            container.uploadGroup('transformA', group, transformAData);
            container.uploadGroup('transformB', group, transformBData);
            pool.trim(0);
        }
    }

    if (isFinite(minX)) {
        container.aabb.center.set((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
        container.aabb.halfExtents.set((maxX - minX) * 0.5, (maxY - minY) * 0.5, (maxZ - minZ) * 0.5);
    } else {
        container.aabb.center.set(0, 0, 0);
        container.aabb.halfExtents.set(1, 1, 1);
    }
};

type FullResolutionSourceOptions = {
    /** Reopen the source for a later lossless export. */
    createSource: () => Promise<ChunkSource>;
    /** Release any source/pool retained by the caller after resource destroy. */
    closeSource?: () => void | Promise<void>;
    /** Read each source chunk once while filling all destination streams. */
    singlePassUpload?: boolean;
};

/**
 * Upload a single-LOD ChunkSource directly into the full-resolution GPU
 * resource. Keeping this separate from the file loader lets selection tools
 * create a new tile from an already filtered/transformed source without first
 * materializing a PLY Blob and parsing it again.
 */
const createFullResolutionPlyResourceFromSource = async (
    source: ChunkSource,
    device: GraphicsDevice,
    options: FullResolutionSourceOptions
): Promise<FullResolutionPlyResource> => {
    const hasGaussianLayers = source.meta.availableLayers.has('position') &&
        source.meta.availableLayers.has('geometric') &&
        source.meta.availableLayers.has('color');
    if (!hasGaussianLayers || source.meta.numLods !== 1 || source.meta.numGaussians <= 0) {
        throw new Error('The selected source is not a non-empty single-LOD Gaussian source');
    }

    const sourceNumSplats = source.meta.numGaussians;
    const sourceChunkSize = source.meta.chunkSize;
    const sourceChunkCount = source.meta.numChunks[0];
    const groupCount = Math.ceil(sourceChunkCount / FULL_RESOLUTION_GROUP_CHUNKS);
    const { format, declarations } = createFullResolutionFormat(device, groupCount, sourceChunkSize, readGLSL, readWGSL);
    const uploadPool = createChunkDataPool({ chunkSize: sourceChunkSize });
    const chunks: FullResolutionContainer[] = [];
    const shBands = 0;

    try {
        // Keep one PlayCanvas resource so its built-in sorter can interleave
        // every source splat in one GPU draw. Only the upload staging arrays
        // are streamed in two passes; no whole-output PLY is allocated.
        const container = new FullResolutionContainer(
            device,
            sourceNumSplats,
            format,
            shBands,
            sourceChunkSize,
            declarations
        );
        chunks.push(container);
        await uploadContainer(
            source,
            uploadPool,
            container,
            0,
            sourceChunkCount,
            sourceNumSplats,
            options.singlePassUpload ?? false
        );

        const aabb = new BoundingBox();
        aabb.copy(container.aabb);
        let destroyed = false;

        return {
            kind: 'full-resolution-ply',
            device,
            chunks,
            numSplats: sourceNumSplats,
            sourceNumSplats,
            sourceIndexForDisplayIndex: (displayIndex: number) => displayIndex,
            displayIndexForSourceIndex: (sourceIndex: number) => sourceIndex,
            isPreview: false,
            sourceShBands: source.meta.shBands,
            shBands,
            aabb,
            transform: source.meta.transform,
            createSource: options.createSource,
            uploadState: (data: Uint8Array) => {
                let offset = 0;
                for (const chunk of chunks) {
                    chunk.uploadState(data.subarray(offset, offset + chunk.maxSplats));
                    offset += chunk.maxSplats;
                }
            },
            destroy: () => {
                if (destroyed) {
                    return;
                }
                destroyed = true;
                for (const chunk of chunks) chunk.destroy();
                chunks.length = 0;
                // Resource destruction is synchronous in PlayCanvas, while a
                // retained file source may need async handle cleanup.
                Promise.resolve(options.closeSource?.()).catch((error) => {
                    console.error('Failed to close the full-resolution PLY source', error);
                });
            }
        };
    } catch (error) {
        for (const chunk of chunks) chunk.destroy();
        chunks.length = 0;
        throw error;
    } finally {
        // The GPU upload has copied each group, so no CPU staging buffer needs
        // to survive after the resource has been created.
        uploadPool.destroy();
    }
};

/**
 * Load a large single-LOD PLY into a streaming display resource without
 * reducing the source row count. Distance LOD is applied by the render shader
 * after upload, and the original source remains available through createSource()
 * for lossless export.
 *
 * Returns null for files small enough for the normal materializing path (and
 * for unsupported multi-LOD/non-Gaussian sources), so callers can retain the
 * existing loader for those cases.
 */
const loadFullResolutionPly = async (
    filename: string,
    fileSystem: ReadFileSystem,
    device: GraphicsDevice
): Promise<FullResolutionPlyResource | null> => {
    if (getInputFormat(filename) !== 'ply') {
        return null;
    }

    const sources = await readFile({
        filename,
        inputFormat: 'ply',
        options: defaultOptions,
        params: [],
        fileSystem
    });
    const source = sources[0];

    try {
        const hasGaussianLayers = source.meta.availableLayers.has('position') &&
            source.meta.availableLayers.has('geometric') &&
            source.meta.availableLayers.has('color');
        if (!hasGaussianLayers || source.meta.numLods !== 1 || source.meta.numGaussians <= FULL_RESOLUTION_NEAR_GAUSSIANS) {
            return null;
        }

        return await createFullResolutionPlyResourceFromSource(source, device, {
            createSource: async () => {
                const reopened = await readFile({
                    filename,
                    inputFormat: 'ply',
                    options: defaultOptions,
                    params: [],
                    fileSystem
                });

                if (reopened.length !== 1 || !reopened[0]) {
                    for (const current of reopened) {
                        await current.close();
                    }
                    throw new Error(`Expected one PLY source while exporting '${filename}'`);
                }

                return reopened[0];
            }
        });
    } finally {
        for (const current of sources) {
            await current.close();
        }
    }
};

export {
    FULL_RESOLUTION_NEAR_GAUSSIANS,
    FullResolutionPlyResource,
    FullResolutionSelectionGroup,
    createFullResolutionPlyResourceFromSource,
    isFullResolutionPlyResource,
    loadFullResolutionPly
};
