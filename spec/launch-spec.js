const path = require("path");
const { resolveJetls, buildArgs, buildEnv, expandHome } = require("../lib/launch");

describe("launch helpers", () => {
  describe("buildArgs", () => {
    it("defaults to threads + `-- serve`", () => {
      expect(buildArgs({ threads: "auto" })).toEqual(["--threads=auto", "--", "serve"]);
    });

    it("puts Julia flags before `--`", () => {
      const args = buildArgs({ threads: "4,2", defaultEnvironment: "@v1.12", juliaFlags: [" --heap-size-hint=4G ", ""] });
      expect(args).toEqual(["--threads=4,2", "--project=@v1.12", "--heap-size-hint=4G", "--", "serve"]);
    });

    it("expands ~ in the default environment but leaves @name alone", () => {
      const args = buildArgs({ defaultEnvironment: "~/envs/work", homedir: "/home/u" });
      expect(args).toContain(`--project=${path.join("/home/u", "envs/work")}`);
    });

    it("omits empty settings", () => {
      expect(buildArgs({})).toEqual(["--", "serve"]);
    });
  });

  describe("resolveJetls", () => {
    it("honors an explicit path", () => {
      expect(resolveJetls({ configured: "/opt/jetls", exists: () => true })).toBe("/opt/jetls");
    });

    it("falls back to <depot>/bin/jetls when it exists", () => {
      const got = resolveJetls({ homedir: "/home/u", env: {}, platform: "linux", exists: () => true });
      expect(got).toBe(path.join("/home/u", ".julia", "bin", "jetls"));
    });

    it("respects JULIA_DEPOT_PATH", () => {
      const got = resolveJetls({ homedir: "/home/u", env: { JULIA_DEPOT_PATH: "/depot" + path.delimiter + "/other" }, platform: "linux", exists: () => true });
      expect(got).toBe(path.join("/depot", "bin", "jetls"));
    });

    it("uses .exe on Windows", () => {
      const got = resolveJetls({ homedir: "C:\\u", env: {}, platform: "win32", exists: () => true });
      expect(path.basename(got)).toBe("jetls.exe");
    });

    it("falls back to PATH lookup", () => {
      expect(resolveJetls({ exists: () => false })).toBe("jetls");
    });
  });

  describe("buildEnv", () => {
    const delim = path.delimiter;

    it("sets JULIA_APPS_JULIA_CMD without mutating the input env", () => {
      const base = { PATH: "/bin" };
      const env = buildEnv({ juliaPath: "/opt/julia/bin/julia", env: base, homedir: "/home/u" });
      expect(env.JULIA_APPS_JULIA_CMD).toBe("/opt/julia/bin/julia");
      expect(base).toEqual({ PATH: "/bin" });
    });

    it("expands ~ in the Julia path", () => {
      expect(buildEnv({ juliaPath: "~/julia/bin/julia", env: {}, homedir: "/home/u" }).JULIA_APPS_JULIA_CMD)
        .toBe(path.join("/home/u", "julia/bin/julia"));
    });

    it("does not set JULIA_APPS_JULIA_CMD when no Julia path is given", () => {
      expect(buildEnv({ juliaPath: "", env: { A: "1" }, homedir: "/home/u" }).JULIA_APPS_JULIA_CMD).toBeUndefined();
    });

    it("appends the depot's bin directory to PATH when it is missing", () => {
      const env = buildEnv({ env: { PATH: "/usr/bin" }, homedir: "/home/u" });
      expect(env.PATH).toBe(["/usr/bin", path.join("/home/u", ".julia", "bin")].join(delim));
    });

    it("does not add it twice", () => {
      const bin = path.join("/home/u", ".julia", "bin");
      const env = buildEnv({ env: { PATH: ["/usr/bin", bin].join(delim) }, homedir: "/home/u" });
      expect(env.PATH).toBe(["/usr/bin", bin].join(delim));
    });

    it("uses the first JULIA_DEPOT_PATH entry", () => {
      const env = buildEnv({ env: { PATH: "/usr/bin", JULIA_DEPOT_PATH: ["/depot", "/other"].join(delim) }, homedir: "/home/u" });
      expect(env.PATH).toBe(["/usr/bin", path.join("/depot", "bin")].join(delim));
    });

    it("creates PATH when there is none, and keeps the casing of an existing Path key", () => {
      expect(buildEnv({ env: {}, homedir: "/home/u" }).PATH).toBe(path.join("/home/u", ".julia", "bin"));
      const win = buildEnv({ env: { Path: "C:\\x" }, homedir: "/home/u" });
      expect(win.Path).toContain("C:\\x");
      expect(win.PATH).toBeUndefined();
    });
  });

  it("expandHome handles bare ~", () => {
    expect(expandHome("~", "/home/u")).toBe("/home/u");
  });
});
