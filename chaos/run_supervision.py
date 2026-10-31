#!/usr/bin/env python3
"""Fault-injection cases for zonesvr worker supervision. Standard library only; see README.md."""
import argparse
import functools
import json
import os
import shutil
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
STRESS = HERE.parent
EP = STRESS.parent / 'example-proj'
DIST_SVR = EP / 'dist/servers/zonesvr'
SRC_SVR = EP / 'src/servers/zonesvr'
BOTS = STRESS / 'bots'
REPORTS = STRESS / 'reports'
SHIM = HERE / 'zonesvr_chaos_worker.js'
CHAOS = Path('/tmp/dogsvr-chaos')
EVENTS = CHAOS / 'events.ndjson'
PROM = 'http://127.0.0.1:9090'
APP = 'exp-zonesvr'

FAIL = 'dogsvr_cmd_duration_milliseconds_count{svr="zonesvr",ok="0"}'
OK_RANK = 'dogsvr_cmd_duration_milliseconds_count{svr="zonesvr",cmdId="20004",ok="1"}'
TIMEOUTS = 'dogsvr_txn_timeout_total{svr="zonesvr"}'


def now():
    return time.time()


def sh(cmd, timeout=None):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


# ---- config files (dist copies only; src is the restore source)

def write_json_atomic(path, obj):
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(json.dumps(obj, indent=4))
    os.replace(tmp, path)


def restore_configs():
    for name in ('main_thread_config.json', 'worker_thread_config.json'):
        shutil.copyfile(SRC_SVR / name, DIST_SVR / name)


def set_main_cfg(shim=True, **overrides):
    cfg = json.loads((SRC_SVR / 'main_thread_config.json').read_text())
    if shim:
        cfg['workerThreadRunFile'] = str(SHIM)
    cfg.update(overrides)
    write_json_atomic(DIST_SVR / 'main_thread_config.json', cfg)


def set_worker_cfg(**overrides):
    cfg = json.loads((SRC_SVR / 'worker_thread_config.json').read_text())
    cfg.update(overrides)
    write_json_atomic(DIST_SVR / 'worker_thread_config.json', cfg)


def restore_worker_cfg():
    shutil.copyfile(SRC_SVR / 'worker_thread_config.json', DIST_SVR / 'worker_thread_config.json')


# ---- chaos markers and shim events

def reset_chaos(version='v1'):
    CHAOS.mkdir(exist_ok=True)
    for p in CHAOS.iterdir():
        p.unlink()
    set_version(version)


def set_version(v):
    (CHAOS / 'version').write_text(v)


def marker(name, on=True):
    p = CHAOS / name
    if on:
        p.touch()
    elif p.exists():
        p.unlink()


def events(since=0.0):
    if not EVENTS.exists():
        return []
    out = []
    for line in EVENTS.read_text().splitlines():
        if line.strip():
            ev = json.loads(line)
            if ev['ts'] >= since * 1000:
                out.append(ev)
    return out


def wait_event(pred, timeout, since=0.0):
    deadline = now() + timeout
    while now() < deadline:
        for ev in events(since):
            if pred(ev):
                return ev
        time.sleep(0.05)
    raise TimeoutError('event not seen')


def serving_tid(idx):
    """Latest worker of slot idx that reached ready; candidates that never got ready are skipped."""
    ready = [e for e in events() if e['e'] == 'ready' and e['idx'] == idx]
    return ready[-1] if ready else None


# ---- main-thread log lines of exp-zonesvr, read from a byte offset

@functools.lru_cache(maxsize=None)
def log_path():
    return Path(pm2_proc()['pm2_env']['pm_out_log_path'])


def log_offset():
    return log_path().stat().st_size


def main_logs(start):
    out = []
    with log_path().open('rb') as f:
        f.seek(start)
        for line in f:
            if b'"thread":"main"' not in line:
                continue
            if b'"module":"main_thread/' not in line and b'"module":"env_info"' not in line:
                continue
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def logs_with(msg, start):
    return [r for r in main_logs(start) if r.get('msg') == msg]


def wait_log(msg, start, timeout):
    deadline = now() + timeout
    while now() < deadline:
        hits = logs_with(msg, start)
        if hits:
            return hits[0]
        time.sleep(0.2)
    raise TimeoutError(f'log "{msg}" not seen')


# ---- Prometheus

def prom(q, t=None):
    params = {'query': q}
    if t is not None:
        params['time'] = f'{t:.3f}'
    with urllib.request.urlopen(PROM + '/api/v1/query?' + urllib.parse.urlencode(params), timeout=30) as r:
        return json.load(r)['data']['result']


def prom_range(q, start, end, step):
    params = {'query': q, 'start': f'{start:.3f}', 'end': f'{end:.3f}', 'step': str(step)}
    with urllib.request.urlopen(PROM + '/api/v1/query_range?' + urllib.parse.urlencode(params), timeout=30) as r:
        return json.load(r)['data']['result']


def scalar(q, t=None):
    r = prom(q, t)
    return float(r[0]['value'][1]) if r else 0.0


def V(sel, t):
    """Last pushed value at t; series that do not exist yet count as 0 (increase() would miss their first point)."""
    return scalar(f'sum(last_over_time({sel}[15s]))', t)


def D(sel, t0, t1):
    return V(sel, t1) - V(sel, t0)


def by_worker(q, t):
    return {r['metric'].get('worker_index'): float(r['value'][1]) for r in prom(q, t)}


def pending_avg(t, window='30s'):
    return by_worker(f'avg by (worker_index)(avg_over_time(dogsvr_worker_pending{{svr="zonesvr"}}[{window}]))', t)


def qps_ok(t):
    return scalar(f'sum(rate({OK_RANK}[15s]))', t)


def wait_until(t):
    while now() < t:
        time.sleep(min(0.2, max(0.0, t - now())))


# ---- pm2 / process

def pm2_proc(app=APP):
    for p in json.loads(sh('pm2 jlist').stdout):
        if p['name'] == app:
            return p
    raise RuntimeError(f'{app} not in pm2')


