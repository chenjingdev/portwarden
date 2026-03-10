const { renderOnce } = require("./output");
const { collectAllListeners, selectListeners } = require("./ports");

function renderWatch(options) {
  const intervalMs = Math.max(250, Math.round(options.watchSeconds * 1000));
  const render = () => {
    const allListeners = collectAllListeners();
    const listeners = selectListeners(allListeners, options);
    console.clear();
    renderOnce(listeners, allListeners.length, options, true);
  };

  render();
  setInterval(render, intervalMs);
}

module.exports = {
  renderWatch,
};
