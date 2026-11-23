import { createGeistdocs } from '@vercel/geistdocs/next';
import type { NextConfig } from 'next';

const withGeistdocs = createGeistdocs();

const config: NextConfig = {
  // The card module reads its fonts and logo from app/og at request time.
  outputFileTracingIncludes: {
    '/*': ['./app/og/**/*'],
  },
  async headers() {
    return process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production'
      ? [{ source: '/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] }]
      : [];
  },
};

export default withGeistdocs(config);
