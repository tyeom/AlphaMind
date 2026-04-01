import { Module } from '@nestjs/common';
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UserModule } from '../user/user.module';
import { UserAuthTokenEntity } from './entities/user-auth-token.entity';
import { TOKEN_VALIDATOR, type TokenValidatorFn } from '@alpha-mind/common';

@Module({
  imports: [
    UserModule,
    MikroOrmModule.forFeature([UserAuthTokenEntity]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): JwtModuleOptions => {
        const expiresIn = configService.get<string>('JWT_EXPIRES_IN') ?? '1d';
        return {
          secret: configService.get<string>('JWT_SECRET'),
          signOptions: {
            expiresIn: expiresIn as any,
          },
        };
      },
      global: true,
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    {
      provide: TOKEN_VALIDATOR,
      useFactory: (authService: AuthService): TokenValidatorFn => {
        return (token: string) => authService.isTokenValid(token);
      },
      inject: [AuthService],
    },
  ],
  exports: [AuthService, TOKEN_VALIDATOR],
})
export class AuthModule {}
