// Browser API compatibility layer for Chrome and Firefox

if (typeof browser === "undefined") {
  window.browser = chrome;
}

let gpuDemandData = null;
let machineNames = [];
let machineApiData = null;
let viewMode = "earnings"; // Default to earnings view
let earningsHistoryCache = {};
let lifetimeEarningsCache = {};
let toggleButtonObserver = null;
let _machineUpdateTimer = null;
let _classOffset = null; // null = not yet detected; computed dynamically from the table's Emotion class number
let _periodicTimersStarted = false;

// Detects the Emotion CSS class offset for the current page render.
// Salad uses Emotion CSS-in-JS; class numbers shift between page loads and deploys.
// The machine table is always present on earn/summary — we derive offset from its class.
function getClassOffset() {
  if (_classOffset !== null) return _classOffset;
  const table = document.querySelector('table');
  if (table) {
    const tableClass = Array.from(table.classList).find(c => /^c0\d+$/.test(c));
    if (tableClass) {
      const tableNum = parseInt(tableClass.slice(2), 10);
      _classOffset = tableNum - 128; // base table class is c0128
      return _classOffset;
    }
  }
  // Table not rendered yet — return 0 without caching so we retry next call
  return 0;
}

// Transforms a c0NNN class name to the correct variant for the current page load
function pc(cls) {
  const offset = getClassOffset();
  if (offset === 0) return cls;
  return cls.replace(/\bc0(\d+)\b/g, (_, n) => `c0${parseInt(n, 10) + offset}`);
}

// querySelector with automatic class variant detection
function qsel(selector) {
  return document.querySelector(pc(selector));
}

// querySelectorAll with automatic class variant detection
function qselAll(selector) {
  return document.querySelectorAll(pc(selector));
}

function scheduleMachineUpdate() {
  if (_machineUpdateTimer) clearTimeout(_machineUpdateTimer);
  _machineUpdateTimer = setTimeout(() => {
    _machineUpdateTimer = null;
    if (!gpuDemandData) {
      fetchGpuDemandData().then(() => fetchMachineApiData().then(() => updateMachineElements())).catch(console.error);
    } else {
      fetchMachineApiData().then(() => updateMachineElements()).catch(console.error);
    }
  }, 150);
}

// Table sorting state
let currentSort = { column: null, direction: "asc" };

// Cache for current earning rates (per-hour) to avoid excessive requests
let currentEarningCache = {};
const CURRENT_EARNING_TTL_MS = 60 * 1000; // 60 seconds cache TTL

async function fetchMachineApiData() {
  try {
    const res = await fetch("https://app-api.salad.com/api/v2/machines", {
      credentials: "include",
    });
    const data = await res.json();
    machineApiData = data.items || data;

    // Store lifetime earnings

    machineApiData.forEach((m) => {
      lifetimeEarningsCache[m.machine_id] = m.lifetime_balance;
    });

    // Update machineNames with valid entries

    if (machineApiData && machineNames.length) {
      machineNames = machineNames
        .map((m) => {
          const matched = machineApiData.find(
            (apiMachine) =>
              apiMachine.machine_id &&
              (apiMachine.machine_id.startsWith(m.machineId) ||
                m.machineId.startsWith(apiMachine.machine_id.substring(0, 8))),
          );

          return {
            ...m,
            valid: !!matched,
            machineIdLong: matched ? matched.machine_id : null,
          };
        })
        .filter((m) => m.valid); // Remove invalid entries
    }
  } catch (err) {
    console.error("Failed to fetch machine API data:", err);
  }
}

async function fetchMachineEarningsHistory() {
  try {
    if (!machineApiData) return;

    // Clear cache if machine list has changed
    const currentMachineIds = new Set(machineApiData.map((m) => m.machine_id));

    Object.keys(earningsHistoryCache).forEach((cachedId) => {
      if (!currentMachineIds.has(cachedId)) {
        delete earningsHistoryCache[cachedId];
      }
    });

    // Fetch all machine histories in parallel

    await Promise.all(
      machineApiData.map(async (machine) => {
        try {
          if (!earningsHistoryCache[machine.machine_id]) {
            const res = await fetch(
              `https://app-api.salad.com/api/v2/machines/${machine.machine_id}/earning-history?timeframe=30d`,
              {
                credentials: "include",
              },
            );

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data && data.earnings) {
              earningsHistoryCache[machine.machine_id] = data.earnings;
            } else {
              console.warn(
                "Unexpected earnings data format for machine:",
                machine.machine_id,
                data,
              );
              earningsHistoryCache[machine.machine_id] = {};
            }
          }
        } catch (err) {
          console.error(
            `Failed to fetch earnings for machine ${machine.machine_id}:`,
            err,
          );
          earningsHistoryCache[machine.machine_id] = {};
        }
      }),
    );
  } catch (err) {
    console.error("Failed to fetch earnings history:", err);
  }
}

async function fetchGpuDemandData() {
  try {
    const res = await fetch(
      "https://app-api.salad.com/api/v2/demand-monitor/gpu",
    );
    gpuDemandData = await res.json();
  } catch (err) {
    console.error("Failed to fetch GPU demand data:", err);
  }
}

function isOnSummaryPage() {
  return window.location.pathname.includes("/earn/summary");
}

