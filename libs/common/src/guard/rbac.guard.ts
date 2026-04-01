import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../enums/user-role.enum';
import { ROLES_KEY } from '../decorator/rbac.decorator';
import { IS_PUBLIC_KEY } from '../decorator/public.decorator';

const ROLE_HIERARCHY: Record<UserRole, number> = {
  [UserRole.ADMIN]: 2,
  [UserRole.USER]: 1,
};

@Injectable()
export class RbacGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.role) {
      throw new ForbiddenException('접근 권한이 없습니다.');
    }

    const userRoleLevel = ROLE_HIERARCHY[user.role as UserRole] ?? 0;
    const hasRole = requiredRoles.some(
      (role) => userRoleLevel >= ROLE_HIERARCHY[role],
    );

    if (!hasRole) {
      throw new ForbiddenException('접근 권한이 없습니다.');
    }

    return true;
  }
}