def pm2_info(app=APP):
    p = pm2_proc(app)
    return {'pid': p['pid'], 'restarts': p['pm2_env']['restart_time'], 'status': p['pm2_env']['status']}


def proc_status(pid):
    d = {}
    for line in Path(f'/proc/{pid}/status').read_text().splitlines():
        k, _, v = line.partition(':')
        if k in ('VmSize', 'VmRSS', 'Threads'):
            d[k] = int(v.split()[0])
    return d


def restart_zonesvr(listen_timeout=90):
    off = log_offset()
    t0 = now()
    sh(f'pm2 restart {APP}')
    listen = wait_log('start dog server successfully', off, listen_timeout)
    infos = [r for r in main_logs(off) if r.get('module') == 'env_info']
    env_ts = infos[0]['time'] / 1000 if infos else None
    return {'t_restart': t0, 'env_ts': env_ts, 'listen_ts': listen['time'] / 1000,
            'listen_after_env_ms': None if env_ts is None else round(listen['time'] - infos[0]['time']),
            'log_offset': off}


def trigger(app=APP):
    t0 = now()
    r = sh(f'timeout 90 pm2 trigger {app} hotUpdate', timeout=100)
    t1 = now()
    return {'t0': t0, 't1': t1, 'secs': round(t1 - t0, 3), 'rc': r.returncode,
            'out': (r.stdout + r.stderr).strip()[-1500:]}


def trigger_async(app=APP):
    box = {}
    th = threading.Thread(target=lambda: box.update(trigger(app)))
    th.start()
    return th, box


# ---- bot load (scenario F, rank queries only)

class Bots:
    def __init__(self, run_id, concurrency, duration_ms, ramp_ms, outdir):
        self.run_id = run_id
        self.logfile = outdir / f'bots-{run_id}.log'
        self.f = self.logfile.open('w')
        self.t0 = now()
        self.proc = subprocess.Popen(
            ['node', 'dist/scenarios/f_realistic_session.js', '--concurrency', str(concurrency),
             '--duration', str(duration_ms), '--ramp', str(ramp_ms), '--weight-battle', '0', '--weight-rank', '3'],
            cwd=BOTS, env={**os.environ, 'STRESS_RUN_ID': run_id}, stdout=self.f, stderr=subprocess.STDOUT)

    def at(self, secs):
        wait_until(self.t0 + secs)

    def wait(self):
        self.proc.wait()
        self.f.close()
        self.t_end = now()

    def text(self):
        return self.logfile.read_text(errors='replace')

    def aborted(self):
        return self.text().count('aborting bot')

    def report_dir(self):
        for line in self.text().splitlines():
            if '"report written"' in line:
                return json.loads(line).get('dir')
        return None

    def cycle_failures(self):
        # Cluster shards push identical label sets, so the Prometheus bot counters only hold one shard.
        return self.text().count('"bot op failed"')


# ---- report

class Report:
    def __init__(self, case, title):
        self.case = case
        self.title = title
        self.t_start = now()
        self.dir = REPORTS / f'{datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M")}-supervision-{case}'
        self.dir.mkdir(parents=True, exist_ok=True)
        self.checks = []
        self.data = {}

    def check(self, name, ok, detail=''):
        self.checks.append({'name': name, 'ok': bool(ok), 'detail': detail})
        print(f'[{"PASS" if ok else "FAIL"}] {name} — {detail}', flush=True)

    def note(self, key, value):
        self.data[key] = value
        print(f'  {key} = {json.dumps(value, default=str)[:400]}', flush=True)

    def write(self):
        self.data['events'] = events(self.t_start - 5)
        passed = sum(c['ok'] for c in self.checks)
        lines = [f'# supervision: {self.case}', '', self.title, '',
                 f'- **开始**: {iso(self.t_start)}', f'- **结束**: {iso(now())}',
                 f'- **结果**: {passed}/{len(self.checks)} PASS', '',
                 '| 检查 | 结果 | 实测 |', '|---|---|---|']
        for c in self.checks:
            lines.append(f'| {c["name"]} | {"PASS" if c["ok"] else "**FAIL**"} | {c["detail"]} |')
        (self.dir / 'summary.md').write_text('\n'.join(lines) + '\n')
        (self.dir / 'data.json').write_text(json.dumps(self.data, indent=2, default=str))
        if EVENTS.exists():
            shutil.copyfile(EVENTS, self.dir / 'events.ndjson')
        print(f'report: {self.dir}  ({passed}/{len(self.checks)} PASS)', flush=True)


def common_end_checks(rep, bots, base, t_begin, log_off):
    """Invariants every case must hold once its bots have stopped."""
    time.sleep(15)
    t = now()
    info = pm2_info()
    rep.check('zonesvr 进程未重启', info['pid'] == base['pid'] and info['restarts'] == base['restarts'],
              f'pid {base["pid"]}→{info["pid"]}, restarts {base["restarts"]}→{info["restarts"]}')
    to = D(TIMEOUTS, t_begin, t)
    logs = main_logs(log_off)
    to_log = sum(1 for r in logs if r.get('msg') == 'txn timeout')
    no_cb = sum(1 for r in logs if r.get('msg') == 'no callback for txnId')
    rep.check('事务超时 = 0', to == 0 and to_log == 0, f'metric {to:.0f}, log {to_log}')
    rep.check('no callback for txnId = 0', no_cb == 0, f'{no_cb}')
    txn_pending = V('dogsvr_txn_pending{svr="zonesvr"}', t)
    wp = by_worker('last_over_time(dogsvr_worker_pending{svr="zonesvr"}[15s])', t)
    rep.check('bot 停止后在途归零', txn_pending == 0 and all(v == 0 for v in wp.values()),
              f'txn_pending {txn_pending:.0f}, worker_pending {wp}')
    thr = proc_status(info['pid'])['Threads']
    rep.check('线程数回到基线（±2）', abs(thr - base['threads']) <= 2, f'{base["threads"]}→{thr}')
    if bots is not None:
        rep.check('没有 bot 永久退出', bots.aborted() == 0, f'aborting bot ×{bots.aborted()}')
        rep.note('bot_report', bots.report_dir())


