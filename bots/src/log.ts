// Tiny NDJSON structured logger to stdout.

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 } as const;
type Level = keyof typeof LEVELS;

const minLevel: number = LEVELS[(process.env.STRESS_LOG_LEVEL as Level) || 'info'];

function emit(level: Level, fields: Record<string, unknown>, msg?: string): void {
    if (LEVELS[level] < minLevel) return;
    const line = JSON.stringify({
        ts: Date.now(),
        level,
        msg,
        ...fields,
    });
    process.stdout.write(line + '\n');
}

export const log = {
    trace: (fields: Record<string, unknown>, msg?: string) => emit('trace', fields, msg),
    debug: (fields: Record<string, unknown>, msg?: string) => emit('debug', fields, msg),
    info:  (fields: Record<string, unknown>, msg?: string) => emit('info', fields, msg),
    warn:  (fields: Record<string, unknown>, msg?: string) => emit('warn', fields, msg),
    error: (fields: Record<string, unknown>, msg?: string) => emit('error', fields, msg),
};
