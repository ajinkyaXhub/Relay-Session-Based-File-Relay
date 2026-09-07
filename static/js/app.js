/**
 * Relay - File Transfer Client Application Logic
 * Handles drag-and-drop, progress tracking, live polling, and session lifecycle.
 */

// Capture PWA beforeinstallprompt event at window scope immediately
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (typeof window.triggerPwaPromptDisplay === 'function') {
    window.triggerPwaPromptDisplay();
  }
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  const modal = document.getElementById('pwaInstallModal');
  if (modal) modal.style.display = 'none';
  sessionStorage.setItem('relay_pwa_installed', '1');
});

document.addEventListener('DOMContentLoaded', () => {
  const config = window.__TRANSFER_CONFIG__ || {};
  const sessionId = config.sessionId;
  const csrfToken = config.csrfToken;
  let remainingSeconds = (typeof config.remainingSeconds === 'number' && config.remainingSeconds >= 0)
    ? config.remainingSeconds
    : 300; // 5 minutes default (300 seconds), never 1200 (20 minutes)
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

  // ---------------------------------------------------------------------------
  // PWA Install Offer Popup Logic
  // ---------------------------------------------------------------------------
  const pwaModal = document.getElementById('pwaInstallModal');
  const pwaTriggerInstallBtn = document.getElementById('pwaTriggerInstallBtn');
  const pwaDismissBtn = document.getElementById('pwaDismissBtn');
  const pwaCloseBtn = document.getElementById('pwaCloseBtn');
  const pwaIosGuide = document.getElementById('pwaIosGuide');
  const pwaInstallDesc = document.getElementById('pwaInstallDesc');

  function initPwaInstallOffer() {
    if (!pwaModal) return;

    // Check if running in standalone mode (already installed)
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                         window.navigator.standalone === true ||
                         sessionStorage.getItem('relay_pwa_installed') === '1';

    if (isStandalone) return;

    // Check if user dismissed it in this browsing session
    if (sessionStorage.getItem('relay_install_dismissed') === '1') return;

    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

    function displayPrompt() {
      if (sessionStorage.getItem('relay_install_dismissed') === '1') return;
      if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true) return;

      if (isIos) {
        if (pwaIosGuide) pwaIosGuide.style.display = 'flex';
        if (pwaTriggerInstallBtn) pwaTriggerInstallBtn.style.display = 'none';
        if (pwaInstallDesc) pwaInstallDesc.textContent = 'Install Relay on your iPhone/iPad for instant, one-tap file transfers:';
      } else {
        if (pwaIosGuide) pwaIosGuide.style.display = 'none';
        if (pwaTriggerInstallBtn) pwaTriggerInstallBtn.style.display = 'inline-flex';
      }

      pwaModal.style.display = 'block';
    }

    window.triggerPwaPromptDisplay = displayPrompt;

    // Show popup automatically after 1.5 seconds when opening app
    setTimeout(displayPrompt, 1500);

    function dismissInstall() {
      pwaModal.style.display = 'none';
      sessionStorage.setItem('relay_install_dismissed', '1');
    }

    if (pwaDismissBtn) pwaDismissBtn.addEventListener('click', dismissInstall);
    if (pwaCloseBtn) pwaCloseBtn.addEventListener('click', dismissInstall);

    if (pwaTriggerInstallBtn) {
      pwaTriggerInstallBtn.addEventListener('click', async () => {
        if (deferredInstallPrompt) {
          deferredInstallPrompt.prompt();
          const { outcome } = await deferredInstallPrompt.userChoice;
          if (outcome === 'accepted') {
            showToast('Thank you for installing Relay!', 'success');
            pwaModal.style.display = 'none';
          }
          deferredInstallPrompt = null;
        } else {
          // If browser doesn't support deferred prompt (e.g. desktop menu / manual)
          showToast('To install Relay: click the Install icon (⊕) in your browser address bar or menu.', 'info', 5000);
          pwaModal.style.display = 'none';
          sessionStorage.setItem('relay_install_dismissed', '1');
        }
      });
    }
  }

  initPwaInstallOffer();

  // ---------------------------------------------------------------------------
  // In-App Camera QR Code Scanner Controller
  // ---------------------------------------------------------------------------
  function initQrScanner() {
    const scannerModal = document.getElementById('qrScannerModal');
    const openScannerBtn = document.getElementById('openScannerBtn');
    const cardScanQrBtn = document.getElementById('cardScanQrBtn');
    const cornerScanQrBtn = document.getElementById('cornerScanQrBtn');
    const bannerScanQrBtn = document.getElementById('bannerScanQrBtn');
    const dropzoneScanQrBtn = document.getElementById('dropzoneScanQrBtn');
    const closeScannerModalBtn = document.getElementById('closeScannerModalBtn');
    const scannerVideo = document.getElementById('scannerVideo');
    const scannerCanvas = document.getElementById('scannerCanvas');
    const scannerReticle = document.getElementById('scannerReticle');
    const scannerLoadingState = document.getElementById('scannerLoadingState');
    const scannerStatusText = document.getElementById('scannerStatusText');
    const scannerFallbackSnapBtn = document.getElementById('scannerFallbackSnapBtn');
    const scannerTorchBtn = document.getElementById('scannerTorchBtn');
    const scannerFlipCameraBtn = document.getElementById('scannerFlipCameraBtn');
    const qrCameraSnapInput = document.getElementById('qrCameraSnapInput');
    const qrImageUploadInput = document.getElementById('qrImageUploadInput');

    if (!scannerModal) return;

    let mediaStream = null;
    let videoTrack = null;
    let scanAnimationId = null;
    let currentFacingMode = 'environment';
    let availableCamerasCount = 0;
    let isProcessingScan = false;
    let isTorchOn = false;
    let lastFrameTime = 0;
    const SCAN_INTERVAL_MS = 85; // Throttle to ~12 checks/sec for optimal responsiveness and battery preservation

    // Cache native BarcodeDetector if supported by the browser (Chrome Android, etc.)
    let nativeDetector = null;
    if ('BarcodeDetector' in window) {
      try {
        nativeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch (e) {
        nativeDetector = null;
      }
    }

    // Detect if device has multiple cameras (front & back)
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices().then(devices => {
        const videoInputs = devices.filter(d => d.kind === 'videoinput');
        availableCamerasCount = videoInputs.length;
        if (availableCamerasCount > 1 && scannerFlipCameraBtn) {
          scannerFlipCameraBtn.style.display = 'flex';
        }
      }).catch(() => {});
    }

    // Play subtle chime on scan success using Web Audio API
    function playSuccessSound() {
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        const ctx = new AudioContextClass();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.setValueAtTime(1760, ctx.currentTime + 0.08);
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
      } catch (e) {}
    }

    function triggerHaptic() {
      if (navigator.vibrate) {
        try {
          navigator.vibrate([40, 30, 80]);
        } catch (e) {}
      }
    }

    // Update Torch button visibility based on active track capabilities
    function updateTorchSupport() {
      if (scannerTorchBtn) {
        if (videoTrack && typeof videoTrack.getCapabilities === 'function') {
          try {
            const caps = videoTrack.getCapabilities();
            if (caps && caps.torch) {
              scannerTorchBtn.style.display = 'flex';
              return;
            }
          } catch (e) {}
        }
        scannerTorchBtn.style.display = 'none';
        isTorchOn = false;
        scannerTorchBtn.classList.remove('active');
      }
    }

    if (scannerTorchBtn) {
      scannerTorchBtn.addEventListener('click', async () => {
        if (!videoTrack) return;
        try {
          isTorchOn = !isTorchOn;
          await videoTrack.applyConstraints({
            advanced: [{ torch: isTorchOn }]
          });
          scannerTorchBtn.classList.toggle('active', isTorchOn);
        } catch (e) {
          console.warn('Torch toggle error:', e);
        }
      });
    }

    async function handleDecodedUrl(decodedText) {
      if (isProcessingScan || !decodedText) return;
      isProcessingScan = true;

      // Animate reticle and provide sensory feedback
      if (scannerReticle) scannerReticle.classList.add('success');
      playSuccessSound();
      triggerHaptic();

      // Clean up camera stream
      stopCamera();

      let targetUrl = decodedText.trim();

      // Check if the user scanned their own session
      if (sessionId) {
        if (targetUrl.includes(sessionId) || targetUrl === sessionId) {
          showToast('You are already connected to this transfer session!', 'info', 4000);
          closeScanner();
          return;
        }
      }

      showToast('Relay QR code recognized! Connecting...', 'success', 3000);

      setTimeout(() => {
        try {
          // Smart loopback rewrite: if scanned URL contains localhost/127.0.0.1,
          // adapt to current phone origin so connection on LAN works smoothly
          if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
            const parsed = new URL(targetUrl);
            if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '0.0.0.0') {
              targetUrl = `${window.location.protocol}//${window.location.host}${parsed.pathname}${parsed.search}`;
            }
            window.location.href = targetUrl;
          } else if (targetUrl.startsWith('/s/')) {
            window.location.href = targetUrl;
          } else if (/^[a-f0-9]{32}$/i.test(targetUrl)) {
            window.location.href = `/s/${targetUrl}`;
          } else {
            showToast(`Scanned: ${targetUrl}`, 'info', 4000);
            closeScanner();
          }
        } catch (err) {
          window.location.href = targetUrl;
        }
      }, 500);
    }

    async function startCamera() {
      isProcessingScan = false;
      isTorchOn = false;
      if (scannerTorchBtn) {
        scannerTorchBtn.style.display = 'none';
        scannerTorchBtn.classList.remove('active');
      }
      if (scannerReticle) scannerReticle.classList.remove('success');
      if (scannerLoadingState) {
        scannerLoadingState.style.display = 'flex';
        if (scannerStatusText) scannerStatusText.textContent = 'Starting camera...';
      }
      if (scannerFallbackSnapBtn) scannerFallbackSnapBtn.style.display = 'none';

      // Check for live camera stream support
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        if (scannerLoadingState && scannerStatusText) {
          scannerStatusText.textContent = 'Live video streaming is not available over plain HTTP. Tap below to snap a photo directly with your camera:';
        }
        if (scannerFallbackSnapBtn) scannerFallbackSnapBtn.style.display = 'inline-flex';
        return;
      }

      // Multi-tier constraint fallback to guarantee compatibility on all mobile browsers
      const constraintTiers = [
        { video: { facingMode: { ideal: currentFacingMode }, width: { ideal: 1280 } }, audio: false },
        { video: { facingMode: { ideal: currentFacingMode } }, audio: false },
        { video: true, audio: false }
      ];

      let stream = null;
      let lastError = null;

      for (const constraints of constraintTiers) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          if (stream) break;
        } catch (err) {
          lastError = err;
        }
      }

      if (!stream) {
        console.warn('Camera access error:', lastError);
        if (scannerLoadingState && scannerStatusText) {
          scannerStatusText.textContent = 'Camera permission denied or camera unavailable. You can snap a photo of the QR code below:';
        }
        if (scannerFallbackSnapBtn) scannerFallbackSnapBtn.style.display = 'inline-flex';
        return;
      }

      mediaStream = stream;
      videoTrack = mediaStream.getVideoTracks()[0] || null;

      if (scannerVideo) {
        scannerVideo.srcObject = mediaStream;
        scannerVideo.setAttribute('playsinline', 'true');
        scannerVideo.setAttribute('webkit-playsinline', 'true');
        scannerVideo.muted = true;
        try {
          await scannerVideo.play();
        } catch (e) {
          console.warn('Video play error:', e);
        }
      }

      if (scannerLoadingState) scannerLoadingState.style.display = 'none';
      updateTorchSupport();

      lastFrameTime = performance.now();
      scanAnimationId = requestAnimationFrame(scanVideoFrame);
    }

    function stopCamera() {
      if (scanAnimationId) {
        cancelAnimationFrame(scanAnimationId);
        scanAnimationId = null;
      }
      if (mediaStream) {
        mediaStream.getTracks().forEach(track => {
          try { track.stop(); } catch (e) {}
        });
        mediaStream = null;
      }
      videoTrack = null;
      if (scannerVideo) {
        scannerVideo.srcObject = null;
      }
    }

    async function scanVideoFrame(timestamp) {
      if (isProcessingScan || !scannerModal || scannerModal.style.display === 'none') {
        return;
      }

      if (scannerVideo && scannerVideo.readyState >= 2 && scannerVideo.videoWidth > 0) {
        if (!timestamp || timestamp - lastFrameTime >= SCAN_INTERVAL_MS) {
          lastFrameTime = timestamp || performance.now();
          const width = scannerVideo.videoWidth;
          const height = scannerVideo.videoHeight;

          // 1. Try native BarcodeDetector API first (hardware accelerated)
          if (nativeDetector) {
            try {
              const barcodes = await nativeDetector.detect(scannerVideo);
              if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
                handleDecodedUrl(barcodes[0].rawValue);
                return;
              }
            } catch (e) {}
          }

          // 2. High-speed jsQR fallback with resolution downsampling
          if (typeof window.jsQR === 'function' && scannerCanvas) {
            // Downscale frame to max 480px to ensure instant, lag-free scanning on mobile
            const maxDim = 480;
            let targetW = width;
            let targetH = height;
            if (width > maxDim || height > maxDim) {
              if (width > height) {
                targetW = maxDim;
                targetH = Math.round((height / width) * maxDim);
              } else {
                targetH = maxDim;
                targetW = Math.round((width / height) * maxDim);
              }
            }

            if (scannerCanvas.width !== targetW) scannerCanvas.width = targetW;
            if (scannerCanvas.height !== targetH) scannerCanvas.height = targetH;

            const ctx = scannerCanvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(scannerVideo, 0, 0, targetW, targetH);

            try {
              const imageData = ctx.getImageData(0, 0, targetW, targetH);
              const qrCode = window.jsQR(imageData.data, imageData.width, imageData.height, {
                inversionAttempts: 'dontInvert'
              });

              if (qrCode && qrCode.data) {
                handleDecodedUrl(qrCode.data);
                return;
              }
            } catch (err) {}
          }
        }
      }

      scanAnimationId = requestAnimationFrame(scanVideoFrame);
    }

    function openScanner() {
      scannerModal.style.display = 'flex';
      startCamera();
    }

    function closeScanner() {
      stopCamera();
      scannerModal.style.display = 'none';
    }

    // Bind all scanner trigger buttons across the application
    if (openScannerBtn) openScannerBtn.addEventListener('click', openScanner);
    if (cardScanQrBtn) cardScanQrBtn.addEventListener('click', openScanner);
    if (cornerScanQrBtn) cornerScanQrBtn.addEventListener('click', openScanner);
    if (bannerScanQrBtn) bannerScanQrBtn.addEventListener('click', openScanner);
    if (dropzoneScanQrBtn) dropzoneScanQrBtn.addEventListener('click', openScanner);
    if (closeScannerModalBtn) closeScannerModalBtn.addEventListener('click', closeScanner);

    scannerModal.addEventListener('click', (e) => {
      if (e.target === scannerModal) {
        closeScanner();
      }
    });

    if (scannerFlipCameraBtn) {
      scannerFlipCameraBtn.addEventListener('click', () => {
        currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
        stopCamera();
        startCamera();
      });
    }

    // Direct fallback button inside loading state to trigger camera snap
    if (scannerFallbackSnapBtn && qrCameraSnapInput) {
      scannerFallbackSnapBtn.addEventListener('click', () => {
        qrCameraSnapInput.click();
      });
    }

    // Process photo or screenshot image file with jsQR and BarcodeDetector
    function decodeImageFile(file) {
      if (!file) return;

      if (scannerLoadingState) {
        scannerLoadingState.style.display = 'flex';
        if (scannerStatusText) scannerStatusText.textContent = 'Decoding QR code from photo...';
        if (scannerFallbackSnapBtn) scannerFallbackSnapBtn.style.display = 'none';
      }

      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = async () => {
          // 1. Try native BarcodeDetector
          if (nativeDetector) {
            try {
              const barcodes = await nativeDetector.detect(img);
              if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
                handleDecodedUrl(barcodes[0].rawValue);
                return;
              }
            } catch (err) {}
          }

          // 2. jsQR with downsampling for huge photos (e.g. 12-48MP smartphone camera shots)
          if (typeof window.jsQR === 'function') {
            const maxDim = 1000;
            let w = img.naturalWidth || img.width;
            let h = img.naturalHeight || img.height;
            if (w > maxDim || h > maxDim) {
              if (w > h) {
                h = Math.round((h / w) * maxDim);
                w = maxDim;
              } else {
                w = Math.round((w / h) * maxDim);
                h = maxDim;
              }
            }

            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, w, h);

            try {
              const imgData = ctx.getImageData(0, 0, w, h);
              const code = window.jsQR(imgData.data, imgData.width, imgData.height, {
                inversionAttempts: 'attemptBoth'
              });
              if (code && code.data) {
                handleDecodedUrl(code.data);
                return;
              }
            } catch (err) {}
          }

          if (scannerLoadingState) {
            scannerLoadingState.style.display = 'none';
          }
          showToast('No readable QR code found in this photo. Please ensure it is clear and in focus.', 'error', 4500);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    }

    if (qrCameraSnapInput) {
      qrCameraSnapInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) decodeImageFile(file);
        qrCameraSnapInput.value = '';
      });
    }

    if (qrImageUploadInput) {
      qrImageUploadInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) decodeImageFile(file);
        qrImageUploadInput.value = '';
      });
    }
  }

  initQrScanner();
});
