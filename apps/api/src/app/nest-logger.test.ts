import { createLogger, RequestContext } from '@reef/logger';
import { describe, expect, it } from 'vitest';

import { NestPinoLogger } from './nest-logger.js';

describe('NestPinoLogger', () => {
  it('redacts objects Nest logs instead of stringifying them into the message', () => {
    const lines: string[] = [];
    const logger = createLogger({
      service: 'test',
      level: 'info',
      context: new RequestContext(),
      destination: { write: (line: string) => lines.push(line) },
    });

    new NestPinoLogger(logger).log({ email: 'jane@example.com', route: '/v1/x' }, 'Router');

    expect(lines.join('')).not.toContain('jane@example.com');
    expect(lines.join('')).toContain('/v1/x');
  });
});
