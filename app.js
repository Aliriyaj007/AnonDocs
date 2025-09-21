/* --------------------------
Utilities & Storage keys
-------------------------- */
const DOCS_KEY = 'anon_docs_v3';
const LINKS_KEY = 'anon_shared_v3';
const THEME_KEY = 'anon_theme_v3';
const TUTORIAL_KEY = 'anon_tutorial_seen_v2';
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

function now() {
    return Date.now();
}

function toast(msg, type = 'info', ms = 3500) {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : type === 'warning' ? 'exclamation-triangle' : 'info-circle'}"></i> ${msg}`;
    $('#toasts').appendChild(t);
    setTimeout(() => {
        t.style.opacity = '0';
        t.style.transform = 'translateX(100%)';
        setTimeout(() => t.remove(), 300);
    }, ms);
}

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            return true;
        } catch (e2) {
            return false;
        }
    }
}

function sanitize(html) {
    return String(html).replace(/<script[\s\S]?>[\s\S]*?<\/script>/gi, '');
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '<',
        '>': '>',
        '"': '&quot;',
        "'": "&#39;"
    }[c]));
}

function base64ToBytes(base64) {
    const binString = atob(base64);
    return Uint8Array.from(binString, (m) => m.codePointAt(0));
}

function bytesToBase64(bytes) {
    return btoa(String.fromCharCode(...bytes));
}

/* --------------------------
Load / Save models
-------------------------- */
let docs = JSON.parse(localStorage.getItem(DOCS_KEY) || '{}');
let sharedLinks = JSON.parse(localStorage.getItem(LINKS_KEY) || '[]');
let currentId = null;
const editor = $('#editor');

/* --------------------------
Encryption functions (WebCrypto API)
-------------------------- */
async function encryptMessage(message, password) {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const key = await window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt,
            iterations: 100000,
            hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"]
    );
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const cipher = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        enc.encode(message)
    );
    return {
        cipher: bytesToBase64(new Uint8Array(cipher)),
        iv: Array.from(iv),
        salt: Array.from(salt)
    };
}

async function decryptMessage(encrypted, password, iv, salt) {
    const dec = new TextDecoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );
    const key = await window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: new Uint8Array(salt),
            iterations: 100000,
            hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"]
    );
    const plainBuffer = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(iv) },
        key,
        base64ToBytes(encrypted)
    );
    return dec.decode(plainBuffer);
}

/* --------------------------
Init on DOM ready
-------------------------- */
window.addEventListener('DOMContentLoaded', () => {
    bindUI();
    applySavedTheme();
    renderDocsList();
    handleIncomingNote();
    initTooltips();
    
    // First-time user tutorial (non-intrusive overlay)
    if (localStorage.getItem(TUTORIAL_KEY) !== 'true') {
        showOnboardingGuide();
    }
    
    // if no docs create one
    if (Object.keys(docs).length === 0) {
        createNewDoc();
    } else {
        // load most recent
        const ids = Object.keys(docs).sort((a, b) => (docs[b].updated || 0) - (docs[a].updated || 0));
        if (ids.length) loadDoc(ids[0]);
    }
    updateStats();
});