def baseline():
    info = pm2_info()
    info['threads'] = proc_status(info['pid'])['Threads']
    return info


def failures_in(t0, t1):
    return D(FAIL, t0, t1)


def retry_seq(log_off, idx):
    return [r.get('retryInMs') for r in logs_with('worker slot down, respawn scheduled', log_off)
            if r.get('workerIndex') == idx]


# ---- cases

def case_crash(args):
    """L-A: serving worker crashes; backoff 1/2/4 s, stable reset, both slots down at once."""
    rep = Report('crash', 'L-A：服务中 worker 崩溃 → 在途立即失败 → 同槽退避重启；稳定 60 s 后退避清零；两槽同时崩溃时立即失败')
    restore_configs()
    set_main_cfg(shim=True)
    reset_chaos('v1')
    rs = restart_zonesvr()
    rep.note('startup', rs)
    time.sleep(20)  # older-process points must age out of the 15 s last_over_time window
    base = baseline()
    log_off = rs['log_offset']
    bots = Bots('sv-crash', 1000, 360000, 60000, rep.dir)
    t_begin = now()

    crashes = []

    def crash(slots, label):
        t = now()
        before = {i: serving_tid(i)['tid'] for i in slots}
        pend = pending_avg(t - 1)
        qps_before = qps_ok(t - 5)
        for i in slots:
            marker(f'exit-{i}')
        exits = {i: wait_event(lambda e, i=i: e['e'] == 'exit' and e['idx'] == i, 10, t - 1) for i in slots}
        readies = {i: wait_event(lambda e, i=i: e['e'] == 'ready' and e['idx'] == i and e['tid'] != before[i], 30, t - 1)
                   for i in slots}
        crashes.append({'label': label, 'slots': slots, 't': t, 'pending_before': pend, 'qps_before': qps_before,
                        'exit_ts': {i: exits[i]['ts'] / 1000 for i in slots},
                        'ready_ts': {i: readies[i]['ts'] / 1000 for i in slots},
                        'recovery_ms': {i: readies[i]['ts'] - exits[i]['ts'] for i in slots},
                        'old_tid': before, 'new_tid': {i: readies[i]['tid'] for i in slots}})
        print(f'{label}: slots {slots} recovered in {crashes[-1]["recovery_ms"]} ms', flush=True)
        return max(readies[i]['ts'] for i in slots) / 1000

    bots.at(90)
    r1 = crash([0], 'A1')
    wait_until(r1 + 10)
    r2 = crash([0], 'A2')
    wait_until(r2 + 10)
    r3 = crash([0], 'A3')
    wait_until(r3 + 70)
    r4 = crash([0], 'A4')
    wait_until(r4 + 70)
    crash([0, 1], 'A5')
    bots.wait()

    expected = {'A1': [1000], 'A2': [2000], 'A3': [4000], 'A4': [1000], 'A5': [1000, 1000]}
    seq0 = retry_seq(log_off, 0)
    seq1 = retry_seq(log_off, 1)
    rep.check('槽 0 重启间隔 1000/2000/4000/1000/1000 ms', seq0 == [1000, 2000, 4000, 1000, 1000], f'{seq0}')
    rep.check('槽 1 重启间隔 1000 ms', seq1 == [1000], f'{seq1}')
    exited = logs_with('worker exited', log_off)
    rep.check('退出码均为 9 且带 threadId', len(exited) == 6 and all(r.get('exitCode') == 9 for r in exited),
              f'{[(r.get("workerIndex"), r.get("exitCode")) for r in exited]}')
    for c in crashes:
        lab = c['label']
        t_ex = min(c['exit_ts'].values())
        t_rd = max(c['ready_ts'].values())
        fails = failures_in(t_ex - 0.5, t_rd + 6)
        inflight = sum(c['pending_before'].get(str(i), 0) for i in c['slots'])
        c['failures'] = fails
        if lab != 'A5':
            rep.check(f'{lab} 失败数 ≈ 崩溃前在途数（0.7~1.3×）', 0.7 * inflight <= fails <= 1.3 * inflight,
                      f'失败 {fails:.0f}，在途 {inflight:.0f}')
        else:
            fast = D('dogsvr_cmd_duration_milliseconds_bucket{svr="zonesvr",ok="0",le="0.5"}', t_ex - 0.5, t_rd + 6)
            slow = fails - D('dogsvr_cmd_duration_milliseconds_bucket{svr="zonesvr",ok="0",le="2000"}', t_ex - 0.5, t_rd + 6)
            c['fast_failures'] = fast
            rep.check('A5 两槽都空时请求立即失败（≤0.5 ms 桶）', fast > 0, f'失败 {fails:.0f}，其中 ≤0.5 ms {fast:.0f}，在途 {inflight:.0f}')
            rep.check('A5 没有失败耗时 ≥ 2 s', slow == 0, f'{slow:.0f}')
        for i in c['slots']:
            retry = expected[lab][c['slots'].index(i)]
            rec = c['recovery_ms'][i]
            rep.check(f'{lab} 槽 {i} 恢复耗时 ≈ 间隔 + init', retry <= rec <= retry + 1500, f'{rec} ms（间隔 {retry}）')
        q_after = qps_ok(t_rd + 20)
        c['qps_after'] = q_after
        if lab in ('A3', 'A4', 'A5'):
            # A1/A2 are followed by the next crash 10 s after recovery, inside this 15 s rate window.
            rep.check(f'{lab} 恢复后吞吐 ≥ 崩溃前 95 %', q_after >= 0.95 * c['qps_before'],
                      f'{c["qps_before"]:.0f} → {q_after:.0f} /s')
            bal = pending_avg(t_rd + 45)
            vals = [bal.get('0', 0), bal.get('1', 0)]
            ratio = vals[0] / vals[1] if vals[1] else 0
            c['balance'] = bal
            rep.check(f'{lab} 恢复 45 s 后两侧在途比 0.8~1.25', 0.8 <= ratio <= 1.25, f'{vals[0]:.0f} / {vals[1]:.0f}')
    rep.note('crashes', crashes)
    # Exited threads keep their last value in the OTel gauge, so only judge tids that are still alive.
    live = {int(t) for t in os.listdir(f'/proc/{base["pid"]}/task')}
    series = prom('last_over_time(dogsvr_thread_cpu_utilization{svr="zonesvr",thread_role="worker"}[15s])',
                  bots.t_end - 20)
    busy_live = {r['metric'].get('worker_index') for r in series
                 if int(r['metric']['tid']) in live and float(r['value'][1]) > 0.3}
    stale = [r['metric']['tid'] for r in series if int(r['metric']['tid']) not in live]
    rep.check('线程 CPU 指标登记了重启后的 worker tid', busy_live == {'0', '1'},
              f'存活且忙碌的 worker_index {sorted(busy_live)}；已退出却仍在上报的 tid {len(stale)} 个')
    total_fail = failures_in(t_begin, bots.t_end + 10)
    rep.note('server_failures_total', total_fail)
    rep.note('bot_cycle_failures', bots.cycle_failures())
    common_end_checks(rep, bots, base, t_begin, log_off)
    restore_configs()
    rep.write()


