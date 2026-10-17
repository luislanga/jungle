import { ALLOWED_CURRENCIES } from '@/shared/consts/money.constant';
import { z } from 'zod';
import { Money } from '@/shared/domain/money.domain';

// HTTP and SQS accept decimal strings. Money validates their scale before PostgreSQL can round them.
export const MONEY_INPUT_SCHEMA = z
  .strictObject({ amount: z.string(), currency: z.enum(ALLOWED_CURRENCIES) })
  .transform((props, ctx) => {
    try {
      return Money.from(props).toJSON();
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid monetary amount' });
      return z.NEVER;
    }
  });
