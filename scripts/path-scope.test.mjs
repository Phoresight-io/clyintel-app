// Run with: node --test scripts/path-scope.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lexicalScope, realScope, globScope, scopeViolation, escapingSymlinks } from "./path-scope.mjs";

// A repo with a sibling "outside" directory, and the links an agent with Bash could leave behind.
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "scope-")));
  const root = join(base, "repo");
  const outside = join(base, "outside");
  mkdirSync(join(root, "clyintel/lib"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  mkdirSync(join(root, "node_modules/vitest"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "clyintel/lib/a.ts"), "export {}");
  writeFileSync(join(root, ".git/config"), "[core]");
  writeFileSync(join(root, "node_modules/vitest/cli.mjs"), "");
  writeFileSync(join(outside, "secret"), "SECRET");
  symlinkSync("../vitest/cli.mjs", join(root, "node_modules/.bin/vitest")); // legitimate, stays inside
  return { base, root, outside, done: () => rmSync(base, { recursive: true, force: true }) };
}

test("lexicalScope: inside is fine; .., absolute elsewhere, ~ and .git are not", () => {
  const R = "/work/repo";
  for (const p of ["a.ts", "./clyintel/x", "/work/repo", "/work/repo/clyintel/a.ts", "clyintel/../a", ".gitignore", ".github/x", "a/.gitkeep"])
    assert.equal(lexicalScope(p, R), null, p);
  for (const p of ["../x", "/proc/self/environ", "/work/repo-evil/x", "/work", "a/../../x", "~/.ssh/id_rsa", "~", "", undefined, null, 42])
    assert.equal(lexicalScope(p, R), "outside", String(p));
  for (const p of [".git", ".git/config", "/work/repo/.git/HEAD", "sub/.git/config", ".GIT/config", "a/../.git"])
    assert.equal(lexicalScope(p, R), ".git", p);
});

test("realScope: symlinks are resolved, so a link out of the repo or into .git is caught", () => {
  const f = fixture();
  try {
    symlinkSync(f.outside, join(f.root, "clyintel/out-dir"));
    symlinkSync(join(f.outside, "secret"), join(f.root, "clyintel/out-file"));
    symlinkSync("/proc/self/environ", join(f.root, "env"));
    symlinkSync("../.git", join(f.root, "clyintel/gitlink"));
    symlinkSync("does-not-exist", join(f.root, "dangling"));
    symlinkSync("loop", join(f.root, "loop"));
    assert.equal(realScope("clyintel/lib/a.ts", f.root), null);
    assert.equal(realScope("clyintel/new/file-not-yet-written.md", f.root), null);
    assert.equal(realScope("node_modules/.bin/vitest", f.root), null);
    assert.equal(realScope("clyintel/out-dir/secret", f.root), "outside");
    assert.equal(realScope("clyintel/out-dir", f.root), "outside");
    assert.equal(realScope("clyintel/out-dir/not-there", f.root), "outside");
    assert.equal(realScope("clyintel/out-file", f.root), "outside");
    assert.equal(realScope("env", f.root), "outside");
    assert.equal(realScope("clyintel/gitlink/config", f.root), ".git");
    assert.equal(realScope("dangling", f.root), "outside"); // cannot be resolved: fail closed
    assert.equal(realScope("loop", f.root), "outside");
    assert.equal(realScope("x", join(f.base, "no-such-root")), "outside");
  } finally { f.done(); }
});

test("globScope: patterns stay relative to the search directory and out of .git", () => {
  for (const g of [undefined, "*.ts", "**/*.{ts,tsx}", "clyintel/**/*.test.ts", "src/[ab]*.js", ".github/**"]) assert.equal(globScope(g), null, String(g));
  for (const g of ["/proc/*/environ", "../**", "**/../../x", "{/etc,src}/*", "{src,/root}/**", "~/**", "\\proc\\x"]) assert.equal(globScope(g), "outside", g);
  for (const g of [".git/**", "**/.git/config", "{.git,src}/*"]) assert.equal(globScope(g), ".git", g);
});

test("scopeViolation: Read, Grep and Glob are checked on every path-like argument", () => {
  const f = fixture();
  try {
    symlinkSync(f.outside, join(f.root, "linked"));
    const ok = (tool, args) => assert.equal(scopeViolation(tool, args, f.root), null, `${tool} ${JSON.stringify(args)}`);
    const no = (tool, args, re = /outside the repository|inside \.git/) => {
      const r = scopeViolation(tool, args, f.root);
      assert.ok(r && re.test(r), `${tool} ${JSON.stringify(args)} -> ${r}`);
    };
    ok("Read", { file_path: join(f.root, "clyintel/lib/a.ts") });
    ok("Read", { file_path: "clyintel/lib/a.ts" });
    ok("Grep", { pattern: "TODO" }); // default path is the repo root
    ok("Grep", { pattern: "x", path: "clyintel", glob: "*.ts" });
    ok("Glob", { pattern: "**/*.ts" });
    ok("Glob", { pattern: "*.ts", path: join(f.root, "clyintel") });
    ok("Write", { file_path: "/etc/passwd" }); // not a scoped tool; Write has its own rules
    no("Read", { file_path: "/proc/self/environ" });
    no("Read", { file_path: "/proc/1/environ" });
    no("Read", { file_path: join(f.outside, "secret") });
    no("Read", { file_path: "linked/secret" });
    no("Read", { file_path: ".git/config" }, /inside \.git/);
    no("Read", {});
    no("Grep", { pattern: "KEY", path: "/proc" });
    no("Grep", { pattern: "KEY", path: "linked" });
    no("Grep", { pattern: "url", path: ".git" }, /inside \.git/);
    no("Grep", { pattern: "x", glob: "../../**" });
    no("Glob", { pattern: "/proc/*/environ" });
    no("Glob", { pattern: "*", path: "/home" });
    no("Glob", { pattern: ".git/**" }, /inside \.git/);
    no("Glob", { pattern: "*", path: "linked" });
    // the denial names the argument but never echoes more than a short prefix of it
    assert.ok(scopeViolation("Read", { file_path: "/x/" + "a".repeat(5000) }, f.root).length < 400);
  } finally { f.done(); }
});

test("escapingSymlinks: finds links out of the repo or into .git anywhere (node_modules too), ignores links that stay inside", () => {
  const f = fixture();
  try {
    assert.deepEqual(escapingSymlinks(f.root), []); // node_modules/.bin/vitest stays inside
    symlinkSync("/proc/self/environ", join(f.root, "clyintel/lib/env"));
    symlinkSync(f.outside, join(f.root, "node_modules/vitest/planted"));
    symlinkSync("../../.git", join(f.root, "clyintel/lib/g"));
    symlinkSync("nowhere", join(f.root, "dangling"));
    symlinkSync(join(f.outside, "secret"), join(f.root, ".git/inside-git-is-not-walked"));
    assert.deepEqual(escapingSymlinks(f.root), ["clyintel/lib/env", "clyintel/lib/g", "dangling", "node_modules/vitest/planted"]);
  } finally { f.done(); }
});

test("scopeViolation: Read refuses hard-linked files (a hard link to .git/config resolves inside the repo)", () => {
  const f = fixture();
  try {
    linkSync(join(f.root, ".git/config"), join(f.root, "clyintel/cfg"));
    const r = scopeViolation("Read", { file_path: "clyintel/cfg" }, f.root);
    assert.match(r, /hard link/);
    assert.equal(scopeViolation("Read", { file_path: "clyintel/lib/a.ts" }, f.root), null);
    assert.equal(scopeViolation("Read", { file_path: "clyintel/not-yet.md" }, f.root), null);
  } finally { f.done(); }
});
