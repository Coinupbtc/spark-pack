/**
 * Packing math + draw. 121 GB is per Spark, not a shared pool.
 * Mutual exclusion is the product: some residents hard-reboot a box.
 */
(function (global) {
  "use strict";

  /** @type {object|null} */
  var catalog = null;
  var sparks = 2;
  /** @type {Object<string, boolean>} */
  var on = {};
  /** @type {object|null} */
  var probe = null;

  /**
   * Default stack matches a typical 2-Spark cluster (DS4F + KV + vision sidecar).
   * @param {object} cat
   */
  function defaultsFrom(cat) {
    on = { os: true };
    cat.modules.forEach(function (m) {
      on[m.id] = m.id === "ds4f" || m.id === "kv" || m.id === "vision";
    });
  }

  function byId(id) {
    if (id === "os") return catalog.os;
    for (var i = 0; i < catalog.modules.length; i++) {
      if (catalog.modules[i].id === id) return catalog.modules[i];
    }
    return null;
  }

  function clusterRanks() {
    return sparks >= 2 ? [0, 1] : [0];
  }

  function spareRank() {
    return sparks >= 3 ? 2 : 0;
  }

  /**
   * H3 is asymmetric — rank 0 is the 89.4 GB side that actually kills a box.
   * @param {object} m
   * @param {number} rank
   */
  function gbOn(m, rank) {
    if (Array.isArray(m.gb)) return m.gb[rank] || 0;
    return m.gb;
  }

  function ranksOf(m) {
    if (m.perSpark) {
      var all = [];
      for (var i = 0; i < sparks; i++) all.push(i);
      return all;
    }
    if (m.kind === "cluster" || m.kind === "h3") return clusterRanks();
    if (m.kind === "sidecar") return [Math.min(1, sparks - 1)];
    return [spareRank()];
  }

  function shareRank(a, b) {
    var ra = ranksOf(a);
    var rb = ranksOf(b);
    return ra.some(function (r) {
      return rb.indexOf(r) !== -1;
    });
  }

  function heavies() {
    // KV is a cluster slice, not a rival resident — do not evict it when DS4F is on.
    return catalog.modules.filter(function (m) {
      return m.id !== "kv" && (m.kind === "cluster" || m.kind === "h3" || m.kind === "spare");
    });
  }

  /** Drop residents that cannot share a tank (DS4F vs H3, cluster vs helper). */
  function reconcile() {
    var list = heavies();
    list.forEach(function (mod) {
      if (!on[mod.id]) return;
      list.forEach(function (other) {
        if (other.id === mod.id || !on[other.id]) return;
        if (shareRank(mod, other) && mod.id === "ds4f") {
          on[other.id] = false;
          if (other.id === "ds4f") on.kv = false;
        }
      });
    });
    if (on.h3 && on.ds4f && sparks >= 2) on.h3 = false;
    if (!on.ds4f) on.kv = false;
  }

  function occupy() {
    var tanks = [];
    for (var i = 0; i < sparks; i++) tanks.push([]);
    function add(m) {
      if (!on[m.id]) return;
      ranksOf(m).forEach(function (r) {
        var g = gbOn(m, r);
        if (g > 0) tanks[r].push({ name: m.name, gb: g, color: m.color, id: m.id });
      });
    }
    add(catalog.os);
    catalog.modules.forEach(add);
    return tanks;
  }

  /**
   * @param {object} m
   */
  function toggle(m) {
    if (m.always) return;
    if (on[m.id]) {
      on[m.id] = false;
      if (m.id === "ds4f") on.kv = false;
      draw();
      return;
    }
    if (m.needs && !on[m.needs]) on[m.needs] = true;
    var actor = m.id === "kv" ? byId("ds4f") : m;
    heavies().forEach(function (h) {
      if (h.id === actor.id || !on[h.id]) return;
      if (shareRank(actor, h)) {
        on[h.id] = false;
        if (h.id === "ds4f") on.kv = false;
      }
    });
    on[m.id] = true;
    draw();
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function verdictOf(tanks) {
    var tankGb = catalog.tank_gb;
    var tight = catalog.tight_headroom_gb;
    var worst = 0;
    tanks.forEach(function (stack) {
      var used = stack.reduce(function (s, x) { return s + x.gb; }, 0);
      worst = Math.max(worst, used);
    });
    var blocked = on.h3 && sparks < 2;
    if (blocked) {
      return {
        kind: "bad",
        title: "Won't start",
        text: "H3 wants both Sparks. One tank can hold rank 0 on paper — the worker never comes up."
      };
    }
    if (worst > tankGb) {
      return {
        kind: "bad",
        title: "Won't start",
        text: "A Spark is over by " + (worst - tankGb).toFixed(1) +
          " GB. Unified memory does not mint extra. Drop a resident or add a Spark."
      };
    }
    var left = tankGb - worst;
    var pct = Math.round((worst / tankGb) * 100);
    if (left < tight) {
      return {
        kind: "tight",
        title: "TIGHT · " + pct + "% · " + left.toFixed(1) + " GB left",
        text: "This is what a live 2-Spark DS4F cluster feels like. Earlyoom trips around 6 GB. Do not add H3."
      };
    }
    return {
      kind: "ok",
      title: "FITS · " + pct + "% · " + left.toFixed(1) + " GB headroom",
      text: sparks + " × " + tankGb + " GB = " + (sparks * tankGb) +
        " GB across the cluster. Worst Spark still has room."
    };
  }

  function drawLive() {
    var box = document.getElementById("live");
    var tag = document.getElementById("live-tag");
    var text = document.getElementById("live-text");
    var btn = document.getElementById("live-match");
    if (!box) return;
    if (!probe || !probe.nodes || !probe.nodes.length) {
      box.className = "live cold";
      tag.textContent = "Catalog";
      text.textContent = "Numbers are measured and dated. On a Spark, run ./probe.sh then refresh to overlay this machine.";
      btn.disabled = true;
      return;
    }
    box.className = "live";
    tag.textContent = "Live probe";
    var bits = probe.nodes.map(function (n) {
      return (n.id || "node") + " " + n.mem_available_gb.toFixed(1) + " GB free of " +
        n.mem_total_gb.toFixed(0);
    });
    text.textContent = bits.join(" · ") + ". Match live paints the tanks from detected residents.";
    btn.disabled = false;
  }

  function draw() {
    if (!catalog) return;
    reconcile();
    var topo = document.getElementById("topo");
    topo.innerHTML = "";
    [
      { n: 1, label: "1 Spark · TP1" },
      { n: 2, label: "2 Sparks · TP2" },
      { n: 3, label: "3 Sparks · TP2 + spare" }
    ].forEach(function (opt) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = opt.n === sparks ? "on" : "";
      b.textContent = opt.label;
      b.addEventListener("click", function () {
        sparks = opt.n;
        draw();
      });
      topo.appendChild(b);
    });

    var modsEl = document.getElementById("mods");
    modsEl.innerHTML = "";
    [catalog.os].concat(catalog.modules).forEach(function (m) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "mod" + (on[m.id] ? " on" : "") + (m.always ? " locked" : "");
      b.innerHTML = '<span class="name">' + esc(m.name) + '</span><span class="gb">' +
        esc(m.label) + '</span><span class="why">' + esc(m.why) + "</span>";
      if (!m.always) b.addEventListener("click", function () { toggle(m); });
      modsEl.appendChild(b);
    });

    var tanks = occupy();
    var racks = document.getElementById("racks");
    racks.style.setProperty("--n", String(sparks));
    racks.innerHTML = "";
    tanks.forEach(function (stack, i) {
      var used = stack.reduce(function (s, x) { return s + x.gb; }, 0);
      var pct = (used / catalog.tank_gb) * 100;
      var rack = document.createElement("div");
      rack.className = "rack" + (used > catalog.tank_gb ? " over" : "");
      var lbl = document.createElement("div");
      lbl.className = "lbl";
      var role = sparks >= 2 && i < 2 && on.ds4f ? "TP2" : "TP1";
      lbl.innerHTML = "<span>Spark " + (i + 1) + " · " + role +
        "</span><span>" + Math.round(pct) + "%</span>";
      var tank = document.createElement("div");
      tank.className = "tank" + (used > catalog.tank_gb ? " over" : "");
      var fill = document.createElement("div");
      fill.className = "tank-fill";
      var acc = 0;
      stack.forEach(function (seg) {
        var s = document.createElement("div");
        s.className = "seg";
        s.style.background = seg.color;
        var h = (seg.gb / catalog.tank_gb) * 100;
        s.style.bottom = acc + "%";
        s.style.height = h + "%";
        acc += h;
        s.innerHTML = "<span>" + esc(seg.name) + "</span><span>" + seg.gb + "</span>";
        fill.appendChild(s);
      });
      tank.appendChild(fill);
      rack.appendChild(lbl);
      rack.appendChild(tank);
      racks.appendChild(rack);
    });

    var v = verdictOf(tanks);
    var vBig = document.getElementById("vBig");
    var vText = document.getElementById("vText");
    vBig.className = "big " + v.kind;
    vBig.textContent = v.title;
    vText.textContent = v.text;
    drawLive();
  }

  /**
   * Turn on catalog ids the probe saw. KV rides with DS4F.
   */
  function matchLive() {
    if (!probe || !probe.detected) return;
    Object.keys(on).forEach(function (id) {
      if (id !== "os") on[id] = false;
    });
    probe.detected.forEach(function (id) {
      if (byId(id)) on[id] = true;
    });
    if (on.ds4f) on.kv = true;
    if (probe.nodes && probe.nodes.length >= 2) sparks = Math.max(sparks, 2);
    draw();
  }

  global.SparkPack = {
    /**
     * @param {object} cat
     */
    init: function (cat) {
      catalog = cat;
      defaultsFrom(cat);
      var asOf = document.getElementById("as-of");
      if (asOf) asOf.textContent = "Catalog measured " + cat.as_of;
      document.getElementById("live-match").addEventListener("click", matchLive);
      draw();
    },
    /**
     * @param {object|null} data
     */
    setProbe: function (data) {
      probe = data;
      draw();
    }
  };
})(window);
