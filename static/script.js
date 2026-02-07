// ===== State =====
let currentStep = 1;
let imageBase64 = null;
let imageMediaType = null;
let assessmentData = null;
let metadataConfig = null;

// ===== DOM References =====
const steps = {
    1: document.getElementById('step-1'),
    2: document.getElementById('step-2'),
    3: document.getElementById('step-3'),
    loading: document.getElementById('loading'),
    success: document.getElementById('success')
};

const indicators = {
    1: document.getElementById('step-indicator-1'),
    2: document.getElementById('step-indicator-2'),
    3: document.getElementById('step-indicator-3')
};

// ===== Initialize =====
document.addEventListener('DOMContentLoaded', async () => {
    try {
        const resp = await fetch('/api/config');
        metadataConfig = await resp.json();
        buildMetadataForm(metadataConfig.metadata_fields);
    } catch (err) {
        showError('Failed to load configuration. Please refresh the page.');
    }

    // Event listeners
    document.getElementById('metadata-form').addEventListener('submit', onMetadataSubmit);
    document.getElementById('photo-input').addEventListener('change', onPhotoSelected);
    document.getElementById('upload-area').addEventListener('click', (e) => {
        if (e.target.id !== 'photo-input') {
            document.getElementById('photo-input').click();
        }
    });
    document.getElementById('analyze-btn').addEventListener('click', onAnalyze);
    document.getElementById('back-to-step-1').addEventListener('click', () => goToStep(1));
    document.getElementById('back-to-step-2').addEventListener('click', () => goToStep(2));
    document.getElementById('submit-btn').addEventListener('click', onSubmit);
    document.getElementById('new-assessment-btn').addEventListener('click', resetForm);
    document.getElementById('dismiss-error').addEventListener('click', hideError);
});

// ===== Metadata Persistence =====
function saveMetadata() {
    const data = {};
    document.querySelectorAll('#metadata-fields input, #metadata-fields select').forEach(input => {
        if (input.name) data[input.name] = input.value;
    });
    try { sessionStorage.setItem('signage_metadata', JSON.stringify(data)); } catch (e) {}
}

