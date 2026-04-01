import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, WebSocket } from 'ws';
import { Subscription } from 'rxjs';
import { KisWebSocketService } from './kis-websocket.service';
import { KisRealtimeTrId } from './kis.types';

interface ClientMeta {
  subscriptions: Set<string>; // "trId:trKey" 형태
  rxSubs: Subscription[];
}

@WebSocketGateway({ path: '/ws/kis' })
export class KisWebSocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(KisWebSocketGateway.name);
  private clients = new Map<WebSocket, ClientMeta>();
  /** trId:trKey → 구독 중인 클라이언트 수 */
  private refCount = new Map<string, number>();

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly kisWsService: KisWebSocketService,
    private readonly configService: ConfigService,
  ) {}

  afterInit() {
    this.logger.log('KIS WebSocket Gateway 초기화 완료 (path: /ws/kis)');
  }

  handleConnection(client: WebSocket) {
    this.clients.set(client, { subscriptions: new Set(), rxSubs: [] });
    this.logger.log(`클라이언트 연결 (현재 ${this.clients.size}명)`);
  }

  handleDisconnect(client: WebSocket) {
    const meta = this.clients.get(client);
    if (meta) {
      // 이 클라이언트의 구독 해제
      for (const key of meta.subscriptions) {
        this.decrementRef(key);
      }
      meta.rxSubs.forEach((s) => s.unsubscribe());
    }
    this.clients.delete(client);
    this.logger.log(`클라이언트 연결 해제 (현재 ${this.clients.size}명)`);
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: WebSocket) {
    this.sendToClient(client, 'pong', {});
  }

  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() data: { type: string; stockCode: string },
  ) {
    const trId = this.resolveRealtimeTrId(data.type);
    if (!trId) {
      this.sendToClient(client, 'error', {
        message: `Unknown type: ${data.type}`,
      });
      return;
    }

    const key = `${trId}:${data.stockCode}`;
    const meta = this.clients.get(client);
    if (!meta || meta.subscriptions.has(key)) return;

    meta.subscriptions.add(key);

    // 첫 구독자면 KIS에 실제 구독
    const prev = this.refCount.get(key) ?? 0;
    this.refCount.set(key, prev + 1);
    if (prev === 0) {
      this.kisWsService.subscribe(trId, data.stockCode);
    }

    // RxJS 스트림 → 이 클라이언트로 포워딩
    if (meta.rxSubs.length === 0) {
      meta.rxSubs.push(
        this.kisWsService.execution$.subscribe((d) => {
          if (meta.subscriptions.has(`H0STCNT0:${d.stockCode}`)) {
            this.sendToClient(client, 'execution', d);
          }
        }),
        this.kisWsService.orderbook$.subscribe((d) => {
          if (meta.subscriptions.has(`H0UNASP0:${d.stockCode}`)) {
            this.sendToClient(client, 'orderbook', d);
          }
        }),
        this.kisWsService.notification$.subscribe((d) => {
          const notiTrId = this.resolveRealtimeTrId('notification');
          if (
            notiTrId &&
            meta.subscriptions.has(`${notiTrId}:${d.stockCode}`)
          ) {
            this.sendToClient(client, 'notification', d);
          }
        }),
      );
    }

    this.sendToClient(client, 'subscribed', {
      type: data.type,
      stockCode: data.stockCode,
    });
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() data: { type: string; stockCode: string },
  ) {
    const trId = this.resolveRealtimeTrId(data.type);
    if (!trId) return;

    const key = `${trId}:${data.stockCode}`;
    const meta = this.clients.get(client);
    if (!meta || !meta.subscriptions.has(key)) return;

    meta.subscriptions.delete(key);
    this.decrementRef(key);

    this.sendToClient(client, 'unsubscribed', {
      type: data.type,
      stockCode: data.stockCode,
    });
  }

  private decrementRef(key: string) {
    const count = (this.refCount.get(key) ?? 1) - 1;
    if (count <= 0) {
      this.refCount.delete(key);
      const [trId, trKey] = key.split(':');
      this.kisWsService.unsubscribe(trId as KisRealtimeTrId, trKey);
    } else {
      this.refCount.set(key, count);
    }
  }

  private resolveRealtimeTrId(type: string): KisRealtimeTrId | null {
    switch (type) {
      case 'execution':
        return 'H0STCNT0';
      case 'orderbook':
        return 'H0UNASP0';
      case 'notification':
        return this.configService.get('KIS_ENV') === 'production'
          ? 'H0STCNI0'
          : 'H0STCNI9';
      default:
        return null;
    }
  }

  private sendToClient(client: WebSocket, event: string, data: any) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ event, data }));
    }
  }
}
