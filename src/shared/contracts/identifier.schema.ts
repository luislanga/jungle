import { z } from 'zod';
import { MAX_IDENTIFIER_LENGTH } from '@/shared/consts/identifier.constant';

// PostgreSQL returns UUIDs in lowercase. Normalize before comparisons and hashing too.
export const UUID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());

export const IDENTIFIER_SCHEMA = z.string().min(1).max(MAX_IDENTIFIER_LENGTH);