function openCSVExportModal() {
  // Remove existing modal if present
  const existingModal = document.getElementById("csvExportModal");
  if (existingModal) existingModal.remove();
  // Create overlay
  const overlay = document.createElement("div");
  overlay.id = "csvExportOverlay";
  overlay.style.position = "fixed";
  overlay.style.top = "0";
  overlay.style.left = "0";
  overlay.style.width = "100%";
  overlay.style.height = "100%";
  overlay.style.backgroundColor = "rgba(0, 0, 0, 0.5)";
  overlay.style.display = "flex";
  overlay.style.justifyContent = "center";
  overlay.style.alignItems = "center";
  overlay.style.zIndex = "10000";

  // Create modal
  const modal = document.createElement("div");
  modal.id = "csvExportModal";
  modal.style.backgroundColor = "#1a2332";
  modal.style.border = "1px solid rgb(219, 241, 193)";
  modal.style.borderRadius = "8px";
  modal.style.padding = "24px";
  modal.style.maxWidth = "400px";
  modal.style.width = "90%";
  modal.style.boxShadow = "0 8px 32px rgba(0, 0, 0, 0.3)";
  modal.style.fontFamily = "Mallory, sans-serif";

  // Title
  const title = document.createElement("h2");
  title.textContent = "Export Earnings Data";
  title.style.margin = "0 0 20px 0";
  title.style.color = "#DBF1C1";
  title.style.fontSize = "18px";
  title.style.fontWeight = "700";

  // Machine selection
  const machineLabel = document.createElement("label");
  machineLabel.textContent = "Select Machine:";
  machineLabel.style.display = "block";
  machineLabel.style.color = "rgb(180, 210, 160)";
  machineLabel.style.fontSize = "13px";
  machineLabel.style.fontWeight = "600";
  machineLabel.style.marginBottom = "6px";

  const machineSelect = document.createElement("select");
  machineSelect.id = "csvMachineSelect";
  machineSelect.style.width = "100%";
  machineSelect.style.padding = "8px 10px";
  machineSelect.style.border = "none";
  machineSelect.style.borderRadius = "4px";
  machineSelect.style.fontSize = "13px";
  machineSelect.style.fontWeight = "600";
  machineSelect.style.color = "#0A2133";
  machineSelect.style.backgroundColor = "rgb(219, 241, 193)";
  machineSelect.style.cursor = "pointer";
  machineSelect.style.marginBottom = "16px";
  machineSelect.style.boxSizing = "border-box";

  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "All Machines";
  machineSelect.appendChild(allOption);

  // Add named machines from machineNames
  machineNames.forEach((machine) => {
    const option = document.createElement("option");
    option.value = machine.machineId;
    option.textContent = machine.customName;
    machineSelect.appendChild(option);
  });

  // Add active unnamed machines (last 31 days) that aren't in machineNames
  if (machineApiData) {
    const now = new Date();
    const thirtyOneDaysAgo = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    const activeMachines = machineApiData.filter((machine) => {
      if (!machine.update_time) return false;
      const updateTime = new Date(machine.update_time);
      return updateTime >= thirtyOneDaysAgo;
    });

    const namedIds = new Set(machineNames.map((m) => m.machineId));
    activeMachines.forEach((machine) => {
      const shortId = machine.machine_id.split("-")[0];

      // Only add if not already in named machines
      if (!namedIds.has(shortId)) {
        const option = document.createElement("option");
        option.value = shortId;
        option.textContent = `Machine ${shortId} (Unnamed)`;
        machineSelect.appendChild(option);
      }
    });
  }

  // Timeframe selection
  const timeframeLabel = document.createElement("label");
  timeframeLabel.textContent = "Time Range:";
  timeframeLabel.style.display = "block";
  timeframeLabel.style.color = "rgb(180, 210, 160)";
  timeframeLabel.style.fontSize = "13px";
  timeframeLabel.style.fontWeight = "600";    
  timeframeLabel.style.marginBottom = "6px";

  const timeframeSelect = document.createElement("select");
  timeframeSelect.id = "csvTimeframeSelect";
  timeframeSelect.style.width = "100%";
  timeframeSelect.style.padding = "8px 10px";
  timeframeSelect.style.border = "none";
  timeframeSelect.style.borderRadius = "4px";
  timeframeSelect.style.fontSize = "13px";
  timeframeSelect.style.fontWeight = "600";
  timeframeSelect.style.color = "#0A2133";
  timeframeSelect.style.backgroundColor = "rgb(219, 241, 193)";
  timeframeSelect.style.cursor = "pointer";
  timeframeSelect.style.marginBottom = "20px";
  timeframeSelect.style.boxSizing = "border-box";

  const timeframeOptions = [
    { value: "24h", text: "24 hours" },
    { value: "7d", text: "7 days" },
    { value: "30d", text: "30 days" },
  ];

  timeframeOptions.forEach((opt) => {
    const option = document.createElement("option");
    option.value = opt.value;
    option.textContent = opt.text;
    if (opt.value === "30d") option.selected = true;
    timeframeSelect.appendChild(option);
  });

  // Buttons container
  const buttonsContainer = document.createElement("div");
  buttonsContainer.style.display = "flex";
  buttonsContainer.style.gap = "10px";

  // Download button
  const downloadBtn = document.createElement("button");
  downloadBtn.textContent = "Download CSV";
  downloadBtn.style.flex = "1";
  downloadBtn.style.border = "none";
  downloadBtn.style.padding = "10px 14px";
  downloadBtn.style.fontFamily = "Mallory, sans-serif";
  downloadBtn.style.fontSize = "13px";
  downloadBtn.style.fontWeight = "700";
  downloadBtn.style.cursor = "pointer";
  downloadBtn.style.backgroundColor = "#DBF1C1";
  downloadBtn.style.color = "#0A2133";
  downloadBtn.style.borderRadius = "4px";
  downloadBtn.style.transition = "background-color 0.2s ease";
  downloadBtn.onmouseover = () => {
    downloadBtn.style.backgroundColor = "#d0e4ab";
  };
  downloadBtn.onmouseout = () => {
    downloadBtn.style.backgroundColor = "#DBF1C1";
  };
  downloadBtn.onclick = () => {
    const selectedMachine = machineSelect.value;
    const selectedTimeframe = timeframeSelect.value;
    downloadEarningsDataFromPage(selectedMachine, selectedTimeframe);
    overlay.remove();
  };

  // Aggregate button
  const aggregateBtn = document.createElement("button");
  aggregateBtn.textContent = "Aggregate";
  aggregateBtn.style.flex = "1";
  aggregateBtn.style.border = "none";
  aggregateBtn.style.padding = "10px 14px";
  aggregateBtn.style.fontFamily = "Mallory, sans-serif";
  aggregateBtn.style.fontSize = "13px";
  aggregateBtn.style.fontWeight = "700";
  aggregateBtn.style.cursor = "pointer";
  aggregateBtn.style.backgroundColor = "#DBF1C1";
  aggregateBtn.style.color = "#0A2133";
  aggregateBtn.style.borderRadius = "4px";
  aggregateBtn.style.transition = "background-color 0.2s ease";
  aggregateBtn.onmouseover = () => {
    aggregateBtn.style.backgroundColor = "#d0e4ab";
  };
  aggregateBtn.onmouseout = () => {
    aggregateBtn.style.backgroundColor = "#DBF1C1";
  };
  aggregateBtn.onclick = () => {
    const selectedTimeframe = timeframeSelect.value;
    downloadAggregateEarningsData(selectedTimeframe);
    overlay.remove();
  };

  // Cancel button
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.flex = "1";
  cancelBtn.style.border = "1px solid rgb(219, 241, 193)";
  cancelBtn.style.padding = "10px 14px";
  cancelBtn.style.fontFamily = "Mallory, sans-serif";
  cancelBtn.style.fontSize = "13px";
  cancelBtn.style.fontWeight = "700";
  cancelBtn.style.cursor = "pointer";
  cancelBtn.style.backgroundColor = "transparent";
  cancelBtn.style.color = "rgb(219, 241, 193)";
  cancelBtn.style.borderRadius = "4px";
  cancelBtn.style.transition = "all 0.2s ease";
  cancelBtn.onmouseover = () => {
    cancelBtn.style.backgroundColor = "rgba(219, 241, 193, 0.1)";
  };
  cancelBtn.onmouseout = () => {
    cancelBtn.style.backgroundColor = "transparent";
  };
  cancelBtn.onclick = () => {
    overlay.remove();
  };
  buttonsContainer.appendChild(downloadBtn);
  buttonsContainer.appendChild(aggregateBtn);
  buttonsContainer.appendChild(cancelBtn);

  // Assemble modal
  modal.appendChild(title);
  modal.appendChild(machineLabel);
  modal.appendChild(machineSelect);
  modal.appendChild(timeframeLabel);
  modal.appendChild(timeframeSelect);
  modal.appendChild(buttonsContainer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Close on overlay click
  overlay.onclick = (e) => {
    if (e.target === overlay) {
      overlay.remove();
    }
  };
}

function downloadEarningsDataFromPage(machineSelection, timeframe) {
  // Determine which machines to include
  let selectedMachines = [];
  if (machineSelection === "all") {
    // Use all active machines from API (last 31 days) instead of just named ones
    const now = new Date();
    const thirtyOneDaysAgo = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    selectedMachines = machineApiData

      .filter((machine) => {
        if (!machine.update_time) return false;
        const updateTime = new Date(machine.update_time);
        return updateTime >= thirtyOneDaysAgo;
      })

      .map((machine) => ({
        machineId: machine.machine_id.split("-")[0],
        customName: "",
        machineIdLong: machine.machine_id,
      }));
  } else {

    // Single machine selection
    const named = machineNames.find((m) => m.machineId === machineSelection);
    if (named) {
      selectedMachines = [named];
    } else {
      // Check if it's an unnamed active machine - need to fetch API data if not available
      if (!machineApiData || machineApiData.length === 0) {
        // Fetch machine data first
        fetchMachineApiData()
          .then(() => {
            downloadEarningsDataFromPage(machineSelection, timeframe);
          })
          .catch(() => {
            console.error("Failed to fetch machine data");
          });
        return;
      }

      const now = new Date();
      const thirtyOneDaysAgo = new Date(
        now.getTime() - 31 * 24 * 60 * 60 * 1000,
      );

      const unnamedMachine = machineApiData.find((machine) => {
        if (!machine.update_time) return false;
        const updateTime = new Date(machine.update_time);
        const shortId = machine.machine_id.split("-")[0];
        return updateTime >= thirtyOneDaysAgo && shortId === machineSelection;
      });

      if (unnamedMachine) {
        selectedMachines = [
          {
            machineId: machineSelection,
            customName: "",
            machineIdLong: unnamedMachine.machine_id,
          },
        ];
      } else {
        console.error("Machine not found:", machineSelection);
        alert("Machine not found. Please try again.");
        return;
      }
    }
  }
  if (selectedMachines.length === 0) {
    console.error("No machines selected");
    return;
  }

  // Fetch earnings data for selected machines
  Promise.all(
    selectedMachines.map((machine) => {
      let fullMachineId = machine.machineIdLong;

      // If we don't have the full machine ID, find it from API data
      if (!fullMachineId) {
        const matchingApiMachine = machineApiData?.find(
          (apiMachine) =>
            apiMachine.machine_id.startsWith(machine.machineId) ||
            machine.machineId.startsWith(apiMachine.machine_id.substring(0, 8)),
        );
        fullMachineId = matchingApiMachine?.machine_id;
      }
      if (!fullMachineId) {
        return Promise.resolve({ machineId: machine.machineId, earnings: {} });
      }

      return fetch(
        `https://app-api.salad.com/api/v2/machines/${fullMachineId}/earning-history?timeframe=${timeframe}`,
        {
          credentials: "include",
        },
      )
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })

        .then((data) => ({
          machineId: machine.machineId,
          customName: machine.customName || "",
          earnings: data.earnings || {},
          fullMachineId: fullMachineId,
        }))

        .catch((err) => {
          console.error(
            `Failed to fetch earnings for ${machine.machineId}:`,
            err,
          );

          return {
            machineId: machine.machineId,
            customName: machine.customName || "",
            earnings: {},
            fullMachineId: "",
          };
        });
    }),
  ).then((results) => {
    const csv = generateEarningsCSV(results);

    downloadCSVFile(csv, "salad-earnings.csv");
  });
}

function downloadAggregateEarningsData(timeframe) {
  if (!machineApiData || machineApiData.length === 0) {
    alert("Machine data not yet loaded. Please wait a moment and try again.");
    return;
  }
  // Fetch earnings data for all active machines (last 31 days) and aggregate by summing matching dates
  const now = new Date();
  const thirtyOneDaysAgo = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
  // Get all active machines from API
  const activeMachines = machineApiData.filter((machine) => {
    if (!machine.update_time) return false;
    const updateTime = new Date(machine.update_time);
    return updateTime >= thirtyOneDaysAgo;
  });

  if (activeMachines.length === 0) {
    console.error("No active machines found");
    return;
  }

  // Fetch earnings data for all active machines
  Promise.all(
    activeMachines.map((machine) => {
      return fetch(
        `https://app-api.salad.com/api/v2/machines/${machine.machine_id}/earning-history?timeframe=${timeframe}`,
        {
          credentials: "include",
        },
      )
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })

        .then((data) => ({
          earnings: data.earnings || {},
        }))

        .catch((err) => {
          console.error(
            `Failed to fetch earnings for ${machine.machine_id}:`,
            err,
          );

          return { earnings: {} };
        });
    }),
  ).then((results) => {
    // Aggregate earnings by date

    const aggregatedEarnings = {};

    results.forEach((result) => {
      const earnings = result.earnings || {};

      Object.entries(earnings).forEach(([date, amount]) => {
        if (!aggregatedEarnings[date]) {
          aggregatedEarnings[date] = 0;
        }

        aggregatedEarnings[date] += amount;
      });
    });

    const csv = generateAggregateCSVFromData(aggregatedEarnings);

    downloadCSVFile(csv, "salad-earnings-aggregate.csv");
  });
}

function generateAggregateCSVFromData(earnings) {
  let csv = "Date,Total Earnings\n";
  if (Object.keys(earnings).length === 0) {
    csv += "No Data,0.000\n";
    return csv;
  }

  const sortedDates = Object.keys(earnings).sort();

  sortedDates.forEach((date) => {
    const totalEarning = earnings[date] || 0;
    const escapedDate = escapeCSVValue(date);
    csv += `${escapedDate},${totalEarning.toFixed(3)}\n`;
  });

  return csv;
}

function generateEarningsCSV(machineResults) {
  let csv = "Machine ID,Custom Name,Date,Earnings\n";

  machineResults.forEach((machineData) => {
    const { machineId, customName, earnings } = machineData;
    const history = earnings || {};
    if (Object.keys(history).length === 0) {
      const escapedId = escapeCSVValue(machineId);
      const escapedName = escapeCSVValue(customName);
      csv += `${escapedId},${escapedName},No Data,0.000\n`;
      return;
    }

    const sortedDates = Object.keys(history).sort();

    sortedDates.forEach((date) => {
      const earning = history[date] || 0;
      const escapedId = escapeCSVValue(machineId);
      const escapedName = escapeCSVValue(customName);
      const escapedDate = escapeCSVValue(date);
      csv += `${escapedId},${escapedName},${escapedDate},${earning.toFixed(3)}\n`;
    });
  });

  return csv;
}

