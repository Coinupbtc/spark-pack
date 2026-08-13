/**
 * Optional live overlay. Missing probe.json is the normal browser-only path.
 */
(function () {
  "use strict";

  fetch("probe.json", { cache: "no-store" })
    .then(function (res) {
      if (!res.ok) throw new Error("no probe");
      return res.json();
    })
    .then(function (data) {
      if (window.SparkPack) window.SparkPack.setProbe(data);
    })
    .catch(function () {
      if (window.SparkPack) window.SparkPack.setProbe(null);
    });
})();
