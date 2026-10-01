// import.meta.glob 的最小声明：只给 loader.client.ts 用（Vite 构建期宏，Node 端不加载该文件）。
// client 侧 tsconfig 已含 vite/client 完整类型，二者以重载形式合并，不冲突。
interface ImportMeta {
  glob<T = unknown>(patterns: string | string[], options?: { eager?: boolean }): Record<string, T>;
}
