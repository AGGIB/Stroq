import type { NextConfig } from 'next';

// The static UI is served by the private loopback service. Browser assets stay local.
const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  devIndicators: false,
};

export default nextConfig;