/* --------------------------
UI Bindings
-------------------------- */
function bindUI() {
    // Hero actions
    $('#createNoteBtn').addEventListener('click', createNewDoc);
    $('#viewDocsBtn').addEventListener('click', () => {
        const sidebar = $('#sidebar');
        sidebar.style.display = sidebar.style.display === 'none' ? 'block' : 'none';
    });
    $('#viewDocsBtnMobile').addEventListener('click', () => {
        const sidebar = $('#sidebar');
        sidebar.style.display = sidebar.style.display === 'none' ? 'block' : 'none';
    });
    
    // Top actions
    $('#newBtn').addEventListener('click', createNewDoc);
    $('#saveBtn').addEventListener('click', saveCurrentDoc);
    
    // Share button - opens new secure note modal
    $('#shareBtn').addEventListener('click', () => {
        $('#noteResult').classList.add('hidden');
        $('#notePassword').value = '';
        $('#notePasswordConfirm').value = '';
        $('#noteReference').value = $('#titleInput').value || 'Untitled Document';
        $('#notifyEmail').value = '';
        $('#destructNotify').checked = false;
        $('#notifyEmail').style.display = 'none';
        $('#selfDestruct').checked = true;
        $('#noteExpiry').value = '168';
        openModal('noteModal');
    });
    
    // Theme selection
    $('#themeSelect').value = localStorage.getItem(THEME_KEY) || 'dark';
    $('#themeSelect').addEventListener('change', e => {
        setTheme(e.target.value);
    });
    
    // Toolbar formatting handlers
    $$('.toolbar button[data-cmd]').forEach(btn => {
        btn.addEventListener('click', () => doCmd(btn.dataset.cmd));
    });
    
    // Other toolbar controls
    $('#fontFamily').addEventListener('change', e => doCmd('fontName', e.target.value));
    $('#fontSize').addEventListener('change', e => doCmd('fontSize', e.target.value));
    $('#blockFormat').addEventListener('change', e => doCmd('formatBlock', e.target.value));
    $('#textColor').addEventListener('change', e => doCmd('foreColor', e.target.value));
    $('#highlightColor').addEventListener('change', e => doCmd('hiliteColor', e.target.value));
    $('#linkBtn').addEventListener('click', insertLink);
    $('#imageInput').addEventListener('change', insertImage);
    $('#findBtn').addEventListener('click', openFindDialog);
    $('#undoBtn').addEventListener('click', () => doCmd('undo'));
    $('#redoBtn').addEventListener('click', () => doCmd('redo'));
    
    // Download dropdown
    $('#downloadBtn').addEventListener('click', toggleDownloadMenu);
    $('#downloadTxtBtn').addEventListener('click', downloadAsTxt);
    $('#downloadPdfBtn').addEventListener('click', downloadAsPdf);
    $('#printBtn').addEventListener('click', printDocument);
    
    // Note modal events
    $('#destructNotify').addEventListener('change', () => {
        $('#notifyEmail').style.display = $('#destructNotify').checked ? 'block' : 'none';
    });
    $('#notePassword').addEventListener('input', updatePasswordStrength);
    $('#generateNoteBtn').addEventListener('click', generateSecureNote);
    $('#copyNoteBtn').addEventListener('click', () => {
        const url = $('#noteUrl').value;
        copyToClipboard(url).then(ok => toast(ok ? 'Link copied!' : 'Copy failed', ok ? 'success' : 'error'));
    });
    $('#qrNoteBtn').addEventListener('click', generateQrCode);
    
    // Import/Export buttons
    $('#importBtn').addEventListener('click', importDocument);
    $('#exportBtn').addEventListener('click', exportDocument);
    
    // Editor events
    editor.addEventListener('input', () => {
        scheduleAutosave();
        updateStats();
    });
    editor.addEventListener('keydown', (e) => {
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key.toLowerCase() === 's') {
            e.preventDefault();
            saveCurrentDoc();
        }
        if (mod && e.key.toLowerCase() === 'b') {
            e.preventDefault();
            doCmd('bold');
        }
        if (mod && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            insertLink();
        }
        if (mod && e.key.toLowerCase() === 'n') {
            e.preventDefault();
            createNewDoc();
        }
    });
    
    // Title change
    $('#titleInput').addEventListener('input', e => {
        if (!currentId) return;
        docs[currentId].title = e.target.value || 'Untitled';
        docs[currentId].updated = now();
        persistDocs();
        renderDocsList();
    });
    
    // Viewer events
    $('#viewerCloseBtn').addEventListener('click', () => $('#viewerOverlay').classList.add('hidden'));
    $('#viewerSaveBtn').addEventListener('click', saveViewerContent);
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.dropdown')) {
            $('#downloadMenu').classList.add('hidden');
        }
    });
}

/* --------------------------
Toggle Download Menu
-------------------------- */
function toggleDownloadMenu() {
    const menu = $('#downloadMenu');
    menu.classList.toggle('hidden');
}

/* --------------------------
Download as TXT
-------------------------- */
function downloadAsTxt() {
    if (!currentId) return;
    const content = editor.innerText;
    const title = $('#titleInput').value || 'document';
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Document downloaded as TXT', 'success');
}

/* --------------------------
Download as PDF
-------------------------- */
function downloadAsPdf() {
    if (!currentId) return;
    
    // Check if jsPDF is available
    if (typeof window.jspdf === 'undefined') {
        toast('PDF library not loaded. Please try again.', 'error');
        return;
    }
    
    const { jsPDF } = window.jspdf;
    const title = $('#titleInput').value || 'Document';
    const content = editor.innerText;
    
    // Create PDF
    const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4'
    });
    
    // Set font and add content
    pdf.setFont('helvetica');
    pdf.setFontSize(12);
    pdf.text(title, 15, 15);
    pdf.setFontSize(10);
    pdf.text(content, 15, 25, {
        maxWidth: 180,
        lineHeightFactor: 1.5
    });
    
    // Save PDF
    pdf.save(`${title}.pdf`);
    toast('Document downloaded as PDF', 'success');
}

