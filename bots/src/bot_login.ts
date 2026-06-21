// Single-bot login flow: dir (HTTP) + zonesvr (WS) via tsrpc Node SDK.

import { WsClient, HttpClient } from 'tsrpc';
import { serviceProto, type ServiceType } from '@dogsvr/cl-tsrpc/protocols/serviceProto';
import * as cmdId from 'example-proj/protocols/cmd_id';
import type {
    DirQueryZoneListReq, DirQueryZoneListRes,
    ZoneLoginReq, ZoneLoginRes,
    ZoneStartBattleReq, ZoneStartBattleRes,
    ZoneBattleEndNtf,
} from 'example-proj/protocols/cmd_proto';
import { cmdRtt, cmdSuccessTotal, cmdErrorTotal, classifyError } from './otel_metrics_client';
import { startClientSpan, injectTraceHead } from './otel_tracing_client';
import { log } from './log';

export interface BotEndpoints {
    dirHost: string;
    dirPort: number;    // default 10000
    zonesvrHost: string;
    zonesvrPort: number;  // default 20000
}

export const DEFAULT_ENDPOINTS: BotEndpoints = {
    dirHost: '127.0.0.1',
    dirPort: 10000,
    zonesvrHost: '127.0.0.1',
    zonesvrPort: 20000,
};

export interface LoginCredentials {
    openId: string;  // e.g. 'stress_42' — matches the stress:fill seeding scheme
    zoneId: number;
    name: string;
}

export interface BotRole {
    openId: string;
    zoneId: number;
    gid: number;
    name: string;
    score: number;
}

/**
 * One Bot = one persistent zonesvr WS connection.
 * Call connectAndLogin() to start.
 */
export class Bot {
    readonly creds: LoginCredentials;
    readonly endpoints: BotEndpoints;
    readonly scenario: string;

    private zoneClient: WsClient<ServiceType> | null = null;
    private role: BotRole | null = null;

    constructor(creds: LoginCredentials, scenario: string, endpoints: BotEndpoints = DEFAULT_ENDPOINTS) {
        this.creds = creds;
        this.endpoints = endpoints;
        this.scenario = scenario;
    }

    getRole(): BotRole | null {
        return this.role;
    }

    isConnected(): boolean {
        return this.zoneClient?.isConnected ?? false;
    }

    /** Anonymous dir HTTP call. */
    async queryZoneList(): Promise<DirQueryZoneListRes> {
        return startClientSpan('bot.DIR_QUERY_ZONE_LIST', { 'rpc.cmd_id': cmdId.DIR_QUERY_ZONE_LIST }, async () => {
            const dirClient = new HttpClient(serviceProto, {
                server: `http://${this.endpoints.dirHost}:${this.endpoints.dirPort}`,
            });
            const start = process.hrtime.bigint();
            try {
                const head = injectTraceHead<Record<string, unknown>>({ cmdId: cmdId.DIR_QUERY_ZONE_LIST, openId: '', zoneId: 0 });
                const ret = await dirClient.callApi('Common', {
                    head: head as never,
                    innerReq: JSON.stringify({} as DirQueryZoneListReq),
                });
                if (!ret.isSucc) {
                    cmdErrorTotal.add({ cmd: 'DIR_QUERY_ZONE_LIST', scenario: this.scenario, kind: 'server_error' });
                    throw new Error(ret.err.message);
                }
                cmdRtt.record(Number(process.hrtime.bigint() - start) / 1e6, { cmd: 'DIR_QUERY_ZONE_LIST', scenario: this.scenario });
                cmdSuccessTotal.add({ cmd: 'DIR_QUERY_ZONE_LIST', scenario: this.scenario });
                return JSON.parse(ret.res.innerRes as string) as DirQueryZoneListRes;
            } catch (err) {
                cmdErrorTotal.add({ cmd: 'DIR_QUERY_ZONE_LIST', scenario: this.scenario, kind: classifyError(err) });
                throw err;
            }
        });
    }