function escapeCSVValue(value) {
  if (value === undefined || value === null) return "";

  const stringValue = String(value);

  if (
    stringValue.includes(",") ||
    stringValue.includes('"') ||
    stringValue.includes("\n")
  ) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

function downloadCSVFile(csv, filename) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function injectTableStylesAndResize() {
  const existing = document.getElementById('smr-styles');
  if (existing) existing.remove();
  const style = document.createElement("style");
  style.id = 'smr-styles';

  const T = pc('c0128'), C = pc('c0120'), I = pc('c0119'), IC = pc('c0119') + '.' + pc('c0121'), W = pc('c0118');
  style.textContent = `
    table.${T} { width: auto !important; min-width: 1200px !important; table-layout: auto !important; }
    table.${T} th, table.${T} td { white-space: nowrap !important; }
    table.${T} th.gpuDemandHeader > div.${C},
    table.${T} th.earningsHeader > div.${C} {
      display: flex !important; justify-content: center !important; align-items: center !important; text-align: center !important;
    }
    table.${T} td.gpuDemandCell > div.${I} > div.${IC},
    table.${T} td.earningsCell > div.${I} > div.${IC} {
      display: flex !important; justify-content: center !important; align-items: center !important; text-align: center !important;
    }
    .${W} > div, .${W} { width: auto !important; max-width: none !important; }
    .earningsCell div { justify-content: center !important; }

    /* Sortable header styles */
    table.${T} th.sortable { cursor: pointer !important; user-select: none !important; }
    table.${T} th .${C} { display: inline-flex !important; align-items: center !important; gap: 6px !important; justify-content: center !important; }
    table.${T} .sort-indicator { font-size: 12px; color: #DBF1C1; line-height: 1; width: 1em; text-align: left; }

    /* Active-only hidden rows (if using attribute) */
    table.${T} tbody tr[hidden-row] { display: none !important; }
  `; 

  // Append style safely: document.head may be null when run at document_start
  if (document.head) {
    document.head.appendChild(style);
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      (document.head || document.documentElement).appendChild(style);
    }, { once: true });
  } else {
    (document.head || document.documentElement).appendChild(style);
  }
}

function addViewToggleButton() {
  // Only add the toggle button on the summary page or when the main machines table exists
  if (!isOnSummaryPage() && !qsel('table.c0128')) {
    return;
  }

  // Prefer the normal container, otherwise place near the main table
  let container = qsel(".c0118");
  const table = qsel('table.c0128');

  if (!container) {
    if (table && table.parentElement) {
      container = table.parentElement;
    } else {
      setTimeout(addViewToggleButton, 500);
      return;
    }
  }

  if (document.getElementById("viewToggleContainer")) return;

  // Create main container div with space-between layout
  const mainContainer = document.createElement("div");
  mainContainer.id = "mainControlsContainer";
  mainContainer.style.marginBottom = "15px";
  mainContainer.style.display = "flex";
  mainContainer.style.alignItems = "center";
  mainContainer.style.justifyContent = "space-between";
  mainContainer.style.gap = "20px";

  // LEFT SIDE: View Type toggle
  const toggleContainer = document.createElement("div");
  toggleContainer.id = "viewToggleContainer";
  toggleContainer.style.display = "flex";
  toggleContainer.style.alignItems = "center";
  toggleContainer.style.gap = "10px";

  const label = document.createElement("p");
  label.className = pc("c0154");
  label.textContent = "View Type";
  label.style.margin = "0";
  label.style.fontFamily = "Mallory, sans-serif";
  label.style.fontSize = "14px";
  label.style.color = "#DBF1C1";

  const toggleWrapper = document.createElement("div");
  toggleWrapper.style.display = "flex";
  toggleWrapper.style.borderRadius = "4px";
  toggleWrapper.style.overflow = "hidden";
  toggleWrapper.style.border = "1px solid #3D5C6F";

  const earningsBtn = document.createElement("button");
  earningsBtn.className =
    pc("c0157") + " " + (viewMode === "earnings" ? pc("c0159") : pc("c0158"));
  earningsBtn.textContent = "Earnings";
  earningsBtn.style.border = "none";
  earningsBtn.style.padding = "6px 12px";
  earningsBtn.style.fontFamily = "Mallory, sans-serif";
  earningsBtn.style.fontSize = "14px";
  earningsBtn.style.cursor = "pointer";
  earningsBtn.style.backgroundColor =
    viewMode === "earnings" ? "#DBF1C1" : "transparent";
  earningsBtn.style.color = viewMode === "earnings" ? "#0A2133" : "#DBF1C1";
  earningsBtn.style.fontWeight = "bold";

  const demandBtn = document.createElement("button");
  demandBtn.className = pc("c0157") + " " + (viewMode === "demand" ? pc("c0159") : pc("c0158"));
  demandBtn.textContent = "Demand";
  demandBtn.style.border = "none";
  demandBtn.style.padding = "6px 12px";
  demandBtn.style.fontFamily = "Mallory, sans-serif";
  demandBtn.style.fontSize = "14px";
  demandBtn.style.cursor = "pointer";
  demandBtn.style.backgroundColor =
    viewMode === "demand" ? "#DBF1C1" : "transparent";
  demandBtn.style.color = viewMode === "demand" ? "#0A2133" : "#DBF1C1";
  demandBtn.style.fontWeight = "bold";

  earningsBtn.onclick = () => {
    viewMode = "earnings";
    updateToggleStyles();
    updateMachineElements();
  };

  demandBtn.onclick = () => {
    viewMode = "demand";
    updateToggleStyles();
    updateMachineElements();
  };

  function updateToggleStyles() {
    earningsBtn.className =
      pc("c0157") + " " + (viewMode === "earnings" ? pc("c0159") : pc("c0158"));
    earningsBtn.style.backgroundColor =
      viewMode === "earnings" ? "#DBF1C1" : "transparent";
    earningsBtn.style.color = viewMode === "earnings" ? "#0A2133" : "#DBF1C1";
    demandBtn.className =
      pc("c0157") + " " + (viewMode === "demand" ? pc("c0159") : pc("c0158"));
    demandBtn.style.backgroundColor =
      viewMode === "demand" ? "#DBF1C1" : "transparent";
    demandBtn.style.color = viewMode === "demand" ? "#0A2133" : "#DBF1C1";
  }

  toggleWrapper.appendChild(earningsBtn);
  toggleWrapper.appendChild(demandBtn);
  toggleContainer.appendChild(label);
  toggleContainer.appendChild(toggleWrapper);

  // RIGHT SIDE: Export button
  const exportBtn = document.createElement("button");
  exportBtn.textContent = "Export Earnings CSV";
  exportBtn.style.border = "none";
  exportBtn.style.padding = "8px 16px";
  exportBtn.style.fontFamily = "Mallory, sans-serif";
  exportBtn.style.fontSize = "14px";
  exportBtn.style.fontWeight = "700";
  exportBtn.style.cursor = "pointer";
  exportBtn.style.backgroundColor = "#DBF1C1";
  exportBtn.style.color = "#0A2133";
  exportBtn.style.borderRadius = "4px";
  exportBtn.style.transition = "background-color 0.2s ease";
  exportBtn.onmouseover = () => {
    exportBtn.style.backgroundColor = "#d0e4ab";
  };
  exportBtn.onmouseout = () => {
    exportBtn.style.backgroundColor = "#DBF1C1";
  };
  exportBtn.onclick = () => {
    openCSVExportModal();
  };

  // Salad Tools link button
  const saladToolsBtn = document.createElement("a");
  saladToolsBtn.textContent = "📊 GPU Demand & Earnings";
  saladToolsBtn.href = "https://salad-tools.novatech.gg/";
  saladToolsBtn.target = "_blank";
  saladToolsBtn.rel = "noopener noreferrer";
  saladToolsBtn.style.border = "none";
  saladToolsBtn.style.padding = "8px 16px";
  saladToolsBtn.style.fontFamily = "Mallory, sans-serif";
  saladToolsBtn.style.fontSize = "14px";
  saladToolsBtn.style.fontWeight = "700";
  saladToolsBtn.style.cursor = "pointer";
  saladToolsBtn.style.backgroundColor = "#DBF1C1";
  saladToolsBtn.style.color = "#0A2133";
  saladToolsBtn.style.borderRadius = "4px";
  saladToolsBtn.style.textDecoration = "none";
  saladToolsBtn.style.display = "inline-flex";
  saladToolsBtn.style.alignItems = "center";
  saladToolsBtn.style.transition = "background-color 0.2s ease";
  saladToolsBtn.onmouseover = () => {
    saladToolsBtn.style.backgroundColor = "#d0e4ab";
  };
  saladToolsBtn.onmouseout = () => {
    saladToolsBtn.style.backgroundColor = "#DBF1C1";
  };

  // Right container for export and potential future controls
  const rightContainer = document.createElement('div');
  rightContainer.style.display = 'flex';
  rightContainer.style.alignItems = 'center';
  rightContainer.style.gap = '8px';
  rightContainer.appendChild(saladToolsBtn);
  rightContainer.appendChild(exportBtn);



  // Assemble main container with left and right sections
  mainContainer.appendChild(toggleContainer);
  mainContainer.appendChild(rightContainer); 

  if (container.firstChild) container.insertBefore(mainContainer, container.firstChild);
  else container.appendChild(mainContainer);
}

