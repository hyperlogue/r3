(() => {
  const $ = (id) => document.getElementById(id);
  const controls = ["amplitude", "decay", "frequency", "phase", "offset"];
  const presets = {
    start: [0.8, 0.12, 1.15, 0.3, 0.1],
    close: [1, 0.22, 1.4, 0, 0],
    drift: [1, 0.22, 1.65, 0, 0],
    decay: [1, 0.05, 1.4, 0, 0],
  };
  const initial = document.body.dataset.version === "1" ? "start" : "close";
  const xs = Array.from({ length: 401 }, (_, i) => i / 40);
  const truth = (x) => Math.exp(-0.22 * x) * Math.sin(1.4 * x) + 0.12 * Math.cos(3 * x);
  let parameters = presets[initial];
  let residualRange = 1;
  const estimate = (x) => {
    const [amplitude, decay, frequency, phase, offset] = parameters;
    return amplitude * Math.exp(-decay * x) * Math.sin(frequency * x + phase) + offset;
  };
  const sx = (x) => 52 + x * 66;
  const sy = (y) => 138 - y * 46;
  const ey = (y) => 79 - (y / residualRange) * 54;
  const path = (fn, scale) =>
    xs.map((x, i) => `${i ? "L" : "M"}${sx(x).toFixed(2)},${scale(fn(x)).toFixed(2)}`).join(" ");
  const format = (value) => (Math.abs(value) < 0.0005 ? "0.000" : value.toFixed(3));

  function inspect() {
    const x = Number($("probe").value);
    const actual = truth(x);
    const predicted = estimate(x);
    $("probe-value").textContent = x.toFixed(2);
    $("point-truth").textContent = format(actual);
    $("point-estimate").textContent = format(predicted);
    $("point-error").textContent = format(predicted - actual);
    for (const id of ["curve-cursor", "error-cursor"]) {
      $(id).setAttribute("x1", sx(x));
      $(id).setAttribute("x2", sx(x));
    }
    for (const [id, y] of [
      ["truth-point", sy(actual)],
      ["estimate-point", sy(predicted)],
    ]) {
      $(id).setAttribute("cx", sx(x));
      $(id).setAttribute("cy", y);
    }
    $("error-point").setAttribute("cx", sx(x));
    $("error-point").setAttribute("cy", ey(predicted - actual));
  }

  function render() {
    parameters = controls.map((id) => Number($(id).value));
    controls.forEach((id, i) => {
      $(`${id}-value`).textContent = parameters[i].toFixed(2);
    });
    const errors = xs.map((x) => estimate(x) - truth(x));
    const maximum = Math.max(...errors.map(Math.abs));
    const rmse = Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / xs.length);
    const mae = errors.reduce((sum, error) => sum + Math.abs(error), 0) / xs.length;
    $("rmse").textContent = format(rmse);
    $("mae").textContent = format(mae);
    $("max-error").textContent = format(maximum);
    $("fit-status").textContent =
      rmse < 0.1
        ? "Close fit · the small ripple remains"
        : "Keep exploring · try matching the peaks";
    $("estimate-path").setAttribute("d", path(estimate, sy));
    const reverseTruth = [...xs]
      .reverse()
      .map((x) => `L${sx(x).toFixed(2)},${sy(truth(x)).toFixed(2)}`)
      .join(" ");
    $("gap-area").setAttribute("d", `${path(estimate, sy)} ${reverseTruth} Z`);
    residualRange = Math.max(0.2, Math.ceil(maximum * 5) / 5);
    $("error-upper").textContent = `+${residualRange.toFixed(1)}`;
    $("error-lower").textContent = `−${residualRange.toFixed(1)}`;
    const residual = path((x) => estimate(x) - truth(x), ey);
    $("error-path").setAttribute("d", residual);
    $("error-area").setAttribute("d", `M52,79 ${residual.replace(/^M/, "L")} L712,79 Z`);
    for (const button of document.querySelectorAll("[data-preset]")) {
      button.setAttribute(
        "aria-pressed",
        String(presets[button.dataset.preset].every((value, i) => value === parameters[i])),
      );
    }
    inspect();
  }

  function applyPreset(name) {
    controls.forEach((id, i) => {
      $(id).value = presets[name][i];
    });
    render();
  }

  controls.forEach((id) => {
    $(id).addEventListener("input", render);
  });
  $("probe").addEventListener("input", inspect);
  $("reset").addEventListener("click", () => {
    $("probe").value = "2.5";
    applyPreset(initial);
  });
  for (const button of document.querySelectorAll("[data-preset]")) {
    button.addEventListener("click", () => applyPreset(button.dataset.preset));
  }
  for (const chart of document.querySelectorAll(".plot")) {
    chart.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch" && !event.buttons) return;
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
        chart.getScreenCTM().inverse(),
      );
      $("probe").value = Math.min(10, Math.max(0, (point.x - 52) / 66));
      inspect();
    });
  }
  $("truth-path").setAttribute("d", path(truth, sy));
  applyPreset(initial);
})();
