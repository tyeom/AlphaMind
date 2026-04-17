import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, WebSocket } from 'ws';
import { AutoTradingService } from './auto-trading.service';

@WebSocketGateway({ path: '/ws/auto-trading' })
export class AutoTradingGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(AutoTradingGateway.name);
  private clients = new Set<WebSocket>();

  @WebSocketServer()
  server!: Server;

  constructor(private readonly autoTradingService: AutoTradingService) {}

  afterInit() {
    this.logger.log(
      'AutoTrading WebSocket Gateway 초기화 (path: /ws/auto-trading)',
    );
    this.autoTradingService.setGateway(this);
  }

  handleConnection(client: WebSocket) {
    this.clients.add(client);
    this.logger.log(
      `자동매매 WS 클라이언트 연결 (현재 ${this.clients.size}명)`,
    );
  }

  handleDisconnect(client: WebSocket) {
    this.clients.delete(client);
    this.logger.log(
      `자동매매 WS 클라이언트 해제 (현재 ${this.clients.size}명)`,
    );
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: WebSocket) {
    this.send(client, 'pong', {});
  }

  @SubscribeMessage('get-sessions')
  async handleGetSessions(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() data: { userId: number },
  ) {
    try {
      const sessions = await this.autoTradingService.getSessions(data.userId);
      this.send(client, 'sessions', sessions);
    } catch (err: any) {
      this.send(client, 'error', { message: err.message });
    }
  }

  /** 세션 업데이트를 모든 클라이언트에 브로드캐스트 */
  broadcastSessionUpdate(session: any) {
    this.broadcast('session-update', session);
  }

  /** 세션 제거를 모든 클라이언트에 브로드캐스트 */
  broadcastSessionRemoved(sessionId: number, stockCode: string) {
    this.broadcast('session-removed', { id: sessionId, stockCode });
  }

  /** 현재가 업데이트를 모든 클라이언트에 브로드캐스트 */
  broadcastPriceUpdate(data: {
    stockCode: string;
    price: number;
    volume?: number;
    timestamp?: string;
  }) {
    this.broadcast('price-update', {
      stockCode: data.stockCode,
      price: data.price,
      volume: data.volume ?? 0,
      timestamp: data.timestamp ?? new Date().toISOString(),
    });
  }

  /** 매매 실행 알림 */
  broadcastTradeExecuted(trade: any) {
    this.broadcast('trade-executed', trade);
  }

  /** 신호 감지 알림 */
  broadcastSignalDetected(signal: any) {
    this.broadcast('signal-detected', signal);
  }

  /** 알림 브로드캐스트 */
  broadcastNotification(notification: any) {
    this.broadcast('notification', notification);
  }

  private broadcast(event: string, data: any) {
    const message = JSON.stringify({ event, data });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  private send(client: WebSocket, event: string, data: any) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ event, data }));
    }
  }
}
