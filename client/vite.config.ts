import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // 更具体的子路径别名必须在前（字符串别名按前缀匹配）
      {
        find: '@gdys/shared/roles/loader.client',
        replacement: path.resolve(__dirname, '../shared/src/roles/loader.client.ts'),
      },
      {
        // 直接引用 shared 的 TS 源码，开发零构建
        find: '@gdys/shared',
        replacement: path.resolve(__dirname, '../shared/src/index.ts'),
      },
    ],
  },
  server: {
    port: 5173,
    host: true, // 监听局域网，手机可访问
    fs: { allow: ['../..'] },
    proxy: {
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
});
