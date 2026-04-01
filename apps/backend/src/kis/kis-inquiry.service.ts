import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { KisService } from './kis.service';
import {
  KisApiResponse,
  KisBalanceItem,
  KisBalanceSummary,
  KisBuyableOutput,
} from './kis.types';

@Injectable()
export class KisInquiryService {
  constructor(
    private readonly httpService: HttpService,
    private readonly kisService: KisService,
  ) {}

  /** 주식 잔고 조회 */
  async getBalance(): Promise<{
    items: KisBalanceItem[];
    summary: KisBalanceSummary;
  }> {
    const trId = this.kisService.getTrId('TTTC8434R', 'VTTC8434R');
    const headers = await this.kisService.getAuthHeaders(trId);

    const { data } = await firstValueFrom(
      this.httpService.get<
        KisApiResponse<KisBalanceItem[]> & { output2: KisBalanceSummary[] }
      >(
        `${this.kisService.baseUrl}/uapi/domestic-stock/v1/trading/inquire-balance`,
        {
          headers,
          params: {
            CANO: this.kisService.accountNo,
            ACNT_PRDT_CD: this.kisService.accountProdCd,
            AFHR_FLPR_YN: 'N',
            OFL_YN: '',
            INQR_DVSN: '02',
            UNPR_DVSN: '01',
            FUND_STTL_ICLD_YN: 'N',
            FNCG_AMT_AUTO_RDPT_YN: 'N',
            PRCS_DVSN: '00',
            CTX_AREA_FK100: '',
            CTX_AREA_NK100: '',
          },
        },
      ),
    );

    return {
      items: data.output1 ?? [],
      summary: data.output2?.[0] ?? ({} as KisBalanceSummary),
    };
  }

  /** 매수 가능 조회 */
  async getBuyableAmount(params: {
    stockCode: string;
    price?: number;
    orderDvsn?: string;
  }): Promise<KisBuyableOutput> {
    const trId = this.kisService.getTrId('TTTC8908R', 'VTTC8908R');
    const headers = await this.kisService.getAuthHeaders(trId);

    const { data } = await firstValueFrom(
      this.httpService.get<KisApiResponse<KisBuyableOutput>>(
        `${this.kisService.baseUrl}/uapi/domestic-stock/v1/trading/inquire-psbl-order`,
        {
          headers,
          params: {
            CANO: this.kisService.accountNo,
            ACNT_PRDT_CD: this.kisService.accountProdCd,
            PDNO: params.stockCode,
            ORD_UNPR: params.price ? String(params.price) : '',
            ORD_DVSN: params.orderDvsn ?? '01',
            CMA_EVLU_AMT_ICLD_YN: 'Y',
            OVRS_ICLD_YN: 'N',
          },
        },
      ),
    );

    return data.output!;
  }

  /** 일별 주문 체결 조회 */
  async getDailyOrders(params: {
    startDate: string;
    endDate: string;
    orderType?: 'all' | 'sell' | 'buy';
    status?: 'all' | 'executed' | 'pending';
  }): Promise<any[]> {
    const trId = this.kisService.getTrId('TTTC0081R', 'VTTC0081R');
    const headers = await this.kisService.getAuthHeaders(trId);

    const sllBuyDvsnCd =
      params.orderType === 'sell'
        ? '01'
        : params.orderType === 'buy'
          ? '02'
          : '00';
    const ccldDvsn =
      params.status === 'executed'
        ? '01'
        : params.status === 'pending'
          ? '02'
          : '00';

    const { data } = await firstValueFrom(
      this.httpService.get(
        `${this.kisService.baseUrl}/uapi/domestic-stock/v1/trading/inquire-daily-ccld`,
        {
          headers,
          params: {
            CANO: this.kisService.accountNo,
            ACNT_PRDT_CD: this.kisService.accountProdCd,
            INQR_STRT_DT: params.startDate,
            INQR_END_DT: params.endDate,
            SLL_BUY_DVSN_CD: sllBuyDvsnCd,
            INQR_DVSN: '00',
            PDNO: '',
            CCLD_DVSN: ccldDvsn,
            ORD_GNO_BRNO: '',
            ODNO: '',
            INQR_DVSN_3: '00',
            INQR_DVSN_1: '',
            CTX_AREA_FK100: '',
            CTX_AREA_NK100: '',
          },
        },
      ),
    );

    return data.output1 ?? [];
  }
}
