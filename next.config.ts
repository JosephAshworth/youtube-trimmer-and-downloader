import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  logging: {
    incomingRequests: {
      ignore: [
        /^\/api\/process\/progress\//,
        /^\/api\/process\/status$/,
        /^\/api\/process\/tmp-status$/,
      ],
    },
  },
};

export default nextConfig;
