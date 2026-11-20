import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// AI Studio pattern: the project's GEMINI_API_KEY secret is exposed to the
// app as process.env.GEMINI_API_KEY. Studio provisions this key itself.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY || ''),
    },
  };
});