function getSavedMetadata() {
    try {
        const raw = sessionStorage.getItem('signage_metadata');
        return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
}

// ===== Build Metadata Form =====
function buildMetadataForm(fields) {
    const container = document.getElementById('metadata-fields');
    container.innerHTML = '';
    const saved = getSavedMetadata();

    fields.forEach(field => {
        const group = document.createElement('div');
        group.className = 'form-group';

        const label = document.createElement('label');
        label.setAttribute('for', `field-${field.id}`);
        label.textContent = field.label;
        if (field.required) {
            const req = document.createElement('span');
            req.className = 'required';
            req.textContent = '*';
            req.setAttribute('aria-label', 'required');
            label.appendChild(req);
        }
        group.appendChild(label);

        let input;
        if (field.type === 'select') {
            input = document.createElement('select');
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = `Select ${field.label.toLowerCase()}...`;
            placeholder.disabled = true;
            placeholder.selected = !saved[field.id];
            input.appendChild(placeholder);

            field.options.forEach(opt => {
                const option = document.createElement('option');
                option.value = opt;
                option.textContent = opt;
                if (saved[field.id] === opt) option.selected = true;
                input.appendChild(option);
            });
        } else if (field.type === 'dependent_select') {
            input = document.createElement('select');
            input.disabled = true;
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = `Select ${field.label.toLowerCase()}...`;
            placeholder.disabled = true;
            placeholder.selected = true;
            input.appendChild(placeholder);

            // Store the options map on the element for later use
            input.dataset.optionsMap = JSON.stringify(field.options_map);
            input.dataset.dependsOn = field.depends_on;

            // Wire up the parent dropdown to populate this one
            const parentId = `field-${field.depends_on}`;
            const wireUp = () => {
                const parentSelect = document.getElementById(parentId);
                if (!parentSelect) return;
                parentSelect.addEventListener('change', () => {
                    populateDependentSelect(input, field.options_map, parentSelect.value, null);
                });
                // If parent already has a saved value, populate now
                if (saved[field.depends_on] && field.options_map[saved[field.depends_on]]) {
                    populateDependentSelect(input, field.options_map, saved[field.depends_on], saved[field.id]);
                }
            };
            // Defer so the parent element exists in the DOM
            setTimeout(wireUp, 0);
        } else if (field.type === 'auto') {
            // Auto-populated read-only field (e.g., floor_owner from owner_map)
            input = document.createElement('div');
            input.className = 'auto-field';
            input.id = `field-${field.id}`;
            input.dataset.fieldId = field.id;
            input.textContent = 'Select a building first...';

            // Wire up auto-population from lookup
            if (field.lookup_from && field.lookup_key) {
                const lookupMap = metadataConfig[field.lookup_from] || {};
                const parentId = `field-${field.lookup_key}`;
                const wireAutoField = () => {
                    const parentSelect = document.getElementById(parentId);
                    if (!parentSelect) return;
                    const updateValue = () => {
                        const val = lookupMap[parentSelect.value] || '';
                        input.textContent = val || 'Unknown';
                        input.dataset.value = val;
                    };
                    parentSelect.addEventListener('change', updateValue);
                    // If parent already has a value, populate now
                    if (parentSelect.value && lookupMap[parentSelect.value] !== undefined) {
                        updateValue();
                    }
                };
                setTimeout(wireAutoField, 0);
            }

            // Auto fields don't need name/required since they're divs
            group.appendChild(input);
            container.appendChild(group);
            return; // Skip the normal input setup below
        } else {
            input = document.createElement('input');
            input.type = field.type === 'email' ? 'email' : field.type === 'date' ? 'date' : 'text';
            if (field.type !== 'date') {
                input.placeholder = `Enter ${field.label.toLowerCase()}`;
            }
            if (saved[field.id]) input.value = saved[field.id];
            // Default date to today
            if (field.type === 'date' && !saved[field.id]) {
                input.value = new Date().toISOString().split('T')[0];
            }
        }

        input.id = `field-${field.id}`;
        input.name = field.id;
        if (field.required) input.required = true;
        group.appendChild(input);

        const errorMsg = document.createElement('div');
        errorMsg.className = 'field-error';
        errorMsg.textContent = `${field.label} is required`;
        group.appendChild(errorMsg);

        container.appendChild(group);
    });
}

// ===== Dependent Select Helper =====
function populateDependentSelect(selectEl, optionsMap, parentValue, savedValue) {
    // Clear existing options
    selectEl.innerHTML = '';

    const locations = optionsMap[parentValue] || [];
    if (locations.length === 0) {
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'No locations available';
        placeholder.disabled = true;
        placeholder.selected = true;
        selectEl.appendChild(placeholder);
        selectEl.disabled = true;
        return;
    }

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select screen location...';
    placeholder.disabled = true;
    placeholder.selected = !savedValue;
    selectEl.appendChild(placeholder);

    locations.forEach(loc => {
        const option = document.createElement('option');
        option.value = loc;
        option.textContent = loc;
        if (savedValue === loc) option.selected = true;
        selectEl.appendChild(option);
    });

    selectEl.disabled = false;
}

// ===== Step Navigation =====
function goToStep(step) {
    // Hide all
    Object.values(steps).forEach(el => el.classList.remove('active'));

    // Update indicators
    Object.entries(indicators).forEach(([num, el]) => {
        el.classList.remove('active', 'completed');
        el.removeAttribute('aria-current');
        const n = parseInt(num);
        if (n < step) el.classList.add('completed');
        if (n === step) {
            el.classList.add('active');
            el.setAttribute('aria-current', 'step');
        }
    });

    // Show target
    steps[step].classList.add('active');
    currentStep = step;

    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showView(viewName) {
    Object.values(steps).forEach(el => el.classList.remove('active'));
    steps[viewName].classList.add('active');
}

// ===== Metadata Form Submit =====
function onMetadataSubmit(e) {
    e.preventDefault();
    const form = e.target;
    let valid = true;

    // Validate all required fields
    form.querySelectorAll('input[required], select[required]').forEach(input => {
        if (!input.value || input.value.trim() === '') {
            input.classList.add('invalid');
            valid = false;
        } else {
            input.classList.remove('invalid');
        }
    });

    if (valid) {
        saveMetadata();
        goToStep(2);
    }
}

// ===== Photo Handling =====
function onPhotoSelected(e) {
    const file = e.target.files[0];
    if (!file) return;

    compressAndEncodeImage(file).then(({ base64, mediaType }) => {
        imageBase64 = base64;
        imageMediaType = mediaType;

        // Show preview
        const preview = document.getElementById('preview-image');
        preview.src = `data:${mediaType};base64,${base64}`;
        preview.classList.remove('hidden');
        document.getElementById('upload-placeholder').classList.add('hidden');

        // Enable analyze button
        document.getElementById('analyze-btn').disabled = false;
    }).catch(err => {
        showError('Failed to process the image. Please try again.');
    });
}

function compressAndEncodeImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const MAX_DIM = 1920;
                let { width, height } = img;

                // Scale down if larger than MAX_DIM
                if (width > MAX_DIM || height > MAX_DIM) {
                    const ratio = Math.min(MAX_DIM / width, MAX_DIM / height);
                    width = Math.round(width * ratio);
                    height = Math.round(height * ratio);
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                // Convert to JPEG at 80% quality
                const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
                const base64 = dataUrl.split(',')[1];
                resolve({ base64, mediaType: 'image/jpeg' });
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// ===== Analyze =====
async function onAnalyze() {
    if (!imageBase64) return;

    // Gather metadata
    const metadata = {};
    document.querySelectorAll('#metadata-fields input, #metadata-fields select').forEach(input => {
        if (input.name) metadata[input.name] = input.value;
    });

    showView('loading');

    try {
        const resp = await fetch('/api/assess', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                image: imageBase64,
                media_type: imageMediaType,
                metadata
            })
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error || `Server error (${resp.status})`);
        }

        assessmentData = await resp.json();
        renderResults(assessmentData);
        goToStep(3);
    } catch (err) {
        showView('loading');
        steps.loading.classList.remove('active');
        goToStep(2);
        showError(`Analysis failed: ${err.message}`);
    }
}

