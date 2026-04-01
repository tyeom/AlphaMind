import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { KisService } from './kis.service';
import { KisApiResponse, KisCurrentPrice, KisDailyPrice } from './kis.types';

@Injectable()
export class KisQuotationService {
  constructor(
    private readonly httpService: HttpService,
    private readonly kisService: KisService,
  ) {}

  /** 주식 현재가 조회 */
  async getCurrentPrice(stockCode: string): Promise<KisCurrentPrice> {
    const headers = await this.kisService.getAuthHeaders('FHKST01010100');

    const { data } = await firstValueFrom(
      this.httpService.get<KisApiResponse<KisCurrentPrice>>(
        `${this.kisService.baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price`,
        {
          headers,
          params: {
            fid_cond_mrkt_div_code: 'J',
            fid_input_iscd: stockCode,
          },
        },
      ),
    );

    return data.output!;
  }

  /** 일자별 시세 조회 */
  async getDailyPrice(
    stockCode: string,
    period: 'D' | 'W' | 'M' | 'Y' = 'D',
    adjustedPrice = true,
  ): Promise<KisDailyPrice[]> {
    const headers = await this.kisService.getAuthHeaders('FHKST01010400');

    const { data } = await firstValueFrom(
      this.httpService.get<KisApiResponse<KisDailyPrice[]>>(
        `${this.kisService.baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-price`,
        {
          headers,
          params: {
            fid_cond_mrkt_div_code: 'J',
            fid_input_iscd: stockCode,
            fid_org_adj_prc: adjustedPrice ? '0' : '1',
            fid_period_div_code: period,
          },
        },
      ),
    );

    return data.output ?? [];
  }
}
