const API = "/api";

let token = null;
let currentUser = null;
let records = [];
let currentView = "dashboard";
let selectedRecord = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);

const pretty = (value) =>
  String(value ?? "").replaceAll("_", " ").toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());

const money = (value) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2
  }).format(Number(value || 0));

const dateText = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? escapeHtml(value)
    : date.toLocaleDateString("en-IN", {
        day: "2-digit", month: "short", year: "numeric"
      });
};

function showNotice(message, type = "info") {
  const area = $("#notice-area");
  if (!area) return;
  area.innerHTML = `<div class="notice ${type === "error" ? "error" : type === "success" ? "success" : type === "warning" ? "warning" : ""}" role="status">${escapeHtml(message)}</div>`;
  area.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function clearNotice() {
  if ($("#notice-area")) $("#notice-area").innerHTML = "";
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body) headers["Content-Type"] = "application/json";

  const response = await fetch(`${API}${path}`, { ...options, headers });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { message: text }; }

  if (!response.ok) {
    throw new Error(data.message || data.error || `Request failed (${response.status})`);
  }
  return data;
}

function getItems(data) {
  if (Array.isArray(data)) return data;
  for (const key of ["fdrs", "records", "items", "data", "results"]) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

function recordStatus(record) {
  return record.status || "DRAFT";
}

function statusBadge(status) {
  const safeStatus = String(status || "DRAFT").toLowerCase();
  return `<span class="status-badge status-${escapeHtml(safeStatus)}">${escapeHtml(pretty(status || "DRAFT"))}</span>`;
}

function recordNumber(record) {
  return record.fdrNumber || record.number || record.id || "—";
}

function recordInstitution(record) {
  return record.institution?.name || record.institutionName || "Your institution";
}

function recordAmount(record) {
  return record.amount ?? record.fdrAmount ?? 0;
}

function dateSortValue(value) {
  return value ? new Date(value).getTime() : 0;
}

function roleLabel(role) {
  return pretty(role || "USER");
}

function canInstitution() {
  return currentUser?.role === "INSTITUTION";
}

function canScrutinize() {
  return currentUser?.role === "SCRUTINY_OFFICER";
}

function canVerify() {
  return currentUser?.role === "VERIFICATION_OFFICER";
}

function renderRows(items, mode = "records") {
  if (!items.length) {
    return `<tr><td colspan="6"><div class="empty-state"><strong>No records found</strong>Records will appear here when available.</div></td></tr>`;
  }

  return items.map((record) => {
    const id = escapeHtml(record.id);
    const status = recordStatus(record);
    let action = `<button class="text-button" data-action="view" data-id="${id}">View</button>`;

    if (mode === "records" && canInstitution() && status === "DRAFT") {
      action += ` <button class="text-button" data-action="submit" data-id="${id}">Submit</button>`;
    }
    if (mode === "queue" && canScrutinize()) {
      if (status === "SUBMITTED") {
        action += ` <button class="text-button" data-action="start-review" data-id="${id}">Start review</button>`;
      }
      if (status === "UNDER_SCRUTINY") {
        action += ` <button class="text-button" data-action="clarification" data-id="${id}">Request clarification</button>`;
        action += ` <button class="text-button" data-action="forward" data-id="${id}">Forward</button>`;
      }
    }
    if (mode === "queue" && canVerify() && status === "AWAITING_VERIFICATION") {
      action += ` <button class="text-button" data-action="verify" data-id="${id}">Record verification</button>`;
    }

    return `<tr>
      <td><div class="cell-primary">${escapeHtml(recordNumber(record))}</div><div class="cell-secondary">${escapeHtml(record.bankName || "—")}</div></td>
      <td>${escapeHtml(recordInstitution(record))}</td>
      <td>${money(recordAmount(record))}</td>
      <td>${dateText(record.maturityDate)}</td>
      <td>${statusBadge(status)}</td>
      <td>${action}</td>
    </tr>`;
  }).join("");
}

function renderTable(container, items, mode = "records") {
  if (!container) return;
  container.innerHTML = `<div class="table-wrap"><table>
    <thead><tr>
      <th>FDR number / bank</th><th>Institution</th><th>Amount</th>
      <th>Maturity date</th><th>Status</th><th>Action</th>
    </tr></thead>
    <tbody>${renderRows(items, mode)}</tbody>
  </table></div>`;
}


function renderDashboard() {
  const isInstitution = canInstitution();
  const isScrutiny = canScrutinize();
  const isVerification = canVerify();

  const total = records.length;

  const pending = records.filter((r) =>
    [
      "DRAFT",
      "SUBMITTED",
      "UNDER_SCRUTINY",
      "CLARIFICATION_PENDING",
      "AWAITING_VERIFICATION",
      "DISCREPANCY"
    ].includes(recordStatus(r))
  ).length;

  const verified = records.filter((r) =>
    ["BANK_VERIFIED", "ACTIVE", "RENEWED"].includes(recordStatus(r))
  ).length;

  // Count FDRs maturing within the next 90 days.
  // Date-only values are handled as calendar dates.
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + 90);

  const expiring = records.filter((r) => {
    if (!r.maturityDate) return false;

    const maturity = new Date(r.maturityDate);
    if (Number.isNaN(maturity.getTime())) return false;

    maturity.setHours(0, 0, 0, 0);
    return maturity >= today && maturity <= cutoff;
  }).length;

  const setStat = (id, value) => {
    const element = $(id);
    if (element) element.textContent = String(value);
  };

  const setCardText = (index, label, description) => {
    const cards = $$(".stat-card");
    const card = cards[index];
    if (!card) return;

    const title = card.querySelector("span");
    const note = card.querySelector("small");

    if (title) title.textContent = label;
    if (note) note.textContent = description;
  };

  if (isInstitution) {
    setCardText(0, "Total FDRs", "Records linked to your institution");
    setCardText(1, "Awaiting action", "Drafts, reviews and discrepancies");
    setCardText(2, "Verified / active", "Verification status recorded in the portal");
    setCardText(3, "Maturing within 90 days", "Upcoming maturity dates");

    setStat("#stat-total", total);
    setStat("#stat-pending", pending);
    setStat("#stat-verified", verified);
    setStat("#stat-expiring", expiring);
  } else if (isScrutiny) {
    setCardText(0, "Items in my queue", "Records available for scrutiny");
    setCardText(1, "Submitted", "Waiting for review to begin");
    setCardText(2, "Under scrutiny", "Reviews currently in progress");
    setCardText(3, "Clarifications", "Records awaiting clarification");

    setStat("#stat-total", total);
    setStat("#stat-pending", records.filter(
      (r) => recordStatus(r) === "SUBMITTED"
    ).length);
    setStat("#stat-verified", records.filter(
      (r) => recordStatus(r) === "UNDER_SCRUTINY"
    ).length);
    setStat("#stat-expiring", records.filter(
      (r) => recordStatus(r) === "CLARIFICATION_PENDING"
    ).length);
  } else if (isVerification) {
    setCardText(0, "Items in my queue", "Records awaiting bank verification");
    setCardText(1, "Awaiting verification", "Pending verification action");
    setCardText(2, "Maturing within 90 days", "Upcoming maturity dates in this queue");
    setCardText(3, "Queue exceptions", "Records needing attention");

    setStat("#stat-total", total);
    setStat("#stat-pending", records.filter(
      (r) => recordStatus(r) === "AWAITING_VERIFICATION"
    ).length);
    setStat("#stat-verified", expiring);
    setStat("#stat-expiring", records.filter(
      (r) => ["DISCREPANCY", "REJECTED"].includes(recordStatus(r))
    ).length);
  } else {
    setCardText(0, "Accessible records", "Records available to this account");
    setCardText(1, "Awaiting action", "Pending workflow items");
    setCardText(2, "Verified / active", "Verification status recorded");
    setCardText(3, "Maturing within 90 days", "Upcoming maturity dates");

    setStat("#stat-total", total);
    setStat("#stat-pending", pending);
    setStat("#stat-verified", verified);
    setStat("#stat-expiring", expiring);
  }

  const recent = [...records].sort((a, b) =>
    dateSortValue(b.updatedAt || b.createdAt) -
    dateSortValue(a.updatedAt || a.createdAt)
  ).slice(0, 5);

  renderTable($("#recent-records"), recent, isInstitution ? "records" : "queue");
}