// ===== Render Results =====
function renderResults(data) {
    // AI-inferred fields (sign_type, orientation) as editable dropdowns
    const inferredDiv = document.getElementById('inferred-fields');
    inferredDiv.innerHTML = '';
    const aiFields = metadataConfig.ai_inferred_fields || [];

    if (aiFields.length > 0) {
        aiFields.forEach(field => {
            const group = document.createElement('div');
            group.className = 'form-group';

            const label = document.createElement('label');
            label.setAttribute('for', `inferred-${field.id}`);
            label.textContent = field.label;
            group.appendChild(label);

            const select = document.createElement('select');
            select.id = `inferred-${field.id}`;
            select.dataset.inferredId = field.id;

            field.options.forEach(opt => {
                const option = document.createElement('option');
                option.value = opt;
                option.textContent = opt;
                const inferred = (data.inferred_metadata || {})[field.id] || '';
                if (opt.toLowerCase() === inferred.toLowerCase() || opt === inferred) {
                    option.selected = true;
                }
                select.appendChild(option);
            });

            group.appendChild(select);
            inferredDiv.appendChild(group);
        });

        // Show any extra context the AI found
        const aiFieldIds = new Set(aiFields.map(f => f.id));
        Object.entries(data.inferred_metadata || {}).forEach(([key, value]) => {
            if (value && !aiFieldIds.has(key)) {
                const p = document.createElement('p');
                p.innerHTML = `<strong>${formatKey(key)}:</strong> ${escapeHtml(String(value))}`;
                inferredDiv.appendChild(p);
            }
        });

        document.getElementById('inferred-metadata').classList.remove('hidden');
    }

    // Assessment categories — each is a text area with AI-generated content
    const resultsContainer = document.getElementById('assessment-results');
    resultsContainer.innerHTML = '';

    if (metadataConfig && metadataConfig.categories) {
        metadataConfig.categories.forEach(category => {
            const card = document.createElement('div');
            card.className = 'card';

            const heading = document.createElement('h3');
            heading.textContent = category.name;
            card.appendChild(heading);

            // Show guidance as a hint
            if (category.guidance) {
                const hint = document.createElement('p');
                hint.className = 'assessment-notes';
                hint.style.marginBottom = '0.75rem';
                hint.textContent = category.guidance.split('\n')[0] + '...';
                card.appendChild(hint);
            }

            // Editable text area with AI response
            const textarea = document.createElement('textarea');
            textarea.className = 'assessment-textarea';
            textarea.dataset.categoryId = category.id;
            textarea.setAttribute('aria-label', `Assessment for: ${category.name}`);
            textarea.rows = 4;
            textarea.value = data.assessments[category.id] || '';
            card.appendChild(textarea);

            resultsContainer.appendChild(card);
        });
    }

    // Overall accessibility rating
    const ratingConfig = metadataConfig.overall_rating;
    if (ratingConfig) {
        const ratingCard = document.createElement('div');
        ratingCard.className = 'card';

        const ratingHeading = document.createElement('h3');
        ratingHeading.textContent = ratingConfig.label;
        ratingCard.appendChild(ratingHeading);

        const ratingSelect = document.createElement('select');
        ratingSelect.id = 'overall-rating';
        ratingSelect.setAttribute('aria-label', ratingConfig.label);

        ratingConfig.options.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt;
            option.textContent = opt;
            if (data.accessibility_rating === opt) option.selected = true;
            ratingSelect.appendChild(option);
        });

        ratingCard.appendChild(ratingSelect);
        resultsContainer.appendChild(ratingCard);
    }

    // Final comments
    const commentsConfig = metadataConfig.final_comments;
    if (commentsConfig) {
        const commentsCard = document.createElement('div');
        commentsCard.className = 'card';

        const commentsHeading = document.createElement('h3');
        commentsHeading.textContent = commentsConfig.label;
        commentsCard.appendChild(commentsHeading);

        const commentsArea = document.createElement('textarea');
        commentsArea.id = 'final-comments';
        commentsArea.className = 'assessment-textarea';
        commentsArea.setAttribute('aria-label', commentsConfig.label);
        commentsArea.rows = 3;
        commentsArea.value = data.final_comments || '';
        commentsCard.appendChild(commentsArea);

        resultsContainer.appendChild(commentsCard);
    }

    // Hide the old overall notes card (replaced by inline elements above)
    document.getElementById('overall-notes-card').style.display = 'none';
}

