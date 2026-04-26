import { of } from 'rxjs';
import { HttpService } from '@nestjs/axios';
import { KisInquiryService } from './kis-inquiry.service';
import { KisService } from './kis.service';

describe('KisInquiryService', () => {
  const createService = () => {
    const httpService = {
      get: jest.fn(),
    } as unknown as HttpService & { get: jest.Mock };

    const kisService = {
      baseUrl: 'https://example.com',
      accountNo: '12345678',
      accountProdCd: '01',
      getTrId: jest.fn().mockReturnValue('VTTC8434R'),
      getAuthHeaders: jest
        .fn()
        .mockResolvedValue({ authorization: 'Bearer token' }),
    } as unknown as KisService & {
      getTrId: jest.Mock;
      getAuthHeaders: jest.Mock;
    };

    const service = new KisInquiryService(httpService, kisService);

    return { service, httpService, kisService };
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('accepts balance summary when output2 is an object', async () => {
    const { service, httpService } = createService();

    httpService.get.mockReturnValue(
      of({
        data: {
          output1: [],
          output2: {
            dnca_tot_amt: '100000',
            pchs_amt_smtl_amt: '500000',
            evlu_amt_smtl_amt: '515000',
            evlu_pfls_smtl_amt: '15000',
          },
        },
      }),
    );

    const result = await service.getBalance();

    expect(result.summary).toMatchObject({
      dnca_tot_amt: '100000',
      pchs_amt_smtl_amt: '500000',
      evlu_amt_smtl_amt: '515000',
      evlu_pfls_smtl_amt: '15000',
    });
  });

  it('accepts realized balance summary when output2 is an object', async () => {
    const { service, httpService, kisService } = createService();

    kisService.getAuthHeaders.mockResolvedValueOnce({
      authorization: 'Bearer token',
    });
    httpService.get.mockReturnValue(
      of({
        data: {
          output1: [],
          output2: {
            rlzt_pfls: '12345',
            thdt_buy_amt: '100000',
            thdt_sll_amt: '112345',
            real_evlu_pfls_erng_rt: '2.47',
          },
        },
      }),
    );

    const result = await service.getBalanceWithRealized();

    expect(result.summary).toMatchObject({
      rlzt_pfls: '12345',
      thdt_buy_amt: '100000',
      thdt_sll_amt: '112345',
      real_evlu_pfls_erng_rt: '2.47',
    });
  });
});
