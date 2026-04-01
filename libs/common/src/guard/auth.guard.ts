import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../decorator/public.decorator';

/**
 * 토큰이 유효한(폐기되지 않은) 상태인지 확인하는 콜백.
 * backend 앱에서 DB 조회 로직을 주입한다.
 */
export const TOKEN_VALIDATOR = Symbol('TOKEN_VALIDATOR');
export type TokenValidatorFn = (token: string) => Promise<boolean>;

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    @Optional()
    @Inject(TOKEN_VALIDATOR)
    private readonly tokenValidator?: TokenValidatorFn,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('인증 토큰이 없습니다.');
    }

    try {
      const payload = await this.jwtService.verifyAsync(token);
      request.user = payload;
    } catch {
      throw new UnauthorizedException('[1] 유효하지 않은 토큰입니다.');
    }

    // 토큰 폐기 여부 확인 (DB)
    if (this.tokenValidator) {
      const isValid = await this.tokenValidator(token);
      if (!isValid) {
        throw new UnauthorizedException('[2] 유효하지 않은 토큰입니다.');
      }
    }

    return true;
  }

  private extractTokenFromHeader(request: any): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