/* --------------------------
Tooltip System
-------------------------- */
function initTooltips() {
    const tooltip = $('#tooltip');
    const elementsWithTips = document.querySelectorAll('[data-tip]');
    elementsWithTips.forEach(el => {
        el.addEventListener('mouseenter', (e) => {
            const tipText = e.target.dataset.tip;
            if (!tipText) return;
            tooltip.textContent = tipText;
            tooltip.classList.remove('hidden');
            
            // Position tooltip above and centered on the element
            const rect = e.target.getBoundingClientRect();
            const tooltipRect = tooltip.getBoundingClientRect();
            const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
            const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
            
            tooltip.style.top = (rect.top - tooltipRect.height - 10 + scrollTop) + 'px';
            tooltip.style.left = (rect.left + rect.width / 2 - tooltipRect.width / 2 + scrollLeft) + 'px';
        });
        el.addEventListener('mouseleave', () => {
            tooltip.classList.add('hidden');
        });
    });
}

/* --------------------------
Onboarding Guide (Non-intrusive overlays)
-------------------------- */
function showOnboardingGuide() {
    const overlay = $('#onboardingOverlay');
    const step1 = $('#onboardingStep1');
    const step2 = $('#onboardingStep2');
    
    // Position step 1 near the hero section
    step1.style.top = '50%';
    step1.style.left = '50%';
    step1.style.transform = 'translate(-50%, -50%)';
    
    // Position step 2 near the create button
    const createBtn = $('#createNoteBtn');
    if (createBtn) {
        const rect = createBtn.getBoundingClientRect();
        step2.style.top = (rect.top + window.scrollY - 20) + 'px';
        step2.style.left = (rect.left + window.scrollX - 10) + 'px';
    }
    
    overlay.classList.remove('hidden');
    
    // Step 1 Next button
    $('#onboardingNext1').addEventListener('click', () => {
        step1.classList.add('hidden');
        step2.classList.remove('hidden');
    });
    
    // Step 2 Back button
    $('#onboardingBack2').addEventListener('click', () => {
        step2.classList.add('hidden');
        step1.classList.remove('hidden');
    });
    
    // Step 2 Next button (Get Started)
    $('#onboardingNext2').addEventListener('click', () => {
        overlay.classList.add('hidden');
        localStorage.setItem(TUTORIAL_KEY, 'true');
        createNewDoc();
    });
    
    // Close on escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            overlay.classList.add('hidden');
            localStorage.setItem(TUTORIAL_KEY, 'true');
        }
    });
}

/* --------------------------
Password strength indicator
-------------------------- */
function updatePasswordStrength() {
    const password = $('#notePassword').value;
    const strengthBar = $('#passwordStrengthBar');
    
    // Reset classes
    strengthBar.className = 'password-strength-bar';
    if (!password) {
        strengthBar.style.width = '0%';
        return;
    }
    
    // Calculate strength (simple version)
    let strength = 0;
    if (password.length >= 8) strength += 1;
    if (password.length >= 12) strength += 1;
    if (/[A-Z]/.test(password)) strength += 1;
    if (/[0-9]/.test(password)) strength += 1;
    if (/[^A-Za-z0-9]/.test(password)) strength += 1;
    
    // Update UI
    if (strength <= 2) {
        strengthBar.classList.add('strength-weak');
    } else if (strength <= 4) {
        strengthBar.classList.add('strength-medium');
    } else {
        strengthBar.classList.add('strength-strong');
    }
}

/* --------------------------
Commands & Editor utilities
-------------------------- */
function doCmd(cmd, val = null) {
    document.execCommand(cmd, false, val);
    editor.focus();
}

function insertLink() {
    const url = prompt('Enter URL (include https://):');
    if (!url) return;
    document.execCommand('createLink', false, url);
}

function insertImage(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(event) {
        const img = new Image();
        img.src = event.target.result;
        img.style.maxWidth = '100%';
        img.style.height = 'auto';
        img.style.borderRadius = '8px';
        img.style.margin = '10px 0';
        
        // Wait for image to load before inserting
        img.onload = function() {
            // Create a range and insert the image
            const range = document.createRange();
            const sel = window.getSelection();
            
            if (sel.rangeCount > 0) {
                range.setStart(sel.anchorNode, sel.anchorOffset);
                range.collapse(true);
            } else {
                range.selectNodeContents(editor);
                range.collapse(false);
            }
            
            // Insert the image
            range.insertNode(img);
            
            // Move cursor after the image
            range.setStartAfter(img);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            
            toast('Image inserted', 'success');
        };
        
        img.onerror = function() {
            toast('Error loading image', 'error');
        };
    };
    reader.readAsDataURL(file);
    e.target.value = ''; // Reset input
}