// ===== Submit =====
async function onSubmit() {
    const submitBtn = document.getElementById('submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    // Gather category assessments (user may have edited the textareas)
    const assessments = {};
    document.querySelectorAll('#assessment-results textarea[data-category-id]').forEach(textarea => {
        assessments[textarea.dataset.categoryId] = textarea.value;
    });

    // Gather overall rating
    const ratingEl = document.getElementById('overall-rating');
    const accessibilityRating = ratingEl ? ratingEl.value : '';

    // Gather final comments
    const commentsEl = document.getElementById('final-comments');
    const finalComments = commentsEl ? commentsEl.value : '';

    // Gather metadata from form fields
    const metadata = {};
    document.querySelectorAll('#metadata-fields input, #metadata-fields select').forEach(input => {
        if (input.name) metadata[input.name] = input.value;
    });

    // Add auto-populated fields (e.g., floor_owner)
    document.querySelectorAll('#metadata-fields .auto-field[data-field-id]').forEach(el => {
        metadata[el.dataset.fieldId] = el.dataset.value || '';
    });

    // Gather user-confirmed inferred fields (sign_type, orientation dropdowns)
    const confirmedInferred = { ...(assessmentData.inferred_metadata || {}) };
    document.querySelectorAll('#inferred-fields select[data-inferred-id]').forEach(select => {
        confirmedInferred[select.dataset.inferredId] = select.value;
    });

    try {
        const resp = await fetch('/api/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                metadata,
                assessments,
                inferred_metadata: confirmedInferred,
                accessibility_rating: accessibilityRating,
                final_comments: finalComments,
                overall_notes: assessmentData.overall_notes || '',
                image: imageBase64,
                media_type: imageMediaType
            })
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error || `Server error (${resp.status})`);
        }

        showView('success');
    } catch (err) {
        showError(`Submission failed: ${err.message}`);
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit to Google Sheet';
    }
}

// ===== Reset =====
function resetForm() {
    // Clear photo and assessment state (metadata stays)
    imageBase64 = null;
    imageMediaType = null;
    assessmentData = null;

    // Reset photo
    document.getElementById('photo-input').value = '';
    document.getElementById('preview-image').classList.add('hidden');
    document.getElementById('preview-image').src = '';
    document.getElementById('upload-placeholder').classList.remove('hidden');
    document.getElementById('analyze-btn').disabled = true;

    // Reset results
    document.getElementById('assessment-results').innerHTML = '';
    document.getElementById('inferred-metadata').classList.add('hidden');
    document.getElementById('overall-notes-card').style.display = 'none';

    // Go back to step 1 — metadata is still filled in from sessionStorage
    goToStep(1);
}

// ===== Error Handling =====
function showError(message) {
    document.getElementById('error-message').textContent = message;
    document.getElementById('error-banner').classList.remove('hidden');
}

function hideError() {
    document.getElementById('error-banner').classList.add('hidden');
}

// ===== Utilities =====
function formatKey(key) {
    return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
