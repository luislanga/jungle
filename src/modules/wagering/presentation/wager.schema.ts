import { z } from 'zod';

export const TRANSACTION_ID_SCHEMA = z.uuid();
export const EXTERNAL_ID_SCHEMA = z.string().min(1);