function addCopyChartButton() {
  // Skip on Firefox - html2canvas has iframe security issues in Firefox extensions
  const isFirefox = typeof InstallTrigger !== 'undefined' || navigator.userAgent.includes('Firefox');
  if (isFirefox) return;
  
  const earningsContainer = qsel(".c0151");
  if (!earningsContainer) {
    setTimeout(addCopyChartButton, 500);
    return;
  }
  if (document.getElementById("copyChartButton")) return;

  const controlsContainer = earningsContainer.querySelector(pc(".c0155"));
  if (!controlsContainer) return;

  const copyBtn = document.createElement("button");
  copyBtn.id = "copyChartButton";
  copyBtn.textContent = "Copy Chart";

  Object.assign(copyBtn.style, {
    border: "none",
    padding: "6px 12px",
    fontFamily: "Mallory, sans-serif",
    fontSize: "14px",
    fontWeight: "700",
    cursor: "pointer",
    backgroundColor: "#DBF1C1",
    color: "#0A2133",
    borderRadius: "4px",
    transition: "background-color 0.2s ease",
    height: "32px",
  });

  copyBtn.onmouseover = () => (copyBtn.style.backgroundColor = "#d0e4ab");
  copyBtn.onmouseout = () => (copyBtn.style.backgroundColor = "#DBF1C1");

  copyBtn.onclick = async () => {
    const originalText = copyBtn.textContent;
    copyBtn.textContent = "⏳ Capturing…";
    copyBtn.disabled = true;

    try {
      // Capture the entire earnings container (title + chart + legend) so we include the title
      const chartEl = earningsContainer; // full container capture

      const blob = await captureElementAsBlob(chartEl);

      // Try to copy to clipboard with cross-browser support
      let copied = false;

      if (navigator.clipboard && navigator.clipboard.write) {
        // Try standard ClipboardItem (Chrome, Safari, Firefox 127+)
        if (typeof ClipboardItem !== "undefined") {
          try {
            await navigator.clipboard.write([
              new ClipboardItem({ "image/png": blob }),
            ]);
            copied = true;
          } catch (e) {
            console.warn("Standard ClipboardItem failed:", e);
            // Try with Promise wrapper (helps with some Firefox versions)
            try {
              await navigator.clipboard.write([
                new ClipboardItem({
                  "image/png": Promise.resolve(blob),
                }),
              ]);
              copied = true;
            } catch (e2) {
              console.warn("Promise-based ClipboardItem also failed:", e2);
            }
          }
        }
      }

      if (copied) {
        copyBtn.textContent = "✓ Copied!";
      } else {
        copyBtn.textContent = "❌ Not supported";
        console.error("Clipboard image copy not supported in this browser");
      }
    } catch (err) {
      console.error("Capture failed:", err);
      copyBtn.textContent = "❌ Failed";
    }

    setTimeout(() => {
      copyBtn.textContent = originalText;
      copyBtn.disabled = false;
    }, 2000);
  };

  try {
    // Make controls container a positioned parent for absolute placement
    if (getComputedStyle(controlsContainer).position === "static") {
      controlsContainer.style.position = "relative";
    }

    // Prepare absolute positioning so the button aligns with the chart's right edge
    Object.assign(copyBtn.style, {
      position: "absolute",
      top: "50%",
      transform: "translateY(-50%)",
      zIndex: "1000",
      right: "10px", // fallback; will be recalculated
    });

    controlsContainer.appendChild(copyBtn);

    // Positioning function: align button's right edge with the chart's right edge
    function positionCopyBtn() {
      try {
        const chartEl =
          earningsContainer.querySelector(".recharts-responsive-container") ||
          earningsContainer.querySelector("svg") ||
          earningsContainer;
        if (!chartEl) return;
        const chartRect = chartEl.getBoundingClientRect();
        const containerRect = controlsContainer.getBoundingClientRect();

        // Ensure the button does not extend beyond the chart's right edge
        const btnRect = copyBtn.getBoundingClientRect();
        const btnWidth = btnRect.width || 80;
        const btnHeight = btnRect.height || 32;

        // compute left such that (left + btnWidth + containerRect.left) <= chartRect.right - 10
        let left = Math.min(
          containerRect.width - btnWidth - 10,
          chartRect.right - containerRect.left - btnWidth - 10,
        );
        if (left < 0) left = Math.max(0, containerRect.width - btnWidth - 10);

        // Find the toggle row to vertically align with (prefer child containing .c0154 label)
        let toggleGroup = null;
        for (const child of Array.from(controlsContainer.children)) {
          try {
            if (child.querySelector && child.querySelector(pc(".c0154"))) {
              toggleGroup = child;
              break;
            }
          } catch (e) {}
        }
        if (!toggleGroup) toggleGroup = controlsContainer;

        const toggleRect = toggleGroup.getBoundingClientRect();

        // compute top so the button is centered with the toggle group, but don't let it go outside container
        let top =
          (toggleRect.top + toggleRect.bottom) / 2 -
          containerRect.top -
          btnHeight / 2;
        // clamp top between 0 and container height - btnHeight
        top = Math.max(0, Math.min(containerRect.height - btnHeight - 4, top));

        copyBtn.style.left = left + "px";
        copyBtn.style.top = top + "px";
        copyBtn.style.right = "auto";
        // remove any translateY used previously
        copyBtn.style.transform = "none";
      } catch (err) {
        // ignore positioning errors
      }
    }

    // Call immediately and hook to resize/DOM changes
    positionCopyBtn();

    // Also attempt to position after a couple animation frames (helps when chart renders asynchronously)
    requestAnimationFrame(() => requestAnimationFrame(positionCopyBtn));

    // Small stabilization retries to account for late rendering/layout changes
    let _retries = 0;
    const stabilizer = setInterval(() => {
      positionCopyBtn();
      _retries += 1;
      if (_retries > 12) {
        clearInterval(stabilizer);
        delete copyBtn._stabilizer;
      }
    }, 200);
    copyBtn._stabilizer = stabilizer;

    window.addEventListener("resize", positionCopyBtn);

    // Use ResizeObserver where available to re-position when chart resizes
    try {
      const ro = new ResizeObserver(positionCopyBtn);
      const chartEl =
        earningsContainer.querySelector(".recharts-responsive-container") ||
        earningsContainer.querySelector("svg") ||
        earningsContainer;
      if (chartEl) ro.observe(chartEl);
      // keep a reference to disconnect if needed
      copyBtn._ro = ro;
    } catch (e) {
      // ResizeObserver not available; fall back to periodic check (shorter interval)
      copyBtn._interval = setInterval(positionCopyBtn, 500);
    }
  } catch (e) {
    console.warn("Failed to append copy chart button:", e);
  }
}

async function captureElementAsBlob(element) {
  const clone = element.cloneNode(true);
  clone.style.backgroundColor = "#0A2133";

  const wrapper = document.createElement("div");
  Object.assign(wrapper.style, {
    position: "fixed",
    left: "-99999px",
    top: "0",
    pointerEvents: "none",
  });

  wrapper.appendChild(clone);
  document.body.appendChild(wrapper);

  await rasterizeSvgsInClone(clone);

  const scale = 2;
  
  // Detect Firefox - it has stricter security that blocks iframe-based rendering
  const isFirefox = typeof InstallTrigger !== 'undefined' || navigator.userAgent.includes('Firefox');
  
  const canvas = await html2canvas(clone, {
    backgroundColor: "#0A2133",
    scale: scale,
    useCORS: true,
    logging: false,
    foreignObjectRendering: isFirefox, // Use foreignObject for Firefox to avoid iframe security issues
    allowTaint: true,
  });

  document.body.removeChild(wrapper);

  // Add padding of 20px (CSS pixels) on left, top, and bottom. Multiply by scale because canvas uses device pixels.
  const leftPaddingCss = 20;
  const topPaddingCss = 20;
  const bottomPaddingCss = 20;

  const leftPaddingPx = Math.round(leftPaddingCss * scale);
  const topPaddingPx = Math.round(topPaddingCss * scale);
  const bottomPaddingPx = Math.round(bottomPaddingCss * scale);

  const paddedCanvas = document.createElement("canvas");
  paddedCanvas.width = canvas.width + leftPaddingPx;
  paddedCanvas.height = canvas.height + topPaddingPx + bottomPaddingPx;

  const ctx = paddedCanvas.getContext("2d");
  // Fill background to match page
  ctx.fillStyle = "#0A2133";
  ctx.fillRect(0, 0, paddedCanvas.width, paddedCanvas.height);
  // Draw original canvas shifted right by left padding and down by top padding
  ctx.drawImage(canvas, leftPaddingPx, topPaddingPx);

  return new Promise((resolve) => paddedCanvas.toBlob(resolve, "image/png"));
}

async function rasterizeSvgsInClone(container) {
  const svgs = container.querySelectorAll("svg");

  for (const svg of svgs) {
    const rect = svg.getBoundingClientRect();
    const clone = svg.cloneNode(true);

    let svgStr = new XMLSerializer().serializeToString(clone);
    if (!svgStr.includes("xmlns=")) {
      svgStr = svgStr.replace(
        "<svg",
        '<svg xmlns="http://www.w3.org/2000/svg">',
      );
    }

    const blob = new Blob([svgStr], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);

    await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, rect.width * 2);
        canvas.height = Math.max(1, rect.height * 2);

        const ctx = canvas.getContext("2d");
        ctx.scale(2, 2);
        ctx.drawImage(img, 0, 0);

        const imgEl = document.createElement("img");
        imgEl.src = canvas.toDataURL("image/png");
        imgEl.style.width = `${rect.width}px`;
        imgEl.style.height = `${rect.height}px`;
        imgEl.style.display = "block";

        svg.replaceWith(imgEl);
        URL.revokeObjectURL(url);
        resolve();
      };

      img.onerror = reject;
      img.src = url;
    });
  }
}

function sumLastHours(history, hours) {
  if (!history || typeof history !== "object") return 0;

  try {
    const entries = Object.entries(history)
      .map(([date, value]) => ({
        date: new Date(date),
        value: typeof value === "number" ? value : 0,
      }))
      .sort((a, b) => b.date - a.date)
      .slice(0, hours);
    return entries.reduce((sum, entry) => sum + entry.value, 0);
  } catch (err) {
    console.error("Error summing hours:", err);
    return 0;
  }
}

function addEmptyEarningsCells(row) {
  // Updated to add 6 empty cells (includes Current Earning Rate + GPU Name + 4 earnings columns)
  for (let i = 0; i < 6; i++) {
    const td = document.createElement("td");

    td.className = "earningsCell";
    td.innerHTML = `
      <div class="${pc('c0119')}">
        <div class="${pc('c0119')} ${pc('c0121')}">N/A</div>
      </div>
    `;
    row.appendChild(td);
  }
} 

