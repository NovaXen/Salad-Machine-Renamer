document.addEventListener('DOMContentLoaded', function() {
  const machineList = document.getElementById('machineList');
  const addMachineButton = document.getElementById('addMachine');
  const autoDetectButton = document.getElementById('autoDetectButton');
  const saveButton = document.getElementById('saveButton');
  const statusDiv = document.getElementById('status');
  const helpButton = document.getElementById('helpButton');
  const supportButton = document.getElementById('supportButton');

  // Release notes elements
  const releaseNotesDiv = document.getElementById('releaseNotes');
  const releaseNotesList = document.getElementById('releaseNotesList');
  const closeReleaseNotes = document.getElementById('closeReleaseNotes');

  let gpuData = [];

  // Disable save until machines loaded
  saveButton.disabled = true;

  // ---- Release Notes Setup ----
  const RELEASE_NOTES = {
    "1.4.5": [
      "Fixed Last 24h / Last 7d / Last 30d earnings columns showing incorrect values",
      "Fixed extension init running twice on page load, causing duplicate API calls and accumulating background timers",
      "Fixed auto-detect treating all saved machines as new every time the popup opened",
      "Fixed aggregate CSV export crashing when machine data hadn't loaded yet",
      "Fixed custom machine names containing [ or ] breaking name replacement",
      "Fixed a race condition where saving from the popup triggered two simultaneous API fetches",
      "Fixed release notes re-appearing if the popup was closed before the version was saved",
      "Added GPU Demand & Earnings button linking to salad-tools.novatech.gg"
    ],
    "1.4.4": [
      "Fixed Salad's broken current earning rate to now show correctly",
      "Columns are now sortable by clicking the column title (toggle low/high)"
    ],
    "1.4.3": [
      "Fixed machine dashboard showing duplicate machines on 2nd page",
    ],
    "1.4.2": [
      "Fixed multiple bugs causes names to switch machine ids",
      "Removed copy chart from firefox",
      "Removed needing browser histroy (Didn't realise tabs permisson caused that so its now only activetabs)"
    ],
    "1.4.0": [
      "Added Earnings download to CSV",
      "Auto-detection for machine IDs",
      "Copy chart to image (Copy Chart)",
      "Fixed various bugs and improved stability",
      "Added firefox support"
    ],
    "1.3.0": [
      "Reworked detection of machine IDs",
      "Added GPU demand to the machine table",
      "Added Get Help / Report Bug button linking to Discord Server",
      "Fixed bugs (Looping name change)",
      "Added historic earnings & lifetime earnings to machines table"
    ]
  };

  // Get extension version - use browser.runtime.getManifest() for cross-browser compatibility
  function getExtensionVersion() {
    try {
      const manifest = browser.runtime.getManifest();
      return manifest.version;
    } catch (err) {
      console.error('Error getting extension version:', err);
      return '1.0.0';
    }
  }

  const currentVersion = getExtensionVersion();
  
  storageGet(['lastSeenVersion']).then(result => {
    if (result.lastSeenVersion !== currentVersion) {
      storageSet({ lastSeenVersion: currentVersion }).catch(err => console.error('Failed to set lastSeenVersion:', err));
      if (RELEASE_NOTES[currentVersion]) {
        releaseNotesList.innerHTML = '';
        RELEASE_NOTES[currentVersion].forEach(note => {
          const li = document.createElement('li');
          li.textContent = note;
          releaseNotesList.appendChild(li);
        });
        releaseNotesDiv.style.display = 'block';
      }
    }
  }).catch(err => {
    console.error('Failed to read lastSeenVersion from storage:', err);
  });

  closeReleaseNotes.addEventListener('click', () => {
    releaseNotesDiv.style.display = 'none';
  });
  // ---- End Release Notes Setup ----

  // Fetch GPU demand data once on popup load
  fetch('https://app-api.salad.com/api/v2/demand-monitor/gpu')
    .then(res => res.json())
    .then(data => {
      gpuData = data;
      loadMachines().then(() => performAutoDetect());
    })
    .catch(err => {
      console.error('Failed to fetch GPU demand data:', err);
      loadMachines().then(() => performAutoDetect());
    });

  function loadMachines() {
    return storageGet(['machineNames']).then(function(result) {
      const savedMachines = result.machineNames || [];
      machineList.innerHTML = '';

      if (savedMachines.length === 0) {
        addMachineEntry();
      } else {
        savedMachines.forEach(({ machineId, customName, gpuName }) => {
          addMachineEntry(machineId, customName, gpuName);
        });
      }
      saveButton.disabled = false;
    }).catch(err => {
      console.error('Failed to read machineNames from storage:', err);
      addMachineEntry();
      saveButton.disabled = false;
    });
  }

  function addMachineEntry(machineId = '', customName = '', gpuName = '') {
    const entry = document.createElement('div');
    entry.className = 'machine-entry';

    const machineIdInput = document.createElement('input');
    machineIdInput.type = 'text';
    machineIdInput.className = 'machineId';
    machineIdInput.placeholder = 'Machine ID';
    machineIdInput.value = machineId;
    machineIdInput.title = machineId;  // Show full ID on hover

    const customNameInput = document.createElement('input');
    customNameInput.type = 'text';
    customNameInput.className = 'customName';
    customNameInput.placeholder = 'Custom Name';
    customNameInput.value = customName;

    const gpuSelect = document.createElement('select');
    gpuSelect.className = 'gpuSelect';

    const loadingOption = document.createElement('option');
    loadingOption.value = '';
    loadingOption.textContent = 'Loading GPUs...';
    gpuSelect.appendChild(loadingOption);

    if (gpuData.length > 0) {
      gpuSelect.innerHTML = '<option value="">Select GPU</option>';
      gpuData.forEach(({ name, displayName }) => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = displayName;
        if (name === gpuName) option.selected = true;
        gpuSelect.appendChild(option);
      });
    }

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'removeMachine';
    removeBtn.title = 'Remove this machine';
    removeBtn.textContent = '-';

    entry.appendChild(machineIdInput);
    entry.appendChild(customNameInput);
    entry.appendChild(gpuSelect);
    entry.appendChild(removeBtn);

    machineList.appendChild(entry);

    [machineIdInput, customNameInput, gpuSelect].forEach(el =>
      el.addEventListener('input', () => {
        statusDiv.textContent = '';
      })
    );
  }

  machineList.addEventListener('click', function(e) {
    if (e.target.classList.contains('removeMachine')) {
      if (machineList.children.length > 1) {
        e.target.parentElement.remove();
        statusDiv.textContent = '';
      } else {
        alert('You must have at least one machine entry.');
      }
    }
  });

  addMachineButton.addEventListener('click', () => addMachineEntry());

  async function performAutoDetect() {
    statusDiv.style.color = 'blue';
    statusDiv.textContent = 'Auto-detecting machines...';
    autoDetectButton.disabled = true;

    try {
      const response = await fetch('https://app-api.salad.com/api/v2/machines', {
        credentials: 'include'
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const machines = data.items || data;

      if (!Array.isArray(machines) || machines.length === 0) {
        statusDiv.style.color = 'orange';
        statusDiv.textContent = 'No machines found. Please add them manually.';
        autoDetectButton.disabled = false;
        return;
      }

      // Filter machines to only those updated within the last 31 days
      const now = new Date();
      const thirtyOneDaysAgo = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
      
      const recentMachines = machines.filter(machine => {
        if (!machine.update_time) return false;
        const updateTime = new Date(machine.update_time);
        return updateTime >= thirtyOneDaysAgo;
      });

      if (recentMachines.length === 0) {
        statusDiv.style.color = 'orange';
        statusDiv.textContent = 'No machines found updated in the last 31 days.';
        autoDetectButton.disabled = false;
        return;
      }

      // Get existing custom names and selected GPUs from current entries, preserving order
      const existingMachines = new Map();
      const existingOrder = [];
      machineList.querySelectorAll('.machine-entry').forEach(entry => {
        const machineId = entry.querySelector('.machineId').value.trim();
        const customName = entry.querySelector('.customName').value.trim();
        const gpuName = entry.querySelector('.gpuSelect')?.value || '';
        if (machineId) {
          // Store both customName and gpuName (may be empty strings)
          existingMachines.set(machineId, { customName, gpuName });
          existingOrder.push(machineId);
        }
      });

      // Build a set of detected machine IDs for quick lookup
      const detectedMachineIds = new Set();
      recentMachines.forEach(machine => {
        const machineId = machine.machine_id || machine.id;
        const shortMachineId = machineId.split('-')[0];
        detectedMachineIds.add(shortMachineId);
      });

      // Clear existing entries
      machineList.innerHTML = '';

      // First, add ALL existing machines in their original saved order (preserve manually added ones even if inactive 30+ days)
      existingOrder.forEach(machineId => {
        const existing = existingMachines.get(machineId);
        addMachineEntry(machineId, existing.customName, existing.gpuName);
      });

      // Then, add any newly detected machines that weren't in the saved list
      let newMachineCount = 0;
      recentMachines.forEach(machine => {
        const machineId = machine.machine_id || machine.id;
        // Extract only the first part before the dash
        const shortMachineId = machineId.split('-')[0];

        // Only add if it's not already in the existing order (i.e., it's new)
        if (!existingMachines.has(shortMachineId)) {
          newMachineCount++;
          addMachineEntry(shortMachineId, '', '');
        }
      });

      statusDiv.style.color = 'green';
      const message = newMachineCount === 0 
        ? `All ${recentMachines.length} machines already configured.`
        : `Found ${newMachineCount} new active machine(s)! Don't forget to save.`;
      statusDiv.textContent = message;
      
      setTimeout(() => {
        statusDiv.textContent = '';
      }, 3000);
    } catch (err) {
      console.error('Auto-detect error:', err);
      statusDiv.style.color = 'red';
      statusDiv.textContent = 'Failed to auto-detect machines. Please check your connection.';
    } finally {
      autoDetectButton.disabled = false;
    }
  }

  autoDetectButton.addEventListener('click', performAutoDetect);

  saveButton.addEventListener('click', async function() {
    const machineEntries = machineList.querySelectorAll('.machine-entry');
    const machineNames = [];
    const seenIds = new Set();

    for (const entry of machineEntries) {
      const machineId = entry.querySelector('.machineId').value.trim();
      const customName = entry.querySelector('.customName').value.trim();
      const gpuName = entry.querySelector('.gpuSelect').value;

      if (!machineId || !customName) {
        statusDiv.style.color = 'red';
        statusDiv.textContent = 'Please fill out all Machine ID and Custom Name fields.';
        return;
      }

      if (seenIds.has(machineId)) {
        statusDiv.style.color = 'red';
        statusDiv.textContent = `Duplicate Machine ID found: ${machineId}`;
        return;
      }

      seenIds.add(machineId);
      machineNames.push({ machineId, customName, gpuName });
    }

    try {
      // Use local storage which is more reliable across browsers
      await storageSet({ machineNames });
      
      statusDiv.style.color = 'green';
      statusDiv.textContent = 'Machine names saved!';


      // Only update the active Salad tab
      try {
        const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (activeTab && activeTab.url && activeTab.url.includes('salad.com')) {
          await browser.tabs.sendMessage(activeTab.id, { action: 'updateMachineNames', machineNames });
          statusDiv.style.color = 'green';
          statusDiv.textContent = 'Machine names saved and pushed to the active Salad tab!';
        } else {
          statusDiv.style.color = 'orange';
          statusDiv.textContent = 'Machine names saved. No active Salad tab found.';
        }
      } catch (err) {
        console.warn('Could not send message to active tab:', err);
        statusDiv.style.color = 'orange';
        statusDiv.textContent = 'Machine names saved; could not notify the active tab.';
      }

      setTimeout(() => {
        statusDiv.textContent = '';
      }, 2500);
    } catch (err) {
      statusDiv.style.color = 'red';
      statusDiv.textContent = 'Error saving machine names.';
      console.error('Storage error:', err);
    }
  });

  // Help / Report Bug button click
  helpButton.addEventListener('click', function() {
    browser.tabs.create({ url: 'https://discord.gg/TyD5HsUkUZ' });
  });

  // Support / Buy Me a Coffee button click
  if (supportButton) {
    supportButton.addEventListener('click', function() {
      browser.tabs.create({ url: 'https://buymeacoffee.com/pixelsizedtech' });
    });
  }
});
