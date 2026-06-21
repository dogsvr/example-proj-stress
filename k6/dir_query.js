// k6 stress for dir:10000 — DIR_QUERY_ZONE_LIST endpoint.
//
// tsrpc HTTP transport accepts POSTs to `/<serviceName>` with a JSON body
// matching `ReqCommon` (head + innerReq). It returns a JSON `ResCommon` with
// inner_res serialized as a string (the same format business code uses).
//
// We run a ramp-then-hold profile by default. Override via env:
//   STRESS_VUS=200 STRESS_DURATION=120s k6 run dir_query.js

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const DIR_HOST = __ENV.DIR_HOST || '127.0.0.1';
const DIR_PORT = __ENV.DIR_PORT || '10000';
const URL = `http://${DIR_HOST}:${DIR_PORT}/Common`;

const VUS = parseInt(__ENV.STRESS_VUS || '50', 10);
const DURATION = __ENV.STRESS_DURATION || '60s';
const RAMP = __ENV.STRESS_RAMP || '20s';

const innerLatency = new Trend('inner_response_size_bytes');

// dogsvr cmdId for DIR_QUERY_ZONE_LIST. Pinned here to avoid pulling
// example-proj into k6's runtime (k6 runs outside Node).
const CMD_DIR_QUERY_ZONE_LIST = 10001;

export const options = {
    scenarios: {
        ramp_hold: {
            executor: 'ramping-vus',
            startVUs: 1,
            stages: [
                { duration: RAMP, target: VUS },
                { duration: DURATION, target: VUS },
                { duration: '15s', target: 0 },
            ],
            gracefulRampDown: '10s',
        },
    },
    thresholds: {
        'http_req_failed': ['rate<0.01'],          // <1% errors
        'http_req_duration': ['p(99)<1000'],       // p99 < 1s
    },
};

export default function () {
    const body = JSON.stringify({
        head: { cmdId: CMD_DIR_QUERY_ZONE_LIST, openId: '', zoneId: 0 },
        innerReq: JSON.stringify({}),
    });
    const res = http.post(URL, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: '5s',
    });
    const ok = check(res, {
        'status 200': (r) => r.status === 200,
        'body has innerRes': (r) => r.body && r.body.indexOf('innerRes') >= 0,
    });
    if (ok && res.body) {
        innerLatency.add(res.body.length);
    }
    sleep(0.05);  // tiny think-time so we don't run k6 hotter than Linux can spawn TCP conns
}
