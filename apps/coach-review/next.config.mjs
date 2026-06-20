import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    cpus: 1,
    workerThreads: false,
    staticGenerationMaxConcurrency: 1,
    staticGenerationMinPagesPerWorker: 100,
  },
  reactStrictMode: true,
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@packages': path.resolve(__dirname, '../../packages'),
    };
    return config;
  },
};

export default nextConfig;
