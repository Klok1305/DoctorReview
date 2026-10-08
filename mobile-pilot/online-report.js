"use strict";
for (const table of document.querySelectorAll(".viewer-dashboard-snapshot table.data")) {
  const heads = [...table.querySelectorAll("tr.grp-head[data-g]")];
  if (!heads.length) continue;
  const open = new Map(heads.map(row => [row.dataset.g, row.querySelector("td span")?.textContent.trim() === "▾"]));
  const refresh = () => {
    for (const row of table.querySelectorAll("tr[data-group-ancestors]")) {
      row.style.display = String(row.dataset.groupAncestors || "").split(/\s+/).filter(Boolean).every(key => open.get(key)) ? "" : "none";
    }
    for (const row of table.querySelectorAll("tr.grp-sub:not([data-group-ancestors])")) {
      const group = [...row.classList].find(name => open.has(name));
      if (group) row.style.display = open.get(group) ? "" : "none";
    }
    for (const row of heads) {
      const marker = row.querySelector("td span");
      if (marker) marker.textContent = open.get(row.dataset.g) ? "▾" : "▸";
      row.setAttribute("aria-expanded", String(open.get(row.dataset.g)));
    }
  };
  for (const row of heads) {
    row.tabIndex = 0; row.setAttribute("role", "button");
    const toggle = () => { open.set(row.dataset.g, !open.get(row.dataset.g)); refresh(); };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); toggle(); } });
  }
  refresh();
}
