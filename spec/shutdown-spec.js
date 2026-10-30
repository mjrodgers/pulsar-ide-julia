// Stopping JETLS at once when the window closes (lib/server/shutdown.js).
const { stopQuicklyIfClosing } = require("../lib/server/shutdown");

describe("stopping the servers when the window closes", () => {
  it("turns graceful shutdown off only while Pulsar unloads the window", () => {
    const manager = { shutdownGracefully: true };
    expect(stopQuicklyIfClosing(manager, { unloading: false })).toBe(false);
    expect(manager.shutdownGracefully).toBe(true); // disabling the package or restarting: still graceful
    expect(stopQuicklyIfClosing(manager, { unloading: true })).toBe(true);
    expect(manager.shutdownGracefully).toBe(false);
  });

  it("copes with no server manager (the package never started one)", () => {
    expect(stopQuicklyIfClosing(undefined, { unloading: true })).toBe(false);
    expect(stopQuicklyIfClosing({ shutdownGracefully: true }, undefined)).toBe(false);
  });
});