def case_rolling(args):
    """L-C: rolling hot update success / fast abort / timeout abort / slot-1 abort / crash during candidate init."""
    rep = Report('rolling', 'L-C：rolling 热更新——成功并重复触发、init 抛错中止、init 超时中止、槽 1 失败（版本混杂）、候选 init 期间旧 worker 崩溃')
    restore_configs()
    set_main_cfg(shim=True)
    reset_chaos('v1')
    rs = restart_zonesvr()
    rep.note('startup', rs)
    time.sleep(20)  # older-process points must age out of the 15 s last_over_time window
    base = baseline()
    log_off = rs['log_offset']
    bots = Bots('sv-rolling', 1000, 330000, 60000, rep.dir)
    t_begin = now()

    # C1: success, plus a second trigger while the first is running.
    bots.at(90)
    set_version('v2')
    old = [serving_tid(0)['tid'], serving_tid(1)['tid']]
    off = log_offset()
    th1, r1 = trigger_async()
    time.sleep(0.15)
    r2 = trigger()
    th1.join()
    # The CLI can return on the ignored trigger's reply, so completion comes from the log.
    done_ts = wait_log('rolling hot update complete: all workers replaced', off, 30)['time'] / 1000
    time.sleep(1)
    new = [serving_tid(0), serving_tid(1)]
    rep.note('C1', {'first': r1, 'second': r2, 'old_tids': old, 'new': new, 'done_ts': done_ts})
    rep.check('C1 第一次触发成功', 'hotUpdate done' in r1['out'], r1['out'][-200:])
    rep.check('C1 第一个 CLI 在热更新完成后才返回（缺陷 3：预期 FAIL）', r1['t1'] >= done_ts,
              f'CLI 返回比完成{"晚" if r1["t1"] >= done_ts else "早"} {abs(r1["t1"] - done_ts):.2f} s')
    rep.check('C1 两槽都换成 v2 新 worker', all(n['ver'] == 'v2' and n['tid'] not in old for n in new),
              f'{[(n["tid"], n["ver"]) for n in new]}')
    stopped = logs_with('old worker stopped', off)
    rep.check('C1 旧 worker 均正常排空', len(stopped) == 2 and all(r.get('reason') == 'drained gracefully' for r in stopped),
              f'{[r.get("reason") for r in stopped]}')
    ignored = logs_with('hotUpdate called while already updating, ignoring', off)
    rep.check('C1 重复触发被忽略（F3：回复内容见实测）', len(ignored) == 1, f'忽略 {len(ignored)} 次；第二次回复：{r2["out"][-120:]!r}')
    rep.check('C1 期间 0 失败', failures_in(r1['t0'] - 1, done_ts + 6) == 0,
              f'{failures_in(r1["t0"] - 1, done_ts + 6):.0f}')

    # C2: initFn throws (bad tableKeysPath) -> abort at slot 0.
    bots.at(130)
    cur = [serving_tid(0)['tid'], serving_tid(1)['tid']]
    off = log_offset()
    set_worker_cfg(tableKeysPath='/nonexistent/table_keys.json')
    r = trigger()
    restore_worker_cfg()
    time.sleep(1)
    init_failed = logs_with('worker init failed', off)
    rep.note('C2', {'trigger': r, 'init_failed': [str(x.get('error'))[:300] for x in init_failed]})
    rep.check('C2 回复 aborted at slot 0', 'aborted at slot 0' in r['out'], r['out'][-200:])
    rep.check('C2 3 s 内中止', r['secs'] < 3, f'{r["secs"]} s')
    rep.check('C2 日志带 init 失败原因', len(init_failed) == 1 and 'table_keys' in str(init_failed[0].get('error')), '')
    rep.check('C2 旧 worker 继续服务', [serving_tid(0)['tid'], serving_tid(1)['tid']] == cur, f'{cur}')
    rep.check('C2 期间 0 失败', failures_in(r['t0'] - 1, r['t1'] + 6) == 0, f'{failures_in(r["t0"] - 1, r["t1"] + 6):.0f}')

    # C3: init hangs (redis connect retries forever) -> abort after workerInitTimeout.
    bots.at(170)
    off = log_offset()
    set_worker_cfg(redisUri='redis://127.0.0.1:1')
    r = trigger()
    restore_worker_cfg()
    time.sleep(1)
    rep.note('C3', {'trigger': r})
    rep.check('C3 回复 aborted at slot 0', 'aborted at slot 0' in r['out'], r['out'][-200:])
    rep.check('C3 约 30 s 后中止（29~33 s）', 29 <= r['secs'] <= 33, f'{r["secs"]} s')
    rep.check('C3 日志 worker init timeout', len(logs_with('worker init timeout', off)) == 1, '')
    rep.check('C3 旧 worker 继续服务', [serving_tid(0)['tid'], serving_tid(1)['tid']] == cur, f'{cur}')
    rep.check('C3 期间 0 失败', failures_in(r['t0'] - 1, r['t1'] + 6) == 0, f'{failures_in(r["t0"] - 1, r["t1"] + 6):.0f}')

    # C4: slot 1 candidate fails -> abort at slot 1, slot 0 stays on the new code.
    bots.at(215)
    set_version('v3')
    marker('loadfail-1')
    r = trigger()
    marker('loadfail-1', False)
    time.sleep(1)
    s0, s1 = serving_tid(0), serving_tid(1)
    rep.note('C4', {'trigger': r, 'slot0': s0, 'slot1': s1})
    rep.check('C4 回复 aborted at slot 1', 'aborted at slot 1' in r['out'], r['out'][-200:])
    rep.check('C4 版本混杂：槽 0 = v3、槽 1 = v2（F2）', s0['ver'] == 'v3' and s1['ver'] == 'v2', f'{s0["ver"]} / {s1["ver"]}')
    rep.check('C4 期间 0 失败', failures_in(r['t0'] - 1, r['t1'] + 6) == 0, f'{failures_in(r["t0"] - 1, r["t1"] + 6):.0f}')

    # C5: the serving worker of slot 0 crashes while its own candidate initialises.
    bots.at(255)
    set_version('v4')
    off = log_offset()
    old0 = serving_tid(0)['tid']
    pend = pending_avg(now() - 1)
    t5 = now()
    th, r5 = trigger_async()
    cand = wait_event(lambda e: e['e'] == 'init_start' and e['idx'] == 0 and e['tid'] != old0, 10, t5)
    marker(f'exit-t{old0}')
    crash = wait_event(lambda e: e['e'] == 'exit' and e['tid'] == old0, 10, t5)
    th.join()
    time.sleep(3)
    loads0 = [e for e in events(t5) if e['e'] == 'load' and e['idx'] == 0]
    ready0 = [e for e in events(t5) if e['e'] == 'ready' and e['idx'] == 0]
    cand_ready = [e for e in ready0 if e['tid'] == cand['tid']]
    rep.note('C5', {'trigger': r5, 'old_tid': old0, 'candidate_tid': cand['tid'], 'loads_slot0': loads0,
                    'pending_before': pend})
    rep.check('C5 崩溃发生在候选 init 期间', bool(cand_ready) and crash['ts'] < cand_ready[0]['ts'],
              f'crash {crash["ts"]}, candidate ready {cand_ready[0]["ts"] if cand_ready else None}')
    rep.check('C5 候选接管，未多出一次重启', len(loads0) == 1 and serving_tid(0)['tid'] == cand['tid'],
              f'槽 0 新加载 {len(loads0)} 次')
    rep.check('C5 热更新完成', 'hotUpdate done' in r5['out'] and serving_tid(1)['ver'] == 'v4', r5['out'][-120:])
    f5 = failures_in(crash['ts'] / 1000 - 0.5, crash['ts'] / 1000 + 6)
    inflight = pend.get('0', 0)
    rep.check('C5 失败数 ≈ 旧 worker 0 在途数（0.7~1.3×）', 0.7 * inflight <= f5 <= 1.3 * inflight, f'失败 {f5:.0f}，在途 {inflight:.0f}')
    # Which of 'exit' and 'ready' main handles first decides whether a respawn gets scheduled; both are correct.
    seq = retry_seq(off, 0)
    order = {(): '候选 ready 先被处理，旧 worker 已退役，未排定重启',
             (1000,): '退出先被处理，排定的 1 s 重启被候选接管取消'}.get(tuple(seq), '意外')
    rep.check('C5 槽 0 最多排定一次重启', tuple(seq) in ((), (1000,)), f'{seq}：{order}')

    bots.wait()
    common_end_checks(rep, bots, base, t_begin, log_off)
    restore_configs()
    rep.write()