function addEarningsColumnsToTable() {
  const table = qsel("table.c0128");

  if (!table) return;
  const theadRow = table.querySelector("thead tr");
  const tbodyRows = table.querySelectorAll("tbody tr");

  // Ensure required earnings headers are present but do not duplicate existing site headers
  const earningsHeaders = ["Current Earning Rate", "GPU Name", "Last 24h", "Last 7d", "Last 30d", "Lifetime"];

  earningsHeaders.forEach((text) => {
    const exists = Array.from(theadRow.cells).some((h) =>
      h.textContent.trim().toLowerCase().startsWith(text.toLowerCase()),
    );
    if (!exists) {
      const th = document.createElement("th");
      th.className = "earningsHeader";
      th.innerHTML = `<div class="${pc('c0120')}"><span>${text}</span></div>`;
      theadRow.appendChild(th);
    }
  });

  tbodyRows.forEach((row) => {
    // Remove previously injected earnings cells (from prior runs)
    row.querySelectorAll(".earningsCell").forEach((el) => el.remove());

    const machineIdCell =
      row.querySelector(".css-15d7bl7.ei767vo0") || row.cells[1];

    if (!machineIdCell) {
      addEmptyEarningsCells(row);

      return;
    }

    // Use data-machine-id attribute if available (set by updateMachineElements)
    // This ensures we match the correct machine even with duplicate custom names
    const taggedMachineId = machineIdCell.getAttribute('data-machine-id');
    const machineIdText = machineIdCell.textContent.trim();

    let matchingMachine = null;
    
    if (taggedMachineId) {
      // Use the stored machine ID for accurate lookup
      matchingMachine = machineApiData?.find(
        (apiMachine) => apiMachine.machine_id.startsWith(taggedMachineId)
      );
    } else {
      // Fallback: try matching by text (machine ID or custom name)
      matchingMachine = machineApiData?.find(
        (apiMachine) =>
          apiMachine.machine_id.startsWith(machineIdText) ||
          machineNames.some(
            (m) =>
              m.customName === machineIdText &&
              apiMachine.machine_id.startsWith(m.machineId),
          ),
      );
    }

    if (!matchingMachine) {
      addEmptyEarningsCells(row);

      return;
    }

    // Get GPU name - first try from machineNames (custom named machines), then from API data
    let gpuInfo = null;
    
    // Try to find GPU info from machineNames entry
    const machineEntry = machineNames.find((m) =>
      matchingMachine.machine_id.startsWith(m.machineId),
    );
    
    if (machineEntry && machineEntry.gpuName) {
      gpuInfo = gpuDemandData?.find((gpu) => gpu.name === machineEntry.gpuName);
    }
    
    // If no GPU info found from machineNames, try to get it from the API machine data
    if (!gpuInfo && matchingMachine.gpu_model) {
      gpuInfo = gpuDemandData?.find((gpu) => 
        gpu.name === matchingMachine.gpu_model ||
        gpu.displayName?.toLowerCase().includes(matchingMachine.gpu_model?.toLowerCase())
      );
    }

    const gpuDisplayName = gpuInfo?.displayName
      ? gpuInfo.displayName.replace(/^NVIDIA\s+/i, "")
      : (matchingMachine.gpu_model || "N/A");

    const history = earningsHistoryCache[matchingMachine.machine_id] || {};
    const lifetime = lifetimeEarningsCache[matchingMachine.machine_id] || 0;

    // Build the cells we will place for this row and insert them in the same order as the table headers
    const tdsByKey = {};

    // current earning cell (placeholder)
    const currentTd = document.createElement("td");
    currentTd.className = "earningsCell currentEarningCell";
    currentTd.innerHTML = `
      <div class="${pc('c0119')}">
        <div class="${pc('c0119')} ${pc('c0121')}">$0.000 / Hour</div>
      </div>
    `;
    tdsByKey['current earning rate'] = currentTd;

    // GPU Name
    const gpuTd = document.createElement('td');
    gpuTd.className = 'earningsCell';
    gpuTd.innerHTML = `<div class="${pc('c0119')}"><div class="${pc('c0119')} ${pc('c0121')}">${gpuDisplayName}</div></div>`;
    tdsByKey['gpu name'] = gpuTd;

    // Last 24h, 7d, 30d, Lifetime
    const last24 = document.createElement('td');
    last24.className = 'earningsCell';
    last24.innerHTML = `<div class="${pc('c0119')}"><div class="${pc('c0119')} ${pc('c0121')}">$${sumLastHours(history,24).toFixed(3)}</div></div>`;
    tdsByKey['last 24h'] = last24;

    const last7 = document.createElement('td');
    last7.className = 'earningsCell';
    last7.innerHTML = `<div class="${pc('c0119')}"><div class="${pc('c0119')} ${pc('c0121')}">$${sumLastHours(history,168).toFixed(3)}</div></div>`;
    tdsByKey['last 7d'] = last7;

    const last30 = document.createElement('td');
    last30.className = 'earningsCell';
    last30.innerHTML = `<div class="${pc('c0119')}"><div class="${pc('c0119')} ${pc('c0121')}">$${sumLastHours(history,720).toFixed(3)}</div></div>`;
    tdsByKey['last 30d'] = last30;

    const lifetimeTd = document.createElement('td');
    lifetimeTd.className = 'earningsCell';
    lifetimeTd.innerHTML = `<div class="${pc('c0119')}"><div class="${pc('c0119')} ${pc('c0121')}">$${lifetime.toFixed(3)}</div></div>`;
    tdsByKey['lifetime'] = lifetimeTd;

    // Determine headers and try to find the site's existing 'Current Earning' column index
    const headerOrder = Array.from(theadRow.cells).map(h => h.textContent.trim().toLowerCase());
    const currentIdx = headerOrder.findIndex(h => h.includes('current') && h.includes('earning'));

    let currentCellRef = currentTd; // default

    if (currentIdx !== -1) {
      // If the row already has a cell at that index, replace its contents and mark it as the current earning cell
      const existingCell = row.cells[currentIdx];
      if (existingCell) {
        existingCell.classList.add('currentEarningCell');
        existingCell.innerHTML = `<div class="${pc('c0119')}"><div class="${pc('c0119')} ${pc('c0121')}">$0.000 / Hour</div></div>`;
        currentCellRef = existingCell;
      } else {
        // fallback to inserting at that position
        const insertBeforeCell = row.cells[currentIdx] || null;
        row.insertBefore(currentTd, insertBeforeCell);
        currentCellRef = currentTd;
      }

      // Remove placeholder key so we don't append a duplicate current cell later
      delete tdsByKey['current earning rate'];

      // Append remaining cells following header order (skip the current earning key)
      headerOrder.forEach((hk) => {
        if (hk === 'current earning rate' || (hk.includes('current') && hk.includes('earning'))) return;
        if (tdsByKey[hk]) {
          row.appendChild(tdsByKey[hk]);
          delete tdsByKey[hk];
        }
      });

      // Append any left-over cells
      Object.keys(tdsByKey).forEach((k) => row.appendChild(tdsByKey[k]));
    } else {
      // No site header found; fall back to inserting all cells in header order matching
      const keysPlaced = new Set();
      headerOrder.forEach((hk) => {
        if (tdsByKey[hk]) {
          row.appendChild(tdsByKey[hk]);
          keysPlaced.add(hk);
        }
      });

      // Append any remaining cells that didn't match headers (fallback)
      Object.keys(tdsByKey).forEach((k) => {
        if (!keysPlaced.has(k)) row.appendChild(tdsByKey[k]);
      });

      // If there was no matching header, ensure current cell is present (put at start)
      if (!row.querySelector('.currentEarningCell')) {
        row.insertBefore(currentTd, row.firstChild);
        currentCellRef = currentTd;
        // Remove placeholder so it won't be appended again
        delete tdsByKey['current earning rate'];
      }
    }

    // Trigger async update for the current earning cell for this machine
    updateCurrentEarningForCell(matchingMachine.machine_id, currentCellRef);
  });
}