function renderAllRecords() {
  const query = ($("#search-fdrs")?.value || "").trim().toLowerCase();
  const status = $("#status-filter")?.value || "";
  const filtered = records.filter((record) => {
    const matchesText = [
      recordNumber(record), record.bankName, record.branchName,
      recordInstitution(record)
    ].some((value) => String(value || "").toLowerCase().includes(query));
    return matchesText && (!status || recordStatus(record) === status);
  });
  renderTable($("#all-records"), filtered);
}

function renderQueue() {
  renderTable($("#queue-records"), records, "queue");
}

function hideAllViews() {
  ["dashboard-view", "fdrs-view", "queue-view", "new-fdr-view", "detail-view"]
    .forEach((id) => {
      const element = document.getElementById(id);
      if (element) element.classList.add("hidden");
    });
}

function openView(view) {
  currentView = view;
  clearNotice();
  hideAllViews();

  const target = document.getElementById(`${view}-view`);
  if (target) target.classList.remove("hidden");

  const titles = {
    dashboard: "Dashboard",
    fdrs: "FDR Records",
    queue: canVerify() ? "Bank Verification Queue" : "Review Queue",
    "new-fdr": "Submit New FDR",
    detail: "FDR Details"
  };
  if ($("#page-title")) $("#page-title").textContent = titles[view] || "FDR Portal";

  $$(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });

  if (view === "fdrs") renderAllRecords();
  if (view === "queue") renderQueue();
}

