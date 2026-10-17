#!/usr/bin/env python3
"""Steady-window zonesvr stats per stress run, one table column per run.

    python3 zonesvr_run_stats.py {prom|pyro} <report_dir>... [--names A,B,...] [--json]

Windows come from each report's summary.md. Method: ../2026-10-17-zonesvr-lb-fix.md §2.3, appendix C.
"""
import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime
from pathlib import Path

Z = 'svr="zonesvr"'
ZW = 'svr="zonesvr-worker"'
NON_JS = ':Non JS threads activity:0'
# First match wins, e.g. logger's sab_writer.js counts as ipc.
CATEGORIES = [
    ('ipc', r'sab_\w+\.js|:postMessage:|node:internal/worker:postMessage|messageport'),
    ('tsrpc', r'tsbuffer|tsrpc|cl-tsrpc'),
    ('bson', r'bson'),
    ('redis', r'@redis'),
    ('mongodb', r'node_modules/mongodb/'),
    ('logger', r'pino|/logger/'),
    ('otel', r'opentelemetry|/otel/'),
    ('socket', r':writev:|:writeBuffer:|:writeUtf8String:|:writeLatin1String:'),
    ('gc', r':Garbage Collection:'),
    ('idle', r':\(idle\):'),
]
CATEGORIES = [(n, re.compile(p)) for n, p in CATEGORIES]


def get_json(url, params):
    with urllib.request.urlopen(url + '?' + urllib.parse.urlencode(params), timeout=120) as r:
        return json.load(r)


