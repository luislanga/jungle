import { LEDGER_CURSOR_VERSION } from '@/shared/consts/ledger.constant';
import { z } from 'zod';
import { ApplicationError } from '@/shared/errors/application.error';
import { APPLICATION_ERRORS } from '@/shared/errors/errors.constant';
import type { LedgerCursor } from '@/shared/interfaces/wallet.interface';
import { UUID_SCHEMA } from '@/shared/contracts/identifier.schema';

const LEDGER_CURSOR_SCHEMA = z.strictObject({
  version: z.literal(LEDGER_CURSOR_VERSION),
  walletId: UUID_SCHEMA,
  createdAt: z.iso.datetime(),
  id: UUID_SCHEMA,
});

export function encodeLedgerCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeLedgerCursor(value: string, walletId: string): LedgerCursor {
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new Error('Noncanonical cursor encoding');
    const cursor = LEDGER_CURSOR_SCHEMA.parse(JSON.parse(decoded.toString('utf8')) as unknown);
    if (cursor.walletId !== UUID_SCHEMA.parse(walletId))
      throw new Error('Cursor belongs to a different wallet');
    return cursor;
  } catch {
    throw new ApplicationError(APPLICATION_ERRORS.INVALID_LEDGER_CURSOR);
  }
}
