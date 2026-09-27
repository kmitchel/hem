// Browser and Node-compatible state holder for confirmed HVAC mode.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HvacMode = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const MODES = ["off", "heat", "cool", "fan"];

  function createTracker(render, timeoutMs = 20000) {
    let connected = false;
    let confirmed = null;
    let pending = null;
    let notice = "Mode unavailable";
    let timer = null;

    function snapshot() {
      return { connected, confirmed, pending, notice };
    }

    function show() { render(snapshot()); }
    function clearTimer() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    }

    function connect() {
      clearTimer();
      connected = true;
      confirmed = null;
      pending = null;
      notice = "Waiting for controller";
      show();
    }

    function disconnect() {
      clearTimer();
      connected = false;
      confirmed = null;
      pending = null;
      notice = "Mode unavailable";
      show();
    }

    function receive(topic, value, packet) {
      if (topic !== "hvac/modeState" || !MODES.includes(value) || (packet && packet.retain)) return false;
      if (!connected) return false;
      confirmed = value;
      if (!pending || pending === value) {
        clearTimer();
        pending = null;
        notice = null;
      }
      show();
      return true;
    }

    function request(mode, publish) {
      if (!connected || !MODES.includes(mode)) return false;
      clearTimer();
      pending = mode;
      notice = null;
      show();
      publish("hvac/mode", mode);
      timer = setTimeout(() => {
        timer = null;
        if (pending === mode) {
          pending = null;
          notice = "No controller confirmation";
          show();
        }
      }, timeoutMs);
      return true;
    }

    show();
    return { connect, disconnect, receive, request, snapshot };
  }

  return { createTracker };
});