def iso_to_unix(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()


class Run:
    def __init__(self, report_dir, name):
        text = (Path(report_dir) / 'summary.md').read_text(encoding='utf-8')
        params = json.loads(re.search(r'```json\n(.*?)\n```', text, re.S).group(1))
        self.name = name
        self.start = iso_to_unix(re.search(r'\*\*开始\*\*: (\S+)', text).group(1))
        self.end = iso_to_unix(re.search(r'\*\*结束\*\*: (\S+)', text).group(1))
        self.duration = params['durationMs'] / 1000
        self.ramp = params['rampMs'] / 1000
        self.t = self.start + self.duration
        self.window = f'{int(self.duration - self.ramp)}s'
        self.summary = {k: v.strip() for k, v in re.findall(r'^\| (\w+) \| ([^|]+) \|$', text, re.M)}


class Prom:
    def __init__(self, url, run):
        self.url, self.t, self.w = url, run.t, run.window

    def query(self, expr):
        expr = expr.replace('$W', self.w)
        return get_json(self.url + '/api/v1/query', {'query': expr, 'time': self.t})['data']['result']

    def scalar(self, expr):
        r = self.query(expr)
        return float(r[0]['value'][1]) if r else float('nan')

    def by(self, expr, label):
        return {r['metric'].get(label, '?'): float(r['value'][1]) for r in self.query(expr)}


def fmt(v, digits=0):
    if isinstance(v, dict):
        return ' / '.join(fmt(v[k], digits) for k in sorted(v))
    if isinstance(v, (list, tuple)):
        return ' / '.join(fmt(x, digits) for x in v)
    if isinstance(v, str):
        return v
    if v is None or v != v:
        return '—'
    return f'{v:.{digits}f}'


def role_cpu(p):
    return p.by(f'sum by (thread_role)(avg_over_time(dogsvr_thread_cpu_utilization{{{Z}}}[$W]))', 'thread_role')


def prom_rows(run, url, cmd):
    p = Prom(url, run)
    c, h = f'{Z},cmdId="{cmd}"', f'{ZW},cmd_id="{cmd}"'
    hist = lambda q, sel, metric, grp='': f'histogram_quantile({q}, sum by (le{grp})(rate({metric}_bucket{{{sel}}}[$W])))'
    mean = lambda sel, metric, grp='': (f'sum by ({grp})(rate({metric}_sum{{{sel}}}[$W])) / '
                                        f'sum by ({grp})(rate({metric}_count{{{sel}}}[$W]))')
    cmd_m, hdl_m = 'dogsvr_cmd_duration_milliseconds', 'dogsvr_worker_cmd_hdl_duration_milliseconds'
    mongo = f'{ZW},coll="role_coll",op="find.toArray"'
    qps = p.scalar(f'sum(rate({cmd_m}_count{{{c}}}[$W]))')
    roles = role_cpu(p)
    total = sum(roles.values())
    mb = lambda d: {k: v / 1e6 for k, v in d.items()}
    rows = [
        ('cmd QPS', qps, 1),
        ('cmd mean (ms)', p.scalar(f'sum(rate({cmd_m}_sum{{{c}}}[$W])) / sum(rate({cmd_m}_count{{{c}}}[$W]))'), 1),
        ('cmd p50 / p95 / p99 (ms, bucket-interp)', [p.scalar(hist(q, c, cmd_m)) for q in (0.5, 0.95, 0.99)], 0),
        ('bot RTT p50 / p95 / p99 (ms)', ' / '.join(run.summary.get(k, '—') for k in ('rtt_p50_ms', 'rtt_p95_ms', 'rtt_p99_ms')), 0),
        ('bot error rate', run.summary.get('error_rate', '—'), 0),
        ('hdl rate per worker (/s)', p.by(f'sum by (worker_index)(rate({hdl_m}_count{{{h}}}[$W]))', 'worker_index'), 0),
        ('hdl mean per worker (ms)', p.by(mean(h, hdl_m, 'worker_index'), 'worker_index'), 0),
        ('hdl p50 per worker (ms)', p.by(hist(0.5, h, hdl_m, ', worker_index'), 'worker_index'), 0),
        ('hdl p99 per worker (ms)', p.by(hist(0.99, h, hdl_m, ', worker_index'), 'worker_index'), 0),
        ('worker_cmd_hdl_pending avg', p.by(f'avg by (worker_index)(avg_over_time(dogsvr_worker_cmd_hdl_pending{{{ZW}}}[$W]))', 'worker_index'), 0),
        ('main-side in-flight avg', p.by(f'avg by (worker_index)(avg_over_time(dogsvr_worker_pending{{{Z}}}[$W]))', 'worker_index'), 0),
        ('ELU', p.by(f'avg by (worker_index)(avg_over_time(dogsvr_worker_elu_utilization{{{ZW}}}[$W]))', 'worker_index'), 3),
        ('event loop lag avg (s, incl. 0.010 baseline)', p.by(f'avg by (worker_index)(avg_over_time(dogsvr_worker_eventloop_lag_seconds{{{ZW}}}[$W]))', 'worker_index'), 3),
        ('GC (s/s)', p.by(f'sum by (worker_index)(rate(dogsvr_worker_gc_duration_seconds_sum{{{ZW}}}[$W]))', 'worker_index'), 3),
        ('heap peak (MB)', mb(p.by(f'max by (worker_index)(max_over_time(dogsvr_worker_heap_used_bytes{{{ZW}}}[$W]))', 'worker_index')), 0),
        ('mongo role_coll.find mean (ms)', p.by(mean(mongo, 'mongo_op_duration_milliseconds', 'service_instance_id'), 'service_instance_id'), 0),
        ('mongo role_coll.find p99 (ms)', p.by(hist(0.99, mongo, 'mongo_op_duration_milliseconds', ', service_instance_id'), 'service_instance_id'), 0),
    ]
    for op in ('zRangeWithScores', 'zRevRank'):
        rows.append((f'redis {op} p99 (ms)', p.by(hist(0.99, f'{ZW},op="{op}"', 'redis_op_duration_milliseconds', ', service_instance_id'), 'service_instance_id'), 0))
    tids = p.query(f'avg_over_time(dogsvr_thread_cpu_utilization{{{Z},thread_role="worker"}}[$W])')
    rows += [
        ('thread CPU main / worker / internal / logger (cores)', [roles.get(k, float('nan')) for k in ('main', 'worker', 'internal', 'logger_central')], 3),
        ('thread CPU per worker tid (cores)', sorted(float(r['value'][1]) for r in tids), 3),
        ('thread CPU process total (cores)', total, 3),
        ('per query main / worker / internal / logger (us)', [1e6 * roles.get(k, float('nan')) / qps for k in ('main', 'worker', 'internal', 'logger_central')], 0),
        ('per query process total (us)', 1e6 * total / qps, 0),
        ('rss peak (MB)', p.scalar(f'max_over_time(dogsvr_process_rss_bytes{{{Z}}}[$W])') / 1e6, 0),
        ('SAB fallback rate (/s)', p.scalar(f'sum(rate(dogsvr_msg_channel_fallback_total{{{Z}}}[$W]))'), 2),
    ]
    return rows


def flame(url, frm, until, selector):
    q = f'wall:cpu:nanoseconds:wall:nanoseconds{{service_name="zonesvr",{selector}}}'
    fb = get_json(url + '/pyroscope/render', {'query': q, 'from': int(frm), 'until': int(until),
                                              'format': 'json', 'max-nodes': '0'})['flamebearer']
    selfs = defaultdict(float)
    for level in fb['levels']:
        for j in range(0, len(level), 4):  # [offset, total, self, nameIndex]
            selfs[fb['names'][level[j + 3]]] += level[j + 2] / 1e9
    return fb['numTicks'] / 1e9, selfs


def categorize(selfs):
    out = defaultdict(float)
    for name, v in selfs.items():
        if name == NON_JS:
            continue
        out[next((c for c, rx in CATEGORIES if rx.search(name)), 'other')] += v
    return out


def pyro_stats(run, prom_url, pyro_url, cmd):
    p = Prom(prom_url, run)
    qps = p.scalar(f'sum(rate(dogsvr_cmd_duration_milliseconds_count{{{Z},cmdId="{cmd}"}}[$W]))')
    roles = role_cpu(p)
    workers = sorted(p.by(f'avg by (worker_index)(avg_over_time(dogsvr_worker_elu_utilization{{{ZW}}}[$W]))', 'worker_index'))
    frm, until = run.start + run.ramp + 15, run.t
    us = lambda share, cores: 1e6 * share * cores / qps

    m_tot, m_self = flame(pyro_url, frm, until, 'thread="main"')
    m_js = m_tot - m_self.get(NON_JS, 0)
    main = {k: us(v / m_js, roles['main']) for k, v in categorize(m_self).items()}

    w_tot, w_self = 0.0, defaultdict(float)
    for i in workers:
        tot, s = flame(pyro_url, frm, until, f'thread="worker",worker_index="{i}"')
        w_tot += tot
        for k, v in s.items():
            w_self[k] += v
    worker = {k: us(v / w_tot, roles['worker']) for k, v in categorize(w_self).items()}

    pick = lambda s, key: sum(v for n, v in s.items() if key in n)
    direction = {
        'main commit (main->worker)': us(pick(m_self, 'sab_ring.js:commit') / m_js, roles['main']),
        'main park': us(pick(m_self, 'sab_pump.js:park') / m_js, roles['main']),
        'worker commit (worker->main)': us(pick(w_self, 'sab_ring.js:commit') / w_tot, roles['worker']),
        'worker park': us(pick(w_self, 'sab_pump.js:park') / w_tot, roles['worker']),
    }

    whole = 0.0
    for sel in ['thread="main"'] + [f'thread="worker",worker_index="{i}"' for i in workers]:
        whole += flame(pyro_url, run.start, run.end, sel)[0]
    return {'main': main, 'worker': worker, 'direction': direction,
            'pyro_whole_run_s': whole, 'proc_steady_cores': sum(roles.values())}


def table(title, names, rows):
    print(f'\n**{title}**\n')
    print('| | ' + ' | '.join(names) + ' |')
    print('|---|' + '---:|' * len(names))
    for label, cells in rows:
        print(f'| {label} | ' + ' | '.join(cells) + ' |')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('mode', choices=['prom', 'pyro'])
    ap.add_argument('reports', nargs='+', help='report directories (reports/<ts>-<scenario>)')
    ap.add_argument('--names', help='comma-separated column names; default: report timestamp')
    ap.add_argument('--cmd-id', default='20004', help='cmd used for QPS and per-query normalization')
    ap.add_argument('--prom', default='http://127.0.0.1:9090')
    ap.add_argument('--pyro', default='http://127.0.0.1:4040')
    ap.add_argument('--json', action='store_true', help='dump raw values instead of a markdown table')
    a = ap.parse_args()
    names = a.names.split(',') if a.names else [Path(r.rstrip('/')).name[:16] for r in a.reports]
    if len(names) != len(a.reports):
        sys.exit('--names must match the number of report directories')
    if not a.cmd_id.isdigit():
        sys.exit('--cmd-id must be a number')
    runs = [Run(r, n) for r, n in zip(a.reports, names)]

    if a.mode == 'prom':
        per_run = [prom_rows(r, a.prom, a.cmd_id) for r in runs]
        if a.json:
            print(json.dumps({r.name: {lbl: v for lbl, v, _ in rows} for r, rows in zip(runs, per_run)}, ensure_ascii=False, indent=1))
            return
        table('Prometheus steady window', names,
              [(lbl, [fmt(rows[i][1], d) for rows in per_run]) for i, (lbl, _, d) in enumerate(per_run[0])])
        return

    stats = [pyro_stats(r, a.prom, a.pyro, a.cmd_id) for r in runs]
    if a.json:
        print(json.dumps({r.name: s for r, s in zip(runs, stats)}, indent=1))
        return
    for side in ('main', 'worker'):
        cats = sorted({c for s in stats for c in s[side]}, key=lambda c: -stats[0][side].get(c, 0))
        rows = [(c, [fmt(s[side].get(c, 0), 1) for s in stats]) for c in cats]
        rows.append(('total', [fmt(sum(s[side].values()), 0) for s in stats]))
        table(f'{side} per query (us), Pyroscope share x /proc CPU', names, rows)
    table('SAB commit / park self time per query (us)', names,
          [(k, [fmt(s['direction'][k], 2) for s in stats]) for k in stats[0]['direction']])
    table('whole-run Pyroscope total vs /proc (noise check)', names,
          [('Pyroscope whole run (s)', [fmt(s['pyro_whole_run_s'], 1) for s in stats]),
           ('/proc steady (cores)', [fmt(s['proc_steady_cores'], 3) for s in stats])])


if __name__ == '__main__':
    main()
