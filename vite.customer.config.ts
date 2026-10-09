/* The CUSTOMER build: a second, slim bundle for /d/<slug>. See src/customer/CustomerApp.tsx.

   Two substitutions do the work, by import specifier so no staff file has to change:
     ProfileContext -> a one-profile, no-localStorage context
     profiles       -> an empty registry (the real one globs every prospect into the bundle)
   `audit:customer` greps the output for both. Built into dist-customer/ and served under
   /d-assets/ by server.ts, ahead of the auth gate. */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const here = (p: string) => path.resolve(__dirname, p);

export default defineConfig({
  plugins: [react()],
  base: "/d-assets/",
  publicDir: false,
  define: { "import.meta.env.VITE_CUSTOMER": JSON.stringify("1") },
  resolve: {
    alias: [
      { find: /^(\.{1,2}\/)+(data\/)?ProfileContext(\.tsx)?$/, replacement: here("src/customer/CustomerProfileContext.tsx") },
      { find: /^(\.{1,2}\/)+(data\/)?profiles(\.ts)?$/, replacement: here("src/customer/profilesStub.ts") },
    ],
  },
  build: {
    outDir: "dist-customer",
    emptyOutDir: true,
    rollupOptions: { input: here("customer.html") },
  },
});
