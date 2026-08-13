/**
 * Load dated catalog first so a missing probe never blanks the tanks.
 */
(function () {
  "use strict";

  fetch("catalog.json", { cache: "no-store" })
    .then(function (res) {
      if (!res.ok) throw new Error("catalog.json missing");
      return res.json();
    })
    .then(function (cat) {
      window.SparkPack.init(cat);
    })
    .catch(function (err) {
      var vBig = document.getElementById("vBig");
      var vText = document.getElementById("vText");
      if (vBig) {
        vBig.className = "big bad";
        vBig.textContent = "Catalog failed";
      }
      if (vText) vText.textContent = String(err.message || err);
    });
})();