function addColumnsToExistingTable() {
  const table = qsel("table.c0128");

  if (!table) return;

  const theadRow = table.querySelector("thead tr");

  const tbodyRows = table.querySelectorAll("tbody tr");

  // Ensure demand headers are present (do not duplicate site headers)
  const demandHeaders = [
    "Current Earning Rate",
    "GPU Name",
    "GPU Demand (Tier / Util %)",
    "Avg Earning Rate",
    "Top 25% Earning Rate",
  ];

  demandHeaders.forEach((text) => {
    const exists = Array.from(theadRow.cells).some((h) =>
      h.textContent.trim().toLowerCase().startsWith(text.toLowerCase()),
    );
    if (!exists) {
      const th = document.createElement("th");
      th.className = pc("c0131") + " gpuDemandHeader";
      const divC0120 = document.createElement("div");
      divC0120.className = pc("c0120");
      const span = document.createElement("span");
      span.className = "css-1la6eeo ei767vo0";
      span.textContent = text;
      divC0120.appendChild(span);
      th.appendChild(divC0120);
      theadRow.appendChild(th);
    }
  });

  tbodyRows.forEach((row) => {
    let machineIdCell = row.querySelector(".css-15d7bl7.ei767vo0");

    if (!machineIdCell && row.cells.length >= 2) {
      machineIdCell = row.cells[1];
    }

    if (!machineIdCell) {
      // Add four empty cells (one extra for GPU Name)

      for (let i = 0; i < 4; i++) {
        const td = document.createElement("td");
        td.className = pc("c0131") + " gpuDemandCell";
        const divC0119 = document.createElement("div");
        divC0119.className = pc("c0119");
        const divInner = document.createElement("div");
        divInner.className = pc("c0119") + " " + pc("c0121");
        divInner.textContent = "N/A";
        divC0119.appendChild(divInner);
        td.appendChild(divC0119);
        row.appendChild(td);
      }

      return;
    }

    // Use data-machine-id attribute if available (set by updateMachineElements)
    // This ensures we match the correct machine even with duplicate custom names
    const taggedMachineId = machineIdCell.getAttribute('data-machine-id');
    const machineIdText = machineIdCell.textContent.trim();

    // First try to find the API machine data
    let matchingApiMachine = null;
    
    if (taggedMachineId) {
      matchingApiMachine = machineApiData?.find(
        (apiMachine) => apiMachine.machine_id.startsWith(taggedMachineId)
      );
    } else {
      matchingApiMachine = machineApiData?.find(
        (apiMachine) => apiMachine.machine_id.startsWith(machineIdText)
      );
      // Also try matching by custom name
      if (!matchingApiMachine) {
        const namedMachine = machineNames.find(
          (m) => m.customName.toLowerCase() === machineIdText.toLowerCase()
        );
        if (namedMachine) {
          matchingApiMachine = machineApiData?.find(
            (apiMachine) => apiMachine.machine_id.startsWith(namedMachine.machineId)
          );
        }
      }
    }

    if (!matchingApiMachine) {
      // Build placeholder tds matching headers
      const headerOrder = Array.from(theadRow.cells).map((h) => h.textContent.trim().toLowerCase());
      const placeholders = {};
      demandHeaders.forEach((text) => {
        const td = document.createElement('td');
        td.className = pc('c0131') + ' gpuDemandCell';
        td.innerHTML = `<div class="${pc('c0119')}"><div class="${pc('c0119')} ${pc('c0121')}">N/A</div></div>`;
        placeholders[text.toLowerCase()] = td;
      });

      headerOrder.forEach((hk) => {
        if (placeholders[hk]) row.appendChild(placeholders[hk]);
      });

      // fallback: if headers didn't match, append all placeholders
      Object.keys(placeholders).forEach((k) => {
        if (!headerOrder.includes(k)) row.appendChild(placeholders[k]);
      });

      return;
    }

    // Get GPU info - first try from machineNames entry, then from API data
    let gpuInfo = null;
    const machineEntry = machineNames.find((m) =>
      matchingApiMachine.machine_id.startsWith(m.machineId)
    );
    
    if (machineEntry && machineEntry.gpuName) {
      gpuInfo = gpuDemandData?.find((gpu) => gpu.name === machineEntry.gpuName);
    }
    
    // If no GPU info found from machineNames, try to get it from the API machine data
    if (!gpuInfo && matchingApiMachine.gpu_model) {
      gpuInfo = gpuDemandData?.find((gpu) => 
        gpu.name === matchingApiMachine.gpu_model ||
        gpu.displayName?.toLowerCase().includes(matchingApiMachine.gpu_model?.toLowerCase())
      );
    }

    // Build cells for demand row matching header order
    const tdsByKey = {};

    const currentTdDemand = document.createElement('td');
    currentTdDemand.className = pc('c0131') + ' gpuDemandCell currentEarningCell';
    currentTdDemand.innerHTML = `<div class="${pc('c0119')}"><div class="${pc('c0119')} ${pc('c0121')}">$0.000 / Hour</div></div>`;
    tdsByKey['current earning rate'] = currentTdDemand;

    const gpuDisplayName = gpuInfo?.displayName ? gpuInfo.displayName.replace(/^NVIDIA\s+/i, '') : 'N/A';
    const gpuNameTd = document.createElement('td');
    gpuNameTd.className = pc('c0131') + ' gpuDemandCell';
    gpuNameTd.innerHTML = `<div class="${pc('c0119')}"><div class="${pc('c0119')} ${pc('c0121')}">${gpuDisplayName}</div></div>`;
    tdsByKey['gpu name'] = gpuNameTd;

    const demandTd = document.createElement('td');
    demandTd.className = pc('c0131') + ' gpuDemandCell';
    const tier = gpuInfo?.demandTierName || 'N/A';
    const util = gpuInfo?.utilizationPct != null ? gpuInfo.utilizationPct + '%' : 'N/A';
    demandTd.innerHTML = `<div class="${pc('c0119')}"><div class="${pc('c0119')} ${pc('c0121')}" style="white-space: normal">${tier} / ${util}</div></div>`;
    tdsByKey['gpu demand (tier / util %)'] = demandTd;

    const avgEarningTd = document.createElement('td');
    avgEarningTd.className = pc('c0131') + ' gpuDemandCell';
    avgEarningTd.innerHTML = `<div class="${pc('c0119')}"><div class="${pc('c0119')} ${pc('c0121')}">${gpuInfo?.earningRates?.avgEarningRate!=null?`$${gpuInfo.earningRates.avgEarningRate.toFixed(3)}`:'N/A'}</div></div>`;
    tdsByKey['avg earning rate'] = avgEarningTd;

    const top25EarningTd = document.createElement('td');
    top25EarningTd.className = pc('c0131') + ' gpuDemandCell';
    top25EarningTd.innerHTML = `<div class="${pc('c0119')}"><div class="${pc('c0119')} ${pc('c0121')}">${gpuInfo?.earningRates?.top25PctEarningRate!=null?`$${gpuInfo.earningRates.top25PctEarningRate.toFixed(3)}`:'N/A'}</div></div>`;
    tdsByKey['top 25% earning rate'] = top25EarningTd;

    const headerOrder = Array.from(theadRow.cells).map(h => h.textContent.trim().toLowerCase());
    const currentIdx = headerOrder.findIndex(h => h.includes('current') && h.includes('earning'));

    let currentCellRef = currentTdDemand;

    if (currentIdx !== -1) {
      const existingCell = row.cells[currentIdx];
      if (existingCell) {
        existingCell.classList.add('currentEarningCell');
        existingCell.innerHTML = `<div class="${pc('c0119')}"><div class="${pc('c0119')} ${pc('c0121')}">$0.000 / Hour</div></div>`;
        currentCellRef = existingCell;
      } else {
        const insertBeforeCell = row.cells[currentIdx] || null;
        row.insertBefore(currentTdDemand, insertBeforeCell);
        currentCellRef = currentTdDemand;
      }

      // Remove placeholder key so we don't append duplicate current cells later
      delete tdsByKey['current earning rate'];

      headerOrder.forEach((hk) => {
        if (hk === 'current earning rate' || (hk.includes('current') && hk.includes('earning'))) return;
        if (tdsByKey[hk]) {
          row.appendChild(tdsByKey[hk]);
          delete tdsByKey[hk];
        }
      });

      Object.keys(tdsByKey).forEach((k) => row.appendChild(tdsByKey[k]));
    } else {
      const keysPlaced = new Set();
      headerOrder.forEach((hk) => {
        if (tdsByKey[hk]) {
          row.appendChild(tdsByKey[hk]);
          keysPlaced.add(hk);
        }
      });

      Object.keys(tdsByKey).forEach((k) => {
        if (!keysPlaced.has(k)) row.appendChild(tdsByKey[k]);
      });

      if (!row.querySelector('.currentEarningCell')) {
        row.insertBefore(currentTdDemand, row.firstChild);
        currentCellRef = currentTdDemand;
        // Remove placeholder so it won't be appended again
        delete tdsByKey['current earning rate'];
      }
    }

    // Start an async update of the current earning for this machine
    updateCurrentEarningForCell(matchingApiMachine.machine_id, currentCellRef);
  });
}

function addLegendBelowTable() {
  const container = qsel(".c0118");

  if (!container) return;

  if (!document.getElementById("demandDataLegend")) {
    const legend = document.createElement("div");
    legend.id = "demandDataLegend";
    legend.style.fontFamily =
      'Mallory, BlinkMacSystemFont, -apple-system, "Work Sans", "Segoe UI", "Fira Sans", "Helvetica Neue", Helvetica, Arial, sans-serif';
    legend.style.fontSize = "12px";
    legend.style.lineHeight = "16px";
    legend.style.paddingBottom = "0px";
    legend.style.fontWeight = "bold";
    legend.style.textAlign = "center";
    legend.style.color = "rgb(219, 241, 193)";
    legend.style.marginTop = "8px";
    legend.style.maxWidth = "100%";
    legend.style.overflowWrap = "break-word";
    legend.innerHTML = `
      <strong>Note:</strong> These columns - <em>GPU Demand Tier/Util %</em>, <em>Avg Earning Rate</em>, and <em>Top 25% Earning Rate</em> - show the chosen GPU's demand information.<br>
      They <strong>do not</strong> represent the exact earnings of your machine.
    `;



    container.appendChild(legend);
  }
}

function updateMachineElements() {
  if (!machineApiData && !machineNames.length) return;

  // Replace machine IDs with custom names in the list elements

  const machineIdSelector = ".css-15d7bl7.ei767vo0";

  document.querySelectorAll(machineIdSelector).forEach((el) => {
    const currentText = el.textContent.trim();

    // If we've previously tagged this element with the original machine id, check if it's still valid
    const taggedMachineId = el.getAttribute('data-machine-id');
    if (taggedMachineId) {
      const matchingByTag = machineNames.find(
        (m) => m.machineId.toLowerCase() === taggedMachineId.toLowerCase(),
      );
      
      // Check if the current text still corresponds to this tagged machine
      // If text is neither the machine ID nor the custom name, the element was reused for a different machine
      const isStillValid = matchingByTag && (
        currentText.toLowerCase() === taggedMachineId.toLowerCase() ||
        currentText === matchingByTag.customName
      );
      
      if (isStillValid) {
        if (matchingByTag && el.textContent !== matchingByTag.customName) {
          el.textContent = matchingByTag.customName;
          el.setAttribute('data-custom-name', 'true');
        }
        return; // we've handled this element
      } else {
        // Element was reused for a different machine (e.g., pagination)
        // Clear the stale attributes and re-process
        el.removeAttribute('data-machine-id');
        el.removeAttribute('data-custom-name');
      }
    }

    const matchingMachine = machineNames.find(
      (m) => m.machineId.toLowerCase() === currentText.toLowerCase(),
    );

    if (
      matchingMachine &&
      currentText.toLowerCase() === matchingMachine.machineId.toLowerCase()
    ) {
      el.textContent = matchingMachine.customName;
      // Tag the element so future updates can find it even if the text has changed
      el.setAttribute('data-custom-name', 'true');
      el.setAttribute('data-machine-id', matchingMachine.machineId);
    }
  });

  // Find the table

  const table = qsel("table.c0128");

  if (!table) return;

  // Remove all previously added earnings or demand headers/cells

  [
    ...table.querySelectorAll(
      ".earningsHeader, .earningsCell, .gpuDemandHeader, .gpuDemandCell",
    ),
  ].forEach((el) => el.remove());

  // Add new columns based on the current view

  if (viewMode === "earnings") {
    addEarningsColumnsToTable();
    addLegendBelowTable();
  } else if (viewMode === "demand") {
    addColumnsToExistingTable();
    addLegendBelowTable();
  }

  replaceMachineIdsInTextNodesSafe();

  // Apply sorting and update earnings
  enableTableSorting();
  // Update current earnings (async) before final sort — cached results may already be present
  updateCurrentEarnings();
  performSort();
}

function replaceMachineIdsInTextNodesSafe() {
  if (!machineNames.length) return;

  const machineMap = {};

  machineNames.forEach((m) => {
    machineMap[m.machineId.toLowerCase()] = m.customName;
  });

  const walker = document.createTreeWalker(
    document.body,

    NodeFilter.SHOW_TEXT,

    {
      acceptNode(node) {
        if (
          node.parentNode &&
          ["SCRIPT", "STYLE", "TEXTAREA", "INPUT"].includes(
            node.parentNode.nodeName,
          )
        ) {
          return NodeFilter.FILTER_REJECT;
        }

        const text = node.textContent.toLowerCase();

        for (const id in machineMap) {
          // Skip if already contains the custom name

          if (
            text.includes(id) &&
            !text.includes(machineMap[id].toLowerCase())
          ) {
            return NodeFilter.FILTER_ACCEPT;
          }
        }

        return NodeFilter.FILTER_REJECT;
      },
    },

    false,
  );

  let node;

  while ((node = walker.nextNode())) {
    let text = node.textContent;

    for (const id in machineMap) {
      const regex = new RegExp(`\\b${id}\\b`, "gi");

      text = text.replace(regex, machineMap[id]);
    }

    if (text !== node.textContent) {
      node.textContent = text;
    }
  }
}

// Escape a string for safe use in a regular expression
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replace old custom names (old->new map) across text nodes. Used when machineNames change and
// some nodes already contain the old custom name text.
function replaceCustomNamesInTextNodes(replacements) {
  if (!replacements || Object.keys(replacements).length === 0) return;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (
        node.parentNode &&
        ["SCRIPT", "STYLE", "TEXTAREA", "INPUT"].includes(
          node.parentNode.nodeName,
        )
      ) {
        return NodeFilter.FILTER_REJECT;
      }

      const text = node.textContent.toLowerCase();
      for (const oldName of Object.keys(replacements)) {
        if (text.includes(oldName.toLowerCase())) return NodeFilter.FILTER_ACCEPT;
      }
      return NodeFilter.FILTER_REJECT;
    }
  }, false);

  let node;
  while ((node = walker.nextNode())) {
    let text = node.textContent;
    for (const oldName in replacements) {
      const escaped = escapeRegExp(oldName);
      const regex = new RegExp(escaped, 'gi');
      text = text.replace(regex, replacements[oldName]);
    }
    if (text !== node.textContent) node.textContent = text;
  }
}

