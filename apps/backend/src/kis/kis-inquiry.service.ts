import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { KisService } from './kis.service';
import {
  KisApiResponse,
  KisBalanceItem,
  KisBalanceRealizedSummary,
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
        KisApiResponse<KisBalanceItem[]> & {
          output2: KisBalanceSummary[] | KisBalanceSummary;
        }
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

    if (data.rt_cd !== '0') {
      throw new Error(`KIS 잔고 조회 실패: [${data.msg_cd}] ${data.msg1}`);
    }

    return {
      items: data.output1 ?? [],
      summary: this.normalizeSummary<KisBalanceSummary>(data.output2),
    };
  }

  /** 실현손익 포함 주식 잔고 조회 (실전 계좌 전용 - TTTC8494R, VTS 미지원) */
  async getBalanceWithRealized(): Promise<{
    items: KisBalanceItem[];
    summary: KisBalanceRealizedSummary;
  }> {
    const headers = await this.kisService.getAuthHeaders('TTTC8494R');

    const { data } = await firstValueFrom(
      this.httpService.get<
        KisApiResponse<KisBalanceItem[]> & {
          output2: KisBalanceRealizedSummary[] | KisBalanceRealizedSummary;
        }
      >(
        `${this.kisService.baseUrl}/uapi/domestic-stock/v1/trading/inquire-balance-rlz-pl`,
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
            PRCS_DVSN: '01',
            COST_ICLD_YN: 'N',
            CTX_AREA_FK100: '',
            CTX_AREA_NK100: '',
          },
        },
      ),
    );

    if (data.rt_cd !== '0') {
      throw new Error(
        `KIS 실현손익 잔고 조회 실패: [${data.msg_cd}] ${data.msg1}`,
      );
    }

    return {
      items: data.output1 ?? [],
      summary: this.normalizeSummary<KisBalanceRealizedSummary>(data.output2),
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

  private normalizeSummary<T extends object>(output?: T[] | T): T {
    if (Array.isArray(output)) {
      return output[0] ?? {};
    }

    return (output ?? {}) as T;
  }
}