    async connectAndLogin(): Promise<ZoneLoginRes> {
        return startClientSpan('bot.ZONE_LOGIN', { 'rpc.cmd_id': cmdId.ZONE_LOGIN, 'bot.openId': this.creds.openId }, async () => {
            this.zoneClient = new WsClient(serviceProto, {
                server: `ws://${this.endpoints.zonesvrHost}:${this.endpoints.zonesvrPort}`,
            });
            const connRes = await this.zoneClient.connect();
            if (!connRes.isSucc) {
                cmdErrorTotal.add({ cmd: 'zone_connect', scenario: this.scenario, kind: 'disconnect' });
                throw new Error(`zone connect failed: ${connRes.errMsg}`);
            }

            const start = process.hrtime.bigint();
            try {
                const req: ZoneLoginReq = { openId: this.creds.openId, zoneId: this.creds.zoneId, name: this.creds.name };
                const head = injectTraceHead<Record<string, unknown>>({ cmdId: cmdId.ZONE_LOGIN, openId: this.creds.openId, zoneId: this.creds.zoneId });
                const ret = await this.zoneClient.callApi('Common', {
                    head: head as never,
                    innerReq: JSON.stringify(req),
                });
                if (!ret.isSucc) {
                    cmdErrorTotal.add({ cmd: 'ZONE_LOGIN', scenario: this.scenario, kind: 'server_error' });
                    throw new Error(`ZONE_LOGIN failed: ${ret.err.message}`);
                }
                cmdRtt.record(Number(process.hrtime.bigint() - start) / 1e6, { cmd: 'ZONE_LOGIN', scenario: this.scenario });
                cmdSuccessTotal.add({ cmd: 'ZONE_LOGIN', scenario: this.scenario });
                const res = JSON.parse(ret.res.innerRes as string) as ZoneLoginRes;
                this.role = res.role as BotRole;
                return res;
            } catch (err) {
                cmdErrorTotal.add({ cmd: 'ZONE_LOGIN', scenario: this.scenario, kind: classifyError(err) });
                throw err;
            }
        });
    }

    /** Disconnect zonesvr WS. Idempotent. */
    async disconnect(): Promise<void> {
        if (this.zoneClient && this.zoneClient.isConnected) {
            await this.zoneClient.disconnect();
        }
        this.zoneClient = null;
    }

    /** Reconnect after a transient drop (used by scenario D). */
    async reconnect(): Promise<ZoneLoginRes> {
        await this.disconnect();
        return this.connectAndLogin();
    }

    /** Start a battle, returning the ticket + battlesvr addr. */
    async startBattle(syncType: string): Promise<ZoneStartBattleRes> {
        if (!this.zoneClient || !this.role) throw new Error('startBattle before login');
        return startClientSpan('bot.ZONE_START_BATTLE', { 'rpc.cmd_id': cmdId.ZONE_START_BATTLE, 'bot.syncType': syncType }, async () => {
            const start = process.hrtime.bigint();
            try {
                const req: ZoneStartBattleReq = { syncType };
                const head = injectTraceHead<Record<string, unknown>>({ cmdId: cmdId.ZONE_START_BATTLE, openId: this.role!.openId, zoneId: this.role!.zoneId });
                const ret = await this.zoneClient!.callApi('Common', {
                    head: head as never,
                    innerReq: JSON.stringify(req),
                });
                if (!ret.isSucc) {
                    cmdErrorTotal.add({ cmd: 'ZONE_START_BATTLE', scenario: this.scenario, kind: 'server_error' });
                    throw new Error(`ZONE_START_BATTLE failed: ${ret.err.message}`);
                }
                cmdRtt.record(Number(process.hrtime.bigint() - start) / 1e6, { cmd: 'ZONE_START_BATTLE', scenario: this.scenario });
                cmdSuccessTotal.add({ cmd: 'ZONE_START_BATTLE', scenario: this.scenario });
                return JSON.parse(ret.res.innerRes as string) as ZoneStartBattleRes;
            } catch (err) {
                cmdErrorTotal.add({ cmd: 'ZONE_START_BATTLE', scenario: this.scenario, kind: classifyError(err) });
                throw err;
            }
        });
    }

    /** Listen for ZONE_BATTLE_END_NTF push from server. */
    onBattleEnd(handler: (ntf: ZoneBattleEndNtf) => void): void {
        if (!this.zoneClient) throw new Error('onBattleEnd before connect');
        this.zoneClient.listenMsg('Common', (msg: any) => {
            if (msg.head?.cmdId === cmdId.ZONE_BATTLE_END_NTF) {
                try {
                    handler(JSON.parse(msg.innerMsg as string) as ZoneBattleEndNtf);
                } catch (err) {
                    log.warn({ err: String(err) }, 'failed to parse ZONE_BATTLE_END_NTF');
                }
            }
        });
    }
}
