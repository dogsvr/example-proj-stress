// Test-only zonesvr worker entry: runs the real zonesvr_logic.js and injects faults per slot
// through marker files in /tmp/dogsvr-chaos. See README.md.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { workerData, threadId } = require('node:worker_threads');

const EXAMPLE_PROJ = path.resolve(__dirname, '../../example-proj');
const DIR = '/tmp/dogsvr-chaos';
const idx = workerData.workerIndex;

fs.mkdirSync(DIR, { recursive: true });
let ver = 'v0';
try { ver = fs.readFileSync(path.join(DIR, 'version'), 'utf8').trim() || ver; } catch {}

function emit(e, extra) {
    const rec = { ts: Date.now(), e, idx, tid: threadId, ver, ...extra };
    fs.appendFileSync(path.join(DIR, 'events.ndjson'), JSON.stringify(rec) + '\n');
}
const has = (name) => fs.existsSync(path.join(DIR, name));

emit('load');
if (has(`loadfail-${idx}`)) {
    emit('loadfail');
    throw new Error(`chaos: loadfail-${idx}`);
}

// Same module instance as the one zonesvr_logic.js requires (both resolve through the symlink's real path).
const dogsvr = require(require.resolve('@dogsvr/dogsvr/worker_thread', { paths: [EXAMPLE_PROJ] }));
const realWorkerReady = dogsvr.workerReady;
dogsvr.workerReady = (initFn) => realWorkerReady(async () => {
    emit('init_start');
    await initFn();
    if (has(`initfail-${idx}`)) {
        emit('initfail');
        throw new Error(`chaos: initfail-${idx}`);
    }
    if (has(`inithang-${idx}`)) {
        emit('inithang');
        await new Promise(() => {});
    }
    emit('ready');
    setInterval(pollExit, 100).unref();
});

// Unlink first: only the worker that removes the marker exits.
function pollExit() {
    for (const name of [`exit-${idx}`, `exit-t${threadId}`]) {
        try { fs.unlinkSync(path.join(DIR, name)); } catch { continue; }
        emit('exit', { marker: name });
        process.exit(9);
    }
}

require(path.join(EXAMPLE_PROJ, 'dist/servers/zonesvr/zonesvr_logic.js'));
