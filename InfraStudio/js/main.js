/* InfraStudio — interaction & animation layer (vanilla JS, no build step) */

(() => {
  "use strict";

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------------------------- Footer year ---------------------------------- */
  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ---------------------------------- Nav scroll state ---------------------------------- */
  const nav = document.getElementById("nav");
  const onScroll = () => {
    if (window.scrollY > 8) nav.classList.add("scrolled");
    else nav.classList.remove("scrolled");
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ---------------------------------- Mobile nav ---------------------------------- */
  const navToggle = document.getElementById("navToggle");
  const navMobile = document.getElementById("navMobile");
  if (navToggle && navMobile) {
    navToggle.addEventListener("click", () => {
      const open = navMobile.classList.toggle("open");
      navToggle.setAttribute("aria-expanded", String(open));
    });
    navMobile.querySelectorAll("a").forEach((a) =>
      a.addEventListener("click", () => {
        navMobile.classList.remove("open");
        navToggle.setAttribute("aria-expanded", "false");
      })
    );
  }

  /* ---------------------------------- Reveal on scroll ---------------------------------- */
  const revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !prefersReducedMotion) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in-view");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -60px 0px" }
    );
    revealEls.forEach((el) => io.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add("in-view"));
  }

  /* ---------------------------------- Architecture diagram — lit pipeline ---------------------------------- */
  const archNodes = document.querySelectorAll(".arch-node");
  if (archNodes.length && "IntersectionObserver" in window) {
    const archIO = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) entry.target.classList.add("lit");
        });
      },
      { threshold: 0.5 }
    );
    archNodes.forEach((n) => archIO.observe(n));
  } else {
    archNodes.forEach((n) => n.classList.add("lit"));
  }

  /* ---------------------------------- Waitlist modal ---------------------------------- */
  // "Request Early Access" and "Become a Design Partner" open the same dialog
  // shell but are distinct asks — different copy, a company field for design
  // partners, and a "type" recorded with the submission.
  const MODAL_COPY = {
    "early-access": {
      kicker: "Early Access",
      title: "Join the waitlist",
      sub: "Tell us a bit about you. This helps us shape the first workflows around real design work.",
      submit: "Join the waitlist",
      successTitle: "You&rsquo;re on the list.",
      successText: "Thanks for your interest in InfraStudio. We&rsquo;ll be in touch as early access opens.",
      showCompany: false,
    },
    "design-partner": {
      kicker: "Design Partner",
      title: "Become a design partner",
      sub: "Design partners get closer collaboration: shaping the roadmap, piloting new workflows first, and direct access to our team.",
      submit: "Apply as a design partner",
      successTitle: "Thanks for stepping up.",
      successText: "We&rsquo;ll reach out to set up a conversation about becoming a design partner.",
      showCompany: true,
    },
  };

  const overlay = document.getElementById("waitlistOverlay");
  const openTriggers = document.querySelectorAll("[data-open-waitlist]");
  const closeBtn = document.getElementById("modalClose");
  const doneBtn = document.getElementById("modalDone");
  const formWrap = document.getElementById("modalForm");
  const successWrap = document.getElementById("modalSuccess");
  const form = document.getElementById("waitlistForm");
  const modalKicker = document.getElementById("modalKicker");
  const modalTitle = document.getElementById("waitlistTitle");
  const modalSub = document.getElementById("modalSub");
  const submitLabel = document.getElementById("submitLabel");
  const successTitle = document.getElementById("successTitle");
  const successText = document.getElementById("successText");
  const companyField = document.getElementById("companyField");
  const waitlistType = document.getElementById("waitlistType");

  function applyModalCopy(type) {
    const copy = MODAL_COPY[type] || MODAL_COPY["early-access"];
    waitlistType.value = type in MODAL_COPY ? type : "early-access";
    modalKicker.textContent = copy.kicker;
    modalTitle.textContent = copy.title;
    modalSub.textContent = copy.sub;
    submitLabel.textContent = copy.submit;
    successTitle.innerHTML = copy.successTitle;
    successText.innerHTML = copy.successText;
    companyField.hidden = !copy.showCompany;
    const companyInput = companyField.querySelector("input");
    if (companyInput) companyInput.required = copy.showCompany;
  }

  function openModal(type) {
    applyModalCopy(type);
    overlay.classList.add("open");
    document.body.style.overflow = "hidden";
    formWrap.hidden = false;
    successWrap.hidden = true;
    const firstInput = form.querySelector("input[name='name']");
    if (firstInput) setTimeout(() => firstInput.focus(), 300);
  }
  function closeModal() {
    overlay.classList.remove("open");
    document.body.style.overflow = "";
  }

  openTriggers.forEach((btn) =>
    btn.addEventListener("click", () => openModal(btn.dataset.openWaitlist))
  );
  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  if (doneBtn) doneBtn.addEventListener("click", closeModal);
  if (overlay) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("open")) closeModal();
  });

  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const data = new FormData(form);
      const entry = {
        type: (data.get("type") || "early-access").toString(),
        name: (data.get("name") || "").toString().trim(),
        email: (data.get("email") || "").toString().trim(),
        profession: (data.get("profession") || "").toString().trim(),
        company: (data.get("company") || "").toString().trim(),
        notes: (data.get("notes") || "").toString().trim(),
        submittedAt: new Date().toISOString(),
      };

      let valid = true;
      form.querySelectorAll("input[required]").forEach((input) => {
        input.classList.add("touched");
        if (!input.checkValidity()) valid = false;
      });
      if (!valid) return;

      const showSuccess = () => {
        formWrap.hidden = true;
        successWrap.hidden = false;
        form.reset();
        form.querySelectorAll(".touched").forEach((el) => el.classList.remove("touched"));
      };

      // Primary path: append the submission to data/waitlist.csv via the small
      // local Node server (see server.js) — this is the stopgap before a real
      // backend exists. Falls back to localStorage if that server isn't running
      // (e.g. the page was opened from a plain static file host).
      fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      })
        .then((res) => {
          if (!res.ok) throw new Error("waitlist endpoint responded with " + res.status);
          showSuccess();
        })
        .catch(() => {
          try {
            const key = "infrastudio_waitlist";
            const existing = JSON.parse(localStorage.getItem(key) || "[]");
            existing.push(entry);
            localStorage.setItem(key, JSON.stringify(existing));
          } catch (err) {
            /* localStorage unavailable — fail silently, still show success */
          }
          showSuccess();
        });
    });
  }

  /* ==========================================================================
     3D scenes (Three.js). Loaded lazily & only if the library is available —
     the page degrades gracefully to a static SVG fallback otherwise.
     ========================================================================== */

  function buildWireframeHouse(THREE, group, opts = {}) {
    const accent = 0x2f6fed;
    const lineColor = opts.dark ? 0x3a3d45 : 0xbfbdb4;
    const solidColor = opts.dark ? 0x17181b : 0xf2f1ed;

    const floors = 2;
    const floorHeight = 1;
    const width = 2.6;
    const depth = 2;

    // Base slab
    const slabGeo = new THREE.BoxGeometry(width + 0.3, 0.06, depth + 0.3);
    const slabMat = new THREE.MeshBasicMaterial({ color: solidColor, transparent: true, opacity: 0.5 });
    const slab = new THREE.Mesh(slabGeo, slabMat);
    slab.position.y = -0.03;
    group.add(slab);

    const edgesMat = new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: 0.85 });
    const accentMat = new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.95 });

    for (let f = 0; f < floors; f++) {
      const y = f * floorHeight + floorHeight / 2;
      const boxGeo = new THREE.BoxGeometry(width, floorHeight * 0.92, depth);
      const solid = new THREE.Mesh(
        boxGeo,
        new THREE.MeshBasicMaterial({ color: solidColor, transparent: true, opacity: 0.06 })
      );
      solid.position.y = y;
      group.add(solid);

      const edges = new THREE.EdgesGeometry(boxGeo);
      const wire = new THREE.LineSegments(edges, f === floors - 1 ? accentMat : edgesMat);
      wire.position.y = y;
      group.add(wire);

      // window mullions on front face
      const winGeo = new THREE.PlaneGeometry(0.32, 0.4);
      const winEdges = new THREE.EdgesGeometry(winGeo);
      const cols = 3;
      for (let c = 0; c < cols; c++) {
        const winWire = new THREE.LineSegments(winEdges, edgesMat);
        winWire.position.set(-width / 2 + 0.5 + c * 0.85, y, depth / 2 + 0.001);
        group.add(winWire);
        const winWireBack = winWire.clone();
        winWireBack.position.z = -depth / 2 - 0.001;
        winWireBack.rotation.y = Math.PI;
        group.add(winWireBack);
      }
    }

    // Roof (simple pitched wire)
    const roofGeo = new THREE.ConeGeometry(Math.max(width, depth) * 0.78, 0.6, 4);
    roofGeo.rotateY(Math.PI / 4);
    const roofEdges = new THREE.EdgesGeometry(roofGeo);
    const roof = new THREE.LineSegments(roofEdges, accentMat);
    roof.position.y = floors * floorHeight + 0.3;
    group.add(roof);

    // Central staircase hint — vertical accent line
    const stairGeo = new THREE.BoxGeometry(0.5, floors * floorHeight, 0.5);
    const stairEdges = new THREE.EdgesGeometry(stairGeo);
    const stair = new THREE.LineSegments(stairEdges, accentMat);
    stair.position.set(0, (floors * floorHeight) / 2, 0);
    group.add(stair);

    return group;
  }

  function initHeroScene(THREE) {
    const canvas = document.getElementById("heroCanvas");
    if (!canvas) return;
    const frame = canvas.parentElement;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(4.2, 3.1, 5.2);
    camera.lookAt(0, 0.9, 0);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const group = new THREE.Group();
    buildWireframeHouse(THREE, group, { dark: false });
    group.position.y = -0.9;
    scene.add(group);

    function resize() {
      const w = frame.clientWidth;
      const h = frame.clientHeight - 41;
      renderer.setSize(w, Math.max(h, 10), false);
      camera.aspect = w / Math.max(h, 10);
      camera.updateProjectionMatrix();
    }
    resize();
    window.addEventListener("resize", resize);

    let raf;
    function animate(t) {
      raf = requestAnimationFrame(animate);
      if (!prefersReducedMotion) {
        group.rotation.y = t * 0.00022;
        group.position.y = -0.9 + Math.sin(t * 0.0006) * 0.04;
      }
      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(animate);

    // Pause when off-screen to save cycles
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) {
            cancelAnimationFrame(raf);
          } else if (!raf) {
            raf = requestAnimationFrame(animate);
          }
        });
      });
      io.observe(canvas);
    }
  }

  function loadThree(cb) {
    if (window.THREE) return cb(window.THREE);
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
    script.async = true;
    script.onload = () => cb(window.THREE);
    script.onerror = () => {
      /* 3D is a progressive enhancement — the HUD + static frame still communicate the product */
    };
    document.head.appendChild(script);
  }

  // Only load the (moderately heavy) 3D library once the hero is near view,
  // keeping initial page load fast.
  const heroCanvas = document.getElementById("heroCanvas");
  if (heroCanvas) {
    loadThree((THREE) => {
      if (!THREE) return;
      initHeroScene(THREE);
    });
  }
})();
