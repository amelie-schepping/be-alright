import "./styles.scss";
import "bootstrap";

const navbar = document.querySelector(".navbar");
const sections = document.querySelectorAll(".page-section");
const navLinks = document.querySelectorAll('.nav-link[href^="#"]');

// Helper: passenden Link zu einer Section-ID finden
const findLink = (id) =>
  [...navLinks].find((a) => a.getAttribute("href") === `#${id}`);

// IntersectionObserver: aktiver Link + Navbar-Transparenz
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;

      // 1) Aktiven Link setzen
      navLinks.forEach((link) => link.classList.remove("active"));
      const link = findLink(entry.target.id);
      if (link) link.classList.add("active");

      // 2) Navbar-Transparenz je nach Section
      const id = entry.target.id;
      if (id === "about" || id === "loop-station") {
        navbar.classList.add("transparent");
      } else {
        navbar.classList.remove("transparent");
      }
    });
  },
  { threshold: 0.6 } // 60% sichtbar => gilt als aktiv
);

// Alle Sections beobachten
sections.forEach((section) => observer.observe(section));
