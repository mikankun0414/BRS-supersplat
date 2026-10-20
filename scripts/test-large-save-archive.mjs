import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ZipFileSystem as OldWriter, ZipReadFileSystem as OldReader, MemoryFileSystem } from '@playcanvas/splat-transform';
import { loader, sink, source } from './test-large-save-helpers.mjs';

const load = loader();
const { ZipFileSystem } = load('src/io/write/zip-file-system.ts');
const { ZipReadFileSystem } = load('src/io/read/zip-file-system.ts');
const { safeSize, get64 } = load('src/io/zip-utils.ts');
const encoder = new TextEncoder();
const text = bytes => new TextDecoder().decode(bytes);

const out = sink();
const zip = new ZipFileSystem(out);
for (const [name, value] of [['document.json', '{"version":1}'], ['日本語/empty', ''], ['data.bin', '123456789']]) {
    const writer = await zip.createWriter(name);
    await writer.write(encoder.encode(value));
    await writer.close();
}
await zip.close();
assert.ok(out.closed);
const bytes = out.data();
for (const Reader of [ZipReadFileSystem, OldReader]) {
    const fs = new Reader(source(bytes));
    assert.equal(text(await (await fs.createSource('data.bin')).read().readAll()), '123456789');
    assert.equal((await (await fs.createSource('日本語/empty')).read().readAll()).length, 0);
}
const oldOutput = new MemoryFileSystem();
const old = new OldWriter(oldOutput.createWriter('old.zip'));
const entry = await old.createWriter('old.txt');
await entry.write(encoder.encode('legacy'));
await entry.close();
await old.close();
assert.equal(text(await (await new ZipReadFileSystem(source(oldOutput.results.get('old.zip'))).createSource('old.txt')).read().readAll()), 'legacy');

// Independent Python zipfile checks: full CRC, UTF-8 names, deflate, forced
// local ZIP64, archive comments containing a false EOCD, and range streams.
const temp = mkdtempSync(join(tmpdir(), 'supersplat-large-save-'));
try {
    writeFileSync(join(temp, 'local.zip'), bytes);
    execFileSync('python', ['-c', `import zipfile,sys
from pathlib import Path
p=Path(sys.argv[1])
with zipfile.ZipFile(p/'local.zip') as z:
 assert z.testzip() is None
 assert z.read('data.bin') == b'123456789'
 assert z.read('日本語/empty') == b''
with zipfile.ZipFile(p/'python.zip','w',compression=zipfile.ZIP_DEFLATED) as z:
 z.writestr('deflate.txt',b'deflated content'*12345)
 z.comment=b'comment PK'+bytes([5,6])+b' false end'
 with z.open('forced64.bin','w',force_zip64=True) as f: f.write(bytes(range(256))*100)
`, temp]);
    const track = {};
    const fs = new ZipReadFileSystem(source(readFileSync(join(temp, 'python.zip')), track));
    assert.equal(text(await (await fs.createSource('deflate.txt')).read().readAll()), 'deflated content'.repeat(12345));
    const forced = await fs.createSource('forced64.bin');
    assert.equal((await forced.read().readAll()).length, 25600);
    assert.ok(track.max <= 65557);
} finally { rmSync(temp, { recursive: true }); }

// Corrupt content, metadata, descriptor, bounds and truncation reject.
const localHeader = 30 + encoder.encode('document.json').length + 20;
const corrupt = Buffer.from(bytes);
corrupt[localHeader] ^= 1;
await assert.rejects(async () => (await new ZipReadFileSystem(source(corrupt)).createSource('document.json')).read().readAll(), /CRC/);
const brokenDescriptor = Buffer.from(bytes);
brokenDescriptor[localHeader + encoder.encode('{"version":1}').length + 4] ^= 1;
await assert.rejects(() => new ZipReadFileSystem(source(brokenDescriptor)).createSource('document.json'), /descriptor/);
await assert.rejects(() => new ZipReadFileSystem(source(bytes.subarray(0, bytes.length - 1))).list(), /end record/);
const badOffset = Buffer.from(bytes);
badOffset.writeUInt32LE(0xfffffffe, bytes.length - 6);
await assert.rejects(() => new ZipReadFileSystem(source(badOffset)).list(), /bounds/);
assert.throws(() => safeSize(Number.MAX_SAFE_INTEGER + 1), /safe integer/);
assert.throws(() => safeSize(-1), /safe integer/);
const unsafe64 = new DataView(new ArrayBuffer(8));
unsafe64.setBigUint64(0, 9007199254740992n, true);
assert.throws(() => get64(unsafe64, 0), /safe integer/);

