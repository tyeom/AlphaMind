import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { EntityManager } from '@mikro-orm/postgresql';
import { firstValueFrom } from 'rxjs';
import { KisService } from './kis.service';
import {
  KisApiResponse,
  KisOrderOutput,
  KisRealtimeOrderNotification,
  OrderDivision,
} from './kis.types';
import {
  TradeHistoryEntity,
  TradeType,
  TradeAction,
  TradeStatus,
} from './entities/trade-history.entity';
import { UserEntity } from '../user/entities/user.entity';

@Injectable()
export class KisOrderService {
  private readonly logger = new Logger(KisOrderService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly kisService: KisService,
    private readonly em: EntityManager,
  ) {}

  /** 현금 매수/매도 주문 */
  async orderCash(params: {
    stockCode: string;
    orderType: 'buy' | 'sell';
    orderDvsn: OrderDivision;
    quantity: number;
    price: number;
    userId: number;
    metadata?: Record<string, any>;
  }): Promise<KisApiResponse<KisOrderOutput>> {
    // 입력 검증 — undefined/NaN가 그대로 KIS로 전송되어 500을 받는 것을 방지
    const quantity = Number(params.quantity);
    const price = Number(params.price ?? 0);
    if (!params.stockCode || !Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException(
        '주문 수량이 올바르지 않습니다. (stockCode, quantity 필수)',
      );
    }
    if (!Number.isFinite(price) || price < 0) {
      throw new BadRequestException('주문 단가가 올바르지 않습니다.');
    }
    if (params.orderDvsn !== '01' && price <= 0) {
      throw new BadRequestException('지정가 주문은 단가가 필요합니다.');
    }

    const trId = this.kisService.getTrId(
      params.orderType === 'buy' ? 'TTTC0012U' : 'TTTC0011U',
      params.orderType === 'buy' ? 'VTTC0012U' : 'VTTC0011U',
    );

    const body = {
      CANO: this.kisService.accountNo,
      ACNT_PRDT_CD: this.kisService.accountProdCd,
      PDNO: params.stockCode,
      ORD_DVSN: params.orderDvsn,
      ORD_QTY: String(quantity),
      ORD_UNPR: String(price),
    };

    const headers = await this.kisService.getAuthHeaders(trId);
    const hashkey = await this.kisService.getHashkey(body);

    let data: KisApiResponse<KisOrderOutput>;
    try {
      const res = await firstValueFrom(
        this.httpService.post(
          `${this.kisService.baseUrl}/uapi/domestic-stock/v1/trading/order-cash`,
          body,
          { headers: { ...headers, hashkey } },
        ),
      );
      data = res.data;
    } catch (err: any) {
      // KIS 응답 바디에 에러 메시지가 담겨 오는 경우가 많음 — 함께 로깅/저장
      const kisBody = err?.response?.data;
      const detailedMessage =
        (kisBody &&
          (kisBody.msg1 ||
            kisBody.error_description ||
            JSON.stringify(kisBody))) ||
        err.message ||
        'KIS 주문 요청 실패';
      this.logger.error(
        `KIS 주문 요청 실패: ${params.stockCode} ${quantity}주 @ ${price} — ${detailedMessage}`,
      );
      await this.saveHistory({
        userId: params.userId,
        action: TradeAction.ORDER,
        tradeType: params.orderType === 'buy' ? TradeType.BUY : TradeType.SELL,
        stockCode: params.stockCode,
        orderDvsn: params.orderDvsn,
        quantity,
        price,
        status: TradeStatus.FAILED,
        errorMessage: detailedMessage,
        rawResponse: {
          kisResponse: kisBody,
          meta: params.metadata ?? null,
        },
      });
      throw err;
    }

    await this.saveHistory({
      userId: params.userId,
      action: TradeAction.ORDER,
      tradeType: params.orderType === 'buy' ? TradeType.BUY : TradeType.SELL,
      stockCode: params.stockCode,
      orderDvsn: params.orderDvsn,
      quantity,
      price,
      status:
        data.rt_cd === '0'
          ? params.metadata?.trackingMode === 'optimistic-fallback'
            ? TradeStatus.SUCCESS
            : TradeStatus.ACCEPTED
          : TradeStatus.FAILED,
      kisOrderNo: data.output?.ODNO,
      errorMessage: data.rt_cd !== '0' ? data.msg1 : undefined,
      rawResponse: {
        kisResponse: data,
        meta: params.metadata ?? null,
      },
    });

    return data;
  }

