import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  HUB_NAME: z.string().min(1).default('wa-hub-demo'),
  HUB_TOKEN: z.string().min(16, 'HUB_TOKEN must be at least 16 chars'),
  HUB_PORT: z.coerce.number().int().positive().default(3060),
  WS_PORT: z.coerce.number().int().positive().default(3061),
  WEBHOOK_SECRET: z.string().min(16, 'WEBHOOK_SECRET must be at least 16 chars'),
  WEBHOOK_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  WEBHOOK_EVENTS: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().nonnegative().default(120),
  DATA_DIR: z.string().default('./data'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;