function configureNavigation() {
  $$(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      const view = button.dataset.view;
      if (view === "new-fdr" && !canInstitution()) {
        showNotice("Only institution users can create FDR records.", "warning");
        return;
      }
      openView(view);
    });
  });

  $$("[data-open-view]").forEach((button) => {
    button.addEventListener("click", () => openView(button.dataset.openView));
  });

  $("#new-fdr-nav")?.addEventListener("click", () => openView("new-fdr"));
  $("#new-fdr-button")?.addEventListener("click", () => openView("new-fdr"));
  $("#refresh-button")?.addEventListener("click", refreshData);
  $("#refresh-queue-button")?.addEventListener("click", refreshData);
  $("#search-fdrs")?.addEventListener("input", renderAllRecords);
  $("#status-filter")?.addEventListener("change", renderAllRecords);
}

function configureRoleUI() {
  const role = currentUser?.role;
  const isInstitution = role === "INSTITUTION";
  const isScrutiny = role === "SCRUTINY_OFFICER";
  const isVerification = role === "VERIFICATION_OFFICER";

  if ($("#user-name")) {
    $("#user-name").textContent = currentUser?.name || currentUser?.email || "Portal user";
  }
  if ($("#user-role")) $("#user-role").textContent = roleLabel(role);
  if ($("#user-avatar")) {
    $("#user-avatar").textContent =
      (currentUser?.name || currentUser?.email || "U").trim().charAt(0).toUpperCase();
  }

  const navNew = $("#new-fdr-nav");
  if (navNew) navNew.classList.toggle("hidden", !isInstitution);

  const queueNav = $$('.nav-item').find((item) => item.dataset.view === "queue");
  if (queueNav) queueNav.textContent = isVerification ? "Bank Verification Queue" : "Review Queue";

  const fdrNav = $$('.nav-item').find((item) => item.dataset.view === "fdrs");
  if (fdrNav) fdrNav.classList.toggle("hidden", !isInstitution);

  const newButton = $("#new-fdr-button");
  if (newButton) newButton.classList.toggle("hidden", !isInstitution);

  const queueAvailable = isScrutiny || isVerification;
  if (queueNav) queueNav.classList.toggle("hidden", !queueAvailable);

  const dashboardNav = $$('.nav-item').find((item) => item.dataset.view === "dashboard");
  if (dashboardNav) dashboardNav.classList.remove("hidden");

  const note = $(".sidebar-note");
  if (note) note.textContent = `Signed in as ${roleLabel(role)}. Access is role-restricted.`;

  if (!isInstitution && !queueAvailable) {
    showNotice("This prototype currently supports the institution, scrutiny and verification workflows. Other roles have limited access.", "warning");
  }
}

async function loadInstitutionRecords() {
  const data = await api("/fdrs");
  records = getItems(data);
}

async function loadQueue() {
  if (canScrutinize()) {
    records = getItems(await api("/fdrs/scrutiny/queue"));
  } else if (canVerify()) {
    records = getItems(await api("/fdrs/verification/queue"));
  } else {
    records = [];
  }
}

async function refreshData() {
  try {
    clearNotice();
    if (canInstitution()) await loadInstitutionRecords();
    else if (canScrutinize() || canVerify()) await loadQueue();
    else records = [];

    renderDashboard();
    renderAllRecords();
    renderQueue();
    showNotice("Portal data refreshed.", "success");
  } catch (error) {
    showNotice(error.message || "Unable to load records.", "error");
  }
}

function showAuthenticatedApp() {
  $("#login-screen")?.classList.add("hidden");
  $("#app-screen")?.classList.remove("hidden");
  configureRoleUI();
  openView("dashboard");
  refreshData();
}

