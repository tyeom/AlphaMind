import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { EntityManager } from '@mikro-orm/postgresql';
import { Public } from '@alpha-mind/common';
import { StockDailyPrice } from './entities/stock-daily-price.entity';
import { StockService } from './stock.service';

@Controller('stocks')
export class StockController {
  constructor(
    private readonly em: EntityManager,
    private readonly stockService: StockService,
  ) {}

  @MessagePattern('stock.lookup')
  async lookupStockRmq(
    @Payload() body: { code: string },
  ): Promise<{ code: string; name: string } | null> {
    const code = body?.code?.trim();
    if (!code) return null;
    try {
      const stock = await this.stockService.findStockByCode(code);
      return { code: stock.code, name: stock.name };
    } catch {
      return null;
    }
  }

  @Public()
  @Get('collection-status')
  getCollectionStatus() {
    return this.stockService.getCollectionStatus();
  }

  @Get()
  async findAll(
    @Query('q') query?: string,
    @Query('limit') limit = '20',
  ) {
    if (query?.trim()) {
      return this.stockService.searchStocks(query, parseInt(limit, 10));
    }
    return this.stockService.findAllStocks();
  }

  @Get(':code')
  async findOne(@Param('code') code: string) {
    return this.stockService.findStockByCode(code);
  }

  @Get(':code/prices')
  async getPrices(
    @Param('code') code: string,
    @Query('limit') limit = '30',
  ) {
    const stock = await this.stockService.findStockByCode(code);
    return this.em.find(
      StockDailyPrice,
      { stock },
      { orderBy: { date: 'DESC' }, limit: parseInt(limit, 10) },
    );
  }

  @Post('collect')
  async collect() {
    await this.stockService.collectAll();
    return { message: 'Data collection completed' };
  }
}