/* --------------------------
Docs CRUD
-------------------------- */
function persistDocs() {
    localStorage.setItem(DOCS_KEY, JSON.stringify(docs));
}

function persistLinks() {
    localStorage.setItem(LINKS_KEY, JSON.stringify(sharedLinks));
}

function createNewDoc() {
    const id = String(now());
    docs[id] = {
        id,
        title: 'Untitled',
        content: '',
        created: now(),
        updated: now()
    };
    persistDocs();
    renderDocsList();
    loadDoc(id);
    toast('New document created', 'success');
}

function renderDocsList() {
    const wrap = $('#docsList');
    wrap.innerHTML = '';
    const arr = Object.values(docs).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    arr.forEach(d => {
        const item = document.createElement('div');
        item.className = 'doc-item';
        if (d.id === currentId) item.classList.add('active');
        
        item.innerHTML = `
            <div class="doc-title">${escapeHtml(d.title)}</div>
            <div class="doc-meta">${new Date(d.updated).toLocaleDateString()}</div>
        `;
        
        item.addEventListener('click', () => loadDoc(d.id));
        wrap.appendChild(item);
    });
}

function loadDoc(id) {
    const d = docs[id];
    if (!d) return;
    currentId = id;
    editor.innerHTML = d.content || '';
    $('#titleInput').value = d.title || 'Untitled';
    renderDocsList();
    updateStats();
    // Scroll to top of editor
    editor.scrollTop = 0;
}

function saveCurrentDoc() {
    if (!currentId) {
        createNewDoc();
        return;
    }
    docs[currentId].content = sanitize(editor.innerHTML);
    docs[currentId].title = $('#titleInput').value || deriveTitle(docs[currentId].content) || 'Untitled';
    docs[currentId].updated = now();
    persistDocs();
    renderDocsList();
    toast('Document saved', 'success');
}

function deriveTitle(html) {
    const text = (html || '').replace(/<[^>]+>/g, ' ').trim();
    return (text.split('\n')[0] || '').slice(0, 60);
}

/* --------------------------
Import/Export functions
-------------------------- */
function importDocument() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.html,.txt,.json';
    input.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const content = e.target.result;
                const id = String(now());
                docs[id] = {
                    id,
                    title: file.name.replace(/\.[^/.]+$/, ""),
                    content: content,
                    created: now(),
                    updated: now()
                };
                persistDocs();
                renderDocsList();
                loadDoc(id);
                toast('Document imported', 'success');
            } catch (error) {
                toast('Error importing document', 'error');
            }
        };
        reader.readAsText(file);
    };
    input.click();
}

