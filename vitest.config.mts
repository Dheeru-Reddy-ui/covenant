import { defineConfig } from 'vitest/config';

// Tests for the Forge app code in src/, with Jira, Forge SQL and Teamwork Graph faked.
// packages/core and eval have their own configs.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