def case_soak(args):
    """F6: memory and threads across many rolling hot updates (no shim)."""
    n = args.updates
    ctl = args.control
    rep = Report('soak-control' if ctl else 'soak',
                 f'spawn soak：F 200 负载下{"按同一时间线但不触发热更新（对照组）" if ctl else f"连续 {n} 次 rolling 热更新（每次创建 2 个 worker）"}，观察 VmSize / VmRSS / 线程数')
    restore_configs()
    rs = restart_zonesvr()
    rep.note('startup', rs)
    time.sleep(20)  # older-process points must age out of the 15 s last_over_time window
    base = baseline()
    pid = base['pid']
    duration = 45 + n * 15 + 30 + args.tail
    bots = Bots('sv-soak', 200, duration * 1000, 30000, rep.dir)
    t_begin = now()
    samples = []
    stop = threading.Event()

    def sampler():
        while not stop.is_set():
            s = proc_status(pid)
            s['t'] = round(now() - bots.t0, 1)
            samples.append(s)
            stop.wait(5)

    th = threading.Thread(target=sampler)
    th.start()
    triggers = []
    for k in range(n):
        bots.at(45 + k * 15)
        if not ctl:
            triggers.append(trigger())
    bots.wait()
    time.sleep(30)
    stop.set()
    th.join()
    rep.note('samples', samples)
    if not ctl:
        rep.note('triggers', [{'secs': t['secs'], 'out': t['out'][-60:]} for t in triggers])
        rep.check('全部热更新成功', all('hotUpdate done' in t['out'] for t in triggers),
                  f'{sum("hotUpdate done" in t["out"] for t in triggers)}/{n}')

    def avg_mb(key, lo, hi):
        xs = [s[key] for s in samples if lo <= s['t'] < hi]
        return round(sum(xs) / len(xs) / 1024) if xs else None

    # VmSize moves in large discrete reservations, so compare runs window by window instead of per spawn.
    rep.note('summary_mb', {
        'vsz_before': avg_mb('VmSize', 35, 45), 'vsz_load_end': avg_mb('VmSize', duration - 45, duration - 30),
        'vsz_idle': avg_mb('VmSize', duration + 15, 1e9),
        'rss_before': avg_mb('VmRSS', 35, 45), 'rss_load_end': avg_mb('VmRSS', duration - 45, duration - 30),
        'rss_idle': avg_mb('VmRSS', duration + 15, 1e9), 'spawns': 0 if ctl else 2 * n})
    rep.check('线程数不增长', abs(samples[-1]['Threads'] - base['threads']) <= 2, f'{base["threads"]}→{samples[-1]["Threads"]}')
    fails = V(FAIL, bots.t_end + 10) - V(FAIL, t_begin)
    rep.check('全程 0 失败', fails == 0, f'{fails:.0f}')
    rep.write()