function exportDocument() {
    if (!currentId) return;
    const doc = docs[currentId];
    const content = doc.content;
    const blob = new Blob([content], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${doc.title}.html`;
    a.click();
    toast('Document exported', 'success');
}

/* Autosave */
let autosaveTimer = null;
function scheduleAutosave() {
    $('#statusBadge').textContent = 'Saving...';
    $('#statusBadge').style.opacity = 1;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
        saveCurrentDoc();
        $('#statusBadge').textContent = 'Saved';
        $('#statusBadge').style.opacity = 0.7;
    }, 900);
}

/* --------------------------
Stats
-------------------------- */
function updateStats() {
    const txt = (editor.innerText || '').trim();
    const words = txt ? (txt.match(/\S+/g) || []).length : 0;
    const chars = txt.replace(/\s/g, '').length;
    $('#stats').textContent = `${words} words · ${chars} chars`;
}

/* --------------------------
Print only content
-------------------------- */
function printDocument() {
    const content = sanitize(editor.innerHTML);
    const title = escapeHtml($('#titleInput').value || 'Document');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title> <style>body{font-family:system-ui,Arial;padding:20px;color:#111}img{max-width:100%;height:auto;border-radius:8px}</style></head><body>${content}</body></html>`;
    const w = window.open('', '_blank', 'noopener');
    if (!w) {
        toast('Popup blocked — allow popups to use print.', 'error');
        return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.onload = () => {
        w.focus();
        w.print();
    };
}

/* --------------------------
Secure Note Creation (Original version preserved)
-------------------------- */
async function generateSecureNote() {
    const pwd = $('#notePassword').value;
    const confirmPwd = $('#notePasswordConfirm').value;
    const ref = $('#noteReference').value || "Untitled Secure Note";
    const email = $('#notifyEmail').value;
    const selfDestruct = $('#selfDestruct').checked;
    const notify = $('#destructNotify').checked;
    
    // Validate inputs
    if (!pwd) {
        toast('Password required!', 'error');
        return;
    }
    if (pwd !== confirmPwd) {
        toast("Passwords don't match!", 'error');
        return;
    }
    if (notify && !email) {
        toast("Email required for notifications!", 'error');
        return;
    }
    
    try {
        // Encrypt note content
        const content = sanitize(editor.innerHTML);
        const { cipher, iv, salt } = await encryptMessage(content, pwd);
        const expiryHours = Number($('#noteExpiry').value);
        const expiresAt = expiryHours > 0 ? now() + expiryHours * 60 * 60 * 1000 : null;
        const payload = {
            title: ref,
            cipher: cipher,
            iv: iv,
            salt: salt,
            createdAt: now(),
            expiresAt: expiresAt,
            selfDestruct: selfDestruct,
            emailNotify: notify ? email : null
        };
        const encoded = btoa(JSON.stringify(payload));
        const noteUrl = `${location.origin}${location.pathname}#note=${encodeURIComponent(encoded)}`;
        
        // Save record
        const rec = {
            id: String(now()),
            docId: currentId,
            url: noteUrl,
            createdAt: payload.createdAt,
            expiresAt: payload.expiresAt,
            selfDestruct: payload.selfDestruct
        };
        sharedLinks.unshift(rec);
        persistLinks();
        
        // Show result
        $('#noteUrl').value = noteUrl;
        $('#noteMeta').textContent = `Expires: ${expiresAt ? new Date(expiresAt).toLocaleString() : 'Never'} · ${selfDestruct ? 'Self-destruct enabled' : 'Permanent'}`;
        $('#noteResult').classList.remove('hidden');
        
        // Show countdown if applicable
        if (expiresAt) {
            $('#destructionCountdown').classList.remove('hidden');
            startCountdown(expiresAt);
        }
        
        copyToClipboard(noteUrl).then(ok => {
            toast(ok ? 'Secure link copied to clipboard!' : 'Could not auto-copy — use copy button', ok ? 'success' : 'warning');
        });
    } catch (error) {
        console.error('Encryption error:', error);
        toast('Error creating secure note', 'error');
    }
}

function startCountdown(expiresAt) {
    const timerElement = $('#countdownTimer');
    function updateCountdown() {
        const now = Date.now();
        const diff = expiresAt - now;
        if (diff <= 0) {
            timerElement.textContent = 'Expired';
            return;
        }
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        timerElement.textContent = `${days}d ${hours}h ${minutes}m`;
    }
    updateCountdown();
    const countdownInterval = setInterval(updateCountdown, 60000);
    
    // Store interval ID on the element for cleanup
    $('#noteModal').countdownInterval = countdownInterval;
    
    // Clear interval when modal is closed
    const modalObserver = new MutationObserver(() => {
        if ($('#noteModal').classList.contains('hidden')) {
            clearInterval(countdownInterval);
            modalObserver.disconnect();
        }
    });
    modalObserver.observe($('#noteModal'), { attributes: true, attributeFilter: ['class'] });
}

/* --------------------------
QR Code Generation
-------------------------- */
function generateQrCode() {
    const url = $('#noteUrl').value;
    if (!url) {
        toast('No URL to generate QR code', 'error');
        return;
    }
    
    // Clear previous QR code
    $('#qrCode').innerHTML = '';
    
    // Generate QR code
    QRCode.toCanvas(document.getElementById('qrCode'), url, {
        width: 256,
        margin: 2,
        color: {
            dark: '#000000',
            light: '#ffffff'
        }
    }, function (error) {
        if (error) {
            console.error('QR Code generation error:', error);
            toast('Error generating QR code', 'error');
            return;
        }
        
        // Show QR modal
        openModal('qrModal');
    });
}

// Download QR code
$('#downloadQrBtn').addEventListener('click', function() {
    const canvas = document.querySelector('#qrCode canvas');
    if (!canvas) {
        toast('No QR code to download', 'error');
        return;
    }
    
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'anondocs-qr-code.png';
    a.click();
    toast('QR code downloaded', 'success');
});

/* --------------------------
Handle incoming secure note
-------------------------- */
async function handleIncomingNote() {
    const hash = window.location.hash;
    if (!hash.includes('note=')) return;
    
    try {
        const encoded = decodeURIComponent(hash.split('note=')[1]);
        const payload = JSON.parse(atob(encoded));
        
        // Check if expired
        if (payload.expiresAt && now() > payload.expiresAt) {
            toast("This secure note has expired.", 'error');
            history.replaceState({}, document.title, location.pathname);
            return;
        }
        
        // Request password
        const pwd = prompt("Enter password to unlock this note:");
        if (!pwd) {
            history.replaceState({}, document.title, location.pathname);
            return;
        }
        
        // Decrypt content
        const content = await decryptMessage(
            payload.cipher,
            pwd,
            payload.iv,
            payload.salt
        );
        
        // Show content
        showSharedViewer({ title: payload.title, html: content }, true);
        
        // Self-destruct if enabled
        if (payload.selfDestruct) {
            history.replaceState({}, document.title, location.pathname);
            toast("This note has been destroyed.", 'warning');
            // Simulate email notification
            if (payload.emailNotify) {
                console.log(`📧 Would send destruction email to: ${payload.emailNotify}`);
            }
        }
    } catch (error) {
        console.error('Decryption error:', error);
        toast('Invalid note or incorrect password', 'error');
        history.replaceState({}, document.title, location.pathname);
    }
}

/* --------------------------
Show shared viewer overlay
-------------------------- */
function showSharedViewer(payload, wasSecure) {
    $('#viewerTitle').textContent = payload.title || 'Shared Document';
    $('#viewerContent').innerHTML = sanitize(payload.html || '');
    $('#viewerOverlay').classList.remove('hidden');
}

function saveViewerContent() {
    const content = $('#viewerContent').innerHTML;
    const title = $('#viewerTitle').textContent;
    const id = String(now());
    docs[id] = {
        id,
        title: title + ' (Copy)',
        content: sanitize(content),
        created: now(),
        updated: now()
    };
    persistDocs();
    renderDocsList();
    loadDoc(id);
    toast('Saved local copy', 'success');
    $('#viewerOverlay').classList.add('hidden');
}

/* --------------------------
Modals open/close
-------------------------- */
function openModal(id) {
    $(`#${id}`).classList.remove('hidden');
    document.body.style.overflow = 'hidden'; // Prevent background scrolling
}

function closeModal(id) {
    $(`#${id}`).classList.add('hidden');
    document.body.style.overflow = ''; // Restore scrolling
    
    // If this is the note modal, clear any countdown
    if (id === 'noteModal' && $(`#${id}`).countdownInterval) {
        clearInterval($(`#${id}`).countdownInterval);
        $(`#${id}`).countdownInterval = null;
    }
}

/* --------------------------
Theme
-------------------------- */
function setTheme(t) {
    if (!t) t = localStorage.getItem(THEME_KEY) || 'dark';
    document.documentElement.classList.remove('light');
    if (t === 'light') document.documentElement.classList.add('light');
    localStorage.setItem(THEME_KEY, t);
    $('#themeSelect').value = t;
}

function applySavedTheme() {
    setTheme(localStorage.getItem(THEME_KEY) || 'dark');
}

/* --------------------------
Find (simple UX: selection)
-------------------------- */
function openFindDialog() {
    const term = prompt('Find (enter text):');
    if (!term) return;
    const idx = editor.innerText.indexOf(term);
    if (idx === -1) {
        toast('Not found', 'warning');
        return;
    }
    selectTextByIndex(idx, term.length);
}

function selectTextByIndex(start, len) {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node, pos = 0, startNode, endNode, startOffset, endOffset;
    while (node = walker.nextNode()) {
        const next = pos + node.textContent.length;
        if (startNode == null && start >= pos && start < next) {
            startNode = node;
            startOffset = start - pos;
        }
        if (startNode && (start + len) <= next) {
            endNode = node;
            endOffset = (start + len) - pos;
            break;
        }
        pos = next;
    }
    if (startNode && endNode) {
        const r = document.createRange();
        r.setStart(startNode, startOffset);
        r.setEnd(endNode, endOffset);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        // Scroll to selection
        const selectionRect = r.getBoundingClientRect();
        editor.scrollTop = selectionRect.top + editor.scrollTop - editor.getBoundingClientRect().top - 100;
    }
}

/* --------------------------
Service Worker (sw.js content)
-------------------------- */
// This will be written to sw.js file separately