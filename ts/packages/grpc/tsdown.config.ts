import { defineConfig } from 'tsdown';
import { baseConfig, baseNeverBundle } from '../../../tsdown.config.base.ts';

export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts'],
  tsconfig: 'tsconfig.json',
  deps: {
    ...baseConfig.deps,
    neverBundle: [...baseNeverBundle, '@grpc/grpc-js', '@grpc/proto-loader'],
  },
});
