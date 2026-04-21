import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { validationSchema } from './config/validation.schema';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { KisModule } from './kis/kis.module';
import { HealthModule } from './health/health.module';
import { AutoTradingModule } from './auto-trading/auto-trading.module';
import { NotificationModule } from './notification/notification.module';
import { AiMeetingResultModule } from './ai-meeting-result/ai-meeting-result.module';
import { RmqModule } from './rmq/rmq.module';
import { AuthGuard, RbacGuard, AllExceptionFilter } from '@alpha-mind/common';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema,
      validationOptions: {
        abortEarly: true,
      },
    }),
    ScheduleModule.forRoot(),
    MikroOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        driver: PostgreSqlDriver,
        host: configService.get<string>('DB_HOST'),
        port: configService.get<number>('DB_PORT'),
        user: configService.get<string>('DB_USERNAME'),
        password: configService.get<string>('DB_PASSWORD'),
        dbName: configService.get<string>('DB_DATABASE'),
        entities: ['./dist/**/*.entity.js'],
        entitiesTs: ['./src/**/*.entity.ts'],
        debug: configService.get<string>('NODE_ENV') === 'development',
        allowGlobalContext: true,
        discovery: { warnWhenNoEntities: false },
        schemaGenerator: { disableForeignKeys: false },
      }),
    }),
    AuthModule,
    UserModule,
    KisModule,
    HealthModule,
    AutoTradingModule,
    NotificationModule,
    AiMeetingResultModule,
    RmqModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_FILTER,
      useClass: AllExceptionFilter,
    },
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RbacGuard,
    },
  ],
})
export class AppModule {}
