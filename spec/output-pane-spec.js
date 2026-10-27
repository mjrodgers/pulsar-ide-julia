const { fakeDocument } = require("./helpers/fake-dom");
const { OutputLog } = require("../lib/debug/log");
const { OutputPane } = require("../lib/debug/output-pane");

describe("OutputPane", () => {
  let log, pane;
  beforeEach(() => {
    log = new OutputLog();
    log.append("before\n");
    pane = new OutputPane(log, { document: fakeDocument() });
  });
  afterEach(() => pane.destroy());

  it("shows what was logged before it opened and what arrives later", () => {
    log.append("after\n", "stderr");
    const spans = pane.pre.querySelectorAll("span");
    expect(spans.map((s) => s.textContent)).toEqual(["before\n", "after\n"]);
    expect(spans.map((s) => s.className)).toEqual(["stdout", "stderr"]);
  });

  it("clears when the log is cleared, including from its Clear button", () => {
    pane.element.querySelector("button.clear").click();
    expect(pane.pre.children.length).toBe(0);
    expect(log.text()).toBe("");
  });

  it("is a bottom pane item", () => {
    expect(pane.getTitle()).toBe("Julia Debug Output");
    expect(pane.getURI()).toBe("atom://pulsar-ide-julia/debug-output");
    expect(pane.getDefaultLocation()).toBe("bottom");
  });

  it("stops listening once destroyed", () => {
    pane.destroy();
    log.append("late\n");
    expect(pane.pre.children.length).toBe(1);
  });
});
