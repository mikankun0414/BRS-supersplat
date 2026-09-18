import * as fs from 'fs';
import * as path from 'path';

const files = [
    './node_modules/@playcanvas/splat-transform/dist/index.mjs',
    './node_modules/@playcanvas/splat-transform/dist/cli.mjs'
];

const radixSortFunc = `
const radixSortIndices = (order, keys) => {
    const n = order.length;
    let src = order;
    let dst = new Uint32Array(n);
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
`;

const targetSortCode = 'order.sort((a, b) => morton[a] - morton[b]);';
const replacementSortCode = 'if (order.length > 256) { radixSortIndices(order, morton); } else { order.sort((a, b) => morton[a] - morton[b]); }';

for (const relPath of files) {
    const absPath = path.resolve(relPath);
    if (!fs.existsSync(absPath)) continue;
    let content = fs.readFileSync(absPath, 'utf8');

    if (!content.includes('const radixSortIndices =')) {
        // Prepend radixSortIndices before sortMortonStrided
        const stridedIdx = content.indexOf('const sortMortonStrided =');
        if (stridedIdx !== -1) {
            content = content.slice(0, stridedIdx) + radixSortFunc + '\n' + content.slice(stridedIdx);
        }
    }

    if (content.includes(targetSortCode)) {
        content = content.replaceAll(targetSortCode, replacementSortCode);
        fs.writeFileSync(absPath, content, 'utf8');
        console.log('Patched:', relPath);
    } else {
        console.log('Already patched or target not found in:', relPath);
    }
}
