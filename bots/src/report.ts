// Per-scenario report generator: summary.md, metrics.json, system.log, git_revisions.txt.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { snapshotCounters } from './otel_metrics_client';
import { log } from './log';

const REPORTS_ROOT = path.resolve(__dirname, '../../reports');

export interface ScenarioParams {
    [key: string]: unknown;
}

export interface ScenarioVerdict {
    passed: boolean;
    reason: string;            // why it passed/failed
    keyStats: Record<string, string | number>;
}

export interface ReportInputs {
    scenario: string;
    startedAt: number;
    finishedAt: number;
    params: ScenarioParams;
    verdict: ScenarioVerdict;
    notes?: string[];
}

export function reportDir(scenario: string, startedAt: number): string {
    const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 16);
    return path.join(REPORTS_ROOT, `${stamp}-${scenario}`);
}

export async function writeReport(input: ReportInputs): Promise<string> {
    const dir = reportDir(input.scenario, input.startedAt);
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(path.join(dir, 'summary.md'), buildSummary(input));

    try {
        fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(snapshotCounters(), null, 2));
    } catch (err) {
        log.warn({ err: String(err) }, 'failed to dump bot metrics.json');
    }

    try {
        const sys = [
            '# uname',
            execSync('uname -a').toString(),
            '\n# free -h',
            execSync('free -h').toString(),
            '\n# top -b -n1 (top 25 lines)',
            execSync('top -b -n1 | head -25').toString(),
        ].join('\n');
        fs.writeFileSync(path.join(dir, 'system.log'), sys);
    } catch (err) {
        log.warn({ err: String(err) }, 'failed to capture system.log');
    }

    try {
        const revs = collectGitRevisions();
        fs.writeFileSync(path.join(dir, 'git_revisions.txt'), revs);
    } catch (err) {
        log.warn({ err: String(err) }, 'failed to collect git revisions');
    }

    fs.writeFileSync(path.join(dir, 'prometheus_snapshot.txt'),
        [
            'To capture the Prometheus snapshot for this run:',
            '  curl -XPOST http://127.0.0.1:9090/api/v1/admin/tsdb/snapshot',
            'Then archive the directory printed under data/prometheus/snapshots/.',
            'Tarball it as prometheus_snapshot.tar.gz alongside this file.',
        ].join('\n') + '\n',
    );

    log.info({ dir }, 'report written');
    return dir;
}

function buildSummary(input: ReportInputs): string {
    const lines: string[] = [];
    lines.push(`# 压测场景报告: ${input.scenario}`);
    lines.push('');
    lines.push(`- **开始**: ${new Date(input.startedAt).toISOString()}`);
    lines.push(`- **结束**: ${new Date(input.finishedAt).toISOString()}`);
    lines.push(`- **时长**: ${((input.finishedAt - input.startedAt) / 1000).toFixed(1)}s`);
    lines.push('');
    lines.push('## 入参');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(input.params, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('## 关键指标');
    lines.push('');
    lines.push('| 指标 | 值 |');
    lines.push('|---|---|');
    for (const [k, v] of Object.entries(input.verdict.keyStats)) {
        lines.push(`| ${k} | ${v} |`);
    }
    lines.push('');
    lines.push(`## 结论: ${input.verdict.passed ? '**通过**' : '**未通过**'}`);
    lines.push('');
    lines.push(input.verdict.reason);
    lines.push('');
    if (input.notes && input.notes.length) {
        lines.push('## 备注');
        lines.push('');
        for (const note of input.notes) {
            lines.push(note);
            lines.push('');
        }
    }
    lines.push('## 环境注释');
    lines.push('');
    lines.push('被压侧 (dogsvr / example-proj) 与压侧 (bot 集群 + Prometheus + Grafana) 同机运行,');
    lines.push('数值仅作相对参考,不应作为生产容量规划的绝对值。');
    lines.push('');
    return lines.join('\n');
}

function collectGitRevisions(): string {
    const repos = [
        '../../../../dogsvr',
        '../../../../cl-tsrpc',
        '../../../../cl-grpc',
        '../../../../cfg-luban',
        '../../../../example-proj-cfg',
        '../../../../example-proj',
        '../../../../example-proj-client',
        '../../../../logger',
    ];
    const lines: string[] = [];
    for (const rel of repos) {
        const abs = path.resolve(__dirname, rel);
        if (!fs.existsSync(abs)) continue;
        try {
            const sha = execSync(`git -C "${abs}" rev-parse HEAD 2>/dev/null`).toString().trim();
            const dirty = execSync(`git -C "${abs}" status --short 2>/dev/null | wc -l`).toString().trim();
            const name = path.basename(abs);
            lines.push(`${name.padEnd(20)} ${sha} ${Number(dirty) > 0 ? `(${dirty} dirty file(s))` : ''}`);
        } catch {
            // not a git repo or git unavailable
        }
    }
    return lines.join('\n') + '\n';
}
