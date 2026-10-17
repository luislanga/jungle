import { Injectable, type CanActivate } from '@nestjs/common';

// README 2 allows omitting authentication. This guard can be replaced with an external
// IdP token check and provider authorization.
@Injectable()
export class ChallengeAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
