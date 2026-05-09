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
/** 연속 재연결 실패가 이 횟수 이상이면 사용자에게 알림 (≈ 30초~5분 무복구 후 통지) */
const RECONNECT_ALERT_THRESHOLD = 5;
/** 외부 헬스 체크 주기 — PINGPONG 모니터의 백업 안전망 */
const HEALTH_CHECK_INTERVAL = 60_000;

export interface KisWsHealth {
  connected: boolean;
  consecutiveFailures: number;
  alerted: boolean;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  reconnectAttempt: number;
}

export interface KisWsConnectionAlert {
  kind: 'disconnected' | 'reconnected';
  failureCount: number;
  lastError?: string;
  downSinceMs?: number;
}

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
  private consecutiveFailures = 0;
  private alerted = false;
  private lastConnectedAt: number | null = null;
  private lastDisconnectedAt: number | null = null;
  private lastConnectError: string | undefined;

  /** PINGPONG 헬스체크 */
  private pingpongTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPingpongAt: number = 0;

  /** 외부 헬스 모니터 */
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private hasWarnedMissingHtsId = false;
  private orderNotificationSubscriptionState:
    | 'idle'
    | 'pending'
    | 'subscribed'
    | 'failed' = 'idle';
  private orderNotificationSubscriptionPromise: Promise<boolean> | null = null;
  private orderNotificationSubscriptionResolver?:
    | ((value: boolean) => void)
    | undefined;
  private orderNotificationSubscriptionTimer: ReturnType<
    typeof setTimeout
  > | null = null;
  private lastOrderNotificationSubscriptionError?: string;

  /** 실시간 체결가 스트림 */
  readonly execution$ = new Subject<KisRealtimeExecution>();
  /** 실시간 호가 스트림 */
  readonly orderbook$ = new Subject<KisRealtimeOrderbook>();
  /** 실시간 체결통보 스트림 */
  readonly notification$ = new Subject<KisRealtimeOrderNotification>();
  /** 실시간 구독 결과 스트림 */
  readonly subscriptionResult$ = new Subject<KisRealtimeSubscriptionResult>();
  /** 연결 상태 변경 알림 — 임계 미충족 시점에서 disconnected, 복구 시 reconnected */
  readonly connectionAlert$ = new Subject<KisWsConnectionAlert>();

  constructor(
    private readonly httpService: HttpService,
    readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    this.startHealthCheckMonitor();
    await this.connect();
  }

  onModuleDestroy() {
    this.destroyed = true;
    this.clearReconnectTimer();
    this.clearPingpongTimer();
    this.clearHealthCheckTimer();
    this.clearOrderNotificationSubscriptionTimer();
    this.closeExistingSocket();
    this.execution$.complete();
    this.orderbook$.complete();
    this.notification$.complete();
    this.subscriptionResult$.complete();
    this.connectionAlert$.complete();
  }

  /** 현재 연결 상태 스냅샷 — 외부 모니터링/디버그용 */
  getHealth(): KisWsHealth {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      consecutiveFailures: this.consecutiveFailures,
      alerted: this.alerted,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      reconnectAttempt: this.reconnectAttempt,
    };
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
      this.lastConnectError = `approval_key: ${err.message ?? err}`;
      this.recordFailureAndMaybeAlert();
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
      this.lastConnectedAt = Date.now();
      this.logger.log('KIS WebSocket 연결 성공');
      this.resubscribeAll();
      this.startPingpongMonitor();
      this.handleConnectionRecovered();
    });

    this.ws.on('message', (raw: Buffer) => {
      this.handleMessage(raw.toString());
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason.toString() || 'N/A';
      this.logger.warn(
        `KIS WebSocket 연결 종료 (code: ${code}, reason: ${reasonStr})`,
      );
      this.lastDisconnectedAt = Date.now();
      this.lastConnectError = `close code=${code} reason=${reasonStr}`;
      this.clearPingpongTimer();
      if (this.orderNotificationSubscriptionState === 'pending') {
        this.finishOrderNotificationSubscription(false);
      } else if (this.orderNotificationSubscriptionState === 'subscribed') {
        this.orderNotificationSubscriptionState = 'idle';
      }
      this.recordFailureAndMaybeAlert();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.logger.error(`KIS WebSocket 오류: ${err.message}`);
      this.lastConnectError = `error: ${err.message}`;
      // error 이벤트 후 close 이벤트가 자동 발생하므로 여기서 reconnect하지 않음
    });
  }

  // ── 연결 상태 추적 ──

  /** 연결 실패/끊김을 카운트하고 임계 도달 시 한 번만 알림 발행 */
  private recordFailureAndMaybeAlert() {
    this.consecutiveFailures++;
    if (
      !this.alerted &&
      this.consecutiveFailures >= RECONNECT_ALERT_THRESHOLD
    ) {
      this.alerted = true;
      const downSinceMs =
        this.lastDisconnectedAt != null
          ? Date.now() - this.lastDisconnectedAt
          : 0;
      this.logger.error(
        `KIS WebSocket 연속 ${this.consecutiveFailures}회 재연결 실패 — 사용자 알림 발행`,
      );
      this.connectionAlert$.next({
        kind: 'disconnected',
        failureCount: this.consecutiveFailures,
        lastError: this.lastConnectError,
        downSinceMs,
      });
    }
  }

  /** 연결 성공 시 카운터 리셋. 직전에 알림이 발행됐으면 복구 알림. */
  private handleConnectionRecovered() {
    const failureCount = this.consecutiveFailures;
    this.consecutiveFailures = 0;
    if (this.alerted) {
      this.alerted = false;
      this.logger.log('KIS WebSocket 재연결 성공 — 복구 알림 발행');
      this.connectionAlert$.next({
        kind: 'reconnected',
        failureCount,
      });
    }
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

  // ── 외부 헬스체크 ──
  // PINGPONG 모니터는 정상 연결 후의 무응답을 감지하지만, 소켓이 오픈된 척만
  // 하면서 PINGPONG 도 안 들어오는 케이스/타이머 누락을 백업하는 안전망.

  private startHealthCheckMonitor() {
    this.clearHealthCheckTimer();
    this.healthCheckTimer = setInterval(() => {
      if (this.destroyed) return;
      // 재연결이 이미 예약되어 있거나 연결 시도 중이면 패스
      if (this.reconnectTimer || this.ws?.readyState === WebSocket.CONNECTING) {
        return;
      }
      const open = this.ws?.readyState === WebSocket.OPEN;
      if (!open) {
        this.logger.warn(
          'KIS WebSocket 헬스체크: 연결 미오픈 상태 감지 → 재연결 시도',
        );
        this.scheduleReconnect();
        return;
      }
      // OPEN 상태인데 PINGPONG 이 너무 오래 멎어 있다면 강제 재연결
      const sincePingpong = Date.now() - this.lastPingpongAt;
      if (this.lastPingpongAt > 0 && sincePingpong > PINGPONG_TIMEOUT) {
        this.logger.warn(
          `KIS WebSocket 헬스체크: PINGPONG ${Math.round(sincePingpong / 1000)}초 무응답 → 강제 재연결`,
        );
        this.closeExistingSocket();
        this.scheduleReconnect();
      }
    }, HEALTH_CHECK_INTERVAL);
  }

  private clearHealthCheckTimer() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
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

  /** 계좌 체결통보 구독 */
  async ensureOrderNotificationsSubscribed(timeoutMs = 5000): Promise<boolean> {
    const htsId = this.configService.get<string>('KIS_HTS_ID')?.trim();
    if (!htsId) {
      if (!this.hasWarnedMissingHtsId) {
        this.logger.warn(
          'KIS_HTS_ID 미설정: 실제 체결 기반 주문 추적을 사용하려면 HTS ID 설정이 필요합니다.',
        );
        this.hasWarnedMissingHtsId = true;
      }
      this.lastOrderNotificationSubscriptionError =
        'KIS_HTS_ID가 설정되지 않아 체결통보를 구독할 수 없습니다.';
      return false;
    }

    this.hasWarnedMissingHtsId = false;
    if (this.orderNotificationSubscriptionState === 'subscribed') {
      return true;
    }

    if (this.orderNotificationSubscriptionPromise) {
      return this.orderNotificationSubscriptionPromise;
    }

    this.orderNotificationSubscriptionState = 'pending';
    this.subscribe(this.getOrderNotificationTrId(), htsId, { force: true });

    this.orderNotificationSubscriptionPromise = new Promise<boolean>(
      (resolve) => {
        this.orderNotificationSubscriptionResolver = resolve;
        this.clearOrderNotificationSubscriptionTimer();
        this.orderNotificationSubscriptionTimer = setTimeout(() => {
          this.logger.error(
            '체결통보 구독 응답 대기 시간 초과: 주문 체결 추적을 사용할 수 없습니다.',
          );
          this.finishOrderNotificationSubscription(false);
        }, timeoutMs);
      },
    );

    return this.orderNotificationSubscriptionPromise;
  }

  /** 계좌 체결통보 구독 해제 */
  unsubscribeOrderNotifications() {
    const htsId = this.configService.get<string>('KIS_HTS_ID')?.trim();
    if (!htsId) return;
    this.unsubscribe(this.getOrderNotificationTrId(), htsId);
    this.finishOrderNotificationSubscription(false, { resetToIdle: true });
  }

  isOrderNotificationsSubscribed(): boolean {
    return this.orderNotificationSubscriptionState === 'subscribed';
  }

  getOrderNotificationSubscriptionError(): string | undefined {
    return this.lastOrderNotificationSubscriptionError;
  }

  private getOrderNotificationTrId(): KisRealtimeTrId {
    return this.configService.get('KIS_ENV') === 'production'
      ? 'H0STCNI0'
      : 'H0STCNI9';
  }

  private clearOrderNotificationSubscriptionTimer() {
    if (this.orderNotificationSubscriptionTimer) {
      clearTimeout(this.orderNotificationSubscriptionTimer);
      this.orderNotificationSubscriptionTimer = null;
    }
  }

  private finishOrderNotificationSubscription(
    success: boolean,
    options?: { resetToIdle?: boolean },
  ) {
    this.clearOrderNotificationSubscriptionTimer();
    const resolve = this.orderNotificationSubscriptionResolver;
    this.orderNotificationSubscriptionResolver = undefined;
    this.orderNotificationSubscriptionPromise = null;
    this.orderNotificationSubscriptionState = options?.resetToIdle
      ? 'idle'
      : success
        ? 'subscribed'
        : 'failed';
    if (success) {
      this.lastOrderNotificationSubscriptionError = undefined;
    }
    resolve?.(success);
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
        const orderNotificationTrId = this.getOrderNotificationTrId();
        const orderNotificationTrKey =
          this.configService.get<string>('KIS_HTS_ID')?.trim() ?? '';
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

        const isOrderNotificationSubscriptionResult =
          (trId === orderNotificationTrId &&
            trKey === orderNotificationTrKey &&
            Boolean(rtCd)) ||
          (this.orderNotificationSubscriptionState === 'pending' &&
            msgCd === 'OPSP0017' &&
            String(msg1 ?? '')
              .toLowerCase()
              .includes('htsid'));

        if (isOrderNotificationSubscriptionResult && rtCd) {
          if (!trId || !trKey) {
            this.subscriptionResult$.next({
              action: 'subscribe',
              trId: orderNotificationTrId,
              trKey: orderNotificationTrKey,
              success: rtCd === '0',
              code: msgCd ?? '',
              message: msg1 ?? '',
            });
          }

          if (rtCd === '0') {
            this.finishOrderNotificationSubscription(true);
          } else {
            this.lastOrderNotificationSubscriptionError =
              msg1 ?? '체결통보 구독에 실패했습니다.';
            this.logger.error(
              `체결통보 구독 실패: ${msg1 ?? '알 수 없는 오류'}`,
            );
            this.pendingSubscriptionActions.delete(
              `${orderNotificationTrId}:${orderNotificationTrKey}`,
            );
            this.finishOrderNotificationSubscription(false);
          }
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