  /** 체결통보 기준으로 주문 이력을 체결 상태로 갱신 */
  async recordExecutionNotification(
    notification: KisRealtimeOrderNotification,
  ): Promise<{
    history: TradeHistoryEntity;
    appliedQty: number;
    previousExecutedQty: number;
    isFullyExecuted: boolean;
  } | null> {
    const history = await this.em.findOne(
      TradeHistoryEntity,
      {
        action: TradeAction.ORDER,
        kisOrderNo: notification.orderNo,
        status: {
          $in: [TradeStatus.ACCEPTED, TradeStatus.PARTIAL],
        },
      },
      { orderBy: { createdAt: 'DESC' } },
    );

    if (!history) {
      return null;
    }

    const previousExecutedQty = Number(history.executedQuantity) || 0;
    const remainingQty = Math.max(0, history.quantity - previousExecutedQty);
    const appliedQty = Math.min(
      remainingQty,
      Math.max(0, Number(notification.executionQty) || 0),
    );

    if (appliedQty <= 0) {
      return null;
    }

    history.executedQuantity = previousExecutedQty + appliedQty;
    history.executedAmount =
      Number(history.executedAmount) +
      Math.round((Number(notification.executionPrice) || 0) * appliedQty);
    history.lastExecutedAt = new Date();
    history.status =
      history.executedQuantity >= history.quantity
        ? TradeStatus.EXECUTED
        : TradeStatus.PARTIAL;
    history.rawResponse = {
      ...(history.rawResponse ?? {}),
      lastNotification: notification,
    };

    await this.em.flush();

    return {
      history,
      appliedQty,
      previousExecutedQty,
      isFullyExecuted: history.status === TradeStatus.EXECUTED,
    };
  }

  /** 거부 통보를 받은 주문 이력을 실패 상태로 마감 */
  async markOrderRejected(
    notification: KisRealtimeOrderNotification,
  ): Promise<TradeHistoryEntity | null> {
    const history = await this.em.findOne(
      TradeHistoryEntity,
      {
        action: TradeAction.ORDER,
        kisOrderNo: notification.orderNo,
        status: {
          $in: [TradeStatus.ACCEPTED, TradeStatus.PARTIAL],
        },
      },
      { orderBy: { createdAt: 'DESC' } },
    );

    if (!history) {
      return null;
    }

    history.status = TradeStatus.FAILED;
    history.errorMessage = 'KIS 체결통보상 주문이 거부되었습니다.';
    history.rawResponse = {
      ...(history.rawResponse ?? {}),
      lastNotification: notification,
    };
    await this.em.flush();
    return history;
  }

  /** 주문 정정 */
  async modifyOrder(params: {
    orgOrderNo: string;
    krxOrgNo: string;
    orderDvsn: OrderDivision;
    quantity: number;
    price: number;
    allQty: boolean;
    userId: number;
  }): Promise<KisApiResponse<KisOrderOutput>> {
    const trId = this.kisService.getTrId('TTTC0013U', 'VTTC0013U');

    const body = {
      CANO: this.kisService.accountNo,
      ACNT_PRDT_CD: this.kisService.accountProdCd,
      KRX_FWDG_ORD_ORGNO: params.krxOrgNo,
      ORGN_ODNO: params.orgOrderNo,
      ORD_DVSN: params.orderDvsn,
      RVSE_CNCL_DVSN_CD: '01',
      ORD_QTY: String(params.quantity),
      ORD_UNPR: String(params.price),
      QTY_ALL_ORD_YN: params.allQty ? 'Y' : 'N',
    };

    const headers = await this.kisService.getAuthHeaders(trId);
    const hashkey = await this.kisService.getHashkey(body);

    let data: KisApiResponse<KisOrderOutput>;
    try {
      const res = await firstValueFrom(
        this.httpService.post(
          `${this.kisService.baseUrl}/uapi/domestic-stock/v1/trading/order-rvsecncl`,
          body,
          { headers: { ...headers, hashkey } },
        ),
      );
      data = res.data;
    } catch (err: any) {
      await this.saveHistory({
        userId: params.userId,
        action: TradeAction.MODIFY,
        stockCode: '',
        orderDvsn: params.orderDvsn,
        quantity: params.quantity,
        price: params.price,
        kisOrgOrderNo: params.orgOrderNo,
        status: TradeStatus.FAILED,
        errorMessage: err.message,
      });
      throw err;
    }

    await this.saveHistory({
      userId: params.userId,
      action: TradeAction.MODIFY,
      stockCode: '',
      orderDvsn: params.orderDvsn,
      quantity: params.quantity,
      price: params.price,
      kisOrgOrderNo: params.orgOrderNo,
      status: data.rt_cd === '0' ? TradeStatus.SUCCESS : TradeStatus.FAILED,
      kisOrderNo: data.output?.ODNO,
      errorMessage: data.rt_cd !== '0' ? data.msg1 : undefined,
      rawResponse: data,
    });

    return data;
  }

