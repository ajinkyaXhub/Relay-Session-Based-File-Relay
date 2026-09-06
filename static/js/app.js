/**
 * Relay - File Transfer Client Application Logic
 * Handles drag-and-drop, progress tracking, live polling, and session lifecycle.
 */

document.addEventListener('DOMContentLoaded', () => {
  const config = window.__TRANSFER_CONFIG__ || {};
  const sessionId = config.sessionId;
  const csrfToken = config.csrfToken;
  let remainingSeconds = config.remainingSeconds || 1200;
  const requiresPin = config.requiresPin || false;

  // DOM Elements
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const uploadQueue = document.getElementById('uploadQueue');
  const filesContainer = document.getElementById('filesContainer');
  const emptyState = document.getElementById('emptyState');
  const downloadAllBtn = document.getElementById('downloadAllBtn');
  const fileCountBadge = document.getElementById('fileCountBadge');
  const expiryTimerDisplay = document.getElementById('expiryTimerDisplay');
  const expiryBox = document.getElementById('expiryBox');
  const extendBtn = document.getElementById('extendBtn');
  const endSessionBtn = document.getElementById('endSessionBtn');
  const copyLinkBtn = document.getElementById('copyLinkBtn');
  const sessionUrlInput = document.getElementById('sessionUrlInput');
  const toastContainer = document.getElementById('toastContainer');
  const qrModalBackdrop = document.getElementById('qrModalBackdrop');
  const qrThumbnail = document.getElementById('qrThumbnail');
  const closeQrModalBtn = document.getElementById('closeQrModalBtn');

  // Track known file IDs to prevent re-rendering when unchanged
  let knownFileIds = new Set();
  if (config.initialFiles) {
    config.initialFiles.forEach(f => knownFileIds.add(f.id));
  }

  // ---------------------------------------------------------------------------
  // Toast Notification System
  // ---------------------------------------------------------------------------
  function showToast(message, type = 'info', duration = 3500) {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let iconSvg = '';
    if (type === 'success') {
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else if (type === 'error') {
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;
    } else {
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#06b6d4" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
    }

    toast.innerHTML = `
      ${iconSvg}
      <span class="toast-message">${escapeHtml(message)}</span>
    `;

    toastContainer.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ---------------------------------------------------------------------------
  // Expiry Countdown Timer
  // ---------------------------------------------------------------------------
  let warnedExpiringSoon = false;

  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  function updateTimer() {
    if (remainingSeconds <= 0) {
      if (expiryTimerDisplay) expiryTimerDisplay.textContent = "00:00";
      showToast("This transfer session has expired.", "error");
      setTimeout(() => {
        window.location.reload();
      }, 1500);
      return;
    }

    remainingSeconds -= 1;
    if (expiryTimerDisplay) {
      expiryTimerDisplay.textContent = formatTime(remainingSeconds);
    }

    if (remainingSeconds <= 120) {
      if (expiryBox) expiryBox.classList.add('warning');
      if (!warnedExpiringSoon) {
        showToast("Session expires in less than 2 minutes!", "error");
        warnedExpiringSoon = true;
      }
    } else {
      if (expiryBox) expiryBox.classList.remove('warning');
      warnedExpiringSoon = false;
    }
  }

  if (expiryTimerDisplay) {
    expiryTimerDisplay.textContent = formatTime(remainingSeconds);
    setInterval(updateTimer, 1000);
  }

  // ---------------------------------------------------------------------------
  // Session Actions (Extend, End, Copy Link)
  // ---------------------------------------------------------------------------
  if (extendBtn) {
    extendBtn.addEventListener('click', async () => {
      try {
        extendBtn.disabled = true;
        const res = await fetch(`/s/${sessionId}/extend`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken
          }
        });
        const data = await res.json();
        if (data.success) {
          remainingSeconds = data.remaining_seconds;
          if (expiryTimerDisplay) expiryTimerDisplay.textContent = formatTime(remainingSeconds);
          if (expiryBox) expiryBox.classList.remove('warning');
          warnedExpiringSoon = false;
          showToast("Session extended by 5 minutes!", "success");
        } else {
          showToast(data.error || "Failed to extend session.", "error");
        }
      } catch (err) {
        showToast("Network error while extending session.", "error");
      } finally {
        extendBtn.disabled = false;
      }
    });
  }

  if (endSessionBtn) {
    endSessionBtn.addEventListener('click', async () => {
      if (!confirm("Are you sure you want to end this transfer session? All uploaded files will be permanently deleted.")) {
        return;
      }
      try {
        endSessionBtn.disabled = true;
        const res = await fetch(`/s/${sessionId}/end`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken
          }
        });
        showToast("Session ended. Redirecting...", "info");
        window.location.href = "/";
      } catch (err) {
        window.location.href = "/";
      }
    });
  }

  if (copyLinkBtn && sessionUrlInput) {
    copyLinkBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(sessionUrlInput.value);
        showToast("Transfer link copied to clipboard!", "success");
      } catch (err) {
        sessionUrlInput.select();
        document.execCommand('copy');
        showToast("Link copied!", "success");
      }
    });
  }

  // QR Code Modal View
  if (qrThumbnail && qrModalBackdrop) {
    qrThumbnail.addEventListener('click', () => {
      qrModalBackdrop.classList.add('active');
    });

    if (closeQrModalBtn) {
      closeQrModalBtn.addEventListener('click', () => {
        qrModalBackdrop.classList.remove('active');
      });
    }

    qrModalBackdrop.addEventListener('click', (e) => {
      if (e.target === qrModalBackdrop) {
        qrModalBackdrop.classList.remove('active');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Drag & Drop File Upload with Progress Tracking
  // ---------------------------------------------------------------------------
  if (dropzone && fileInput) {
    // Native <label for="fileInput"> triggers file input directly across all mobile & desktop browsers

    ['dragenter', 'dragover'].forEach(eventName => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach(eventName => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove('dragover');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      const files = dt.files;
      if (files && files.length > 0) {
        handleFiles(files);
      }
    });

    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length > 0) {
        handleFiles(fileInput.files);
        fileInput.value = ''; // Reset for re-selection
      }
    });
  }

  function handleFiles(files) {
    if (requiresPin) {
      showToast("Please authenticate with the session PIN first.", "error");
      return;
    }

    Array.from(files).forEach(file => {
      uploadSingleFile(file);
    });
  }

  function uploadSingleFile(file) {
    const queueCard = document.createElement('div');
    queueCard.className = 'queue-card';

    queueCard.innerHTML = `
      <div class="queue-card-header">
        <span class="queue-filename" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
        <span class="queue-status">0%</span>
      </div>
      <div class="progress-track">
        <div class="progress-bar"></div>
      </div>
    `;

    if (uploadQueue) uploadQueue.appendChild(queueCard);

    const progressBar = queueCard.querySelector('.progress-bar');
    const statusText = queueCard.querySelector('.queue-status');

    const formData = new FormData();
    formData.append('file', file);
    formData.append('csrf_token', csrfToken);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/s/${sessionId}/upload`, true);
    xhr.setRequestHeader('X-CSRF-Token', csrfToken);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        progressBar.style.width = `${percent}%`;
        statusText.textContent = `${percent}%`;
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const res = JSON.parse(xhr.responseText);
          progressBar.style.width = '100%';
          statusText.textContent = 'Uploaded ✓';
          statusText.style.color = 'var(--success-emerald)';
          showToast(`Uploaded: ${file.name}`, 'success');
          // Immediate polling trigger
          fetchSessionFiles();
        } catch (e) {
          statusText.textContent = 'Done ✓';
        }
      } else {
        let errMessage = 'Upload failed';
        try {
          const res = JSON.parse(xhr.responseText);
          if (res.error) errMessage = res.error;
        } catch (e) {}
        statusText.textContent = 'Failed ✗';
        statusText.style.color = 'var(--danger-red)';
        showToast(`${file.name}: ${errMessage}`, 'error');
      }

      setTimeout(() => {
        queueCard.style.opacity = '0';
        queueCard.style.transition = 'opacity 0.4s ease';
        setTimeout(() => queueCard.remove(), 400);
      }, 3500);
    };

    xhr.onerror = () => {
      statusText.textContent = 'Error ✗';
      statusText.style.color = 'var(--danger-red)';
      showToast(`Network error uploading ${file.name}`, 'error');
    };

    xhr.send(formData);
  }

  // ---------------------------------------------------------------------------
  // Real-time File List Polling
  // ---------------------------------------------------------------------------
  async function fetchSessionFiles() {
    try {
      const res = await fetch(`/s/${sessionId}/files`);
      if (res.status === 404 || res.status === 410) {
        // Session has expired or been terminated on server
        window.location.reload();
        return;
      }
      if (!res.ok) return;

      const data = await res.json();
      if (!data.files) return;

      // Update remaining seconds if drifted
      if (typeof data.remaining_seconds === 'number') {
        remainingSeconds = data.remaining_seconds;
      }

      // Check if file list has changed
      const currentIds = new Set(data.files.map(f => f.id));
      const hasChanged = currentIds.size !== knownFileIds.size || 
        [...currentIds].some(id => !knownFileIds.has(id));

      if (hasChanged) {
        knownFileIds = currentIds;
        renderFileList(data.files);
      }
    } catch (err) {
      // Polling network glitch, quietly ignore and retry next cycle
    }
  }

  function renderFileList(files) {
    if (!filesContainer) return;

    if (fileCountBadge) {
      fileCountBadge.textContent = `${files.length} file${files.length === 1 ? '' : 's'}`;
    }

    if (downloadAllBtn) {
      downloadAllBtn.style.display = files.length > 1 ? 'inline-flex' : 'none';
    }

    if (files.length === 0) {
      filesContainer.innerHTML = '';
      if (emptyState) emptyState.style.display = 'flex';
      return;
    }

    if (emptyState) emptyState.style.display = 'none';

    filesContainer.innerHTML = files.map(file => {
      const isImg = file.is_image;
      const previewUrl = `/s/${sessionId}/download/${file.id}?preview=1`;
      const downloadUrl = `/s/${sessionId}/download/${file.id}`;

      let visualBlock = '';
      if (isImg) {
        visualBlock = `<img src="${previewUrl}" class="file-thumb-img" alt="${escapeHtml(file.display_name)}" loading="lazy">`;
      } else {
        visualBlock = `
          <svg class="file-icon-placeholder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
        `;
      }

      return `
        <div class="file-item-card" data-file-id="${file.id}">
          <div class="file-thumb-box">
            ${visualBlock}
          </div>
          <div class="file-details">
            <span class="file-name" title="${escapeHtml(file.display_name)}">${escapeHtml(file.display_name)}</span>
            <div class="file-meta-row">
              <span>${file.size_formatted}</span>
              <span>${file.uploaded_at}</span>
            </div>
          </div>
          <div class="file-actions">
            <a href="${downloadUrl}" class="btn btn-secondary btn-sm" download="${escapeHtml(file.display_name)}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              Download
            </a>
          </div>
        </div>
      `;
    }).join('');
  }

  // Start continuous polling every 2.5 seconds
  setInterval(fetchSessionFiles, 2500);

  // ---------------------------------------------------------------------------
  // Service Worker Registration for PWA Shell
  // ---------------------------------------------------------------------------
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/static/service-worker.js')
      .then(reg => {
        console.log('[Relay] Service worker registered successfully.');
      })
      .catch(err => {
        console.warn('[Relay] Service worker registration ignored:', err);
      });
  }
});