def case_startup_loadfail(args):
    """L-B1: one slot fails to load at startup; backoff ladder to the 60 s cap; hot update kicks it back."""
    rep = Report('startup-loadfail', 'L-B1：启动时槽 1 加载即失败 → 照常监听、只用槽 0 服务、退避升到 60 s 封顶；去掉故障后热更新立即拉起')
    restore_configs()
    set_main_cfg(shim=True)
    reset_chaos('v1')
    marker('loadfail-1')
    rs = restart_zonesvr()
    rep.note('startup', rs)
    log_off = rs['log_offset']
    rep.check('照常监听（< 3 s）', rs['listen_after_env_ms'] < 3000, f'{rs["listen_after_env_ms"]} ms')
    base = baseline()
    bots = Bots('sv-loadfail', 100, 110000, 10000, rep.dir)
    t_begin = now()
    hit = None
    deadline = rs['listen_ts'] + 90
    while now() < deadline and hit is None:
        hit = next((r for r in logs_with('worker slot down, respawn scheduled', log_off)
                    if r.get('workerIndex') == 1 and r.get('retryInMs') == 60000), None)
        time.sleep(1)
    seq = retry_seq(log_off, 1)
    rep.check('槽 1 退避 1→2→4→8→16→32→60 s', seq[:7] == [1000, 2000, 4000, 8000, 16000, 32000, 60000], f'{seq}')
    errs = [r for r in logs_with('worker error', log_off) if r.get('workerIndex') == 1]
    rep.check('每次失败都记录原因', bool(errs) and 'loadfail-1' in json.dumps(errs[0]), f'worker error ×{len(errs)}')
    wp = by_worker('max_over_time(dogsvr_worker_pending{svr="zonesvr"}[30s])', now())
    rep.check('槽 1 空置期间不派发', wp.get('1', 0) == 0 and wp.get('0', 0) > 0, f'{wp}')
    marker('loadfail-1', False)
    r = trigger()
    time.sleep(1)
    s1 = [e for e in events(r['t0']) if e['e'] == 'ready' and e['idx'] == 1]
    rep.note('kick', {'trigger': r, 'slot1_ready': s1})
    rep.check('热更新立即拉起空槽（3 s 内）', bool(s1) and s1[0]['ts'] / 1000 - r['t0'] < 3,
              f'{(s1[0]["ts"] / 1000 - r["t0"]) if s1 else None}')
    bots.wait()
    # The process started inside this case, so its counter value is the whole lifetime count.
    fails = V(FAIL, bots.t_end + 10)
    rep.check('全程 0 失败', fails == 0, f'{fails:.0f}')
    common_end_checks(rep, bots, base, t_begin, log_off)
    restore_configs()
    rep.write()


def case_startup_inithang(args):
    """L-B2: one slot's init never finishes; listen waits for workerInitTimeout; repeated timeouts stay bounded."""
    rep = Report('startup-inithang', 'L-B2：启动时槽 1 init 永不完成 → 约 30 s 后才监听；之后每次重试都 30 s 超时；线程数有界')
    restore_configs()
    set_main_cfg(shim=True)
    reset_chaos('v1')
    marker('inithang-1')
    rs = restart_zonesvr()
    rep.note('startup', rs)
    log_off = rs['log_offset']
    rep.check('约 30 s 后才开始监听（29.5~32 s）', 29500 <= rs['listen_after_env_ms'] <= 32000, f'{rs["listen_after_env_ms"]} ms')
    base = baseline()
    bots = Bots('sv-inithang', 50, 80000, 5000, rep.dir)
    t_begin = now()
    threads = []
    while now() < rs['env_ts'] + 100:
        threads.append(proc_status(base['pid'])['Threads'])
        time.sleep(2)
    to = logs_with('worker init timeout', log_off)
    rel = [round(r['time'] / 1000 - rs['env_ts'], 1) for r in to]
    rep.check('init 超时在约 30 / 61 / 93 s 发生', len(rel) >= 3 and abs(rel[0] - 30) < 2 and abs(rel[1] - 61) < 3 and abs(rel[2] - 93) < 4,
              f'{rel}')
    rep.check('线程数有界（波动 ≤ 2）', max(threads) - min(threads) <= 2, f'{min(threads)}~{max(threads)}')
    marker('inithang-1', False)
    rdy = wait_event(lambda e: e['e'] == 'ready' and e['idx'] == 1, 60, rs['t_restart'])
    rep.note('slot1_ready_after_s', round(rdy['ts'] / 1000 - rs['env_ts'], 1))
    bots.wait()
    # The process started inside this case, so its counter value is the whole lifetime count.
    fails = V(FAIL, bots.t_end + 10)
    rep.check('全程 0 失败', fails == 0, f'{fails:.0f}')
    common_end_checks(rep, bots, base, t_begin, log_off)
    restore_configs()
    rep.write()