$("#login-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorBox = $("#login-error");
  if (errorBox) errorBox.textContent = "";

  const email = $("#email")?.value.trim();
  const password = $("#password")?.value;
  const submitButton = event.submitter;

  if (submitButton) submitButton.disabled = true;

  try {
    const result = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });

    token = result.token || result.accessToken || result.access_token;
    currentUser = result.user || result.data?.user || null;

    if (!token) throw new Error("Login succeeded but no access token was returned.");

    if (!currentUser) {
      const me = await api("/auth/me");
      currentUser = me.user || me.data?.user || me;
    }

    const selectedRole = document.querySelector(
      'input[name="account-type"]:checked'
    )?.value;

    if (selectedRole && currentUser?.role !== selectedRole) {
      token = null;
      currentUser = null;
      throw new Error(
        "The selected account type does not match this account. Please choose the correct role."
      );
    }

    showAuthenticatedApp();
  } catch (error) {
    if (errorBox) errorBox.textContent = error.message || "Login failed. Check your details.";
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

$("#logout-button")?.addEventListener("click", () => {
  token = null;
  currentUser = null;
  records = [];
  selectedRecord = null;
  $("#app-screen")?.classList.add("hidden");
  $("#login-screen")?.classList.remove("hidden");
  $("#login-form")?.reset();
  if ($("#login-error")) $("#login-error").textContent = "";
  clearNotice();
});

$("#fdr-pdf")?.addEventListener("change", (event) => {
  const file = event.currentTarget.files?.[0];
  const name = $("#fdr-pdf-name");
  if (name) name.textContent = file ? `Selected: ${file.name}` : "";
});

$("#fdr-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!canInstitution()) {
    showNotice("Only institution users can create FDRs.", "error");
    return;
  }

  const form = event.currentTarget;
  const submitButton = form.querySelector('[type="submit"]');
  const pdfInput = $("#fdr-pdf");
  const file = pdfInput?.files?.[0];

  if (!file) {
    showNotice("Please select the FDR PDF.", "error");
    return;
  }
  if (!file.name.toLowerCase().endsWith(".pdf") ||
      file.type !== "application/pdf" ||
      file.size > 10 * 1024 * 1024) {
    showNotice("Choose a valid PDF file no larger than 10 MB.", "error");
    return;
  }

  if (submitButton) submitButton.disabled = true;

  const payload = {
    fdrNumber: $("#fdr-number")?.value.trim(),
    bankName: $("#bank-name")?.value.trim(),
    branchName: $("#branch-name")?.value.trim() || undefined,
    amount: $("#fdr-amount")?.value,
    issueDate: $("#issue-date")?.value,
    maturityDate: $("#maturity-date")?.value,
    lienInFavorOf: $("#lien-favor")?.value.trim()
  };

  try {
    const created = await api("/fdrs", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const fdr = created.fdr;
    if (!fdr?.id) throw new Error("FDR was created, but its ID was not returned.");

    const formData = new FormData();
    formData.append("fdrPdf", file);

    const response = await fetch(`${API}/fdrs/${encodeURIComponent(fdr.id)}/documents`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData
    });
    const responseText = await response.text();
    let result = {};
    try { result = responseText ? JSON.parse(responseText) : {}; }
    catch { result = {}; }
    if (!response.ok) {
      throw new Error(result.error || `PDF upload failed (${response.status}). FDR draft ${fdr.fdrNumber} was created; upload its PDF from the draft record after fixing the issue.`);
    }

    form.reset();
    if ($("#fdr-pdf-name")) $("#fdr-pdf-name").textContent = "";
    await loadInstitutionRecords();
    renderDashboard();
    renderAllRecords();
    openView("fdrs");
    showNotice("FDR draft and PDF saved successfully. Review the record and submit it when ready.", "success");
  } catch (error) {
    showNotice(error.message || "Could not create the FDR and upload its PDF.", "error");
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;

  const { action, id } = button.dataset;
  if (!id) return;

  button.disabled = true;
  try {
    if (action === "view") {
      const record = records.find((item) => item.id === id);
      if (!record) throw new Error("Record not found in the current list.");
      selectedRecord = record;
      renderDetail(record);
      openView("detail");
    }

    if (action === "submit") {
      if (!confirm("Submit this FDR for scrutiny? You may not be able to edit it after submission.")) return;
      await api(`/fdrs/${encodeURIComponent(id)}/submit`, { method: "POST" });
      await refreshData();
      openView("fdrs");
      showNotice("FDR submitted for scrutiny.", "success");
    }

    if (action === "start-review") {
      await api(`/fdrs/${encodeURIComponent(id)}/start-review`, { method: "POST" });
      await refreshData();
      openView("queue");
      showNotice("Scrutiny review started.", "success");
    }

    if (action === "clarification") {
      const reason = prompt("Explain the clarification required (at least 10 characters):");
      if (reason === null) return;
      if (reason.trim().length < 10) throw new Error("Please enter at least 10 characters.");
      await api(`/fdrs/${encodeURIComponent(id)}/request-clarification`, {
        method: "POST", body: JSON.stringify({ reason: reason.trim() })
      });
      await refreshData();
      openView("queue");
      showNotice("Clarification requested.", "success");
    }

    if (action === "forward") {
      if (!confirm("Forward this FDR to the bank verification queue?")) return;
      await api(`/fdrs/${encodeURIComponent(id)}/forward-to-verification`, { method: "POST" });
      await refreshData();
      openView("queue");
      showNotice("FDR forwarded for verification.", "success");
    }

    if (action === "verify") {
      const source = prompt("Evidence source (e.g. official bank confirmation/reference):");
      if (source === null) return;
      const status = prompt("Enter result exactly: VERIFIED, MISMATCH, or REJECTED");
      if (status === null) return;
      const normalizedStatus = status.trim().toUpperCase();
      if (!["VERIFIED", "MISMATCH", "REJECTED"].includes(normalizedStatus)) {
        throw new Error("Result must be VERIFIED, MISMATCH, or REJECTED.");
      }
      const remarks = prompt("Enter verification remarks (at least 5 characters):");
      if (remarks === null) return;
      if (remarks.trim().length < 5) throw new Error("Please enter meaningful verification remarks.");

      let declaredData;
      let confirmedData;
      if (normalizedStatus === "VERIFIED") {
        const record = records.find((item) => item.id === id);
        const amount = Number(record?.amount ?? record?.fdrAmount);
        const number = record?.fdrNumber || record?.number;
        const bank = record?.bankName;

        const evidence = prompt(
          "Enter the bank confirmation reference or evidence in a normal sentence:"
        );
        if (evidence === null) return;
        if (evidence.trim().length < 5) {
          throw new Error("Please enter meaningful verification evidence.");
        }
        confirmedData = { evidence: evidence.trim() };

        declaredData = { fdrNumber: number, amount, bankName: bank };
      }

      await api(`/fdrs/${encodeURIComponent(id)}/verify`, {
        method: "POST",
        body: JSON.stringify({
          status: normalizedStatus,
          source: source.trim(),
          remarks: remarks.trim(),
          ...(declaredData ? { declaredData } : {}),
          ...(confirmedData ? { confirmedData } : {})
        })
      });

      await refreshData();
      openView("queue");
      showNotice("Verification result recorded. Ensure the evidence source and remarks are accurate.", "success");
    }
  } catch (error) {
    showNotice(error.message || "The requested action failed.", "error");
  } finally {
    button.disabled = false;
  }
});