// Table sorting and Active-only filter helpers
function enableTableSorting() {
  const table = qsel('table.c0128');
  if (!table) return;
  const theadRow = table.querySelector('thead tr');
  if (!theadRow) return;

  Array.from(theadRow.cells).forEach((th, index) => {
    const text = th.textContent.trim();
    const key = text;
    const sortableNames = [
      'Machine ID',
      'GPU Name',
      'GPU Demand',
      'Last Seen',
      'Current Earning Rate',
      'Last 24h',
      'Last 7d',
      'Last 30d',
      'Lifetime',
      'Avg Earning Rate',
      'Top 25% Earning Rate',
    ];
    const isSortable = sortableNames.some((name) => text.startsWith(name));

    const innerDiv = th.querySelector(pc('.c0120')) || th;

    if (isSortable) {
      th.classList.add('sortable');
      th.setAttribute('data-sort-key', key);
      // ensure inner div layout supports inline icon
      try {
        innerDiv.style.display = 'inline-flex';
        innerDiv.style.alignItems = 'center';
        innerDiv.style.gap = '6px';
      } catch (e) {}

      // add or reuse indicator span
      let indicator = innerDiv.querySelector('.sort-indicator');
      if (!indicator) {
        indicator = document.createElement('span');
        indicator.className = 'sort-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        // insert after the main label span when possible so it appears next to the title
        const labelEl = innerDiv.querySelector('span') || innerDiv.firstChild;
        if (labelEl && labelEl.parentNode) {
          labelEl.insertAdjacentElement('afterend', indicator);
        } else {
          innerDiv.appendChild(indicator);
        }
      }

      indicator.textContent = currentSort.column === key ? (currentSort.direction === 'asc' ? '▲' : '▼') : '';
      th.setAttribute('aria-sort', currentSort.column === key ? (currentSort.direction === 'asc' ? 'ascending' : 'descending') : 'none');

      th.onclick = () => {
        if (currentSort.column === key) {
          currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
        } else {
          currentSort.column = key;
          currentSort.direction = 'asc';
        }
        updateSortIndicators();
        performSort();
      };
    } else {
      th.classList.remove('sortable');
      th.removeAttribute('data-sort-key');
      const existingIndicator = innerDiv.querySelector('.sort-indicator');
      if (existingIndicator) existingIndicator.remove();
      th.onclick = null;
      th.classList.remove('sort-asc', 'sort-desc');
      th.removeAttribute('aria-sort');
    }
  });

  updateSortIndicators();
}

function performSort() {
  const table = qsel('table.c0128');
  if (!table || !currentSort.column) return;
  const theadRow = table.querySelector('thead tr');
  const tbody = table.querySelector('tbody');
  const rows = Array.from(tbody.querySelectorAll('tr'));
  const headerIndex = Array.from(theadRow.cells).findIndex((h) =>
    (h.getAttribute('data-sort-key') || '').trim() === currentSort.column,
  );
  if (headerIndex === -1) return;

  const headerKey = (theadRow.cells[headerIndex].getAttribute('data-sort-key') || '').trim();

  const visibleRows = rows.filter((r) => r.style.display !== 'none');

  const getCellValue = (row) => {
    const cell = row.cells[headerIndex];
    if (!cell) return '';
    const text = cell.textContent.trim();

    // Special parsing for Last Seen column: convert to minutes since last seen (lower = more recent)
    if (headerKey.toLowerCase().startsWith('last seen')) {
      const t = text.toLowerCase();
      if (!t || t === 'n/a') return Number.MAX_SAFE_INTEGER;
      if (t.includes('just now') || t.includes('online') || t.includes('now')) return 0;
      const dayMatch = t.match(/(\d+)\s*day/);
      if (dayMatch) return parseInt(dayMatch[1], 10) * 24 * 60;
      const hourMatch = t.match(/(\d+)\s*hour/);
      if (hourMatch) return parseInt(hourMatch[1], 10) * 60;
      const minMatch = t.match(/(\d+)\s*min/);
      if (minMatch) return parseInt(minMatch[1], 10);
      const numberMatch = t.match(/(\d+)/);
      if (numberMatch) return parseInt(numberMatch[1], 10) * 24 * 60;
      return Number.MAX_SAFE_INTEGER;
    }

    // GPU Demand parsing: use utilization percentage if present (N/A -> -1)
    if (headerKey.toLowerCase().includes('gpu demand')) {
      const utilMatch = text.match(/([0-9]+\.?[0-9]*)%/);
      if (utilMatch) return parseFloat(utilMatch[1]) || 0;
      return -1;
    }

    // Try to extract numeric value (dollar/percent/plain numbers)
    const currencyMatch = text.match(/\$\s*([0-9,]+\.?[0-9]*)/);
    if (currencyMatch) return parseFloat(currencyMatch[1].replace(/,/g, '')) || 0;

    const percentMatch = text.match(/([0-9]+\.?[0-9]*)%/);
    if (percentMatch) return parseFloat(percentMatch[1]) || 0;

    const numMatch = text.match(/([+-]?[0-9,]+\.?[0-9]*)/);
    if (numMatch && numMatch[1]) return parseFloat(numMatch[1].replace(/,/g, '')) || 0;

    return text.toLowerCase();
  };

  visibleRows.sort((a, b) => {
    const av = getCellValue(a);
    const bv = getCellValue(b);

    if (typeof av === 'number' && typeof bv === 'number') {
      return currentSort.direction === 'asc' ? av - bv : bv - av;
    }

    if (av < bv) return currentSort.direction === 'asc' ? -1 : 1;
    if (av > bv) return currentSort.direction === 'asc' ? 1 : -1;
    return 0;
  });

  // Re-append visible rows in sorted order (hidden rows remain in place)
  visibleRows.forEach((row) => tbody.appendChild(row));
}

// Fetch the 5-minute earning for a machine and convert to hourly (×12). Uses cache.
async function fetchCurrentEarningPerHour(machineFullId) {
  try {
    const now = Date.now();
    const cached = currentEarningCache[machineFullId];
    if (cached && now - cached.ts < CURRENT_EARNING_TTL_MS) {
      return cached.value;
    }

    const res = await fetch(
      `https://app-api.salad.com/api/v2/machines/${machineFullId}/earnings/5-minutes`,
      { credentials: 'include' },
    );

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Try to find a numeric value in the response
    let fiveMinVal = null;
    if (typeof data === 'number') fiveMinVal = data;
    else if (data && typeof data.amount === 'number') fiveMinVal = data.amount;
    else if (data && typeof data.value === 'number') fiveMinVal = data.value;
    else if (data && typeof data.earning === 'number') fiveMinVal = data.earning;
    else if (data && data.earnings && typeof data.earnings === 'number') fiveMinVal = data.earnings;
    else if (Array.isArray(data) && data.length && typeof data[0] === 'number') fiveMinVal = data[0];
    else if (data && typeof data === 'object') {
      // pick the first numeric prop
      for (const k in data) {
        if (typeof data[k] === 'number') {
          fiveMinVal = data[k];
          break;
        }
      }
    }

    if (fiveMinVal == null) {
      // fallback to 0
      fiveMinVal = 0;
    }

    // multiply by 12 to get per-hour
    const perHour = fiveMinVal * 12;

    currentEarningCache[machineFullId] = { value: perHour, ts: Date.now() };

    return perHour;
  } catch (err) {
    console.warn('Failed to fetch 5-minute earnings for', machineFullId, err);
    currentEarningCache[machineFullId] = { value: 0, ts: Date.now() };
    return 0;
  }
}

// Update a single cell for a machine's current earning rate
async function updateCurrentEarningForCell(machineFullId, cell) {
  if (!machineFullId || !cell) return;

  // show loading state
  try {
    cell.querySelector(pc('.c0119.c0121')).textContent = 'Loading...';
  } catch (e) {}

  const value = await fetchCurrentEarningPerHour(machineFullId);

  const display = `$${value.toFixed(3)} / Hour`;
  try {
    cell.querySelector(pc('.c0119.c0121')).textContent = display;
  } catch (e) {
    cell.textContent = display;
  }

  // If sorting by current earning, reapply sort to keep order accurate
  if (currentSort.column && currentSort.column.toLowerCase().includes('current earning')) {
    try { performSort(); } catch (e) {}
  }
}

// Iterate visible rows and update current earnings (async)
function updateCurrentEarnings() {
  const table = qsel('table.c0128');
  if (!table) return;
  const tbody = table.querySelector('tbody');
  Array.from(tbody.querySelectorAll('tr')).forEach((row) => {
    const td = row.querySelector('td.currentEarningCell');
    if (!td) return;

    // try to find machine id from stored data-machine-id on name cell or matching text
    const machineIdCell = row.querySelector('.css-15d7bl7.ei767vo0') || row.cells[1];
    const tagged = machineIdCell && machineIdCell.getAttribute && machineIdCell.getAttribute('data-machine-id');

    if (tagged) {
      // tagged may be the short machineId; find the full machine id in machineApiData
      const matched = machineApiData?.find((m) => m.machine_id.startsWith(tagged) || m.machine_id.includes(tagged));
      if (matched) {
        updateCurrentEarningForCell(matched.machine_id, td);
      }
      return;
    }

    // Fallback: attempt to match via visible machine name text against API data
    const nameText = machineIdCell ? machineIdCell.textContent.trim() : '';
    if (nameText) {
      const matched = machineApiData?.find((m) => m.machine_id.startsWith(nameText) || nameText.startsWith(m.machine_id.substring(0, 8)));
      if (matched) {
        updateCurrentEarningForCell(matched.machine_id, td);
      }
    }
  });
}

function updateSortIndicators() {
  const table = qsel('table.c0128');
  if (!table) return;
  const theadRow = table.querySelector('thead tr');
  Array.from(theadRow.cells).forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    const key = th.getAttribute('data-sort-key');
    const innerDiv = th.querySelector(pc('.c0120')) || th;
    const indicator = innerDiv.querySelector('.sort-indicator');
    if (currentSort.column && key === currentSort.column) {
      th.classList.add(currentSort.direction === 'asc' ? 'sort-asc' : 'sort-desc');
      if (indicator) indicator.textContent = currentSort.direction === 'asc' ? '▲' : '▼';
      th.setAttribute('aria-sort', currentSort.direction === 'asc' ? 'ascending' : 'descending');
    } else {
      if (indicator) indicator.textContent = '';
      th.setAttribute('aria-sort','none');
    }
  });
}