def case_startup_allfail(args):
    """L-B3: every slot fails init; server still listens and fails requests at once; recovers after the fix."""
    rep = Report('startup-allfail', 'L-B3：两个槽 init 都失败 → 照常监听但请求立即失败；修复配置后在下一次重试时恢复')
    restore_configs()
    set_main_cfg(shim=True)
    reset_chaos('v1')
    set_worker_cfg(tableKeysPath='/nonexistent/table_keys.json')
    rs = restart_zonesvr()
    rep.note('startup', rs)
    log_off = rs['log_offset']
    rep.check('照常监听（< 3 s）', rs['listen_after_env_ms'] < 3000, f'{rs["listen_after_env_ms"]} ms')
    base = baseline()
    probe = Bots('sv-allfail-probe', 20, 15000, 1000, rep.dir)
    probe.wait()
    # Past 15 s after the restart only this process's points remain, so plain values are lifetime counts.
    t1 = max(probe.t_end + 8, rs['t_restart'] + 20)
    wait_until(t1 + 1)
    fails = V(FAIL, t1)
    fast = V('dogsvr_cmd_duration_milliseconds_bucket{svr="zonesvr",ok="0",le="0.5"}', t1)
    oks = V('dogsvr_cmd_duration_milliseconds_count{svr="zonesvr",ok="1"}', t1)
    rep.check('无可用 worker 时请求全部立即失败（≤0.5 ms）', fails > 0 and fast / fails >= 0.99 and oks == 0,
              f'失败 {fails:.0f}，≤0.5 ms {fast:.0f}，成功 {oks:.0f}')
    restore_worker_cfg()
    t_fix = now()
    seq = {i: retry_seq(log_off, i) for i in (0, 1)}
    rdy = [wait_event(lambda e, i=i: e['e'] == 'ready' and e['idx'] == i, 70, t_fix) for i in (0, 1)]
    rec = [round(e['ts'] / 1000 - t_fix, 1) for e in rdy]
    rep.note('retry_seq_at_fix', seq)
    # The startup baseline had no workers; compare the end state against the recovered process instead.
    time.sleep(2)
    rep.note('threads', {'no_worker': base['threads'], 'recovered': proc_status(base['pid'])['Threads']})
    base['threads'] = proc_status(base['pid'])['Threads']
    rep.check('修复后在下一次重试时恢复', all(r <= max(seq[i][-1] for i in (0, 1)) / 1000 + 2 for r in rec),
              f'恢复用时 {rec} s，当时的间隔 {[seq[i][-1] for i in (0, 1)]}')
    smoke = Bots('sv-allfail-smoke', 20, 20000, 2000, rep.dir)
    smoke.wait()
    rep.check('恢复后冒烟 0 失败', failures_in(smoke.t0, smoke.t_end + 8) == 0, f'{failures_in(smoke.t0, smoke.t_end + 8):.0f}')
    common_end_checks(rep, None, base, probe.t0, log_off)
    restore_configs()
    rep.write()


def case_allatonce(args):
    """L-D: allAtOnce success with back-to-back triggers; one-slot load failure keeps every old worker."""
    rep = Report('allatonce', 'L-D：allAtOnce 热更新——成功并紧接再触发；槽 1 加载失败时两个旧 worker 都保留')
    restore_configs()
    set_main_cfg(shim=True, hotUpdateStrategy={'strategy': 'allAtOnce'})
    reset_chaos('v1')
    rs = restart_zonesvr()
    rep.note('startup', rs)
    time.sleep(20)  # older-process points must age out of the 15 s last_over_time window
    base = baseline()
    log_off = rs['log_offset']
    bots = Bots('sv-allatonce', 300, 200000, 20000, rep.dir)
    t_begin = now()

    bots.at(60)
    off = log_offset()
    gen_a = [serving_tid(0)['tid'], serving_tid(1)['tid']]
    set_version('v2')
    r1 = trigger()
    set_version('v3')
    th2, r2 = trigger_async()
    time.sleep(0.15)
    r3 = trigger()
    th2.join()
    time.sleep(2)
    stopped = logs_with('old worker stopped', off)
    ignored = logs_with('hotUpdate called while already updating, ignoring', off)
    gen_c = [serving_tid(0), serving_tid(1)]
    rep.note('D1', {'r1': r1, 'r2': r2, 'r3': r3, 'gen_a': gen_a, 'gen_c': gen_c,
                    'stopped': [(s['time'], s.get('workerIndex'), s.get('reason')) for s in stopped]})
    rep.check('D1 三次触发：第 1、2 次执行、第 3 次被忽略', 'hotUpdate done' in r1['out'] and len(ignored) == 1,
              f'忽略 {len(ignored)} 次；回复 {[x["out"][-40:] for x in (r1, r2, r3)]}')
    rep.check('D1 最终两槽都是 v3', all(g['ver'] == 'v3' for g in gen_c), f'{[(g["tid"], g["ver"]) for g in gen_c]}')
    first_c_load = min((e['ts'] for e in events(r1['t0']) if e['e'] == 'load' and e['ver'] == 'v3'), default=None)
    a_stop = [s['time'] for s in stopped[:2]]
    # Whether generation A was still draining when v3 loaded depends on timing; record it, don't judge it.
    rep.note('D1_overlap', {'first_v3_load': first_c_load, 'gen_a_stopped': a_stop,
                            'three_generations': first_c_load is not None and bool(a_stop) and first_c_load < max(a_stop)})
    rep.check('D1 期间 0 失败', failures_in(r1['t0'] - 1, r3['t1'] + 8) == 0, f'{failures_in(r1["t0"] - 1, r3["t1"] + 8):.0f}')

    bots.at(120)
    cur = [serving_tid(0)['tid'], serving_tid(1)['tid']]
    set_version('v4')
    marker('loadfail-1')
    r = trigger()
    marker('loadfail-1', False)
    time.sleep(1)
    rep.note('D2', {'trigger': r})
    rep.check('D2 中止', 'aborted at slot' in r['out'], r['out'][-200:])
    rep.check('D2 报错槽位为 1（F1：预期错报为 0）', 'aborted at slot 1' in r['out'], r['out'][-120:])
    rep.check('D2 两个旧 worker 都保留', [serving_tid(0)['tid'], serving_tid(1)['tid']] == cur, f'{cur}')
    rep.check('D2 期间 0 失败', failures_in(r['t0'] - 1, r['t1'] + 6) == 0, f'{failures_in(r["t0"] - 1, r["t1"] + 6):.0f}')
    bots.wait()
    common_end_checks(rep, bots, base, t_begin, log_off)
    restore_configs()
    rep.write()


