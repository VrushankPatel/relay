import { defineConfig } from 'vitest/config';
import fs from 'fs';

export default defineConfig({
  plugins: [
    {
      name: 'html-loader',
      transform(code, id) {
        if (id.endsWith('.html')) {
          const htmlContent = fs.readFileSync(id, 'utf-8');
          return {
            code: `export default ${JSON.stringify(htmlContent)};`,
            map: null
          };
        }
      }
    }
  ],
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        '**/*.config.ts',
        '**/*.d.ts',
      ],
    },
    testTimeout: 10000,
  },
});