async function init() {
  // Only run extension functionality on the summary page

  if (!isOnSummaryPage()) {
    return;
  }

  // Re-detect class variant on each init (may differ between direct load and SPA navigation)
  _classOffset = null;

  injectTableStylesAndResize();

  // Set up observer to maintain buttons

  if (!toggleButtonObserver) {
    toggleButtonObserver = new MutationObserver(() => {
      if (
        !document.getElementById("viewToggleContainer") &&
        isOnSummaryPage()
      ) {
        addViewToggleButton();
      }
      if (!document.getElementById("copyChartButton") && isOnSummaryPage()) {
        addCopyChartButton();
      }
    });

    // Observe body (safe if document.body isn't ready yet)
    function startToggleObserver() {
      const target = document.body;
      if (target) {
        toggleButtonObserver.observe(target, { childList: true, subtree: true });
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          const t = document.body || document.documentElement;
          toggleButtonObserver.observe(t, { childList: true, subtree: true });
        }, { once: true });
      }
    }
    startToggleObserver();
  }

  await fetchGpuDemandData();

  // Read machine names from local storage, falling back to sync storage for compatibility
  async function loadStoredMachineNames() {
    try {
      const res = await storageGet(['machineNames']);
      let names = res.machineNames || [];

      // If no names found in local, try sync (older versions used chrome.storage.sync)
      if ((!names || names.length === 0) && browser.storage && browser.storage.sync) {
        try {
          const syncRes = await new Promise((resolve) => {
            try {
              // chrome-style callback
              browser.storage.sync.get(['machineNames'], (r) => resolve(r));
            } catch (e) {
              // promise-style
              browser.storage.sync.get(['machineNames']).then(resolve).catch(() => resolve({}));
            }
          });
          names = syncRes.machineNames || [];
        } catch (e) {
          // ignore
        }
      }

      machineNames = names || [];
    } catch (err) {
      console.error('Error reading machineNames from storage (local+sync):', err);
      machineNames = [];
    }
  }

  await loadStoredMachineNames();

  await fetchMachineApiData();
  await fetchMachineEarningsHistory();
  addViewToggleButton();
  addCopyChartButton();
  updateMachineElements();

  // Staggered initial updates
  [500, 1500, 3000, 5000, 7500].forEach((delay) => {
    setTimeout(() => {
      updateMachineElements();
      if (delay === 7500 && !_periodicTimersStarted) {
        _periodicTimersStarted = true;
        setInterval(updateMachineElements, 2000);
        setTimeout(() => { updateCurrentEarnings(); setInterval(updateCurrentEarnings, 60 * 1000); }, 3000);
      }
    }, delay);
  });
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'updateMachineNames' || message.machineNames) {
    const newNames = message.machineNames || [];

    // Compute mapping of old customName -> new customName for items that changed
    const oldMap = new Map((machineNames || []).map(m => [m.machineId, m.customName]));
    const replacements = {};
    (newNames || []).forEach(m => {
      const oldName = oldMap.get(m.machineId);
      if (oldName && oldName !== m.customName) replacements[oldName] = m.customName;
    });

    if (Object.keys(replacements).length > 0) {
      replaceCustomNamesInTextNodes(replacements);
    }

    machineNames = newNames;
    // Debounced so storage.onChanged firing simultaneously doesn't cause a double fetch
    scheduleMachineUpdate();
    flashPageUpdateNotice();
  } else if (message.action === "getEarningsData") {
    const timeframe = message.timeframe || "30d";

    Promise.all(
      (machineApiData || []).map(async (machine) => {
        try {
          const res = await fetch(
            `https://app-api.salad.com/api/v2/machines/${machine.machine_id}/earning-history?timeframe=${timeframe}`,
            {
              credentials: "include",
            },
          );

          if (!res.ok) throw new Error(`HTTP ${res.status}`);

          const data = await res.json();

          if (data && data.earnings) {
            return { machineId: machine.machine_id, earnings: data.earnings };
          }
        } catch (err) {
          console.error(
            `Failed to fetch earnings for machine ${machine.machine_id}:`,
            err,
          );

          return { machineId: machine.machine_id, earnings: {} };
        }
      }),
    ).then((results) => {
      // Build the response data

      const responseData = {};

      machineNames.forEach((machine) => {
        const matchingApiMachine = machineApiData?.find(
          (apiMachine) =>
            apiMachine.machine_id.startsWith(machine.machineId) ||
            machine.machineId.startsWith(apiMachine.machine_id.substring(0, 8)),
        );

        if (matchingApiMachine) {
          const historyResult = results.find(
            (r) => r.machineId === matchingApiMachine.machine_id,
          );
          const history = historyResult?.earnings || {};
          const lifetime =
            lifetimeEarningsCache[matchingApiMachine.machine_id] || 0;
          responseData[machine.machineId] = {
            customName: machine.customName,
            detailedHistory: history,
            lifetimeEarnings: lifetime,
          };
        }
      });

      sendResponse({ earningsData: responseData });
    });

    // Return true to indicate we'll send response asynchronously
    return true;
  }
});

storageGet('showReleaseNotes').then((data) => {
  if (data && data.showReleaseNotes) {
    const banner = document.createElement("div");

    banner.textContent =
      "Salad Machine Renamer Extension updated! Check the release notes in the Extension.";
    banner.style.position = "fixed";
    banner.style.top = "0";
    banner.style.left = "0";
    banner.style.right = "0";
    banner.style.backgroundColor = "rgb(219, 241, 193)";
    banner.style.color = "#0A2133";
    banner.style.fontWeight = "700";
    banner.style.fontFamily =
      'Mallory, BlinkMacSystemFont, -apple-system, "Work Sans", "Segoe UI", "Fira Sans", "Helvetica Neue", Helvetica, Arial, sans-serif';
    banner.style.textAlign = "center";
    banner.style.padding = "10px";
    banner.style.zIndex = "9999";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "x";
    closeBtn.style.marginLeft = "10px";
    closeBtn.style.background = "none";
    closeBtn.style.border = "none";
    closeBtn.style.fontSize = "20px";
    closeBtn.style.cursor = "pointer";
    closeBtn.style.color = "#0A2133";
    closeBtn.style.fontWeight = "700";
    closeBtn.onclick = () => banner.remove();
    // Buy Me a Coffee support link
    const supportLink = document.createElement('a');
    supportLink.href = 'https://buymeacoffee.com/pixelsizedtech';
    supportLink.target = '_blank';
    supportLink.rel = 'noopener noreferrer';
    supportLink.textContent = 'Buy Me a Coffee';
    supportLink.style.marginLeft = '10px';
    supportLink.style.background = 'none';
    supportLink.style.border = 'none';
    supportLink.style.color = '#0A2133';
    supportLink.style.fontWeight = '700';
    supportLink.style.cursor = 'pointer';
    supportLink.style.textDecoration = 'underline';

    banner.appendChild(supportLink);
    banner.appendChild(closeBtn);
    document.body.appendChild(banner);
    storageSet({ showReleaseNotes: false }).catch(err => console.error('Failed to set showReleaseNotes:', err));
  }
}).catch(err => {
  console.error('Failed to read showReleaseNotes from storage:', err);
});
// Notify user briefly that the page was updated
function flashPageUpdateNotice() {
  try {
    const id = 'machineNamesUpdateNotice';
    const existing = document.getElementById(id);
    if (existing) existing.remove();

    const notice = document.createElement('div');
    notice.id = id;
    notice.textContent = 'Machine names updated';
    Object.assign(notice.style, {
      position: 'fixed',
      top: '12px',
      right: '12px',
      background: '#DBF1C1',
      color: '#0A2133',
      padding: '8px 12px',
      borderRadius: '6px',
      zIndex: 10001,
      fontWeight: '700',
      fontFamily: 'Mallory, sans-serif',
      boxShadow: '0 6px 18px rgba(0,0,0,0.2)'
    });
    document.body.appendChild(notice);
    setTimeout(() => {
      notice.style.transition = 'opacity 0.3s ease';
      notice.style.opacity = '0';
      setTimeout(() => notice.remove(), 400);
    }, 1400);
  } catch (e) {
    // ignore
  }
}
// Update when `machineNames` changes in storage (e.g., popup save)
if (browser && browser.storage && browser.storage.onChanged) {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' && area !== 'sync') return;
    if (changes.machineNames) {
      const oldVal = changes.machineNames.oldValue || [];
      const newVal = changes.machineNames.newValue || [];

      // Build map of old customName -> new customName for machines where the name changed
      const oldMap = new Map((oldVal || []).map(m => [m.machineId, m.customName]));
      const replacements = {};
      (newVal || []).forEach(m => {
        const oldName = oldMap.get(m.machineId);
        if (oldName && oldName !== m.customName) {
          replacements[oldName] = m.customName;
        }
      });

      // Apply text-node replacements for any changed custom names
      if (Object.keys(replacements).length > 0) {
        replaceCustomNamesInTextNodes(replacements);
      }

      machineNames = newVal || [];
      // Debounced so onMessage firing simultaneously doesn't cause a double fetch
      scheduleMachineUpdate();
    }
  });
}

// SPA navigation detection: React Router changes URL without a full page reload.
let _lastSPAPath = window.location.pathname;

function waitForEarnTableThenInit() {
  // Wait for Salad's machine table to appear in the DOM before running init().
  // We look for any <table> since earn/summary has exactly one.
  if (document.querySelector('table')) {
    init();
    return;
  }
  const obs = new MutationObserver(() => {
    if (document.querySelector('table')) {
      obs.disconnect();
      init();
    }
  });
  obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
  // Fallback after 5s in case the table never appears
  setTimeout(() => { obs.disconnect(); init(); }, 5000);
}

function handleSPANavigation() {
  const currentPath = window.location.pathname;
  if (currentPath === _lastSPAPath) return;
  _lastSPAPath = currentPath;
  if (isOnSummaryPage()) {
    _classOffset = null; // force re-detect after React renders new content
    waitForEarnTableThenInit();
  }
}

// pushState patching does NOT work from a content script isolated world — React Router
// runs in the page world and its pushState calls are invisible to us. Instead, we watch
// the DOM for mutations (which happen during every React Router render) and check if the
// URL changed to earn/summary on each mutation. document.documentElement is shared.
const _spaNavObserver = new MutationObserver(handleSPANavigation);
_spaNavObserver.observe(document.documentElement, { childList: true, subtree: true });

// Handle page navigation (direct loads and refreshes)
if (document.readyState === "complete") init();
else document.addEventListener("DOMContentLoaded", init);

// Cleanup when leaving page
window.addEventListener("beforeunload", () => {
  if (toggleButtonObserver) toggleButtonObserver.disconnect();
  _spaNavObserver.disconnect();
});
