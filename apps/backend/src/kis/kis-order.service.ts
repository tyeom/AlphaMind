import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { EntityManager } from '@mikro-orm/postgresql';
import { firstValueFrom } from 'rxjs';
import { KisService } from './kis.service';
import { KisApiResponse, KisOrderOutput, OrderDivision } from './kis.types';
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
  }): Promise<KisApiResponse<KisOrderOutput>> {
    const trId = this.kisService.getTrId(
      params.orderType === 'buy' ? 'TTTC0012U' : 'TTTC0011U',
      params.orderType === 'buy' ? 'VTTC0012U' : 'VTTC0011U',
    );

    const body = {
      CANO: this.kisService.accountNo,
      ACNT_PRDT_CD: this.kisService.accountProdCd,
      PDNO: params.stockCode,
      ORD_DVSN: params.orderDvsn,
      ORD_QTY: String(params.quantity),
      ORD_UNPR: String(params.price),
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
      await this.saveHistory({
        userId: params.userId,
        action: TradeAction.ORDER,
        tradeType: params.orderType === 'buy' ? TradeType.BUY : TradeType.SELL,
        stockCode: params.stockCode,
        orderDvsn: params.orderDvsn,
        quantity: params.quantity,
        price: params.price,
        status: TradeStatus.FAILED,
        errorMessage: err.message,
      });
      throw err;
    }

    await this.saveHistory({
      userId: params.userId,
      action: TradeAction.ORDER,
      tradeType: params.orderType === 'buy' ? TradeType.BUY : TradeType.SELL,
      stockCode: params.stockCode,
      orderDvsn: params.orderDvsn,
      quantity: params.quantity,
      price: params.price,
      status: data.rt_cd === '0' ? TradeStatus.SUCCESS : TradeStatus.FAILED,
      kisOrderNo: data.output?.ODNO,
      errorMessage: data.rt_cd !== '0' ? data.msg1 : undefined,
      rawResponse: data,
    });

    return data;
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
      const history = this.em.create(TradeHistoryEntity, {
        user: this.em.getReference(UserEntity, params.userId),
        action: params.action,
        tradeType: params.tradeType,
        stockCode: params.stockCode,
        orderDvsn: params.orderDvsn,
        quantity: params.quantity,
        price: params.price,
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
