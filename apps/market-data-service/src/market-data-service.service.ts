import { Injectable } from '@nestjs/common';

@Injectable()
export class MarketDataServiceService {
  getHello(): string {
    return 'Hello World!';
  }
}
