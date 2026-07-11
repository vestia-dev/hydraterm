#!/usr/bin/env bun
/**
 * MAINTAINER-ONLY build step. Never runs on an end user's machine.
 *
 * Clones a pinned commit of ghostty-org/ghostty, builds libghostty-vt as a
 * shared library (.dylib) via its own build.zig, and copies the result +
 * public headers into native/<platform>/ where they are committed and shipped.
 *
 * Requires: git, and a Zig toolchain (see GHOSTTY_MIN_ZIG). Consumers need
 * neither — they receive the prebuilt .dylib.
 *
 * Usage: bun run scripts/build-libghostty.ts
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";

// libghostty-vt's C API is unversioned/unstable upstream, so we pin a commit.
// Bump deliberately and re-verify the FFI bindings when you do.
const GHOSTTY_REPO = "https://github.com/ghostty-org/ghostty.git";
const GHOSTTY_PIN = "53bd14fecfd68c6c0ab64d37b5943247299e2b40";

// ghostty pins its Zig toolchain and hard-rejects other versions (its build.zig
// calls requireZig()). This is the version required by GHOSTTY_PIN above; the
// system Zig is NOT used, so the build is reproducible regardless of what the
// maintainer has installed. Bump alongside GHOSTTY_PIN when ghostty moves.
const ZIG_VERSION = "0.15.2";

const VENDOR = "vendor/ghostty";
const BUILD_ROOT = ".build-libghostty";
const BUILD_PREFIX = `${BUILD_ROOT}/out`;

/** Fetch the pinned Zig into a local, gitignored dir and return the binary path. */
async function ensureZig(): Promise<string> {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const os = process.platform === "darwin" ? "macos" : process.platform;
  const dir = `${BUILD_ROOT}/toolchain/zig-${arch}-${os}-${ZIG_VERSION}`;
  const bin = `${dir}/zig`;
  if (!existsSync(bin)) {
    await mkdir(`${BUILD_ROOT}/toolchain`, { recursive: true });
    const url = `https://ziglang.org/download/${ZIG_VERSION}/zig-${arch}-${os}-${ZIG_VERSION}.tar.xz`;
    console.log(`Fetching Zig ${ZIG_VERSION} (maintainer build-time only)...`);
    await $`curl -fSL -o ${BUILD_ROOT}/toolchain/zig.tar.xz ${url}`;
    await $`tar xf ${BUILD_ROOT}/toolchain/zig.tar.xz -C ${BUILD_ROOT}/toolchain`;
    await $`rm ${BUILD_ROOT}/toolchain/zig.tar.xz`;
  }
  return `${process.cwd()}/${bin}`;
}

// v1: macOS arm64 only. Extend by adding targets + native/<platform> dirs.
const PLATFORM = `${process.platform}-${process.arch}`; // e.g. darwin-arm64
const DYLIB_NAME = "libghostty-vt.dylib";

async function main() {
  // 1. Vendor the pinned commit (shallow).
  if (!existsSync(VENDOR)) {
    await mkdir("vendor", { recursive: true });
    console.log(`Cloning ghostty @ ${GHOSTTY_PIN.slice(0, 10)} ...`);
    await $`git clone --filter=blob:none ${GHOSTTY_REPO} ${VENDOR}`;
  }
  await $`git -C ${VENDOR} fetch --depth 1 origin ${GHOSTTY_PIN}`.quiet().nothrow();
  await $`git -C ${VENDOR} checkout --detach ${GHOSTTY_PIN}`;

  // 2. Build the shared lib. -Dsimd=false minimizes deps (matches coder's build);
  //    -Demit-lib-vt=true selects the libghostty-vt shared-lib target.
  const zig = await ensureZig();
  console.log("Building libghostty-vt shared library (zig)...");
  const absPrefix = `${process.cwd()}/${BUILD_PREFIX}`;
  await $`${zig} build -Doptimize=ReleaseFast -Demit-lib-vt=true -Dsimd=false --prefix ${absPrefix}`.cwd(
    VENDOR,
  );

  // 3. Stage the prebuilt artifact + headers into the shipped location.
  //    Don't assume the install layout — locate the actual .dylig under the prefix.
  const dest = `native/${PLATFORM}`;
  await mkdir(dest, { recursive: true });
  const found =
    (await $`find ${BUILD_PREFIX} -name 'libghostty-vt*.dylib' -type f`.text())
      .trim()
      .split("\n")
      .filter(Boolean);
  if (found.length === 0) {
    console.error(`Build output tree under ${BUILD_PREFIX}:`);
    await $`find ${BUILD_PREFIX} -maxdepth 3`.nothrow();
    throw new Error(`No libghostty-vt*.dylib produced. Inspect the tree above.`);
  }
  await $`cp ${found[0]} ${dest}/${DYLIB_NAME}`;
  // Ship the headers we bound against alongside the binary (documentation + parity).
  await $`cp -R ${VENDOR}/include ${dest}/include`.nothrow();
  console.log(`\n✅ Staged ${dest}/${DYLIB_NAME} (from ${found[0]})`);
}

main().catch((err) => {
  console.error("build-libghostty failed:", err);
  process.exit(1);
});
