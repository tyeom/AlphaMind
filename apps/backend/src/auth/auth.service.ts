import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { EntityManager } from '@mikro-orm/postgresql';
import { UserService } from '../user/user.service';
import { SignInDto } from '../user/dto/sign-in.dto';
import { UserAuthTokenEntity } from './entities/user-auth-token.entity';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly em: EntityManager,
  ) {}

  async signIn(dto: SignInDto) {
    const user = await this.userService.validateUser(
      dto.username,
      dto.password,
    );

    if (!user) {
      throw new UnauthorizedException(
        '아이디 또는 패스워드가 일치하지 않습니다.',
      );
    }

    const payload = {
      sub: user.id,
      username: user.username,
      role: user.role,
    };

    // 기존 토큰 폐기
    await this.em.nativeDelete(UserAuthTokenEntity, { user });

    const accessToken = await this.jwtService.signAsync(payload);

    // 토큰 DB 저장
    const decoded = this.jwtService.decode(accessToken) as { exp: number };
    const authToken = this.em.create(UserAuthTokenEntity, {
      user,
      token: accessToken,
      expiresAt: new Date(decoded.exp * 1000),
    });
    await this.em.persistAndFlush(authToken);

    return {
      accessToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  async signOut(token: string) {
    // 토큰 DB에서 삭제 (폐기)
    const deleted = await this.em.nativeDelete(UserAuthTokenEntity, { token });
    if (deleted === 0) {
      throw new UnauthorizedException('유효하지 않은 토큰입니다.');
    }
    return { message: '로그아웃 되었습니다.' };
  }

  /** 토큰이 DB에 존재하는지 확인 */
  async isTokenValid(token: string): Promise<boolean> {
    const count = await this.em.count(UserAuthTokenEntity, { token });
    return count > 0;
  }
}
