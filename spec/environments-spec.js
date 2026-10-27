const fs = require("fs");
const os = require("os");
const path = require("path");
const { rawString } = require("../lib/julia-string");
const env = require("../lib/environments");

describe("rawString", () => {
  it("wraps plain paths", () => {
    expect(rawString("/a/b c")).toBe('raw"/a/b c"');
  });
  it("escapes quotes", () => {
    expect(rawString('a"b')).toBe('raw"a\\"b"');
  });
  it("doubles backslashes that touch a quote or the end", () => {
    expect(rawString("C:\\dir\\")).toBe('raw"C:\\dir\\\\"');
    expect(rawString("C:\\dir\\sub")).toBe('raw"C:\\dir\\sub"');
    expect(rawString('a\\"b')).toBe('raw"a\\\\\\"b"');
  });
});

describe("environment commands", () => {
  it("spells them", () => {
    expect(env.cdCommand("/w/x")).toBe('cd(raw"/w/x")');
    expect(env.cdHomeCommand()).toBe("cd()");
    expect(env.activateCommand("/w/x")).toBe('import Pkg; Pkg.activate(raw"/w/x")');
    expect(env.activateSharedCommand("plots")).toBe('import Pkg; Pkg.activate(raw"plots"; shared=true)');
    expect(env.activateDefaultCommand()).toBe("import Pkg; Pkg.activate()");
  });
});

describe("depotDir", () => {
  it("uses the first JULIA_DEPOT_PATH entry", () => {
    expect(env.depotDir({ env: { JULIA_DEPOT_PATH: ["/d1", "/d2"].join(path.delimiter) }, home: "/home/u" })).toBe("/d1");
    expect(env.depotDir({ env: { JULIA_DEPOT_PATH: [":", "/d2"].join("") }, home: "/home/u" })).toBe(path.delimiter === ":" ? "/d2" : ":/d2");
  });
  it("expands ~ and falls back to ~/.julia", () => {
    expect(env.depotDir({ env: { JULIA_DEPOT_PATH: "~/depot" }, home: "/home/u" })).toBe(path.join("/home/u", "/depot"));
    expect(env.depotDir({ env: {}, home: "/home/u" })).toBe(path.join("/home/u", ".julia"));
    expect(env.depotDir({ env: { JULIA_DEPOT_PATH: "" }, home: "/home/u" })).toBe(path.join("/home/u", ".julia"));
  });
});

describe("listSharedEnvironments", () => {
  let depot;
  beforeEach(() => { depot = fs.mkdtempSync(path.join(os.tmpdir(), "envs-")); });
  afterEach(() => fs.rmSync(depot, { recursive: true, force: true }));

  it("lists folders with a project file, sorted", () => {
    const make = (name, file) => {
      fs.mkdirSync(path.join(depot, "environments", name), { recursive: true });
      if (file) fs.writeFileSync(path.join(depot, "environments", name, file), "");
    };
    make("v1.11", "Project.toml");
    make("Analysis", "JuliaProject.toml");
    make("empty", null);
    fs.writeFileSync(path.join(depot, "environments", "stray.txt"), "");
    expect(env.listSharedEnvironments(depot)).toEqual(["Analysis", "v1.11"]);
  });

  it("is empty without an environments folder", () => {
    expect(env.listSharedEnvironments(depot)).toEqual([]);
    expect(env.listSharedEnvironments(path.join(depot, "nope"))).toEqual([]);
  });
});
