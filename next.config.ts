import type { NextConfig } from "next";

const electronExport = process.env.ELECTRON_EXPORT === "true";

const nextConfig: NextConfig = {
  ...(electronExport ?
    {
      output: "export" as const,
      distDir: "out",
      assetPrefix: "./",
    }
  : {
      output: "standalone",
      /** 避免開發模式右下角的 Next 圖示擋住側邊欄「設置」按鈕 */
      devIndicators: { position: "top-right" },
    }),
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
