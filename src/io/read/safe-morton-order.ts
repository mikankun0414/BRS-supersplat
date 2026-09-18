/**
 * Safe Morton (Z-order) sorting using 32-bit radix sort.
 * Avoids V8's "RangeError: Custom comparefn not supported for huge TypedArrays".
 */

const radixSortIndices = (order: Uint32Array, keys: Uint32Array) => {
    const n = order.length;
    let src: Uint32Array = order;
    let dst: Uint32Array = new Uint32Array(n);
    const count = new Uint32Array(256);

    for (let shift = 0; shift < 32; shift += 8) {
        count.fill(0);
        for (let i = 0; i < n; i++) {
            count[(keys[src[i]] >>> shift) & 0xff]++;
        }
        let total = 0;
        for (let i = 0; i < 256; i++) {
            const c = count[i];
            count[i] = total;
            total += c;
        }
        for (let i = 0; i < n; i++) {
            dst[count[(keys[src[i]] >>> shift) & 0xff]++] = src[i];
        }
        const tmp = src;
        src = dst;
        dst = tmp;
    }
};

const encodeMorton3 = (x: number, y: number, z: number) => {
    const Part1By2 = (v: number) => {
        v &= 0x000003ff;
        v = (v ^ (v << 16)) & 0xff0000ff;
        v = (v ^ (v << 8)) & 0x0300f00f;
        v = (v ^ (v << 4)) & 0x030c30c3;
        v = (v ^ (v << 2)) & 0x09249249;
        return v;
    };
    return (Part1By2(z) << 2) + (Part1By2(y) << 1) + Part1By2(x);
};

const safeSortMortonStrided = (
    indices: Uint32Array,
    xa: ArrayLike<number>,
    ya: ArrayLike<number>,
    za: ArrayLike<number>,
    stride: number,
    ox: number,
    oy: number,
    oz: number
) => {
    const generate = (subIndices: Uint32Array) => {
        if (subIndices.length === 0) return;

        let mx = Infinity, my = Infinity, mz = Infinity;
        let Mx = -Infinity, My = -Infinity, Mz = -Infinity;
        for (let i = 0; i < subIndices.length; ++i) {
            const b = subIndices[i] * stride;
            const x = xa[b + ox], y = ya[b + oy], z = za[b + oz];
            if (x < mx) mx = x;
            if (x > Mx) Mx = x;
            if (y < my) my = y;
            if (y > My) My = y;
            if (z < mz) mz = z;
            if (z > Mz) Mz = z;
        }
        const xlen = Mx - mx, ylen = My - my, zlen = Mz - mz;
        if (!isFinite(xlen) || !isFinite(ylen) || !isFinite(zlen)) return;
        if (xlen === 0 && ylen === 0 && zlen === 0) return;

        const xmul = (xlen === 0) ? 0 : 1024 / xlen;
        const ymul = (ylen === 0) ? 0 : 1024 / ylen;
        const zmul = (zlen === 0) ? 0 : 1024 / zlen;
        const morton = new Uint32Array(subIndices.length);
        for (let i = 0; i < subIndices.length; ++i) {
            const b = subIndices[i] * stride;
            const ix = Math.min(1023, (xa[b + ox] - mx) * xmul) >>> 0;
            const iy = Math.min(1023, (ya[b + oy] - my) * ymul) >>> 0;
            const iz = Math.min(1023, (za[b + oz] - mz) * zmul) >>> 0;
            morton[i] = encodeMorton3(ix, iy, iz);
        }

        const order = new Uint32Array(subIndices.length);
        for (let i = 0; i < order.length; i++) order[i] = i;

        if (order.length > 256) {
            radixSortIndices(order, morton);
        } else {
            order.sort((a, b) => morton[a] - morton[b]);
        }

        const tmpIndices = subIndices.slice();
        for (let i = 0; i < subIndices.length; ++i) {
            subIndices[i] = tmpIndices[order[i]];
        }

        let start = 0, end = 1;
        while (start < subIndices.length) {
            while (end < subIndices.length && morton[order[end]] === morton[order[start]]) {
                ++end;
            }
            if (end - start > 256) {
                generate(subIndices.subarray(start, end));
            }
            start = end;
        }
    };
    generate(indices);
};

const safeSortMortonOrder = (dataTable: any, indices: Uint32Array) => {
    const xCol = dataTable.getColumnByName('x');
    const yCol = dataTable.getColumnByName('y');
    const zCol = dataTable.getColumnByName('z');
    if (!xCol || !yCol || !zCol) {
        throw new Error('safeSortMortonOrder: DataTable missing x, y, or z column');
    }
    safeSortMortonStrided(indices, xCol.data, yCol.data, zCol.data, 1, 0, 0, 0);
};

export { safeSortMortonOrder, safeSortMortonStrided, radixSortIndices };
