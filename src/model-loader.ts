import { path } from 'playcanvas';

type ModelImportFile = {
    filename: string;
    url?: string;
    contents?: Blob | ArrayBuffer;
};

type ModelSource = {
    url: string;
    contents: ArrayBuffer | null;
    cleanup: () => void;
};

const isGltfModel = (filename: string) => {
    const cleanFilename = filename.split(/[?#]/)[0].toLowerCase();
    return cleanFilename.endsWith('.gltf') || cleanFilename.endsWith('.glb');
};

const getExtension = (filename: string) => {
    const cleanFilename = filename.split(/[?#]/)[0].toLowerCase();
    return path.getExtension(cleanFilename);
};

const getMimeType = (filename: string) => {
    switch (getExtension(filename)) {
        case '.gltf': return 'model/gltf+json';
        case '.glb': return 'model/gltf-binary';
        case '.bin': return 'application/octet-stream';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.png': return 'image/png';
        case '.webp': return 'image/webp';
        case '.avif': return 'image/avif';
        case '.gif': return 'image/gif';
        case '.svg': return 'image/svg+xml';
        case '.ktx2': return 'image/ktx2';
        case '.basis': return 'application/octet-stream';
        default: return 'application/octet-stream';
    }
};

const readContents = async (contents: Blob | ArrayBuffer) => {
    if (contents instanceof ArrayBuffer) {
        return contents;
    }
    return await contents.arrayBuffer();
};

const createObjectUrl = (contents: Blob | ArrayBuffer, filename: string, urls: string[]) => {
    const blob = contents instanceof Blob ? contents : new Blob([contents], { type: getMimeType(filename) });
    const url = URL.createObjectURL(blob);
    urls.push(url);
    return url;
};

const decodePathPart = (part: string) => {
    try {
        return decodeURIComponent(part);
    } catch {
        return part;
    }
};

// Normalize paths in the same form for browser file drops and glTF URI references.
const normalizePath = (filename: string) => {
    const cleanFilename = filename.replace(/\\/g, '/').split(/[?#]/)[0];
    const parts: string[] = [];

    cleanFilename.split('/').forEach((part) => {
        const decoded = decodePathPart(part);
        if (!decoded || decoded === '.') {
            return;
        }
        if (decoded === '..') {
            parts.pop();
        } else {
            parts.push(decoded.toLowerCase());
        }
    });

    return parts.join('/');
};

const getBasename = (filename: string) => {
    const normalized = normalizePath(filename);
    return normalized.substring(normalized.lastIndexOf('/') + 1);
};

const isExternalUri = (uri: string) => {
    return uri.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(uri);
};

class LocalResourceResolver {
    private readonly files: ModelImportFile[];
    private readonly mainDirectory: string;
    private readonly urls: string[];
    private readonly urlCache = new Map<ModelImportFile, string>();

    constructor(files: ModelImportFile[], mainFilename: string, urls: string[]) {
        this.files = files.filter(file => !!file.contents);
        const mainPath = normalizePath(mainFilename);
        const separator = mainPath.lastIndexOf('/');
        this.mainDirectory = separator === -1 ? '' : mainPath.substring(0, separator + 1);
        this.urls = urls;
    }

    resolve(uri: string) {
        const resourcePath = uri.split(/[?#]/)[0];
        const normalizedUri = normalizePath(resourcePath);
        const candidates = [
            normalizePath(`${this.mainDirectory}${resourcePath}`),
            normalizedUri
        ];

        for (const candidate of candidates) {
            const match = this.files.find(file => normalizePath(file.filename) === candidate);
            if (match) {
                return match;
            }
        }

        const basename = getBasename(resourcePath);
        const basenameMatches = this.files.filter(file => getBasename(file.filename) === basename);
        return basenameMatches.length === 1 ? basenameMatches[0] : null;
    }

    getUrl(file: ModelImportFile) {
        const cached = this.urlCache.get(file);
        if (cached) {
            return cached;
        }

        if (!file.contents) {
            throw new Error(`The glTF resource '${file.filename}' has no local contents.`);
        }

        const url = createObjectUrl(file.contents, file.filename, this.urls);
        this.urlCache.set(file, url);
        return url;
    }
}

const rewriteGltfUris = (gltf: any, resolver: LocalResourceResolver, mainFilename: string) => {
    const resources = [...(gltf.buffers ?? []), ...(gltf.images ?? [])];
    let changed = false;

    resources.forEach((resource: any) => {
        if (typeof resource.uri !== 'string' || isExternalUri(resource.uri)) {
            return;
        }

        const file = resolver.resolve(resource.uri);
        if (!file) {
            throw new Error(
                `Missing glTF resource '${resource.uri}' referenced by '${mainFilename}'. ` +
                'Select the .bin and texture files together with the .gltf file.'
            );
        }

        resource.uri = resolver.getUrl(file);
        changed = true;
    });

    return changed;
};

type GlbChunk = {
    type: number;
    data: Uint8Array;
};

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;

const padToFourBytes = (length: number) => (length + 3) & ~3;

const rewriteGlbContents = (
    contents: ArrayBuffer,
    resolver: LocalResourceResolver,
    mainFilename: string
) => {
    if (contents.byteLength < 12) {
        return contents;
    }

    const bytes = new Uint8Array(contents);
    const view = new DataView(contents);
    if (view.getUint32(0, true) !== GLB_MAGIC) {
        return contents;
    }

    const chunks: GlbChunk[] = [];
    let offset = 12;
    let jsonChunkIndex = -1;

    while (offset + 8 <= bytes.byteLength) {
        const length = view.getUint32(offset, true);
        const type = view.getUint32(offset + 4, true);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd > bytes.byteLength) {
            return contents;
        }

        chunks.push({ type, data: bytes.slice(dataStart, dataEnd) });
        if (type === GLB_JSON_CHUNK && jsonChunkIndex === -1) {
            jsonChunkIndex = chunks.length - 1;
        }
        offset = dataEnd;
    }

    if (jsonChunkIndex === -1) {
        return contents;
    }

    const jsonText = new TextDecoder().decode(chunks[jsonChunkIndex].data).replace(/\0+$/g, '');
    const gltf = JSON.parse(jsonText);
    const changed = rewriteGltfUris(gltf, resolver, mainFilename);
    if (!changed) {
        return contents;
    }

    const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
    const paddedJson = new Uint8Array(padToFourBytes(jsonBytes.byteLength));
    paddedJson.set(jsonBytes);
    paddedJson.fill(0x20, jsonBytes.byteLength);
    chunks[jsonChunkIndex].data = paddedJson;

    const totalLength = chunks.reduce((total, chunk) => total + 8 + chunk.data.byteLength, 12);
    const output = new Uint8Array(totalLength);
    const outputView = new DataView(output.buffer);
    outputView.setUint32(0, GLB_MAGIC, true);
    outputView.setUint32(4, view.getUint32(4, true), true);
    outputView.setUint32(8, totalLength, true);

    offset = 12;
    chunks.forEach((chunk) => {
        outputView.setUint32(offset, chunk.data.byteLength, true);
        outputView.setUint32(offset + 4, chunk.type, true);
        output.set(chunk.data, offset + 8);
        offset += 8 + chunk.data.byteLength;
    });

    return output.buffer;
};

const prepareModelSource = async (files: ModelImportFile[], mainFile: ModelImportFile): Promise<ModelSource> => {
    if (!mainFile.contents) {
        if (!mainFile.url) {
            throw new Error(`Unable to load '${mainFile.filename}': no file contents or URL was provided.`);
        }

        return {
            url: mainFile.url,
            contents: null,
            cleanup: () => {}
        };
    }

    const urls: string[] = [];
    const cleanup = () => {
        urls.splice(0).forEach(url => URL.revokeObjectURL(url));
    };

    try {
        const resolver = new LocalResourceResolver(files, mainFile.filename, urls);
        let contents = await readContents(mainFile.contents);

        if (getExtension(mainFile.filename) === '.gltf') {
            const gltf = JSON.parse(new TextDecoder().decode(contents));
            const changed = await rewriteGltfUris(gltf, resolver, mainFile.filename);
            if (changed) {
                contents = new TextEncoder().encode(JSON.stringify(gltf)).buffer as ArrayBuffer;
            }
        } else {
            contents = await rewriteGlbContents(contents, resolver, mainFile.filename);
        }

        return {
            url: createObjectUrl(contents, mainFile.filename, urls),
            contents,
            cleanup
        };
    } catch (error) {
        cleanup();
        throw error;
    }
};

export { isGltfModel, ModelImportFile, prepareModelSource };
