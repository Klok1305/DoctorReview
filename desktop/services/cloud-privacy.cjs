"use strict";

// Aho–Corasick: one pass through report text instead of one full package scan
// per patient. This module runs only in the local packaging worker. Patient
// patterns never become part of a publication or the server deployment.
function assertCloudPatientPrivacy(pages, patterns = [], { doctorNames = [] } = {}) {
  const knownDoctors = new Set(doctorNames);
  const nodes = [{ next: new Map(), fail: 0, match: false }];
  for (const pattern of new Set(patterns)) {
    if (typeof pattern !== "string" || pattern.length < 4) continue;
    let state = 0;
    for (const char of pattern) {
      if (!nodes[state].next.has(char)) {
        nodes[state].next.set(char, nodes.length);
        nodes.push({ next: new Map(), fail: 0, match: false });
      }
      state = nodes[state].next.get(char);
    }
    nodes[state].match = true;
  }
  const queue = [...nodes[0].next.values()];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    for (const [char, child] of nodes[current].next) {
      let failure = nodes[current].fail;
      while (failure && !nodes[failure].next.has(char)) failure = nodes[failure].fail;
      nodes[child].fail = nodes[failure].next.get(char) || 0;
      nodes[child].match ||= nodes[nodes[child].fail].match;
      queue.push(child);
    }
  }
  const scan = value => {
    if (typeof value === "string") {
      let state = 0;
      for (const char of value) {
        while (state && !nodes[state].next.has(char)) state = nodes[state].fail;
        state = nodes[state].next.get(char) || 0;
        if (nodes[state].match) throw new Error("В отчёте найдено имя или идентификатор пациента. Проверьте комментарии перед публикацией");
      }
    } else if (Array.isArray(value)) value.forEach(scan);
    else if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        // A doctor can also occur in the source patient register. Only the
        // explicitly labelled staff cell is exempt, never free text/comments.
        if (key === "rows" && value.columns?.[0] === "Врач") {
          nested.forEach(row => row.forEach((cell, index) => { if (index !== 0 || !knownDoctors.has(cell)) scan(cell); }));
        } else if (key === "author" && value.blockKey && knownDoctors.has(nested)) continue;
        else scan(nested);
      }
    }
  };
  // Titles, doctor IDs and scope metadata come from the allowed staff roster.
  if (nodes.length > 1) for (const page of pages) scan(page.report || page.html);
}
function cloudPrivacyPatterns(snapshot) {
  const patterns = new Set();
  for (const month of Object.values(snapshot.months || {})) {
    for (const windows of Object.values(month.kb || {})) {
      for (const base of Object.values(windows || {})) {
        for (const patient of base.clients || []) {
          const name = String(patient.name || "").trim();
          const id = String(patient.patientId || "").trim();
          if (name.length >= 4) patterns.add(name);
          if (id.length >= 4 && !/^\d+$/.test(id)) patterns.add(id);
        }
      }
    }
  }
  return [...patterns];
}
module.exports = { assertCloudPatientPrivacy, cloudPrivacyPatterns };