function renderDetail(record) {
  const container = $("#detail-content");
  if (!container) return;

  const fields = [
    ["FDR number", recordNumber(record)],
    ["Bank", record.bankName],
    ["Branch", record.branchName],
    ["Amount", money(recordAmount(record))],
    ["Issue date", dateText(record.issueDate)],
    ["Maturity date", dateText(record.maturityDate)],
    ["Lien in favour of", record.lienInFavorOf],
    ["Institution", recordInstitution(record)],
    ["Status", pretty(recordStatus(record))],
    ["Created", dateText(record.createdAt)],
    ["Last updated", dateText(record.updatedAt)]
  ];

  container.innerHTML = `
    <div class="detail-grid">
      ${fields.map(([label, value]) => `
        <div class="detail-item">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value ?? "—")}</strong>
        </div>`).join("")}
    </div>
    <div class="detail-actions">
      <button class="secondary-button" data-open-view="fdrs">Back to records</button>
    </div>`;
  container.querySelectorAll("[data-open-view]").forEach((button) => {
    button.addEventListener("click", () => openView(button.dataset.openView));
  });
}

configureNavigation();

document.querySelector("#password-toggle")?.addEventListener("click", () => {
  const passwordInput = document.querySelector("#password");
  const toggle = document.querySelector("#password-toggle");
  if (!passwordInput || !toggle) return;

  const reveal = passwordInput.type === "password";
  passwordInput.type = reveal ? "text" : "password";
  toggle.textContent = reveal ? "Hide" : "Show";
  toggle.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
  toggle.setAttribute("aria-pressed", String(reveal));
});
