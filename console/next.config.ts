import type { NextConfig } from 'next';

// The static UI is served by the private loopback service. Browser assets stay local;
// explicitly authorized live checks make their provider requests from the backend.
const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  devIndicators: false,
};

export default nextConfig;
