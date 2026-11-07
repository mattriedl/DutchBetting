const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR || '.next',
  output: process.env.NEXT_OUTPUT_MODE,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  experimental: {
    outputFileTracingRoot: __dirname,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  images: { unoptimized: true },
  // Dev chunk URLs are not content-hashed, so a cached copy outlives an edit.
  async headers() {
    if (process.env.NODE_ENV !== 'development') return [];
    return [{ source: '/_next/static/:path*', headers: [{ key: 'Cache-Control', value: 'no-store, must-revalidate' }] }];
  },
  webpack: (config, { dev, isServer }) => {
    if (!isServer) {
      // Content hashes only exist in a production compilation. `next dev` builds chunks on
      // demand, so [contenthash] resolves to undefined and the browser requests
      // static/chunks/undefined.js, which 404s and breaks navigation in the dev preview.
      if (!dev) {
        config.output.filename = 'static/chunks/[name]-[contenthash:8].js';
        config.output.chunkFilename = 'static/chunks/[contenthash:16].js';
      } else {
        // Hashed entry names give every edit a new URL; the dev Pages Router loads pages/* by name.
        config.output.filename = ({ chunk }) => (chunk.name || '').startsWith('pages/') ? 'static/chunks/[name].js' : 'static/chunks/[name]-[contenthash:8].js';
      }
    }
    return config;
  },
};

const fs = require('fs');
const userConfigPath = path.join(__dirname, 'next.config.user.json');
const userConfigAllowedKeys = { skipTrailingSlashRedirect: 'boolean', trailingSlash: 'boolean' };
if (fs.existsSync(userConfigPath)) {
  const userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf8'));
  for (const key of Object.keys(userConfig)) {
    if (typeof userConfig[key] !== userConfigAllowedKeys[key]) {
      throw new Error(`next.config.user.json: unsupported override "${key}". Supported boolean keys: skipTrailingSlashRedirect, trailingSlash.`);
    }
    nextConfig[key] = userConfig[key];
  }
}

module.exports = nextConfig;
