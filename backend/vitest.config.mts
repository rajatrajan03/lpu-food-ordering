import { defineConfig } from "vitest/config";

// This suite runs against the real (Supabase) database — there is no
// separate provisioned test database for this project (see HANDOFF.md's
// testing section). Every test that touches the DB creates its own
// disposable fixtures (prefixed, see tests/helpers/fixtures.ts) and cleans
// them up in an afterEach/finally, the same discipline this project's
// ad-hoc tmpTest*.ts scripts used all session — but that also means tests
// must run sequentially within a file (default) and real network latency
// applies, hence the generous timeout.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/load/**"],
    // The Supabase pooler connection this project uses (Session Mode, see
    // HANDOFF.md) caps at 15 simultaneous clients. Vitest's default runs
    // each test file in its own worker process, each instantiating its own
    // PrismaClient/connection pool — with enough files running at once that
    // blows past 15 and every DB call starts failing with EMAXCONNSESSION.
    // Forcing a single worker keeps this suite to one PrismaClient/pool for
    // the whole run, same as any single running instance of the app.
    fileParallelism: false,
    pool: "forks",
    singleFork: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/scripts/**", "src/server.ts", "src/**/*.d.ts"],
    },
  },
});
