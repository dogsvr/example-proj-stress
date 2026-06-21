// Minimal CLI flag parser: long flags (--name value or --name=value) and bool flags (--name).

export interface ParsedArgs {
    flags: Record<string, string | boolean>;
    positional: string[];
}

export function parseArgs(argv = process.argv.slice(2)): ParsedArgs {
    const flags: Record<string, string | boolean> = {};
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const t = argv[i];
        if (!t.startsWith('--')) {
            positional.push(t);
            continue;
        }
        const body = t.slice(2);
        const eq = body.indexOf('=');
        if (eq >= 0) {
            flags[body.slice(0, eq)] = body.slice(eq + 1);
            continue;
        }
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
            flags[body] = next;
            i++;
        } else {
            flags[body] = true;
        }
    }
    return { flags, positional };
}

export function optNum(args: ParsedArgs, flag: string, fallback: number): number {
    const v = args.flags[flag];
    if (typeof v !== 'string') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

export function optStr(args: ParsedArgs, flag: string, fallback: string): string {
    const v = args.flags[flag];
    return typeof v === 'string' ? v : fallback;
}

export function hasFlag(args: ParsedArgs, flag: string): boolean {
    return args.flags[flag] !== undefined;
}

/** Format milliseconds as human-readable string. */
export function formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}min`;
}

/** Format epoch ms as local ISO string. */
export function tsLocal(ms: number): string {
    const d = new Date(ms);
    return d.toISOString().replace('T', ' ').slice(0, 19);
}
