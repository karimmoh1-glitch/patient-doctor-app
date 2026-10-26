import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, writeFile, mkdir } from "fs/promises";
import { execSync } from "child_process";

// server deps to bundle to reduce openat(2) syscalls, which helps cold
// start times.
const allowlist = [
  "bcryptjs",
  "dotenv",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-async-errors",
  "express-rate-limit",
  "helmet",
  "jsonwebtoken",
  "multer",
  "nanoid",
  "pg",
  "resend",
  "zod",
];

// Which commit is this build? Deploys from a laptop pass BUILD_COMMIT; otherwise
// ask git. It is written into the server bundles and into /version.json so
// anyone can check that the running site is the build they meant to ship.
function currentCommit(): string {
  if (process.env.BUILD_COMMIT) return process.env.BUILD_COMMIT.trim();
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}
const BUILD = { commit: currentCommit(), builtAt: new Date().toISOString() };

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();
  await mkdir("dist/public", { recursive: true });
  await writeFile("dist/public/version.json", JSON.stringify(BUILD) + "\n");

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  // Vercel function: one self-contained ESM bundle (package.json is
  // "type": "module"); the banner restores require/__dirname for the
  // CommonJS dependencies bundled inside it.
  await esbuild({
    entryPoints: ["server/vercel.ts"],
    platform: "node",
    bundle: true,
    format: "esm",
    outfile: "api/index.js",
    define: { "process.env.NODE_ENV": '"production"', "process.env.BUILD_COMMIT": JSON.stringify(BUILD.commit), "process.env.BUILD_TIME": JSON.stringify(BUILD.builtAt) },
    minify: true,
    external: ["pg-native"],
    banner: { js: "import { createRequire as __createRequire } from 'module'; import { fileURLToPath as __fileURLToPath } from 'url'; import { dirname as __dirnameOf } from 'path'; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __dirnameOf(__filename);" },
    logLevel: "info",
  });

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.BUILD_COMMIT": JSON.stringify(BUILD.commit),
      "process.env.BUILD_TIME": JSON.stringify(BUILD.builtAt),
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
