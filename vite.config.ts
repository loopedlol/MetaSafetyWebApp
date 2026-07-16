import { defineConfig, loadEnv } from 'vite';
import { validateDevelopmentTunnelOrigin } from './server/config.ts';

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const tunnelEnabled = command === 'serve' && env.DEV_TUNNEL_MODE === 'true';
  const nodeEnv = env.NODE_ENV || (mode === 'production' ? 'production' : 'development');
  if (tunnelEnabled && nodeEnv !== 'development') {
    throw new Error('DEV_TUNNEL_MODE may be enabled only when NODE_ENV=development.');
  }
  const tunnelOrigin = tunnelEnabled
    ? validateDevelopmentTunnelOrigin(env.DEV_TUNNEL_ORIGIN)
    : null;
  return {
    server: {
      allowedHosts: tunnelOrigin ? [new URL(tunnelOrigin).hostname] : [],
      proxy: {
        '/api': {
          target: env.VITE_API_TARGET || 'http://localhost:3001',
          changeOrigin: false
        }
      }
    }
  };
});
