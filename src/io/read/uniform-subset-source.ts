import { type ChunkData, type ChunkDataPool, type ChunkLayer, type ChunkSource } from '@playcanvas/splat-transform';

/**
 * Create a lazy source that keeps a uniformly distributed subset of a source.
 *
 * The parent is read one chunk at a time and only the selected rows are copied
 * into the output buffers. This keeps large PLY files from being materialized
 * before the caller has chosen a manageable preview size.
 */
const createUniformSubsetSource = (parent: ChunkSource, targetCount: number, pool: ChunkDataPool): ChunkSource => {
    const parentCount = parent.meta.numGaussians;
    const outputCount = Math.min(parentCount, Math.max(1, Math.floor(targetCount)));
    const chunkSize = parent.meta.chunkSize;

    const meta = {
        ...parent.meta,
        numGaussians: outputCount,
        numLods: 1,
        lodCounts: [outputCount],
        numChunks: [Math.ceil(outputCount / chunkSize)]
    };

    // Mapping by formula avoids a second multi-million-entry index buffer.
    const parentIndex = (outputIndex: number) => Math.floor(outputIndex * parentCount / outputCount);

    const copyRows = (source: ChunkData, target: ChunkData, sourceOffset: number, targetOffset: number, count: number) => {
        const wordsPerRow = source.stride >>> 2;
        const sourceWords = new Uint32Array(source.data);
        const targetWords = new Uint32Array(target.data);

        for (let row = 0; row < count; row++) {
            const sourceStart = (sourceOffset + row) * wordsPerRow;
            const targetStart = (targetOffset + row) * wordsPerRow;
            targetWords.set(sourceWords.subarray(sourceStart, sourceStart + wordsPerRow), targetStart);
        }
    };

    const read = async (request: Parameters<ChunkSource['read']>[0]): Promise<void> => {
        if ('indices' in request) {
            const mapped = new Uint32Array(request.count);
            for (let i = 0; i < request.count; i++) {
                mapped[i] = parentIndex(request.indices[request.indexOffset + i]);
            }

            await parent.read({
                indices: mapped,
                indexOffset: 0,
                count: request.count,
                lod: 0,
                position: request.position,
                geometric: request.geometric,
                color: request.color,
                other: request.other
            });
            return;
        }

        const outputStart = request.chunkIndex * chunkSize;
        const outputChunkCount = Math.min(chunkSize, outputCount - outputStart);
        if (outputChunkCount <= 0) {
            throw new Error(`uniform subset chunk index out of range: ${request.chunkIndex}`);
        }

        const wanted: { layer: ChunkLayer, output: ChunkData }[] = [];
        if (request.position) wanted.push({ layer: 'position', output: request.position });
        if (request.geometric) wanted.push({ layer: 'geometric', output: request.geometric });
        if (request.color) wanted.push({ layer: 'color', output: request.color });
        if (request.other) wanted.push({ layer: 'other', output: request.other });
        if (wanted.length === 0) return;

        let outputOffset = 0;
        while (outputOffset < outputChunkCount) {
            const firstParentIndex = parentIndex(outputStart + outputOffset);
            const parentChunkIndex = Math.floor(firstParentIndex / chunkSize);
            const parentChunkStart = parentChunkIndex * chunkSize;
            const parentChunkCount = Math.min(chunkSize, parentCount - parentChunkStart);
            const parentChunkEnd = parentChunkStart + parentChunkCount;

            let groupCount = 1;
            while (outputOffset + groupCount < outputChunkCount &&
                   parentIndex(outputStart + outputOffset + groupCount) < parentChunkEnd) {
                groupCount++;
            }

            const parentRequest = {
                chunkIndex: parentChunkIndex,
                lod: 0,
                position: undefined as ChunkData | undefined,
                geometric: undefined as ChunkData | undefined,
                color: undefined as ChunkData | undefined,
                other: undefined as ChunkData | undefined
            };
            const temporaries: { temporary: ChunkData, output: ChunkData }[] = [];

            for (const { layer, output } of wanted) {
                const layout = parent.meta.layouts[layer];
                if (!layout) continue;

                const temporary = pool.acquire(layer, layout, parentChunkCount);
                parentRequest[layer] = temporary;
                temporaries.push({ temporary, output });
            }

            try {
                await parent.read(parentRequest);

                for (const { temporary, output } of temporaries) {
                    const firstOffset = firstParentIndex - parentChunkStart;
                    copyRows(temporary, output, firstOffset, outputOffset, groupCount);
                }
            } finally {
                for (const { temporary } of temporaries) {
                    temporary.release();
                }
            }

            outputOffset += groupCount;
        }
    };

    return {
        meta,
        read,
        // The caller owns the parent source and closes it with the original
        // source list. Keeping this view close idempotent avoids closing a
        // selected LOD parent twice.
        close: () => Promise.resolve()
    };
};

export { createUniformSubsetSource };
