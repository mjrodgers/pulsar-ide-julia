// Julia project lookups (lib/julia/paths.js), against a fake file system.
const path = require("path");
const { findProjectDir, replProjectDir, parseProjectHeader, readProject, packageOf, expandHome } = require("../lib/julia/paths");

const UUID = "6c3f9b2e-1d4a-4e8b-9f0a-2b7c5d8e1a34";

// files: { "/abs/path": "contents" }
const fakeFs = (files) => ({
  exists: (p) => Object.prototype.hasOwnProperty.call(files, path.resolve(p)),
  read: (p) => {
    const key = path.resolve(p);
    if (!Object.prototype.hasOwnProperty.call(files, key)) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
    return files[key];
  },
});
const abs = (p) => path.resolve(p);

describe("expandHome", () => {
  it("expands a leading ~", () => {
    expect(expandHome("~", "/home/me")).toBe("/home/me");
    expect(expandHome("~/x", "/home/me")).toBe(path.join("/home/me", "x"));
    expect(expandHome("/a/~", "/home/me")).toBe("/a/~");
  });
});

describe("findProjectDir", () => {
  it("finds the nearest directory with a project file", () => {
    const fs = fakeFs({ [abs("/a/Project.toml")]: "", [abs("/a/b/c/JuliaProject.toml")]: "" });
    expect(findProjectDir("/a/b/c/d", fs.exists)).toBe(abs("/a/b/c"));
    expect(findProjectDir("/a/b", fs.exists)).toBe(abs("/a"));
    expect(findProjectDir("/z", fs.exists)).toBe(null);
    expect(findProjectDir(null, fs.exists)).toBe(null);
  });
});

describe("replProjectDir", () => {
  const fs = fakeFs({
    [abs("/pkg/Project.toml")]: 'name = "Pkg"\n',
    [abs("/pkg/test/Project.toml")]: "[deps]\n",
    [abs("/pkg/docs/Project.toml")]: "[deps]\n",
    [abs("/scripts/test/Project.toml")]: "[deps]\n",
  });

  it("starts the REPL of a package's test file in the package", () => {
    expect(replProjectDir("/pkg/test/Groups", fs)).toBe(abs("/pkg"));
    expect(replProjectDir("/pkg/src", fs)).toBe(abs("/pkg"));
  });

  it("keeps other environments, and a test environment that is not a package's", () => {
    expect(replProjectDir("/pkg/docs", fs)).toBe(abs("/pkg/docs"));
    expect(replProjectDir("/scripts/test", fs)).toBe(abs("/scripts/test"));
    expect(replProjectDir("/nowhere", fs)).toBe(null);
  });
});

describe("parseProjectHeader", () => {
  it("reads the top-level name and uuid only", () => {
    const text = [
      "# a comment",
      `name = "MyPkg"`,
      `uuid = "${UUID}"  # trailing comment`,
      `authors = ["me"]`,
      "",
      "[deps]",
      `name = "NotThis"`,
    ].join("\n");
    expect(parseProjectHeader(text)).toEqual({ name: "MyPkg", uuid: UUID });
  });
  it("leaves missing keys null, and copes with Windows line ends", () => {
    expect(parseProjectHeader(`[deps]\r\nname = "X"\r\n`)).toEqual({ name: null, uuid: null });
    expect(parseProjectHeader(`name = "A"\r\n`)).toEqual({ name: "A", uuid: null });
  });
});

describe("readProject", () => {
  it("prefers JuliaProject.toml, and is null without a project file", () => {
    const fs = fakeFs({
      [abs("/p/JuliaProject.toml")]: `name = "Preferred"`,
      [abs("/p/Project.toml")]: `name = "Other"`,
      [abs("/q/Project.toml")]: `name = "Q"`,
    });
    expect(readProject("/p", { read: fs.read }).name).toBe("Preferred");
    expect(readProject("/q", { read: fs.read }).name).toBe("Q");
    expect(readProject("/none", { read: fs.read })).toBe(null);
    expect(readProject(null)).toBe(null);
  });
});

describe("packageOf", () => {
  const files = {
    [abs("/pkg/Project.toml")]: `name = "MyPkg"\nuuid = "${UUID.toUpperCase()}"\n`,
    [abs("/env/Project.toml")]: `[deps]\nExample = "7876af07-990d-54b4-ab0e-23690620f79a"\n`,
    [abs("/bad/Project.toml")]: `name = "Bad"\nuuid = "not-a-uuid"\n`,
  };
  const fs = fakeFs(files);
  const of = (file) => packageOf(file, fs);

  it("names the package of a file under src/, with a lower-case uuid", () => {
    expect(of("/pkg/src/utils.jl")).toEqual({ name: "MyPkg", uuid: UUID, dir: abs("/pkg") });
    expect(of("/pkg/src/sub/deep.jl").name).toBe("MyPkg");
    expect(of("/pkg/src/MyPkg.jl").name).toBe("MyPkg");
  });

  it("is null for test files, scripts, environments without a name, bad uuids and unsaved buffers", () => {
    expect(of("/pkg/test/runtests.jl")).toBe(null);
    expect(of("/pkg/scripts/run.jl")).toBe(null);
    expect(of("/pkg/srcfoo.jl")).toBe(null);
    expect(of("/env/src/x.jl")).toBe(null);
    expect(of("/bad/src/x.jl")).toBe(null);
    expect(of("/nowhere/src/x.jl")).toBe(null);
    expect(of(null)).toBe(null);
    expect(of("")).toBe(null);
  });
});
