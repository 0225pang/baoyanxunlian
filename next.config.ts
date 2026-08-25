import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['mysql2'],
  devIndicators: false,
};

export default nextConfig;
