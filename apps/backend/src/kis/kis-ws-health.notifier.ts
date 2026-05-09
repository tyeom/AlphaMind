import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subscription } from 'rxjs';
import { KisWebSocketService } from './kis-websocket.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification.entity';

/**
 * KIS WebSocket 의 연결 상태 알림(connectionAlert$)을 받아
 * `SCHEDULED_TRADER_USER_ID` 사용자에게 Notification 으로 전달한다.
 * KIS 모듈 내부에서 도는 저수준 transport 와 사용자 알림 도메인을 분리하기 위해 별도 서비스로 둠.
 */
@Injectable()
export class KisWsHealthNotifier implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KisWsHealthNotifier.name);
  private subscription?: Subscription;

  constructor(
    private readonly kisWsService: KisWebSocketService,
    private readonly notificationService: NotificationService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    this.subscription = this.kisWsService.connectionAlert$.subscribe(
      (event) => {
        this.handleAlert(event).catch((err: any) => {
          this.logger.warn(
            `KIS WS 알림 발행 실패: ${err.message ?? err}`,
          );
        });
      },
    );
  }

  onModuleDestroy() {
    this.subscription?.unsubscribe();
  }

  private async handleAlert(event: {
    kind: 'disconnected' | 'reconnected';
    failureCount: number;
    lastError?: string;
    downSinceMs?: number;
  }): Promise<void> {
    const userId = this.configService.get<number>('SCHEDULED_TRADER_USER_ID');
    if (!userId) {
      this.logger.warn(
        'SCHEDULED_TRADER_USER_ID 미설정 — KIS WS 상태 알림 발행 스킵',
      );
      return;
    }

    if (event.kind === 'disconnected') {
      const downMin = Math.round((event.downSinceMs ?? 0) / 60_000);
      await this.notificationService.create(
        userId,
        NotificationType.KIS_WS_DISCONNECTED,
        'KIS 실시간 연결 끊김',
        `KIS WebSocket 이 ${event.failureCount}회 연속 재연결에 실패하고 있습니다. ` +
          `자동 재연결을 계속 시도 중입니다 (현재 ${downMin}분 무복구). ` +
          `복구되지 않으면 실시간 매수/체결 신호 처리가 지연됩니다. ` +
          `마지막 오류: ${event.lastError ?? '알 수 없음'}`,
        {
          kind: 'kis_ws_disconnected',
          failureCount: event.failureCount,
          downSinceMs: event.downSinceMs,
          lastError: event.lastError,
        },
      );
    } else {
      await this.notificationService.create(
        userId,
        NotificationType.KIS_WS_RECONNECTED,
        'KIS 실시간 연결 복구',
        `KIS WebSocket 재연결에 성공했습니다. 실시간 신호 처리가 정상화되었습니다. ` +
          `(직전 누적 실패 ${event.failureCount}회)`,
        {
          kind: 'kis_ws_reconnected',
          failureCount: event.failureCount,
        },
      );
    }
  }
}