def case_hotupdate_perf(args):
    """P3/P4: hot update under the standard F 1000 load (original configs), triggers at 120 s and 210 s."""
    label = args.label
    rep = Report(f'hotupdate-{label}', f'P3/P4：标准 F 1000 负载下 rolling 热更新（120 s、210 s 各一次），dogsvr = {label}')
    restore_configs()
    off = log_offset()
    sh('pm2 restart exp-dir exp-zonesvr exp-battlesvr')
    listen = wait_log('start dog server successfully', off, 60)
    infos = [r for r in main_logs(off) if r.get('module') == 'env_info']
    rep.note('listen_after_env_ms', round(listen['time'] - infos[0]['time']) if infos else None)
    time.sleep(15)
    base = baseline()
    bots = Bots(f'sv-hu-{label}', 1000, 300000, 60000, rep.dir)
    t_begin = now()
    trig = []
    for at in (120, 210):
        bots.at(at)
        lo = log_offset()
        r = trigger()
        time.sleep(2)
        r['replaced'] = [(x['time'], x.get('workerIndex')) for x in logs_with('rolling hot update: worker replaced', lo)]
        r['stopped'] = [(x['time'], x.get('workerIndex'), x.get('reason')) for x in logs_with('old worker stopped', lo)]
        trig.append(r)
    bots.wait()
    rep.note('triggers', trig)
    step = 5
    t0, t1 = bots.t0, bots.t_end
    series = {}
    for name, sel in (('cnt', OK_RANK),
                      ('le500', 'dogsvr_cmd_duration_milliseconds_bucket{svr="zonesvr",cmdId="20004",ok="1",le="500"}'),
                      ('le1000', 'dogsvr_cmd_duration_milliseconds_bucket{svr="zonesvr",cmdId="20004",ok="1",le="1000"}'),
                      ('le2000', 'dogsvr_cmd_duration_milliseconds_bucket{svr="zonesvr",cmdId="20004",ok="1",le="2000"}'),
                      ('fail', FAIL), ('timeout', TIMEOUTS)):
        res = prom_range(f'sum(last_over_time({sel}[15s]))', t0, t1, step)
        series[name] = {float(ts): float(v) for ts, v in (res[0]['values'] if res else [])}
    pend = prom_range('avg by (worker_index)(last_over_time(dogsvr_worker_pending{svr="zonesvr"}[6s]))', t0, t1, step)
    pend_series = {r['metric'].get('worker_index'): {float(ts): float(v) for ts, v in r['values']} for r in pend}
    windows = []
    keys = sorted(series['cnt'])
    for a, b in zip(keys, keys[1:]):
        g = lambda n, t: series[n].get(t, 0.0)
        n_ = g('cnt', b) - g('cnt', a)
        windows.append({'t': round(b - t0), 'n': n_,
                        'gt500': n_ - (g('le500', b) - g('le500', a)),
                        'gt1000': n_ - (g('le1000', b) - g('le1000', a)),
                        'gt2000': n_ - (g('le2000', b) - g('le2000', a)),
                        'fail': g('fail', b) - g('fail', a), 'timeout': g('timeout', b) - g('timeout', a),
                        'pending': {w: pend_series[w].get(b) for w in pend_series}})
    rep.note('windows', windows)
    for r, at in zip(trig, (120, 210)):
        near = [w for w in windows if at - 5 <= w['t'] <= at + 25]
        steady = [w for w in windows if at - 40 <= w['t'] < at - 5]
        share = lambda ws, k: sum(w[k] for w in ws) / max(1, sum(w['n'] for w in ws))
        r['summary'] = {'gt500_near': share(near, 'gt500'), 'gt500_steady': share(steady, 'gt500'),
                        'gt1000_near': share(near, 'gt1000'), 'gt2000_near': share(near, 'gt2000'),
                        'fail_near': sum(w['fail'] for w in near), 'timeout_near': sum(w['timeout'] for w in near)}
        rep.check(f'{at}s 热更新成功', 'hotUpdate done' in r['out'], f'{r["secs"]} s')
        rep.check(f'{at}s 前后 0 失败、0 超时', r['summary']['fail_near'] == 0 and r['summary']['timeout_near'] == 0,
                  f'失败 {r["summary"]["fail_near"]:.0f}，超时 {r["summary"]["timeout_near"]:.0f}')
        rep.note(f'tail_{at}', r['summary'])
    common_end_checks(rep, bots, base, t_begin, off)
    rep.write()


CASES = {
    'crash': case_crash,
    'rolling': case_rolling,
    'soak': case_soak,
    'startup-loadfail': case_startup_loadfail,
    'startup-inithang': case_startup_inithang,
    'startup-allfail': case_startup_allfail,
    'allatonce': case_allatonce,
    'hotupdate-perf': case_hotupdate_perf,
}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('case', choices=sorted(CASES))
    ap.add_argument('--updates', type=int, default=20, help='soak: number of rolling hot updates')
    ap.add_argument('--control', action='store_true', help='soak: same timeline without triggering hot updates')
    ap.add_argument('--tail', type=int, default=0, help='soak: extra seconds of load after the last hot update')
    ap.add_argument('--label', default='new', help='hotupdate-perf: dogsvr build label for the report')
    args = ap.parse_args()
    try:
        CASES[args.case](args)
    finally:
        restore_configs()


if __name__ == '__main__':
    main()