  /** 주문 취소 */
  async cancelOrder(params: {
    orgOrderNo: string;
    krxOrgNo: string;
    allQty?: boolean;
    quantity?: number;
    userId: number;
  }): Promise<KisApiResponse<KisOrderOutput>> {
    const trId = this.kisService.getTrId('TTTC0013U', 'VTTC0013U');

    const body = {
      CANO: this.kisService.accountNo,
      ACNT_PRDT_CD: this.kisService.accountProdCd,
      KRX_FWDG_ORD_ORGNO: params.krxOrgNo,
      ORGN_ODNO: params.orgOrderNo,
      ORD_DVSN: '00',
      RVSE_CNCL_DVSN_CD: '02',
      ORD_QTY: params.allQty ? '0' : String(params.quantity ?? 0),
      ORD_UNPR: '0',
      QTY_ALL_ORD_YN: params.allQty !== false ? 'Y' : 'N',
    };

    const headers = await this.kisService.getAuthHeaders(trId);
    const hashkey = await this.kisService.getHashkey(body);

    let data: KisApiResponse<KisOrderOutput>;
    try {
      const res = await firstValueFrom(
        this.httpService.post(
          `${this.kisService.baseUrl}/uapi/domestic-stock/v1/trading/order-rvsecncl`,
          body,
          { headers: { ...headers, hashkey } },
        ),
      );
      data = res.data;
    } catch (err: any) {
      await this.saveHistory({
        userId: params.userId,
        action: TradeAction.CANCEL,
        stockCode: '',
        orderDvsn: '00',
        quantity: params.quantity ?? 0,
        price: 0,
        kisOrgOrderNo: params.orgOrderNo,
        status: TradeStatus.FAILED,
        errorMessage: err.message,
      });
      throw err;
    }

    await this.saveHistory({
      userId: params.userId,
      action: TradeAction.CANCEL,
      stockCode: '',
      orderDvsn: '00',
      quantity: params.quantity ?? 0,
      price: 0,
      kisOrgOrderNo: params.orgOrderNo,
      status: data.rt_cd === '0' ? TradeStatus.SUCCESS : TradeStatus.FAILED,
      kisOrderNo: data.output?.ODNO,
      errorMessage: data.rt_cd !== '0' ? data.msg1 : undefined,
      rawResponse: data,
    });

    return data;
  }

  private async saveHistory(params: {
    userId: number;
    action: TradeAction;
    tradeType?: TradeType;
    stockCode: string;
    orderDvsn: string;
    quantity: number;
    price: number;
    kisOrderNo?: string;
    kisOrgOrderNo?: string;
    status: TradeStatus;
    errorMessage?: string;
    rawResponse?: Record<string, any>;
  }): Promise<void> {
    try {
      // quantity/price는 엔티티에서 non-null — 상위 호출자가 undefined를 넘기더라도
      // 실패 로그가 소실되지 않도록 0으로 기본값 처리
      const quantity = Number.isFinite(Number(params.quantity))
        ? Number(params.quantity)
        : 0;
      const price = Number.isFinite(Number(params.price))
        ? Number(params.price)
        : 0;
      const history = this.em.create(TradeHistoryEntity, {
        user: this.em.getReference(UserEntity, params.userId),
        action: params.action,
        tradeType: params.tradeType,
        stockCode: params.stockCode || '',
        orderDvsn: params.orderDvsn || '',
        quantity,
        price,
        kisOrderNo: params.kisOrderNo,
        kisOrgOrderNo: params.kisOrgOrderNo,
        status: params.status,
        errorMessage: params.errorMessage,
        rawResponse: params.rawResponse,
      });
      await this.em.persistAndFlush(history);
    } catch (err) {
      this.logger.error('매매 기록 저장 실패', err);
    }
  }
}
