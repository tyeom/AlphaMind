import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Subject } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { createDecipheriv } from 'crypto';
import WebSocket from 'ws';
import {
  KisRealtimeExecution,
  KisRealtimeOrderbook,
  KisRealtimeOrderNotification,
  KisRealtimeSubscriptionResult,
  KisRealtimeTrId,
} from './kis.types';

/** 재연결 설정 */
const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 60000;
const PINGPONG_TIMEOUT = 90000; // KIS 서버 PING 주기(약 60초) + 여유

@Injectable()
export class KisWebSocketService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KisWebSocketService.name);
  private ws: WebSocket | null = null;
  private approvalKey: string | null = null;
  private aesIv: string | null = null;
  private aesKey: string | null = null;
  private subscriptions = new Map<string, Set<string>>();
  private pendingSubscriptionActions = new Map<
    string,
    'subscribe' | 'unsubscribe'
  >();

  /** 재연결 상태 */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private destroyed = false;

  /** PINGPONG 헬스체크 */
  private pingpongTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPingpongAt: number = 0;

  /** 실시간 체결가 스트림 */
  readonly execution$ = new Subject<KisRealtimeExecution>();
  /** 실시간 호가 스트림 */
  readonly orderbook$ = new Subject<KisRealtimeOrderbook>();
  /** 실시간 체결통보 스트림 */
  readonly notification$ = new Subject<KisRealtimeOrderNotification>();
  /** 실시간 구독 결과 스트림 */
  readonly subscriptionResult$ = new Subject<KisRealtimeSubscriptionResult>();

  constructor(
    private readonly httpService: HttpService,
    readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    await this.connect();
  }

  onModuleDestroy() {
    this.destroyed = true;
    this.clearReconnectTimer();
    this.clearPingpongTimer();
    this.closeExistingSocket();
    this.execution$.complete();
    this.orderbook$.complete();
    this.notification$.complete();
    this.subscriptionResult$.complete();
  }

  /** WebSocket 접속키 발급 (REST) */
  private async getApprovalKey(): Promise<string> {
    const baseUrl =
      this.configService.get('KIS_ENV') === 'production'
        ? 'https://openapi.koreainvestment.com:9443'
        : 'https://openapivts.koreainvestment.com:29443';

    const { data } = await firstValueFrom(
      this.httpService.post(`${baseUrl}/oauth2/Approval`, {
        grant_type: 'client_credentials',
        appkey: this.configService.get('KIS_APP_KEY'),
        secretkey: this.configService.get('KIS_APP_SECRET'),
      }),
    );

    return data.approval_key;
  }

  /** 기존 소켓 정리 */
  private closeExistingSocket() {
    if (this.ws) {
      this.ws.removeAllListeners();
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  /** KIS WebSocket 연결 */
  private async connect() {
    if (this.destroyed) return;

    // 기존 소켓이 남아있으면 정리
    this.closeExistingSocket();
    this.clearPingpongTimer();

    // 접속키 발급
    try {
      this.approvalKey = await this.getApprovalKey();
      this.logger.log('KIS WebSocket 접속키 발급 완료');
    } catch (err: any) {
      this.logger.error(`접속키 발급 실패: ${err.message}`);
      this.scheduleReconnect();
      return;
    }

    const wsUrl =
      this.configService.get('KIS_ENV') === 'production'
        ? 'ws://ops.koreainvestment.com:21000'
        : 'ws://ops.koreainvestment.com:31000';

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      this.reconnectAttempt = 0;
      this.logger.log('KIS WebSocket 연결 성공');
      this.resubscribeAll();
      this.startPingpongMonitor();
    });

    this.ws.on('message', (raw: Buffer) => {
      this.handleMessage(raw.toString());
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.logger.warn(
        `KIS WebSocket 연결 종료 (code: ${code}, reason: ${reason.toString() || 'N/A'})`,
      );
      this.clearPingpongTimer();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.logger.error(`KIS WebSocket 오류: ${err.message}`);
      // error 이벤트 후 close 이벤트가 자동 발생하므로 여기서 reconnect하지 않음
    });
  }

  // ── 재연결 (Exponential Backoff) ──

  private scheduleReconnect() {
    if (this.destroyed) return;

    this.clearReconnectTimer();
    this.reconnectAttempt++;

    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempt - 1),
      RECONNECT_MAX_DELAY,
    );

    this.logger.log(
      `KIS WebSocket 재연결 예약 (시도 #${this.reconnectAttempt}, ${delay / 1000}초 후)`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── PINGPONG 헬스체크 ──
  // KIS 서버는 주기적으로 PINGPONG 메시지를 보냄.
  // 일정 시간 내 PINGPONG을 못 받으면 연결이 죽은 것으로 간주하고 재연결.

  private startPingpongMonitor() {
    this.lastPingpongAt = Date.now();
    this.clearPingpongTimer();

    this.pingpongTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastPingpongAt;
      if (elapsed > PINGPONG_TIMEOUT) {
        this.logger.warn(
          `PINGPONG 타임아웃 (${Math.round(elapsed / 1000)}초 무응답), 연결 재시작`,
        );
        this.clearPingpongTimer();
        this.closeExistingSocket();
        this.scheduleReconnect();
      }
    }, 30000);
  }

  private clearPingpongTimer() {
    if (this.pingpongTimer) {
      clearInterval(this.pingpongTimer);
      this.pingpongTimer = null;
    }
  }

  // ── 구독 관리 ──

  /** 종목 구독 */
  subscribe(
    trId: KisRealtimeTrId,
    trKey: string,
    options?: { force?: boolean },
  ) {
    if (!this.subscriptions.has(trId)) {
      this.subscriptions.set(trId, new Set());
    }
    const keys = this.subscriptions.get(trId)!;
    const alreadySubscribed = keys.has(trKey);
    keys.add(trKey);

    if (alreadySubscribed && !options?.force) {
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(
        `WebSocket 미연결 상태, 구독 대기열에 추가 (${trId}:${trKey})`,
      );
      return;
    }

    this.sendSubscription('1', trId, trKey);
  }

  /** 구독 해제 */
  unsubscribe(trId: KisRealtimeTrId, trKey: string) {
    const deleted = this.subscriptions.get(trId)?.delete(trKey);
    if (!deleted) {
      return;
    }
    this.sendSubscription('2', trId, trKey);
  }

  private sendSubscription(trType: '1' | '2', trId: string, trKey: string) {
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.approvalKey
    ) {
      return;
    }

    this.ws.send(
      JSON.stringify({
        header: {
          approval_key: this.approvalKey,
          custtype: 'P',
          tr_type: trType,
          'content-type': 'utf-8',
        },
        body: {
          input: { tr_id: trId, tr_key: trKey },
        },
      }),
    );

    this.pendingSubscriptionActions.set(
      `${trId}:${trKey}`,
      trType === '1' ? 'subscribe' : 'unsubscribe',
    );
  }

  /** 재연결 시 기존 구독 복원 */
  private resubscribeAll() {
    let count = 0;
    for (const [trId, keys] of this.subscriptions) {
      for (const trKey of keys) {
        this.sendSubscription('1', trId, trKey);
        count++;
      }
    }
    if (count > 0) {
      this.logger.log(`기존 구독 ${count}건 복원 완료`);
    }
  }

  // ── 메시지 처리 ──

  /** 수신 메시지 처리 */
  private handleMessage(raw: string) {
    // PINGPONG 응답
    if (raw === 'PINGPONG') {
      this.lastPingpongAt = Date.now();
      this.ws?.send('PINGPONG');
      return;
    }

    // JSON 응답 (구독 확인)
    if (raw.startsWith('{')) {
      try {
        const json = JSON.parse(raw);
        const trId = json.header?.tr_id;
        const trKey = json.header?.tr_key;
        const rtCd = json.body?.rt_cd;
        const msgCd = json.body?.msg_cd;
        const msg1 = json.body?.msg1;
        const pendingAction =
          trId && trKey
            ? this.pendingSubscriptionActions.get(`${trId}:${trKey}`)
            : undefined;
        const action =
          pendingAction ??
          (String(msg1 ?? '')
            .toUpperCase()
            .includes('UNSUBSCRIBE')
            ? 'unsubscribe'
            : 'subscribe');

        if (json.body?.output?.iv) {
          this.aesIv = json.body.output.iv;
          this.aesKey = json.body.output.key;
        }

        if (trId && trKey && rtCd) {
          this.pendingSubscriptionActions.delete(`${trId}:${trKey}`);
          this.subscriptionResult$.next({
            action,
            trId,
            trKey,
            success: rtCd === '0',
            code: msgCd ?? '',
            message: msg1 ?? '',
          });
        }

        if (rtCd !== '0') {
          this.logger.warn(
            `구독 실패: ${trId ?? 'N/A'}:${trKey ?? 'N/A'} - ${msg1}`,
          );
        }
      } catch {
        this.logger.warn('JSON 파싱 실패');
      }
      return;
    }

    // 파이프 구분 실시간 데이터: [암호화]|[TR_ID]|[건수]|[데이터...]
    const pipeIdx1 = raw.indexOf('|');
    const pipeIdx2 = raw.indexOf('|', pipeIdx1 + 1);
    const pipeIdx3 = raw.indexOf('|', pipeIdx2 + 1);
    if (pipeIdx3 === -1) return;

    const encrypted = raw.substring(0, pipeIdx1);
    const trId = raw.substring(pipeIdx1 + 1, pipeIdx2);
    const dataStr = raw.substring(pipeIdx3 + 1);

    let fields: string[];
    if (encrypted === '1' && this.aesIv && this.aesKey) {
      const decrypted = this.decryptAes256(dataStr, this.aesKey, this.aesIv);
      fields = decrypted.split('^');
    } else {
      fields = dataStr.split('^');
    }

    switch (trId) {
      case 'H0STCNT0':
        this.execution$.next(this.parseExecution(fields));
        break;
      case 'H0UNASP0':
        this.orderbook$.next(this.parseOrderbook(fields));
        break;
      case 'H0STCNI0':
      case 'H0STCNI9':
        this.notification$.next(this.parseNotification(fields));
        break;
    }
  }

  /** AES-256-CBC 복호화 */
  private decryptAes256(data: string, key: string, iv: string): string {
    const decipher = createDecipheriv(
      'aes-256-cbc',
      Buffer.from(key),
      Buffer.from(iv),
    );
    let decrypted = decipher.update(data, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /** 실시간 체결가 파싱 */
  private parseExecution(f: string[]): KisRealtimeExecution {
    return {
      stockCode: f[0]?.substring(0, 6) ?? f[0],
      time: f[1],
      price: Number(f[2]),
      changeSign: f[3],
      change: Number(f[4]),
      changeRate: Number(f[5]),
      weightedAvgPrice: Number(f[6]),
      openPrice: Number(f[7]),
      highPrice: Number(f[8]),
      lowPrice: Number(f[9]),
      askPrice1: Number(f[10]),
      bidPrice1: Number(f[11]),
      executionVolume: Number(f[12]),
      cumulativeVolume: Number(f[13]),
      cumulativeAmount: Number(f[14]),
      executionStrength: Number(f[18]),
      executionType: f[21],
    };
  }

  /** 실시간 호가 파싱 */
  private parseOrderbook(f: string[]): KisRealtimeOrderbook {
    const askPrices: number[] = [];
    const bidPrices: number[] = [];
    const askVolumes: number[] = [];
    const bidVolumes: number[] = [];

    for (let i = 0; i < 10; i++) {
      askPrices.push(Number(f[3 + i]));
      bidPrices.push(Number(f[13 + i]));
      askVolumes.push(Number(f[23 + i]));
      bidVolumes.push(Number(f[33 + i]));
    }

    return {
      stockCode: f[0]?.substring(0, 6) ?? f[0],
      time: f[1],
      askPrices,
      bidPrices,
      askVolumes,
      bidVolumes,
      totalAskVolume: Number(f[43]),
      totalBidVolume: Number(f[44]),
      expectedPrice: Number(f[51]),
      expectedVolume: Number(f[52]),
    };
  }

  /** 체결통보 파싱 */
  private parseNotification(f: string[]): KisRealtimeOrderNotification {
    return {
      accountNo: f[1],
      orderNo: f[2],
      originalOrderNo: f[3],
      orderType: f[4],
      modifyType: f[5],
      stockCode: f[8]?.substring(0, 6) ?? f[8],
      executionQty: Number(f[9]),
      executionPrice: Number(f[10]),
      time: f[11],
      isRejected: f[12] === '1',
      isExecuted: f[13] === '2',
      orderQty: Number(f[16]),
      stockName: f[24]?.trim(),
      orderPrice: Number(f[25]),
    };
  }
}