// Logical boundary only: private cursor injection simulates sparse offsets.
// No 4GiB payload is allocated or written by this test.
for (const offset of [0xfffffffe, 0xffffffff, 0x100000000]) {
    const output = sink();
    const writer = new ZipFileSystem(output);
    writer.offset = offset;
    const e = await writer.createWriter('late');
    await e.write(encoder.encode('tail'));
    await e.close();
    await writer.close();
    const emitted = output.data();
    const records = [];
    let cursor = offset;
    for (const chunk of output.chunks) { records.push([cursor, chunk]); cursor += chunk.length; }
    const sparse = {
        size: cursor, seekable: true,
        read(start, end) {
            const range = Buffer.alloc(end - start);
            for (const [at, chunk] of records) {
                const a = Math.max(at, start), b = Math.min(at + chunk.length, end);
                if (b > a) range.set(chunk.subarray(a - at, b - at), a - start);
            }
            return source(range).read();
        },
        close() {}
    };
    assert.ok(emitted.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])));
    assert.equal(text(await (await new ZipReadFileSystem(sparse).createSource('late')).read().readAll()), 'tail');
}
// Entry size sentinel and 64-bit descriptor fields, without claiming real I/O.
const logical = sink();
const logicalZip = new ZipFileSystem(logical);
await logicalZip.createWriter('large');
logicalZip.entries[0].size = 0x100000001;
logicalZip.offset += 0x100000001;
await logicalZip.close();
const descriptor = logical.chunks[1];
assert.equal(new DataView(descriptor.buffer).getBigUint64(8, true), 0x100000001n);
assert.ok(logical.data().includes(Buffer.from([1, 0, 16, 0]))); // ZIP64 size extra

// Count sentinel independently from byte offsets.
const countSink = sink();
const countZip = new ZipFileSystem(countSink);
for (let i = 0; i < 65535; i++) await (await countZip.createWriter(`f${i}`)).close();
await countZip.close();
assert.equal((await new ZipReadFileSystem(source(countSink.data())).list()).length, 65535);

// Backpressure: caller cannot complete a write before its sink acknowledges.
let release;
let block = false;
const slow = sink();
const originalWrite = slow.write;
slow.write = async data => { if (block) await new Promise(resolve => { release = resolve; }); await originalWrite(data); };
const slowZip = new ZipFileSystem(slow);
const slowEntry = await slowZip.createWriter('slow');
block = true;
let finished = false;
const pending = slowEntry.write(encoder.encode('bytes')).then(() => { finished = true; });
await Promise.resolve();
assert.equal(finished, false);
release(); await pending; block = false;
await slowZip.close();
for (const phase of ['write', 'close']) {
    const failing = sink();
    failing[phase] = async () => { throw new Error('disk full'); };
    const fs = new ZipFileSystem(failing);
    await assert.rejects(async () => { const w = await fs.createWriter('fail'); await w.write(encoder.encode('x')); await fs.close(); }, /disk full/);
    assert.ok(failing.aborted);
    assert.equal(failing.closed, false);
}
const aborted = sink();
const abortedZip = new ZipFileSystem(aborted);
const abortedEntry = await abortedZip.createWriter('cancelled');
await abortedEntry.abort();
await assert.rejects(() => abortedZip.close(), /closed/);
assert.ok(aborted.aborted);
console.log('PASS archive: legacy compatibility, Python CRC/deflate/ZIP64, malformed input, logical 4GiB/count boundaries, backpressure and abort');
