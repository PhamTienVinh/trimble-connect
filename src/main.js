/**
 * main.js - Trimble Connect Extension Entry Point
 * Connects to TC Workspace API with event callback for model state changes.
 */

let api = null;
let viewer = null;
let isConnected = false;

// Event listeners registered by other modules
const eventListeners = {};

// ========================
// TC Workspace API Connection
// ========================

async function connectToTrimbleConnect() {
  try {
    const { WorkspaceAPI } = await import("trimble-connect-workspace-api");

    // The event callback is passed as the second argument to connect()
    // This is the ONLY way to receive events from TC — there is no api.on() method
    api = await WorkspaceAPI.connect(window.parent, (event, data) => {
      console.log(`📢 TC Event: ${event}`, data);

      // Dispatch to registered listeners
      if (eventListeners[event]) {
        eventListeners[event].forEach((callback) => {
          try {
            callback(event, data);
          } catch (e) {
            console.error(`Error in event handler for ${event}:`, e);
          }
        });
      }
    }, 10000);

    viewer = api.viewer;
    isConnected = true;
    updateConnectionStatus(true);

    // Request access token permission
    try {
      await api.extension.requestPermission("accesstoken");
      console.log("✅ Access token permission granted");
    } catch (e) {
      console.warn("⚠️ Token request:", e.message);
    }

    console.log("✅ Connected to Trimble Connect Workspace API");
    return { api, viewer };
  } catch (error) {
    console.warn("⚠️ Not inside Trimble Connect iframe:", error.message);
    updateConnectionStatus(false, true);
    return { api: null, viewer: null };
  }
}

function updateConnectionStatus(connected, standalone = false) {
  const statusDot = document.querySelector(".status-dot");
  const statusText = document.querySelector(".status-text");
  if (!statusDot || !statusText) return;

  if (connected) {
    statusDot.classList.add("connected");
    statusText.textContent = "Connected";
  } else if (standalone) {
    statusDot.style.background = "var(--warning)";
    statusDot.style.boxShadow = "0 0 6px rgba(245,166,35,0.5)";
    statusText.textContent = "Standalone";
  }
}

// ========================
// Event System
// ========================

export function onEvent(eventId, callback) {
  if (!eventListeners[eventId]) {
    eventListeners[eventId] = [];
  }
  eventListeners[eventId].push(callback);
}

// ========================
// Tab Navigation
// ========================

function setupTabs() {
  const tabs = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".tab-content");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(target === "search" ? "panelSearch" : "panelStats").classList.add("active");
    });
  });
}

// ========================
// Filter Chips
// ========================

function setupFilterChips() {
  document.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const checkbox = chip.querySelector("input[type='checkbox']");
      checkbox.checked = !checkbox.checked;
      chip.classList.toggle("active", checkbox.checked);
      const event = new Event("input", { bubbles: true });
      document.getElementById("searchInput").dispatchEvent(event);
    });
    chip.querySelector("input").addEventListener("click", (e) => e.stopPropagation());
  });
}

// ========================
// Toast Notification
// ========================

export function showToast(message, type = "info") {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));

  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ========================
// Exports
// ========================

export function getAPI() { return api; }
export function getViewer() { return viewer; }
export function getIsConnected() { return isConnected; }

// ========================
// Application Init
// ========================

async function init() {
  setupTabs();
  setupFilterChips();

  await connectToTrimbleConnect();

  const { initObjectExplorer } = await import("./objectExplorer.js");
  const { initSteelStatistics } = await import("./steelStatistics.js");

  initObjectExplorer();
  initSteelStatistics();

  console.log("🚀 TC Object Explorer initialized");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
