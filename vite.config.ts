import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  // Computer's shell entry also exports a Node host implementation. Workers
  // must resolve the portable build, which excludes native compression addons.
  resolve: {
    alias: [{ find: /^just-bash$/, replacement: "just-bash/browser" }],
  },
  plugins: [
    vinext(),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
